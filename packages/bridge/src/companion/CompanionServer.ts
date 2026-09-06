/**
 * Bitfocus Companion Integration Server
 * 
 * Provides HTTP REST API for Companion button actions and WebSocket for tally/feedback.
 * Compatible with Companion's generic HTTP module.
 * 
 * HTTP Endpoints:
 *   POST /api/action     - Execute camera command
 *   GET  /api/state      - Get current camera state
 *   GET  /api/tally       - Get tally state
 *   POST /api/tally       - Set tally state (for forwarding)
 * 
 * WebSocket (port 9701):
 *   Sends real-time state updates and tally changes
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { NUDGE_ACTIONS } from '../protocol/paintNudge.js';
import { EventEmitter } from 'events';

export interface TallyState {
  /** Program (red) tally active */
  program: boolean;
  /** Preview (green) tally active */
  preview: boolean;
  /** ISO recording indicator */
  isoRec: boolean;
}

export interface CompanionCommand {
  action: string;
  params?: Record<string, unknown>;
}

export interface CameraStateBroadcast {
  cameraNumber: number;
  state: Record<string, unknown>;
}

export class CompanionServer extends EventEmitter {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private tally: TallyState = { program: false, preview: false, isoRec: false };
  private cameraState: Record<string, unknown> = {};
  private cameraStates: CameraStateBroadcast[] = [];
  private connected = false;

