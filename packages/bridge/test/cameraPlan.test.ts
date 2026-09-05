/**
 * Der Kamera-Plan aus dem MultiCam-Planner gegen die Kameras am Bus (B-41.1).
 *
 * Geprueft wird die Regel, an der sich der Nutzen entscheidet: eine Zuordnung
 * gibt es nur mit Beleg, und ein mehrdeutiger Beleg ist keiner. Die falsche
 * Kamera zu schwenken, weil das Pult sie falsch beschriftet hat, ist der
 * Schaden — nicht ein Slot, der unbeschriftet bleibt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchCameraPlan, parseCameraPlan, type CameraPlan, type SlotFacts } from '../src/plan/cameraPlan.js';

const plan = (cameras: CameraPlan['cameras']): CameraPlan => ({
  kind: 'camera-list',
  formatVersion: 1,
  app: 'multicam-planner',
  appVersion: '4.3.2',
  exportedAt: '2026-09-05T12:00:00.000Z',
  cameras,
});

const slot = (num: number, knownModel?: string, planCameraId?: string): SlotFacts => ({
  num,
  ...(knownModel ? { knownModel } : {}),
  ...(planCameraId ? { planCameraId } : {}),
});

test('parseCameraPlan nimmt nur an, was ein Kamera-Plan ist', () => {
  assert.equal(parseCameraPlan('kein json'), null);
  assert.equal(parseCameraPlan('{"kind":"etwas-anderes","formatVersion":1,"cameras":[]}'), null);
  // Eine kuenftige Version ist keine, die dieser Leser versteht. Sie
  // durchzuwinken hiesse, Felder still zu ignorieren, die etwas bedeuten.
  assert.equal(parseCameraPlan('{"kind":"camera-list","formatVersion":2,"cameras":[]}'), null);
  const p = parseCameraPlan(JSON.stringify(plan([{ id: 'c1', label: 'CAM 1', model: 'FX9' }])));
  assert.equal(p?.cameras.length, 1);
  assert.equal(p?.cameras[0].model, 'FX9');
});

test('parseCameraPlan wirft Eintraege ohne Id oder Beschriftung weg', () => {
  const roh = {
    kind: 'camera-list', formatVersion: 1, app: 'x', appVersion: '1', exportedAt: '',
    cameras: [{ id: 'c1', label: 'CAM 1' }, { label: 'ohne id' }, { id: 'c3' }],
  };
  assert.equal(parseCameraPlan(JSON.stringify(roh))?.cameras.length, 1);
});

test('ein gemessenes Modell ordnet zu — quer durch drei Schreibweisen', () => {
  // Der USB-Produktstring sagt "ILME-FX3", der Katalog des Planers "FX3".
  const r = matchCameraPlan(
    plan([{ id: 'c1', label: 'Buehne links', model: 'FX3' }]),
    [slot(7, 'ILME-FX3')],
  );
  assert.equal(r.matches[0].cameraNumber, 7);
  assert.equal(r.matches[0].matchedBy, 'model');
  assert.deepEqual(r.unmatchedSlots, []);
});

test('zwei gleiche Modelle am Bus ergeben KEINEN Vorschlag', () => {
  // Zwei FX9 im Rack. Zwei plausible Zuordnungen sind keine halbe Zuordnung,
  // sondern eine Verwechslungsgefahr.
  const r = matchCameraPlan(
    plan([{ id: 'c1', label: 'Buehne links', model: 'FX9' }]),
    [slot(1, 'ILME-FX9'), slot(2, 'ILME-FX9')],
  );
  assert.equal(r.matches[0].cameraNumber, undefined);
  assert.match(r.matches[0].reason ?? '', /eindeutig oder gar nicht/i);
  assert.deepEqual(r.unmatchedSlots, [1, 2]);
});

test('zwei geplante Kameras desselben Modells ergeben ebenfalls keinen', () => {
  // Die Gegenrichtung derselben Regel: ein Geraet am Bus, zwei geplante
  // Kameras, die darauf passen wuerden.
  const r = matchCameraPlan(
    plan([
      { id: 'c1', label: 'Links', model: 'FX9' },
      { id: 'c2', label: 'Rechts', model: 'FX9' },
    ]),
    [slot(4, 'ILME-FX9')],
  );
  assert.equal(r.matches.find((m) => m.planCameraId === 'c1')?.cameraNumber, undefined);
  assert.equal(r.matches.find((m) => m.planCameraId === 'c2')?.cameraNumber, undefined);
});

test('die Zahl in der Beschriftung ist ein Vorschlag, und sagt das', () => {
  const r = matchCameraPlan(plan([{ id: 'c1', label: 'CAM 3' }]), [slot(3)]);
  assert.equal(r.matches[0].cameraNumber, 3);
  assert.equal(r.matches[0].matchedBy, 'number');
});

test('das gemessene Modell schlaegt die Zahl in der Beschriftung', () => {
  // "CAM 1" steht im Plan, das Geraet haengt aber auf Slot 5. Die Messung
  // gewinnt: die Nummer ist eine Konvention, das Modell ein Befund.
  const r = matchCameraPlan(
    plan([{ id: 'c1', label: 'CAM 1', model: 'FX6' }]),
    [slot(1), slot(5, 'ILME-FX6')],
  );
  assert.equal(r.matches[0].cameraNumber, 5);
  assert.equal(r.matches[0].matchedBy, 'model');
  assert.deepEqual(r.unmatchedSlots, [1]);
});

test('eine von Hand gesetzte Zuordnung ueberlebt den Abgleich', () => {
  // Sonst waere jeder erneute Abgleich ein Rueckschritt: der Mensch hat
  // hingesehen, das Modell nicht.
  const r = matchCameraPlan(
    plan([{ id: 'c1', label: 'CAM 1', model: 'FX6' }]),
    [slot(2, undefined, 'c1'), slot(5, 'ILME-FX6')],
  );
  assert.equal(r.matches[0].cameraNumber, 2);
  assert.equal(r.matches[0].matchedBy, 'manual');
  assert.deepEqual(r.unmatchedSlots, [5]);
});

test('ein Slot wird hoechstens einmal vergeben', () => {
  const r = matchCameraPlan(
    plan([{ id: 'c1', label: 'CAM 2' }, { id: 'c2', label: 'CAM 2 Ersatz' }]),
    [slot(2)],
  );
  const belegt = r.matches.filter((m) => m.cameraNumber === 2);
  assert.equal(belegt.length, 1);
});

test('ohne jeden Beleg steht der Grund da, nicht ein Schweigen', () => {
  const r = matchCameraPlan(plan([{ id: 'c1', label: 'Handkamera' }]), [slot(1), slot(2)]);
  assert.equal(r.matches[0].cameraNumber, undefined);
  assert.match(r.matches[0].reason ?? '', /kein Modell/i);
  // Und die Slots, die nichts abbekommen haben, stehen ebenfalls da.
  assert.deepEqual(r.unmatchedSlots, [1, 2]);
});

test('der Grund unterscheidet „kein Geraet meldet das" von „mehrere passen"', () => {
  const keins = matchCameraPlan(plan([{ id: 'c1', label: 'Links', model: 'FX9' }]), [slot(1, 'BMPCC 6K')]);
  assert.match(keins.matches[0].reason ?? '', /Kein Gerät am Bus meldet/i);
});
