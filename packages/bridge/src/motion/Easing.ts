/**
 * Ease-in / ease-out for camera moves.
 *
 * Two jobs, one curve family:
 *
 * 1. `SpeedRamp` — operator speed demands (joystick, zoom rocker, Companion
 *    buttons) do not jump to the new speed. They glide there along an ease
 *    curve, so a zoom starts softly and stops softly instead of snapping.
 *    Same idea as the photobooth fan envelope: attack when speeding up,
 *    release when slowing down, never a step.
 * 2. `easedTrajectory` — a preset move from pose A to pose B, sampled at a
 *    fixed interval, every axis on the same eased time line. Heads that take
 *    a stream of absolute positions (Telemetrics S5 keyframes) play it as is.
 *
 * The cubic ease-in/out is the one the multicam planner already uses for its
 * camera transitions (`apps/multicam-planner/src/utils/cameraTransition.ts`),
 * so a move looks the same in the planner and on the real head.
 */

export type EaseCurve = 'linear' | 'sine' | 'cubic' | 'quint';

/** Ease in and out, t in 0..1 → 0..1. */
export function ease(t: number, curve: EaseCurve = 'cubic'): number {
  const c = Math.min(1, Math.max(0, t));
  switch (curve) {
    case 'linear':
      return c;
    case 'sine':
      return 0 - (Math.cos(Math.PI * c) - 1) / 2; // never -0
    case 'quint':
      return c < 0.5 ? 16 * c ** 5 : 1 - (-2 * c + 2) ** 5 / 2;
    case 'cubic':
    default:
      return c < 0.5 ? 4 * c ** 3 : 1 - (-2 * c + 2) ** 3 / 2;
  }
}

export interface RampOptions {
  /** Time to go from standstill to full speed (ms). 0 = no ramp. */
  attackMs: number;
  /** Time to go from full speed to standstill (ms). 0 = no ramp. */
  releaseMs: number;
  curve?: EaseCurve;
}

export const DEFAULT_RAMP: RampOptions = { attackMs: 350, releaseMs: 450, curve: 'cubic' };

/**
 * Glides a speed value (-1..1 or any range) towards a target.
 * The duration of one glide scales with the size of the step:
 * a full-scale change takes `attackMs` (speeding up) or `releaseMs`
 * (slowing down); a small correction is correspondingly quicker.
 */
export class SpeedRamp {
  private from = 0;
  private to = 0;
  private startedAt = 0;
  private durationMs = 0;
  current = 0;

  constructor(
    private opts: RampOptions = DEFAULT_RAMP,
    private fullScale = 1,
  ) {}

  setOptions(opts: RampOptions) {
    this.opts = opts;
  }

  /** New target. Returns true if a glide started (caller should start ticking). */
  set(target: number, now = Date.now()): boolean {
    if (target === this.to && this.done(now)) return false;
    this.current = this.valueAt(now);
    this.from = this.current;
    this.to = target;
    this.startedAt = now;
    const speedingUp = Math.abs(target) > Math.abs(this.from);
    const base = speedingUp ? this.opts.attackMs : this.opts.releaseMs;
    this.durationMs = base * Math.min(1, Math.abs(target - this.from) / this.fullScale);
    return true;
  }

  valueAt(now = Date.now()): number {
    if (this.durationMs <= 0) return this.to;
    const t = (now - this.startedAt) / this.durationMs;
    if (t >= 1) return this.to;
    return this.from + (this.to - this.from) * ease(t, this.opts.curve);
  }

  /** Advances and returns the value to send now. */
  tick(now = Date.now()): number {
    this.current = this.valueAt(now);
    return this.current;
  }

  done(now = Date.now()): boolean {
    return this.durationMs <= 0 || now - this.startedAt >= this.durationMs;
  }

  get target() {
    return this.to;
  }

  /** Emergency: jump to a value without a glide. */
  hard(value: number) {
    this.from = this.to = this.current = value;
    this.durationMs = 0;
  }
}

export type Pose = Record<string, number>;

/**
 * Samples an eased move from `from` to `to` every `intervalMs`.
 * The first sample is the start pose, the last one exactly the target.
 */
export function easedTrajectory(
  from: Pose,
  to: Pose,
  durationMs: number,
  intervalMs = 50,
  curve: EaseCurve = 'cubic',
): Pose[] {
  const steps = Math.max(1, Math.round(durationMs / intervalMs));
  const out: Pose[] = [];
  for (let i = 0; i <= steps; i++) {
    const e = ease(i / steps, curve);
    const p: Pose = {};
    for (const k of Object.keys(to)) {
      const a = from[k] ?? to[k];
      p[k] = Math.round(a + (to[k] - a) * e);
    }
    out.push(p);
  }
  return out;
}
