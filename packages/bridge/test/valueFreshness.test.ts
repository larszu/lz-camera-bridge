/**
 * Bestaetigt ist nicht dauerhaft bestaetigt — Bedarf 102.
 *
 *   > Parameters changed in the camera's own menu or web UI never update the
 *   > control surface; an ND filter change executes but THE DISPLAYED
 *   > VARIABLE STAYS STALE, and SHORTENING THE POLL INTERVAL FROM 3000ms TO
 *   > 200ms CHANGES NOTHING.
 *
 * Der teuerste Fehler waere hier, das Alter gegen eine feste Sekundenzahl zu
 * halten. Ein Weg, der jede Sekunde fragt, und einer, der alle zwei Sekunden
 * fragt, meinen mit derselben halben Minute Verschiedenes — und ein Weg, auf
 * dem die Kamera VON SICH AUS meldet, meint mit Stille „nichts hat sich
 * geaendert" und nicht „ich weiss es nicht mehr".
 *
 * Reine Funktionen; keine Uhr, keine Kamera, kein Netz. Die Zeit kommt als
 * Zahl herein.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AGING_POLLS,
  MODE_CADENCE,
  MODE_READBACK,
  STALE_POLLS,
  applyConfirmations,
  freshness,
  freshnessLimits,
} from '../src/protocol/valueOrigin.js';

const T0 = 1_700_000_000_000;

// ── Der Zeitstempel entsteht nur aus einer echten Rueckmeldung ────────────

test('eine Rueckmeldung auf einem lesenden Weg wird gestempelt', () => {
  const c = applyConfirmations({}, 'blackmagic', ['iris'], 'read', T0);
  assert.equal(c.iris, T0);
});

test('eine Rueckmeldung auf einem Feld, das der Weg NICHT liest, wird nicht gestempelt', () => {
  // `blackmagic` liest laut MODE_READBACK nur iris, masterGain, shutterSpeed.
  const c = applyConfirmations({}, 'blackmagic', ['saturation'], 'read', T0);
  assert.equal(c.saturation, undefined);
});

test('ein Echo stempelt nicht — es ist keine Rueckmeldung', () => {
  const c = applyConfirmations({}, 'blackmagic', ['iris'], 'command', T0);
  assert.equal(c.iris, undefined);
});

test('ein Kommando LOESCHT einen fruehreren Stempel', () => {
  // Sonst zeigte die Anzeige das Alter einer Bestaetigung, die einen ANDEREN
  // Wert betraf — die stillste Art zu luegen.
  const bestaetigt = applyConfirmations({}, 'blackmagic', ['iris'], 'read', T0);
  const danach = applyConfirmations(bestaetigt, 'blackmagic', ['iris'], 'command', T0 + 500);
  assert.equal(danach.iris, undefined);
});

test('andere Felder bleiben unangetastet', () => {
  const a = applyConfirmations({}, 'blackmagic', ['iris', 'masterGain'], 'read', T0);
  const b = applyConfirmations(a, 'blackmagic', ['iris'], 'command', T0 + 100);
  assert.equal(b.masterGain, T0);
});

test('das Ergebnis ist ein neues Objekt', () => {
  const a = applyConfirmations({}, 'blackmagic', ['iris'], 'read', T0);
  const b = applyConfirmations(a, 'blackmagic', ['masterGain'], 'read', T0 + 1);
  assert.notEqual(a, b);
  assert.equal(a.masterGain, undefined);
});

// ── Das Urteil laeuft gegen den TAKT DES WEGES ────────────────────────────

test('innerhalb des Takts ist der Wert frisch', () => {
  const takt = MODE_CADENCE.blackmagic;
  assert.equal(freshness(T0, T0 + 999, takt), 'frisch');
});

test('nach mehr als drei ausgelassenen Takten faellt er auf', () => {
  const takt = MODE_CADENCE.blackmagic; // 1000 ms
  assert.equal(freshness(T0, T0 + 1000 * AGING_POLLS + 1, takt), 'alternd');
});

test('nach mehr als zehn Takten beschreibt er die Vergangenheit', () => {
  const takt = MODE_CADENCE.blackmagic;
  assert.equal(freshness(T0, T0 + 1000 * STALE_POLLS + 1, takt), 'ueberholt');
});

test('derselbe Abstand heisst auf einem langsameren Weg etwas anderes', () => {
  // 6 s: auf dem 1-s-Weg schon auffaellig, auf dem 2-s-Weg noch nicht.
  const sechsSekunden = T0 + 6000;
  assert.equal(freshness(T0, sechsSekunden, MODE_CADENCE.blackmagic), 'alternd');
  assert.equal(freshness(T0, sechsSekunden, MODE_CADENCE['canon-ccapi']), 'frisch');
});

test('auf einem Weg, auf dem die Kamera von sich aus meldet, altert nichts', () => {
  // `tcp`/`serial`: Nachricht 0x50 kommt unaufgefordert. Stille heisst dort
  // „nichts hat sich geaendert" — daraus einen Befund zu machen, meldete
  // jede ruhige Kamera als Problem.
  assert.equal(freshness(T0, T0 + 3_600_000, MODE_CADENCE.tcp), 'frisch');
  assert.equal(freshness(T0, T0 + 3_600_000, MODE_CADENCE.serial), 'frisch');
});

test('ohne Stempel gibt es kein Alter, sondern „unbestaetigt"', () => {
  assert.equal(freshness(undefined, T0, MODE_CADENCE.blackmagic), 'unbestaetigt');
});

test('ein Weg, der nichts zurueckliest, ist immer unbestaetigt', () => {
  assert.equal(freshness(T0, T0, MODE_CADENCE.visca), 'unbestaetigt');
});

// ── Die beiden Tabellen duerfen nicht auseinanderlaufen ───────────────────

test('genau die Wege ohne Rueckmeldung haben den Takt `none`', () => {
  for (const [mode, felder] of Object.entries(MODE_READBACK)) {
    const takt = MODE_CADENCE[mode as keyof typeof MODE_CADENCE];
    assert.equal(
      takt.kind === 'none',
      felder.length === 0,
      `${mode}: MODE_READBACK und MODE_CADENCE widersprechen sich`,
    );
  }
});

test('jeder Poll-Takt ist eine plausible Zahl', () => {
  for (const takt of Object.values(MODE_CADENCE)) {
    if (takt.kind !== 'poll') continue;
    assert.ok(Number.isFinite(takt.everyMs) && takt.everyMs > 0, 'Takt muss positiv sein');
    assert.ok(takt.everyMs <= 10_000, 'ein Takt ueber zehn Sekunden waere kein Poll mehr');
  }
});

// ── Die Bruecke schickt es auch mit ───────────────────────────────────────

const quelle = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('der state-Broadcast traegt die Zeitstempel', () => {
  // Ohne diese Zeile bliebe das Modell im Server liegen und das Pult saehe
  // nie ein Alter — die Sorte Luecke, die kein Unit-Test der reinen
  // Funktionen bemerkt.
  // Zeilenweise zu suchen ging schief, und zwar in beide Richtungen: die
  // Erstauslieferung an einen neuen Client schreibt das Objekt ueber mehrere
  // Zeilen (Treffer ohne `confirmations` in derselben Zeile), und ein
  // KOMMENTAR, der `type: 'state'` erwaehnt, zaehlte mit. Gesucht wird
  // deshalb ohne Kommentare und in einem Fenster hinter der Fundstelle.
  const server = quelle('../src/BridgeServer.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const stellen: number[] = [];
  for (let i = server.indexOf("type: 'state'"); i >= 0; i = server.indexOf("type: 'state'", i + 1)) {
    stellen.push(i);
  }
  assert.ok(stellen.length >= 3, `weniger state-Meldungen als erwartet: ${stellen.length}`);
  for (const i of stellen) {
    const fenster = server.slice(i, i + 260);
    assert.ok(
      fenster.includes('confirmations'),
      `state-Meldung ohne Zeitstempel bei Zeichen ${i}`,
    );
  }
});

test('das Pult rechnet das Urteil nicht selbst nach', () => {
  // Dieselbe Regel wie bei Bedarf 46: eine zweite Tabelle im Pult waere die
  // zweite Wahrheit, die der Bedarf gerade abschafft.
  const pult = quelle('../../web-rcp/src/origin.ts');
  assert.ok(!pult.includes('MODE_CADENCE'), 'das Pult fuehrt eine eigene Takt-Tabelle');
  assert.ok(!pult.includes('STALE_POLLS'), 'das Pult fuehrt eigene Schwellen');
});

test('ein push-Takt traegt gar keine Zahl', () => {
  // Sonst waere die naechste „Verbesserung" ein everyMs am push-Weg, und die
  // Stille einer ruhigen Kamera wuerde wieder zum Befund.
  for (const takt of Object.values(MODE_CADENCE)) {
    if (takt.kind === 'poll') continue;
    assert.ok(!('everyMs' in takt), `${takt.kind} hat einen Takt, den es nicht haben darf`);
  }
});

// ── Das Pult bekommt die Grenzen fertig, nicht die Tabelle ───────────────

test('ein Poll-Weg liefert zwei Grenzen in Millisekunden', () => {
  const g = freshnessLimits(MODE_CADENCE.blackmagic);
  assert.deepEqual(g, { agingAfterMs: 1000 * AGING_POLLS, staleAfterMs: 1000 * STALE_POLLS });
});

test('ein Melde-Weg und ein stummer Weg liefern keine Grenzen', () => {
  assert.equal(freshnessLimits(MODE_CADENCE.tcp), null);
  assert.equal(freshnessLimits(MODE_CADENCE.visca), null);
});

test('die Grenzen liegen in derselben Reihenfolge wie die Urteile', () => {
  for (const takt of Object.values(MODE_CADENCE)) {
    const g = freshnessLimits(takt);
    if (!g) continue;
    assert.ok(g.agingAfterMs < g.staleAfterMs, 'alternd muss vor ueberholt liegen');
  }
});

test('das Pult fuehrt weder Tabelle noch Schwellen', () => {
  // Es vergleicht zwei Zahlen, die es geschickt bekommt. Alles andere waere
  // die zweite Wahrheit, die Bedarf 46 gerade abgeschafft hat.
  const pult = quelle('../../web-rcp/src/origin.ts');
  for (const verboten of ['MODE_CADENCE', 'AGING_POLLS', 'STALE_POLLS', 'everyMs']) {
    assert.ok(!pult.includes(verboten), `das Pult kennt ${verboten}`);
  }
});

test('die Bruecke schickt die Grenzen mit der Kameraliste', () => {
  const server = quelle('../src/BridgeServer.ts');
  assert.ok(server.includes('freshnessLimits('), 'die Kameraliste traegt die Grenzen nicht');
});
