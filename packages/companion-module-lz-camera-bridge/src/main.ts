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
import { updateFeedbacks } from './feedbacks.js'
import { updatePresets } from './presets.js'
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
  cameraState: BridgeCameraState = {}
  tallyState: BridgeTallyState = { ...UNKNOWN_TALLY }
  private client: BridgeClient | null = null

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
    await this.initClient()
  }

  async destroy(): Promise<void> {
    this.client?.destroy()
    this.client = null
  }

  async configUpdated(config: ModuleConfig, _secrets: undefined): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.updateStatus(InstanceStatus.Connecting)
    await this.initClient()
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
    this.client.onState = (state) => {
      this.cameraState = { ...this.cameraState, ...state }
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
    this.setVariableValues({
      bridge_connected: this.bridgeConnected ? 'true' : 'false',
      camera_connected: this.cameraConnected ? 'true' : 'false',
      iris: this.formatNumber(this.cameraState.iris),
      master_black: this.formatNumber(this.cameraState.masterBlack),
      master_gain: this.formatNumber(this.cameraState.masterGain),
      master_gamma: this.formatNumber(this.cameraState.masterGamma),
      saturation: this.formatNumber(this.cameraState.saturation),
      detail_level: this.formatNumber(this.cameraState.detailLevel),
      shutter_speed: this.formatNumber(this.cameraState.shutterSpeed),
      nd_filter: this.formatNumber(this.cameraState.ndFilter),
      bars: this.cameraState.bars ? 'true' : 'false',
      camera_power: this.cameraState.cameraPower ? 'true' : 'false',
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
