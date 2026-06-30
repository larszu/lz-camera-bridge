/**
 * VISCA-over-IP PTZ Client (generic)
 *
 * One implementation covers a large family of PTZ cameras that speak VISCA over
 * IP: PTZOptics, Marshall, AVer, Bolin, and Sony/Panasonic PTZ heads. Commands
 * are sent as raw VISCA packets over UDP (PTZOptics-style, default port 1259).
 *
 * Sony's official "VISCA over IP" adds an 8-byte transport header on UDP 52381;
 * that wrapper is not applied here — set the port for the raw-UDP cameras. The
 * VISCA payloads themselves are identical across vendors.
 *
 * Reference: VISCA command reference (Sony / PTZOptics).
 */
import { EventEmitter } from 'events';
import dgram from 'dgram';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient } from './GenericCameraClient.js';

/** Split a byte into two VISCA nibble bytes (0x0H, 0x0L). */
function nibbles(value: number): [number, number] {
  return [(value >> 4) & 0x0f, value & 0x0f];
}

export class ViscaClient extends EventEmitter implements GenericCameraClient {
  private host: string;
  private port: number;
  private socket: dgram.Socket | null = null;
  private connected = false;
  private _state: CameraState = {};

  constructor(host: string, port = 1259) {
    super();
    this.host = host;
    this.port = port;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => this.emit('error', err));
    // VISCA is connectionless; sending the version inquiry confirms a target.
    await this.send([0x81, 0x09, 0x00, 0x02, 0xff]).catch(() => {});
    this.connected = true;
    this.emit('connected', { host: this.host, port: this.port });
    return { host: this.host };
  }

  disconnect(): void {
    this.connected = false;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.emit('disconnected');
  }

  private send(bytes: number[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('VISCA socket not open'));
      this.socket.send(Buffer.from(bytes), this.port, this.host, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris': {
        // CAM_Iris Direct: 81 01 04 4B 00 00 0p 0q FF. Iris positions are small.
        const pos = Math.round((num('value') / 255) * 0x11); // 0..17
        const [p, q] = nibbles(pos);
        await this.send([0x81, 0x01, 0x04, 0x4b, 0x00, 0x00, p, q, 0xff]);
        this._state.iris = num('value');
        this.emit('stateChanged', { iris: this._state.iris });
        return true;
      }
      case 'setMasterGain': {
        // CAM_Gain Direct: 81 01 04 4C 00 00 0p 0q FF.
        const pos = Math.max(0, Math.min(0x0f, num('value')));
        const [p, q] = nibbles(pos);
        await this.send([0x81, 0x01, 0x04, 0x4c, 0x00, 0x00, p, q, 0xff]);
        this._state.masterGain = num('value');
        this.emit('stateChanged', { masterGain: this._state.masterGain });
        return true;
      }
      case 'setZoom': {
        const v = num('value'); // -100..100, 0 = stop
        if (v === 0) await this.send([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
        else {
          const speed = Math.max(0, Math.min(7, Math.round((Math.abs(v) / 100) * 7)));
          const dir = v > 0 ? 0x20 : 0x30; // tele : wide
          await this.send([0x81, 0x01, 0x04, 0x07, dir | speed, 0xff]);
        }
        return true;
      }
      case 'autoFocus':
        // One-push AF trigger.
        await this.send([0x81, 0x01, 0x04, 0x18, 0x01, 0xff]);
        return true;
      case 'autoWhiteBalance':
        // Switch to one-push WB mode, then trigger.
        await this.send([0x81, 0x01, 0x04, 0x35, 0x03, 0xff]);
        await this.send([0x81, 0x01, 0x04, 0x10, 0x05, 0xff]);
        return true;
      case 'setCameraPower':
        await this.send([0x81, 0x01, 0x04, 0x00, Boolean(params['on']) ? 0x02 : 0x03, 0xff]);
        this._state.cameraPower = Boolean(params['on']);
        this.emit('stateChanged', { cameraPower: this._state.cameraPower });
        return true;
      case 'recallPreset':
        await this.send([0x81, 0x01, 0x04, 0x3f, 0x02, num('value') & 0x7f, 0xff]);
        return true;
      default:
        return false;
    }
  }
}
