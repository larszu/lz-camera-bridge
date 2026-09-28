export interface CameraState {
  iris?: number;
  masterBlack?: number;
  blackR?: number;
  blackG?: number;
  blackB?: number;
  whiteR?: number;
  whiteG?: number;
  whiteB?: number;
  masterGain?: number;
  masterGamma?: number;
  saturation?: number;
  shutterSpeed?: number;
  bars?: boolean;
  cameraPower?: boolean;
  ndFilter?: number;
  masterWhiteClip?: number;
  detailLevel?: number;
}

export type CameraStatesByNumber = Record<number, CameraState>;

export type ConnectionMode =
  | 'tcp' | 'serial' | 'lumix-http' | 'sony-usb' | 'blackmagic' | 'sony-mnc' | 'canon-ccapi'
  | 'zcam' | 'panasonic-ptz' | 'visca' | 'visca-serial' | 'jvc' | 'birddog'
  // HTTP-CGI PTZ: alternative Steuerung ueber die Web-CGI der Kamera
  // (Vissonic/PTZOptics ptzctrl.cgi, Sony SRG/BRC /command/) statt VISCA.
  | 'http-cgi'
  // Gimbals: bewegen den Kopf, tragen aber kein Bild.
  | 'dji-osmo' | 'dji-ronin'
  // A B4 lens behind the ESP32-S3 interface in `packages/firmware-b4`.
  // Iris only -- the Hirose 12-pin connector has no analog drive input for
  // zoom or focus at all, so there is nothing else to offer.
  | 'b4-lens'
  // A camera that is not there — the only mode that needs no address. Every
  // other one wants a host, a port or a USB device, so on a laptop the panel
  // came up empty and every control was inert. The state carries `isDemo`,
  // and the surface marks itself with it.
  | 'demo';

export interface BridgeConfig {
  connectionMode?: ConnectionMode;
  tcpHost?: string;
  tcpPort?: number;
  serialPath?: string;
  baudRate?: number;
  ccuId?: number;
  lumixHost?: string;
  lumixPort?: number;
  usbDeviceId?: string;
  usbDeviceModel?: string;
  bmHost?: string;
  bmHttps?: boolean;
  mncHost?: string;
  mncPort?: number;
  canonHost?: string;
  canonPort?: number;
  camHost?: string;
  camPort?: number;
  camUser?: string;
  camPass?: string;
  /** HTTP-CGI: Firmware-Familie und Preset-Versatz. */
  cgiFamily?: 'vissonic' | 'sony';
  cgiPresetOffset?: number;
  /** Multiviewer: Stream-Adresse (RTSP/HLS/MJPEG) aus dem Streaming-Teil der Kamera. */
  streamUrl?: string;
  /** VISCA ueber RS-232: Geraetepfad, Baudrate, Adresse in der Kette (1..7). */
  viscaSerialPath?: string;
  viscaBaudRate?: number;
  viscaAddress?: number;
  /** DJI-Gimbals: serieller Pfad und Baudrate. */
  djiPath?: string;
  djiBaudRate?: number;
}

export interface HidDevice {
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  path?: string;
}

export interface SonyUsbDevice {
  id: string;
  model: string;
  serialNumber: string;
  connectionType: 'usb';
  vendorId: number;
  productId: number;
  supported: boolean;
}

export interface SonyMncDevice {
  host: string;
  model: string;
  location: string;
}

export interface WiznetDevice {
  ident: string;
  fw: string;
  mac: string;
  ip: string;
  port: number;
  mode: 'server' | 'client';
  baud: number;
  parity: 'odd' | 'even' | 'none';
  lastSeen: number;
}

export interface TallyState {
  program: boolean;
  preview: boolean;
  isoRec: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// RCP capability flags — which controls a given backend actually supports.
// Populated per connection mode in capabilities.ts.
// ═══════════════════════════════════════════════════════════════════════════

export interface CameraCapabilities {
  call?: boolean;
  bars?: boolean;
  colorTemp?: boolean;
  character?: boolean;
  masterGain?: boolean;
  awb?: boolean;
  abb?: boolean;
  whiteBalance?: boolean;
  blackBalance?: boolean;
  masterBlack?: boolean;
  masterGamma?: boolean;
  autoIris?: boolean;
  iris?: boolean;
  ndFilter?: boolean;
  cc?: boolean;
  tallyProgram?: boolean;
  tallyPreview?: boolean;
  record?: boolean;
  iso?: boolean;
  shutter?: boolean;
  focus?: boolean;
  contrast?: boolean;
  saturation?: boolean;
  resetCc?: boolean;
}
