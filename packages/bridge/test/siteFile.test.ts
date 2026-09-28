/**
 * The site file: our format round-trips, the predecessor's export migrates,
 * junk is refused with a sentence, and persistence writes atomically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseSite, serialiseSite, emptySite, SiteParseError } from '../src/site/siteFile.js';
import { SitePersistence, configDir } from '../src/site/persistence.js';

const CONTROL_CENTER_EXPORT = JSON.stringify({
  version: 1,
  installationName: 'Room A',
  switcherPath: 'serial',
  pgmWindow: 1,
  devices: [
    { id: 'cam-sony', kind: 'sony-ptz', name: 'Sony', host: '10.0.0.31', httpPort: 80, rtspUrl: 'rtsp://u:p@10.0.0.31/media/video1', username: 'admin', password: 'secret', presetOffset: 0, switcherInput: 1, presets: [] },
    { id: 'cam-vis', kind: 'vissonic-ptz', name: 'Left', host: '10.0.0.32', httpPort: 80, rtspUrl: 'rtsp://10.0.0.32:554/1', username: '', password: '', presetOffset: -1, switcherInput: 3, presets: [] },
    { id: 'sw', kind: 'vis-catc', name: 'Switcher', host: '10.0.0.34', httpPort: 80, inputLabels: ['HDMI-1', 'HDMI-2', 'SDI-1', 'SDI-2', 'SDI-3', 'SDI-4'], serial: { transport: 'tcp', host: '10.0.0.200', port: 4001, baudRate: 9600 } },
  ],
});

test('av-control-center export becomes http-cgi cameras and one switcher', () => {
  const site = parseSite(CONTROL_CENTER_EXPORT);
  assert.equal(site.kind, 'lz-site');
  assert.equal(site.name, 'Room A');
  assert.equal(site.cameras.length, 2);
  const [sony, vis] = site.cameras;
  assert.equal(sony.cameraNumber, 1);
  assert.deepEqual(sony.config, {
    connectionMode: 'http-cgi', cgiFamily: 'sony', camHost: '10.0.0.31', camPort: 80, ccuId: 1, label: 'Sony',
    camUser: 'admin', camPass: 'secret', cgiPresetOffset: 0, streamUrl: 'rtsp://u:p@10.0.0.31/media/video1', switcherInput: 1,
  });
  assert.equal(vis.config.cgiFamily, 'vissonic');
  assert.equal(vis.config.cgiPresetOffset, -1);
  assert.equal(vis.config.camUser, undefined, 'empty login is left out');
  assert.equal(site.switchers.length, 1);
  const sw = site.switchers[0];
  assert.equal(sw.switcherNumber, 1);
  assert.equal(sw.config.host, '10.0.0.34');
  assert.equal(sw.config.path, 'serial');
  assert.equal(sw.config.pgmWindow, 1);
  assert.deepEqual(sw.config.serial, { transport: 'tcp', host: '10.0.0.200', port: 4001, devicePath: undefined, baudRate: 9600 });
});

test('our own format round-trips and tolerates junk entries', () => {
  const site = emptySite('X');
  site.cameras.push({ cameraNumber: 2, config: { connectionMode: 'demo' }, autoConnect: false });
  site.switchers.push({ switcherNumber: 1, config: { host: 'sw.lan' }, autoConnect: true });
  const back = parseSite(serialiseSite(site));
  assert.deepEqual(back, site);
  const junk = parseSite(JSON.stringify({ kind: 'lz-site', formatVersion: 1, cameras: [{ cameraNumber: 'x' }, { cameraNumber: 1 }, { cameraNumber: 1, config: {} }, { cameraNumber: 1, config: {} }], switchers: 'no' }));
  assert.equal(junk.cameras.length, 1);
  assert.equal(junk.cameras[0].autoConnect, true);
});

test('refusals have a sentence', () => {
  assert.throws(() => parseSite('{'), SiteParseError);
  assert.throws(() => parseSite('{"foo":1}'), /Not a site file/);
  assert.throws(() => parseSite('{"kind":"lz-site","formatVersion":9}'), /newer/);
});

test('persistence: debounced, atomic, tolerant of a missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lz-site-'));
  const p = new SitePersistence(dir, 10);
  assert.equal(p.load(), null);
  const site = emptySite('Y');
  p.save(site);
  site.name = 'Z';
  p.save(site);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(p.load()?.name, 'Z');
  assert.ok(!existsSync(join(dir, 'site.json.tmp')));
  writeFileSync(join(dir, 'site.json'), 'not json');
  assert.equal(p.load(), null, 'an unreadable file is not a crash');
  p.save(emptySite('W'));
  p.flush();
  assert.equal(JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')).name, 'W');
  rmSync(dir, { recursive: true, force: true });
  assert.equal(configDir({ LZ_BRIDGE_CONFIG_DIR: '/x' } as NodeJS.ProcessEnv), '/x');
  assert.match(configDir({} as NodeJS.ProcessEnv), /\.lz-camera-bridge$/);
});
