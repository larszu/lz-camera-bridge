/**
 * Lens calibration tests (run with `npm test` in packages/bridge).
 *
 * Both raw ranges from issue #55 appear here: the 16-bit serial count from
 * 0x31/0x32 and the analog 2–7 V reading, expressed in millivolts. The point
 * is that neither is special to the code — the difference lives entirely in
 * the table.
 *
 * The numbers in these tables are INVENTED FOR THE TEST. They are not
 * measurements of any lens, and nothing here claims a real mapping; issue #55
 * needs an axis driven over its full mechanical travel for that.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FREED_AXIS_MAX,
  FREED_AXIS_MIN,
  calibratedRange,
  checkCalibration,
  freeDLensAxes,
  interpolate,
  toFreeDAxis,
  type CalibrationTable,
} from '../src/protocol/LensCalibration.js';

/** Serial zoom: 16-bit count against focal length in mm. */
const seriellerZoom: CalibrationTable = {
  axis: 'zoom',
  rawUnit: 'serial-16bit',
  valueUnit: 'mm',
  points: [
    { raw: 0x0000, value: 9.3 },
    { raw: 0x4000, value: 30 },
    { raw: 0x8000, value: 80 },
    { raw: 0xffff, value: 410 },
  ],
  source: 'test fixture, not a measurement',
};

/** Analog focus: 2–7 V (in mV) against distance in metres. */
const analogerFokus: CalibrationTable = {
  axis: 'focus',
  rawUnit: 'millivolt',
  valueUnit: 'metre',
  points: [
    { raw: 2000, value: 0.9 },
    { raw: 4500, value: 5 },
    { raw: 7000, value: 60 },
  ],
  source: 'test fixture, not a measurement',
};

test('a table with fewer than two points is rejected', () => {
  const r = checkCalibration({ ...seriellerZoom, points: [{ raw: 0, value: 1 }] });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.problems.some((p) => /at least two/.test(p)));
});

test('a raw reading that means two values is rejected', () => {
  const r = checkCalibration({
    ...seriellerZoom,
    points: [
      { raw: 0, value: 10 },
      { raw: 0, value: 20 },
      { raw: 100, value: 30 },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.problems.some((p) => /appears twice/.test(p)));
});

test('a reversed direction sense is named, not averaged away', () => {
  const r = checkCalibration({
    ...seriellerZoom,
    points: [
      { raw: 0, value: 10 },
      { raw: 100, value: 20 },
      { raw: 200, value: 15 },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.problems.some((p) => /direction reverses/.test(p)));
});

test('a descending value column is fine — that is how direction sense is stated', () => {
  const fallend: CalibrationTable = {
    axis: 'focus',
    rawUnit: 'serial-16bit',
    valueUnit: 'metre',
    points: [
      { raw: 0, value: 100 },
      { raw: 0x8000, value: 10 },
      { raw: 0xffff, value: 0.8 },
    ],
  };
  assert.deepEqual(checkCalibration(fallend), { ok: true });
  // Rising raw, falling value: the FreeD count still runs the full span, and
  // it follows the VALUE, so the far end of focus is the low count.
  assert.equal(toFreeDAxis(fallend, 0xffff), FREED_AXIS_MIN);
  assert.equal(toFreeDAxis(fallend, 0), FREED_AXIS_MAX);
});

test('every problem is reported, not just the first', () => {
  const r = checkCalibration({
    ...seriellerZoom,
    points: [
      { raw: 0, value: 10 },
      { raw: 100, value: 20 },
      { raw: 50, value: 30 },
      { raw: 200, value: 25 },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.problems.length >= 2, 'expected more than one problem');
});

test('interpolation runs straight lines between measured points', () => {
  // Halfway between 0x4000/30 mm and 0x8000/80 mm.
  assert.equal(interpolate(seriellerZoom, 0x6000), 55);
  // Exactly on a measured point.
  assert.equal(interpolate(seriellerZoom, 0x8000), 80);
  // Floating point: 2.95 is not representable, so the check is a tolerance.
  assert.ok(Math.abs(interpolate(analogerFokus, 3250)! - 2.95) < 1e-9);
});

test('a reading outside the measured span is unknown, not clamped', () => {
  assert.equal(interpolate(analogerFokus, 1900), null);
  assert.equal(interpolate(analogerFokus, 7100), null);
  assert.equal(toFreeDAxis(analogerFokus, 7100), null);
  // Negative control: just inside, an answer comes back.
  assert.notEqual(interpolate(analogerFokus, 2000), null);
});

test('an unusable table yields nothing — no estimate', () => {
  const kaputt: CalibrationTable = { ...seriellerZoom, points: [{ raw: 0, value: 1 }] };
  assert.equal(interpolate(kaputt, 0), null);
  assert.equal(toFreeDAxis(kaputt, 0), null);
  assert.equal(calibratedRange(kaputt), null);
});

test('the FreeD axis uses the full 0..4095 without clamping or overflow', () => {
  assert.equal(toFreeDAxis(seriellerZoom, 0x0000), FREED_AXIS_MIN);
  assert.equal(toFreeDAxis(seriellerZoom, 0xffff), FREED_AXIS_MAX);
  assert.equal(toFreeDAxis(analogerFokus, 2000), FREED_AXIS_MIN);
  assert.equal(toFreeDAxis(analogerFokus, 7000), FREED_AXIS_MAX);

  // Nothing in between leaves the range, and nothing is negative.
  for (let raw = 0; raw <= 0xffff; raw += 0x400) {
    const v = toFreeDAxis(seriellerZoom, raw);
    assert.ok(v !== null && v >= FREED_AXIS_MIN && v <= FREED_AXIS_MAX, `raw ${raw} gave ${v}`);
  }
});

test('the FreeD axis is monotone across the whole span, both raw units', () => {
  for (const table of [seriellerZoom, analogerFokus]) {
    const span = calibratedRange(table)!;
    let last = -1;
    for (let i = 0; i <= 200; i += 1) {
      const raw = span.min + ((span.max - span.min) * i) / 200;
      const v = toFreeDAxis(table, raw);
      assert.ok(v !== null, `raw ${raw} inside the span must map`);
      assert.ok(v >= last, `${table.axis}: ${v} after ${last} at raw ${raw}`);
      last = v;
    }
    assert.equal(last, FREED_AXIS_MAX);
  }
});

test('an axis without a table stays null, the other one still reports', () => {
  const axes = freeDLensAxes({ zoom: { table: seriellerZoom, raw: 0x4000 } });
  assert.equal(axes.focus, null);
  assert.ok(axes.zoom !== null);

  const keine = freeDLensAxes({});
  assert.deepEqual(keine, { zoom: null, focus: null });
});

test('a reading outside the table leaves that axis missing for the encoder', () => {
  const axes = freeDLensAxes({
    zoom: { table: seriellerZoom, raw: 0x2000 },
    focus: { table: analogerFokus, raw: 8000 },
  });
  assert.ok(axes.zoom !== null);
  assert.equal(axes.focus, null, 'an uncalibrated reading must not become a number');
});
