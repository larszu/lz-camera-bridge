/**
 * VIS-CATC — the wire vocabulary from the device page and the manual, and
 * the client's behaviour around it: the bus, the trusted serial switch, the
 * poll that never overlaps. Network and serial are stand-ins on 127.0.0.1,
 * because the part that breaks is the transport, not the string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import {
  httpRoute, httpLayout, httpAudio, httpStatus,
  parseStatus, parseInputInfo, parseVersion, parseNetInfo, parseJsonLoose,
  serialRoute, serialLayout, serialAudio, serialFreezeTime, serialSetFreeze,
  isCompleteSerialReply, parseSwitchReply, parseLayoutReply, parseAudioReply, parseNetworkReply,
} from '../src/switcher/visCatcProtocol.js';
import { SWITCHER_LAYOUTS, layoutByMode, mainWindow, windowNumbers, isFullscreenLayout, fullscreenMode } from '../src/switcher/layouts.js';
import { cut, takeProgram, selectPreview, tallyFor, keyToAction } from '../src/switcher/switcherBus.js';
import { VisCatcClient, sendOverTcp } from '../src/switcher/VisCatcClient.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('the layout table in the panel is the one in the bridge, line for line', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').split('\n').slice(19).join('\n');
  assert.equal(read('../../web-rcp/src/lib/layouts.ts'), read('../src/switcher/layouts.ts'),
    'packages/web-rcp/src/lib/layouts.ts drifted from packages/bridge/src/switcher/layouts.ts — copy the bridge file over');
});

test('network verbs are the form bodies of the device page, unescaped', () => {
  assert.deepEqual(httpRoute(3, 1), { path: '/', method: 'POST', contentType: 'application/x-www-form-urlencoded; charset=utf-8', body: 'param=3V1' });
  assert.equal(httpRoute(9, 9).body, 'param=6V4');
  assert.equal(httpLayout(11).body, 'param=mode11');
  assert.equal(httpLayout(99).body, 'param=mode11');
  assert.equal(httpAudio(2).body, 'param=audio2');
  assert.equal(httpStatus().body, 'param=status');
});

test('status replies: strict JSON and the firmware\'s loose variant', () => {
  assert.deepEqual(parseStatus('{"out1":3,"out2":1,"out3":4,"out4":5,"mode":9,"audio":1}'), {
    outputs: { 1: 3, 2: 1, 3: 4, 4: 5 }, mode: 9, audio: 1,
  });
  assert.deepEqual(parseStatus("{out1:'3', out2:'1', mode:'0', audio:'0',}")?.outputs, { 1: 3, 2: 1 });
  assert.equal(parseStatus('garbage'), null);
  assert.equal(parseStatus('{"mode":1}'), null);
  assert.deepEqual(parseInputInfo('{"HDMI-1":"true","SDI-1":false,"SDI-2":1}'), { 'HDMI-1': true, 'SDI-1': false, 'SDI-2': true });
  assert.equal(parseVersion('{"version":"V1.2.3"}'), 'V1.2.3');
  assert.deepEqual(parseNetInfo("{ip:'192.168.1.20',gateway:'192.168.1.1',subnet:'255.255.255.0',mac:'00:11'}"), {
    ip: '192.168.1.20', gateway: '192.168.1.1', subnet: '255.255.255.0', mac: '00:11',
  });
  assert.equal(parseJsonLoose(''), null);
});

test('serial verbs and replies follow manual §6.3', () => {
  assert.equal(serialRoute(3, 1), '3V1.');
  assert.equal(serialRoute(0, 0), '1V1.');
  assert.equal(serialLayout(7), '<#Splice_mode7>');
  assert.equal(serialAudio(2), '<#Audio_chn2>');
  assert.equal(serialFreezeTime(9), 'FREEZE6.');
  assert.equal(serialSetFreeze(), 'SetFreeze.');
  assert.deepEqual(parseSwitchReply('V:3 -> 1'), { source: 3, window: 1 });
  assert.equal(parseLayoutReply('<Splice_mode7>'), 7);
  assert.equal(parseAudioReply('<Audio_chn2>'), 2);
  assert.deepEqual(parseNetworkReply('<SPORT5000><SIPR192.168.1.20><GAR192.168.1.1><SUBR255.255.255.0><SHAR00:11:22:33:44:55>'), {
    port: 5000, ip: '192.168.1.20', gateway: '192.168.1.1', subnet: '255.255.255.0', mac: '00:11:22:33:44:55',
  });
});

test('a serial reply is complete at <…>, a dot or the switch echo — not at a bare arrow', () => {
  assert.equal(isCompleteSerialReply('V:3 ->'), false);
  assert.equal(isCompleteSerialReply('V:3 -> 1'), true);
  assert.equal(isCompleteSerialReply('<Splice_mode'), false);
  assert.equal(isCompleteSerialReply('<Splice_mode7>'), true);
  assert.equal(isCompleteSerialReply('FREEZE3.'), true);
  assert.equal(isCompleteSerialReply(''), false);
});

test('twelve layouts; the programme window is the largest, and layout 5 is the odd one', () => {
  assert.equal(SWITCHER_LAYOUTS.length, 12);
  assert.deepEqual(SWITCHER_LAYOUTS.map((l) => l.windows.length), [1, 4, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4]);
  for (const l of SWITCHER_LAYOUTS) {
    for (const w of l.windows) {
      assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.width <= 100.001 && w.y + w.height <= 100.001, `layout ${l.mode} window ${w.number} out of bounds`);
    }
  }
  assert.equal(mainWindow(0), 1);
  assert.equal(mainWindow(4), 2, 'PiP top-left: window 2 is the big picture');
  assert.equal(mainWindow(5), 1);
  assert.equal(mainWindow(9), 1);
  assert.equal(mainWindow(10), 4);
  assert.deepEqual(windowNumbers(4), [1, 2]);
  assert.equal(isFullscreenLayout(0), true);
  assert.equal(fullscreenMode(), 0);
  assert.equal(layoutByMode(12), undefined);
});

test('the bus: preview sends nothing, CUT swaps, TAKE is a hard cut', () => {
  let s = { program: 1, preview: 0 };
  assert.deepEqual(cut(s), { state: s, switchTo: 0 });
  s = selectPreview(s, 3);
  const c = cut(s);
  assert.deepEqual(c, { state: { program: 3, preview: 1 }, switchTo: 3 });
  assert.deepEqual(takeProgram(c.state, 3).switchTo, 0);
  assert.deepEqual(takeProgram(c.state, 5), { state: { program: 5, preview: 1 }, switchTo: 5 });
  assert.equal(tallyFor({ program: 2, preview: 2 }, 2), 'program');
  assert.equal(tallyFor({ program: 2, preview: 4 }, 4), 'preview');
  assert.equal(tallyFor({ program: 2, preview: 4 }, 0), 'off');
});

test('keys by code: Shift+Digit takes, which event.key could never do', () => {
  assert.deepEqual(keyToAction('Digit3', false, 6), { kind: 'preview', source: 3 });
  assert.deepEqual(keyToAction('Digit3', true, 6), { kind: 'program', source: 3 });
  assert.deepEqual(keyToAction('Numpad2', true, 6), { kind: 'program', source: 2 });
  assert.equal(keyToAction('Digit7', false, 6), null);
  assert.deepEqual(keyToAction('Enter', false, 6), { kind: 'cut' });
  assert.deepEqual(keyToAction('Space', false, 6), { kind: 'cut' });
  assert.equal(keyToAction('KeyA', false, 6), null);
});

/** A switcher stand-in on HTTP: answers status from its own table. */
function fakeSwitcher() {
  const bodies: string[] = [];
  const state = { out1: 1, out2: 2, out3: 3, out4: 4, mode: 9, audio: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(raw);
      const m = /^param=(.*)$/.exec(raw);
      const p = m?.[1] ?? '';
      let answer = '{}';
      if (p === 'status') answer = JSON.stringify(state);
      else if (p === 'inputinfo') answer = '{"HDMI-1":"true","SDI-1":"false"}';
      else if (p === 'version') answer = '{"version":"V2"}';
      else if (/^(\d)V(\d)$/.test(p)) { const [, q, w] = /^(\d)V(\d)$/.exec(p)!; (state as Record<string, number>)[`out${w}`] = Number(q); }
      else if (/^mode(\d+)$/.test(p)) state.mode = Number(p.slice(4));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(answer);
    });
  });
  return { server, bodies, state };
}

