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
  | 'sony-ptpip'
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
  // Robotic pan/tilt head over TCP 3001 (directly or a device-server port).
  | 'robotic-head'
  // A camera that is not there — the only mode that needs no address. Every
  // other one wants a host, a port or a USB device, so on a laptop the panel
  // came up empty and every control was inert. The state carries `isDemo`,
  // and the surface marks itself with it.
  | 'demo';

export interface BridgeConfig {
  connectionMode?: ConnectionMode;
  /** FreeD tracking out of this camera's pose. Mirrors the bridge's `protocol/freeDPose.ts`. */
  freed?: FreeDCameraConfig;
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
  /** sony-ptpip: confirmed SSH host-key fingerprint of the camera. */
  sshFingerprint?: string;
  /** HTTP-CGI: Firmware-Familie und Preset-Versatz. */
  cgiFamily?: 'vissonic' | 'sony';
  cgiPresetOffset?: number;
  /** Multiviewer: Stream-Adresse (RTSP) aus dem Streaming-Teil der Kamera. Die Bruecke holt sie, das Pult nie. */
  streamUrl?: string;
  /** Name am Pult. Ein Plan-Label gewinnt. */
  label?: string;
  /** Eingang am Mischer, 1-basiert; 0/leer: keiner. Daraus entsteht das Tally je Kamera. */
  switcherInput?: number;
  /** On-air lock: no shot recall while on programme unless forced. Default on; only `false` switches it off. */
  tallyProtect?: boolean;
  /** Geplante Shots → Kopf-Pose: Montagefehler vor Ort, Heimat-Richtung, gemessene Zoomkurve, VISCA-Skala. */
  poseOffset?: { pan: number; tilt: number };
  homeHeading?: number;
  zoomTable?: { position: number; focalMm: number }[];
  unitsPerDeg?: number;
  /** Presets in der Bruecke: gelesene Pose, Fahrzeit (ms), Weich-Schalter — je Preset-Nummer. */
  bridgePresets?: Record<string, { pan?: number; tilt?: number; zoom?: number; timeMs?: number; soft?: boolean }>;
  /** Vorgaben fuer diese Fahrten: Zeit (ms), Kurve, Hoechstgeschwindigkeit des Kopfs (°/s). */
  presetMove?: { timeMs?: number; curve?: 'linear' | 'sine' | 'cubic' | 'quint'; maxDegPerSec?: number };
  /** Bildwinkel je Zoomstellung (gemessen), Datenblatt-Enden, Sensorbreite — fuer "Rahmen ziehen" und das Panorama. */
  fovTable?: { position: number; hfovDeg: number }[];
  hfovWideDeg?: number;
  hfovTeleDeg?: number;
  sensorWidthMm?: number;
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

/** Measured calibration of one panel axis (bridge input/axisCalibration.ts). */
export interface AxisCalibration {
  min: number;
  max: number;
  centre?: number;
  deadzone: number;
  curve: 'linear' | 'expo';
  expo: number;
  invert: boolean;
}

/** The active panel's axes, as the bridge reports them. `device` null = no panel. */
export interface InputCalibrationInfo {
  device: string | null;
  axes: { key: string; label: string; twoSided: boolean; calibration?: AxisCalibration }[];
}

/** The calibration assistant while it runs. */
export interface InputCalibrationLive {
  phase: 'sweep' | 'rest' | 'idle';
  axes?: { key: string; label: string; twoSided: boolean; raw: number | null; min: number | null; max: number | null; full: number }[];
  skipped?: string[];
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

/** A Sony camera found by SSDP (DigitalImaging service), for sony-ptpip. */
export interface SonyNetDevice {
  ip: string;
  name: string;
  model: string;
  serial: string;
  firmware: string;
  mac: string;
  /** Access Authentication on: user/password and SSH. */
  ssh: boolean;
  /** Access Authentication off: confirm pairing once on the camera. */
  pairing: boolean;
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

// ═══════════════════════════════════════════════════════════════════════════
// Switcher (VIS-CATC) — mirrors packages/bridge/src/switcher/VisCatcClient.ts
// ═══════════════════════════════════════════════════════════════════════════

export type SwitcherPath = 'http' | 'serial';

export interface SwitcherSerialConfig {
  transport: 'none' | 'tcp' | 'port';
  host?: string;
  port?: number;
  devicePath?: string;
  baudRate?: number;
}

export interface SwitcherConfig {
  kind?: 'vis-catc';
  label?: string;
  host?: string;
  port?: number;
  path?: SwitcherPath;
  serial?: SwitcherSerialConfig;
  inputLabels?: string[];
  pgmWindow?: number;
  timeoutMs?: number;
}

export interface SwitcherState {
  outputs: Record<number, number>;
  mode: number;
  audio: number;
  inputSignals: Record<string, boolean>;
  version: string | null;
  program: number;
  preview: number;
  readAt: number | null;
}

export interface SwitcherSlot {
  switcherNumber: number;
  config: SwitcherConfig;
  connected: boolean;
  state: SwitcherState | null;
  inputLabels: string[] | null;
}

export type SourceTally = 'program' | 'preview' | 'off';
export type CameraTally = Record<number, SourceTally>;

/** FreeD tracking — the wire shapes of the bridge's `protocol/freeDPose.ts` and `transport/FreeDOutput.ts`. */
export interface FreeDTarget { host: string; port: number }
export interface FreeDSiteConfig { targets: FreeDTarget[]; rateHz: number; pollMs?: number }
export interface FreeDCameraConfig {
  enabled: boolean;
  cameraId?: number;
  positionMm?: { x: number; y: number; z: number };
  columnMmPerCount?: number;
  invert?: { pan?: boolean; tilt?: boolean; zoom?: boolean; focus?: boolean };
  offsetDeg?: { pan?: number; tilt?: number; roll?: number };
}
export interface FreeDCameraStatus {
  cameraNumber: number; cameraId: number; sent: number; silent: number; errors: number;
  readAgeMs: number | null; unread: ('zoom' | 'focus')[]; lastError?: string;
}
export interface FreeDInfo { config: FreeDSiteConfig | null; status: { active: boolean; cameras: FreeDCameraStatus[] } }

export interface SiteInfo {
  name: string;
  path: string | null;
  cameras: number;
  switchers: number;
}
