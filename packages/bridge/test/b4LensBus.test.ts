/**
 * Das B4-Objektiv am Command-Bus — Abnahme von #35 an der Stelle, an der ein
 * Pult es sieht: am `type: 'state'`-Broadcast der Bruecke.
 *
 * `b4LensClient.test.ts` prueft das Backend fuer sich. Hier geht es um die
 * Kette dahinter: dieselbe Serveradresse, dasselbe Nachrichtenschema, und die
 * Trennung von `origins` und `confirmations`, die das Issue verlangt:
 *
 *   - ein Iris-Sollwert kommt als `{ type: 'command', cmd: 'setIris' }` herein
 *     und erscheint als 'commanded', OHNE Bestaetigungszeit;
 *   - erst die Messung an Pin 7 macht daraus 'confirmed' mit Zeitstempel.
 *
 * Gegen einen echten HTTP-Server auf 127.0.0.1, wie im Rest der B4-Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { BridgeServer } from '../src/BridgeServer.js';
import type { B4Status } from '../src/cameras/B4LensClient.js';

type StateMsg = {
  type: 'state';
  cameraNumber: number;
  state: Record<string, unknown>;
  origins: Record<string, string>;
  confirmations: Record<string, number>;
};

const READY: B4Status = {
  driveCompiledIn: true,
  armed: true,
  calibrated: true,
  i2c: { dac: true, adc: true },
  lens: { iris: 100 },
  drive: { setpoint: 100, holding: true },
};

const fakeWs = () => {
  const sent: string[] = [];
  return { ws: { readyState: 1, send: (s: string) => sent.push(s) } as never, sent };
};

const until = async (cond: () => boolean, ms = 1500): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitueberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('b4-lens am Bus: Sollwert ist commanded, erst die Messung ist confirmed', async () => {
  const device = { status: { ...READY } as B4Status };
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(device.status));
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;

  // Nicht gestartet: der Test braucht den Bus, nicht den Port 9700.
  const bridge = new BridgeServer(19741, { http: 19841, ws: 19941 });
  const inner = bridge as unknown as {
    broadcast: (m: unknown) => void;
    handleClientMessage: (ws: unknown, msg: unknown) => Promise<void>;
    stop: () => void;
  };
  const states: StateMsg[] = [];
  inner.broadcast = (m: unknown) => {
    if ((m as { type?: string }).type === 'state') states.push(m as StateMsg);
  };

  const { ws, sent } = fakeWs();
  try {
    await inner.handleClientMessage(ws, {
      type: 'setCameraConfig',
      cameraNumber: 1,
      config: { connectionMode: 'b4-lens', camHost: '127.0.0.1', camPort: port },
    });
    await inner.handleClientMessage(ws, { type: 'connectCamera', cameraNumber: 1 });

    // 1. Die erste Messung: bestaetigt, mit Zeitstempel.
    await until(() => states.length >= 1);
    const first = states.at(-1)!;
    assert.equal(first.cameraNumber, 1);
    assert.equal(first.state.iris, 100);
    assert.equal(first.origins.iris, 'confirmed');
    assert.equal(typeof first.confirmations.iris, 'number');

    // 2. Ein Sollwert ueber das vorhandene Kommando-Schema.
    const before = states.length;
    await inner.handleClientMessage(ws, {
      type: 'command',
      cameraNumber: 1,
      cmd: 'setIris',
      params: { value: 200 },
    });
    assert.deepEqual(sent, [], 'kein Fehler fuer ein unterstuetztes Kommando');
    const commanded = states[before]!;
    assert.equal(commanded.state.iris, 200);
    assert.equal(commanded.origins.iris, 'commanded', 'ein Sollwert ist keine Bestaetigung');
    assert.equal(
      'iris' in commanded.confirmations,
      false,
      'ein nicht zurueckgelesener Wert traegt keine Bestaetigungszeit',
    );

    // 3. Das Geraet misst an Pin 7 einen anderen Wert — der wird bestaetigt.
    device.status = { ...READY, lens: { iris: 197 } };
    await until(() => states.at(-1)!.state.iris === 197);
    const confirmed = states.at(-1)!;
    assert.equal(confirmed.origins.iris, 'confirmed');
    assert.equal(typeof confirmed.confirmations.iris, 'number');
  } finally {
    await inner.handleClientMessage(ws, { type: 'disconnectCamera', cameraNumber: 1 }).catch(() => {});
    inner.stop();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }
});
