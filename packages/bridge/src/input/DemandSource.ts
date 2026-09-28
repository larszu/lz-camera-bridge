/**
 * Zoom and focus demands as a source on the command bus (phase 4, #51).
 *
 * A demand is read by the ESP32 in `packages/firmware-b4` (second ADS1115,
 * `demand` block of `/api/status`). This module polls that device and turns
 * the wiper reading into the bus's own rate commands — `setZoom` / `setFocus`
 * with `value` -100..100, 0 = stop, the vocabulary `ViscaClient`,
 * `PanasonicPtzClient`, `JvcClient` and the PTZ panel already share. No new
 * command, no new port, no OSC (see #53).
 *
 * ── A demand is a setpoint source, never a confirmation ───────────────────
 * What it produces goes through `dispatchCommand` like a tap on the panel.
 * Nothing here reports a value as read from a camera; the `demand` broadcast
 * carries `origin: 'commanded'` in the same words `origins` uses.
 *
 * ── No table, no command ──────────────────────────────────────────────────
 * The wiper voltage → command value mapping is a calibration table measured
 * per demand (ends and centre), evaluated with the same `interpolate` the
 * FreeD output uses. A reading outside the measured range is unknown, not the
 * nearest end. Nothing is assumed about 2.5 / 5.0 / 7.5 V.
 *
 * ── Losing the demand stops the axis ──────────────────────────────────────
 * Field absent, reading outside the table, device unreachable: each of these
 * RELEASES the axis — exactly one `value: 0` goes out, then silence until a
 * valid reading returns. Holding the last value would keep a zoom running
 * that nobody is touching.
 */
import { EventEmitter } from 'events';
import { interpolate, checkCalibration, type CalibrationTable } from '../protocol/LensCalibration.js';
import { httpRequest } from '../cameras/GenericCameraClient.js';

export type DemandAxis = 'zoom' | 'focus';

export interface DemandBinding {
  /** Which wiper on the device: `demand.zoomCounts` or `demand.focusCounts`. */
  axis: DemandAxis;
  /** Which camera slot this demand drives. */
  cameraNumber: number;
  /** A bus rate command. Position commands are not offered: the bus has none for zoom/focus. */
  command: 'setZoom' | 'setFocus';
  /** Raw ADC counts → -100..100. At least the two ends; the centre if the demand has one. */
  calibration: CalibrationTable;
  /** Output units around 0 that count as rest. Default 3. */
  deadband?: number;
  /** Minimum output change worth sending. Default 2. A stop always goes through. */
  step?: number;
  /** At most one command per this many ms. Default 50 (20 Hz). */
  minIntervalMs?: number;
}

export interface DemandConfig {
  /** The firmware-b4 device the demand is plugged into. */
  host: string;
  port?: number;
  /** Poll period. Default 50 ms. */
  pollMs?: number;
  bindings: DemandBinding[];
}

/** What a binding decided for one reading. */
export type ShapeResult =
  | { kind: 'send'; value: number }
  | { kind: 'release' } // send one stop, then stay silent
  | { kind: 'hold' }; // nothing new worth sending

/**
 * The pure part: deadband, step, rate limit, release. No clock of its own and
 * no I/O, so every rule is testable with plain numbers.
 */
export class DemandShaper {
  private lastSent: number | null = null;
  private lastSentAt = -Infinity;
  private released = true; // nothing is being driven until a valid reading arrives

  constructor(private readonly b: DemandBinding) {
    const check = checkCalibration(b.calibration);
    if (!check.ok) throw new Error(`Demand ${b.axis}: calibration unusable — ${check.problems.join('; ')}`);
  }

  /** `raw` undefined = the device did not report this wiper. */
  update(raw: number | undefined, now: number): ShapeResult {
    const mapped = raw === undefined ? null : interpolate(this.b.calibration, raw);
    if (mapped === null) return this.release();

    let v = Math.max(-100, Math.min(100, mapped));
    if (Math.abs(v) <= (this.b.deadband ?? 3)) v = 0;
    v = Math.round(v);

    const isStop = v === 0;
    if (this.lastSent !== null && v === this.lastSent) return { kind: 'hold' };
    if (!isStop && this.lastSent !== null && Math.abs(v - this.lastSent) < (this.b.step ?? 2)) {
      return { kind: 'hold' };
    }
    // A stop is never delayed by the rate limit: a late stop is a zoom that overshoots.
    if (!isStop && now - this.lastSentAt < (this.b.minIntervalMs ?? 50)) return { kind: 'hold' };

    this.lastSent = v;
    this.lastSentAt = now;
    this.released = false;
    return { kind: 'send', value: v };
  }

