/**
 * Protocol framing unit tests (run with `npm test` in packages/bridge).
 * Pure functions only — no camera or network required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  packCommand,
  packData,
  parseContainer,
  PTP_CONTAINER_COMMAND,
  PTP_CONTAINER_DATA,
  PTP_CONTAINER_HEADER_LEN,
  PTP_OC_OpenSession,
  encodeFNumber,
  encodeIso,
  encodeShutterSpeed,
  encodeColorTemp,
  encodeButton,
  irisPositionToFNumber,
  GAIN_INDEX_TO_ISO,
  SONY_BUTTON_DOWN,
} from '../src/protocol/SonyPtp.js';

import {
  wrapSonyVisca,
  buildSonyResetSequence,
  SONY_PAYLOAD_COMMAND,
} from '../src/cameras/ViscaClient.js';

// ── Sony PTP (USB) ───────────────────────────────────────────────────────────

test('PTP command container roundtrip', () => {
  const cmd = packCommand(PTP_OC_OpenSession, 7, [1, 0, 0]);
  assert.equal(cmd.length, PTP_CONTAINER_HEADER_LEN + 12);
  assert.equal(cmd.readUInt32LE(0), cmd.length);

  const c = parseContainer(cmd);
  assert.ok(c);
  assert.equal(c.type, PTP_CONTAINER_COMMAND);
  assert.equal(c.code, PTP_OC_OpenSession);
  assert.equal(c.transactionId, 7);
  assert.equal(c.payload.readUInt32LE(0), 1);
});

test('PTP data container roundtrip', () => {
  const d = packData(0x9205, 42, Buffer.from([0x18, 0x01]));
  const c = parseContainer(d);
  assert.ok(c);
  assert.equal(c.type, PTP_CONTAINER_DATA);
  assert.equal(c.code, 0x9205);
  assert.equal(c.transactionId, 42);
  assert.deepEqual([...c.payload], [0x18, 0x01]);
});

test('PTP parseContainer clamps a partial data phase', () => {
  const cmd = packCommand(PTP_OC_OpenSession, 1, [1, 2, 3]);
  const partial = cmd.subarray(0, PTP_CONTAINER_HEADER_LEN + 4);
  const c = parseContainer(partial);
  assert.ok(c);
  assert.equal(c.length, cmd.length, 'declared length preserved');
  assert.equal(c.payload.length, 4, 'payload clamped to available bytes');
  assert.equal(parseContainer(Buffer.alloc(4)), null);
});

test('Sony PTP value encoders', () => {
  assert.deepEqual([...encodeFNumber(2.8)], [0x18, 0x01], 'F2.8 = 280 LE');
  assert.deepEqual([...encodeFNumber(4.0)], [0x90, 0x01], 'F4.0 = 400 LE');
  assert.deepEqual([...encodeIso(800)], [0x20, 0x03, 0x00, 0x00]);
  assert.deepEqual([...encodeShutterSpeed(1, 60)], [0x3c, 0x00, 0x01, 0x00]);
  assert.deepEqual([...encodeColorTemp(5600)], [0xe0, 0x15]);
  assert.deepEqual([...encodeButton(SONY_BUTTON_DOWN)], [0x02, 0x00]);
});

test('iris position ↔ F-number mapping bounds', () => {
  assert.ok(Math.abs(irisPositionToFNumber(0) - 1.4) < 1e-9);
  assert.ok(Math.abs(irisPositionToFNumber(255) - 22.0) < 1e-9);
  assert.equal(GAIN_INDEX_TO_ISO[0], 800);
  assert.equal(GAIN_INDEX_TO_ISO[6], 51200);
});

// ── Sony VISCA over IP (BRC/SRG, BirdDog) ────────────────────────────────────

test('Sony VISCA header matches the documented spec example', () => {
  // Preset-Recall 1: 01 00 00 07 00 00 00 01 | 81 01 04 3F 02 01 FF
  const payload = Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, 0x01, 0xff]);
  const pkt = wrapSonyVisca(payload, 1, SONY_PAYLOAD_COMMAND);
  assert.equal(pkt.toString('hex'), '01000007000000018101043f0201ff');
});

test('Sony VISCA reset-sequence control packet', () => {
  assert.equal(buildSonyResetSequence().toString('hex'), '020000010000000001');
});

test('Sony VISCA header length and sequence fields', () => {
  const pkt = wrapSonyVisca(Buffer.from([0x81, 0x09, 0x00, 0x02, 0xff]), 0x0a0b0c0d);
  assert.equal(pkt.readUInt16BE(2), 5);
  assert.equal(pkt.readUInt32BE(4), 0x0a0b0c0d);
});
