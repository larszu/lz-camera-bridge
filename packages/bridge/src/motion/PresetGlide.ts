/**
 * Eased preset recall for heads that keep their presets inside the camera.
 *
 * A camera-internal preset moves the way the firmware likes: every axis at its
 * own top speed, the shorter axis arriving first, a hard stop at the end. On
 * air that reads as a jolt. Here the preset lives in the bridge as a POSE
 * (pan/tilt in degrees, zoom 0..1, read back from the head when it is stored),
 * and a recall becomes a stream of absolute positions on one eased time line
 * (`easedTrajectory`): all axes start together and land together, softly.
 *
 * Only for backends that can both position absolutely and report their pose
 * (`poseStream` + `readPose`): the start of the move is read, never assumed.
 * The others keep the camera's own preset, and the panel says which one a
 * camera gets (`presetRecall` in the camera list).
 *
 * Each frame carries a speed hint: the velocity its segment needs against the
 * head's top speed, with a little lead, so the head reaches a waypoint just
 * before the next one arrives instead of stopping in between.
 */
import { easedTrajectory, type EaseCurve } from './Easing.js';

export interface PosePoint {
  pan: number;
  tilt: number;
  zoom?: number;
}

/** One preset as the bridge keeps it (site file, per camera). */
export interface BridgePreset {
  /** Pose read from the head at store time; absent → the camera's own preset is recalled. */
  pan?: number;
  tilt?: number;
  zoom?: number;
  /** Move time of this preset (ms). Falls back to `presetMove.timeMs`. */
  timeMs?: number;
  /** false: recall the camera's own preset, unchanged. Default true. */
  soft?: boolean;
}

export interface GlideOptions {
  timeMs: number;
  curve: EaseCurve;
  /** Frame interval (ms). The backend sets it: a head that wants 130 ms between commands gets no 20 Hz. */
  intervalMs: number;
  /** Top pan/tilt speed of the head (°/s) — the scale for the per-frame speed hint. */
  maxDegPerSec: number;
}

export const DEFAULT_GLIDE: GlideOptions = { timeMs: 3000, curve: 'cubic', intervalMs: 50, maxDegPerSec: 90 };
export const GLIDE_TIME_MIN_MS = 300;
export const GLIDE_TIME_MAX_MS = 60000;

/** How much faster than the segment needs the head is told to go. */
const LEAD = 1.25;

export interface GlideFrame {
  pose: PosePoint;
  /** 0..1 of the head's top speed. */
  speed: number;
}

/** Fixed-point scales so `easedTrajectory` (integer frames) keeps 0.01° and 0.0001 zoom. */
const SCALE = { pan: 100, tilt: 100, zoom: 10000 } as const;

export function clampGlideTime(ms: number): number {
  return Math.min(GLIDE_TIME_MAX_MS, Math.max(GLIDE_TIME_MIN_MS, Math.round(ms)));
}

/**
 * Frames from `from` to `to`, start pose excluded (the head is already there),
 * the last one exactly the target. Without a target zoom the zoom is left alone.
 */
export function glideFrames(from: PosePoint, to: PosePoint, opts: GlideOptions): GlideFrame[] {
  const withZoom = to.zoom !== undefined;
  const scaled = (p: PosePoint, fallback: PosePoint) => ({
    pan: p.pan * SCALE.pan,
    tilt: p.tilt * SCALE.tilt,
    ...(withZoom ? { zoom: (p.zoom ?? fallback.zoom ?? 0) * SCALE.zoom } : {}),
  });
  const raw = easedTrajectory(scaled(from, to), scaled(to, to), clampGlideTime(opts.timeMs), opts.intervalMs, opts.curve);
  const frames: GlideFrame[] = [];
  for (let i = 1; i < raw.length; i++) {
    const pose: PosePoint = {
      pan: raw[i].pan / SCALE.pan,
      tilt: raw[i].tilt / SCALE.tilt,
      ...(withZoom ? { zoom: raw[i].zoom / SCALE.zoom } : {}),
    };
    const seg = Math.max(Math.abs(raw[i].pan - raw[i - 1].pan) / SCALE.pan, Math.abs(raw[i].tilt - raw[i - 1].tilt) / SCALE.tilt);
    const degPerSec = seg / (opts.intervalMs / 1000);
    const speed = Math.min(1, Math.max(0.01, (degPerSec * LEAD) / opts.maxDegPerSec));
    frames.push({ pose, speed: Math.round(speed * 1000) / 1000 });
  }
  // The last frame is the target itself, not a rounding of it.
  if (frames.length) frames[frames.length - 1].pose = { pan: to.pan, tilt: to.tilt, ...(withZoom ? { zoom: to.zoom } : {}) };
  return frames;
}

export type GlideResult = 'done' | 'cancelled' | 'failed';

type Send = (cmd: string, params: Record<string, unknown>) => Promise<boolean>;

/**
 * Plays frames as `ptzAbsolute { pan, tilt, zoom?, speed, stream: true }`, one
 * per interval, on a drift-free clock. One glide per camera: a new one, or any
 * operator move (`cancel`), ends the running one at the frame it reached.
 */
export class PresetGlide {
  private token = 0;
  private running = false;

  get moving(): boolean {
    return this.running;
  }

  cancel(): void {
    this.token++;
  }

  async run(send: Send, frames: GlideFrame[], intervalMs: number): Promise<GlideResult> {
    const token = ++this.token;
    this.running = true;
    const start = Date.now();
    try {
      let i = 0;
      while (i < frames.length) {
        if (token !== this.token) return 'cancelled';
        // A slow transport (one HTTP request per frame) falls behind the
        // clock; frames whose time has passed are skipped, so the move keeps
        // its length, and the next one carries the fastest skipped speed.
        const due = Math.min(frames.length - 1, Math.floor((Date.now() - start) / intervalMs));
        let speed = frames[i].speed;
        while (i < due) speed = Math.max(speed, frames[++i].speed);
        const ok = await send('ptzAbsolute', { ...frames[i].pose, speed, stream: true }).catch(() => false);
        if (!ok) return 'failed';
        i++;
        const wait = start + i * intervalMs - Date.now();
        if (wait > 0 && i < frames.length) await new Promise((r) => setTimeout(r, wait));
      }
      return token === this.token ? 'done' : 'cancelled';
    } finally {
      if (token === this.token) this.running = false;
    }
  }
}
