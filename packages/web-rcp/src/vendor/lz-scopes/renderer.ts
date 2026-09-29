// WebGL2 renderer: one canvas behind the whole panel grid. Scopes are computed on the
// GPU by scattering every sampled pixel as a point into a float accumulation buffer
// (additive blending), then tone-mapped into the panel's plot rectangle.

import { GAMUTS, LUMA, hexToRgb, rgbToXyzMatrix, type Colorspace, type FalseColorBand, type Transfer } from './color';
import type { Source } from './sources';

export type ScatterMode = 'luma' | 'rgb' | 'parade' | 'yrgb' | 'ycbcr' | 'vector' | 'cie';
const MODE_ID: Record<ScatterMode, number> = { luma: 0, rgb: 1, parade: 2, yrgb: 3, ycbcr: 4, vector: 5, cie: 6 };
const INSTANCES: Record<ScatterMode, number> = { luma: 1, rgb: 3, parade: 3, yrgb: 4, ycbcr: 3, vector: 1, cie: 1 };
const TRANSFER_ID: Record<Transfer, number> = { sdr: 0, pq: 1, hlg: 2 };

export type PictureMode = 'normal' | 'false' | 'zebra' | 'clip' | 'luma';
const PICTURE_ID: Record<PictureMode, number> = { normal: 0, false: 1, zebra: 2, clip: 3, luma: 4 };

export interface Rect { x: number; y: number; w: number; h: number }

/** Vertical waveform range: signal level at the bottom and top edge of the plot. */
export const WAVE_MIN = -0.05;
export const WAVE_MAX = 1.05;
/** CIE xy plot window (square). */
export const CIE_VIEW = { x0: -0.05, x1: 0.85, y0: -0.03, y1: 0.87 };

const FETCH = (u16: boolean) => u16
  ? `uniform highp usampler2D uSrc;
     vec3 fetchRGB(ivec2 p) { return vec3(texelFetch(uSrc, p, 0).rgb) / 65535.0; }`
  : `uniform highp sampler2D uSrc;
     vec3 fetchRGB(ivec2 p) { return texelFetch(uSrc, p, 0).rgb; }`;

const SCATTER_VS = (u16: boolean) => `#version 300 es
precision highp float; precision highp int;
${FETCH(u16)}
uniform ivec2 uSize;
uniform int uStep, uCols, uMode, uTransfer, uColorize;
uniform vec2 uK;
uniform float uZoom, uIntensity, uWMin, uWMax, uPointSize;
uniform mat3 uToXYZ;
uniform vec4 uCie;
out vec3 vColor;

float eotf(float v) {
  v = max(v, 0.0);
  if (uTransfer == 1) { // PQ → relative linear
    float p = pow(v, 1.0 / 78.84375);
    return pow(max(p - 0.8359375, 0.0) / (18.8515625 - 18.6875 * p), 1.0 / 0.1593017578125);
  }
  if (uTransfer == 2) { // HLG inverse OETF
    return v <= 0.5 ? v * v / 3.0 : (exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
  }
  return pow(v, 2.4);
}

float waveY(float v) { return (v - uWMin) / (uWMax - uWMin) * 2.0 - 1.0; }

void main() {
  gl_PointSize = uPointSize;
  ivec2 p = ivec2(gl_VertexID % uCols, gl_VertexID / uCols) * uStep;
  if (p.y >= uSize.y || p.x >= uSize.x) { gl_Position = vec4(9.0); return; }
  vec3 rgb = fetchRGB(p);
  float kr = uK.x, kb = uK.y, kg = 1.0 - kr - kb;
  float Y = dot(rgb, vec3(kr, kg, kb));
  float cb = (rgb.b - Y) / (2.0 * (1.0 - kb));
  float cr = (rgb.r - Y) / (2.0 * (1.0 - kr));
  float x = (float(p.x) + 0.5) / float(uSize.x);
  int ch = gl_InstanceID;
  vec3 unit[3] = vec3[3](vec3(1.0, 0.18, 0.18), vec3(0.2, 1.0, 0.25), vec3(0.3, 0.45, 1.0));
  vec3 mono = vec3(1.0);
  vec2 pos; vec3 col = mono;

  if (uMode == 0) {
    pos = vec2(x * 2.0 - 1.0, waveY(Y));
    if (uColorize == 1) col = clamp(rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 0.05), 0.0, 1.0);
  } else if (uMode == 1 || uMode == 2) {
    float v = ch == 0 ? rgb.r : ch == 1 ? rgb.g : rgb.b;
    float px = uMode == 2 ? (float(ch) + x) / 3.0 : x;
    pos = vec2(px * 2.0 - 1.0, waveY(v));
    col = uColorize == 1 || uMode == 1 ? unit[ch] : mono;
  } else if (uMode == 3) {
    float v = ch == 0 ? Y : ch == 1 ? rgb.r : ch == 2 ? rgb.g : rgb.b;
    pos = vec2((float(ch) + x) / 4.0 * 2.0 - 1.0, waveY(v));
    col = ch == 0 || uColorize == 0 ? mono : unit[ch - 1];
  } else if (uMode == 4) {
    float v = ch == 0 ? Y : ch == 1 ? cb + 0.5 : cr + 0.5;
    pos = vec2((float(ch) + x) / 3.0 * 2.0 - 1.0, waveY(v));
    col = ch == 0 || uColorize == 0 ? mono : ch == 1 ? vec3(0.35, 0.55, 1.0) : vec3(1.0, 0.3, 0.35);
  } else if (uMode == 5) {
    pos = vec2(cb, cr) * 2.0 * 0.9 * uZoom;
    if (uColorize == 1) col = clamp(rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 0.05), 0.0, 1.0);
  } else {
    vec3 lin = vec3(eotf(rgb.r), eotf(rgb.g), eotf(rgb.b));
    vec3 XYZ = uToXYZ * lin;
    float s = XYZ.x + XYZ.y + XYZ.z;
    if (s < 1e-6) { gl_Position = vec4(9.0); return; }
    vec2 xy = XYZ.xy / s;
    pos = vec2((xy.x - uCie.x) / (uCie.y - uCie.x), (xy.y - uCie.z) / (uCie.w - uCie.z)) * 2.0 - 1.0;
    col = uColorize == 1 ? clamp(rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 0.05), 0.0, 1.0) : mono;
  }
  vColor = col * uIntensity;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const SCATTER_FS = `#version 300 es
