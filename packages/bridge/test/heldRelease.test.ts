/**
 * A client that disappears while it holds a speed key must not leave the
 * head moving: the bridge sends the release for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { BridgeServer } from '../src/BridgeServer.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('held pan/tilt and zoom are stopped when the client goes away', async () => {
  const port = 19631;
  const dir = mkdtempSync(join(tmpdir(), 'lz-held-'));
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 }, { persist: false, configDir: dir });
  bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  try {
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo', ease: { attackMs: 0, releaseMs: 0 } } });
    send({ type: 'connectCamera', cameraNumber: 1 });
    await wait(450);

    const sent: [string, Record<string, unknown>][] = [];
    const backend = (bridge as unknown as { cameras: Map<number, { backend: { handleRcpCommand: (c: string, p: Record<string, unknown>) => Promise<boolean> } }> }).cameras.get(1)!.backend;
    const orig = backend.handleRcpCommand.bind(backend);
    backend.handleRcpCommand = (c, p) => { sent.push([c, p]); return orig(c, p); };

    send({ type: 'command', cameraNumber: 1, cmd: 'ptz', params: { pan: 60, tilt: 0 } });
    send({ type: 'command', cameraNumber: 1, cmd: 'setZoom', params: { value: 40 } });
    send({ type: 'command', cameraNumber: 1, cmd: 'setFocus', params: { value: 30 } });
    send({ type: 'command', cameraNumber: 1, cmd: 'setFocus', params: { value: 0 } }); // released normally
    await wait(150);
    sent.length = 0;

    ws.close();
    await wait(300);

    assert.deepEqual(sent.find(([c]) => c === 'ptz')?.[1], { pan: 0, tilt: 0, cameraNumber: 1 });
    assert.deepEqual(sent.find(([c]) => c === 'setZoom')?.[1], { value: 0, cameraNumber: 1 });
    assert.equal(sent.some(([c]) => c === 'setFocus'), false, 'a released axis is left alone');
  } finally {
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
