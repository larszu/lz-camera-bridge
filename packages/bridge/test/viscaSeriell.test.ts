/**
 * VISCA am Kabel -- die Teile, die OHNE Kamera pruefbar sind.
 *
 * Der Fehler, den man beim seriellen Lesen macht, ist anzunehmen, ein
 * `data`-Ereignis sei ein Paket. Serielle Daten kommen in beliebigen
 * Haeppchen: zwei Antworten koennen in einem Haeppchen liegen, eine Antwort
 * ueber drei verteilt sein. Genau das pruefen die ersten Faelle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ViscaFrameParser,
  viscaKopf,
  buildIfClearBroadcast,
  VISCA_TERMINATOR,
} from '../src/transport/ViscaSerialTransport.js';

test('ein Haeppchen, ein vollstaendiges Paket', () => {
  const p = new ViscaFrameParser();
  const fertig = p.push(Buffer.from([0x90, 0x41, 0xff]));
  assert.equal(fertig.length, 1);
  assert.deepEqual([...fertig[0]], [0x90, 0x41, 0xff]);
  assert.deepEqual(p.angefangen, []);
});

test('ZWEI Pakete in EINEM Haeppchen werden beide erkannt', () => {
  const p = new ViscaFrameParser();
  // ACK und Completion kommen dicht hintereinander und landen regelmaessig
  // im selben Lesevorgang.
  const fertig = p.push(Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff]));
  assert.equal(fertig.length, 2);
  assert.deepEqual([...fertig[0]], [0x90, 0x41, 0xff]);
  assert.deepEqual([...fertig[1]], [0x90, 0x51, 0xff]);
});

test('ein Paket ueber drei Haeppchen verteilt ergibt genau ein Paket', () => {
  const p = new ViscaFrameParser();
  assert.deepEqual(p.push(Buffer.from([0x90])), []);
  assert.deepEqual(p.push(Buffer.from([0x50, 0x02])), []);
  const fertig = p.push(Buffer.from([VISCA_TERMINATOR]));
  assert.equal(fertig.length, 1);
  assert.deepEqual([...fertig[0]], [0x90, 0x50, 0x02, 0xff]);
});

test('ein angefangenes Paket wird NICHT ausgeliefert', () => {
  const p = new ViscaFrameParser();
  assert.deepEqual(p.push(Buffer.from([0x90, 0x50])), []);
  assert.deepEqual(p.angefangen, [0x90, 0x50]);
});

test('Adressbyte: 1..7 ergibt 0x81..0x87', () => {
  assert.equal(viscaKopf(1), 0x81);
  assert.equal(viscaKopf(3), 0x83);
  assert.equal(viscaKopf(7), 0x87);
});

test('Adressen ausserhalb 1..7 werden abgewiesen statt still falsch zu rechnen', () => {
  // 0 waere der Rundruf und 8 gibt es nicht -- beides stillschweigend zu
  // akzeptieren hiesse, die falsche Kamera zu schwenken.
  assert.throws(() => viscaKopf(0), /1\.\.7/);
  assert.throws(() => viscaKopf(8), /1\.\.7/);
  assert.throws(() => viscaKopf(1.5), /1\.\.7/);
});

test('IF_Clear ist ein Rundruf und endet mit dem Terminator', () => {
  assert.deepEqual([...buildIfClearBroadcast()], [0x88, 0x01, 0x00, 0x01, 0xff]);
});
