/**
 * Panorama scan (#138) and field-of-view calibration (#137) against a
 * synthetic room: a brightness pattern on the sphere around the head. Every
 * "picture" is rendered from that pattern at the pose the fake head stands
 * on, so placement, stitching and the measured field of view can be checked
 * against the truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { panTiltOf, rayFromPixel } from '../src/protocol/frameAim.js';
import { mapSize, planScan, stitch, MAX_SCAN_STOPS, type RgbImage } from '../src/panorama/stitch.js';
import { calibrationStep, hfovFromShift, measureShift } from '../src/panorama/fovCalibration.js';
import { mergeFovTable, runFovCalibration, runScan, scanSettings, type JobDeps } from '../src/panorama/PanoramaScan.js';
import { ffmpegCodec, jpegSize } from '../src/panorama/jpegCodec.js';
import { PanoramaStore } from '../src/panorama/PanoramaStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The room: periods from 40° down to 40°/2^(octaves−1), different per channel. */
function world(pan: number, tilt: number, octaves: number): [number, number, number] {
  let g = 0;
  for (let i = 0; i < octaves; i++) g += Math.sin((2 * Math.PI * pan) / (40 / 2 ** i) + i * 1.7) / (1 + i * 0.3);
  const t = Math.sin((2 * Math.PI * tilt) / 30);
  const v = 128 + 50 * g / 2 + 30 * t;
  return [v, 128 + 60 * t, 128 + 40 * Math.sin((2 * Math.PI * (pan + tilt)) / 25)];
}

function render(pose: { pan: number; tilt: number }, hfov: number, width: number, height: number, octaves: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = panTiltOf(rayFromPixel((x + 0.5) / width, (y + 0.5) / height, width / height, hfov, pose));
      const c = world(d.pan, d.tilt, octaves);
      const o = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) data[o + k] = Math.max(0, Math.min(255, Math.round(c[k])));
    }
  }
  return { width, height, data };
}

/** A head that is where it was sent, a lens whose field of view follows `trueFov`, pictures from `world`. */
function fakeHead(trueFov: (zoom: number) => number, width: number, octaves: number) {
  const pose = { pan: 3, tilt: 1, zoom: 0.2 };
  const moves: { pan: number; tilt: number; zoom?: number }[] = [];
  let cancelAfter = Infinity;
  const deps: JobDeps = {
    drive: async (p) => { moves.push(p); Object.assign(pose, p); return true; },
    readPose: async () => ({ ...pose }),
    grab: async () => Buffer.from(JSON.stringify(pose)),
    codec: {
      decode: async (buf) => {
        const p = JSON.parse(buf.toString());
        return render(p, trueFov(p.zoom), width, Math.round((width * 9) / 16), octaves);
      },
      encode: async (img) => Buffer.from(`jpeg ${img.width}x${img.height}`),
    },
    cancelled: () => moves.length > cancelAfter,
  };
  return { deps, pose, moves, cancelAt: (n: number) => { cancelAfter = n; } };
}

test('scan plan: serpentine rows from the top, enough overlap, a ceiling on the count', () => {
  const plan = planScan({ panMin: -90, panMax: 90, tiltMin: -20, tiltMax: 20, hfovDeg: 60, aspect: 16 / 9, overlap: 0.3 });
  assert.ok(Array.isArray(plan));
  const tilts = [...new Set(plan.map((p) => p.tilt))];
  assert.ok(tilts[0] > tilts[tilts.length - 1], 'top row first');
  const row0 = plan.filter((p) => p.tilt === tilts[0]).map((p) => p.pan);
  const row1 = plan.filter((p) => p.tilt === tilts[1]).map((p) => p.pan);
  assert.ok(row0[0] < row0[row0.length - 1] && row1[0] > row1[row1.length - 1], 'second row runs back');
  for (let i = 1; i < row0.length; i++) assert.ok(row0[i] - row0[i - 1] <= 60 * 0.7 + 0.1);
  assert.equal(row0[0], -60);
  assert.equal(typeof planScan({ panMin: -170, panMax: 170, tiltMin: -60, tiltMax: 60, hfovDeg: 2, aspect: 16 / 9, overlap: 0.5 }), 'string');
  assert.equal(typeof planScan({ panMin: 0, panMax: 0, tiltMin: 0, tiltMax: 10, hfovDeg: 2, aspect: 1, overlap: 0.5 }), 'string');
  assert.ok(MAX_SCAN_STOPS >= 120, 'the issue\'s 180° × 50° at 20° must fit');
  const issue = planScan({ panMin: -90, panMax: 90, tiltMin: -25, tiltMax: 25, hfovDeg: 20, aspect: 16 / 9, overlap: 0.35 });
  assert.ok(Array.isArray(issue), String(issue));
});

