/**
 * Camera pose → FreeD D1 sample, and the configuration that decides how.
 *
 * Every camera that reports its pose (`readPose`: pan/tilt in degrees, zoom
 * and focus 0..1 of their counters, an elevation column in raw counts) can be
 * sent as FreeD tracking. This module is the pure half: what one pose read
 * becomes on the wire, and how a pose between two slow reads is drawn.
 * Polling, sockets and timers live in `transport/FreeDOutput.ts`.
 *
 * ── Frame and units ───────────────────────────────────────────────────────
 * The head frame of `Pose` already matches FreeD: pan positive clockwise seen
 * from above, tilt positive up, degrees. Roll is not an axis a pan/tilt head
 * has; it is sent as the configured value (0 unless stated). Position is the
 * camera's MOUNTING point in the room, millimetres, stated per camera — the
 * bridge cannot measure it. An elevation column adds its height to Z through
 * a stated scale (`columnMmPerCount`), because the head reports raw counts.
 *
 * ── Zoom and focus ────────────────────────────────────────────────────────
 * FreeD carries encoder counts, not millimetres; the receiver maps them (in
 * Unreal: the encoder range of the FreeD source plus a lens file). The 0..1
 * position goes through `toFreeDAxis` of `LensCalibration.ts` — with a
 * measured table when the camera config has one, otherwise with the identity
 * table whose two points ARE the definitions of the counter (0 = wide / near
 * end, 1 = tele / far end). Either way the result is 0..4095.
 *
 * A camera that reports no zoom or no focus at all sends 0 on that axis and
 * names it in `unread`; the panel shows it. That is not a measurement, and the
 * receiver should treat the encoder as invalid. Pan and tilt are different: a
 * pose read that failed or went stale is not sent at all (see FreeDOutput).
 *
 * Pure functions — no clock of its own, no socket.
 */
import type { FreeDSample } from './FreeD.js';
import { toFreeDAxis, type CalibrationTable } from './LensCalibration.js';

export interface FreeDTarget {
  host: string;
  port: number;
}

/** Site-wide: where the packets go and how often. */
export interface FreeDSiteConfig {
  /** Every target gets every camera's packets. Empty → nothing is sent. */
  targets: FreeDTarget[];
  /** Packets per second per camera. Usually the show's frame or field rate. */
  rateHz: number;
  /** How often a camera's pose is read, in ms. Packets in between are interpolated. */
  pollMs?: number;
}

/** Per camera, kept in its `CameraConfig.freed`. */
export interface FreeDCameraConfig {
  enabled: boolean;
  /** FreeD camera id byte, 0..255. Default: the camera number. */
  cameraId?: number;
  /** Mounting point in the room, mm. Default 0,0,0 — the receiver's origin. */
  positionMm?: { x: number; y: number; z: number };
  /** Elevation column: millimetres per raw count added to Z. Without it the column is not used. */
  columnMmPerCount?: number;
  /** Mirror an axis (sign for angles, 1 − v for zoom/focus). */
  invert?: { pan?: boolean; tilt?: boolean; zoom?: boolean; focus?: boolean };
  /** Added after the inversion, degrees. */
  offsetDeg?: { pan?: number; tilt?: number; roll?: number };
  /** Measured 0..1 position → value tables (LensCalibration). Without one the counter range is used. */
  zoomTable?: CalibrationTable;
  focusTable?: CalibrationTable;
}

/** Unreal's Live Link FreeD source listens here unless told otherwise. A suggestion for the panel, not a protocol port. */
export const FREED_SUGGESTED_PORT = 40000;
export const FREED_DEFAULT_RATE_HZ = 50;
export const FREED_DEFAULT_POLL_MS = 50;

/** The counter itself: its ends are definitions, so this table claims nothing beyond them. */
export const COUNTER_RANGE_TABLE = (axis: string): CalibrationTable => ({
  axis,
  rawUnit: 'position-0..1',
  valueUnit: 'position-0..1',
  points: [{ raw: 0, value: 0 }, { raw: 1, value: 1 }],
  source: 'counter range of the camera (ends by definition)',
});

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Clean a site config from the wire or a file. Returns null when nothing usable is left. */
export function normaliseFreeDSite(raw: unknown): FreeDSiteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const targets: FreeDTarget[] = [];
  for (const t of Array.isArray(r.targets) ? r.targets : []) {
    const host = typeof (t as FreeDTarget)?.host === 'string' ? (t as FreeDTarget).host.trim() : '';
    const port = Number((t as FreeDTarget)?.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (targets.some((x) => x.host === host && x.port === port)) continue;
    targets.push({ host, port });
  }
  const rate = Number(r.rateHz);
  const poll = Number(r.pollMs);
  return {
    targets,
    rateHz: finite(rate) && rate > 0 && rate <= 240 ? rate : FREED_DEFAULT_RATE_HZ,
    ...(finite(poll) && poll >= 10 && poll <= 2000 ? { pollMs: Math.round(poll) } : {}),
  };
}

