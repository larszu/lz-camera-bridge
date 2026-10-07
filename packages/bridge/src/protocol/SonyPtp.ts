/**
 * Sony PTP Vendor Extension — protocol layer (pure, no I/O)
 *
 * Sony Alpha / Cinema-Line cameras (FX3, FX6, A7 …) expose remote control over
 * USB using the PTP (Picture Transfer Protocol, ISO 15740) "Still Image"
 * interface plus a Sony vendor extension. This is the same protocol that
 * libgphoto2's ptp2 driver and Sony's own Imaging Edge / Camera Remote SDK
 * speak — so it can be implemented directly over libusb without the
 * proprietary native SDK.
 *
 * This module contains only the framing and constants so it can be unit
 * tested without any USB hardware. The actual bulk transfers live in
 * SonyPtpUsbClient.
 *
 * Opcode / property values are taken verbatim from libgphoto2
 * (camlibs/ptp2/ptp.h). All multi-byte fields are little-endian.
 */

// ── PTP USB container types ────────────────────────────────────────────────
export const PTP_CONTAINER_COMMAND = 0x0001;
export const PTP_CONTAINER_DATA = 0x0002;
export const PTP_CONTAINER_RESPONSE = 0x0003;
export const PTP_CONTAINER_EVENT = 0x0004;

export const PTP_CONTAINER_HEADER_LEN = 12;

// ── Standard PTP operation codes ───────────────────────────────────────────
export const PTP_OC_GetDeviceInfo = 0x1001;
export const PTP_OC_OpenSession = 0x1002;
export const PTP_OC_CloseSession = 0x1003;
export const PTP_OC_GetDevicePropValue = 0x1015;
export const PTP_OC_SetDevicePropValue = 0x1016;

// ── Sony vendor operation codes ────────────────────────────────────────────
export const PTP_OC_SONY_SDIO_Connect = 0x9201;
export const PTP_OC_SONY_SDIO_GetExtDeviceInfo = 0x9202;
export const PTP_OC_SONY_SDIO_SetExtDevicePropValue = 0x9205; // "ControlDeviceA" — set a value property
export const PTP_OC_SONY_GetControlDeviceDesc = 0x9206;
export const PTP_OC_SONY_SDIO_ControlDevice = 0x9207; // "ControlDeviceB" — momentary button
export const PTP_OC_SONY_SDIO_GetAllExtDevicePropInfo = 0x9209;

// ── Response codes ─────────────────────────────────────────────────────────
export const PTP_RC_OK = 0x2001;

// ── Standard device property codes used by Sony ────────────────────────────
export const PTP_DPC_WhiteBalance = 0x5005;
export const PTP_DPC_FNumber = 0x5007; // aperture, uint16 = F-number * 100
export const PTP_DPC_FocusMode = 0x500a;
export const PTP_DPC_ExposureProgramMode = 0x500e;
export const PTP_DPC_ExposureBiasCompensation = 0x5010; // int16, milli-EV (1/1000 EV)

// ── Sony vendor device property codes (value properties) ───────────────────
export const PTP_DPC_SONY_ShutterSpeed = 0xd20d; // uint32 = (numerator<<16)|denominator
export const PTP_DPC_SONY_ColorTemp = 0xd20f; // uint16 Kelvin
export const PTP_DPC_SONY_ISO = 0xd21e; // uint32 (low 24 bits = value, 0x00ffffff = AUTO)
export const PTP_DPC_SONY_ExposureCompensation = 0xd224;
export const PTP_DPC_SONY_MovieRecordingState = 0xd21d; // read-back: 0=idle, recording>0

// ── Sony vendor "button" property codes (momentary, via ControlDeviceB) ─────
export const PTP_DPC_SONY_ShutterHalfRelease = 0xd2c1; // autofocus half-press
export const PTP_DPC_SONY_ShutterRelease = 0xd2c2; // full-press capture
export const PTP_DPC_SONY_MovieRecButtonHold = 0xd2c8; // start/stop movie recording
export const PTP_DPC_SONY_CustomWBCapture = 0xd2e1; // one-push / custom white balance

/** Button press/release values used by ControlDeviceB. */
export const SONY_BUTTON_DOWN = 0x0002;
export const SONY_BUTTON_UP = 0x0001;

// ── Container framing ──────────────────────────────────────────────────────

export interface PtpContainer {
  length: number;
  type: number;
  code: number;
  transactionId: number;
  /** Raw payload after the 12-byte header (params for command, data for data). */
  payload: Buffer;
}

