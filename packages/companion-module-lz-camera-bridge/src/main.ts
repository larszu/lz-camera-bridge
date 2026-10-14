import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import {
  BridgeClient,
  formatTally,
  UNKNOWN_TALLY,
  type BridgeCameraState,
  type BridgeTallyState,
} from './bridge.js'
import { DEFAULT_CONFIG, getConfigFields, type ModuleConfig } from './config.js'
import { updateActions } from './actions.js'
import { STUDIO_FEEDBACKS, updateFeedbacks } from './feedbacks.js'
import { ControlLink } from './link.js'
import { updatePresets } from './presets.js'
import {
  applyMessage,
  cameraNumbers,
  choiceSignature,
  emptyStudio,
  expireHeld,
  HELD_TTL_MS,
  linkLost,
  studioVariableValues,
  type Change,
  type StudioState,
} from './studio.js'
import { parseCameraTargets } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { updateVariableDefinitions } from './variables.js'

/**
 * ADR-003 — der Anfangszustand ist „unbekannt", nicht „aus".
 *
 * Vorher stand hier `{ program: false, preview: false, isoRec: false }`:
 * zwischen dem Laden des Moduls und der ersten erfolgreichen Abfrage
 * behauptete es also, die Kamera sei nicht auf Sendung. Das ist genau die
 * Zeitspanne, in der noch niemand etwas wissen kann.
 */

export class ModuleInstance extends InstanceBase<ModuleConfig, undefined> {
  config: ModuleConfig = DEFAULT_CONFIG
  bridgeConnected = false
  cameraConnected = false
  /** The bridge's legacy merged state (messages without a camera number). */
  cameraState: BridgeCameraState = {}
  /** Paint state per camera, as the bridge reported it. */
  cameraStates: Record<number, BridgeCameraState> = {}
  tallyState: BridgeTallyState = { ...UNKNOWN_TALLY }
  /** What the control socket said: cameras, studio shots, moves, aim jobs. */
  studio: StudioState = emptyStudio()
  private client: BridgeClient | null = null
  private link: ControlLink | null = null
  private definedSignature = ''
  private definedCameras = ''
  private heldTimer: ReturnType<typeof setTimeout> | null = null
  private poseTimer: ReturnType<typeof setInterval> | null = null

  constructor(internal: unknown) {
    super(internal)
  }