export function freeDCameraId(cfg: FreeDCameraConfig | undefined, cameraNumber: number): number {
  const id = cfg?.cameraId;
  const n = Number.isInteger(id) ? id! : cameraNumber;
  return Math.max(0, Math.min(255, n));
}

/** What a pose read carries. */
export interface PoseRead {
  pan: number;
  tilt: number;
  zoom?: number;
  focus?: number;
  column?: number;
}

export interface FreeDMapped {
  sample: FreeDSample;
  /** Lens axes the camera did not report; sent as 0. */
  unread: ('zoom' | 'focus')[];
}

function lensAxis(v: number | undefined, invert: boolean | undefined, table: CalibrationTable | undefined, axis: string): number | null | undefined {
  if (!finite(v)) return undefined;
  const p = invert ? 1 - v : v;
  return toFreeDAxis(table ?? COUNTER_RANGE_TABLE(axis), p);
}

/**
 * One pose (or none) → one sample. `pose === null` (no read yet, read failed,
 * stale) gives null angles, which the encoder refuses: silence on the wire.
 */
export function poseToFreeD(pose: PoseRead | null, cfg: FreeDCameraConfig | undefined, cameraNumber: number): FreeDMapped {
  const inv = cfg?.invert ?? {};
  const off = cfg?.offsetDeg ?? {};
  const pos = cfg?.positionMm ?? { x: 0, y: 0, z: 0 };
  const unread: ('zoom' | 'focus')[] = [];

  let zoom: number | null = null;
  let focus: number | null = null;
  let zMm: number | null = finite(pos.z) ? pos.z : 0;
  if (pose) {
    const z = lensAxis(pose.zoom, inv.zoom, cfg?.zoomTable, 'zoom');
    if (z === undefined) { unread.push('zoom'); zoom = 0; } else zoom = z;
    const f = lensAxis(pose.focus, inv.focus, cfg?.focusTable, 'focus');
    if (f === undefined) { unread.push('focus'); focus = 0; } else focus = f;
    // A stated column scale is a statement that the column moves; an unknown
    // column height is then an unknown Z, not the floor.
    if (finite(cfg?.columnMmPerCount)) {
      zMm = finite(pose.column) ? (zMm ?? 0) + pose.column * cfg!.columnMmPerCount! : null;
    }
  }

  return {
    sample: {
      cameraId: freeDCameraId(cfg, cameraNumber),
      panDeg: pose ? (inv.pan ? -pose.pan : pose.pan) + (off.pan ?? 0) : null,
      tiltDeg: pose ? (inv.tilt ? -pose.tilt : pose.tilt) + (off.tilt ?? 0) : null,
      rollDeg: pose ? off.roll ?? 0 : null,
      xMm: finite(pos.x) ? pos.x : 0,
      yMm: finite(pos.y) ? pos.y : 0,
      zMm,
      zoom,
      focus,
    },
    unread,
  };
}

/**
 * Smooth output from slow pose reads.
 *
 * A head answers a few times per second to a few dozen; FreeD goes out at the
 * show's frame rate. Between two reads the pose is drawn on a straight line
 * from the previous read to the latest, over the time the last read took to
 * arrive — the output runs one read interval behind and never overshoots,
 * where extrapolation would guess where the head is going.
 *
 * A read older than `staleMs` ends the pose: `at()` gives null and the output
 * goes silent instead of holding a frozen value that looks like a camera
 * nobody moves.
 */
export class PoseInterpolator {
  private prev: { t: number; pose: PoseRead } | null = null;
  private last: { t: number; pose: PoseRead } | null = null;

  constructor(private readonly staleMs: number) {}

  push(t: number, pose: PoseRead): void {
    this.prev = this.last;
    this.last = { t, pose };
  }

  clear(): void {
    this.prev = null;
    this.last = null;
  }

  /** Time of the latest read, or null. */
  get lastReadAt(): number | null {
    return this.last?.t ?? null;
  }

  at(now: number): PoseRead | null {
    const last = this.last;
    if (!last || now - last.t > this.staleMs) return null;
    const prev = this.prev;
    if (!prev || last.t <= prev.t) return last.pose;
    const a = Math.max(0, Math.min(1, (now - last.t) / (last.t - prev.t)));
    const lerp = (x: number | undefined, y: number | undefined): number | undefined =>
      finite(x) && finite(y) ? x + (y - x) * a : y;
    const p0 = prev.pose;
    const p1 = last.pose;
    // A pan that jumped by more than half a turn wrapped around (±180):
    // drawing a line through the back would swing the camera the long way.
    const pan = Math.abs(p1.pan - p0.pan) > 180 ? p1.pan : lerp(p0.pan, p1.pan)!;
    const out: PoseRead = { pan, tilt: lerp(p0.tilt, p1.tilt)! };
    const zoom = lerp(p0.zoom, p1.zoom);
    const focus = lerp(p0.focus, p1.focus);
    const column = lerp(p0.column, p1.column);
    if (zoom !== undefined) out.zoom = zoom;
    if (focus !== undefined) out.focus = focus;
    if (column !== undefined) out.column = column;
    return out;
  }
}
