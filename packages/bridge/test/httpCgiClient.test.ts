/**
 * HTTP-CGI PTZ client — an alternative control path to VISCA for the same
 * heads. The RCP verbs must land as the exact CGI the camera's own web app
 * sends, and the transport quirks proven live must hold:
 *
 *  - the Vissonic/PTZOptics control CGI (`ptzctrl.cgi`) needs no auth;
 *  - the Sony CGI (`/command/…`) is refused with 403 without a `Referer`, and
 *    then wants Digest.
 *
 * Tested against a real HTTP server on 127.0.0.1, not a stubbed `fetch`: the
 * bridge reaches the camera over HTTP, and a test that removes the transport
 * would not cover the part that can break — exactly the digest round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import {
  HttpCgiClient, sonyDirection, vissonicDirection, parsePowerReply, isViscaDone, parseSonyImaging,
  VISCA_POWER_ON, VISCA_POWER_STANDBY, VISCA_POWER_INQUIRY,
} from '../src/cameras/HttpCgiClient.js';
import { MODE_READBACK, MODE_CADENCE } from '../src/protocol/valueOrigin.js';
import { capabilitiesForMode, isPtzMode } from '../../web-rcp/src/capabilities.ts';

interface Hit {
  url: string;
  referer?: string;
  authorization?: string;
}

/** A camera stand-in that records the CGI it was asked for. */
function fakeCamera(opts: { digest?: { user: string; pass: string } } = {}) {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const record = () =>
      hits.push({
        url: req.url ?? '',
        referer: req.headers['referer'] as string | undefined,
        authorization: req.headers['authorization'] as string | undefined,
      });

    if (opts.digest && !req.headers['authorization']) {
      // First contact without credentials → Digest challenge.
      record();
      res.writeHead(401, {
        'WWW-Authenticate': 'Digest realm="", nonce="abc123", qop="auth", algorithm=MD5',
      });
      res.end('unauthorized');
      return;
    }
    record();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('{"Response":{"Result":"Success"}}');
  });
  return { server, hits };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Close the server and drop keep-alive sockets so the test runner can exit. */
function shut(server: Server): void {
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
}

test('Vissonic: RCP-Verben landen als ptzctrl.cgi der Geraeteoberflaeche', async () => {
  const { server, hits } = fakeCamera();
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });

  await cam.handleRcpCommand('ptz', { pan: 50, tilt: -50 });
  await cam.handleRcpCommand('ptz', { pan: 0, tilt: 0 });
  await cam.handleRcpCommand('setZoom', { value: 80 });
  await cam.handleRcpCommand('setZoom', { value: 0 });
  await cam.handleRcpCommand('setFocus', { value: -40 });
  await cam.handleRcpCommand('recallPreset', { value: 1 });
  await cam.handleRcpCommand('storePreset', { value: 9 });
  await cam.handleRcpCommand('autoFocus', {});

  const urls = hits.map((h) => h.url);
  assert.equal(urls[0], '/cgi-bin/ptzctrl.cgi?ptzcmd&rightdown&12&10');
  assert.equal(urls[1], '/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop&1&1');
  assert.equal(urls[2], '/cgi-bin/ptzctrl.cgi?ptzcmd&zoomin&6');
  assert.equal(urls[3], '/cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop&1');
  assert.equal(urls[4], '/cgi-bin/ptzctrl.cgi?ptzcmd&focusout&3');
  // Vissonic firmware counts presets from 0: shown 1 → sent 0.
  assert.equal(urls[5], '/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&0');
  assert.equal(urls[6], '/cgi-bin/ptzctrl.cgi?ptzcmd&posset&8');
  assert.equal(urls[7], '/cgi-bin/ptzctrl.cgi?ptzcmd&afocus');
  shut(server);
});

