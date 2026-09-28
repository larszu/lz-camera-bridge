/**
 * Camera backend factory.
 *
 * Builds the right camera client for a per-camera connection config and returns
 * it behind one uniform CameraBackend interface, together with a state-mapper
 * that normalises whatever the client emits into the dashboard's CameraState.
 * This is what lets the BridgeServer hold many cameras at once and route by
 * number without a per-type branch.
 */
import { EventEmitter } from 'events';
import { CcuClient, CameraState } from '../protocol/CcuClient.js';
import { LumixClient } from '../protocol/LumixClient.js';
import { SonyPtpUsbClient, SonyPtpState } from './SonyPtpUsbClient.js';
import { BMDeviceClient, BMCameraState } from './BMDeviceClient.js';
import { SonyMncClient, MncCameraState } from './SonyMncClient.js';
import { CanonCcapiClient } from './CanonCcapiClient.js';
import { ZCamClient } from './ZCamClient.js';
import { PanasonicPtzClient } from './PanasonicPtzClient.js';
import { ViscaClient } from './ViscaClient.js';
import { JvcClient } from './JvcClient.js';
import { BirddogClient } from './BirddogClient.js';
import { HttpCgiClient, CgiFamily } from './HttpCgiClient.js';
import { DemoCameraClient } from './DemoCameraClient.js';
import { B4LensClient } from './B4LensClient.js';
import { DjiOsmoClient } from './DjiOsmoClient.js';
import { DjiRoninClient } from './DjiRoninClient.js';

export type ConnectionMode =
  | 'tcp' | 'serial' | 'lumix-http' | 'sony-usb' | 'blackmagic' | 'sony-mnc' | 'canon-ccapi'
  | 'zcam' | 'panasonic-ptz' | 'visca' | 'visca-serial' | 'jvc' | 'birddog' | 'http-cgi'
  // Gimbals. Sie tragen kein Bild, sie bewegen nur den Kopf -- Blende und
  // Gain gehoeren der Kamera darauf.
  // (Kein Semikolon in diesem Block: valueOrigin.test.ts liest die Union
  // bis zum ersten, und ein Semikolon im Kommentar schnitte sie ab.)
  | 'dji-osmo' | 'dji-ronin'
  // A B4 LENS, not a camera: the ESP32-S3 interface from
  // `packages/firmware-b4`, sitting in the Hirose 12-pin cable. Iris is
  // the only thing that connector can command -- and this is the only
  // path here whose readback is an independent measurement (pin 7),
  // not an echo of what we sent (pin 5).
  | 'b4-lens'
  // A camera that is not there. Every other mode needs a real address, so
  // without hardware the panel came up empty and every control was inert —
  // you could not see the RCP work on a laptop. See `DemoCameraClient` for
  // what it refuses to be.
  | 'demo';

/** Per-camera connection config (a subset carried by each camera slot). */
export interface CameraConfig {
  connectionMode?: ConnectionMode;
  tcpHost?: string; tcpPort?: number;
  serialPath?: string; baudRate?: number;
  ccuId?: number;
  lumixHost?: string; lumixPort?: number;
  usbDeviceId?: string; usbDeviceModel?: string;
  bmHost?: string; bmHttps?: boolean;
  mncHost?: string; mncPort?: number;
  canonHost?: string; canonPort?: number;
  camHost?: string; camPort?: number; camUser?: string; camPass?: string;
  /** HTTP-CGI: welche Firmware-Familie (Vissonic/PTZOptics oder Sony SRG/BRC). */
  cgiFamily?: CgiFamily; cgiPresetOffset?: number;
  /** VISCA ueber RS-232: Port, Baudrate und Adresse in der Kette (1..7). */
  viscaSerialPath?: string; viscaBaudRate?: number; viscaAddress?: number;
  /** DJI-Gimbals: serieller Pfad (Osmo: CDC, Ronin: SLCAN-Stecker). */
  djiPath?: string; djiBaudRate?: number;
  /**
   * Stream-Adresse fuer den Multiviewer (RTSP/HLS/MJPEG). Kommt aus dem
   * separaten Streaming-Teil der Kamera, nicht aus dem Steuerpfad -- die
   * Bridge steuert ueber CGI/VISCA und zeigt daneben das Bild.
   */
  streamUrl?: string;
}

