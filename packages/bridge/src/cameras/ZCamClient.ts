/**
 * Z CAM HTTP Control Client
 *
 * Controls Z CAM cinema cameras (E2, E2-M4, E2-S6, E2-F6, E2-F8, …) over their
 * documented HTTP control API.
 *
 *   Info:   GET /info
 *   Set:    GET /ctrl/set?<key>=<value>      (iso, iris, wb, mwb, sht_angle …)
 *   Get:    GET /ctrl/get?k=<key>
 *   Record: GET /ctrl/rec?action=start|stop
 *
 * Reference: Z CAM E2 HTTP API. Value formats can vary slightly by model and
 * firmware, so the encodings here may need per-model tuning on real hardware.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';
import { irisPositionToFNumber, GAIN_INDEX_TO_ISO } from '../protocol/SonyPtp.js';

export class ZCamClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _state: CameraState = {};

  constructor(host: string, port = 80) {
    super();
    this.base = `http://${host}:${port}`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    const text = await httpRequest(`${this.base}/info`);
    let info: Record<string, unknown> = {};
    try {
      info = JSON.parse(text);
    } catch {
      /* some firmwares return plain text */
    }
    this.connected = true;
    this.emit('connected', info);
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), 2000);
    return info;
  }

  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
    this.emit('disconnected');
  }

  private async set(key: string, value: string | number): Promise<void> {
    await httpRequest(`${this.base}/ctrl/set?${key}=${encodeURIComponent(String(value))}`);
  }

  private async poll(): Promise<void> {
    if (!this.connected) return;
    const txt = await httpRequest(`${this.base}/ctrl/get?k=iso`).catch(() => '');
    const m = /"value"\s*:\s*"?(\d+)"?/.exec(txt);
    if (m) {
      const idx = Object.entries(GAIN_INDEX_TO_ISO).find(([, v]) => v === Number(m[1]))?.[0];
      if (idx !== undefined) {
        this._state.masterGain = Number(idx);
        this.emit('stateChanged', { masterGain: this._state.masterGain });
      }
    }
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris': {
        const f = irisPositionToFNumber(num('value'));
        await this.set('iris', `F${f.toFixed(1)}`);
        this._state.iris = num('value');
        this.emit('stateChanged', { iris: this._state.iris });
        return true;
      }
      case 'setMasterGain':
        await this.set('iso', GAIN_INDEX_TO_ISO[num('value')] ?? 800);
        this._state.masterGain = num('value');
        this.emit('stateChanged', { masterGain: this._state.masterGain });
        return true;
      case 'setShutterSpeed':
        // Z CAM uses shutter angle; approximate 1/x → angle is non-trivial, so
        // we set the shutter speed string the camera understands.
        await this.set('sht_operation', 'Speed');
        await this.set('shutter_speed', `1/${num('value')}`);
        return true;
      case 'setColorTemp':
        await this.set('wb', 'Manual');
        await this.set('mwb', num('value', 5600));
        return true;
      case 'autoWhiteBalance':
        await this.set('wb', 'Auto');
        return true;
      case 'setRecording':
        await httpRequest(`${this.base}/ctrl/rec?action=${Boolean(params['on']) ? 'start' : 'stop'}`);
        return true;
      default:
        return false;
    }
  }
}
