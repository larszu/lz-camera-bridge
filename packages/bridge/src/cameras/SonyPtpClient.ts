/**
 * Sony PTP camera control — the part shared by every transport.
 *
 * USB (`SonyPtpUsbClient`) and network (`SonyPtpIpClient`, PTP/IP with
 * optional SSH) differ only in how one PTP transaction travels. Everything
 * above that lives here: the SDIO handshake, writing a value, buttons, the
 * clock and the RCP command mapping.
 *
 * Behaviour from Sony's Camera Control PTP 3 Reference, checked on a real
 * FX3 (firmware 7.00) with lz-camera-sync on 2026-10-07:
 *  - handshake with protocol 3.00 (0x012C); SDIO_GetExtDeviceInfo may answer
 *    with no data at first — "retry until successful";
 *  - a written value shows up in GetAllExtDevicePropInfo only ~250 ms later,
 *    so every write waits until the camera reports it (bounded);
 *  - after an exposure-mode change wait 500 ms before exposure values;
 *  - the clock (0xD223) is a string "YYYYMMDDThhmmss.s±hhmm".
 */

import { EventEmitter } from 'events';
import {
  PTP_OC_OpenSession,
  PTP_OC_CloseSession,
  PTP_OC_SONY_SDIO_Connect,
  PTP_OC_SONY_SDIO_GetExtDeviceInfo,
  PTP_OC_SONY_SDIO_GetAllExtDevicePropInfo,
  PTP_OC_SONY_SDIO_SetExtDevicePropValue,
  PTP_OC_SONY_SDIO_ControlDevice,
  PTP_DPC_FNumber,
  PTP_DPC_ExposureProgramMode,
  PTP_DPC_SONY_ISO,
  PTP_DPC_SONY_ShutterSpeed,
  PTP_DPC_SONY_ColorTemp,
  PTP_DPC_SONY_ShutterRelease,
  PTP_DPC_SONY_ShutterHalfRelease,
  PTP_DPC_SONY_MovieRecButtonHold,
  PTP_DPC_SONY_CustomWBCapture,
  PTP_DPC_SONY_DateTimeSet,
  SONY_BUTTON_DOWN,
  SONY_BUTTON_UP,
  SONY_PROTOCOL_3,
  DTC,
  encodeFNumber,
  encodeIso,
  encodeShutterSpeed,
  encodeColorTemp,
  encodeButton,
  encodePtpValue,
  irisPositionToFNumber,
  parseSonyProps,
  sonyDateTimeString,
  GAIN_INDEX_TO_ISO,
  type SonyPropDesc,
} from '../protocol/SonyPtp.js';

