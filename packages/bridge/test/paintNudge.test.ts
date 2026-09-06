/**
 * Relative Kommandos — Bedarf 129.
 *
 * Der Beleg (`bitfocus/companion-module-bmd-atem#350`) nennt zwei Dinge in
 * einem Atemzug: es fehlen Inkrement-Aktionen, UND die Wertskala kann falsch
 * sein. Beides wird hier festgehalten — die Aufloesung selbst, und die eine
 * Tabelle, aus der alle Wege ihre Bereiche und Schrittweiten nehmen.
 *
 * Reine Funktionen plus zwei Durchlaeufe durch den Dispatcher; keine Kamera,
 * kein Netz.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  NUDGE_ACTIONS,
  NUDGE_REFUSAL_LABEL,
  PAINT_PARAMETERS,
  isPaintParameter,
  resolveNudge,
  type PaintParameter,
} from '../src/protocol/paintNudge.js';
import { BridgeServer } from '../src/BridgeServer.js';

const quelle = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Quelltext OHNE Kommentare.
 *
 * Wer eine abgeschaffte Bauform verbietet, muss sie in der Begruendung
 * zitieren duerfen — sonst steht im Code kein Wort mehr darueber, warum sie
 * weg ist. Eine Pruefung, die den ganzen Text durchsucht, verbietet
 * ausgerechnet die Erklaerung mit. Also erst die Kommentare weg, dann pruefen.
 */