/** One uniform interface every camera backend satisfies. */
export interface CameraBackend extends EventEmitter {
  readonly isConnected: boolean;
  connect(): Promise<unknown>;
  disconnect(): void | Promise<void>;
  handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean>;
}

export interface BuiltBackend {
  backend: CameraBackend;
  /** Normalise the backend's stateChanged payload into CameraState. */
  mapState: (s: unknown) => Partial<CameraState>;
}

const identity = (s: unknown): Partial<CameraState> => (s ?? {}) as Partial<CameraState>;

// ── State mappers for the backends that don't already emit CameraState ──────

function mapBmState(state: Partial<BMCameraState>): Partial<CameraState> {
  const out: Partial<CameraState> = {};
  if (state.iris && typeof state.iris.normalised === 'number') out.iris = Math.round(state.iris.normalised * 255);
  if (typeof state.gainDb === 'number') out.masterGain = state.gainDb;
  if (typeof state.shutterSpeed === 'number') out.shutterSpeed = state.shutterSpeed;
  return out;
}

function mapMncState(state: MncCameraState): Partial<CameraState> {
  return { iris: Math.round(((state.iris / 100 - 1.4) / 20.6) * 255), ndFilter: state.ndFilter };
}

function mapSonyUsbState(state: SonyPtpState): Partial<CameraState> {
  return { iris: state.iris, masterGain: state.masterGain, shutterSpeed: state.shutterSpeed };
}

/**
 * Sony USB needs a discovery step before connect, so it gets a thin wrapper
 * that presents the plain CameraBackend contract and maps its state.
 */
class SonyUsbBackend extends EventEmitter implements CameraBackend {
  private client = new SonyPtpUsbClient();
  constructor(private readonly usbId?: string) {
    super();
    this.client.on('connected', (i) => this.emit('connected', i));
    this.client.on('stateChanged', (s: SonyPtpState) => this.emit('stateChanged', s));
    this.client.on('disconnected', () => this.emit('disconnected'));
    this.client.on('error', (e) => this.emit('error', e));
  }
  get isConnected(): boolean { return this.client.isConnected; }
  async connect(): Promise<unknown> {
    const { discoverSonyUsbCameras } = await import('../discovery/SonyUsbDiscovery.js');
    const { devices, reason } = await discoverSonyUsbCameras();
    if (devices.length === 0) throw new Error(reason ?? 'Keine Sony-Kamera am USB gefunden.');
    const t = devices.find((d) => d.id === this.usbId) ?? devices[0];
    return this.client.connect({ id: t.id, model: t.model });
  }
  disconnect(): Promise<void> { return this.client.disconnect(); }
  handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    return this.client.handleRcpCommand(cmd, params);
  }
}

const GENERIC_PORT: Record<string, number> = { zcam: 80, 'panasonic-ptz': 80, visca: 1259, jvc: 80, birddog: 8080, 'b4-lens': 80, 'http-cgi': 80 };

