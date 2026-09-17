/**
 * B4 lens frame decoder tests (run with `npm test` in packages/bridge).
 * Pure functions only — no lens, no serial port, no hardware required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  B4Cmd,
  B4FrameDecoder,
  B4_MAX_DATA_LEN,
  b4Crc,
  decodeLensName,
  decodeOpenFNumber,
  encodeB4Frame,
} from '../src/protocol/B4Lens.js';

// ── CRC ──────────────────────────────────────────────────────────────────────

test('CRC matches the worked examples from the protocol reference', () => {
  // "00 53 XX" — minimal frame, no data. 0x00 + 0x53 = 0x53 -> 0x100-0x53 = 0xAD
  assert.equal(b4Crc(Buffer.from([0x00, 0x53])), 0xad);

  // "0A 53 01..0A XX" — ten data bytes. 0x0A + 0x53 + 55 = 0x94 -> 0x6C
  const body = Buffer.from([0x0a, 0x53, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(b4Crc(body), 0x6c);
});

test('a complete valid frame sums to zero in the low byte', () => {
  for (const cmd of [0x01, 0x11, 0x30, 0xff]) {
    const frame = encodeB4Frame(cmd, Buffer.from([0xde, 0xad]));
    const sum = frame.reduce((a, b) => (a + b) & 0xff, 0);
    assert.equal(sum, 0, `frame for cmd 0x${cmd.toString(16)} did not sum to zero`);
  }
});

// ── Encoding ─────────────────────────────────────────────────────────────────

test('encode builds length, cmd, data, crc in that order', () => {
  assert.deepEqual([...encodeB4Frame(0x53)], [0x00, 0x53, 0xad]);
  assert.deepEqual(
    [...encodeB4Frame(0x53, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))],
    [0x0a, 0x53, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x6c],
  );
});

test('encode refuses more than 15 data bytes and non-byte commands', () => {
  assert.throws(() => encodeB4Frame(0x20, Buffer.alloc(B4_MAX_DATA_LEN + 1)), RangeError);
  assert.throws(() => encodeB4Frame(0x100), RangeError);
  assert.throws(() => encodeB4Frame(-1), RangeError);
});

// ── Decoding ─────────────────────────────────────────────────────────────────

test('decodes both worked examples', () => {
  const d = new B4FrameDecoder();
  const frames = d.push(Buffer.from([0x00, 0x53, 0xad, 0x0a, 0x53, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x6c]));

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.cmd, 0x53);
  assert.equal(frames[0]!.data.length, 0);
  assert.deepEqual([...frames[1]!.data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(d.stats().framesDecoded, 2);
  assert.equal(d.stats().bytesDropped, 0);
});

test('a frame split across three chunks still decodes, and nothing leaks early', () => {
  const d = new B4FrameDecoder();
  const frame = encodeB4Frame(B4Cmd.GetZoom, Buffer.from([0x12, 0x34]));

  assert.deepEqual(d.push(frame.subarray(0, 2)), []);
  assert.deepEqual(d.push(frame.subarray(2, 4)), []);
  assert.ok(d.pending > 0);

  const out = d.push(frame.subarray(4));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.cmd, B4Cmd.GetZoom);
  assert.deepEqual([...out[0]!.data], [0x12, 0x34]);
  assert.equal(d.pending, 0);
});

test('a wrong CRC is dropped and counted, never handed out', () => {
  const d = new B4FrameDecoder();
  const bad = Buffer.from([0x00, 0x53, 0xae]); // 0xAD would be right

  assert.deepEqual(d.push(bad), []);
  assert.equal(d.stats().framesDecoded, 0);
  assert.ok(d.stats().crcErrors >= 1);
});

test('a length byte above 0x0F is rejected without consuming a whole frame', () => {
  const d = new B4FrameDecoder();
  d.push(Buffer.from([0x10, 0x53, 0x00]));

  assert.equal(d.stats().lengthErrors, 1);
  assert.equal(d.stats().framesDecoded, 0);
});

test('resynchronises after leading garbage and finds the next real frame', () => {
  const d = new B4FrameDecoder();
  const good = encodeB4Frame(B4Cmd.LensNameFirst, Buffer.from('FUJINON', 'ascii'));
  const noisy = Buffer.concat([Buffer.from([0xff, 0xfe, 0x7f, 0x11]), good]);

  const out = d.push(noisy);

  assert.equal(out.length, 1);
  assert.equal(out[0]!.cmd, B4Cmd.LensNameFirst);
  assert.ok(d.stats().bytesDropped > 0, 'garbage should have been counted as dropped');
});

test('a truncated frame is held, not guessed at', () => {
  const d = new B4FrameDecoder();
  const frame = encodeB4Frame(B4Cmd.GetIris, Buffer.from([0x80, 0x00]));

  assert.deepEqual(d.push(frame.subarray(0, frame.length - 1)), []);
  assert.equal(d.stats().framesDecoded, 0);
  assert.equal(d.stats().crcErrors, 0, 'an incomplete frame is not a CRC error');
});

test('the documented idle bytes FB 03 do not produce a frame', () => {
  const d = new B4FrameDecoder();
  assert.deepEqual(d.push(Buffer.from([0xfb, 0x03, 0xfb, 0x03])), []);
  assert.equal(d.stats().framesDecoded, 0);
});

test('reset clears buffered bytes but keeps the counters', () => {
  const d = new B4FrameDecoder();
  d.push(Buffer.from([0x00, 0x53, 0xae])); // bad CRC
  const before = d.stats().crcErrors;

  d.push(Buffer.from([0x05]));
  d.reset();

  assert.equal(d.pending, 0);
  assert.equal(d.stats().crcErrors, before);
});

test('every frame survives a roundtrip for all legal data lengths', () => {
  for (let len = 0; len <= B4_MAX_DATA_LEN; len += 1) {
    const data = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) & 0xff));
    const d = new B4FrameDecoder();
    const out = d.push(encodeB4Frame(B4Cmd.SetFocus, data));

    assert.equal(out.length, 1, `length ${len} did not decode`);
    assert.deepEqual([...out[0]!.data], [...data]);
  }
});

// ── Payload helpers ──────────────────────────────────────────────────────────

test('lens name joins both halves and drops non-printable bytes', () => {
  const first = Buffer.from('FUJINON XA20sx', 'ascii');
  const second = Buffer.from([0x38, 0x2e, 0x35, 0x00, 0x00]); // "8.5" plus padding

  assert.equal(decodeLensName(first, second), 'FUJINON XA20sx8.5');
  assert.equal(decodeLensName(Buffer.from([0x00, 0x01])), '');
});

test('open F number decodes the documented anchor points', () => {
  // The exponent runs 8 -> 0 as raw runs 0x0000 -> 0x10000, so the bottom of
  // the two-byte range is the closed end.
  const closed = decodeOpenFNumber(Buffer.from([0x00, 0x00]));
  assert.ok(closed !== null);
  assert.ok(Math.abs(closed - 256) < 1e-6, `expected F256 at 0x0000, got ${closed}`);

  // One stop is 0x1000 and one stop in F numbers is a factor of sqrt(2), so
  // 0xF000 is one stop off F1.0 and 0xE000 is two.
  const oneStop = decodeOpenFNumber(Buffer.from([0xf0, 0x00]));
  assert.ok(oneStop !== null);
  assert.ok(Math.abs(oneStop - Math.SQRT2) < 1e-9, `expected F1.4 at 0xF000, got ${oneStop}`);

  const twoStops = decodeOpenFNumber(Buffer.from([0xe0, 0x00]));
  assert.ok(twoStops !== null);
  assert.ok(Math.abs(twoStops - 2) < 1e-9, `expected F2.0 at 0xE000, got ${twoStops}`);
});

test('an F number payload of the wrong length yields null, not a number', () => {
  assert.equal(decodeOpenFNumber(Buffer.from([0x01])), null);
  assert.equal(decodeOpenFNumber(Buffer.from([])), null);
  assert.equal(decodeOpenFNumber(Buffer.from([1, 2, 3])), null);
});
