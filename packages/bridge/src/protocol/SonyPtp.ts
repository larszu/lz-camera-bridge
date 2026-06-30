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
