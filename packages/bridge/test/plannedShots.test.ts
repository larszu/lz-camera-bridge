/**
 * Planned shots end to end against the demo camera, which holds a pose: a
 * v3 plan is applied, a shot is driven, every shot is stored with progress,
 * a calibration turns the head's real reading into an offset that survives a
 * restart of the bridge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { BridgeServer } from '../src/BridgeServer.js';

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

const PLAN = {
  kind: 'camera-list', formatVersion: 3, app: 'multicam', appVersion: '1', exportedAt: '',
  cameras: [{
    id: 'c1', label: 'CAM 1', pan: 90, tilt: 0, lens: { focalMinMm: 4.3, focalMaxMm: 129 },
    presets: [
      { number: 1, name: 'Lectern', pan: 120, tilt: -8, focalMm: 66.65, focusM: 6, savedAt: 'x' },
      { number: 2, name: 'Wide', pan: 90, tilt: -2, focalMm: 4.3, focusM: 6, savedAt: 'x' },
    ],
  }],
};

test('drive, store and calibrate planned shots on the demo head; the offset survives a restart', async () => {
  const port = 19771;
  const dir = mkdtempSync(join(tmpdir(), 'lz-shots-'));
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 }, { persist: true, configDir: dir });
  bridge.start();
  const c = new Client(port);
  await c.open();
  try {
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo' } });
    c.send({ type: 'connectCamera', cameraNumber: 1 });
    await c.waitFor((m) => m.type === 'cameraConnected');
    c.send({ type: 'assignPlanCamera', cameraNumber: 1, plan: PLAN, planCameraId: 'c1' });
    const cams = await c.waitFor<{ cameras: { plan?: { presets: unknown[] } }[] }>((m) => m.type === 'cameras' && Boolean((m.cameras as { plan?: unknown }[])[0]?.plan));
    assert.equal(cams.cameras[0].plan?.presets.length, 2);

    // Drive shot 1: room 120° with home heading 90° → head 30°, zoom linear 0.5.
    c.send({ type: 'drivePlannedPreset', cameraNumber: 1, presetNumber: 1 });
    await c.waitFor((m) => m.type === 'plannedProgress' && m.step === 'driving' && m.presetNumber === 1);
    c.send({ type: 'readPose', cameraNumber: 1 });
    let pose = await c.waitFor<{ pose: { pan: number; tilt: number; zoom: number } }>((m) => m.type === 'pose');
    assert.deepEqual(pose.pose, { pan: 30, tilt: -8, zoom: 0.5 });

    // Store all: two "stored" steps and a "done".
    c.inbox = [];
    c.send({ type: 'storePlannedPresets', cameraNumber: 1, settleMs: 10 });
    await c.waitFor((m) => m.type === 'plannedProgress' && m.step === 'done');
    const stored = c.inbox.filter((m) => m.type === 'plannedProgress' && m.step === 'stored').map((m) => m.presetNumber);
    assert.deepEqual(stored, [1, 2]);

    // Calibrate: the operator nudges the head 3° right of shot 2 and says "this is shot 2".
    c.send({ type: 'drivePlannedPreset', cameraNumber: 1, presetNumber: 2 });
    await c.waitFor((m) => m.type === 'plannedProgress' && m.step === 'driving' && m.presetNumber === 2);
    for (let i = 0; i < 3; i++) c.send({ type: 'command', cameraNumber: 1, cmd: 'ptz', params: { pan: 50, tilt: 0 } });
    await new Promise((r) => setTimeout(r, 100));
    c.inbox = [];
    c.send({ type: 'calibratePose', cameraNumber: 1, presetNumber: 2 });
    pose = await c.waitFor((m) => m.type === 'pose' && Boolean(m.offset));
    assert.deepEqual((pose as unknown as { offset: unknown }).offset, { pan: 3, tilt: 0 });
    // From now on shot 1 lands 3° further right.
    c.send({ type: 'drivePlannedPreset', cameraNumber: 1, presetNumber: 1 });
    await c.waitFor((m) => m.type === 'plannedProgress' && m.step === 'driving' && m.presetNumber === 1);
    c.inbox = [];
    c.send({ type: 'readPose', cameraNumber: 1 });
    pose = await c.waitFor((m) => m.type === 'pose');
    assert.equal(pose.pose.pan, 33);
    // A shot the plan does not have is refused with a sentence.
    c.send({ type: 'drivePlannedPreset', cameraNumber: 1, presetNumber: 9 });
    const err = await c.waitFor<{ message: string }>((m) => m.type === 'error');
    assert.match(err.message, /no shot 9/);
  } finally {
    c.close();
    bridge.stop();
  }

  const again = new BridgeServer(port + 1, { http: port + 101, ws: port + 201 }, { persist: true, configDir: dir });
  again.start();
  try {
    const c2 = new Client(port + 1);
    await c2.open();
    const restored = await c2.waitFor<{ cameras: { config: { poseOffset?: unknown }; plan?: { label: string } }[] }>((m) => m.type === 'cameras' && (m.cameras as unknown[]).length === 1);
    assert.deepEqual(restored.cameras[0].config.poseOffset, { pan: 3, tilt: 0 });
    assert.equal(restored.cameras[0].plan?.label, 'CAM 1', 'the plan came back with the site');
    c2.close();
  } finally {
    again.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
