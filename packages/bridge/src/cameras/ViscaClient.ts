/**
 * VISCA-over-IP PTZ Client (generic)
 *
 * One implementation covers a large family of PTZ cameras that speak VISCA over
 * IP: PTZOptics, Marshall, AVer, Bolin — and Sony BRC/SRG heads.
 *
 * Two wire variants exist:
 *  - RAW:  the bare VISCA packet over UDP (PTZOptics-style, default port 1259).
 *  - SONY: Sony's official "VISCA over IP" — the same VISCA payload prefixed
 *    with an 8-byte transport header on UDP 52381:
 *      bytes 0-1  payload type (0x0100 command, 0x0110 inquiry, 0x0200 control)
 *      bytes 2-3  payload length (big-endian)
 *      bytes 4-7  sequence number (big-endian, incremented per message)
 *    A RESET_SEQUENCE control packet (payload 0x01) is sent on connect.
 *    Reference: Sony VISCA over IP spec (BRC/SRG command lists, pro.sony) and
 *    AVer VISCA-over-IP guide.
 *
 * The Sony header is enabled automatically when the port is 52381, so Sony
 * BRC/SRG cameras work by simply selecting that port.
 */
import { EventEmitter } from 'events';
import dgram from 'dgram';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient } from './GenericCameraClient.js';
import { ViscaSerialTransport, buildIfClearBroadcast, viscaKopf } from '../transport/ViscaSerialTransport.js';

/**
 * Wie dieser Client auf dem Draht liegt.
 *
 * Der Befehlssatz darunter ist DERSELBE -- siehe ViscaSerialTransport.ts.
 * Getrennt ist nur die Huelle: auf IP optional Sonys 8-Byte-Kopf mit
 * Sequenzzaehler, auf RS-232 das nackte Paket.
 */
export type ViscaLink =
  | { art: 'ip'; host: string; port: number; sonyHeader?: boolean }
  | { art: 'seriell'; path: string; baudRate?: number; adresse?: number };

/** Split a byte into two VISCA nibble bytes (0x0H, 0x0L). */
function nibbles(value: number): [number, number] {
  return [(value >> 4) & 0x0f, value & 0x0f];
}

export const SONY_VISCA_PORT = 52381;

export const SONY_PAYLOAD_COMMAND = 0x0100;
export const SONY_PAYLOAD_INQUIRY = 0x0110;
export const SONY_PAYLOAD_CONTROL = 0x0200;

/** Wrap a VISCA payload in Sony's 8-byte VISCA-over-IP transport header. */
export function wrapSonyVisca(payload: Buffer, sequence: number, payloadType = SONY_PAYLOAD_COMMAND): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(sequence >>> 0, 4);
  payload.copy(buf, 8);
  return buf;
}

/** Sony control packet that resets the camera's sequence-number counter. */
export function buildSonyResetSequence(): Buffer {
  return wrapSonyVisca(Buffer.from([0x01]), 0, SONY_PAYLOAD_CONTROL);
}

export class ViscaClient extends EventEmitter implements GenericCameraClient {
  private host: string;
  private port: number;
  private sonyHeader: boolean;
  private sequence = 1;
  private socket: dgram.Socket | null = null;
  private connected = false;
  private _state: CameraState = {};
  /** Nur im seriellen Betrieb gesetzt. */
  private seriell: ViscaSerialTransport | null = null;
  private readonly link: ViscaLink;
  /**
   * Erstes Byte jedes Kommandos. Auf IP praktisch immer 0x81 (Adresse 1),
   * am Kabel die konfigurierte Adresse der Kette -- deshalb hier gemerkt
   * und nicht in jedem Kommando fest hingeschrieben.
   */
  private readonly kopf: number;

