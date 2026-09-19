/**
 * FreeD UDP sender tests (run with `npm test` in packages/bridge).
 *
 * These bind a real loopback socket rather than a mock: the thing under test
 * is that bytes leave the machine at the configured address and rate, and a
 * fake `send()` would prove only that the function was called. Port 0 lets
 * the kernel pick, so a parallel run never collides.
 *
 * What is NOT tested here is byte-exactness against real FreeD equipment —
 * that is issue #54's remaining item and belongs to `freeD.test.ts`.
 */
import assert from 'node:assert/strict';
import dgram from 'dgram';
import { test } from 'node:test';

import { decodeFreeD, isValidFreeDPacket, type FreeDSample } from '../src/protocol/FreeD.js';
import { createFreeDSender } from '../src/transport/FreeDSender.js';

const full = (over: Partial<FreeDSample> = {}): FreeDSample => ({
  cameraId: 3,
  panDeg: 12.5,
  tiltDeg: -3.25,
  rollDeg: 0,
  xMm: 1000,
  yMm: -250,
  zMm: 1500,
  zoom: 0x1234,
  focus: 0x5678,
  ...over,
});

/** A loopback receiver on a kernel-chosen port. */
async function receiver(): Promise<{
  port: number;
  next(): Promise<Buffer>;
  received: Buffer[];
  close(): void;
}> {
  const sock = dgram.createSocket('udp4');
  const received: Buffer[] = [];
  const waiting: ((b: Buffer) => void)[] = [];
  sock.on('message', (msg) => {
    received.push(Buffer.from(msg));
    waiting.shift()?.(Buffer.from(msg));
  });
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
  const port = sock.address().port;
  return {
    port,
    next: () =>
      new Promise<Buffer>((resolve, reject) => {
        const first = received.shift();
        if (first) return resolve(first);
        const timer = setTimeout(() => reject(new Error('no datagram within 2 s')), 2000);
        waiting.push((b) => {
          clearTimeout(timer);
          resolve(b);
        });
      }),
    received,
    close: () => sock.close(),
  };
}

test('sendNow puts one valid packet on the configured host and port', async () => {
  const rx = await receiver();
  const sender = createFreeDSender({ host: '127.0.0.1', port: rx.port, rateHz: 25 });
  sender.update(full());

  const result = sender.sendNow();
  assert.deepEqual(result, { ok: true });

  const packet = await rx.next();
  assert.ok(isValidFreeDPacket(packet), 'packet must carry a valid checksum');
  const back = decodeFreeD(packet);
  assert.equal(back?.cameraId, 3);
  assert.equal(back?.panDeg, 12.5);
  assert.equal(back?.zoom, 0x1234);

  sender.stop();
  rx.close();
});

test('an incomplete sample is not sent, and the missing axes are named', async () => {
  const rx = await receiver();
  const missingSeen: string[][] = [];
  const sender = createFreeDSender({
    host: '127.0.0.1',
    port: rx.port,
    rateHz: 25,
    onIncomplete: (missing) => missingSeen.push([...missing] as string[]),
  });
  sender.update(full({ panDeg: null, zoom: null }));

  const result = sender.sendNow();
  assert.deepEqual(result, { ok: false, reason: 'incomplete' });
  assert.deepEqual(missingSeen, [['panDeg', 'zoom']]);
  assert.equal(sender.stats.sent, 0);
  assert.equal(sender.stats.skippedIncomplete, 1);

  // Nothing at all may arrive — a zero-filled packet would be a claim.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rx.received.length, 0);

  sender.stop();
  rx.close();
});

test('a sender that was never given a sample stays silent', async () => {
  const rx = await receiver();
  const sender = createFreeDSender({ host: '127.0.0.1', port: rx.port, rateHz: 50 });

  assert.deepEqual(sender.sendNow(), { ok: false, reason: 'no-sample' });
  assert.equal(sender.stats.skippedNoSample, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rx.received.length, 0);

  sender.stop();
  rx.close();
});

test('start ticks at the configured rate and sends the latest sample', async () => {
  const rx = await receiver();
  const sender = createFreeDSender({ host: '127.0.0.1', port: rx.port, rateHz: 100 });
  assert.equal(sender.intervalMs, 10);

  sender.update(full({ cameraId: 7 }));
  sender.start();
  assert.equal(sender.running, true);

  const first = await rx.next();
  assert.equal(decodeFreeD(first)?.cameraId, 7);

  sender.update(full({ cameraId: 9 }));
  // Drain what was already queued from before the update, then read a fresh one.
  await new Promise((r) => setTimeout(r, 60));
  rx.received.length = 0;
  const later = await rx.next();
  assert.equal(decodeFreeD(later)?.cameraId, 9);

  sender.stop();
  assert.equal(sender.running, false);

  // After stop, nothing more arrives.
  const countAtStop = rx.received.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rx.received.length, countAtStop);

  rx.close();
});

test('start twice does not open a second timer', async () => {
  const rx = await receiver();
  const sender = createFreeDSender({ host: '127.0.0.1', port: rx.port, rateHz: 50 });
  sender.update(full());
  sender.start();
  sender.start();
  await new Promise((r) => setTimeout(r, 120));
  sender.stop();
  // 50 Hz for ~120 ms is around 6 packets; a doubled timer would show ~12.
  assert.ok(rx.received.length <= 9, `expected a single timer, saw ${rx.received.length}`);
  rx.close();
});

test('address, port and rate have no defaults, and nonsense is rejected', () => {
  assert.throws(
    () => createFreeDSender({ host: '', port: 6301, rateHz: 25 }),
    /host is required/,
  );
  assert.throws(
    () => createFreeDSender({ host: '127.0.0.1', port: 0, rateHz: 25 }),
    /port must be 1\.\.65535/,
  );
  assert.throws(
    () => createFreeDSender({ host: '127.0.0.1', port: 70000, rateHz: 25 }),
    /port must be 1\.\.65535/,
  );
  assert.throws(
    () => createFreeDSender({ host: '127.0.0.1', port: 6301, rateHz: 0 }),
    /rateHz must be a positive number/,
  );
  assert.throws(
    () => createFreeDSender({ host: '127.0.0.1', port: 6301, rateHz: Number.NaN }),
    /rateHz must be a positive number/,
  );
});

test('stop is safe before start and twice in a row', () => {
  const sender = createFreeDSender({ host: '127.0.0.1', port: 6301, rateHz: 25 });
  sender.stop();
  sender.stop();
  assert.equal(sender.running, false);
});
