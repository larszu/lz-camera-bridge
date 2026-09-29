/**
 * Scopes for the video tiles — RTSP in, raw R'G'B' frames out.
 *
 * `WS /scope/<n>` speaks the LZ Scopes frame protocol (larszu/lz-scopes,
 * `docs/frame-protocol.md`): one text message `{type:'info', …}`, then one
 * binary message per picture (`width × height × 4` samples, Uint8 or
 * Uint16 LE), `{type:'stats'}` once a second, `{type:'error'|'end'}` before
 * the bridge closes. The browser side is `packages/web-rcp/src/vendor/lz-scopes`.
 *
 * WHY NOT THE MJPEG HUB. A scope measures levels; a JPEG re-quantises them
 * and its chroma subsampling smears the vectorscope. So every open scope
 * gets its OWN ffmpeg that decodes to raw RGBA, and only while the client is
 * connected. The shared MJPEG hub (RtspHub.ts) stays untouched.
 *
 * THE MATRIX IS SET EXPLICITLY. swscale assumes BT.601 for untagged input,
 * and most HD cameras do not tag their H.264 — a wrong matrix shifts every
 * hue on the vectorscope. `decodeParams` decides: tagged value first, then
 * BT.709 above SD and BT.601 for SD. The transfer function is left alone, so
 * PQ/HLG code values arrive unchanged.
 *
 * As with the tiles, the client sends a camera NUMBER, never an address.
 */
import { spawn, type ChildProcess } from 'child_process';
import { basename, dirname, join } from 'path';
import { WebSocket } from 'ws';
import { ffmpegCandidates, inputFlags } from './RtspHub.js';

export interface StreamProbe {
  width: number;
  height: number;
  codec?: string;
  pixFmt?: string;
  fps: number;
  transfer: string;
  primaries: string;
  matrix: string;
  range: string;
}

export interface ScopeQuery {
  depth: 8 | 16;
  width: number;
  fps: number;
}

export const SCOPE_WIDTH = 960;
/** One scope = one ffmpeg = one RTSP session. Cameras often allow only a few. */
export const MAX_SCOPES = 4;
const PROBE_TIMEOUT_MS = 15000;
/** 1 s / 2 MB instead of ffmpeg's 5 s: first frame after 3.0 s instead of 4.5 s (measured 2026-09-29, 1080p25 over RTSP). */
const FAST_PROBE = ['-analyzeduration', '1000000', '-probesize', '2000000'];

export function parseScopeQuery(params: URLSearchParams): ScopeQuery {
  const depth = params.get('depth') === '16' ? 16 : 8;
  const raw = params.get('width');
  const width = raw === null ? SCOPE_WIDTH : Math.min(3840, Math.max(0, Math.round(Number(raw)) || 0));
  const fps = Math.min(60, Math.max(0, Math.round(Number(params.get('fps') ?? 0)) || 0));
  return { depth, width, fps };
}

/** Matrix and range for the Y'CbCr → R'G'B' step; see the header. */
export function decodeParams(info: Pick<StreamProbe, 'matrix' | 'range' | 'height'>): { decodeMatrix: string; decodeRange: 'full' | 'limited' } {
  const m = String(info.matrix ?? '');
  const decodeMatrix = m.startsWith('bt2020') ? 'bt2020'
    : m === 'bt709' ? 'bt709'
      : m === 'smpte170m' || m === 'bt470bg' ? 'bt601'
        : m === 'smpte240m' ? 'smpte240m'
          : info.height > 576 ? 'bt709' : 'bt601';
  return { decodeMatrix, decodeRange: info.range === 'pc' ? 'full' : 'limited' };
}

/** Fit into maxWidth keeping the aspect, even dimensions. 0 = native size. */
export function outputSize(w: number, h: number, maxWidth: number): { width: number; height: number } {
  if (!w || !h) return { width: 960, height: 540 };
  const width = maxWidth > 0 && w > maxWidth ? maxWidth : w;
  const height = Math.round((h * width) / w);
  return { width: width & ~1, height: Math.max(2, height & ~1) };
}

