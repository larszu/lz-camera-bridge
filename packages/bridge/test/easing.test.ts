// Ease-in/out for speed demands and preset moves (motion/Easing.ts, motion/EasedDrive.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ease, easedTrajectory, SpeedRamp } from '../src/motion/Easing.ts';
import { EasedDrive } from '../src/motion/EasedDrive.ts';

test('ease curves start and end flat and are symmetric', () => {
  for (const c of ['sine', 'cubic', 'quint'] as const) {
    assert.equal(ease(0, c), 0);
    assert.equal(ease(1, c), 1);
    assert.ok(Math.abs(ease(0.5, c) - 0.5) < 1e-9);
    assert.ok(ease(0.1, c) < 0.1, `${c} starts slower than linear`);
    assert.ok(ease(0.9, c) > 0.9, `${c} ends slower than linear`);
  }
});

test('speed ramp glides up with attack and down with release', () => {
  const r = new SpeedRamp({ attackMs: 400, releaseMs: 800, curve: 'cubic' }, 100);
  r.set(100, 0);
  assert.equal(r.valueAt(0), 0);
  assert.ok(r.valueAt(100) < 25, 'soft start');
  assert.ok(r.valueAt(300) > 75);
  assert.equal(r.valueAt(400), 100);
  r.set(0, 400);
  assert.ok(r.valueAt(600) > 80, 'soft stop');
  assert.equal(r.valueAt(1200), 0);
});

test('a small correction is quicker than a full-scale change', () => {
  const r = new SpeedRamp({ attackMs: 400, releaseMs: 400 }, 100);
  r.set(10, 0);
  assert.equal(r.valueAt(40), 10);
});

test('preset trajectory: eased, exact end point', () => {
  const t = easedTrajectory({ pan: 0, zoom: 100 }, { pan: 1000, zoom: 0 }, 1000, 50);
  assert.equal(t.length, 21);
  assert.deepEqual(t[0], { pan: 0, zoom: 100 });
  assert.deepEqual(t.at(-1), { pan: 1000, zoom: 0 });
  assert.ok(t[1].pan < 50 && t[19].pan > 950, 'slow at both ends');
});

test('EasedDrive sends intermediate zoom speeds and ends exactly at the target', async () => {
  const sent: number[] = [];
  const drive = new EasedDrive(async (_c, p) => {
    sent.push(Number(p.value));
    return true;
  }, { attackMs: 200, releaseMs: 200, curve: 'cubic' });
  assert.equal(await drive.demand('setZoom', { value: 100 }), true);
  await new Promise((r) => setTimeout(r, 320));
  assert.ok(sent.length >= 3, 'several steps');
  assert.equal(sent.at(-1), 100);
  assert.ok(sent.some((v) => v > 0 && v < 100), 'intermediate values');
  await drive.demand('setZoom', { value: 0 });
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(sent.at(-1), 0);
  drive.dispose();
});

test('EasedDrive with ease switched off passes through unchanged', async () => {
  const sent: unknown[] = [];
  const drive = new EasedDrive(async (c, p) => {
    sent.push([c, p]);
    return true;
  }, { attackMs: 0, releaseMs: 0 });
  await drive.demand('ptz', { pan: 50, tilt: -20 });
  assert.deepEqual(sent, [['ptz', { pan: 50, tilt: -20 }]]);
});
