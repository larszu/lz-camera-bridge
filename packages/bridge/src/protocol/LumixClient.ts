/**
 * Panasonic Lumix HTTP CGI Camera Client
 *
 * Controls Lumix cameras (S1, S5, GH5, GH6, etc.) via their
 * built-in WiFi/Ethernet HTTP CGI API.
 *
 * The camera exposes a simple HTTP endpoint:
 *   http://<ip>/cam.cgi?mode=<mode>&type=<type>&value=<value>
 *
 * Connection steps:
 *   1. GET /cam.cgi?mode=accctrl&type=req_acc&value=<app_name>&value2=<app_name>
 *   2. Camera returns an access token
 *   3. Subsequent requests include the token: &value=<token>
 *
 * Supported on: Lumix S1, S1R, S1H, S5, S5II, S5IIX, GH5, GH5S, GH6, BGH1, BS1H
 */

import { EventEmitter } from 'events';
import { CameraState } from './CcuClient.js';

export interface LumixClientOptions {
  /** Camera IP address */
  host: string;
  /** HTTP port (default 80) */
  port?: number;
  /** Application name for access control (default 'SonyCameraBridge') */
  appName?: string;
  /** Poll interval in milliseconds (default 2000) */
  pollInterval?: number;
}

export interface LumixCameraInfo {
  model?: string;
  firmware?: string;
  host: string;
  port: number;
}

// Lumix CGI modes
const CGI_PATH = '/cam.cgi';

// Iris value mappings (Lumix uses step-based iris values)
// F1.4 = 0, F1.7 = 1, F2.0 = 2, ... up to F22
const IRIS_STEPS = [
  'F1.4', 'F1.7', 'F2.0', 'F2.4', 'F2.8', 'F3.3',
  'F4.0', 'F4.8', 'F5.6', 'F6.7', 'F8.0', 'F9.5',
  'F11',  'F13',  'F16',  'F19',  'F22',
];

// Shutter speed value mappings
const SHUTTER_STEPS = [
  '1/8000', '1/4000', '1/2000', '1/1000', '1/500',
  '1/250', '1/125', '1/60', '1/30', '1/15',
  '1/8', '1/4', '1/2', '1',
];

// ISO values
const ISO_STEPS = [
  '100', '200', '400', '800', '1600', '3200', '6400', '12800', '25600', '51200',
];

// White balance modes
const WB_MODES: Record<string, string> = {
  auto: 'atw',
  daylight: 'set1',
  cloudy: 'set2',
  shade: 'set3',
  tungsten: 'set4',
  fluorescent: 'set5',
  flash: 'flash',
  kelvin: 'ctemp',
};

export class LumixClient extends EventEmitter {
  private host: string;
  private port: number;
  private appName: string;
  private pollInterval: number;
  private accessToken: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _state: CameraState = {};
  private _lumixState: Record<string, string> = {};

