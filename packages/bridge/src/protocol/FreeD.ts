/**
 * FreeD (D1) camera tracking packets.
 *
 * FreeD originates with BBC R&D and is consumed by, among others, Unreal
 * Engine via Live Link. A D1 message is 29 bytes, big-endian throughout:
 *
 *     0       0xD1                     message type
 *     1       camera id                byte
 *     2..4    pan   (yaw)              24-bit signed, 1/32768 degree
 *     5..7    tilt  (pitch)            24-bit signed, 1/32768 degree
 *     8..10   roll                     24-bit signed, 1/32768 degree
 *     11..13  x position               24-bit signed, 1/64 mm
 *     14..16  y position               24-bit signed, 1/64 mm
 *     17..19  z position (height)      24-bit signed, 1/64 mm
 *     20..22  zoom                     24-bit unsigned
 *     23..25  focus                    24-bit unsigned
 *     26..27  spare / user defined     16-bit
 *     28      checksum                 (0x40 - sum of bytes 0..27) & 0xFF
 *
 * ── What is verified and what is not ───────────────────────────────────────
 * Verified from public sources: the 29-byte length, the 0xD1 identifier, the
 * checksum rule, and the angle format (sign in bit 23, 8 integer bits, 15
 * fractional bits — i.e. 1/32768 degree).
 *
 * NOT verified here: the 1/64 mm position scale. It is the widely used value
 * but the two authoritative documents (the Vizrt protocol description and
 * Sony's free-d integration manuals) were not reachable when this was written.
 * Treat POSITION_UNITS_PER_MM as provisional and confirm it against a real
 * capture before trusting translation data. Angles, zoom and focus are not
 * affected.
 *
 * Pure functions — no socket, no timer. Sending and rate limiting belong to
 * the caller.
 */

/** Every FreeD D1 packet is exactly this long. */
export const FREED_D1_LENGTH = 29;

/** First byte of a D1 message. */
export const FREED_D1_ID = 0xd1;

/** Angle fixed-point scale: 15 fractional bits. */
export const ANGLE_UNITS_PER_DEGREE = 32768;

/** Position fixed-point scale. PROVISIONAL — see the module comment. */
export const POSITION_UNITS_PER_MM = 64;

/** Largest and smallest value a 24-bit signed field can carry. */
export const INT24_MAX = 0x7fffff;
export const INT24_MIN = -0x800000;

/** Largest value a 24-bit unsigned field can carry. */
export const UINT24_MAX = 0xffffff;

/**
 * One tracking sample.
 *
 * Every axis is `number | null`, and null means **not known** — not zero.
 * FreeD has no representation for "missing": every field is 24 bits of
 * something. A camera that reports pan 0 is saying it points straight ahead,
 * which is a different statement from "nobody measured the pan". Encoding the
 * second as the first is exactly the mistake this codebase refuses elsewhere,
 * so `encodeFreeD` will not do it either.
 */
export interface FreeDSample {
  cameraId: number;
  /** Degrees. */
  panDeg: number | null;
  tiltDeg: number | null;
  rollDeg: number | null;
  /** Millimetres. */
  xMm: number | null;
  yMm: number | null;
  zMm: number | null;
  /** Raw 24-bit counts, 0..0xFFFFFF. */
  zoom: number | null;
  focus: number | null;
  /** Optional 16-bit user field. Defaults to 0, which the spec allows. */
  spare?: number;
}

export type FreeDEncodeResult =
  | { ok: true; packet: Buffer }
  | { ok: false; missing: readonly (keyof FreeDSample)[] };

const REQUIRED: readonly (keyof FreeDSample)[] = [
  'panDeg',
  'tiltDeg',
  'rollDeg',
  'xMm',
  'yMm',
  'zMm',
  'zoom',
  'focus',
];

function clampInt(value: number, min: number, max: number): number {
  const r = Math.round(value);
  if (!Number.isFinite(r)) return 0;
  return r < min ? min : r > max ? max : r;
}

