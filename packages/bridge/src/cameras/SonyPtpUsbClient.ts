/**
 * Sony PTP/USB Camera Control Client
 *
 * Real control of Sony Alpha / Cinema-Line cameras (FX3, FX6, A7 …) over USB
 * using the Sony PTP vendor extension (see protocol/SonyPtp.ts). No proprietary
 * Sony SDK is required — the bulk transfers go straight to the camera through
 * the optional native `usb` (libusb) module.
 *
 * Connection sequence (matches libgphoto2's Sony init):
 *   1. OpenSession
 *   2. SDIO_Connect(1) / SDIO_Connect(2)
 *   3. SDIO_GetExtDeviceInfo(version) — pulls the vendor property list
 *   4. SDIO_Connect(3)
 * After that, value properties are set with ControlDeviceA (0x9205) and
 * momentary buttons (capture, record, AF) with ControlDeviceB (0x9207).
 *
 * NOTE: the camera must be set to "PC Remote" (USB control) mode. On Windows the
 * libusb path needs a WinUSB driver bound to the camera (e.g. via Zadig); this
 * conflicts with Sony's own driver, so only one control stack can own the device
 * at a time. Hardware-specific value encodings (shutter table, WB) can vary by
 * model and may need per-model tuning.
 */

import { EventEmitter } from 'events';
import {
  packCommand,
  packData,
  parseContainer,
  PTP_CONTAINER_DATA,
  PTP_CONTAINER_RESPONSE,
  PTP_CONTAINER_HEADER_LEN,
  PTP_RC_OK,
  PTP_OC_OpenSession,
  PTP_OC_CloseSession,
  PTP_OC_SONY_SDIO_Connect,
  PTP_OC_SONY_SDIO_GetExtDeviceInfo,
  PTP_OC_SONY_SDIO_SetExtDevicePropValue,
  PTP_OC_SONY_SDIO_ControlDevice,
  PTP_DPC_FNumber,
  PTP_DPC_SONY_ISO,
  PTP_DPC_SONY_ShutterSpeed,
  PTP_DPC_SONY_ColorTemp,
  PTP_DPC_SONY_ShutterRelease,
  PTP_DPC_SONY_ShutterHalfRelease,
  PTP_DPC_SONY_MovieRecButtonHold,
  PTP_DPC_SONY_CustomWBCapture,
  SONY_BUTTON_DOWN,
  SONY_BUTTON_UP,
  encodeFNumber,
  encodeIso,
  encodeShutterSpeed,
  encodeColorTemp,
  encodeButton,
  irisPositionToFNumber,
  GAIN_INDEX_TO_ISO,
} from '../protocol/SonyPtp.js';

const SONY_VENDOR_ID = 0x054c;
const USB_CLASS_STILL_IMAGE = 6; // PTP interface class
const BULK_READ_SIZE = 16384;
const TRANSFER_TIMEOUT_MS = 4000;

export interface SonyPtpTarget {
  id: string; // "usb:<bus>.<address>"
  model: string;
}

export interface SonyPtpState {
  iris: number; // 0-255 RCP scale
  masterGain: number; // gain index 0-6
  shutterSpeed: number;
  colorTemperature: number;
  recording: boolean;
}

/** Lazily load the optional native `usb` module; returns null when absent. */
async function loadUsb(): Promise<any | null> {
  try {
    const moduleName = 'usb';
    return await import(moduleName);
  } catch {
    return null;
  }
}

