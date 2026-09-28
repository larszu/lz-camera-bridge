/**
 * The bridge with a switcher slot next to its camera slots, over the real
 * WebSocket: the tally per camera is DERIVED from the switcher's bus and
 * every camera's `switcherInput`; the site goes out and comes back in
 * (also from the predecessor's export); the HTTP side serves the site and
 * refuses a camera without a stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { BridgeServer } from '../src/BridgeServer.js';

/** A VIS-CATC on HTTP: source 3 on window 1, layout 0. */
function fakeSwitcher() {
  const state = { out1: 3, out2: 1, out3: 2, out4: 4, mode: 0, audio: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = /^param=(.*)$/.exec(raw)?.[1] ?? '';
      let answer = '{}';
      if (p === 'status') answer = JSON.stringify(state);
      else if (p === 'inputinfo') answer = '{}';
      else if (p === 'version') answer = '{"version":"T"}';
      const m = /^(\d)V(\d)$/.exec(p);
      if (m) (state as Record<string, number>)[`out${m[2]}`] = Number(m[1]);
      res.writeHead(200);
      res.end(answer);
    });
  });
  return { server, state };
}

class Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
  }
  open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())); }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  async waitFor<T = Record<string, unknown>>(pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = [...this.inbox].reverse().find(pred);
      if (found) return found as T;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no message matched within ${ms} ms; last: ${JSON.stringify(this.inbox.at(-1))}`);
  }
  close(): void { this.ws.close(); }
}

test('switcher slot, per-camera tally, site round trip, HTTP side', async () => {
  const sw = fakeSwitcher();
  const swPort = await new Promise<number>((r) => sw.server.listen(0, '127.0.0.1', () => r((sw.server.address() as AddressInfo).port)));
  const port = 19761;
  const dir = mkdtempSync(join(tmpdir(), 'lz-bridge-'));
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 }, { persist: true, configDir: dir });
  bridge.start();
  const c = new Client(port);
  await c.open();
  try {
    // Two cameras on inputs 3 and 1 (demo cameras: no address needed), one switcher.
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo', switcherInput: 3, label: 'Stage' } });
    c.send({ type: 'setCameraConfig', cameraNumber: 2, config: { connectionMode: 'demo', switcherInput: 1 } });
    c.send({ type: 'setSwitcherConfig', switcherNumber: 1, switcherConfig: { host: '127.0.0.1', port: swPort, path: 'http' } });
    c.send({ type: 'connectSwitcher', switcherNumber: 1 });
    const list = await c.waitFor<{ switchers: { connected: boolean; state: { program: number } }[] }>((m) => m.type === 'switchers' && (m.switchers as { connected: boolean }[])[0]?.connected === true);
    assert.equal(list.switchers[0].state.program, 3);
    let tally = await c.waitFor<{ tally: Record<string, string> }>((m) => m.type === 'cameraTally' && (m.tally as Record<string, string>)['1'] === 'program');
    assert.deepEqual(tally.tally, { 1: 'program', 2: 'off' });

    // Preview camera 2's input, then CUT: the switcher gets 1V1, tally flips.
    c.send({ type: 'switcherCommand', switcherNumber: 1, cmd: 'preview', params: { source: 1 } });
    tally = await c.waitFor((m) => m.type === 'cameraTally' && (m.tally as Record<string, string>)['2'] === 'preview');
    assert.deepEqual(tally.tally, { 1: 'program', 2: 'preview' });
    c.send({ type: 'switcherCommand', switcherNumber: 1, cmd: 'cut', params: {} });
    tally = await c.waitFor((m) => m.type === 'cameraTally' && (m.tally as Record<string, string>)['2'] === 'program');
    assert.deepEqual(tally.tally, { 1: 'preview', 2: 'program' });
    assert.equal(sw.state.out1, 1);

    // Site export carries both families; the name is settable.
    c.send({ type: 'setSiteName', name: 'Test room' });
    const site = await c.waitFor<{ site: { name: string; cameras: unknown[]; switchers: unknown[] }; path: string }>((m) => m.type === 'site' && (m.name as string) === 'Test room');
    assert.equal(site.site.cameras.length, 2);
    assert.equal(site.site.switchers.length, 1);
    assert.equal(site.path, join(dir, 'site.json'));

    // The predecessor's export replaces the room: one http-cgi camera, no switcher.
    c.inbox = [];
    c.send({
      type: 'importSite',
      site: { version: 1, installationName: 'Old room', devices: [{ kind: 'vissonic-ptz', name: 'Cam', host: '10.0.0.9', httpPort: 80, switcherInput: 2 }] },
    });
    const cams = await c.waitFor<{ cameras: { config: { connectionMode: string; label: string } }[] }>((m) => m.type === 'cameras' && (m.cameras as unknown[]).length === 1);
    assert.equal(cams.cameras[0].config.connectionMode, 'http-cgi');
    assert.equal(cams.cameras[0].config.label, 'Cam');
    const after = await c.waitFor<{ switchers: unknown[] }>((m) => m.type === 'switchers' && (m.switchers as unknown[]).length === 0);
    assert.equal(after.switchers.length, 0);
    // Junk is refused with a sentence, not silence.
    c.inbox = [];
    c.send({ type: 'importSite', site: { foo: 1 } });
    const err = await c.waitFor<{ message: string }>((m) => m.type === 'error' && /site file/i.test(String(m.message)));
    assert.match(err.message, /Not a site file/);

    // HTTP: /site.json downloads, /video/<n>.mjpeg without a stream is a 404, /health answers.
    const siteRes = await fetch(`http://127.0.0.1:${port}/site.json`);
    assert.equal(siteRes.status, 200);
    assert.match(siteRes.headers.get('content-disposition') ?? '', /Old_room\.lz-site\.json/);
    assert.equal((await siteRes.json()).cameras.length, 1);
    const video = await fetch(`http://127.0.0.1:${port}/video/1.mjpeg`);
    assert.equal(video.status, 404);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await health.json()).service, 'lz-camera-bridge');
    // A public stream address is refused before ffmpeg is even looked for.
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { streamUrl: 'rtsp://8.8.8.8/x' } });
    await c.waitFor((m) => m.type === 'cameras' && ((m.cameras as { config: { streamUrl?: string } }[])[0].config.streamUrl === 'rtsp://8.8.8.8/x'));
    const refused = await fetch(`http://127.0.0.1:${port}/video/1.mjpeg`);
    assert.equal(refused.status, 400);
  } finally {
    c.close();
    bridge.stop();
    (sw.server as unknown as { closeAllConnections(): void }).closeAllConnections();
    sw.server.close();
  }

  // Persistence: a second bridge on the same directory restores the room.
  const again = new BridgeServer(port + 1, { http: port + 101, ws: port + 201 }, { persist: true, configDir: dir });
  again.start();
  try {
    const c2 = new Client(port + 1);
    await c2.open();
    const restored = await c2.waitFor<{ cameras: { config: { camHost: string } }[] }>((m) => m.type === 'cameras' && (m.cameras as unknown[]).length === 1);
    assert.equal(restored.cameras[0].config.camHost, '10.0.0.9');
    const name = await c2.waitFor<{ name: string }>((m) => m.type === 'site');
    assert.equal(name.name, 'Old room');
    c2.close();
  } finally {
    again.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
