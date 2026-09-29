import { detectColorspace, detectTransfer, type Colorspace, type Transfer } from './color';
import { patternById, renderPattern } from './patterns';

export type SourceKind = 'stream' | 'webcam' | 'screen' | 'file' | 'pattern';

export interface SourceSettings {
  transfer: 'auto' | Transfer;
  colorspace: 'auto' | Colorspace;
  /** Analysis width in px for bridge streams (0 = native). */
  width: number;
  fps: number;
  depth: 8 | 16;
  transport: 'tcp' | 'udp';
}

export interface StreamInfo {
  width: number; height: number; sourceWidth: number; sourceHeight: number; depth: 8 | 16; fps: number;
  codec?: string; pixFmt?: string; decodeMatrix?: string; transfer?: string; primaries?: string; matrix?: string; range?: string;
}

export interface Stats {
  hist: Float32Array[]; // R, G, B, Y — 256 bins each
  yMin: number; yMax: number; yAvg: number;
  clipLow: number[]; clipHigh: number[]; // fraction per R, G, B
  samples: number;
}

export const DEFAULT_SETTINGS: SourceSettings = { transfer: 'auto', colorspace: 'auto', width: 960, fps: 0, depth: 8, transport: 'tcp' };

let nextId = 1;

export class Source {
  readonly id: string;
  name: string;
  kind: SourceKind;
  url = '';
  settings: SourceSettings;
  status: 'idle' | 'connecting' | 'live' | 'error' | 'ended' = 'idle';
  message = '';
  info: StreamInfo | null = null;
  width = 0;
  height = 0;
  depth: 8 | 16 = 8;
  /** Latest raw frame (bridge streams). */
  data: Uint8Array | Uint16Array | null = null;
  /** Browser-decoded media (webcam, screen, files). */
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | null = null;
  /** Test pattern state (kind 'pattern'). */
  pattern = { id: 'smpte75', width: 1920, height: 1080, label: '' };
  frameSeq = 0;
  fps = 0;
  dropped = 0;
  frozen = false;
  stats: Stats | null = null;
  probe: { x: number; y: number } | null = null;
  onChange: () => void = () => {};

  private ws: WebSocket | null = null;
  private patternTimer: ReturnType<typeof setInterval> | null = null;
  private media: MediaStream | null = null;
  private objectUrl: string | null = null;
  private frameTimes: number[] = [];
  private statsCanvas: HTMLCanvasElement | null = null;
  private statsSeq = -1;

