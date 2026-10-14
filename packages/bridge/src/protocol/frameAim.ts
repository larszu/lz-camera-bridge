/**
 * Frame aim — "draw a frame in the picture, the head goes there".
 *
 * GEOMETRY. A head turns about its pan and tilt axes; the picture is a pinhole
 * projection with the horizontal field of view `hfov`. In units of the image
 * width the focal length is f = 0.5 / tan(hfov/2). A point (u, v) of the
 * picture (0..1, v downwards) is the ray (u − ½, (½ − v)/aspect, f) in the
 * camera frame; turned by the tilt and then the pan of the pose it took, it is
 * a direction in the head frame — and that direction IS a pan/tilt:
 *
 *   world axes  x right, y up, z forward at pan 0 / tilt 0
 *   pan  = atan2(x, z)              positive right, as the head counts
 *   tilt = atan2(y, √(x² + z²))     positive up
 *
 * The target zoom is the angular width of the frame (the angle between the
 * rays through the midpoints of its left and right edges), turned into a zoom
 * position through the field-of-view model below. The frame's height does
 * not enter: the operator draws in the camera's aspect, and a head has no roll.
 *
 * FIELD OF VIEW PER ZOOM POSITION. The honest gap again (see ptzPose.ts): the
 * curve is per model and nobody ships it. The model says where its number comes
 * from (`fit`):
 *
 *   'table'   at least two measured points (`fovTable`, from the automatic
 *             calibration or typed in) — interpolated between them, with the
 *             datasheet ends as anchors where the table does not reach.
 *   'focal'   focal length (measured `zoomTable` or the plan's lens range) and
 *             the sensor width: hfov = 2·atan(sensor / 2f). Physics, not a guess.
 *   'linear'  only the two datasheet ends (or one end and one point): an
 *             estimate between them.
 *   'none'    nothing known — the aim is refused with a sentence.
 *
 * Interpolation runs on ln(tan(hfov/2)), i.e. on the logarithm of the
 * magnification: a zoom position that halves the field of view twice in equal
 * steps is a straight line there, and the ends come out exact.
 *
 * Pure functions: no network, no clock.
 */
import { wrapDeg, type ZoomPoint } from './ptzPose.js';

export interface FovPoint {
  /** Zoom position 0..1. */
  position: number;
  /** Horizontal field of view in degrees at that position. */
  hfovDeg: number;
}

export interface FovModel {
  fovTable?: FovPoint[];
  /** Datasheet values: horizontal field of view at the wide and the tele end. */
  hfovWideDeg?: number;
  hfovTeleDeg?: number;
  /** Sensor width in mm — with a focal length it gives the field of view. */
  sensorWidthMm?: number;
  zoomTable?: ZoomPoint[];
  focalMinMm?: number;
  focalMaxMm?: number;
}

export type FovFit = 'table' | 'focal' | 'linear' | 'none';

export interface AimPose {
  pan: number;
  tilt: number;
  zoom?: number;
}

/** A frame in normalised picture coordinates: left/top corner and size, 0..1. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An equirectangular map: which pan/tilt range it covers. Row 0 is `tiltMax`. */
export interface MapExtent {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
}

const RAD = Math.PI / 180;
const MIN_FOV = 0.2;
const MAX_FOV = 170;

// ── Field of view model ─────────────────────────────────────────────────────

function valid(p: FovPoint): boolean {
  return Number.isFinite(p.position) && Number.isFinite(p.hfovDeg) && p.hfovDeg > 0 && p.hfovDeg < 180;
}

/** ln(tan(h/2)) — the space the curve is interpolated in. */
const toMag = (h: number) => Math.log(Math.tan((h * RAD) / 2));
const fromMag = (m: number) => (2 * Math.atan(Math.exp(m))) / RAD;

function interpolate(points: FovPoint[], zoom: number): number {
  const pts = [...points].sort((a, b) => a.position - b.position);
  if (zoom <= pts[0].position) return pts[0].hfovDeg;
  const last = pts[pts.length - 1];
  if (zoom >= last.position) return last.hfovDeg;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (zoom <= b.position) {
      const t = (zoom - a.position) / (b.position - a.position || 1);
      return fromMag(toMag(a.hfovDeg) + t * (toMag(b.hfovDeg) - toMag(a.hfovDeg)));
    }
  }
  return last.hfovDeg;
}

/** Measured points plus the datasheet ends where no measured point is near them. */
function pointsOf(model: FovModel): { measured: FovPoint[]; all: FovPoint[] } {
  const measured = (model.fovTable ?? []).filter(valid);
  const all = [...measured];
  const near = (pos: number) => measured.some((p) => Math.abs(p.position - pos) < 0.02);
  if (model.hfovWideDeg && !near(0)) all.push({ position: 0, hfovDeg: model.hfovWideDeg });
  if (model.hfovTeleDeg && !near(1)) all.push({ position: 1, hfovDeg: model.hfovTeleDeg });
  return { measured, all: all.filter(valid) };
}

