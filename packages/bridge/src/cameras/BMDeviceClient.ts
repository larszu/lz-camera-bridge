/**
 * Blackmagic Camera REST API Client
 * 
 * Based on the Blackmagic Camera Control REST API and the
 * BM Camera Control WebUI by Dylan Speiser.
 * https://github.com/DylanSpeiser/BM-Camera-Control-WebUI
 * 
 * API Documentation: https://documents.blackmagicdesign.com/DeveloperManuals/RESTAPIforBlackmagicCameras.pdf
 * 
 * Supports cameras with firmware 8.6+:
 * - Pocket Cinema Camera 4K/6K/6K G2/6K Pro
 * - Cinema Camera 6K
 * - URSA Broadcast G2
 * - Micro Studio Camera 4K G2
 * - Studio Camera 4K Plus/Pro/G2
 * - Studio Camera 6K Pro
 */

import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BMCameraInfo {
  model: string;
  hostname: string;
  codec: string;
  resolution: { width: number; height: number };
  frameRate: number;
}

export interface BMCameraState {
  // Lens
  iris: { normalised: number; apertureStop: number };
  focus: { normalised: number };
  zoom: { normalised: number; focalLength: number };
  
  // Exposure
  iso: number;
  gainDb: number; // dB (renamed to avoid conflict)
  shutterSpeed?: number;
  shutterAngle?: number;
  ndFilter?: number;
  autoExposure: { mode: string; type: string };
  
  // White Balance
  whiteBalance: number; // Kelvin
  whiteBalanceTint: number;
  
  // Color Correction
  lift: BMColorCorrection;
  gamma: BMColorCorrection;
  gainCC: BMColorCorrection; // Color correction gain
  offset: BMColorCorrection;
  contrast: { pivot: number; adjust: number };
  color: { hue: number; saturation: number };
  lumaContribution: number;
  
  // Recording
  recording: boolean;
  timecode: number;
}

export interface BMColorCorrection {
  red: number;
  green: number;
  blue: number;
  luma: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Blackmagic REST API Client
// ═══════════════════════════════════════════════════════════════════════════

export class BMDeviceClient extends EventEmitter {
  private hostname: string;
  private useHttps: boolean;
  private connected = false;
  private ws: WebSocket | null = null;
  private propertyData: Record<string, unknown> = {};
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(hostname: string, useHttps = false) {
    super();
    this.hostname = hostname;
    this.useHttps = useHttps;
  }

  get apiAddress(): string {
    const protocol = this.useHttps ? 'https' : 'http';
    return `${protocol}://${this.hostname}/control/api/v1`;
  }

