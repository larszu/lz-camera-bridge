/**
 * The RTSP→MJPEG hub without ffmpeg: the parser across chunk boundaries, the
 * argument list, the binary search order, the private-network guard, and
 * the hub's life cycle driven by a fake "ffmpeg" (a node script that writes
 * mpjpeg parts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createMjpegParser, mjpegArgs, ffmpegCandidates, checkStreamUrl, isPrivateHost, RtspHub } from '../src/multiview/RtspHub.js';

function part(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${payload.length}\r\n\r\n`, 'latin1'),
    Buffer.from(payload, 'latin1'),
  ]);
}

test('mpjpeg parser: one part, two in one chunk, one across three chunks', () => {
  const frames: string[] = [];
  const feed = createMjpegParser((f) => frames.push(f.toString('latin1')));
  feed(part('AAAA'));
  assert.deepEqual(frames, ['AAAA']);
  feed(Buffer.concat([part('BB'), part('CCC')]));
  assert.deepEqual(frames, ['AAAA', 'BB', 'CCC']);
  const whole = part('DDDDDDDD');
  feed(whole.subarray(0, 10));
  feed(whole.subarray(10, 40));
  assert.equal(frames.length, 3, 'unfinished part is not delivered');
  feed(whole.subarray(40));
  assert.deepEqual(frames.at(-1), 'DDDDDDDD');
});

test('ffmpeg arguments: TCP, socket timeout, scaled MJPEG to stdout', () => {
  const args = mjpegArgs('rtsp://cam/1', 960, 12);
  assert.ok(args.includes('-rtsp_transport') && args[args.indexOf('-rtsp_transport') + 1] === 'tcp');
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://cam/1');
  assert.equal(args[args.indexOf('-vf') + 1], 'scale=960:-2');
  assert.deepEqual(args.slice(-3), ['-f', 'mpjpeg', '-']);
});

test('binary search order: LZ_BRIDGE_FFMPEG, portable folder, PATH', () => {
  const root = join(tmpdir(), `lz-hub-${process.pid}`);
  mkdirSync(join(root, 'ffmpeg-portable'), { recursive: true });
  writeFileSync(join(root, 'ffmpeg-portable', 'ffmpeg'), '');
  assert.deepEqual(ffmpegCandidates({ LZ_BRIDGE_FFMPEG: '/opt/ff' } as NodeJS.ProcessEnv, root, 'darwin'), ['/opt/ff', join(root, 'ffmpeg-portable', 'ffmpeg'), 'ffmpeg']);
  assert.deepEqual(ffmpegCandidates({} as NodeJS.ProcessEnv, '/nowhere', 'win32'), ['ffmpeg']);
});

test('stream guard: rtsp only, private networks only', () => {
  assert.equal(checkStreamUrl('rtsp://192.168.56.131/1'), null);
  assert.equal(checkStreamUrl('rtsp://admin:pw@cam.lan:554/media/video1'), null);
  assert.match(checkStreamUrl('http://192.168.1.1/x') ?? '', /rtsp/);
  assert.match(checkStreamUrl('rtsp://8.8.8.8/1') ?? '', /outside/);
  assert.equal(checkStreamUrl('rtsp://8.8.8.8/1', true), null);
  assert.match(checkStreamUrl('not a url') ?? '', /valid/);
  assert.equal(isPrivateHost('10.0.0.1'), true);
  assert.equal(isPrivateHost('172.31.0.1'), true);
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('[::1]'), true);
});

test('hub: one process per stream, frames fan out, last frame greets a late tile, idle stop kills', async () => {
  const dir = join(tmpdir(), `lz-hub-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'fake-ffmpeg.mjs');
  // Emits three parts, then stays alive (like ffmpeg on a live stream).
  writeFileSync(script, `
    const part = (p) => Buffer.concat([Buffer.from('--ffmpeg\\r\\nContent-type: image/jpeg\\r\\nContent-length: ' + p.length + '\\r\\n\\r\\n'), Buffer.from(p)]);
    let n = 0;
    const t = setInterval(() => { process.stdout.write(part('F' + (++n))); if (n === 3) clearInterval(t); }, 20);
    setInterval(() => {}, 1000);
  `);
  // A wrapper that ignores ffmpeg's flags and runs the script.
  const wrapper = join(dir, 'ffmpeg');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  const hub = new RtspHub({ candidates: [wrapper], idleStopMs: 50 });
  try {
    const url = 'rtsp://127.0.0.1/fake';
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = hub.subscribe(url, { frame: (f) => a.push(f.toString()), error: (e) => a.push('ERR ' + e) });
    await waitFor(() => a.length >= 3, 3000);
    assert.deepEqual(a.slice(0, 3), ['F1', 'F2', 'F3']);
    const unsubB = hub.subscribe(url, { frame: (f) => b.push(f.toString()), error: (e) => b.push('ERR ' + e) });
    assert.deepEqual(b, ['F3'], 'a late tile gets the last frame at once');
    assert.equal(hub.activeCount, 1, 'never more than one process per stream');
    unsubA();
    unsubB();
    await waitFor(() => hub.activeCount === 0, 2000);
    assert.equal(hub.activeCount, 0, 'idle stop killed the process');
  } finally {
    hub.stopAll();
  }
});

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
}
