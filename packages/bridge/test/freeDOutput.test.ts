/**
 * FreeD tracking from camera poses: mapping, interpolation, byte layout as a
 * Live Link FreeD source reads it, and the whole path over loopback UDP into
 * the receiver tool.
 *
 * The receiver here is our own decoder. That proves the bridge agrees with
 * itself and with the published layout written out byte by byte below — not
 * that a foreign receiver does (issue #56 stays open for that).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import { decodeFreeD, encodeFreeD, freeDChecksum } from '../src/protocol/FreeD.ts';
import {
  normaliseFreeDSite, poseToFreeD, PoseInterpolator, freeDCameraId, FREED_SUGGESTED_PORT,
} from '../src/protocol/freeDPose.ts';
import { createFreeDSender } from '../src/transport/FreeDSender.ts';
import { FreeDOutput } from '../src/transport/FreeDOutput.ts';
import { createFreeDReceiver, formatSample, type ReceivedPacket } from '../src/tools/freedReceive.ts';
import { makeBackend, POSE_READ_MODES, type CameraConfig, type ConnectionMode } from '../src/cameras/backendFactory.ts';
import { parseSite, serialiseSite, emptySite } from '../src/site/siteFile.ts';
import { parseViscaFocus } from '../src/protocol/ptzPose.ts';
import { WebSocket } from 'ws';
import { BridgeServer } from '../src/BridgeServer.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Byte layout, written out by hand ─────────────────────────────────────────

test('D1 layout: angles ×32768, positions ×64 mm, zoom/focus 24-bit unsigned, checksum 0x40 − sum', () => {
  const r = encodeFreeD({
    cameraId: 7, panDeg: 90, tiltDeg: -45, rollDeg: 0.5,
    xMm: 1000, yMm: -250, zMm: 1500, zoom: 4095, focus: 2048,
  });
  assert.ok(r.ok);
  const b = r.packet;
  assert.equal(b.length, 29);
  assert.equal(b[0], 0xd1);
  assert.equal(b[1], 7);
  assert.deepEqual([...b.subarray(2, 5)], [0x2d, 0x00, 0x00], 'pan 90° = 90·32768 = 0x2D0000');
  assert.deepEqual([...b.subarray(5, 8)], [0xe9, 0x80, 0x00], 'tilt −45° = two’s complement of 0x168000');
  assert.deepEqual([...b.subarray(8, 11)], [0x00, 0x40, 0x00], 'roll 0.5° = 0x004000');
  assert.deepEqual([...b.subarray(11, 14)], [0x00, 0xfa, 0x00], 'x 1000 mm = 64000');
  assert.deepEqual([...b.subarray(14, 17)], [0xff, 0xc1, 0x80], 'y −250 mm = −16000');
  assert.deepEqual([...b.subarray(17, 20)], [0x01, 0x77, 0x00], 'z 1500 mm = 96000');
  assert.deepEqual([...b.subarray(20, 23)], [0x00, 0x0f, 0xff], 'zoom 4095');
  assert.deepEqual([...b.subarray(23, 26)], [0x00, 0x08, 0x00], 'focus 2048');
  let sum = 0;
  for (let i = 0; i < 28; i++) sum += b[i];
  assert.equal(b[28], (0x40 - sum) & 0xff);
  assert.equal(b[28], freeDChecksum(b.subarray(0, 28)));
  // Live Link FreeD sums all 29 bytes with the checksum and expects 0x40.
  let all = 0;
  for (const x of b) all = (all + x) & 0xff;
  assert.equal(all, 0x40);
});

// ── Mapping ──────────────────────────────────────────────────────────────────

test('pose → sample: inversion, offsets, mounting position, counter-range zoom/focus', () => {
  const m = poseToFreeD(
    { pan: 10, tilt: -5, zoom: 0.5, focus: 1 },
    {
      enabled: true, cameraId: 3, positionMm: { x: 100, y: 200, z: 1600 },
      invert: { pan: true, focus: true }, offsetDeg: { pan: 2, tilt: 1, roll: 0.25 },
    },
    1,
  );
  assert.deepEqual(m.unread, []);
  assert.deepEqual(m.sample, {
    cameraId: 3, panDeg: -8, tiltDeg: -4, rollDeg: 0.25,
    xMm: 100, yMm: 200, zMm: 1600, zoom: 2048, focus: 0,
  });
});

test('pose → sample: unreported focus is 0 and named; camera id defaults to the number', () => {
  const m = poseToFreeD({ pan: 0, tilt: 0, zoom: 1 }, { enabled: true }, 4);
  assert.deepEqual(m.unread, ['focus']);
  assert.equal(m.sample.focus, 0);
  assert.equal(m.sample.zoom, 4095);
  assert.equal(m.sample.cameraId, 4);
  assert.equal(freeDCameraId(undefined, 300), 255);
});

test('pose → sample: no pose means no angles — the encoder refuses, nothing is sent', () => {
  const m = poseToFreeD(null, { enabled: true }, 1);
  const r = encodeFreeD(m.sample);
  assert.equal(r.ok, false);
});

test('elevation column adds its height to Z; a stated column without a reading is an unknown Z', () => {
  const cfg = { enabled: true, positionMm: { x: 0, y: 0, z: 500 }, columnMmPerCount: 0.1 };
  assert.equal(poseToFreeD({ pan: 0, tilt: 0, column: 12000 }, cfg, 1).sample.zMm, 1700);
  assert.equal(poseToFreeD({ pan: 0, tilt: 0 }, cfg, 1).sample.zMm, null);
  assert.equal(poseToFreeD({ pan: 0, tilt: 0, column: 12000 }, { enabled: true }, 1).sample.zMm, 0, 'no scale → column ignored');
});

test('a measured zoom table maps through LensCalibration; outside it the axis is unknown', () => {
  const zoomTable = {
    axis: 'zoom', rawUnit: 'position-0..1', valueUnit: 'mm',
    points: [{ raw: 0.1, value: 4.4 }, { raw: 0.5, value: 20 }, { raw: 0.9, value: 88 }],
  };
  const cfg = { enabled: true, zoomTable };
  assert.equal(poseToFreeD({ pan: 0, tilt: 0, zoom: 0.1 }, cfg, 1).sample.zoom, 0);
  assert.equal(poseToFreeD({ pan: 0, tilt: 0, zoom: 0.9 }, cfg, 1).sample.zoom, 4095);
  assert.equal(poseToFreeD({ pan: 0, tilt: 0, zoom: 0.95 }, cfg, 1).sample.zoom, null);
});

test('site settings are cleaned: bad targets dropped, duplicates merged, rate kept sane', () => {
  const s = normaliseFreeDSite({
    targets: [{ host: '10.0.0.5', port: 40000 }, { host: '10.0.0.5', port: 40000 }, { host: '', port: 1 }, { host: 'x', port: 70000 }, { host: '10.0.0.6', port: 6301 }],
    rateHz: -3, pollMs: 40,
  });
  assert.deepEqual(s, { targets: [{ host: '10.0.0.5', port: 40000 }, { host: '10.0.0.6', port: 6301 }], rateHz: 50, pollMs: 40 });
  assert.equal(normaliseFreeDSite('nope'), null);
  assert.equal(FREED_SUGGESTED_PORT, 40000);
});

test('site file keeps the FreeD settings and the per-camera switch', () => {
  const site = emptySite('Studio');
  site.cameras.push({ cameraNumber: 2, config: { connectionMode: 'visca', camHost: '10.0.0.9', freed: { enabled: true, cameraId: 12 } } });
  site.freed = { targets: [{ host: '127.0.0.1', port: 40000 }], rateHz: 59.94 };
  const back = parseSite(serialiseSite(site));
  assert.deepEqual(back.freed, site.freed);
  assert.deepEqual(back.cameras[0].config.freed, { enabled: true, cameraId: 12 });
});

test('VISCA focus answer → 0..1 of the 16-bit counter', () => {
  assert.equal(parseViscaFocus([0x90, 0x50, 0x0f, 0x0f, 0x0f, 0x0f, 0xff]), 1);
  assert.equal(parseViscaFocus([0x90, 0x50, 0x08, 0x00, 0x00, 0x00, 0xff]), 0.5);
  assert.equal(parseViscaFocus([0x90, 0x41, 0xff]), null);
});

// ── Interpolation ────────────────────────────────────────────────────────────

test('interpolation runs one read interval behind and never overshoots', () => {
  const ip = new PoseInterpolator(1000);
  assert.equal(ip.at(0), null);
  ip.push(0, { pan: 0, tilt: 0, zoom: 0 });
  assert.deepEqual(ip.at(10), { pan: 0, tilt: 0, zoom: 0 });
  ip.push(100, { pan: 10, tilt: -10, zoom: 1 });
  assert.deepEqual(ip.at(100), { pan: 0, tilt: 0, zoom: 0 });
  assert.deepEqual(ip.at(150), { pan: 5, tilt: -5, zoom: 0.5 });
  assert.deepEqual(ip.at(200), { pan: 10, tilt: -10, zoom: 1 });
  assert.deepEqual(ip.at(400), { pan: 10, tilt: -10, zoom: 1 }, 'held, not extrapolated');
});

test('interpolation does not swing through the back on a ±180 wrap, and goes silent when stale', () => {
  const ip = new PoseInterpolator(500);
  ip.push(0, { pan: 179, tilt: 0 });
  ip.push(100, { pan: -179, tilt: 0 });
  assert.equal(ip.at(150)!.pan, -179);
  assert.equal(ip.at(601), null);
});

// ── Wire ─────────────────────────────────────────────────────────────────────

async function receiver(): Promise<{ port: number; got: ReceivedPacket[]; close: () => void }> {
  const got: ReceivedPacket[] = [];
  return new Promise((resolve) => {
    const r = createFreeDReceiver(0, (p) => got.push(p), (port) => resolve({ port, got, close: r.close }));
  });
}

test('one sender, two targets: both receive the same packet', async () => {
  const a = await receiver();
  const b = await receiver();
  const sender = createFreeDSender({
    targets: [{ host: '127.0.0.1', port: a.port }, { host: '127.0.0.1', port: b.port }],
    rateHz: 100,
  });
  sender.update({ cameraId: 1, panDeg: 1, tiltDeg: 2, rollDeg: 0, xMm: 0, yMm: 0, zMm: 0, zoom: 10, focus: 20 });
  assert.deepEqual(sender.sendNow(), { ok: true });
  await sleep(100);
  a.close(); b.close();
  assert.equal(a.got.length, 1);
  assert.equal(b.got.length, 1);
  assert.deepEqual(a.got[0].bytes, b.got[0].bytes);
  assert.equal(a.got[0].sample?.panDeg, 1);
});

test('receiver flags a corrupted packet instead of decoding it', async () => {
  const r = await receiver();
  const pkt = encodeFreeD({ cameraId: 1, panDeg: 0, tiltDeg: 0, rollDeg: 0, xMm: 0, yMm: 0, zMm: 0, zoom: 0, focus: 0 });
  assert.ok(pkt.ok);
  pkt.packet[5] ^= 0x01;
  const sender = createFreeDSender({ host: '127.0.0.1', port: r.port, rateHz: 10 });
  // Raw bytes via a tiny socket: the sender itself would never produce this.
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  await new Promise<void>((res) => s.send(pkt.packet, r.port, '127.0.0.1', () => res()));
  s.close();
  sender.stop();
  await sleep(50);
  r.close();
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0].sample, null);
  assert.equal(decodeFreeD(pkt.packet), null);
});

class FakeHead extends EventEmitter {
  pose = { pan: 0, tilt: 0, zoom: 0.25 };
  reads = 0;
  fail = false;
  async readPose(): Promise<{ pan: number; tilt: number; zoom: number }> {
    this.reads += 1;
    if (this.fail) throw new Error('no answer');
    return { ...this.pose };
  }
}

test('FreeDOutput: an enabled camera streams decoded poses to every target; disabling stops it', async () => {
  const a = await receiver();
  const b = await receiver();
  const out = new FreeDOutput();
  out.configure({ targets: [{ host: '127.0.0.1', port: a.port }, { host: '127.0.0.1', port: b.port }], rateHz: 50, pollMs: 20 });
  const head = new FakeHead();
  head.pose = { pan: 12.5, tilt: -3, zoom: 0.25 };
  const cams = (enabled: boolean) => [
    { cameraNumber: 2, connected: true, backend: head, freed: { enabled, cameraId: 9, positionMm: { x: 10, y: 20, z: 30 } } },
    { cameraNumber: 3, connected: true, backend: new FakeHead(), freed: { enabled: false } },
  ];
  out.sync(cams(true));
  await sleep(250);
  const st = out.status();
  assert.equal(st.active, true);
  assert.equal(st.cameras.length, 1);
  assert.deepEqual(st.cameras[0].unread, ['focus']);
  assert.ok(st.cameras[0].sent >= 5, `sent ${st.cameras[0].sent}`);
  assert.ok(head.reads >= 3);

  const last = a.got.at(-1)!.sample!;
  assert.equal(last.cameraId, 9);
  assert.equal(last.panDeg, 12.5);
  assert.equal(last.tiltDeg, -3);
  assert.deepEqual([last.xMm, last.yMm, last.zMm], [10, 20, 30]);
  assert.equal(last.zoom, Math.round(0.25 * 4095));
  assert.ok(b.got.length > 0, 'second target receives too');
  assert.ok(a.got.every((p) => p.sample !== null), 'every packet decodes');
  assert.match(formatSample(last), /cam 9 {2}pan 12\.50°/);

  out.sync(cams(false));
  assert.equal(out.status().active, false);
  const n = a.got.length;
  await sleep(100);
  assert.equal(a.got.length, n, 'nothing after disabling');
  out.stop();
  a.close(); b.close();
});

test('FreeDOutput: a head that stops answering goes silent instead of freezing', async () => {
  const r = await receiver();
  const out = new FreeDOutput();
  out.configure({ targets: [{ host: '127.0.0.1', port: r.port }], rateHz: 100, pollMs: 10 });
  const head = new FakeHead();
  out.sync([{ cameraNumber: 1, connected: true, backend: head, freed: { enabled: true } }]);
  await sleep(100);
  assert.ok(r.got.length > 0);
  head.fail = true;
  // Stale after max(1000, 5 × poll) ms.
  await sleep(1150);
  const n = r.got.length;
  await sleep(150);
  assert.equal(r.got.length, n, 'silent once the last read is stale');
  assert.equal(out.status().cameras[0].lastError, 'no answer');
  out.stop();
  r.close();
});

test('FreeDOutput: no targets, disconnected or no readPose → no stream', () => {
  const out = new FreeDOutput();
  out.sync([{ cameraNumber: 1, connected: true, backend: new FakeHead(), freed: { enabled: true } }]);
  assert.equal(out.status().active, false, 'no site settings');
  out.configure({ targets: [], rateHz: 50 });
  assert.equal(out.status().active, false, 'no targets');
  out.configure({ targets: [{ host: '127.0.0.1', port: 9 }], rateHz: 50 });
  out.sync([
    { cameraNumber: 1, connected: false, backend: new FakeHead(), freed: { enabled: true } },
    { cameraNumber: 2, connected: true, backend: {}, freed: { enabled: true } },
  ]);
  assert.equal(out.status().active, false);
  out.stop();
});

test('the pose-read table agrees with the backends', () => {
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
    assert.equal(POSE_READ_MODES.includes(mode), typeof backend.readPose === 'function', `${mode}: table and backend disagree`);
  }
});

// ── Through the bridge ───────────────────────────────────────────────────────

test('bridge: site settings + camera toggle stream the demo head over UDP; status is announced', async () => {
  const r = await receiver();
  const port = 19861;
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 });
  bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((res) => ws.once('open', res));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const f = [...inbox].reverse().find(pred);
      if (f) return f;
      await sleep(10);
    }
    throw new Error('no message matched');
  };
  try {
    send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo' } });
    send({ type: 'connectCamera', cameraNumber: 1 });
    await waitFor((m) => m.type === 'cameraConnected');
    const cams = await waitFor((m) => m.type === 'cameras' && Boolean((m.cameras as { connected: boolean }[])[0]?.connected)) as { cameras: { freedCapable: boolean }[] };
    assert.equal(cams.cameras[0].freedCapable, true);
    send({ type: 'command', cameraNumber: 1, cmd: 'ptzAbsolute', params: { pan: 30, tilt: -10, zoom: 1 } });
    send({ type: 'setFreeD', freed: { targets: [{ host: '127.0.0.1', port: r.port }], rateHz: 50, pollMs: 20 } });
    send({ type: 'setCameraFreeD', cameraNumber: 1, freed: { enabled: true, cameraId: 5, positionMm: { x: 0, y: 0, z: 1200 } } });
    const st = await waitFor((m) => m.type === 'freed' && Boolean((m.status as { active: boolean }).active)) as { config: { rateHz: number } };
    assert.equal(st.config.rateHz, 50);
    await sleep(300);
    const last = r.got.at(-1)?.sample;
    assert.ok(last, 'packets arrived');
    assert.equal(last.cameraId, 5);
    assert.equal(last.panDeg, 30);
    assert.equal(last.tiltDeg, -10);
    assert.equal(last.zMm, 1200);
    assert.equal(last.zoom, 4095);
    const site = bridge.currentSite();
    assert.deepEqual(site.freed?.targets, [{ host: '127.0.0.1', port: r.port }]);
    assert.equal(site.cameras[0].config.freed?.enabled, true);

    send({ type: 'disconnectCamera', cameraNumber: 1 });
    await waitFor((m) => m.type === 'freed' && !(m.status as { active: boolean }).active);
  } finally {
    ws.close();
    bridge.stop();
    r.close();
  }
});
