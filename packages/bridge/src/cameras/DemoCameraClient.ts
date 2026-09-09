/**
 * A camera that is not there — and says so.
 *
 * ─── WHAT WAS REPORTED (user, 2026-09-09) ──────────────────────────────────
 *
 *   „Ebenso auch Kamerapult [muss man lokal starten koennen]."
 *
 * ─── WHY A PANEL WITHOUT A CAMERA WAS USELESS ──────────────────────────────
 *
 * `npm run dev` always started. What it could not do is show anything: every
 * backend in `backendFactory` needs a real address — a CCU on TCP, a VISCA
 * port, a USB device in PC-Remote mode. Without one the panel comes up empty
 * and every control is inert. You could not see the RCP work, you could not
 * try the joystick, you could not check a layout on a laptop.
 *
 * ─── WHAT THIS IS, AND WHAT IT REFUSES TO BE ───────────────────────────────
 *
 * It is a control surface with a state behind it: turn the iris ring and the
 * iris value follows, pull black and black follows. That is the whole point —
 * the panel is the thing under test, not the protocol.
 *
 * It is NOT a camera simulator. It does not model exposure, it does not
 * invent a picture, and it does not pretend a protocol handshake happened.
 * Nothing here may ever look like a measurement from a real device:
 *
 *   * `isDemo` sits in the state and travels with it to the dashboard, so the
 *     surface can mark itself. A demo state that arrives indistinguishable
 *     from a real one is the defect this whole repository argues against —
 *     an operator who trusts a number that came from nowhere.
 *   * Values move ONLY because a command moved them. There is no drift, no
 *     noise, no timer nudging anything. If the panel shows a change, the
 *     panel caused it.
 *   * `connect()` resolves immediately. It does not fake a delay to look
 *     realistic; a delay would be a small lie for decoration.
 */
import { EventEmitter } from 'events';
import type { CameraState } from '../protocol/CcuClient.js';

/** The state a demo camera starts from — a plausible mid-scale setup. */
const START: CameraState = {
  iris: 50,
  masterBlack: 0,
  blackR: 0, blackG: 0, blackB: 0,
  whiteR: 0, whiteG: 0, whiteB: 0,
  masterGain: 0,
  masterGamma: 45,
  saturation: 100,
  shutterSpeed: 50,
  detailLevel: 0,
  ndFilter: 1,
  masterWhiteClip: 100,
  bars: false,
  cameraPower: true,
};

/** What the dashboard sees on top of a normal CameraState. */
export interface DemoCameraState extends CameraState {
  /** Always true. The surface uses it to mark itself as not-a-camera. */
  isDemo: true;
}

export class DemoCameraClient extends EventEmitter {
  private connected = false;
  readonly state: DemoCameraState = { ...START, isDemo: true };

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<boolean> {
    this.connected = true;
    this.emit('connected');
    this.emit('stateChanged', { ...this.state });
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Apply a command to the held state.
   *
   * Unknown commands return `false` rather than `true`. A demo that swallowed
   * everything would report success for a command the real backends reject,
   * and someone would build a panel button on top of that answer.
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    if (!this.connected) return false;
    const num = (k: string): number => Number(params[k] ?? 0);
    const bool = (k: string): boolean => Boolean(params[k]);

    switch (cmd) {
      case 'setIris': this.state.iris = num('value'); break;
      case 'setMasterBlack': this.state.masterBlack = num('value'); break;
      case 'setBlackBalance':
        this.state.blackR = num('r'); this.state.blackG = num('g'); this.state.blackB = num('b');
        break;
      case 'setWhiteBalance':
        this.state.whiteR = num('r'); this.state.whiteG = num('g'); this.state.whiteB = num('b');
        break;
      case 'setMasterGain': this.state.masterGain = num('value'); break;
      case 'setMasterGamma': this.state.masterGamma = num('value'); break;
      case 'setSaturation': this.state.saturation = num('value'); break;
      case 'setDetailLevel': this.state.detailLevel = num('value'); break;
      case 'setNdFilter': this.state.ndFilter = num('value'); break;
      case 'setShutterSpeed': this.state.shutterSpeed = num('value'); break;
      case 'setBars': this.state.bars = bool('on'); break;
      case 'setCameraPower': this.state.cameraPower = bool('on'); break;
      default:
        return false;
    }
    this.emit('stateChanged', { ...this.state });
    return true;
  }
}