/** Build a backend for a camera config. Throws for missing required fields. */
export function makeBackend(cfg: CameraConfig): BuiltBackend {
  const mode = cfg.connectionMode ?? 'tcp';
  switch (mode) {
    // Stands first because it is the only one that needs nothing: no host,
    // no port, no device. `isDemo` rides along in the state so the surface
    // can mark itself — a demo state that arrives indistinguishable from a
    // real one is exactly the defect this repository argues against.
    case 'demo':
      return { backend: new DemoCameraClient(), mapState: identity };
    case 'tcp':
      return { backend: new CcuClient({ host: cfg.tcpHost ?? '192.168.1.10', port: cfg.tcpPort ?? 7700, ccuId: cfg.ccuId ?? 0 }), mapState: identity };
    case 'serial':
      if (!cfg.serialPath) throw new Error('Kein serieller Port konfiguriert');
      return { backend: new CcuClient({ serialPath: cfg.serialPath, baudRate: cfg.baudRate ?? 38400, ccuId: cfg.ccuId ?? 0 }), mapState: identity };
    case 'lumix-http':
      return { backend: new LumixClient({ host: cfg.lumixHost ?? '192.168.54.1', port: cfg.lumixPort ?? 80 }), mapState: identity };
    case 'sony-usb':
      return { backend: new SonyUsbBackend(cfg.usbDeviceId), mapState: (s) => mapSonyUsbState(s as SonyPtpState) };
    case 'blackmagic': {
      if (!cfg.bmHost) throw new Error('Keine Blackmagic-Kamera-IP konfiguriert');
      return { backend: new BMDeviceClient(cfg.bmHost, cfg.bmHttps ?? false), mapState: (s) => mapBmState(s as Partial<BMCameraState>) };
    }
    case 'sony-mnc':
      if (!cfg.mncHost) throw new Error('Keine Sony-WiFi-Kamera-IP konfiguriert');
      return { backend: new SonyMncClient(cfg.mncHost, cfg.mncPort ?? 10000), mapState: (s) => mapMncState(s as MncCameraState) };
    case 'canon-ccapi':
      if (!cfg.canonHost) throw new Error('Keine Canon-Kamera-IP konfiguriert');
      return { backend: new CanonCcapiClient({ host: cfg.canonHost, port: cfg.canonPort ?? 8080 }), mapState: identity };
    case 'dji-osmo': {
      if (!cfg.djiPath) throw new Error('Kein Geraetepfad fuer den Osmo-Gimbal konfiguriert');
      return { backend: new DjiOsmoClient(cfg.djiPath, cfg.djiBaudRate ?? 115200), mapState: identity };
    }
    case 'dji-ronin': {
      if (!cfg.djiPath) throw new Error('Kein Pfad zum SLCAN-Stecker konfiguriert');
      return { backend: new DjiRoninClient(cfg.djiPath, cfg.djiBaudRate ?? 115200), mapState: identity };
    }
    case 'visca-serial': {
      if (!cfg.viscaSerialPath) throw new Error('Kein serieller Port fuer VISCA konfiguriert');
      return {
        backend: new ViscaClient({
          art: 'seriell',
          path: cfg.viscaSerialPath,
          baudRate: cfg.viscaBaudRate ?? 9600,
          adresse: cfg.viscaAddress ?? 1,
        }),
        mapState: identity,
      };
    }
    case 'b4-lens': {
      if (!cfg.camHost) throw new Error('Keine Adresse des B4-Objektiv-Interfaces konfiguriert');
      return { backend: new B4LensClient(cfg.camHost, cfg.camPort ?? 80), mapState: identity };
    }
    case 'http-cgi': {
      if (!cfg.camHost) throw new Error('Keine Kamera-IP konfiguriert');
      return {
        backend: new HttpCgiClient({
          host: cfg.camHost,
          port: cfg.camPort ?? 80,
          family: cfg.cgiFamily ?? 'vissonic',
          username: cfg.camUser ?? '',
          password: cfg.camPass ?? '',
          presetOffset: cfg.cgiPresetOffset,
        }),
        mapState: identity,
      };
    }
    case 'zcam': case 'panasonic-ptz': case 'visca': case 'jvc': case 'birddog': {
      const host = cfg.camHost;
      if (!host) throw new Error('Keine Kamera-IP konfiguriert');
      const port = cfg.camPort ?? GENERIC_PORT[mode];
      const backend =
        mode === 'zcam' ? new ZCamClient(host, port)
        : mode === 'panasonic-ptz' ? new PanasonicPtzClient(host, port)
        : mode === 'visca' ? new ViscaClient(host, port)
        : mode === 'jvc' ? new JvcClient(host, port, cfg.camUser ?? '', cfg.camPass ?? '')
        : new BirddogClient(host, port);
      return { backend, mapState: identity };
    }
    default:
      throw new Error(`Unbekannter Verbindungsmodus: ${mode}`);
  }
}
