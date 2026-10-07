/**
 * Sony PTP/IP (Wi-Fi/LAN) and the fixes found on a real FX3 (fw 7.00,
 * 2026-10-07, with lz-camera-sync): protocol 3.00 handshake with retry,
 * writes that show up ~250 ms late, the clock as an ISO 8601 string, SSH
 * with a checked host key, SSDP discovery — and that the SSH password never
 * reaches site.json.
 *
 * No camera: a PTP/IP responder plays the body over a real TCP socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseSonyProps, sonyDateTimeString, DTC } from '../src/protocol/SonyPtp.js';
import { packPtpIp, PTPIP } from '../src/protocol/PtpIp.js';
import { SonyPtpIpClient } from '../src/cameras/SonyPtpIpClient.js';
import { fingerprintsOf, FingerprintError, SonySshTunnel } from '../src/transport/SonySshTunnel.js';
import { parseSonyDescription } from '../src/discovery/SonyNetDiscovery.js';
import { serialiseSite } from '../src/site/siteFile.js';

// ── A 0x9209 dataset built by hand ────────────────────────────────────────

interface FakeProp { code: number; type: number; value: number; values?: number[] }

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function val(type: number, v: number): Buffer { return type === DTC.UINT16 ? u16(v) : type === DTC.UINT8 ? Buffer.from([v]) : u32(v); }

function dump(props: FakeProp[], second?: { code: number; values: number[] }): Buffer {
  const parts: Buffer[] = [u32(props.length), u32(0)];
  for (const p of props) {
    parts.push(u16(p.code), u16(p.type), Buffer.from([1, 1]), val(p.type, p.value), val(p.type, p.value));
    if (p.values) {
      parts.push(Buffer.from([2]), u16(p.values.length), ...p.values.map((v) => val(p.type, v)));
      if (second?.code === p.code) parts.push(u16(second.values.length), ...second.values.map((v) => val(p.type, v)));
    } else parts.push(Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

test('0x9209: values, enums and the second enum newer bodies append', () => {
  const props = parseSonyProps(
    dump(
      [
        { code: 0x5005, type: DTC.UINT16, value: 0x8012, values: [2, 4, 0x8012] },
        { code: 0xd20f, type: DTC.UINT16, value: 5600 },
      ],
      { code: 0x5005, values: [2, 0x8012] },
    ),
  );
  assert.equal(props.get(0x5005)?.current, 0x8012);
  assert.deepEqual(props.get(0x5005)?.values, [2, 0x8012]);
  assert.equal(props.get(0xd20f)?.current, 5600);
  assert.equal(props.get(0xd20f)?.writable, true);
});

test('the clock goes out as Sony documents it', () => {
  assert.equal(sonyDateTimeString(new Date('2026-10-07T18:30:05.400Z'), true), '20261007T183005.4+0000');
  assert.match(sonyDateTimeString(new Date()), /^\d{8}T\d{6}\.\d[+-]\d{4}$/);
});

// ── A body behind PTP/IP ──────────────────────────────────────────────────

class FakeBody {
  props = new Map<number, number>([[0xd20f, 5600], [0xd20d, (1 << 16) | 50]]);
  extInfoEmpty = 2;
  applyDelayMs = 60;
  clock = '';
  writes = 0;

  dataFor(op: number): Buffer | null {
    if (op === 0x9201) return Buffer.alloc(8);
    if (op === 0x9202) return this.extInfoEmpty-- > 0 ? Buffer.alloc(0) : u16(0x012c);
    if (op === 0x9209) return dump([...this.props].map(([code, value]) => ({ code, type: code === 0xd20f ? DTC.UINT16 : DTC.UINT32, value })));
    return null;
  }

  write(code: number, data: Buffer): void {
    this.writes++;
    if (code === 0xd223) {
      const n = data.readUInt8(0);
      this.clock = data.subarray(1, 1 + (n - 1) * 2).toString('utf16le');
      return;
    }
    const v = code === 0xd20f ? data.readUInt16LE(0) : data.readUInt32LE(0);
    setTimeout(() => this.props.set(code, v), this.applyDelayMs); // FX3: the value shows up late
  }
}

function serve(body: FakeBody): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let pending: { op: number; tid: number; params: number[] } | null = null;
    const reply = (op: number, tid: number, dataOut?: Buffer) => {
      if (op === 0x9205 && dataOut) body.write(pending!.params[0], dataOut);
      const data = body.dataFor(op);
      if (data) {
        const start = Buffer.alloc(12); start.writeUInt32LE(tid, 0); start.writeBigUInt64LE(BigInt(data.length), 4);
        sock.write(packPtpIp(PTPIP.START_DATA, start));
        sock.write(packPtpIp(PTPIP.END_DATA, Buffer.concat([u32(tid), data])));
      }
      const r = Buffer.alloc(6); r.writeUInt16LE(0x2001, 0); r.writeUInt32LE(tid, 2);
      // split the response across two writes, as the real FX3 does
      const pkt = packPtpIp(PTPIP.CMD_RESPONSE, r);
      sock.write(pkt.subarray(0, 8));
      sock.write(pkt.subarray(8));
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8 && buf.length >= buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        const type = buf.readUInt32LE(4);
        const p = buf.subarray(8, len);
        buf = buf.subarray(len);
        if (type === PTPIP.INIT_COMMAND_REQUEST) sock.write(packPtpIp(PTPIP.INIT_COMMAND_ACK, Buffer.concat([u32(1), Buffer.alloc(16), Buffer.from('FX3\0', 'utf16le'), u32(0x10000)])));
        else if (type === PTPIP.INIT_EVENT_REQUEST) sock.write(packPtpIp(PTPIP.INIT_EVENT_ACK));
        else if (type === PTPIP.CMD_REQUEST) {
          const phase = p.readUInt32LE(0);
          pending = { op: p.readUInt16LE(4), tid: p.readUInt32LE(6), params: [] };
          for (let o = 10; o + 4 <= p.length; o += 4) pending.params.push(p.readUInt32LE(o));
          if (phase !== 2) reply(pending.op, pending.tid);
        } else if (type === PTPIP.END_DATA) reply(pending!.op, pending!.tid, p.subarray(4));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })));
}

test('PTP/IP: handshake retries the protocol version, writes wait for the camera', async () => {
  const body = new FakeBody();
  const srv = await serve(body);
  const cam = new SonyPtpIpClient({ host: '127.0.0.1', ptpPort: srv.port });
  cam.settleMs = 0;
  try {
  await cam.connect();
  assert.equal(body.extInfoEmpty, -1, 'asked again after two empty answers');

  await cam.setColorTemperature(6500);
  // Without the wait the next read would still say 5600.
  assert.equal((await cam.readProps()).get(0xd20f)?.current, 6500);
  assert.equal(cam.state.colorTemperature, 6500);

  await cam.setClock(new Date('2026-10-07T18:30:00Z'), true);
  assert.equal(body.clock, '20261007T183000.0+0000');
  } finally {
    await cam.disconnect();
    srv.close();
  }
});

test('PTP/IP: a value the body snaps to its own step still counts as taken', async () => {
  const body = new FakeBody();
  body.extInfoEmpty = 0;
  const srv = await serve(body);
  const cam = new SonyPtpIpClient({ host: '127.0.0.1', ptpPort: srv.port });
  try {
  await cam.connect();
  const t0 = Date.now();
  // The body takes 1/60 for "1/60" — but a snapped value would differ; the
  // wait ends on any change, not only on the exact value.
  body.write = function (code: number) { this.writes++; setTimeout(() => this.props.set(code, (1 << 16) | 64), 40); };
  await cam.setShutterDenominator(60);
  assert.ok(Date.now() - t0 < 1000, 'no 2 s timeout for a snapped value');
  } finally {
    await cam.disconnect();
    srv.close();
  }
});

// ── SSH with a checked host key ───────────────────────────────────────────

async function sshCamera(): Promise<{ port: number; fp: string; close: () => void } | null> {
  let ssh2: any;
  try {
    ssh2 = (await import('ssh2')).default;
  } catch {
    return null;
  }
  const key = ssh2.utils.generateKeyPairSync('ed25519');
  const fp = fingerprintsOf(ssh2.utils.parseKey(key.public).getPublicSSH()).sha256;
  const server = new ssh2.Server({ hostKeys: [key.private], algorithms: { cipher: ['aes128-ctr'] } }, (client: any) => {
    client
      .on('authentication', (ctx: any) =>
        ctx.method === 'keyboard-interactive'
          ? ctx.prompt([{ prompt: 'Password: ', echo: false }], (a: string[]) => (ctx.username === 'cam' && a[0] === 'secret' ? ctx.accept() : ctx.reject()))
          : ctx.reject(['keyboard-interactive']),
      )
      .on('ready', () =>
        client.on('tcpip', (accept: () => any, reject: () => void, info: { destPort: number }) => {
          if (info.destPort !== 15740) return reject();
          const ch = accept();
          ch.on('data', (d: Buffer) => ch.write(Buffer.concat([Buffer.from('ptp:'), d])));
        }),
      )
      .on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, fp, close: () => server.close() };
}

test('SSH: first contact names the fingerprint, a confirmed one opens the tunnel', async (t) => {
  const cam = await sshCamera();
  if (!cam) return t.skip('ssh2 not installed');
  const first = new SonySshTunnel({ host: '127.0.0.1', port: cam.port, user: 'cam', password: 'secret' });
  await assert.rejects(first.connect(), (e: unknown) => e instanceof FingerprintError && e.kind === 'unknown' && e.message.includes(cam.fp));

  const wrong = new SonySshTunnel({ host: '127.0.0.1', port: cam.port, user: 'cam', password: 'secret', fingerprint: 'SHA256:other' });
  await assert.rejects(wrong.connect(), (e: unknown) => e instanceof FingerprintError && e.kind === 'mismatch');

  const ok = new SonySshTunnel({ host: '127.0.0.1', port: cam.port, user: 'cam', password: 'secret', fingerprint: cam.fp });
  await ok.connect();
  const ch = await ok.channel();
  const echo = await new Promise<string>((r) => { ch.on('data', (d: Buffer) => r(String(d))); ch.write(Buffer.from('x')); });
  assert.equal(echo, 'ptp:x');
  ok.close();
  cam.close();
});

// ── Discovery and storage ─────────────────────────────────────────────────

test('discovery reads model, serial and whether SSH is required', () => {
  const dd = '<root><device><friendlyName>VIN_</friendlyName><serviceList><service><SCPDURL>/DigitalImagingDesc.xml</SCPDURL></service></serviceList></device></root>';
  const desc = '<X_ModelName>ILME-FX3</X_ModelName><X_FirmwareVersion>7.00</X_FirmwareVersion><X_SerialVersion>03802290</X_SerialVersion><X_PTP_PairingNecessity>Unnecessary</X_PTP_PairingNecessity><X_SSH_Support>Enable</X_SSH_Support>';
  assert.deepEqual(parseSonyDescription('192.168.0.225', dd, desc), {
    ip: '192.168.0.225', name: 'VIN_', model: 'ILME-FX3', serial: '03802290', firmware: '7.00', mac: '', ssh: true, pairing: false,
  });
});

test('the SSH password of a Sony Wi-Fi camera never reaches site.json', () => {
  const text = serialiseSite({
    version: 1,
    installationName: 'x',
    cameras: [
      { cameraNumber: 1, autoConnect: true, config: { connectionMode: 'sony-ptpip', camHost: '192.168.0.225', camUser: 'u', camPass: 'secret-ssh', sshFingerprint: 'SHA256:abc' } },
      { cameraNumber: 2, autoConnect: true, config: { connectionMode: 'http-cgi', camHost: '10.0.0.2', camPass: 'cgi-pass' } },
    ],
    switchers: [],
  } as any);
  assert.ok(!text.includes('secret-ssh'));
  assert.ok(text.includes('SHA256:abc'));
  assert.ok(text.includes('cgi-pass'), 'other modes unchanged');
});

