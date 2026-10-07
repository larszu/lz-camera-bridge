/**
 * The site file — everything the bridge knows about a room, in one JSON.
 *
 * Until now the camera slots lived in memory only: every bridge restart
 * meant typing the addresses again. A control room has the same cameras
 * every day, so the bridge now keeps its slots on disk (`persistence.ts`)
 * and can hand the whole room out as a file and take it back in.
 *
 * FORMAT `lz-site` v1:
 *
 *   {
 *     "kind": "lz-site", "formatVersion": 1,
 *     "name": "Conference room",
 *     "cameras":   [{ "cameraNumber": 1, "config": { …CameraConfig },   "autoConnect": true }],
 *     "switchers": [{ "switcherNumber": 1, "config": { …SwitcherConfig }, "autoConnect": true }]
 *   }
 *
 * Also read: the settings export of the predecessor application
 * (`av-control-center`, `version: 1, devices: [...]`), so an existing room
 * moves over with one import. Its `vissonic-ptz` / `sony-ptz` devices become
 * `http-cgi` cameras, its `vis-catc` becomes a switcher; RTSP address, login,
 * preset offset and the switcher input come along.
 *
 * Passwords are part of the file — it describes a room, and the room's
 * cameras need them. The file belongs next to the bridge, not in a
 * repository.
 */
import type { CameraConfig } from '../cameras/backendFactory.js';
import type { SwitcherConfig } from '../switcher/VisCatcClient.js';
import type { PlanCamera } from '../plan/cameraPlan.js';

export const SITE_KIND = 'lz-site';
export const SITE_FORMAT_VERSION = 1;

export interface SiteCamera {
  cameraNumber: number;
  config: CameraConfig;
  autoConnect?: boolean;
  /** The planned camera on this slot (label, heading, shots) — kept so planned presets survive a restart. */
  plan?: PlanCamera;
  planMatchedBy?: 'model' | 'number' | 'manual';
}

export interface SiteSwitcher {
  switcherNumber: number;
  config: SwitcherConfig;
  autoConnect?: boolean;
}

export interface SiteFile {
  kind: typeof SITE_KIND;
  formatVersion: number;
  name: string;
  cameras: SiteCamera[];
  switchers: SiteSwitcher[];
}

export function emptySite(name = ''): SiteFile {
  return { kind: SITE_KIND, formatVersion: SITE_FORMAT_VERSION, name, cameras: [], switchers: [] };
}

export class SiteParseError extends Error {}

/** Parse a site file — ours, or the predecessor's settings export. */
export function parseSite(text: string): SiteFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SiteParseError('Not a JSON file.');
  }
  if (!raw || typeof raw !== 'object') throw new SiteParseError('Not a site file.');
  const obj = raw as Record<string, unknown>;
  if (obj.kind === SITE_KIND) return normaliseSite(obj);
  if (Array.isArray(obj.devices)) return fromControlCenter(obj);
  throw new SiteParseError("Not a site file: expected 'lz-site' or an av-control-center settings export.");
}

function normaliseSite(obj: Record<string, unknown>): SiteFile {
  const version = Number(obj.formatVersion ?? 0);
  if (version > SITE_FORMAT_VERSION) throw new SiteParseError(`Site file version ${version} is newer than this bridge understands.`);
  const cameras = Array.isArray(obj.cameras) ? obj.cameras : [];
  const switchers = Array.isArray(obj.switchers) ? obj.switchers : [];
  const site = emptySite(typeof obj.name === 'string' ? obj.name : '');
  const seenCam = new Set<number>();
  for (const c of cameras as Record<string, unknown>[]) {
    const n = Number(c?.cameraNumber);
    if (!Number.isInteger(n) || n < 1 || seenCam.has(n) || !c.config || typeof c.config !== 'object') continue;
    seenCam.add(n);
    const plan = c.plan && typeof c.plan === 'object' && typeof (c.plan as PlanCamera).id === 'string' ? (c.plan as PlanCamera) : undefined;
    site.cameras.push({
      cameraNumber: n,
      config: c.config as CameraConfig,
      autoConnect: c.autoConnect !== false,
      ...(plan ? { plan, planMatchedBy: (['model', 'number', 'manual'] as const).find((m) => m === c.planMatchedBy) ?? 'manual' } : {}),
    });
  }
  const seenSw = new Set<number>();
  for (const s of switchers as Record<string, unknown>[]) {
    const n = Number(s?.switcherNumber);
    if (!Number.isInteger(n) || n < 1 || seenSw.has(n) || !s.config || typeof s.config !== 'object') continue;
    seenSw.add(n);
    site.switchers.push({ switcherNumber: n, config: s.config as SwitcherConfig, autoConnect: s.autoConnect !== false });
  }
  site.cameras.sort((a, b) => a.cameraNumber - b.cameraNumber);
  site.switchers.sort((a, b) => a.switcherNumber - b.switcherNumber);
  return site;
}