  async init(config: ModuleConfig, _isFirstInit: boolean, _secrets: undefined): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.updateVariableDefinitions()
    this.updateActions()
    this.updateFeedbacks()
    this.updatePresets()
    this.updateStatus(InstanceStatus.Connecting)
    this.initLink()
    await this.initClient()
  }

  async destroy(): Promise<void> {
    this.client?.destroy()
    this.client = null
    this.link?.destroy()
    this.link = null
    if (this.heldTimer) clearTimeout(this.heldTimer)
    if (this.poseTimer) clearInterval(this.poseTimer)
  }

  async configUpdated(config: ModuleConfig, _secrets: undefined): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.updateStatus(InstanceStatus.Connecting)
    this.redefine(true)
    this.initLink()
    await this.initClient()
  }

  /** Paint state of one camera; the legacy merged state when the bridge sent nothing per camera. */
  cameraStateFor(cameraNumber: number): BridgeCameraState {
    return this.cameraStates[cameraNumber] ?? (Object.keys(this.cameraStates).length ? {} : this.cameraState)
  }

  /**
   * One message to the bridge's control socket. Returns false — and logs —
   * while the link is down: a button that silently does nothing cannot be
   * told apart from a broken bridge.
   */
  sendControl(type: string, payload: Record<string, unknown> = {}): boolean {
    if (this.link?.send(type, payload)) return true
    this.log('warn', `${type}: not connected to the bridge control port ${this.config.host}:${this.config.controlPort} — nothing sent.`)
    return false
  }

  /** Called after the state changed outside a bridge message (an action cleared a held recall). */
  studioChanged(changes: Change[]): void {
    const ids = new Set<string>()
    for (const c of changes) for (const id of (STUDIO_FEEDBACKS as Record<string, readonly string[]>)[c] ?? []) ids.add(id)
    if (changes.includes('cameras') || changes.includes('shots') || changes.includes('switchers') || changes.includes('link')) this.redefine()
    this.applyVariableValues()
    if (ids.size) this.checkFeedbacks(...ids)
    if (changes.includes('held')) this.scheduleHeldExpiry()
  }

  /**
   * Dropdowns, variables and presets follow the bridge's lists. They are
   * re-defined only when a list really changed — Companion redraws its
   * editors on every definition.
   */
  private redefine(force = false): void {
    const fallback = parseCameraTargets(this.config).map((t) => ({ id: t.id, label: t.label }))
    const signature = choiceSignature(this.studio, fallback) + JSON.stringify(this.studio.shots?.seats ?? null) + this.label
    const cams = JSON.stringify(cameraNumbers(this.studio))
    if (force || signature !== this.definedSignature) {
      this.definedSignature = signature
      this.updateActions()
      this.updateFeedbacks()
      this.updatePresets()
    }
    if (force || cams !== this.definedCameras) {
      this.definedCameras = cams
      this.updateVariableDefinitions()
    }
  }

  private scheduleHeldExpiry(): void {
    if (this.heldTimer) clearTimeout(this.heldTimer)
    this.heldTimer = null
    if (!this.studio.held) return
    this.heldTimer = setTimeout(() => {
      if (expireHeld(this.studio, Date.now())) this.studioChanged(['held'])
    }, HELD_TTL_MS + 100)
  }

  private initLink(): void {
    this.link?.destroy()
    if (this.poseTimer) clearInterval(this.poseTimer)
    this.poseTimer = null
    linkLost(this.studio)
    this.link = new ControlLink(`ws://${this.config.host}:${this.config.controlPort}`)
    this.link.onOpen = () => {
      this.studio.linkConnected = true
      this.studioChanged(['link'])
    }
    this.link.onClose = () => {
      // ADR-003: what the link said is no longer known once it is gone.
      linkLost(this.studio)
      this.studioChanged(['link', 'cameras', 'shots', 'switchers', 'held'])
    }
    this.link.onMessage = (msg) => {
      const changes = applyMessage(this.studio, msg, Date.now())
      if (changes.includes('error') && this.studio.lastError) this.log('warn', `Bridge: ${this.studio.lastError}`)
      if (msg.type === 'shotHeld' && this.studio.held) {
        this.log('info', `Held by the on-air lock: ${this.studio.held.label} (camera ${this.studio.held.cameras.join(', ')}) — "Studio: move anyway" moves it.`)
      }
      if (changes.length) this.studioChanged(changes)
    }
    this.link.onError = (message) => this.log('debug', `Control link: ${message}`)
    this.link.connect()
    if (this.config.posePoll > 0) {
      this.poseTimer = setInterval(() => {
        if (!this.link?.open) return
        for (const n of cameraNumbers(this.studio)) {
          if (this.studio.cameras?.[n]?.connected) this.link.send('readPose', { cameraNumber: n })
        }
      }, Math.max(250, this.config.posePoll))
    }
  }

  getConfigFields() {
    return getConfigFields()
  }

  updateActions(): void {
    updateActions(this)
  }

  updateFeedbacks(): void {
    updateFeedbacks(this)
  }

  updatePresets(): void {
    updatePresets(this)
  }

  updateVariableDefinitions(): void {
    updateVariableDefinitions(this)
  }

  async sendCameraCommand(action: string, params: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      this.updateStatus(InstanceStatus.Disconnected, 'Bridge client not initialised')
      return
    }

    try {
      await this.client.sendAction(action, params)
      this.updateStatus(InstanceStatus.Ok)
      await this.client.refreshAll()
    } catch (error) {
      const message = (error as Error).message
      this.log('error', message)
      this.updateStatus(InstanceStatus.ConnectionFailure, message)
    }
  }

  async sendTally(tally: Partial<BridgeTallyState>): Promise<void> {
    if (!this.client) {
      this.updateStatus(InstanceStatus.Disconnected, 'Bridge client not initialised')
      return
    }

    try {
      await this.client.setTally(tally)
      this.updateStatus(InstanceStatus.Ok)
      await this.client.refreshAll()
    } catch (error) {
      const message = (error as Error).message
      this.log('error', message)
      this.updateStatus(InstanceStatus.ConnectionFailure, message)
    }
  }

  private async initClient(): Promise<void> {
    this.client?.destroy()
    this.client = new BridgeClient(this.config)
    this.client.onBridgeReachable = (connected) => {
      this.bridgeConnected = connected
      if (!connected) {
        this.updateStatus(InstanceStatus.ConnectionFailure, 'Bridge not reachable')
      } else if (this.cameraConnected) {
        this.updateStatus(InstanceStatus.Ok)
      } else {
        this.updateStatus(InstanceStatus.Ok, 'Bridge connected, camera idle')
      }
      this.applyVariableValues()
      this.checkFeedbacks('bridge_connected', 'camera_connected')
    }
    this.client.onCameraConnected = (connected) => {
      this.cameraConnected = connected
      if (this.bridgeConnected) {
        this.updateStatus(InstanceStatus.Ok, connected ? undefined : 'Bridge connected, camera idle')
      }
      this.applyVariableValues()
      this.checkFeedbacks('camera_connected')
    }
    this.client.onState = (state, cameraNumber) => {
      if (cameraNumber === undefined) this.cameraState = { ...this.cameraState, ...state }
      else this.cameraStates[cameraNumber] = { ...(this.cameraStates[cameraNumber] ?? {}), ...state }
      this.applyVariableValues()
    }
    this.client.onTally = (tally) => {
      // Kein Auffuellen mit `false` und kein Weiterschleppen des alten
      // Standes: die Antwort IST der aktuelle Kenntnisstand. Ein Feld, das
      // sie nicht nennt, ist unbekannt — nicht aus, und nicht das, was vor
      // zwei Sekunden galt.
      this.tallyState = { ...tally }
      this.applyVariableValues()
      this.checkFeedbacks('tally_program', 'tally_preview', 'tally_iso_rec', 'tally_unknown')
    }
    this.client.onError = (message) => {
      this.log('warn', message)
    }

    try {
      await this.client.connect()
    } catch (error) {
      const message = (error as Error).message
      this.log('error', message)
      this.updateStatus(InstanceStatus.ConnectionFailure, message)
    }
  }

  private applyVariableValues(): void {
    const paint = this.cameraStateFor(this.config.defaultCamera)
    this.setVariableValues({
      ...studioVariableValues(this.studio),
      bridge_connected: this.bridgeConnected ? 'true' : 'false',
      camera_connected: this.cameraConnected ? 'true' : 'false',
      iris: this.formatNumber(paint.iris),
      master_black: this.formatNumber(paint.masterBlack),
      master_gain: this.formatNumber(paint.masterGain),
      master_gamma: this.formatNumber(paint.masterGamma),
      saturation: this.formatNumber(paint.saturation),
      detail_level: this.formatNumber(paint.detailLevel),
      shutter_speed: this.formatNumber(paint.shutterSpeed),
      nd_filter: this.formatNumber(paint.ndFilter),
      bars: paint.bars ? 'true' : 'false',
      camera_power: paint.cameraPower ? 'true' : 'false',
      // `unknown` ist hier der eigentliche Gewinn: an der Lampe sieht man
      // nur an/aus, in der Variablen steht, ob es bestaetigt ist.
      tally_program: formatTally(this.tallyState.program),
      tally_preview: formatTally(this.tallyState.preview),
      tally_iso_rec: formatTally(this.tallyState.isoRec),
    })
  }

  private formatNumber(value: number | undefined): string {
    return typeof value === 'number' ? String(value) : ''
  }
}

runEntrypoint(ModuleInstance, UpgradeScripts)
