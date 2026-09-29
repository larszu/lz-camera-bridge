/**
 * Planned shot → head pose: the room frame of the MultiCam Planner against
 * the head frame, the on-site offset, the zoom fit that says what it is,
 * and the wire encodings of the three heads that take an absolute position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shotToPose, calibrateOffset, zoomForFocal, wrapDeg,
  viscaAbsolutePanTilt, viscaZoomDirect, parseViscaPanTilt, parseViscaZoom, nibbles4, fromNibbles4,
  sonyCgiAbsolutePanTilt, sonyCgiAbsoluteZoom, parseSonyCgiPose,
  awAbsolutePanTilt, awAbsoluteZoom, parseAwPanTilt, parseAwZoom, AW_CENTER,
} from '../src/protocol/ptzPose.js';
import { parseCameraPlan } from '../src/plan/cameraPlan.js';

test('room frame → head frame: subtract the home heading, both clockwise', () => {
  // Head mounted looking "down" on the plan (heading 90); a shot at 120 is 30° right.
  const p = shotToPose({ number: 1, name: 'A', pan: 120, tilt: -5 }, 90);
  assert.deepEqual([p.pan, p.tilt, p.zoom, p.fit], [30, -5, undefined, 'none']);
  // Wrap: heading 170, shot at −170 → 20°, not −340.
  assert.equal(shotToPose({ number: 1, name: '', pan: -170, tilt: 0 }, 170).pan, 20);
  assert.equal(wrapDeg(180), 180);
  assert.equal(wrapDeg(-180), 180);
  assert.equal(wrapDeg(540), 180);
});

test('offset: the head reads 3° right of the plan, every shot moves 3°', () => {
  const shot = { number: 2, name: '', pan: 45, tilt: -10 };
  const off = calibrateOffset(shot, 0, { pan: 48, tilt: -9.5 });
  assert.deepEqual(off, { pan: 3, tilt: 0.5 });
  assert.deepEqual([shotToPose(shot, 0, off).pan, shotToPose(shot, 0, off).tilt], [48, -9.5]);
  const other = shotToPose({ number: 3, name: '', pan: -20, tilt: 0 }, 0, off);
  assert.deepEqual([other.pan, other.tilt], [-17, 0.5]);
});

test('zoom fit names its source: table, linear between the ends, or none', () => {
  assert.deepEqual(zoomForFocal(10, { focalMinMm: 4.3, focalMaxMm: 129 }).fit, 'linear');
  assert.equal(zoomForFocal(4.3, { focalMinMm: 4.3, focalMaxMm: 129 }).zoom, 0);
  assert.equal(zoomForFocal(129, { focalMinMm: 4.3, focalMaxMm: 129 }).zoom, 1);
  const table = [{ position: 0, focalMm: 4.3 }, { position: 0.5, focalMm: 20 }, { position: 1, focalMm: 129 }];
  const z = zoomForFocal(12.15, { zoomTable: table });
  assert.equal(z.fit, 'table');
  assert.equal(Math.round(z.zoom * 100) / 100, 0.25);
  assert.equal(zoomForFocal(200, { zoomTable: table }).zoom, 1);
  assert.equal(zoomForFocal(10).fit, 'none');
  assert.equal(shotToPose({ number: 1, name: '', pan: 0, tilt: 0, focalMm: 20 }, 0, undefined, { zoomTable: table }).zoom, 0.5);
});

test('VISCA: absolute drive nibbles and the position reply, 14.4 units per degree', () => {
  assert.deepEqual(nibbles4(0x0990), [0, 9, 9, 0]);
  assert.equal(fromNibbles4([0xf, 0xf, 0xf, 0xf]), -1);
  const drive = viscaAbsolutePanTilt(170, -10);
  assert.deepEqual(drive.slice(0, 6), [0x81, 0x01, 0x06, 0x02, 0x18, 0x14]);
  assert.deepEqual(drive.slice(6, 10), [0, 9, 9, 0], '170° = 0x0990');
  assert.equal(fromNibbles4(drive, 10), -144, '−10° = −144 units');
  assert.equal(drive[14], 0xff);
  const zoom = viscaZoomDirect(0.5);
  assert.deepEqual(zoom, [0x81, 0x01, 0x04, 0x47, 0x02, 0x00, 0x00, 0x00, 0xff]);
  // Reply with an ACK in front of it, as heads send it.
  const reply = [0x90, 0x41, 0xff, 0x90, 0x50, 0, 9, 9, 0, 0xf, 0xf, 0x7, 0x0, 0xff];
  assert.deepEqual(parseViscaPanTilt(reply), { pan: 170, tilt: -10 });
  assert.equal(parseViscaZoom([0x90, 0x50, 0x04, 0x00, 0x00, 0x00, 0xff]), 1);
  assert.equal(parseViscaPanTilt([0x90, 0x41, 0xff]), null);
});

test('Sony CGI: AbsolutePanTilt/AbsoluteZoom and the inquiry answer', () => {
  assert.equal(sonyCgiAbsolutePanTilt(170, -10), '/command/ptzf.cgi?AbsolutePanTilt=0990,FF70,24');
  assert.equal(sonyCgiAbsoluteZoom(1), '/command/ptzf.cgi?AbsoluteZoom=4000');
  assert.deepEqual(parseSonyCgiPose('PanTiltMove=stop&AbsolutePTZF=0990,FF70,2000,1234&FocusMode=auto'), { pan: 170, tilt: -10, zoom: 0.5 });
  assert.equal(parseSonyCgiPose('Power=on'), null);
});

test('Panasonic AW: #APC around 0x8000 and #AXZ between 0x555 and 0xFFF', () => {
  assert.equal(awAbsolutePanTilt(0, 0), `APC7FFF${AW_CENTER.toString(16).toUpperCase()}`, 'pan 0 is the midpoint of the documented ends');
  assert.equal(awAbsolutePanTilt(175, -30), 'APCD2F571C7');
  assert.equal(awAbsolutePanTilt(-175, 0), 'APC2D088000');
  assert.equal(awAbsoluteZoom(0), 'AXZ555');
  assert.equal(awAbsoluteZoom(1), 'AXZFFF');
  assert.deepEqual(parseAwPanTilt('aPCD2F571C7'), { pan: 175, tilt: -30 });
  assert.equal(parseAwZoom('gz555'), 0);
  assert.equal(parseAwZoom('axzFFF'), 1);
});

test('camera-list v3: heading, lens and shots come through; v4 is refused by name', () => {
  const plan = parseCameraPlan(JSON.stringify({
    kind: 'camera-list', formatVersion: 3, app: 'multicam', appVersion: '1', exportedAt: '',
    cameras: [{
      id: 'c1', label: 'CAM 1', x: 1, y: 2, z: 1.5, pan: 90, tilt: -5, focalMm: 10,
      lens: { focalMinMm: 4.3, focalMaxMm: 129, model: 'Zoom' },
      presets: [
        { number: 2, name: 'Wide', pan: 100, tilt: -10, focalMm: 4.3, focusM: 5, savedAt: 'x' },
        { number: 1, name: 'Lectern', pan: 80, tilt: -8, focalMm: 40, focusM: 8, savedAt: 'x' },
        { number: 'x', pan: 0, tilt: 0 },
      ],
    }],
  }));
  assert.ok(plan);
  const cam = plan!.cameras[0];
  assert.deepEqual([cam.pan, cam.tilt, cam.z, cam.lens?.focalMaxMm], [90, -5, 1.5, 129]);
  assert.deepEqual(cam.presets?.map((p) => p.number), [1, 2], 'sorted by number, junk dropped');
  assert.equal(plan!.formatVersion, 3);
  assert.equal(parseCameraPlan('{"kind":"camera-list","formatVersion":4,"cameras":[]}'), null);
  assert.equal(parseCameraPlan('{"kind":"camera-list","formatVersion":2,"cameras":[]}')?.formatVersion, 2);
});