test('stitch: every covered map pixel shows the room in that direction', () => {
  const extent = { panMin: -40, panMax: 40, tiltMin: -15, tiltMax: 15 };
  const hfov = 40;
  const plan = planScan({ ...extent, hfovDeg: hfov, aspect: 16 / 9, overlap: 0.3 });
  assert.ok(Array.isArray(plan));
  const tiles = plan.map((p) => ({ ...p, hfovDeg: hfov, image: render(p, hfov, 320, 180, 3) }));
  const size = mapSize(extent, 320, hfov);
  const map = stitch(tiles, extent, size.width, size.height);
  let err = 0;
  let n = 0;
  for (let y = 2; y < map.height - 2; y += 3) {
    for (let x = 2; x < map.width - 2; x += 3) {
      const pan = extent.panMin + ((x + 0.5) / map.width) * 80;
      const tilt = extent.tiltMax - ((y + 0.5) / map.height) * 30;
      const w = world(pan, tilt, 3);
      const o = (y * map.width + x) * 3;
      err += Math.abs(map.data[o] - w[0]) + Math.abs(map.data[o + 1] - w[1]) + Math.abs(map.data[o + 2] - w[2]);
      n += 3;
    }
  }
  assert.ok(err / n < 2.5, `mean error ${err / n}`);
});

test('field of view from a known pan step and the measured shift', () => {
  for (const hfov of [58, 21, 4.2]) {
    const step = calibrationStep(hfov);
    const a = render({ pan: 0, tilt: 0 }, hfov, 640, 360, 6);
    const b = render({ pan: step, tilt: 0 }, hfov, 640, 360, 6);
    const s = measureShift(a, b);
    assert.ok(s && s.shift > 0, `no shift at ${hfov}°`);
    const measured = hfovFromShift(s!.shift, 640, step)!;
    assert.ok(Math.abs(measured - hfov) / hfov < 0.02, `${measured} vs ${hfov}`);
  }
  // A blank picture has nothing to match.
  const blank = { width: 64, height: 36, data: new Uint8Array(64 * 36 * 3).fill(90) };
  assert.equal(measureShift(blank, blank), null);
});