precision highp float;
in vec3 vColor; out vec4 o;
void main() { o = vec4(vColor, 1.0); }`;

const QUAD_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D uAcc; uniform float uGain; uniform vec3 uTint;
in vec2 vUv; out vec4 o;
void main() {
  vec3 a = texture(uAcc, vUv).rgb;
  vec3 c = 1.0 - exp(-a * uGain);
  o = vec4(c * uTint, 1.0);
}`;

const PICTURE_FS = (u16: boolean) => `#version 300 es
precision highp float; precision highp int;
${FETCH(u16)}
uniform ivec2 uSize; uniform int uMode; uniform vec2 uK;
uniform vec4 uBand[8]; uniform int uBands;
uniform float uZebra, uZebraLow;
in vec2 vUv; out vec4 o;
void main() {
  ivec2 p = clamp(ivec2(vec2(vUv.x, 1.0 - vUv.y) * vec2(uSize)), ivec2(0), uSize - 1);
  vec3 rgb = fetchRGB(p);
  float kr = uK.x, kb = uK.y;
  float Y = dot(rgb, vec3(kr, 1.0 - kr - kb, kb));
  vec3 c = rgb;
  if (uMode == 1) {
    c = vec3(Y * 0.8);
    for (int i = 0; i < 8; i++) {
      if (i >= uBands) break;
      vec4 b = uBand[i];
      float from = b.x, to = b.y;
      if (Y >= from && Y < to) {
        float packed = b.z; // 0xRRGGBB packed into a float (exact up to 2^24)
        float r = floor(packed / 65536.0), g = floor(mod(packed, 65536.0) / 256.0), bl = mod(packed, 256.0);
        c = vec3(r, g, bl) / 255.0;
      }
    }
  } else if (uMode == 2) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
    if (Y >= uZebra) c = mix(c, vec3(stripe), 0.85);
    else if (uZebraLow > 0.0 && Y >= uZebraLow && Y < uZebraLow + 0.05) c = mix(c, vec3(stripe), 0.5);
  } else if (uMode == 3) {
    float hi = 254.5 / 255.0, lo = 0.5 / 255.0;
    bool h = max(rgb.r, max(rgb.g, rgb.b)) >= hi, l = min(rgb.r, min(rgb.g, rgb.b)) <= lo;
    c = vec3(Y * 0.6);
    if (h) c = vec3(1.0, 0.1, 0.1);
    if (l) c = vec3(0.15, 0.3, 1.0);
  } else if (uMode == 4) {
    c = vec3(Y);
  }
  o = vec4(c, 1.0);
}`;

