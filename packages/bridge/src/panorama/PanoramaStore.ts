/**
 * Where the panorama maps live: `<config dir>/panorama/cam-<n>.jpg` with its
 * `.json` beside it (extent, resolution, scan zoom). Without a directory
 * (tests, persistence off) they stay in memory for the life of the bridge.
 *
 * As with the site file, a failed write never throws into the bridge: the map
 * stays in memory and the failure is logged.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MapExtent } from '../protocol/frameAim.js';

export interface PanoramaMeta extends MapExtent {
  cameraNumber: number;
  width: number;
  height: number;
  pxPerDeg: number;
  /** Zoom position and field of view the pictures were taken with. */
  zoom: number;
  hfovDeg: number;
  /** Where that field of view came from (`FovFit`). */
  fit: string;
  /** Picture aspect of the camera, width / height. */
  aspect: number;
  pictures: number;
  createdAt: string;
}

export class PanoramaStore {
  private readonly cache = new Map<number, { meta: PanoramaMeta; jpeg: Buffer }>();

  constructor(private readonly dir: string | null) {}

  private paths(num: number) {
    const base = join(this.dir!, 'panorama', `cam-${num}`);
    return { jpg: `${base}.jpg`, json: `${base}.json` };
  }

  save(meta: PanoramaMeta, jpeg: Buffer): void {
    this.cache.set(meta.cameraNumber, { meta, jpeg });
    if (!this.dir) return;
    const p = this.paths(meta.cameraNumber);
    try {
      mkdirSync(join(this.dir, 'panorama'), { recursive: true });
      writeFileSync(`${p.jpg}.tmp`, jpeg);
      renameSync(`${p.jpg}.tmp`, p.jpg);
      writeFileSync(`${p.json}.tmp`, JSON.stringify(meta, null, 2), 'utf8');
      renameSync(`${p.json}.tmp`, p.json);
    } catch (err) {
      console.warn(`[Panorama] could not write ${p.jpg}: ${(err as Error).message}`);
    }
  }

  get(num: number): { meta: PanoramaMeta; jpeg: Buffer } | null {
    const hit = this.cache.get(num);
    if (hit || !this.dir) return hit ?? null;
    const p = this.paths(num);
    try {
      const meta = JSON.parse(readFileSync(p.json, 'utf8')) as PanoramaMeta;
      const jpeg = readFileSync(p.jpg);
      if (meta.cameraNumber !== num || !(meta.panMax > meta.panMin)) return null;
      const entry = { meta, jpeg };
      this.cache.set(num, entry);
      return entry;
    } catch {
      return null;
    }
  }
}
