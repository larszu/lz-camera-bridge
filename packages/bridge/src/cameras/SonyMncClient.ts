/**
 * Sony Monitor & Control Protocol Client
 * 
 * This module implements the WiFi protocol used by Sony's "Monitor & Control" app.
 * The app controls cameras like FX3, FX6, FX9 over WiFi.
 * 
 * Protocol details are reverse-engineered from the app's network traffic.
 * The camera exposes an HTTP API when in "Streaming" mode.
 */

import { EventEmitter } from 'events';
import http from 'http';
import dgram from 'dgram';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MncCameraInfo {
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  ipAddress: string;
  streaming: boolean;
}

export interface MncCameraState {
  iris: number;
  isoGain: number;
  shutterAngle: number;
  colorTemperature: number;
  whiteBalanceMode: string;
  ndFilter: number;
  recording: boolean;
  mediaRemaining: number;
  batteryLevel: number;
  timecode: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sony Monitor & Control Client
// ═══════════════════════════════════════════════════════════════════════════

export class SonyMncClient extends EventEmitter {
  private host: string;
  private port: number;
  private connected = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private state: MncCameraState | null = null;

  constructor(host: string, port = 10000) {
    super();
    this.host = host;
    this.port = port;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to the camera
   */
  async connect(): Promise<MncCameraInfo> {
    console.log(`[MNC] Connecting to ${this.host}:${this.port}...`);
    
    try {
      // Get camera info
      const info = await this.getCameraInfo();
      
      this.connected = true;
      this.startPolling();
      
      this.emit('connected', info);
      console.log(`[MNC] Connected to ${info.model}`);
      
      return info;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from the camera
   */
  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Get camera information
   */
  async getCameraInfo(): Promise<MncCameraInfo> {
    const response = await this.request('GET', '/sony/camera/v1/system') as Record<string, string | boolean>;
    
    return {
      model: String(response.model ?? 'Unknown'),
      serialNumber: String(response.serialNumber ?? ''),
      firmwareVersion: String(response.version ?? ''),
      ipAddress: this.host,
      streaming: Boolean(response.streaming ?? false),
    };
  }

  /**
   * Get current camera state
   */
  async getState(): Promise<MncCameraState> {
    const response = await this.request('GET', '/sony/camera/v1/shooting/status') as Record<string, unknown>;
    
    this.state = {
      iris: this.parseIris(response.iris as string | number),
      isoGain: Number(response.isoGain ?? 800),
      shutterAngle: Number(response.shutterAngle ?? 180),
      colorTemperature: Number(response.colorTemperature ?? 5600),
      whiteBalanceMode: String(response.whiteBalanceMode ?? 'auto'),
      ndFilter: Number(response.ndFilter ?? 0),
      recording: Boolean(response.recording ?? false),
      mediaRemaining: Number(response.mediaRemaining ?? 0),
      batteryLevel: Number(response.batteryLevel ?? 0),
      timecode: String(response.timecode ?? '00:00:00:00'),
    };
    
    return this.state!;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Camera Control Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set iris value
   * @param value F-number string like "F2.8" or "F5.6"
   */
  async setIris(value: string): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/iris', { value });
    this.emit('irisChanged', value);
  }

  /**
   * Set ISO/Gain
   */
  async setIsoGain(value: number): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/isoGain', { value });
    this.emit('isoGainChanged', value);
  }

  /**
   * Set shutter angle
   */
  async setShutterAngle(value: number): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/shutterAngle', { value });
    this.emit('shutterAngleChanged', value);
  }

  /**
   * Set color temperature
   */
  async setColorTemperature(kelvin: number): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/colorTemperature', { value: kelvin });
    this.emit('colorTemperatureChanged', kelvin);
  }

  /**
   * Set white balance mode
   */
  async setWhiteBalanceMode(mode: string): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/whiteBalanceMode', { value: mode });
    this.emit('whiteBalanceModeChanged', mode);
  }

