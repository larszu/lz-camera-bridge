/**
 * A stand-in for `ModuleInstance` (main.ts calls `runEntrypoint` on import
 * and cannot be loaded in a test). It records what the actions send and
 * holds the same fields the definitions read.
 */
import type { CompanionActionDefinitions, CompanionFeedbackDefinitions } from '@companion-module/base'
import type { ModuleInstance } from '../src/main.js'
import { buildActions } from '../src/actions.js'
import { buildFeedbacks } from '../src/feedbacks.js'
import { buildPresets } from '../src/presets.js'
import { DEFAULT_CONFIG, type ModuleConfig } from '../src/config.js'
import { emptyStudio, type StudioState } from '../src/studio.js'
import type { BridgeCameraState, BridgeTallyState } from '../src/bridge.js'

export interface Sent {
  type: string
  payload: Record<string, unknown>
}

export interface Harness {
  self: ModuleInstance
  studio: StudioState
  control: Sent[]
  http: Array<{ action: string; params: Record<string, unknown> }>
  tally: Array<Partial<BridgeTallyState>>
  logs: Array<{ level: string; message: string }>
  actions: () => CompanionActionDefinitions
  feedbacks: () => CompanionFeedbackDefinitions
  presets: () => ReturnType<typeof buildPresets>
  run: (actionId: string, options?: Record<string, unknown>) => Promise<void>
  check: (feedbackId: string, options?: Record<string, unknown>) => boolean
  /** Replace how `sendControl` delivers (default: record only, link "open"). */
  deliver: (fn: (type: string, payload: Record<string, unknown>) => boolean) => void
}

export function harness(config: Partial<ModuleConfig> = {}, cameraStates: Record<number, BridgeCameraState> = {}): Harness {
  const studio = emptyStudio()
  const control: Sent[] = []
  const http: Harness['http'] = []
  const tally: Harness['tally'] = []
  const logs: Harness['logs'] = []
  let deliverFn = (_type: string, _payload: Record<string, unknown>) => true
  const self = {
    config: { ...DEFAULT_CONFIG, ...config },
    label: 'lzcb',
    studio,
    tallyState: {} as BridgeTallyState,
    bridgeConnected: true,
    cameraConnected: true,
    cameraStateFor: (n: number) => cameraStates[n] ?? {},
    log: (level: string, message: string) => logs.push({ level, message }),
    sendControl: (type: string, payload: Record<string, unknown> = {}) => {
      control.push({ type, payload })
      return deliverFn(type, payload)
    },
    sendCameraCommand: async (action: string, params: Record<string, unknown>) => {
      http.push({ action, params })
    },
    sendTally: async (t: Partial<BridgeTallyState>) => {
      tally.push(t)
    },
    studioChanged: () => {},
  } as unknown as ModuleInstance

  const h: Harness = {
    self,
    studio,
    control,
    http,
    tally,
    logs,
    actions: () => buildActions(self),
    feedbacks: () => buildFeedbacks(self),
    presets: () => buildPresets(self),
    run: async (actionId, options = {}) => {
      const def = h.actions()[actionId]
      if (!def) throw new Error(`no action ${actionId}`)
      const defaults: Record<string, unknown> = {}
      for (const o of def.options) if ('default' in o) defaults[o.id] = o.default
      await def.callback({ options: { ...defaults, ...options } } as never, {} as never)
    },
    check: (feedbackId, options = {}) => {
      const def = h.feedbacks()[feedbackId]
      if (!def) throw new Error(`no feedback ${feedbackId}`)
      const defaults: Record<string, unknown> = {}
      for (const o of def.options) if ('default' in o) defaults[o.id] = o.default
      return def.callback({ options: { ...defaults, ...options } } as never, {} as never) as boolean
    },
    deliver: (fn) => {
      deliverFn = fn
    },
  }
  return h
}
