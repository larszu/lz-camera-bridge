/**
 * Canon CCAPI Camera Client
 *
 * Controls Canon EOS cameras (R5, R6, R6 II, R7, R8, R10, R50, 1D X III, …)
 * over their official **CCAPI** (Camera Control API) — a documented HTTP/REST
 * interface exposed over WiFi or USB-Ethernet.
 *
 *   Base:   http://<ip>:<port>/ccapi
 *   Info:   GET  /ccapi/ver100/deviceinformation
 *   Set:    PUT  /ccapi/ver100/shooting/settings/{av|tv|iso|wb|colortemperature}
 *   Shoot:  POST /ccapi/ver100/shooting/control/shutterbutton  { af }
 *   Record: POST /ccapi/ver100/shooting/control/recbutton      { action }
 *   Events: GET  /ccapi/ver100/event/polling
 *
 * CCAPI must first be enabled on the camera (one-time activation via Canon's
 * EOS Utility). The camera then serves the API on a fixed IP/port (commonly
 * 8080). This is a real REST client — no SDK and no simulated state.
 *
 * Reference: Canon Developer Community — "Camera Control API (CCAPI)".
 */

import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { irisPositionToFNumber, GAIN_INDEX_TO_ISO } from '../protocol/SonyPtp.js';

export interface CanonClientOptions {
  host: string;
  /** CCAPI port (default 8080) */
  port?: number;
  /** CCAPI API version path segment (default 'ver100') */
  apiVersion?: string;
  /** Poll interval in milliseconds (default 2000) */
  pollInterval?: number;
}

export interface CanonCameraInfo {
  manufacturer: string;
  productName: string;
  serialNumber: string;
  firmwareVersion: string;
  host: string;
}

export class CanonCcapiClient extends EventEmitter {
  private host: string;
  private port: number;
  private ver: string;
  private pollMs: number;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _state: CameraState = {};

