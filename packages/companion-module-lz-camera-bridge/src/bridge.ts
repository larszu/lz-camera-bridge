import WebSocket from 'ws'
import type { ModuleConfig } from './config.js'

export interface BridgeCameraState {
  iris?: number
  masterBlack?: number
  blackR?: number
  blackG?: number
  blackB?: number
  whiteR?: number
  whiteG?: number
  whiteB?: number
  masterGain?: number
  masterGamma?: number
  saturation?: number
  shutterSpeed?: number
  bars?: boolean
  cameraPower?: boolean
  ndFilter?: number
  masterWhiteClip?: number
  detailLevel?: number
}

/**
 * ADR-003 — Tally-Zustand, in dem „unbestaetigt" ein eigener Wert ist.
 *
 * `undefined` heisst NICHT „aus". Es heisst: die Bridge hat dazu nichts
 * gesagt. Der Unterschied ist bei Tally kein Detail — eine dunkle Lampe
 * liest ein Operator als „die Kamera ist nicht auf Sendung, ich kann davor
 * langlaufen". Wer das behauptet, ohne es zu wissen, behauptet genau das
 * Gefaehrliche.
 *
 * Companion-Feedbacks koennen nur an oder aus; deshalb gibt es zusaetzlich
 * das Feedback `tally_unknown`, mit dem sich der Fall sichtbar machen laesst,
 * und die Variablen sagen `unknown` statt `false`.
 */
export interface BridgeTallyState {
  program?: boolean
  preview?: boolean
  isoRec?: boolean
}

/** Nichts bestaetigt. Der Anfangszustand und die Antwort auf eine Luecke. */
export const UNKNOWN_TALLY: BridgeTallyState = {}

/**
 * `true` / `false` / `unknown` fuer die Companion-Variablen — nie `false`
 * fuer „nicht gesagt". Steht hier und nicht in `main.ts`, weil `main.ts` beim
 * Laden `runEntrypoint` aufruft und damit nicht testbar importierbar ist.
 */
export const formatTally = (value: boolean | undefined): string =>
  value === undefined ? 'unknown' : value ? 'true' : 'false'

interface StateResponse {
  connected: boolean
  state: BridgeCameraState
}

interface TallyResponse {
  tally?: BridgeTallyState
}

export class BridgeClient {
  private config: ModuleConfig
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  onBridgeReachable?: (connected: boolean) => void
  onCameraConnected?: (connected: boolean) => void
  onState?: (state: BridgeCameraState) => void
  onTally?: (tally: BridgeTallyState) => void
  onError?: (message: string) => void

  constructor(config: ModuleConfig) {
    this.config = config
  }

  updateConfig(config: ModuleConfig): void {
    this.config = config
  }

  async connect(): Promise<void> {
    this.destroyed = false
    await this.refreshAll()
    this.openWebSocket()
    this.startPolling()
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }
  }

  async sendAction(action: string, params: Record<string, unknown> = {}): Promise<void> {
    const response = await fetch(this.httpUrl('/api/action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    })

    if (!response.ok) {
      throw new Error(`Action failed with HTTP ${response.status}`)
    }
  }

  async setTally(tally: Partial<BridgeTallyState>): Promise<void> {
    const response = await fetch(this.httpUrl('/api/tally'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tally),
    })

    if (!response.ok) {
      throw new Error(`Tally update failed with HTTP ${response.status}`)
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.fetchState(), this.fetchTally()])
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    this.pollTimer = setInterval(() => {
      void this.refreshAll().catch((error: Error) => {
        this.onBridgeReachable?.(false)
        this.onError?.(error.message)
      })
    }, this.config.pollInterval)
  }

  private openWebSocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }

    this.ws = new WebSocket(this.wsUrl())

    this.ws.on('open', () => {
      this.onBridgeReachable?.(true)
    })

    this.ws.on('message', (data) => {
      this.onBridgeReachable?.(true)
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.type === 'connection') {
          this.onCameraConnected?.(Boolean(msg.connected))
        } else if (msg.type === 'state' && msg.state && typeof msg.state === 'object') {
          this.onState?.(msg.state as BridgeCameraState)
        } else if (msg.type === 'tally' && msg.tally && typeof msg.tally === 'object') {
          this.onTally?.(msg.tally as BridgeTallyState)
        }
      } catch (error) {
        this.onError?.((error as Error).message)
      }
    })

    this.ws.on('error', (error) => {
      this.onBridgeReachable?.(false)
      this.onError?.(error.message)
    })

    this.ws.on('close', () => {
      this.onBridgeReachable?.(false)
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.openWebSocket(), 2000)
      }
    })
  }

  private async fetchState(): Promise<void> {
    const response = await fetch(this.httpUrl('/api/state'))
    if (!response.ok) {
      throw new Error(`State fetch failed with HTTP ${response.status}`)
    }

    const json = (await response.json()) as StateResponse
    this.onBridgeReachable?.(true)
    this.onCameraConnected?.(Boolean(json.connected))
    this.onState?.(json.state ?? {})
  }

  private async fetchTally(): Promise<void> {
    const response = await fetch(this.httpUrl('/api/tally'))
    if (!response.ok) {
      throw new Error(`Tally fetch failed with HTTP ${response.status}`)
    }

    const json = (await response.json()) as TallyResponse
    this.onBridgeReachable?.(true)
    if (!json.tally) {
      // Hier stand `?? { program: false, preview: false, isoRec: false }`.
      // Eine 200-Antwort ohne `tally`-Feld wurde damit zu „alle Lampen aus"
      // — eine erfundene Bestaetigung, und zwar in die gefaehrliche
      // Richtung. Jetzt: nichts behaupten und es sagen.
      this.onError?.('Bridge antwortete auf /api/tally ohne tally-Feld — Zustand unbekannt.')
      this.onTally?.(UNKNOWN_TALLY)
      return
    }
    this.onTally?.(json.tally)
  }

  private httpUrl(path: string): string {
    return `http://${this.config.host}:${this.config.httpPort}${path}`
  }

  private wsUrl(): string {
    return `ws://${this.config.host}:${this.config.wsPort}`
  }
}
