/**
 * Poses — absolute pan/tilt/zoom, and how a planned shot becomes one.
 *
 * The MultiCam Planner exports (camera-list v3) a camera's planned heading
 * and its presets as pan/tilt in DEGREES in the ROOM frame: pan 0 points
 * right on the floor plan, positive turns clockwise on the plan (y grows
 * downwards, see multicam `sightline.ts`); tilt negative looks down. A PTZ
 * head knows nothing of the room: its pan 0 is wherever it was mounted,
 * positive is right (clockwise seen from above). Both are clockwise, so the
 * room frame becomes the head frame by subtracting the heading of the head's
 * home position — which is the planned camera heading, until the site says
 * otherwise:
 *
 *   headPan  = presetPan  − homeHeading + offset.pan
 *   headTilt = presetTilt              + offset.tilt
 *
 * `offset` is measured on site (`calibrate`): drive the head by hand onto a
 * shot the plan knows, read the head's actual pose, and the difference to the
 * planned pose is the mounting error — a head that is 3° off the drawing puts
 * every planned preset 3° off, and one measurement fixes all of them.
 *
 * ZOOM is the honest gap. A head takes a zoom POSITION (VISCA 0..0x4000,
 * Panasonic 0x555..0xFFF); the plan knows a FOCAL LENGTH. The two ends are
 * definitions — position 0 is the wide end, the maximum is the tele end — and
 * nothing in between is: the curve is per model and non-linear. Without a
 * measured table this module interpolates linearly and SAYS SO (`fit:
 * 'linear'`); with a table (`zoomTable`, measured on that model) it
 * interpolates between the measured points (`fit: 'table'`). It never
 * invents a number it cannot name the source of.
 *
 * Pure functions: no network, no clock.
 */

export interface Pose {
  /** Head frame, degrees, positive right. */
  pan: number;
  /** Degrees, positive up. */
  tilt: number;
  /** 0..1 of the head's zoom range; undefined when unknown. */
  zoom?: number;
}

export interface PoseOffset {
  pan: number;
  tilt: number;
}

export interface PlannedShot {
  number: number;
  name: string;
  /** Room frame, degrees. */
  pan: number;
  tilt: number;
  focalMm?: number;
  focusM?: number;
}

/** One measured point of a zoom curve: at this position the lens read this focal length. */
export interface ZoomPoint {
  position: number; // 0..1
  focalMm: number;
}

export interface ZoomFit {
  zoom: number;
  fit: 'table' | 'linear' | 'none';
}

export const ZERO_OFFSET: PoseOffset = { pan: 0, tilt: 0 };

/** Wrap to (−180, 180]. */
export function wrapDeg(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Planned shot → head pose. `homeHeading` is the room heading of the head's pan 0. */
export function shotToPose(
  shot: PlannedShot,
  homeHeading: number,
  offset: PoseOffset = ZERO_OFFSET,
  lens?: { focalMinMm?: number; focalMaxMm?: number; zoomTable?: ZoomPoint[] },
): Pose & { fit: ZoomFit['fit'] } {
  const pan = wrapDeg(shot.pan - homeHeading + offset.pan);
  const tilt = shot.tilt + offset.tilt;
  const z = shot.focalMm !== undefined ? zoomForFocal(shot.focalMm, lens) : { zoom: undefined, fit: 'none' as const };
  return { pan, tilt, ...(z.zoom !== undefined ? { zoom: z.zoom } : {}), fit: z.fit };
}

/**
 * The offset that makes the plan agree with the head: the head was driven by
 * hand onto `shot`, and it reads `actual`.
 */
export function calibrateOffset(shot: PlannedShot, homeHeading: number, actual: Pose): PoseOffset {
  const planned = shotToPose(shot, homeHeading);
  return { pan: wrapDeg(actual.pan - planned.pan), tilt: actual.tilt - planned.tilt };
}

export function zoomForFocal(
  focalMm: number,
  lens?: { focalMinMm?: number; focalMaxMm?: number; zoomTable?: ZoomPoint[] },
): ZoomFit {
  const table = lens?.zoomTable?.filter((p) => Number.isFinite(p.position) && Number.isFinite(p.focalMm)) ?? [];
  if (table.length >= 2) {
    const pts = [...table].sort((a, b) => a.focalMm - b.focalMm);
    if (focalMm <= pts[0].focalMm) return { zoom: clamp01(pts[0].position), fit: 'table' };
    const last = pts[pts.length - 1];
    if (focalMm >= last.focalMm) return { zoom: clamp01(last.position), fit: 'table' };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (focalMm <= b.focalMm) {
        const t = (focalMm - a.focalMm) / (b.focalMm - a.focalMm || 1);
        return { zoom: clamp01(a.position + t * (b.position - a.position)), fit: 'table' };
      }
    }
  }
  const min = lens?.focalMinMm;
  const max = lens?.focalMaxMm;
  if (min !== undefined && max !== undefined && max > min) {
    return { zoom: clamp01((focalMm - min) / (max - min)), fit: 'linear' };
  }
  return { zoom: undefined as unknown as number, fit: 'none' };
}

