/**
 * Sony PTP/USB Camera Control Client
 *
 * Real control of Sony Alpha / Cinema-Line cameras (FX3, FX6, A7 …) over USB
 * using the Sony PTP vendor extension (see protocol/SonyPtp.ts). No proprietary
 * Sony SDK is required — the bulk transfers go straight to the camera through
 * the optional native `usb` (libusb) module.
 *
 * The handshake (protocol 3.00 with retry), confirmed writes, buttons and the
 * RCP mapping live in `SonyPtpClient`, shared with the network path
 * (`SonyPtpIpClient`). This file is only the USB transport: claim the
 * Still-Image interface and move PTP containers over the bulk endpoints.
 *
 * NOTE: the camera must be set to "PC Remote" (USB control) mode. On Windows the
 * libusb path needs a WinUSB driver bound to the camera (e.g. via Zadig); this
 * conflicts with Sony's own driver, so only one control stack can own the device
 * at a time. Hardware-specific value encodings (shutter table, WB) can vary by
 * model and may need per-model tuning.
 */

import {
  packCommand,
  packData,
  parseContainer,
  PTP_CONTAINER_DATA,
  PTP_CONTAINER_RESPONSE,
  PTP_CONTAINER_HEADER_LEN,
  PTP_RC_OK,
} from '../protocol/SonyPtp.js';
import { SonyPtpClient, type SonyPtpState } from './SonyPtpClient.js';

export type { SonyPtpState };

const SONY_VENDOR_ID = 0x054c;
const USB_CLASS_STILL_IMAGE = 6; // PTP interface class
const BULK_READ_SIZE = 16384;
const TRANSFER_TIMEOUT_MS = 4000;

export interface SonyPtpTarget {
  id: string; // "usb:<bus>.<address>"
  model: string;
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

export class SonyPtpUsbClient extends SonyPtpClient {
  private device: any = null;
  private iface: any = null;
  private epOut: any = null;
  private epIn: any = null;
  private transactionId = 0;

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

    this.transactionId = 0;
    await this.handshake();

    this.connected = true;
    this.emit('connected', target);
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      await this.closeSession();
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
  protected async transaction(opcode: number, params: number[], dataOut?: Buffer): Promise<Buffer | null> {
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
}
