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
 *   { type: 'enableDemand', demand } | { type: 'disableDemand' }
 *       Zoom-/Fokus-Demand an einem firmware-b4-Geraet als Quelle von
 *       setZoom/setFocus; siehe input/DemandSource.ts und docs/b4/demand.md.
 *   { type: 'listSwitchers' | 'setSwitcherConfig' | 'connectSwitcher'
 *          | 'disconnectSwitcher' | 'removeSwitcher', switcherNumber, switcherConfig? }
 *   { type: 'switcherCommand', switcherNumber, cmd, params }
 *       cmd: 'preview' {source} | 'cut' | 'take' {source} | 'route' {source, window}
 *          | 'setLayout' {mode} | 'setAudio' {channel} | 'freeze' {seconds} | 'refresh'
 *       Ein Mischer ist KEINE Kamera: eigene Slots, eigenes Vokabular
 *       (switcher/VisCatcClient.ts). Der Vorschau-Bus liegt in der Bruecke.
 *   { type: 'readPose', cameraNumber }                     → { type: 'pose', cameraNumber, pose }
 *   { type: 'drivePlannedPreset', cameraNumber, presetNumber }
 *   { type: 'storePlannedPresets', cameraNumber, presetNumbers?, settleMs? }
 *       faehrt jeden geplanten Shot an und speichert ihn IM KOPF; Fortschritt
 *       als { type: 'plannedProgress', cameraNumber, presetNumber, step, message? }.
 *   { type: 'calibratePose', cameraNumber, presetNumber }
 *       der Kopf steht von Hand auf diesem Shot; die Differenz zur geplanten
 *       Pose wird als `poseOffset` gemerkt (protocol/ptzPose.ts).
 *   { type: 'setPoseOffset', cameraNumber, offset | null }
 *   { type: 'getSite' } | { type: 'importSite', site } | { type: 'setSiteName', name }
 *       Die Anlage als Datei (site/siteFile.ts): Kameras + Mischer. Wird
 *       bei eingeschalteter Persistenz (index.ts, Electron) auf Platte
 *       gehalten und beim Start wiederhergestellt.
 *
 * HTTP auf demselben Port:
 *   GET /video/<cameraNumber>.mjpeg   Livebild als multipart/x-mixed-replace
 *                                     (multiview/RtspHub.ts) -- fuer <img>.
 *   GET /video/<cameraNumber>.jpg     das letzte Bild.
 *   WS  /scope/<cameraNumber>?depth=8|16&width=960
 *                                     rohe R'G'B'-Bilder im Frame-Protokoll
 *                                     von LZ Scopes (multiview/ScopeStream.ts),
 *                                     ein eigener ffmpeg je offenem Scope.
 *   GET /site.json                    die Anlage zum Herunterladen.
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
 *   { type: 'demand', axis, cameraNumber, command, raw, value, present,
 *                     origin: 'commanded' }   nur wenn etwas gesendet wurde
 *   { type: 'demandSource', active, bindings? }
 *   { type: 'tally' | 'ports' | 'wiznetDevices' | 'sonyUsbDevices'
 *          | 'sonyMncDevices' | 'hidDevices' | 'controlSurface' | 'wiznetConfigResult' }
 *   { type: 'switchers', switchers: [{ switcherNumber, config, connected, state, inputLabels }] }
 *   { type: 'switcherState', switcherNumber, state }
 *   { type: 'cameraTally', tally: { [cameraNumber]: 'program' | 'preview' | 'off' } }
 *       abgeleitet aus Programm/Vorschau des Mischers und `switcherInput`
 *       je Kamera. Der globale `tally` (Companion) bleibt daneben bestehen.
 *   { type: 'site', name, site, path? }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import { Rs422Transport } from './transport/Rs422Transport.js';
