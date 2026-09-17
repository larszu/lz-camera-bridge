/**
 * Was ein Gamepad am Bedienpult-Eingang ausloest.
 *
 * Gemessen wird die REINE Auswertung (`berechneBefehle`), nicht `node-hid`:
 * das native Modul ist optional, und ein Test, der es braucht, liefe hier
 * nicht. Die Reports sind von Hand gebaute Buffer — genau das, was der
 * Controller auf den Draht legt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BINDINGS,
  DUALSENSE_BINDINGS,
  PID_DUALSENSE,
  PID_DUALSHOCK4_V2,
  VENDOR_SONY,
  achsenWert,
  berechneBefehle,
  istBekanntesGamepad,
  standardBindungen,
  type HidBinding,
  type ReportZustand,
} from '../src/input/HidControlSurface.ts';

/** Ein DualSense-USB-Report in Ruhe: Sticks mittig, Trigger los. */
function ruheReport(): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 0x01;
  b[1] = 128; // LX
  b[2] = 128; // LY
  b[3] = 128; // RX
  b[4] = 128; // RY
  return b;
}

test('ein bekannter DualSense bekommt die Fahr-Belegung, kein Paint', () => {
  assert.equal(standardBindungen(VENDOR_SONY, PID_DUALSENSE), DUALSENSE_BINDINGS);
  assert.ok(istBekanntesGamepad(VENDOR_SONY, PID_DUALSENSE));
  assert.ok(istBekanntesGamepad(VENDOR_SONY, PID_DUALSHOCK4_V2));

  // Der Punkt dahinter: keine Stick-Achse darf auf setIris landen. Am
  // DigitalBird-DB3 ist setIris ein 9-Byte-Paket, dessen Bytes 6/7 der
  // Decoder als Pan/Tilt-Richtung liest -- der Kopf faehrt dann los.
  const befehle = DUALSENSE_BINDINGS.map((b) => b.command);
  assert.ok(!befehle.includes('setIris'));
  assert.ok(!befehle.includes('setMasterGain'));
});

test('ein unbekanntes Pult behaelt die bisherige Paint-Belegung', () => {
  assert.equal(standardBindungen(0x1234, 0x5678), DEFAULT_BINDINGS);
  assert.ok(!istBekanntesGamepad(0x1234, 0x5678));
});

test('die Ruhelage sendet keinen Fahrbefehl', () => {
  const z: ReportZustand = new Map();
  const erste = berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);
  // Beim ersten Report ist alles neu, also darf die Ruhelage einmal als
  // Stopp durchgehen -- aber mit den Werten 0 und nicht mit halber Fahrt.
  const ptz = erste.find((c) => c.cmd === 'ptz');
  assert.deepEqual(ptz?.params, { pan: 0, tilt: 0 });

  // Und danach gar nichts mehr, solange niemand etwas anfasst.
  assert.deepEqual(berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z), []);
});

test('Zittern in den letzten Bits bleibt Ruhe (Totband)', () => {
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const wackelt = ruheReport();
  wackelt[1] = 133; // 5 Zaehler neben der Mitte, Totband ist 6
  wackelt[2] = 124;
  assert.deepEqual(berechneBefehle(DUALSENSE_BINDINGS, wackelt, z), []);
});

test('Stick nach oben links fahert den Kopf nach oben links', () => {
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const r = ruheReport();
  r[1] = 0;   // LX ganz links
  r[2] = 0;   // LY ganz oben (kleiner Rohwert)
  const befehle = berechneBefehle(DUALSENSE_BINDINGS, r, z);

  const ptz = befehle.find((c) => c.cmd === 'ptz');
  assert.ok(ptz, 'pan und tilt muessen in EINEM Befehl kommen');
  assert.equal(ptz.params.pan, -100);
  // Oben am Stick ist der kleine Rohwert; `gain: -1` dreht das um, damit
  // der ViscaClient (tilt > 0 = hoch) dasselbe meint wie die Hand.
  assert.equal(ptz.params.tilt, 100);
  // Genau ein ptz-Befehl, nicht zwei -- zwei Fahrten hoben sich gegenseitig auf.
  assert.equal(befehle.filter((c) => c.cmd === 'ptz').length, 1);
});

