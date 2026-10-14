/**
 * Panorama map — scan plan and stitching, pose-based.
 *
 * The head steps through a pan/tilt grid at one zoom position and takes a
 * picture at every stop. Because every picture's pan, tilt and field of view
 * are known, no feature matching is needed to place it: every pixel of the
 * equirectangular map is a direction (pan, tilt), and that direction lands at
 * a known point of every picture that saw it (`pixelOfDirection`). Where
 * pictures overlap they are blended with a feather weight that falls to zero
 * at the picture edge, so the seams fade instead of cutting.
 *
 * LIMITS, said once here: the map is a still (people move), parallax shows on
 * near objects because the pan axis is not the lens's nodal point, and the
 * head's own pose accuracy is the placement accuracy. Feature refinement can
 * come later on top of this; the placement it would refine is already right
 * to within the head's repeatability.
 *
 * Pure functions on RGB buffers: no network, no files, no clock.
 */
import { pixelOfDirection, dirOf, vfovOf, type MapExtent } from '../protocol/frameAim.js';

export interface ScanOptions extends MapExtent {
  /** Horizontal field of view at the scan zoom. */
  hfovDeg: number;
  /** Picture aspect, width / height. */
  aspect: number;
  /** Overlap between neighbouring pictures, 0..0.8. */
  overlap: number;
}

export interface RgbImage {
  width: number;
  height: number;
  /** rgb24, row by row. */
  data: Uint8Array;
}

export interface Tile {
  pan: number;
  tilt: number;
  hfovDeg: number;
  image: RgbImage;
}

export const MAX_SCAN_STOPS = 200;

/** Stop centres along one axis so that pictures of size `fov` cover min..max with the overlap. */
function stops(min: number, max: number, fov: number, overlap: number): number[] {
  const span = max - min;
  if (span <= fov) return [round1((min + max) / 2)];
  const step = fov * (1 - overlap);
  const n = Math.ceil((span - fov) / step) + 1;
  const first = min + fov / 2;
  const last = max - fov / 2;
  return Array.from({ length: n }, (_, i) => round1(first + ((last - first) * i) / (n - 1)));
}

/**
 * The grid, row by row from the top, every second row backwards (serpentine)
 * so that the head never swings back across the whole range between rows.
 */
export function planScan(o: ScanOptions): { pan: number; tilt: number }[] | string {
  if (!(o.panMax > o.panMin) || !(o.tiltMax > o.tiltMin)) return 'The scan range is empty';
  if (!(o.hfovDeg > 0) || !(o.aspect > 0)) return 'The field of view at the scan zoom is unknown';
  const overlap = Math.min(0.8, Math.max(0, o.overlap));
  const vfov = vfovOf(o.hfovDeg, o.aspect);
  const tilts = stops(o.tiltMin, o.tiltMax, vfov, overlap).reverse();
  const out: { pan: number; tilt: number }[] = [];
  tilts.forEach((tilt, row) => {
    // Away from the horizon a picture covers more pan; fewer stops are needed there.
    // Measured at the picture's edge nearest the horizon, so the overlap holds there too.
    const nearest = Math.max(0, Math.abs(tilt) - vfov / 2);
    const widen = 1 / Math.max(0.3, Math.cos((nearest * Math.PI) / 180));
    const pans = stops(o.panMin, o.panMax, Math.min(o.hfovDeg * widen, 360), overlap);
    for (const pan of row % 2 ? [...pans].reverse() : pans) out.push({ pan, tilt });
  });
  if (out.length > MAX_SCAN_STOPS) return `The scan would take ${out.length} pictures (at most ${MAX_SCAN_STOPS}). Zoom wider, narrow the range or lower the overlap.`;
  return out;
}

/**
 * Map resolution: the pictures' own resolution where the map stays below
 * 4096 × 2048, otherwise as much as fits.
 */
export function mapSize(extent: MapExtent, tileWidth: number, hfovDeg: number): { width: number; height: number; pxPerDeg: number } {
  const span = extent.panMax - extent.panMin;
  const tspan = extent.tiltMax - extent.tiltMin;
  const pxPerDeg = Math.max(1, Math.min(tileWidth / hfovDeg, 4096 / span, 2048 / tspan));
  return { width: Math.max(2, Math.round(span * pxPerDeg)), height: Math.max(2, Math.round(tspan * pxPerDeg)), pxPerDeg };
}

/** Grey for the parts of the map no picture covered. */
const EMPTY = 32;

export function stitch(tiles: Tile[], extent: MapExtent, width: number, height: number): RgbImage {
  const out = new Uint8Array(width * height * 3).fill(EMPTY);
  const span = extent.panMax - extent.panMin;
  const tspan = extent.tiltMax - extent.tiltMin;
  const acc = new Float32Array(3);
  const prepared = tiles.map((t) => ({
    ...t,
    aspect: t.image.width / t.image.height,
    // Generous cull radius: half the diagonal of the picture, plus margin.
    reach: Math.hypot(t.hfovDeg, vfovOf(t.hfovDeg, t.image.width / t.image.height)) / 2 + 2,
  }));
  for (let y = 0; y < height; y++) {
    const tilt = extent.tiltMax - ((y + 0.5) / height) * tspan;
    const rowTiles = prepared.filter((t) => Math.abs(t.tilt - tilt) <= t.reach);
    for (let x = 0; x < width; x++) {
      const pan = extent.panMin + ((x + 0.5) / width) * span;
      const dir = dirOf(pan, tilt);
      acc[0] = acc[1] = acc[2] = 0;
      let wsum = 0;
      for (const t of rowTiles) {
        const p = pixelOfDirection(dir, t.aspect, t.hfovDeg, t);
        if (!p || p.u <= 0 || p.u >= 1 || p.v <= 0 || p.v >= 1) continue;
        // Feather: 0 at the edge, 1 from 15 % inside. Squared for a smoother seam.
        const e = Math.min(1, Math.min(p.u, 1 - p.u, p.v, 1 - p.v) / 0.15);
        const w = e * e + 1e-6;
        sample(t.image, p.u, p.v, acc, w);
        wsum += w;
      }
      if (wsum > 0) {
        const o = (y * width + x) * 3;
        out[o] = acc[0] / wsum;
        out[o + 1] = acc[1] / wsum;
        out[o + 2] = acc[2] / wsum;
      }
    }
  }
  return { width, height, data: out };
}

/** Bilinear sample at (u, v) ∈ (0, 1), added to `acc` with weight `w`. */
function sample(img: RgbImage, u: number, v: number, acc: Float32Array, w: number): void {
  const fx = u * img.width - 0.5;
  const fy = v * img.height - 0.5;
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(fy)));
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const ax = Math.min(1, Math.max(0, fx - x0));
  const ay = Math.min(1, Math.max(0, fy - y0));
  const d = img.data;
  const i00 = (y0 * img.width + x0) * 3;
  const i10 = (y0 * img.width + x1) * 3;
  const i01 = (y1 * img.width + x0) * 3;
  const i11 = (y1 * img.width + x1) * 3;
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * ax;
    const bottom = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * ax;
    acc[c] += (top + (bottom - top) * ay) * w;
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