function writeInt24BE(buf: Buffer, offset: number, value: number): void {
  const v = clampInt(value, INT24_MIN, INT24_MAX) & 0xffffff;
  buf[offset] = (v >> 16) & 0xff;
  buf[offset + 1] = (v >> 8) & 0xff;
  buf[offset + 2] = v & 0xff;
}

function writeUInt24BE(buf: Buffer, offset: number, value: number): void {
  const v = clampInt(value, 0, UINT24_MAX);
  buf[offset] = (v >> 16) & 0xff;
  buf[offset + 1] = (v >> 8) & 0xff;
  buf[offset + 2] = v & 0xff;
}

/** `(0x40 - sum of every preceding byte) & 0xFF`. */
export function freeDChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return (0x40 - sum) & 0xff;
}

/**
 * Encode one sample.
 *
 * Returns `{ ok: false, missing }` when an axis is null, naming each one, so
 * the caller can report *what* is unknown instead of silently transmitting a
 * confident-looking zero.
 */
export function encodeFreeD(sample: FreeDSample): FreeDEncodeResult {
  const missing = REQUIRED.filter((k) => sample[k] === null || sample[k] === undefined);
  if (missing.length > 0) return { ok: false, missing };

  const buf = Buffer.alloc(FREED_D1_LENGTH);
  buf[0] = FREED_D1_ID;
  buf[1] = clampInt(sample.cameraId, 0, 0xff);

  writeInt24BE(buf, 2, sample.panDeg! * ANGLE_UNITS_PER_DEGREE);
  writeInt24BE(buf, 5, sample.tiltDeg! * ANGLE_UNITS_PER_DEGREE);
  writeInt24BE(buf, 8, sample.rollDeg! * ANGLE_UNITS_PER_DEGREE);

  writeInt24BE(buf, 11, sample.xMm! * POSITION_UNITS_PER_MM);
  writeInt24BE(buf, 14, sample.yMm! * POSITION_UNITS_PER_MM);
  writeInt24BE(buf, 17, sample.zMm! * POSITION_UNITS_PER_MM);

  writeUInt24BE(buf, 20, sample.zoom!);
  writeUInt24BE(buf, 23, sample.focus!);

  const spare = clampInt(sample.spare ?? 0, 0, 0xffff);
  buf[26] = (spare >> 8) & 0xff;
  buf[27] = spare & 0xff;

  buf[28] = freeDChecksum(buf.subarray(0, FREED_D1_LENGTH - 1));
  return { ok: true, packet: buf };
}

/** True when the packet is 29 bytes, starts with 0xD1 and its checksum holds. */
export function isValidFreeDPacket(packet: Uint8Array): boolean {
  if (packet.length !== FREED_D1_LENGTH) return false;
  if (packet[0] !== FREED_D1_ID) return false;
  return freeDChecksum(packet.subarray(0, FREED_D1_LENGTH - 1)) === packet[FREED_D1_LENGTH - 1];
}

/**
 * Decode a packet back into a sample. Used by the tests and by anyone
 * verifying a capture; the bridge itself only sends.
 */
export function decodeFreeD(packet: Uint8Array): FreeDSample | null {
  if (!isValidFreeDPacket(packet)) return null;

  const i24 = (o: number): number => {
    const raw = (packet[o]! << 16) | (packet[o + 1]! << 8) | packet[o + 2]!;
    return raw & 0x800000 ? raw - 0x1000000 : raw;
  };
  const u24 = (o: number): number => (packet[o]! << 16) | (packet[o + 1]! << 8) | packet[o + 2]!;

  return {
    cameraId: packet[1]!,
    panDeg: i24(2) / ANGLE_UNITS_PER_DEGREE,
    tiltDeg: i24(5) / ANGLE_UNITS_PER_DEGREE,
    rollDeg: i24(8) / ANGLE_UNITS_PER_DEGREE,
    xMm: i24(11) / POSITION_UNITS_PER_MM,
    yMm: i24(14) / POSITION_UNITS_PER_MM,
    zMm: i24(17) / POSITION_UNITS_PER_MM,
    zoom: u24(20),
    focus: u24(23),
    spare: (packet[26]! << 8) | packet[27]!,
  };
}
