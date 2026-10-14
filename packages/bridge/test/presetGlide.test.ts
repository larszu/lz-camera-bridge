// Eased preset recall on every positioning head (motion/PresetGlide.ts):
// the frames, the player, the wire encodings with a speed, the bridge path
// against the demo head, and the table that tells the panel which camera
// gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';

import { PresetGlide, glideFrames, clampGlideTime, DEFAULT_GLIDE } from '../src/motion/PresetGlide.ts';
import { awAbsolutePanTiltSpeed, viscaAbsolutePanTilt } from '../src/protocol/ptzPose.ts';
import { EASED_PRESET_MODES, makeBackend, presetRecallFor, type CameraConfig, type ConnectionMode } from '../src/cameras/backendFactory.ts';
import { ViscaClient } from '../src/cameras/ViscaClient.ts';
import { BridgeServer } from '../src/BridgeServer.ts';

const opts = { ...DEFAULT_GLIDE, timeMs: 1000, intervalMs: 50 };

test('glide frames: start excluded, exact target, slow at both ends', () => {
  const f = glideFrames({ pan: 0, tilt: 0, zoom: 0 }, { pan: 40, tilt: -10, zoom: 0.5 }, opts);
  assert.equal(f.length, 20);
  assert.deepEqual(f.at(-1)!.pose, { pan: 40, tilt: -10, zoom: 0.5 });
  assert.ok(f[0].pose.pan < 1, 'first step is small');
  assert.ok(f[0].speed < f[9].speed && f[19].speed < f[9].speed, 'speed rises and falls');
  assert.ok(f.every((x) => x.speed > 0 && x.speed <= 1));
  for (let i = 1; i < f.length; i++) assert.ok(f[i].pose.pan >= f[i - 1].pose.pan, 'monotonic');
});

test('glide frames: no target zoom leaves the zoom alone; time is clamped', () => {
  const f = glideFrames({ pan: 0, tilt: 0, zoom: 0.3 }, { pan: 10, tilt: 0 }, opts);
  assert.ok(f.every((x) => x.pose.zoom === undefined));
  assert.equal(clampGlideTime(10), 300);
  assert.equal(clampGlideTime(1e9), 60000);
});

test('the player sends every frame on its clock and stops when cancelled', async () => {
  const frames = glideFrames({ pan: 0, tilt: 0 }, { pan: 10, tilt: 0 }, { ...opts, timeMs: 300, intervalMs: 20 });
  const sent: Record<string, unknown>[] = [];
  const g = new PresetGlide();
  const r = await g.run(async (cmd, p) => { assert.equal(cmd, 'ptzAbsolute'); sent.push(p); return true; }, frames, 20);
  assert.equal(r, 'done');
  // A loaded test runner may skip a frame or two; never the target, never backwards.
  assert.ok(sent.length >= frames.length - 3, `${sent.length} of ${frames.length} frames`);
  assert.equal(sent.at(-1)!.pan, 10);
  for (let i = 1; i < sent.length; i++) assert.ok(Number(sent[i].pan) >= Number(sent[i - 1].pan));
  assert.equal(sent[0].stream, true);

  const g2 = new PresetGlide();
  let n = 0;
  const run = g2.run(async () => { n++; return true; }, frames, 20);
  await new Promise((r) => setTimeout(r, 50));
  g2.cancel();
  assert.equal(await run, 'cancelled');
  assert.ok(n < frames.length);
});

test('a slow transport skips frames instead of stretching the move', async () => {
  const frames = glideFrames({ pan: 0, tilt: 0 }, { pan: 30, tilt: 0 }, { ...opts, timeMs: 400, intervalMs: 20 });
  const sent: Record<string, unknown>[] = [];
  const t0 = Date.now();
  const r = await new PresetGlide().run(async (_c, p) => { sent.push(p); await new Promise((x) => setTimeout(x, 60)); return true; }, frames, 20);
  assert.equal(r, 'done');
  assert.ok(sent.length < frames.length, 'frames were skipped');
  assert.equal(sent.at(-1)!.pan, 30, 'the target is never skipped');
  assert.ok(Date.now() - t0 < 900, 'the move kept roughly its length');
});

test('wire: VISCA and AW carry the speed of a glide frame', () => {
  assert.deepEqual(viscaAbsolutePanTilt(0, 0, 14.4, 0.5 * 0x18, 0.5 * 0x14).slice(4, 6), [0x0c, 0x0a]);
  assert.equal(awAbsolutePanTiltSpeed(0, 0, 1), 'APS7FFF80001D2');
  assert.equal(awAbsolutePanTiltSpeed(0, 0, 0), 'APS7FFF8000012', 'never speed 0');
});

test('ViscaClient puts the speed into the absolute pan-tilt packet', async () => {
  const v = new ViscaClient('127.0.0.1', 1259);
  const sent: number[][] = [];
  (v as unknown as { send: (b: number[]) => Promise<void> }).send = async (b) => { sent.push(b); };
  await v.handleRcpCommand('ptzAbsolute', { pan: 10, tilt: 0, zoom: 0.5, speed: 0.25 });
  assert.deepEqual(sent[0].slice(0, 6), [0x81, 0x01, 0x06, 0x02, 6, 5]);
  assert.deepEqual(sent[1].slice(0, 4), [0x81, 0x01, 0x04, 0x47]);
  sent.length = 0;
  await v.handleRcpCommand('ptzAbsolute', { pan: 10, tilt: 0 });
  assert.deepEqual(sent[0].slice(4, 6), [0x18, 0x14], 'no speed → full speed as before');
});

