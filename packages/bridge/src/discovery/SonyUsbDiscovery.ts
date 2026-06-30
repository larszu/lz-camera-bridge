/**
 * Sony USB Camera Discovery
 *
 * Real USB device enumeration for Sony cameras (FX3, FX6, FX9, A7 series, …).
 *
 * Sony imaging products use USB vendor id 0x054C. When a camera is set to
 * "PC Remote" (USB control) mode it enumerates as a Sony USB device whose
 * product string contains the model name (e.g. "ILME-FX3").
 *
 * This module performs the enumeration with the optional native `usb`
 * (libusb) package. The dependency is loaded lazily so the bridge keeps
 * building and running on machines where the native module is not installed —
 * in that case discovery returns an empty list together with a human readable
 * `reason`, instead of the previous fake demo device.
 *
 * To get real results, install the optional dependency on the target machine:
 *     npm install usb --workspace=packages/bridge
 * and put the camera into Menu → Network → USB → "PC Remote" (or
 * "USB Streaming" depending on the model).
 */

export const SONY_VENDOR_ID = 0x054c;

export interface SonyUsbDevice {
  /** Stable identifier: usb:<bus>.<address> */
  id: string;
  model: string;
  serialNumber: string;
  connectionType: 'usb';
  vendorId: number;
  productId: number;
  /** True when the model is in the known supported list */
  supported: boolean;
}

export interface SonyUsbDiscoveryResult {
  devices: SonyUsbDevice[];
  /** Set when discovery could not run (missing native module, no access, …) */
  reason?: string;
}

/**
 * Known Sony camera USB product ids in PC-Remote / control mode.
 * PIDs can vary by firmware and USB mode, so this map is only used as a
 * friendly fallback when the product string descriptor cannot be read.
 */
const KNOWN_PRODUCT_IDS: Record<number, string> = {
  0x0d97: 'ILME-FX3',
  0x0ddc: 'ILME-FX6',
  0x0c2a: 'PXW-FX9',
  0x0e62: 'ILCE-7M4 (A7 IV)',
  0x0c34: 'ILCE-7SM3 (A7S III)',
  0x0e0b: 'ILCE-7RM5 (A7R V)',
  0x0d9f: 'ZV-E1',
  0x0d7e: 'ILCE-1 (A1)',
};

/** Models we can reasonably claim to support via the control path. */
function isSupportedModel(model: string): boolean {
  return /FX3|FX6|FX9|ILCE|ILME|ZV-E|A7|A1/i.test(model);
}

/** Minimal shape of the parts of the native `usb` module we use. */
interface UsbModule {
  getDeviceList(): any[];
}

let cachedUsb: UsbModule | null | undefined;

/** Lazily load the optional native `usb` module; returns null when absent. */
async function loadUsb(): Promise<UsbModule | null> {
  if (cachedUsb !== undefined) return cachedUsb;
  try {
    // Indirection through a variable keeps the specifier non-literal so the
    // optional native module is not resolved at build time — the bridge
    // builds and runs even when `usb` is not installed.
    const moduleName = 'usb';
    cachedUsb = (await import(moduleName)) as unknown as UsbModule;
  } catch {
    cachedUsb = null;
  }
  return cachedUsb;
}

/** Promisified string-descriptor read; resolves to undefined on any failure. */
function readStringDescriptor(device: any, index: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!index) return resolve(undefined);
    try {
      device.getStringDescriptor(index, (err: unknown, value?: string) => {
        resolve(err || !value ? undefined : value.trim());
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Enumerate connected Sony USB cameras.
 *
 * Never throws — failures are reported through the `reason` field so the
 * caller (and ultimately the UI) can show why no devices were found.
 */
export async function discoverSonyUsbCameras(): Promise<SonyUsbDiscoveryResult> {
  const usbModule = await loadUsb();
  if (!usbModule) {
    return {
      devices: [],
      reason:
        'Native USB-Modul nicht installiert. Auf dem Zielrechner ausführen: ' +
        'npm install usb --workspace=packages/bridge',
    };
  }

  let rawDevices: any[];
  try {
    rawDevices = usbModule.getDeviceList();
  } catch (err) {
    return { devices: [], reason: `USB-Zugriff fehlgeschlagen: ${(err as Error).message}` };
  }

  const sonyDevices = rawDevices.filter(
    (d) => d?.deviceDescriptor?.idVendor === SONY_VENDOR_ID,
  );

  if (sonyDevices.length === 0) {
    return {
      devices: [],
      reason:
        'Keine Sony-Kamera am USB gefunden. Kamera einschalten und in den ' +
        'Modus „PC Remote" (USB-Steuerung) versetzen.',
    };
  }

  const devices: SonyUsbDevice[] = [];
  for (const dev of sonyDevices) {
    const desc = dev.deviceDescriptor;
    const productId: number = desc.idProduct;
    const bus: number = dev.busNumber ?? 0;
    const address: number = dev.deviceAddress ?? 0;

    let model: string | undefined;
    let serialNumber: string | undefined;

    // Reading the product/serial strings needs the device opened. This can
    // fail when another driver (e.g. the Sony SDK) already claims it — in
    // that case we still report the device using the PID fallback.
    let opened = false;
    try {
      dev.open();
      opened = true;
      model = await readStringDescriptor(dev, desc.iProduct);
      serialNumber = await readStringDescriptor(dev, desc.iSerialNumber);
    } catch {
      /* keep fallbacks */
    } finally {
      if (opened) {
        try {
          dev.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (!model) {
      model =
        KNOWN_PRODUCT_IDS[productId] ??
        `Sony Camera (PID 0x${productId.toString(16).padStart(4, '0')})`;
    }

    devices.push({
      id: `usb:${bus}.${address}`,
      model,
      serialNumber: serialNumber ?? '',
      connectionType: 'usb',
      vendorId: SONY_VENDOR_ID,
      productId,
      supported: isSupportedModel(model),
    });
  }

  return { devices };
}
