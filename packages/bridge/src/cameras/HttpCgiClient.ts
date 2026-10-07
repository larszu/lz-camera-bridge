/**
 * HTTP-CGI PTZ client — an alternative control path for PTZ heads that expose
 * an HTTP CGI interface instead of (or alongside) VISCA-over-IP.
 *
 * Two families, one client. The wire calls differ, the RCP mapping is the same:
 *
 *  - `vissonic`  PTZOptics-style firmware (Vissonic, PTZOptics, and clones):
 *                GET /cgi-bin/ptzctrl.cgi?ptzcmd&<action>&<panSpeed>&<tiltSpeed>
 *                Verified against the camera's own web UI (build.min.js,
 *                object `navigator_api`) and a live PTZOptics-clone: the
 *                control CGI needs no authentication. Power is NOT on the
 *                CGI at all — these clones take VISCA over TCP 5678, measured
 *                on the installation: `81 09 04 00 FF` → `90 50 02 FF` (on)
 *                or `90 50 03 FF` (standby).
 *
 *  - `sony`      Sony SRG/BRC CGI: GET /command/ptzf.cgi?PanTiltMove=...,
 *                ZoomMove=..., FocusMove=..., presetposition.cgi?PresetCall=...
 *                Verified live against a Sony SRG-A40: the CGI is refused with
 *                403 unless a `Referer` header matching the camera is sent, and
 *                then wants Digest authentication. Power is
 *                `/command/main.cgi?System=on|standby`, read back from
 *                `/command/inquiry.cgi?inq=sysinfo` (`Power=on|standby`).
 *
 * Why this exists next to `ViscaClient`, which already drives the same heads:
 * some rooms block the VISCA UDP ports but allow HTTP, and the camera's own
 * app speaks exactly this CGI. It is an alternative transport to the same
 * cameras, deliberately not a second command vocabulary — the RCP verbs
 * (`ptz`, `setZoom`, `setFocus`, `recallPreset`, `storePreset`, `autoFocus`,
 * `setCameraPower`, `home`, `osd`) map straight onto it, so the RCP behaves
 * identically to every other head.
 *
 * ORDER. Every request goes through one queue per camera. A `stop` that
 * overtook its `move` on the network (each was its own fetch, the probe
 * before it asynchronous) left the head running away — a real defect of the
 * predecessor. In the queue a stop can never pass a move; and while a move
 * is waiting, a newer move replaces it instead of queueing behind, so a
 * slow camera gets the latest stick position, not a backlog.
 */
import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { createConnection } from 'net';
import { CameraState } from '../protocol/CcuClient.js';
import {
  parseSonyCgiPose, sonyCgiAbsolutePanTilt, sonyCgiAbsoluteZoom,
  viscaAbsolutePanTilt, viscaZoomDirect, VISCA_INQ_PAN_TILT, VISCA_INQ_ZOOM,
  parseViscaPanTilt, parseViscaZoom, VISCA_UNITS_PER_DEG, type Pose,
} from '../protocol/ptzPose.js';

export type CgiFamily = 'vissonic' | 'sony';

export interface HttpCgiOptions {
  host: string;
  port?: number;
  family?: CgiFamily;
  username?: string;
  password?: string;
  /**
   * Offset between the preset number the RCP shows and the one the camera
   * expects. PTZOptics/Vissonic firmware counts from 0 (offset -1); Sony from
   * 1 (offset 0). Configurable because it varies by firmware.
   */
  presetOffset?: number;
  /** Poll the power state in this rhythm (ms). 0 disables. */
  powerPollMs?: number;
  /** VISCA-over-TCP port of a PTZOptics-style head (power and absolute pose). */
  viscaPort?: number;
  /** Position units per degree (VISCA scale), default 14.4. */
  unitsPerDeg?: number;
}

export const VISCA_TCP_PORT = 5678;
export const VISCA_POWER_ON = '8101040002ff';
export const VISCA_POWER_STANDBY = '8101040003ff';
export const VISCA_POWER_INQUIRY = '81090400ff';
const POWER_POLL_MS = 10000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Map an RCP -100..100 velocity to a speed in [1..max] (0 stays 0 = stop). */
function velocityToSpeed(value: number, max: number): number {
  if (value === 0) return 0;
  return Math.max(1, Math.round((Math.abs(value) / 100) * max));
}

