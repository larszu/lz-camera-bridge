/**
 * Sony Camera Remote SDK Integration
 * 
 * The Sony Camera Remote SDK allows control of Sony cameras via USB and WiFi.
 * Supported cameras: FX3, FX6, FX9, A7 IV, A7S III, A7R V, ZV-E1, A1, and more.
 * 
 * SDK Documentation: https://support.d-imaging.sony.co.jp/app/sdk/en/index.html
 * 
 * This module provides a TypeScript wrapper for the SDK functionality,
 * mapping RCP commands to camera API calls.
 */

import { EventEmitter } from 'events';
import { discoverSonyUsbCameras } from '../discovery/SonyUsbDiscovery.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CrsdkDevice {
  id: string;
  model: string;
  serialNumber: string;
  connectionType: 'usb' | 'wifi';
  ipAddress?: string;
  firmwareVersion?: string;
}

export interface CrsdkCameraState {
  // Exposure
  iris: number;           // F-number * 100 (e.g., 280 = F2.8)
  isoSensitivity: number;
  shutterSpeed: string;   // "1/60", "1/100", etc.
  exposureMode: 'manual' | 'auto' | 'aperture' | 'shutter';
  
  // White Balance
  whiteBalanceMode: 'auto' | 'daylight' | 'tungsten' | 'custom' | 'colorTemp';
  colorTemperature: number;
  whiteBalanceShift: { r: number; g: number; b: number };
  
  // Focus
  focusMode: 'manual' | 'afc' | 'afs';
  focusArea: 'wide' | 'zone' | 'center' | 'spot';
  
  // Recording
  isRecording: boolean;
  recordingFormat: string;
  remainingTime: number;
  
  // Battery
  batteryLevel: number;
  batteryCharging: boolean;
}

export interface CrsdkCapabilities {
  iris: { min: number; max: number; step: number };
  iso: number[];
  shutterSpeeds: string[];
  whiteBalanceModes: string[];
  focusModes: string[];
  recordingFormats: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Sony Camera Remote SDK Client
// ═══════════════════════════════════════════════════════════════════════════

export class SonyCrsdkClient extends EventEmitter {
  private device: CrsdkDevice | null = null;
  private state: CrsdkCameraState | null = null;
  private capabilities: CrsdkCapabilities | null = null;
  private connected = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
  }

  /**
   * Scan for available Sony cameras via USB.
   *
   * Performs a real libusb enumeration (Sony vendor id 0x054C) through
   * {@link discoverSonyUsbCameras}. When no camera is attached — or the
   * optional native `usb` module is not installed — an empty list is
   * returned and the reason is emitted via the `scanInfo` event, instead
   * of the previous fake demo device.
   */
  async scanUsbDevices(): Promise<CrsdkDevice[]> {
    console.log('[CRSDK] Scanning for USB devices...');

    const { devices, reason } = await discoverSonyUsbCameras();
    if (reason) {
      console.log(`[CRSDK] USB scan: ${reason}`);
      this.emit('scanInfo', reason);
    }

    return devices.map((d) => ({
      id: d.id,
      model: d.model,
      serialNumber: d.serialNumber,
      connectionType: 'usb' as const,
    }));
  }

  /**
   * Scan for cameras on the network
   */
  async scanWifiDevices(subnet?: string): Promise<CrsdkDevice[]> {
    console.log('[CRSDK] Scanning for WiFi devices...');
    
    // SSDP discovery or direct IP scanning
    // Sony cameras advertise via mDNS/SSDP when in remote control mode
    return [];
  }

  /**
   * Connect to a camera
   */
  async connect(device: CrsdkDevice): Promise<void> {
    console.log(`[CRSDK] Connecting to ${device.model} (${device.id})...`);
    
    this.device = device;
    
    // In production:
    // 1. CrSdkApi_Connect(deviceHandle)
    // 2. Wait for connection callback
    // 3. Get capabilities: CrSdkApi_GetDeviceProperty()
    
    // Simulate connection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    this.connected = true;
    this.capabilities = this.getDefaultCapabilities();
    this.state = this.getDefaultState();
    
    // Start polling for state changes
    this.startPolling();
    
    this.emit('connected', device);
    console.log(`[CRSDK] Connected to ${device.model}`);
  }

  /**
   * Disconnect from the camera
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    
    console.log('[CRSDK] Disconnecting...');
    
    this.stopPolling();
    
    // In production: CrSdkApi_Disconnect()
    
    this.connected = false;
    this.device = null;
    this.state = null;
    
    this.emit('disconnected');
  }

  /**
   * Get current camera state
   */
  getState(): CrsdkCameraState | null {
    return this.state;
  }