  constructor(
    private readonly httpPort = 9702,
    private readonly wsPort = 9701,
  ) {
    // Beide Vorgaben greifen auch bei `undefined` — der Aufrufer darf einen
    // Port weglassen, ohne den anderen zu kennen.

    super();
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ port: wsPort });
    this.wss.on('connection', (ws) => this.onWsClient(ws));
  }

  start(): void {
    this.httpServer.listen(this.httpPort, () => {
      console.log(`[Companion] HTTP API listening on http://localhost:${this.httpPort}`);
    });
    console.log(`[Companion] WebSocket feedback on ws://localhost:${this.wsPort}`);
  }

  stop(): void {
    this.httpServer.close();
    this.wss.close();
  }

  // ─── State Updates (called by BridgeServer) ─────────────────────────────────

  updateCameraState(state: Record<string, unknown>): void {
    this.cameraState = { ...this.cameraState, ...state };
    this.broadcastWs({ type: 'state', state: this.cameraState });
  }

  updateCameraStateFor(cameraNumber: number, state: Record<string, unknown>): void {
    const existing = this.cameraStates.find((entry) => entry.cameraNumber === cameraNumber);
    if (existing) {
      existing.state = { ...existing.state, ...state };
    } else {
      this.cameraStates.push({ cameraNumber, state: { ...state } });
    }
    this.broadcastWs({ type: 'state', cameraNumber, state });
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.broadcastWs({ type: 'connection', connected });
  }

  setTally(tally: Partial<TallyState>): void {
    this.tally = { ...this.tally, ...tally };
    this.broadcastWs({ type: 'tally', tally: this.tally });
    this.emit('tallyChanged', this.tally);
  }

  getTally(): TallyState {
    return { ...this.tally };
  }

  // ─── HTTP Handler ───────────────────────────────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers for Companion
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.httpPort}`);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      this.sendJson(res, { connected: this.connected, state: this.cameraState, cameraStates: this.cameraStates });
      return;
    }

    if (url.pathname === '/api/tally' && req.method === 'GET') {
      this.sendJson(res, { tally: this.tally });
      return;
    }

    if (url.pathname === '/api/tally' && req.method === 'POST') {
      this.readBody(req).then((body) => {
        try {
          const data = JSON.parse(body);
          if (typeof data.program === 'boolean') this.tally.program = data.program;
          if (typeof data.preview === 'boolean') this.tally.preview = data.preview;
          if (typeof data.isoRec === 'boolean') this.tally.isoRec = data.isoRec;
          this.broadcastWs({ type: 'tally', tally: this.tally });
          this.emit('tallyChanged', this.tally);
          this.sendJson(res, { ok: true, tally: this.tally });
        } catch {
          this.sendError(res, 400, 'Invalid JSON');
        }
      });
      return;
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      this.readBody(req).then((body) => {
        try {
          const cmd: CompanionCommand = JSON.parse(body);
          if (!cmd.action) {
            this.sendError(res, 400, 'Missing action');
            return;
          }
          // Emit command for BridgeServer to handle
          this.emit('command', cmd);
          this.sendJson(res, { ok: true, action: cmd.action });
        } catch {
          this.sendError(res, 400, 'Invalid JSON');
        }
      });
      return;
    }

    // Quick action via query params: /api/action?cmd=setIris&value=50
    if (url.pathname === '/api/action' && req.method === 'GET') {
      const action = url.searchParams.get('cmd');
      if (!action) {
        this.sendError(res, 400, 'Missing cmd parameter');
        return;
      }
      const params: Record<string, unknown> = {};
      url.searchParams.forEach((v, k) => {
        if (k !== 'cmd') {
          // Try to parse as number
          const num = parseFloat(v);
          params[k] = isNaN(num) ? v : num;
        }
      });
      this.emit('command', { action, params });
      this.sendJson(res, { ok: true, action, params });
      return;
    }

    // Presets list for Companion
    if (url.pathname === '/api/presets' && req.method === 'GET') {
      this.sendJson(res, { presets: this.getPresets() });
      return;
    }

    this.sendError(res, 404, 'Not found');
  }

  private getPresets(): Array<{ id: string; label: string; category: string }> {
    return [
      // Iris
      { id: 'setIris', label: 'Iris', category: 'Exposure' },
      // Gain
      { id: 'setMasterGain', label: 'Master Gain', category: 'Exposure' },
      // Shutter
      { id: 'setShutterSpeed', label: 'Shutter', category: 'Exposure' },
      // ND
      { id: 'setNdFilter', label: 'ND Filter', category: 'Exposure' },
      // Relative Tasten (Bedarf 129). Sie stehen NICHT hier, sondern in
      // `protocol/paintNudge.ts` — dieselbe Tabelle, aus der der Dispatcher
      // seine Schrittweiten und Wertebereiche nimmt. Vorher standen die Ids
      // hier und die Rechnung dort, und beide Listen kannten `masterBlack`
      // nicht: der Wert, den der Beleg als den meistgetrimmten benennt, hatte
      // ueberhaupt keine relative Taste.
      ...Object.entries(NUDGE_ACTIONS).map(([id, a]) => ({
        id,
        label: a.label,
        category: a.category,
      })),
      // Black
      { id: 'setMasterBlack', label: 'Master Black', category: 'Black' },
      { id: 'setBlackR', label: 'Black R', category: 'Black' },
      { id: 'setBlackG', label: 'Black G', category: 'Black' },
      { id: 'setBlackB', label: 'Black B', category: 'Black' },
      // White Balance
      { id: 'setWhiteR', label: 'White R', category: 'White Balance' },
      { id: 'setWhiteG', label: 'White G', category: 'White Balance' },
      { id: 'setWhiteB', label: 'White B', category: 'White Balance' },
      { id: 'autoWhiteBalance', label: 'Auto White Balance', category: 'White Balance' },
      // Picture
      { id: 'setMasterGamma', label: 'Master Gamma', category: 'Picture' },
      { id: 'setSaturation', label: 'Saturation', category: 'Picture' },
      { id: 'setDetailLevel', label: 'Detail', category: 'Picture' },
      // System
      { id: 'setBars', label: 'Bars On/Off', category: 'System' },
      { id: 'setCameraPower', label: 'Camera Power', category: 'System' },
      // Tally
      { id: 'tallyProgram', label: 'Tally Program', category: 'Tally' },
      { id: 'tallyPreview', label: 'Tally Preview', category: 'Tally' },
      { id: 'tallyClear', label: 'Tally Clear', category: 'Tally' },
    ];
  }

  // ─── WebSocket Handler ──────────────────────────────────────────────────────

  private onWsClient(ws: WebSocket): void {
    console.log('[Companion] WebSocket client connected');
    
    // Send initial state
    ws.send(JSON.stringify({ type: 'connection', connected: this.connected }));
    ws.send(JSON.stringify({ type: 'tally', tally: this.tally }));
    ws.send(JSON.stringify({ type: 'state', state: this.cameraState }));
    for (const cameraState of this.cameraStates) {
      ws.send(JSON.stringify({ type: 'state', cameraNumber: cameraState.cameraNumber, state: cameraState.state }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command' && msg.action) {
          this.emit('command', { action: msg.action, params: msg.params ?? {} });
        }
        if (msg.type === 'setTally') {
          this.setTally(msg.tally ?? {});
        }
      } catch { /* ignore */ }
    });

    ws.on('close', () => console.log('[Companion] WebSocket client disconnected'));
  }

  private broadcastWs(msg: unknown): void {
    const data = JSON.stringify(msg);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
    });
  }
}