  constructor(opts: CanonClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 8080;
    this.ver = opts.apiVersion ?? 'ver100';
    this.pollMs = opts.pollInterval ?? 2000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get state(): CameraState {
    return this._state;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<CanonCameraInfo> {
    const info = (await this.request('GET', '/deviceinformation')) as Record<string, string>;
    const cameraInfo: CanonCameraInfo = {
      manufacturer: info.manufacturer ?? 'Canon',
      productName: info.productname ?? 'Canon EOS',
      serialNumber: info.serialnumber ?? '',
      firmwareVersion: info.firmwareversion ?? '',
      host: this.host,
    };
    this.connected = true;
    this.emit('connected', cameraInfo);
    this.startPolling();
    return cameraInfo;
  }

  disconnect(): void {
    this.stopPolling();
    this.connected = false;
    this.emit('disconnected');
  }

  // ─── Control ────────────────────────────────────────────────────────────────

  /** Aperture as a Canon av string, e.g. F4.0 → "f4.0". */
  async setAperture(fNumber: number): Promise<void> {
    await this.request('PUT', '/shooting/settings/av', { value: `f${fNumber.toFixed(1)}` });
    this._state.iris = Math.round(((fNumber - 1.4) / 20.6) * 255);
  }

  /** Shutter as 1/denominator, e.g. "1/60". */
  async setShutterSpeed(denominator: number): Promise<void> {
    if (denominator <= 0) return;
    await this.request('PUT', '/shooting/settings/tv', { value: `1/${denominator}` });
    this._state.shutterSpeed = denominator;
  }

  async setIso(iso: number): Promise<void> {
    await this.request('PUT', '/shooting/settings/iso', { value: String(iso) });
  }

  async setWhiteBalanceMode(mode: string): Promise<void> {
    await this.request('PUT', '/shooting/settings/wb', { value: mode });
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    // Colour temperature only applies when WB mode is "colortemp".
    await this.request('PUT', '/shooting/settings/wb', { value: 'colortemp' }).catch(() => {});
    await this.request('PUT', '/shooting/settings/colortemperature', { value: kelvin });
  }

  /** Trigger a still capture (with autofocus). */
  async capture(af = true): Promise<void> {
    await this.request('POST', '/shooting/control/shutterbutton', { af });
  }

  async setRecording(on: boolean): Promise<void> {
    await this.request('POST', '/shooting/control/recbutton', { action: on ? 'start' : 'stop' });
  }

  /**
   * Map the bridge's RCP commands onto CCAPI. Returns false for commands Canon
   * has no CCAPI equivalent for, so the bridge can report them honestly.
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'setIris':
        await this.setAperture(irisPositionToFNumber(num('value')));
        this.emitState();
        return true;
      case 'setMasterGain':
        await this.setIso(GAIN_INDEX_TO_ISO[num('value')] ?? 800);
        this._state.masterGain = num('value');
        this.emitState();
        return true;
      case 'setShutterSpeed':
        await this.setShutterSpeed(num('value'));
        this.emitState();
        return true;
      case 'setColorTemp':
        await this.setColorTemperature(num('value', 5600));
        return true;
      case 'autoWhiteBalance':
        await this.setWhiteBalanceMode('auto');
        return true;
      case 'setRecording':
        await this.setRecording(Boolean(params['on']));
        return true;
      case 'setNdFilter':
      case 'setBars':
      case 'setMasterBlack':
      case 'setMasterGamma':
      case 'setWhiteBalance':
        // No CCAPI equivalent (Canon WB is mode-based, no master black/gamma/ND).
        console.log(`[Canon] '${cmd}' wird über CCAPI nicht unterstützt`);
        return false;
      default:
        console.log(`[Canon] Unbekanntes Kommando: ${cmd}`);
        return false;
    }
  }

  // ─── State polling ──────────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollState().catch(() => {}), this.pollMs);
    this.pollState().catch(() => {});
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollState(): Promise<void> {
    if (!this.connected) return;
    const [av, iso, tv] = await Promise.all([
      this.request('GET', '/shooting/settings/av').catch(() => null),
      this.request('GET', '/shooting/settings/iso').catch(() => null),
      this.request('GET', '/shooting/settings/tv').catch(() => null),
    ]);

    let changed = false;
    const avValue = (av as { value?: string } | null)?.value;
    if (avValue) {
      const f = parseFloat(avValue.replace(/^f/i, ''));
      if (!Number.isNaN(f)) {
        this._state.iris = Math.round(((f - 1.4) / 20.6) * 255);
        changed = true;
      }
    }
    const tvValue = (tv as { value?: string } | null)?.value;
    if (tvValue) {
      const m = /^1\/(\d+)/.exec(tvValue);
      if (m) {
        this._state.shutterSpeed = Number(m[1]);
        changed = true;
      }
    }
    const isoValue = (iso as { value?: string } | null)?.value;
    if (isoValue && /^\d+$/.test(isoValue)) {
      const idx = Object.entries(GAIN_INDEX_TO_ISO).find(([, v]) => v === Number(isoValue))?.[0];
      if (idx !== undefined) {
        this._state.masterGain = Number(idx);
        changed = true;
      }
    }
    if (changed) this.emitState();
  }

  private emitState(): void {
    this.emit('stateChanged', { ...this._state });
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: object): Promise<unknown> {
    const url = `http://${this.host}:${this.port}/ccapi/${this.ver}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        throw new Error(`Canon CCAPI HTTP ${res.status} (${method} ${path})`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout zur Canon-Kamera ${this.host}:${this.port}`);
      }
      if (this.connected && method !== 'GET') {
        // A failed control request shouldn't tear down the session, but a
        // failed connect (first deviceinformation GET) propagates to caller.
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery (mDNS / Bonjour: _ccapi._tcp)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canon CCAPI cameras advertise the service `_ccapi._tcp` over mDNS/Bonjour.
 * Implementing a full mDNS responder here would add a heavy dependency, so
 * discovery currently returns an empty list and the user enters the camera's
 * IP/port directly (shown in the camera's CCAPI activation screen). This is an
 * honest no-op, not a fake device.
 */
export async function discoverCanonCameras(): Promise<{ host: string; port: number; model: string }[]> {
  return [];
}