export class SonyPtpUsbClient extends EventEmitter {
  private device: any = null;
  private iface: any = null;
  private epOut: any = null;
  private epIn: any = null;
  private transactionId = 0;
  private connected = false;

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

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(target: SonyPtpTarget): Promise<void> {
    const usb = await loadUsb();
    if (!usb) {
      throw new Error(
        'Native USB-Modul nicht installiert: npm install usb --workspace=packages/bridge',
      );
    }

    this.device = this.findDevice(usb, target.id);
    if (!this.device) {
      throw new Error(`Sony-Kamera ${target.model} (${target.id}) nicht mehr am USB`);
    }

    this.device.open();
    this.claimStillImageInterface();

    // PTP + Sony handshake.
    this.transactionId = 0;
    await this.transaction(PTP_OC_OpenSession, [1]);
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [1, 0, 0]);
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [2, 0, 0]);
    await this.transaction(PTP_OC_SONY_SDIO_GetExtDeviceInfo, [0xc8]); // pulls vendor prop list (ignored)
    await this.transaction(PTP_OC_SONY_SDIO_Connect, [3, 0, 0]);

    this.connected = true;
    this.emit('connected', target);
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      try {
        if (this.connected) await this.transaction(PTP_OC_CloseSession, []);
      } catch {
        /* ignore */
      }
      try {
        this.iface?.release(true, () => {});
      } catch {
        /* ignore */
      }
      try {
        this.device.close();
      } catch {
        /* ignore */
      }
    }
    this.device = null;
    this.iface = null;
    this.epOut = null;
    this.epIn = null;
    this.connected = false;
    this.emit('disconnected');
  }

  private findDevice(usb: any, id: string): any {
    const list: any[] = usb.getDeviceList();
    const m = /^usb:(\d+)\.(\d+)$/.exec(id);
    const sony = list.filter((d) => d?.deviceDescriptor?.idVendor === SONY_VENDOR_ID);
    if (m) {
      const [bus, addr] = [Number(m[1]), Number(m[2])];
      const exact = sony.find((d) => (d.busNumber ?? 0) === bus && (d.deviceAddress ?? 0) === addr);
      if (exact) return exact;
    }
    return sony[0] ?? null;
  }

  private claimStillImageInterface(): void {
    const interfaces: any[] = this.device.interfaces ?? [];
    this.iface =
      interfaces.find((i) => i.descriptor?.bInterfaceClass === USB_CLASS_STILL_IMAGE) ??
      interfaces[0];
    if (!this.iface) throw new Error('Kein PTP-Interface auf der Kamera gefunden');

    // Linux/macOS may have a kernel driver attached — detach so we can claim.
    try {
      if (typeof this.iface.isKernelDriverActive === 'function' && this.iface.isKernelDriverActive()) {
        this.iface.detachKernelDriver();
      }
    } catch {
      /* not supported on this platform */
    }
    this.iface.claim();

    const endpoints: any[] = this.iface.endpoints ?? [];
    this.epOut = endpoints.find((e) => e.direction === 'out');
    this.epIn = endpoints.find((e) => e.direction === 'in' && e.transferType !== 3 /* not interrupt */);
    if (!this.epOut || !this.epIn) throw new Error('PTP Bulk-Endpunkte nicht gefunden');
  }

  // ── Low-level bulk transfer ────────────────────────────────────────────────

  private writeBulk(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('USB write timeout')), TRANSFER_TIMEOUT_MS);
      this.epOut.transfer(buf, (err: unknown) => {
        clearTimeout(timer);
        err ? reject(err as Error) : resolve();
      });
    });
  }

  private readBulk(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('USB read timeout')), TRANSFER_TIMEOUT_MS);
      this.epIn.transfer(BULK_READ_SIZE, (err: unknown, data: Buffer) => {
        clearTimeout(timer);
        err ? reject(err as Error) : resolve(data);
      });
    });
  }

  /**
   * Run one PTP transaction: Command → optional Data-out → Response.
   * Returns the data-in payload (if the camera sent one) or null.
   */
  private async transaction(opcode: number, params: number[], dataOut?: Buffer): Promise<Buffer | null> {
    if (!this.epOut || !this.epIn) throw new Error('Not connected');
    const tid = ++this.transactionId;

    await this.writeBulk(packCommand(opcode, tid, params));
    if (dataOut) await this.writeBulk(packData(opcode, tid, dataOut));

    let chunk = await this.readBulk();
    let container = parseContainer(chunk);
    if (!container) throw new Error('Leere PTP-Antwort');

    let dataIn: Buffer | null = null;
    if (container.type === PTP_CONTAINER_DATA) {
      // Gather a possibly multi-transfer data phase.
      let full = chunk;
      while (full.length < container.length) {
        full = Buffer.concat([full, await this.readBulk()]);
      }
      dataIn = full.subarray(PTP_CONTAINER_HEADER_LEN, container.length);
      chunk = await this.readBulk();
      container = parseContainer(chunk);
      if (!container) throw new Error('Fehlende PTP-Response nach Datenphase');
    }

    if (container.type !== PTP_CONTAINER_RESPONSE) {
      throw new Error(`Unerwarteter PTP-Container-Typ 0x${container.type.toString(16)}`);
    }
    if (container.code !== PTP_RC_OK) {
      throw new Error(`PTP-Fehler 0x${container.code.toString(16)} (op 0x${opcode.toString(16)})`);
    }
    return dataIn;
  }

  /** Set a value property (ControlDeviceA / 0x9205). */
  private setControlA(propCode: number, value: Buffer): Promise<Buffer | null> {
    return this.transaction(PTP_OC_SONY_SDIO_SetExtDevicePropValue, [propCode], value);
  }

  /** Press a momentary button property (ControlDeviceB / 0x9207). */
  private async pressButton(propCode: number, hold = 60): Promise<void> {
    await this.transaction(PTP_OC_SONY_SDIO_ControlDevice, [propCode], encodeButton(SONY_BUTTON_DOWN));
    await new Promise((r) => setTimeout(r, hold));
    await this.transaction(PTP_OC_SONY_SDIO_ControlDevice, [propCode], encodeButton(SONY_BUTTON_UP));
  }

  // ── High-level control ─────────────────────────────────────────────────────

  async setIrisPosition(position: number): Promise<void> {
    await this.setControlA(PTP_DPC_FNumber, encodeFNumber(irisPositionToFNumber(position)));
    this.state.iris = position;
    this.emitState();
  }

  async setGainIndex(index: number): Promise<void> {
    const iso = GAIN_INDEX_TO_ISO[index] ?? 800;
    await this.setControlA(PTP_DPC_SONY_ISO, encodeIso(iso));
    this.state.masterGain = index;
    this.emitState();
  }

  /** Sets shutter to 1/denominator. */
  async setShutterDenominator(denominator: number): Promise<void> {
    if (denominator <= 0) return;
    await this.setControlA(PTP_DPC_SONY_ShutterSpeed, encodeShutterSpeed(1, denominator));
    this.state.shutterSpeed = denominator;
    this.emitState();
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    await this.setControlA(PTP_DPC_SONY_ColorTemp, encodeColorTemp(kelvin));
    this.state.colorTemperature = kelvin;
    this.emitState();
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
   * the USB/PTP path does not support (so the caller can report it).
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
      case 'setNdFilter':
      case 'setBars':
        // No PTP property exposed for these on Alpha/Cinema bodies.
        console.log(`[SonyPTP] '${cmd}' wird über USB/PTP nicht unterstützt`);
        return false;
      default:
        console.log(`[SonyPTP] Unbekanntes Kommando: ${cmd}`);
        return false;
    }
  }

  private emitState(): void {
    this.emit('stateChanged', { ...this.state });
  }
}
