import type {
  CompanionActionDefinition,
  CompanionActionDefinitions,
  CompanionInputFieldDropdown,
  CompanionInputFieldNumber,
  SomeCompanionActionInputField,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { parseCameraTargets } from './config.js'
import {
  cameraChoices,
  clampMoveTime,
  moveChoices,
  onAirLock,
  seatChoices,
  setChoices,
  switcherChoices,
  withDefaults,
  type Choice,
} from './studio.js'

type Options = Record<string, unknown>

// ── Option builders ─────────────────────────────────────────────────────────

function cameraOption(self: ModuleInstance, id = 'cameraNumber'): CompanionInputFieldDropdown {
  const fallback = parseCameraTargets(self.config).map((t) => ({ id: t.id, label: t.label }))
  return {
    id,
    type: 'dropdown',
    label: 'Target Camera',
    default: self.config.defaultCamera,
    choices: cameraChoices(self.studio, fallback),
    allowCustom: true,
  }
}

function getTargetOptions(self: ModuleInstance): SomeCompanionActionInputField[] {
  return [cameraOption(self)]
}

function getTargetCamera(options: Options, self: ModuleInstance): number {
  return Number(options.cameraNumber ?? self.config.defaultCamera)
}

function dropdown(id: string, label: string, choices: Choice[], fallbackDefault: string | number = ''): CompanionInputFieldDropdown {
  return { id, type: 'dropdown', label, default: choices[0]?.id ?? fallbackDefault, choices }
}

function numberOption(id: string, label: string, def: number, min: number, max: number, extra: Partial<CompanionInputFieldNumber> = {}): CompanionInputFieldNumber {
  return { id, type: 'number', label, default: def, min, max, ...extra }
}

const SPEED = (def: number) => numberOption('speed', 'Speed (1-100)', def, 1, 100, { range: true })

const FORCE: SomeCompanionActionInputField = {
  id: 'force',
  type: 'checkbox',
  label: 'Move even when on air (ignore the on-air lock)',
  default: false,
}

const MOVE_TIME = (label = 'Move time (s, 0 = default)'): CompanionInputFieldNumber =>
  numberOption('time', label, 0, 0, 60, { step: 0.1 })

/** Seconds from an option → ms, or undefined for "0 = default". */
function moveTimeMs(options: Options): number | undefined {
  const s = Number(options.time)
  return Number.isFinite(s) && s > 0 ? clampMoveTime(s * 1000) : undefined
}

const ON_OFF_TOGGLE: Choice[] = [
  { id: 'toggle', label: 'Toggle' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
]

// ── Paint (relative, via the Companion API) ─────────────────────────────────

/**
 * BEDARF 129 — a relative button sends the bridge's nudge id (`irisUp` …,
 * `protocol/paintNudge.ts`). The bridge trims from the value it READ for this
 * camera and refuses when it has none. Before, the module added the step to
 * its own copy of the state — merged across all cameras, with 128 invented
 * where nothing was known, and with a gain ceiling (7) the bridge does not
 * have (6).
 */
function makeNudgeAction(self: ModuleInstance, name: string, nudgeId: string): CompanionActionDefinition {
  return {
    name,
    options: getTargetOptions(self),
    callback: async (event) => {
      await self.sendCameraCommand(nudgeId, { cameraNumber: getTargetCamera(event.options, self) })
    },
  }
}

const PAINT_SET: Choice[] = [
  { id: 'setIris', label: 'Iris (0-255)' },
  { id: 'setMasterGain', label: 'Master gain (step 0-6)' },
  { id: 'setMasterBlack', label: 'Master black (0-255, 128 = centre)' },
  { id: 'setMasterGamma', label: 'Master gamma (0-255, 128 = centre)' },
  { id: 'setSaturation', label: 'Saturation (0-255, 128 = centre)' },
  { id: 'setDetailLevel', label: 'Detail level' },
  { id: 'setNdFilter', label: 'ND filter (step 0-3)' },
  { id: 'setShutterSpeed', label: 'Shutter (camera table index)' },
  { id: 'setColorTemp', label: 'Colour temperature (K)' },
  { id: 'setContrast', label: 'Contrast' },
]

const TRIGGERS: Choice[] = [
  { id: 'home', label: 'Home position' },
  { id: 'autoFocus', label: 'Auto focus' },
  { id: 'manualFocus', label: 'Manual focus' },
  { id: 'autoWhiteBalance', label: 'Auto white balance' },
  { id: 'autoBlackBalance', label: 'Auto black balance' },
  { id: 'resetColorCorrection', label: 'Reset colour correction' },
]

const SWITCHES: Choice[] = [
  { id: 'setAutoIris', label: 'Auto iris' },
  { id: 'setRecording', label: 'Recording' },
]

// ── Head directions ─────────────────────────────────────────────────────────

const DIRECTIONS: Record<string, { pan: number; tilt: number; label: string }> = {
  up: { pan: 0, tilt: 1, label: 'Up' },
  down: { pan: 0, tilt: -1, label: 'Down' },
  left: { pan: -1, tilt: 0, label: 'Left' },
  right: { pan: 1, tilt: 0, label: 'Right' },
  upleft: { pan: -1, tilt: 1, label: 'Up left' },
  upright: { pan: 1, tilt: 1, label: 'Up right' },
  downleft: { pan: -1, tilt: -1, label: 'Down left' },
  downright: { pan: 1, tilt: -1, label: 'Down right' },
}

/** A speed axis: + / - / stop, the value the bridge expects (-100..100). */
function axisValue(direction: unknown, speed: unknown, plus: string): number {
  if (direction === 'stop') return 0
  const v = Math.max(1, Math.min(100, Number(speed) || 50))
  return direction === plus ? v : -v
}

function axisAction(
  self: ModuleInstance,
  name: string,
  cmd: string,
  plus: Choice,
  minus: Choice,
  description: string,
): CompanionActionDefinition {
  return {
    name,
    description,
    options: [
      cameraOption(self),
      dropdown('direction', 'Direction', [plus, minus, { id: 'stop', label: 'Stop' }]),
      SPEED(50),
    ],
    callback: async (event) => {
      self.sendControl('command', {
        cameraNumber: getTargetCamera(event.options, self),
        cmd,
        params: { value: axisValue(event.options.direction, event.options.speed, String(plus.id)) },
      })
    },
  }
}

// ── The definitions ─────────────────────────────────────────────────────────

export function buildActions(self: ModuleInstance): CompanionActionDefinitions {
  const s = self.studio
  const cam = (o: Options) => getTargetCamera(o, self)

  /** The camera must be on the bridge — `setCameraConfig` would otherwise CREATE an empty slot. */
  const knownCamera = (n: number, what: string): boolean => {
    if (s.cameras?.[n]) return true
    self.log('warn', `${what}: camera ${n} is not on the bridge (or the control link is down) — nothing sent.`)
    return false
  }

  return {
    // ── Paint, relative (unchanged ids) ───────────────────────────────────
    iris_up: makeNudgeAction(self, 'Iris +', 'irisUp'),
    iris_down: makeNudgeAction(self, 'Iris -', 'irisDown'),
    gain_up: makeNudgeAction(self, 'Gain + (1 step)', 'gainUp'),
    gain_down: makeNudgeAction(self, 'Gain - (1 step)', 'gainDown'),
    black_up: makeNudgeAction(self, 'Master Black +', 'blackUp'),
    black_down: makeNudgeAction(self, 'Master Black -', 'blackDown'),
    gamma_up: makeNudgeAction(self, 'Master Gamma +', 'gammaUp'),
    gamma_down: makeNudgeAction(self, 'Master Gamma -', 'gammaDown'),
    saturation_up: makeNudgeAction(self, 'Saturation +', 'satUp'),
    saturation_down: makeNudgeAction(self, 'Saturation -', 'satDown'),
    // The bridge has no relative detail (its range differs per camera, see
    // paintNudge.ts) — these two stay absolute steps from the value the
    // bridge reported for THIS camera, and refuse without one.
    detail_up: makeDetailAction(self, 'Detail +', 4),
    detail_down: makeDetailAction(self, 'Detail -', -4),
    nd_up: makeNudgeAction(self, 'ND +', 'ndUp'),
    nd_down: makeNudgeAction(self, 'ND -', 'ndDown'),

    // ── Paint, absolute ───────────────────────────────────────────────────
    paint_set: {
      name: 'Paint: set value',
      description: 'Sends an absolute value. The range depends on the camera; the bridge says when a camera cannot do it.',
      options: [cameraOption(self), dropdown('command', 'Parameter', PAINT_SET), numberOption('value', 'Value', 128, -100000, 100000)],
      callback: async (event) => {
        await self.sendCameraCommand(String(event.options.command), { cameraNumber: cam(event.options), value: Number(event.options.value) })
      },
    },
    paint_rgb: {
      name: 'Paint: white / black balance (R, G, B)',
      options: [
        cameraOption(self),
        dropdown('which', 'Balance', [
          { id: 'setWhiteBalance', label: 'White (R/G/B gain)' },
          { id: 'setBlackBalance', label: 'Black (R/G/B)' },
        ]),
        numberOption('r', 'R', 128, 0, 255),
        numberOption('g', 'G', 128, 0, 255),
        numberOption('b', 'B', 128, 0, 255),
      ],
      callback: async (event) => {
        const o = event.options
        await self.sendCameraCommand(String(o.which), { cameraNumber: cam(o), r: Number(o.r), g: Number(o.g), b: Number(o.b) })
      },
    },
    camera_trigger: {
      name: 'Camera: one-shot function',
      options: [cameraOption(self), dropdown('command', 'Function', TRIGGERS)],
      callback: async (event) => {
        self.sendControl('command', { cameraNumber: cam(event.options), cmd: String(event.options.command), params: {} })
      },
    },
    camera_switch: {
      name: 'Camera: auto iris / recording on/off',
      options: [
        cameraOption(self),
        dropdown('command', 'Function', SWITCHES),
        dropdown('on', 'State', [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ]),
      ],
      callback: async (event) => {
        self.sendControl('command', { cameraNumber: cam(event.options), cmd: String(event.options.command), params: { on: event.options.on === 'on' } })
      },
    },
    set_bars: {
      name: 'Bars toggle',
      options: [...getTargetOptions(self), dropdown('on', 'Bars', ON_OFF_TOGGLE)],
      callback: async (event) => {
        const n = cam(event.options)
        const next = resolveToggle(self, String(event.options.on), self.cameraStateFor(n).bars, 'set_bars')
        if (next === undefined) return
        await self.sendCameraCommand('setBars', { on: next, cameraNumber: n })
      },
    },
    set_camera_power: {
      name: 'Power toggle',
      options: [...getTargetOptions(self), dropdown('on', 'Power', ON_OFF_TOGGLE)],
      callback: async (event) => {
        const n = cam(event.options)
        const next = resolveToggle(self, String(event.options.on), self.cameraStateFor(n).cameraPower, 'set_camera_power')
        if (next === undefined) return
        await self.sendCameraCommand('setCameraPower', { on: next, cameraNumber: n })
      },
    },
    camera_connect: {
      name: 'Camera: connect / disconnect on the bridge',
      options: [
        cameraOption(self),
        dropdown('mode', 'Action', [
          { id: 'connect', label: 'Connect' },
          { id: 'disconnect', label: 'Disconnect' },
        ]),
      ],
      callback: async (event) => {
        const n = cam(event.options)
        if (!knownCamera(n, 'camera_connect')) return
        self.sendControl(event.options.mode === 'disconnect' ? 'disconnectCamera' : 'connectCamera', { cameraNumber: n })
      },
    },

    // ── Head: speed moves ─────────────────────────────────────────────────
    ptz_move: {
      name: 'Head: pan/tilt (press) — pair with "Head: stop pan/tilt" on release',
      options: [
        cameraOption(self),
        dropdown('direction', 'Direction', Object.entries(DIRECTIONS).map(([id, d]) => ({ id, label: d.label }))),
        SPEED(50),
      ],
      callback: async (event) => {
        const d = DIRECTIONS[String(event.options.direction)] ?? DIRECTIONS.up
        const v = Math.max(1, Math.min(100, Number(event.options.speed) || 50))
        self.sendControl('command', { cameraNumber: cam(event.options), cmd: 'ptz', params: { pan: d.pan * v, tilt: d.tilt * v } })
      },
    },
    ptz_stop: {
      name: 'Head: stop pan/tilt',
      options: [cameraOption(self)],
      callback: async (event) => {
        self.sendControl('command', { cameraNumber: cam(event.options), cmd: 'ptz', params: { pan: 0, tilt: 0 } })
      },
    },
    zoom: axisAction(self, 'Head: zoom (speed)', 'setZoom', { id: 'in', label: 'In (tele)' }, { id: 'out', label: 'Out (wide)' }, 'Press with In/Out, release with Stop.'),
    focus: axisAction(self, 'Head: focus (speed)', 'setFocus', { id: 'far', label: 'Far' }, { id: 'near', label: 'Near' }, 'Press with Far/Near, release with Stop.'),
    column: axisAction(self, 'Head: elevation column (speed)', 'setColumn', { id: 'up', label: 'Up' }, { id: 'down', label: 'Down' }, 'Robotic heads with an elevation column. Press with Up/Down, release with Stop.'),
    zoom_to: {
      name: 'Head: zoom to position',
      options: [cameraOption(self), numberOption('zoom', 'Zoom (0 = wide, 100 = tele)', 0, 0, 100, { range: true })],
      callback: async (event) => {
        self.sendControl('zoomTo', { cameraNumber: cam(event.options), zoom: Math.max(0, Math.min(100, Number(event.options.zoom))) / 100 })
      },
    },
    read_pose: {
      name: 'Head: read pose (updates the pan/tilt/zoom variables)',
      options: [cameraOption(self)],
      callback: async (event) => {
        self.sendControl('readPose', { cameraNumber: cam(event.options) })
      },
    },

    // ── Presets (#144: soft presets) ──────────────────────────────────────
    preset_recall: {
      name: 'Preset: recall',
      description:
        'Where the head reports its pose the bridge glides to the stored pose (soft), otherwise the camera recalls its own preset. Move time 0 = the time stored with the preset.',
      options: [cameraOption(self), numberOption('preset', 'Preset', 1, 0, 255), MOVE_TIME('Move time (s, 0 = stored)'), FORCE],
      callback: async (event) => {
        const o = event.options
        const timeMs = moveTimeMs(o)
        self.sendControl('command', {
          cameraNumber: cam(o),
          cmd: 'recallPreset',
          params: { value: Number(o.preset), ...(timeMs !== undefined ? { timeMs } : {}), ...(o.force ? { force: true } : {}) },
        })
      },
    },
    preset_store: {
      name: 'Preset: store',
      description: 'Stores into the camera and, on a head that reports its pose, the pose in the bridge (for the soft recall).',
      options: [cameraOption(self), numberOption('preset', 'Preset', 1, 0, 255), MOVE_TIME('Move time (s, 0 = keep)')],
      callback: async (event) => {
        const o = event.options
        const timeMs = moveTimeMs(o)
        self.sendControl('command', { cameraNumber: cam(o), cmd: 'storePreset', params: { value: Number(o.preset), ...(timeMs !== undefined ? { timeMs } : {}) } })
      },
    },
    preset_motion: {
      name: 'Preset: move time / soft on-off',
      options: [
        cameraOption(self),
        numberOption('preset', 'Preset', 1, 0, 255),
        MOVE_TIME('Move time (s, 0 = unchanged)'),
        dropdown('soft', 'Soft (eased) recall', [
          { id: 'keep', label: 'Unchanged' },
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off (camera preset)' },
          { id: 'toggle', label: 'Toggle' },
        ]),
      ],
      callback: async (event) => {
        const o = event.options
        const n = cam(o)
        if (!knownCamera(n, 'preset_motion')) return
        const timeMs = moveTimeMs(o)
        const current = s.cameras?.[n]?.bridgePresets?.[String(Number(o.preset))]?.soft
        const soft = o.soft === 'on' ? true : o.soft === 'off' ? false : o.soft === 'toggle' ? current === false : undefined
        if (timeMs === undefined && soft === undefined) return
        self.sendControl('setPresetMotion', {
          cameraNumber: n,
          presetNumber: Number(o.preset),
          ...(timeMs !== undefined ? { timeMs } : {}),
          ...(soft !== undefined ? { soft } : {}),
        })
      },
    },

    // ── Studio shots (#146) ───────────────────────────────────────────────
    recall_shot: {
      name: 'Studio: recall shot (cut / fade)',
      options: [
        cameraOption(self),
        numberOption('preset', 'Shot (preset or planned shot number)', 1, 0, 255),
        dropdown('source', 'Source', [
          { id: 'head', label: 'Preset in the head' },
          { id: 'plan', label: 'Planned shot' },
        ]),
        dropdown('mode', 'Mode', [
          { id: 'default', label: 'Default of the studio shots' },
          { id: 'cut', label: 'Cut (as fast as it goes)' },
          { id: 'fade', label: 'Fade (timed, all axes land together)' },
        ]),
        MOVE_TIME(),
        FORCE,
      ],
      callback: async (event) => {
        const o = event.options
        const timeMs = moveTimeMs(o)
        self.sendControl('recallShot', {
          cameraNumber: cam(o),
          presetNumber: Number(o.preset),
          source: o.source === 'plan' ? 'plan' : 'head',
          ...(o.mode === 'cut' || o.mode === 'fade' ? { mode: o.mode } : {}),
          ...(timeMs !== undefined ? { timeMs } : {}),
          ...(o.force ? { force: true } : {}),
        })
      },
    },
    recall_shot_set: {
      name: 'Studio: recall shot set',
      options: [dropdown('set', 'Shot set', setChoices(s)), FORCE],
      callback: async (event) => {
        const id = String(event.options.set ?? '')
        if (!id) return
        self.sendControl('recallShotSet', { id, ...(event.options.force ? { force: true } : {}) })
      },
    },
    recall_seat: {
      name: 'Studio: recall seat',
      description: 'The bridge picks the first connected camera for this seat that is not on air.',
      options: [dropdown('seat', 'Seat', seatChoices(s)), FORCE],
      callback: async (event) => {
        const id = String(event.options.seat ?? '')
        if (!id) return
        self.sendControl('recallSeat', { id, ...(event.options.force ? { force: true } : {}) })
      },
    },
    play_move: {
      name: 'Studio: play move',
      options: [dropdown('move', 'Move', moveChoices(s)), FORCE],
      callback: async (event) => {
        const id = String(event.options.move ?? '')
        if (!id) return
        self.sendControl('playMove', { id, ...(event.options.force ? { force: true } : {}) })
      },
    },
    stop_move: {
      name: 'Studio: stop move',
      description: 'Stops the running move (and any glide) of the camera.',
      options: [
        dropdown('target', 'Stop', [
          { id: 'running', label: 'Every camera with a running move' },
          { id: 'camera', label: 'This camera' },
        ]),
        { ...cameraOption(self), isVisible: (o) => o.target === 'camera' },
      ],
      callback: async (event) => {
        const o = event.options
        const cameras =
          o.target === 'camera'
            ? [cam(o)]
            : [...new Set(Object.values(s.moves).filter((m) => m.state === 'playing').map((m) => m.cameraNumber))]
        for (const n of cameras) self.sendControl('stopMove', { cameraNumber: n })
      },
    },
    move_anyway: {
      name: 'Studio: move anyway (the recall the on-air lock held back)',
      description: 'Sends the last held recall again with force. Does nothing when no recall is held.',
      options: [],
      callback: async () => {
        const held = s.held
        if (!held) {
          self.log('info', 'move_anyway: no recall is held.')
          return
        }
        const { type, ...rest } = held.retry
        s.held = null
        self.studioChanged(['held'])
        self.sendControl(String(type), { ...rest, force: true })
      },
    },
    dismiss_held: {
      name: 'Studio: dismiss held recall',
      options: [],
      callback: async () => {
        if (!s.held) return
        s.held = null
        self.studioChanged(['held'])
      },
    },
    on_air_lock: {
      name: 'Studio: on-air lock per camera',
      description: 'With the lock on, a recall does not move a camera that is on programme unless forced.',
      options: [cameraOption(self), dropdown('mode', 'Lock', ON_OFF_TOGGLE)],
      callback: async (event) => {
        const n = cam(event.options)
        if (!knownCamera(n, 'on_air_lock')) return
        const next = resolveToggle(self, String(event.options.mode), onAirLock(s, n), 'on_air_lock')
        if (next === undefined) return
        self.sendControl('setCameraConfig', { cameraNumber: n, config: { tallyProtect: next } })
      },
    },
    studio_defaults: {
      name: 'Studio: default move time / mode',
      options: [
        dropdown('timeMode', 'Move time', [
          { id: 'keep', label: 'Unchanged' },
          { id: 'set', label: 'Set to' },
          { id: 'add', label: 'Add' },
          { id: 'sub', label: 'Subtract' },
        ]),
        numberOption('seconds', 'Seconds', 1, 0, 60, { step: 0.1 }),
        dropdown('mode', 'Mode', [
          { id: 'keep', label: 'Unchanged' },
          { id: 'cut', label: 'Cut' },
          { id: 'fade', label: 'Fade' },
          { id: 'toggle', label: 'Toggle' },
        ]),
      ],
      callback: async (event) => {
        const o = event.options
        const shots = s.shots
        if (!shots) {
          self.log('warn', 'studio_defaults: the bridge has not sent its studio shots yet — nothing changed.')
          return
        }
        const ms = Number(o.seconds) * 1000
        const timeMs =
          o.timeMode === 'set' ? ms : o.timeMode === 'add' ? shots.defaultTimeMs + ms : o.timeMode === 'sub' ? shots.defaultTimeMs - ms : undefined
        const mode =
          o.mode === 'cut' || o.mode === 'fade' ? o.mode : o.mode === 'toggle' ? (shots.defaultMode === 'cut' ? 'fade' : 'cut') : undefined
        if (timeMs === undefined && mode === undefined) return
        if (timeMs !== undefined && !Number.isFinite(timeMs)) return
        self.sendControl('setStudioShots', { shots: withDefaults(shots, { mode, timeMs }) })
      },
    },

    // ── Aim and panorama (#145) ───────────────────────────────────────────
    aim_panorama_region: {
      name: 'Aim: go to a region of the panorama map',
      description: 'Frame in percent of the stored panorama (0,0 = top left). Needs a scanned panorama.',
      options: [
        cameraOption(self),
        numberOption('x', 'Left (%)', 25, 0, 100),
        numberOption('y', 'Top (%)', 25, 0, 100),
        numberOption('w', 'Width (%)', 50, 1, 100),
        numberOption('h', 'Height (%)', 50, 1, 100),
      ],
      callback: async (event) => {
        const o = event.options
        const p = (k: string) => Math.max(0, Math.min(100, Number(o[k]) || 0)) / 100
        self.sendControl('aimFrame', { cameraNumber: cam(o), source: 'panorama', frame: { x: p('x'), y: p('y'), w: p('w'), h: p('h') } })
      },
    },
    scan_panorama: {
      name: 'Aim: scan panorama',
      options: [cameraOption(self)],
      callback: async (event) => {
        self.sendControl('scanPanorama', { cameraNumber: cam(event.options) })
      },
    },
    calibrate_fov: {
      name: 'Aim: measure field of view',
      options: [cameraOption(self)],
      callback: async (event) => {
        self.sendControl('calibrateFov', { cameraNumber: cam(event.options) })
      },
    },
    cancel_panorama: {
      name: 'Aim: cancel scan / measurement',
      options: [cameraOption(self)],
      callback: async (event) => {
        self.sendControl('cancelPanorama', { cameraNumber: cam(event.options) })
      },
    },

    // ── Mixer ─────────────────────────────────────────────────────────────
    switcher: {
      name: 'Mixer: preview / take / cut',
      options: [
        dropdown('switcher', 'Mixer', switcherChoices(s), 1),
        dropdown('command', 'Command', [
          { id: 'preview', label: 'Preview source' },
          { id: 'take', label: 'Take source' },
          { id: 'cut', label: 'Cut' },
        ]),
        { ...numberOption('source', 'Source', 1, 0, 64), isVisible: (o) => o.command !== 'cut' },
      ],
      callback: async (event) => {
        const o = event.options
        self.sendControl('switcherCommand', {
          switcherNumber: Number(o.switcher),
          cmd: String(o.command),
          params: { source: Number(o.source) },
        })
      },
    },

    // ── Global tally (unchanged ids) ──────────────────────────────────────
    tally_program: {
      name: 'Set program tally',
      options: [dropdown('mode', 'Mode', ON_OFF_TOGGLE)],
      callback: async (event) => {
        // ADR-003 — „Toggle" leitet einen Befehl aus einem Zustand ab. Ist
        // der Zustand unbestaetigt, gibt es kein Gegenteil, das man bilden
        // koennte: `!undefined` waere `true` und haette die Kamera aus purer
        // Unkenntnis auf Sendung geschaltet.
        const next = resolveToggle(self, String(event.options.mode), self.tallyState.program, 'tally_program')
        if (next === undefined) return
        await self.sendTally({ program: next })
      },
    },
    tally_preview: {
      name: 'Set preview tally',
      options: [dropdown('mode', 'Mode', ON_OFF_TOGGLE)],
      callback: async (event) => {
        const next = resolveToggle(self, String(event.options.mode), self.tallyState.preview, 'tally_preview')
        if (next === undefined) return
        await self.sendTally({ preview: next })
      },
    },
    tally_clear: {
      name: 'Clear all tally',
      options: [],
      callback: async () => {
        await self.sendTally({ program: false, preview: false, isoRec: false })
      },
    },
  }
}

/**
 * ADR-003 — on/off are always possible; a toggle needs a CONFIRMED state to
 * invert. `!undefined` would be `true` and switch something on out of pure
 * ignorance, so the toggle does nothing and says why.
 */
export function resolveToggle(self: ModuleInstance, option: string, current: boolean | undefined, actionId: string): boolean | undefined {
  if (option === 'on') return true
  if (option === 'off') return false
  if (current === undefined) {
    self.log('warn', `${actionId}: state unconfirmed — toggle not sent. Use On/Off.`)
    return undefined
  }
  return !current
}

function makeDetailAction(self: ModuleInstance, name: string, step: number): CompanionActionDefinition {
  return {
    name,
    options: getTargetOptions(self),
    callback: async (event) => {
      const n = getTargetCamera(event.options, self)
      const current = self.cameraStateFor(n).detailLevel
      if (typeof current !== 'number') {
        self.log('warn', `${name}: camera ${n} has not reported its detail level — set it once absolutely (Paint: set value).`)
        return
      }
      await self.sendCameraCommand('setDetailLevel', { value: Math.max(0, Math.min(255, current + step)), cameraNumber: n })
    },
  }
}

export function updateActions(self: ModuleInstance): void {
  self.setActionDefinitions(buildActions(self))
}
