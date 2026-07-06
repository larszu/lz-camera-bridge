/**
 * Sony 700PTP CCU Client
 *
 * Connects to a Sony CCU (Camera Control Unit) or RP700 panel
 * over TCP (port 7700) or directly via 8-pin RS-422 serial.
 * Emulates an RCP-1500 panel (SRCID=0x90, Model=0x0a).
 *
 * Implements: handshake, heartbeat, camera parameter get/set.
 */

import { Socket } from 'net';
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import {
  PacketHeader,
  CnsMode,
  SppCommandGroup,
  ChuAnalogParam,
  ChuSwitchParam,
  CcuSwitchParam,
  SppCommandPair,
  ParsedPacket,
  buildHandshake,
  buildHeartBeat,
  buildNotifyACK,
  buildClose,
  buildCloseACK,
  buildMessage50,
  buildMessageResponse,
  parseNextPacket,
  getMessageType,
  getMessageId,
  parseMessage50Commands,
  parseHandshake,
  HandshakeInfo,
} from './Ptp700Protocol.js';

export interface CcuClientOptions {
  /** TCP host (IP of CCU). Set for TCP mode. */
  host?: string;
  /** TCP port, default 7700 */
  port?: number;
  /** Serial port path (e.g. COM3). Set for direct 8-pin RS-422 mode. */
  serialPath?: string;
  /** Serial baud rate, default 38400 */
  baudRate?: number;
  ccuId?: number;
  serialNumber?: number;
  mode?: CnsMode;
}

export interface CameraState {
  iris?: number;
  masterBlack?: number;
  blackR?: number;
  blackG?: number;
  blackB?: number;
  whiteR?: number;
  whiteG?: number;
  whiteB?: number;
  masterGain?: number;
  masterGamma?: number;
  saturation?: number;
  shutterSpeed?: number;
  bars?: boolean;
  cameraPower?: boolean;
  ndFilter?: number;
  masterWhiteClip?: number;
  detailLevel?: number;
}

/** Minimal stream interface satisfied by both net.Socket and SerialPort */
interface Transport {
  write(data: Buffer | Uint8Array): boolean;
  on(event: string, cb: (...args: unknown[]) => void): this;
  destroy(): void;
  readonly writable: boolean;
}

export class CcuClient extends EventEmitter {
  private transport: Transport | null = null;
  private transportType: 'tcp' | 'serial' = 'tcp';
  private rxBuffer: Buffer = Buffer.alloc(0);
  private requestId = 0x6468;
  private responseId = 0x0000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private remoteInfo: HandshakeInfo | null = null;
  private pendingCallbacks = new Map<number, (p: ParsedPacket) => void>();

  readonly state: CameraState = {};

  private readonly opts: {
    host: string;
    port: number;
    serialPath: string;
    baudRate: number;
    ccuId: number;
    serialNumber: number;
    mode: CnsMode;
  };

  constructor(options: CcuClientOptions) {
    super();
    this.opts = {
      host: options.host ?? '',
      port: options.port ?? 7700,
      serialPath: options.serialPath ?? '',
      baudRate: options.baudRate ?? 38400,
      ccuId: options.ccuId ?? 0,
      serialNumber: options.serialNumber ?? 0x12345678,
      mode: options.mode ?? CnsMode.Bridge,
    };
    this.transportType = this.opts.serialPath ? 'serial' : 'tcp';
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return this.transportType === 'serial' ? this.connectSerial() : this.connectTcp();
  }

