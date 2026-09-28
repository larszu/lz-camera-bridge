/**
 * Live picture for the camera tiles — RTSP in, JPEG frames out.
 *
 * A browser cannot play RTSP (`docs/live-video.md`). The bridge therefore
 * runs one ffmpeg per stream that scales the picture down and emits
 * `mpjpeg`; the frames go to every subscriber, and the HTTP side serves them
 * as `multipart/x-mixed-replace`, which any `<img>` shows without a player.
 *
 * ONE ffmpeg PER STREAM, shared by every tile in every window. Two windows do
 * not mean two RTSP sessions — some cameras allow only a few. When ffmpeg
 * dies while somebody is watching, the hub restarts it with a growing pause;
 * after the last tile closes it keeps running for a few seconds (switching
 * views, reloading) and is then killed.
 *
 * The stream address stays in the bridge. Clients ask for a CAMERA NUMBER,
 * never for a URL — so a stream login is neither in the page source nor in
 * the browser history, and a page cannot make the bridge fetch an arbitrary
 * address. (The predecessor put `rtsp://user:pass@…` into the WebSocket
 * query string.)
 *
 * ffmpeg is found in this order: `LZ_BRIDGE_FFMPEG` (the desktop app sets it
 * to the bundled binary), `ffmpeg-portable/` next to the bridge, then PATH.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface FrameSubscriber {
  frame(jpeg: Buffer): void;
  error(reason: string): void;
}

export interface HubOptions {
  width?: number;
  fps?: number;
  /** ms ffmpeg keeps running after the last subscriber left. */
  idleStopMs?: number;
  candidates?: string[];
}

const TILE_WIDTH = 960;
const TILE_FPS = 12;
const IDLE_STOP_MS = 5000;

export function ffmpegCandidates(env = process.env, root = process.cwd(), os = process.platform): string[] {
  const exe = os === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list: string[] = [];
  if (env.LZ_BRIDGE_FFMPEG) list.push(env.LZ_BRIDGE_FFMPEG);
  const portable = join(root, 'ffmpeg-portable', exe);
  if (existsSync(portable)) list.push(portable);
  list.push('ffmpeg');
  return list;
}

export function mjpegArgs(url: string, width = TILE_WIDTH, fps = TILE_FPS): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-rtsp_transport', 'tcp',
    // Socket limit in microseconds: a camera in standby must not hang a tile for minutes.
    '-timeout', '5000000',
    '-i', url,
    '-an',
    '-vf', `scale=${width}:-2`,
    '-r', String(fps),
    '-q:v', '6',
    '-f', 'mpjpeg',
    '-',
  ];
}

/**
 * Splits ffmpeg's mpjpeg output into single JPEGs. Every part carries a
 * Content-length, followed by exactly that many bytes. Chunks arrive at
 * arbitrary boundaries, so the parser keeps what it has not finished.
 */
export function createMjpegParser(onFrame: (jpeg: Buffer) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > 64 * 1024) buffer = Buffer.alloc(0);
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString('latin1');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      onFrame(Buffer.from(buffer.subarray(start, start + length)));
      buffer = buffer.subarray(start + length);
    }
  };
}

/** Only rtsp:// on a private network — the bridge must not become a relay for the internet. */
export function checkStreamUrl(raw: string, allowAnyHost = false): string | null {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return 'Not a valid stream address.';
  }
  if (!/^rtsps?:$/.test(target.protocol)) return 'Only rtsp:// streams can be shown.';
  if (!allowAnyHost && !isPrivateHost(target.hostname)) return `${target.hostname} is outside the private networks.`;
  return null;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

interface Hub {
  url: string;
  subscribers: Set<FrameSubscriber>;
  lastFrame: Buffer | null;
  lastError: string | null;
  child: ChildProcess | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
}

export class RtspHub {
  private hubs = new Map<string, Hub>();
  private working: string | null = null;
  private readonly width: number;
  private readonly fps: number;
  private readonly idleStopMs: number;
  private readonly candidates: string[] | null;