test('Loslassen schickt den Stopp, auch wenn er klein ist', () => {
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const gefahren = ruheReport();
  gefahren[1] = 255;
  berechneBefehle(DUALSENSE_BINDINGS, gefahren, z);

  const los = berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);
  const ptz = los.find((c) => c.cmd === 'ptz');
  assert.deepEqual(ptz?.params, { pan: 0, tilt: 0 });
});

test('die Trigger fahren den Zoom in beide Richtungen', () => {
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const tele = ruheReport();
  tele[6] = 255; // R2
  const a = berechneBefehle(DUALSENSE_BINDINGS, tele, z).find((c) => c.cmd === 'setZoom');
  assert.equal(a?.params.value, 100);

  const weit = ruheReport();
  weit[5] = 255; // L2
  const b = berechneBefehle(DUALSENSE_BINDINGS, weit, z).find((c) => c.cmd === 'setZoom');
  assert.equal(b?.params.value, -100);
});

test('vier Tasten in EINEM Byte loeschen sich nicht mehr gegenseitig aus', () => {
  // Das war der Fehler: der Merker lag auf dem Byte-Offset, nicht auf der
  // Bindung. Wer Quadrat und Kreuz im selben Byte belegte, bekam einen
  // Tastendruck statt zweien.
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const zwei = ruheReport();
  zwei[8] = (1 << 4) | (1 << 5); // Quadrat und Kreuz zugleich
  const befehle = berechneBefehle(DUALSENSE_BINDINGS, zwei, z)
    .filter((c) => c.cmd === 'recallPreset')
    .map((c) => c.params.value);
  assert.deepEqual(befehle.sort(), [1, 2]);

  // Halten ist kein zweiter Druck.
  assert.deepEqual(berechneBefehle(DUALSENSE_BINDINGS, zwei, z), []);
});

test('einseitige Achsen rechnen wie bisher (die Pult-Bindungen bleiben heil)', () => {
  const fader: HidBinding = { kind: 'axis', offset: 1, command: 'setIris', paramKey: 'value' };
  assert.equal(achsenWert(fader, 0), 0);
  assert.equal(achsenWert(fader, 255), 255);
  assert.equal(achsenWert(fader, 128), 128);

  const gain: HidBinding = { kind: 'axis', offset: 2, command: 'setMasterGain', paramKey: 'value', max: 7 };
  assert.equal(achsenWert(gain, 7), 255);
});

test('eine zweiseitige Achse ist in der Mitte null und an den Enden voll', () => {
  const stick: HidBinding = { kind: 'axis', offset: 1, command: 'ptz', paramKey: 'pan', centre: 128, deadband: 6, span: 100 };
  assert.equal(achsenWert(stick, 128), 0);
  assert.equal(achsenWert(stick, 255), 100);
  assert.equal(achsenWert(stick, 0), -100);
  assert.equal(achsenWert(stick, 134), 0, 'am Rand des Totbandes noch Ruhe');
  assert.ok(achsenWert(stick, 200) > 0 && achsenWert(stick, 200) < 100);
});

test('beide Trigger zugleich heisst Stillstand, nicht Zufall', () => {
  // Vorher war das von der Reihenfolge der Bindungen abhaengig: der eine
  // Trigger schickte Fahrt, der andere im selben Report den Stopp, und wer
  // gewann, entschied die Tabellenzeile. Addiert ist es eine Aussage.
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, ruheReport(), z);

  const beide = ruheReport();
  beide[5] = 255;
  beide[6] = 255;
  const zoom = berechneBefehle(DUALSENSE_BINDINGS, beide, z).filter((c) => c.cmd === 'setZoom');
  assert.equal(zoom.length, 1, 'ein Befehl, nicht zwei');
  assert.equal(zoom[0].params.value, 0);
});