  constructor(options: LumixClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? 80;
    this.appName = options.appName ?? 'SonyCameraBridge';
    this.pollInterval = options.pollInterval ?? 2000;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** CameraBackend interface alias. */
  get isConnected(): boolean {
    return this._connected;
  }

  get state(): CameraState {
    return this._state;
  }

  /** Map the shared RCP command vocabulary onto the Lumix CGI methods. */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris': await this.setIris(num('value')); return true;
      case 'setMasterBlack': await this.setMasterBlack(num('value')); return true;
      case 'setWhiteBalance': await this.setWhiteBalance(num('r'), num('g'), num('b')); return true;
      case 'setMasterGain': await this.setMasterGain(num('value')); return true;
      case 'setSaturation': await this.setSaturation(num('value')); return true;
      case 'setDetailLevel': await this.setDetailLevel(num('value')); return true;
      case 'setBars': await this.setBars(Boolean(params['on'])); return true;
      case 'setCameraPower': await this.setCameraPower(Boolean(params['on'])); return true;
      case 'setNdFilter': await this.setNdFilter(num('value')); return true;
      case 'setShutterSpeed': await this.setShutterSpeed(num('value')); return true;
      case 'setZoom': await this.setZoom(num('value')); return true;
      case 'setRecording': await this.setRecording(Boolean(params['on'])); return true;
      default: return false;
    }
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    try {
      // Step 1: Request access
      const token = await this.requestAccess();
      this.accessToken = token;
      this._connected = true;

      // Step 2: Get camera info
      const info = await this.getCameraInfo();
      this.emit('connected', info);

      // Step 3: Start polling camera state
      this.startPolling();
    } catch (err) {
      this._connected = false;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  disconnect(): void {
    this.stopPolling();
    if (this._connected && this.accessToken) {
      // Release access (fire-and-forget)
      this.cgi({ mode: 'accctrl', type: 'req_acc_e', value: this.accessToken }).catch(() => {});
    }
    this._connected = false;
    this.accessToken = null;
    this.emit('disconnected');
  }

  // ─── Camera control methods ───────────────────────────────────────────────

  /** Set iris (aperture). Value is index into IRIS_STEPS (0-16) or raw F-number string */
  async setIris(value: number): Promise<void> {
    const step = Math.max(0, Math.min(IRIS_STEPS.length - 1, Math.round(value)));
    const irisStr = IRIS_STEPS[step];
    await this.sendCommand('menu', 'set', `iris_${irisStr.replace('.', '')}`);
    this._state.iris = step;
  }

  /** Set shutter speed. Value is index into SHUTTER_STEPS (0-13) */
  async setShutterSpeed(value: number): Promise<void> {
    const step = Math.max(0, Math.min(SHUTTER_STEPS.length - 1, Math.round(value)));
    await this.sendCommand('menu', 'set', `shutter_${SHUTTER_STEPS[step].replace('/', '_')}`);
    this._state.shutterSpeed = step;
  }

  /** Set ISO. Value is index into ISO_STEPS (0-9) */
  async setMasterGain(value: number): Promise<void> {
    const step = Math.max(0, Math.min(ISO_STEPS.length - 1, Math.round(value)));
    await this.sendCommand('menu', 'set', `iso_${ISO_STEPS[step]}`);
    this._state.masterGain = step;
  }

  /** Set white balance mode. Value maps to WB_MODES keys */
  async setWhiteBalance(r: number, _g: number, _b: number): Promise<void> {
    // r encodes WB mode index: 0=auto, 1=daylight, 2=cloudy, 3=shade, 4=tungsten, 5=fluorescent
    const modes = Object.keys(WB_MODES);
    const modeIdx = Math.max(0, Math.min(modes.length - 1, Math.round(r)));
    const lumixMode = WB_MODES[modes[modeIdx]] ?? 'atw';
    await this.sendCommand('menu', 'set', `awb_${lumixMode}`);
    this._state.whiteR = r;
    this._state.whiteG = _g;
    this._state.whiteB = _b;
  }

  /** Set exposure compensation (maps masterBlack). Value -5 to +5 in 1/3 EV steps */
  async setMasterBlack(value: number): Promise<void> {
    // Map -128..+127 range to Lumix -5..+5 EV (in 1/3 stops)
    const ev = Math.round((value / 128) * 15); // -15..+15 thirds
    const evStr = ev >= 0 ? `plus${ev}` : `minus${Math.abs(ev)}`;
    await this.sendCommand('menu', 'set', `exprev_${evStr}`);
    this._state.masterBlack = value;
  }

  /** Toggle test bars (if supported) */
  async setBars(on: boolean): Promise<void> {
    // Lumix does not have a direct bars command via CGI;
    // we simulate via color bar setting in video mode
    await this.sendCommand('menu', 'set', on ? 'colbar_on' : 'colbar_off');
    this._state.bars = on;
  }

  /** Set detail/sharpening level. Value -7 to +7 */
  async setDetailLevel(value: number): Promise<void> {
    const clamped = Math.max(-7, Math.min(7, Math.round(value)));
    const valStr = clamped >= 0 ? `${clamped}` : `minus${Math.abs(clamped)}`;
    await this.sendCommand('menu', 'set', `detail_${valStr}`);
    this._state.detailLevel = clamped;
  }

  /** Set saturation. Value -7 to +7 */
  async setSaturation(value: number): Promise<void> {
    const clamped = Math.max(-7, Math.min(7, Math.round(value)));
    const valStr = clamped >= 0 ? `${clamped}` : `minus${Math.abs(clamped)}`;
    await this.sendCommand('menu', 'set', `saturation_${valStr}`);
    this._state.saturation = clamped;
  }

  /** Capture a still image */
  async capture(): Promise<void> {
    await this.cgi({ mode: 'camcmd', value: 'capture' });
  }

  /** Start/stop video recording */
  async setRecording(on: boolean): Promise<void> {
    await this.cgi({ mode: 'camcmd', value: on ? 'video_recstart' : 'video_recstop' });
  }

  /** Control zoom. value: -100 (wide) to +100 (tele), 0 = stop */
  async setZoom(value: number): Promise<void> {
    if (value === 0) {
      await this.cgi({ mode: 'camcmd', value: 'zoomstop' });
    } else if (value > 0) {
      const speed = Math.min(4, Math.round(Math.abs(value) / 25) + 1);
      await this.cgi({ mode: 'camcmd', value: `tele${speed}` });
    } else {
      const speed = Math.min(4, Math.round(Math.abs(value) / 25) + 1);
      await this.cgi({ mode: 'camcmd', value: `wide${speed}` });
    }
  }

  /** Set ND filter. Lumix S1/S5 do not have built-in ND; mapped as no-op for compatibility */
  async setNdFilter(_value: number): Promise<void> {
    // No-op: Lumix mirrorless cameras don't have motorized ND filters
    this._state.ndFilter = _value;
  }

  /** Power camera off via WiFi keepalive release */
  async setCameraPower(on: boolean): Promise<void> {
    if (!on) {
      await this.cgi({ mode: 'camcmd', value: 'poweroff' });
      this._state.cameraPower = false;
    } else {
      // Cannot power ON via WiFi (camera must be manually powered)
      this._state.cameraPower = true;
    }
  }

  // ─── State polling ────────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollState(), this.pollInterval);
    // Poll immediately
    this.pollState().catch(() => {});
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollState(): Promise<void> {
    if (!this._connected) return;
    try {
      const result = await this.cgi({ mode: 'getstate' });
      const parsed = this.parseStateResponse(result);
      if (parsed) {
        this._lumixState = { ...this._lumixState, ...parsed };
        const newState = this.lumixStateToCamera(this._lumixState);
        this._state = newState;
        this.emit('stateChanged', newState);
      }
    } catch {
      // Silent poll failure; will retry
    }
  }

  private parseStateResponse(body: string): Record<string, string> | null {
    // Lumix getstate returns XML: <camrply><result>ok</result><state><rec>inactive</rec>...</state></camrply>
    const result: Record<string, string> = {};
    const tagRegex = /<(\w+)>([^<]*)<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(body)) !== null) {
      result[match[1]] = match[2];
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  private lumixStateToCamera(lumix: Record<string, string>): CameraState {
    const state: CameraState = { ...this._state };

    // Map recording status
    if (lumix['rec'] === 'active') {
      state.cameraPower = true;
    }

    // Map iris from camera state
    if (lumix['iris']) {
      const irisIdx = IRIS_STEPS.findIndex(s => s === lumix['iris']);
      if (irisIdx >= 0) state.iris = irisIdx;
    }

    // Map shutter
    if (lumix['shutter']) {
      const shutterIdx = SHUTTER_STEPS.findIndex(s => s === lumix['shutter']);
      if (shutterIdx >= 0) state.shutterSpeed = shutterIdx;
    }

    // Map ISO
    if (lumix['iso']) {
      const isoIdx = ISO_STEPS.findIndex(s => s === lumix['iso']);
      if (isoIdx >= 0) state.masterGain = isoIdx;
    }

    return state;
  }

  // ─── HTTP CGI helpers ─────────────────────────────────────────────────────

  private async requestAccess(): Promise<string> {
    const body = await this.cgi({
      mode: 'accctrl',
      type: 'req_acc',
      value: this.appName,
      value2: this.appName,
    });

    // Response: <camrply><result>ok</result><acc>TOKEN</acc></camrply>
    const tokenMatch = body.match(/<acc>([^<]+)<\/acc>/);
    if (!tokenMatch) {
      // Some Lumix models don't require access control
      const result = body.match(/<result>([^<]+)<\/result>/)?.[1];
      if (result === 'ok' || result === 'acc_error') {
        return 'no_token';
      }
      throw new Error(`Lumix access denied. Response: ${body}`);
    }
    return tokenMatch[1];
  }

  private async getCameraInfo(): Promise<LumixCameraInfo> {
    try {
      const body = await this.cgi({ mode: 'getinfo', type: 'capability' });
      const model = body.match(/<model>([^<]+)<\/model>/)?.[1];
      const firmware = body.match(/<firmware>([^<]+)<\/firmware>/)?.[1];
      return { model, firmware, host: this.host, port: this.port };
    } catch {
      return { host: this.host, port: this.port };
    }
  }

  private async sendCommand(mode: string, type: string, value: string): Promise<void> {
    await this.cgi({ mode, type, value });
  }

  private async cgi(params: Record<string, string>): Promise<string> {
    if (this.accessToken && this.accessToken !== 'no_token' && !params['value']) {
      params = { ...params, value: this.accessToken };
    }

    const query = new URLSearchParams(params).toString();
    const url = `http://${this.host}:${this.port}${CGI_PATH}?${query}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': this.appName,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from Lumix camera at ${url}`);
      }

      return await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout connecting to Lumix camera at ${this.host}:${this.port}`);
      }
      if (this._connected) {
        this._connected = false;
        this.emit('disconnected');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
