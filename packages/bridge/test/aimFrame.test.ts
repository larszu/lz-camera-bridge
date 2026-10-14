/**
 * Aim by frame end to end against the demo head, which holds its pose: a
 * frame drawn in the live picture drives pan/tilt/zoom, the pose reply names
 * the field of view, and the panorama paths refuse with a sentence while
 * there is no map or no stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { BridgeServer } from '../src/BridgeServer.js';
import { zoomForHfov } from '../src/protocol/frameAim.js';

class Client {
  ws: WebSocket;
  inbox: Record<string, unknown>[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
  }
  open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())); }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  async waitFor<T = Record<string, unknown>>(pred: (m: Record<string, unknown>) => boolean, ms = 4000): Promise<T> {
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

test('a frame in the live picture drives the demo head there, zoomed to the frame width', async () => {
  const port = 19781;
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 });
  bridge.start();
  const c = new Client(port);
  await c.open();
  try {
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo' } });
    c.send({ type: 'connectCamera', cameraNumber: 1 });
    await c.waitFor((m) => m.type === 'cameraConnected');

    // Without a field of view the aim is refused, not guessed.
    c.send({ type: 'aimFrame', cameraNumber: 1, source: 'picture', frame: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, aspect: 16 / 9 });
    const refusal = await c.waitFor<{ message: string }>((m) => m.type === 'error');
    assert.match(refusal.message, /field of view/);

    const model = { hfovWideDeg: 60, hfovTeleDeg: 3 };
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: model });
    await c.waitFor((m) => m.type === 'cameras' && (m.cameras as { config: { hfovWideDeg?: number } }[])[0]?.config.hfovWideDeg === 60);

    // Head at wide; a centred half-width frame: same direction, zoom to that field of view.
    c.send({ type: 'aimFrame', cameraNumber: 1, source: 'picture', frame: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, aspect: 16 / 9 });
    const aim = await c.waitFor<{ pose: { pan: number; tilt: number; zoom: number }; hfovDeg: number; fit: string }>((m) => m.type === 'aim');
    assert.equal(aim.pose.pan, 0);
    assert.equal(aim.pose.tilt, 0);
    assert.equal(aim.fit, 'linear');
    assert.equal(aim.pose.zoom, zoomForHfov(aim.hfovDeg, model)!.zoom);

    // The demo head glides there (eased stream of absolute positions); poll until it arrived.
    let pose: { pose: { zoom: number }; hfovDeg: number; fit: string } | undefined;
    for (let i = 0; i < 40 && pose?.pose.zoom !== aim.pose.zoom; i++) {
      c.inbox = [];
      c.send({ type: 'readPose', cameraNumber: 1 });
      pose = await c.waitFor((m) => m.type === 'pose');
      if (pose.pose.zoom !== aim.pose.zoom) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pose!.pose.zoom, aim.pose.zoom);
    assert.ok(Math.abs(pose!.hfovDeg - aim.hfovDeg) < 0.05, `${pose!.hfovDeg} vs ${aim.hfovDeg}`);

    // A frame in the upper right: right and up.
    c.inbox = [];
    c.send({ type: 'aimFrame', cameraNumber: 1, source: 'picture', frame: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 }, aspect: 16 / 9 });
    const ur = await c.waitFor<{ pose: { pan: number; tilt: number } }>((m) => m.type === 'aim');
    assert.ok(ur.pose.pan > 0 && ur.pose.tilt > 0, JSON.stringify(ur.pose));

    // Panorama: none yet, and no stream to scan with.
    c.send({ type: 'getPanorama', cameraNumber: 1 });
    const pano = await c.waitFor<{ meta: unknown }>((m) => m.type === 'panorama');
    assert.equal(pano.meta, null);
    c.inbox = [];
    c.send({ type: 'aimFrame', cameraNumber: 1, source: 'panorama', frame: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
    assert.match((await c.waitFor<{ message: string }>((m) => m.type === 'error')).message, /no panorama/);
    c.inbox = [];
    c.send({ type: 'scanPanorama', cameraNumber: 1 });
    assert.match((await c.waitFor<{ message: string }>((m) => m.type === 'error')).message, /stream address/);
    const res = await fetch(`http://127.0.0.1:${port}/panorama/1.jpg`);
    assert.equal(res.status, 404);
  } finally {
    c.close();
    bridge.stop();
  }
});
