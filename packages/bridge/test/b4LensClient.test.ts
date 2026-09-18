/**
 * Das B4-Objektiv-Interface — der einzige Weg, dessen Iris-Rueckmeldung eine
 * MESSUNG ist.
 *
 * Kommandiert wird auf Hirose Pin 5, gemessen auf Pin 7. Das ist eine andere
 * Ader. Ueberall sonst in diesem Repo ist `iris` entweder die Meinung des
 * Geraets ueber sich selbst oder schlicht das Echo dessen, was wir gerade
 * geschickt haben — `MODE_READBACK` zaehlt sechs Wege, die gar nichts lesen.
 *
 * Der teuerste Fehler waere hier derselbe wie dort: das Kommando als
 * Bestaetigung auszugeben. `handleRcpCommand('setIris')` darf deshalb KEIN
 * `stateChanged` senden, und genau das wird unten geprueft — nicht die
 * Absicht im Kommentar, sondern das Verhalten am Ereignis.
 *
 * Gegen einen echten HTTP-Server auf 127.0.0.1, nicht gegen ein
 * nachgebautes `fetch`: die Bruecke spricht mit dem Geraet ueber HTTP, und ein
 * Test, der den Transport wegnimmt, prueft den Teil nicht, der brechen kann.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { B4LensClient, driveRefusal, type B4Status } from '../src/cameras/B4LensClient.js';
import { MODE_READBACK, readsBack } from '../src/protocol/valueOrigin.js';
import { capabilitiesForMode } from '../../web-rcp/src/capabilities.ts';

/** Ein Geraet, dessen Zustand der Test von aussen stellt. */
function fakeDevice(state: { status: B4Status }) {
  const posted: Array<{ path: string; body: unknown }> = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.status));
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      posted.push({ path: req.url!, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { server, posted };
}

async function withDevice(
  status: B4Status,
  fn: (c: B4LensClient, posted: Array<{ path: string; body: unknown }>, state: { status: B4Status }) => Promise<void>,
) {
  const state = { status };
  const { server, posted } = fakeDevice(state);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  // Schneller Takt: der Test soll auf eine Messung warten, nicht auf eine Uhr.
  const client = new B4LensClient('127.0.0.1', port, 20);
  try {
    await fn(client, posted, state);
  } finally {
    await client.disconnect().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const READY: B4Status = {
  firmware: 'b4-lens-control/1',
  driveCompiledIn: true,
  armed: true,
  calibrated: true,
  calPoints: 17,
  i2c: { dac: true, adc: true },
  lens: { iris: 100, irisVolts: 4.1 },
  drive: { setpoint: 100, dacCode: 2048, holding: true },
};

// ── Die Kernaussage ────────────────────────────────────────────────────────

test('setIris meldet NICHT zurueck — die Bestaetigung kommt von Pin 7', async () => {
  await withDevice({ ...READY }, async (c, posted, state) => {
    await c.connect();

    const events: unknown[] = [];
    c.on('stateChanged', (s) => events.push(s));

    await c.handleRcpCommand('setIris', { value: 200 });

    // Das Kommando ging raus …
    assert.ok(posted.some((p) => p.path === '/api/iris' && (p.body as any).value === 200));
    // … aber kein Wert wurde behauptet.
    assert.deepEqual(events, [], 'setIris darf keinen Wert als bestaetigt ausgeben');

    // Erst wenn das Geraet einen anderen Wert GEMESSEN hat, kommt er an.
    state.status = { ...READY, lens: { iris: 198, irisVolts: 5.4 } };
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(events, [{ iris: 198 }]);
  });
});

test('die erste Messung kommt an, danach schweigt ein stillstehendes Objektiv', async () => {
  await withDevice({ ...READY }, async (c) => {
    const events: unknown[] = [];
    c.on('stateChanged', (s) => events.push(s));
    await c.connect();

    // Der erste gelesene Wert IST eine Nachricht: das Pult kennt die Blende
    // noch nicht, und `paintNudge` verweigert einen relativen Trim, solange
    // kein Ist-Wert gelesen wurde. Ihn zurueckzuhalten hiesse, den ersten
    // Tastendruck am Pult ins Leere laufen zu lassen.
    await new Promise((r) => setTimeout(r, 200)); // viele Abfragen
    assert.deepEqual(events, [{ iris: 100 }],
      'genau eine Meldung: der erste Messwert, danach keine Wiederholung');
  });
});

test('fehlt die Messung, wird kein Wert erfunden', async () => {
  const blind: B4Status = { ...READY, i2c: { dac: true, adc: false }, lens: {} };
  await withDevice(blind, async (c) => {
    await c.connect();
    const events: unknown[] = [];
    c.on('stateChanged', (s) => events.push(s));
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(events, [], 'ohne ADC gibt es keine Iris — auch keine 0');
  });
});

// ── Verweigerung mit Grund ─────────────────────────────────────────────────

test('driveRefusal nennt den Grund, nicht nur ein Nein', () => {
  assert.match(driveRefusal({ driveCompiledIn: false })!, /B4_ENABLE_IRIS_DRIVE=0/);
  assert.match(driveRefusal({ driveCompiledIn: true, i2c: { dac: false } })!, /MCP4728/);
  assert.match(
    driveRefusal({ driveCompiledIn: true, i2c: { dac: true }, calibrated: false })!,
    /calibration/i,
  );
  assert.match(
    driveRefusal({ driveCompiledIn: true, i2c: { dac: true }, calibrated: true, armed: false })!,
    /armed/,
  );
  assert.equal(driveRefusal(READY), null);
});

test('setIris auf ein unkalibriertes Geraet wirft mit Begruendung', async () => {
  await withDevice({ ...READY, calibrated: false }, async (c, posted) => {
    await c.connect();
    await assert.rejects(
      () => c.handleRcpCommand('setIris', { value: 128 }),
      /calibration/i,
    );
    assert.ok(!posted.some((p) => p.path === '/api/iris'), 'nichts gesendet');
  });
});

test('ein unkalibriertes Geraet wird beim Verbinden nicht scharfgeschaltet', async () => {
  await withDevice({ ...READY, calibrated: false, armed: false }, async (c, posted) => {
    await c.connect();
    assert.ok(
      !posted.some((p) => p.path === '/api/arm' && (p.body as any).armed === true),
      'scharf und verweigernd sieht an der Werkbank wie ein Hardwarefehler aus',
    );
  });
});

test('Trennen entwaffnet — Verlust des Sollwerts stoppt die Bewegung', async () => {
  await withDevice({ ...READY }, async (c, posted) => {
    await c.connect();
    await c.disconnect();
    assert.ok(posted.some((p) => p.path === '/api/arm' && (p.body as any).armed === false));
  });
});

test('Werte ausserhalb 0..255 werden begrenzt, nicht durchgereicht', async () => {
  await withDevice({ ...READY }, async (c, posted) => {
    await c.connect();
    await c.handleRcpCommand('setIris', { value: 9999 });
    await c.handleRcpCommand('setIris', { value: -7 });
    const vals = posted.filter((p) => p.path === '/api/iris').map((p) => (p.body as any).value);
    assert.deepEqual(vals, [255, 0]);
  });
});

test('unbekannte Kommandos werden abgelehnt, nicht stillschweigend geschluckt', async () => {
  await withDevice({ ...READY }, async (c) => {
    await c.connect();
    assert.equal(await c.handleRcpCommand('setMasterGain', { value: 3 }), false);
    assert.equal(await c.handleRcpCommand('recallPreset', { index: 1 }), false);
  });
});

// ── Die Tabellen muessen zum Backend passen ────────────────────────────────

test('b4-lens steht als bestaetigender Weg in MODE_READBACK', () => {
  assert.deepEqual(MODE_READBACK['b4-lens'], ['iris']);
  assert.equal(readsBack('b4-lens', 'iris'), true);
  // Zoom und Fokus liest das Geraet zwar, aber CameraState hat keine Felder
  // dafuer. Erfundene Paint-Felder waeren zwei tote Regler am Pult.
  assert.equal(readsBack('b4-lens', 'masterGain'), false);
});

test('die Faehigkeiten decken genau das ab, was handleRcpCommand kann', () => {
  const caps = capabilitiesForMode('b4-lens');
  assert.equal(caps.iris, true);
  assert.equal(caps.autoIris, true, 'Pin 8 ist ein Draht, keine NDA-Frage');
  for (const k of ['masterGain', 'masterBlack', 'colorTemp', 'awb', 'focus', 'record'] as const) {
    assert.equal(caps[k], false, `${k} kann dieses Interface nicht — es ist ein Objektiv`);
  }
});
