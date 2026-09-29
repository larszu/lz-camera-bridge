// 2D overlays per panel: graticules, labels, histogram, statistics, probe read-outs.

import {
  GAMUTS, SKIN_LINE_DEG, SPECTRAL_LOCUS, barTargets, codeValue, nitsToSignal, signalToNits, ycbcr,
  type Colorspace, type Transfer,
} from './color';
import { CIE_VIEW, WAVE_MAX, WAVE_MIN, type Rect } from './renderer';
import type { Source } from './sources';

export type ScopeType = 'picture' | 'wf-luma' | 'wf-rgb' | 'parade' | 'yrgb' | 'ycbcr' | 'vector' | 'cie' | 'hist' | 'stats';
export type Unit = 'percent' | 'bit8' | 'bit10' | 'nits';

export const SCOPE_LABELS: Record<ScopeType, string> = {
  picture: 'Bild', 'wf-luma': 'Waveform Luma', 'wf-rgb': 'Waveform RGB', parade: 'RGB-Parade', yrgb: 'YRGB-Parade',
  ycbcr: 'YCbCr-Parade', vector: 'Vectorscope', cie: 'CIE 1931', hist: 'Histogramm', stats: 'Messwerte',
};

export const isWaveform = (s: ScopeType) => s === 'wf-luma' || s === 'wf-rgb' || s === 'parade' || s === 'yrgb' || s === 'ycbcr';
export const sections = (s: ScopeType) => (s === 'parade' || s === 'ycbcr' ? 3 : s === 'yrgb' ? 4 : 1);

const GRID = 'rgba(210, 190, 120, 0.42)';
const GRID_DIM = 'rgba(210, 190, 120, 0.16)';
const LABEL = 'rgba(230, 215, 170, 0.85)';
const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

/** Plot area inside a panel body (CSS px), shared by WebGL and the overlay. */
export function plotRect(scope: ScopeType, w: number, h: number, aspect = 16 / 9): Rect {
  if (isWaveform(scope)) return { x: 44, y: 8, w: Math.max(10, w - 52), h: Math.max(10, h - 16) };
  if (scope === 'vector') {
    const s = Math.max(10, Math.min(w, h) - 16);
    return { x: (w - s) / 2, y: (h - s) / 2, w: s, h: s };
  }
  if (scope === 'cie') {
    const s = Math.max(10, Math.min(w - 36, h - 24));
    return { x: (w - s + 24) / 2, y: (h - s - 16) / 2, w: s, h: s };
  }
  if (scope === 'hist') return { x: 8, y: 8, w: Math.max(10, w - 16), h: Math.max(10, h - 26) };
  if (scope === 'picture') {
    let pw = w, ph = w / aspect;
    if (ph > h) { ph = h; pw = h * aspect; }
    return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph };
  }
  return { x: 0, y: 0, w, h };
}

export function waveTicks(unit: Unit, transfer: Transfer): { level: number; label: string; major: boolean }[] {
  if (unit === 'nits') {
    const list = transfer === 'pq' ? [0, 1, 10, 100, 203, 400, 1000, 2000, 4000, 10000]
      : transfer === 'hlg' ? [0, 1, 10, 50, 100, 203, 500, 1000] : [0, 1, 5, 10, 20, 50, 100];
    return list.map((n) => ({ level: nitsToSignal(n, transfer), label: n >= 1000 ? `${n / 1000}k` : String(n), major: [0, 100, 203, 1000, 10000].includes(n) }));
  }
  const out = [];
  for (let i = 0; i <= 10; i++) {
    const level = i / 10;
    const label = unit === 'percent' ? String(i * 10) : String(Math.round(codeValue(level, unit === 'bit8' ? 8 : 10)));
    out.push({ level, label, major: i === 0 || i === 10 || i === 5 });
  }
  return out;
}

export const waveY = (r: Rect, level: number) => r.y + r.h - ((level - WAVE_MIN) / (WAVE_MAX - WAVE_MIN)) * r.h;

