import {
  combineRgb,
  type CompanionButtonPresetDefinition,
  type CompanionOptionValues,
  type CompanionPresetAction,
  type CompanionPresetDefinitions,
  type CompanionPresetFeedback,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { parseCameraTargets } from './config.js'
import { cameraNumbers, seatLabel } from './studio.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREY = combineRgb(40, 40, 40)
const RED = combineRgb(204, 0, 0)
const GREEN = combineRgb(0, 204, 0)
const AMBER = combineRgb(255, 191, 0)
const VIOLET = combineRgb(153, 0, 204)

/** How many preset buttons per camera the ready-made pages offer. */
export const PRESET_BUTTONS = 8

function button(
  category: string,
  name: string,
  text: string,
  down: CompanionPresetAction[],
  opts: { up?: CompanionPresetAction[]; feedbacks?: CompanionPresetFeedback[]; size?: number | 'auto'; bgcolor?: number } = {},
): CompanionButtonPresetDefinition {
  return {
    type: 'button',
    category,
    name,
    style: { text, size: opts.size ?? 'auto', color: WHITE, bgcolor: opts.bgcolor ?? GREY },
    steps: [{ down, up: opts.up ?? [] }],
    feedbacks: opts.feedbacks ?? [],
  }
}

const act = (actionId: string, options: CompanionOptionValues = {}): CompanionPresetAction => ({ actionId, options })

const held = (cameraNumber: number | 'any'): CompanionPresetFeedback => ({
  feedbackId: 'shot_held',
  options: { cameraNumber },
  style: { bgcolor: AMBER, color: BLACK },
})

/**
 * Ready-made button pages: studio shots from the bridge (one button per set,
 * seat and move), and per camera the head, presets, on-air lock and aim.
 * Built from the bridge's lists, so they follow what is set up there.
 */
export function buildPresets(self: ModuleInstance): CompanionPresetDefinitions {
  const s = self.studio
  const v = (id: string) => `$(${self.label}:${id})`
  const out: CompanionPresetDefinitions = {}
  const cams = cameraNumbers(s)
  const cameras = cams.length ? cams : parseCameraTargets(self.config).map((t) => t.id)

  // ── Studio shots ────────────────────────────────────────────────────────
  for (const set of s.shots?.sets ?? []) {
    out[`set_${set.id}`] = button('Studio: shot sets', set.name, set.name, [act('recall_shot_set', { set: set.id, force: false })], {
      feedbacks: [
        { feedbackId: 'active_shot_set', options: { set: set.id }, style: { bgcolor: GREEN, color: BLACK } },
        held('any'),
      ],
    })
  }
  for (const seat of s.shots?.seats.seats ?? []) {
    const label = seatLabel(seat)
    out[`seat_${seat.id}`] = button('Studio: seats', label, label, [act('recall_seat', { seat: seat.id, force: false })], {
      feedbacks: [held('any')],
    })
  }
  for (const move of s.shots?.moves ?? []) {
    out[`move_${move.id}`] = button('Studio: moves', `Play ${move.name}`, `▶ ${move.name}`, [act('play_move', { move: move.id, force: false })], {
      feedbacks: [{ feedbackId: 'move_running', options: { move: move.id }, style: { bgcolor: VIOLET, color: WHITE } }, held(move.cameraNumber)],
    })
  }
  out.studio_stop_moves = button('Studio: moves', 'Stop all moves', '■ STOP\\nmoves', [act('stop_move', { target: 'running', cameraNumber: self.config.defaultCamera })], {
    feedbacks: [{ feedbackId: 'move_running', options: { move: 'any' }, style: { bgcolor: VIOLET, color: WHITE } }],
  })
  out.studio_move_anyway = button('Studio: control', 'Move anyway', 'MOVE\\nANYWAY\\n' + v('held_label'), [act('move_anyway')], {
    feedbacks: [held('any')],
    size: 14,
  })
  out.studio_dismiss_held = button('Studio: control', 'Dismiss held recall', 'DISMISS\\nHELD', [act('dismiss_held')], { feedbacks: [held('any')] })
  out.studio_time_up = button('Studio: control', 'Default move time +0.5 s', `TIME +\\n${v('default_move_time')} s`, [
    act('studio_defaults', { timeMode: 'add', seconds: 0.5, mode: 'keep' }),
  ])
  out.studio_time_down = button('Studio: control', 'Default move time -0.5 s', `TIME -\\n${v('default_move_time')} s`, [
    act('studio_defaults', { timeMode: 'sub', seconds: 0.5, mode: 'keep' }),
  ])
  out.studio_mode = button('Studio: control', 'Default mode cut/fade', `MODE\\n${v('default_mode')}`, [
    act('studio_defaults', { timeMode: 'keep', seconds: 1, mode: 'toggle' }),
  ])

  // ── Per camera ──────────────────────────────────────────────────────────
  for (const n of cameras) {
    const label = s.cameras?.[n]?.label ?? `Camera ${n}`
    const head = `${label}: head`
    const cam = { cameraNumber: n }
    const dirs: Array<[string, string]> = [
      ['up', '⬆'],
      ['down', '⬇'],
      ['left', '⬅'],
      ['right', '➡'],
      ['upleft', '⬉'],
      ['upright', '⬈'],
      ['downleft', '⬋'],
      ['downright', '⬊'],
    ]
    for (const [dir, arrow] of dirs) {
      out[`c${n}_ptz_${dir}`] = button(head, `Pan/tilt ${dir}`, arrow, [act('ptz_move', { ...cam, direction: dir, speed: 50 })], {
        up: [act('ptz_stop', cam)],
        size: 30,
      })
    }
    const axis = (id: string, action: string, dir: string, text: string) => {
      out[`c${n}_${id}`] = button(head, text.replace('\\n', ' '), text, [act(action, { ...cam, direction: dir, speed: 50 })], {
        up: [act(action, { ...cam, direction: 'stop', speed: 50 })],
      })
    }
    axis('zoom_in', 'zoom', 'in', 'ZOOM\\nIN')
    axis('zoom_out', 'zoom', 'out', 'ZOOM\\nOUT')
    axis('focus_far', 'focus', 'far', 'FOCUS\\nFAR')
    axis('focus_near', 'focus', 'near', 'FOCUS\\nNEAR')
    axis('column_up', 'column', 'up', 'COLUMN\\nUP')
    axis('column_down', 'column', 'down', 'COLUMN\\nDOWN')
    out[`c${n}_column_stop`] = button(head, 'Column stop', 'COLUMN\\nSTOP', [act('column', { ...cam, direction: 'stop', speed: 50 })])
    out[`c${n}_af`] = button(head, 'Auto focus', 'AF', [act('camera_trigger', { ...cam, command: 'autoFocus' })])
    out[`c${n}_home`] = button(head, 'Home', 'HOME', [act('camera_trigger', { ...cam, command: 'home' })])
    out[`c${n}_pose`] = button(head, 'Read pose', `P ${v(`cam${n}_pan`)}\\nT ${v(`cam${n}_tilt`)}\\nZ ${v(`cam${n}_zoom`)}`, [act('read_pose', cam)], { size: 14 })
    out[`c${n}_stop_move`] = button(head, 'Stop move', '■ STOP', [act('stop_move', { target: 'camera', ...cam })], {
      feedbacks: [{ feedbackId: 'move_running', options: { move: 'any' }, style: { bgcolor: VIOLET, color: WHITE } }],
    })

    const presets = `${label}: presets`
    for (let p = 1; p <= PRESET_BUTTONS; p++) {
      out[`c${n}_recall_${p}`] = button(presets, `Recall ${p} (fade)`, `${label}\\nSHOT ${p}`, [
        act('recall_shot', { ...cam, preset: p, source: 'head', mode: 'default', time: 0, force: false }),
      ], {
        size: 14,
        feedbacks: [
          { feedbackId: 'active_shot', options: { ...cam, preset: p, source: 'head' }, style: { bgcolor: GREEN, color: BLACK } },
          held(n),
        ],
      })
    }
    for (let p = 1; p <= PRESET_BUTTONS; p++) {
      out[`c${n}_cut_${p}`] = button(presets, `Cut to ${p}`, `CUT\\n${p}`, [
        act('recall_shot', { ...cam, preset: p, source: 'head', mode: 'cut', time: 0, force: false }),
      ], {
        feedbacks: [
          { feedbackId: 'active_shot', options: { ...cam, preset: p, source: 'head' }, style: { bgcolor: GREEN, color: BLACK } },
          held(n),
        ],
      })
    }
    for (let p = 1; p <= PRESET_BUTTONS; p++) {
      out[`c${n}_store_${p}`] = button(`${label}: store presets`, `Store ${p}`, `STORE\\n${p}`, [act('preset_store', { ...cam, preset: p, time: 0 })], {
        bgcolor: combineRgb(90, 0, 0),
      })
    }

    const studio = `${label}: on air`
    out[`c${n}_lock`] = button(studio, 'On-air lock toggle', `LOCK\\n${v(`cam${n}_on_air_lock`)}`, [act('on_air_lock', { ...cam, mode: 'toggle' })], {
      feedbacks: [
        { feedbackId: 'on_air_lock', options: cam, style: { bgcolor: AMBER, color: BLACK } },
        { feedbackId: 'camera_tally', options: { ...cam, state: 'program' }, style: { bgcolor: RED, color: WHITE } },
      ],
    })
    out[`c${n}_tally`] = button(studio, 'Mixer tally', `${label}\\n${v(`cam${n}_tally`)}`, [], {
      size: 14,
      feedbacks: [
        { feedbackId: 'camera_tally', options: { ...cam, state: 'preview' }, style: { bgcolor: GREEN, color: BLACK } },
        { feedbackId: 'camera_tally', options: { ...cam, state: 'program' }, style: { bgcolor: RED, color: WHITE } },
      ],
    })

    const aim = `${label}: aim`
    const job: CompanionPresetFeedback = { feedbackId: 'head_job_running', options: cam, style: { bgcolor: AMBER, color: BLACK } }
    out[`c${n}_scan`] = button(aim, 'Scan panorama', 'SCAN\\nPANORAMA', [act('scan_panorama', cam)], { feedbacks: [job] })
    out[`c${n}_fov`] = button(aim, 'Measure field of view', 'MEASURE\\nFOV', [act('calibrate_fov', cam)], { feedbacks: [job] })
    out[`c${n}_cancel`] = button(aim, 'Cancel scan / measurement', 'CANCEL\\n' + v(`cam${n}_job`), [act('cancel_panorama', cam)], { feedbacks: [job], size: 14 })
    out[`c${n}_aim_centre`] = button(aim, 'Panorama: centre region', 'AIM\\nCENTRE', [act('aim_panorama_region', { ...cam, x: 25, y: 25, w: 50, h: 50 })])
  }

  // ── Paint (default camera) ──────────────────────────────────────────────
  const paint: Array<[string, string]> = [
    ['iris_up', 'IRIS +'],
    ['iris_down', 'IRIS -'],
    ['gain_up', 'GAIN +'],
    ['gain_down', 'GAIN -'],
    ['black_up', 'BLACK +'],
    ['black_down', 'BLACK -'],
    ['gamma_up', 'GAMMA +'],
    ['gamma_down', 'GAMMA -'],
    ['saturation_up', 'SAT +'],
    ['saturation_down', 'SAT -'],
    ['nd_up', 'ND +'],
    ['nd_down', 'ND -'],
  ]
  for (const [id, text] of paint) {
    out[`paint_${id}`] = button('Paint (default camera)', text, text, [act(id, { cameraNumber: self.config.defaultCamera })])
  }

  // ── Global tally and mixer ──────────────────────────────────────────────
  out.tally_pgm = button('Tally', 'Program tally toggle', 'PGM', [act('tally_program', { mode: 'toggle' })], {
    feedbacks: [
      { feedbackId: 'tally_unknown', options: {}, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId: 'tally_program', options: {}, style: { bgcolor: RED, color: WHITE } },
    ],
  })
  out.tally_pvw = button('Tally', 'Preview tally toggle', 'PVW', [act('tally_preview', { mode: 'toggle' })], {
    feedbacks: [
      { feedbackId: 'tally_unknown', options: {}, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId: 'tally_preview', options: {}, style: { bgcolor: GREEN, color: BLACK } },
    ],
  })
  out.tally_clear = button('Tally', 'Clear tally', 'TALLY\\nCLEAR', [act('tally_clear')])

  const switchers = s.switchers.length ? s.switchers : [{ switcherNumber: 1, label: 'Switcher 1', inputLabels: [] as string[] }]
  for (const w of switchers) {
    const cat = `Mixer: ${w.label}`
    out[`sw${w.switcherNumber}_cut`] = button(cat, 'Cut', 'CUT', [act('switcher', { switcher: w.switcherNumber, command: 'cut', source: 1 })])
    const sources = w.inputLabels.length ? w.inputLabels.length : 4
    for (let i = 1; i <= sources; i++) {
      const name = w.inputLabels[i - 1] || `IN ${i}`
      out[`sw${w.switcherNumber}_pvw_${i}`] = button(cat, `Preview ${name}`, `PVW\\n${name}`, [act('switcher', { switcher: w.switcherNumber, command: 'preview', source: i })])
      out[`sw${w.switcherNumber}_take_${i}`] = button(cat, `Take ${name}`, `TAKE\\n${name}`, [act('switcher', { switcher: w.switcherNumber, command: 'take', source: i })])
    }
  }

  out.status_control = button('Status', 'Control link', 'BRIDGE\\nCONTROL', [], {
    feedbacks: [{ feedbackId: 'control_connected', options: {}, style: { bgcolor: combineRgb(0, 102, 204), color: WHITE } }],
  })
  return out
}

export function updatePresets(self: ModuleInstance): void {
  self.setPresetDefinitions(buildPresets(self))
}
