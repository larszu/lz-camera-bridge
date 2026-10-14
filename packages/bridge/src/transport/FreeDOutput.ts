/**
 * FreeD tracking out of every camera that reports its pose.
 *
 * One stream per enabled camera: a poll loop asks the backend for its pose
 * (`readPose` with focus), a `PoseInterpolator` draws the pose at send time,
 * `poseToFreeD` turns it into a sample, and a `FreeDSender` puts one D1 packet
 * per tick on the wire to every target of the site. Byte layout in
 * `protocol/FreeD.ts`, mapping in `protocol/freeDPose.ts`, setup in
 * `docs/freed-tracking.md`.
 *
 * The bridge owns the cameras; this class only gets told which ones exist
 * (`sync`) and what the site wants (`configure`). It never connects a camera.
 *
 * Losing a camera — read errors, disconnect, a read older than the stale
 * limit — makes its stream silent, not frozen (see PoseInterpolator).
 */
import type { FreeDSample } from '../protocol/FreeD.js';
import {
  FREED_DEFAULT_POLL_MS,
  freeDCameraId,
  PoseInterpolator,
  poseToFreeD,
  type FreeDCameraConfig,
  type FreeDSiteConfig,
  type PoseRead,
} from '../protocol/freeDPose.js';
import { createFreeDSender, type FreeDSender } from './FreeDSender.js';

export interface FreeDCameraSource {
  cameraNumber: number;
  freed?: FreeDCameraConfig;
  connected: boolean;
  /** The camera's backend; its identity marks a reconnect. */
  backend: { readPose?(opts?: { focus?: boolean }): Promise<PoseRead> } | null;
}

export interface FreeDCameraStatus {
  cameraNumber: number;
  cameraId: number;
  /** Packets sent since the stream started. */
  sent: number;
  /** Ticks that sent nothing: no pose yet, or the pose went stale. */
  silent: number;
  errors: number;
  /** Age of the latest pose read in ms, null before the first. */
  readAgeMs: number | null;
  /** Lens axes the camera does not report (sent as 0). */
  unread: ('zoom' | 'focus')[];
  lastError?: string;
}

export interface FreeDStatus {
  active: boolean;
  cameras: FreeDCameraStatus[];
}

interface Stream {
  key: string;
  num: number;
  cfg: FreeDCameraConfig;
  sender: FreeDSender;
  interp: PoseInterpolator;
  running: boolean;
  unread: ('zoom' | 'focus')[];
  lastError?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FreeDOutput {
  private site: FreeDSiteConfig | null = null;
  private readonly streams = new Map<number, Stream>();
  private lastSources: FreeDCameraSource[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  get siteConfig(): FreeDSiteConfig | null {
    return this.site;
  }

  /** Replace the site settings; running streams restart with them. */
  configure(site: FreeDSiteConfig | null): void {
    this.site = site;
    this.sync(this.lastSources);
  }

  /** The cameras as they are now. Starts, restarts and stops streams to match. */
  sync(sources: FreeDCameraSource[]): void {
    this.lastSources = sources;
    const want = new Map<number, FreeDCameraSource>();
    if (this.site && this.site.targets.length > 0) {
      for (const s of sources) {
        if (s.freed?.enabled && s.connected && s.backend?.readPose) want.set(s.cameraNumber, s);
      }
    }
    for (const [num, stream] of this.streams) {
      const s = want.get(num);
      if (!s || this.keyOf(s) !== stream.key) this.stopStream(num);
    }
    for (const [num, s] of want) {
      if (!this.streams.has(num)) this.startStream(s);
    }
  }

  status(): FreeDStatus {
    const t = this.now();
    const cameras = [...this.streams.values()].sort((a, b) => a.num - b.num).map((s) => {
      const at = s.interp.lastReadAt;
      return {
        cameraNumber: s.num,
        cameraId: freeDCameraId(s.cfg, s.num),
        sent: s.sender.stats.sent,
        silent: s.sender.stats.skippedNoSample + s.sender.stats.skippedIncomplete,
        errors: s.sender.stats.errors,
        readAgeMs: at === null ? null : Math.max(0, t - at),
        unread: [...s.unread],
        ...(s.lastError ? { lastError: s.lastError } : {}),
      };
    });
    return { active: cameras.length > 0, cameras };
  }

  stop(): void {
    for (const num of [...this.streams.keys()]) this.stopStream(num);
  }

  private keyOf(s: FreeDCameraSource): string {
    // Anything that changes the stream restarts it; a new backend object is a
    // reconnect, which is exactly when a fresh start is right.
    return `${JSON.stringify({ site: this.site, cfg: s.freed })}#${this.backendId(s.backend!)}`;
  }

  private readonly backendIds = new WeakMap<object, number>();
  private backendSeq = 0;
  private backendId(b: object): number {
    let id = this.backendIds.get(b);
    if (id === undefined) {
      this.backendSeq += 1;
      id = this.backendSeq;
      this.backendIds.set(b, id);
    }
    return id;
  }

  private startStream(src: FreeDCameraSource): void {
    const site = this.site!;
    const pollMs = site.pollMs ?? FREED_DEFAULT_POLL_MS;
    const interp = new PoseInterpolator(Math.max(1000, pollMs * 5));
    const cfg = src.freed!;
    const num = src.cameraNumber;
    const sampleAt = (): FreeDSample | null => {
      const pose = interp.at(this.now());
      return pose ? poseToFreeD(pose, cfg, num).sample : null;
    };
    const stream: Stream = {
      key: this.keyOf(src),
      num,
      cfg,
      interp,
      running: true,
      unread: [],
      timer: null,
      sender: createFreeDSender({
        targets: site.targets,
        rateHz: site.rateHz,
        sampleAt,
        onError: (err) => { stream.lastError = err.message; },
      }),
    };
    this.streams.set(num, stream);
    stream.sender.start();

    const backend = src.backend!;
    const loop = async (): Promise<void> => {
      if (!stream.running) return;
      const started = this.now();
      try {
        const pose = await backend.readPose!({ focus: true });
        if (!stream.running) return;
        interp.push(this.now(), pose);
        stream.unread = poseToFreeD(pose, cfg, num).unread;
        stream.lastError = undefined;
      } catch (err) {
        stream.lastError = (err as Error).message;
      }
      if (!stream.running) return;
      const wait = Math.max(0, pollMs - (this.now() - started));
      stream.timer = setTimeout(() => void loop(), wait);
      stream.timer.unref?.();
    };
    void loop();
  }

  private stopStream(num: number): void {
    const s = this.streams.get(num);
    if (!s) return;
    s.running = false;
    if (s.timer) clearTimeout(s.timer);
    s.sender.stop();
    s.interp.clear();
    this.streams.delete(num);
  }
}