function focalAt(zoom: number, model: FovModel): number | undefined {
  const table = (model.zoomTable ?? []).filter((p) => Number.isFinite(p.position) && p.focalMm > 0);
  if (table.length >= 2) {
    const pts = [...table].sort((a, b) => a.position - b.position);
    if (zoom <= pts[0].position) return pts[0].focalMm;
    const last = pts[pts.length - 1];
    if (zoom >= last.position) return last.focalMm;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (zoom <= b.position) return a.focalMm + ((zoom - a.position) / (b.position - a.position || 1)) * (b.focalMm - a.focalMm);
    }
  }
  const { focalMinMm: min, focalMaxMm: max } = model;
  if (min && max && max > min) return min + Math.min(1, Math.max(0, zoom)) * (max - min);
  return undefined;
}

/** Horizontal field of view at a zoom position, and where the number comes from. */
export function hfovAt(zoom: number, model: FovModel): { hfovDeg: number; fit: FovFit } | null {
  const z = Math.min(1, Math.max(0, zoom));
  const { measured, all } = pointsOf(model);
  if (measured.length >= 2) return { hfovDeg: round2(interpolate(all, z)), fit: 'table' };
  if (model.sensorWidthMm && model.sensorWidthMm > 0) {
    const f = focalAt(z, model);
    if (f) return { hfovDeg: round2((2 * Math.atan(model.sensorWidthMm / (2 * f))) / RAD), fit: 'focal' };
  }
  if (all.length >= 2) return { hfovDeg: round2(interpolate(all, z)), fit: 'linear' };
  return null;
}

/**
 * The zoom position that gives this field of view. Bisection on `hfovAt`, so
 * it holds for every fit as long as the field of view shrinks towards tele.
 * Outside the lens's range it clamps to the end — a frame wider than the wide
 * end gets the wide end, not a refusal.
 */
export function zoomForHfov(hfovDeg: number, model: FovModel): { zoom: number; fit: FovFit } | null {
  const wide = hfovAt(0, model);
  const tele = hfovAt(1, model);
  if (!wide || !tele) return null;
  if (hfovDeg >= wide.hfovDeg) return { zoom: 0, fit: wide.fit };
  if (hfovDeg <= tele.hfovDeg) return { zoom: 1, fit: tele.fit };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (hfovAt(mid, model)!.hfovDeg > hfovDeg) lo = mid;
    else hi = mid;
  }
  return { zoom: Math.round(((lo + hi) / 2) * 10000) / 10000, fit: wide.fit };
}

/** Vertical field of view of a picture with this aspect (width / height). */
export function vfovOf(hfovDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((hfovDeg * RAD) / 2) / aspect)) / RAD;
}

// ── Directions ──────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

export function dirOf(panDeg: number, tiltDeg: number): Vec3 {
  const p = panDeg * RAD;
  const t = tiltDeg * RAD;
  return [Math.cos(t) * Math.sin(p), Math.sin(t), Math.cos(t) * Math.cos(p)];
}

export function panTiltOf(v: Vec3): { pan: number; tilt: number } {
  return { pan: Math.atan2(v[0], v[2]) / RAD, tilt: Math.atan2(v[1], Math.hypot(v[0], v[2])) / RAD };
}

export function angleBetween(a: Vec3, b: Vec3): number {
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.min(1, Math.max(-1, dot))) / RAD;
}

/** Camera frame → head frame: tilt about the x axis, then pan about the y axis. */
function toWorld(c: Vec3, panDeg: number, tiltDeg: number): Vec3 {
  const p = panDeg * RAD;
  const t = tiltDeg * RAD;
  const y = c[1] * Math.cos(t) + c[2] * Math.sin(t);
  const z1 = -c[1] * Math.sin(t) + c[2] * Math.cos(t);
  return [c[0] * Math.cos(p) + z1 * Math.sin(p), y, -c[0] * Math.sin(p) + z1 * Math.cos(p)];
}

/** Head frame → camera frame, the inverse of `toWorld`. */
function toCamera(w: Vec3, panDeg: number, tiltDeg: number): Vec3 {
  const p = panDeg * RAD;
  const t = tiltDeg * RAD;
  const x = w[0] * Math.cos(p) - w[2] * Math.sin(p);
  const z1 = w[0] * Math.sin(p) + w[2] * Math.cos(p);
  return [x, w[1] * Math.cos(t) - z1 * Math.sin(t), w[1] * Math.sin(t) + z1 * Math.cos(t)];
}