/** 0..1, rounded to four places — a zoom position is a 14-bit number, not a float artefact. */
function clamp01(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}

// ── VISCA encodings ────────────────────────────────────────────────────────────

/**
 * Pan/tilt position units per degree. Sony BRC/SRG and the PTZOptics family
 * both document ±170° pan as ±0x0990 → 2448/170 = 14.4 units per degree, and
 * the same scale for tilt. Other heads differ; the slot config can override.
 */
export const VISCA_UNITS_PER_DEG = 14.4;
export const VISCA_ZOOM_MAX = 0x4000;

/** Four nibbles of a signed 16-bit value, VISCA style (0p 0q 0r 0s). */
export function nibbles4(value: number): number[] {
  const v = Math.round(value) & 0xffff;
  return [(v >> 12) & 0xf, (v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf];
}

/** Back from four nibbles (signed). */
export function fromNibbles4(n: number[], offset = 0): number {
  const v = ((n[offset] & 0xf) << 12) | ((n[offset + 1] & 0xf) << 8) | ((n[offset + 2] & 0xf) << 4) | (n[offset + 3] & 0xf);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Pan-tiltDrive AbsolutePosition: 81 01 06 02 VV WW 0Y 0Y 0Y 0Y 0Z 0Z 0Z 0Z FF. */
export function viscaAbsolutePanTilt(pan: number, tilt: number, unitsPerDeg = VISCA_UNITS_PER_DEG, panSpeed = 0x18, tiltSpeed = 0x14): number[] {
  return [0x81, 0x01, 0x06, 0x02, Math.max(1, Math.min(0x18, Math.round(panSpeed))), Math.max(1, Math.min(0x14, Math.round(tiltSpeed))),
    ...nibbles4(pan * unitsPerDeg), ...nibbles4(tilt * unitsPerDeg), 0xff];
}

/** CAM_Zoom Direct: 81 01 04 47 0p 0q 0r 0s FF with 0..0x4000. */
export function viscaZoomDirect(zoom01: number): number[] {
  return [0x81, 0x01, 0x04, 0x47, ...nibbles4(Math.round(clamp01(zoom01) * VISCA_ZOOM_MAX)), 0xff];
}

export const VISCA_INQ_PAN_TILT = [0x81, 0x09, 0x06, 0x12, 0xff];
export const VISCA_INQ_ZOOM = [0x81, 0x09, 0x04, 0x47, 0xff];

/** Reply y0 50 0w 0w 0w 0w 0z 0z 0z 0z FF → degrees. Null when the frame is not that reply. */
export function parseViscaPanTilt(frame: Uint8Array | number[], unitsPerDeg = VISCA_UNITS_PER_DEG): { pan: number; tilt: number } | null {
  const b = Array.from(frame);
  const i = b.findIndex((x, k) => (x & 0xf0) === 0x90 && b[k + 1] === 0x50 && b.length >= k + 11 && b[k + 10] === 0xff);
  if (i < 0) return null;
  const pan = fromNibbles4(b, i + 2) / unitsPerDeg;
  const tilt = fromNibbles4(b, i + 6) / unitsPerDeg;
  return { pan: round1(pan), tilt: round1(tilt) };
}

/** Reply y0 50 0p 0q 0r 0s FF → 0..1. */
export function parseViscaZoom(frame: Uint8Array | number[]): number | null {
  const b = Array.from(frame);
  const i = b.findIndex((x, k) => (x & 0xf0) === 0x90 && b[k + 1] === 0x50 && b.length >= k + 7 && b[k + 6] === 0xff);
  if (i < 0) return null;
  const raw = ((b[i + 2] & 0xf) << 12) | ((b[i + 3] & 0xf) << 8) | ((b[i + 4] & 0xf) << 4) | (b[i + 5] & 0xf);
  return clamp01(raw / VISCA_ZOOM_MAX);
}

// ── Sony CGI (SRG/BRC) ────────────────────────────────────────────────────────

/** `ptzf.cgi?AbsolutePanTilt=<pan>,<tilt>,<speed>` — 4-digit hex, VISCA units. */
export function sonyCgiAbsolutePanTilt(pan: number, tilt: number, speed = 24, unitsPerDeg = VISCA_UNITS_PER_DEG): string {
  return `/command/ptzf.cgi?AbsolutePanTilt=${hex4(pan * unitsPerDeg)},${hex4(tilt * unitsPerDeg)},${Math.max(1, Math.min(24, Math.round(speed)))}`;
}
export function sonyCgiAbsoluteZoom(zoom01: number): string {
  return `/command/ptzf.cgi?AbsoluteZoom=${hex4(clamp01(zoom01) * VISCA_ZOOM_MAX)}`;
}
/** `inquiry.cgi?inq=ptzf` → `AbsolutePTZF=pppp,tttt,zzzz,ffff`. */
export function parseSonyCgiPose(body: string, unitsPerDeg = VISCA_UNITS_PER_DEG): Pose | null {
  const m = /AbsolutePTZF=([0-9a-fA-F]{1,4}),([0-9a-fA-F]{1,4}),([0-9a-fA-F]{1,4})/.exec(body);
  if (!m) return null;
  return {
    pan: round1(signed16(parseInt(m[1], 16)) / unitsPerDeg),
    tilt: round1(signed16(parseInt(m[2], 16)) / unitsPerDeg),
    zoom: clamp01(parseInt(m[3], 16) / VISCA_ZOOM_MAX),
  };
}

// ── Panasonic AW ────────────────────────────────────────────────────────────

/**
 * `#APC[pan][tilt]`, 4 hex digits each, 0x8000 = centre. The AW protocol maps
 * −175..+175° pan to 0x2D08..0xD2F5 and −30..+90°/+210° tilt over the same
 * scale: 121.35 units per degree. Zoom `#AXZ[3 hex]`, 0x555 (wide)..0xFFF (tele).
 */
export const AW_PAN_MIN = 0x2d08; // −175°
export const AW_PAN_MAX = 0xd2f5; // +175°
export const AW_UNITS_PER_DEG = (AW_PAN_MAX - AW_PAN_MIN) / 350;
export const AW_CENTER = 0x8000;
export const AW_ZOOM_MIN = 0x555;
export const AW_ZOOM_MAX = 0xfff;

/**
 * Pan runs between the two documented end values; tilt uses the same scale
 * around 0x8000. *Tuning*: the tilt end values differ per AW model and have
 * not been read off a head here.
 */
export function awAbsolutePanTilt(pan: number, tilt: number): string {
  const p = Math.round(AW_PAN_MIN + (Math.max(-175, Math.min(175, pan)) + 175) * AW_UNITS_PER_DEG);
  const t = Math.round(AW_CENTER + tilt * AW_UNITS_PER_DEG);
  return `APC${hex4(p)}${hex4(t)}`;
}
export function awAbsoluteZoom(zoom01: number): string {
  return `AXZ${Math.round(AW_ZOOM_MIN + clamp01(zoom01) * (AW_ZOOM_MAX - AW_ZOOM_MIN)).toString(16).toUpperCase().padStart(3, '0')}`;
}
/** Reply `aPC[pan][tilt]` / `axz[zoom]` (the head answers the command in lower case). */
export function parseAwPanTilt(body: string): { pan: number; tilt: number } | null {
  const m = /aPC([0-9a-fA-F]{4})([0-9a-fA-F]{4})/i.exec(body);
  if (!m) return null;
  return {
    pan: round1((parseInt(m[1], 16) - AW_PAN_MIN) / AW_UNITS_PER_DEG - 175),
    tilt: round1((parseInt(m[2], 16) - AW_CENTER) / AW_UNITS_PER_DEG),
  };
}
export function parseAwZoom(body: string): number | null {
  const m = /(?:a[xg]z|gz)([0-9a-fA-F]{3})/i.exec(body);
  if (!m) return null;
  return clamp01((parseInt(m[1], 16) - AW_ZOOM_MIN) / (AW_ZOOM_MAX - AW_ZOOM_MIN));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function hex4(value: number): string {
  return (Math.round(value) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
function signed16(v: number): number {
  return v >= 0x8000 ? v - 0x10000 : v;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