import { CameraState } from './protocol/CcuClient.js';
import { makeBackend, CameraBackend, CameraConfig } from './cameras/backendFactory.js';
import {
  buildGo2rtcConfig,
  buildLaunchScript,
  buildVlcWindowsScript,
  type MultiviewSource,
} from './multiview/multiviewGenerators.js';
import { RtspHub, checkStreamUrl } from './multiview/RtspHub.js';
import { MAX_SCOPES, parseScopeQuery, runScope, sendFinal } from './multiview/ScopeStream.js';
import { VisCatcClient, type SwitcherConfig, type SwitcherState } from './switcher/VisCatcClient.js';
import type { SourceTally } from './switcher/switcherBus.js';
import { SitePersistence } from './site/persistence.js';
import { emptySite, parseSite, type SiteFile } from './site/siteFile.js';
import { WiznetDiscovery, WiznetDeviceConfig } from './discovery/WiznetDiscovery.js';
import { CompanionServer, TallyState } from './companion/CompanionServer.js';
import { HidControlSurface, HidSurfaceConfig } from './input/HidControlSurface.js';
import { DemandSource, conflictingCommands, type DemandConfig } from './input/DemandSource.js';
import {
  matchCameraPlan, parseCameraPlan,
  type CameraPlan, type PlanCamera, type SlotFacts,
} from './plan/cameraPlan.js';
import { NUDGE_ACTIONS, NUDGE_REFUSAL_LABEL, resolveNudge } from './protocol/paintNudge.js';
import { calibrateOffset, shotToPose, type Pose } from './protocol/ptzPose.js';
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

interface SwitcherSlot {
  num: number;
  config: SwitcherConfig;
  client: VisCatcClient | null;
  connected: boolean;
}

export interface BridgeOptions {
  /** Keep the site on disk and restore it on start. Off in tests. */
  persist?: boolean;
  configDir?: string;
  /** Let the video hub fetch streams outside the private networks. */
  allowAnyStreamHost?: boolean;
}

interface ClientMessage {
  type:
    | 'listCameras' | 'setCameraConfig' | 'connectCamera' | 'disconnectCamera' | 'removeCamera'
    | 'command' | 'listPorts' | 'discoverWiznet' | 'configureWiznet' | 'discoverSonyUsb'
    | 'discoverSonyMnc' | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
    | 'setTally' | 'getTally' | 'enableDemand' | 'disableDemand'
    | 'matchCameraPlan' | 'applyCameraPlan' | 'assignPlanCamera'
    | 'getMultiview'
    | 'listSwitchers' | 'setSwitcherConfig' | 'connectSwitcher' | 'disconnectSwitcher' | 'removeSwitcher'
    | 'switcherCommand'
    | 'getSite' | 'importSite' | 'setSiteName'
    | 'readPose' | 'drivePlannedPreset' | 'storePlannedPresets' | 'calibratePose' | 'setPoseOffset';
  cameraNumber?: number;
  presetNumber?: number;
  presetNumbers?: number[];
  settleMs?: number;
  offset?: { pan: number; tilt: number } | null;
  config?: CameraConfig;
  switcherNumber?: number;
  switcherConfig?: SwitcherConfig;
  site?: string | Record<string, unknown>;
  name?: string;
  cmd?: string;
  params?: Record<string, unknown>;
  deviceIp?: string;
  deviceConfig?: WiznetDeviceConfig;
  surface?: HidSurfaceConfig;
  demand?: DemandConfig;
  tally?: Partial<TallyState>;
  /** Kamera-Plan als Text ODER als Objekt — beides, siehe `handleClientMessage`. */
  plan?: string | Record<string, unknown>;
  /** Fuer `assignPlanCamera`: leer laesst die Zuordnung fallen. */
  planCameraId?: string | null;
}