/** The ray through picture point (u, v) of a picture taken at `pose` with `hfovDeg`. */
export function rayFromPixel(u: number, v: number, aspect: number, hfovDeg: number, pose: { pan: number; tilt: number }): Vec3 {
  const f = 0.5 / Math.tan((hfovDeg * RAD) / 2);
  return toWorld([u - 0.5, (0.5 - v) / aspect, f], pose.pan, pose.tilt);
}

/** Where a direction lands in that picture (u, v in 0..1 when inside), or null behind the camera. */
export function pixelOfDirection(dir: Vec3, aspect: number, hfovDeg: number, pose: { pan: number; tilt: number }): { u: number; v: number } | null {
  const c = toCamera(dir, pose.pan, pose.tilt);
  if (c[2] <= 1e-9) return null;
  const f = 0.5 / Math.tan((hfovDeg * RAD) / 2);
  return { u: 0.5 + (f * c[0]) / c[2], v: 0.5 - ((f * c[1]) / c[2]) * aspect };
}

// ── Frame → pose ────────────────────────────────────────────────────────────

export interface AimResult {
  pan: number;
  tilt: number;
  /** Angular width of the frame — the field of view the head should zoom to. */
  hfovDeg: number;
}

function checkFrame(frame: Frame): string | null {
  const ok = [frame.x, frame.y, frame.w, frame.h].every(Number.isFinite) && frame.w > 0 && frame.h > 0;
  return ok ? null : 'The frame needs a position and a size';
}

/**
 * A frame drawn in a picture the head took at `pose` with `hfovDeg`.
 * Pan comes back next to the reference pan (no 360° jump across ±180).
 */
export function aimFromPicture(frame: Frame, aspect: number, hfovDeg: number, pose: { pan: number; tilt: number }): AimResult | string {
  const bad = checkFrame(frame);
  if (bad) return bad;
  if (!(aspect > 0) || !(hfovDeg > 0)) return 'The picture size or the field of view is unknown';
  const cy = frame.y + frame.h / 2;
  const centre = panTiltOf(rayFromPixel(frame.x + frame.w / 2, cy, aspect, hfovDeg, pose));
  const width = angleBetween(rayFromPixel(frame.x, cy, aspect, hfovDeg, pose), rayFromPixel(frame.x + frame.w, cy, aspect, hfovDeg, pose));
  return finish(centre, width, pose.pan);
}

/** A frame drawn on an equirectangular map (`MapExtent`). */
export function aimFromMap(frame: Frame, map: MapExtent): AimResult | string {
  const bad = checkFrame(frame);
  if (bad) return bad;
  const at = (u: number, v: number) => ({
    pan: map.panMin + u * (map.panMax - map.panMin),
    tilt: map.tiltMax - v * (map.tiltMax - map.tiltMin),
  });
  const cy = frame.y + frame.h / 2;
  const c = at(frame.x + frame.w / 2, cy);
  const l = at(frame.x, cy);
  const r = at(frame.x + frame.w, cy);
  const width = angleBetween(dirOf(l.pan, l.tilt), dirOf(r.pan, r.tilt));
  return finish(c, width, c.pan);
}

function finish(centre: { pan: number; tilt: number }, widthDeg: number, refPan: number): AimResult {
  const pan = refPan + wrapDeg(centre.pan - refPan);
  return {
    pan: round2(pan),
    tilt: round2(centre.tilt),
    hfovDeg: round2(Math.min(MAX_FOV, Math.max(MIN_FOV, widthDeg))),
  };
}

/** Where a pose's picture sits on a map, as a frame in map coordinates (for the live overlay). */
export function frameOnMap(pose: { pan: number; tilt: number }, hfovDeg: number, aspect: number, map: MapExtent): Frame {
  const vfov = vfovOf(hfovDeg, aspect);
  const span = map.panMax - map.panMin;
  const tspan = map.tiltMax - map.tiltMin;
  // Horizontal extent on an equirectangular map widens with the tilt.
  const wDeg = Math.min(360, hfovDeg / Math.max(0.2, Math.cos(pose.tilt * RAD)));
  return {
    x: (pose.pan - wDeg / 2 - map.panMin) / span,
    y: (map.tiltMax - pose.tilt - vfov / 2) / tspan,
    w: wDeg / span,
    h: vfov / tspan,
  };
}

/**
 * A move time for heads that play an eased trajectory: long enough that the
 * picture can be followed, short enough that nobody waits. ~40°/s, 1–6 s.
 */
export function moveTimeMs(from: { pan: number; tilt: number } | undefined, to: { pan: number; tilt: number }): number {
  if (!from) return 2000;
  const deg = angleBetween(dirOf(from.pan, from.tilt), dirOf(to.pan, to.tilt));
  return Math.round(Math.min(6000, Math.max(1000, (deg / 40) * 1000 + 600)));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