test('VisCatcClient over HTTP: connect reads status, cut routes to the main window, preview lives in the bridge', async () => {
  const sw = fakeSwitcher();
  const port = await new Promise<number>((r) => sw.server.listen(0, '127.0.0.1', () => r((sw.server.address() as AddressInfo).port)));
  const client = new VisCatcClient({ host: '127.0.0.1', port, path: 'http' });
  await client.connect();
  assert.equal(client.isConnected, true);
  assert.equal(client.state.mode, 9);
  assert.equal(client.state.program, 1, 'layout 9: window 1 is the programme');
  assert.equal(client.state.version, 'V2');
  assert.deepEqual(client.state.inputSignals, { 'HDMI-1': true, 'SDI-1': false });

  client.setPreview(5);
  assert.equal(sw.bodies.filter((b) => /V/.test(b)).length, 0, 'preview sends no command');
  assert.equal(await client.doCut(), true);
  assert.equal(sw.bodies.at(-1), 'param=5V1');
  assert.deepEqual([client.state.program, client.state.preview], [5, 1]);

  // TAKE straight to programme; the old preview stays.
  assert.equal(await client.take(3), true);
  assert.equal(sw.bodies.at(-1), 'param=3V1');
  assert.deepEqual([client.state.program, client.state.preview], [3, 1]);

  // Layout change moves the programme window: layout 10 → window 4.
  assert.equal(await client.setLayout(10), true);
  assert.equal(client.programWindow(), 4);
  assert.equal(client.state.program, 4, 'window 4 still carries source 4');

  // A poll that is running is not started twice.
  const a = client.refresh();
  const b = client.refresh();
  assert.equal(await b, true);
  await a;
  client.disconnect();
  (sw.server as unknown as { closeAllConnections(): void }).closeAllConnections();
  sw.server.close();
});

