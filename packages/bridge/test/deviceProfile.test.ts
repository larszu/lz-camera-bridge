/**
 * Device profile tests (run with `npm test` in packages/bridge).
 *
 * The test that matters for issue #58 is `a second device joins without a code
 * change`: the shipped example profile and a made-up second one both load
 * through the same functions, and nothing in `src/` names either device.
 *
 * Every figure in these profiles is invented. None of them measures a real
 * head, and nothing here claims otherwise.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  absoluteAxes,
  axisCapability,
  checkProfile,
  type AxisProfile,
  type DeviceProfile,
} from '../src/protocol/DeviceProfile.js';

const beispiel = JSON.parse(
  readFileSync(fileURLToPath(new URL('../profiles/example-pan-tilt.json', import.meta.url)), 'utf8'),
) as DeviceProfile;

const panAchse = (over: Partial<AxisProfile> = {}): AxisProfile => ({
  id: 'pan',
  kind: 'rotary',
  unit: 'degree',
  travel: { min: -180, max: 180 },
  directionSense: 'normal',
  drive: { ratio: 120, toothModuleMm: 0.8 },
  feedback: { kind: 'incremental-encoder', countsPerUnit: 400, zeroOffset: 0 },
  homing: { method: 'index-pulse', direction: 'toward-min', against: 'index mark' },
  brake: { present: false },
  cutouts: { currentA: 4.5 },
  ...over,
});

const profilMit = (axes: AxisProfile[]): DeviceProfile => ({
  formatVersion: 1,
  id: 'test-head',
  manufacturer: 'Test',
  model: 'Head',
  source: 'test fixture',
  axes,
});

test('the shipped example profile is valid', () => {
  const r = checkProfile(beispiel);
  assert.deepEqual(r.errors, [], 'the example must not carry errors');
  assert.equal(r.ok, true);
});

test('the example is honest about the axis it does not fully describe', () => {
  const r = checkProfile(beispiel);
  // The lift axis states no travel, no feedback and no homing on purpose —
  // it is the profile's demonstration of "missing stays missing".
  assert.ok(r.unknowns.some((u) => /axis lift: travel limits are not stated/.test(u)));
  assert.ok(r.unknowns.some((u) => /axis lift: no feedback/.test(u)));
  assert.equal(absoluteAxes(beispiel).length, 2, 'only pan and tilt may be sent to a number');
});

test('a second device joins without a code change', () => {
  // Nothing about this head appears anywhere in src/ — it is data only.
  const zweites: DeviceProfile = {
    formatVersion: 1,
    id: 'other-column',
    manufacturer: 'Other',
    model: 'Telescopic column',
    source: 'test fixture, invented',
    axes: [
      {
        id: 'column',
        kind: 'linear',
        unit: 'mm',
        travel: { min: 0, max: 1200 },
        directionSense: 'normal',
        drive: { ratio: 4 },
        feedback: { kind: 'hall', countsPerUnit: 12, zeroOffset: 0 },
        homing: { method: 'hard-stop', direction: 'toward-min', against: 'lower mechanical stop' },
        brake: { present: true, releaseBeforeMoveMs: 300, engageAfterStopMs: 150 },
        cutouts: { currentA: 9, commandTimeoutS: 0.5 },
      },
    ],
  };
  const r = checkProfile(zweites);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.unknowns, []);
  assert.equal(absoluteAxes(zweites).length, 1);
});

test('a profile without travel limits is accepted but loses absolute motion', () => {
  const ohneGrenzen = panAchse({ travel: undefined });
  const r = checkProfile(profilMit([ohneGrenzen]));
  assert.equal(r.ok, true, 'unstated limits are honest, not an error');
  assert.ok(r.unknowns.some((u) => /travel limits are not stated/.test(u)));

  const cap = axisCapability(ohneGrenzen);
  assert.equal(cap.absoluteMove, false);
  assert.equal(cap.jog, true, 'a hand on a control is a limit of a sort');
  assert.deepEqual(cap.reasons, ['travel limits are not stated']);

  // Negative control: with limits back, the same axis may be sent to a number.
  assert.equal(axisCapability(panAchse()).absoluteMove, true);
});

test('travel limits that are not limits are an error, not an unknown', () => {
  const r = checkProfile(profilMit([panAchse({ travel: { min: 90, max: 90 } })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /is not below travel.max/.test(e)));
});

test('a contradictory direction sense is rejected', () => {
  const r = checkProfile(
    profilMit([panAchse({ directionSense: 'clockwise' as unknown as 'normal' })]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /directionSense must be/.test(e)));
});

test('an axis stated in the wrong unit is rejected', () => {
  const r = checkProfile(profilMit([panAchse({ unit: 'mm' })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /a rotary axis is stated in degree/.test(e)));
});

test('two axes cannot share a name', () => {
  const r = checkProfile(profilMit([panAchse(), panAchse()]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /appears twice/.test(e)));
});

test('a declared brake without a release time is rejected', () => {
  const r = checkProfile(profilMit([panAchse({ brake: { present: true } })]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /brake is declared but no release time/.test(e)));
});

test('an unestablished zero point costs absolute motion without rejecting the profile', () => {
  const axis = panAchse({
    feedback: { kind: 'incremental-encoder', countsPerUnit: 400 },
  });
  const r = checkProfile(profilMit([axis]));
  assert.equal(r.ok, true);
  assert.ok(r.unknowns.some((u) => /zero point is not established/.test(u)));
  assert.equal(axisCapability(axis).absoluteMove, false);
  assert.equal(axisCapability(axis).positionFeedback, true);
});

test('every problem is reported at once', () => {
  const r = checkProfile(
    profilMit([panAchse({ unit: 'mm', directionSense: 'sideways' as unknown as 'normal' })]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2, `expected several errors, got ${r.errors.join(' | ')}`);
});

test('malformed input is rejected rather than read', () => {
  assert.equal(checkProfile(null).ok, false);
  assert.equal(checkProfile('a profile').ok, false);
  assert.equal(checkProfile({ formatVersion: 2, id: 'x', manufacturer: 'y', model: 'z' }).ok, false);
  const leer = checkProfile({ formatVersion: 1, id: 'x', manufacturer: 'y', model: 'z', axes: [] });
  assert.equal(leer.ok, false);
  assert.ok(leer.errors.some((e) => /non-empty array/.test(e)));
});

test('no device name from any profile appears in the source', () => {
  // The blunt version of "without a code change": if a device is named in
  // src/, the next one needs an edit there too.
  const src = fileURLToPath(new URL('../src/protocol/DeviceProfile.ts', import.meta.url));
  const text = readFileSync(src, 'utf8');
  assert.ok(!text.includes(beispiel.id), 'the profile id must not be mentioned in the source');
  assert.ok(!text.includes(beispiel.manufacturer), 'the manufacturer must not be in the source');
});
