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
 *                control CGI needs no authentication.
 *
 *  - `sony`      Sony SRG/BRC CGI: GET /command/ptzf.cgi?PanTiltMove=...,
 *                ZoomMove=..., FocusMove=..., presetposition.cgi?PresetCall=...
 *                Verified live against a Sony SRG-A40: the CGI is refused with
 *                403 unless a `Referer` header matching the camera is sent, and
 *                then wants Digest authentication.
 *
 * Why this exists next to `ViscaClient`, which already drives the same heads:
 * some rooms block the VISCA UDP ports but allow HTTP, and the camera's own
 * app speaks exactly this CGI. It is an alternative transport to the same
 * cameras, deliberately not a second command vocabulary — the RCP verbs
 * (`ptz`, `setZoom`, `setFocus`, `recallPreset`, `storePreset`, `autoFocus`,
 * `setCameraPower`) map straight onto it, so the RCP behaves identically to
 * every other head.
 */
import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { CameraState } from '../protocol/CcuClient.js';

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
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Map an RCP -100..100 velocity to a speed in [1..max] (0 stays 0 = stop). */
function velocityToSpeed(value: number, max: number): number {
  if (value === 0) return 0;
  return Math.max(1, Math.round((Math.abs(value) / 100) * max));
}

export class HttpCgiClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly family: CgiFamily;
  private readonly username: string;
  private readonly password: string;
  private readonly presetOffset: number;
  private connected = false;
  private readonly _state: CameraState = {};

  constructor(opts: HttpCgiOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 80;
    this.family = opts.family ?? 'vissonic';
    this.username = opts.username ?? '';
    this.password = opts.password ?? '';
    this.presetOffset = opts.presetOffset ?? (this.family === 'vissonic' ? -1 : 0);
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
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'ptz': {
        // Pan/tilt drive: RCP gives velocities -100..100, 0 = stop.
        const pan = num('pan');
        const tilt = num('tilt');
        await this.request(this.ptzMovePath(pan, tilt));
        return true;
      }
      case 'setZoom': {
        const v = num('value'); // -100..100, + = tele, 0 = stop
        await this.request(this.zoomPath(v));
        return true;
      }
      case 'setFocus': {
        const v = num('value'); // -100..100, + = near, 0 = stop
        await this.request(this.focusPath(v));
        return true;
      }
      case 'autoFocus':
        await this.request(this.focusModePath('auto'));
        return true;
      case 'recallPreset':
        await this.request(this.presetPath('call', num('value')));
        return true;
      case 'storePreset':
        await this.request(this.presetPath('set', num('value')));
        return true;
      case 'setCameraPower': {
        // Only Sony exposes power over this CGI; Vissonic has no equivalent.
        if (this.family !== 'sony') {
          console.log(`[HTTP-CGI] 'setCameraPower' wird von der ${this.family}-CGI nicht unterstützt`);
          return false;
        }
        await this.request(`/command/main.cgi?System=${params['on'] ? 'on' : 'standby'}`);
        this._state.cameraPower = Boolean(params['on']);
        this.emit('stateChanged', { cameraPower: this._state.cameraPower });
        return true;
      }
      default:
        // Iris/paint and white balance have no PTZ-CGI equivalent.
        console.log(`[HTTP-CGI] Unbekanntes oder nicht unterstütztes Kommando: ${cmd}`);
        return false;
    }
  }

  // ── Path builders ───────────────────────────────────────────────────────────

  private ptzMovePath(pan: number, tilt: number): string {
    if (this.family === 'sony') {
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