  /**
   * Get camera capabilities
   */
  getCapabilities(): CrsdkCapabilities | null {
    return this.capabilities;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Camera Control Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set iris (aperture) value
   * @param fNumber F-number (e.g., 2.8, 4.0, 5.6)
   */
  async setIris(fNumber: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting iris to F${fNumber}`);
    
    // In production: CrSdkApi_SetDeviceProperty(FNUMBER, value * 100)
    
    if (this.state) {
      this.state.iris = Math.round(fNumber * 100);
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Set ISO sensitivity
   */
  async setIso(iso: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting ISO to ${iso}`);
    
    if (this.state) {
      this.state.isoSensitivity = iso;
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Set shutter speed
   */
  async setShutterSpeed(speed: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting shutter speed to ${speed}`);
    
    if (this.state) {
      this.state.shutterSpeed = speed;
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Set white balance mode
   */
  async setWhiteBalanceMode(mode: CrsdkCameraState['whiteBalanceMode']): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting white balance to ${mode}`);
    
    if (this.state) {
      this.state.whiteBalanceMode = mode;
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Set color temperature (when in colorTemp mode)
   */
  async setColorTemperature(kelvin: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting color temperature to ${kelvin}K`);
    
    if (this.state) {
      this.state.colorTemperature = kelvin;
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Set white balance shift (R/G/B offset)
   */
  async setWhiteBalanceShift(r: number, g: number, b: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting WB shift R:${r} G:${g} B:${b}`);
    
    if (this.state) {
      this.state.whiteBalanceShift = { r, g, b };
      this.emit('stateChanged', this.state);
    }
  }

  /**
   * Start recording
   */
  async startRecording(): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log('[CRSDK] Starting recording...');
    
    if (this.state) {
      this.state.isRecording = true;
      this.emit('stateChanged', this.state);
      this.emit('recordingStarted');
    }
  }

  /**
   * Stop recording
   */
  async stopRecording(): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log('[CRSDK] Stopping recording...');
    
    if (this.state) {
      this.state.isRecording = false;
      this.emit('stateChanged', this.state);
      this.emit('recordingStopped');
    }
  }

  /**
   * Execute auto white balance
   */
  async executeAwb(): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log('[CRSDK] Executing auto white balance...');
    
    // In production: CrSdkApi_SendCommand(AWB_PUSH)
    
    this.emit('awbExecuted');
  }

  /**
   * Set focus mode
   */
  async setFocusMode(mode: CrsdkCameraState['focusMode']): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    
    console.log(`[CRSDK] Setting focus mode to ${mode}`);
    
    if (this.state) {
      this.state.focusMode = mode;
      this.emit('stateChanged', this.state);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RCP Command Mapping
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle RCP commands and map to camera API
   */
  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<void> {
    switch (cmd) {
      case 'setIris':
        // Map 0-255 range to F1.4-F22
        const irisValue = params.value as number;
        const fNumber = 1.4 + (irisValue / 255) * 20.6;
        await this.setIris(fNumber);
        break;
        
      case 'setWhiteBalance':
        const r = ((params.r as number) - 128) / 12.8; // -10 to +10
        const g = ((params.g as number) - 128) / 12.8;
        const b = ((params.b as number) - 128) / 12.8;
        await this.setWhiteBalanceShift(r, g, b);
        break;
        
      case 'autoWhiteBalance':
        await this.executeAwb();
        break;
        
      case 'setMasterGain':
        // Map gain index to ISO
        const gainIsoMap: Record<number, number> = {
          0: 800, 1: 1600, 2: 3200, 3: 6400, 4: 12800, 5: 25600, 6: 51200,
        };
        await this.setIso(gainIsoMap[params.value as number] || 800);
        break;
        
      case 'setColorTemp':
        await this.setColorTemperature(params.value as number);
        break;
        
      default:
        console.log(`[CRSDK] Unhandled command: ${cmd}`, params);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      // In production: poll camera state
      // CrSdkApi_GetDeviceProperty() for all monitored properties
    }, 500);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private getDefaultCapabilities(): CrsdkCapabilities {
    return {
      iris: { min: 140, max: 2200, step: 10 }, // F1.4 to F22
      iso: [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200],
      shutterSpeeds: ['1/8000', '1/4000', '1/2000', '1/1000', '1/500', '1/250', '1/125', '1/60', '1/30'],
      whiteBalanceModes: ['auto', 'daylight', 'tungsten', 'colorTemp', 'custom'],
      focusModes: ['manual', 'afc', 'afs'],
      recordingFormats: ['XAVC S 4K', 'XAVC S HD', 'XAVC HS 4K'],
    };
  }

  private getDefaultState(): CrsdkCameraState {
    return {
      iris: 280, // F2.8
      isoSensitivity: 800,
      shutterSpeed: '1/60',
      exposureMode: 'manual',
      whiteBalanceMode: 'auto',
      colorTemperature: 5600,
      whiteBalanceShift: { r: 0, g: 0, b: 0 },
      focusMode: 'afc',
      focusArea: 'wide',
      isRecording: false,
      recordingFormat: 'XAVC S 4K',
      remainingTime: 3600,
      batteryLevel: 85,
      batteryCharging: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Native SDK Bindings (placeholder)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * NOTE: The actual Sony Camera Remote SDK requires:
 * 
 * 1. Download SDK from Sony Developer Portal
 *    https://support.d-imaging.sony.co.jp/app/sdk/en/index.html
 * 
 * 2. Install native dependencies:
 *    - Windows: CrSdk.dll
 *    - macOS: libCrSdk.dylib
 *    - Linux: libCrSdk.so
 * 
 * 3. Use node-ffi-napi or a custom native addon to call SDK functions:
 *    - CrSdkApi_Init()
 *    - CrSdkApi_EnumCameraObjects()
 *    - CrSdkApi_Connect()
 *    - CrSdkApi_SetDeviceProperty()
 *    - CrSdkApi_GetDeviceProperty()
 *    - CrSdkApi_SendCommand()
 *    - CrSdkApi_Disconnect()
 *    - CrSdkApi_Release()
 * 
 * 4. Handle callbacks for:
 *    - Connection state changes
 *    - Property changes
 *    - Download notifications
 *    - Live view frames
 */