test('serial over a TCP gateway: the switch echo confirms, a closed socket without bytes is a failure', async () => {
  const seen: string[] = [];
  const gateway = createTcpServer((socket) => {
    socket.on('data', (chunk) => {
      const cmd = chunk.toString('ascii');
      seen.push(cmd);
      const m = /^(\d)V(\d)\.$/.exec(cmd);
      if (m) socket.write(`V:${m[1]} -> ${m[2]}`);
      else socket.end();
    });
  });
  const port = await new Promise<number>((r) => gateway.listen(0, '127.0.0.1', () => r((gateway.address() as AddressInfo).port)));
  const ok = await sendOverTcp('127.0.0.1', port, '3V1.', 1000, true);
  assert.deepEqual(ok, { ok: true, body: 'V:3 -> 1' });
  const silent = await sendOverTcp('127.0.0.1', port, '<#Splice_mode2>', 1000, true);
  assert.equal(silent.ok, false);
  const fire = await sendOverTcp('127.0.0.1', port, 'SetFreeze.', 1000, false);
  assert.equal(fire.ok, true);
  assert.deepEqual(seen, ['3V1.', '<#Splice_mode2>', 'SetFreeze.']);
  gateway.close();
});

test('VisCatcClient over serial: the last switch is trusted until the poll agrees', async () => {
  const sw = fakeSwitcher(); // its table does NOT learn from serial — a stale HTTP status
  const port = await new Promise<number>((r) => sw.server.listen(0, '127.0.0.1', () => r((sw.server.address() as AddressInfo).port)));
  const gateway = createTcpServer((socket) => {
    socket.on('data', (chunk) => {
      const m = /^(\d)V(\d)\.$/.exec(chunk.toString('ascii'));
      if (m) socket.write(`V:${m[1]} -> ${m[2]}`);
    });
  });
  const gport = await new Promise<number>((r) => gateway.listen(0, '127.0.0.1', () => r((gateway.address() as AddressInfo).port)));
  const client = new VisCatcClient({ host: '127.0.0.1', port, path: 'serial', serial: { transport: 'tcp', host: '127.0.0.1', port: gport } });
  await client.connect();
  assert.equal(client.state.program, 1);
  assert.equal(await client.take(6), true);
  assert.equal(client.state.program, 6);
  await client.refresh(); // HTTP still says 1
  assert.equal(client.state.program, 6, 'the serial switch outlives one stale poll');
  client.disconnect();
  gateway.close();
  (sw.server as unknown as { closeAllConnections(): void }).closeAllConnections();
  sw.server.close();
});
