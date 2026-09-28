/**
 * Vissonic VIS-CATC — the wire vocabulary of a one-output video switcher
 * with a built-in multi-image display.
 *
 * Two transports carry the same verbs, and this module is the pure part of
 * both: it builds request bodies and serial strings and reads replies. It
 * touches no socket, so every line of it is unit-testable.
 *
 * NETWORK (taken from the device's own page, VIS-CATC.html): everything is a
 * `POST /` with a form-urlencoded body and a JSON-ish answer.
 *
 *   param=<q>V<w>     source q into window w (1..6 → 1..4)
 *   param=mode<n>     picture layout of the output (0..11)
 *   param=audio<n>    audio source (0..3)
 *   param=status      → out1..out4 (= windows 1..4), mode, audio
 *   param=inputinfo   → signal detection per input
 *   param=version     → firmware
 *   param=netInfo     → ip, gateway, subnet, mac
 *
 * The device has exactly ONE video output: both HDMI sockets and the UVC
 * output carry the same picture. `out1..out4` are the windows inside that
 * picture, not separate outputs — which is why the UI calls them "targets".
 *
 * SERIAL (manual VIS-CATC-B §6.3, RS-232 9600 8N1):
 *
 *   [x]V[y].            video switch, reply `V:[x] -> [y]`
 *   <#Splice_mode[x]>   layout 0..11, reply `<Splice_mode[x]>`
 *   <#Audio_chn[x]>     audio channel, reply `<Audio_chn[x]>`
 *   FREEZE[x].          freeze time in seconds (1..6), reply `FREEZE[x].`
 *   SetFreeze.          trigger the freeze
 *   <^NET>              query network, reply `<SPORT…><SIPR…><GAR…><SUBR…><SHAR…>`
 *
 * The manual documents the video switch for RS-232 and the front panel; the
 * web page issues the same verbs over HTTP (`param=3V1` is `3V1.`). Both
 * work on the units measured so far; the route is a per-site choice.
 */

export const SOURCE_COUNT = 6;
export const WINDOW_COUNT = 4;
export const LAYOUT_COUNT = 12;
export const AUDIO_COUNT = 4;

/** Source numbers as the device counts them, with the labels of its sockets. */
export const DEFAULT_INPUT_LABELS = ['HDMI-1', 'HDMI-2', 'SDI-1', 'SDI-2', 'SDI-3', 'SDI-4'];

export const SERIAL_DEFAULTS = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 } as const;

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ── Network ────────────────────────────────────────────────────────────────────

export interface FormRequest {
  path: '/';
  method: 'POST';
  contentType: string;
  body: string;
}

const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

/**
 * The device expects the order and encoding of its own page: plain
 * key=value&key=value with NO escaping of values. `URLSearchParams` would
 * escape the dots of an IP address and the switcher answers with nothing.
 */
function form(params: Record<string, string>): FormRequest {
  const body = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return { path: '/', method: 'POST', contentType: CONTENT_TYPE, body };
}

/** Put source `source` into window `window`. Both 1-based. */
export function httpRoute(source: number, window: number): FormRequest {
  return form({ param: `${clampInt(source, 1, SOURCE_COUNT)}V${clampInt(window, 1, WINDOW_COUNT)}` });
}
export function httpLayout(mode: number): FormRequest {
  return form({ param: `mode${clampInt(mode, 0, LAYOUT_COUNT - 1)}` });
}
export function httpAudio(audio: number): FormRequest {
  return form({ param: `audio${clampInt(audio, 0, AUDIO_COUNT - 1)}` });
}
export const httpStatus = (): FormRequest => form({ param: 'status' });
export const httpInputInfo = (): FormRequest => form({ param: 'inputinfo' });
export const httpVersion = (): FormRequest => form({ param: 'version' });
export const httpNetInfo = (): FormRequest => form({ param: 'netInfo' });

export interface SwitcherStatus {
  /** window number → source number */
  outputs: Record<number, number>;
  mode: number;
  audio: number;
}

