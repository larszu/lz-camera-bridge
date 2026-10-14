/**
 * Aim by frame (#137): picture point → direction → head pose, the frame's
 * angular width → zoom, and the field-of-view model that names its source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aimFromMap, aimFromPicture, angleBetween, dirOf, frameOnMap, hfovAt, moveTimeMs, panTiltOf,
  pixelOfDirection, rayFromPixel, vfovOf, zoomForHfov,
} from '../src/protocol/frameAim.js';

const near = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`);

test('directions: pan positive right, tilt positive up, round trip', () => {
  const r = dirOf(90, 0);
  near(r[0], 1, 1e-9);
  near(dirOf(0, 90)[1], 1, 1e-9);
  const back = panTiltOf(dirOf(-37.5, 22));
  near(back.pan, -37.5, 1e-9);
  near(back.tilt, 22, 1e-9);
  near(angleBetween(dirOf(0, 0), dirOf(30, 0)), 30, 1e-9);
});

test('picture point → ray → picture point is the identity, also tilted and panned', () => {
  const pose = { pan: 40, tilt: -18 };
  for (const [u, v] of [[0.5, 0.5], [0.1, 0.2], [0.93, 0.77]]) {
    const p = pixelOfDirection(rayFromPixel(u, v, 16 / 9, 55, pose), 16 / 9, 55, pose)!;
    near(p.u, u, 1e-9);
    near(p.v, v, 1e-9);
  }
  // Behind the camera there is no picture point.
  assert.equal(pixelOfDirection(dirOf(220, 18), 16 / 9, 55, pose), null);
});

test('frame in the middle: same direction, field of view of its width', () => {
  const hfov = 60;
  const aim = aimFromPicture({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 16 / 9, hfov, { pan: 10, tilt: 5 });
  assert.ok(typeof aim !== 'string');
  near(aim.pan, 10);
  near(aim.tilt, 5);
  // Half the width of the picture is 2·atan(½·tan 30°), not 30°.
  near(aim.hfovDeg, (2 * Math.atan(0.5 * Math.tan(Math.PI / 6)) * 180) / Math.PI);
});

test('frame at the right edge at tilt 0: pan = atan(offset / f)', () => {
  const aim = aimFromPicture({ x: 0.8, y: 0.45, w: 0.2, h: 0.1 }, 16 / 9, 60, { pan: 0, tilt: 0 });
  assert.ok(typeof aim !== 'string');
  const f = 0.5 / Math.tan(Math.PI / 6);
  near(aim.pan, (Math.atan(0.4 / f) * 180) / Math.PI);
  near(aim.tilt, 0);
  // Above the centre is up: positive tilt.
  const up = aimFromPicture({ x: 0.4, y: 0, w: 0.2, h: 0.2 }, 16 / 9, 60, { pan: 0, tilt: 0 });
  assert.ok(typeof up !== 'string' && up.tilt > 5);
});

test('pan stays next to the reference across ±180', () => {
  const aim = aimFromPicture({ x: 0.7, y: 0.4, w: 0.2, h: 0.2 }, 16 / 9, 60, { pan: 175, tilt: 0 });
  assert.ok(typeof aim !== 'string');
  assert.ok(aim.pan > 175 && aim.pan < 200, String(aim.pan));
});

test('bad input is refused with a sentence', () => {
  assert.equal(typeof aimFromPicture({ x: 0, y: 0, w: 0, h: 0.1 }, 16 / 9, 60, { pan: 0, tilt: 0 }), 'string');
  assert.equal(typeof aimFromPicture({ x: 0, y: 0, w: 0.1, h: 0.1 }, 16 / 9, 0, { pan: 0, tilt: 0 }), 'string');
});

test('map frame: centre of the map, angular width shrinks away from the horizon', () => {
  const map = { panMin: -90, panMax: 90, tiltMin: -30, tiltMax: 30 };
  const mid = aimFromMap({ x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, map);
  assert.ok(typeof mid !== 'string');
  near(mid.pan, 0);
  near(mid.tilt, 0);
  near(mid.hfovDeg, 18);
  const high = aimFromMap({ x: 0.45, y: 0, w: 0.1, h: 0.2 }, map);
  assert.ok(typeof high !== 'string' && high.hfovDeg < 18 && high.tilt > 20);
  // And the live overlay lands where the aim went.
  const f = frameOnMap({ pan: 0, tilt: 0 }, 18, 16 / 9, map);
  near(f.x, 0.45, 1e-6);
  near(f.w, 0.1, 1e-6);
  near(f.h, vfovOf(18, 16 / 9) / 60, 1e-6);
});

test('field of view: measured table wins, interpolated on the magnification', () => {
  const model = { fovTable: [{ position: 0, hfovDeg: 60 }, { position: 1, hfovDeg: 3 }], hfovWideDeg: 70, sensorWidthMm: 6 };
  assert.deepEqual(hfovAt(0, model), { hfovDeg: 60, fit: 'table' });
  assert.deepEqual(hfovAt(1, model), { hfovDeg: 3, fit: 'table' });
  const mid = hfovAt(0.5, model)!;
  // Geometric mean of the magnifications, not the arithmetic mean of the angles.
  const expect = (2 * Math.atan(Math.sqrt(Math.tan((30 * Math.PI) / 180) * Math.tan((1.5 * Math.PI) / 180))) * 180) / Math.PI;
  near(mid.hfovDeg, expect, 0.01);
  assert.ok(mid.hfovDeg < 31.5);
});

test('field of view: datasheet ends anchor a short table, focal + sensor is physics, ends alone are linear', () => {
  const partial = { fovTable: [{ position: 0.2, hfovDeg: 40 }, { position: 0.4, hfovDeg: 20 }], hfovTeleDeg: 2.5 };
  assert.deepEqual(hfovAt(1, partial), { hfovDeg: 2.5, fit: 'table' });
  const focal = hfovAt(0, { sensorWidthMm: 6.17, focalMinMm: 4.4, focalMaxMm: 88 })!;
  assert.equal(focal.fit, 'focal');
  near(focal.hfovDeg, (2 * Math.atan(6.17 / 8.8) * 180) / Math.PI, 0.01);
  assert.equal(hfovAt(0.5, { hfovWideDeg: 60, hfovTeleDeg: 3 })!.fit, 'linear');
  assert.equal(hfovAt(0.5, { hfovWideDeg: 60 }), null);
  assert.equal(hfovAt(0.5, {}), null);
});

test('zoom for a field of view inverts the curve and clamps at the ends', () => {
  const model = { hfovWideDeg: 63, hfovTeleDeg: 3.3 };
  for (const z of [0.1, 0.37, 0.8]) {
    const h = hfovAt(z, model)!.hfovDeg;
    near(zoomForHfov(h, model)!.zoom, z, 0.002);
  }
  assert.equal(zoomForHfov(90, model)!.zoom, 0);
  assert.equal(zoomForHfov(1, model)!.zoom, 1);
  assert.equal(zoomForHfov(20, {}), null);
});

test('move time grows with the swing and stays within 1–6 s', () => {
  assert.equal(moveTimeMs(undefined, { pan: 0, tilt: 0 }), 2000);
  assert.equal(moveTimeMs({ pan: 0, tilt: 0 }, { pan: 0, tilt: 0 }), 1000);
  assert.ok(moveTimeMs({ pan: 0, tilt: 0 }, { pan: 90, tilt: 0 }) > 2500);
  assert.equal(moveTimeMs({ pan: -170, tilt: 0 }, { pan: 170, tilt: 80 }) <= 6000, true);
});
