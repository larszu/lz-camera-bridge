/**
 * Device profiles: a retro-fitted head is described, not coded for.
 *
 * A foreign pan/tilt head or a foreign column joins this bridge by way of a
 * profile — axes, drive, feedback, homing, brake, cut-out limits. The test of
 * whether the format is any good is a blunt one, and it is issue #58's: a
 * second device has to work **without a code change**.
 *
 * ── A MISSING FIGURE STAYS MISSING ─────────────────────────────────────────
 *
 * The house rule, applied to a thing that can hurt someone. A head whose
 * profile states no travel limits does not have limits at zero — it has
 * UNKNOWN limits, and an axis with unknown limits does not move to an absolute
 * position. It may still be jogged by hand under someone's thumb, because that
 * person is the limit. The difference is the whole point: a default of 0..0
 * would read as "cannot move", a default of ±180° would read as "go anywhere",
 * and both are inventions.
 *
 * So the validator distinguishes two outcomes that are easy to confuse:
 *
 *   errors    the profile is WRONG — contradictory, malformed, unusable.
 *             It is rejected. Nothing is filled in.
 *   unknowns  the profile is honest about something it does not state.
 *             It is accepted, and the capability it costs is named.
 *
 * `axisCapability` turns the second into an answer a caller can act on
 * instead of a field it has to remember to check.
 *
 * Pure functions — no hardware, no file, no clock. Loading JSON from disk is
 * the caller's job; this module validates whatever it is handed.
 */

/** Rotary axes are stated in degrees, linear axes in millimetres. */
export type AxisKind = 'rotary' | 'linear';

/**
 * Whether a positive command drives the axis the way the geometry expects.
 * `inverted` is the ordinary case of a motor built in the other way round; it
 * is a statement, not a defect.
 */
export type DirectionSense = 'normal' | 'inverted';

export interface AxisTravel {
  /** Inclusive lower end, in the axis unit. */
  min: number;
  /** Inclusive upper end, in the axis unit. */
  max: number;
}

export interface AxisDrive {
  /** Motor turns per axis turn (rotary) or per millimetre (linear). */
  ratio: number;
  /**
   * Tooth module of the gear, in millimetres. 0.8 is the cine and broadcast
   * standard; another value is not wrong, but it is worth stating because a
   * follow-focus built to 0.8 will not mesh with it.
   */
  toothModuleMm?: number;
  /** Pole count of the motor. */
  poles?: number;
}

export interface AxisFeedback {
  /** What reports the position, e.g. `incremental-encoder`, `hall`, `potentiometer`. */
  kind: string;
  /** Counts per axis turn (rotary) or per millimetre (linear). */
  countsPerUnit: number;
  /**
   * Where zero sits, in the axis unit, relative to the feedback's own origin.
   * Absent means the zero point is not established — which is not zero.
   */
  zeroOffset?: number;
}

export interface AxisHoming {
  /** `limit-switch`, `hard-stop`, `index-pulse`, `none` — free text, stated by the profile. */
  method: string;
  /** Which way the axis travels while homing. */
  direction: 'toward-min' | 'toward-max';
  /** Which stop it homes against, when the method uses one. */
  against?: string;
}

export interface AxisBrake {
  /** Stated, not guessed. A profile that says nothing about a brake gets `unknowns`. */
  present: boolean;
  /** Milliseconds to wait after releasing the brake before commanding motion. */
  releaseBeforeMoveMs?: number;
  /** Milliseconds to wait after motion stops before engaging the brake. */
  engageAfterStopMs?: number;
}

export interface AxisCutouts {
  /** Motor current, in amperes, above which the axis shuts off. */
  currentA?: number;
  /** Following error, in the axis unit, above which the axis shuts off. */
  followingError?: number;
  /** Seconds of no command after which the axis shuts off. */
  commandTimeoutS?: number;
}

export interface AxisProfile {
  /** Stable within the profile: `pan`, `tilt`, `lift`, `dolly`. */
  id: string;
  kind: AxisKind;
  /** `degree` for rotary, `mm` for linear. Stated so a mis-filed axis shows. */
  unit: string;
  /** Absent means the travel is NOT KNOWN — see the module comment. */
  travel?: AxisTravel;
  directionSense: DirectionSense;
  drive: AxisDrive;
  /** Absent means the axis reports nothing back. */
  feedback?: AxisFeedback;
  /** Absent means no homing procedure is defined for this axis. */
  homing?: AxisHoming;
  /** Absent means the profile does not say whether a brake exists. */
  brake?: AxisBrake;
  cutouts?: AxisCutouts;
}

export interface DeviceProfile {
  /** Format version. A profile without one cannot be read safely. */
  formatVersion: 1;
  /** Stable id for the device model. */
  id: string;
  manufacturer: string;
  model: string;
  axes: readonly AxisProfile[];
  /** Where the figures come from. A profile without provenance is a guess. */
  source?: string;
}

export interface ProfileCheck {
  /** False means: reject the profile. Do not complete it, do not repair it. */
  ok: boolean;
  /** Contradictions and malformations. Any entry rejects the profile. */
  errors: readonly string[];
  /**
   * What the profile honestly does not state. These do NOT reject it — they
   * cost capability, and `axisCapability` names which.
   */
  unknowns: readonly string[];
}

const UNITS: Record<AxisKind, string> = { rotary: 'degree', linear: 'mm' };

/**
 * Validate a profile as it is loaded.
 *
 * Every problem is collected rather than the first: whoever writes a profile
 * by hand wants the whole list, and a check that stops early makes them run it
 * once per typo.
 */
