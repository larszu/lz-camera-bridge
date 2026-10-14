/**
 * Joystick calibration for the control-surface input (#133).
 *
 * The binding tables in `HidControlSurface.ts` carry factory guesses: centre
 * 128, dead band 6, full travel 0..255. A real stick does not keep to that.
 * A worn pot rests at 131, a Hall stick never reaches 0 or 255, a trigger
 * rests at 4. The guesses then cost the operator twice: the head creeps
 * because the rest is outside the dead band, and full deflection never
 * reaches full speed because the end is never reached.
 *
 * A calibration replaces the guesses with what was measured on this device:
 * per axis the two ends, the rest position (centre of a two-sided axis, the
 * rest end of a trigger or fader), a dead zone sized from the noise at rest,
 * a response curve (linear, or expo with an adjustable amount for fine
 * control around the centre) and an invert switch.
 *
 * It is applied in the bridge input path — `achsenWert` — before the command
 * reaches `dispatchCommand` and from there `EasedDrive`. The ramp then eases
 * a speed that already means what the operator's hand meant.
 *
 * Stored per device (USB vendor:product) in the site file under `input`,
 * because a room keeps its panels, and per axis by the report byte offset,
 * because that is what identifies an axis in a HID report.
 *
 * The capture (`CalibrationSession`) is pure: it is fed raw reports and
 * derives the calibration, so every rule is testable with hand-built buffers.
 * Untested on a real joystick.
 */

export type ResponseCurve = 'linear' | 'expo';

export interface AxisCalibration {
  /** Raw value at one end. For a one-sided axis: the REST end (where 0 comes out). */
  min: number;
  /** Raw value at the other end. For a one-sided axis it may be below `min` (a reversed trigger). */
  max: number;
  /** Raw rest position. Present = the axis is two-sided. */
  centre?: number;
  /** Raw units around the rest that count as rest. */
  deadzone: number;
  curve: ResponseCurve;
  /** 0..1, how much of the cubic goes into the expo curve. Ignored for `linear`. */
  expo: number;
  invert: boolean;
}

/** One device: axes keyed by the report byte offset (as a string, JSON keys are strings). */
export interface DeviceCalibration {
  axes: Record<string, AxisCalibration>;
}

/** The site's `input` block: devices keyed by `deviceKey(vendorId, productId)`. */
export interface InputCalibration {
  devices: Record<string, DeviceCalibration>;
}

export const DEFAULT_EXPO = 0.4;

/** `054c:0ce6` — stable across ports and reboots, unlike the HID path. */
export function deviceKey(vendorId: number, productId: number): string {
  const h = (n: number) => (n & 0xffff).toString(16).padStart(4, '0');
  return `${h(vendorId)}:${h(productId)}`;
}