test('calibration run: wide to tele, each measured within 3 %, head back where it was', async () => {
  // A 20× lens with an exponential curve, roughly what PTZ heads do.
  const trueFov = (z: number) => (2 * Math.atan(Math.tan((62 * Math.PI) / 360) / 20 ** z) * 180) / Math.PI;
  const head = fakeHead(trueFov, 640, 6);
  const seen: number[] = [];
  const pts = await runFovCalibration([0, 0.25, 0.5, 0.75, 1], {}, head.deps, 10, (r) => { if (r.hfovDeg) seen.push(r.zoom); });
  assert.deepEqual(pts.map((p) => p.position), [0, 0.25, 0.5, 0.75, 1]);
  for (const p of pts) assert.ok(Math.abs(p.hfovDeg - trueFov(p.position)) / trueFov(p.position) < 0.03, `${p.position}: ${p.hfovDeg} vs ${trueFov(p.position)}`);
  assert.deepEqual(seen, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual({ pan: head.pose.pan, tilt: head.pose.tilt, zoom: head.pose.zoom }, { pan: 3, tilt: 1, zoom: 0.2 });
  // New points replace old ones at the same zoom.
  assert.deepEqual(mergeFovTable([{ position: 0, hfovDeg: 70 }, { position: 0.6, hfovDeg: 9 }], [{ position: 0.001, hfovDeg: 62 }]),
    [{ position: 0.001, hfovDeg: 62 }, { position: 0.6, hfovDeg: 9 }]);
});

test('scan run: a map of the planned extent, head back home, cancellation also goes home', async () => {
  const head = fakeHead(() => 40, 320, 3);
  const settings = scanSettings({ panMin: -40, panMax: 40, tiltMin: -15, tiltMax: 15, zoom: 0.1, settleMs: 200 });
  const steps: number[] = [];
  const out = await runScan(4, settings, { hfovWideDeg: 40, hfovTeleDeg: 40 }, head.deps, (p) => steps.push(p.index));
  assert.equal(out.meta.cameraNumber, 4);
  assert.equal(out.meta.pictures, steps.length);
  assert.equal(out.meta.fit, 'linear');
  assert.equal(out.jpeg.toString(), `jpeg ${out.meta.width}x${out.meta.height}`);
  assert.deepEqual([head.pose.pan, head.pose.tilt, head.pose.zoom], [3, 1, 0.2]);
  assert.ok(head.moves.slice(0, -1).every((m) => m.zoom === 0.1), 'every picture at the scan zoom');

  const again = fakeHead(() => 40, 160, 2);
  again.cancelAt(2);
  await assert.rejects(runScan(4, settings, { hfovWideDeg: 40, hfovTeleDeg: 40 }, again.deps, () => {}), /cancelled/);
  assert.deepEqual([again.pose.pan, again.pose.tilt], [3, 1]);

  await assert.rejects(runScan(4, settings, {}, again.deps, () => {}), /field of view/);
});

test('scan settings are clamped to what a head can do', () => {
  const s = scanSettings({ panMin: -400, panMax: 999, tiltMin: -100, overlap: 2, settleMs: 1, zoom: 3 });
  assert.deepEqual([s.panMin, s.panMax, s.tiltMin, s.overlap, s.settleMs, s.zoom], [-180, 180, -90, 0.8, 200, 1]);
});

test('JPEG size from the SOF segment', () => {
  // SOI, APP0 (len 16), SOF0 with height 0x01E0 and width 0x0280.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...new Array(9).fill(0)];
  assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, ...app0, ...sof])), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('ffmpeg codec: encode, size, decode round trip', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const img = render({ pan: 0, tilt: 0 }, 50, 128, 72, 2);
  const jpeg = await ffmpegCodec.encode(img);
  assert.deepEqual(jpegSize(jpeg), { width: 128, height: 72 });
  const back = await ffmpegCodec.decode(jpeg, 64);
  assert.deepEqual([back.width, back.height, back.data.length], [64, 36, 64 * 36 * 3]);
});

test('panorama store: on disk with its extent, read back after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lz-pano-'));
  try {
    const meta = {
      cameraNumber: 2, panMin: -10, panMax: 10, tiltMin: -5, tiltMax: 5, width: 20, height: 10, pxPerDeg: 1,
      zoom: 0, hfovDeg: 60, fit: 'table', aspect: 16 / 9, pictures: 3, createdAt: 'now',
    };
    new PanoramaStore(dir).save(meta, Buffer.from('J'));
    const back = new PanoramaStore(dir).get(2);
    assert.deepEqual(back?.meta, meta);
    assert.equal(back?.jpeg.toString(), 'J');
    assert.equal(new PanoramaStore(dir).get(3), null);
    assert.equal(new PanoramaStore(null).get(2), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