  /** Force a release, e.g. the device stopped answering. */
  release(): ShapeResult {
    if (this.released) return { kind: 'hold' };
    this.released = true;
    this.lastSent = 0;
    return { kind: 'release' };
  }
}

/** What the device reports under `demand`. Fields are absent when not read. */
export interface DemandStatus {
  zoomCounts?: number;
  focusCounts?: number;
  zoomDetectVolts?: number;
  focusDetectVolts?: number;
  vtr?: boolean;
  ret?: boolean;
}

export interface DemandEvent {
  axis: DemandAxis;
  cameraNumber: number;
  command: string;
  /** Raw counts, or null when the device reported none. */
  raw: number | null;
  /** The value sent; 0 on release. */
  value: number;
  /** false = released (absent, out of the table, or device lost). */
  present: boolean;
  origin: 'commanded';
}

/**
 * Polls one device and emits:
 *   'command' { cameraNumber, cmd, params: { value } }  — for dispatchCommand
 *   'demand'  DemandEvent                                — for the broadcast
 *   'error'   Error
 */
export class DemandSource extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly shapers: DemandShaper[];
  private readonly base: string;
  private busy = false;

  constructor(private readonly cfg: DemandConfig, private readonly clock: () => number = Date.now) {
    super();
    if (!cfg.host) throw new Error('Demand source needs the address of the firmware-b4 device');
    if (cfg.bindings.length === 0) throw new Error('Demand source without bindings drives nothing');
    this.shapers = cfg.bindings.map((b) => new DemandShaper(b));
    this.base = `http://${cfg.host}:${cfg.port ?? 80}`;
  }

  get bindings(): readonly DemandBinding[] {
    return this.cfg.bindings;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), this.cfg.pollMs ?? 50);
  }

  /** Stops polling and releases every axis that was being driven. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.shapers.forEach((s, i) => this.apply(i, s.release(), null));
  }

  /** One poll. Public so tests do not have to wait for a timer. */
  async poll(): Promise<void> {
    if (this.busy) return; // a slow device must not stack requests
    this.busy = true;
    try {
      let demand: DemandStatus | undefined;
      try {
        const txt = await httpRequest(`${this.base}/api/status`, { timeoutMs: 1000 });
        demand = (JSON.parse(txt) as { demand?: DemandStatus }).demand;
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.shapers.forEach((s, i) => this.apply(i, s.release(), null));
        return;
      }
      const now = this.clock();
      this.cfg.bindings.forEach((b, i) => {
        const raw = demand?.[b.axis === 'zoom' ? 'zoomCounts' : 'focusCounts'];
        const r = typeof raw === 'number' ? raw : undefined;
        this.apply(i, this.shapers[i]!.update(r, now), r ?? null);
      });
    } finally {
      this.busy = false;
    }
  }

  private apply(i: number, r: ShapeResult, raw: number | null): void {
    if (r.kind === 'hold') return;
    const b = this.cfg.bindings[i]!;
    const value = r.kind === 'send' ? r.value : 0;
    this.emit('command', { cameraNumber: b.cameraNumber, cmd: b.command, params: { value } });
    const ev: DemandEvent = {
      axis: b.axis,
      cameraNumber: b.cameraNumber,
      command: b.command,
      raw,
      value,
      present: r.kind === 'send',
      origin: 'commanded',
    };
    this.emit('demand', ev);
  }
}

/**
 * Does a HID control surface already drive what this demand would?
 *
 * The WS way (this module) and the HID way (the firmware as a gamepad, read by
 * `HidControlSurface`) must not both steer the same command — two sources on
 * one axis cancel each other out report by report. The bridge refuses the
 * second one instead of letting them fight. Returned as the conflicting
 * command names, empty when there is none.
 */
export function conflictingCommands(
  demandBindings: readonly Pick<DemandBinding, 'command'>[],
  surfaceBindings: readonly { command: string }[],
): string[] {
  const surface = new Set(surfaceBindings.map((b) => b.command));
  return [...new Set(demandBindings.map((b) => b.command).filter((c) => surface.has(c)))];
}
