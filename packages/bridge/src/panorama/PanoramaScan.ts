/**
 * The two jobs that drive a head through a sequence of poses and look at the
 * picture each time: the panorama scan (#138) and the field-of-view
 * calibration (#137). Both take their head and their picture through `deps`,
 * so they run against the demo camera and a synthetic picture in the tests
 * exactly as against a head.
 *
 * The head goes back to where it started when a job ends — finished, failed
 * or cancelled. Whoever pressed the button sees the shot they had before.
 */
import { hfovAt, type FovModel, type FovPoint } from '../protocol/frameAim.js';
import { calibrationStep, hfovFromShift, measureShift } from './fovCalibration.js';
import type { JpegCodec } from './jpegCodec.js';
import type { PanoramaMeta } from './PanoramaStore.js';
import { mapSize, planScan, stitch, type RgbImage, type Tile } from './stitch.js';

export interface HeadPose {
  pan: number;
  tilt: number;
  zoom?: number;
}

export interface JobDeps {
  /** Absolute move; resolves when the command is out (not when the head arrived). */
  drive(pose: HeadPose): Promise<boolean>;
  /** Where the head is. Optional: without it the commanded pose is taken as the truth. */
  readPose?(): Promise<HeadPose>;
  /** A picture taken after `settleMs` — not one from before the move. */
  grab(settleMs: number): Promise<Buffer>;
  codec: JpegCodec;
  cancelled(): boolean;
}

export interface ScanSettings {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
  /** Zoom position for the scan, 0 = wide. */
  zoom: number;
  overlap: number;
  settleMs: number;
}

export const DEFAULT_SCAN: ScanSettings = { panMin: -90, panMax: 90, tiltMin: -25, tiltMax: 25, zoom: 0, overlap: 0.35, settleMs: 1500 };

/** Width the pictures are decoded at — enough for a map, small enough to stitch in a second. */
export const TILE_DECODE_WIDTH = 640;

export interface ScanProgress {
  index: number;
  total: number;
  pan: number;
  tilt: number;
}

class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

async function startPose(deps: JobDeps): Promise<HeadPose | null> {
  return deps.readPose ? deps.readPose().catch(() => null) : null;
}

async function goBack(deps: JobDeps, home: HeadPose | null): Promise<void> {
  if (home) await deps.drive(home).catch(() => false);
}

/** Merge settings from a client with the defaults, clamped to what a head can do. */
export function scanSettings(raw: Partial<ScanSettings> | undefined): ScanSettings {
  const s = { ...DEFAULT_SCAN, ...(raw ?? {}) };
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    panMin: Math.max(-180, n(s.panMin, DEFAULT_SCAN.panMin)),
    panMax: Math.min(180, n(s.panMax, DEFAULT_SCAN.panMax)),
    tiltMin: Math.max(-90, n(s.tiltMin, DEFAULT_SCAN.tiltMin)),
    tiltMax: Math.min(90, n(s.tiltMax, DEFAULT_SCAN.tiltMax)),
    zoom: Math.min(1, Math.max(0, n(s.zoom, 0))),
    overlap: Math.min(0.8, Math.max(0.1, n(s.overlap, DEFAULT_SCAN.overlap))),
    settleMs: Math.min(10000, Math.max(200, n(s.settleMs, DEFAULT_SCAN.settleMs))),
  };
}

export async function runScan(
  cameraNumber: number,
  settings: ScanSettings,
  model: FovModel,
  deps: JobDeps,
  progress: (p: ScanProgress) => void,
  aspectHint = 16 / 9,
): Promise<{ meta: PanoramaMeta; jpeg: Buffer }> {
  const fov = hfovAt(settings.zoom, model);
  if (!fov) throw new Error('The field of view of this camera is unknown — enter the wide/tele values or run the calibration first');
  const plan = planScan({ ...settings, hfovDeg: fov.hfovDeg, aspect: aspectHint });
  if (typeof plan === 'string') throw new Error(plan);
  const home = await startPose(deps);
  const tiles: Tile[] = [];
  let aspect = aspectHint;
  try {
    for (let i = 0; i < plan.length; i++) {
      if (deps.cancelled()) throw new Cancelled();
      const stop = plan[i];
      progress({ index: i + 1, total: plan.length, ...stop });
      await deps.drive({ ...stop, zoom: settings.zoom });
      // The first stop also waits for the zoom and the longest swing.
      const jpeg = await deps.grab(i === 0 ? settings.settleMs * 2 + 1000 : settings.settleMs);
      const actual = deps.readPose ? await deps.readPose().catch(() => null) : null;
      const image = await deps.codec.decode(jpeg, TILE_DECODE_WIDTH);
      aspect = image.width / image.height;
      tiles.push({ pan: actual?.pan ?? stop.pan, tilt: actual?.tilt ?? stop.tilt, hfovDeg: fov.hfovDeg, image });
    }
  } catch (err) {
    await goBack(deps, home);
    throw err;
  }
  await goBack(deps, home);
  const extent = { panMin: settings.panMin, panMax: settings.panMax, tiltMin: settings.tiltMin, tiltMax: settings.tiltMax };
  const size = mapSize(extent, tiles[0]?.image.width ?? TILE_DECODE_WIDTH, fov.hfovDeg);
  const map = stitch(tiles, extent, size.width, size.height);
  const jpeg = await deps.codec.encode(map);
  const meta: PanoramaMeta = {
    cameraNumber, ...extent, width: size.width, height: size.height, pxPerDeg: Math.round(size.pxPerDeg * 1000) / 1000,
    zoom: settings.zoom, hfovDeg: fov.hfovDeg, fit: fov.fit, aspect: Math.round(aspect * 10000) / 10000,
    pictures: tiles.length, createdAt: new Date().toISOString(),
  };
  return { meta, jpeg };
}

