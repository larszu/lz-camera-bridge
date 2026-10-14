/**
 * freed-receive — listen for FreeD D1 packets and print what they say.
 *
 *   npx tsx src/tools/freedReceive.ts [port=40000] [--raw]
 *
 * For checking a route before the real receiver is involved: is anything
 * arriving, from where, for which camera id, how often, and do the values move
 * the way the camera moves. Packets with a wrong length or checksum are
 * counted and shown, not dropped silently.
 *
 * This proves the bridge and its own decoder agree. It does NOT prove a
 * foreign receiver reads the same thing — that is what a test against the
 * receiver itself is for (issue #56).
 */
import dgram from 'node:dgram';
import { decodeFreeD, type FreeDSample } from '../protocol/FreeD.js';

export interface ReceivedPacket {
  from: string;
  at: number;
  sample: FreeDSample | null;
  bytes: Buffer;
}

export interface FreeDReceiver {
  readonly port: number;
  close(): void;
}

/** Bind a UDP port and hand every datagram over, decoded or (when invalid) as null. */
export function createFreeDReceiver(
  port: number,
  onPacket: (p: ReceivedPacket) => void,
  onListening?: (port: number) => void,
): FreeDReceiver {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let bound = port;
  sock.on('message', (msg, rinfo) => {
    onPacket({ from: `${rinfo.address}:${rinfo.port}`, at: Date.now(), sample: decodeFreeD(msg), bytes: msg });
  });
  sock.bind(port, () => {
    bound = sock.address().port;
    onListening?.(bound);
  });
  return {
    get port() {
      return bound;
    },
    close: () => {
      try { sock.close(); } catch { /* already closed */ }
    },
  };
}

/** One line per packet, the way someone at a console reads it. */
export function formatSample(s: FreeDSample): string {
  const f = (v: number | null, d = 2): string => (v === null ? '—' : v.toFixed(d));
  return `cam ${s.cameraId}  pan ${f(s.panDeg)}°  tilt ${f(s.tiltDeg)}°  roll ${f(s.rollDeg)}°  `
    + `x ${f(s.xMm, 1)}  y ${f(s.yMm, 1)}  z ${f(s.zMm, 1)} mm  zoom ${s.zoom}  focus ${s.focus}`;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 40000);
  const counts = new Map<string, number>();
  let invalid = 0;
  let lastPrint = 0;
  createFreeDReceiver(
    port,
    (p) => {
      if (!p.sample) {
        invalid += 1;
        console.log(`${p.from}  INVALID (${p.bytes.length} bytes) ${p.bytes.toString('hex')}`);
        return;
      }
      const key = `${p.from} cam ${p.sample.cameraId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // Every packet at 50 Hz is unreadable; ten lines a second is not.
      if (raw || p.at - lastPrint >= 100) {
        lastPrint = p.at;
        console.log(`${p.from}  ${formatSample(p.sample)}${raw ? `  ${p.bytes.toString('hex')}` : ''}`);
      }
    },
    (bound) => console.log(`listening for FreeD on UDP ${bound}`),
  );
  setInterval(() => {
    const parts = [...counts].map(([k, n]) => `${k}: ${(n / 5).toFixed(1)}/s`);
    console.log(`── ${parts.join('  ') || 'nothing received'}${invalid ? `  invalid ${invalid}` : ''}`);
    counts.clear();
  }, 5000);
}