/**
 * Sony `inquiry.cgi?inq=imaging` → the white balance gains, or null when absent.
 *
 * Measured on an SRG-A40 (firmware 4.00): the answer carries
 * `WhiteBalanceCrGain` and `WhiteBalanceCbGain` (0..255) next to
 * `WhiteBalanceMode`. Raising CrGain by 30 lifted the mean R′ of the picture
 * from 0.52 to 0.90; raising CbGain by 30 lifted B′ from 0.51 to 0.75. So
 * Cr = red, Cb = blue. Both act like colour-difference gains: G′ moves the
 * other way. The camera has no G gain.
 */
export function parseSonyImaging(body: string | undefined): { whiteR: number; whiteB: number } | null {
  if (!body) return null;
  const r = /(?:^|&|\s)WhiteBalanceCrGain=(\d+)/.exec(body);
  const b = /(?:^|&|\s)WhiteBalanceCbGain=(\d+)/.exec(body);
  if (!r || !b) return null;
  return { whiteR: Number(r[1]), whiteB: Number(b[1]) };
}

/**
 * Sony manual white balance: the bus triple {r, g, b} (0..255) → imaging.cgi.
 * Only R and B exist on the camera; `g` is not sent. Switching to manual is
 * part of the command, because the gains are only valid in manual mode.
 */
export function sonyWhiteBalancePath(r: number, b: number): string {
  return `/command/imaging.cgi?WhiteBalanceMode=manual&WhiteBalanceCrGain=${clamp(r, 0, 255)}&WhiteBalanceCbGain=${clamp(b, 0, 255)}`;
}

/** Power reply of either family → on/standby, or null when unreadable. */
export function parsePowerReply(family: CgiFamily, body: string | undefined): boolean | null {
  if (!body) return null;
  if (family === 'sony') {
    const m = /(?:^|&|\s)Power=(on|standby)/i.exec(body);
    return m ? m[1].toLowerCase() === 'on' : null;
  }
  const hex = body.replace(/\s/g, '').toLowerCase();
  // Answer x0 50 0p FF: p=2 on, p=3 standby. Skip preceding ACKs.
  const m = /[89a-f]0500([23])ff/.exec(hex);
  return m ? m[1] === '2' : null;
}

type QueueKind = 'ptz' | 'zoom' | 'focus' | 'other';

interface Job {
  kind: QueueKind;
  run: () => Promise<void>;
  resolve: () => void;
}

