/**
 * Telemetrics robotic heads (PT-LP/HP/CP-S5, RoboEye2, S2/S4) over TCP —
 * a head with its own network port, or one serial port of a DS-4 device
 * server (TCP 3001..3004).
 *
 * The protocol is CR-terminated ASCII:
 *   P<v>T<v>Z<v>      velocity, 0..32767, 16383 = stop
 *   FI<±n>            focus step (relative)
 *   ptzfxymi          position query → "pan tilt zoom focus x y black iris"
 *   CX p t z f x i b y time_ms   absolute move (S2/S4 and fallback)
 * and, on S5, a 30-byte binary keyframe stream (`CH`), 20 positions per
 * second into a small buffer in the head with flow control (`CH=<n>`).
 *
 * WHY PRESETS LIVE IN THE BRIDGE
 *
 * These heads have no preset memory of their own: the original panel stored
 * the positions and sent them back. Here they are kept per head in
 * `<configDir>/telemetrics/<host>_<port>.json`, and a recall on S5 is played
 * as an EASED keyframe trajectory (motion/Easing.ts) — the move starts and
 * lands softly on every axis, zoom included, instead of the head's own
 * profile. S2/S4 fall back to `CX` with the stored move time.
 *
 * Direction of low vs. high velocity values is not documented; `invertPan`
 * and friends exist because the first test on a real head decides it.
 */
import { EventEmitter } from 'events';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { GenericCameraClient } from './GenericCameraClient.js';
import { configDir } from '../site/persistence.js';
import { easedTrajectory, type EaseCurve, type Pose } from '../motion/Easing.js';

export const TM_NEUTRAL = 16383;
const POS_KEYS = ['pan', 'tilt', 'zoom', 'focus', 'x', 'y', 'black', 'iris'] as const;
type HeadPos = Record<(typeof POS_KEYS)[number], number>;

export interface TelemetricsOptions {
  model?: 'S5' | 'S2';
  /** Velocity letter of an elevation column / aux axis. */
  columnAxis?: 'X' | 'Y' | 'Q';
  countsPerDegree?: number; // 15625 (LP-S5, CP), 22222 (HP-S5)
  invertPan?: boolean;
  invertTilt?: boolean;
  invertZoom?: boolean;
  /** Default preset move time when a preset has none (ms). */
  presetTimeMs?: number;
  curve?: EaseCurve;
  dataDir?: string;
}

interface StoredPreset {
  pos: HeadPos;
  timeMs: number;
}

/** One 30-byte keyframe: 'C' 'H' 0 cmd, 7 × 24-bit big-endian, 3 × 0, checksum, CR. */
export function keyframe(cmd: 0x00 | 0xff | 0xef, p?: Partial<HeadPos> & { z?: number }): Buffer {
  const b = Buffer.alloc(30);
  b[0] = 0x43;
  b[1] = 0x48;
  b[2] = 0x00;
  b[3] = cmd;
  const vals = p ? [p.pan, p.tilt, p.zoom, p.focus, p.x, p.y, p.z ?? 0] : [0, 0, 0, 0, 0, 0, 0];
  vals.forEach((v, i) => {
    const n = Math.round(v ?? 0) & 0xffffff;
    b[4 + i * 3] = (n >> 16) & 0xff;
    b[5 + i * 3] = (n >> 8) & 0xff;
    b[6 + i * 3] = n & 0xff;
  });
  let sum = 0;
  for (let i = 0; i < 28; i++) sum += b[i];
  b[28] = sum & 0xff;
  b[29] = 0x0d;
  return b;
}

const speed = (v: number, invert = false) =>
  Math.max(0, Math.min(32767, Math.round(TM_NEUTRAL + (invert ? -1 : 1) * (Math.max(-100, Math.min(100, v)) / 100) * TM_NEUTRAL)));

export class TelemetricsClient extends EventEmitter implements GenericCameraClient {
  private sock: net.Socket | null = null;
  private buf = '';
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private focusSpeed = 0;
  private pos: HeadPos | null = null;
  private posWaiters: ((p: HeadPos) => void)[] = [];
  private bufferLevel: { n: number; at: number } | null = null;
  private presets = new Map<number, StoredPreset>();
  private moveToken = 0;
  private readonly opts: Required<Omit<TelemetricsOptions, 'dataDir'>> & { dataDir: string };