/** Reply of `param=status`. */
export function parseStatus(raw: string): SwitcherStatus | null {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const outputs: Record<number, number> = {};
  for (let i = 1; i <= 8; i++) {
    const value = data[`out${i}`];
    if (value !== undefined) outputs[i] = toInt(value);
  }
  if (Object.keys(outputs).length === 0) return null;
  return { outputs, mode: toInt(data.mode), audio: toInt(data.audio) };
}

/** Reply of `param=inputinfo`: "true"/"false" per input name. */
export function parseInputInfo(raw: string): Record<string, boolean> | null {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = value === true || value === 'true' || value === 1 || value === '1';
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function parseVersion(raw: string): string | null {
  const data = parseJsonLoose(raw);
  const version = data?.version;
  return typeof version === 'string' ? version : null;
}

export interface NetInfo { ip: string; gateway: string; subnet: string; mac: string }

export function parseNetInfo(raw: string): NetInfo | null {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const get = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const ip = get('ip');
  if (!ip) return null;
  return { ip, gateway: get('gateway'), subnet: get('subnet'), mac: get('mac') };
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The firmware does not always answer strict JSON (trailing commas, single
 * quotes, bare keys). Strict parse first, then a gentle repair.
 */
export function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const text = raw?.trim();
  if (!text) return null;
  const asObject = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    /* repaired below */
  }
  const cleaned = text
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  try {
    return asObject(JSON.parse(cleaned));
  } catch {
    return null;
  }
}

// ── Serial ──────────────────────────────────────────────────────────────────────

export function serialRoute(source: number, window: number): string {
  return `${clampInt(source, 1, SOURCE_COUNT)}V${clampInt(window, 1, WINDOW_COUNT)}.`;
}
export function serialLayout(mode: number): string {
  return `<#Splice_mode${clampInt(mode, 0, LAYOUT_COUNT - 1)}>`;
}
export function serialAudio(channel: number): string {
  return `<#Audio_chn${clampInt(channel, 0, 7)}>`;
}
export function serialFreezeTime(seconds: number): string {
  return `FREEZE${clampInt(seconds, 1, 6)}.`;
}
export const serialSetFreeze = (): string => 'SetFreeze.';
export const serialQueryNetwork = (): string => '<^NET>';

/**
 * When is a serial reply complete? A closed `<…>` pair at the end (not a bare
 * `>`: that also matches the arrow in `V:3 ->`, half an answer), a trailing
 * dot, or the switch echo.
 */
export function isCompleteSerialReply(text: string): boolean {
  if (!text) return false;
  if (/<[^<>]*>\s*$/.test(text)) return true;
  if (/\.\s*$/.test(text)) return true;
  if (/V\s*:\s*\d+\s*->\s*\d+\s*$/.test(text)) return true;
  return false;
}

export function parseSwitchReply(raw: string): { source: number; window: number } | null {
  const match = /V\s*:\s*(\d+)\s*->\s*(\d+)/.exec(raw ?? '');
  if (!match) return null;
  return { source: Number.parseInt(match[1], 10), window: Number.parseInt(match[2], 10) };
}
export function parseLayoutReply(raw: string): number | null {
  const match = /<Splice_mode(\d+)>/.exec(raw ?? '');
  return match ? Number.parseInt(match[1], 10) : null;
}
export function parseAudioReply(raw: string): number | null {
  const match = /<Audio_chn(\d+)>/.exec(raw ?? '');
  return match ? Number.parseInt(match[1], 10) : null;
}
export function parseNetworkReply(
  raw: string,
): { port?: number; ip?: string; gateway?: string; subnet?: string; mac?: string } | null {
  const text = raw ?? '';
  const ip = /<SIPR([\d.]+)>/.exec(text);
  const gateway = /<GAR([\d.]+)>/.exec(text);
  const subnet = /<SUBR([\d.]+)>/.exec(text);
  const mac = /<SHAR([\dA-Fa-f:]+)>/.exec(text);
  const port = /<SPORT(\d+)>/.exec(text);
  if (!ip && !gateway && !subnet && !mac && !port) return null;
  return {
    port: port ? Number.parseInt(port[1], 10) : undefined,
    ip: ip?.[1],
    gateway: gateway?.[1],
    subnet: subnet?.[1],
    mac: mac?.[1],
  };
}