/** av-control-center `Settings` → site. Order of devices becomes the numbering. */
function fromControlCenter(obj: Record<string, unknown>): SiteFile {
  const site = emptySite(typeof obj.installationName === 'string' ? obj.installationName : '');
  let cam = 0;
  let sw = 0;
  for (const d of obj.devices as Record<string, unknown>[]) {
    if (!d || typeof d !== 'object') continue;
    const kind = String(d.kind ?? '');
    const host = typeof d.host === 'string' ? d.host : '';
    const label = typeof d.name === 'string' ? d.name : undefined;
    if (kind === 'vissonic-ptz' || kind === 'sony-ptz') {
      cam += 1;
      const family = kind === 'sony-ptz' ? 'sony' : 'vissonic';
      const config: CameraConfig = {
        connectionMode: 'http-cgi',
        cgiFamily: family,
        camHost: host,
        camPort: numberOr(d.httpPort, 80),
        ccuId: cam,
        label,
      };
      if (typeof d.username === 'string' && d.username) config.camUser = d.username;
      if (typeof d.password === 'string' && d.password) config.camPass = d.password;
      if (typeof d.presetOffset === 'number') config.cgiPresetOffset = d.presetOffset;
      if (typeof d.rtspUrl === 'string' && d.rtspUrl) config.streamUrl = d.rtspUrl;
      const input = numberOr(d.switcherInput, 0);
      if (input > 0) config.switcherInput = input;
      site.cameras.push({ cameraNumber: cam, config, autoConnect: true });
    } else if (kind === 'vis-catc') {
      sw += 1;
      const serial = (d.serial && typeof d.serial === 'object' ? d.serial : {}) as Record<string, unknown>;
      const config: SwitcherConfig = {
        kind: 'vis-catc',
        label,
        host,
        port: numberOr(d.httpPort, 80),
        path: obj.switcherPath === 'serial' ? 'serial' : 'http',
        inputLabels: Array.isArray(d.inputLabels) ? d.inputLabels.map(String) : undefined,
        pgmWindow: typeof obj.pgmWindow === 'number' ? obj.pgmWindow : undefined,
        serial: {
          transport: serial.transport === 'tcp' || serial.transport === 'port' ? serial.transport : 'none',
          host: typeof serial.host === 'string' ? serial.host : undefined,
          port: numberOr(serial.port, 4001),
          devicePath: typeof serial.devicePath === 'string' ? serial.devicePath : undefined,
          baudRate: numberOr(serial.baudRate, 9600),
        },
      };
      site.switchers.push({ switcherNumber: sw, config, autoConnect: true });
    }
  }
  return site;
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The SSH password of a sony-ptpip camera never goes to disk: site.json is
 * plain text, and that password opens the camera to anyone on the network.
 * User and confirmed fingerprint stay; after a restart the password is
 * entered again.
 */
export function serialiseSite(site: SiteFile): string {
  const safe: SiteFile = {
    ...site,
    cameras: site.cameras.map((c) =>
      c.config.connectionMode === 'sony-ptpip' && c.config.camPass ? { ...c, config: { ...c.config, camPass: undefined } } : c,
    ),
  };
  return JSON.stringify(safe, null, 2) + '\n';
}
