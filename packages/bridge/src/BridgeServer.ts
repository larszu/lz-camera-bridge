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
 *          | 'discoverSonyUsb' | 'discoverSonyMnc' | 'discoverSonyNet'
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
 *   { type: 'zoomTo', cameraNumber, zoom }                 absolute Zoomstellung 0..1
 *   { type: 'captureZoomPoint', cameraNumber, focalMm }
 *       liest die Zoomstellung des Kopfs und merkt sie mit der abgelesenen
 *       Brennweite in `zoomTable` — die gemessene Kurve dieses Modells.
 *   { type: 'clearZoomTable', cameraNumber }
 *   { type: 'setPresetMotion', cameraNumber, presetNumber, timeMs?, soft? }
 *       Fahrzeit und Weich-Schalter eines Presets (motion/PresetGlide.ts).
 *       `storePreset`/`recallPreset` als `command` laufen ueber die Bruecke:
 *       wo der Kopf absolut positioniert und seine Pose meldet, wird die Pose
 *       gemerkt und weich angefahren; sonst das Preset der Kamera.
 *   { type: 'aimFrame', cameraNumber, source: 'picture' | 'panorama', frame: {x,y,w,h}, aspect? }
 *       Rahmen im Bild (0..1) → Pan/Tilt/Zoom (protocol/frameAim.ts). 'picture'
 *       ist das Livebild an der Pose, die der Kopf JETZT meldet; 'panorama'
 *       die gespeicherte Karte. Antwort an alle: { type: 'aim', cameraNumber, pose, hfovDeg, fit }.
 *   { type: 'scanPanorama', cameraNumber, scan? } | { type: 'cancelPanorama', cameraNumber }
 *       Raster abfahren, je Stopp ein Bild, zur Karte zusammensetzen
 *       (panorama/). Fortschritt { type: 'panoramaProgress', cameraNumber,
 *       step, index?, total?, message? }, danach { type: 'panorama', cameraNumber, meta }.
 *   { type: 'getPanorama', cameraNumber }                  → { type: 'panorama', cameraNumber, meta | null }
 *   { type: 'calibrateFov', cameraNumber, zooms? }
 *       Bildwinkel je Zoomstellung messen (kleiner Schwenk, Bildverschiebung);
 *       Fortschritt als { type: 'fovProgress', … }, Ergebnis in `fovTable`.
 *   { type: 'getSite' } | { type: 'importSite', site } | { type: 'setSiteName', name }
 *   FreeD tracking (transport/FreeDOutput.ts, docs/freed-tracking.md):
 *   { type: 'getFreeD' } | { type: 'setFreeD', freed: { targets, rateHz, pollMs? } | null }
 *   { type: 'setCameraFreeD', cameraNumber, freed: FreeDCameraConfig | null }
 *       -> { type: 'freed', config, status }  on change and once a second while streaming
 *   Studio shots (motion/studioShots.ts) -- shot sets, seat shots, moves:
 *   { type: 'setStudioShots', shots }                        replaces all of them, kept in the site
 *   { type: 'recallShot', cameraNumber, presetNumber, source?, mode?, timeMs?, force? }
 *   { type: 'recallShotSet', id, force?, cameras? }          every camera of a set, one common move time
 *   { type: 'recallSeat', id, force? }                       the best camera for this seat
 *   { type: 'playMove', id, force? } | { type: 'stopMove', cameraNumber }
 *       -> { type: 'studioShots', shots }
 *        | { type: 'shotRecalled', cameraNumber, presetNumber, source, mode, timeMs, note? }
 *        | { type: 'shotHeld', cameras, label, retry }   the camera is on air; `retry` is the
 *          message that, sent again (it carries `force: true`), moves it anyway. Also for
 *          `recallPreset`, `drivePlannedPreset` and `storePlannedPresets`.
 *        | { type: 'seatRecalled', id, cameraNumber }
 *        | { type: 'moveProgress', id, cameraNumber, step, of, state }
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
 *   GET /panorama/<cameraNumber>.jpg  die Panorama-Karte, `.json` ihre Ausdehnung.
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
import { makeBackend, presetRecallFor, POSE_READ_MODES, CameraBackend, CameraConfig } from './cameras/backendFactory.js';
import { FreeDOutput } from './transport/FreeDOutput.js';
import { normaliseFreeDSite, type FreeDCameraConfig } from './protocol/freeDPose.js';
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
import { EasedDrive, isRamped } from './motion/EasedDrive.js';
import { DEFAULT_RAMP } from './motion/Easing.js';
import { DEFAULT_GLIDE, PresetGlide, clampGlideTime, glideFrames, type BridgePreset } from './motion/PresetGlide.js';
import {
  clampTime, emptyStudioShots, heldByOnAir, normaliseStudioShots, pickSeatShot,
  type RecallMode, type ShotRef, type ShotSource, type StudioShots,
} from './motion/studioShots.js';
import {
  matchCameraPlan, parseCameraPlan,
  type CameraPlan, type PlanCamera, type SlotFacts,
} from './plan/cameraPlan.js';
import { NUDGE_ACTIONS, NUDGE_REFUSAL_LABEL, resolveNudge } from './protocol/paintNudge.js';
import { calibrateOffset, shotToPose, type Pose } from './protocol/ptzPose.js';
import { aimFromMap, aimFromPicture, hfovAt, moveTimeMs, zoomForHfov, type FovModel, type Frame } from './protocol/frameAim.js';
import { PanoramaStore } from './panorama/PanoramaStore.js';
import { ffmpegCodec, jpegSize } from './panorama/jpegCodec.js';
import {
  DEFAULT_CALIBRATION_ZOOMS, isCancelled, mergeFovTable, runFovCalibration, runScan, scanSettings,
  type JobDeps, type ScanSettings,
} from './panorama/PanoramaScan.js';
import { configDir } from './site/persistence.js';
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