export class BridgeServer {
  private wss: WebSocketServer;
  /** `/scope/<n>` — kept apart from `wss` so broadcasts never reach a scope socket. */
  private scopeWss: WebSocketServer;
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
  private hidSurfaceConfig: HidSurfaceConfig | null = null;
  private demandSource: DemandSource | null = null;
  private tally: TallyState = { program: false, preview: false, isoRec: false };
  private switchers = new Map<number, SwitcherSlot>();
  private readonly hub: RtspHub;
  private readonly persistence: SitePersistence | null;
  private siteName = '';
  private readonly allowAnyStreamHost: boolean;

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
    opts: BridgeOptions = {},
  ) {
    this.companion = new CompanionServer(companionPorts?.http, companionPorts?.ws);
    this.hub = new RtspHub();
    this.persistence = opts.persist ? new SitePersistence(opts.configDir) : null;
    this.allowAnyStreamHost = opts.allowAnyStreamHost ?? false;
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this.onClient(ws));
    this.scopeWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const scope = /^\/scope\/(\d+)$/.exec(new URL(req.url ?? '/', 'http://bridge').pathname);
      const target = scope ? this.scopeWss : this.wss;
      target.handleUpgrade(req, socket, head, (ws) => {
        if (scope) this.onScope(ws, Number(scope[1]), new URL(req.url ?? '/', 'http://bridge').searchParams);
        else target.emit('connection', ws, req);
      });
    });

    this.companion.on('command', (cmd: { action: string; params?: Record<string, unknown> }) => {
      this.handleCompanionCommand(cmd.action, cmd.params ?? {});
    });
    this.companion.on('tallyChanged', (t: TallyState) => {
      this.tally = t;
      this.broadcast({ type: 'tally', tally: this.tally });
    });
  }

  start(): void {
    this.restoreSite();
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
    this.disableDemand();
    for (const slot of this.cameras.values()) void slot.backend?.disconnect();
    for (const slot of this.switchers.values()) slot.client?.disconnect();
    this.hub.stopAll();
    for (const ws of this.scopeWss.clients) ws.terminate();
    this.scopeWss.close();
    this.persistence?.flush();
    this.companion.stop();
    this.wss.close();
    this.httpServer.close();
  }

  // ─── WebSocket client handling ────────────────────────────────────────────

  private onClient(ws: WebSocket): void {
    console.log('[BridgeServer] Web client connected');
    this.sendCameras(ws);
    this.sendSwitchers(ws);
    ws.send(JSON.stringify({ type: 'tally', tally: this.tally }));
    ws.send(JSON.stringify({ type: 'cameraTally', tally: this.cameraTally() }));
    this.sendSite(ws);
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
        this.siteChanged();
        break;
      }

      case 'connectCamera':
        await this.connectCamera(msg.cameraNumber ?? 0);
        break;

      case 'disconnectCamera':
        await this.disconnectCamera(msg.cameraNumber ?? 0);
        break;

      case 'removeCamera':
        await this.removeCameraSlot(msg.cameraNumber ?? 0);
        this.broadcastCameras();
        this.siteChanged();
        break;

      // ─── Switcher ───────────────────────────────────────────────────────
      case 'listSwitchers':
        this.sendSwitchers(ws);
        break;

      case 'setSwitcherConfig': {
        const num = msg.switcherNumber ?? 1;
        const slot = this.getOrCreateSwitcher(num);
        slot.config = { ...slot.config, ...(msg.switcherConfig ?? {}) };
        this.sendSwitchers();
        this.siteChanged();
        break;
      }

      case 'connectSwitcher':
        await this.connectSwitcher(msg.switcherNumber ?? 1);
        break;

      case 'disconnectSwitcher':
        this.disconnectSwitcher(msg.switcherNumber ?? 1);
        break;

      case 'removeSwitcher':
        this.disconnectSwitcher(msg.switcherNumber ?? 1);
        this.switchers.delete(msg.switcherNumber ?? 1);
        this.sendSwitchers();
        this.broadcastCameraTally();
        this.siteChanged();
        break;

      case 'switcherCommand':
        await this.dispatchSwitcherCommand(ws, msg.switcherNumber ?? 1, msg.cmd ?? '', msg.params ?? {});
        break;

      // ─── Planned shots ──────────────────────────────────────────────────
      case 'readPose': {
        const num = msg.cameraNumber ?? 0;
        const pose = await this.readPose(ws, num);
        if (pose) ws.send(JSON.stringify({ type: 'pose', cameraNumber: num, pose }));
        break;
      }

      case 'drivePlannedPreset': {
        const num = msg.cameraNumber ?? 0;
        await this.drivePlanned(ws, num, msg.presetNumber ?? -1);
        break;
      }

      case 'storePlannedPresets': {
        const num = msg.cameraNumber ?? 0;
        await this.storePlanned(ws, num, msg.presetNumbers, msg.settleMs);
        break;
      }

      case 'calibratePose': {
        const num = msg.cameraNumber ?? 0;
        await this.calibratePose(ws, num, msg.presetNumber ?? -1);
        break;
      }

      case 'setPoseOffset': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); break; }
        const offset = msg.offset;
        if (offset && Number.isFinite(offset.pan) && Number.isFinite(offset.tilt)) slot.config.poseOffset = { pan: offset.pan, tilt: offset.tilt };
        else delete slot.config.poseOffset;
        this.broadcastCameras();
        this.siteChanged();
        break;
      }

      // ─── Site ─────────────────────────────────────────────────────────────
      case 'getSite':
        this.sendSite(ws);
        break;

      case 'setSiteName':
        this.siteName = String(msg.name ?? '').slice(0, 120);
        this.sendSite();
        this.siteChanged();
        break;

      case 'importSite': {
        const text = typeof msg.site === 'string' ? msg.site : JSON.stringify(msg.site ?? null);
        const site = parseSite(text); // throws with a sentence → sendError via the catch above
        await this.applySite(site, true);
        break;
      }

      case 'command':
        if (!msg.cmd) break;
        await this.dispatchCommand(ws, msg.cameraNumber ?? 0, msg.cmd, msg.params ?? {});
        break;

      case 'listPorts': {
        const ports = await Rs422Transport.listPorts();
        ws.send(JSON.stringify({ type: 'ports', ports }));
        break;
      }
      // Multiviewer add-on: turn the configured stream URLs into the artefacts
      // that show every camera at once (go2rtc for RTSP→WebRTC, plus local
      // mpv/ffmpeg and VLC launchers). Only cameras that carry a streamUrl take
      // part — the control path and the picture path are separate.
      case 'getMultiview': {
        const sources: MultiviewSource[] = [...this.cameras.values()]
          .filter((slot) => Boolean(slot.config?.streamUrl))
          .map((slot) => ({
            label: slot.plan?.label ?? `Cam ${slot.num}`,
            streamUrl: slot.config!.streamUrl!,
          }));
        ws.send(
          JSON.stringify({
            type: 'multiview',
            sources,
            go2rtc: buildGo2rtcConfig(sources),
            launchScript: buildLaunchScript(sources),
            vlcScript: buildVlcWindowsScript(sources),
          }),
        );
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

      case 'enableDemand':
        if (!msg.demand) { this.sendError(ws, 'Missing demand config'); break; }
        this.enableDemand(msg.demand);
        break;

      case 'disableDemand':
        this.disableDemand();
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
        this.siteChanged();
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
        this.siteChanged();
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

  /** Drop the slot entirely — the one place, used by `removeCamera` and by a site import. */
  private async removeCameraSlot(num: number): Promise<void> {
    await this.disconnectCamera(num);
    this.cameras.delete(num);
    this.vergissKamera(num);
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
    this.broadcastCameraTally();
  }

  // ─── HID control surface ────────────────────────────────────────────────

  private async enableControlSurface(surface: HidSurfaceConfig): Promise<void> {
    this.disableControlSurface();
    const clash = this.demandSource ? conflictingCommands(this.demandSource.bindings, surface.bindings) : [];
    if (clash.length > 0) {
      throw new Error(
        `Control surface refused: ${clash.join(', ')} is already driven by a demand. ` +
          'Two sources on one axis cancel each other out — disable the demand first.',
      );
    }
    this.hidSurfaceConfig = surface;
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
    this.hidSurfaceConfig = null;
  }

  // ─── Demand source (phase 4) ────────────────────────────────────────────

  /**
   * A zoom/focus demand as a source on this bus. Its commands take the same
   * path as a tap on the panel, so they are 'commanded' and never 'confirmed'.
   * Refused while a HID surface drives the same command — see
   * `conflictingCommands` for why.
   */
  private enableDemand(cfg: DemandConfig): void {
    this.disableDemand();
    const clash = this.hidSurfaceConfig ? conflictingCommands(cfg.bindings, this.hidSurfaceConfig.bindings) : [];
    if (clash.length > 0) {
      throw new Error(
        `Demand refused: ${clash.join(', ')} is already driven by the control surface. ` +
          'Two sources on one axis cancel each other out — disable the surface first.',
      );
    }
    const src = new DemandSource(cfg);
    this.demandSource = src;
    src.on('command', ({ cameraNumber, cmd, params }: { cameraNumber: number; cmd: string; params: Record<string, unknown> }) => {
      const slot = this.cameras.get(cameraNumber);
      if (!slot?.connected) return; // nothing to drive; the broadcast still shows the demand
      const quietWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      void this.dispatchCommand(quietWs, cameraNumber, cmd, params);
    });
    src.on('demand', (ev) => this.broadcast({ type: 'demand', ...ev }));
    src.on('error', (err: Error) => this.broadcast({ type: 'error', message: `Demand: ${err.message}` }));
    src.start();
    this.broadcast({ type: 'demandSource', active: true, bindings: cfg.bindings.map((b) => ({ axis: b.axis, cameraNumber: b.cameraNumber, command: b.command })) });
  }

  private disableDemand(): void {
    if (!this.demandSource) return;
    // stop() releases every driven axis — the stop goes out before the source is gone.
    this.demandSource.stop();
    this.demandSource.removeAllListeners();
    this.demandSource = null;
    this.broadcast({ type: 'demandSource', active: false });
  }


  // ─── Switcher slots ───────────────────────────────────────────────────────

  private getOrCreateSwitcher(num: number): SwitcherSlot {
    let slot = this.switchers.get(num);
    if (!slot) {
      slot = { num, config: { kind: 'vis-catc' }, client: null, connected: false };
      this.switchers.set(num, slot);
    }
    return slot;
  }

  private async connectSwitcher(num: number): Promise<void> {
    const slot = this.switchers.get(num);
    if (!slot) throw new Error(`Switcher ${num} is not configured`);
    if (slot.client) {
      slot.client.disconnect();
      slot.client = null;
      slot.connected = false;
    }
    const client = new VisCatcClient(slot.config);
    slot.client = client;
    client.on('connected', () => {
      slot.connected = true;
      console.log(`[BridgeServer] Switcher ${num} connected (${slot.config.path ?? 'http'})`);
      this.sendSwitchers();
      this.broadcastCameraTally();
    });
    client.on('stateChanged', (state: SwitcherState) => {
      this.broadcast({ type: 'switcherState', switcherNumber: num, state });
      this.broadcastCameraTally();
    });
    client.on('disconnected', () => {
      slot.connected = false;
      this.sendSwitchers();
      this.broadcastCameraTally();
    });
    client.on('error', (err: Error) => {
      this.broadcast({ type: 'error', message: err.message, switcherNumber: num });
    });
    await client.connect();
  }

  private disconnectSwitcher(num: number): void {
    const slot = this.switchers.get(num);
    if (!slot?.client) return;
    slot.client.disconnect();
    slot.client = null;
    slot.connected = false;
    this.sendSwitchers();
    this.broadcastCameraTally();
  }

  private async dispatchSwitcherCommand(ws: WebSocket, num: number, cmd: string, params: Record<string, unknown>): Promise<void> {
    const slot = this.switchers.get(num);
    const client = slot?.client;
    if (!client || !slot?.connected) {
      this.sendError(ws, `Switcher ${num} is not connected`);
      return;
    }
    const n = (k: string, d = 0) => Number(params[k] ?? d);
    let ok = true;
    switch (cmd) {
      case 'preview': client.setPreview(n('source')); break;
      case 'cut': ok = await client.doCut(); break;
      case 'take': ok = await client.take(n('source')); break;
      case 'route': ok = await client.route(n('source'), n('window', 1)); break;
      case 'setLayout': ok = await client.setLayout(n('mode')); break;
      case 'setAudio': ok = await client.setAudio(n('channel')); break;
      case 'freeze': ok = await client.freeze(n('seconds', 3)); break;
      case 'refresh': ok = await client.refresh(); break;
      default:
        this.sendError(ws, `'${cmd}' is not a switcher command`);
        return;
    }
    // `false` with a reason has already gone out as an `error` event from the
    // client; a false without one is the bus saying "nothing to do" (CUT
    // without a preview), which is not an error.
    void ok;
  }

  private sendSwitchers(ws?: WebSocket): void {
    const switchers = [...this.switchers.values()].map((s) => ({
      switcherNumber: s.num,
      config: s.config,
      connected: s.connected,
      state: s.client?.state ?? null,
      inputLabels: s.client?.inputLabels ?? s.config.inputLabels ?? null,
    }));
    const msg = JSON.stringify({ type: 'switchers', switchers });
    if (ws) ws.send(msg);
    else this.broadcastRaw(msg);
  }

  /**
   * Tally per camera, derived — not stored. The first connected switcher's
   * programme and preview against every camera's `switcherInput`. A camera
   * without an input, or without a connected switcher, is `off`, not
   * "unknown": the panel shows a lamp, and a lamp is either lit or not.
   */
  private cameraTally(): Record<number, SourceTally> {
    const sw = [...this.switchers.values()].find((s) => s.connected && s.client);
    const bus = sw?.client?.state;
    const out: Record<number, SourceTally> = {};
    for (const cam of this.cameras.values()) {
      const input = cam.config?.switcherInput ?? 0;
      let t: SourceTally = 'off';
      if (bus && input > 0) {
        if (bus.program === input) t = 'program';
        else if (bus.preview === input) t = 'preview';
      }
      out[cam.num] = t;
    }
    return out;
  }

  private broadcastCameraTally(): void {
    this.broadcast({ type: 'cameraTally', tally: this.cameraTally() });
  }


  // ─── Planned shots ────────────────────────────────────────────────────────

  private plannedPose(slot: CameraSlot, presetNumber: number): { pose: Pose; fit: string; name: string } | string {
    const plan = slot.plan;
    if (!plan) return `Camera ${slot.num} has no planned camera assigned (Wall → plan).`;
    const shot = plan.presets?.find((p) => p.number === presetNumber);
    if (!shot) return `The plan of camera ${slot.num} has no shot ${presetNumber}.`;
    const homeHeading = slot.config.homeHeading ?? plan.pan ?? 0;
    const lens = { focalMinMm: plan.lens?.focalMinMm, focalMaxMm: plan.lens?.focalMaxMm, zoomTable: slot.config.zoomTable };
    const { fit, ...pose } = shotToPose(shot, homeHeading, slot.config.poseOffset, lens);
    return { pose, fit, name: shot.name };
  }

  private async readPose(ws: WebSocket, num: number): Promise<Pose | null> {
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) { this.sendError(ws, `Camera ${num} is not connected`, num); return null; }
    if (!slot.backend.readPose) { this.sendError(ws, `Camera ${num} cannot report its pose on this path`, num); return null; }
    try {
      return await slot.backend.readPose();
    } catch (err) {
      this.sendError(ws, `Camera ${num}: ${(err as Error).message}`, num);
      return null;
    }
  }

  private async drivePlanned(ws: WebSocket, num: number, presetNumber: number): Promise<boolean> {
    const slot = this.cameras.get(num);
    if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); return false; }
    const planned = this.plannedPose(slot, presetNumber);
    if (typeof planned === 'string') { this.sendError(ws, planned, num); return false; }
    const params: Record<string, unknown> = { pan: planned.pose.pan, tilt: planned.pose.tilt };
    if (planned.pose.zoom !== undefined) params.zoom = planned.pose.zoom;
    this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber, step: 'driving', message: planned.name, fit: planned.fit });
    await this.dispatchCommand(ws, num, 'ptzAbsolute', params);
    return true;
  }

  /**
   * Drive every planned shot and store it in the head, one after the other.
   * The settle time is the head's, not ours: a preset stored while the head
   * still moves is the wrong preset. Progress goes to every client; one
   * failed shot does not stop the rest.
   */
  private async storePlanned(ws: WebSocket, num: number, presetNumbers?: number[], settleMs = 4000): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) { this.sendError(ws, `Camera ${num} is not connected`, num); return; }
    const shots = (slot.plan?.presets ?? []).filter((p) => !presetNumbers || presetNumbers.includes(p.number));
    if (shots.length === 0) { this.sendError(ws, `Camera ${num} has no planned shots to store`, num); return; }
    for (const shot of shots) {
      if (shot.number < 1) {
        this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber: shot.number, step: 'failed', message: 'preset number 0 cannot be stored in a head' });
        continue;
      }
      const ok = await this.drivePlanned(ws, num, shot.number);
      if (!ok) { this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber: shot.number, step: 'failed' }); continue; }
      await new Promise((r) => setTimeout(r, Math.max(0, settleMs)));
      const stored = await slot.backend.handleRcpCommand('storePreset', { value: shot.number, cameraNumber: num }).catch(() => false);
      this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber: shot.number, step: stored ? 'stored' : 'failed', message: shot.name });
    }
    this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber: 0, step: 'done' });
  }

  private async calibratePose(ws: WebSocket, num: number, presetNumber: number): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.plan) { this.sendError(ws, `Camera ${num} has no planned camera assigned`, num); return; }
    const shot = slot.plan.presets?.find((p) => p.number === presetNumber);
    if (!shot) { this.sendError(ws, `The plan of camera ${num} has no shot ${presetNumber}`, num); return; }
    const actual = await this.readPose(ws, num);
    if (!actual) return;
    const homeHeading = slot.config.homeHeading ?? slot.plan.pan ?? 0;
    slot.config.poseOffset = calibrateOffset(shot, homeHeading, actual);
    this.broadcast({ type: 'pose', cameraNumber: num, pose: actual, offset: slot.config.poseOffset });
    this.broadcastCameras();
    this.siteChanged();
  }

  // ─── Site ─────────────────────────────────────────────────────────────────

  currentSite(): SiteFile {
    const site = emptySite(this.siteName);
    for (const s of [...this.cameras.values()].sort((a, b) => a.num - b.num)) {
      site.cameras.push({
        cameraNumber: s.num, config: s.config, autoConnect: s.connected || Boolean(s.backend),
        ...(s.plan ? { plan: s.plan, planMatchedBy: s.planMatchedBy } : {}),
      });
    }
    for (const s of [...this.switchers.values()].sort((a, b) => a.num - b.num)) {
      site.switchers.push({ switcherNumber: s.num, config: s.config, autoConnect: s.connected || Boolean(s.client) });
    }
    return site;
  }

  private sendSite(ws?: WebSocket): void {
    const msg = JSON.stringify({
      type: 'site',
      name: this.siteName,
      site: this.currentSite(),
      path: this.persistence?.path ?? null,
    });
    if (ws) ws.send(msg);
    else this.broadcastRaw(msg);
  }

  private siteChanged(): void {
    this.persistence?.save(this.currentSite());
  }

  private restoreSite(): void {
    const site = this.persistence?.load();
    if (!site) return;
    console.log(`[BridgeServer] Site restored from ${this.persistence!.path}: ${site.cameras.length} cameras, ${site.switchers.length} switchers`);
    void this.applySite(site, false);
  }

  /**
   * Replace the whole room. Everything connected is disconnected first; the
   * slots of the file take over; what the file marks `autoConnect` is
   * connected, each on its own, so one dead camera does not hold up the rest.
   */
  private async applySite(site: SiteFile, announce: boolean): Promise<void> {
    for (const num of [...this.cameras.keys()]) await this.removeCameraSlot(num);
    for (const num of [...this.switchers.keys()]) {
      this.disconnectSwitcher(num);
      this.switchers.delete(num);
    }
    this.siteName = site.name;
    for (const c of site.cameras) {
      const slot = this.getOrCreateSlot(c.cameraNumber);
      slot.config = { ...c.config };
      if (c.plan) { slot.plan = c.plan; slot.planMatchedBy = c.planMatchedBy ?? 'manual'; }
    }
    for (const s of site.switchers) this.getOrCreateSwitcher(s.switcherNumber).config = { ...s.config };
    this.broadcastCameras();
    this.sendSwitchers();
    this.sendSite();
    if (announce) this.siteChanged();
    for (const c of site.cameras) {
      if (c.autoConnect === false) continue;
      this.connectCamera(c.cameraNumber).catch((err) =>
        this.broadcast({ type: 'error', message: (err as Error).message, cameraNumber: c.cameraNumber }),
      );
    }
    for (const s of site.switchers) {
      if (s.autoConnect === false) continue;
      this.connectSwitcher(s.switcherNumber).catch((err) =>
        this.broadcast({ type: 'error', message: (err as Error).message, switcherNumber: s.switcherNumber }),
      );
    }
  }

  // ─── HTTP: live video and the site file ───────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url ?? '/', 'http://bridge');
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'lz-camera-bridge', cameras: this.cameras.size, switchers: this.switchers.size, streams: this.hub.activeCount, scopes: this.scopeWss.clients.size }));
      return;
    }
    if (url.pathname === '/site.json') {
      const name = (this.siteName || 'site').replace(/[^\w.-]+/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}.lz-site.json"`,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(this.currentSite(), null, 2));
      return;
    }
    const video = /^\/video\/(\d+)\.(mjpeg|jpg)$/.exec(url.pathname);
    if (video) {
      this.serveVideo(Number(video[1]), video[2] as 'mjpeg' | 'jpg', res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('LZ Camera Bridge: WebSocket on this port; /video/<n>.mjpeg, /scope/<n> (WebSocket), /site.json, /health');
  }

  /** One scope socket: checks like `serveVideo`, then its own ffmpeg until either side closes. */
  private onScope(ws: WebSocket, num: number, params: URLSearchParams): void {
    ws.on('error', () => {});
    const streamUrl = this.cameras.get(num)?.config.streamUrl;
    if (!streamUrl) return sendFinal(ws, 'error', `Camera ${num} has no stream address`);
    const refusal = checkStreamUrl(streamUrl, this.allowAnyStreamHost);
    if (refusal) return sendFinal(ws, 'error', refusal);
    if (this.scopeWss.clients.size > MAX_SCOPES) {
      return sendFinal(ws, 'error', `At most ${MAX_SCOPES} scopes at once — each one opens its own stream session.`);
    }
    void runScope(ws, streamUrl, parseScopeQuery(params)).catch((err) => sendFinal(ws, 'error', (err as Error).message));
  }

  private serveVideo(num: number, kind: 'mjpeg' | 'jpg', res: ServerResponse): void {
    const slot = this.cameras.get(num);
    const streamUrl = slot?.config.streamUrl;
    if (!streamUrl) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Camera ${num} has no stream address`);
      return;
    }
    const refusal = checkStreamUrl(streamUrl, this.allowAnyStreamHost);
    if (refusal) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(refusal);
      return;
    }
    if (kind === 'jpg') {
      const frame = this.hub.lastFrame(streamUrl);
      if (!frame) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '2' });
        res.end('No picture yet');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      res.end(frame);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=lzframe',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    let closed = false;
    const unsubscribe = this.hub.subscribe(streamUrl, {
      frame: (jpeg) => {
        if (closed) return;
        // Drop frames when the client cannot keep up; a tile that lags a
        // second is better than a bridge that buffers a minute.
        if (res.writableLength > 2 * 1024 * 1024) return;
        res.write(`--lzframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      },
      error: (reason) => {
        if (closed) return;
        // The stream stays open; the hub retries. A text part tells a
        // curious reader why the picture froze — <img> simply keeps the last frame.
        res.write(`--lzframe\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}\r\n`);
      },
    });
    const done = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    res.on('close', done);
    res.on('error', done);
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

    if (action === 'switcherCut' || action === 'switcherPreview' || action === 'switcherTake') {
      const dummyWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      const num = Number(params.switcherNumber ?? [...this.switchers.keys()][0] ?? 1);
      const cmd = action === 'switcherCut' ? 'cut' : action === 'switcherPreview' ? 'preview' : 'take';
      await this.dispatchSwitcherCommand(dummyWs, num, cmd, { source: Number(params.source ?? 0) });
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