/** A PTZOptics-style head's VISCA-over-TCP side: ACK + completion, inquiry answers with the power state. */
function fakeVisca() {
  const received: string[] = [];
  let power = '02';
  const server: TcpServer = createTcpServer((socket) => {
    socket.on('data', (chunk) => {
      const hex = chunk.toString('hex');
      received.push(hex);
      if (hex === VISCA_POWER_INQUIRY) {
        socket.write(Buffer.from(`9050${power}ff`, 'hex'));
        return;
      }
      if (hex === VISCA_POWER_ON) power = '02';
      if (hex === VISCA_POWER_STANDBY) power = '03';
      // ACK, then completion — two frames in one chunk, as the real head does it.
      socket.write(Buffer.from('9041ff9051ff', 'hex'));
    });
  });
  return { server, received };
}

test('Vissonic: Ein/Aus geht ueber VISCA-TCP, nicht ueber die CGI, und wird zurueckgelesen', async () => {
  const { server } = fakeCamera();
  const port = await listen(server);
  const visca = fakeVisca();
  const viscaPort = await new Promise<number>((r) => visca.server.listen(0, '127.0.0.1', () => r((visca.server.address() as AddressInfo).port)));
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic', viscaPort, powerPollMs: 0 });
  await cam.connect();
  const states: unknown[] = [];
  cam.on('stateChanged', (s) => states.push(s));

  assert.equal(await cam.handleRcpCommand('setCameraPower', { on: false }), true);
  assert.ok(visca.received.includes(VISCA_POWER_STANDBY));
  await cam.readPower();
  assert.deepEqual(states.at(-1), { cameraPower: false });
  assert.equal(await cam.handleRcpCommand('setIris', { value: 128 }), false);
  cam.disconnect();
  visca.server.close();
  shut(server);
});

test('parsePowerReply liest beide Familien und raet nie', () => {
  assert.equal(parsePowerReply('sony', 'ModelName=SRG-A40&Power=on&Serial=1'), true);
  assert.equal(parsePowerReply('sony', 'Power=standby'), false);
  assert.equal(parsePowerReply('sony', 'ModelName=SRG-A40'), null);
  // ACK before the answer, as a real head sends it.
  assert.equal(parsePowerReply('vissonic', '9041ff905002ff'), true);
  assert.equal(parsePowerReply('vissonic', '905003ff'), false);
  assert.equal(parsePowerReply('vissonic', '9041ff'), null);
  assert.equal(parsePowerReply('vissonic', undefined), null);
  assert.equal(isViscaDone(Buffer.from('9041ff', 'hex')), false);
  assert.equal(isViscaDone(Buffer.from('9041ff9051ff', 'hex')), true);
  assert.equal(isViscaDone(Buffer.from('906002ff', 'hex')), true);
});

test('home und OSD: Vissonic kennt beides, Sony nur home', async () => {
  const { server, hits } = fakeCamera();
  const port = await listen(server);
  const vis = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });
  assert.equal(await vis.handleRcpCommand('home', {}), true);
  assert.equal(await vis.handleRcpCommand('osd', { action: 'menu' }), true);
  assert.equal(await vis.handleRcpCommand('osd', { action: 'back' }), true);
  assert.equal(await vis.handleRcpCommand('manualFocus', {}), true);
  const sony = new HttpCgiClient({ host: '127.0.0.1', port, family: 'sony' });
  assert.equal(await sony.handleRcpCommand('home', {}), true);
  assert.equal(await sony.handleRcpCommand('osd', { action: 'menu' }), false);
  const urls = hits.map((h) => h.url);
  assert.deepEqual(urls, [
    '/cgi-bin/ptzctrl.cgi?ptzcmd&home&12&10',
    '/cgi-bin/ptzctrl.cgi?osdcmd&menu',
    '/cgi-bin/ptzctrl.cgi?navigate_mode&OSD_BACK',
    '/cgi-bin/ptzctrl.cgi?ptzcmd&mfocus',
    '/command/ptzf.cgi?PanTiltReset=on',
  ]);
  shut(server);
});