interface SrcTex { tex: WebGLTexture; w: number; h: number; u16: boolean; seq: number }
interface Accum { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

export interface ScatterParams {
  mode: ScatterMode; gain: number; colorize: boolean; zoom: number; tint: [number, number, number]; maxSamples: number;
}
export interface PictureParams { mode: PictureMode; bands: FalseColorBand[]; zebra: number; zebraLow: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progs = new Map<string, WebGLProgram>();
  private uloc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private vao: WebGLVertexArrayObject;
  private textures = new Map<string, SrcTex>();
  private accums = new Map<string, Accum>();
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 wird von diesem Browser nicht unterstützt.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float fehlt – Scopes brauchen Float-Rendertargets.');
    gl.getExtension('EXT_float_blend');
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private program(key: string, vs: string, fs: string) {
    let p = this.progs.get(key);
    if (p) return p;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(p)}`);
    this.progs.set(key, p); this.uloc.set(p, new Map());
    return p;
  }

  private u(p: WebGLProgram, name: string) {
    const m = this.uloc.get(p)!;
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  }

  beginFrame() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.043, 0.047, 0.055, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Upload the source's newest frame if it changed. Returns the texture or null. */
  private sourceTexture(src: Source): SrcTex | null {
    if (!src.ready) return null;
    const gl = this.gl;
    const u16 = src.data !== null && src.depth === 16;
    let t = this.textures.get(src.id);
    const w = src.width, h = src.height;
    if (t && t.seq === src.frameSeq && t.w === w && t.h === h && t.u16 === u16) return t;
    if (!t || t.u16 !== u16) {
      if (t) gl.deleteTexture(t.tex);
      const tex = gl.createTexture()!;
      t = { tex, w: 0, h: 0, u16, seq: -1 };
      this.textures.set(src.id, t);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    const same = t.w === w && t.h === h;
    try {
      if (src.data && u16) {
        if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, src.data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, w, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, src.data);
      } else if (src.data) {
        if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
      } else if (src.element) {
        if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.element);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src.element);
      }
    } catch {
      return null; // e.g. video not ready yet
    }
    t.w = w; t.h = h; t.seq = src.frameSeq;
    return t;
  }

  private accum(key: string, w: number, h: number): Accum {
    const gl = this.gl;
    let a = this.accums.get(key);
    if (a && a.w === w && a.h === h) return a;
    if (a) { gl.deleteTexture(a.tex); gl.deleteFramebuffer(a.fbo); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    a = { tex, fbo, w, h };
    this.accums.set(key, a);
    return a;
  }

  dropPanel(key: string) {
    const a = this.accums.get(key);
    if (a) { this.gl.deleteTexture(a.tex); this.gl.deleteFramebuffer(a.fbo); this.accums.delete(key); }
  }
  dropSource(id: string) {
    const t = this.textures.get(id);
    if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(id); }
  }

  /** CSS-pixel rect (relative to canvas) → GL viewport in device pixels (origin bottom-left). */
  private viewport(r: Rect) {
    const d = this.dpr;
    const x = Math.round(r.x * d), w = Math.max(1, Math.round(r.w * d)), h = Math.max(1, Math.round(r.h * d));
    const y = this.canvas.height - Math.round(r.y * d) - h;
    return { x, y, w, h };
  }

  drawScatter(key: string, src: Source, rect: Rect, p: ScatterParams) {
    const t = this.sourceTexture(src);
    if (!t) return;
    const gl = this.gl;
    const vp = this.viewport(rect);
    const acc = this.accum(key, vp.w, vp.h);
    const prog = this.program(`scatter${t.u16 ? 16 : 8}`, SCATTER_VS(t.u16), SCATTER_FS);
    const step = Math.max(1, Math.ceil(Math.sqrt((t.w * t.h) / p.maxSamples)));
    const cols = Math.ceil(t.w / step), rows = Math.ceil(t.h / step);
    const cs: Colorspace = src.colorspace;
    const { kr, kb } = LUMA[cs];
    const mode = MODE_ID[p.mode];
    const n = cols * rows;
    // Normalise so that the display brightness does not depend on source or panel size.
    const sections = p.mode === 'parade' || p.mode === 'ycbcr' ? 3 : p.mode === 'yrgb' ? 4 : 1;
    const area = (vp.w / sections) * vp.h;
    const dot = p.mode === 'vector' || p.mode === 'cie' ? Math.max(1, Math.round(this.dpr)) : 1;
    const intensity = ((p.mode === 'vector' || p.mode === 'cie' ? 0.6 : 0.9) * area) / n / (dot * dot);

    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo);
    gl.viewport(0, 0, acc.w, acc.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.u(prog, 'uSrc'), 0);
    gl.uniform2i(this.u(prog, 'uSize'), t.w, t.h);
    gl.uniform1i(this.u(prog, 'uStep'), step);
    gl.uniform1i(this.u(prog, 'uCols'), cols);
    gl.uniform1i(this.u(prog, 'uMode'), mode);
    gl.uniform1i(this.u(prog, 'uTransfer'), TRANSFER_ID[src.transfer]);
    gl.uniform1i(this.u(prog, 'uColorize'), p.colorize ? 1 : 0);
    gl.uniform2f(this.u(prog, 'uK'), kr, kb);
    gl.uniform1f(this.u(prog, 'uZoom'), p.zoom);
    gl.uniform1f(this.u(prog, 'uIntensity'), intensity);
    gl.uniform1f(this.u(prog, 'uPointSize'), dot);
    gl.uniform1f(this.u(prog, 'uWMin'), WAVE_MIN);
    gl.uniform1f(this.u(prog, 'uWMax'), WAVE_MAX);
    const m = rgbToXyzMatrix(GAMUTS[cs === '2020' ? '2020' : cs === '601' ? '601' : '709']);
    // GLSL mat3 is column-major
    gl.uniformMatrix3fv(this.u(prog, 'uToXYZ'), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    gl.uniform4f(this.u(prog, 'uCie'), CIE_VIEW.x0, CIE_VIEW.x1, CIE_VIEW.y0, CIE_VIEW.y1);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.POINTS, 0, n, INSTANCES[p.mode]);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    const dp = this.program('display', QUAD_VS, DISPLAY_FS);
    gl.useProgram(dp);
    gl.bindTexture(gl.TEXTURE_2D, acc.tex);
    gl.uniform1i(this.u(dp, 'uAcc'), 0);
    gl.uniform1f(this.u(dp, 'uGain'), p.gain);
    gl.uniform3fv(this.u(dp, 'uTint'), p.tint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawPicture(src: Source, rect: Rect, p: PictureParams) {
    const t = this.sourceTexture(src);
    if (!t) return;
    const gl = this.gl;
    const vp = this.viewport(rect);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    const prog = this.program(`picture${t.u16 ? 16 : 8}`, QUAD_VS, PICTURE_FS(t.u16));
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    const { kr, kb } = LUMA[src.colorspace];
    gl.uniform1i(this.u(prog, 'uSrc'), 0);
    gl.uniform2i(this.u(prog, 'uSize'), t.w, t.h);
    gl.uniform1i(this.u(prog, 'uMode'), PICTURE_ID[p.mode]);
    gl.uniform2f(this.u(prog, 'uK'), kr, kb);
    gl.uniform1f(this.u(prog, 'uZebra'), p.zebra);
    gl.uniform1f(this.u(prog, 'uZebraLow'), p.zebraLow);
    const bands = new Float32Array(32);
    p.bands.slice(0, 8).forEach((b, i) => {
      const [r, g, bl] = hexToRgb(b.color).map((v) => Math.round(v * 255));
      bands.set([b.from / 100, b.to / 100, r * 65536 + g * 256 + bl, 0], i * 4);
    });
    gl.uniform4fv(this.u(prog, 'uBand'), bands);
    gl.uniform1i(this.u(prog, 'uBands'), Math.min(8, p.bands.length));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Fill a rect with the plot background colour. */
  clearRect(rect: Rect, rgb: [number, number, number] = [0, 0, 0]) {
    const gl = this.gl, vp = this.viewport(rect);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vp.x, vp.y, vp.w, vp.h);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }
}
