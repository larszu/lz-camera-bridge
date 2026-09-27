/**
 * Das Werkbank-Werkzeug fuer Mitschnitte (#43, #45, #47). Synthetische
 * Mitschnitte: bewiesen wird die Auswertung, nicht die Bedeutung eines Codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeB4Frame } from '../src/protocol/B4Lens.js';
import { lensNameIn, parseArg, report } from '../src/tools/b4Capture.js';
import { captureFromBytes } from '../src/protocol/B4CaptureDiff.js';

const poll = (cmd: number, values: number[]) =>
  Buffer.concat(values.map((v) => encodeB4Frame(cmd, Buffer.from([v >> 8, v & 0xff]))));

test('Objektivname aus 0x11 allein und aus 0x11 + 0x12', () => {
  const short = captureFromBytes('a', [], encodeB4Frame(0x11, Buffer.from('TEST LENS')));
  assert.equal(lensNameIn(short), 'TEST LENS');
  const long = captureFromBytes('b', [], Buffer.concat([
    encodeB4Frame(0x11, Buffer.from('ABCDEFGHIJKLMNO')),
    encodeB4Frame(0x12, Buffer.from('PQR')),
  ]));
  assert.equal(lensNameIn(long), 'ABCDEFGHIJKLMNOPQR');
  assert.equal(lensNameIn(captureFromBytes('c', [], poll(0x30, [1, 2]))), null);
});

test('Bericht: Grundlinie, Kandidat nur bei genau einer Bedienung', () => {
  const idle = { label: 'idle', operated: [], bytes: poll(0x30, [0x8000, 0x8000, 0x8000]) };
  const zoom = {
    label: 'zoom',
    operated: ['zoom'],
    bytes: Buffer.concat([poll(0x30, [0x8000, 0x8000]), poll(0x31, [0x1000, 0x3000, 0x6000])]),
  };
  const text = report([idle, zoom]);
  assert.match(text, /new codes: 0x31/);
  assert.match(text, /CANDIDATE: zoom ↔ 0x31 \(new-code\)/);

  const both = { ...zoom, label: 'both', operated: ['zoom', 'focus'] };
  assert.match(report([idle, both]), /no single candidate/);
});

test('Muell ohne gueltigen Rahmen wird benannt statt verschwiegen', () => {
  const text = report([{ label: 'noise', operated: [], bytes: Buffer.from([0xfb, 0x03, 0xfb, 0x03]) }]);
  assert.match(text, /0 frames/);
  assert.match(text, /wrong baud rate, missing inversion/);
});

test('Argumente: Datei, Bedienung, idle', () => {
  assert.deepEqual(parseArg('cap/zoom.bin:zoom'), { file: 'cap/zoom.bin', label: 'zoom.bin', operated: ['zoom'] });
  assert.deepEqual(parseArg('idle.bin'), { file: 'idle.bin', label: 'idle.bin', operated: [] });
  assert.deepEqual(parseArg('i.bin:idle'), { file: 'i.bin', label: 'i.bin', operated: [] });
});