export class HttpCgiClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly family: CgiFamily;
  private readonly username: string;
  private readonly password: string;
  private readonly presetOffset: number;
  private readonly powerPollMs: number;
  private readonly viscaPort: number;
  private readonly unitsPerDeg: number;
  private connected = false;
  private readonly _state: CameraState = {};
  private queue: Job[] = [];
  private running = false;
  private powerTimer: ReturnType<typeof setInterval> | null = null;
  private powerRecheck: ReturnType<typeof setTimeout>[] = [];

  constructor(opts: HttpCgiOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 80;
    this.family = opts.family ?? 'vissonic';
    this.username = opts.username ?? '';
    this.password = opts.password ?? '';
    this.presetOffset = opts.presetOffset ?? (this.family === 'vissonic' ? -1 : 0);
    this.powerPollMs = opts.powerPollMs ?? POWER_POLL_MS;
    this.viscaPort = opts.viscaPort ?? VISCA_TCP_PORT;
    this.unitsPerDeg = opts.unitsPerDeg ?? VISCA_UNITS_PER_DEG;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * "Connecting" over stateless CGI means one reachability probe, not a
   * session. A probe that a stopped PTZ move answers proves the head is there
   * without moving it.
   */
  async connect(): Promise<void> {
    const probe =
      this.family === 'sony'
        ? '/command/inquiry.cgi?inq=ptzf'
        : '/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop&1&1';
    await this.request(probe);
    this.connected = true;
    this.emit('connected', { host: this.host, family: this.family });
    void this.readPower();
    void this.readImaging();
    if (this.powerPollMs > 0) {
      this.powerTimer = setInterval(() => { void this.readPower(); void this.readImaging(); }, this.powerPollMs);
      this.powerTimer.unref?.();
    }
  }

  disconnect(): void {
    this.connected = false;
    if (this.powerTimer) clearInterval(this.powerTimer);
    this.powerTimer = null;
    for (const t of this.powerRecheck) clearTimeout(t);
    this.powerRecheck = [];
    this.queue = [];
    this.emit('disconnected');
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'ptz': {
        // Pan/tilt drive: RCP gives velocities -100..100, 0 = stop.
        const pan = num('pan');
        const tilt = num('tilt');
        await this.enqueue(pan === 0 && tilt === 0 ? 'other' : 'ptz', () => this.request(this.ptzMovePath(pan, tilt)));
        return true;
      }
      case 'home':
        await this.enqueue('other', () => this.request(this.homePath()));
        return true;
      case 'setZoom': {
        const v = num('value'); // -100..100, + = tele, 0 = stop
        await this.enqueue(v === 0 ? 'other' : 'zoom', () => this.request(this.zoomPath(v)));
        return true;
      }
      case 'setFocus': {
        const v = num('value'); // -100..100, + = near, 0 = stop
        await this.enqueue(v === 0 ? 'other' : 'focus', () => this.request(this.focusPath(v)));
        return true;
      }
      case 'autoFocus':
        await this.enqueue('other', () => this.request(this.focusModePath('auto')));
        return true;
      case 'manualFocus':
        await this.enqueue('other', () => this.request(this.focusModePath('manual')));
        return true;
      case 'recallPreset':
        await this.enqueue('other', () => this.request(this.presetPath('call', num('value'))));
        return true;
      case 'storePreset':
        await this.enqueue('other', () => this.request(this.presetPath('set', num('value'))));
        return true;
      case 'ptzAbsolute': {
        // The PTZOptics-style CGI has no absolute verb; those heads take VISCA
        // over TCP 5678 (measured on the installation) — the same packets
        // ViscaClient sends over UDP. Sony's CGI has AbsolutePanTilt.
        const pan = num('pan');
        const tilt = num('tilt');
        const zoom = params['zoom'] !== undefined ? num('zoom') : undefined;
        await this.enqueue('other', async () => {
          if (this.family === 'sony') {
            await this.request(sonyCgiAbsolutePanTilt(pan, tilt, 24, this.unitsPerDeg));
            if (zoom !== undefined) await this.request(sonyCgiAbsoluteZoom(zoom));
          } else {
            await viscaTcp(this.host, this.viscaPort, hex(viscaAbsolutePanTilt(pan, tilt, this.unitsPerDeg)), 4000);
            if (zoom !== undefined) await viscaTcp(this.host, this.viscaPort, hex(viscaZoomDirect(zoom)), 4000);
          }
        });
        return true;
      }
      case 'zoomAbsolute': {
        const zoom = num('zoom');
        await this.enqueue('other', async () => {
          if (this.family === 'sony') await this.request(sonyCgiAbsoluteZoom(zoom));
          else await viscaTcp(this.host, this.viscaPort, hex(viscaZoomDirect(zoom)), 4000);
        });
        return true;
      }
      case 'osd': {
        // On-screen menu: only the PTZOptics-style firmware exposes it over CGI.
        if (this.family !== 'vissonic') return false;
        const action = String(params['action'] ?? 'menu');
        const path =
          action === 'enter' ? '/cgi-bin/ptzctrl.cgi?navigate_mode&OSD_ENTER'
          : action === 'back' ? '/cgi-bin/ptzctrl.cgi?navigate_mode&OSD_BACK'
          : '/cgi-bin/ptzctrl.cgi?osdcmd&menu';
        await this.enqueue('other', () => this.request(path));
        return true;
      }
      case 'setCameraPower': {
        const on = Boolean(params['on']);
        await this.enqueue('other', async () => {
          if (this.family === 'sony') {
            await this.request(`/command/main.cgi?System=${on ? 'on' : 'standby'}`);
          } else {
            await viscaTcp(this.host, this.viscaPort, on ? VISCA_POWER_ON : VISCA_POWER_STANDBY, 4000);
          }
        });
        // Read back soon and again later: a head takes seconds to wake.
        for (const ms of [1500, 10000]) {
          const t = setTimeout(() => void this.readPower(), ms);
          t.unref?.();
          this.powerRecheck.push(t);
        }
        return true;
      }
      case 'setWhiteBalance': {
        // Sony only: manual white balance over imaging.cgi (R/B gain, no G).
        if (this.family !== 'sony') return false;
        const r = num('r', 128), b = num('b', 128);
        await this.enqueue('other', async () => {
          await this.request(sonyWhiteBalancePath(r, b));
          await this.readImaging();
        });
        return true;
      }
      default:
        // Iris and the rest of the paint have no PTZ-CGI equivalent.
        console.log(`[HTTP-CGI] Unbekanntes oder nicht unterstütztes Kommando: ${cmd}`);
        return false;
    }
  }

  /** Where the head is. Sony: `inquiry.cgi?inq=ptzf`; Vissonic: VISCA inquiries over TCP. */
  async readPose(): Promise<Pose> {
    if (this.family === 'sony') {
      const pose = parseSonyCgiPose(await this.request('/command/inquiry.cgi?inq=ptzf'), this.unitsPerDeg);
      if (!pose) throw new Error('Sony CGI: AbsolutePTZF missing in the answer');
      return pose;
    }
    const pt = parseViscaPanTilt(Buffer.from(await viscaTcp(this.host, this.viscaPort, hex(VISCA_INQ_PAN_TILT), 3000), 'hex'), this.unitsPerDeg);
    if (!pt) throw new Error('VISCA: pan/tilt answer unreadable');
    let zoom: number | undefined;
    try {
      zoom = parseViscaZoom(Buffer.from(await viscaTcp(this.host, this.viscaPort, hex(VISCA_INQ_ZOOM), 3000), 'hex')) ?? undefined;
    } catch { /* pose without zoom */ }
    return { ...pt, ...(zoom !== undefined ? { zoom } : {}) };
  }

  /** Sony: read the white balance gains back. Emits `stateChanged` only with an answer. */
  async readImaging(): Promise<void> {
    if (!this.connected || this.family !== 'sony') return;
    try {
      const wb = parseSonyImaging(await this.request('/command/inquiry.cgi?inq=imaging'));
      if (!wb) return;
      Object.assign(this._state, wb);
      this.emit('stateChanged', wb);
    } catch {
      // standby or unreachable: no value, no guess
    }
  }

  /** Ask the head whether it is on. Emits `stateChanged` only with an answer — never guesses. */
  async readPower(): Promise<void> {
    if (!this.connected) return;
    try {
      const body =
        this.family === 'sony'
          ? await this.request('/command/inquiry.cgi?inq=sysinfo')
          : await viscaTcp(this.host, this.viscaPort, VISCA_POWER_INQUIRY, 3000);
      const on = parsePowerReply(this.family, body);
      if (on === null) return;
      this._state.cameraPower = on;
      this.emit('stateChanged', { cameraPower: on });
    } catch {
      // A head in standby often does not answer at all; that is not an error worth a banner.
    }
  }

  // ── Queue ───────────────────────────────────────────────────────────────────

  private enqueue(kind: QueueKind, run: () => Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (kind !== 'other') {
        // The newest drive value replaces a waiting one of the same axis.
        const i = this.queue.findIndex((j) => j.kind === kind);
        if (i >= 0) {
          const old = this.queue[i];
          this.queue.splice(i, 1);
          old.resolve();
        }
      }
      this.queue.push({
        kind,
        run: () => run().then(() => undefined, reject),
        resolve,
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await job.run();
        } finally {
          job.resolve();
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ── Path builders ───────────────────────────────────────────────────────────

  private ptzMovePath(pan: number, tilt: number): string {
    if (this.family === 'sony') {
      if (pan === 0 && tilt === 0) return '/command/ptzf.cgi?PanTiltMove=stop,0,0';
      const dir = sonyDirection(pan, tilt);
      const p = velocityToSpeed(pan, 24) || (tilt !== 0 ? 1 : 0);
      const t = velocityToSpeed(tilt, 24) || (pan !== 0 ? 1 : 0);
      return `/command/ptzf.cgi?PanTiltMove=${dir},${p},${t}`;
    }
    // Vissonic/PTZOptics: pan speed 1..24, tilt speed 1..20.
    if (pan === 0 && tilt === 0) {
      return '/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop&1&1';
    }
    const dir = vissonicDirection(pan, tilt);
    const p = Math.max(1, velocityToSpeed(pan, 24) || velocityToSpeed(tilt, 24));
    const t = Math.max(1, velocityToSpeed(tilt, 20) || velocityToSpeed(pan, 20));
    return `/cgi-bin/ptzctrl.cgi?ptzcmd&${dir}&${p}&${t}`;
  }

  private homePath(): string {
    if (this.family === 'sony') return '/command/ptzf.cgi?PanTiltReset=on';
    return '/cgi-bin/ptzctrl.cgi?ptzcmd&home&12&10';
  }

  private zoomPath(v: number): string {
    if (this.family === 'sony') {
      if (v === 0) return '/command/ptzf.cgi?ZoomMove=stop,0';
      const s = velocityToSpeed(v, 8);
      return `/command/ptzf.cgi?ZoomMove=${v > 0 ? 'tele' : 'wide'},${s}`;
    }
    if (v === 0) return '/cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop&1';
    const s = velocityToSpeed(v, 7);
    return `/cgi-bin/ptzctrl.cgi?ptzcmd&${v > 0 ? 'zoomin' : 'zoomout'}&${s}`;
  }

  private focusPath(v: number): string {
    if (this.family === 'sony') {
      if (v === 0) return '/command/ptzf.cgi?FocusMove=stop,0';
      const s = velocityToSpeed(v, 8);
      return `/command/ptzf.cgi?FocusMove=${v > 0 ? 'near' : 'far'},${s}`;
    }
    if (v === 0) return '/cgi-bin/ptzctrl.cgi?ptzcmd&focusstop&1';
    const s = velocityToSpeed(v, 7);
    return `/cgi-bin/ptzctrl.cgi?ptzcmd&${v > 0 ? 'focusin' : 'focusout'}&${s}`;
  }

  private focusModePath(mode: 'auto' | 'manual'): string {
    if (this.family === 'sony') return `/command/ptzf.cgi?FocusMode=${mode}`;
    return `/cgi-bin/ptzctrl.cgi?ptzcmd&${mode === 'auto' ? 'afocus' : 'mfocus'}`;
  }

  private presetPath(action: 'call' | 'set', preset: number): string {
    const n = clamp(preset, 1, 255) + this.presetOffset;
    if (this.family === 'sony') {
      const verb = action === 'call' ? 'PresetCall' : 'PresetSet';
      // Sony's PresetCall takes a recall speed; a middle speed is a safe default.
      return `/command/presetposition.cgi?${verb}=${n}${action === 'call' ? ',20' : ''}`;
    }
    return `/cgi-bin/ptzctrl.cgi?ptzcmd&${action === 'call' ? 'poscall' : 'posset'}&${n}`;
  }

  // ── HTTP with Referer + Digest ───────────────────────────────────────────────

  private baseUrl(): string {
    const suffix = this.port === 80 ? '' : `:${this.port}`;
    return `http://${this.host}${suffix}`;
  }

  /**
   * One CGI GET. Always carries a `Referer` (the Sony CGI answers 403 without
   * it) and answers a Digest challenge when the camera sends one (the Vissonic
   * control CGI needs none, its web UI does; the Sony needs both).
   */
  private async request(path: string): Promise<string> {
    const url = `${this.baseUrl()}${path}`;
    const headers: Record<string, string> = { Referer: `${this.baseUrl()}/` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      let res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 401 && this.username) {
        const wa = res.headers.get('www-authenticate') ?? '';
        if (/^digest/i.test(wa)) {
          headers.Authorization = this.buildDigest('GET', path, wa);
          res = await fetch(url, { headers, signal: controller.signal });
        } else if (/^basic/i.test(wa)) {
          const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
          headers.Authorization = `Basic ${token}`;
          res = await fetch(url, { headers, signal: controller.signal });
        }
      }
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP-CGI ${res.status} (${path})`);
      }
      return res.status === 204 ? '' : await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout zur Kamera ${this.host}:${this.port}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildDigest(method: string, uri: string, header: string): string {
    const c = parseDigestChallenge(header);
    const realm = c.realm ?? '';
    const nonce = c.nonce ?? '';
    const qop = c.qop;
    const ha1 = md5(`${this.username}:${realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const fields = [
      `username="${this.username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${c.algorithm ?? 'MD5'}`,
    ];
    let response: string;
    if (qop) {
      const nc = '00000001';
      const cnonce = randomBytes(8).toString('hex');
      const q = qop.split(',')[0].trim();
      response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${q}:${ha2}`);
      fields.push(`qop=${q}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    } else {
      response = md5(`${ha1}:${nonce}:${ha2}`);
    }
    if (c.opaque) fields.push(`opaque="${c.opaque}"`);
    fields.push(`response="${response}"`);
    return `Digest ${fields.join(', ')}`;
  }
}

// ── VISCA over TCP (power only) ───────────────────────────────────────────────

/**
 * One raw VISCA packet over TCP, answered by the first completion or error
 * frame (`x0 5y … FF` / `x0 6y … FF`); a bare ACK (`x0 4y FF`) is not the
 * end. Returns the hex of everything received.
 */
export function viscaTcp(host: string, port: number, hex: string, timeoutMs: number): Promise<string> {
  const packet = Buffer.from(hex.replace(/\s/g, ''), 'hex');
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(received.toString('hex'));
    };
    const socket = createConnection({ host, port }, () => socket.write(packet));
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (isViscaDone(received)) finish();
    });
    socket.on('timeout', () => (received.length ? finish() : finish(new Error(`VISCA ${host}:${port}: timeout`))));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => (received.length ? finish() : finish(new Error(`VISCA ${host}:${port}: closed`))));
  });
}