export function scopeArgs(
  url: string,
  o: { width: number; height: number; depth: 8 | 16; fps: number; decodeMatrix: string; decodeRange: string },
): string[] {
  const vf = [`scale=${o.width}:${o.height}:flags=area:in_color_matrix=${o.decodeMatrix}:in_range=${o.decodeRange}`];
  if (o.fps) vf.push(`fps=${o.fps}`);
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', 'nobuffer', '-flags', 'low_delay', ...FAST_PROBE,
    ...inputFlags(url),
    '-i', url,
    '-an', '-sn', '-dn', '-map', '0:v:0',
    '-vf', vf.join(','),
    '-pix_fmt', o.depth === 16 ? 'rgba64le' : 'rgba',
    '-f', 'rawvideo', 'pipe:1',
  ];
}

export function ffprobeArgs(url: string): string[] {
  return [
    '-v', 'error', ...FAST_PROBE, ...inputFlags(url), '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,codec_name,avg_frame_rate,r_frame_rate,color_transfer,color_primaries,color_space,color_range,pix_fmt',
    '-of', 'json', '-i', url,
  ];
}

const rate = (r: unknown) => {
  const [n, d] = String(r ?? '0/1').split('/').map(Number);
  return d ? n / d : 0;
};

export function parseFfprobeJson(out: string): StreamProbe | null {
  let s: Record<string, unknown> | undefined;
  try {
    s = JSON.parse(out).streams?.[0];
  } catch {
    return null;
  }
  if (!s || !s.width || !s.height) return null;
  return {
    width: Number(s.width), height: Number(s.height),
    codec: s.codec_name as string | undefined, pixFmt: s.pix_fmt as string | undefined,
    fps: Math.round((rate(s.avg_frame_rate) || rate(s.r_frame_rate)) * 100) / 100,
    transfer: (s.color_transfer as string) ?? 'unknown', primaries: (s.color_primaries as string) ?? 'unknown',
    matrix: (s.color_space as string) ?? 'unknown', range: (s.color_range as string) ?? 'unknown',
  };
}

/**
 * The same facts from ffmpeg's own stream banner — for installs without
 * ffprobe (the desktop app bundles ffmpeg only). The colour part reads
 * `yuv420p(tv, bt709, progressive)` when matrix, primaries and transfer agree
 * and `yuv420p10le(tv, bt2020nc/bt2020/smpte2084)` when they do not.
 */
export function parseFfmpegBanner(stderr: string): StreamProbe | null {
  const line = stderr.split('\n').find((l) => /Stream #\d+:\d+.*: Video: /.test(l));
  if (!line) return null;
  const size = /,\s*(\d{2,5})x(\d{2,5})\b/.exec(line);
  if (!size) return null;
  const codec = /Video: ([\w-]+)/.exec(line)?.[1];
  const fmt = /Video: [^,]+,\s*([\w]+)(?:\(([^)]*)\))?/.exec(line);
  let range = 'unknown', matrix = 'unknown', primaries = 'unknown', transfer = 'unknown';
  for (const part of (fmt?.[2] ?? '').split(',').map((p) => p.trim())) {
    if (part === 'tv' || part === 'pc') range = part;
    else if (/^[\w-]+\/[\w-]+\/[\w-]+$/.test(part)) [matrix, primaries, transfer] = part.split('/');
    else if (/^(bt|smpte|arib|iec|gbr|ycgco|fcc|bt470)/.test(part)) matrix = primaries = transfer = part;
  }
  const fps = Number(/([\d.]+) fps/.exec(line)?.[1] ?? /([\d.]+) tbr/.exec(line)?.[1] ?? 0);
  return { width: Number(size[1]), height: Number(size[2]), codec, pixFmt: fmt?.[1], fps, transfer, primaries, matrix, range };
}