/** Build a Command block: 12-byte header followed by up to five uint32 params. */
export function packCommand(code: number, transactionId: number, params: number[] = []): Buffer {
  const buf = Buffer.alloc(PTP_CONTAINER_HEADER_LEN + params.length * 4);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(PTP_CONTAINER_COMMAND, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(transactionId >>> 0, 8);
  params.forEach((p, i) => buf.writeUInt32LE(p >>> 0, PTP_CONTAINER_HEADER_LEN + i * 4));
  return buf;
}

/** Build a Data block: 12-byte header followed by the raw payload. */
export function packData(code: number, transactionId: number, payload: Buffer): Buffer {
  const buf = Buffer.alloc(PTP_CONTAINER_HEADER_LEN + payload.length);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(PTP_CONTAINER_DATA, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(transactionId >>> 0, 8);
  payload.copy(buf, PTP_CONTAINER_HEADER_LEN);
  return buf;
}

/**
 * Parse the leading container out of a buffer. Returns the container plus how
 * many bytes it claimed via its length field. Returns null if fewer than a
 * full header is present.
 */
export function parseContainer(buf: Buffer): PtpContainer | null {
  if (buf.length < PTP_CONTAINER_HEADER_LEN) return null;
  const length = buf.readUInt32LE(0);
  const type = buf.readUInt16LE(4);
  const code = buf.readUInt16LE(6);
  const transactionId = buf.readUInt32LE(8);
  // Clamp the payload to what is actually present (a data phase can be split
  // across several USB transfers; the caller keeps reading until `length`).
  const end = Math.min(Math.max(length, PTP_CONTAINER_HEADER_LEN), buf.length);
  const payload = buf.subarray(PTP_CONTAINER_HEADER_LEN, end);
  return { length, type, code, transactionId, payload };
}

// ── Value encoders ─────────────────────────────────────────────────────────

/** Aperture: F-number → uint16 (F-number * 100). e.g. F2.8 → 280. */
export function encodeFNumber(fNumber: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(Math.round(fNumber * 100) & 0xffff, 0);
  return b;
}

/** ISO sensitivity (manual): uint32, low 24 bits = value. */
export function encodeIso(iso: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(iso & 0x00ffffff, 0);
  return b;
}

/** Shutter speed as a fraction numerator/denominator → uint32 (num<<16)|den. */
export function encodeShutterSpeed(numerator: number, denominator: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE((((numerator & 0xffff) << 16) | (denominator & 0xffff)) >>> 0, 0);
  return b;
}

/** Color temperature in Kelvin → uint16. */
export function encodeColorTemp(kelvin: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(kelvin & 0xffff, 0);
  return b;
}

/** Exposure compensation in milli-EV (e.g. +1 EV = 1000) → int16. */
export function encodeExposureComp(milliEv: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(Math.max(-32768, Math.min(32767, milliEv)), 0);
  return b;
}

/** Momentary button value (down/up) → uint16. */
export function encodeButton(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

/**
 * Map a 0-255 RCP iris position onto an F-number (F1.4 … F22), matching the
 * scale used elsewhere in the bridge.
 */
export function irisPositionToFNumber(position: number): number {
  const clamped = Math.max(0, Math.min(255, position));
  return 1.4 + (clamped / 255) * 20.6;
}

/** Map a master-gain index (0-6) to an ISO sensitivity. */
export const GAIN_INDEX_TO_ISO: Record<number, number> = {
  0: 800,
  1: 1600,
  2: 3200,
  3: 6400,
  4: 12800,
  5: 25600,
  6: 51200,
};

// ── Protocol 3.00, property dump, clock (Sony Camera Control PTP 3 Reference) ─
//
// Verified on a real FX3 (firmware 7.00) with lz-camera-sync on 2026-10-07:
// the 3.00 handshake, the 0x9209 dump (369 properties), a writable 0xD223,
// and that a written value only shows up ~250 ms later.

/** Initiator protocol version for SDIO_GetExtDeviceInfo (0x012C = 3.00). */
export const SONY_PROTOCOL_3 = 0x012c;
/** Write-only string, "YYYYMMDDThhmmss.s±hhmm" (ISO 8601). */
export const PTP_DPC_SONY_DateTimeSet = 0xd223;

/** PTP data type codes used by the Sony descriptors. */
export const DTC = { INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6, INT64: 7, UINT64: 8, STR: 0xffff } as const;

export type PropValue = number | string | number[];

export interface SonyPropDesc {
  code: number;
  dataType: number;
  /** Settable now (Sony's isEnabled byte applied, protocol 3 rules). */
  writable: boolean;
  current: PropValue;
  /** Enumeration form: the values the body offers. */
  values?: PropValue[];
}

class PtpReader {
  constructor(readonly buf: Buffer, public off = 0) {}
  get left(): number { return this.buf.length - this.off; }
  private need(n: number): void { if (this.left < n) throw new RangeError('short PTP data'); }
  u8(): number { this.need(1); return this.buf.readUInt8(this.off++); }
  i8(): number { this.need(1); return this.buf.readInt8(this.off++); }
  u16(): number { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  i16(): number { this.need(2); const v = this.buf.readInt16LE(this.off); this.off += 2; return v; }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  i32(): number { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  u64(): string { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return v.toString(); }
  i64(): string { this.need(8); const v = this.buf.readBigInt64LE(this.off); this.off += 8; return v.toString(); }
  str(): string {
    const n = this.u8();
    if (n === 0) return '';
    this.need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.buf.readUInt16LE(this.off + i * 2);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    this.off += n * 2;
    return s;
  }
}

function readPtpValue(r: PtpReader, type: number): PropValue {
  if (type === DTC.STR) return r.str();
  if (type & 0x4000) {
    const n = r.u32();
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Number(readPtpValue(r, type & ~0x4000)));
    return out;
  }
  switch (type) {
    case DTC.INT8: return r.i8();
    case DTC.UINT8: return r.u8();
    case DTC.INT16: return r.i16();
    case DTC.UINT16: return r.u16();
    case DTC.INT32: return r.i32();
    case DTC.UINT32: return r.u32();
    case DTC.INT64: return r.i64();
    case DTC.UINT64: return r.u64();
    default: throw new Error(`unsupported PTP data type 0x${type.toString(16)}`);
  }
}

function readEnum(r: PtpReader, type: number): PropValue[] {
  const n = r.u16();
  const out: PropValue[] = [];
  for (let i = 0; i < n; i++) out.push(readPtpValue(r, type));
  return out;
}

/**
 * Parse the SDIO_GetAllExtDevicePropInfo (0x9209) dataset: uint32 count,
 * uint32 0, then one Sony descriptor per property (libgphoto2
 * `ptp_unpack_Sony_DPD`, protocol 3 rules). Stops at the first descriptor
 * it cannot read, as libgphoto2 does.
 */
export function parseSonyProps(data: Buffer): Map<number, SonyPropDesc> {
  const out = new Map<number, SonyPropDesc>();
  const r = new PtpReader(data, 8);
  while (r.left > 0) {
    try {
      const code = r.u16();
      const dataType = r.u16();
      const getSet = r.u8();
      const enabled = r.u8();
      readPtpValue(r, dataType); // factory default
      const current = readPtpValue(r, dataType);
      const desc: SonyPropDesc = { code, dataType, writable: getSet === 1 && enabled === 1, current };
      if (r.left >= 1) {
        const form = r.u8();
        if (form === 1) { readPtpValue(r, dataType); readPtpValue(r, dataType); readPtpValue(r, dataType); }
        else if (form === 2) desc.values = readEnum(r, dataType);
        // Bodies from 2024 append a second enum: the values settable now.
        // Without it the next two bytes are already the next property code.
        if (r.left >= 2 && form === 2 && r.buf.readUInt16LE(r.off) < 0x200) desc.values = readEnum(r, dataType);
      }
      out.set(code, desc);
    } catch {
      break;
    }
  }
  return out;
}

/** Encode a value of `dataType` (the inverse of the reader, for 0x9205). */
export function encodePtpValue(dataType: number, value: PropValue): Buffer {
  switch (dataType) {
    case DTC.INT8: { const b = Buffer.alloc(1); b.writeInt8(Number(value)); return b; }
    case DTC.UINT8: { const b = Buffer.alloc(1); b.writeUInt8(Number(value) & 0xff); return b; }
    case DTC.INT16: { const b = Buffer.alloc(2); b.writeInt16LE(Number(value)); return b; }
    case DTC.UINT16: { const b = Buffer.alloc(2); b.writeUInt16LE(Number(value) & 0xffff); return b; }
    case DTC.INT32: { const b = Buffer.alloc(4); b.writeInt32LE(Number(value)); return b; }
    case DTC.UINT32: { const b = Buffer.alloc(4); b.writeUInt32LE(Number(value) >>> 0); return b; }
    case DTC.INT64: { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value as string)); return b; }
    case DTC.UINT64: { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value as string)); return b; }
    case DTC.STR: return encodePtpString(String(value));
    default: throw new Error(`unsupported PTP data type 0x${dataType.toString(16)}`);
  }
}

/** PTP string: uint8 length in UCS-2 chars incl. terminator, then UCS-2LE. */
export function encodePtpString(s: string): Buffer {
  if (s.length === 0) return Buffer.from([0]);
  const chars = [...s].slice(0, 254);
  const b = Buffer.alloc(1 + (chars.length + 1) * 2);
  b.writeUInt8(chars.length + 1, 0);
  chars.forEach((ch, i) => b.writeUInt16LE(ch.charCodeAt(0), 1 + i * 2));
  return b;
}

/** 0xD223 value: "YYYYMMDDThhmmss.s±hhmm" in local time (or +0000 with utc). */
export function sonyDateTimeString(d: Date, utc = false): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const parts = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const off = utc ? 0 : -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
  return `${parts[0]}${p(parts[1])}${p(parts[2])}T${p(parts[3])}${p(parts[4])}${p(parts[5])}.${Math.floor(d.getMilliseconds() / 100)}${zone}`;
}
