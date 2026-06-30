/**
 * HID Control-Surface Input Adapter
 *
 * Turns a USB control panel (knobs / faders / buttons) into an *input* for the
 * bridge: instead of the bridge controlling a camera, the panel drives the
 * bridge's RCP command bus, so one physical surface controls whatever camera is
 * currently connected — Sony, Canon, Lumix, Blackmagic, PTZ, … all at once.
 *
 * This is the integration path for a Blackmagic (or any) USB-C control panel.
 * Because every panel reports a different HID layout, the mapping from report
 * bytes to commands is data-driven (see HidBinding); the user picks their
 * device and tunes the mapping to its report format. The native `node-hid`
 * module is optional and loaded lazily, so the bridge runs without it.
 */
import { EventEmitter } from 'events';

export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  path?: string;
}

export interface HidBinding {
  kind: 'axis' | 'button';
  /** Byte offset of the value within the HID input report. */
  offset: number;
  /** Number of bytes for an axis value (1 or 2, little-endian). Default 1. */
  bytes?: number;
  /** RCP command to emit, e.g. 'setIris'. */
  command: string;
  /** Param key for an axis value (scaled to 0-255), e.g. 'value'. */
  paramKey?: string;
  /** Extra static params merged into the emitted command (e.g. { on: true }). */
  params?: Record<string, unknown>;
  /** Raw axis range mapped onto 0-255. Defaults to 0..255. */
  min?: number;
  max?: number;
}

export interface HidSurfaceConfig {
  vendorId: number;
  productId: number;
  path?: string;
  bindings: HidBinding[];
}

/** A reasonable starting mapping — almost certainly needs tuning per panel. */
export const DEFAULT_BINDINGS: HidBinding[] = [
  { kind: 'axis', offset: 1, command: 'setIris', paramKey: 'value' },
  { kind: 'axis', offset: 2, command: 'setMasterGain', paramKey: 'value', max: 7 },
  { kind: 'axis', offset: 3, bytes: 2, command: 'setColorTemp', paramKey: 'value', min: 0, max: 65535 },
  { kind: 'button', offset: 5, command: 'setRecording', params: { on: true } },
];

async function loadHid(): Promise<any | null> {
  try {
    const moduleName = 'node-hid';
    return await import(moduleName);
  } catch {
    return null;
  }
}

/** Enumerate connected HID devices so the user can pick their control panel. */
export async function listHidDevices(): Promise<{ devices: HidDeviceInfo[]; reason?: string }> {
  const hid = await loadHid();
  if (!hid) {
    return {
      devices: [],
      reason: 'Natives Modul fehlt: npm install node-hid --workspace=packages/bridge',
    };
  }
  try {
    const list = (hid.devices() as any[]).map((d) => ({
      vendorId: d.vendorId,
      productId: d.productId,
      product: d.product,
      manufacturer: d.manufacturer,
      path: d.path,
    }));
    return { devices: list };
  } catch (err) {
    return { devices: [], reason: `HID-Zugriff fehlgeschlagen: ${(err as Error).message}` };
  }
}

export class HidControlSurface extends EventEmitter {
  private device: any = null;
  private bindings: HidBinding[];
  private vendorId: number;
  private productId: number;
  private path?: string;
  private last = new Map<number, number>(); // offset → previous raw value
  private running = false;

  constructor(config: HidSurfaceConfig) {
    super();
    this.vendorId = config.vendorId;
    this.productId = config.productId;
    this.path = config.path;
    this.bindings = config.bindings?.length ? config.bindings : DEFAULT_BINDINGS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    const hid = await loadHid();
    if (!hid) {
      throw new Error('Natives Modul fehlt: npm install node-hid --workspace=packages/bridge');
    }
    this.device = this.path ? new hid.HID(this.path) : new hid.HID(this.vendorId, this.productId);
    this.device.on('data', (buf: Buffer) => this.onReport(buf));
    this.device.on('error', (err: Error) => this.emit('error', err));
    this.running = true;
    this.emit('started', { vendorId: this.vendorId, productId: this.productId });
  }

  stop(): void {
    try {
      this.device?.close();
    } catch {
      /* ignore */
    }
    this.device = null;
    this.running = false;
    this.last.clear();
    this.emit('stopped');
  }

  private readRaw(buf: Buffer, b: HidBinding): number {
    if ((b.bytes ?? 1) === 2) {
      return b.offset + 1 < buf.length ? buf.readUInt16LE(b.offset) : 0;
    }
    return b.offset < buf.length ? buf[b.offset] : 0;
  }

  private onReport(buf: Buffer): void {
    for (const b of this.bindings) {
      const raw = this.readRaw(buf, b);
      const prev = this.last.get(b.offset);
      if (prev === raw) continue;
      this.last.set(b.offset, raw);

      if (b.kind === 'axis') {
        const min = b.min ?? 0;
        const max = b.max ?? 255;
        const scaled = Math.max(0, Math.min(255, Math.round(((raw - min) / (max - min || 1)) * 255)));
        this.emit('command', { cmd: b.command, params: { [b.paramKey ?? 'value']: scaled, ...(b.params ?? {}) } });
      } else {
        // Button: emit on rising edge only.
        if ((prev ?? 0) === 0 && raw !== 0) {
          this.emit('command', { cmd: b.command, params: { ...(b.params ?? {}) } });
        }
      }
    }
  }
}