/** ffprobe next to the ffmpeg that was found, then PATH. */
export function ffprobeCandidates(ffmpegs: string[], env = process.env): string[] {
  const list: string[] = [];
  if (env.LZ_BRIDGE_FFPROBE) list.push(env.LZ_BRIDGE_FFPROBE);
  for (const f of ffmpegs) {
    const name = basename(f);
    if (f !== name && /^ffmpeg(\.exe)?$/.test(name)) list.push(join(dirname(f), name.replace('ffmpeg', 'ffprobe')));
  }
  list.push('ffprobe');
  return [...new Set(list)];
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string } | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-8000); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Size and colour tags of the first video stream: ffprobe, else ffmpeg's banner. */
export async function probeStream(url: string, ffmpegs = ffmpegCandidates()): Promise<{ probe: StreamProbe; ffmpeg: string }> {
  for (const ffprobe of ffprobeCandidates(ffmpegs)) {
    const r = await run(ffprobe, ffprobeArgs(url), PROBE_TIMEOUT_MS);
    if (!r) continue;
    const p = parseFfprobeJson(r.out);
    if (p) return { probe: p, ffmpeg: ffmpegs[0] };
    // ffprobe ran and could not open the stream: asking ffmpeg would only wait for the same timeout.
    throw new Error(r.err.trim().split('\n').pop() || 'Stream could not be opened.');
  }
  for (const ffmpeg of ffmpegs) {
    // Without an output ffmpeg prints the input banner and exits.
    const r = await run(ffmpeg, ['-hide_banner', ...FAST_PROBE, ...inputFlags(url), '-i', url], PROBE_TIMEOUT_MS);
    if (!r) continue;
    const p = parseFfmpegBanner(r.err);
    if (p) return { probe: p, ffmpeg };
    const last = r.err.trim().split('\n').filter((l) => !/output file/i.test(l)).pop();
    throw new Error(last || 'Stream could not be opened.');
  }
  throw new Error('ffmpeg not found — install it or put it into ffmpeg-portable/.');
}

/**
 * Run one scope on an open WebSocket until either side ends. Returns once
 * ffmpeg has started (or failed); cleanup hangs on the socket's close.
 */
export async function runScope(ws: WebSocket, url: string, query: ScopeQuery, ffmpegs = ffmpegCandidates()): Promise<void> {
  let probed: { probe: StreamProbe; ffmpeg: string };
  try {
    probed = await probeStream(url, ffmpegs);
  } catch (e) {
    sendFinal(ws, 'error', (e as Error).message);
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  const info = probed.probe;
  const { width, height } = outputSize(info.width, info.height, query.width);
  const { decodeMatrix, decodeRange } = decodeParams(info);
  const bytesPerFrame = width * height * 4 * (query.depth / 8);

  let child: ChildProcess;
  try {
    child = spawn(probed.ffmpeg, scopeArgs(url, { width, height, depth: query.depth, fps: query.fps, decodeMatrix, decodeRange }), {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    sendFinal(ws, 'error', `ffmpeg could not start: ${(e as Error).message}`);
    return;
  }

  ws.send(JSON.stringify({
    type: 'info', ...info, decodeMatrix, sourceWidth: info.width, sourceHeight: info.height,
    width, height, depth: query.depth, fps: query.fps || info.fps,
  }));

  let pending: Buffer[] = [], pendingBytes = 0, sent = 0, dropped = 0, stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes >= bytesPerFrame) {
      const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      const frame = all.subarray(0, bytesPerFrame);
      const rest = all.subarray(bytesPerFrame);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
      // Drop instead of queueing when the browser falls behind: a scope wants the newest picture.
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < bytesPerFrame * 2) {
        ws.send(frame, { binary: true });
        sent++;
      } else dropped++;
    }
  });
  child.stdout?.on('error', () => {});
  child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  child.stderr?.on('error', () => {});
  child.once('error', (e) => sendFinal(ws, 'error', `ffmpeg could not start: ${e.message}`));
  child.once('close', (code) => {
    clearInterval(stats);
    sendFinal(ws, code === 0 ? 'end' : 'error', stderr.trim().split('\n').pop() || `ffmpeg exited (${code})`);
  });
  const stats = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stats', sent, dropped }));
  }, 1000);
  ws.once('close', () => {
    clearInterval(stats);
    child.kill('SIGKILL');
  });
}

export function sendFinal(ws: WebSocket, type: 'error' | 'end', message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, message }));
  ws.close();
}
