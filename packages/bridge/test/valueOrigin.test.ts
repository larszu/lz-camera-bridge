/**
 * Kommandiert ist nicht bestaetigt — Bedarf 46.
 *
 *   > The controller only knows values it set itself […] SHADERS WORK
 *   > AGAINST A MENTAL MODEL, NOT THE CAMERA.
 *
 * Der teuerste Fehler waere hier, den KANAL zu glauben: mehrere Backends
 * werfen aus `handleRcpCommand` heraus den gerade geschickten Wert als
 * `stateChanged` zurueck. Wer das als Rueckmeldung liest, baut die Luege
 * dieses Bedarfs nach — nur mit mehr Code.
 *
 * Reine Funktionen plus Durchlaeufe durch den Dispatcher; keine Kamera, kein
 * Netz.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EventEmitter } from 'node:events';
import {
  MODE_READBACK,
  applyOrigins,
  feldnamen,
  neverReadsBack,
  readsBack,
  type Origins,
} from '../src/protocol/valueOrigin.js';
import { BridgeServer } from '../src/BridgeServer.js';
// Das Pult liegt in einem anderen Paket und hat keinen eigenen Testlauf. Sein
// `origin.ts` haengt an nichts — es ist Text und zwei reine Funktionen —, und
// die eine Regel darin („ohne Eintrag ist der Wert NICHT unbestaetigt,
// sondern gar nicht da") ist zu teuer, um ungeprueft zu bleiben: sie
// entscheidet, ob eine leere Anzeige markiert wird und die Markierung damit
// bedeutungslos.
import { istUnbestaetigt, unconfirmedProps, UNCONFIRMED_NOTE } from '../../web-rcp/src/origin.ts';

const quelle = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ─── 1. Die Tabelle ist nachgelesen, nicht geraten ─────────────────────────

test('kennt jeden Verbindungsweg', () => {
  // Ein Weg ohne Zeile liefe in `readsBack` auf `undefined?.includes` und
  // gaelte still als „liest nichts" — das waere zufaellig oft richtig und
  // deshalb die schlechteste Sorte Fehler.
  const union = /export type ConnectionMode =([\s\S]*?);/.exec(
    quelle('../src/cameras/backendFactory.ts'),
  );
  assert.ok(union, 'ConnectionMode nicht gefunden');
  const wege = [...union[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.ok(wege.length >= 10, `nur ${wege.length} Wege gelesen`);
  assert.deepEqual(Object.keys(MODE_READBACK).sort(), wege);
});

test('die Sony-CCU ist der Weg, der wirklich zurueckliest', () => {
  // `CcuClient.handleMessage50` wertet den Message-50-Strom aus. Nachgesehen:
  // `applyStateFromCommand` setzt genau diese Felder.
  for (const f of ['iris', 'masterBlack', 'whiteR', 'masterGain', 'ndFilter', 'bars'] as const) {
    assert.ok(readsBack('tcp', f), f);
    assert.ok(readsBack('serial', f), f);
  }
  assert.deepEqual([...MODE_READBACK.tcp], [...MODE_READBACK.serial]);
});

test('die Blackmagic HOLT den Farbsatz und legt ihn nicht ab', () => {
  // Der Fall aus dem Beleg. `BMDeviceClient.getState` fragt
  // /colorCorrection/lift, /gamma, /gain, /offset, /contrast und /color ab —
  // `mapBmState` bildet davon NICHTS auf den Bildzustand ab. Wer die
  // Farbregler am Pult sieht, sieht ausschliesslich Gesendetes.
  assert.deepEqual([...MODE_READBACK.blackmagic], ['iris', 'masterGain', 'shutterSpeed']);
  for (const f of ['whiteR', 'blackR', 'masterGamma', 'saturation', 'masterBlack'] as const) {
    assert.equal(readsBack('blackmagic', f), false, f);
  }
  // Und die Quelle sagt es auch: der Mapper hat drei Zeilen.
  const bm = quelle('../src/cameras/backendFactory.ts');
  const mapper = /function mapBmState[\s\S]*?\n}/.exec(bm)?.[0] ?? '';
  assert.ok(mapper.includes('out.iris'));
  assert.ok(!mapper.includes('lift'), 'mapBmState bildet keine Farbkorrektur ab');
});

test('fuenf Wege lesen GAR NICHTS zurueck', () => {
  // Visca, Z CAM, Panasonic-PTZ, JVC und Sony-USB melden ausschliesslich das
  // gerade Gesendete. Das ist keine Luecke in der Tabelle, sondern ihre
  // Aussage.
  for (const m of ['visca', 'zcam', 'panasonic-ptz', 'jvc', 'sony-usb', 'birddog'] as const) {
    assert.equal(neverReadsBack(m), true, m);
    assert.deepEqual([...MODE_READBACK[m]], []);
  }
  // Gegenprobe: die Wege, die etwas lesen, gelten nicht als blind.
  for (const m of ['tcp', 'serial', 'blackmagic', 'canon-ccapi', 'sony-mnc', 'lumix-http'] as const) {
    assert.equal(neverReadsBack(m), false, m);
  }
});

test('Lumix meldet cameraPower nur halb — und steht deshalb nicht drin', () => {
  // `lumixStateToCamera` setzt `cameraPower` ausschliesslich auf `true` und
  // nie zurueck. Eine Rueckmeldung, die nur in eine Richtung geht, ist keine.
  assert.equal(readsBack('lumix-http', 'cameraPower'), false);
  assert.deepEqual([...MODE_READBACK['lumix-http']], ['iris', 'shutterSpeed', 'masterGain']);
});

// ─── 2. Die Engstelle ──────────────────────────────────────────────────────

test('ein Echo bleibt ein Echo, auch auf einem lesenden Weg', () => {
  const o = applyOrigins(undefined, 'tcp', ['iris'], 'command');
  assert.deepEqual(o, { iris: 'commanded' });
});

test('eine Meldung ist nur dort bestaetigt, wo die Tabelle es hergibt', () => {
  // Derselbe Kanal, dieselbe Meldung, zwei Wege — und zwei Wahrheiten.
  assert.deepEqual(applyOrigins(undefined, 'tcp', ['iris'], 'read'), { iris: 'confirmed' });
  assert.deepEqual(applyOrigins(undefined, 'visca', ['iris'], 'read'), { iris: 'commanded' });
  // Und ein Feld, das dieser Weg nicht liest, obwohl er andere liest.
  assert.deepEqual(applyOrigins(undefined, 'blackmagic', ['whiteR'], 'read'), {
    whiteR: 'commanded',
  });
});

test('ein Kommando entwertet eine fruehere Bestaetigung', () => {
  // Was die Kamera VOR dem Kommando gemeldet hat, gilt danach nicht mehr.
  const vorher: Origins = { iris: 'confirmed', masterGain: 'confirmed' };
  const nachher = applyOrigins(vorher, 'tcp', ['iris'], 'command');
  assert.equal(nachher.iris, 'commanded');
  assert.equal(nachher.masterGain, 'confirmed', 'nur das kommandierte Feld');
});

test('und eine Meldung hebt sie wieder', () => {
  const o = applyOrigins({ iris: 'commanded' }, 'tcp', ['iris'], 'read');
  assert.equal(o.iris, 'confirmed');
});

test('ohne bekannten Weg wird nichts bestaetigt', () => {
  // Ein Slot ohne Konfiguration ist kein Grund, etwas zu behaupten.
  assert.deepEqual(applyOrigins(undefined, undefined, ['iris'], 'read'), { iris: 'commanded' });
});

test('das Ergebnis ist ein neues Objekt', () => {
  const vorher: Origins = { iris: 'confirmed' };
  const nachher = applyOrigins(vorher, 'tcp', ['masterGain'], 'read');
  assert.notEqual(vorher, nachher);
  assert.deepEqual(vorher, { iris: 'confirmed' }, 'unveraendert');
});

test('Felder ohne Wert zaehlen nicht als gemeldet', () => {
  // `mapState` liefert regelmaessig Objekte mit `undefined`-Feldern. Wuerden
  // die mitzaehlen, truege der Zustand eine Herkunft fuer einen Wert, den es
  // nicht gibt — und das Pult markierte eine leere Anzeige.
  assert.deepEqual(feldnamen({ iris: 12, masterGain: undefined }), ['iris']);
  assert.deepEqual(feldnamen({}), []);
});

// ─── 3. Durch den Dispatcher ───────────────────────────────────────────────

const bruecke = new BridgeServer(19751, { http: 19752, ws: 19753 });
const innen = bruecke as unknown as {
  cameras: Map<number, unknown>;
  cameraStates: Map<number, Record<string, unknown>>;
  cameraOrigins: Map<number, Origins>;
  dispatchCommand: (w: unknown, n: number, c: string, p: Record<string, unknown>) => Promise<void>;
  wireSlot: (slot: unknown) => void;
  wss: { clients: Set<unknown> };
  stop: () => void;
};
after(() => {
  innen.wss.clients.clear();
  innen.stop();
});

const fakeWs = () => {
  const gesendet: string[] = [];
  // `readyState: 1` — `sendError` prueft es, und ohne kaeme kein Fehler an.
  return { ws: { readyState: 1, send: (s: string) => gesendet.push(s) } as unknown, gesendet };
};

const frisch = (mode: string) => {
  innen.cameras.clear();
  innen.cameraStates.clear();
  innen.cameraOrigins.clear();
  innen.wss.clients.clear();
  innen.cameras.set(1, {
    connected: true,
    config: { connectionMode: mode },
    backend: { handleRcpCommand: async () => true, disconnect: async () => {} },
  });
};

test('der Dispatcher markiert seinen eigenen Echo als kommandiert', async () => {
  frisch('tcp');
  const { ws } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'setIris', { value: 100 });
  assert.equal(innen.cameraStates.get(1)?.iris, 100);
  assert.equal(innen.cameraOrigins.get(1)?.iris, 'commanded');
});

test('auch ein Trimm endet als kommandierter Wert', async () => {
  // Der Trimm loest sich in ein absolutes Kommando auf (Bedarf 129) — und
  // das ist ein Kommando, kein Ablesen.
  frisch('tcp');
  innen.cameraStates.set(1, { masterBlack: 120 });
  innen.cameraOrigins.set(1, { masterBlack: 'confirmed' });
  const { ws } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'nudge', { parameter: 'masterBlack', by: 2 });
  assert.equal(innen.cameraStates.get(1)?.masterBlack, 122);
  assert.equal(innen.cameraOrigins.get(1)?.masterBlack, 'commanded');
});

test('ein abgelehntes Kommando hinterlaesst keine Herkunft', async () => {
  frisch('tcp');
  innen.cameras.set(1, {
    connected: true,
    config: { connectionMode: 'tcp' },
    backend: { handleRcpCommand: async () => false, disconnect: async () => {} },
  });
  const { ws, gesendet } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'setIris', { value: 100 });
  assert.equal(gesendet.length, 1, 'ein Fehler');
  assert.equal(innen.cameraOrigins.get(1), undefined);
  assert.equal(innen.cameraStates.get(1), undefined);
});

test('der Broadcast traegt die Herkunft mit', async () => {
  frisch('tcp');
  const gesehen: string[] = [];
  innen.wss.clients.add({ readyState: 1, send: (s: string) => gesehen.push(s) });
  const { ws } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'setIris', { value: 42 });
  const zustand = gesehen.map((g) => JSON.parse(g)).filter((m) => m.type === 'state');
  assert.equal(zustand.length, 1);
  assert.deepEqual(zustand[0].origins, { iris: 'commanded' });
});

test('eine MELDUNG des Backends geht durch dieselbe Engstelle', async () => {
  // Der zweite Schreibweg. Ohne diesen Durchlauf blieb er ungeprueft — und
  // eine Gegenprobe, die ihm die Herkunft ganz nahm, blieb gruen.
  frisch('tcp');
  // `disconnect` gehoert dazu: `stop()` im Aufraeumen ruft es an JEDEM Slot,
  // und ein Backend ohne die Methode laesst den Server offen — der Runner
  // haengt dann bis zum CI-Timeout statt den Fehlschlag zu melden.
  const backend = Object.assign(new EventEmitter(), {
    disconnect: async () => {},
  }) as unknown as { emit: (e: string, v: unknown) => boolean };
  const slot = {
    num: 1,
    config: { connectionMode: 'tcp' },
    backend,
    mapState: (x: unknown) => x as Record<string, unknown>,
    connected: true,
  };
  innen.cameras.set(1, slot);
  innen.wireSlot(slot);
  backend.emit('stateChanged', { iris: 77 });
  assert.equal(innen.cameraStates.get(1)?.iris, 77);
  assert.equal(innen.cameraOrigins.get(1)?.iris, 'confirmed');
});

test('dieselbe Meldung auf einem blinden Weg bleibt kommandiert', async () => {
  // Genau der Fall, den die Backends bauen: `ViscaClient.setIris` wirft den
  // gerade geschickten Wert als `stateChanged` zurueck. Der Weg entscheidet,
  // nicht der Kanal — und der Weg kommt aus dem Slot, nicht aus einer
  // festen Annahme.
  frisch('visca');
  // `disconnect` gehoert dazu: `stop()` im Aufraeumen ruft es an JEDEM Slot,
  // und ein Backend ohne die Methode laesst den Server offen — der Runner
  // haengt dann bis zum CI-Timeout statt den Fehlschlag zu melden.
  const backend = Object.assign(new EventEmitter(), {
    disconnect: async () => {},
  }) as unknown as { emit: (e: string, v: unknown) => boolean };
  const slot = {
    num: 1,
    config: { connectionMode: 'visca' },
    backend,
    mapState: (x: unknown) => x as Record<string, unknown>,
    connected: true,
  };
  innen.cameras.set(1, slot);
  innen.wireSlot(slot);
  backend.emit('stateChanged', { iris: 77 });
  assert.equal(innen.cameraStates.get(1)?.iris, 77, 'der Wert steht trotzdem da');
  assert.equal(innen.cameraOrigins.get(1)?.iris, 'commanded');
});

test('auch die Meldung traegt die Herkunft in den Broadcast', () => {
  frisch('tcp');
  const gesehen: string[] = [];
  innen.wss.clients.add({ readyState: 1, send: (s: string) => gesehen.push(s) });
  // `disconnect` gehoert dazu: `stop()` im Aufraeumen ruft es an JEDEM Slot,
  // und ein Backend ohne die Methode laesst den Server offen — der Runner
  // haengt dann bis zum CI-Timeout statt den Fehlschlag zu melden.
  const backend = Object.assign(new EventEmitter(), {
    disconnect: async () => {},
  }) as unknown as { emit: (e: string, v: unknown) => boolean };
  const slot = {
    num: 1,
    config: { connectionMode: 'tcp' },
    backend,
    mapState: (x: unknown) => x as Record<string, unknown>,
    connected: true,
  };
  innen.cameras.set(1, slot);
  innen.wireSlot(slot);
  backend.emit('stateChanged', { masterGain: 3 });
  const zustand = gesehen.map((g) => JSON.parse(g)).filter((m) => m.type === 'state');
  assert.equal(zustand.length, 1);
  assert.deepEqual(zustand[0].origins, { masterGain: 'confirmed' });
});

// ─── 4. Das Pult liest die Herkunft richtig ────────────────────────────────

test('ohne Eintrag ist ein Wert NICHT unbestaetigt, sondern gar nicht da', () => {
  // Der Unterschied entscheidet, ob die leere Anzeige („--") markiert wird.
  // Waere sie es, markierte das Pult ueberall dort, wo es nichts zu sagen
  // hat — und die Markierung waere nach dem dritten Regler bedeutungslos.
  assert.equal(istUnbestaetigt({ iris: 'commanded' }, 'iris'), true);
  assert.equal(istUnbestaetigt({ iris: 'confirmed' }, 'iris'), false);
  assert.equal(istUnbestaetigt({}, 'iris'), false);
  assert.equal(istUnbestaetigt(undefined, 'iris'), false);
});

test('Klasse und Satz kommen zusammen oder gar nicht', () => {
  const markiert = unconfirmedProps({ iris: 'commanded' }, 'iris');
  assert.match(markiert.className, /rcp-unconfirmed/);
  assert.equal(markiert.title, UNCONFIRMED_NOTE);
  const still = unconfirmedProps({ iris: 'confirmed' }, 'iris');
  assert.equal(still.className, '');
  assert.equal(still.title, undefined);
});

// ─── 5. Verdrahtung ────────────────────────────────────────────────────────

test('die Bruecke schickt die Auskunft, das Pult fuehrt keine zweite Tabelle', () => {
  // Eine Kopie von MODE_READBACK im Web-RCP waere die zweite Wahrheit, die
  // dieses Modul gerade abschafft.
  const server = quelle('../src/BridgeServer.ts');
  assert.match(server, /neverReadsBack: neverReadsBack\(/);
  const pult = quelle('../../web-rcp/src/origin.ts');
  assert.ok(!pult.includes('MODE_READBACK'), 'keine zweite Tabelle im Pult');
  const panel = quelle('../../web-rcp/src/components/SonyRcpPanel.tsx');
  assert.match(panel, /neverReadsBack && <div className="rcp-noreadback">/);
  assert.match(panel, /istUnbestaetigt\(origins, feld\)/);
});

test('bleibt rein — keine Uhr, kein Netz', () => {
  const src = quelle('../src/protocol/valueOrigin.ts');
  assert.ok(!/\bDate\.now\b|new Date\(|fetch\(|require\(/.test(src));
});
