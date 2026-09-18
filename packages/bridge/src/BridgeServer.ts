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
 *       cmd 'nudge', params { parameter, by } trimmt relativ; siehe
 *       protocol/paintNudge.ts. Wird zu einem absoluten Kommando
 *       aufgeloest, bevor irgendein Backend es sieht.
 *   { type: 'listPorts' | 'discoverWiznet' | 'configureWiznet'
 *          | 'discoverSonyUsb' | 'discoverSonyMnc'
 *          | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
 *          | 'setTally' | 'getTally' }
 *
 * Server → Client messages:
 *   { type: 'cameras', cameras: [{ cameraNumber, config, connected,
 *                                  neverReadsBack, freshnessLimits }] }
 *   { type: 'cameraConnected' | 'cameraDisconnected', cameraNumber, info? }
 *   { type: 'state', cameraNumber, state, origins, confirmations }
 *                        origins je Feld: 'confirmed' (vom Geraet gelesen)
 *                        | 'commanded' (Echo).
 *                        confirmations je Feld: wann zuletzt bestaetigt
 *                        (ms seit Epoche). Nur bestaetigte Felder stehen
 *                        darin; ein Kommando loescht den Eintrag.
 *   { type: 'error', message, cameraNumber? }
 *   { type: 'tally' | 'ports' | 'wiznetDevices' | 'sonyUsbDevices'
 *          | 'sonyMncDevices' | 'hidDevices' | 'controlSurface' | 'wiznetConfigResult' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { Rs422Transport } from './transport/Rs422Transport.js';
import { CameraState } from './protocol/CcuClient.js';
import { makeBackend, CameraBackend, CameraConfig } from './cameras/backendFactory.js';
import { WiznetDiscovery, WiznetDeviceConfig } from './discovery/WiznetDiscovery.js';
import { CompanionServer, TallyState } from './companion/CompanionServer.js';
import { HidControlSurface, HidSurfaceConfig } from './input/HidControlSurface.js';
import {
  matchCameraPlan, parseCameraPlan,
  type CameraPlan, type PlanCamera, type SlotFacts,
} from './plan/cameraPlan.js';
import { NUDGE_ACTIONS, NUDGE_REFUSAL_LABEL, resolveNudge } from './protocol/paintNudge.js';
import {
  applyOrigins,
  applyConfirmations,
  type Confirmations,
  feldnamen,
  neverReadsBack,
  MODE_CADENCE,
  freshnessLimits,
  type Origins,
} from './protocol/valueOrigin.js';

/** Was der Nutzer liest, wenn die Datei kein Kamera-Plan ist. */
const PLAN_FEHLER =
  'Keine gueltige Kamera-Liste. Erwartet wird eine Datei im Format ' +
  "'camera-list' v1 (Export aus dem MultiCam-Planner).";

interface CameraSlot {
  num: number;
  config: CameraConfig;
  backend: CameraBackend | null;
  mapState: (s: unknown) => Partial<CameraState>;
  connected: boolean;
  /**
   * Die geplante Kamera, die auf diesem Slot sitzt (B-41.1). Am Pult steht
   * dann "CAM 3 — Buehne links" statt einer nackten Nummer; das ist die
   * Sprache, in der die Show geplant wurde.
   */
  plan?: PlanCamera;
  /** Womit die Zuordnung belegt ist. Siehe `plan/cameraPlan.ts`. */
  planMatchedBy?: 'model' | 'number' | 'manual';
}

interface ClientMessage {
  type:
    | 'listCameras' | 'setCameraConfig' | 'connectCamera' | 'disconnectCamera' | 'removeCamera'
    | 'command' | 'listPorts' | 'discoverWiznet' | 'configureWiznet' | 'discoverSonyUsb'
    | 'discoverSonyMnc' | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
    | 'setTally' | 'getTally'
    | 'matchCameraPlan' | 'applyCameraPlan' | 'assignPlanCamera';
  cameraNumber?: number;
  config?: CameraConfig;
  cmd?: string;
  params?: Record<string, unknown>;
  deviceIp?: string;
  deviceConfig?: WiznetDeviceConfig;
  surface?: HidSurfaceConfig;
  tally?: Partial<TallyState>;
  /** Kamera-Plan als Text ODER als Objekt — beides, siehe `handleClientMessage`. */
  plan?: string | Record<string, unknown>;
  /** Fuer `assignPlanCamera`: leer laesst die Zuordnung fallen. */
  planCameraId?: string | null;
}

export class BridgeServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private cameras = new Map<number, CameraSlot>();
  private cameraStates = new Map<number, CameraState>();
  /**
   * BEDARF 46 — woher jeder Wert in `cameraStates` stammt.
   *
   * Getrennt gefuehrt und nicht in den Zustand gemischt: der Zustand ist die
   * Sprache zu den Backends und zu Companion, die Herkunft eine Aussage
   * UEBER ihn. Zusammengelegt haette jede Stelle, die den Zustand weiterreicht,
   * eine Meinung dazu haben muessen.
   */
  private cameraOrigins = new Map<number, Origins>();
  // BEDARF 102 — wann jedes Feld ZULETZT bestaetigt wurde. Getrennt von
  // `cameraOrigins` gefuehrt, weil es eine andere Frage beantwortet: die
  // Herkunft sagt „hat die Kamera das je gesagt", der Zeitstempel sagt
  // „gilt das noch". Wer am Kameramenue dreht, aendert das zweite, nicht
  // das erste.
  private cameraConfirmations = new Map<number, Confirmations>();
  private wiznetDiscovery = new WiznetDiscovery();
  private companion: CompanionServer;
  private hidSurface: HidControlSurface | null = null;
  private tally: TallyState = { program: false, preview: false, isoRec: false };

  /**
   * `companionPorts` ist da, damit eine zweite Bruecke im selben Prozess
   * ueberhaupt entstehen kann. `CompanionServer` bindet seinen WebSocket-Port
   * SCHON IM KONSTRUKTOR, und er stand fest auf 9701 — zwei Instanzen gaben
   * `EADDRINUSE`, ohne dass jemand nach einem Port gefragt haette. Aufgefallen
   * ist es an zwei Testdateien, die der Runner nebenlaeufig ausfuehrt; es
   * gilt aber genauso fuer zwei Bruecken auf einem Rechner.
   */
  constructor(
    private readonly wsPort = 9700,
    companionPorts?: { http?: number; ws?: number },
  ) {
    this.companion = new CompanionServer(companionPorts?.http, companionPorts?.ws);
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
      // AND the addresses somebody can actually hand out.
      //
      // `listen` without a host binds every interface, so the bridge was
      // always reachable from the network — and only `localhost` was ever
      // printed. A control surface on a tablet is the normal case for this
      // application, not the exception, and whoever sets it up has to be
      // told where to point it.
      //
      // All detected addresses, not one guessed: on a machine with a Docker
      // or VPN bridge the first one is often the wrong one, and whoever
      // reads the list recognises their own.
      for (const entries of Object.values(networkInterfaces())) {
        for (const e of entries ?? []) {
          if (e.family === 'IPv4' && !e.internal) {
            console.log(`[BridgeServer]                     ws://${e.address}:${this.wsPort}  (same network)`);
          }
        }
      }
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
      ws.send(
        JSON.stringify({
          type: 'state',
          cameraNumber,
          state,
          origins: this.cameraOrigins.get(cameraNumber) ?? {},
          confirmations: this.cameraConfirmations.get(cameraNumber) ?? {},
        }),
      );
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
        this.vergissKamera(msg.cameraNumber ?? 0);
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

      // ── Kamera-Plan aus dem MultiCam-Planner (B-41.1) ───────────────────
      //
      // Zwei Schritte, und der erste ist nicht optional: `matchCameraPlan`
      // sagt, welche geplante Kamera auf welchem Slot sitzt und WOMIT das
      // belegt ist, `applyCameraPlan` schreibt es an die Slots. Wer eine
      // Kamera falsch beschriftet, schwenkt spaeter die falsche.
      case 'matchCameraPlan': {
        const plan = this.leseKameraPlan(msg.plan);
        if (!plan) { this.sendError(ws, PLAN_FEHLER); break; }
        ws.send(JSON.stringify({ type: 'cameraPlanMatch', ...matchCameraPlan(plan, this.slotFacts()) }));
        break;
      }

      case 'applyCameraPlan': {
        const plan = this.leseKameraPlan(msg.plan);
        if (!plan) { this.sendError(ws, PLAN_FEHLER); break; }
        const ergebnis = matchCameraPlan(plan, this.slotFacts());
        for (const m of ergebnis.matches) {
          if (m.cameraNumber === undefined) continue;
          const slot = this.getOrCreateSlot(m.cameraNumber);
          slot.plan = plan.cameras.find((c) => c.id === m.planCameraId);
          slot.planMatchedBy = m.matchedBy;
        }
        ws.send(JSON.stringify({ type: 'cameraPlanMatch', ...ergebnis }));
        this.broadcastCameras();
        break;
      }

      case 'assignPlanCamera': {
        // Von Hand: das staerkste Wort. Ueberschreibt jeden Vorschlag und
        // ueberlebt den naechsten Abgleich.
        const num = msg.cameraNumber ?? 0;
        const slot = this.getOrCreateSlot(num);
        if (!msg.planCameraId) {
          slot.plan = undefined;
          slot.planMatchedBy = undefined;
        } else {
          const plan = this.leseKameraPlan(msg.plan);
          const cam = plan?.cameras.find((c) => c.id === msg.planCameraId);
          if (!cam) { this.sendError(ws, 'Diese geplante Kamera steht nicht in der mitgeschickten Liste.'); break; }
          // Dieselbe Kamera darf nicht auf zwei Slots liegen: dann waeren zwei
          // Pulte fuer dasselbe Geraet beschriftet, und eines davon luegt.
          for (const anderer of this.cameras.values()) {
            if (anderer.num !== num && anderer.plan?.id === cam.id) {
              anderer.plan = undefined;
              anderer.planMatchedBy = undefined;
            }
          }
          slot.plan = cam;
          slot.planMatchedBy = 'manual';
        }
        this.broadcastCameras();
        break;
      }
    }
  }

  /** Der Plan als Text oder als Objekt. Beides, damit Hand- und Programmweg denselben Eingang haben. */
  private leseKameraPlan(roh: string | Record<string, unknown> | undefined): CameraPlan | null {
    if (typeof roh === 'string') return parseCameraPlan(roh);
    if (roh && typeof roh === 'object') return parseCameraPlan(JSON.stringify(roh));
    return null;
  }

  /**
   * Was die Bruecke ueber ihre Slots weiss, soweit es fuer den Abgleich zaehlt.
   *
   * `usbDeviceModel` ist der einzige Modellname, den die Slot-Konfiguration
   * heute fuehrt — bei TCP, seriell und den HTTP-Backends steht dort eine
   * Adresse und kein Geraet. Genau deshalb liefert der Abgleich einen Beleg
   * mit, statt ueberall etwas zu behaupten.
   */
  private slotFacts(): SlotFacts[] {
    return [...this.cameras.values()].map((s) => ({
      num: s.num,
      ...(s.config.usbDeviceModel ? { knownModel: s.config.usbDeviceModel } : {}),
      ...(s.planMatchedBy === 'manual' && s.plan ? { planCameraId: s.plan.id } : {}),
    }));
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

  /**
   * Was die Bruecke ueber eine Kamera BEHAUPTET, faellt mit der Verbindung.
   *
   * Zustand, Herkunft und Bestaetigungszeit sind Aussagen ueber ein Geraet,
   * mit dem gerade gesprochen wird. Ohne Verbindung sind sie es nicht mehr:
   * wer die Kamera in der Zwischenzeit am Menue anfasst, macht jede davon
   * still falsch. Beim naechsten Verbindungsaufbau kaemen sie sonst als
   * Aussage der NEUEN Sitzung zurueck.
   *
   * Eine Stelle, damit hier nicht wieder eine Karte vergessen wird — genau
   * das war passiert: `cameraConfirmations` kam mit Bedarf 102 dazu und
   * stand danach in keinem der beiden Aufraeumwege.
   */
  private vergissKamera(num: number): void {
    this.cameraStates.delete(num);
    this.cameraOrigins.delete(num);
    this.cameraConfirmations.delete(num);
  }

  private async disconnectCamera(num: number): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend) return;
    try { await slot.backend.disconnect(); } catch { /* ignore */ }
    slot.backend = null;
    slot.connected = false;
    this.vergissKamera(num);
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
      // BEDARF 46 — `stateChanged` heisst NICHT „vom Geraet gelesen". Mehrere
      // Backends werfen aus `handleRcpCommand` heraus den gerade geschickten
      // Wert als `stateChanged` zurueck (Visca, JVC, Z CAM, Panasonic-PTZ,
      // Sony-USB). Ob es eine Rueckmeldung war, entscheidet deshalb
      // `MODE_READBACK` je Feld und Weg — nicht der Kanal.
      const origins = applyOrigins(
        this.cameraOrigins.get(num),
        slot.config?.connectionMode,
        feldnamen(mapped),
        'read',
      );
      this.cameraOrigins.set(num, origins);
      const confirmations = applyConfirmations(
        this.cameraConfirmations.get(num),
        slot.config?.connectionMode,
        feldnamen(mapped),
        'read',
        Date.now(),
      );
      this.cameraConfirmations.set(num, confirmations);
      this.broadcast({ type: 'state', cameraNumber: num, state: merged, origins, confirmations });
      this.companion.updateCameraStateFor(num, merged as Record<string, unknown>);
    });

    backend.on('disconnected', () => {
      slot.connected = false;
      // Auch beim UNGEWOLLTEN Verbindungsverlust — der ist der haeufigere
      // Fall und der gefaehrlichere: niemand hat etwas getan, und die Werte
      // stehen weiter da, als seien sie bestaetigt.
      this.vergissKamera(num);
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

    // BEDARF 129 — relativ trimmen. Die Aufloesung passiert HIER, einmal, und
    // zwar gegen den Zustand, den die Bruecke fuer diese Kamera fuehrt. Was
    // nach unten geht, ist ein gewoehnliches absolutes Kommando: die Backends
    // kennen keine relative Sprache, und es soll dabei bleiben — sonst
    // muesste jedes von ihnen den Ausgangswert selbst kennen, und dann gaebe
    // es acht Antworten auf die Frage, wovon aus getrimmt wird.
    if (cmd === 'nudge') {
      const aufgeloest = resolveNudge(
        String(params.parameter ?? ''),
        Number(params.by ?? Number.NaN),
        this.cameraStates.get(num),
      );
      if ('refusal' in aufgeloest) {
        // Mit Grund. Eine Taste, die wortlos nichts tut, ist von einer
        // kaputten Bruecke nicht zu unterscheiden.
        this.sendError(ws, NUDGE_REFUSAL_LABEL[aufgeloest.refusal], num);
        return;
      }
      await this.dispatchCommand(ws, num, aufgeloest.command, { value: aufgeloest.value });
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
      // Ein Echo ist ein Echo. Es ueberschreibt eine fruehere Bestaetigung
      // ausdruecklich — was die Kamera vor dem Kommando gemeldet hat, gilt
      // danach nicht mehr, und ein pollendes Backend setzt sie gleich wieder.
      const origins = applyOrigins(
        this.cameraOrigins.get(num),
        slot.config?.connectionMode,
        feldnamen(echo),
        'command',
      );
      this.cameraOrigins.set(num, origins);
      // Und der Zeitstempel faellt mit: er beschriebe sonst das Alter einer
      // Bestaetigung, die einen ANDEREN Wert betraf.
      const confirmations = applyConfirmations(
        this.cameraConfirmations.get(num),
        slot.config?.connectionMode,
        feldnamen(echo),
        'command',
        Date.now(),
      );
      this.cameraConfirmations.set(num, confirmations);
      this.broadcast({ type: 'state', cameraNumber: num, state: merged, origins, confirmations });
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
      // BEDARF 46 — ob dieser Weg ueberhaupt je etwas zurueckliest. Das Pult
      // bekommt die fertige Auskunft und KEINE Kopie von `MODE_READBACK`:
      // eine zweite Tabelle im selben Repo waere die zweite Wahrheit, die
      // dieses Modul gerade abschafft.
      neverReadsBack: neverReadsBack(s.config?.connectionMode ?? 'tcp'),
      // BEDARF 102 — der Takt kommt FERTIG mit, wie schon
      // `neverReadsBack`. Das Pult bekommt kein Duplikat der Tabelle;
      // eine zweite Tabelle waere die zweite Wahrheit.
      freshnessLimits: freshnessLimits(MODE_CADENCE[s.config?.connectionMode ?? 'tcp']),
      // Der Plan geht mit, damit das Pult die Kamera so beschriften kann, wie
      // sie in der Show heisst -- samt Beleg, damit ein blosser Vorschlag
      // nicht wie eine Tatsache aussieht.
      ...(s.plan ? { plan: s.plan, planMatchedBy: s.planMatchedBy } : {}),
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
    // Rohe Reports weiterreichen, wenn der Bedienende sie angefordert hat.
    // Ohne das ist die Belegung eines fremden Pultes Raten: die Byte-Offsets
    // eines Gamepads unterscheiden sich je Modell UND je Anschlussart, und
    // eine abgeschriebene Tabelle legt die Achse still an die falsche Stelle.
    hid.on('report', (hex: string) => this.broadcast({ type: 'hidReport', hex }));
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

    // BEDARF 129 — die relativen Tasten gehen durch DIESELBE Aufloesung wie
    // der WebSocket-Weg (`protocol/paintNudge.ts`). Vorher rechnete diese
    // Stelle drei Sonderfaelle selbst aus, und alle drei waren falsch:
    // `(perCam.iris ?? 128) + 5` erfand einen Ausgangswert, wo die Bruecke
    // keinen gelesen hatte; `Math.min(7, …)` liess `masterGain` auf einen
    // Index laufen, den die Gain-Tabellen der Backends nicht kennen (sie
    // fallen dann auf 0 dB zurueck — die Taste „Gain +" sprang von +18 dB
    // nach unten); `Math.min(4, …)` dasselbe fuer den ND-Filter, der vier
    // Stellungen hat (0..3). `masterBlack`, der Wert aus dem Beleg, kam gar
    // nicht vor.
    const nudge = NUDGE_ACTIONS[action];
    if (nudge) {
      const aufgeloest = resolveNudge(nudge.parameter, nudge.by, this.cameraStates.get(camNum));
      if ('refusal' in aufgeloest) {
        // Companion hat fuer Presets keinen Rueckkanal. Die Absage geht
        // deshalb an die Pult-Clients — irgendwo sichtbar ist besser als
        // nirgends, und „die Taste tut nichts" ist die schlechteste Auskunft.
        this.broadcast({
          type: 'error',
          message: `${nudge.label}: ${NUDGE_REFUSAL_LABEL[aufgeloest.refusal]}`,
          cameraNumber: camNum,
        });
        return;
      }
      action = aufgeloest.command;
      params.value = aufgeloest.value;
    }

    const slot = this.cameras.get(camNum);
    if (!slot?.connected) return;
    const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
    await this.dispatchCommand(dummyWs, camNum, action, params);
  }
}