  constructor(kind: SourceKind, name?: string, settings?: Partial<SourceSettings>) {
    this.id = `s${nextId++}`;
    this.kind = kind;
    this.name = name ?? { stream: 'Stream', webcam: 'Kamera', screen: 'Bildschirm', file: 'Datei', pattern: 'Testbild' }[kind];
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  get transfer(): Transfer {
    if (this.settings.transfer !== 'auto') return this.settings.transfer;
    if (this.kind === 'pattern') return patternById(this.pattern.id).transfer ?? 'sdr';
    return detectTransfer(this.info?.transfer);
  }
  get colorspace(): Colorspace {
    if (this.settings.colorspace !== 'auto') return this.settings.colorspace;
    if (!this.info) return this.height > 576 || this.height === 0 ? '709' : '601';
    return detectColorspace(this.info.decodeMatrix ?? this.info.matrix, this.info.primaries, this.info.sourceHeight);
  }
  get ready() { return this.width > 0 && (this.data !== null || this.element !== null); }

  private set(status: Source['status'], message = '') {
    this.status = status; this.message = message; this.onChange();
  }

  private tick() {
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;
    if (!this.frozen) this.frameSeq++;
  }

  connectStream(url: string, bridge: string) {
    this.stop();
    this.url = url;
    this.set('connecting', 'Verbinde …');
    const { width, fps, depth, transport } = this.settings;
    const q = new URLSearchParams({ url, width: String(width), fps: String(fps), depth: String(depth), transport });
    this.connectFrames(`${bridge}/stream?${q}`, false);
  }

  /**
   * Connect to any endpoint speaking the LZ Scopes frame protocol (docs/frame-protocol.md),
   * e.g. a host bridge that keeps the camera address to itself: `ws://host/scope/3`.
   */
  connectFrames(wsUrl: string, reset = true) {
    if (reset) { this.stop(); this.url = wsUrl; this.set('connecting', 'Verbinde …'); }
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'info') {
          this.info = msg; this.width = msg.width; this.height = msg.height; this.depth = msg.depth;
          this.set('live', `${msg.sourceWidth}×${msg.sourceHeight} ${msg.codec ?? ''}`.trim());
        } else if (msg.type === 'stats') {
          this.dropped = msg.dropped;
        } else if (msg.type === 'error' || msg.type === 'end') {
          this.set(msg.type === 'end' ? 'ended' : 'error', msg.message);
        }
        return;
      }
      if (this.frozen) return;
      this.data = this.depth === 16 ? new Uint16Array(ev.data) : new Uint8Array(ev.data);
      this.tick();
    };
    ws.onerror = () => this.set('error', 'Bridge nicht erreichbar – läuft `npm run dev` bzw. `npm start`?');
    ws.onclose = () => { if (this.ws === ws && this.status === 'live') this.set('ended', 'Verbindung beendet'); };
  }

  /**
   * Feed frames without a WebSocket, e.g. from an Electron main process over a
   * MessagePort. `info` once (or on change), then one call per frame.
   */
  pushInfo(info: StreamInfo) {
    this.info = info; this.width = info.width; this.height = info.height; this.depth = info.depth;
    this.set('live', `${info.sourceWidth}×${info.sourceHeight} ${info.codec ?? ''}`.trim());
  }
  pushFrame(buffer: ArrayBuffer) {
    if (this.frozen || !this.info) return;
    this.data = this.depth === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    this.tick();
  }

  async startCapture(kind: 'webcam' | 'screen', deviceId?: string) {
    this.stop();
    this.set('connecting', 'Warte auf Freigabe …');
    try {
      this.media = kind === 'webcam'
        ? await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 } } : { width: { ideal: 1920 } }, audio: false })
        : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = this.media;
      await v.play();
      this.attachVideo(v);
      const track = this.media.getVideoTracks()[0];
      track.addEventListener('ended', () => this.set('ended', 'Aufnahme beendet'));
      this.set('live', `${v.videoWidth}×${v.videoHeight} ${track.label}`);
    } catch (e) {
      this.set('error', (e as Error).message);
    }
  }

  async openFile(file: File) {
    this.stop();
    this.objectUrl = URL.createObjectURL(file);
    this.name = file.name;
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.src = this.objectUrl;
      await img.decode();
      this.element = img; this.width = img.naturalWidth; this.height = img.naturalHeight; this.depth = 8;
      this.tick();
      this.set('live', `${this.width}×${this.height} Bild`);
      return;
    }
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.src = this.objectUrl;
    try {
      await v.play();
      this.attachVideo(v);
      this.set('live', `${v.videoWidth}×${v.videoHeight} Video`);
    } catch (e) {
      this.set('error', `Nicht abspielbar: ${(e as Error).message}`);
    }
  }

  /** Generate a test pattern into a canvas; animated patterns redraw at 25 fps. */
  async startPattern() {
    this.stop();
    const { id, width, height, label } = this.pattern;
    const def = patternById(id);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const t0 = performance.now();
    try {
      await renderPattern(ctx, def, width, height, 0, label);
    } catch (e) {
      this.set('error', (e as Error).message);
      return;
    }
    this.element = canvas; this.width = width; this.height = height; this.depth = 8;
    this.tick();
    this.set('live', `${def.name} · ${width}×${height}`);
    if (def.animated) {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || this.frozen || this.element !== canvas) return;
        busy = true;
        await renderPattern(ctx, def, width, height, (performance.now() - t0) / 1000, label);
        busy = false;
        this.tick();
      }, 40);
      this.patternTimer = timer;
    }
  }

  private attachVideo(v: HTMLVideoElement) {
    this.element = v; this.width = v.videoWidth; this.height = v.videoHeight; this.depth = 8;
    const onFrame = () => {
      if (this.element !== v) return;
      this.width = v.videoWidth; this.height = v.videoHeight;
      this.tick();
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(onFrame);
      else setTimeout(onFrame, 1000 / 30);
    };
    onFrame();
  }

  get video(): HTMLVideoElement | null {
    return this.element instanceof HTMLVideoElement ? this.element : null;
  }

  stop() {
    if (this.patternTimer) { clearInterval(this.patternTimer); this.patternTimer = null; }
    if (this.ws) { const ws = this.ws; this.ws = null; ws.onclose = null; ws.close(); }
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    this.element = null; this.data = null; this.info = null; this.width = 0; this.height = 0; this.stats = null;
    this.fps = 0; this.dropped = 0;
    if (this.status !== 'idle') this.set('idle');
  }

  /** Read one pixel as normalised R'G'B'. */
  readPixel(x: number, y: number): [number, number, number] | null {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    if (this.data) {
      const i = (y * this.width + x) * 4, s = this.depth === 16 ? 65535 : 255;
      return [this.data[i] / s, this.data[i + 1] / s, this.data[i + 2] / s];
    }
    if (this.element) {
      const c = this.scratch(1, 1);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(this.element, x, y, 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    }
    return null;
  }

  private scratch(w: number, h: number) {
    this.statsCanvas ??= document.createElement('canvas');
    if (this.statsCanvas.width !== w || this.statsCanvas.height !== h) { this.statsCanvas.width = w; this.statsCanvas.height = h; }
    return this.statsCanvas;
  }

  /** Histogram and clipping statistics on a subsampled frame (CPU, ~130 k samples). */
  updateStats(kr: number, kb: number) {
    if (!this.ready || this.statsSeq === this.frameSeq) return;
    this.statsSeq = this.frameSeq;
    let px: Uint8Array | Uint8ClampedArray | Uint16Array, w: number, h: number, step: number, scale: number;
    if (this.data) {
      px = this.data; w = this.width; h = this.height; scale = this.depth === 16 ? 65535 : 255;
      step = Math.max(1, Math.round(Math.sqrt((w * h) / 130000)));
    } else {
      w = Math.min(480, this.width); h = Math.max(1, Math.round((this.height * w) / this.width));
      const c = this.scratch(w, h), ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(this.element!, 0, 0, w, h);
      px = ctx.getImageData(0, 0, w, h).data; scale = 255; step = 1;
    }
    this.stats = computeStats(px, w, h, step, scale, kr, kb);
  }
}