export function drawWaveGraticule(ctx: CanvasRenderingContext2D, scope: ScopeType, r: Rect, unit: Unit, transfer: Transfer) {
  ctx.font = FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  let lastLabel = Infinity;
  for (const t of waveTicks(unit, transfer)) {
    const y = Math.round(waveY(r, t.level)) + 0.5;
    ctx.strokeStyle = t.major ? GRID : GRID_DIM;
    ctx.setLineDash(t.major ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
    // ticks run bottom → top; skip labels that would collide with the previous one
    if (lastLabel - y >= 11) { ctx.fillStyle = LABEL; ctx.fillText(t.label, r.x - 5, y); lastLabel = y; }
  }
  ctx.setLineDash([]);
  const n = sections(scope);
  ctx.strokeStyle = GRID;
  for (let i = 1; i < n; i++) {
    const x = Math.round(r.x + (r.w * i) / n) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
  }
  const names = scope === 'parade' ? ['R', 'G', 'B'] : scope === 'yrgb' ? ['Y', 'R', 'G', 'B'] : scope === 'ycbcr' ? ['Y', 'Cb', 'Cr'] : [];
  const colors: Record<string, string> = { R: '#ff6b6b', G: '#6bff7a', B: '#7b9bff', Y: '#ddd', Cb: '#7b9bff', Cr: '#ff6b6b' };
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  names.forEach((nm, i) => { ctx.fillStyle = colors[nm]; ctx.fillText(nm, r.x + (r.w * i) / n + 4, r.y + 2); });
  ctx.fillStyle = LABEL; ctx.textAlign = 'right';
  ctx.fillText(unit === 'nits' ? `cd/m² ${transfer.toUpperCase()}` : unit === 'percent' ? '%' : unit === 'bit8' ? '8 bit' : '10 bit', r.x + r.w - 4, r.y + 2);
}

export function drawWaveProbe(ctx: CanvasRenderingContext2D, scope: ScopeType, r: Rect, src: Source, rgb: [number, number, number]) {
  if (!src.probe) return;
  const n = sections(scope);
  const fx = src.probe.x / src.width;
  const { y, cb, cr } = ycbcr(rgb[0], rgb[1], rgb[2], src.colorspace);
  const vals: [number, string][] = scope === 'wf-luma' ? [[y, '#fff']]
    : scope === 'wf-rgb' || scope === 'parade' ? [[rgb[0], '#ff6b6b'], [rgb[1], '#6bff7a'], [rgb[2], '#7b9bff']]
      : scope === 'yrgb' ? [[y, '#fff'], [rgb[0], '#ff6b6b'], [rgb[1], '#6bff7a'], [rgb[2], '#7b9bff']]
        : [[y, '#fff'], [cb + 0.5, '#7b9bff'], [cr + 0.5, '#ff6b6b']];
  ctx.strokeStyle = 'rgba(0, 220, 255, 0.55)';
  ctx.setLineDash([4, 3]);
  for (let i = 0; i < n; i++) {
    const x = Math.round(r.x + (r.w * (i + fx)) / n) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
  }
  ctx.setLineDash([]);
  vals.forEach(([v, c], i) => {
    const sec = n === 1 ? 0 : i;
    const x = r.x + (r.w * (sec + fx)) / n, yy = waveY(r, v);
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 7, yy); ctx.lineTo(x + 7, yy); ctx.stroke();
  });
  ctx.lineWidth = 1;
}

export function vectorPoint(r: Rect, cb: number, cr: number, zoom: number) {
  const R = r.w / 2;
  return [r.x + R + cb * 2 * 0.9 * zoom * R, r.y + R - cr * 2 * 0.9 * zoom * R] as const;
}

export function drawVectorGraticule(ctx: CanvasRenderingContext2D, r: Rect, cs: Colorspace, zoom: number) {
  const R = r.w / 2, cx = r.x + R, cy = r.y + R;
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.lineWidth = 1; ctx.strokeStyle = GRID;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = GRID_DIM;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  for (let a = 0; a < 360; a += 10) {
    const rad = (a * Math.PI) / 180, l = a % 30 === 0 ? 0.06 : 0.03;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rad) * R * 0.9, cy - Math.sin(rad) * R * 0.9);
    ctx.lineTo(cx + Math.cos(rad) * R * (0.9 - l), cy - Math.sin(rad) * R * (0.9 - l));
    ctx.stroke();
  }
  // skin-tone line
  const s = (SKIN_LINE_DEG * Math.PI) / 180;
  ctx.strokeStyle = 'rgba(255, 170, 120, 0.5)'; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(s) * R, cy - Math.sin(s) * R); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const t100 = barTargets(cs, 1), t75 = barTargets(cs, 0.75);
  const box = Math.max(5, R * 0.05);
  t75.forEach((t, i) => {
    const [x, y] = vectorPoint(r, t.cb, t.cr, zoom);
    ctx.strokeStyle = GRID;
    ctx.strokeRect(x - box, y - box, box * 2, box * 2);
    const [x1, y1] = vectorPoint(r, t100[i].cb, t100[i].cr, zoom);
    ctx.beginPath(); ctx.arc(x1, y1, box * 0.6, 0, Math.PI * 2); ctx.stroke();
    // label on the inner side of the 75 % box so it never leaves the plot
    const ang = Math.atan2(t.cr, t.cb);
    ctx.fillStyle = LABEL;
    ctx.fillText(t.label, x - Math.cos(ang) * box * 2.6, y + Math.sin(ang) * box * 2.6);
  });
  ctx.restore();
  ctx.fillStyle = LABEL; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`Rec.${cs}${zoom !== 1 ? `  ×${zoom}` : ''}`, r.x + 2, r.y + 2);
}