test('Reihenfolge: ein Stop ueberholt nie seinen Move, und der neueste Move ersetzt den wartenden', async () => {
  // A slow camera: every request takes a moment, so several pile up.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, 30);
  });
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });
  const all = [
    cam.handleRcpCommand('ptz', { pan: 20, tilt: 0 }),   // goes out at once
    cam.handleRcpCommand('ptz', { pan: 40, tilt: 0 }),   // waits …
    cam.handleRcpCommand('ptz', { pan: 60, tilt: 0 }),   // … and replaces the 40
    cam.handleRcpCommand('ptz', { pan: 0, tilt: 0 }),    // the stop, after the 60
  ];
  await Promise.all(all);
  assert.deepEqual(hits, [
    '/cgi-bin/ptzctrl.cgi?ptzcmd&right&5&4',
    '/cgi-bin/ptzctrl.cgi?ptzcmd&right&14&12',
    '/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop&1&1',
  ]);
  shut(server);
});

test('Sony: PanTiltMove/ZoomMove/PresetCall, Referer immer gesetzt', async () => {
  const { server, hits } = fakeCamera();
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'sony' });

  await cam.handleRcpCommand('ptz', { pan: -100, tilt: 100 });
  await cam.handleRcpCommand('setZoom', { value: -50 });
  await cam.handleRcpCommand('setFocus', { value: 30 });
  await cam.handleRcpCommand('recallPreset', { value: 3 });
  await cam.handleRcpCommand('setCameraPower', { on: false });

  const urls = hits.map((h) => h.url);
  assert.equal(urls[0], '/command/ptzf.cgi?PanTiltMove=up-left,24,24');
  assert.equal(urls[1], '/command/ptzf.cgi?ZoomMove=wide,4');
  assert.equal(urls[2], '/command/ptzf.cgi?FocusMove=near,2');
  // Sony counts presets from 1: shown 3 → sent 3, with a recall speed.
  assert.equal(urls[3], '/command/presetposition.cgi?PresetCall=3,20');
  assert.equal(urls[4], '/command/main.cgi?System=standby');
  // Every call carries the Referer the Sony CGI insists on.
  assert.ok(hits.every((h) => h.referer === `http://127.0.0.1:${port}/`));
  shut(server);
});

test('Digest: eine 401-Challenge wird korrekt beantwortet', async () => {
  const { server, hits } = fakeCamera({ digest: { user: 'admin', pass: 'Admin1234' } });
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'sony', username: 'admin', password: 'Admin1234' });

  await cam.handleRcpCommand('ptz', { pan: 0, tilt: 0 });

  // First hit is the unauthenticated probe (401), second carries the answer.
  assert.equal(hits.length, 2);
  assert.equal(hits[0].authorization, undefined);
  assert.ok(hits[1].authorization?.startsWith('Digest '));
  // Verify the response digest matches what the server would compute.
  const auth = hits[1].authorization!;
  const field = (k: string) => new RegExp(`${k}=(?:"([^"]*)"|([^,]*))`).exec(auth)?.slice(1).find((x) => x !== undefined) ?? '';
  const uri = field('uri');
  const nc = field('nc');
  const cnonce = field('cnonce');
  const ha1 = createHash('md5').update('admin::Admin1234').digest('hex');
  const ha2 = createHash('md5').update(`GET:${uri}`).digest('hex');
  const expected = createHash('md5').update(`${ha1}:abc123:${nc}:${cnonce}:auth:${ha2}`).digest('hex');
  assert.equal(field('response'), expected);
  shut(server);
});

test('connect probes without moving the head', async () => {
  const { server, hits } = fakeCamera();
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });
  await cam.connect();
  assert.equal(cam.isConnected, true);
  // ptzstop is a no-op move, not a drive.
  assert.equal(hits[0].url, '/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop&1&1');
  shut(server);
});

