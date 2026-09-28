/**
 * Multiviewer generators — pure string builders, so they are tested by their
 * output alone: the go2rtc config, the launch script and the VLC script must
 * carry every stream and stay valid for the tool that runs them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildGo2rtcConfig,
  buildLaunchScript,
  buildVlcWindowsScript,
  gridFor,
  slug,
  tilePositions,
  type MultiviewSource,
} from '../src/multiview/multiviewGenerators.js';

const sources: MultiviewSource[] = [
  { label: 'Sony SRG-A40', streamUrl: 'rtsp://cam1.lan:554/media/video1' },
  { label: 'Vissonic PTZ 1', streamUrl: 'rtsp://cam2.lan:554/1' },
  { label: 'Vissonic PTZ 2', streamUrl: 'rtsp://cam3.lan:554/1' },
];

test('slug makes go2rtc-safe ids', () => {
  assert.equal(slug('Sony SRG-A40'), 'sony-srg-a40');
  assert.equal(slug('  Cam #2 !!'), 'cam-2');
  assert.equal(slug('///'), 'stream');
});

test('gridFor is near-square', () => {
  assert.deepEqual(gridFor(1), { columns: 1, rows: 1 });
  assert.deepEqual(gridFor(2), { columns: 2, rows: 1 });
  assert.deepEqual(gridFor(3), { columns: 2, rows: 2 });
  assert.deepEqual(gridFor(4), { columns: 2, rows: 2 });
  assert.deepEqual(gridFor(9), { columns: 3, rows: 3 });
});

test('tilePositions cover the screen without overlap', () => {
  const tiles = tilePositions(4, 1920, 1080);
  assert.deepEqual(tiles, [
    { x: 0, y: 0, width: 960, height: 540 },
    { x: 960, y: 0, width: 960, height: 540 },
    { x: 0, y: 540, width: 960, height: 540 },
    { x: 960, y: 540, width: 960, height: 540 },
  ]);
});

test('go2rtc config lists every stream with a unique id', () => {
  const yaml = buildGo2rtcConfig(sources);
  assert.match(yaml, /streams:/);
  assert.match(yaml, /\n {2}sony-srg-a40:\n {4}- rtsp:\/\/cam1\.lan:554\/media\/video1/);
  assert.match(yaml, /\n {2}vissonic-ptz-1:\n {4}- rtsp:\/\/cam2\.lan:554\/1/);
});

test('go2rtc keeps ids unique when labels collide', () => {
  const yaml = buildGo2rtcConfig([
    { label: 'Cam', streamUrl: 'rtsp://a/1' },
    { label: 'Cam', streamUrl: 'rtsp://b/1' },
  ]);
  assert.match(yaml, /\n {2}cam:\n/);
  assert.match(yaml, /\n {2}cam-2:\n/);
});

test('launch script has an mpv path and an ffmpeg fallback, and is valid bash', () => {
  const script = buildLaunchScript(sources, 1920, 1080);
  assert.ok(script.startsWith('#!/bin/bash'));
  assert.match(script, /command -v mpv/);
  assert.match(script, /xstack=inputs=4/); // 3 streams + 1 black tile in a 2x2
  assert.match(script, /--geometry=960x540\+0\+0/);
  assert.match(script, /"rtsp:\/\/cam2\.lan:554\/1"/);
  assertValidBash(script);
});

test('VLC script opens one window per stream and is valid bash', () => {
  const script = buildVlcWindowsScript(sources);
  assert.ok(script.startsWith('#!/bin/bash'));
  assert.match(script, /--no-one-instance/);
  assert.match(script, /osascript/);
  // one --video-x launch per stream
  assert.equal(script.split('--video-x=$X').length - 1, 3);
  assertValidBash(script);
});

/** `bash -n` parses without executing — proves the generated script is valid. */
function assertValidBash(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'mv-'));
  const file = join(dir, 'script.sh');
  writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}
