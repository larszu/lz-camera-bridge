/**
 * PGM/PVW bus logic in the manner of a Blackmagic ATEM panel, carried over to
 * a switcher with one output.
 *
 * An ATEM has two buses: PGM is what goes out, PVW the pre-selection, CUT
 * swaps them. The VIS-CATC only knows the one output, so the preview bus
 * lives in the BRIDGE (not in a browser tab): a source on PVW sends no
 * device command, only CUT puts it out. Because the bridge holds it, every
 * client — the panel, a second window, Companion — sees the same preview.
 * (In the predecessor application each window kept its own preview and the
 * multiviewer window reset the panel's on opening.)
 *
 * The device has no soft transition. The manual promises a switch "without
 * flashing or black screen", so a clean hard cut; there is no AUTO.
 */

export interface BusState {
  /** Source on the output. 0 = unknown. */
  program: number;
  /** Pre-selected source. 0 = none. */
  preview: number;
}

export interface CutResult {
  state: BusState;
  /** Source that has to be switched now. 0 = nothing to do. */
  switchTo: number;
}

/** CUT: preview goes out, the previous programme becomes the preview. Without a preview nothing happens. */
export function cut(state: BusState): CutResult {
  if (state.preview === 0 || state.preview === state.program) return { state, switchTo: 0 };
  return { state: { program: state.preview, preview: state.program }, switchTo: state.preview };
}

/** Source straight onto the output (PGM bus, hard cut). */
export function takeProgram(state: BusState, source: number): CutResult {
  if (source === state.program) return { state, switchTo: 0 };
  return { state: { program: source, preview: state.preview }, switchTo: source };
}

/** Pre-select. No device command. */
export function selectPreview(state: BusState, source: number): BusState {
  return { program: state.program, preview: source };
}

export type SourceTally = 'program' | 'preview' | 'off';

/** Tally of a source: red before green, as on the panel. */
export function tallyFor(state: BusState, source: number): SourceTally {
  if (source <= 0) return 'off';
  if (state.program === source) return 'program';
  if (state.preview === source) return 'preview';
  return 'off';
}

/**
 * Keyboard in the manner of a panel:
 *   1..9            source to preview
 *   Shift + 1..9    source straight to programme
 *   Enter / Space   CUT
 *
 * Takes `event.code`, not `event.key`: with Shift held, `key` is `!`, `"`
 * or `§` depending on the keyboard layout and the digit never matches. That
 * was a real defect in the predecessor — "Shift + 1..6 switches at once"
 * stood in its README and could never fire.
 */
export type KeyAction =
  | { kind: 'preview'; source: number }
  | { kind: 'program'; source: number }
  | { kind: 'cut' }
  | null;

export function keyToAction(code: string, shift: boolean, sourceCount: number): KeyAction {
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') return { kind: 'cut' };
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (!digit) return null;
  const source = Number.parseInt(digit[1], 10);
  if (source > sourceCount) return null;
  return shift ? { kind: 'program', source } : { kind: 'preview', source };
}
