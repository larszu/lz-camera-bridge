/**
 * PTP/IP (CIPA DC-005) — the network transport for Sony Alpha / Cinema Line
 * bodies on Wi-Fi or LAN (TCP 15740). Pure framing plus a transaction runner
 * over any duplex byte stream, so the same code runs over a plain TCP socket
 * and over an SSH-forwarded channel (Access Authentication on).
 *
 * Packet layout per libgphoto2 camlibs/ptp2/ptpip.c: uint32 length,
 * uint32 type, payload. Ported from lz-camera-sync (src/core/ptpip.ts), where
 * it runs against a real FX3 (firmware 7.00) since 2026-10-07.
 */

export const PTPIP_PORT = 15740;

export const PTPIP = {
  INIT_COMMAND_REQUEST: 1,
  INIT_COMMAND_ACK: 2,
  INIT_EVENT_REQUEST: 3,
  INIT_EVENT_ACK: 4,
  INIT_FAIL: 5,
  CMD_REQUEST: 6,
  CMD_RESPONSE: 7,
  EVENT: 8,
  START_DATA: 9,
  DATA: 10,
  CANCEL: 11,
  END_DATA: 12,
  PING: 13,
  PONG: 14,
} as const;

/** Minimal duplex the runner needs: a Node socket or an ssh2 channel. */
export interface ByteStream {
  write(chunk: Buffer, cb?: (err?: Error | null) => void): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error' | 'close', cb: (err?: Error) => void): unknown;
  end(): unknown;
}

export function packPtpIp(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(8 + payload.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, payload]);
}

/** Friendly names in the init packets are NUL-terminated UTF-16LE, not PTP strings. */
function utf16z(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
}

export function initCommandRequest(guid: Buffer, name: string): Buffer {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(0x00010000);
  return packPtpIp(PTPIP.INIT_COMMAND_REQUEST, Buffer.concat([guid, utf16z(name), version]));
}

export function cmdRequest(opcode: number, tid: number, params: number[], dataOut: boolean): Buffer {
  const b = Buffer.alloc(10 + params.length * 4);
  b.writeUInt32LE(dataOut ? 2 : 1, 0);
  b.writeUInt16LE(opcode, 4);
  b.writeUInt32LE(tid >>> 0, 6);
  params.forEach((p, i) => b.writeUInt32LE(p >>> 0, 10 + i * 4));
  return packPtpIp(PTPIP.CMD_REQUEST, b);
}

/** Reassembles packets from a byte stream; `next()` resolves with the next whole one. */
export class PacketReader {
  private buf = Buffer.alloc(0);
  private waiters: ((p: { type: number; payload: Buffer }) => void)[] = [];
  private failed: Error | null = null;
  private failWaiters: ((e: Error) => void)[] = [];

  constructor(stream: ByteStream) {
    stream.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    const fail = (err?: Error) => {
      this.failed = err ?? new Error('Verbindung zur Kamera geschlossen');
      for (const f of this.failWaiters.splice(0)) f(this.failed);
      this.waiters = [];
    };
    stream.on('error', fail);
    stream.on('close', () => fail());
  }

  private queue: { type: number; payload: Buffer }[] = [];

  private drain(): void {
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < len) return;
      const packet = { type: this.buf.readUInt32LE(4), payload: this.buf.subarray(8, len) };
      this.buf = this.buf.subarray(len);
      const w = this.waiters.shift();
      if (w) {
        this.failWaiters.shift();
        w(packet);
      } else this.queue.push(packet);
    }
  }

  next(timeoutMs = 10000): Promise<{ type: number; payload: Buffer }> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTP/IP: keine Antwort der Kamera')), timeoutMs);
      this.waiters.push((p) => {
        clearTimeout(timer);
        resolve(p);
      });
      this.failWaiters.push((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

export interface PtpIpResult {
  code: number;
  data: Buffer | null;
}

/**
 * A PTP/IP session: command + event channel, one transaction at a time.
 * `open` yields a fresh duplex to the camera's PTP/IP port (plain TCP or an
 * SSH-forwarded channel).
 */
export class PtpIpConnection {
  private tid = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly cmd: ByteStream,
    private readonly reader: PacketReader,
    private readonly event: ByteStream,
  ) {}

  /**
   * Init handshake. Without Access Authentication the camera may show
   * "Allow pairing?" and answer only after the operator confirms — so the
   * first wait is long.
   */
  static async connect(open: () => Promise<ByteStream>, guid: Buffer, name = 'LZ Camera Bridge'): Promise<PtpIpConnection> {
    const cmd = await open();
    const reader = new PacketReader(cmd);
    cmd.write(initCommandRequest(guid, name));
    const ack = await reader.next(60000);
    if (ack.type === PTPIP.INIT_FAIL) throw new Error(`PTP/IP: Kamera lehnt ab (Grund ${ack.payload.readUInt32LE(0)})`);
    if (ack.type !== PTPIP.INIT_COMMAND_ACK) throw new Error(`PTP/IP: unerwartetes Paket ${ack.type}`);
    const connection = ack.payload.readUInt32LE(0);

    const event = await open();
    const evReader = new PacketReader(event);
    const id = Buffer.alloc(4);
    id.writeUInt32LE(connection);
    event.write(packPtpIp(PTPIP.INIT_EVENT_REQUEST, id));
    const evAck = await evReader.next();
    if (evAck.type !== PTPIP.INIT_EVENT_ACK) throw new Error(`PTP/IP: Event-Kanal abgelehnt (${evAck.type})`);
    return new PtpIpConnection(cmd, reader, event);
  }

  transaction(opcode: number, params: number[], dataOut?: Buffer): Promise<PtpIpResult> {
    const run = async (): Promise<PtpIpResult> => {
      const tid = ++this.tid;
      this.cmd.write(cmdRequest(opcode, tid, params, !!dataOut));
      if (dataOut) {
        const start = Buffer.alloc(12);
        start.writeUInt32LE(tid, 0);
        start.writeBigUInt64LE(BigInt(dataOut.length), 4);
        this.cmd.write(packPtpIp(PTPIP.START_DATA, start));
        const t = Buffer.alloc(4);
        t.writeUInt32LE(tid);
        this.cmd.write(packPtpIp(PTPIP.END_DATA, Buffer.concat([t, dataOut])));
      }
      const chunks: Buffer[] = [];
      for (;;) {
        const p = await this.reader.next();
        if (p.type === PTPIP.DATA || p.type === PTPIP.END_DATA) chunks.push(p.payload.subarray(4));
        else if (p.type === PTPIP.CMD_RESPONSE) {
          return { code: p.payload.readUInt16LE(0), data: chunks.length ? Buffer.concat(chunks) : null };
        }
        // START_DATA, PING etc.: nothing to keep
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  close(): void {
    for (const s of [this.cmd, this.event]) {
      try {
        s.end();
      } catch {
        /* already gone */
      }
    }
  }
}
