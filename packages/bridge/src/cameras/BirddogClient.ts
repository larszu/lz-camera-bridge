/**
 * BirdDog PTZ Camera Client
 *
 * BirdDog cameras (P100/P200/P400/P4K, X1/X5, Maki, Eyes) expose two control
 * planes — both used here exactly as BirdDog's own tooling and the official
 * Bitfocus companion-module-birddog-ptz do:
 *
 *  1. Motion/optics: Sony-style VISCA over IP on UDP 52381 (8-byte payload
 *     header + sequence number). Pan/tilt, zoom, focus, iris, gain, one-push
 *     AWB and power all ride this plane — delegated to ViscaClient.
 *  2. Setup REST API on port 8080:
 *       GET  /about                          — device info (connect probe)
 *       POST /birddogexpsetup                — { ExpMode, IrisLevel, GainLevel }
 *       POST /birddogwbsetup                 — { WbMode, ColorTemp, RedGain, BlueGain }
 *       POST /recall | /save                 — { Preset: "Preset-<n>" }
 *     (Field values are strings, per the verified module payloads.)
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';
import { ViscaClient, SONY_VISCA_PORT } from './ViscaClient.js';

export class BirddogClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private visca: ViscaClient;
  private connected = false;
  private _state: CameraState = {};

  constructor(host: string, restPort = 8080) {
    super();
    this.base = `http://${host}:${restPort}`;
    this.visca = new ViscaClient(host, SONY_VISCA_PORT);
    this.visca.on('stateChanged', (s: Partial<CameraState>) => {
      this._state = { ...this._state, ...s };
      this.emit('stateChanged', s);
    });
    this.visca.on('error', (err: Error) => this.emit('error', err));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    // REST /about proves we are talking to a BirdDog unit…
    const about = await httpRequest(`${this.base}/about`);
    // …and the VISCA plane handles all motion from here on.
    await this.visca.connect();
    this.connected = true;
    this.emit('connected', { host: this.base, info: about });
    return about;
  }

  disconnect(): void {
    this.connected = false;
    this.visca.disconnect();
    this.emit('disconnected');
  }

  private post(path: string, body: object): Promise<string> {
    return httpRequest(`${this.base}${path}`, { method: 'POST', json: true, body });
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      // ── Setup plane (REST, verified field names) ──────────────────────────
      case 'setColorTemp':
        await this.post('/birddogwbsetup', { WbMode: 'Manual', ColorTemp: String(num('value', 5600)) });
        return true;
      case 'autoWhiteBalance':
        await this.post('/birddogwbsetup', { WbMode: 'Auto' });
        return true;
      case 'recallPreset':
        await this.post('/recall', { Preset: `Preset-${num('value')}` });
        return true;
      case 'storePreset':
        await this.post('/save', { Preset: `Preset-${num('value')}` });
        return true;

      // ── Motion/optics plane (VISCA over IP, Sony header) ──────────────────
      case 'setIris':
      case 'setMasterGain':
      case 'ptz':
      case 'setZoom':
      case 'setFocus':
      case 'autoFocus':
      case 'setCameraPower':
        return this.visca.handleRcpCommand(cmd, params);

      default:
        return false;
    }
  }
}