  /**
   * Execute auto white balance
   */
  async executeAwb(): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/awb/execute');
    this.emit('awbExecuted');
  }

  /**
   * Set ND filter
   * @param value 0=Clear, 1=1/4, 2=1/16, 3=1/64
   */
  async setNdFilter(value: number): Promise<void> {
    await this.request('POST', '/sony/camera/v1/shooting/ndFilter', { value });
    this.emit('ndFilterChanged', value);
  }

  /**
   * Start recording
   */
  async startRecording(): Promise<void> {
    await this.request('POST', '/sony/camera/v1/recording/start');
    this.emit('recordingStarted');
  }

  /**
   * Stop recording
   */
  async stopRecording(): Promise<void> {
    await this.request('POST', '/sony/camera/v1/recording/stop');
    this.emit('recordingStopped');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RCP Command Mapping
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle RCP commands and map to camera API
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    switch (cmd) {
      case 'setIris': {
        // Map 0-255 to F1.4-F22
        const irisValue = params.value as number;
        const fNumber = 1.4 + (irisValue / 255) * 20.6;
        await this.setIris(`F${fNumber.toFixed(1)}`);
        return true;
      }
      case 'setMasterGain': {
        const gainIsoMap: Record<number, number> = {
          0: 800, 1: 1600, 2: 3200, 3: 6400, 4: 12800, 5: 25600, 6: 51200,
        };
        await this.setIsoGain(gainIsoMap[params.value as number] || 800);
        return true;
      }
      case 'setColorTemp':
        await this.setColorTemperature(params.value as number);
        return true;
      case 'autoWhiteBalance':
        await this.executeAwb();
        return true;
      case 'setNdFilter':
        await this.setNdFilter(params.value as number);
        return true;
      default:
        return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (this.connected) {
        try {
          await this.getState();
          this.emit('stateChanged', this.state);
        } catch (err) {
          console.error('[MNC] Polling error:', err);
        }
      }
    }, 1000);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private parseIris(value: string | number): number {
    if (typeof value === 'number') return value;
    // Parse "F2.8" -> 280
    const match = value?.match(/F?(\d+\.?\d*)/);
    return match ? Math.round(parseFloat(match[1]) * 100) : 280;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery (SSDP)
// ═══════════════════════════════════════════════════════════════════════════

export interface MncDiscoveredCamera {
  /** IP address parsed from the SSDP LOCATION header */
  host: string;
  /** Friendly model string from the SSDP SERVER/USN header, if present */
  model: string;
  /** Full device-description URL advertised in LOCATION */
  location: string;
}

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
// Sony's "Smart Remote"/ScalarWebAPI service. We also accept ssdp:all and
// filter Sony devices out of the responses, so cameras that advertise a
// slightly different ST are still found.
const SONY_SEARCH_TARGETS = [
  'urn:schemas-sony-com:service:ScalarWebAPI:1',
  'urn:schemas-upnp-org:device:MediaServer:1',
];

/**
 * Discover Sony cameras on the local network via SSDP M-SEARCH.
 *
 * Sends an M-SEARCH datagram to the SSDP multicast group and collects unicast
 * responses for `timeoutMs`. Responses whose SERVER/USN/LOCATION look like a
 * Sony device are returned. This is real UDP discovery — it resolves to an
 * empty list (not a fake device) when nothing answers.
 */
export async function discoverSonyMncCameras(timeoutMs = 3000): Promise<MncDiscoveredCamera[]> {
  console.log('[MNC] SSDP discovery (M-SEARCH)…');

  const found = new Map<string, MncDiscoveredCamera>();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  const parseResponse = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const text = msg.toString('utf8');
    const headers: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
    }
    const blob = `${headers['SERVER'] ?? ''} ${headers['USN'] ?? ''} ${headers['ST'] ?? ''} ${headers['LOCATION'] ?? ''}`.toLowerCase();
    if (!blob.includes('sony')) return;

    const location = headers['LOCATION'] ?? '';
    let host = rinfo.address;
    try {
      if (location) host = new URL(location).hostname;
    } catch {
      /* keep rinfo.address */
    }
    found.set(host, { host, model: headers['SERVER'] || 'Sony Camera', location });
  };

  return new Promise<MncDiscoveredCamera[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      console.log(`[MNC] SSDP found ${found.size} Sony device(s)`);
      resolve([...found.values()]);
    };

    socket.on('message', parseResponse);
    socket.on('error', () => finish());

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
      for (const st of SONY_SEARCH_TARGETS) {
        const msearch = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            `ST: ${st}\r\n\r\n`,
        );
        socket.send(msearch, 0, msearch.length, SSDP_PORT, SSDP_ADDRESS);
      }
    });

    setTimeout(finish, timeoutMs);
  });
}
