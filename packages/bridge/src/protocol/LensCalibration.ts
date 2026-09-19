/**
 * Lens calibration tables: raw readings → a scale someone can use.
 *
 * ── WHY A TABLE AND NOT A FORMULA ──────────────────────────────────────────
 *
 * The sources give three different raw ranges for the same two axes:
 *
 *     serial 0x31 / 0x32     0x0000..0xFFFF    zoom wide→tele, focus MOD→inf
 *     analog pin 10 / 11     2..7 V
 *     FreeD                  0..4095
 *
 * None of those pairs is a fixed relationship. The voltage figures are
 * unverified third-party reverse engineering, and `0x0000..0xFFFF` may well
 * not cover the whole mechanical travel of a particular lens — a lens that
 * reads 0x0C00 at its hard stop has not been driven to 0x0000 by anyone.
 * A constant in the code would turn one lens's measurement into every lens's
 * truth. So the mapping is measured per lens and lives in a table, and this
 * module only interpolates between measured points.
 *
 * The same tables serve the iris loop (issue #40) and the FreeD zoom/focus
 * output (issue #55). Two mapping mechanisms would be two behaviours.
 *
 * ── OUTSIDE THE MEASURED RANGE, THE ANSWER IS "UNKNOWN" ────────────────────
 *
 * `interpolate` returns null for a reading beyond the outermost points rather
 * than clamping to the end value. Clamping would assert that the axis is at
 * its stop, which is precisely what was not measured: all that is known is
 * that the calibration does not reach this far. A null travels onward as a
 * missing axis — `encodeFreeD` refuses it and `FreeDSender` sends nothing —
 * which is the correct report. A clamped 4095 would look like a lens racked
 * fully to tele.
 *
 * Likewise: no table, no value. Nothing here estimates.
 *
 * Pure functions — no hardware, no clock, no file.
 */

/** One measured point: a raw reading and the value it corresponds to. */
export interface CalPoint {
  /** What the lens reported: serial count, millivolts, ADC count — the unit is the table's. */
  raw: number;
  /** What it means, in the table's output unit. */
  value: number;
}

export interface CalibrationTable {
  /**
   * Which axis this calibrates. Free text, because the axes this bridge will
   * meet are not a closed set; it exists so a mis-filed table is visible.
   */
  axis: string;
  /** The unit of `raw`, e.g. `serial-16bit`, `millivolt`, `adc-count`. */
  rawUnit: string;
  /** The unit of `value`, e.g. `mm` for focal length, `percent`, `metre`. */
  valueUnit: string;
  /**
   * Measured points, at least two. Must be strictly monotone in `raw`;
   * `value` may rise or fall with it, which is how direction sense is stated.
   */
  points: readonly CalPoint[];
  /** Where the numbers come from. A table without provenance is a guess. */
  source?: string;
}

export type CalibrationCheck = { ok: true } | { ok: false; problems: readonly string[] };

/** The range a FreeD consumer expects for zoom and focus. */
export const FREED_AXIS_MIN = 0;
export const FREED_AXIS_MAX = 4095;

/**
 * Is this table usable?
 *
 * Every problem is reported, not just the first: someone fixing a table by
 * hand wants the whole list, and a check that stops at the first fault makes
 * them run it four times.
 */
export function checkCalibration(table: CalibrationTable): CalibrationCheck {
  const problems: string[] = [];
  const pts = table.points;

  if (pts.length < 2) {
    problems.push(`needs at least two measured points, has ${pts.length}`);
  }
  if (pts.some((p) => !Number.isFinite(p.raw) || !Number.isFinite(p.value))) {
    problems.push('every point must carry finite raw and value numbers');
  }

  if (pts.length >= 2 && problems.length === 0) {
    const rawUp = pts[1]!.raw > pts[0]!.raw;
    const valUp = pts[1]!.value > pts[0]!.value;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (a.raw === b.raw) {
        problems.push(`raw ${a.raw} appears twice — one reading cannot mean two values`);
        continue;
      }
      if (b.raw > a.raw !== rawUp) {
        problems.push(`raw is not monotone at point ${i}: ${a.raw} then ${b.raw}`);
      }
      if (a.value === b.value) {
        problems.push(`value ${a.value} repeats at point ${i} — a flat step has no direction`);
        continue;
      }
      if (b.value > a.value !== valUp) {
        // A reversal is what a mis-wired direction sense looks like, and it is
        // worth naming rather than averaging away: past the reversal the same
        // raw reading maps to two different values.
        problems.push(`value direction reverses at point ${i}: ${a.value} then ${b.value}`);
      }
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** The measured raw span, smallest first. Null when the table is unusable. */
export function calibratedRange(table: CalibrationTable): { min: number; max: number } | null {
  if (!checkCalibration(table).ok) return null;
  const raws = table.points.map((p) => p.raw);
  return { min: Math.min(...raws), max: Math.max(...raws) };
}

/**
 * The value for a raw reading, by straight lines between measured points.
 *
 * Returns null when the table is unusable or the reading lies outside the
 * measured span — see the module comment. Piecewise linear and nothing
 * cleverer: a spline through six hand-measured points invents curvature that
 * nobody observed.
 */
export function interpolate(table: CalibrationTable, raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  if (!checkCalibration(table).ok) return null;

  const pts = [...table.points].sort((a, b) => a.raw - b.raw);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (raw < first.raw || raw > last.raw) return null;

  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (raw <= b.raw) {
      const t = (raw - a.raw) / (b.raw - a.raw);
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

/**
 * A raw reading as a FreeD axis count, 0..4095.
 *
 * The span of the table's own `value` column is what maps onto 0..4095: the
 * calibration states how far the axis goes, so its ends ARE the ends. That is
 * why a reading outside the table is null rather than 0 or 4095 — an
 * out-of-range reading means the calibration is short, not that the lens is
 * at a stop.
 *
 * Rounded to a whole count, because the field is an integer; the FreeD zoom
 * and focus fields are 24 bits wide, but consumers work in 0..4095 and a
 * larger number would not be read as "further".
 */
export function toFreeDAxis(table: CalibrationTable, raw: number): number | null {
  const value = interpolate(table, raw);
  if (value === null) return null;

  const values = table.points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return null;

  const t = (value - lo) / (hi - lo);
  const counts = Math.round(FREED_AXIS_MIN + t * (FREED_AXIS_MAX - FREED_AXIS_MIN));
  // Rounding cannot leave the range here — but a table edited later could, and
  // an overflowing axis count is worse than a clamped one at the very end.
  return counts < FREED_AXIS_MIN
    ? FREED_AXIS_MIN
    : counts > FREED_AXIS_MAX
      ? FREED_AXIS_MAX
      : counts;
}

/**
 * Zoom and focus for one FreeD sample, from whatever tables exist.
 *
 * An axis without a table is null and stays null. That is the whole point: a
 * bridge that has been calibrated for zoom but not for focus reports zoom and
 * says nothing about focus, instead of sending a focus number it made up.
 */
export function freeDLensAxes(input: {
  zoom?: { table: CalibrationTable; raw: number };
  focus?: { table: CalibrationTable; raw: number };
}): { zoom: number | null; focus: number | null } {
  return {
    zoom: input.zoom ? toFreeDAxis(input.zoom.table, input.zoom.raw) : null,
    focus: input.focus ? toFreeDAxis(input.focus.table, input.focus.raw) : null,
  };
}