/** The axis key of a binding: its byte offset. */
export function axisKey(offset: number): string {
  return String(offset);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The response curve on a normalised deflection -1..1.
 *
 * Expo is the RC-transmitter blend `(1-k)·x + k·x³`: same end points, same
 * sign, flatter around the centre. At k = 0 it is linear, at k = 1 a pure
 * cubic. The ends are untouched, so full deflection stays full speed.
 */
export function applyCurve(n: number, curve: ResponseCurve, expo: number): number {
  if (curve !== 'expo') return n;
  const k = clamp(Number.isFinite(expo) ? expo : 0, 0, 1);
  return (1 - k) * n + k * n * n * n;
}

/**
 * Raw → normalised deflection: -1..1 for a two-sided axis, 0..1 for a
 * one-sided one. Dead zone first, then the remaining travel is stretched to
 * the full range, so leaving the dead zone starts at 0 and not with a jump.
 */
export function normaliseRaw(cal: AxisCalibration, raw: number): number {
  const dz = Math.max(0, cal.deadzone);
  if (cal.centre !== undefined) {
    const d = raw - cal.centre;
    if (Math.abs(d) <= dz) return 0;
    const half = d > 0 ? cal.max - cal.centre : cal.centre - cal.min;
    const usable = Math.max(1, half - dz);
    return clamp(Math.sign(d) * ((Math.abs(d) - dz) / usable), -1, 1);
  }
  const dir = cal.max >= cal.min ? 1 : -1;
  const travel = (raw - cal.min) * dir;
  if (travel <= dz) return 0;
  const usable = Math.max(1, Math.abs(cal.max - cal.min) - dz);
  return clamp((travel - dz) / usable, 0, 1);
}

/** Raw → output value in -span..span (two-sided) or 0..span (one-sided), with curve, invert and the binding's gain. */
export function shapeAxis(cal: AxisCalibration, raw: number, span: number, gain = 1): number {
  const n = applyCurve(normaliseRaw(cal, raw), cal.curve, cal.expo);
  const out = Math.round(n * span) * gain * (cal.invert ? -1 : 1);
  return clamp(out, -span, span) || 0; // `|| 0`: no -0 on the wire
}

// ─── Capture ────────────────────────────────────────────────────────────────

/** What the session needs to know about each axis it measures. */
export interface CalibrationAxisSpec {
  key: string;
  offset: number;
  /** 1 or 2 bytes, little-endian — as in `HidBinding.bytes`. */
  bytes: 1 | 2;
  twoSided: boolean;
  label: string;
}

export interface CalibrationAxisLive {
  key: string;
  label: string;
  twoSided: boolean;
  raw: number | null;
  min: number | null;
  max: number | null;
  /** Full raw range of the axis (255 or 65535), for drawing. */
  full: number;
}

export interface CalibrationResult {
  calibration: DeviceCalibration;
  /** Labels of axes that were not moved far enough and keep their previous setting. */
  skipped: string[];
}

export type CalibrationPhase = 'sweep' | 'rest';

/** An axis counts as moved when it travelled at least this share of its full range. */
const MIN_TRAVEL = 0.25;
/** The smallest dead zone, as a share of the full range: rest noise of zero is a lucky sample, not a quiet stick. */
const MIN_DEADZONE = 0.015;

function readRaw(buf: Buffer, offset: number, bytes: 1 | 2): number | null {
  if (bytes === 2) return offset + 1 < buf.length ? buf.readUInt16LE(offset) : null;
  return offset < buf.length ? buf[offset]! : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Track {
  spec: CalibrationAxisSpec;
  raw: number | null;
  min: number | null;
  max: number | null;
  rest: number[];
}

/**
 * Two phases, as the assistant tells the operator:
 *
 *   sweep — "move every stick to all corners": the extremes are recorded.
 *   rest  — "let go": the rest position and its noise are recorded.
 *
 * `finish()` derives one `AxisCalibration` per axis that was moved; an axis
 * that was not keeps what `previous` had, so calibrating the stick does not
 * wipe a fader that nobody touched this time.
 */
export class CalibrationSession {
  private tracks: Track[];
  private _phase: CalibrationPhase = 'sweep';

  constructor(specs: CalibrationAxisSpec[], private readonly previous?: DeviceCalibration) {
    // One track per byte offset: two bindings on the same byte are one axis.
    const seen = new Set<string>();
    this.tracks = specs
      .filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)))
      .map((spec) => ({ spec, raw: null, min: null, max: null, rest: [] }));
  }

  get phase(): CalibrationPhase {
    return this._phase;
  }

  get axisCount(): number {
    return this.tracks.length;
  }

  sample(buf: Buffer): void {
    for (const t of this.tracks) {
      const raw = readRaw(buf, t.spec.offset, t.spec.bytes);
      if (raw === null) continue;
      t.raw = raw;
      t.min = t.min === null ? raw : Math.min(t.min, raw);
      t.max = t.max === null ? raw : Math.max(t.max, raw);
      if (this._phase === 'rest') t.rest.push(raw);
    }
  }

  /** The operator has let go: from now on samples are the rest position. */
  beginRest(): void {
    this._phase = 'rest';
    for (const t of this.tracks) t.rest = [];
  }

  live(): CalibrationAxisLive[] {
    return this.tracks.map((t) => ({
      key: t.spec.key,
      label: t.spec.label,
      twoSided: t.spec.twoSided,
      raw: t.raw,
      min: t.min,
      max: t.max,
      full: t.spec.bytes === 2 ? 65535 : 255,
    }));
  }

  finish(): CalibrationResult {
    const axes: Record<string, AxisCalibration> = { ...(this.previous?.axes ?? {}) };
    const skipped: string[] = [];
    for (const t of this.tracks) {
      const derived = deriveAxis(t, this.previous?.axes[t.spec.key]);
      if (derived) axes[t.spec.key] = derived;
      else skipped.push(t.spec.label);
    }
    return { calibration: { axes }, skipped };
  }
}

