/**
 * Sony Alpha / Cinema Line over Wi-Fi or LAN — PTP/IP (TCP 15740), with the
 * camera's Access Authentication through an SSH tunnel.
 *
 * Same commands as USB (`SonyPtpClient`), different wire. Two ways in:
 *  - Access Authentication on (factory default on current bodies): user and
 *    password from the camera's Access Authen. Info, host key checked against
 *    the confirmed fingerprint; PTP/IP runs through SSH.
 *  - Access Authentication off: plain PTP/IP; on first contact the camera
 *    asks "Allow pairing?" and remembers this initiator's GUID (up to 20).
 *
 * Checked on a real FX3 (firmware 7.00, 2026-10-07) with the same protocol
 * code in lz-camera-sync: SSH, handshake, 369 properties read, writes
 * confirmed, clock set.
 */
import net from 'net';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { PtpIpConnection, PTPIP_PORT, type ByteStream } from '../protocol/PtpIp.js';
import { PTP_RC_OK } from '../protocol/SonyPtp.js';
import { SonySshTunnel } from '../transport/SonySshTunnel.js';
import { SonyPtpClient } from './SonyPtpClient.js';

export interface SonyPtpIpTarget {
  host: string;
  /** With user + password: SSH (Access Authentication on). */
  user?: string;
  password?: string;
  /** Confirmed host-key fingerprint ("SHA256:…"). Without it the connect fails once with the camera's fingerprint. */
  fingerprint?: string;
  /** Test hooks. */
  sshPort?: number;
  ptpPort?: number;
}

/**
 * The initiator GUID. A camera stores paired GUIDs, so it must not change
 * between runs: derived from the host name.
 */
function initiatorGuid(): Buffer {
  return createHash('md5').update(`lz-camera-bridge:${hostname()}`).digest();
}

export class SonyPtpIpClient extends SonyPtpClient {
  private conn: PtpIpConnection | null = null;
  private tunnel: SonySshTunnel | null = null;

  constructor(private readonly target: SonyPtpIpTarget) {
    super();
  }

  async connect(): Promise<void> {
    const { host, user, password } = this.target;
    let open: () => Promise<ByteStream>;
    if (user && password) {
      this.tunnel = new SonySshTunnel({
        host,
        user,
        password,
        fingerprint: this.target.fingerprint,
        port: this.target.sshPort,
        targetPort: this.target.ptpPort ?? PTPIP_PORT,
      });
      await this.tunnel.connect();
      open = () => this.tunnel!.channel();
    } else {
      open = () =>
        new Promise((resolve, reject) => {
          const s = net.createConnection({ host, port: this.target.ptpPort ?? PTPIP_PORT, timeout: 5000 }, () => {
            s.setTimeout(0);
            resolve(s);
          });
          s.once('error', reject);
          s.once('timeout', () => {
            s.destroy();
            reject(new Error(`${host}: keine Antwort auf Port ${this.target.ptpPort ?? PTPIP_PORT}`));
          });
        });
    }
    this.conn = await PtpIpConnection.connect(open, initiatorGuid());
    await this.handshake();
    this.connected = true;
    this.emit('connected', { host, model: 'Sony PTP/IP' });
  }

  async disconnect(): Promise<void> {
    await this.closeSession();
    this.conn?.close();
    this.tunnel?.close();
    this.conn = null;
    this.tunnel = null;
    this.connected = false;
    this.emit('disconnected');
  }

  protected async transaction(opcode: number, params: number[], dataOut?: Buffer): Promise<Buffer | null> {
    if (!this.conn) throw new Error('Not connected');
    const res = await this.conn.transaction(opcode, params, dataOut);
    if (res.code !== PTP_RC_OK) throw new Error(`PTP-Fehler 0x${res.code.toString(16)} (op 0x${opcode.toString(16)})`);
    return res.data;
  }
}
