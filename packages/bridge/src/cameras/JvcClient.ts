/**
 * JVC Camera Client (CONNECTED CAM / KY-PZ PTZ / ProHD)
 *
 * Implements JVC's web API as documented in the "JVC Camcorder Web API
 * Reference" (pro.jvc.com) and verified against the official Bitfocus
 * companion-module-jvc-ptz implementation:
 *
 *   1. Login:    GET /api.php with HTTP Digest authentication →
 *                SessionID arrives in a Set-Cookie header ("SessionID=…").
 *   2. Commands: POST /cgi-bin/api.cgi
 *                body { Request: { Command, Params, SessionID } }
 *   3. A Response.Result of "SessionError" means the session expired —
 *                re-login once and resend.
 *
 * Verified command vocabulary (from the JVC web-remote):
 *   GetSystemInfo / GetCamStatus / GetPTPosition
 *   JoyStickOperation   { PanDirection: Left|Right|Stop, PanSpeed: 0-8,
 *                         TiltDirection: Up|Down|Stop,  TiltSpeed: 0-8 }
 *   ZoomSwitchOperation { Direction: Tele|Wide|Stop, Speed: 0-8 }
 *   SetWebButtonEvent   { Kind: Iris,  Button: Open1|Close1 }
 *                       { Kind: Gain,  Button: Up1|Down1 }
 *                       { Kind: Whb,   Button: Awb|3200K|5600K|Manual|Faw }
 *                       { Kind: Focus, Button: … }        (step buttons)
 *   SetPTZPreset        { No: 1-100, Operation: Move|Set|Delete }
 *   SetCamCtrl          { CamCtrl: Rec|Stop }
 *
 * JVC exposes iris/gain only as *step* buttons over this API, so absolute
 * RCP values are translated into steps relative to the last commanded value.
 */
