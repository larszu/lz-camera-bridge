// Colour science used by the scopes and graticules. All signal values are normalised
// R'G'B' / Y' in 0..1 where 0 = black level and 1 = nominal peak (100 %).

export type Colorspace = '709' | '2020' | '601';
export type Transfer = 'sdr' | 'pq' | 'hlg';

/** Luma coefficients Kr, Kb (ITU-R BT.601 / BT.709 / BT.2020). */
export const LUMA: Record<Colorspace, { kr: number; kb: number }> = {
  '601': { kr: 0.299, kb: 0.114 },
  '709': { kr: 0.2126, kb: 0.0722 },
  '2020': { kr: 0.2627, kb: 0.0593 },
};

export type XY = [number, number];
export interface Gamut { name: string; r: XY; g: XY; b: XY; white: XY }

export const D65: XY = [0.3127, 0.329];
export const GAMUTS: Record<'709' | 'p3' | '2020' | '601', Gamut> = {
  '709': { name: 'Rec.709', r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: D65 },
  p3: { name: 'P3-D65', r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: D65 },
  '2020': { name: 'Rec.2020', r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], white: D65 },
  '601': { name: 'SMPTE-C', r: [0.63, 0.34], g: [0.31, 0.595], b: [0.155, 0.07], white: D65 },
};

export function ycbcr(r: number, g: number, b: number, cs: Colorspace) {
  const { kr, kb } = LUMA[cs];
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  return { y, cb: (b - y) / (2 * (1 - kb)), cr: (r - y) / (2 * (1 - kr)) };
}

/** Row-major 3×3 RGB(linear) → XYZ matrix for a set of primaries. */
export function rgbToXyzMatrix(g: Gamut): number[] {
  const col = ([x, y]: XY) => [x / y, 1, (1 - x - y) / y];
  const R = col(g.r), G = col(g.g), B = col(g.b), W = col(g.white);
  const m = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const s = mul3(inv3(m), W);
  return [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
}

function mul3(m: number[], v: number[]) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

function inv3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// SMPTE ST 2084 (PQ)
const M1 = 2610 / 16384, M2 = (2523 / 4096) * 128, C1 = 3424 / 4096, C2 = (2413 / 4096) * 32, C3 = (2392 / 4096) * 32;
export function pqEncode(nits: number) {
  const y = Math.max(0, nits) / 10000, p = Math.pow(y, M1);
  return Math.pow((C1 + C2 * p) / (1 + C3 * p), M2);
}
export function pqDecode(signal: number) {
  const p = Math.pow(Math.max(0, signal), 1 / M2);
  return 10000 * Math.pow(Math.max(0, p - C1) / (C2 - C3 * p), 1 / M1);
}

// ARIB STD-B67 / BT.2100 HLG
const HA = 0.17883277, HB = 1 - 4 * HA, HC = 0.5 - HA * Math.log(4 * HA);
export function hlgOetf(e: number) {
  return e <= 1 / 12 ? Math.sqrt(3 * Math.max(0, e)) : HA * Math.log(12 * e - HB) + HC;
}
export function hlgInverseOetf(v: number) {
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HC) / HA) + HB) / 12;
}
/** Approximate displayed luminance of an HLG signal on a 1000 cd/m² display (system gamma 1.2, achromatic). */
export function hlgNits(v: number) { return 1000 * Math.pow(hlgInverseOetf(v), 1.2); }
export function hlgFromNits(n: number) { return hlgOetf(Math.pow(Math.max(0, n) / 1000, 1 / 1.2)); }

/** SDR per BT.1886 with a 100 cd/m² reference white. */
export function sdrNits(v: number) { return 100 * Math.pow(Math.max(0, v), 2.4); }
export function sdrFromNits(n: number) { return Math.pow(Math.max(0, n) / 100, 1 / 2.4); }

export function signalToNits(v: number, t: Transfer) {
  return t === 'pq' ? pqDecode(v) : t === 'hlg' ? hlgNits(v) : sdrNits(v);
}
export function nitsToSignal(n: number, t: Transfer) {
  return t === 'pq' ? pqEncode(n) : t === 'hlg' ? hlgFromNits(n) : sdrFromNits(n);
}

