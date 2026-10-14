// Telemetrics head: keyframe frame format, bridge-side presets, eased recall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyframe, TelemetricsClient } from '../src/cameras/TelemetricsClient.ts';

test('keyframe frame matches the worked example of the protocol analysis', () => {
  const f = keyframe(0x00, { pan: 100000, tilt: -5000, zoom: 30000, focus: 20000, x: 0, y: 0 });
  assert.equal(f.toString('hex'), '434800000186a0ffec78007530004e20' + '00'.repeat(12) + '280d');
  assert.equal(keyframe(0xef).toString('hex').slice(-4), '7a0d');
  assert.equal(keyframe(0xff).toString('hex').slice(-4), '8a0d');
});

/** Minimal S5: answers positions, takes velocity, plays keyframes, answers CH=<n>. */
function mockHead(port: number) {
  const played: number[][] = [];
  const pos = [0, 0, 10000, 30000, 0, 0, 0, 0];
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length >= 30 && buf[0] === 0x43 && buf[1] === 0x48) {
          const f = buf.subarray(0, 30);
          buf = buf.subarray(30);
          const cmd = f[3];
          if (cmd !== 0xef) {
            const v = [0, 1, 2, 3, 4, 5].map((i) => {
              const n = (f[4 + i * 3] << 16) | (f[5 + i * 3] << 8) | f[6 + i * 3];
              return n & 0x800000 ? n - 0x1000000 : n;
            });
            if (v.some((x) => x !== 0) || cmd === 0x00) {
              played.push(v);
              for (let i = 0; i < 6; i++) pos[i] = v[i];
            }
          }
          s.write('CH=1\r');
          continue;
        }
        const cr = buf.indexOf(0x0d);
        if (cr < 0) break;
        const line = buf.subarray(0, cr).toString('latin1').trim();
        buf = buf.subarray(cr + 1);
        if (line.startsWith('ptzfxymi')) s.write(pos.join(' ') + '\r');
      }
    });
  });
  server.listen(port);
  return { server, played, pos };
}

test('store a preset, move away, recall it as an eased keyframe move', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
  const head = mockHead(19651);
  const cam = new TelemetricsClient('127.0.0.1', 19651, { dataDir: dir, presetTimeMs: 1000 });
  try {
    await cam.connect();
    assert.equal(await cam.handleRcpCommand('storePreset', { value: 1 }), true);
    head.pos[0] = 156250; // head was driven 10° to the right
    head.pos[2] = 50000;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await cam.handleRcpCommand('recallPreset', { value: 1 }), true);
    await new Promise((r) => setTimeout(r, 100)); // last frame in flight
    const pans = head.played.map((p) => p[0]);
    assert.ok(pans.length >= 20, `about 20 frames for 1 s, got ${pans.length}`);
    assert.equal(pans.at(-1), 0, 'lands exactly on the preset');
    const first = Math.abs(pans[1] - pans[0]);
    const mid = Math.abs(pans[Math.floor(pans.length / 2)] - pans[Math.floor(pans.length / 2) - 1]);
    assert.ok(first < mid / 3, 'starts slowly (ease-in)');
    assert.equal(head.played.at(-1)![2], 10000, 'zoom eases back too');
    assert.ok(fs.existsSync(path.join(dir, '127.0.0.1_19651.json')), 'presets saved');
    assert.equal(await cam.handleRcpCommand('recallPreset', { value: 9 }), false, 'unknown preset refused');
    const pose = await cam.readPose();
    assert.equal(pose.pan, 0);
  } finally {
    cam.disconnect();
    head.server.close();
  }
});