/** True once a completion (y=5) or error (y=6) frame is in the buffer. */
export function isViscaDone(buf: Buffer): boolean {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const y = (buf[start + 1] ?? 0) >> 4;
    if (i - start >= 2 && (y === 5 || y === 6)) return true;
    start = i + 1;
  }
  return false;
}

function hex(bytes: number[]): string {
  return Buffer.from(bytes).toString('hex');
}

// ── Direction helpers ──────────────────────────────────────────────────────────

/** RCP pan/tilt velocities → Sony PanTiltMove direction word. */
export function sonyDirection(pan: number, tilt: number): string {
  const h = pan < 0 ? 'left' : pan > 0 ? 'right' : '';
  const v = tilt > 0 ? 'up' : tilt < 0 ? 'down' : '';
  if (h && v) return `${v}-${h}`;
  if (h) return h;
  if (v) return v;
  return 'stop';
}

/** RCP pan/tilt velocities → Vissonic/PTZOptics direction token. */
export function vissonicDirection(pan: number, tilt: number): string {
  const h = pan < 0 ? 'left' : pan > 0 ? 'right' : '';
  const v = tilt > 0 ? 'up' : tilt < 0 ? 'down' : '';
  if (h && v) return `${h}${v}`; // leftup, rightdown, …
  if (h) return h;
  if (v) return v;
  return 'ptzstop';
}

// ── Digest primitives ───────────────────────────────────────────────────────────

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

export function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rest = header.replace(/^Digest\s+/i, '');
  for (const part of rest.match(/(\w+)=(?:"([^"]*)"|([^,]*))/g) ?? []) {
    const m = /(\w+)=(?:"([^"]*)"|([^,]*))/.exec(part);
    if (m) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}