/** Commands that take the head over from a running preset glide. */
/**
 * Speed commands whose last value keeps the head moving. If the client that
 * sent a non-zero one goes away (Companion restarted, network gone, panel
 * closed while a key is held), nobody will ever send the release — so the
 * bridge sends it: the axis stops instead of driving into its end stop.
 */
const HELD_SPEEDS: Record<string, string[]> = { ptz: ['pan', 'tilt'], setZoom: ['value'], setFocus: ['value'], setColumn: ['value'] };

const GLIDE_BREAKERS = new Set(['ptz', 'setZoom', 'home', 'ptzAbsolute', 'zoomAbsolute', 'stop', 'gotoAngle', 'recenter']);

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
  /** Ease-in/out for pan/tilt, zoom and focus speed demands (motion/EasedDrive.ts). */
  eased?: EasedDrive;
  /** The running eased preset recall, if any (motion/PresetGlide.ts). */
  glide?: PresetGlide;
  /** Bumped by every new move; a running shot move (motion/studioShots.ts) stops when it changes. */
  moveToken?: number;
}

type RecallOutcome = { outcome: 'moved' | 'held' | 'failed'; ms: number };

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
    | 'discoverSonyMnc' | 'discoverSonyNet' | 'listHidDevices' | 'enableControlSurface' | 'disableControlSurface'
    | 'setTally' | 'getTally' | 'enableDemand' | 'disableDemand'
    | 'matchCameraPlan' | 'applyCameraPlan' | 'assignPlanCamera'
    | 'getMultiview'
    | 'listSwitchers' | 'setSwitcherConfig' | 'connectSwitcher' | 'disconnectSwitcher' | 'removeSwitcher'
    | 'switcherCommand'
    | 'getSite' | 'importSite' | 'setSiteName'
    | 'getFreeD' | 'setFreeD' | 'setCameraFreeD'
    | 'readPose' | 'drivePlannedPreset' | 'storePlannedPresets' | 'calibratePose' | 'setPoseOffset'
    | 'zoomTo' | 'captureZoomPoint' | 'clearZoomTable' | 'setPresetMotion'
    | 'aimFrame' | 'scanPanorama' | 'cancelPanorama' | 'getPanorama' | 'calibrateFov'
    | 'setStudioShots' | 'recallShot' | 'recallShotSet' | 'recallSeat' | 'playMove' | 'stopMove';
  cameraNumber?: number;
  presetNumber?: number;
  presetNumbers?: number[];
  settleMs?: number;
  offset?: { pan: number; tilt: number } | null;
  zoom?: number;
  focalMm?: number;
  timeMs?: number;
  soft?: boolean;
  /** aimFrame: where the frame was drawn ('picture' | 'panorama'), the frame itself (0..1) and the picture's width/height. recallShot: 'head' | 'plan'. */
  source?: 'picture' | 'panorama' | ShotSource;
  frame?: Frame;
  aspect?: number;
  scan?: Partial<ScanSettings>;
  zooms?: number[];
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
  /** Studio shots. */
  shots?: unknown;
  id?: string;
  mode?: RecallMode;
  /** Move a camera that is on air anyway. */
  force?: boolean;
  cameras?: number[];
  /** setFreeD: site settings; setCameraFreeD: this camera's. */
  freed?: unknown;
}