test('the eased-preset table agrees with the backends', () => {
  const cfg = (mode: ConnectionMode): CameraConfig => ({
    connectionMode: mode, camHost: '127.0.0.1', bmHost: '127.0.0.1', mncHost: '127.0.0.1', canonHost: '127.0.0.1',
    serialPath: '/dev/null', viscaSerialPath: '/dev/null', djiPath: '/dev/null',
  });
  const modes: ConnectionMode[] = [
    'tcp', 'serial', 'lumix-http', 'sony-usb', 'blackmagic', 'sony-mnc', 'canon-ccapi', 'sony-ptpip', 'zcam',
    'panasonic-ptz', 'visca', 'visca-serial', 'jvc', 'birddog', 'http-cgi', 'dji-osmo', 'dji-ronin', 'b4-lens',
    'robotic-head', 'demo',
  ];
  for (const mode of modes) {
    const { backend } = makeBackend(cfg(mode));
    // The robotic head eases its own presets (keyframes); everyone else needs both.
    const glides = Boolean(backend.poseStream && backend.readPose) || mode === 'robotic-head';
    assert.equal(EASED_PRESET_MODES.includes(mode), glides, `${mode}: table and backend disagree`);
    assert.equal(presetRecallFor(mode), glides ? 'eased' : 'camera');
  }
});

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

type Cams = { cameras: { presetRecall?: string; config: { bridgePresets?: Record<string, Record<string, unknown>> } }[] };

test('bridge: store keeps the pose, recall glides there, soft off uses the camera preset', async () => {
  const port = 19791;
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 });
  bridge.start();
  const c = new Client(port);
  await c.open();
  try {
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo', presetMove: { timeMs: 400 } } });
    c.send({ type: 'connectCamera', cameraNumber: 1 });
    await c.waitFor((m) => m.type === 'cameraConnected');
    const listed = await c.waitFor<Cams>((m) => m.type === 'cameras' && (m.cameras as unknown[]).length === 1);
    assert.equal(listed.cameras[0].presetRecall, 'eased');

    c.send({ type: 'command', cameraNumber: 1, cmd: 'ptzAbsolute', params: { pan: 20, tilt: -5, zoom: 0.4 } });
    c.send({ type: 'command', cameraNumber: 1, cmd: 'storePreset', params: { value: 3 } });
    const stored = await c.waitFor<Cams>((m) => m.type === 'cameras' && Boolean((m as unknown as Cams).cameras[0]?.config.bridgePresets?.['3']));
    assert.deepEqual(stored.cameras[0].config.bridgePresets!['3'], { pan: 20, tilt: -5, zoom: 0.4 });

    c.send({ type: 'setPresetMotion', cameraNumber: 1, presetNumber: 3, timeMs: 1200 });
    await c.waitFor<Cams>((m) => m.type === 'cameras' && (m as unknown as Cams).cameras[0]?.config.bridgePresets?.['3']?.timeMs === 1200);

    // Elsewhere, then recall: halfway through the head is between, at the end on the pose.
    c.send({ type: 'command', cameraNumber: 1, cmd: 'ptzAbsolute', params: { pan: -20, tilt: 5, zoom: 0 } });
    await new Promise((r) => setTimeout(r, 30));
    c.send({ type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } });
    await new Promise((r) => setTimeout(r, 400));
    c.inbox = [];
    c.send({ type: 'readPose', cameraNumber: 1 });
    const mid = await c.waitFor<{ pose: { pan: number } }>((m) => m.type === 'pose');
    assert.ok(mid.pose.pan > -20 && mid.pose.pan < 20, `between the two poses, was ${mid.pose.pan}`);
    await new Promise((r) => setTimeout(r, 1200));
    c.inbox = [];
    c.send({ type: 'readPose', cameraNumber: 1 });
    const end = await c.waitFor<{ pose: unknown }>((m) => m.type === 'pose');
    assert.deepEqual(end.pose, { pan: 20, tilt: -5, zoom: 0.4 });

    // A joystick move takes over from a running glide.
    c.send({ type: 'command', cameraNumber: 1, cmd: 'ptzAbsolute', params: { pan: -20, tilt: 0, zoom: 0 } });
    await new Promise((r) => setTimeout(r, 30));
    c.send({ type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } });
    await new Promise((r) => setTimeout(r, 100));
    c.send({ type: 'command', cameraNumber: 1, cmd: 'ptzAbsolute', params: { pan: -30, tilt: 0 } });
    await new Promise((r) => setTimeout(r, 1300));
    c.inbox = [];
    c.send({ type: 'readPose', cameraNumber: 1 });
    const taken = await c.waitFor<{ pose: { pan: number } }>((m) => m.type === 'pose');
    assert.equal(taken.pose.pan, -30);

    // Soft off: the camera's own preset (the demo's does not move the head).
    c.send({ type: 'setPresetMotion', cameraNumber: 1, presetNumber: 3, soft: false });
    await c.waitFor<Cams>((m) => m.type === 'cameras' && (m as unknown as Cams).cameras[0]?.config.bridgePresets?.['3']?.soft === false);
    c.send({ type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } });
    await new Promise((r) => setTimeout(r, 200));
    c.inbox = [];
    c.send({ type: 'readPose', cameraNumber: 1 });
    const hard = await c.waitFor<{ pose: { pan: number } }>((m) => m.type === 'pose');
    assert.equal(hard.pose.pan, -30);
  } finally {
    c.close();
    bridge.stop();
  }
});

test('issue #143: a busy Companion port is a log line, not an uncaught exception', async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(19993, r));
  const bridge = new BridgeServer(19793, { http: 19893, ws: 19993 });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    bridge.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(errors.some((e) => /19993 is in use/.test(String(e))), 'the busy port is named');
    // The bridge itself still answers.
    const c = new Client(19793);
    await c.open();
    await c.waitFor((m) => m.type === 'cameras');
    c.close();
  } finally {
    console.error = orig;
    bridge.stop();
    blocker.close();
  }
});
