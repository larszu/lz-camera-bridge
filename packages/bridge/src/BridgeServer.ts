/**
 * WebSocket Bridge Server — multi-camera.
 *
 * Holds any number of camera connections at once, each in a numbered slot with
 * its own backend, and routes commands/state by camera number. Backends are
 * built by the factory (backendFactory.ts) and share the CameraBackend
 * interface, so the server has no per-type branching.
 *
 * Client → Server messages:
 *   { type: 'listCameras' }
 *   { type: 'setCameraConfig', cameraNumber, config }
 *   { type: 'connectCamera',    cameraNumber }
 *   { type: 'disconnectCamera', cameraNumber }
 *   { type: 'removeCamera',     cameraNumber }
 *   { type: 'command', cameraNumber, cmd, params }
 *   { type: 'listPorts' | 'discoverWiznet' | 'configureWiznet'
 *          | 'discoverSonyUsb' | 'discoverSonyMnc'
 *          | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
 *          | 'setTally' | 'getTally' }
 *
 * Server → Client messages:
 *   { type: 'cameras', cameras: [{ cameraNumber, config, connected }] }
 *   { type: 'cameraConnected' | 'cameraDisconnected', cameraNumber, info? }
 *   { type: 'state', cameraNumber, state }
 *   { type: 'error', message, cameraNumber? }
 *   { type: 'tally' | 'ports' | 'wiznetDevices' | 'sonyUsbDevices'
 *          | 'sonyMncDevices' | 'hidDevices' | 'controlSurface' | 'wiznetConfigResult' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Rs422Transport } from './transport/Rs422Transport.js';
import { CameraState } from './protocol/CcuClient.js';
import { makeBackend, CameraBackend, CameraConfig } from './cameras/backendFactory.js';
import { WiznetDiscovery, WiznetDeviceConfig } from './discovery/WiznetDiscovery.js';
import { CompanionServer, TallyState } from './companion/CompanionServer.js';
import { HidControlSurface, HidSurfaceConfig } from './input/HidControlSurface.js';

interface CameraSlot {
  num: number;
  config: CameraConfig;
  backend: CameraBackend | null;
  mapState: (s: unknown) => Partial<CameraState>;
  connected: boolean;
}

interface ClientMessage {
  type:
    | 'listCameras' | 'setCameraConfig' | 'connectCamera' | 'disconnectCamera' | 'removeCamera'
    | 'command' | 'listPorts' | 'discoverWiznet' | 'configureWiznet' | 'discoverSonyUsb'
    | 'discoverSonyMnc' | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
    | 'setTally' | 'getTally';
  cameraNumber?: number;
  config?: CameraConfig;
  cmd?: string;
  params?: Record<string, unknown>;
  deviceIp?: string;
  deviceConfig?: WiznetDeviceConfig;
  surface?: HidSurfaceConfig;
  tally?: Partial<TallyState>;
}

export class BridgeServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private cameras = new Map<number, CameraSlot>();
  private cameraStates = new Map<number, CameraState>();
  private wiznetDiscovery = new WiznetDiscovery();
  private companion = new CompanionServer();
  private hidSurface: HidControlSurface | null = null;
  private tally: TallyState = { program: false, preview: false, isoRec: false };

  constructor(private readonly wsPort = 9700) {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this.onClient(ws));

    this.companion.on('command', (cmd: { action: string; params?: Record<string, unknown> }) => {
      this.handleCompanionCommand(cmd.action, cmd.params ?? {});
    });
    this.companion.on('tallyChanged', (t: TallyState) => {
      this.tally = t;
      this.broadcast({ type: 'tally', tally: this.tally });
    });
  }

  start(): void {
    this.httpServer.listen(this.wsPort, () => {
      console.log(`[BridgeServer] WebSocket listening on ws://localhost:${this.wsPort}`);
    });
    this.companion.start();
  }

  stop(): void {
    this.disableControlSurface();
    for (const slot of this.cameras.values()) void slot.backend?.disconnect();
    this.companion.stop();
    this.wss.close();
    this.httpServer.close();
  }

  // ─── WebSocket client handling ────────────────────────────────────────────

  private onClient(ws: WebSocket): void {
    console.log('[BridgeServer] Web client connected');
    this.sendCameras(ws);
    ws.send(JSON.stringify({ type: 'tally', tally: this.tally }));
    for (const [cameraNumber, state] of this.cameraStates.entries()) {
      ws.send(JSON.stringify({ type: 'state', cameraNumber, state }));
    }

    ws.on('message', (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        this.handleClientMessage(ws, msg).catch((err) =>
          this.sendError(ws, (err as Error).message, msg.cameraNumber),
        );
      } catch {
        this.sendError(ws, 'Invalid JSON message');
      }
    });
    ws.on('close', () => console.log('[BridgeServer] Web client disconnected'));
    ws.on('error', (err) => console.error('[BridgeServer] WS error:', err));
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'listCameras':
        this.sendCameras(ws);
        break;

      case 'setCameraConfig': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.getOrCreateSlot(num);
        slot.config = { ...slot.config, ...(msg.config ?? {}) };
        this.broadcastCameras();
        break;
      }

      case 'connectCamera':
        await this.connectCamera(msg.cameraNumber ?? 0);
        break;

      case 'disconnectCamera':
        await this.disconnectCamera(msg.cameraNumber ?? 0);
        break;

      case 'removeCamera':
        await this.disconnectCamera(msg.cameraNumber ?? 0);
        this.cameras.delete(msg.cameraNumber ?? 0);
        this.cameraStates.delete(msg.cameraNumber ?? 0);
        this.broadcastCameras();
        break;

      case 'command':
        if (!msg.cmd) break;
        await this.dispatchCommand(ws, msg.cameraNumber ?? 0, msg.cmd, msg.params ?? {});
        break;

      case 'listPorts': {
        const ports = await Rs422Transport.listPorts();
        ws.send(JSON.stringify({ type: 'ports', ports }));
        break;
      }

      case 'discoverWiznet': {
        const devices = await this.wiznetDiscovery.discover();
        ws.send(JSON.stringify({ type: 'wiznetDevices', devices }));
        break;
      }

      case 'configureWiznet': {
        if (!msg.deviceIp || !msg.deviceConfig) { this.sendError(ws, 'Missing deviceIp or deviceConfig'); break; }
        const ok = await this.wiznetDiscovery.configure(msg.deviceIp, msg.deviceConfig);
        ws.send(JSON.stringify({ type: 'wiznetConfigResult', success: ok, ip: msg.deviceIp }));
        break;
      }

      case 'discoverSonyUsb': {
        const { discoverSonyUsbCameras } = await import('./discovery/SonyUsbDiscovery.js');
        const { devices, reason } = await discoverSonyUsbCameras();
        ws.send(JSON.stringify({ type: 'sonyUsbDevices', devices, reason }));
        break;
      }

      case 'discoverSonyMnc': {
        const { discoverSonyMncCameras } = await import('./cameras/SonyMncClient.js');
        const devices = await discoverSonyMncCameras();
        ws.send(JSON.stringify({ type: 'sonyMncDevices', devices }));
        break;
      }

      case 'listHidDevices': {
        const { listHidDevices } = await import('./input/HidControlSurface.js');
        const { devices, reason } = await listHidDevices();
        ws.send(JSON.stringify({ type: 'hidDevices', devices, reason }));
        break;
      }

      case 'enableControlSurface':
        if (!msg.surface) { this.sendError(ws, 'Missing control-surface config'); break; }
        await this.enableControlSurface(msg.surface);
        break;

      case 'disableControlSurface':
        this.disableControlSurface();
        break;

      case 'setTally':
        if (msg.tally) {
          this.tally = { ...this.tally, ...msg.tally };
          this.companion.setTally(this.tally);
          this.broadcast({ type: 'tally', tally: this.tally });
        }
        break;

      case 'getTally':
        ws.send(JSON.stringify({ type: 'tally', tally: this.tally }));
        break;
    }
  }

  // ─── Camera slots ─────────────────────────────────────────────────────────

  private getOrCreateSlot(num: number): CameraSlot {
    let slot = this.cameras.get(num);
    if (!slot) {
      slot = { num, config: {}, backend: null, mapState: (s) => (s ?? {}) as Partial<CameraState>, connected: false };
      this.cameras.set(num, slot);
    }
    return slot;
  }

  private async connectCamera(num: number): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot) throw new Error(`Kamera ${num} ist nicht konfiguriert`);

    // Reconnecting? drop this slot's previous backend only (others stay up).
    if (slot.backend) {
      try { await slot.backend.disconnect(); } catch { /* ignore */ }
      slot.backend = null;
      slot.connected = false;
    }

    const { backend, mapState } = makeBackend(slot.config);
    slot.backend = backend;
    slot.mapState = mapState;
    this.wireSlot(slot);
    await backend.connect();
  }

  private async disconnectCamera(num: number): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend) return;
    try { await slot.backend.disconnect(); } catch { /* ignore */ }
    slot.backend = null;
    slot.connected = false;
    this.broadcast({ type: 'cameraDisconnected', cameraNumber: num });
    this.companion.setConnected(this.anyConnected());
    this.broadcastCameras();
  }

  private wireSlot(slot: CameraSlot): void {
    const backend = slot.backend;
    if (!backend) return;
    const num = slot.num;

    backend.on('connected', (info: unknown) => {
      slot.connected = true;
      console.log(`[BridgeServer] Camera ${num} connected`);
      this.broadcast({ type: 'cameraConnected', cameraNumber: num, info });
      this.companion.setConnected(true);
      this.broadcastCameras();
    });

    backend.on('stateChanged', (raw: unknown) => {
      const mapped = slot.mapState(raw);
      const merged = { ...(this.cameraStates.get(num) ?? {}), ...mapped };
      this.cameraStates.set(num, merged);
      this.broadcast({ type: 'state', cameraNumber: num, state: merged });
      this.companion.updateCameraStateFor(num, merged as Record<string, unknown>);
    });

    backend.on('disconnected', () => {
      slot.connected = false;
      this.broadcast({ type: 'cameraDisconnected', cameraNumber: num });
      this.companion.setConnected(this.anyConnected());
      this.broadcastCameras();
    });

    backend.on('error', (err: Error) => {
      console.error(`[BridgeServer] Camera ${num} error:`, err);
      this.broadcast({ type: 'error', message: err.message, cameraNumber: num });
    });
  }

  private async dispatchCommand(ws: WebSocket, num: number, cmd: string, params: Record<string, unknown>): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) {
      this.sendError(ws, `Kamera ${num} ist nicht verbunden`, num);
      return;
    }
    const handled = await slot.backend.handleRcpCommand(cmd, { ...params, cameraNumber: num });
    if (!handled) {
      // `return` — nicht bloss melden. Ohne ihn lief der optimistische Echo
      // unten TROTZDEM: Der Client bekam eine Fehlermeldung UND einen
      // `type: 'state'`-Broadcast mit genau dem Wert, den die Kamera gerade
      // abgelehnt hat. Die Oberflaeche zeigte danach Iris 42 an einer Kamera,
      // die `setIris` nicht kann.
      //
      // Der Kommentar unten begruendet den Echo damit, dass pollende Backends
      // ihn mit dem echten Wert ueberschreiben. Genau das passiert hier nicht:
      // ein Backend, das das Kommando nicht unterstuetzt, pollt dafuer auch
      // keinen Wert — der erfundene bleibt stehen, bis jemand die Kamera neu
      // verbindet.
      //
      // ADR-003 in einem Satz: ein Zustand, den niemand kommandiert hat, darf
      // nicht behauptet werden. Ein Fehler UND ein Erfolg fuer dasselbe
      // Kommando ist die schlimmste der beiden Auskuenfte, weil die zweite die
      // erste ueberschreibt.
      this.sendError(ws, `'${cmd}' wird von Kamera ${num} nicht unterstützt`, num);
      return;
    }

    // Optimistic UI echo for value-carrying paint commands (backends that poll
    // their own state will overwrite this with the real value).
    const echo = this.echoState(cmd, params);
    if (echo) {
      const merged = { ...(this.cameraStates.get(num) ?? {}), ...echo };
      this.cameraStates.set(num, merged);
      this.broadcast({ type: 'state', cameraNumber: num, state: merged });
      this.companion.updateCameraStateFor(num, merged as Record<string, unknown>);
    }
  }

  private echoState(cmd: string, params: Record<string, unknown>): Partial<CameraState> | null {
    const n = (k: string) => Number(params[k] ?? 0);
    switch (cmd) {
      case 'setIris': return { iris: n('value') };
      case 'setMasterBlack': return { masterBlack: n('value') };
      case 'setMasterGain': return { masterGain: n('value') };
      case 'setMasterGamma': return { masterGamma: n('value') };
      case 'setSaturation': return { saturation: n('value') };
      case 'setDetailLevel': return { detailLevel: n('value') };
      case 'setNdFilter': return { ndFilter: n('value') };
      case 'setShutterSpeed': return { shutterSpeed: n('value') };
      case 'setBars': return { bars: Boolean(params['on']) };
      case 'setCameraPower': return { cameraPower: Boolean(params['on']) };
      case 'setWhiteBalance': return { whiteR: n('r'), whiteG: n('g'), whiteB: n('b') };
      case 'setBlackBalance': return { blackR: n('r'), blackG: n('g'), blackB: n('b') };
      default: return null;
    }
  }

  private anyConnected(): boolean {
    for (const slot of this.cameras.values()) if (slot.connected) return true;
    return false;
  }

  private sendCameras(ws?: WebSocket): void {
    const cameras = [...this.cameras.values()].map((s) => ({
      cameraNumber: s.num,
      config: s.config,
      connected: s.connected,
    }));
    const msg = JSON.stringify({ type: 'cameras', cameras });
    if (ws) ws.send(msg);
    else this.broadcastRaw(msg);
  }

  private broadcastCameras(): void {
    this.sendCameras();
  }

  // ─── HID control surface ────────────────────────────────────────────────

  private async enableControlSurface(surface: HidSurfaceConfig): Promise<void> {
    this.disableControlSurface();
    const hid = new HidControlSurface(surface);
    this.hidSurface = hid;
    hid.on('command', ({ cmd, params }: { cmd: string; params: Record<string, unknown> }) => {
      // Panel drives the lowest-numbered connected camera by default.
      const target = [...this.cameras.values()].find((s) => s.connected)?.num
        ?? (params.cameraNumber as number | undefined) ?? 0;
      const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      void this.dispatchCommand(dummyWs, target, cmd, params);
    });
    hid.on('started', (info) => this.broadcast({ type: 'controlSurface', active: true, info }));
    hid.on('stopped', () => this.broadcast({ type: 'controlSurface', active: false }));
    hid.on('error', (err: Error) => this.broadcast({ type: 'error', message: `Control surface: ${err.message}` }));
    await hid.start();
  }

  private disableControlSurface(): void {
    if (this.hidSurface) {
      this.hidSurface.stop();
      this.hidSurface = null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private broadcast(msg: unknown): void {
    this.broadcastRaw(JSON.stringify(msg));
  }

  private broadcastRaw(data: string): void {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  private sendError(ws: WebSocket, message: string, cameraNumber?: number): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message, cameraNumber }));
    }
  }

  // ─── Companion command handler ──────────────────────────────────────────

  private async handleCompanionCommand(action: string, params: Record<string, unknown>): Promise<void> {
    if (action === 'tallyProgram' || action === 'tallyPreview' || action === 'tallyClear') {
      if (action === 'tallyClear') this.tally = { program: false, preview: false, isoRec: false };
      else this.tally[action === 'tallyProgram' ? 'program' : 'preview'] = !this.tally[action === 'tallyProgram' ? 'program' : 'preview'];
      this.companion.setTally(this.tally);
      this.broadcast({ type: 'tally', tally: this.tally });
      return;
    }

    const camNum = Number(params.cameraNumber ?? 0);
    const perCam = this.cameraStates.get(camNum) ?? {};

    if (action === 'irisUp' || action === 'irisDown') {
      const cur = (perCam.iris ?? 128) + (action === 'irisUp' ? 5 : -5);
      params.value = Math.max(0, Math.min(255, cur));
      action = 'setIris';
    } else if (action === 'gainUp' || action === 'gainDown') {
      const cur = (perCam.masterGain ?? 0) + (action === 'gainUp' ? 1 : -1);
      params.value = Math.max(0, Math.min(7, cur));
      action = 'setMasterGain';
    } else if (action === 'ndUp' || action === 'ndDown') {
      const cur = (perCam.ndFilter ?? 0) + (action === 'ndUp' ? 1 : -1);
      params.value = Math.max(0, Math.min(4, cur));
      action = 'setNdFilter';
    }

    const slot = this.cameras.get(camNum);
    if (!slot?.connected) return;
    const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
    await this.dispatchCommand(dummyWs, camNum, action, params);
  }
}