  get wsAddress(): string {
    const protocol = this.useHttps ? 'wss' : 'ws';
    return `${protocol}://${this.hostname}/control/api/v1/event/websocket`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to the camera
   */
  async connect(): Promise<BMCameraInfo> {
    console.log(`[BMDevice] Connecting to ${this.hostname}...`);
    
    try {
      // Test connection
      const systemInfo = await this.GET('/system') as Record<string, unknown>;
      const formatInfo = await this.GET('/system/format') as Record<string, unknown>;
      
      this.connected = true;
      
      // Initialize WebSocket for real-time updates (browser only)
      if (typeof WebSocket !== 'undefined') {
        this.initWebSocket();
      } else {
        // Node.js - use polling instead
        this.startPolling();
      }
      
      const info: BMCameraInfo = {
        model: this.hostname.replace('.local', '').replace(/-/g, ' '),
        hostname: this.hostname,
        codec: String(formatInfo.codec ?? 'Unknown'),
        resolution: formatInfo.recordResolution as { width: number; height: number } ?? { width: 0, height: 0 },
        frameRate: Number(formatInfo.frameRate ?? 0),
      };
      
      this.emit('connected', info);
      console.log(`[BMDevice] Connected to ${info.model}`);
      
      return info;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from the camera
   */
  disconnect(): void {
    this.stopPolling();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Get camera state
   */
  async getState(): Promise<Partial<BMCameraState>> {
    const [
      lens,
      iris,
      focus,
      zoom,
      iso,
      gain,
      shutter,
      wb,
      wbTint,
      autoExp,
      lift,
      gamma,
      gainCC,
      offset,
      contrast,
      color,
      lumaC,
      record,
      tc,
    ] = await Promise.all([
      this.GET('/lens').catch(() => ({})),
      this.GET('/lens/iris').catch(() => ({})),
      this.GET('/lens/focus').catch(() => ({})),
      this.GET('/lens/zoom').catch(() => ({})),
      this.GET('/video/iso').catch(() => ({})),
      this.GET('/video/gain').catch(() => ({})),
      this.GET('/video/shutter').catch(() => ({})),
      this.GET('/video/whiteBalance').catch(() => ({})),
      this.GET('/video/whiteBalanceTint').catch(() => ({})),
      this.GET('/video/autoExposure').catch(() => ({})),
      this.GET('/colorCorrection/lift').catch(() => ({ red: 0, green: 0, blue: 0, luma: 0 })),
      this.GET('/colorCorrection/gamma').catch(() => ({ red: 0, green: 0, blue: 0, luma: 0 })),
      this.GET('/colorCorrection/gain').catch(() => ({ red: 1, green: 1, blue: 1, luma: 1 })),
      this.GET('/colorCorrection/offset').catch(() => ({ red: 0, green: 0, blue: 0, luma: 0 })),
      this.GET('/colorCorrection/contrast').catch(() => ({ pivot: 0.5, adjust: 1 })),
      this.GET('/colorCorrection/color').catch(() => ({ hue: 0, saturation: 1 })),
      this.GET('/colorCorrection/lumaContribution').catch(() => ({ lumaContribution: 1 })),
      this.GET('/transports/0/record').catch(() => ({})),
      this.GET('/transports/0/timecode').catch(() => ({})),
    ]) as Record<string, unknown>[];

    return {
      iris: iris as unknown as BMCameraState['iris'],
      focus: focus as unknown as BMCameraState['focus'],
      zoom: zoom as unknown as BMCameraState['zoom'],
      iso: (iso as Record<string, number>).iso ?? 800,
      gainDb: (gain as Record<string, number>).gain ?? 0,
      shutterSpeed: (shutter as Record<string, number>).shutterSpeed,
      shutterAngle: (shutter as Record<string, number>).shutterAngle,
      whiteBalance: (wb as Record<string, number>).whiteBalance ?? 5600,
      whiteBalanceTint: (wbTint as Record<string, number>).whiteBalanceTint ?? 0,
      autoExposure: autoExp as unknown as BMCameraState['autoExposure'],
      lift: lift as unknown as BMColorCorrection,
      gamma: gamma as unknown as BMColorCorrection,
      gainCC: gainCC as unknown as BMColorCorrection,
      offset: offset as unknown as BMColorCorrection,
      contrast: contrast as unknown as BMCameraState['contrast'],
      color: color as unknown as BMCameraState['color'],
      lumaContribution: (lumaC as Record<string, number>).lumaContribution ?? 1,
      recording: (record as Record<string, boolean>).recording ?? false,
      timecode: (tc as Record<string, number>).timecode ?? 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Camera Control Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set iris (aperture)
   * @param normalised 0.0 to 1.0
   */
  async setIris(normalised: number): Promise<void> {
    await this.PUT('/lens/iris', { normalised });
  }

  /**
   * Set focus
   * @param normalised 0.0 to 1.0
   */
  async setFocus(normalised: number): Promise<void> {
    await this.PUT('/lens/focus', { normalised });
  }

  /**
   * Trigger auto focus
   */
  async doAutoFocus(): Promise<void> {
    await this.PUT('/lens/focus/doAutoFocus', {});
  }

  /**
   * Set zoom
   * @param normalised 0.0 to 1.0
   */
  async setZoom(normalised: number): Promise<void> {
    await this.PUT('/lens/zoom', { normalised });
  }

  /**
   * Set ISO
   */
  async setIso(iso: number): Promise<void> {
    await this.PUT('/video/iso', { iso });
  }

  /**
   * Set gain in dB
   */
  async setGain(gain: number): Promise<void> {
    await this.PUT('/video/gain', { gain });
  }

  /**
   * Set shutter angle (e.g., 18000 for 180°)
   */
  async setShutterAngle(angle: number): Promise<void> {
    await this.PUT('/video/shutter', { shutterAngle: angle });
  }

  /**
   * Set shutter speed (e.g., 60 for 1/60)
   */
  async setShutterSpeed(speed: number): Promise<void> {
    await this.PUT('/video/shutter', { shutterSpeed: speed });
  }

  /**
   * Set white balance in Kelvin
   */
  async setWhiteBalance(kelvin: number): Promise<void> {
    await this.PUT('/video/whiteBalance', { whiteBalance: kelvin });
  }

  /**
   * Set white balance tint
   */
  async setWhiteBalanceTint(tint: number): Promise<void> {
    await this.PUT('/video/whiteBalanceTint', { whiteBalanceTint: tint });
  }

  /**
   * Trigger auto white balance
   */
  async doAutoWhiteBalance(): Promise<void> {
    await this.PUT('/video/whiteBalance/doAuto', {});
  }

  /**
   * Set ND filter stop
   */
  async setNdFilter(stop: number): Promise<void> {
    await this.PUT('/video/ndFilter', { stop });
  }

  // Color Correction

  /**
   * Set lift (shadows)
   */
  async setLift(values: BMColorCorrection): Promise<void> {
    await this.PUT('/colorCorrection/lift', values);
  }

  /**
   * Set gamma (midtones)
   */
  async setGamma(values: BMColorCorrection): Promise<void> {
    await this.PUT('/colorCorrection/gamma', values);
  }

  /**
   * Set gain (highlights)
   */
  async setGainCC(values: BMColorCorrection): Promise<void> {
    await this.PUT('/colorCorrection/gain', values);
  }

  /**
   * Set offset
   */
  async setOffset(values: BMColorCorrection): Promise<void> {
    await this.PUT('/colorCorrection/offset', values);
  }

  /**
   * Set contrast
   */
  async setContrast(pivot: number, adjust: number): Promise<void> {
    await this.PUT('/colorCorrection/contrast', { pivot, adjust });
  }

  /**
   * Set color (hue and saturation)
   */
  async setColor(hue: number, saturation: number): Promise<void> {
    await this.PUT('/colorCorrection/color', { hue, saturation });
  }

  /**
   * Set luma contribution
   */
  async setLumaContribution(value: number): Promise<void> {
    await this.PUT('/colorCorrection/lumaContribution', { lumaContribution: value });
  }

  /**
   * Reset all color correction to defaults
   */
  async resetColorCorrection(): Promise<void> {
    await Promise.all([
      this.setLift({ red: 0, green: 0, blue: 0, luma: 0 }),
      this.setGamma({ red: 0, green: 0, blue: 0, luma: 0 }),
      this.setGainCC({ red: 1, green: 1, blue: 1, luma: 1 }),
      this.setOffset({ red: 0, green: 0, blue: 0, luma: 0 }),
      this.setContrast(0.5, 1),
      this.setColor(0, 1),
      this.setLumaContribution(1),
    ]);
  }

  // Recording

  /**
   * Start recording
   */
  async startRecording(): Promise<void> {
    await this.PUT('/transports/0/record', { recording: true });
    this.emit('recordingStarted');
  }

  /**
   * Stop recording
   */
  async stopRecording(): Promise<void> {
    await this.PUT('/transports/0/record', { recording: false });
    this.emit('recordingStopped');
  }

  /**
   * Toggle recording
   */
  async toggleRecording(): Promise<void> {
    const state = await this.GET('/transports/0/record') as { recording: boolean };
    await this.PUT('/transports/0/record', { recording: !state.recording });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RCP Command Mapping (dashboard/CCU-style controls → Blackmagic REST)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Map the bridge's CCU-style RCP commands onto the Blackmagic REST API.
   *
   * The CCU paradigm (master black / gamma / white balance) maps naturally
   * onto Blackmagic's colour-correction blocks:
   *   master black   → lift   (shadows)
   *   master gamma   → gamma  (midtones)
   *   white balance  → gain   (highlights)
   *   black balance  → lift R/G/B
   * Iris uses the 0-255 RCP scale → normalised 0-1; saturation → colour
   * saturation 0-2; colour temperature is set in Kelvin directly.
   *
   * Returns false for commands Blackmagic has no equivalent for, so the
   * bridge can report them honestly instead of silently dropping them.
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    // 0-255 (centre 128) → -1..1 around the colour-correction neutral point.
    const bipolar = (v: number) => Math.max(-1, Math.min(1, (v - 128) / 128));

    switch (cmd) {
      case 'setIris':
        await this.setIris(Math.max(0, Math.min(1, num('value') / 255)));
        return true;
      case 'setMasterGain':
        // Treat the gain index as a dB value (Blackmagic gain is in dB).
        await this.setGain(num('value'));
        return true;
      case 'setShutterSpeed':
        await this.setShutterSpeed(num('value'));
        return true;
      case 'setNdFilter':
        await this.setNdFilter(num('value'));
        return true;
      case 'setColorTemp':
        await this.setWhiteBalance(num('value', 5600));
        return true;
      case 'autoWhiteBalance':
        await this.doAutoWhiteBalance();
        return true;
      case 'autoFocus':
        await this.doAutoFocus();
        return true;
      case 'setFocus':
        await this.setFocus(Math.max(0, Math.min(1, num('value') / 255)));
        return true;
      case 'setZoom':
        await this.setZoom(Math.max(0, Math.min(1, num('value') / 255)));
        return true;
      case 'setSaturation':
        // 0-255 → 0-2 saturation, preserving current hue.
        await this.setColor(0, Math.max(0, Math.min(2, num('value') / 128)));
        return true;
      case 'setMasterBlack':
        await this.setLift({ red: 0, green: 0, blue: 0, luma: bipolar(num('value')) });
        return true;
      case 'setBlackBalance':
        await this.setLift({
          red: bipolar(num('r', 128)),
          green: bipolar(num('g', 128)),
          blue: bipolar(num('b', 128)),
          luma: 0,
        });
        return true;
      case 'setMasterGamma':
        await this.setGamma({ red: 0, green: 0, blue: 0, luma: bipolar(num('value')) });
        return true;
      case 'setWhiteBalance':
        // RGB white-balance trim → highlights (gain) colour, centred on 1.0.
        await this.setGainCC({
          red: 1 + bipolar(num('r', 128)),
          green: 1 + bipolar(num('g', 128)),
          blue: 1 + bipolar(num('b', 128)),
          luma: 1,
        });
        return true;
      case 'setRecording':
        await (Boolean(params['on']) ? this.startRecording() : this.stopRecording());
        return true;
      default:
        // bars, character, camera power, detail level, etc. — no BM equivalent.
        console.log(`[BMDevice] '${cmd}' wird über die Blackmagic REST-API nicht unterstützt`);
        return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP Request Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async GET(endpoint: string): Promise<unknown> {
    return this.request('GET', endpoint);
  }

  private async PUT(endpoint: string, data: object): Promise<unknown> {
    return this.request('PUT', endpoint, data);
  }

  private request(method: string, endpoint: string, data?: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.apiAddress + endpoint);
      const httpModule = this.useHttps ? https : http;
      
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (this.useHttps ? 443 : 80),
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        // Ignore SSL certificate errors for self-signed certs
        rejectUnauthorized: false,
      };

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch {
              resolve({});
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WebSocket Methods (Browser only)
  // ═══════════════════════════════════════════════════════════════════════════

  private initWebSocket(): void {
    if (typeof WebSocket === 'undefined') return;

    this.ws = new WebSocket(this.wsAddress);

    this.ws.onopen = () => {
      console.log('[BMDevice] WebSocket connected');
      // Request list of properties
      this.ws?.send(JSON.stringify({
        type: 'request',
        data: { action: 'listProperties' },
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const eventData = JSON.parse(event.data as string);
        const messageData = eventData.data;

        if (eventData.type === 'response' && messageData.values) {
          Object.assign(this.propertyData, messageData.values);
          this.emit('stateChanged', this.propertyData);
        }

        if (messageData.action === 'propertyValueChanged') {
          this.propertyData[messageData.property] = messageData.value;
          this.emit('propertyChanged', messageData.property, messageData.value);
        }

        if (messageData.action === 'listProperties') {
          // Subscribe to all properties
          messageData.properties?.forEach((prop: string) => {
            this.ws?.send(JSON.stringify({
              type: 'request',
              data: { action: 'subscribe', properties: [prop] },
            }));
          });
        }
      } catch (err) {
        console.error('[BMDevice] WebSocket message error:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[BMDevice] WebSocket error:', err);
      this.emit('error', err);
    };

    this.ws.onclose = () => {
      console.log('[BMDevice] WebSocket closed');
      this.ws = null;
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Polling Methods (Node.js fallback)
  // ═══════════════════════════════════════════════════════════════════════════

  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (!this.connected) return;
      try {
        const state = await this.getState();
        this.emit('stateChanged', state);
      } catch (err) {
        // Ignore polling errors
      }
    }, 1000);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List of common Blackmagic camera hostnames
 */
export const BM_CAMERA_HOSTNAMES = [
  'Pocket-Cinema-Camera-4K.local',
  'Pocket-Cinema-Camera-6K.local',
  'Pocket-Cinema-Camera-6K-G2.local',
  'Pocket-Cinema-Camera-6K-Pro.local',
  'Blackmagic-Cinema-Camera-6K.local',
  'URSA-Broadcast-G2.local',
  'Micro-Studio-Camera-4K-G2.local',
  'Studio-Camera-4K-Plus.local',
  'Studio-Camera-4K-Pro.local',
  'Studio-Camera-4K-Plus-G2.local',
  'Studio-Camera-4K-Pro-G2.local',
  'Studio-Camera-6K-Pro.local',
];

/**
 * Try to discover Blackmagic cameras on the network
 * Tests connectivity to known hostnames
 */
export async function discoverBMCameras(): Promise<string[]> {
  const found: string[] = [];
  
  const testConnection = async (hostname: string): Promise<boolean> => {
    try {
      const client = new BMDeviceClient(hostname);
      await client.connect();
      client.disconnect();
      return true;
    } catch {
      return false;
    }
  };

  // Test in parallel with 2s timeout each
  const results = await Promise.allSettled(
    BM_CAMERA_HOSTNAMES.map(async (hostname) => {
      const isAvailable = await Promise.race([
        testConnection(hostname),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
      ]);
      return { hostname, isAvailable };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.isAvailable) {
      found.push(result.value.hostname);
    }
  }

  return found;
}