export interface SonyPtpState {
  iris: number; // 0-255 RCP scale
  masterGain: number; // gain index 0-6
  shutterSpeed: number;
  colorTemperature: number;
  recording: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export abstract class SonyPtpClient extends EventEmitter {
  protected connected = false;
  /** Pause after an exposure-mode change (Sony reference: 500 ms). */
  settleMs = 500;
  /** How long a write may take to show up before we stop waiting (FX3: ~250 ms). */
  confirmMs = 2000;

  readonly state: SonyPtpState = {
    iris: 128,
    masterGain: 0,
    shutterSpeed: 60,
    colorTemperature: 5600,
    recording: false,
  };

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * One PTP transaction: command (+ optional data-out) → optional data-in →
   * response. Resolves with the data-in payload (or null) and throws when the
   * response is not OK.
   */
  protected abstract transaction(opcode: number, params: number[], dataOut?: Buffer): Promise<Buffer | null>;

  /** OpenSession + SDIO handshake as in Sony's "Authentication Sequence". */
  protected async handshake(): Promise<void> {
    await this.transaction(PTP_OC_OpenSession, [1]);
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [1, 0, 0]);
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [2, 0, 0]);
    // "When SDIO_GetExtDeviceInfo fails (returned data size is zero), retry
    // until successful." Bounded, so a dead camera ends in an error.
    let info: Buffer | null = null;
    for (let i = 0; i < 30 && !(info && info.length >= 2); i++) {
      info = await this.transaction(PTP_OC_SONY_SDIO_GetExtDeviceInfo, [SONY_PROTOCOL_3, 1]);
      if (!(info && info.length >= 2)) await sleep(100);
    }
    if (!(info && info.length >= 2)) throw new Error('Kamera meldet keine Protokollversion (SDIO_GetExtDeviceInfo)');
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [3, 0, 0]);
  }

  protected async closeSession(): Promise<void> {
    try {
      if (this.connected) await this.transaction(PTP_OC_CloseSession, []);
    } catch {
      /* ignore */
    }
  }

  /** Every property with its current value (SDIO_GetAllExtDevicePropInfo). */
  async readProps(): Promise<Map<number, SonyPropDesc>> {
    const data = await this.transaction(PTP_OC_SONY_SDIO_GetAllExtDevicePropInfo, []);
    return data ? parseSonyProps(data) : new Map();
  }

  /**
   * Set a value property (ControlDeviceA / 0x9205) and wait until the camera
   * shows the change: the exact value, or — where the body snaps a slider
   * value to the nearest one it offers — any value other than before.
   * Returns false when nothing showed up within `confirmMs`; the caller then
   * knows only what it commanded.
   */
  protected async setControlA(propCode: number, value: Buffer, expect?: number | string): Promise<boolean> {
    const before = expect === undefined ? undefined : (await this.readProps()).get(propCode)?.current;
    await this.transaction(PTP_OC_SONY_SDIO_SetExtDevicePropValue, [propCode], value);
    let confirmed = true;
    if (expect !== undefined && before !== undefined && String(before) !== String(expect)) {
      confirmed = false;
      const until = Date.now() + this.confirmMs;
      for (;;) {
        const now = (await this.readProps()).get(propCode)?.current;
        confirmed = now === undefined || String(now) === String(expect) || String(now) !== String(before);
        if (confirmed || Date.now() >= until) break;
        await sleep(50);
      }
    }
    if (propCode === PTP_DPC_ExposureProgramMode && this.settleMs > 0) await sleep(this.settleMs);
    return confirmed;
  }

  /** Press a momentary button property (ControlDeviceB / 0x9207). */
  protected async pressButton(propCode: number, hold = 60): Promise<void> {
    await this.transaction(PTP_OC_SONY_SDIO_ControlDevice, [propCode], encodeButton(SONY_BUTTON_DOWN));
    await sleep(hold);
    await this.transaction(PTP_OC_SONY_SDIO_ControlDevice, [propCode], encodeButton(SONY_BUTTON_UP));
  }

  // ── High-level control ─────────────────────────────────────────────────

  async setIrisPosition(position: number): Promise<void> {
    const f = Math.round(irisPositionToFNumber(position) * 100) & 0xffff;
    await this.setControlA(PTP_DPC_FNumber, encodeFNumber(irisPositionToFNumber(position)), f);
    this.state.iris = position;
    this.emitState();
  }

  async setGainIndex(index: number): Promise<void> {
    const iso = GAIN_INDEX_TO_ISO[index] ?? 800;
    await this.setControlA(PTP_DPC_SONY_ISO, encodeIso(iso), iso & 0x00ffffff);
    this.state.masterGain = index;
    this.emitState();
  }

  /** Sets shutter to 1/denominator. */
  async setShutterDenominator(denominator: number): Promise<void> {
    if (denominator <= 0) return;
    await this.setControlA(PTP_DPC_SONY_ShutterSpeed, encodeShutterSpeed(1, denominator), ((1 << 16) | (denominator & 0xffff)) >>> 0);
    this.state.shutterSpeed = denominator;
    this.emitState();
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    await this.setControlA(PTP_DPC_SONY_ColorTemp, encodeColorTemp(kelvin), kelvin & 0xffff);
    this.state.colorTemperature = kelvin;
    this.emitState();
  }

  /** Set the camera clock to `now` (0xD223, ISO 8601 string). */
  async setClock(now = new Date(), utc = false): Promise<void> {
    await this.setControlA(PTP_DPC_SONY_DateTimeSet, encodePtpValue(DTC.STR, sonyDateTimeString(now, utc)));
  }

  async executeAutoWhiteBalance(): Promise<void> {
    await this.pressButton(PTP_DPC_SONY_CustomWBCapture);
  }

  async autoFocus(): Promise<void> {
    await this.pressButton(PTP_DPC_SONY_ShutterHalfRelease, 200);
  }

  async capture(): Promise<void> {
    await this.pressButton(PTP_DPC_SONY_ShutterRelease);
  }

  /** Toggle movie recording (the rec button is a single momentary toggle). */
  async setRecording(on: boolean): Promise<void> {
    await this.pressButton(PTP_DPC_SONY_MovieRecButtonHold);
    this.state.recording = on;
    this.emitState();
  }

  /**
   * Map dashboard RCP commands onto camera control. Returns false for commands
   * the PTP path does not support (so the caller can report it).
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris':
        await this.setIrisPosition(num('value'));
        return true;
      case 'setMasterGain':
        await this.setGainIndex(num('value'));
        return true;
      case 'setShutterSpeed':
        await this.setShutterDenominator(num('value'));
        return true;
      case 'setColorTemp':
        await this.setColorTemperature(num('value', 5600));
        return true;
      case 'autoWhiteBalance':
        await this.executeAutoWhiteBalance();
        return true;
      case 'setRecording':
        await this.setRecording(Boolean(params['on']));
        return true;
      case 'setClock':
        await this.setClock(new Date(), Boolean(params['utc']));
        return true;
      case 'setNdFilter':
      case 'setBars':
        // No PTP property exposed for these on Alpha/Cinema bodies.
        console.log(`[SonyPTP] '${cmd}' wird über PTP nicht unterstützt`);
        return false;
      default:
        console.log(`[SonyPTP] Unbekanntes Kommando: ${cmd}`);
        return false;
    }
  }

  protected emitState(): void {
    this.emit('stateChanged', { ...this.state });
  }
}