  constructor(host: string, port?: number, sonyHeader?: boolean);
  constructor(link: ViscaLink);
  constructor(hostOrLink: string | ViscaLink, port = 1259, sonyHeader?: boolean) {
    super();
    this.link = typeof hostOrLink === 'string'
      ? { art: 'ip', host: hostOrLink, port, sonyHeader }
      : hostOrLink;

    if (this.link.art === 'seriell') {
      this.host = this.link.path;
      this.port = 0;
      this.sonyHeader = false;
      this.kopf = viscaKopf(this.link.adresse ?? 1);
    } else {
      this.host = this.link.host;
      this.port = this.link.port;
      // Sony BRC/SRG use port 52381 with the transport header; raw otherwise.
      this.sonyHeader = this.link.sonyHeader ?? this.link.port === SONY_VISCA_PORT;
      this.kopf = 0x81;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    if (this.link.art === 'seriell') {
      this.seriell = new ViscaSerialTransport({ path: this.link.path, baudRate: this.link.baudRate });
      this.seriell.on('error', (err) => this.emit('error', err));
      this.seriell.on('paket', (paket: Buffer) => this.emit('visca', paket));
      await this.seriell.open();
      // Haengende Kommandos in der ganzen Kette abraeumen, bevor eigene
      // kommen -- eine Kamera, die noch auf eine alte Antwort wartet, nimmt
      // sonst nichts Neues an.
      await this.seriell.write(buildIfClearBroadcast()).catch(() => {});
      this.connected = true;
      this.emit('connected', { path: this.link.path, baudRate: this.link.baudRate ?? 9600, variant: 'seriell' });
      return { path: this.link.path };
    }
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => this.emit('error', err));
    if (this.sonyHeader) {
      // Reset the camera's sequence counter, then start counting from 1.
      await this.sendRaw(buildSonyResetSequence()).catch(() => {});
      this.sequence = 1;
    }
    // VISCA is connectionless; sending the version inquiry confirms a target.
    await this.send([0x81, 0x09, 0x00, 0x02, 0xff], SONY_PAYLOAD_INQUIRY).catch(() => {});
    this.connected = true;
    this.emit('connected', { host: this.host, port: this.port, variant: this.sonyHeader ? 'sony' : 'raw' });
    return { host: this.host };
  }

  disconnect(): void {
    this.connected = false;
    if (this.seriell) {
      this.seriell.close();
      this.seriell = null;
    }
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.emit('disconnected');
  }

  private sendRaw(buf: Buffer): Promise<void> {
    if (this.link.art === 'seriell') {
      if (!this.seriell) return Promise.reject(new Error('Serieller VISCA-Port ist nicht offen'));
      return this.seriell.write(buf);
    }
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('VISCA socket not open'));
      this.socket.send(buf, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  private send(bytes: number[], payloadType = SONY_PAYLOAD_COMMAND): Promise<void> {
    // Die Kommandos unten sind mit 0x81 (Adresse 1) geschrieben. Am Kabel
    // kann die Kamera eine andere Adresse haben; hier wird sie eingesetzt,
    // damit die Kodierung NUR EINMAL existiert und nicht je Adresse kopiert
    // werden muss. 0x88 ist Rundruf und bleibt unangetastet.
    const adressiert = bytes.length > 0 && (bytes[0] & 0xf0) === 0x80 && bytes[0] !== 0x88
      ? [this.kopf, ...bytes.slice(1)]
      : bytes;
    const payload = Buffer.from(adressiert);
    if (!this.sonyHeader) return this.sendRaw(payload);
    const packet = wrapSonyVisca(payload, this.sequence, payloadType);
    this.sequence = (this.sequence + 1) >>> 0;
    return this.sendRaw(packet);
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
      case 'ptz': {
        // Pan/Tilt drive: 81 01 06 01 VV WW 0p 0q FF.
        const pan = num('pan');
        const tilt = num('tilt');
        const panSpeed = Math.max(1, Math.round((Math.abs(pan) / 100) * 0x18));
        const tiltSpeed = Math.max(1, Math.round((Math.abs(tilt) / 100) * 0x14));
        const panDir = pan < 0 ? 0x01 : pan > 0 ? 0x02 : 0x03; // left : right : stop
        const tiltDir = tilt > 0 ? 0x01 : tilt < 0 ? 0x02 : 0x03; // up : down : stop
        await this.send([0x81, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, panDir, tiltDir, 0xff]);
        return true;
      }
      case 'setFocus': {
        const v = num('value'); // -100..100 (far..near), 0 = stop
        if (v === 0) await this.send([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]);
        else {
          const speed = Math.max(0, Math.min(7, Math.round((Math.abs(v) / 100) * 7)));
          const dir = v > 0 ? 0x20 : 0x30; // near (far) — 0x2p far, 0x3p near
          await this.send([0x81, 0x01, 0x04, 0x08, dir | speed, 0xff]);
        }
        return true;
      }
      case 'storePreset':
        await this.send([0x81, 0x01, 0x04, 0x3f, 0x01, num('value') & 0x7f, 0xff]);
        return true;
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
