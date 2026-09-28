/**
 * Where the bridge keeps its site between restarts.
 *
 * `LZ_BRIDGE_CONFIG_DIR` names the directory (the desktop app points it at
 * the user-data folder); without it, `~/.lz-camera-bridge`. The file is
 * `site.json`, written whole and atomically (temp file + rename), debounced
 * so that dragging a slider through twenty config changes writes once.
 *
 * Writing never throws into the bridge: a read-only disk must not take the
 * cameras down. It is logged, once per failure, and the bridge carries on
 * with what it has in memory.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseSite, serialiseSite, type SiteFile } from './siteFile.js';

export function configDir(env = process.env): string {
  return env.LZ_BRIDGE_CONFIG_DIR || join(homedir(), '.lz-camera-bridge');
}

export class SitePersistence {
  readonly path: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SiteFile | null = null;
  private lastError: string | null = null;

  constructor(dir = configDir(), private readonly debounceMs = 400) {
    this.path = join(dir, 'site.json');
  }

  /** The saved site, or null when there is none or it is unreadable. */
  load(): SiteFile | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return null;
    }
    try {
      return parseSite(text);
    } catch (err) {
      console.warn(`[Site] ${this.path} is unreadable: ${(err as Error).message}`);
      return null;
    }
  }

  save(site: SiteFile): void {
    this.pending = site;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Write now. Called on stop so that nothing is lost to the debounce. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const site = this.pending;
    this.pending = null;
    if (!site) return;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, serialiseSite(site), 'utf8');
      renameSync(tmp, this.path);
      this.lastError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastError) console.warn(`[Site] could not write ${this.path}: ${message}`);
      this.lastError = message;
    }
  }
}
