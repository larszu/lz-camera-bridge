/**
 * The scope stream without a camera: matrix/range choice, output size, the
 * ffmpeg argument list, the query guard, both probe parsers — and the
 * endpoint itself against a fake "ffmpeg"/"ffprobe" pair (node scripts), so
 * the frame protocol is checked end to end without ffmpeg installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

import {
  decodeParams, outputSize, scopeArgs, parseScopeQuery, parseFfprobeJson, parseFfmpegBanner,
  ffprobeCandidates, runScope,
} from '../src/multiview/ScopeStream.js';

test('decode matrix: tagged value wins, untagged HD is BT.709, untagged SD is BT.601', () => {
  assert.equal(decodeParams({ matrix: 'unknown', range: 'tv', height: 1080 }).decodeMatrix, 'bt709');
  assert.equal(decodeParams({ matrix: 'unknown', range: 'tv', height: 720 }).decodeMatrix, 'bt709');
  assert.equal(decodeParams({ matrix: 'unknown', range: 'tv', height: 576 }).decodeMatrix, 'bt601');
  assert.equal(decodeParams({ matrix: 'unknown', range: 'tv', height: 480 }).decodeMatrix, 'bt601');
  assert.equal(decodeParams({ matrix: 'bt2020nc', range: 'tv', height: 2160 }).decodeMatrix, 'bt2020');
  assert.equal(decodeParams({ matrix: 'bt2020c', range: 'tv', height: 2160 }).decodeMatrix, 'bt2020');
  assert.equal(decodeParams({ matrix: 'smpte170m', range: 'tv', height: 1080 }).decodeMatrix, 'bt601', 'a tag beats the size');
  assert.equal(decodeParams({ matrix: 'bt470bg', range: 'tv', height: 1080 }).decodeMatrix, 'bt601');
  assert.equal(decodeParams({ matrix: 'bt709', range: 'tv', height: 480 }).decodeMatrix, 'bt709');
});

test('decode range: only an explicit pc is full range', () => {
  assert.equal(decodeParams({ matrix: 'bt709', range: 'pc', height: 1080 }).decodeRange, 'full');
  assert.equal(decodeParams({ matrix: 'bt709', range: 'tv', height: 1080 }).decodeRange, 'limited');
  assert.equal(decodeParams({ matrix: 'bt709', range: 'unknown', height: 1080 }).decodeRange, 'limited');
});

test('output size: fits the width, keeps the aspect, even numbers, never upscales', () => {
  assert.deepEqual(outputSize(1920, 1080, 960), { width: 960, height: 540 });
  assert.deepEqual(outputSize(1280, 720, 960), { width: 960, height: 540 });
  assert.deepEqual(outputSize(720, 576, 960), { width: 720, height: 576 });
  assert.deepEqual(outputSize(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(1440, 1080, 961), { width: 960, height: 720 });
  assert.deepEqual(outputSize(0, 0, 960), { width: 960, height: 540 });
});

test('ffmpeg arguments: explicit matrix and range, raw RGBA or RGBA64 to stdout', () => {
  const a = scopeArgs('rtsp://cam/1', { width: 960, height: 540, depth: 8, fps: 0, decodeMatrix: 'bt709', decodeRange: 'limited' });
  assert.equal(a[a.indexOf('-vf') + 1], 'scale=960:540:flags=area:in_color_matrix=bt709:in_range=limited');
  assert.equal(a[a.indexOf('-pix_fmt') + 1], 'rgba');
  assert.equal(a[a.indexOf('-f') + 1], 'rawvideo');
  assert.equal(a.at(-1), 'pipe:1');
  assert.equal(a[a.indexOf('-rtsp_transport') + 1], 'tcp');
  assert.equal(a[a.indexOf('-i') + 1], 'rtsp://cam/1');
  assert.ok(a.includes('-an'));
  const b = scopeArgs('srt://cam:9000', { width: 1920, height: 1080, depth: 16, fps: 25, decodeMatrix: 'bt2020', decodeRange: 'full' });
  assert.equal(b[b.indexOf('-vf') + 1], 'scale=1920:1080:flags=area:in_color_matrix=bt2020:in_range=full,fps=25');
  assert.equal(b[b.indexOf('-pix_fmt') + 1], 'rgba64le');
  assert.ok(!b.includes('-rtsp_transport'));
});

test('query: depth 8 or 16 only, width default 960 and capped, fps capped', () => {
  const q = (s: string) => parseScopeQuery(new URLSearchParams(s));
  assert.deepEqual(q(''), { depth: 8, width: 960, fps: 0 });
  assert.deepEqual(q('depth=16&width=1920&fps=25'), { depth: 16, width: 1920, fps: 25 });
  assert.equal(q('depth=10').depth, 8);
  assert.equal(q('width=99999').width, 3840);
  assert.equal(q('width=-5').width, 0);
  assert.equal(q('width=abc').width, 0);
  assert.equal(q('fps=500').fps, 60);
});

test('ffprobe JSON: size, rate and colour tags; missing tags become unknown', () => {
  const p = parseFfprobeJson(JSON.stringify({ streams: [{
    width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p', avg_frame_rate: '25/1',
    color_space: 'bt709', color_range: 'tv',
  }] }));
  assert.deepEqual(p, { width: 1920, height: 1080, codec: 'h264', pixFmt: 'yuv420p', fps: 25, transfer: 'unknown', primaries: 'unknown', matrix: 'bt709', range: 'tv' });
  assert.equal(parseFfprobeJson('{"streams":[]}'), null);
  assert.equal(parseFfprobeJson('not json'), null);
});

test('ffmpeg banner: untagged, fully tagged, mixed tags', () => {
  const untagged = parseFfmpegBanner('  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 90k tbn\n');
  assert.equal(untagged?.width, 1920);
  assert.equal(untagged?.height, 1080);
  assert.equal(untagged?.codec, 'h264');
  assert.equal(untagged?.matrix, 'unknown');
  assert.equal(untagged?.fps, 25);
  assert.equal(decodeParams(untagged!).decodeMatrix, 'bt709');

  const tagged = parseFfmpegBanner('Stream #0:0: Video: h264 (Main), yuv420p(tv, bt709, progressive), 1280x720, 50 fps');
  assert.deepEqual([tagged?.range, tagged?.matrix, tagged?.primaries, tagged?.transfer], ['tv', 'bt709', 'bt709', 'bt709']);

  const hdr = parseFfmpegBanner('Stream #0:0[0x100]: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 25 tbr');
  assert.deepEqual([hdr?.matrix, hdr?.primaries, hdr?.transfer, hdr?.width, hdr?.fps], ['bt2020nc', 'bt2020', 'smpte2084', 3840, 25]);

  assert.equal(parseFfmpegBanner('rtsp://x: Connection refused'), null);
});

test('ffprobe is looked for next to the ffmpeg that was found', () => {
  const list = ffprobeCandidates(['/opt/app/ffmpeg-portable/ffmpeg', 'ffmpeg'], {});
  assert.deepEqual(list, ['/opt/app/ffmpeg-portable/ffprobe', 'ffprobe']);
  assert.deepEqual(ffprobeCandidates(['C:\\x\\ffmpeg.exe'], { LZ_BRIDGE_FFPROBE: '/p/ffprobe' }).slice(0, 1), ['/p/ffprobe']);
});

// ── End to end with fakes ─────────────────────────────────────────────────

function fakeTools(): string {
  const dir = join(tmpdir(), `lz-scope-fake-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // ffprobe: a tagged 1920×1080 stream.
  writeFileSync(join(dir, 'ffprobe'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ streams: [{ width: 1920, height: 1080, codec_name: 'h264', avg_frame_rate: '25/1', color_space: 'bt709', color_range: 'tv' }] }));
`);
  // ffmpeg: writes its argv to stderr, then 3 frames of the requested size in odd-sized chunks.
  writeFileSync(join(dir, 'ffmpeg'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const [w, h] = a[a.indexOf('-vf') + 1].match(/scale=(\\d+):(\\d+)/).slice(1).map(Number);
const bpp = a[a.indexOf('-pix_fmt') + 1] === 'rgba64le' ? 8 : 4;
const all = Buffer.alloc(w * h * bpp * 3);
for (let f = 0; f < 3; f++) all[f * w * h * bpp] = 10 + f;
let i = 0;
const step = () => { if (i >= all.length) return process.exit(0); process.stdout.write(all.subarray(i, i + 7777), step); i += 7777; };
step();
`);
  chmodSync(join(dir, 'ffprobe'), 0o755);
  chmodSync(join(dir, 'ffmpeg'), 0o755);
  return dir;
}

test('endpoint: info first, then frames of exactly width×height×4, then end', { skip: process.platform === 'win32' }, async () => {
  const dir = fakeTools();
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => { void runScope(ws, 'rtsp://127.0.0.1/test', { depth: 8, width: 960, fps: 0 }, [join(dir, 'ffmpeg')]); });
  const port = (wss.address() as { port: number }).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const texts: Record<string, unknown>[] = [];
  const frames: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    client.on('message', (data, isBinary) => {
      if (isBinary) frames.push(data as Buffer);
      else texts.push(JSON.parse(data.toString()));
    });
    client.on('close', () => resolve());
    client.on('error', reject);
  });
  wss.close();
  const info = texts[0] as Record<string, unknown>;
  assert.equal(info.type, 'info', 'info comes before any frame');
  assert.deepEqual([info.width, info.height, info.depth, info.sourceWidth, info.sourceHeight, info.decodeMatrix], [960, 540, 8, 1920, 1080, 'bt709']);
  assert.equal(frames.length, 3);
  for (const f of frames) assert.equal(f.length, 960 * 540 * 4);
  assert.deepEqual(frames.map((f) => f[0]), [10, 11, 12], 'frames are cut at the right boundaries');
  assert.equal(texts.at(-1)?.type, 'end');
});

test('bridge routes /scope/<n> apart from the control socket and refuses without a stream address', async () => {
  const { BridgeServer } = await import('../src/BridgeServer.js');
  const port = 19781;
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 });
  bridge.start();
  try {
    const control = new WebSocket(`ws://127.0.0.1:${port}`);
    const first = await new Promise<Record<string, unknown>>((resolve) => control.once('message', (d) => resolve(JSON.parse(d.toString()))));
    assert.equal(first.type, 'cameras', 'the plain path is still the control socket');

    const messages: Record<string, unknown>[] = [];
    const scope = new WebSocket(`ws://127.0.0.1:${port}/scope/7`);
    scope.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => scope.once('close', r));
    assert.deepEqual(messages, [{ type: 'error', message: 'Camera 7 has no stream address' }], 'a scope socket gets no control broadcasts');

    control.send(JSON.stringify({ type: 'setCameraConfig', cameraNumber: 2, config: { streamUrl: 'rtsp://203.0.113.9/live' } }));
    await new Promise((r) => setTimeout(r, 50));
    const refused: Record<string, unknown>[] = [];
    const outside = new WebSocket(`ws://127.0.0.1:${port}/scope/2`);
    outside.on('message', (d) => refused.push(JSON.parse(d.toString())));
    await new Promise((r) => outside.once('close', r));
    assert.equal(refused[0]?.type, 'error');
    assert.match(String(refused[0]?.message), /outside the private networks/);
    control.close();
  } finally {
    bridge.stop();
  }
});