  private connectTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.connect(this.opts.port, this.opts.host, async () => {
        try {
          await this.performHandshake();
          this.startHeartbeat();
          await this.scanCameraStatus();
          this.emit('connected', this.remoteInfo);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      socket.on('data', (d: Buffer) => this.onData(d));
      socket.on('error', (err: Error) => this.emit('error', err));
      socket.on('close', () => {
        this.stopHeartbeat();
        this.emit('disconnected');
      });
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });
      socket.setTimeout(5000);
      this.transport = socket as unknown as Transport;
    });
  }

  private connectSerial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.opts.serialPath,
        baudRate: this.opts.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'odd',
        autoOpen: false,
      });

      port.open(async (err) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          await this.performHandshake();
          this.startHeartbeat();
          await this.scanCameraStatus();
          this.emit('connected', this.remoteInfo);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      port.on('data', (d: Buffer) => this.onData(d));
      port.on('error', (err: Error) => this.emit('error', err));
      port.on('close', () => {
        this.stopHeartbeat();
        this.emit('disconnected');
      });
      this.transport = port as unknown as Transport;
    });
  }

  disconnect(): void {
    if (!this.transport) return;
    try {
      this.writeRaw(buildClose());
    } catch { /* ignore */ }
    this.stopHeartbeat();
    this.transport.destroy();
    this.transport = null;
    this.remoteInfo = null;
  }

  get connected(): boolean {
    return this.transport?.writable === true && this.remoteInfo !== null;
  }

  /** CameraBackend interface alias. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Map the shared RCP command vocabulary onto the 700PTP set-methods.
   * `cameraNumber` selects which camera on the CNS the command targets.
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    const cam = params.cameraNumber !== undefined ? Number(params.cameraNumber) : undefined;
    switch (cmd) {
      case 'setIris': await this.setIris(num('value'), cam); return true;
      case 'setMasterBlack': await this.setMasterBlack(num('value'), cam); return true;
      case 'setBlackBalance': await this.setBlackBalance(num('r'), num('g'), num('b'), cam); return true;
      case 'setWhiteBalance': await this.setWhiteBalance(num('r'), num('g'), num('b'), cam); return true;
      case 'setMasterGain': await this.setMasterGain(num('value'), cam); return true;
      case 'setMasterGamma': await this.setMasterGamma(num('value'), cam); return true;
      case 'setSaturation': await this.setSaturation(num('value'), cam); return true;
      case 'setDetailLevel': await this.setDetailLevel(num('value'), cam); return true;
      case 'setBars': await this.setBars(Boolean(params['on']), cam); return true;
      case 'setCameraPower': await this.setCameraPower(Boolean(params['on']), cam); return true;
      case 'setNdFilter': await this.setNdFilter(num('value'), cam); return true;
      case 'setShutterSpeed': await this.setShutterSpeed(num('value'), cam); return true;
      default: return false;
    }
  }

  // ─── Handshake ─────────────────────────────────────────────────────────────

  private performHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const reqId = this.nextRequestId();
      const hs = buildHandshake(PacketHeader.HandShake, this.opts.mode, reqId, this.opts.serialNumber);
      this.writeRaw(hs);

      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 3000);

      const handler = (packet: ParsedPacket) => {
        if (packet.header !== PacketHeader.HandShakeResponse) return;
        clearTimeout(timeout);
        this.off('rawPacket', handler);

        this.remoteInfo = parseHandshake(packet);
        this.responseId = this.remoteInfo.id;

        const ack = buildHandshake(PacketHeader.HandShakeACK, this.opts.mode, this.nextRequestId(), this.opts.serialNumber);
        this.writeRaw(ack);
        resolve();
      };

      this.on('rawPacket', handler);
    });
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 1000) {
        try {
          this.writeRaw(buildHeartBeat(false));
        } catch { /* socket closing */ }
      }
    }, 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Data Handling ─────────────────────────────────────────────────────────

  private onData(data: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, data]);
    this.parsePackets();
  }

  private parsePackets(): void {
    while (true) {
      const result = parseNextPacket(this.rxBuffer);
      if (!result) break;
      this.rxBuffer = this.rxBuffer.subarray(result.consumed);
      this.handlePacket(result.packet);
    }
  }

  private handlePacket(packet: ParsedPacket): void {
    this.lastActivity = Date.now();
    this.emit('rawPacket', packet);

    switch (packet.header) {
      case PacketHeader.HeartBeat:
        this.writeRaw(buildHeartBeat(true));
        break;
      case PacketHeader.HeartBeatACK:
        break;
      case PacketHeader.Notify:
        this.writeRaw(buildNotifyACK());
        break;
      case PacketHeader.Close:
        this.writeRaw(buildCloseACK());
        this.transport?.destroy();
        break;
      case PacketHeader.Message: {
        const msgType = getMessageType(packet);
        const msgId = getMessageId(packet);
        this.responseId = msgId;

        if (msgType === 0x50) {
          this.handleMessage50(packet);
        }
        this.writeRaw(buildMessageResponse(msgId + 1));
        break;
      }
      case PacketHeader.MessageResponse: {
        // resolve pending callbacks
        const id = packet.payload.length >= 2
          ? (packet.payload[0] << 8) | packet.payload[1]
          : 0;
        const cb = this.pendingCallbacks.get(id);
        if (cb) {
          this.pendingCallbacks.delete(id);
          cb(packet);
        }
        break;
      }
    }
  }

  private handleMessage50(packet: ParsedPacket): void {
    const commands = parseMessage50Commands(packet);
    for (const cmd of commands) {
      this.applyStateFromCommand(cmd);
    }
    if (commands.length > 0) {
      this.emit('stateChanged', { ...this.state });
    }
  }

  private applyStateFromCommand(cmd: SppCommandPair): void {
    const value = cmd.param1 !== undefined ? (cmd.param1 << 8) | (cmd.param2 ?? 0) : 0;
    switch (cmd.cmdGp) {
      case SppCommandGroup.CHU_ANALOG_ABS:
        switch (cmd.param0) {
          case ChuAnalogParam.IRIS: this.state.iris = value; break;
          case ChuAnalogParam.MASTER_BLACK: this.state.masterBlack = value; break;
          case ChuAnalogParam.BLACK_R: this.state.blackR = value; break;
          case ChuAnalogParam.BLACK_G: this.state.blackG = value; break;
          case ChuAnalogParam.BLACK_B: this.state.blackB = value; break;
          case ChuAnalogParam.WHITE_R: this.state.whiteR = value; break;
          case ChuAnalogParam.WHITE_G: this.state.whiteG = value; break;
          case ChuAnalogParam.WHITE_B: this.state.whiteB = value; break;
          case ChuAnalogParam.MASTER_GAMMA: this.state.masterGamma = value; break;
          case ChuAnalogParam.SATURATION: this.state.saturation = value; break;
          case ChuAnalogParam.MASTER_WHITE_CLIP: this.state.masterWhiteClip = value; break;
          case ChuAnalogParam.DETAIL_LEVEL: this.state.detailLevel = value; break;
        }
        break;
      case SppCommandGroup.CHU_SWITCH_ABS:
        switch (cmd.param0) {
          case ChuSwitchParam.MASTER_GAIN: this.state.masterGain = cmd.param1; break;
          case ChuSwitchParam.SHUTTER_SPEED: this.state.shutterSpeed = cmd.param1; break;
          case ChuSwitchParam.ND_FILTER: this.state.ndFilter = cmd.param1; break;
        }
        break;
      case SppCommandGroup.CCU_SWITCH_ABS:
        switch (cmd.param0) {
          case CcuSwitchParam.CAM_PW: this.state.cameraPower = cmd.param1 !== 0; break;
          case CcuSwitchParam.BARS_CHARACTER: this.state.bars = cmd.param1 !== 0; break;
        }
        break;
    }
  }

  // ─── Camera Status Scan ────────────────────────────────────────────────────

  private async scanCameraStatus(): Promise<void> {
    // Request camera status blocks (from CcuClient.cs ScanCameraStatus)
    const statuses = [
      [0x00, 0x40, 0x18, 0x40, 0x00, 0x00],
      [0x00, 0x40, 0x18, 0xd3, 0x00, 0x00],
      [0x00, 0x40, 0x18, 0xd4, 0x00, 0x00],
      [0x00, 0x40, 0x18, 0x60, 0x00, 0x00],
    ];
    for (const block of statuses) {
      const id = this.nextRequestId();
      const payload = Buffer.from([
        (id >> 8) & 0xff, id & 0xff,
        0x10,
        ...block,
      ]);
      const packet = Buffer.alloc(2 + payload.length);
      packet[0] = PacketHeader.Message;
      packet[1] = payload.length;
      payload.copy(packet, 2);
      this.writeRaw(packet);
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  // ─── Parameter Control ─────────────────────────────────────────────────────

  private async sendMessage50(commands: SppCommandPair[], ccuId = this.opts.ccuId): Promise<ParsedPacket | null> {
    const reqId = this.nextRequestId();
    const packet = buildMessage50(reqId, ccuId, 0x02, commands);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(reqId + 1);
        resolve(null);
      }, 1000);

      this.pendingCallbacks.set(reqId + 1, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.writeRaw(packet);
    });
  }

  // ─── Public Camera Control API ────────────────────────────────────────────

  setIris(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.IRIS, hi, lo),
    ], ccuId);
  }

  setMasterBlack(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.MASTER_BLACK, hi, lo),
    ], ccuId);
  }

  setBlackBalance(r: number, g: number, b: number, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.BLACK_R, (r >> 8) & 0xff, r & 0xff),
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.BLACK_G, (g >> 8) & 0xff, g & 0xff),
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.BLACK_B, (b >> 8) & 0xff, b & 0xff),
    ], ccuId);
  }

  setWhiteBalance(r: number, g: number, b: number, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.WHITE_R, (r >> 8) & 0xff, r & 0xff),
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.WHITE_G, (g >> 8) & 0xff, g & 0xff),
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.WHITE_B, (b >> 8) & 0xff, b & 0xff),
    ], ccuId);
  }

  setMasterGain(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_SWITCH_ABS, ChuSwitchParam.MASTER_GAIN, value),
    ], ccuId);
  }

  setMasterGamma(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.MASTER_GAMMA, hi, lo),
    ], ccuId);
  }

  setSaturation(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.SATURATION, hi, lo),
    ], ccuId);
  }

  setDetailLevel(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    const hi = (value >> 8) & 0xff;
    const lo = value & 0xff;
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_ANALOG_ABS, ChuAnalogParam.DETAIL_LEVEL, hi, lo),
    ], ccuId);
  }

  setBars(on: boolean, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CCU_SWITCH_ABS, CcuSwitchParam.BARS_CHARACTER, on ? 1 : 0),
    ], ccuId);
  }

  setCameraPower(on: boolean, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CCU_SWITCH_ABS, CcuSwitchParam.CAM_PW, on ? 1 : 0),
    ], ccuId);
  }

  setNdFilter(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_SWITCH_ABS, ChuSwitchParam.ND_FILTER, value),
    ], ccuId);
  }

  setShutterSpeed(value: number, ccuId?: number): Promise<ParsedPacket | null> {
    return this.sendMessage50([
      new SppCommandPair(SppCommandGroup.CHU_SWITCH_ABS, ChuSwitchParam.SHUTTER_SPEED, value),
    ], ccuId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private writeRaw(data: Buffer): void {
    if (!this.transport?.writable) throw new Error('Transport not writable');
    this.transport.write(data);
    this.lastActivity = Date.now();
  }

  private nextRequestId(): number {
    const id = this.requestId;
    this.requestId = (this.requestId + 1) & 0xffff;
    return id;
  }
}