  constructor(
    private readonly host: string,
    private readonly port = 3001,
    opts: TelemetricsOptions = {},
  ) {
    super();
    this.opts = {
      model: 'S5',
      columnAxis: 'X',
      countsPerDegree: 15625,
      invertPan: false,
      invertTilt: false,
      invertZoom: false,
      presetTimeMs: 3000,
      curve: 'cubic',
      dataDir: path.join(configDir(), 'telemetrics'),
      ...opts,
    };
    this.loadPresets();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private get presetFile() {
    return path.join(this.opts.dataDir, `${this.host.replace(/[^\w.-]/g, '_')}_${this.port}.json`);
  }

  private loadPresets() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.presetFile, 'utf8')) as Record<string, StoredPreset>;
      for (const [k, v] of Object.entries(raw)) this.presets.set(Number(k), v);
    } catch {
      /* no presets yet */
    }
  }

  private savePresets() {
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    fs.writeFileSync(this.presetFile, JSON.stringify(Object.fromEntries(this.presets), null, 2));
  }

  async connect(): Promise<unknown> {
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      s.setNoDelay(true);
      const fail = (err: Error) => reject(err);
      s.once('error', fail);
      s.once('connect', () => {
        s.off('error', fail);
        s.on('error', (err) => this.emit('error', err));
        resolve();
      });
      s.on('data', (d) => this.onData(d.toString('latin1')));
      s.on('close', () => {
        const was = this.connected;
        this.connected = false;
        this.stopTimers();
        if (was) this.emit('disconnected');
      });
      this.sock = s;
    });
    this.connected = true;
    this.write('\r');
    this.pollTimer = setInterval(() => this.write('ptzfxymi\r'), 250);
    const info = { model: this.opts.model, host: this.host, port: this.port };
    this.emit('connected', info);
    return info;
  }

  disconnect(): void {
    if (this.connected) this.write(`\rP${TM_NEUTRAL}\rT${TM_NEUTRAL}\rZ${TM_NEUTRAL}\r`);
    this.stopTimers();
    this.sock?.destroy();
    this.sock = null;
    this.connected = false;
  }

  private stopTimers() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.focusTimer) clearInterval(this.focusTimer);
    this.pollTimer = this.focusTimer = null;
    this.moveToken++;
  }

  private write(data: string | Buffer) {
    if (!this.sock) throw new Error('Telemetrics head not connected');
    this.sock.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split('\r');
    this.buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\n/g, '').trim();
      if (!line) continue;
      if (line.startsWith('CH=')) {
        this.bufferLevel = { n: Number(line.slice(3)), at: Date.now() };
        continue;
      }
      if (line.startsWith('#') || /[a-zA-Z]/.test(line)) continue;
      const nums = line.match(/-?\d+/g)?.map(Number) ?? [];
      if (nums.length >= 8) {
        const p = Object.fromEntries(POS_KEYS.map((k, i) => [k, nums[i]])) as HeadPos;
        this.pos = p;
        for (const w of this.posWaiters.splice(0)) w(p);
      }
    }
  }

  private nextPosition(timeoutMs = 1500): Promise<HeadPos> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Telemetrics head: no position reply')), timeoutMs);
      this.posWaiters.push((p) => {
        clearTimeout(t);
        resolve(p);
      });
      this.write('ptzfxymi\r');
    });
  }

  /** Pan/tilt in degrees, zoom 0..1 (0 = wide end of the 0..65535 range). */
  async readPose(): Promise<{ pan: number; tilt: number; zoom: number }> {
    const p = await this.nextPosition();
    const k = this.opts.countsPerDegree;
    return { pan: p.pan / k, tilt: p.tilt / k, zoom: p.zoom / 65535 };
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'ptz':
        this.cancelMove();
        this.write(`P${speed(num('pan'), this.opts.invertPan)}T${speed(num('tilt'), this.opts.invertTilt)}\r`);
        return true;
      case 'setZoom':
        this.cancelMove();
        // Bridge convention: positive = tele. On these heads a LOW value zooms in.
        this.write(`Z${speed(-num('value'), this.opts.invertZoom)}\r`);
        return true;
      case 'setFocus':
        this.setFocusSpeed(num('value'));
        return true;
      case 'setColumn':
        this.cancelMove();
        this.write(`${this.opts.columnAxis}${speed(num('value'))}\r`);
        return true;
      case 'storePreset': {
        const p = await this.nextPosition();
        const n = num('value');
        this.presets.set(n, { pos: p, timeMs: num('timeMs', this.presets.get(n)?.timeMs ?? this.opts.presetTimeMs) });
        this.savePresets();
        return true;
      }
      case 'recallPreset': {
        const pr = this.presets.get(num('value'));
        if (!pr) return false;
        await this.moveTo(pr.pos, num('timeMs', pr.timeMs));
        return true;
      }
      case 'ptzAbsolute': {
        const cur = this.pos ?? (await this.nextPosition());
        const k = this.opts.countsPerDegree;
        const target: HeadPos = { ...cur, pan: num('pan') * k, tilt: num('tilt') * k };
        if (params['zoom'] !== undefined) target.zoom = Math.round(num('zoom') * 65535);
        await this.moveTo(target, num('timeMs', this.opts.presetTimeMs));
        return true;
      }
      case 'zoomAbsolute': {
        const cur = this.pos ?? (await this.nextPosition());
        await this.moveTo({ ...cur, zoom: Math.round(num('zoom') * 65535) }, num('timeMs', 1500));
        return true;
      }
      default:
        return false;
    }
  }

  private setFocusSpeed(v: number) {
    this.focusSpeed = Math.max(-100, Math.min(100, v));
    if (this.focusSpeed === 0) {
      if (this.focusTimer) clearInterval(this.focusTimer);
      this.focusTimer = null;
      return;
    }
    if (!this.focusTimer) {
      const step = () => {
        const n = Math.round((this.focusSpeed / 100) * 20);
        if (n) this.write(`FI${n}\r`);
      };
      step();
      this.focusTimer = setInterval(step, 100);
    }
  }

  private cancelMove() {
    this.moveToken++;
  }

  /** Eased move to an absolute head position. S5: keyframe stream; S2/S4: CX. */
  async moveTo(target: HeadPos, timeMs: number): Promise<void> {
    const token = ++this.moveToken;
    const from = this.pos ?? (await this.nextPosition());
    if (this.opts.model !== 'S5') {
      const t = target;
      this.write(`\x18\r\rCX ${t.pan} ${t.tilt} ${t.zoom} ${t.focus} ${t.x} ${t.iris} ${t.black} ${t.y} ${Math.round(timeMs)}\r`);
      return;
    }
    const axes: (keyof HeadPos)[] = ['pan', 'tilt', 'zoom', 'focus', 'x', 'y'];
    const pick = (p: HeadPos): Pose => Object.fromEntries(axes.map((a) => [a, p[a]]));
    const frames = easedTrajectory(pick(from), pick(target), Math.max(timeMs, 50), 50, this.opts.curve);
    // Start with a reset frame carrying the first position, then append with flow control.
    this.bufferLevel = null;
    this.write(keyframe(0xff, frames[0] as Partial<HeadPos>));
    for (let i = 1; i < frames.length; i++) {
      if (token !== this.moveToken) return this.abortKeyframes();
      const ok = await this.waitForRoom(token);
      if (!ok) return this.abortKeyframes();
      this.write(keyframe(0x00, frames[i] as Partial<HeadPos>));
    }
  }

  /** Waits for a `CH=` reply with room in the head's buffer (< 10 frames). */
  private async waitForRoom(token: number): Promise<boolean> {
    const start = Date.now();
    let lastQuery = 0;
    for (;;) {
      if (token !== this.moveToken || !this.connected) return false;
      const lvl = this.bufferLevel;
      if (lvl && lvl.at >= start - 60 && lvl.n >= 0 && lvl.n < 10) {
        this.bufferLevel = null;
        return true;
      }
      if (lvl && lvl.n < 0) return false; // head aborted the keyframe move
      if (Date.now() - start > 1000) return false;
      if (Date.now() - lastQuery > 100) {
        this.write(keyframe(0xef));
        lastQuery = Date.now();
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private abortKeyframes() {
    if (!this.connected) return;
    this.write(`\rP${TM_NEUTRAL}\rT${TM_NEUTRAL}\rZ${TM_NEUTRAL}\rF${TM_NEUTRAL}\rX${TM_NEUTRAL}\rY${TM_NEUTRAL}\r`);
    this.write(keyframe(0xff));
  }
}