import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient } from './GenericCameraClient.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Minimal HTTP Digest (MD5 / qop=auth) client for JVC's /api.php login. */
async function digestGet(url: string, username: string, password: string): Promise<Response> {
  const first = await fetch(url, { method: 'GET' });
  if (first.status !== 401) return first;

  const challenge = first.headers.get('www-authenticate') ?? '';
  const field = (name: string) =>
    new RegExp(`${name}="?([^",]+)"?`, 'i').exec(challenge)?.[1] ?? '';
  const realm = field('realm');
  const nonce = field('nonce');
  const qop = field('qop');
  const opaque = field('opaque');

  const uri = new URL(url).pathname;
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`GET:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth =
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  return fetch(url, { method: 'GET', headers: { Authorization: auth } });
}

export class JvcClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private username: string;
  private password: string;
  private sessionId: string | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _state: CameraState = {};
  /** Last absolute iris/gain the dashboard asked for — used for step deltas. */
  private lastIris = 128;
  private lastGain = 0;

  constructor(host: string, port = 80, username = '', password = '') {
    super();
    this.base = `http://${host}:${port}`;
    this.username = username;
    this.password = password;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ─── Session ────────────────────────────────────────────────────────────

  private async login(): Promise<void> {
    const res = await digestGet(`${this.base}/api.php`, this.username, this.password);
    if (res.status === 401) {
      throw new Error('JVC-Login fehlgeschlagen (Benutzername/Passwort prüfen)');
    }
    if (!res.ok) throw new Error(`JVC-Login: HTTP ${res.status}`);
    // SessionID arrives via Set-Cookie: "SessionID=<value>; …"
    const cookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [res.headers.get('set-cookie') ?? ''];
    for (const c of cookies) {
      const m = /SessionID=([^;]+)/i.exec(c);
      if (m) {
        this.sessionId = m[1];
        return;
      }
    }
    throw new Error('JVC-Login: keine SessionID im Set-Cookie erhalten');
  }

  private async command(command: string, params?: Record<string, unknown>, retried = false): Promise<Record<string, unknown>> {
    if (!this.sessionId) await this.login();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.base}/cgi-bin/api.cgi`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Request: { Command: command, ...(params ? { Params: params } : {}), SessionID: this.sessionId },
        }),
      });
      if (!res.ok) throw new Error(`JVC HTTP ${res.status} (${command})`);
      const json = (await res.json().catch(() => ({}))) as { Response?: { Result?: string } };
      if (json.Response?.Result === 'SessionError' && !retried) {
        this.sessionId = null;
        return this.command(command, params, true);
      }
      return json as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect(): Promise<unknown> {
    await this.login();
    const info = await this.command('GetSystemInfo');
    this.connected = true;
    this.emit('connected', { host: this.base, info });
    this.pollTimer = setInterval(() => {
      this.command('GetCamStatusMinimum').catch(() => {});
    }, 3000);
    return info;
  }

  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
    this.sessionId = null;
    this.emit('disconnected');
  }

  // ─── RCP mapping ────────────────────────────────────────────────────────

  /** Press a step button n times (JVC has no absolute iris/gain over this API). */
  private async steps(kind: string, upButton: string, downButton: string, delta: number, maxSteps = 8): Promise<void> {
    const n = Math.min(maxSteps, Math.abs(delta));
    const button = delta > 0 ? upButton : downButton;
    for (let i = 0; i < n; i++) {
      await this.command('SetWebButtonEvent', { Kind: kind, Button: button });
    }
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris': {
        // 0-255 absolute → step presses relative to the last commanded value.
        // ~16 RCP units per iris step keeps a full sweep within ~16 presses.
        const target = num('value');
        const delta = Math.round((target - this.lastIris) / 16);
        if (delta !== 0) await this.steps('Iris', 'Open1', 'Close1', delta);
        this.lastIris = target;
        this._state.iris = target;
        this.emit('stateChanged', { iris: target });
        return true;
      }
      case 'setMasterGain': {
        const target = num('value');
        const delta = target - this.lastGain;
        if (delta !== 0) await this.steps('Gain', 'Up1', 'Down1', delta);
        this.lastGain = target;
        this._state.masterGain = target;
        this.emit('stateChanged', { masterGain: target });
        return true;
      }
      case 'setColorTemp': {
        // JVC exposes WB presets, not arbitrary Kelvin: snap to 3200K/5600K.
        const kelvin = num('value', 5600);
        await this.command('SetWebButtonEvent', {
          Kind: 'Whb',
          Button: kelvin < 4400 ? '3200K' : '5600K',
        });
        return true;
      }
      case 'autoWhiteBalance':
        await this.command('SetWebButtonEvent', { Kind: 'Whb', Button: 'Awb' });
        return true;
      case 'ptz': {
        const pan = num('pan');
        const tilt = num('tilt');
        await this.command('JoyStickOperation', {
          PanDirection: pan < 0 ? 'Left' : pan > 0 ? 'Right' : 'Stop',
          PanSpeed: Math.min(8, Math.round((Math.abs(pan) / 100) * 8)),
          TiltDirection: tilt > 0 ? 'Up' : tilt < 0 ? 'Down' : 'Stop',
          TiltSpeed: Math.min(8, Math.round((Math.abs(tilt) / 100) * 8)),
        });
        return true;
      }
      case 'setZoom': {
        const v = num('value');
        await this.command('ZoomSwitchOperation', {
          Direction: v > 0 ? 'Tele' : v < 0 ? 'Wide' : 'Stop',
          Speed: Math.min(8, Math.round((Math.abs(v) / 100) * 8)),
        });
        return true;
      }
      case 'setFocus': {
        // Step buttons; Near1/Far1 naming follows the Iris/Gain pattern and
        // needs confirmation against the camcorder API reference.
        const v = num('value');
        if (v !== 0) {
          await this.command('SetWebButtonEvent', { Kind: 'Focus', Button: v > 0 ? 'Near1' : 'Far1' });
        }
        return true;
      }
      case 'recallPreset':
        await this.command('SetPTZPreset', { No: num('value'), Operation: 'Move' });
        return true;
      case 'storePreset':
        await this.command('SetPTZPreset', { No: num('value'), Operation: 'Set' });
        return true;
      case 'setRecording':
        await this.command('SetCamCtrl', { CamCtrl: Boolean(params['on']) ? 'Rec' : 'Stop' });
        return true;
      default:
        return false;
    }
  }
}