export function cieToPlot(r: Rect, x: number, y: number) {
  const v = CIE_VIEW;
  return [r.x + ((x - v.x0) / (v.x1 - v.x0)) * r.w, r.y + r.h - ((y - v.y0) / (v.y1 - v.y0)) * r.h] as const;
}

export function drawCieGraticule(ctx: CanvasRenderingContext2D, r: Rect, cs: Colorspace) {
  ctx.lineWidth = 1; ctx.font = FONT;
  ctx.strokeStyle = GRID_DIM; ctx.fillStyle = LABEL;
  const every = r.w < 320 ? 2 : 1;
  for (let i = 0; i <= 8; i++) {
    const v = i / 10;
    const [x] = cieToPlot(r, v, 0), [, y] = cieToPlot(r, 0, v);
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
    if (i % every) continue;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(v.toFixed(1), x, r.y + r.h + 3);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(v.toFixed(1), r.x - 4, y);
  }
  ctx.beginPath();
  SPECTRAL_LOCUS.forEach(([, x, y], i) => { const [px, py] = cieToPlot(r, x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'; ctx.fill();
  ctx.strokeStyle = 'rgba(230, 230, 230, 0.7)'; ctx.stroke();
  ctx.fillStyle = 'rgba(230, 230, 230, 0.55)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const [nm, x, y] of SPECTRAL_LOCUS) {
    if (![460, 480, 500, 520, 540, 560, 580, 600, 620].includes(nm) || (r.w < 320 && nm % 40 !== 20 && nm !== 460)) continue;
    const [px, py] = cieToPlot(r, x, y);
    ctx.fillText(String(nm), px + (x < 0.3 ? -26 : 5), py);
  }
  const tri: [keyof typeof GAMUTS, string][] = [['709', 'rgba(255,255,255,0.75)'], ['p3', 'rgba(255,200,60,0.7)'], ['2020', 'rgba(60,220,255,0.7)']];
  tri.forEach(([k, c], i) => {
    const g = GAMUTS[k];
    ctx.strokeStyle = c; ctx.setLineDash(k === cs || (k === '709' && cs === '601') ? [] : [4, 3]);
    ctx.beginPath();
    [g.r, g.g, g.b].forEach(([x, y], j) => { const [px, py] = cieToPlot(r, x, y); if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = c; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(g.name, r.x + r.w - 4, r.y + 4 + i * 13);
  });
  ctx.setLineDash([]);
  const [wx, wy] = cieToPlot(r, 0.3127, 0.329);
  ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(wx, wy, 3, 0, Math.PI * 2); ctx.stroke();
}

export function drawHistogram(ctx: CanvasRenderingContext2D, r: Rect, src: Source, mode: 'rgb' | 'luma' | 'split', log: boolean) {
  const st = src.stats;
  ctx.strokeStyle = GRID_DIM; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = Math.round(r.x + (r.w * i) / 10) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
  }
  ctx.fillStyle = LABEL; ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 10; i += 2) ctx.fillText(String(i * 10), r.x + (r.w * i) / 10, r.y + r.h + 4);
  if (!st) return;
  const chans: [number, string][] = mode === 'luma' ? [[3, 'rgba(235,235,235,0.85)']]
    : [[0, 'rgba(255,70,70,0.75)'], [1, 'rgba(70,255,90,0.75)'], [2, 'rgba(80,120,255,0.8)']];
  const rows = mode === 'split' ? 3 : 1;
  const tf = (v: number) => (log ? Math.log1p(v) : v);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  chans.forEach(([c, col], i) => {
    const h = st.hist[c];
    // ignore the extreme bins for scaling so that clipped areas do not flatten the rest
    let max = 1;
    for (let b = 1; b < 255; b++) max = Math.max(max, tf(h[b]));
    const row = rows === 1 ? 0 : i, rh = r.h / rows, base = r.y + rh * (row + 1);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(r.x, base);
    for (let b = 0; b < 256; b++) ctx.lineTo(r.x + ((b + 0.5) / 256) * r.w, base - Math.min(1, tf(h[b]) / max) * (rh - 2));
    ctx.lineTo(r.x + r.w, base); ctx.closePath(); ctx.fill();
  });
  ctx.restore();
  ctx.textAlign = 'left'; ctx.fillStyle = LABEL;
  const clip = (a: number[]) => `${(Math.max(...a) * 100).toFixed(2)} %`;
  ctx.fillText(`Clip ▼ ${clip(st.clipLow)}   ▲ ${clip(st.clipHigh)}${log ? '   log' : ''}`, r.x + 4, r.y + 2);
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

export function probeLines(src: Source, rgb: [number, number, number], unit: Unit): string[] {
  const { y, cb, cr } = ycbcr(rgb[0], rgb[1], rgb[2], src.colorspace);
  const bits = unit === 'bit8' ? 8 : 10;
  const fmt = (v: number) => (unit === 'percent' || unit === 'nits' ? (v * 100).toFixed(1) : Math.round(codeValue(v, bits)).toString());
  const lines = [
    `x ${src.probe!.x}  y ${src.probe!.y}`,
    `R ${fmt(rgb[0])}  G ${fmt(rgb[1])}  B ${fmt(rgb[2])}`,
    `Y' ${pct(y)}  Cb ${cb >= 0 ? '+' : ''}${(cb * 100).toFixed(1)}  Cr ${cr >= 0 ? '+' : ''}${(cr * 100).toFixed(1)}`,
  ];
  if (src.transfer !== 'sdr' || unit === 'nits') lines.push(`≈ ${Math.round(signalToNits(y, src.transfer))} cd/m² (${src.transfer.toUpperCase()})`);
  return lines;
}

export function drawTextBox(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[], align: 'left' | 'right' = 'left') {
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12, h = lines.length * 15 + 8;
  const bx = align === 'right' ? x - w : x;
  ctx.fillStyle = 'rgba(8, 9, 11, 0.78)'; ctx.fillRect(bx, y, w, h);
  ctx.fillStyle = '#e8e8e8'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + 6, y + 5 + i * 15));
}

export function statsLines(src: Source, displayFps: number): string[] {
  const st = src.stats, info = src.info;
  const lines = [
    src.name,
    `Status     ${src.status}${src.message ? ` – ${src.message}` : ''}`,
    `Analyse    ${src.width}×${src.height}  ${src.depth} bit`,
  ];
  if (info) {
    lines.push(`Quelle     ${info.sourceWidth}×${info.sourceHeight}  ${info.codec ?? ''} ${info.pixFmt ?? ''}`);
    lines.push(`Metadaten  ${info.matrix}/${info.primaries}/${info.transfer}  ${info.range}`);
  }
  lines.push(`Auswertung Rec.${src.colorspace}  ${src.transfer.toUpperCase()}`);
  lines.push(`Frames     ${src.fps} fps Eingang  ${displayFps} fps Anzeige${src.dropped ? `  ${src.dropped} verworfen` : ''}`);
  if (st) {
    const n = (v: number) => (src.transfer === 'sdr' ? '' : `  (${Math.round(signalToNits(v, src.transfer))} cd/m²)`);
    lines.push('');
    lines.push(`Y' min     ${pct(st.yMin)}${n(st.yMin)}`);
    lines.push(`Y' max     ${pct(st.yMax)}${n(st.yMax)}`);
    lines.push(`Y' Mittel  ${pct(st.yAvg)}${n(st.yAvg)}`);
    lines.push(`Clip ▲ RGB ${st.clipHigh.map((v) => (v * 100).toFixed(2)).join(' / ')} %`);
    lines.push(`Clip ▼ RGB ${st.clipLow.map((v) => (v * 100).toFixed(2)).join(' / ')} %`);
  }
  return lines;
}
