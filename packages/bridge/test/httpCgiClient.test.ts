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

import { HttpCgiClient, sonyDirection, vissonicDirection } from '../src/cameras/HttpCgiClient.js';
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

test('Vissonic: kein setCameraPower ueber die CGI', async () => {
  const { server } = fakeCamera();
  const port = await listen(server);
  const cam = new HttpCgiClient({ host: '127.0.0.1', port, family: 'vissonic' });
  assert.equal(await cam.handleRcpCommand('setCameraPower', { on: true }), false);
  assert.equal(await cam.handleRcpCommand('setIris', { value: 128 }), false);
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

test('http-cgi is a control-only path in the value-origin model', () => {
  // Reads nothing back, so no cadence — the contract other backends carry.
  assert.deepEqual(MODE_READBACK['http-cgi'], []);
  assert.deepEqual(MODE_CADENCE['http-cgi'], { kind: 'none' });
  // It is a PTZ mode and offers focus but no paint.
  assert.equal(isPtzMode('http-cgi'), true);
  const caps = capabilitiesForMode('http-cgi');
  assert.equal(caps.focus, true);
  assert.equal(caps.iris, false);
});
