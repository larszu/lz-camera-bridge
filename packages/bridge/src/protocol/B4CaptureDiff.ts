/**
 * Comparing B4 lens captures — which command code carries which function.
 *
 * The method, from docs/b4/umsetzungsplan.pdf section 6.3: record the idle
 * bus, then trigger exactly ONE action at a time (only the zoom rocker, only
 * focus, only iris, only the extender), and compare the recordings. A code
 * that appears only while the zoom moves is the zoom code. A data field that
 * rises monotonically while the ring turns one way is that action's value.
 *
 * ── Why this is a module and not a pair of eyes ───────────────────────────
 * Comparing many recordings by hand is the part a script does better than a
 * person, and the upstream plan says so. It is also the only honest way to
 * settle the command-code conflict in the source: the main table says 0x20
 * iris / 0x21 zoom / 0x22 focus, a later prose section says 0x21 / 0x23 /
 * 0x22. Trying codes on a four- to five-figure lens to find out is not an
 * experiment, it is a gamble. The camera polls the lens anyway; let it tell us.
 *
 * Works on stored recordings — no lens, no serial port, no hardware.
 */

import { B4FrameDecoder, type B4Frame } from './B4Lens.js';

/**
 * One recording.
 *
 * `operated` is the point of the whole exercise: a capture whose notes are
 * missing cannot be compared against anything, because nobody knows what was
 * different about it. It is machine readable and not hidden in the file name.
 */
export interface B4Capture {
  label: string;
  /** What was operated during the recording. Empty array means idle. */
  operated: readonly string[];
  frames: readonly B4Frame[];
}

/** Build a capture from raw received bytes. Invalid frames are dropped as usual. */
export function captureFromBytes(label: string, operated: readonly string[], bytes: Uint8Array): B4Capture {
  const decoder = new B4FrameDecoder();
  return { label, operated, frames: decoder.push(bytes) };
}

/** How a code's payload behaved across a capture. */
export interface CodeBehaviour {
  cmd: number;
  /** How many frames carried this code. */
  count: number;
  /** Payload length, or null when it varied between frames. */
  dataLen: number | null;
  /**
   * Per byte offset: does the value move in one direction only?
   *
   * A monotonic byte that spans a wide range while exactly one control was
   * operated is the strongest evidence this module can produce.
   */
  monotonic: readonly MonotonicField[];
}

export interface MonotonicField {
  /** Byte offset inside the payload; for a 16-bit read, the high byte. */
  offset: number;
  width: 1 | 2;
  direction: 'rising' | 'falling';
  min: number;
  max: number;
  /** max - min. A field that barely moves proves little. */
  span: number;
}

const readAt = (data: Uint8Array, offset: number, width: 1 | 2): number | null => {
  if (offset + width > data.length) return null;
  return width === 1 ? data[offset]! : (data[offset]! << 8) | data[offset + 1]!;
};

/**
 * Is the series monotonic, ignoring repeats?
 *
 * Repeats are ignored because the camera polls faster than a hand turns a
 * ring: a value that holds for three frames and then rises is still rising.
 * A single step the other way, however, is not — that would make almost
 * anything look monotonic, and a false lead costs a measuring session.
 */
const monotonicDirection = (series: readonly number[]): 'rising' | 'falling' | null => {
  let sawUp = false;
  let sawDown = false;
  for (let i = 1; i < series.length; i += 1) {
    const d = series[i]! - series[i - 1]!;
    if (d > 0) sawUp = true;
    else if (d < 0) sawDown = true;
    if (sawUp && sawDown) return null;
  }
  if (sawUp) return 'rising';
  if (sawDown) return 'falling';
  return null; // flat: no information
};