  constructor(opts: HubOptions = {}) {
    this.width = opts.width ?? TILE_WIDTH;
    this.fps = opts.fps ?? TILE_FPS;
    this.idleStopMs = opts.idleStopMs ?? IDLE_STOP_MS;
    this.candidates = opts.candidates ?? null;
  }

  /** How many streams are running right now. */
  get activeCount(): number {
    let n = 0;
    for (const h of this.hubs.values()) if (h.child) n++;
    return n;
  }

  lastFrame(url: string): Buffer | null {
    return this.hubs.get(url)?.lastFrame ?? null;
  }

  subscribe(url: string, subscriber: FrameSubscriber): () => void {
    const hub = this.get(url);
    if (hub.stopTimer) {
      clearTimeout(hub.stopTimer);
      hub.stopTimer = null;
    }
    hub.subscribers.add(subscriber);
    if (hub.lastFrame) subscriber.frame(hub.lastFrame);
    else if (hub.lastError) subscriber.error(hub.lastError);
    this.start(hub);
    return () => {
      hub.subscribers.delete(subscriber);
      if (hub.subscribers.size > 0 || hub.stopTimer) return;
      hub.stopTimer = setTimeout(() => {
        hub.stopTimer = null;
        if (hub.subscribers.size > 0) return;
        this.kill(hub);
        this.hubs.delete(url);
      }, this.idleStopMs);
    };
  }

  /** Kill every ffmpeg. Called when the bridge stops — a child left behind keeps the camera's RTSP slot. */
  stopAll(): void {
    for (const hub of this.hubs.values()) {
      if (hub.stopTimer) clearTimeout(hub.stopTimer);
      this.kill(hub);
      for (const s of hub.subscribers) s.error('bridge stopped');
      hub.subscribers.clear();
    }
    this.hubs.clear();
  }

  private get(url: string): Hub {
    let hub = this.hubs.get(url);
    if (!hub) {
      hub = { url, subscribers: new Set(), lastFrame: null, lastError: null, child: null, stopTimer: null, retryTimer: null, backoffMs: 1000 };
      this.hubs.set(url, hub);
    }
    return hub;
  }

  private kill(hub: Hub): void {
    if (hub.retryTimer) clearTimeout(hub.retryTimer);
    hub.retryTimer = null;
    hub.child?.kill('SIGKILL');
    hub.child = null;
  }

  private start(hub: Hub, candidates?: string[], index = 0): void {
    if (hub.child || hub.subscribers.size === 0) return;
    const list = candidates ?? (this.working ? [this.working] : this.candidates ?? ffmpegCandidates());
    const binary = list[index];
    if (!binary) {
      this.fail(hub, 'ffmpeg not found — install it or put it into ffmpeg-portable/.');
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(binary, mjpegArgs(hub.url, this.width, this.fps), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      this.start(hub, list, index + 1);
      return;
    }
    hub.child = child;
    let stderr = '';
    let spawnFailed = false;
    const parse = createMjpegParser((frame) => {
      this.working = binary;
      hub.lastFrame = frame;
      hub.lastError = null;
      hub.backoffMs = 1000;
      for (const s of hub.subscribers) s.frame(frame);
    });
    child.stdout?.on('data', parse);
    child.stdout?.on('error', () => {});
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.stderr?.on('error', () => {});
    child.once('error', () => {
      // Not startable (missing, wrong architecture): next candidate.
      spawnFailed = true;
      if (hub.child === child) hub.child = null;
      this.start(hub, list, index + 1);
    });
    child.once('exit', (code) => {
      if (hub.child === child) hub.child = null;
      if (spawnFailed) return;
      const reason = stderr.trim().split('\n').pop() || `ffmpeg exited (${code})`;
      if (hub.subscribers.size > 0) this.fail(hub, reason);
    });
  }

  private fail(hub: Hub, reason: string): void {
    hub.lastError = reason;
    hub.lastFrame = null;
    for (const s of hub.subscribers) s.error(reason);
    if (hub.subscribers.size === 0 || hub.retryTimer) return;
    hub.retryTimer = setTimeout(() => {
      hub.retryTimer = null;
      this.start(hub);
    }, hub.backoffMs);
    hub.backoffMs = Math.min(15000, hub.backoffMs * 2);
  }
}