const ohneKommentare = (rel: string): string =>
  quelle(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

// ─── Die Engstelle ─────────────────────────────────────────────────────────

test('trimmt vom GELESENEN Wert aus', () => {
  const r = resolveNudge('masterBlack', 1, { masterBlack: 130 });
  assert.deepEqual(r, { command: 'setMasterBlack', value: 131, from: 130, clamped: false });
});

test('ohne gelesenen Wert kommt eine Absage, KEIN geratener Ausgangswert', () => {
  // Das ist der Kern des Moduls. Vorher rechnete der Dispatcher
  // `(perCam.iris ?? 128) + 5` und schickte 133 an eine Kamera, deren Blende
  // niemand abgelesen hatte.
  assert.deepEqual(resolveNudge('iris', 5, {}), { refusal: 'no-current-value' });
  assert.deepEqual(resolveNudge('iris', 5, undefined), { refusal: 'no-current-value' });
  // Auch ein Zustand, der ANDERE Werte kennt, macht diesen nicht bekannt.
  assert.deepEqual(resolveNudge('iris', 5, { masterBlack: 128 }), {
    refusal: 'no-current-value',
  });
});

test('128 ist kein Ersatz fuer einen unbekannten Wert', () => {
  // Gegenprobe zur Absage oben: die Mitte der Skala waere die verfuehrendste
  // aller Erfindungen, weil sie plausibel aussieht.
  const r = resolveNudge('masterBlack', 1, {});
  assert.ok('refusal' in r);
  assert.ok(!('value' in r), 'keine 129 aus dem Nichts');
});

test('ein unbekannter Parameter wird abgelehnt statt durchgereicht', () => {
  assert.deepEqual(resolveNudge('detailLevel', 1, { detailLevel: 5 } as never), {
    refusal: 'unknown-parameter',
  });
  assert.deepEqual(resolveNudge('', 1, {}), { refusal: 'unknown-parameter' });
});

test('ein Trimm ohne Richtung ist keiner', () => {
  assert.deepEqual(resolveNudge('iris', 0, { iris: 100 }), { refusal: 'zero-step' });
  assert.deepEqual(resolveNudge('iris', Number.NaN, { iris: 100 }), { refusal: 'zero-step' });
  assert.deepEqual(resolveNudge('iris', Number.POSITIVE_INFINITY, { iris: 100 }), {
    refusal: 'zero-step',
  });
});

test('am Anschlag kommt eine Absage statt eines Kommandos ohne Wirkung', () => {
  // Ein erneut gesendeter gleicher Wert saehe fuer den Bedienenden aus wie
  // eine Taste, die nicht funktioniert.
  assert.deepEqual(resolveNudge('masterGain', 1, { masterGain: 6 }), { refusal: 'at-limit' });
  assert.deepEqual(resolveNudge('ndFilter', -1, { ndFilter: 0 }), { refusal: 'at-limit' });
  assert.deepEqual(resolveNudge('iris', -5, { iris: 0 }), { refusal: 'at-limit' });
});

test('kurz vor dem Anschlag wird der Schritt verkuerzt und das gesagt', () => {
  const r = resolveNudge('iris', 5, { iris: 253 });
  assert.deepEqual(r, { command: 'setIris', value: 255, from: 253, clamped: true });
});

test('ein gemeldeter Wert ausserhalb des Bereichs wird fuer die Rechnung geholt, aber nicht verschwiegen', () => {
  // Eine Kamera meldet, was sie will. Gerechnet wird im Bus-Bereich, `from`
  // bleibt die Meldung — sonst behauptete die Bruecke, die Kamera haette
  // etwas anderes gesagt.
  const r = resolveNudge('masterGain', -1, { masterGain: 9 });
  assert.deepEqual(r, { command: 'setMasterGain', value: 5, from: 9, clamped: false });
});

test('gebrochene Angaben werden gerundet, nicht abgeschnitten', () => {
  assert.deepEqual(resolveNudge('masterBlack', 1.6, { masterBlack: 100 }), {
    command: 'setMasterBlack',
    value: 102,
    from: 100,
    clamped: false,
  });
});

// ─── Die Tabelle ist die einzige Wahrheit ueber Bereiche ───────────────────

test('jede Absage hat einen Text', () => {
  for (const grund of ['unknown-parameter', 'no-current-value', 'zero-step', 'at-limit'] as const) {
    assert.ok(NUDGE_REFUSAL_LABEL[grund].length > 10, grund);
  }
});

test('jeder Parameter hat einen Bereich, einen Schritt und einen Beleg dafuer', () => {
  for (const [name, spec] of Object.entries(PAINT_PARAMETERS)) {
    assert.ok(spec.min < spec.max, `${name}: leerer Bereich`);
    assert.ok(spec.step > 0, `${name}: Schritt 0`);
    assert.ok(spec.step <= spec.max - spec.min, `${name}: Schritt groesser als der Bereich`);
    assert.ok(Number.isInteger(spec.step), `${name}: gebrochener Schritt`);
    // Die Skala ist keine Zierde: sie sagt, WOMIT der Bereich belegt ist.
    // Ohne Beleg waere die naechste Zahl wieder geraten, und genau daraus
    // entsteht die falsche Skala aus dem Bedarf.
    assert.ok(spec.scale.length > 20, `${name}: Skala nicht belegt`);
    assert.ok(spec.command.startsWith('set'), `${name}: kein absolutes Kommando`);
  }
});

test('die Bereiche stimmen mit den Reglern des Web-RCP ueberein', () => {
  // Der zweite Teil des Bedarfs: EINE Skala, nicht zwei. Vorher klemmte
  // Companion `masterGain` auf 0..7 und `ndFilter` auf 0..4, das Web-RCP auf
  // 0..6 und 0..3 — beide Male war Companion um eins zu weit, und die
  // Gain-Tabellen der Backends fielen bei Index 7 auf 0 dB zurueck.
  const rcp = quelle('../../web-rcp/src/components/SonyRcpPanel.tsx');
  const stufen = (name: string): number => {
    const treffer = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(rcp);
    assert.ok(treffer, `${name} nicht gefunden`);
    return treffer[1].split(',').length;
  };
  assert.equal(PAINT_PARAMETERS.masterGain.max, stufen('GAIN_VALUES') - 1);
  assert.equal(PAINT_PARAMETERS.ndFilter.max, stufen('ND_VALUES') - 1);
});

test('das Web-RCP klemmt Gain und ND nicht mehr selbst', () => {
  // Eine dritte Kopie des Bereichs waere genau die Bauform, die dieser
  // Bedarf abschafft. Das Pult schickt jetzt den relativen Zug und laesst
  // die Bruecke rechnen.
  const rcp = ohneKommentare('../../web-rcp/src/components/SonyRcpPanel.tsx');
  assert.doesNotMatch(rcp, /cmd\('setMasterGain'/);
  assert.doesNotMatch(rcp, /cmd\('setNdFilter'/);
  assert.match(rcp, /cmd\('nudge', \{ parameter: 'masterGain'/);
  assert.match(rcp, /cmd\('nudge', \{ parameter: 'ndFilter'/);
  // Und es erfindet keinen Ausgangswert mehr.
  assert.doesNotMatch(rcp, /state\.masterGain \?\? 0/);
  assert.doesNotMatch(rcp, /state\.ndFilter \?\? 0/);
});

// ─── Die Tasten ────────────────────────────────────────────────────────────

test('jede Taste zeigt auf einen bekannten Parameter und nimmt ihren Schritt aus der Tabelle', () => {
  for (const [id, aktion] of Object.entries(NUDGE_ACTIONS)) {
    assert.ok(isPaintParameter(aktion.parameter), `${id}: unbekannter Parameter`);
    const spec = PAINT_PARAMETERS[aktion.parameter];
    assert.equal(
      Math.abs(aktion.by),
      spec.step,
      `${id}: eigene Schrittweite statt der aus PAINT_PARAMETERS`,
    );
    assert.ok(aktion.label.length > 2, `${id}: kein Text`);
    assert.ok(aktion.category.length > 2, `${id}: keine Gruppe`);
  }
});

test('jeder Parameter hat beide Richtungen', () => {
  const richtungen = new Map<PaintParameter, Set<string>>();
  for (const aktion of Object.values(NUDGE_ACTIONS)) {
    const s = richtungen.get(aktion.parameter) ?? new Set<string>();
    s.add(aktion.by > 0 ? 'auf' : 'ab');
    richtungen.set(aktion.parameter, s);
  }
  for (const name of Object.keys(PAINT_PARAMETERS) as PaintParameter[]) {
    assert.deepEqual(
      [...(richtungen.get(name) ?? [])].sort(),
      ['ab', 'auf'],
      `${name}: nur eine Richtung hat eine Taste`,
    );
  }
});

test('die alten Companion-Ids bleiben erhalten', () => {
  // Es liegen Companion-Seiten da draussen, auf denen sie auf Tasten liegen.
  for (const id of ['irisUp', 'irisDown', 'gainUp', 'gainDown', 'ndUp', 'ndDown']) {
    assert.ok(NUDGE_ACTIONS[id], `${id} verschwunden`);
  }
  assert.equal(NUDGE_ACTIONS.irisUp.parameter, 'iris');
  assert.equal(NUDGE_ACTIONS.gainUp.parameter, 'masterGain');
  assert.equal(NUDGE_ACTIONS.ndUp.parameter, 'ndFilter');
});

test('der Wert aus dem Beleg hat eine Taste', () => {
  // „Lift Luma (Black Level)" — der am haeufigsten getrimmte Wert, und bis
  // zu diesem Bedarf der einzige ohne jede relative Bedienung.
  assert.equal(NUDGE_ACTIONS.blackUp.parameter, 'masterBlack');
  assert.equal(NUDGE_ACTIONS.blackDown.by, -PAINT_PARAMETERS.masterBlack.step);
});

test('Companion baut seine relativen Presets aus derselben Tabelle', () => {
  const companion = ohneKommentare('../src/companion/CompanionServer.ts');
  assert.match(companion, /Object\.entries\(NUDGE_ACTIONS\)/);
  // Und nicht daneben noch einmal von Hand.
  assert.doesNotMatch(companion, /id: 'irisUp'/);
  assert.doesNotMatch(companion, /id: 'gainUp'/);
});

// ─── Die Skala nach unten ──────────────────────────────────────────────────

test('Blackmagic bekommt den Gain-Index in dB umgerechnet', () => {
  // Der zweite Halbsatz des Belegs: „the value scale can be wrong". Sechs von
  // sieben Backends lesen `masterGain` als Index; nur BMDeviceClient reichte
  // ihn frueher als dB durch, sodass Index 6 („+18dB" am Pult) als 6 dB
  // ankam.
  const bm = ohneKommentare('../src/cameras/BMDeviceClient.ts');
  assert.match(bm, /BUS_GAIN_STEP_DB = 3/);
  assert.match(bm, /setGain\(num\('value'\) \* BUS_GAIN_STEP_DB\)/);
  assert.doesNotMatch(bm, /Treat the gain index as a dB value/);
});

test('die Gain-Stufen des Busses decken sich mit der ISO-Tabelle der Sony-Backends', () => {
  // `GAIN_INDEX_TO_ISO` hat sieben Eintraege (0..6) — dieselbe Obergrenze,
  // die `PAINT_PARAMETERS.masterGain` nennt. Waeren es acht, muesste die
  // Tabelle hier mitwachsen statt stillschweigend auf 800 ISO zurueckzufallen.
  const ptp = quelle('../src/protocol/SonyPtp.ts');
  const block = /GAIN_INDEX_TO_ISO: Record<number, number> = \{([\s\S]*?)\}/.exec(ptp);
  assert.ok(block);
  const eintraege = block[1].split(',').filter((z) => z.includes(':')).length;
  assert.equal(eintraege - 1, PAINT_PARAMETERS.masterGain.max);
});

// ─── Durch den Dispatcher ──────────────────────────────────────────────────

/** Ein WebSocket, der nur mitschreibt. `readyState` 1 = OPEN. */
const fakeWs = () => {
  const gesendet: string[] = [];
  return {
    ws: { readyState: 1, send: (s: string) => gesendet.push(s) } as never,
    gesendet,
  };
};

/**
 * EINE Bruecke fuer alle Durchlaeufe, aufgeraeumt in `after`.
 *
 * Zwei Gruende, und beide kamen aus einer Gegenprobe (2026-09-06):
 *
 *  - `new BridgeServer(...)` bindet ueber `CompanionServer` schon im
 *    Konstruktor dessen WebSocket-Port. Der stand fest auf 9701, und der
 *    Test-Runner faehrt die Testdateien NEBENLAEUFIG: zwei Dateien, die je
 *    eine Bruecke bauen, gaben `EADDRINUSE` — mal die eine, mal die andere,
 *    je nach Reihenfolge. Deshalb nimmt der Konstruktor die Companion-Ports
 *    jetzt entgegen, und hier stehen eigene.
 *  - Ein `stop()` in der letzten Zeile des Testkoerpers wird bei einer
 *    fehlgeschlagenen Zusicherung NIE erreicht. Der lauschende Server haelt
 *    danach die Event-Loop offen: der Runner meldet den Fehlschlag nicht,
 *    sondern haengt bis zum CI-Timeout. Gemessen: zwanzig Minuten ohne eine
 *    Zeile Ausgabe.
 */
const bruecke = new BridgeServer(19741, { http: 19742, ws: 19743 });
const innen = bruecke as unknown as {
  cameras: Map<number, unknown>;
  cameraStates: Map<number, Record<string, unknown>>;
  dispatchCommand: (w: unknown, n: number, c: string, p: Record<string, unknown>) => Promise<void>;
  handleCompanionCommand: (a: string, p: Record<string, unknown>) => Promise<void>;
  wss: { clients: Set<unknown> };
  stop: () => void;
};
after(() => {
  // Erst die Zuhoerer weg, dann zu. `wss.close()` schliesst jeden Client mit
  // — ein Attrappen-Client ohne `close()` laesst den Server offen, und der
  // Prozess haengt danach mit belegtem Port 9701 weiter.
  innen.wss.clients.clear();
  innen.stop();
});

/** Was das Backend zu sehen bekam. */
let gesehen: Array<{ cmd: string; params: Record<string, unknown> }> = [];

/** Frischer Anfang: eine verbundene Kamera 1, die jedes Kommando annimmt. */
const frisch = (zustand?: Record<string, unknown>) => {
  gesehen = [];
  innen.cameras.clear();
  innen.cameraStates.clear();
  innen.wss.clients.clear();
  innen.cameras.set(1, {
    connected: true,
    backend: {
      handleRcpCommand: async (cmd: string, params: Record<string, unknown>) => {
        gesehen.push({ cmd, params });
        return true;
      },
      disconnect: async () => {},
    },
  });
  if (zustand) innen.cameraStates.set(1, zustand);
};

test('der Bus loest nudge in ein absolutes Kommando auf', async () => {
  frisch({ masterBlack: 120 });
  const { ws, gesendet } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'nudge', { parameter: 'masterBlack', by: 2 });

  assert.equal(gesendet.length, 0, 'kein Fehler');
  assert.equal(gesehen.length, 1);
  assert.equal(gesehen[0].cmd, 'setMasterBlack');
  assert.equal(gesehen[0].params.value, 122);
  // Und der Zustand ist mitgezogen — sonst traefe der naechste Trimm auf
  // einen veralteten Ausgangswert.
  assert.equal(innen.cameraStates.get(1)?.masterBlack, 122);
});

test('kein Backend sieht jemals das Wort nudge', async () => {
  frisch({ iris: 100 });
  const { ws } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'nudge', { parameter: 'iris', by: 5 });
  assert.deepEqual(
    gesehen.map((g) => g.cmd),
    ['setIris'],
  );
});

test('eine Absage geht als Fehler raus und kein Kommando nach unten', async () => {
  frisch();
  const { ws, gesendet } = fakeWs();
  await innen.dispatchCommand(ws, 1, 'nudge', { parameter: 'masterBlack', by: 1 });

  assert.equal(gesehen.length, 0, 'nichts an die Kamera');
  assert.equal(gesendet.length, 1);
  assert.match(gesendet[0], /unbekannt/);
  // Und vor allem: kein erfundener Zustand.
  assert.equal(innen.cameraStates.has(1), false);
});

test('eine nicht verbundene Kamera meldet das, bevor irgendwas gerechnet wird', async () => {
  frisch({ iris: 100 });
  const { ws, gesendet } = fakeWs();
  await innen.dispatchCommand(ws, 7, 'nudge', { parameter: 'iris', by: 5 });
  assert.match(gesendet[0], /nicht verbunden/);
});

test('die Companion-Taste rechnet nicht mehr selbst', () => {
  // Die drei Sonderfaelle im Dispatcher sind weg — samt geratenem
  // Ausgangswert und den beiden falschen Obergrenzen.
  const bridge = ohneKommentare('../src/BridgeServer.ts');
  assert.doesNotMatch(bridge, /perCam\.iris \?\? 128/);
  assert.doesNotMatch(bridge, /action === 'irisUp'/);
  assert.doesNotMatch(bridge, /Math\.min\(7, cur\)/);
  assert.doesNotMatch(bridge, /Math\.min\(4, cur\)/);
  assert.match(bridge, /NUDGE_ACTIONS\[action\]/);
});

test('die Companion-Absage bleibt nicht stumm', async () => {
  // Companion hat keinen Rueckkanal; die Absage muss trotzdem irgendwo
  // ankommen, sonst ist eine Taste ohne Wirkung von einer kaputten Bruecke
  // nicht zu unterscheiden.
  frisch();
  const gesendet: string[] = [];
  innen.wss.clients.add({ readyState: 1, send: (text: string) => gesendet.push(text) });

  await innen.handleCompanionCommand('blackUp', { cameraNumber: 1 });
  assert.equal(gesendet.length, 1);
  assert.match(gesendet[0], /Master Black \+/);
  assert.match(gesendet[0], /unbekannt/);
});
