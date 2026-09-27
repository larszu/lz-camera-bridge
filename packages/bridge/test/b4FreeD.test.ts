/**
 * Der FreeD-Laeufer fuer den Unreal-Test (#56): Geraet auf 127.0.0.1 und ein
 * echter UDP-Empfaenger. Beweist die Kette, nicht das Format — das prueft
 * erst eine fremde Gegenstelle (Unreal Live Link), und darum bleibt #56 offen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { AddressInfo } from 'node:net';

import { checkConfig, sampleFrom, startRunner, type B4FreeDConfig } from '../src/tools/b4FreeD.js';
import { decodeFreeD } from '../src/protocol/FreeD.js';

const table = (axis: string) => ({
  axis, rawUnit: 'adc-count', valueUnit: 'percent',
  points: [{ raw: 10000, value: 0 }, { raw: 20000, value: 100 }],
  source: 'Testtabelle, keine Messung',
});

const CFG = (devicePort: number, udpPort: number): B4FreeDConfig => ({
  device: { host: '127.0.0.1', port: devicePort, pollMs: 10 },
  freed: { host: '127.0.0.1', port: udpPort, rateHz: 50, cameraId: 3 },
  zoomTable: table('zoom'),
  focusTable: table('focus'),
  staticPose: { panDeg: 0, tiltDeg: 0, rollDeg: 0, xMm: 0, yMm: 0, zMm: 1500 },
});

test('ohne ausdrueckliche Pose, Port und Rate startet nichts', () => {
  const p = checkConfig({ device: { host: 'x' }, freed: { host: 'y' } as never });
  assert.ok(p.some((s) => /staticPose/.test(s)));
  assert.ok(p.some((s) => /freed.port/.test(s)));
  assert.ok(p.some((s) => /rateHz/.test(s)));
});

test('Messwert ausserhalb der Tabelle oder fehlend wird null, nicht Anschlag', () => {
  const cfg = CFG(1, 1);
  assert.equal(sampleFrom({ zoomCounts: 15000, focusCounts: 20000 }, cfg).zoom, 2048);
  assert.equal(sampleFrom({ zoomCounts: 25000, focusCounts: 20000 }, cfg).zoom, null);
  assert.equal(sampleFrom(undefined, cfg).focus, null);
});

test('Kette: Geraet → Tabelle → FreeD auf UDP; Geraet weg → Stille', async () => {
  let lens: unknown = { zoomCounts: 20000, focusCounts: 10000 };
  let alive = true;
  const http = createServer((req, res) => {
    if (!alive) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ lens }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const udp = createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  const got: Buffer[] = [];
  udp.on('message', (m) => got.push(m));

  const runner = startRunner(CFG((http.address() as AddressInfo).port, udp.address().port));
  try {
    // Auf das erste Paket warten statt auf eine Uhr: unter Last braucht der
    // erste Umlauf (HTTP, Tabelle, Takt) laenger als ein fester Schlaf.
    for (let t0 = Date.now(); got.length === 0 || decodeFreeD(got.at(-1)!)!.zoom !== 4095; ) {
      if (Date.now() - t0 > 3000) throw new Error('kein FreeD-Paket angekommen');
      await new Promise((r) => setTimeout(r, 10));
    }
    const last = decodeFreeD(got.at(-1)!)!;
    assert.equal(last.cameraId, 3);
    assert.equal(last.zoom, 4095);
    assert.equal(last.focus, 0);
    assert.equal(last.zMm, 1500);

    alive = false;
    await runner.poll(); // sofort, nicht auf den Takt warten
    await new Promise((r) => setTimeout(r, 40));
    const n = got.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(got.length, n, 'kein eingefrorener Wert, wenn das Geraet weg ist');
    assert.ok(runner.sender.stats.skippedIncomplete > 0);
  } finally {
    runner.stop();
    udp.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }
});
