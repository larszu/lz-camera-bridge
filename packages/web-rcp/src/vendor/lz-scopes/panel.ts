// Draws one scope panel (WebGL trace + 2D overlay). Shared by the full app and the
// embeddable ScopeView (src/embed.ts).

import { FALSE_COLOR_PRESETS, ycbcr } from './color';
import {
  drawCieGraticule, drawHistogram, drawTextBox, drawVectorGraticule, drawWaveGraticule, drawWaveProbe,
  isWaveform, plotRect, probeLines, statsLines, vectorPoint, type ScopeType, type Unit,
} from './graticule';
import type { PictureMode, Rect, Renderer, ScatterMode } from './renderer';
import type { Source } from './sources';

export interface PanelState {
  scope: ScopeType; sourceId: string; gain: number; colorize: boolean; zoom: number;
  picture: PictureMode; hist: 'rgb' | 'luma' | 'split'; log: boolean;
}

export const TINTS = { white: [1, 1, 1], green: [0.55, 1, 0.62], amber: [1, 0.82, 0.45] } as const;
export type Tint = keyof typeof TINTS;

export interface DrawOptions {
  unit: Unit; tint: Tint; maxSamples: number; falsePreset: string;
  zebra: number; zebraLow: number; frozen: boolean; displayFps: number;
  emptyText?: string;
}

export const defaultPanel = (scope: ScopeType): PanelState => ({
  scope, sourceId: '', gain: 1, colorize: scope === 'vector' || scope === 'cie', zoom: 1, picture: 'normal', hist: 'rgb', log: false,
});

const SCATTER: Partial<Record<ScopeType, ScatterMode>> = {
  'wf-luma': 'luma', 'wf-rgb': 'rgb', parade: 'parade', yrgb: 'yrgb', ycbcr: 'ycbcr', vector: 'vector', cie: 'cie',
};

/**
 * @param body panel body in CSS px relative to the renderer canvas
 * @param ctx  2D context of the panel overlay, already scaled to CSS px and cleared
 */
export function drawPanel(renderer: Renderer, ctx: CanvasRenderingContext2D, key: string, p: PanelState, src: Source | null, body: Rect, o: DrawOptions) {
  const aspect = src && src.width ? src.width / src.height : 16 / 9;
  const r = plotRect(p.scope, body.w, body.h, aspect);
  const abs = { x: body.x + r.x, y: body.y + r.y, w: r.w, h: r.h };
  renderer.clearRect(abs);

  if (!src || !src.ready) {
    ctx.fillStyle = '#6b7078'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(src ? (src.message || 'Keine Daten – Quelle starten') : (o.emptyText ?? 'Links eine Quelle hinzufügen'), body.w / 2, body.h / 2);
    if (isWaveform(p.scope)) drawWaveGraticule(ctx, p.scope, r, o.unit, src?.transfer ?? 'sdr');
    return;
  }
  const probeRgb = src.probe ? src.readPixel(src.probe.x, src.probe.y) : null;
  const mode = SCATTER[p.scope];
  if (mode) {
    renderer.drawScatter(key, src, abs, {
      mode, gain: p.gain, colorize: p.colorize, zoom: p.zoom, tint: [...TINTS[o.tint]] as [number, number, number], maxSamples: o.maxSamples,
    });
  }
  if (isWaveform(p.scope)) {
    drawWaveGraticule(ctx, p.scope, r, o.unit, src.transfer);
    if (probeRgb) drawWaveProbe(ctx, p.scope, r, src, probeRgb);
  } else if (p.scope === 'vector') {
    drawVectorGraticule(ctx, r, src.colorspace, p.zoom);
    if (probeRgb) {
      const { cb, cr } = ycbcr(probeRgb[0], probeRgb[1], probeRgb[2], src.colorspace);
      const [x, y] = vectorPoint(r, cb, cr, p.zoom);
      ctx.strokeStyle = '#00dcff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
    }
  } else if (p.scope === 'cie') {
    drawCieGraticule(ctx, r, src.colorspace);
  } else if (p.scope === 'hist') {
    drawHistogram(ctx, r, src, p.hist, p.log);
  } else if (p.scope === 'picture') {
    renderer.drawPicture(src, abs, { mode: p.picture, bands: FALSE_COLOR_PRESETS[o.falsePreset] ?? [], zebra: o.zebra, zebraLow: o.zebraLow });
    if (p.picture === 'false') {
      const bands = FALSE_COLOR_PRESETS[o.falsePreset] ?? [];
      ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      bands.forEach((bd, i) => {
        const y = r.y + r.h - 12 - (bands.length - 1 - i) * 14;
        ctx.fillStyle = 'rgba(8,9,11,0.75)'; ctx.fillRect(r.x + 4, y - 7, 150, 14);
        ctx.fillStyle = bd.color; ctx.fillRect(r.x + 6, y - 4, 8, 8);
        ctx.fillStyle = '#ddd'; ctx.fillText(`${bd.from}–${Math.min(100, bd.to)} % ${bd.label}`, r.x + 18, y);
      });
    }
    if (src.probe && probeRgb) {
      const x = r.x + ((src.probe.x + 0.5) / src.width) * r.w, y = r.y + ((src.probe.y + 0.5) / src.height) * r.h;
      ctx.strokeStyle = '#00dcff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 10); ctx.stroke();
      drawTextBox(ctx, r.x + r.w - 6, r.y + 6, probeLines(src, probeRgb, o.unit), 'right');
    }
    if (o.frozen) drawTextBox(ctx, r.x + 6, r.y + 6, ['STANDBILD']);
  } else if (p.scope === 'stats') {
    const lines = statsLines(src, o.displayFps);
    if (probeRgb) lines.push('', 'Messpunkt', ...probeLines(src, probeRgb, o.unit));
    ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#d6d6d6'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 12, 10 + i * 15));
  }
}
