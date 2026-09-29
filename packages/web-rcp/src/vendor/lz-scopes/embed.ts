// Embeddable scopes: `new ScopeView(container, { scopes: ['wf-luma', 'vector'] })`.
// One WebGL canvas behind a small panel grid; feed it a Source (bridge frames,
// video element, test pattern). Framework-free so React/Vue hosts wrap it in a ref.

import { LUMA } from './color';
import { SCOPE_LABELS, type ScopeType, type Unit } from './graticule';
import { defaultPanel, drawPanel, type PanelState, type Tint } from './panel';
import { Renderer } from './renderer';
import type { Source } from './sources';

export interface ScopeViewOptions {
  scopes?: ScopeType[];
  unit?: Unit;
  tint?: Tint;
  maxSamples?: number;
  /** Show a scope selector in each panel header (default true). */
  selectors?: boolean;
  /** Text when no source is set. */
  emptyText?: string;
  onScopesChange?: (scopes: ScopeType[]) => void;
}

const CSS = `
.lzs-root{position:relative;display:grid;gap:3px;width:100%;height:100%;background:#0b0c0e;font:11px system-ui,sans-serif;color:#d9dce0}
.lzs-root>canvas.lzs-gl{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.lzs-panel{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #22262b;border-radius:3px}
.lzs-head{position:relative;z-index:1;display:flex;gap:4px;padding:2px 3px;background:rgba(17,19,22,.92);border-bottom:1px solid #22262b}
.lzs-head select{font:inherit;color:inherit;background:#181b1f;border:1px solid #2d3238;border-radius:3px;padding:1px 3px}
.lzs-body{position:relative;flex:1;min-height:0}
.lzs-body canvas{position:absolute;inset:0;width:100%;height:100%}`;

let styled = false;

export class ScopeView {
  readonly root: HTMLDivElement;
  private renderer: Renderer;
  private glCanvas: HTMLCanvasElement;
  private panels: { state: PanelState; el: HTMLElement; body: HTMLElement; overlay: HTMLCanvasElement }[] = [];
  private source: Source | null = null;
  private raf = 0;
  private lastStats = 0;
  private opts: Required<Omit<ScopeViewOptions, 'onScopesChange' | 'emptyText'>> & ScopeViewOptions;

  constructor(container: HTMLElement, options: ScopeViewOptions = {}) {
    if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.append(st); styled = true; }
    this.opts = { scopes: ['wf-luma', 'vector'], unit: 'percent', tint: 'green', maxSamples: 1_000_000, selectors: true, ...options };
    this.root = document.createElement('div');
    this.root.className = 'lzs-root';
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'lzs-gl';
    this.root.append(this.glCanvas);
    container.append(this.root);
    this.renderer = new Renderer(this.glCanvas);
    this.setScopes(this.opts.scopes);
    this.raf = requestAnimationFrame(this.frame);
  }

  setSource(src: Source | null) { this.source = src; }

  setOptions(o: Partial<Pick<ScopeViewOptions, 'unit' | 'tint' | 'maxSamples'>>) { Object.assign(this.opts, o); }

  setScopes(scopes: ScopeType[]) {
    this.panels.forEach((p, i) => { p.el.remove(); this.renderer.dropPanel(`e${i}`); });
    this.opts.scopes = scopes;
    const n = scopes.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    this.root.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this.root.style.gridAutoRows = '1fr';
    this.panels = scopes.map((scope, i) => {
      const state = defaultPanel(scope);
      const body = document.createElement('div'); body.className = 'lzs-body';
      const overlay = document.createElement('canvas'); body.append(overlay);
      const el = document.createElement('div'); el.className = 'lzs-panel';
      if (this.opts.selectors) {
        const head = document.createElement('div'); head.className = 'lzs-head';
        const sel = document.createElement('select');
        for (const [k, label] of Object.entries(SCOPE_LABELS)) {
          if (k === 'stats') continue;
          sel.append(new Option(label, k, false, k === scope));
        }
        sel.onchange = () => {
          const next = [...this.opts.scopes]; next[i] = sel.value as ScopeType;
          this.setScopes(next); this.opts.onScopesChange?.(next);
        };
        head.append(sel); el.append(head);
      }
      el.append(body);
      this.root.append(el);
      return { state, el, body, overlay };
    });
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const g = this.root.getBoundingClientRect();
    if (g.width < 2 || g.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(g.width, g.height, dpr);
    this.renderer.beginFrame();
    const src = this.source;
    const now = performance.now();
    if (src && now - this.lastStats > 100) {
      this.lastStats = now;
      const { kr, kb } = LUMA[src.colorspace];
      src.updateStats(kr, kb);
    }
    this.panels.forEach((p, i) => {
      const b = p.body.getBoundingClientRect();
      const W = Math.round(b.width * dpr), H = Math.round(b.height * dpr);
      if (p.overlay.width !== W || p.overlay.height !== H) { p.overlay.width = W; p.overlay.height = H; }
      const ctx = p.overlay.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, b.width, b.height);
      drawPanel(this.renderer, ctx, `e${i}`, p.state, src, { x: b.left - g.left, y: b.top - g.top, w: b.width, h: b.height }, {
        unit: this.opts.unit, tint: this.opts.tint, maxSamples: this.opts.maxSamples, falsePreset: 'ARRI',
        zebra: 0.95, zebraLow: 0, frozen: false, displayFps: 0, emptyText: this.opts.emptyText ?? 'Kein Signal',
      });
    });
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    this.root.remove();
    this.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