/** Group a capture's frames by command code and describe each code's payload. */
export function behaviourByCode(capture: B4Capture): Map<number, CodeBehaviour> {
  const byCode = new Map<number, B4Frame[]>();
  for (const f of capture.frames) {
    const list = byCode.get(f.cmd);
    if (list) list.push(f);
    else byCode.set(f.cmd, [f]);
  }

  const out = new Map<number, CodeBehaviour>();
  for (const [cmd, frames] of byCode) {
    const lengths = new Set(frames.map((f) => f.data.length));
    const dataLen = lengths.size === 1 ? [...lengths][0]! : null;

    const monotonic: MonotonicField[] = [];
    if (dataLen !== null && frames.length >= 2) {
      for (const width of [2, 1] as const) {
        for (let offset = 0; offset + width <= dataLen; offset += 1) {
          const series = frames
            .map((f) => readAt(f.data, offset, width))
            .filter((v): v is number => v !== null);
          if (series.length < 2) continue;

          const direction = monotonicDirection(series);
          if (!direction) continue;

          const min = Math.min(...series);
          const max = Math.max(...series);
          monotonic.push({ offset, width, direction, min, max, span: max - min });
        }
      }
      // Widest movement first: that is the field most likely to be the value.
      monotonic.sort((a, b) => b.span - a.span);
    }

    out.set(cmd, { cmd, count: frames.length, dataLen, monotonic });
  }
  return out;
}

export interface CaptureDiff {
  /** Codes present in `after` but not in `before`. */
  newCodes: readonly number[];
  /** Codes present in `before` but not in `after`. */
  goneCodes: readonly number[];
  /** Codes in both, with what moved in `after`. */
  changed: readonly CodeBehaviour[];
  /**
   * Behaviour of the codes that are new in `after`.
   *
   * Kept separate from `changed` because the two are different kinds of
   * evidence: a code that appears only while the zoom moves is a stronger
   * claim than one that was already there and started moving.
   */
  newBehaviour: readonly CodeBehaviour[];
  /** What was operated in `after` and not in `before`. */
  operatedDelta: readonly string[];
}

/**
 * Compare two captures.
 *
 * The intended use is idle-vs-one-action: `before` recorded with nothing
 * touched, `after` with exactly one control operated. Then `newCodes` plus the
 * widest monotonic field in `changed` names that control's command code.
 */
export function diffCaptures(before: B4Capture, after: B4Capture): CaptureDiff {
  const b = behaviourByCode(before);
  const a = behaviourByCode(after);

  const newCodes = [...a.keys()].filter((c) => !b.has(c)).sort((x, y) => x - y);
  const goneCodes = [...b.keys()].filter((c) => !a.has(c)).sort((x, y) => x - y);

  const bySpan = (x: CodeBehaviour, y: CodeBehaviour): number =>
    (y.monotonic[0]?.span ?? 0) - (x.monotonic[0]?.span ?? 0);

  const changed = [...a.values()].filter((beh) => b.has(beh.cmd) && beh.monotonic.length > 0).sort(bySpan);
  const newBehaviour = newCodes.map((c) => a.get(c)!).sort(bySpan);

  const beforeOps = new Set(before.operated);
  const operatedDelta = after.operated.filter((op) => !beforeOps.has(op));

  return { newCodes, goneCodes, changed, newBehaviour, operatedDelta };
}

/**
 * The strongest single claim a comparison can make, or null.
 *
 * Deliberately conservative. A candidate only counts when exactly one control
 * was operated and exactly one code carries a field that moved — anything
 * else is a hint for a person, not an assignment. `minSpan` exists because a
 * field that wobbles by three counts proves nothing; the default asks for a
 * movement a hand could plausibly have caused.
 *
 * New codes and already-present codes are both considered: a control can
 * announce itself either by a code appearing or by a code starting to move.
 * `evidence` says which of the two it was, because they are not equally
 * strong and the person reading the result should see the difference.
 */
export function candidateAssignment(
  diff: CaptureDiff,
  minSpan = 64,
): { control: string; cmd: number; field: MonotonicField; evidence: 'new-code' | 'moved' } | null {
  if (diff.operatedDelta.length !== 1) return null;

  const big = (c: CodeBehaviour): boolean => (c.monotonic[0]?.span ?? 0) >= minSpan;
  const fresh = diff.newBehaviour.filter(big);
  const moved = diff.changed.filter(big);

  const total = fresh.length + moved.length;
  if (total !== 1) return null;

  const winner = fresh[0] ?? moved[0]!;
  return {
    control: diff.operatedDelta[0]!,
    cmd: winner.cmd,
    field: winner.monotonic[0]!,
    evidence: fresh.length === 1 ? 'new-code' : 'moved',
  };
}
