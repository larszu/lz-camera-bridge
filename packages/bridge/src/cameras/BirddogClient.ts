/**
 * BirdDog PTZ / Converter Client
 *
 * Controls BirdDog NDI PTZ cameras (P100/P200/P400, Maki, Eyes) and the camera
 * functions on BirdDog converters via their documented REST API (port 8080).
 *
 *   GET/POST http://<ip>:8080/exposure       { ExpMode, IrisLevel, GainLevel }
 *   POST     http://<ip>:8080/whitebalance    { WbMode, ColourTemp }
 *   POST     http://<ip>:8080/recall          { Preset }
 *
 * Field names differ slightly between BirdDog firmware generations, so the
 * payloads here may need per-model tuning on real hardware.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';
import { irisPositionToFNumber } from '../protocol/SonyPtp.js';

export class BirddogClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private connected = false;
  private _state: CameraState = {};

  constructor(host: string, port = 8080) {
    super();
    this.base = `http://${host}:${port}`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    const text = await httpRequest(`${this.base}/about`).catch(() => httpRequest(`${this.base}/exposure`));
    this.connected = true;
    this.emit('connected', { host: this.base, info: text });
    return text;
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  private post(path: string, body: object): Promise<string> {
    return httpRequest(`${this.base}${path}`, { method: 'POST', json: true, body });
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris':
        await this.post('/exposure', {
          ExpMode: 'Manual',
          IrisLevel: `F${irisPositionToFNumber(num('value')).toFixed(1)}`,
        });
        this._state.iris = num('value');
        this.emit('stateChanged', { iris: this._state.iris });
        return true;
      case 'setMasterGain':
        await this.post('/exposure', { ExpMode: 'Manual', GainLevel: `${num('value') * 3}dB` });
        this._state.masterGain = num('value');
        this.emit('stateChanged', { masterGain: this._state.masterGain });
        return true;
      case 'setColorTemp':
        await this.post('/whitebalance', { WbMode: 'Manual', ColourTemp: num('value', 5600) });
        return true;
      case 'autoWhiteBalance':
        await this.post('/whitebalance', { WbMode: 'Auto' });
        return true;
      case 'recallPreset':
        await this.post('/recall', { Preset: num('value') });
        return true;
      default:
        return false;
    }
  }
}