export class BridgeServer {
  private wss: WebSocketServer;
  /** `/scope/<n>` — kept apart from `wss` so broadcasts never reach a scope socket. */
  private scopeWss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private cameras = new Map<number, CameraSlot>();
  private held = new WeakMap<WebSocket, Map<number, Set<string>>>();
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
  private studioShots: StudioShots = emptyStudioShots();
  private readonly allowAnyStreamHost: boolean;
  private readonly panoramas: PanoramaStore;
  /** One head job (panorama scan, field-of-view calibration) per camera at a time. */
  private readonly jobs = new Map<number, { kind: 'scan' | 'calibration'; cancel: boolean }>();
  /** FreeD tracking out of every enabled camera that reports its pose. */
  private readonly freed = new FreeDOutput();
  private freedTimer: ReturnType<typeof setInterval> | null = null;

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
    this.panoramas = new PanoramaStore(opts.persist ? opts.configDir ?? configDir() : null);
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
    this.companion.on('portError', (e: { what: string; port: number; busy: boolean }) => {
      this.broadcast({ type: 'error', message: `Companion ${e.what}: port ${e.port} ${e.busy ? 'is in use by another program' : 'failed'}` });
    });
    this.companion.on('tallyChanged', (t: TallyState) => {
      this.tally = t;
      this.broadcast({ type: 'tally', tally: this.tally });
    });
  }

  start(): void {
    this.restoreSite();
    // Without a listener a busy port is an uncaught exception that takes the
    // whole app down (issue #143) — here it is a sentence in the log.
    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      console.error(
        err.code === 'EADDRINUSE'
          ? `[BridgeServer] Port ${this.wsPort} is in use — is another LZ Camera Bridge running? The panel talks to that one.`
          : `[BridgeServer] ${err.message}`,
      );
    });
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
    this.freed.stop();
    if (this.freedTimer) { clearInterval(this.freedTimer); this.freedTimer = null; }
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
    ws.send(JSON.stringify({ type: 'studioShots', shots: this.studioShots }));
    this.sendSite(ws);
    ws.send(this.freedMessage());
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
    ws.on('close', () => {
      console.log('[BridgeServer] Web client disconnected');
      this.releaseHeld(ws);
    });
    ws.on('error', (err) => console.error('[BridgeServer] WS error:', err));
  }

  /** Remembers which speed axes a client left moving (see HELD_SPEEDS). */
  private trackHeld(ws: WebSocket, num: number, cmd: string, params: Record<string, unknown>): void {
    const keys = HELD_SPEEDS[cmd];
    if (!keys) return;
    let perCam = this.held.get(ws);
    if (!perCam) this.held.set(ws, (perCam = new Map()));
    let cmds = perCam.get(num);
    if (!cmds) perCam.set(num, (cmds = new Set()));
    if (keys.some((k) => Number(params[k] ?? 0) !== 0)) cmds.add(cmd);
    else cmds.delete(cmd);
  }

  private releaseHeld(ws: WebSocket): void {
    const perCam = this.held.get(ws);
    this.held.delete(ws);
    if (!perCam) return;
    const quietWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
    for (const [num, cmds] of perCam) {
      for (const cmd of cmds) {
        console.log(`[BridgeServer] Client gone while camera ${num} ${cmd} was held — stopping it`);
        const zero = Object.fromEntries(HELD_SPEEDS[cmd].map((k) => [k, 0]));
        // Not raw: a running ease ramp must get target 0 too, or it keeps sending.
        void this.dispatchCommand(quietWs, num, cmd, zero).catch(() => {});
      }
    }
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
        this.syncFreeD();
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
        if (pose) ws.send(JSON.stringify({ type: 'pose', cameraNumber: num, pose, ...this.viewOf(num, pose) }));
        break;
      }

      // ─── Aim by frame, panorama ─────────────────────────────────────────
      case 'aimFrame':
        await this.aimFrame(ws, msg.cameraNumber ?? 0, msg.source === 'panorama' ? 'panorama' : 'picture', msg.frame, msg.aspect);
        break;

      case 'scanPanorama':
        await this.scanPanorama(ws, msg.cameraNumber ?? 0, msg.scan);
        break;

      case 'calibrateFov':
        await this.calibrateFov(ws, msg.cameraNumber ?? 0, msg.zooms);
        break;

      case 'cancelPanorama': {
        const job = this.jobs.get(msg.cameraNumber ?? 0);
        if (job) job.cancel = true;
        break;
      }

      case 'getPanorama': {
        const num = msg.cameraNumber ?? 0;
        ws.send(JSON.stringify({ type: 'panorama', cameraNumber: num, meta: this.panoramas.get(num)?.meta ?? null }));
        break;
      }

      case 'drivePlannedPreset': {
        const num = msg.cameraNumber ?? 0;
        if (this.holdOnAir(num, msg.force, `Planned shot ${msg.presetNumber}`, { ...msg })) break;
        await this.drivePlanned(ws, num, msg.presetNumber ?? -1);
        break;
      }

      case 'storePlannedPresets': {
        const num = msg.cameraNumber ?? 0;
        if (this.holdOnAir(num, msg.force, 'Store all shots in head', { ...msg })) break;
        await this.storePlanned(ws, num, msg.presetNumbers, msg.settleMs);
        break;
      }

      // ─── Studio shots ───────────────────────────────────────────────────
      case 'setStudioShots':
        this.studioShots = normaliseStudioShots(msg.shots);
        this.broadcast({ type: 'studioShots', shots: this.studioShots });
        this.siteChanged();
        break;

      case 'recallShot': {
        const ref: ShotRef = { cameraNumber: msg.cameraNumber ?? 0, preset: msg.presetNumber ?? -1, source: msg.source === 'plan' ? 'plan' : 'head' };
        const mode = msg.mode ?? this.studioShots.defaultMode;
        const timeMs = clampTime(msg.timeMs, this.studioShots.defaultTimeMs);
        const r = await this.recallShot(ws, ref, { mode, timeMs, force: msg.force });
        if (r.outcome === 'held') this.announceHeld([ref.cameraNumber], `Shot ${ref.preset}`, { ...msg });
        break;
      }

      case 'recallShotSet':
        await this.recallShotSet(ws, String(msg.id ?? ''), msg.force, msg.cameras);
        break;

      case 'recallSeat':
        await this.recallSeat(ws, String(msg.id ?? ''), msg.force);
        break;

      case 'playMove':
        await this.playMove(ws, String(msg.id ?? ''), msg.force);
        break;

      case 'stopMove': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        if (!slot) break;
        this.beginMove(slot);
        if (slot.connected) await this.dispatchCommand(ws, num, 'ptz', { pan: 0, tilt: 0 }, { raw: true });
        break;
      }

      case 'calibratePose': {
        const num = msg.cameraNumber ?? 0;
        await this.calibratePose(ws, num, msg.presetNumber ?? -1);
        break;
      }

      case 'zoomTo': {
        const num = msg.cameraNumber ?? 0;
        const z = Number(msg.zoom);
        if (!Number.isFinite(z)) { this.sendError(ws, 'zoomTo needs a zoom between 0 and 1', num); break; }
        await this.dispatchCommand(ws, num, 'zoomAbsolute', { zoom: Math.min(1, Math.max(0, z)) });
        break;
      }

      case 'captureZoomPoint': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        const focal = Number(msg.focalMm);
        if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); break; }
        if (!Number.isFinite(focal) || focal <= 0) { this.sendError(ws, 'A focal length in mm is needed', num); break; }
        const pose = await this.readPose(ws, num);
        if (!pose) break;
        if (pose.zoom === undefined) { this.sendError(ws, `Camera ${num} does not report its zoom position`, num); break; }
        // Ein Punkt je Stellung: eine zweite Messung an derselben Stellung ersetzt die erste.
        const rest = (slot.config.zoomTable ?? []).filter((p) => Math.abs(p.position - pose.zoom!) > 0.005);
        slot.config.zoomTable = [...rest, { position: pose.zoom, focalMm: focal }].sort((a, b) => a.position - b.position);
        this.broadcast({ type: 'pose', cameraNumber: num, pose });
        this.broadcastCameras();
        this.siteChanged();
        break;
      }

      case 'clearZoomTable': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); break; }
        delete slot.config.zoomTable;
        this.broadcastCameras();
        this.siteChanged();
        break;
      }

      case 'setPresetMotion': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        const n = Number(msg.presetNumber);
        if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); break; }
        if (!Number.isInteger(n) || n < 0) { this.sendError(ws, 'setPresetMotion needs a preset number', num); break; }
        const p: BridgePreset = { ...(slot.config.bridgePresets?.[n] ?? {}) };
        if (msg.timeMs !== undefined && Number.isFinite(Number(msg.timeMs))) p.timeMs = clampGlideTime(Number(msg.timeMs));
        if (typeof msg.soft === 'boolean') p.soft = msg.soft;
        slot.config.bridgePresets = { ...(slot.config.bridgePresets ?? {}), [n]: p };
        this.broadcastCameras();
        this.siteChanged();
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

      case 'getFreeD':
        ws.send(this.freedMessage());
        break;

      case 'setFreeD': {
        const cfg = msg.freed === null ? null : normaliseFreeDSite(msg.freed);
        if (msg.freed !== null && !cfg) { this.sendError(ws, 'FreeD: settings unreadable'); break; }
        this.freed.configure(cfg);
        this.syncFreeD();
        this.siteChanged();
        break;
      }

      case 'setCameraFreeD': {
        const num = msg.cameraNumber ?? 0;
        const slot = this.cameras.get(num);
        if (!slot) { this.sendError(ws, `Camera ${num} is not configured`, num); break; }
        if (msg.freed && typeof msg.freed === 'object') slot.config.freed = msg.freed as FreeDCameraConfig;
        else delete slot.config.freed;
        this.broadcastCameras();
        this.syncFreeD();
        this.siteChanged();
        break;
      }

      case 'importSite': {
        const text = typeof msg.site === 'string' ? msg.site : JSON.stringify(msg.site ?? null);
        const site = parseSite(text); // throws with a sentence → sendError via the catch above
        await this.applySite(site, true);
        break;
      }

      case 'command':
        if (!msg.cmd) break;
        // The "move anyway" retry of a held preset recall carries `force` on
        // the message, not in `params` (see `holdOnAir`); without passing it
        // on, the retry was held again.
        await this.dispatchCommand(ws, msg.cameraNumber ?? 0, msg.cmd, msg.force ? { ...(msg.params ?? {}), force: true } : msg.params ?? {});
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

      case 'discoverSonyNet': {
        const { discoverSonyNetCameras } = await import('./discovery/SonyNetDiscovery.js');
        const devices = await discoverSonyNetCameras();
        ws.send(JSON.stringify({ type: 'sonyNetDevices', devices }));
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
      slot.eased?.dispose();
      slot.eased = undefined;
      slot.glide?.cancel();
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
    slot.eased?.dispose();
    slot.eased = undefined;
    slot.glide?.cancel();
    try { await slot.backend.disconnect(); } catch { /* ignore */ }
    slot.backend = null;
    slot.connected = false;
    this.vergissKamera(num);
    this.broadcast({ type: 'cameraDisconnected', cameraNumber: num });
    this.companion.setConnected(this.anyConnected());
    this.broadcastCameras();
    this.syncFreeD();
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
      this.syncFreeD();
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
      this.syncFreeD();
    });

    backend.on('error', (err: Error) => {
      console.error(`[BridgeServer] Camera ${num} error:`, err);
      this.broadcast({ type: 'error', message: err.message, cameraNumber: num });
    });
  }

  private async dispatchCommand(
    ws: WebSocket,
    num: number,
    cmd: string,
    params: Record<string, unknown>,
    opts: { raw?: boolean } = {},
  ): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) {
      this.sendError(ws, `Kamera ${num} ist nicht verbunden`, num);
      return;
    }

    this.trackHeld(ws, num, cmd, params);

    // A hand on the joystick, a preset or an absolute move ends any timed
    // move the bridge is playing on this camera (motion/studioShots.ts).
    if (GLIDE_BREAKERS.has(cmd) || cmd === 'recallPreset') this.beginMove(slot);

    // On-air lock: a preset recall does not move a camera on programme
    // unless it comes back with `force` ("move anyway").
    if (cmd === 'recallPreset') {
      const { force, ...rest } = params;
      if (this.holdOnAir(num, force === true, `Preset ${String(rest.value)}`, { type: 'command', cameraNumber: num, cmd, params: rest })) return;
      params = rest;
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

    // Presets go through the bridge: a stored pose is recalled as an eased
    // move, the camera's own preset is the fallback (motion/PresetGlide.ts).
    if (cmd === 'storePreset' || cmd === 'recallPreset') {
      await this.presetCommand(ws, slot, cmd, params);
      return;
    }
    // Any other move takes the head over from a running preset glide.
    if (GLIDE_BREAKERS.has(cmd)) slot.glide?.cancel();

    // Speed demands glide (ease in / ease out) unless the source shapes the
    // motion itself (a physical demand) or the camera's ease is switched off.
    let handled: boolean;
    if (isRamped(cmd) && !opts.raw) {
      const backend = slot.backend;
      slot.eased ??= new EasedDrive((c, p) => backend.handleRcpCommand(c, { ...p, cameraNumber: num }));
      slot.eased.setOptions(slot.config.ease ?? DEFAULT_RAMP);
      handled = await slot.eased.demand(cmd, params);
    } else {
      handled = await slot.backend.handleRcpCommand(cmd, { ...params, cameraNumber: num });
    }
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

  /**
   * `storePreset` / `recallPreset` for one camera.
   *
   * Store: always into the camera as well — its own preset is the fallback
   * for a recall the bridge cannot glide (pose unreadable, soft switched
   * off, bridge bypassed). On a positioning head the pose is read back and
   * kept in the site file.
   * Recall: with a stored pose and `soft` not off, an eased stream of
   * absolute positions from where the head IS (read, not assumed) to the
   * pose. Otherwise the camera's own preset; the robotic head plays its own
   * eased keyframes and only gets the move time.
   */
  private async presetCommand(ws: WebSocket, slot: CameraSlot, cmd: 'storePreset' | 'recallPreset', params: Record<string, unknown>): Promise<void> {
    const num = slot.num;
    const backend = slot.backend!;
    const n = Number(params.value);
    const key = String(n);
    const stored = slot.config.bridgePresets?.[key];
    const timeMs = params.timeMs !== undefined && Number.isFinite(Number(params.timeMs)) ? Number(params.timeMs) : stored?.timeMs;
    const glides = Boolean(backend.poseStream && backend.readPose);
    const forward = { ...params, cameraNumber: num, ...(timeMs !== undefined ? { timeMs } : {}) };

    if (cmd === 'storePreset') {
      const inCamera = await backend.handleRcpCommand('storePreset', forward);
      if (!glides) {
        if (!inCamera) this.sendError(ws, `'storePreset' wird von Kamera ${num} nicht unterstützt`, num);
        return;
      }
      const meta: BridgePreset = { ...(stored ?? {}) };
      delete meta.pan; delete meta.tilt; delete meta.zoom;
      if (timeMs !== undefined) meta.timeMs = clampGlideTime(timeMs);
      try {
        const pose = await backend.readPose!();
        Object.assign(meta, { pan: pose.pan, tilt: pose.tilt }, pose.zoom !== undefined ? { zoom: pose.zoom } : {});
      } catch (err) {
        // Kept without a pose: a recall then uses the camera's preset instead
        // of gliding to an old pose that no longer is this preset.
        this.sendError(ws, `Camera ${num}: preset ${n} stored in the camera, but the pose could not be read (${(err as Error).message}) — it recalls without easing`, num);
      }
      slot.config.bridgePresets = { ...(slot.config.bridgePresets ?? {}), [key]: meta };
      this.broadcastCameras();
      this.siteChanged();
      return;
    }

    slot.glide?.cancel();
    if (glides && stored && stored.pan !== undefined && stored.tilt !== undefined && stored.soft !== false) {
      let from: { pan: number; tilt: number; zoom?: number } | null = null;
      try {
        from = await backend.readPose!();
      } catch {
        /* no start pose → the camera's own preset below */
      }
      if (from) {
        const move = slot.config.presetMove ?? {};
        const intervalMs = backend.poseStream!.intervalMs;
        const frames = glideFrames(from, { pan: stored.pan, tilt: stored.tilt, zoom: stored.zoom }, {
          timeMs: timeMs ?? move.timeMs ?? DEFAULT_GLIDE.timeMs,
          curve: move.curve ?? DEFAULT_GLIDE.curve,
          intervalMs,
          maxDegPerSec: move.maxDegPerSec ?? DEFAULT_GLIDE.maxDegPerSec,
        });
        slot.glide ??= new PresetGlide();
        const result = await slot.glide.run((c, p) => backend.handleRcpCommand(c, { ...p, cameraNumber: num }), frames, intervalMs);
        if (result === 'failed') this.sendError(ws, `Camera ${num}: eased move to preset ${n} broke off`, num);
        return;
      }
    }
    if (!(await backend.handleRcpCommand('recallPreset', forward))) {
      this.sendError(ws, `'recallPreset' wird von Kamera ${num} nicht unterstützt`, num);
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
      // Wie ein Preset-Abruf faehrt: 'eased' (weich, Fahrzeit einstellbar)
      // oder 'camera' (das Preset der Kamera). Fertig von hier, wie oben.
      presetRecall: presetRecallFor(s.config?.connectionMode),
      // Reports its pose → can feed the FreeD output.
      freedCapable: POSE_READ_MODES.includes(s.config?.connectionMode ?? 'tcp'),
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
      void this.dispatchCommand(quietWs, cameraNumber, cmd, params, { raw: true });
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

  // ─── Studio shots: recall modes, on-air lock, sets, seats, moves ──────────

  private onAir(num: number): boolean {
    return this.cameraTally()[num] === 'program';
  }

  /**
   * True (and every panel told) when the camera is on air, its lock is on
   * and nobody forced the move. `retry` is the message that, sent again
   * with `force: true`, moves it anyway.
   */
  private holdOnAir(num: number, force: boolean | undefined, label: string, retry: Record<string, unknown>): boolean {
    const slot = this.cameras.get(num);
    if (!slot || !heldByOnAir(this.onAir(num), slot.config, force)) return false;
    this.announceHeld([num], label, retry);
    return true;
  }

  private announceHeld(cameras: number[], label: string, retry: Record<string, unknown>): void {
    this.broadcast({ type: 'shotHeld', cameras, label, retry: { ...retry, force: true } });
  }

  private beginMove(slot: CameraSlot): number {
    slot.moveToken = (slot.moveToken ?? 0) + 1;
    return slot.moveToken;
  }

  /**
   * One shot on one camera.
   *
   * `cut`: the camera's own preset, or an absolute move at full speed.
   * `fade`: a head preset goes through `presetCommand` with the move time --
   * a pose the bridge stored glides (motion/PresetGlide.ts), the robotic head
   * plays the time itself, anything else recalls the camera's preset. A
   * planned shot glides from the pose the head reports, or gets the time on a
   * head that plays timed moves; where neither works it cuts, and the answer
   * says so.
   */
  private async recallShot(
    ws: WebSocket,
    ref: ShotRef,
    opts: { mode: RecallMode; timeMs: number; force?: boolean; token?: number },
  ): Promise<RecallOutcome> {
    const num = ref.cameraNumber;
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) {
      this.sendError(ws, `Camera ${num} is not connected`, num);
      return { outcome: 'failed', ms: 0 };
    }
    if (heldByOnAir(this.onAir(num), slot.config, opts.force)) return { outcome: 'held', ms: 0 };
    if (opts.token === undefined) this.beginMove(slot);
    slot.glide?.cancel();
    const backend = slot.backend;
    const source = ref.source ?? 'head';
    const streams = Boolean(backend.poseStream && backend.readPose);
    let mode: RecallMode = 'cut';
    let note: string | undefined;
    let ok = false;
    try {
      if (source === 'head') {
        if (opts.mode === 'fade') {
          const stored = slot.config.bridgePresets?.[String(ref.preset)];
          const glides = streams && stored?.pan !== undefined && stored?.tilt !== undefined && stored?.soft !== false;
          if (glides || backend.timedMoves) mode = 'fade';
          else note = 'No eased move stored for this preset; the camera recalled it at its own speed.';
          // Not awaited: a glide resolves only when the head has landed.
          void this.presetCommand(ws, slot, 'recallPreset', { value: ref.preset, timeMs: opts.timeMs }).catch((err) =>
            this.sendError(ws, `Camera ${num}: ${(err as Error).message}`, num));
          ok = true;
        } else {
          ok = await backend.handleRcpCommand('recallPreset', { value: ref.preset, cameraNumber: num });
        }
      } else {
        const planned = this.plannedPose(slot, ref.preset);
        if (typeof planned === 'string') {
          this.sendError(ws, planned, num);
          return { outcome: 'failed', ms: 0 };
        }
        const target = { pan: planned.pose.pan, tilt: planned.pose.tilt, ...(planned.pose.zoom !== undefined ? { zoom: planned.pose.zoom } : {}) };
        this.broadcast({ type: 'plannedProgress', cameraNumber: num, presetNumber: ref.preset, step: 'driving', message: planned.name, fit: planned.fit });
        if (opts.mode === 'fade' && backend.timedMoves) {
          ok = await backend.handleRcpCommand('ptzAbsolute', { ...target, timeMs: opts.timeMs, cameraNumber: num });
          mode = 'fade';
        } else if (opts.mode === 'fade' && streams) {
          const from = await backend.readPose!();
          const move = slot.config.presetMove ?? {};
          const intervalMs = backend.poseStream!.intervalMs;
          const frames = glideFrames(from, target, {
            timeMs: opts.timeMs,
            curve: move.curve ?? DEFAULT_GLIDE.curve,
            intervalMs,
            maxDegPerSec: move.maxDegPerSec ?? DEFAULT_GLIDE.maxDegPerSec,
          });
          slot.glide ??= new PresetGlide();
          void slot.glide.run((c, p) => backend.handleRcpCommand(c, { ...p, cameraNumber: num }), frames, intervalMs).then((r) => {
            if (r === 'failed') this.sendError(ws, `Camera ${num}: eased move to planned shot ${ref.preset} broke off`, num);
          });
          ok = true;
          mode = 'fade';
        } else {
          ok = await backend.handleRcpCommand('ptzAbsolute', { ...target, cameraNumber: num });
          if (opts.mode === 'fade') note = 'This camera does not report its position; the shot was cut.';
        }
      }
    } catch (err) {
      this.sendError(ws, `Camera ${num}: ${(err as Error).message}`, num);
      return { outcome: 'failed', ms: 0 };
    }
    if (!ok) {
      this.sendError(ws, `Camera ${num} cannot recall ${source === 'plan' ? 'planned shot' : 'preset'} ${ref.preset}`, num);
      return { outcome: 'failed', ms: 0 };
    }
    const ms = mode === 'fade' ? opts.timeMs : 0;
    this.broadcast({ type: 'shotRecalled', cameraNumber: num, presetNumber: ref.preset, source, mode, timeMs: ms, ...(note ? { note } : {}) });
    return { outcome: 'moved', ms };
  }

  private async recallShotSet(ws: WebSocket, id: string, force?: boolean, only?: number[]): Promise<void> {
    const set = this.studioShots.sets.find((s) => s.id === id);
    if (!set) { this.sendError(ws, `There is no shot set '${id}'`); return; }
    const mode = set.mode ?? this.studioShots.defaultMode;
    const timeMs = set.timeMs ?? this.studioShots.defaultTimeMs;
    const shots = Array.isArray(only) ? set.shots.filter((s) => only.includes(s.cameraNumber)) : set.shots;
    const results = await Promise.all(shots.map((s) => this.recallShot(ws, s, { mode, timeMs, force })));
    const held = shots.filter((_, i) => results[i].outcome === 'held').map((s) => s.cameraNumber);
    if (held.length) this.announceHeld(held, set.name, { type: 'recallShotSet', id, cameras: held });
  }

  private async recallSeat(ws: WebSocket, id: string, force?: boolean): Promise<void> {
    const seat = this.studioShots.seats.seats.find((s) => s.id === id);
    if (!seat) { this.sendError(ws, `There is no seat '${id}'`); return; }
    const facts = [...this.cameras.values()].map((c) => ({
      cameraNumber: c.num, connected: c.connected, onAir: this.onAir(c.num), tallyProtect: c.config.tallyProtect,
    }));
    const pick = pickSeatShot(seat, facts);
    const label = seat.label ?? `Row ${seat.row + 1}, seat ${seat.col + 1}`;
    if (!pick) { this.sendError(ws, `${label}: no connected camera has a shot for this seat`); return; }
    if (pick.held && !force) { this.announceHeld([pick.shot.cameraNumber], label, { type: 'recallSeat', id }); return; }
    const r = await this.recallShot(ws, pick.shot, { mode: this.studioShots.defaultMode, timeMs: this.studioShots.defaultTimeMs, force: true });
    if (r.outcome === 'moved') this.broadcast({ type: 'seatRecalled', id, cameraNumber: pick.shot.cameraNumber });
  }

  /**
   * A move: the shots of one camera in a row, each an eased move of its own
   * time, with an optional hold in between. The on-air lock is asked once,
   * at the start -- a move started on air on purpose runs through.
   */
  private async playMove(ws: WebSocket, id: string, force?: boolean): Promise<void> {
    const move = this.studioShots.moves.find((m) => m.id === id);
    if (!move) { this.sendError(ws, `There is no move '${id}'`); return; }
    const num = move.cameraNumber;
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) { this.sendError(ws, `Camera ${num} is not connected`, num); return; }
    if (move.steps.length === 0) { this.sendError(ws, `${move.name} has no steps`, num); return; }
    if (this.holdOnAir(num, force, move.name, { type: 'playMove', id })) return;
    const token = this.beginMove(slot);
    const of = move.steps.length;
    const progress = (step: number, state: 'playing' | 'done' | 'stopped') =>
      this.broadcast({ type: 'moveProgress', id, cameraNumber: num, step, of, state });
    for (let i = 0; i < of; i++) {
      if (slot.moveToken !== token) return progress(i, 'stopped');
      const st = move.steps[i];
      progress(i + 1, 'playing');
      const timeMs = st.timeMs ?? this.studioShots.defaultTimeMs;
      const r = await this.recallShot(ws, { cameraNumber: num, preset: st.preset, source: st.source }, { mode: 'fade', timeMs, force: true, token });
      if (r.outcome !== 'moved') return progress(i + 1, 'stopped');
      const until = Date.now() + Math.max(r.ms, timeMs) + (st.holdMs ?? 0);
      while (Date.now() < until && slot.moveToken === token) {
        await new Promise((res) => setTimeout(res, Math.min(50, until - Date.now())));
      }
    }
    progress(of, slot.moveToken === token ? 'done' : 'stopped');
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

  // ─── Aim by frame and the panorama map (#137, #138) ────────────────────────

  /** Everything this slot knows about its field of view (protocol/frameAim.ts). */
  private fovModel(slot: CameraSlot): FovModel {
    const c = slot.config;
    return {
      fovTable: c.fovTable, hfovWideDeg: c.hfovWideDeg, hfovTeleDeg: c.hfovTeleDeg, sensorWidthMm: c.sensorWidthMm,
      zoomTable: c.zoomTable, focalMinMm: slot.plan?.lens?.focalMinMm, focalMaxMm: slot.plan?.lens?.focalMaxMm,
    };
  }

  /** The field of view at a pose's zoom, when it can be named — the panel places the live picture with it. */
  private viewOf(num: number, pose: Pose): { hfovDeg?: number; fit?: string } {
    const slot = this.cameras.get(num);
    if (!slot || pose.zoom === undefined) return {};
    const v = hfovAt(pose.zoom, this.fovModel(slot));
    return v ? { hfovDeg: v.hfovDeg, fit: v.fit } : {};
  }

  private async aimFrame(ws: WebSocket, num: number, source: 'picture' | 'panorama', frame: Frame | undefined, aspect?: number): Promise<void> {
    const slot = this.cameras.get(num);
    if (!slot?.backend || !slot.connected) { this.sendError(ws, `Camera ${num} is not connected`, num); return; }
    if (!frame) { this.sendError(ws, 'aimFrame needs a frame', num); return; }
    const busy = this.jobs.get(num);
    if (busy) { this.sendError(ws, `Camera ${num} is busy with a ${busy.kind}`, num); return; }
    const model = this.fovModel(slot);
    let current: Pose | null;
    let aim: ReturnType<typeof aimFromMap>;
    if (source === 'panorama') {
      const pano = this.panoramas.get(num);
      if (!pano) { this.sendError(ws, `Camera ${num} has no panorama yet — scan one first`, num); return; }
      aim = aimFromMap(frame, pano.meta);
      current = slot.backend.readPose ? await slot.backend.readPose().catch(() => null) : null;
    } else {
      // The picture shows the head where it stands NOW; the frame is measured from there.
      current = await this.readPose(ws, num);
      if (!current) return;
      if (current.zoom === undefined) { this.sendError(ws, `Camera ${num} does not report its zoom position`, num); return; }
      const view = hfovAt(current.zoom, model);
      if (!view) { this.sendError(ws, `The field of view of camera ${num} is unknown — enter the wide/tele values or calibrate`, num); return; }
      aim = aimFromPicture(frame, Number(aspect) > 0 ? Number(aspect) : 16 / 9, view.hfovDeg, current);
    }
    if (typeof aim === 'string') { this.sendError(ws, aim, num); return; }
    const zoom = zoomForHfov(aim.hfovDeg, model);
    const target = { pan: aim.pan, tilt: aim.tilt, ...(zoom ? { zoom: zoom.zoom } : {}) };
    const timeMs = moveTimeMs(current ?? undefined, aim);
    const backend = slot.backend;
    if (current && backend.poseStream) {
      // Same eased stream of absolute positions as a soft preset recall
      // (motion/PresetGlide.ts): all axes start and land together.
      const move = slot.config.presetMove ?? {};
      const intervalMs = backend.poseStream.intervalMs;
      const frames = glideFrames(current, target, {
        timeMs, curve: move.curve ?? DEFAULT_GLIDE.curve, intervalMs, maxDegPerSec: move.maxDegPerSec ?? DEFAULT_GLIDE.maxDegPerSec,
      });
      slot.glide?.cancel();
      this.beginMove(slot); // a running shot move stops here too
      slot.glide ??= new PresetGlide();
      void slot.glide.run((c, p) => backend.handleRcpCommand(c, { ...p, cameraNumber: num }), frames, intervalMs).then((r) => {
        if (r === 'failed') this.sendError(ws, `Camera ${num}: eased move to the frame broke off`, num);
      });
    } else {
      // The robotic head plays `timeMs` as its own eased keyframes; the rest drive their absolute move.
      await this.dispatchCommand(ws, num, 'ptzAbsolute', { ...target, timeMs });
    }
    this.broadcast({
      type: 'aim', cameraNumber: num, pose: { pan: aim.pan, tilt: aim.tilt, ...(zoom ? { zoom: zoom.zoom } : {}) },
      hfovDeg: aim.hfovDeg, fit: zoom?.fit ?? 'none',
    });
  }

  /**
   * A picture from the camera's stream that arrived at least `settleMs` from
   * now — the head has stopped and the encoder delay has passed.
   */
  private grabFrame(num: number, settleMs: number, timeoutMs = 8000): Promise<Buffer> {
    const url = this.cameras.get(num)?.config.streamUrl;
    if (!url) return Promise.reject(new Error(`Camera ${num} has no stream address — this needs its picture`));
    const refusal = checkStreamUrl(url, this.allowAnyStreamHost);
    if (refusal) return Promise.reject(new Error(refusal));
    return new Promise((resolve, reject) => {
      const notBefore = Date.now() + settleMs;
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (err: Error | null, jpeg?: Buffer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (err) reject(err);
        else resolve(jpeg!);
      };
      const timer = setTimeout(() => finish(new Error(`No picture from camera ${num}'s stream`)), settleMs + timeoutMs);
      unsubscribe = this.hub.subscribe(url, {
        frame: (jpeg) => { if (Date.now() >= notBefore) finish(null, jpeg); },
        error: () => { /* the hub retries; the timeout decides */ },
      });
      if (done) unsubscribe();
    });
  }

  /** Start a head job, or say why not. */
  private startJob(ws: WebSocket, num: number, kind: 'scan' | 'calibration'): { slot: CameraSlot; deps: JobDeps; release: () => void } | null {
    const slot = this.cameras.get(num);
    const backend = slot?.backend;
    if (!slot || !backend || !slot.connected) { this.sendError(ws, `Camera ${num} is not connected`, num); return null; }
    const busy = this.jobs.get(num);
    if (busy) { this.sendError(ws, `Camera ${num} is busy with a ${busy.kind}`, num); return null; }
    const url = slot.config.streamUrl;
    if (!url) { this.sendError(ws, `Camera ${num} has no stream address — this needs its picture`, num); return null; }
    slot.glide?.cancel();
    const job = { kind, cancel: false };
    this.jobs.set(num, job);
    // Hold the stream open for the whole job, so ffmpeg is not restarted between two pictures.
    const keep = checkStreamUrl(url, this.allowAnyStreamHost) ? null : this.hub.subscribe(url, { frame: () => {}, error: () => {} });
    const deps: JobDeps = {
      drive: (p) => backend.handleRcpCommand('ptzAbsolute', {
        pan: p.pan, tilt: p.tilt, ...(p.zoom !== undefined ? { zoom: p.zoom } : {}), timeMs: 800, cameraNumber: num,
      }),
      readPose: backend.readPose ? () => backend.readPose!() : undefined,
      grab: (ms) => this.grabFrame(num, ms),
      codec: ffmpegCodec,
      cancelled: () => job.cancel || !slot.connected,
    };
    return { slot, deps, release: () => { this.jobs.delete(num); keep?.(); } };
  }

  private async scanPanorama(ws: WebSocket, num: number, raw?: Partial<ScanSettings>): Promise<void> {
    const job = this.startJob(ws, num, 'scan');
    if (!job) return;
    const progress = (m: Record<string, unknown>) => this.broadcast({ type: 'panoramaProgress', cameraNumber: num, ...m });
    const last = this.hub.lastFrame(job.slot.config.streamUrl!);
    const size = last ? jpegSize(last) : null;
    try {
      progress({ step: 'starting' });
      const result = await runScan(num, scanSettings(raw), this.fovModel(job.slot), job.deps,
        (p) => progress({ step: 'picture', ...p }), size ? size.width / size.height : 16 / 9);
      this.panoramas.save(result.meta, result.jpeg);
      progress({ step: 'done', message: `${result.meta.pictures} pictures` });
      this.broadcast({ type: 'panorama', cameraNumber: num, meta: result.meta });
    } catch (err) {
      progress({ step: isCancelled(err) ? 'cancelled' : 'failed', message: (err as Error).message });
    } finally {
      job.release();
    }
  }

  private async calibrateFov(ws: WebSocket, num: number, zooms?: number[]): Promise<void> {
    const job = this.startJob(ws, num, 'calibration');
    if (!job) return;
    const progress = (m: Record<string, unknown>) => this.broadcast({ type: 'fovProgress', cameraNumber: num, ...m });
    const list = Array.isArray(zooms) && zooms.length ? zooms.map(Number).filter(Number.isFinite) : DEFAULT_CALIBRATION_ZOOMS;
    try {
      progress({ step: 'starting', total: list.length });
      const points = await runFovCalibration(list, this.fovModel(job.slot), job.deps, 1200,
        (r, index, total) => progress({ step: 'point', index, total, ...r }));
      if (points.length) {
        job.slot.config.fovTable = mergeFovTable(job.slot.config.fovTable, points);
        this.broadcastCameras();
        this.siteChanged();
      }
      progress({ step: points.length ? 'done' : 'failed', message: `${points.length} of ${list.length} zoom positions measured` });
    } catch (err) {
      progress({ step: isCancelled(err) ? 'cancelled' : 'failed', message: (err as Error).message });
    } finally {
      job.release();
    }
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
    const sh = this.studioShots;
    if (sh.sets.length || sh.moves.length || sh.seats.seats.length || sh.seats.rows) site.shots = sh;
    const freed = this.freed.siteConfig;
    if (freed) site.freed = freed;
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
    this.studioShots = normaliseStudioShots(site.shots);
    this.freed.configure(site.freed ?? null);
    this.syncFreeD();
    this.broadcast({ type: 'studioShots', shots: this.studioShots });
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

  // ─── FreeD tracking ───────────────────────────────────────────────────────

  private freedMessage(): string {
    return JSON.stringify({ type: 'freed', config: this.freed.siteConfig, status: this.freed.status() });
  }

  /** Hand the cameras to the FreeD output, announce, and keep the status ticking while it streams. */
  private syncFreeD(): void {
    this.freed.sync([...this.cameras.values()].map((s) => ({
      cameraNumber: s.num, freed: s.config?.freed, connected: s.connected, backend: s.backend,
    })));
    this.broadcastRaw(this.freedMessage());
    const active = this.freed.status().active;
    if (active && !this.freedTimer) {
      this.freedTimer = setInterval(() => this.broadcastRaw(this.freedMessage()), 1000);
      this.freedTimer.unref?.();
    } else if (!active && this.freedTimer) {
      clearInterval(this.freedTimer);
      this.freedTimer = null;
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
    const pano = /^\/panorama\/(\d+)\.(jpg|json)$/.exec(url.pathname);
    if (pano) {
      const entry = this.panoramas.get(Number(pano[1]));
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Camera ${pano[1]} has no panorama yet`);
      } else if (pano[2] === 'jpg') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
        res.end(entry.jpeg);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(entry.meta));
      }
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
