/**
 * Studio shots: the pure parts (normalising, the on-air lock, which camera a
 * seat takes), then end to end over the
 * real WebSocket with two demo heads behind a fake switcher — camera 1 on
 * programme, camera 2 free.
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
import {
  heldByOnAir, moveDurationMs, normaliseStudioShots, pickSeatShot,
} from '../src/motion/studioShots.js';
import { parseSite } from '../src/site/siteFile.js';

test('normalise: broken entries are dropped, times clamped, seats stay inside the chart', () => {
  const s = normaliseStudioShots({
    defaultMode: 'cut', defaultTimeMs: 5,
    sets: [
      { id: 'a', name: 'Wide', shots: [{ cameraNumber: 1, preset: 2 }, { cameraNumber: 0, preset: 1 }, { cameraNumber: 2, preset: 3, source: 'plan' }], timeMs: 999999 },
      { id: 'a', shots: 'nope' },
      null,
    ],
    seats: { rows: 2, cols: 3, seats: [
      { id: 's1', row: 0, col: 0, shots: [{ cameraNumber: 1, preset: 4 }] },
      { id: 's2', row: 0, col: 0, shots: [] },
      { id: 's3', row: 5, col: 0, shots: [] },
    ] },
    moves: [{ id: 'm', name: 'Push', cameraNumber: 2, steps: [{ preset: 1, timeMs: 2000 }, { preset: 2, holdMs: 500, source: 'plan' }, { preset: -1 }] }, { cameraNumber: 'x' }],
  });
  assert.equal(s.defaultMode, 'cut');
  assert.equal(s.defaultTimeMs, 300);
  assert.deepEqual(s.sets[0], { id: 'a', name: 'Wide', shots: [{ cameraNumber: 1, preset: 2 }, { cameraNumber: 2, preset: 3, source: 'plan' }], timeMs: 60000 });
  assert.equal(s.sets[1].id, 'a_');
  assert.deepEqual(s.sets[1].shots, []);
  assert.equal(s.sets.length, 2);
  assert.deepEqual(s.seats.seats.map((x) => x.id), ['s1']);
  assert.deepEqual(s.moves, [{ id: 'm', name: 'Push', cameraNumber: 2, steps: [{ preset: 1, timeMs: 2000 }, { preset: 2, source: 'plan', holdMs: 500 }] }]);
  assert.equal(moveDurationMs(s.moves[0], 1000), 2000 + 1000 + 500);
  assert.deepEqual(normaliseStudioShots(undefined).sets, []);
});

test('on-air lock: on by default, off only on an explicit false, force overrides', () => {
  assert.equal(heldByOnAir(true, {}), true);
  assert.equal(heldByOnAir(true, undefined), true);
  assert.equal(heldByOnAir(true, { tallyProtect: false }), false);
  assert.equal(heldByOnAir(true, {}, true), false);
  assert.equal(heldByOnAir(false, {}), false);
});

test('seat: first free candidate wins; all on air → held on the first connected one', () => {
  const seat = { shots: [{ cameraNumber: 1, preset: 1 }, { cameraNumber: 2, preset: 5 }, { cameraNumber: 3, preset: 9 }] };
  const facts = (onAir: number[], offline: number[] = [], unlocked: number[] = []) =>
    [1, 2, 3].map((n) => ({ cameraNumber: n, connected: !offline.includes(n), onAir: onAir.includes(n), ...(unlocked.includes(n) ? { tallyProtect: false } : {}) }));
  assert.deepEqual(pickSeatShot(seat, facts([])), { shot: seat.shots[0], held: false });
  assert.deepEqual(pickSeatShot(seat, facts([1])), { shot: seat.shots[1], held: false });
  assert.deepEqual(pickSeatShot(seat, facts([1], [2])), { shot: seat.shots[2], held: false });
  assert.deepEqual(pickSeatShot(seat, facts([1, 2, 3])), { shot: seat.shots[0], held: true });
  assert.deepEqual(pickSeatShot(seat, facts([1, 2, 3], [1])), { shot: seat.shots[1], held: true });
  assert.deepEqual(pickSeatShot(seat, facts([1, 2, 3], [], [3])), { shot: seat.shots[2], held: false });
  assert.equal(pickSeatShot(seat, facts([], [1, 2, 3])), null);
});

// ── End to end ────────────────────────────────────────────────────────────────

function fakeSwitcher() {
  // Programme = window 1 = input 3.
  const state = { out1: 3, out2: 1, out3: 2, out4: 4, mode: 0, audio: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = /^param=(.*)$/.exec(raw)?.[1] ?? '';
      res.writeHead(200);
      res.end(p === 'status' ? JSON.stringify(state) : p === 'version' ? '{"version":"T"}' : '{}');
    });
  });
  return server;
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
  async waitFor<T = Record<string, unknown>>(pred: (m: Record<string, unknown>) => boolean, ms = 4000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = [...this.inbox].reverse().find(pred);
      if (found) return found as T;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no message matched within ${ms} ms; last: ${JSON.stringify(this.inbox.at(-1))}`);
  }
  async pose(num: number): Promise<{ pan: number; tilt: number; zoom: number }> {
    this.inbox = this.inbox.filter((m) => m.type !== 'pose');
    this.send({ type: 'readPose', cameraNumber: num });
    return (await this.waitFor<{ pose: { pan: number; tilt: number; zoom: number } }>((m) => m.type === 'pose' && m.cameraNumber === num)).pose;
  }
  close(): void { this.ws.close(); }
}

const PLAN = {
  kind: 'camera-list', formatVersion: 3, app: 'multicam', appVersion: '1', exportedAt: '',
  cameras: ['c1', 'c2'].map((id) => ({
    id, label: id.toUpperCase(), pan: 0, tilt: 0, lens: { focalMinMm: 10, focalMaxMm: 110 },
    presets: [
      { number: 1, name: 'Lectern', pan: 20, tilt: -5, focalMm: 60 },
      { number: 2, name: 'Wide', pan: -10, tilt: 0, focalMm: 10 },
    ],
  })),
};

test('sets, on-air lock with "move anyway", seats, moves and the site round trip', async () => {
  const sw = fakeSwitcher();
  const swPort = await new Promise<number>((r) => sw.listen(0, '127.0.0.1', () => r((sw.address() as AddressInfo).port)));
  const port = 19611;
  const dir = mkdtempSync(join(tmpdir(), 'lz-studio-'));
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 }, { persist: true, configDir: dir });
  bridge.start();
  const c = new Client(port);
  await c.open();
  try {
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo', switcherInput: 3 } });
    c.send({ type: 'setCameraConfig', cameraNumber: 2, config: { connectionMode: 'demo', switcherInput: 1 } });
    c.send({ type: 'connectCamera', cameraNumber: 1 });
    c.send({ type: 'connectCamera', cameraNumber: 2 });
    c.send({ type: 'setSwitcherConfig', switcherNumber: 1, switcherConfig: { host: '127.0.0.1', port: swPort, path: 'http' } });
    c.send({ type: 'connectSwitcher', switcherNumber: 1 });
    await c.waitFor((m) => m.type === 'cameraTally' && (m.tally as Record<string, string>)['1'] === 'program');
    c.send({ type: 'assignPlanCamera', cameraNumber: 1, plan: PLAN, planCameraId: 'c1' });
    c.send({ type: 'assignPlanCamera', cameraNumber: 2, plan: PLAN, planCameraId: 'c2' });
    await c.waitFor((m) => m.type === 'cameras' && (m.cameras as { plan?: unknown }[]).filter((x) => x.plan).length === 2);

    c.send({ type: 'setStudioShots', shots: {
      defaultMode: 'fade', defaultTimeMs: 300,
      sets: [{ id: 'both', name: 'Lectern', shots: [{ cameraNumber: 1, preset: 1, source: 'plan' }, { cameraNumber: 2, preset: 1, source: 'plan' }] }],
      seats: { rows: 1, cols: 2, seats: [{ id: 'A1', label: 'Guest', row: 0, col: 0, shots: [{ cameraNumber: 1, preset: 2, source: 'plan' }, { cameraNumber: 2, preset: 2, source: 'plan' }] }] },
      moves: [{ id: 'push', name: 'Push in', cameraNumber: 2, steps: [{ preset: 2, source: 'plan', timeMs: 200 }, { preset: 1, source: 'plan', timeMs: 200, holdMs: 50 }] }],
    } });
    await c.waitFor((m) => m.type === 'studioShots' && ((m.shots as { sets: unknown[] }).sets.length === 1));

    // The set: camera 2 fades, camera 1 (on air) is held with a retry for camera 1 only.
    c.inbox = [];
    c.send({ type: 'recallShotSet', id: 'both' });
    const held = await c.waitFor<{ cameras: number[]; retry: Record<string, unknown> }>((m) => m.type === 'shotHeld');
    assert.deepEqual(held.cameras, [1]);
    assert.deepEqual(held.retry, { type: 'recallShotSet', id: 'both', cameras: [1], force: true });
    const moved = await c.waitFor<{ mode: string; timeMs: number }>((m) => m.type === 'shotRecalled' && m.cameraNumber === 2);
    assert.equal(moved.mode, 'fade');
    assert.equal(moved.timeMs, 300);
    // Mid-move the head is on its way, not there yet; after the move time it has landed.
    await new Promise((r) => setTimeout(r, 120));
    const mid = await c.pose(2);
    assert.ok(mid.pan > 0 && mid.pan < 20, `mid pan ${mid.pan}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await c.pose(2), { pan: 20, tilt: -5, zoom: 0.5 });
    assert.deepEqual(await c.pose(1), { pan: 0, tilt: 0, zoom: 0 });
    // "Move anyway".
    c.send(held.retry);
    await c.waitFor((m) => m.type === 'shotRecalled' && m.cameraNumber === 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await c.pose(1)).pan, 20);

    // A plain preset recall on the on-air camera is held too; with the lock off it goes through.
    c.inbox = [];
    c.send({ type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } });
    const heldPreset = await c.waitFor<{ retry: Record<string, unknown> }>((m) => m.type === 'shotHeld');
    assert.deepEqual(heldPreset.retry, { type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 }, force: true });
    // ... and its retry ("move anyway") goes through instead of being held again.
    c.inbox = [];
    c.send(heldPreset.retry);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.inbox.some((m) => m.type === 'shotHeld'), false);

    // The seat: camera 1 is listed first but on air → camera 2 takes it.
    c.inbox = [];
    c.send({ type: 'recallSeat', id: 'A1' });
    const seat = await c.waitFor<{ cameraNumber: number }>((m) => m.type === 'seatRecalled');
    assert.equal(seat.cameraNumber, 2);

    // Lock off on camera 1: now the seat goes to camera 1, and nothing is held.
    c.send({ type: 'setCameraConfig', cameraNumber: 1, config: { tallyProtect: false } });
    c.inbox = [];
    c.send({ type: 'recallSeat', id: 'A1' });
    assert.equal((await c.waitFor<{ cameraNumber: number }>((m) => m.type === 'seatRecalled')).cameraNumber, 1);
    assert.equal(c.inbox.some((m) => m.type === 'shotHeld'), false);

    // The move: two eased steps on camera 2, ends on shot 1.
    c.inbox = [];
    c.send({ type: 'playMove', id: 'push' });
    await c.waitFor((m) => m.type === 'moveProgress' && m.state === 'done', 3000);
    const steps = c.inbox.filter((m) => m.type === 'moveProgress' && m.state === 'playing').map((m) => m.step);
    assert.deepEqual(steps, [1, 2]);
    assert.deepEqual(await c.pose(2), { pan: 20, tilt: -5, zoom: 0.5 });

    // A joystick touch stops a running move.
    c.inbox = [];
    c.send({ type: 'playMove', id: 'push' });
    await c.waitFor((m) => m.type === 'moveProgress' && m.state === 'playing');
    c.send({ type: 'stopMove', cameraNumber: 2 });
    await c.waitFor((m) => m.type === 'moveProgress' && m.state === 'stopped', 3000);

    // Single shots: cut lands at once; a head preset the bridge keeps as a
    // pose fades back to it (the preset glide).
    c.send({ type: 'recallShot', cameraNumber: 2, presetNumber: 2, source: 'plan', mode: 'cut' });
    await c.waitFor((m) => m.type === 'shotRecalled' && m.cameraNumber === 2 && m.mode === 'cut');
    assert.equal((await c.pose(2)).pan, -10);
    c.send({ type: 'command', cameraNumber: 2, cmd: 'storePreset', params: { value: 7 } });
    await c.waitFor((m) => m.type === 'cameras' && Boolean((m.cameras as { cameraNumber: number; config: { bridgePresets?: Record<string, unknown> } }[]).find((x) => x.cameraNumber === 2)?.config.bridgePresets?.['7']));
    c.send({ type: 'recallShot', cameraNumber: 2, presetNumber: 1, source: 'plan', mode: 'cut' });
    await c.waitFor((m) => m.type === 'shotRecalled' && m.cameraNumber === 2 && m.presetNumber === 1);
    c.inbox = [];
    c.send({ type: 'recallShot', cameraNumber: 2, presetNumber: 7, mode: 'fade', timeMs: 300 });
    const glide = await c.waitFor<{ mode: string; note?: string }>((m) => m.type === 'shotRecalled' && m.presetNumber === 7);
    assert.equal(glide.mode, 'fade');
    assert.equal(glide.note, undefined);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await c.pose(2)).pan, -10);

    // The site carries the shots, and a site file brings them back.
    c.send({ type: 'getSite' });
    const site = await c.waitFor<{ site: { shots?: { sets: { id: string }[] } } }>((m) => m.type === 'site' && Boolean((m.site as { shots?: unknown }).shots));
    assert.equal(site.site.shots?.sets[0].id, 'both');
    assert.equal(parseSite(JSON.stringify(site.site)).shots?.moves[0].steps.length, 2);
  } finally {
    c.close();
    bridge.stop();
    sw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
