/**
 * B4 broadcast lens serial protocol (group B — serial on the Hirose 12-pin).
 *
 * Frame format, from docs/b4/b4-lens-control.md section 4:
 *
 *     <length> <cmd> <data 0..15> <crc>
 *
 *   length  number of data bytes AFTER the command byte, 0x00..0x0F
 *   cmd     command / function code
 *   crc     sum all bytes starting with the length byte,
 *           then take the low byte of (0x0100 - sum)
 *
 * Wire parameters are 78400 8N1, TTL, **inverted** polarity. None of that is
 * this module's concern: it works on already-deframed bytes so it can be
 * tested without any hardware.
 *
 * ── Everything from the lens is untrusted ──────────────────────────────────
 * Every published detail of this interface comes from third-party reverse
 * engineering, and the upstream authors state their findings may be wrong.
 * The decoder therefore validates the length byte and the CRC before it hands
 * anything out, drops what does not validate, and counts the drop. It never
 * guesses at a partially valid frame.
 */

/** Largest value the length byte may carry. */
export const B4_MAX_DATA_LEN = 0x0f;

/** Smallest possible frame: length + cmd + crc, no data. */
export const B4_MIN_FRAME_LEN = 3;

/**
 * Command codes.
 *
 * NOTE — unresolved conflict in the source. The upstream README's main table
 * lists 0x20 iris / 0x21 zoom / 0x22 focus, while a later prose section of the
 * same file lists 0x21 iris / 0x22 focus / 0x23 zoom. The table is the more
 * complete and internally consistent of the two and is used here, but this is
 * NOT settled: it must be resolved by observing what the camera actually sends
 * before anything is transmitted. See issue #47.
 */
export const B4Cmd = {
  Connect: 0x01,
  LensNameFirst: 0x11,
  LensNameSecond: 0x12,
  OpenFNumber: 0x13,
  FocalLengthTele: 0x14,
  FocalLengthWide: 0x15,
  MinObjectDistance: 0x16,
  SetIris: 0x20,
  SetZoom: 0x21,
  SetFocus: 0x22,
  GetIris: 0x30,
  GetZoom: 0x31,
  GetFocus: 0x32,
} as const;

export type B4CmdCode = (typeof B4Cmd)[keyof typeof B4Cmd];

/** A frame that passed both the length check and the CRC check. */
export interface B4Frame {
  cmd: number;
  data: Buffer;
}

/** Why a byte was thrown away. */
export interface B4DecoderCounters {
  /** Frames handed out after passing every check. */
  framesDecoded: number;
  /** Bytes discarded during resynchronisation. */
  bytesDropped: number;
  /** Frames whose length byte was in range but whose CRC did not match. */
  crcErrors: number;
  /** Frames rejected because the length byte exceeded B4_MAX_DATA_LEN. */
  lengthErrors: number;
}

/**
 * CRC over a frame body: the length byte, the command byte and the data.
 *
 * `crc = (0x0100 - sum) & 0xFF`, so a complete valid frame always satisfies
 * `(sum of every byte including the CRC) & 0xFF === 0`.
 */
export function b4Crc(body: Uint8Array): number {
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  return (0x100 - sum) & 0xff;
}

/**
 * Build a frame. Encoding is not transmitting: this exists so the decoder can
 * be tested against known-good input and so a future transmit path has one
 * place that knows the layout. Actually putting bytes on the wire stays behind
 * the compile-time flag and the physical jumper (issue #48).
 */
export function encodeB4Frame(cmd: number, data: Uint8Array = new Uint8Array(0)): Buffer {
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xff) {
    throw new RangeError(`B4 command must be a byte, got ${cmd}`);
  }
  if (data.length > B4_MAX_DATA_LEN) {
    throw new RangeError(`B4 frame carries at most ${B4_MAX_DATA_LEN} data bytes, got ${data.length}`);
  }
  const body = Buffer.alloc(2 + data.length);
  body[0] = data.length;
  body[1] = cmd;
  Buffer.from(data).copy(body, 2);
  return Buffer.concat([body, Buffer.from([b4Crc(body)])]);
}

/**
 * Streaming frame decoder.
 *
 * Frame boundaries come from the length byte and the CRC — never from a
 * timeout. A byte that cannot start a valid frame is dropped one at a time and
 * the decoder tries again at the next offset, so a burst of line noise costs
 * only the bytes it corrupted.
 */
export class B4FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  private counters: B4DecoderCounters = {
    framesDecoded: 0,
    bytesDropped: 0,
    crcErrors: 0,
    lengthErrors: 0,
  };

  /** Feed received bytes, get back every frame that completed. */
  push(chunk: Uint8Array): B4Frame[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, Buffer.from(chunk)]);

    const out: B4Frame[] = [];

    while (this.buf.length >= B4_MIN_FRAME_LEN) {
      const len = this.buf[0]!;

      if (len > B4_MAX_DATA_LEN) {
        this.drop(1);
        this.counters.lengthErrors += 1;
        continue;
      }

      const frameLen = len + B4_MIN_FRAME_LEN;
      if (this.buf.length < frameLen) break; // incomplete, wait for more

      const body = this.buf.subarray(0, frameLen - 1);
      if (b4Crc(body) !== this.buf[frameLen - 1]) {
        this.drop(1);
        this.counters.crcErrors += 1;
        continue;
      }

      out.push({ cmd: body[1]!, data: Buffer.from(body.subarray(2)) });
      this.counters.framesDecoded += 1;
      this.buf = this.buf.subarray(frameLen);
    }

    return out;
  }

  /** Bytes held back because a frame is still incomplete. */
  get pending(): number {
    return this.buf.length;
  }

  /** Read the drop counters. A rising count is the signal that something is wrong. */
  stats(): B4DecoderCounters {
    return { ...this.counters };
  }

  /** Forget buffered bytes, e.g. after reconnecting. Counters survive. */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  private drop(n: number): void {
    this.buf = this.buf.subarray(n);
    this.counters.bytesDropped += n;
  }
}

/**
 * Join the two halves of a lens name (0x11 and 0x12).
 *
 * 0x12 is only to be requested when 0x11 returned its full 15 bytes; passing a
 * short first half plus a second half here is a caller error, not something to
 * paper over, so the halves are concatenated exactly as given.
 *
 * Non-printable bytes are dropped rather than rendered as replacement
 * characters: the point of this call is to decide whether the link works, and
 * a name full of question marks would answer that question wrongly.
 */
export function decodeLensName(first: Uint8Array, second: Uint8Array = new Uint8Array(0)): string {
  const joined = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
  let text = '';
  for (const b of joined) {
    if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
  }
  return text.trim();
}

/**
 * Open F number from the two bytes of command 0x13.
 *
 * `FNo = 2 ^ (8 * (1 - data / 0x10000))`, where 0x10000 would be F1.0 and one
 * stop is 0x1000. Returns null for a payload that is not two bytes — an
 * unreadable answer is not an F number, and inventing one would put a value on
 * the RCP that no lens reported.
 */
export function decodeOpenFNumber(data: Uint8Array): number | null {
  if (data.length !== 2) return null;
  const raw = (data[0]! << 8) | data[1]!;
  return 2 ** (8 * (1 - raw / 0x10000));
}
