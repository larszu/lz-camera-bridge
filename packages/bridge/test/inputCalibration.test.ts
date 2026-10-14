/**
 * Joystick calibration and move time on the panel (#133).
 *
 * Measured on hand-built HID reports, not on a real stick: the native
 * `node-hid` module is optional, and no joystick is attached here. What is
 * proven is the arithmetic and the wiring; the feel on a real stick is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import {
  CalibrationSession,
  applyCurve,
  deviceKey,
  normaliseInputCalibration,
  shapeAxis,
  tuneAxis,
  type AxisCalibration,
} from '../src/input/axisCalibration.ts';
import {
  DUALSENSE_BINDINGS,
  HidControlSurface,
  PID_DUALSENSE,
  VENDOR_SONY,
  achsenWert,
  berechneBefehle,
  kalibrierAchsen,
  ruheBefehle,
  type EmittedCommand,
  type HidBinding,
  type HidSurfaceConfig,
  type ReportZustand,
} from '../src/input/HidControlSurface.ts';
import { moveTimeFromFader, panelMoveTime, stepMoveTime } from '../src/input/panelMoveTime.ts';
import { parseSite, serialiseSite, emptySite } from '../src/site/siteFile.ts';
import { BridgeServer } from '../src/BridgeServer.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function report(vals: Record<number, number>, len = 16): Buffer {
  const b = Buffer.alloc(len);
  b[0] = 0x01;
  b[1] = 128; b[2] = 128; b[3] = 128; b[4] = 128;
  for (const [k, v] of Object.entries(vals)) b[Number(k)] = v;
  return b;
}

const stick: AxisCalibration = { min: 20, max: 230, centre: 131, deadzone: 4, curve: 'linear', expo: 0.4, invert: false };

// ─── Curve and shaping ──────────────────────────────────────────────────────

test('expo keeps the ends and the sign, and is flatter around the centre', () => {
  assert.equal(applyCurve(1, 'expo', 0.6), 1);
  assert.equal(applyCurve(-1, 'expo', 0.6), -1);
  assert.equal(applyCurve(0.5, 'linear', 0.6), 0.5);
  const e = applyCurve(0.5, 'expo', 0.6);
  assert.ok(e > 0 && e < 0.5, `expo 0.5 → ${e}`);
  assert.equal(applyCurve(0.5, 'expo', 0), 0.5, 'amount 0 is linear');
  assert.equal(applyCurve(-0.5, 'expo', 0.6), -e);
});

test('a measured stick: off-centre rest gives 0, the measured ends give full speed', () => {
  assert.equal(shapeAxis(stick, 131, 100), 0);
  assert.equal(shapeAxis(stick, 134, 100), 0, 'inside the dead zone');
  assert.equal(shapeAxis(stick, 230, 100), 100, 'the measured end is full, though it is not 255');
  assert.equal(shapeAxis(stick, 20, 100), -100);
  assert.equal(shapeAxis(stick, 255, 100), 100, 'beyond the end stays full');
  assert.equal(shapeAxis({ ...stick, invert: true }, 230, 100), -100);
  assert.equal(shapeAxis(stick, 230, 100, -1), -100, 'the binding gain still applies');
  const lin = shapeAxis(stick, 180, 100);
  const expo = shapeAxis({ ...stick, curve: 'expo', expo: 0.7 }, 180, 100);
  assert.ok(expo < lin && expo > 0, `expo ${expo} below linear ${lin}`);
});

test('a reversed trigger (rests high) gives 0 at rest and full when pulled', () => {
  const trig: AxisCalibration = { min: 240, max: 10, deadzone: 4, curve: 'linear', expo: 0, invert: false };
  assert.equal(shapeAxis(trig, 240, 100), 0);
  assert.equal(shapeAxis(trig, 243, 100), 0);
  assert.equal(shapeAxis(trig, 10, 100), 100);
  assert.ok(shapeAxis(trig, 125, 100) > 40);
});

test('the calibration replaces the binding guesses in the report path', () => {
  const b = DUALSENSE_BINDINGS[0]!; // pan, offset 1, centre 128, deadband 6
  assert.notEqual(achsenWert(b, 136), 0, 'factory guess: 136 drives');
  const cal = { axes: { '1': { ...stick, centre: 136 } } };
  assert.equal(achsenWert(b, 136, cal), 0, 'measured: 136 is the rest');
  const z: ReportZustand = new Map();
  const cmds = berechneBefehle(DUALSENSE_BINDINGS, report({ 1: 136, 2: 128 }), z, cal);
  assert.deepEqual(cmds.find((c) => c.cmd === 'ptz')?.params, { pan: 0, tilt: 0 });
});

// ─── Capture ────────────────────────────────────────────────────────────────

test('the assistant derives ends, centre and a dead zone from the noise at rest', () => {
  const s = new CalibrationSession(kalibrierAchsen(DUALSENSE_BINDINGS));
  for (const [lx, ly, l2] of [[128, 128, 0], [15, 128, 0], [240, 20, 0], [128, 236, 250], [128, 128, 3]]) {
    s.sample(report({ 1: lx!, 2: ly!, 5: l2!, 6: 2 }));
  }
  s.beginRest();
  for (const n of [130, 132, 131, 133, 131]) s.sample(report({ 1: n, 2: 127, 5: 3, 6: 2 }));
  const { calibration, skipped } = s.finish();
  const pan = calibration.axes['1']!;
  assert.equal(pan.min, 15);
  assert.equal(pan.max, 240);
  assert.equal(pan.centre, 131);
  assert.ok(pan.deadzone >= 4, `dead zone ${pan.deadzone} covers ±2 of noise`);
  assert.equal(calibration.axes['2']!.centre, 127);
  const l2 = calibration.axes['5']!;
  assert.equal(l2.centre, undefined, 'a trigger stays one-sided');
  assert.equal(l2.min, 3, 'rest end');
  assert.equal(l2.max, 250);
  // R2 (offset 6) and the right stick (offset 4) were never moved.
  assert.ok(skipped.some((l) => l.includes('byte 6')));
  assert.ok(skipped.some((l) => l.includes('byte 4')));
  assert.equal(calibration.axes['6'], undefined);
});

test('an axis not moved this time keeps its previous calibration and tuning', () => {
  const prev = { axes: { '4': { ...stick, curve: 'expo' as const, expo: 0.8 }, '1': { ...stick, invert: true, curve: 'expo' as const } } };
  const s = new CalibrationSession(kalibrierAchsen(DUALSENSE_BINDINGS), prev);
  s.sample(report({ 1: 10 }));
  s.sample(report({ 1: 250 }));
  s.beginRest();
  s.sample(report({ 1: 129 }));
  const { calibration } = s.finish();
  assert.deepEqual(calibration.axes['4'], prev.axes['4']);
  assert.equal(calibration.axes['1']!.invert, true, 'tuning survives a recalibration');
  assert.equal(calibration.axes['1']!.curve, 'expo');
  assert.equal(calibration.axes['1']!.centre, 129);
});

test('a stick held off-centre at "let go" is refused, not stored', () => {
  const s = new CalibrationSession(kalibrierAchsen(DUALSENSE_BINDINGS));
  s.sample(report({ 1: 0 }));
  s.sample(report({ 1: 255 }));
  s.beginRest();
  s.sample(report({ 1: 250 }));
  assert.equal(s.finish().calibration.axes['1'], undefined);
});

// ─── Stored form ────────────────────────────────────────────────────────────

test('calibration goes through the site file and broken entries are dropped', () => {
  assert.equal(deviceKey(VENDOR_SONY, PID_DUALSENSE), '054c:0ce6');
  const site = { ...emptySite('Room'), input: { devices: { '054c:0ce6': { axes: { '1': stick } } } } };
  const back = parseSite(serialiseSite(site));
  assert.deepEqual(back.input, site.input);
  const n = normaliseInputCalibration({
    devices: {
      '054c:0ce6': { axes: { '1': stick, '2': { min: 0, max: 255, centre: 300 }, x: stick } },
      bogus: { axes: { '1': stick } },
    },
  });
  assert.deepEqual(Object.keys(n!.devices), ['054c:0ce6']);
  assert.deepEqual(Object.keys(n!.devices['054c:0ce6']!.axes), ['1']);
  assert.equal(parseSite(serialiseSite(emptySite('x'))).input, undefined);
});

test('tuning changes the feel, never the measurement', () => {
  const t = tuneAxis(stick, { curve: 'expo', expo: 2, invert: true, deadzone: 7.4 });
  assert.equal(t.curve, 'expo');
  assert.equal(t.expo, 1);
  assert.equal(t.invert, true);
  assert.equal(t.deadzone, 7);
  assert.equal(t.min, stick.min);
  assert.equal(t.centre, stick.centre);
});

// ─── Surface behaviour ──────────────────────────────────────────────────────

class FakeHid extends HidControlSurface {
  override async start(): Promise<void> {
    this.emit('started', { fake: true });
  }
}

test('calibrating stops a moving head and then drives nothing', async () => {
  const hid = new FakeHid({ vendorId: VENDOR_SONY, productId: PID_DUALSENSE, bindings: [] });
  const out: EmittedCommand[] = [];
  hid.on('command', (c: EmittedCommand) => out.push(c));
  hid.onReport(report({ 1: 250 }));
  assert.notEqual((out.find((c) => c.cmd === 'ptz')!.params as { pan: number }).pan, 0);
  out.length = 0;

  hid.beginCalibration();
  assert.deepEqual(out, [{ cmd: 'ptz', params: { pan: 0, tilt: 0 } }], 'one stop for the stick group');
  out.length = 0;
  hid.onReport(report({ 1: 0, 2: 255 }), 1000);
  hid.onReport(report({ 1: 255, 2: 0 }), 1200);
  assert.deepEqual(out, [], 'sweeping the stick moves nothing');

  const p = hid.captureRest(20);
  hid.onReport(report({ 1: 131, 2: 126 }), 1300);
  const result = await p;
  assert.equal(result?.calibration.axes['1']?.centre, 131);
  assert.equal(hid.calibrating, false);
  hid.onReport(report({ 1: 131, 2: 126 }), 1400);
  assert.deepEqual(out.find((c) => c.cmd === 'ptz'), { cmd: 'ptz', params: { pan: 0, tilt: 0 } }, 'the measured rest is rest');
});

test('ruheBefehle stops only what is moving', () => {
  const z: ReportZustand = new Map();
  berechneBefehle(DUALSENSE_BINDINGS, report({ 4: 20 }), z); // focus moving, stick at rest
  const stops = ruheBefehle(DUALSENSE_BINDINGS, z);
  assert.deepEqual(stops, [{ cmd: 'setFocus', params: { value: 0 } }]);
});

// ─── Move time on the panel ─────────────────────────────────────────────────

test('a fader maps onto 0.3 s … 20 s, log scale; buttons step a ladder', () => {
  assert.equal(moveTimeFromFader(0), 300);
  assert.equal(moveTimeFromFader(255), 20000);
  const mid = moveTimeFromFader(128);
  assert.ok(mid > 2000 && mid < 3000, `half travel → ${mid} ms, short times get the travel`);
  assert.equal(stepMoveTime(3000, 1), 4000);
  assert.equal(stepMoveTime(3000, -1), 2000);
  assert.equal(stepMoveTime(2500, 1), 3000);
  assert.equal(stepMoveTime(300, -1), 300);
  assert.equal(stepMoveTime(60000, 1), 60000);
  assert.equal(panelMoveTime('setMoveTime', { value: 100, span: 100 }, 3000), 20000);
  assert.equal(panelMoveTime('stepMoveTime', { by: -1 }, 3000), 2000);
  assert.equal(panelMoveTime('setMoveTime', {}, 3000), null);
});

test('bridge: panel move time sets the default, panel presets use it, calibration lands in the site', async () => {
  const port = 19671;
  const dir = mkdtempSync(join(tmpdir(), 'lz-input-cal-'));
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 }, { persist: false, configDir: dir });
  bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Record<string, unknown>[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  try {
    send({ type: 'setCameraConfig', cameraNumber: 1, config: { connectionMode: 'demo', ease: { attackMs: 0, releaseMs: 0 } } });
    send({ type: 'connectCamera', cameraNumber: 1 });
    await wait(400);

    const bindings: HidBinding[] = [
      ...DUALSENSE_BINDINGS,
      { kind: 'axis', offset: 10, command: 'setMoveTime', paramKey: 'value', step: 4 },
    ];
    let hid: FakeHid | null = null;
    const internal = bridge as unknown as {
      enableControlSurface: (c: HidSurfaceConfig, make: (c: HidSurfaceConfig) => HidControlSurface) => Promise<void>;
      cameras: Map<number, { backend: { handleRcpCommand: (c: string, p: Record<string, unknown>) => Promise<boolean> } }>;
    };
    await internal.enableControlSurface({ vendorId: VENDOR_SONY, productId: PID_DUALSENSE, bindings }, (c) => (hid = new FakeHid(c)));
    const sent: [string, Record<string, unknown>][] = [];
    const backend = internal.cameras.get(1)!.backend;
    const orig = backend.handleRcpCommand.bind(backend);
    backend.handleRcpCommand = (c, p) => { sent.push([c, p]); return orig(c, p); };

    // Fader to the top → 20 s, never dispatched to the camera.
    hid!.onReport(report({ 10: 255 }));
    await wait(50);
    const shots = msgs.filter((m) => m.type === 'studioShots').at(-1) as { shots: { defaultTimeMs: number } };
    assert.equal(shots.shots.defaultTimeMs, 20000);
    assert.equal(sent.some(([c]) => c === 'setMoveTime'), false);
    assert.equal(bridge.currentSite().shots?.defaultTimeMs, 20000, 'kept in the site');

    // A preset button on this panel recalls with that time.
    hid!.onReport(report({ 10: 255, 8: 0x10 }));
    await wait(50);
    const recall = sent.find(([c]) => c === 'recallPreset');
    assert.equal(recall?.[1].timeMs, 20000);

    // Calibration over the socket.
    send({ type: 'startInputCalibration' });
    await wait(50);
    hid!.onReport(report({ 1: 5, 2: 250, 10: 255 }), 10_000);
    hid!.onReport(report({ 1: 250, 2: 5, 10: 255 }), 10_200);
    sent.length = 0;
    send({ type: 'captureInputRest' });
    await wait(100);
    hid!.onReport(report({ 1: 133, 2: 125, 10: 255 }), 10_300);
    await wait(1000);
    assert.equal(sent.some(([c, p]) => c === 'ptz' && p.pan !== 0), false, 'nothing drove during calibration');
    const cal = msgs.filter((m) => m.type === 'inputCalibration').at(-1) as { device: string; axes: { key: string; calibration?: AxisCalibration }[] };
    assert.equal(cal.device, '054c:0ce6');
    assert.equal(cal.axes.find((a) => a.key === '1')?.calibration?.centre, 133);
    assert.equal(bridge.currentSite().input?.devices['054c:0ce6']?.axes['1']?.centre, 133);

    send({ type: 'tuneInputAxis', axis: '1', tuning: { curve: 'expo', expo: 0.5 } });
    await wait(50);
    assert.equal(bridge.currentSite().input?.devices['054c:0ce6']?.axes['1']?.curve, 'expo');
  } finally {
    ws.close();
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
