/**
 * FreeD D1 encoder tests (run with `npm test` in packages/bridge).
 * Pure functions only — no socket, no tracking hardware.
 *
 * NOTE on coverage. These tests prove the properties that public sources
 * establish: length, identifier, checksum rule, field placement, sign handling
 * and the angle scale. They do NOT prove byte-exactness against a capture from
 * real FreeD equipment, because no such capture is available here. Issue #54
 * stays open for that check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANGLE_UNITS_PER_DEGREE,
  FREED_D1_ID,
  FREED_D1_LENGTH,
  INT24_MAX,
  UINT24_MAX,
  decodeFreeD,
  encodeFreeD,
  freeDChecksum,
  isValidFreeDPacket,
  type FreeDSample,
} from '../src/protocol/FreeD.js';

const full = (over: Partial<FreeDSample> = {}): FreeDSample => ({
  cameraId: 1,
  panDeg: 0,
  tiltDeg: 0,
  rollDeg: 0,
  xMm: 0,
  yMm: 0,
  zMm: 0,
  zoom: 0,
  focus: 0,
  ...over,
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('a packet is 29 bytes and starts with 0xD1', () => {
  const r = encodeFreeD(full({ cameraId: 7 }));
  assert.ok(r.ok);
  assert.equal(r.packet.length, FREED_D1_LENGTH);
  assert.equal(r.packet[0], FREED_D1_ID);
  assert.equal(r.packet[1], 7);
});

test('checksum rule holds: 0x40 minus the sum of the first 28 bytes', () => {
  const r = encodeFreeD(full({ panDeg: 12.5, zoom: 0x1234 }));
  assert.ok(r.ok);

  let sum = 0;
  for (let i = 0; i < FREED_D1_LENGTH - 1; i += 1) sum = (sum + r.packet[i]!) & 0xff;
  assert.equal(r.packet[28], (0x40 - sum) & 0xff);
  assert.ok(isValidFreeDPacket(r.packet));
});

test('a flipped byte invalidates the packet', () => {
  const r = encodeFreeD(full());
  assert.ok(r.ok);

  const tampered = Buffer.from(r.packet);
  tampered[5] = (tampered[5]! + 1) & 0xff;
  assert.equal(isValidFreeDPacket(tampered), false);
});

test('freeDChecksum is computed over the given bytes only', () => {
  assert.equal(freeDChecksum(new Uint8Array([])), 0x40);
  assert.equal(freeDChecksum(new Uint8Array([0x40])), 0x00);
  assert.equal(freeDChecksum(new Uint8Array([0x41])), 0xff);
});

// ── A missing axis is not a zero ─────────────────────────────────────────────

test('a null axis refuses the packet and names what is missing', () => {
  const r = encodeFreeD(full({ panDeg: null }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.missing.includes('panDeg'));
});

test('several missing axes are all named, not just the first', () => {
  const r = encodeFreeD(full({ xMm: null, yMm: null, zMm: null, focus: null }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.deepEqual([...r.missing].sort(), ['focus', 'xMm', 'yMm', 'zMm']);
});

test('zero is a value and encodes fine — it is not treated as missing', () => {
  const r = encodeFreeD(full());
  assert.ok(r.ok);
  const back = decodeFreeD(r.packet);
  assert.ok(back);
  assert.equal(back.panDeg, 0);
});

// ── Scaling and sign ─────────────────────────────────────────────────────────

test('angles use 1/32768 degree, positive and negative', () => {
  const r = encodeFreeD(full({ panDeg: 1, tiltDeg: -1 }));
  assert.ok(r.ok);

  const pan = (r.packet[2]! << 16) | (r.packet[3]! << 8) | r.packet[4]!;
  assert.equal(pan, ANGLE_UNITS_PER_DEGREE);

  const tiltRaw = (r.packet[5]! << 16) | (r.packet[6]! << 8) | r.packet[7]!;
  assert.equal(tiltRaw - 0x1000000, -ANGLE_UNITS_PER_DEGREE);
});

test('roundtrip preserves angles, position, zoom and focus', () => {
  const sample = full({
    cameraId: 3,
    panDeg: 47.25,
    tiltDeg: -12.5,
    rollDeg: 0.5,
    xMm: 1234.5,
    yMm: -987.25,
    zMm: 1500,
    zoom: 0x00abcd,
    focus: 0x00fedc,
    spare: 0xbeef,
  });

  const r = encodeFreeD(sample);
  assert.ok(r.ok);
  const back = decodeFreeD(r.packet);
  assert.ok(back);

  assert.equal(back.cameraId, 3);
  assert.ok(Math.abs(back.panDeg! - 47.25) < 1e-4);
  assert.ok(Math.abs(back.tiltDeg! - -12.5) < 1e-4);
  assert.ok(Math.abs(back.rollDeg! - 0.5) < 1e-4);
  assert.ok(Math.abs(back.xMm! - 1234.5) < 1e-2);
  assert.ok(Math.abs(back.yMm! - -987.25) < 1e-2);
  assert.equal(back.zoom, 0x00abcd);
  assert.equal(back.focus, 0x00fedc);
  assert.equal(back.spare, 0xbeef);
});

test('out-of-range values clamp instead of wrapping into nonsense', () => {
  const r = encodeFreeD(full({ panDeg: 1e9, zoom: UINT24_MAX + 500 }));
  assert.ok(r.ok);

  const pan = (r.packet[2]! << 16) | (r.packet[3]! << 8) | r.packet[4]!;
  assert.equal(pan, INT24_MAX, 'a huge angle must saturate, not wrap to a negative one');

  const zoom = (r.packet[20]! << 16) | (r.packet[21]! << 8) | r.packet[22]!;
  assert.equal(zoom, UINT24_MAX);
});

test('the spare field defaults to zero and stays 16 bits', () => {
  const r = encodeFreeD(full());
  assert.ok(r.ok);
  assert.equal(r.packet[26], 0);
  assert.equal(r.packet[27], 0);
});

// ── Validation of foreign packets ────────────────────────────────────────────

test('a packet of the wrong length or identifier is rejected', () => {
  assert.equal(isValidFreeDPacket(new Uint8Array(28)), false);
  assert.equal(isValidFreeDPacket(new Uint8Array(FREED_D1_LENGTH)), false); // id 0x00

  assert.equal(decodeFreeD(new Uint8Array(FREED_D1_LENGTH)), null);
});

test('every camera id byte survives', () => {
  for (const id of [0, 1, 127, 255]) {
    const r = encodeFreeD(full({ cameraId: id }));
    assert.ok(r.ok);
    assert.equal(decodeFreeD(r.packet)!.cameraId, id);
  }
});
