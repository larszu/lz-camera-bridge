/**
 * DUML -- die Rechenwege, die ohne Geraet pruefbar sind.
 *
 * Was diese Faelle NICHT belegen: dass eine Pocket die Pakete annimmt. Dafuer
 * braeuchte es die Kamera. Belegt ist, dass Rahmen und Pruefsummen in sich
 * stimmen und dass der Stromleser die Faelle uebersteht, an denen ein
 * naiver Leser scheitert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dumlBauen, dumlLesen, dumlCrc8, dumlCrc16, DumlStromLeser, DumlPruefFehler,
  dumlAbsoluterWinkel, dumlGeschwindigkeit,
  DUML_SOF, DUML_CMDSET_GIMBAL, DUML_CMD_GIMBAL_ABSOLUT,
} from '../src/protocol/Duml.js';

const beispiel = {
  sender: 0x0a, empfaenger: 0x03, folge: 0x1234, flags: 0x40,
  cmdSet: DUML_CMDSET_GIMBAL, cmdId: DUML_CMD_GIMBAL_ABSOLUT,
  nutzlast: new Uint8Array([1, 2, 3, 4]),
};

test('CRC8 und CRC16 sind bestimmt und nicht trivial', () => {
  assert.equal(dumlCrc8([]), 0xee, 'leer ergibt den Startwert');
  assert.equal(typeof dumlCrc8([0x55, 0x0e, 0x04]), 'number');
  assert.notEqual(dumlCrc8([0x01]), dumlCrc8([0x02]));
  assert.notEqual(dumlCrc16([0x01]), dumlCrc16([0x02]));
  // Beide bleiben in ihrem Wertebereich -- ein Ueberlauf faellt sonst erst
  // beim Geraet auf, und dort als "antwortet nicht".
  for (let i = 0; i < 256; i++) {
    assert.ok(dumlCrc8([i]) >= 0 && dumlCrc8([i]) <= 0xff);
    assert.ok(dumlCrc16([i]) >= 0 && dumlCrc16([i]) <= 0xffff);
  }
});

test('Hin- und Rueckweg erhalten jedes Feld', () => {
  const gelesen = dumlLesen(dumlBauen(beispiel));
  assert.equal(gelesen.sender, beispiel.sender);
  assert.equal(gelesen.empfaenger, beispiel.empfaenger);
  assert.equal(gelesen.folge, beispiel.folge);
  assert.equal(gelesen.flags, beispiel.flags);
  assert.equal(gelesen.cmdSet, beispiel.cmdSet);
  assert.equal(gelesen.cmdId, beispiel.cmdId);
  assert.deepEqual([...gelesen.nutzlast], [1, 2, 3, 4]);
});

test('der Rahmen faengt mit 0x55 an und traegt seine eigene Laenge', () => {
  const b = dumlBauen(beispiel);
  assert.equal(b[0], DUML_SOF);
  assert.equal(b.readUInt16LE(1) & 0x3ff, b.length);
  assert.equal(b.length, 13 + 4);
});

test('die Folgenummer steht in BIG-Endian -- die Falle des Rahmens', () => {
  const b = dumlBauen({ ...beispiel, folge: 0x1234 });
  assert.equal(b[6], 0x12, 'hohes Byte zuerst');
  assert.equal(b[7], 0x34);
});

test('ein verfaelschtes Byte faellt beim CRC16 auf', () => {
  const b = dumlBauen(beispiel);
  b[12] ^= 0xff; // irgendwo in der Nutzlast
  assert.throws(() => dumlLesen(b), DumlPruefFehler);
});

test('ein verfaelschter Kopf faellt beim CRC8 auf', () => {
  const b = dumlBauen(beispiel);
  b[3] ^= 0xff;
  assert.throws(() => dumlLesen(b), /CRC8/);
});

test('Stromleser: zwei Rahmen in einem Haeppchen', () => {
  const leser = new DumlStromLeser();
  const roh = Buffer.concat([dumlBauen(beispiel), dumlBauen({ ...beispiel, folge: 9 })]);
  const fertig = leser.push(roh);
  assert.equal(fertig.length, 2);
  assert.equal(fertig[1].folge, 9);
});

test('Stromleser: ein Rahmen byteweise zugestellt', () => {
  const leser = new DumlStromLeser();
  const roh = dumlBauen(beispiel);
  let fertig: ReturnType<DumlStromLeser['push']> = [];
  for (const b of roh) fertig = fertig.concat(leser.push(Buffer.from([b])));
  assert.equal(fertig.length, 1);
  assert.equal(fertig[0].folge, beispiel.folge);
});

test('Stromleser: ein 0x55 IN der Nutzlast reisst den Rahmen nicht auf', () => {
  // Der Fall, an dem ein Leser scheitert, der nur nach dem Startbyte sucht.
  const leser = new DumlStromLeser();
  const mitSof = { ...beispiel, nutzlast: new Uint8Array([0x55, 0x55, 0x55, 0x55]) };
  const fertig = leser.push(dumlBauen(mitSof));
  assert.equal(fertig.length, 1);
  assert.deepEqual([...fertig[0].nutzlast], [0x55, 0x55, 0x55, 0x55]);
});

test('Stromleser: Muell vor dem Rahmen wird uebersprungen', () => {
  const leser = new DumlStromLeser();
  const fertig = leser.push(Buffer.concat([Buffer.from([0x00, 0xff, 0xab]), dumlBauen(beispiel)]));
  assert.equal(fertig.length, 1);
});

test('Winkel werden in Zehntelgrad als int16 gefuehrt', () => {
  const p = Buffer.from(dumlAbsoluterWinkel({ yaw: 90, roll: 0, pitch: -45 }));
  assert.equal(p.readInt16LE(0), 900);
  assert.equal(p.readInt16LE(2), 0);
  assert.equal(p.readInt16LE(4), -450, 'negative Winkel bleiben negativ');
  assert.equal(p[6], 0x01, 'Modus absolut');
});

test('Geschwindigkeit nutzt denselben Aufbau, aber Modus 0', () => {
  const p = Buffer.from(dumlGeschwindigkeit({ yaw: -12.3 }));
  assert.equal(p.readInt16LE(0), -123);
  assert.equal(p[6], 0x00);
});

test('Winkel jenseits von int16 werden begrenzt statt ueberzulaufen', () => {
  // Ohne Begrenzung ergaebe 4000 Grad einen Ueberlauf und damit einen
  // VOLLKOMMEN anderen Winkel -- der Gimbal faehrt dann irgendwohin.
  const p = Buffer.from(dumlAbsoluterWinkel({ yaw: 40000 }));
  assert.equal(p.readInt16LE(0), 32767);
});