export function computeStats(px: ArrayLike<number>, w: number, h: number, step: number, scale: number, kr: number, kb: number): Stats {
  const hist = [0, 1, 2, 3].map(() => new Float32Array(256));
  const kg = 1 - kr - kb;
  const lo = 0.5 / 255, hi = 254.5 / 255;
  const clipLow = [0, 0, 0], clipHigh = [0, 0, 0];
  let yMin = 1, yMax = 0, ySum = 0, n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = px[i] / scale, g = px[i + 1] / scale, b = px[i + 2] / scale;
      const Y = kr * r + kg * g + kb * b;
      hist[0][Math.min(255, (r * 255 + 0.5) | 0)]++;
      hist[1][Math.min(255, (g * 255 + 0.5) | 0)]++;
      hist[2][Math.min(255, (b * 255 + 0.5) | 0)]++;
      hist[3][Math.min(255, (Y * 255 + 0.5) | 0)]++;
      if (r <= lo) clipLow[0]++; else if (r >= hi) clipHigh[0]++;
      if (g <= lo) clipLow[1]++; else if (g >= hi) clipHigh[1]++;
      if (b <= lo) clipLow[2]++; else if (b >= hi) clipHigh[2]++;
      if (Y < yMin) yMin = Y;
      if (Y > yMax) yMax = Y;
      ySum += Y; n++;
    }
  }
  return {
    hist, yMin, yMax, yAvg: n ? ySum / n : 0, samples: n,
    clipLow: clipLow.map((c) => c / Math.max(1, n)), clipHigh: clipHigh.map((c) => c / Math.max(1, n)),
  };
}
