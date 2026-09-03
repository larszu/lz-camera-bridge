/**
 * ADR-003 — Tally-Zustand: „unbestaetigt" darf nie zu „aus" werden.
 *
 * Reine Funktionen und ein gestubbtes `fetch` — keine Bridge, kein Netz,
 * keine Kamera. Gleiche Machart wie packages/bridge/test/protocol.test.ts.
 *
 * WORUM ES GEHT. `fetchTally` hatte `json.tally ?? { program: false,
 * preview: false, isoRec: false }`. Eine 200-Antwort ohne `tally`-Feld wurde
 * damit zu „alle Lampen aus" — und eine dunkle Tally-Lampe liest ein
 * Operator als „die Kamera ist nicht auf Sendung". Das ist eine erfundene
 * Bestaetigung in der gefaehrlichen Richtung.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeClient, formatTally, UNKNOWN_TALLY, type BridgeTallyState } from '../src/bridge.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/** Ein `fetch`, das auf jeden Pfad dieselbe JSON-Antwort gibt. */
function stubFetch(bodyFor: (url: string) => unknown, ok = true): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => bodyFor(url),
    };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function clientWithCollector() {
  const client = new BridgeClient({ ...DEFAULT_CONFIG });
  const tallies: BridgeTallyState[] = [];
  const errors: string[] = [];
  client.onTally = (tally) => tallies.push(tally);
  client.onError = (message) => errors.push(message);
  return { client, tallies, errors };
}

test('eine 200-Antwort ohne tally-Feld behauptet nichts', async () => {
  const restore = stubFetch((url) =>
    url.includes('/api/tally') ? { ok: true } : { connected: true, state: {} },
  );
  try {
    const { client, tallies, errors } = clientWithCollector();
    await client.refreshAll();

    assert.equal(tallies.length, 1);
    // Der eigentliche Punkt: KEIN `false`. Alle drei Felder sind unbekannt.
    assert.equal(tallies[0].program, undefined);
    assert.equal(tallies[0].preview, undefined);
    assert.equal(tallies[0].isoRec, undefined);
    // Und es bleibt nicht still — Regel 3 aus ADR-005: melden, wo es passiert.
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ohne tally-Feld/);
  } finally {
    restore();
  }
});

test('eine vollstaendige Antwort kommt unveraendert durch', async () => {
  const restore = stubFetch((url) =>
    url.includes('/api/tally')
      ? { tally: { program: true, preview: false, isoRec: false } }
      : { connected: true, state: {} },
  );
  try {
    const { client, tallies, errors } = clientWithCollector();
    await client.refreshAll();

    assert.deepEqual(tallies[0], { program: true, preview: false, isoRec: false });
    assert.equal(errors.length, 0);
  } finally {
    restore();
  }
});

test('eine TEILWEISE Antwort fuellt die uebrigen Felder nicht mit false auf', async () => {
  // Der zweite Erfindungspunkt, den es gab: `{ ...DEFAULT_TALLY, ...tally }`
  // in main.ts machte aus „die Bridge hat nur ueber program gesprochen" ein
  // „preview und isoRec sind aus".
  const restore = stubFetch((url) =>
    url.includes('/api/tally') ? { tally: { program: true } } : { connected: true, state: {} },
  );
  try {
    const { client, tallies } = clientWithCollector();
    await client.refreshAll();

    assert.equal(tallies[0].program, true);
    assert.equal(tallies[0].preview, undefined);
    assert.equal(tallies[0].isoRec, undefined);
  } finally {
    restore();
  }
});

test('formatTally unterscheidet unbestaetigt von aus', () => {
  assert.equal(formatTally(true), 'true');
  assert.equal(formatTally(false), 'false');
  assert.equal(formatTally(undefined), 'unknown');
});

test('der Anfangszustand ist unbekannt, nicht aus', () => {
  // Zwischen Modul-Start und erster erfolgreicher Abfrage kann niemand etwas
  // wissen. Vorher stand hier `{ program: false, preview: false, isoRec: false }`.
  assert.equal(UNKNOWN_TALLY.program, undefined);
  assert.equal(UNKNOWN_TALLY.preview, undefined);
  assert.equal(UNKNOWN_TALLY.isoRec, undefined);
  assert.equal(formatTally(UNKNOWN_TALLY.program), 'unknown');
});

test('ein HTTP-Fehler behauptet erst recht nichts', async () => {
  const restore = stubFetch(() => ({}), false);
  try {
    const { client, tallies } = clientWithCollector();
    await assert.rejects(() => client.refreshAll());
    // Kein onTally-Aufruf: ein Fehlschlag ist kein Zustand.
    assert.equal(tallies.length, 0);
  } finally {
    restore();
  }
});

test('main.ts fuellt den Zustand nicht mehr mit false auf', async () => {
  // Quell-Zusicherung statt Verhaltenstest: `main.ts` ruft beim Laden
  // `runEntrypoint` auf und laesst sich deshalb nicht importieren. Der
  // zweite Erfindungspunkt sass genau dort, also wird er hier festgehalten.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf-8');

  assert.match(src, /this\.tallyState = \{ \.\.\.tally \}/);
  assert.doesNotMatch(src, /DEFAULT_TALLY/);
  // Der Anfangszustand kommt aus UNKNOWN_TALLY, nicht aus einem Literal.
  assert.match(src, /tallyState: BridgeTallyState = \{ \.\.\.UNKNOWN_TALLY \}/);
  // Und das neue Feedback wird bei jeder Aktualisierung mitgeprueft.
  assert.match(src, /'tally_unknown'/);
});
