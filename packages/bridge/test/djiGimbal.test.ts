/**
 * DJI R SDK und SLCAN -- die Teile, die ohne Ronin pruefbar sind.
 *
 * Wieder der Vorbehalt: belegt ist, dass die Rahmen in sich stimmen, NICHT
 * dass ein Geraet sie annimmt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rsdkBauen, rsdkLesen, rsdkCrc16, rsdkCrc32, RsdkPruefFehler,
  rsdkGeschwindigkeit, rsdkPosition, RSDK_SOF, RSDK_CMDSET_GIMBAL, RSDK_CMD_GESCHWINDIGKEIT,
} from '../src/protocol/DjiRSdk.js';
import {
  slcanSendezeile, slcanLeseZeile, inCanHaeppchen, CAN_ID_ZU_GIMBAL,
} from '../src/transport/SlcanTransport.js';

const beispiel = {
  folge: 0x0042,
  cmdSet: RSDK_CMDSET_GIMBAL,
  cmdId: RSDK_CMD_GESCHWINDIGKEIT,
  nutzlast: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
};

test('R SDK: Hin- und Rueckweg erhalten jedes Feld', () => {
  const g = rsdkLesen(rsdkBauen(beispiel));
  assert.equal(g.folge, beispiel.folge);
  assert.equal(g.cmdSet, beispiel.cmdSet);
  assert.equal(g.cmdId, beispiel.cmdId);
  assert.deepEqual([...g.nutzlast], [1, 2, 3, 4, 5, 6, 7]);
});

test('R SDK: Rahmen beginnt mit 0xAA und traegt seine Laenge', () => {
  const b = rsdkBauen(beispiel);
  assert.equal(b[0], RSDK_SOF);
  assert.equal(b.readUInt16LE(1) & 0x1fff, b.length);
  assert.equal(b.length, 18 + 7);
});

test('R SDK: verfaelschte Nutzlast faellt beim CRC32 auf', () => {
  const b = rsdkBauen(beispiel);
  b[15] ^= 0xff;
  assert.throws(() => rsdkLesen(b), RsdkPruefFehler);
});

test('R SDK: verfaelschter Kopf faellt beim CRC16 auf', () => {
  const b = rsdkBauen(beispiel);
  b[8] ^= 0xff; // Folgenummer im vom CRC16 gedeckten Kopf
  assert.throws(() => rsdkLesen(b), /CRC16/);
});

test('R SDK: beide Pruefsummen bleiben in ihrem Wertebereich', () => {
  for (let i = 0; i < 256; i += 7) {
    assert.ok(rsdkCrc16([i]) >= 0 && rsdkCrc16([i]) <= 0xffff);
    assert.ok(rsdkCrc32([i]) >= 0 && rsdkCrc32([i]) <= 0xffffffff);
  }
});

test('R SDK: Geschwindigkeit traegt das Uebernahme-Byte 0x80', () => {
  // Ohne dieses Byte ignoriert der Kopf die Fahrt -- der Fehler, den man
  // sonst erst mit Hardware findet.
  const p = Buffer.from(rsdkGeschwindigkeit({ yaw: 30 }));
  assert.equal(p.readInt16LE(0), 300);
  assert.equal(p[6], 0x80);
});

test('R SDK: Position ist absolut und traegt eine Fahrzeit', () => {
  const p = Buffer.from(rsdkPosition({ yaw: -15, pitch: 20 }, 25));
  assert.equal(p.readInt16LE(0), -150);
  assert.equal(p.readInt16LE(4), 200);
  assert.equal(p[6], 0x01);
  assert.equal(p[7], 25);
});

test('SLCAN: Sendezeile hat das Lawicel-Format', () => {
  const z = slcanSendezeile({ id: CAN_ID_ZU_GIMBAL, daten: Buffer.from([0xaa, 0x0f]) });
  assert.equal(z, 't2232AA0F\r');
});

test('SLCAN: Lesen kehrt das Senden um', () => {
  const rahmen = { id: 0x222, daten: Buffer.from([1, 2, 3]) };
  const gelesen = slcanLeseZeile(slcanSendezeile(rahmen));
  assert.ok(gelesen);
  assert.equal(gelesen.id, 0x222);
  assert.deepEqual([...gelesen.daten], [1, 2, 3]);
});

test('SLCAN: abgeschnittene oder fremde Zeilen ergeben null statt Unsinn', () => {
  assert.equal(slcanLeseZeile('z\r'), null, 'Bestaetigung ist kein Datenrahmen');
  assert.equal(slcanLeseZeile('t2238AABB'), null, 'zu wenige Datenbytes fuer die Laenge');
  assert.equal(slcanLeseZeile(''), null);
});

test('SLCAN: Kennungen ueber 11 bit und zu lange Rahmen werden abgewiesen', () => {
  // Beides still zu kuerzen hiesse, auf einer anderen Kennung zu senden.
  assert.throws(() => slcanSendezeile({ id: 0x800, daten: Buffer.alloc(0) }), /11 bit/);
  assert.throws(() => slcanSendezeile({ id: 0x223, daten: Buffer.alloc(9) }), /8 Bytes/);
});

test('ein R-SDK-Rahmen wird in 8-Byte-Haeppchen zerlegt, ohne ein Byte zu verlieren', () => {
  const rahmen = rsdkBauen(beispiel);
  const haeppchen = inCanHaeppchen(rahmen);
  assert.equal(haeppchen.length, Math.ceil(rahmen.length / 8));
  for (const h of haeppchen) assert.ok(h.daten.length <= 8);
  assert.deepEqual([...Buffer.concat(haeppchen.map((h) => h.daten))], [...rahmen]);
});
