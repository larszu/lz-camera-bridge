/**
 * Die Kamera, die nicht da ist — und was sie NICHT sein darf.
 *
 * ─── DIE MELDUNG DAHINTER (Nutzer, 2026-09-09) ──────────────────────────────
 *
 *   „Ebenso auch Kamerapult [muss man lokal starten koennen]."
 *
 * `npm run dev` startete schon immer. Was es nicht konnte, war etwas ZEIGEN:
 * jeder Weg in `backendFactory` braucht eine echte Adresse, also kam das Pult
 * ohne Hardware leer hoch und jeder Regler war tot.
 *
 * ─── WAS HIER GEPRUEFT WIRD ─────────────────────────────────────────────────
 *
 * Nicht, dass der Demo-Weg „funktioniert" — sondern die vier Zusagen, mit
 * denen er sich von einer Kamera unterscheidet. Die dritte und die vierte
 * sind die wichtigen: sie halten die Grenze zwischen „Bedienoberflaeche
 * ausprobieren" und „Messwert vortaeuschen".
 *
 *   1. Er braucht keine Adresse — sonst waere nichts gewonnen.
 *   2. Ein Befehl bewegt den Wert, und der Zustand kommt zurueck.
 *   3. NICHTS bewegt sich von selbst. Kein Drift, kein Rauschen, kein Timer.
 *      Was das Pult zeigt, hat das Pult verursacht.
 *   4. Der Zustand traegt `isDemo` — und zwar bis nach oben. Ein Demo-Wert,
 *      der nicht von einem echten zu unterscheiden ist, ist genau der
 *      Defekt, gegen den `valueOrigin.test.ts` und Bedarf 46 stehen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as schlaf } from 'node:timers/promises';

import { makeBackend } from '../src/cameras/backendFactory.ts';
import { DemoCameraClient } from '../src/cameras/DemoCameraClient.ts';
import { MODE_READBACK, MODE_CADENCE } from '../src/protocol/valueOrigin.ts';

test('der Demo-Weg braucht keine Adresse', () => {
  // Jeder andere Modus wirft hier: „Keine Kamera-IP konfiguriert", „Kein
  // serieller Port konfiguriert". Genau das machte das Pult ohne Hardware
  // unbenutzbar.
  const gebaut = makeBackend({ connectionMode: 'demo' });
  assert.ok(gebaut.backend instanceof DemoCameraClient);

  for (const modus of ['blackmagic', 'sony-mnc', 'canon-ccapi', 'visca'] as const) {
    assert.throws(() => makeBackend({ connectionMode: modus }),
      `${modus} sollte ohne Adresse werfen — sonst misst dieser Test nichts`);
  }
});

test('ein Befehl bewegt den Wert, und der Zustand kommt zurueck', async () => {
  const c = new DemoCameraClient();
  const gesehen: unknown[] = [];
  c.on('stateChanged', (s) => gesehen.push(s));

  assert.equal(c.isConnected, false);
  await c.connect();
  assert.equal(c.isConnected, true);

  assert.equal(await c.handleRcpCommand('setIris', { value: 73 }), true);
  assert.equal(c.state.iris, 73);
  assert.equal(await c.handleRcpCommand('setBars', { on: true }), true);
  assert.equal(c.state.bars, true);
  assert.equal(await c.handleRcpCommand('setWhiteBalance', { r: 5, g: 0, b: -5 }), true);
  assert.deepEqual([c.state.whiteR, c.state.whiteG, c.state.whiteB], [5, 0, -5]);

  // connect + drei Befehle
  assert.equal(gesehen.length, 4);
});

test('ein unbekannter Befehl wird abgelehnt und nicht geschluckt', async () => {
  // Ein Demo, das alles mit `true` beantwortet, meldet Erfolg fuer einen
  // Befehl, den die echten Wege ablehnen — und jemand baut einen Knopf auf
  // diese Antwort.
  const c = new DemoCameraClient();
  await c.connect();
  assert.equal(await c.handleRcpCommand('setWarpDrive', { value: 9 }), false);
});

test('ohne Verbindung passiert gar nichts', async () => {
  const c = new DemoCameraClient();
  assert.equal(await c.handleRcpCommand('setIris', { value: 10 }), false);
  assert.equal(c.state.iris, 50, 'der Wert hat sich ohne Verbindung bewegt');
});

test('NICHTS bewegt sich von selbst', async () => {
  // Die Zusage, die den Unterschied zu einem Simulator macht. Ein Drift,
  // ein Rauschen oder ein Timer wuerde Werte erzeugen, die niemand
  // kommandiert hat — und das Pult zeigte eine Bewegung, die es nicht gab.
  const c = new DemoCameraClient();
  await c.connect();
  const vorher = JSON.stringify(c.state);
  let meldungen = 0;
  c.on('stateChanged', () => { meldungen += 1; });

  await schlaf(600);

  assert.equal(JSON.stringify(c.state), vorher, 'der Zustand hat sich von selbst geaendert');
  assert.equal(meldungen, 0, 'es kam eine Meldung ohne Befehl');
});

test('der Zustand nennt sich als Demo — und behaelt es beim Durchreichen', () => {
  const { backend, mapState } = makeBackend({ connectionMode: 'demo' });
  const c = backend as DemoCameraClient;
  assert.equal(c.state.isDemo, true);

  // `mapState` ist der Weg nach oben ins Dashboard. Faellt `isDemo` hier
  // heraus, kommt der Wert oben an wie jeder andere — und genau das darf
  // nicht passieren.
  const oben = mapState(c.state) as Record<string, unknown>;
  assert.equal(oben.isDemo, true,
    'isDemo faellt auf dem Weg ins Dashboard heraus — dann ist der Demo-Wert '
    + 'von einem echten nicht mehr zu unterscheiden');
});

test('der Demo-Weg steht in beiden Herkunfts-Tabellen', () => {
  // Die Tabellen sind `Record<ConnectionMode, …>`; TypeScript erzwingt den
  // Eintrag also schon. Was es NICHT erzwingt, ist ein sinnvoller Wert —
  // und `[]` waere hier falsch: es hiesse „liest nicht zurueck", und dann
  // zeigte das Pult jeden gezogenen Regler als unbestaetigt an, obwohl er
  // unmittelbar antwortet.
  assert.ok(MODE_READBACK.demo.length > 10,
    'der Demo-Weg liest seinen ganzen Zustand zurueck — die Liste sagt es nicht');
  assert.deepEqual(MODE_CADENCE.demo, { kind: 'push' },
    'der Demo-Weg meldet nach jedem Befehl und sonst nie — das ist push');
});
