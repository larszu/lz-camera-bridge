/**
 * B4 capture comparison tests (run with `npm test` in packages/bridge).
 * Pure functions over stored recordings — no lens, no serial port.
 *
 * These tests build synthetic captures, so they prove the COMPARISON is
 * sound, not that any particular command code means anything. The real
 * assignment comes from recordings of a real camera (issue #47), and this
 * module exists to make that comparison reliable rather than to pre-empt it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { B4Cmd, encodeB4Frame } from '../src/protocol/B4Lens.js';
import {
  behaviourByCode,
  candidateAssignment,
  captureFromBytes,
  diffCaptures,
  type B4Capture,
} from '../src/protocol/B4CaptureDiff.js';

/** A frame stream where `cmd` carries a 16-bit value that walks through `values`. */
const sweep = (cmd: number, values: readonly number[]): Buffer =>
  Buffer.concat(values.map((v) => encodeB4Frame(cmd, Buffer.from([(v >> 8) & 0xff, v & 0xff]))));

const idle = (): B4Capture =>
  captureFromBytes('idle', [], sweep(B4Cmd.GetIris, [0x8000, 0x8000, 0x8000, 0x8000]));

test('a capture from bytes decodes into frames', () => {
  const c = captureFromBytes('x', ['zoom'], sweep(B4Cmd.GetZoom, [1, 2, 3]));
  assert.equal(c.frames.length, 3);
  assert.equal(c.operated[0], 'zoom');
});

test('behaviour groups by code and reports payload length', () => {
  const c = captureFromBytes('x', [], sweep(B4Cmd.GetZoom, [0x0100, 0x0200]));
  const beh = behaviourByCode(c).get(B4Cmd.GetZoom);

  assert.ok(beh);
  assert.equal(beh.count, 2);
  assert.equal(beh.dataLen, 2);
});

test('a rising 16-bit field is found, with its direction and span', () => {
  const c = captureFromBytes('zoom in', ['zoom'], sweep(B4Cmd.GetZoom, [0x1000, 0x2000, 0x3000, 0x4000]));
  const field = behaviourByCode(c).get(B4Cmd.GetZoom)!.monotonic[0]!;

  assert.equal(field.width, 2);
  assert.equal(field.offset, 0);
  assert.equal(field.direction, 'rising');
  assert.equal(field.span, 0x3000);
});

test('a falling field is reported as falling', () => {
  const c = captureFromBytes('zoom out', ['zoom'], sweep(B4Cmd.GetZoom, [0x4000, 0x3000, 0x2000]));
  assert.equal(behaviourByCode(c).get(B4Cmd.GetZoom)!.monotonic[0]!.direction, 'falling');
});

test('repeated values do not break monotonicity — the camera polls faster than a hand turns', () => {
  const c = captureFromBytes('slow', ['focus'], sweep(B4Cmd.GetFocus, [0x1000, 0x1000, 0x1000, 0x2000, 0x2000]));
  const field = behaviourByCode(c).get(B4Cmd.GetFocus)!.monotonic[0]!;

  assert.equal(field.direction, 'rising');
});

test('one step the other way disqualifies the field', () => {
  // Without this, almost anything looks monotonic and a false lead costs a
  // measuring session.
  const c = captureFromBytes('wobble', ['x'], sweep(0x40, [0x1000, 0x2000, 0x1800, 0x3000]));
  assert.deepEqual(behaviourByCode(c).get(0x40)!.monotonic, []);
});

test('a flat field yields no information and is not reported', () => {
  assert.deepEqual(behaviourByCode(idle()).get(B4Cmd.GetIris)!.monotonic, []);
});

test('a code whose payload length varies reports dataLen null and no fields', () => {
  const mixed = Buffer.concat([
    encodeB4Frame(0x41, Buffer.from([0x01])),
    encodeB4Frame(0x41, Buffer.from([0x01, 0x02])),
  ]);
  const beh = behaviourByCode(captureFromBytes('mixed', [], mixed)).get(0x41)!;

  assert.equal(beh.dataLen, null);
  assert.deepEqual(beh.monotonic, []);
});

