/**
 * The twelve pictures of the Vissonic VIS-CATC.
 *
 * Source: the device's own page (VIS-CATC.html). Each layout has a
 * `pvWindow<n>` with one `div` per window; size and position are partly
 * inline style, partly a CSS rule (`#pvWindow1 div { float:left; width:50%;
 * height:50% }`).
 *
 * `mode` is the number in the command (`param=mode<n>`, `<#Splice_mode<n>>`)
 * and 0-based; the device's buttons count from 1 (`label`).
 *
 * The window number is the `data` attribute and therefore the `w` in
 * `<q>V<w>`. It does NOT follow reading order: in layout 5 (mode 4) window 1
 * is the SMALL picture and window 2 the big one; in 6..9 it is the other way
 * round. `mainWindow()` answers "which window is the programme" from the
 * geometry, so nobody has to remember that.
 *
 * `packages/web-rcp/src/lib/layouts.ts` carries the same table for the
 * picker; `test/layouts.test.ts` keeps both copies identical.
 */

export interface LayoutWindow {
  /** Window number as the device expects it (`data` attribute). */
  number: number;
  /** Position and size in percent of the output. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SwitcherLayout {
  /** Number in the command, 0-based. */
  mode: number;
  /** Label as on the device page, 1-based. */
  label: string;
  name: string;
  windows: LayoutWindow[];
}

const T = 100 / 3;

export const SWITCHER_LAYOUTS: SwitcherLayout[] = [
  { mode: 0, label: '1', name: 'Full screen', windows: [{ number: 1, x: 0, y: 0, width: 100, height: 100 }] },
  {
    mode: 1, label: '2', name: 'Four equal',
    windows: [
      { number: 1, x: 0, y: 0, width: 50, height: 50 },
      { number: 2, x: 50, y: 0, width: 50, height: 50 },
      { number: 3, x: 0, y: 50, width: 50, height: 50 },
      { number: 4, x: 50, y: 50, width: 50, height: 50 },
    ],
  },
  {
    mode: 2, label: '3', name: 'Two columns',
    windows: [
      { number: 1, x: 0, y: 0, width: 50, height: 100 },
      { number: 2, x: 50, y: 0, width: 50, height: 100 },
    ],
  },
  {
    mode: 3, label: '4', name: 'Two rows',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 50 },
      { number: 2, x: 0, y: 50, width: 100, height: 50 },
    ],
  },
  {
    mode: 4, label: '5', name: 'Picture in picture, top left',
    // Here window 1 is the SMALL picture — unlike 6..9.
    windows: [
      { number: 2, x: 0, y: 0, width: 100, height: 100 },
      { number: 1, x: 0, y: 0, width: 50, height: 50 },
    ],
  },
  {
    mode: 5, label: '6', name: 'Picture in picture, top right',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 100 },
      { number: 2, x: 50, y: 0, width: 50, height: 50 },
    ],
  },
  {
    mode: 6, label: '7', name: 'Picture in picture, bottom left',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 100 },
      { number: 2, x: 0, y: 50, width: 50, height: 50 },
    ],
  },
  {
    mode: 7, label: '8', name: 'Picture in picture, bottom right',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 100 },
      { number: 2, x: 50, y: 50, width: 50, height: 50 },
    ],
  },
  {
    mode: 8, label: '9', name: 'Picture in picture, centre',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 100 },
      { number: 2, x: 25, y: 25, width: 50, height: 50 },
    ],
  },
  {
    mode: 9, label: '10', name: 'Large top, three below',
    windows: [
      { number: 1, x: 0, y: 0, width: 100, height: 2 * T },
      { number: 2, x: 0, y: 2 * T, width: T, height: T },
      { number: 3, x: T, y: 2 * T, width: T, height: T },
      { number: 4, x: 2 * T, y: 2 * T, width: T, height: T },
    ],
  },
  {
    mode: 10, label: '11', name: 'Three top, large below',
    windows: [
      { number: 1, x: 0, y: 0, width: T, height: T },
      { number: 2, x: T, y: 0, width: T, height: T },
      { number: 3, x: 2 * T, y: 0, width: T, height: T },
      { number: 4, x: 0, y: T, width: 100, height: 2 * T },
    ],
  },
  {
    mode: 11, label: '12', name: 'Large left, three right',
    windows: [
      { number: 1, x: 0, y: 0, width: 2 * T, height: 100 },
      { number: 2, x: 2 * T, y: 0, width: T, height: T },
      { number: 3, x: 2 * T, y: T, width: T, height: T },
      { number: 4, x: 2 * T, y: 2 * T, width: T, height: T },
    ],
  },
];

export function layoutByMode(mode: number): SwitcherLayout | undefined {
  return SWITCHER_LAYOUTS.find((l) => l.mode === mode);
}

/** Window numbers of a layout, ascending. */
export function windowNumbers(mode: number): number[] {
  const layout = layoutByMode(mode);
  if (!layout) return [];
  return [...new Set(layout.windows.map((w) => w.number))].sort((a, b) => a - b);
}

export function isFullscreenLayout(mode: number): boolean {
  return layoutByMode(mode)?.windows.length === 1;
}

export function fullscreenMode(): number {
  return SWITCHER_LAYOUTS.find((l) => l.windows.length === 1)?.mode ?? 0;
}

/**
 * The window with the largest area — in picture-in-picture the main picture,
 * not the inset. That window is the programme.
 */
export function mainWindow(mode: number): number {
  const layout = layoutByMode(mode);
  if (!layout || layout.windows.length === 0) return 1;
  return layout.windows.reduce((largest, w) =>
    w.width * w.height > largest.width * largest.height ? w : largest,
  ).number;
}
