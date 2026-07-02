/**
 * Panasonic AW PTZ / Studio Camera Client
 *
 * Controls Panasonic AW-series cameras (AW-UE150/UE100/UE80/UE50/UE40,
 * AW-HE130/HE40/HE42, AW-UE20 …) over their HTTP CGI "AW protocol".
 *
 *   PTZ:   GET /cgi-bin/aw_ptz?cmd=%23<command>&res=1   (#Z zoom, #F focus,
 *          #PTS pan/tilt, #I iris, #O power)
 *   Cam:   GET /cgi-bin/aw_cam?cmd=<command>&res=1      (#D30/#D31 iris mode,
 *          DCB color bars, OSE:69:1 one-touch AF)
 *
 * Command set from the public AW protocol (used by the Bitfocus Panasonic-PTZ
 * module). Auto-iris/manual-iris is toggled before sending an iris position.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';

export class PanasonicPtzClient extends EventEmitter implements GenericCameraClient {
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
    // The model/version page confirms reachability.
    const info = await httpRequest(`${this.base}/cgi-bin/aw_ptz?cmd=%23R00&res=1`).catch(async () => {
      // Fall back to the firmware-info page if the live command is rejected.
      return httpRequest(`${this.base}/cgi-bin/getinfo?FILE=1`);
    });
    this.connected = true;
    this.emit('connected', { host: this.base, info });
    return info;
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  private ptz(cmd: string): Promise<string> {
    return httpRequest(`${this.base}/cgi-bin/aw_ptz?cmd=%23${cmd}&res=1`);
  }

  private cam(cmd: string): Promise<string> {
    return httpRequest(`${this.base}/cgi-bin/aw_cam?cmd=${encodeURIComponent(cmd)}&res=1`);
  }

  private two(value: number): string {
    return Math.max(0, Math.min(99, Math.round(value))).toString().padStart(2, '0');
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris':
        await this.cam('OSD:F1');      // manual iris (D31 equivalent on some bodies)
        await this.ptz(`I${this.two((num('value') / 255) * 99)}`);
        this._state.iris = num('value');
        this.emit('stateChanged', { iris: this._state.iris });
        return true;
      case 'setZoom': {
        // -100..100 → Z01..Z99 (Z50 = stop).
        const z = 50 + Math.round((num('value') / 100) * 49);
        await this.ptz(`Z${this.two(z)}`);
        return true;
      }
      case 'setFocus': {
        const f = 50 + Math.round((num('value') / 100) * 49);
        await this.ptz(`F${this.two(f)}`);
        return true;
      }
      case 'ptz': {
        // Pan/Tilt drive: #PTSppttt → PTS<panspeed><tiltspeed>, 50 = stop.
        const p = 50 + Math.round((num('pan') / 100) * 49);
        const t = 50 + Math.round((num('tilt') / 100) * 49);
        await this.ptz(`PTS${this.two(p)}${this.two(t)}`);
        return true;
      }
      case 'recallPreset':
        // #R<xx> recalls preset 00-99.
        await this.ptz(`R${this.two(num('value'))}`);
        return true;
      case 'storePreset':
        // #M<xx> stores preset 00-99.
        await this.ptz(`M${this.two(num('value'))}`);
        return true;
      case 'autoFocus':
        await this.cam('OSE:69:1'); // one-touch AF
        return true;
      case 'setBars':
        await this.cam(`DCB:${Boolean(params['on']) ? 1 : 0}`);
        this._state.bars = Boolean(params['on']);
        this.emit('stateChanged', { bars: this._state.bars });
        return true;
      case 'setCameraPower':
        await this.ptz(`O${Boolean(params['on']) ? 1 : 0}`);
        this._state.cameraPower = Boolean(params['on']);
        this.emit('stateChanged', { cameraPower: this._state.cameraPower });
        return true;
      default:
        // Gain / shutter / white-balance AW codes vary by body; left to a
        // future per-model mapping rather than sending a guessed command.
        return false;
    }
  }
}