export interface CalibrationStepResult {
  zoom: number;
  hfovDeg?: number;
  score?: number;
  /** Why this zoom position gave no value. */
  reason?: string;
}

export const DEFAULT_CALIBRATION_ZOOMS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Measures the field of view at each zoom position, wide to tele, at the pan
 * and tilt the head stands on. Needs a picture with texture across it.
 * Each measured value also sharpens the guess for the next, smaller one.
 */
export async function runFovCalibration(
  zooms: number[],
  model: FovModel,
  deps: JobDeps,
  settleMs: number,
  progress: (r: CalibrationStepResult, index: number, total: number) => void,
): Promise<FovPoint[]> {
  const home = await startPose(deps);
  if (!home) throw new Error('The calibration needs a head that reports its pose');
  const sorted = [...new Set(zooms.map((z) => Math.min(1, Math.max(0, z))))].sort((a, b) => a - b);
  const measured: FovPoint[] = [];
  try {
    for (let i = 0; i < sorted.length; i++) {
      if (deps.cancelled()) throw new Cancelled();
      const zoom = sorted[i];
      const guess = guessFor(zoom, model, measured);
      const step = calibrationStep(guess);
      const result: CalibrationStepResult = { zoom };
      await deps.drive({ pan: home.pan, tilt: home.tilt, zoom });
      const a = await deps.codec.decode(await deps.grab(settleMs * 2), TILE_DECODE_WIDTH);
      const pa = await deps.readPose!().catch(() => null);
      await deps.drive({ pan: home.pan + step, tilt: home.tilt, zoom });
      const b = await deps.codec.decode(await deps.grab(settleMs), TILE_DECODE_WIDTH);
      const pb = await deps.readPose!().catch(() => null);
      // The pan the head REPORTS is the step that happened; the commanded one is the fallback.
      const moved = pa && pb && Math.abs(pb.pan - pa.pan) > 0.05 ? pb.pan - pa.pan : step;
      const shift = measureShift(a, b);
      const hfov = shift ? hfovFromShift(shift.shift, a.width, moved, home.tilt) : null;
      if (!shift) result.reason = 'no clear match between the two pictures (too little texture, or something moved)';
      else if (!hfov || hfov > 170) result.reason = 'the measured shift is implausible';
      else {
        result.hfovDeg = hfov;
        result.score = shift.score;
        measured.push({ position: zoom, hfovDeg: hfov });
      }
      progress(result, i + 1, sorted.length);
    }
  } finally {
    await goBack(deps, home);
  }
  return measured;
}

function guessFor(zoom: number, model: FovModel, measured: FovPoint[]): number {
  if (measured.length >= 2) {
    // Extrapolate in log space from the last two: zoom curves are roughly exponential.
    const [a, b] = measured.slice(-2);
    const t = (zoom - b.position) / (b.position - a.position || 1);
    return Math.max(0.5, b.hfovDeg * Math.pow(b.hfovDeg / a.hfovDeg, t));
  }
  const known = hfovAt(zoom, model);
  if (known) return known.hfovDeg;
  return measured.length ? measured[0].hfovDeg * 0.5 : 60;
}

/** New points replace old ones at (nearly) the same zoom position. */
export function mergeFovTable(old: FovPoint[] | undefined, fresh: FovPoint[]): FovPoint[] {
  const rest = (old ?? []).filter((p) => !fresh.some((f) => Math.abs(f.position - p.position) < 0.01));
  return [...rest, ...fresh].sort((a, b) => a.position - b.position);
}

export function isCancelled(err: unknown): boolean {
  return err instanceof Cancelled;
}

export type { RgbImage };
