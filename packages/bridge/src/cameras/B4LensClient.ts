/**
 * B4 Lens Control Client
 *
 * Drives a 2/3" broadcast lens (Canon/Fujinon, B4 mount) through the ESP32-S3
 * interface built in `packages/firmware-b4`, which sits in the Hirose 12-pin
 * cable between camera and lens.
 *
 *   GET  /api/status   → full device + lens state
 *   POST /api/iris     { value: 0..255 }
 *   POST /api/arm      { armed: boolean }
 *
 * WHY THIS BACKEND IS DIFFERENT FROM THE OTHER TEN
 *
 * It is the only path in this repo whose iris readback is an INDEPENDENT
 * MEASUREMENT. Iris is commanded on Hirose pin 5 and measured on pin 7 — a
 * separate conductor, read through its own ADC. Everywhere else `iris` either
 * comes back from the device's own idea of itself, or is the echo of what we
 * just sent (see `MODE_READBACK`: six of the paths read nothing at all).
 *
 * That is why `'b4-lens': ['iris']` in valueOrigin.ts is load-bearing rather
 * than decorative, and why this client NEVER emits the commanded value as
 * `stateChanged`. Doing so would launder a command into a confirmation and
 * defeat the whole model. The value reaches the panel only after the device has
 * measured it.
 *
 * A lens is not a camera. Everything the RCP offers beyond iris is unsupported
 * here and is disabled by `capabilitiesForMode('b4-lens')`, the same way the
 * PTZ backends disable paint they do not have.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient, httpRequest } from './GenericCameraClient.js';

/** What the device reports. Fields are ABSENT when it did not measure them. */
export interface B4Status {
  firmware?: string;
  driveCompiledIn?: boolean;
  armed?: boolean;
  calibrated?: boolean;
  calPoints?: number;
  i2c?: { dac?: boolean; adc?: boolean };
  lens?: {
    iris?: number;
    irisVolts?: number;
    zoomCounts?: number;
    zoomVolts?: number;
    focusCounts?: number;
    focusVolts?: number;
  };
  drive?: { setpoint?: number; dacCode?: number; holding?: boolean; fault?: string };
}

/**
 * Why the lens cannot be driven right now, or null when it can.
 *
 * Returned as a sentence rather than a boolean because every one of these has a
 * different fix at the bench, and "iris did nothing" with no reason is the
 * failure mode this whole repository argues against.
 */
export function driveRefusal(s: B4Status): string | null {
  if (s.driveCompiledIn === false)
    return 'Firmware built with B4_ENABLE_IRIS_DRIVE=0 — it cannot drive at all.';
  if (s.i2c?.dac === false) return 'No MCP4728 on the I²C bus.';
  if (s.calibrated === false) return 'No calibration table recorded on the device.';
  if (s.armed === false) return 'Device is not armed.';
  return null;
}

export class B4LensClient extends EventEmitter implements GenericCameraClient {
  private base: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _state: CameraState = {};
  private lastStatus: B4Status = {};
  /** Last iris we reported upward, to avoid a broadcast per poll. */
  private lastIris: number | undefined;

  constructor(host: string, port = 80, private readonly pollMs = 250) {
    super();
    this.base = `http://${host}:${port}`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The most recent device report. Read-only view for the UI and tests. */
  get status(): Readonly<B4Status> {
    return this.lastStatus;
  }

  async connect(): Promise<unknown> {
    const s = await this.fetchStatus();
    this.connected = true;

    // Arm on connect ONLY if the device can actually be driven. Arming a device
    // that has no calibration table would leave it armed and refusing, which
    // reads at the bench like a hardware fault.
    if (driveRefusal({ ...s, armed: false }) === null) {
      await this.post('/api/arm', { armed: true }).catch(() => {});
    }

    this.emit('connected', s);
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    return s;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    // Leaving a lens interface armed after the panel has gone is exactly the
    // "loss of setpoint" case brief.md §3 requires to stop motion.
    if (this.connected) await this.post('/api/arm', { armed: false }).catch(() => {});
    this.connected = false;
    this.emit('disconnected');
  }

  private async fetchStatus(): Promise<B4Status> {
    const txt = await httpRequest(`${this.base}/api/status`, { timeoutMs: 2000 });
    const s = JSON.parse(txt) as B4Status;
    this.lastStatus = s;
    return s;
  }

  private async post(path: string, body: unknown): Promise<string> {
    return httpRequest(`${this.base}${path}`, {
      method: 'POST',
      body,
      json: true,
      timeoutMs: 2000,
    });
  }

  /**
   * One poll.
   *
   * Emits `stateChanged` only when the MEASURED iris moved. A device that is
   * holding still should not produce four broadcasts a second, and a value that
   * did not change carries no news.
   */
  private async poll(): Promise<void> {
    if (!this.connected) return;
    let s: B4Status;
    try {
      s = await this.fetchStatus();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const fault = s.drive?.fault;
    if (fault) this.emit('error', new Error(`Lens interface: ${fault}`));

    const iris = s.lens?.iris;
    if (typeof iris === 'number' && iris !== this.lastIris) {
      this.lastIris = iris;
      this._state.iris = iris;
      this.emit('stateChanged', { iris });
    }
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    switch (cmd) {
      case 'setIris': {
        const value = Math.max(0, Math.min(255, Math.round(Number(params['value'] ?? 0))));
        const refusal = driveRefusal(this.lastStatus);
        if (refusal) throw new Error(refusal);
        await this.post('/api/iris', { value });
        // Deliberately NO stateChanged here. The panel learns the new iris when
        // pin 7 says the blades arrived — see the header of this file.
        return true;
      }

      case 'setAutoIris': {
        // Hirose pin 8 selects the lens's own auto-iris versus remote control.
        // Disarming hands the lens back to itself, which is what "auto" means
        // on this interface; there is no separate auto command.
        await this.post('/api/arm', { armed: !Boolean(params['on']) });
        return true;
      }

      default:
        return false;
    }
  }
}