test('direction helpers map diagonals per family', () => {
  assert.equal(vissonicDirection(50, -50), 'rightdown');
  assert.equal(vissonicDirection(-50, 50), 'leftup');
  assert.equal(vissonicDirection(0, 0), 'ptzstop');
  assert.equal(sonyDirection(-100, 100), 'up-left');
  assert.equal(sonyDirection(100, 0), 'right');
  assert.equal(sonyDirection(0, 0), 'stop');
});

test('http-cgi reads back power and (Sony) the white balance gains', () => {
  assert.deepEqual(MODE_READBACK['http-cgi'], ['cameraPower', 'whiteR', 'whiteB']);
  assert.deepEqual(MODE_CADENCE['http-cgi'], { kind: 'poll', everyMs: 10000 });
  // It is a PTZ mode and offers focus but no paint.
  assert.equal(isPtzMode('http-cgi'), true);
  const caps = capabilitiesForMode('http-cgi');
  assert.equal(caps.focus, true);
  assert.equal(caps.iris, false);
  // without a family: the weakest member (Vissonic) – no white balance
  assert.equal(caps.whiteBalance, false);
  assert.equal(capabilitiesForMode('http-cgi', 'vissonic').whiteBalance, false);
  assert.equal(capabilitiesForMode('http-cgi', 'sony').whiteBalance, true);
  assert.equal(capabilitiesForMode('http-cgi', 'sony').blackBalance, false);
});

test('Sony: setWhiteBalance → imaging.cgi (manual, Cr = R, Cb = B, kein G) und Rueckmeldung', async () => {
  // what an SRG-A40 (firmware 4.00) answers to inq=imaging, shortened
  let imaging = 'WhiteBalanceCbGain=179&WhiteBalanceCrGain=203&WhiteBalanceMode=auto&WhiteBalanceOffset=7';
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/command/imaging.cgi') {
      imaging = `WhiteBalanceCbGain=${u.searchParams.get('WhiteBalanceCbGain')}&WhiteBalanceCrGain=${u.searchParams.get('WhiteBalanceCrGain')}&WhiteBalanceMode=${u.searchParams.get('WhiteBalanceMode')}`;
      res.writeHead(204); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(u.searchParams.get('inq') === 'imaging' ? imaging : 'Power=on');
  });
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'sony', powerPollMs: 0 });
  const seen: Record<string, unknown>[] = [];
  cam.on('stateChanged', (s) => seen.push(s));
  await cam.connect();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.some((s) => s.whiteR === 203 && s.whiteB === 179), 'reads the gains on connect');

  assert.equal(await cam.handleRcpCommand('setWhiteBalance', { r: 215, g: 128, b: 170 }), true);
  assert.ok(hits.includes('/command/imaging.cgi?WhiteBalanceMode=manual&WhiteBalanceCrGain=215&WhiteBalanceCbGain=170'));
  assert.deepEqual(seen.at(-1), { whiteR: 215, whiteB: 170 });
  // out of range is clamped, never wrapped
  await cam.handleRcpCommand('setWhiteBalance', { r: 300, b: -4 });
  assert.ok(hits.includes('/command/imaging.cgi?WhiteBalanceMode=manual&WhiteBalanceCrGain=255&WhiteBalanceCbGain=0'));
  cam.disconnect();
  shut(server);
});

test('parseSonyImaging liest nur, was da ist', () => {
  assert.deepEqual(parseSonyImaging('WhiteBalanceCbGain=179&WhiteBalanceCrGain=203'), { whiteR: 203, whiteB: 179 });
  assert.equal(parseSonyImaging('WhiteBalanceMode=auto'), null);
  assert.equal(parseSonyImaging(undefined), null);
});

test('Vissonic kennt keinen Weissabgleich ueber die CGI', async () => {
  const { server, hits } = fakeCamera();
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });
  assert.equal(await cam.handleRcpCommand('setWhiteBalance', { r: 140, g: 128, b: 120 }), false);
  assert.equal(hits.length, 0);
  shut(server);
});
