/**
 * JVC Connected Cam Client
 *
 * Controls JVC CONNECTED CAM / ProHD cameras (GY-HC900/HC550/HC500, GY-HM250/
 * HM170 …) over their HTTP web-remote API.
 *
 *   POST http://<ip>/cgi-bin/api.cgi   body: { "Command": "...", "Params": {…} }
 *
 * JVC publishes an official API reference: "JVC Camcorder Web API Reference"
 * (pro.jvc.com → JvcCamcorderApiReferenceV118_public.pdf, covers GY-HC500/
 * HC550/HM250 …). That document is the authority for endpoint paths and
 * command names; this client's mappings are best-effort until aligned with
 * it (the PDF is not reachable from this build environment). Unsupported or
 * unconfirmed commands are reported, not faked.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';

export class JvcClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private connected = false;
  private _state: CameraState = {};

  constructor(host: string, port = 80) {
    super();
    this.base = `http://${host}:${port}`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    const info = await this.command('GetCamStatus', {}).catch(() =>
      httpRequest(`${this.base}/cgi-bin/get_camera_status.cgi`),
    );
    this.connected = true;
    this.emit('connected', { host: this.base, info });
    return info;
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  private command(command: string, params: Record<string, unknown>): Promise<string> {
    return httpRequest(`${this.base}/cgi-bin/api.cgi`, {
      method: 'POST',
      json: true,
      body: { Command: command, Params: params },
    });
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris':
        await this.command('SetIris', { Mode: 'Manual', Value: num('value') });
        this._state.iris = num('value');
        this.emit('stateChanged', { iris: this._state.iris });
        return true;
      case 'setMasterGain':
        await this.command('SetGain', { Value: num('value') });
        this._state.masterGain = num('value');
        this.emit('stateChanged', { masterGain: this._state.masterGain });
        return true;
      case 'setColorTemp':
        await this.command('SetWhiteBalance', { Mode: 'Manual', ColorTemp: num('value', 5600) });
        return true;
      case 'autoWhiteBalance':
        await this.command('SetWhiteBalance', { Mode: 'FAW' });
        return true;
      case 'setBars':
        await this.command('SetColorBar', { Enable: Boolean(params['on']) });
        this._state.bars = Boolean(params['on']);
        this.emit('stateChanged', { bars: this._state.bars });
        return true;
      case 'setRecording':
        await this.command(Boolean(params['on']) ? 'StartRec' : 'StopRec', {});
        return true;
      default:
        return false;
    }
  }
}
