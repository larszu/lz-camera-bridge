/**
 * Field of view, measured: pan the head by a small known angle, see how far
 * the picture moved.
 *
 * A pan of Δ moves the scene sideways by f·tan(Δ) pixels, with
 * f = (W/2) / tan(hfov/2). Two pictures, one shift, one unknown:
 *
 *   hfov = 2 · atan( (W/2) · tan(Δ) / shift )
 *
 * The shift is found without feature tracking: every picture is boiled down
 * to its column profile (mean brightness per column, high-passed so that a
 * lighting gradient does not count as structure), and the second profile is
 * slid against the first until the normalised cross-correlation peaks. A pan
 * moves whole columns, so a 1-D search is the right one — and it needs
 * texture across the picture, not corners. A blank wall gives a flat
 * correlation, and then the measurement is refused instead of guessed.
 *
 * Off the horizon a pan moves the picture less: the factor is cos(tilt) for
 * small steps, applied to Δ. Calibrate near tilt 0 anyway.
 *
 * Pure functions: no network, no clock.
 */
import type { RgbImage } from './stitch.js';

const RAD = Math.PI / 180;

/** Mean brightness per column, minus its moving average (window ≈ W/12). */
export function columnProfile(img: RgbImage): Float64Array {
  const { width, height, data } = img;
  const raw = new Float64Array(width);
  // The middle 80 % of the rows: the top and bottom edge often carry an OSD or a vignette.
  const y0 = Math.floor(height * 0.1);
  const y1 = Math.max(y0 + 1, Math.ceil(height * 0.9));
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[x] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  const win = Math.max(3, Math.round(width / 12));
  const out = new Float64Array(width);
  let sum = 0;
  const pre: number[] = [0];
  for (let x = 0; x < width; x++) pre.push((sum += raw[x]));
  for (let x = 0; x < width; x++) {
    const a = Math.max(0, x - win);
    const b = Math.min(width, x + win + 1);
    out[x] = raw[x] / (y1 - y0) - (pre[b] - pre[a]) / (b - a) / (y1 - y0);
  }
  return out;
}

/**
 * How many pixels the content of `b` sits to the LEFT of where it was in `a`
 * (b(x) ≈ a(x + shift)); a pan to the right gives a positive shift.
 *
 * Only the middle 40 % of `b` is matched: a pan shifts the picture edges more
 * than its centre (perspective, f·tan), and the centre column is the one the
 * formula in `hfovFromShift` is exact for. Null when the correlation is too
 * weak to trust.
 */
export function measureShift(a: RgbImage, b: RgbImage, maxFraction = 0.45, minScore = 0.6): { shift: number; score: number } | null {
  if (a.width !== b.width) return null;
  const pa = columnProfile(a);
  const pb = columnProfile(b);
  const n = pa.length;
  const maxShift = Math.floor(n * maxFraction);
  const c0 = Math.floor(n * 0.3);
  const c1 = Math.ceil(n * 0.7);
  const score = (s: number): number => {
    // the part of b's middle whose partner x + s is inside a
    const from = Math.max(c0, -s);
    const to = Math.min(c1, n - s);
    if (to - from < (c1 - c0) * 0.6) return -1;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    let ma = 0;
    let mb = 0;
    for (let x = from; x < to; x++) { ma += pa[x + s]; mb += pb[x]; }
    ma /= to - from;
    mb /= to - from;
    for (let x = from; x < to; x++) {
      const da = pa[x + s] - ma;
      const db = pb[x] - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1;
  };
  let best = 0;
  let bestScore = -Infinity;
  const scores = new Map<number, number>();
  for (let s = -maxShift; s <= maxShift; s++) {
    const v = score(s);
    scores.set(s, v);
    if (v > bestScore) { bestScore = v; best = s; }
  }
  if (bestScore < minScore) return null;
  // Sub-pixel: parabola through the peak and its neighbours.
  const l = scores.get(best - 1);
  const r = scores.get(best + 1);
  let shift = best;
  if (l !== undefined && r !== undefined) {
    const d = l - 2 * bestScore + r;
    if (d < 0) shift = best + (0.5 * (l - r)) / d;
  }
  return { shift, score: Math.round(bestScore * 1000) / 1000 };
}

/** The field of view a measured shift implies. */
export function hfovFromShift(shiftPx: number, widthPx: number, panStepDeg: number, tiltDeg = 0): number | null {
  const step = Math.abs(panStepDeg) * Math.cos(tiltDeg * RAD);
  const s = Math.abs(shiftPx);
  if (!(s > 0.5) || !(step > 0)) return null;
  return Math.round(((2 * Math.atan(((widthPx / 2) * Math.tan(step * RAD)) / s)) / RAD) * 100) / 100;
}

/**
 * The pan step for a measurement at a zoom whose field of view is about
 * `guessDeg`: 12 % of the picture, so that the shift is clear but the
 * overlap stays large even when the guess is off by a factor of three.
 */
export function calibrationStep(guessDeg: number): number {
  return Math.round(Math.min(8, Math.max(0.3, guessDeg * 0.12)) * 100) / 100;
}