function deriveAxis(t: Track, prev: AxisCalibration | undefined): AxisCalibration | null {
  if (t.min === null || t.max === null) return null;
  const full = t.spec.bytes === 2 ? 65535 : 255;
  if (t.max - t.min < full * MIN_TRAVEL) return null;
  const rest = t.rest.length ? t.rest : t.raw !== null ? [t.raw] : [];
  if (rest.length === 0) return null;
  const r0 = median(rest);
  const noise = Math.max(...rest.map((r) => Math.abs(r - r0)));
  const deadzone = Math.max(Math.ceil(noise * 1.5) + 1, Math.round(full * MIN_DEADZONE));
  const keep = { curve: prev?.curve ?? 'linear', expo: prev?.expo ?? DEFAULT_EXPO, invert: prev?.invert ?? false } as const;

  if (t.spec.twoSided) {
    // A stick that rests at one end is not two-sided — or was held. Either way, not a calibration.
    if (r0 - t.min < full * 0.1 || t.max - r0 < full * 0.1) return null;
    return { min: t.min, max: t.max, centre: Math.round(r0), deadzone, ...keep };
  }
  // One-sided: the end it rests at is where 0 comes out; the far end is full.
  const restsLow = r0 - t.min <= t.max - r0;
  return restsLow
    ? { min: Math.round(r0), max: t.max, deadzone, ...keep }
    : { min: Math.round(r0), max: t.min, deadzone, ...keep };
}

// ─── Normalising what comes from a client or a site file ────────────────────

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : undefined;
}

export function normaliseAxisCalibration(raw: unknown): AxisCalibration | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const min = num(o.min);
  const max = num(o.max);
  if (min === undefined || max === undefined || min === max) return null;
  const centre = num(o.centre);
  const out: AxisCalibration = {
    min,
    max,
    deadzone: Math.max(0, num(o.deadzone) ?? 0),
    curve: o.curve === 'expo' ? 'expo' : 'linear',
    expo: clamp(num(o.expo) ?? DEFAULT_EXPO, 0, 1),
    invert: o.invert === true,
  };
  if (centre !== undefined) {
    if (!(min < centre && centre < max)) return null;
    out.centre = centre;
  }
  return out;
}

export function normaliseInputCalibration(raw: unknown): InputCalibration | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const devices = (raw as Record<string, unknown>).devices;
  if (!devices || typeof devices !== 'object') return undefined;
  const out: InputCalibration = { devices: {} };
  for (const [key, dev] of Object.entries(devices as Record<string, unknown>)) {
    if (!/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(key) || !dev || typeof dev !== 'object') continue;
    const axesRaw = (dev as Record<string, unknown>).axes;
    if (!axesRaw || typeof axesRaw !== 'object') continue;
    const axes: Record<string, AxisCalibration> = {};
    for (const [ak, av] of Object.entries(axesRaw as Record<string, unknown>)) {
      if (!/^\d+$/.test(ak)) continue;
      const a = normaliseAxisCalibration(av);
      if (a) axes[ak] = a;
    }
    if (Object.keys(axes).length) out.devices[key] = { axes };
  }
  return Object.keys(out.devices).length ? out : undefined;
}

/** What the operator may change by hand after a calibration: the feel, not the measurement. */
export interface AxisTuning {
  curve?: ResponseCurve;
  expo?: number;
  invert?: boolean;
  deadzone?: number;
}

export function tuneAxis(cal: AxisCalibration, t: AxisTuning): AxisCalibration {
  const out = { ...cal };
  if (t.curve === 'linear' || t.curve === 'expo') out.curve = t.curve;
  if (num(t.expo) !== undefined) out.expo = clamp(Number(t.expo), 0, 1);
  if (typeof t.invert === 'boolean') out.invert = t.invert;
  if (num(t.deadzone) !== undefined) out.deadzone = Math.max(0, Math.round(Number(t.deadzone)));
  return out;
}