export function checkProfile(profile: unknown): ProfileCheck {
  const errors: string[] = [];
  const unknowns: string[] = [];

  if (typeof profile !== 'object' || profile === null) {
    return { ok: false, errors: ['profile is not an object'], unknowns: [] };
  }
  const p = profile as Partial<DeviceProfile>;

  if (p.formatVersion !== 1) {
    errors.push(`formatVersion must be 1, got ${JSON.stringify(p.formatVersion)}`);
  }
  for (const field of ['id', 'manufacturer', 'model'] as const) {
    if (typeof p[field] !== 'string' || p[field] === '') errors.push(`${field} is required`);
  }
  if (!p.source) unknowns.push('source: where these figures come from is not stated');

  if (!Array.isArray(p.axes) || p.axes.length === 0) {
    errors.push('axes must be a non-empty array');
    return { ok: false, errors, unknowns };
  }

  const seen = new Set<string>();
  const achsen = p.axes as readonly Partial<AxisProfile>[];
  for (const [i, axis] of achsen.entries()) {
    const where = axis?.id ? `axis ${axis.id}` : `axis at index ${i}`;

    if (typeof axis?.id !== 'string' || axis.id === '') {
      errors.push(`${where}: id is required`);
    } else if (seen.has(axis.id)) {
      errors.push(`${where}: id appears twice — two axes cannot share a name`);
    } else {
      seen.add(axis.id);
    }

    if (axis?.kind !== 'rotary' && axis?.kind !== 'linear') {
      errors.push(`${where}: kind must be 'rotary' or 'linear', got ${JSON.stringify(axis?.kind)}`);
    } else if (axis.unit !== UNITS[axis.kind]) {
      // Not a formality: a rotary axis stated in mm means the profile was
      // copied from a column, and every figure below it is then suspect.
      errors.push(
        `${where}: a ${axis.kind} axis is stated in ${UNITS[axis.kind]}, not ${JSON.stringify(axis.unit)}`,
      );
    }

    if (axis?.directionSense !== 'normal' && axis?.directionSense !== 'inverted') {
      errors.push(
        `${where}: directionSense must be 'normal' or 'inverted', got ${JSON.stringify(axis?.directionSense)}`,
      );
    }

    if (!axis?.drive || !Number.isFinite(axis.drive.ratio) || axis.drive.ratio <= 0) {
      errors.push(`${where}: drive.ratio must be a positive number`);
    }

    if (!axis?.travel) {
      unknowns.push(`${where}: travel limits are not stated — no absolute moves`);
    } else if (!Number.isFinite(axis.travel.min) || !Number.isFinite(axis.travel.max)) {
      errors.push(`${where}: travel.min and travel.max must be numbers`);
    } else if (axis.travel.min >= axis.travel.max) {
      errors.push(
        `${where}: travel.min ${axis.travel.min} is not below travel.max ${axis.travel.max}`,
      );
    }

    if (!axis?.feedback) {
      unknowns.push(`${where}: no feedback — position is commanded, never confirmed`);
    } else if (!Number.isFinite(axis.feedback.countsPerUnit) || axis.feedback.countsPerUnit <= 0) {
      errors.push(`${where}: feedback.countsPerUnit must be a positive number`);
    } else if (axis.feedback.zeroOffset === undefined) {
      unknowns.push(`${where}: feedback zero point is not established`);
    }

    if (!axis?.homing) {
      unknowns.push(`${where}: no homing procedure — the axis cannot establish where it is`);
    } else if (axis.homing.direction !== 'toward-min' && axis.homing.direction !== 'toward-max') {
      errors.push(
        `${where}: homing.direction must be 'toward-min' or 'toward-max', got ${JSON.stringify(axis.homing.direction)}`,
      );
    } else if (axis.travel && axis.homing.method !== 'none' && !axis.homing.against) {
      unknowns.push(`${where}: homing does not name what it homes against`);
    }

    if (!axis?.brake) {
      unknowns.push(`${where}: the profile does not say whether a brake exists`);
    } else if (axis.brake.present && axis.brake.releaseBeforeMoveMs === undefined) {
      // Driving into a closed brake is how a gearbox is destroyed, so an
      // unstated release time is not a detail to fill in with zero.
      errors.push(`${where}: a brake is declared but no release time is given`);
    }

    if (!axis?.cutouts || Object.keys(axis.cutouts).length === 0) {
      unknowns.push(`${where}: no cut-out limits are stated`);
    }
  }

  return { ok: errors.length === 0, errors, unknowns };
}

export interface AxisCapability {
  /** May the axis be commanded to a position? */
  absoluteMove: boolean;
  /** May it be jogged under someone's hand? */
  jog: boolean;
  /** Does it report where it is? */
  positionFeedback: boolean;
  /** Why anything above is false, in the profile's own terms. */
  reasons: readonly string[];
}

/**
 * What a profile actually permits.
 *
 * Absolute motion needs three things stated: where the ends are, where zero is,
 * and how to find zero. Any one missing and the axis may still be jogged — a
 * hand on a control is a limit of a sort — but it is not sent to a number.
 */
export function axisCapability(axis: AxisProfile): AxisCapability {
  const reasons: string[] = [];
  if (!axis.travel) reasons.push('travel limits are not stated');
  if (!axis.feedback) reasons.push('the axis reports no position');
  else if (axis.feedback.zeroOffset === undefined) reasons.push('the zero point is not established');
  if (!axis.homing) reasons.push('no homing procedure is defined');

  return {
    absoluteMove: reasons.length === 0,
    jog: true,
    positionFeedback: axis.feedback !== undefined,
    reasons,
  };
}

/** The axes a profile permits absolute motion on. Often shorter than `axes`. */
export const absoluteAxes = (profile: DeviceProfile): AxisProfile[] =>
  profile.axes.filter((a) => axisCapability(a).absoluteMove);
