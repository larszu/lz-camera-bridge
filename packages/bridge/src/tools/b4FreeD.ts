/**
 * b4-freed — lens zoom and focus from the B4 interface out as FreeD D1.
 *
 * The runner for the phase 5 interop test (#56): it polls the firmware-b4
 * device, maps `lens.zoomCounts` / `lens.focusCounts` through the per-lens
 * calibration tables (`LensCalibration.ts`), and hands the result to
 * `FreeDSender`, which owns the socket and the rate.
 *
 *   npx tsx src/tools/b4FreeD.ts b4-freed.json
 *
 * ── The pose is a statement, not a default ────────────────────────────────
 * A lens knows zoom and focus. FreeD also carries pan, tilt, roll and position,
 * and `encodeFreeD` refuses to invent them. For a camera on a fixed mount the
 * config must therefore SAY where it is (`staticPose`); without that entry
 * the runner does not start. Zero pan written by the user is a statement;
 * zero pan filled in by the program would be a guess.
 *
 * ── Losing the device sends nothing ───────────────────────────────────────
 * If the device stops answering, or a reading falls outside its table, the
 * axis becomes null and the sender goes silent rather than repeating the last
 * value. On the receiving side that is a source that stopped, which Live Link
 * shows as such; a frozen value would look like a lens nobody touched.
 */
import { readFileSync } from 'node:fs';
import { httpRequest } from '../cameras/GenericCameraClient.js';
import { freeDLensAxes, type CalibrationTable } from '../protocol/LensCalibration.js';
import type { FreeDSample } from '../protocol/FreeD.js';
import { createFreeDSender, type FreeDSender } from '../transport/FreeDSender.js';

export interface StaticPose {
  panDeg: number;
  tiltDeg: number;
  rollDeg: number;
  xMm: number;
  yMm: number;
  zMm: number;
}

export interface B4FreeDConfig {
  device: { host: string; port?: number; pollMs?: number };
  freed: { host: string; port: number; rateHz: number; cameraId: number };
  zoomTable: CalibrationTable;
  focusTable: CalibrationTable;
  staticPose: StaticPose;
}

export function checkConfig(c: Partial<B4FreeDConfig>): string[] {
  const problems: string[] = [];
  if (!c.device?.host) problems.push('device.host missing');
  if (!c.freed?.host) problems.push('freed.host missing');
  if (!Number.isInteger(c.freed?.port)) problems.push('freed.port missing — FreeD has no standard port; the receiver decides');
  if (!(Number(c.freed?.rateHz) > 0)) problems.push('freed.rateHz missing — the show format decides');
  if (!Number.isInteger(c.freed?.cameraId) || c.freed!.cameraId < 0 || c.freed!.cameraId > 255) problems.push('freed.cameraId 0..255 missing');
  if (!c.zoomTable) problems.push('zoomTable missing — measured per lens, see LensCalibration.ts');
  if (!c.focusTable) problems.push('focusTable missing — measured per lens');
  const p = c.staticPose;
  if (!p || (['panDeg', 'tiltDeg', 'rollDeg', 'xMm', 'yMm', 'zMm'] as const).some((k) => typeof p[k] !== 'number')) {
    problems.push('staticPose missing or incomplete — state the fixed mount explicitly; nothing is assumed');
  }
  return problems;
}

/** One device status → one FreeD sample. `lens` absent or partial → null axes. */
export function sampleFrom(
  lens: { zoomCounts?: number; focusCounts?: number } | undefined,
  cfg: B4FreeDConfig,
): FreeDSample {
  const axes = freeDLensAxes({
    ...(typeof lens?.zoomCounts === 'number' ? { zoom: { table: cfg.zoomTable, raw: lens.zoomCounts } } : {}),
    ...(typeof lens?.focusCounts === 'number' ? { focus: { table: cfg.focusTable, raw: lens.focusCounts } } : {}),
  });
  return { cameraId: cfg.freed.cameraId, ...cfg.staticPose, zoom: axes.zoom, focus: axes.focus };
}

export interface Runner {
  sender: FreeDSender;
  poll(): Promise<void>;
  stop(): void;
}

export function startRunner(cfg: B4FreeDConfig, log: (s: string) => void = () => {}): Runner {
  const problems = checkConfig(cfg);
  if (problems.length) throw new Error(`b4-freed config: ${problems.join('; ')}`);
  const sender = createFreeDSender({
    host: cfg.freed.host,
    port: cfg.freed.port,
    rateHz: cfg.freed.rateHz,
    onIncomplete: (missing) => log(`FreeD: nothing sent, no ${missing.join(', ')}`),
    onError: (err) => log(`FreeD: ${err.message}`),
  });
  const base = `http://${cfg.device.host}:${cfg.device.port ?? 80}`;
  const poll = async (): Promise<void> => {
    try {
      const st = JSON.parse(await httpRequest(`${base}/api/status`, { timeoutMs: 500 })) as {
        lens?: { zoomCounts?: number; focusCounts?: number };
      };
      sender.update(sampleFrom(st.lens, cfg));
    } catch (err) {
      sender.update(sampleFrom(undefined, cfg)); // device gone → null axes → silence
      log(`device: ${(err as Error).message}`);
    }
  };
  const timer = setInterval(() => void poll(), cfg.device.pollMs ?? 20);
  sender.start();
  return {
    sender,
    poll,
    stop: () => {
      clearInterval(timer);
      sender.stop();
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: b4FreeD.ts <config.json>   (format: docs/b4/unreal-livelink.md)');
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as B4FreeDConfig;
  const r = startRunner(cfg, (s) => console.log(s));
  console.log(`FreeD → ${cfg.freed.host}:${cfg.freed.port} at ${cfg.freed.rateHz} Hz, camera ${cfg.freed.cameraId}`);
  setInterval(() => {
    const s = r.sender.stats;
    console.log(`sent ${s.sent}  incomplete ${s.skippedIncomplete}  errors ${s.errors}`);
  }, 5000);
  process.on('SIGINT', () => { r.stop(); process.exit(0); });
}
