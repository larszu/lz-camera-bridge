/**
 * Puts a `SpeedRamp` between the operator and the camera for the three
 * speed commands: `ptz` (pan + tilt), `setZoom` and `setFocus`.
 *
 * A tap on "zoom in" no longer sends speed 100 at once; the speed glides up
 * (attack) and, on release, glides down (release). Every camera backend
 * profits, because what goes down is still the plain speed command it knows,
 * only more often and with intermediate values.
 *
 * Not used for a physical zoom/focus demand (`DemandSource`): the operator's
 * hand already shapes that motion, and a second ramp would make it feel late.
 */
import { DEFAULT_RAMP, type RampOptions, SpeedRamp } from './Easing.js';

export const RAMPED_COMMANDS = ['ptz', 'setZoom', 'setFocus'] as const;
export type RampedCommand = (typeof RAMPED_COMMANDS)[number];

const TICK_MS = 40;

type Send = (cmd: string, params: Record<string, unknown>) => Promise<boolean>;

interface Lane {
  ramps: Record<string, SpeedRamp>; // param key → ramp
  extra: Record<string, unknown>; // params that are passed through unchanged
  last: Record<string, number>;
  timer?: ReturnType<typeof setInterval>;
}

export function isRamped(cmd: string): cmd is RampedCommand {
  return (RAMPED_COMMANDS as readonly string[]).includes(cmd);
}

const KEYS: Record<RampedCommand, string[]> = { ptz: ['pan', 'tilt'], setZoom: ['value'], setFocus: ['value'] };

export class EasedDrive {
  private lanes = new Map<string, Lane>();

  constructor(
    private readonly send: Send,
    private opts: RampOptions = DEFAULT_RAMP,
  ) {}

  setOptions(opts: RampOptions) {
    this.opts = opts;
    for (const lane of this.lanes.values()) for (const r of Object.values(lane.ramps)) r.setOptions(opts);
  }

  get enabled() {
    return this.opts.attackMs > 0 || this.opts.releaseMs > 0;
  }

  /**
   * Takes a new speed demand. Resolves with the backend's answer to the
   * first command, so the caller can still report "not supported".
   */
  async demand(cmd: RampedCommand, params: Record<string, unknown>): Promise<boolean> {
    if (!this.enabled) return this.send(cmd, params);
    let lane = this.lanes.get(cmd);
    if (!lane) {
      lane = { ramps: {}, extra: {}, last: {} };
      for (const k of KEYS[cmd]) lane.ramps[k] = new SpeedRamp(this.opts, 100);
      this.lanes.set(cmd, lane);
    }
    const now = Date.now();
    for (const [k, v] of Object.entries(params)) if (!KEYS[cmd].includes(k)) lane.extra[k] = v;
    for (const k of KEYS[cmd]) {
      const target = Number(params[k] ?? lane.ramps[k].target);
      lane.ramps[k].set(Number.isFinite(target) ? target : 0, now);
    }
    const ok = await this.step(cmd, lane, true);
    if (ok && !lane.timer) {
      lane.timer = setInterval(() => void this.step(cmd, lane!, false), TICK_MS);
    }
    return ok;
  }

  private async step(cmd: RampedCommand, lane: Lane, force: boolean): Promise<boolean> {
    const now = Date.now();
    const values: Record<string, number> = {};
    let changed = force;
    let done = true;
    for (const [k, r] of Object.entries(lane.ramps)) {
      const v = Math.round(r.tick(now));
      values[k] = v;
      if (v !== lane.last[k]) changed = true;
      if (!r.done(now)) done = false;
    }
    if (done && lane.timer) {
      clearInterval(lane.timer);
      lane.timer = undefined;
    }
    if (!changed) return true;
    lane.last = values;
    try {
      return await this.send(cmd, { ...lane.extra, ...values });
    } catch {
      return false;
    }
  }

  /** Stops every axis immediately (no release glide). */
  async halt(): Promise<void> {
    for (const [cmd, lane] of this.lanes) {
      if (lane.timer) clearInterval(lane.timer);
      lane.timer = undefined;
      for (const r of Object.values(lane.ramps)) r.hard(0);
      const zero = Object.fromEntries(KEYS[cmd as RampedCommand].map((k) => [k, 0]));
      lane.last = zero;
      await this.send(cmd, { ...lane.extra, ...zero }).catch(() => false);
    }
  }

  dispose() {
    for (const lane of this.lanes.values()) if (lane.timer) clearInterval(lane.timer);
    this.lanes.clear();
  }
}