/** Map ffprobe colour metadata to our settings. */
export function detectTransfer(ffTransfer?: string): Transfer {
  if (ffTransfer === 'smpte2084') return 'pq';
  if (ffTransfer === 'arib-std-b67') return 'hlg';
  return 'sdr';
}
export function detectColorspace(matrix?: string, primaries?: string, height = 1080): Colorspace {
  if (matrix?.startsWith('bt2020') || primaries === 'bt2020') return '2020';
  if (matrix === 'bt709' || primaries === 'bt709') return '709';
  if (matrix === 'bt601' || matrix === 'smpte170m' || matrix === 'bt470bg' || primaries === 'smpte170m' || primaries === 'bt470bg') return '601';
  return height > 576 ? '709' : '601';
}

/** Legal-range code value for a normalised signal level (0 % = 16/64, 100 % = 235/940). */
export function codeValue(level: number, bits: 8 | 10) {
  return bits === 8 ? 16 + level * 219 : 64 + level * 876;
}

/** Vectorscope targets for 75 % and 100 % colour bars. */
export const BAR_COLORS: { label: string; rgb: [number, number, number] }[] = [
  { label: 'R', rgb: [1, 0, 0] }, { label: 'Mg', rgb: [1, 0, 1] }, { label: 'B', rgb: [0, 0, 1] },
  { label: 'Cy', rgb: [0, 1, 1] }, { label: 'G', rgb: [0, 1, 0] }, { label: 'Yl', rgb: [1, 1, 0] },
];
export function barTargets(cs: Colorspace, level: number) {
  return BAR_COLORS.map(({ label, rgb }) => {
    const { cb, cr } = ycbcr(rgb[0] * level, rgb[1] * level, rgb[2] * level, cs);
    return { label, cb, cr };
  });
}

/** Skin-tone ("I") line angle, measured counter-clockwise from +Cb. */
export const SKIN_LINE_DEG = 123;

/** CIE 1931 2° spectral locus (x, y), 380–700 nm. */
export const SPECTRAL_LOCUS: [number, number, number][] = [
  [380, 0.1741, 0.005], [400, 0.1733, 0.0048], [420, 0.1714, 0.0051], [430, 0.1689, 0.0069],
  [440, 0.1644, 0.0109], [450, 0.1566, 0.0177], [460, 0.144, 0.0297], [470, 0.1241, 0.0578],
  [475, 0.1096, 0.0868], [480, 0.0913, 0.1327], [485, 0.0687, 0.2007], [490, 0.0454, 0.295],
  [495, 0.0235, 0.4127], [500, 0.0082, 0.5384], [505, 0.0039, 0.6548], [510, 0.0139, 0.7502],
  [515, 0.0389, 0.812], [520, 0.0743, 0.8338], [525, 0.1142, 0.8262], [530, 0.1547, 0.8059],
  [540, 0.2296, 0.7543], [550, 0.3016, 0.6923], [560, 0.3731, 0.6245], [570, 0.4441, 0.5547],
  [580, 0.5125, 0.4866], [590, 0.5752, 0.4242], [600, 0.627, 0.3725], [610, 0.6658, 0.334],
  [620, 0.6915, 0.3083], [630, 0.7079, 0.292], [640, 0.719, 0.2809], [650, 0.726, 0.274],
  [660, 0.73, 0.27], [680, 0.7334, 0.2666], [700, 0.7347, 0.2653],
];

export interface FalseColorBand { from: number; to: number; color: string; label: string }
/** Signal-level bands in % (ARRI-style exposure false colour). Everything else shows as greyscale. */
export const FALSE_COLOR_PRESETS: Record<string, FalseColorBand[]> = {
  ARRI: [
    { from: 0, to: 2.5, color: '#8a2be2', label: 'Schwarz-Clip' },
    { from: 2.5, to: 4, color: '#1e5bff', label: 'knapp über Schwarz' },
    { from: 38, to: 42, color: '#22c55e', label: '18 % Grau' },
    { from: 52, to: 56, color: '#ff6ec7', label: 'Grau +1 Blende' },
    { from: 97, to: 99, color: '#ffd400', label: 'knapp unter Weiß' },
    { from: 99, to: 100.01, color: '#ff1f1f', label: 'Weiß-Clip' },
  ],
  Belichtung: [
    { from: 0, to: 5, color: '#6a0dad', label: 'abgesoffen' },
    { from: 5, to: 20, color: '#1e3a8a', label: 'Schatten' },
    { from: 40, to: 50, color: '#16a34a', label: 'Mittelton' },
    { from: 55, to: 70, color: '#f472b6', label: 'Hautton' },
    { from: 90, to: 97, color: '#facc15', label: 'Lichter' },
    { from: 97, to: 100.01, color: '#dc2626', label: 'Clip' },
  ],
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
