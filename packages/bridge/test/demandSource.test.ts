/**
 * Demand als Quelle auf dem Bus (#51).
 *
 * Geprueft wird, was das Issue verlangt, am Verhalten:
 *   - Stellung erscheint auf dem Bus im vorhandenen Schema (setZoom/setFocus)
 *   - als Sollwert gekennzeichnet, nie als Bestaetigung
 *   - Zielkamera waehlbar
 *   - kein Fluten: Rate, Schritt, Totband
 *   - abgezogener Demand gibt die Achse frei, statt den letzten Wert zu halten
 * Und der Streitfall aus #52: HID-Pult und Demand auf demselben Befehl.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { DemandShaper, DemandSource, conflictingCommands, type DemandBinding } from '../src/input/DemandSource.js';
import { BridgeServer } from '../src/BridgeServer.js';

/** Gemessene Tabelle eines Zoom-Wippen-Demands: Weitwinkel, Mitte, Tele. */
const ZOOM: DemandBinding = {
  axis: 'zoom',
  cameraNumber: 2,
  command: 'setZoom',
  calibration: {
    axis: 'zoom-demand',
    rawUnit: 'adc-count',
    valueUnit: 'rate-percent',
    points: [
      { raw: 8000, value: -100 },
      { raw: 16000, value: 0 },
      { raw: 24000, value: 100 },
    ],
    source: 'Testtabelle, keine Messung',
  },
};

// ── Der reine Teil ────────────────────────────────────────────────────────

test('Mitte im Totband ist Stillstand, Ausschlag wird auf -100..100 abgebildet', () => {
  const s = new DemandShaper(ZOOM);
  assert.deepEqual(s.update(16100, 0), { kind: 'send', value: 0 });
  assert.deepEqual(s.update(20000, 100), { kind: 'send', value: 50 });
  assert.deepEqual(s.update(8000, 200), { kind: 'send', value: -100 });
});

test('kein Fluten: gleicher Wert, kleiner Schritt und zu kurzer Abstand halten', () => {
  const s = new DemandShaper(ZOOM);
  s.update(20000, 0); // 50
  assert.deepEqual(s.update(20000, 100), { kind: 'hold' }, 'gleicher Wert');
  assert.deepEqual(s.update(20040, 200), { kind: 'hold' }, 'Schritt < 2');
  assert.deepEqual(s.update(21600, 300), { kind: 'send', value: 70 });
  assert.deepEqual(s.update(23200, 310), { kind: 'hold' }, 'erst 10 ms seit dem letzten Senden');
  assert.deepEqual(s.update(23200, 350), { kind: 'send', value: 90 });
});

test('ein Stopp wartet nicht auf die Rate', () => {
  const s = new DemandShaper(ZOOM);
  s.update(24000, 0);
  assert.deepEqual(s.update(16000, 5), { kind: 'send', value: 0 });
});

test('abgezogen: genau ein Stopp, danach Stille — nicht der letzte Wert', () => {
  const s = new DemandShaper(ZOOM);
  s.update(22000, 0); // 75, die Achse faehrt
  assert.deepEqual(s.update(undefined, 100), { kind: 'release' });
  assert.deepEqual(s.update(undefined, 200), { kind: 'hold' });
  // Ausserhalb der Tabelle ist ebenfalls „weg": ein freier Schleifer ist kein Anschlag.
  s.update(22000, 300);
  assert.deepEqual(s.update(30000, 400), { kind: 'release' });
});

test('ohne brauchbare Tabelle gibt es keinen Demand', () => {
  assert.throws(
    () => new DemandShaper({ ...ZOOM, calibration: { ...ZOOM.calibration, points: [{ raw: 1, value: 0 }] } }),
    /calibration unusable/,
  );
});

test('Konflikt HID gegen Demand wird erkannt', () => {
  assert.deepEqual(conflictingCommands([ZOOM], [{ command: 'setZoom' }, { command: 'setIris' }]), ['setZoom']);
  assert.deepEqual(conflictingCommands([ZOOM], [{ command: 'ptz' }]), []);
});

// ── Gegen ein Geraet auf 127.0.0.1 ─────────────────────────────────────────

