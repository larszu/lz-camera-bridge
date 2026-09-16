/**
 * Capability truth table per bridge connection mode.
 *
 * Mirrors exactly what each backend's handleRcpCommand (or command switch)
 * actually implements, so UI buttons for unsupported functions are disabled
 * instead of producing runtime errors. When a backend gains a command, update
 * its row here.
 */
import type { CameraCapabilities, ConnectionMode } from './types.ts';

const NONE: CameraCapabilities = {
  call: false, bars: false, colorTemp: false, character: false, masterGain: false,
  awb: false, abb: false, whiteBalance: false, blackBalance: false, masterBlack: false,
  masterGamma: false, autoIris: false, iris: false, ndFilter: false, cc: false,
  tallyProgram: true, tallyPreview: true, record: false, iso: false, shutter: false,
  focus: false, contrast: false, saturation: false, resetCc: false,
};

const MODE_CAPS: Record<ConnectionMode, Partial<CameraCapabilities>> = {
  // The demo camera. Its list is the paint set `DemoCameraClient` actually
  // applies — read off its switch, not wished for. AWB/ABB/auto-iris stay
  // off because it does not implement them, and a demo that claimed a
  // capability the real backends lack would teach the wrong panel: someone
  // would lay out a button that has nothing behind it anywhere.
  demo: {
    iris: true, masterBlack: true, blackBalance: true, whiteBalance: true,
    masterGain: true, masterGamma: true, saturation: true, ndFilter: true,
    shutter: true, bars: true,
  },
  // Sony CCU 700PTP (TCP + RS-422): full CCU paint. AWB/ABB/Auto-Iris stay
  // disabled deliberately: Sony's 700 protocol is NDA-only and no public
  // source documents those auto-setup command codes (verified against the
  // DelphiForBroadcasting/sony-700ptp-protocol reference, which only covers
  // framing + paint). Enabling them needs a CNA-1 log or RCP traffic capture.
  tcp: {
    iris: true, masterBlack: true, blackBalance: true, whiteBalance: true,
    masterGain: true, masterGamma: true, saturation: true, ndFilter: true,
    shutter: true, bars: true,
  },
  serial: {
    iris: true, masterBlack: true, blackBalance: true, whiteBalance: true,
    masterGain: true, masterGamma: true, saturation: true, ndFilter: true,
    shutter: true, bars: true,
  },
  // Sony Alpha/Cinema über USB-PTP.
  'sony-usb': { iris: true, masterGain: true, iso: true, shutter: true, colorTemp: true, awb: true, record: true },
  // Sony Monitor & Control (WiFi).
  'sony-mnc': { iris: true, masterGain: true, iso: true, colorTemp: true, awb: true, ndFilter: true },
  // Panasonic Lumix HTTP CGI.
  'lumix-http': {
    iris: true, masterBlack: true, whiteBalance: true, masterGain: true, iso: true,
    saturation: true, bars: true, ndFilter: true, shutter: true, record: true,
  },
  // Canon CCAPI.
  'canon-ccapi': { iris: true, masterGain: true, iso: true, shutter: true, colorTemp: true, awb: true, record: true },
  // Blackmagic REST (CCU-Regler → Lift/Gamma/Gain).
  blackmagic: {
    iris: true, masterBlack: true, blackBalance: true, whiteBalance: true,
    masterGain: true, masterGamma: true, saturation: true, ndFilter: true,
    shutter: true, colorTemp: true, awb: true, focus: true, record: true,
    contrast: true, resetCc: true, cc: true,
  },
  // Z CAM HTTP.
  zcam: { iris: true, masterGain: true, iso: true, shutter: true, colorTemp: true, awb: true, record: true },
  // Panasonic AW PTZ CGI.
  'panasonic-ptz': { iris: true, bars: true, focus: true },
  // VISCA over IP.
  visca: { iris: true, masterGain: true, awb: true, focus: true },
  // VISCA ueber RS-232. Identischer Befehlssatz wie ueber IP -- der Draht
  // aendert die Huelle, nicht die Kommandos -- also auch identische
  // Faehigkeiten. Stuende hier weniger, waeren Knopfe grundlos aus.
  'visca-serial': { iris: true, masterGain: true, awb: true, focus: true },
  // Gimbals: KEINE Bild-Faehigkeit. Ein Gimbal traegt eine Kamera, er ist
  // keine. Stuende hier `iris: true`, boete das Pult einen Regler an, der
  // ins Leere greift -- und das ist schlimmer als ein ausgegrauter.
  'dji-osmo': {},
  'dji-ronin': {},
  // JVC web API (Session + Digest, verified command vocabulary). Iris/gain
  // are step-based on this API; bars has no verified command.
  jvc: { iris: true, masterGain: true, colorTemp: true, awb: true, focus: true, record: true },
  // BirdDog: motion/optics via VISCA-over-IP (52381), setup via REST :8080.
  birddog: { iris: true, masterGain: true, colorTemp: true, awb: true, focus: true },
};

/** Modes whose backend implements ptz/setZoom/setFocus/presets. */
export const PTZ_MODES: ConnectionMode[] = [
  'panasonic-ptz', 'visca', 'visca-serial', 'birddog', 'jvc', 'dji-osmo', 'dji-ronin',
];

export function capabilitiesForMode(mode: ConnectionMode | undefined): CameraCapabilities {
  return { ...NONE, ...(mode ? MODE_CAPS[mode] ?? {} : {}) };
}

export function isPtzMode(mode: ConnectionMode | undefined): boolean {
  return !!mode && PTZ_MODES.includes(mode);
}
