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

export interface BridgeConfig {
  connectionMode?: 'tcp' | 'serial' | 'lumix-http' | 'sony-usb' | 'blackmagic' | 'sony-mnc' | 'canon-ccapi';
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
// Camera Connection Types
// ═══════════════════════════════════════════════════════════════════════════

export type CameraProtocol = 
  | 'sony-700ptp'      // Sony 700 Protocol over TCP
  | 'sony-700spp'      // Sony 700 Protocol over Serial/RS-422
  | 'sony-crsdk'       // Sony Camera Remote SDK (USB/WiFi) - FX3, FX6, A7 etc.
  | 'sony-mnc'         // Sony Monitor & Control App Protocol (WiFi)
  | 'lumix-http'       // Panasonic Lumix HTTP CGI (WiFi/LAN)
  | 'blackmagic-rest'  // Blackmagic REST API (Ethernet/WiFi)
  | 'blackmagic-sdi'   // Blackmagic SDI Camera Control (via ATEM)
  | 'manual';          // Manual/demo mode

export type CameraType = 'sony' | 'lumix' | 'blackmagic';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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

export interface CameraConnection {
  id: string;
  name: string;
  cameraNumber: number;
  type: CameraType;
  protocol: CameraProtocol;
  status: ConnectionStatus;
  error?: string;
  
  // Connection settings based on protocol
  settings: {
    // TCP settings (700PTP, CRSDK WiFi)
    host?: string;
    port?: number;
    
    // Serial settings (700SPP, RS-422)
    serialPath?: string;
    baudRate?: number;
    parity?: 'odd' | 'even' | 'none';
    
    // USB settings (CRSDK)
    usbDeviceId?: string;
    
    // WIZ108SR bridge
    wiznetMac?: string;
  };
  
  // Current state
  state: CameraState;
  tally: TallyState;
  capabilities: CameraCapabilities;
}

export interface DashboardState {
  cameras: CameraConnection[];
  selectedCameraId: string | null;
  companionEnabled: boolean;
  companionPort: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sony Camera Remote SDK Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SonyCrsdkDevice {
  id: string;
  model: string;
  serialNumber: string;
  connectionType: 'usb' | 'wifi';
  ipAddress?: string;
  supported: boolean;
}

export interface SonyCrsdkCapabilities {
  iris: boolean;
  whiteBalance: boolean;
  iso: boolean;
  shutter: boolean;
  focus: boolean;
  zoom: boolean;
  recording: boolean;
  liveView: boolean;
}
