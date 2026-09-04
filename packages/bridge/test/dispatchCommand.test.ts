/**
 * Nach einem abgelehnten Kommando darf kein Zustand behauptet werden.
 *
 * WAS SCHIEFLIEF (gemessen 2026-09-04). `dispatchCommand` meldete ein nicht
 * unterstuetztes Kommando per `sendError` — ohne `return`. Der optimistische
 * Echo darunter lief trotzdem und schickte einen `type: 'state'`-Broadcast mit
 * genau dem Wert, den die Kamera gerade abgelehnt hatte. Der Client bekam
 * einen Fehler UND einen Erfolg fuer dasselbe Kommando, und der zweite
 * ueberschrieb die Anzeige.
 *
 * Der Kommentar am Echo begruendet ihn damit, dass pollende Backends ihn mit
 * dem echten Wert ueberschreiben. Genau das passiert hier nicht: ein Backend,
 * das das Kommando nicht kann, pollt dafuer auch keinen Wert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeServer } from '../src/BridgeServer.js';

/** Ein WebSocket, der nur mitschreibt. `readyState` 1 = OPEN. */
const fakeWs = () => {
  const gesendet: string[] = [];
  return {
    ws: { readyState: 1, send: (s: string) => gesendet.push(s) } as never,
    gesendet,
  };
};

/** Ein Backend, das jedes Kommando annimmt oder jedes ablehnt. */
const server = (handled: boolean, port: number) => {
  const s = new BridgeServer(port);
  const innen = s as unknown as {
    cameras: Map<number, unknown>;
    cameraStates: Map<number, Record<string, unknown>>;
  };
  innen.cameras.set(1, {
    connected: true,
    backend: { handleRcpCommand: async () => handled, disconnect: async () => {} },
  });
  return { s, innen };
};

test('abgelehntes Kommando setzt KEINEN Zustand', async () => {
  const { s, innen } = server(false, 19731);
  const { ws, gesendet } = fakeWs();
  await (s as unknown as {
    dispatchCommand: (w: unknown, n: number, c: string, p: Record<string, unknown>) => Promise<void>;
  }).dispatchCommand(ws, 1, 'setIris', { value: 42 });

  // Der Fehler geht raus — das war nie das Problem.
  assert.equal(gesendet.length, 1);
  assert.match(gesendet[0], /nicht unterstützt/);

  // Und der Zustand bleibt leer. Vorher stand hier { iris: 42 }.
  assert.equal(innen.cameraStates.has(1), false, 'kein erfundener Zustand nach einem Fehler');
  (s as unknown as { stop: () => void }).stop();
});

test('angenommenes Kommando setzt den Zustand weiterhin', async () => {
  // Gegenprobe: ohne sie koennte der Fix den Echo ganz abgeschaltet haben.
  const { s, innen } = server(true, 19732);
  const { ws, gesendet } = fakeWs();
  await (s as unknown as {
    dispatchCommand: (w: unknown, n: number, c: string, p: Record<string, unknown>) => Promise<void>;
  }).dispatchCommand(ws, 1, 'setIris', { value: 42 });

  assert.equal(gesendet.length, 0, 'kein Fehler bei einem angenommenen Kommando');
  assert.deepEqual(innen.cameraStates.get(1), { iris: 42 });
  (s as unknown as { stop: () => void }).stop();
});

test('nicht verbundene Kamera setzt ebenfalls keinen Zustand', async () => {
  // Der frueh zurueckkehrende Zweig darueber — er war schon richtig, und der
  // Test haelt fest, dass er es bleibt.
  const s = new BridgeServer(19733);
  const innen = s as unknown as { cameraStates: Map<number, unknown> };
  const { ws, gesendet } = fakeWs();
  await (s as unknown as {
    dispatchCommand: (w: unknown, n: number, c: string, p: Record<string, unknown>) => Promise<void>;
  }).dispatchCommand(ws, 9, 'setIris', { value: 42 });

  assert.match(gesendet[0], /nicht verbunden/);
  assert.equal(innen.cameraStates.has(9), false);
  (s as unknown as { stop: () => void }).stop();
});