async function withDevice(fn: (port: number, set: (d: unknown) => void, down: () => void) => Promise<void>) {
  let demand: unknown = { zoomCounts: 16000 };
  let alive = true;
  const http = createServer((req, res) => {
    if (!alive) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ firmware: 'test', demand }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  try {
    await fn((http.address() as AddressInfo).port, (d) => (demand = d), () => (alive = false));
  } finally {
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }
}

test('DemandSource: Stellung wird Kommando fuer die gewaehlte Kamera, Verlust stoppt', async () => {
  await withDevice(async (port, set, down) => {
    let t = 0;
    const src = new DemandSource({ host: '127.0.0.1', port, bindings: [ZOOM] }, () => (t += 100));
    const cmds: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];
    src.on('command', (c) => cmds.push(c));
    src.on('demand', (e) => events.push(e));
    src.on('error', () => {});

    await src.poll(); // Mitte
    set({ zoomCounts: 24000 });
    await src.poll(); // voll Tele
    set({}); // Feld fehlt: abgezogen
    await src.poll();
    await src.poll(); // bleibt still

    assert.deepEqual(cmds, [
      { cameraNumber: 2, cmd: 'setZoom', params: { value: 0 } },
      { cameraNumber: 2, cmd: 'setZoom', params: { value: 100 } },
      { cameraNumber: 2, cmd: 'setZoom', params: { value: 0 } },
    ]);
    assert.ok(events.every((e) => e.origin === 'commanded'), 'ein Demand ist ein Sollwertgeber');
    assert.equal(events.at(-1)!.present, false);

    // Geraet weg, waehrend die Achse faehrt: auch das stoppt.
    set({ zoomCounts: 24000 });
    await src.poll();
    down();
    await src.poll();
    assert.deepEqual(cmds.at(-1), { cameraNumber: 2, cmd: 'setZoom', params: { value: 0 } });
    src.stop();
  });
});

// ── Am Bus ────────────────────────────────────────────────────────────────

test('am Bus: Demand erreicht das Backend, erscheint als demand-Nachricht, HID-Konflikt wird verweigert', async () => {
  await withDevice(async (port, set) => {
    const bridge = new BridgeServer(19751, { http: 19851, ws: 19951 });
    const inner = bridge as unknown as {
      cameras: Map<number, unknown>;
      broadcast: (m: unknown) => void;
      handleClientMessage: (ws: unknown, msg: unknown) => Promise<void>;
      demandSource: DemandSource | null;
      stop: () => void;
    };
    const received: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    inner.cameras.set(2, {
      num: 2,
      config: { connectionMode: 'visca' },
      connected: true,
      backend: {
        handleRcpCommand: async (cmd: string, params: Record<string, unknown>) => {
          received.push({ cmd, params });
          return true;
        },
        disconnect: async () => {},
      },
    });
    const out: Array<Record<string, unknown>> = [];
    inner.broadcast = (m) => out.push(m as Record<string, unknown>);
    const ws = { readyState: 1, send: () => {} };

    try {
      await inner.handleClientMessage(ws, {
        type: 'enableDemand',
        demand: { host: '127.0.0.1', port, pollMs: 1000, bindings: [ZOOM] },
      });
      assert.ok(out.some((m) => m.type === 'demandSource' && m.active === true));

      set({ zoomCounts: 20000 });
      await inner.demandSource!.poll();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(received.at(-1), { cmd: 'setZoom', params: { value: 50, cameraNumber: 2 } });
      const msg = out.find((m) => m.type === 'demand' && m.value === 50)!;
      assert.equal(msg.origin, 'commanded');
      assert.equal(msg.cameraNumber, 2);

      // Ein HID-Pult auf demselben Befehl wird abgewiesen, bevor es startet.
      await assert.rejects(
        () =>
          inner.handleClientMessage(ws, {
            type: 'enableControlSurface',
            surface: { vendorId: 1, productId: 2, bindings: [{ kind: 'axis', offset: 0, command: 'setZoom' }] },
          }),
        /already driven by a demand/,
      );

      // Abschalten gibt die Achse frei.
      await inner.handleClientMessage(ws, { type: 'disableDemand' });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(received.at(-1), { cmd: 'setZoom', params: { value: 0, cameraNumber: 2 } });
      assert.ok(out.some((m) => m.type === 'demandSource' && m.active === false));
    } finally {
      inner.stop();
    }
  });
});