// ── The actual method: idle vs. exactly one control ──────────────────────────

test('a code that appears only while a control moves is reported as new', () => {
  const after = captureFromBytes(
    'zoom only',
    ['zoom'],
    Buffer.concat([sweep(B4Cmd.GetIris, [0x8000, 0x8000]), sweep(B4Cmd.GetZoom, [0x1000, 0x9000])]),
  );

  const d = diffCaptures(idle(), after);
  assert.deepEqual(d.newCodes, [B4Cmd.GetZoom]);
  assert.deepEqual(d.goneCodes, []);
  assert.deepEqual(d.operatedDelta, ['zoom']);
});

test('a candidate is named when one control moved and one code moved with it', () => {
  const after = captureFromBytes(
    'zoom only',
    ['zoom'],
    Buffer.concat([sweep(B4Cmd.GetIris, [0x8000, 0x8000]), sweep(B4Cmd.GetZoom, [0x1000, 0x9000])]),
  );

  const c = candidateAssignment(diffCaptures(idle(), after));
  assert.ok(c);
  assert.equal(c.control, 'zoom');
  assert.equal(c.cmd, B4Cmd.GetZoom);
  assert.equal(c.evidence, 'new-code');
});

test('a control that only makes an EXISTING code move is still found', () => {
  // The other kind of evidence: no new code, but the iris value starts walking.
  const after = captureFromBytes('iris only', ['iris'], sweep(B4Cmd.GetIris, [0x2000, 0x4000, 0x6000]));

  const c = candidateAssignment(diffCaptures(idle(), after));
  assert.ok(c);
  assert.equal(c.cmd, B4Cmd.GetIris);
  assert.equal(c.evidence, 'moved');
});

test('two controls operated at once yields NO candidate', () => {
  // The method depends on isolating one action. If the notes say two, the
  // recording cannot settle anything, and saying otherwise would be worse
  // than saying nothing.
  const after = captureFromBytes(
    'both',
    ['zoom', 'focus'],
    Buffer.concat([sweep(B4Cmd.GetZoom, [0x1000, 0x9000]), sweep(B4Cmd.GetFocus, [0x1000, 0x9000])]),
  );

  assert.equal(candidateAssignment(diffCaptures(idle(), after)), null);
});

test('two codes moving under one control yields NO candidate', () => {
  const after = captureFromBytes(
    'zoom only',
    ['zoom'],
    Buffer.concat([sweep(B4Cmd.GetZoom, [0x1000, 0x9000]), sweep(0x44, [0x1000, 0x9000])]),
  );

  assert.equal(candidateAssignment(diffCaptures(idle(), after)), null);
});

test('a field that barely moves does not count as evidence', () => {
  const after = captureFromBytes('twitch', ['zoom'], sweep(B4Cmd.GetZoom, [0x1000, 0x1003]));

  assert.equal(candidateAssignment(diffCaptures(idle(), after)), null);
  assert.ok(candidateAssignment(diffCaptures(idle(), after), 2) !== null, 'a lower threshold does accept it');
});

test('a code that disappears is reported too', () => {
  const before = captureFromBytes('with extender', ['extender'], sweep(0x45, [0x0001, 0x0001]));
  const after = captureFromBytes('idle', [], sweep(B4Cmd.GetIris, [0x8000, 0x8000]));

  const d = diffCaptures(before, after);
  assert.deepEqual(d.goneCodes, [0x45]);
});

test('comparing a capture with itself finds nothing', () => {
  const d = diffCaptures(idle(), idle());

  assert.deepEqual(d.newCodes, []);
  assert.deepEqual(d.goneCodes, []);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.operatedDelta, []);
});
