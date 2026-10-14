import { combineRgb, type CompanionFeedbackDefinitions, type CompanionInputFieldDropdown } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { parseCameraTargets } from './config.js'
import {
  cameraChoices,
  isHeld,
  jobRunning,
  moveChoices,
  moveRunning,
  onAirLock,
  setActive,
  setChoices,
  shotActive,
} from './studio.js'

/** Which feedbacks a studio change can move — `main.ts` re-checks only these. */
export const STUDIO_FEEDBACKS = {
  link: ['control_connected', 'camera_online', 'camera_tally', 'on_air_lock', 'shot_held', 'move_running', 'active_shot_set', 'active_shot', 'head_job_running'],
  cameras: ['camera_online', 'on_air_lock', 'shot_held'],
  tally: ['camera_tally'],
  shot: ['active_shot', 'active_shot_set'],
  shots: ['active_shot_set', 'move_running'],
  held: ['shot_held'],
  move: ['move_running'],
  job: ['head_job_running'],
} as const

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)

export function buildFeedbacks(self: ModuleInstance): CompanionFeedbackDefinitions {
  const s = self.studio
  const fallback = parseCameraTargets(self.config).map((t) => ({ id: t.id, label: t.label }))
  const camera: CompanionInputFieldDropdown = {
    id: 'cameraNumber',
    type: 'dropdown',
    label: 'Camera',
    default: self.config.defaultCamera,
    choices: cameraChoices(s, fallback),
    allowCustom: true,
  }
  const anyCamera: CompanionInputFieldDropdown = {
    ...camera,
    default: 'any',
    choices: [{ id: 'any', label: 'Any camera' }, ...camera.choices],
  }
  const camOf = (o: Record<string, unknown>) => Number(o.cameraNumber ?? self.config.defaultCamera)

  return {
    bridge_connected: {
      type: 'boolean',
      name: 'Bridge reachable',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 102, 204) },
      options: [],
      callback: () => self.bridgeConnected,
    },
    camera_connected: {
      type: 'boolean',
      name: 'Camera connected (any camera on the bridge)',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 153, 0) },
      options: [],
      callback: () => self.cameraConnected,
    },
    control_connected: {
      type: 'boolean',
      name: 'Bridge control link connected',
      description: 'The control port (studio shots, presets, aim). Without it those buttons do nothing.',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 102, 204) },
      options: [],
      callback: () => s.linkConnected,
    },
    camera_online: {
      type: 'boolean',
      name: 'Camera connected (this camera)',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 153, 0) },
      options: [camera],
      callback: (fb) => s.cameras?.[camOf(fb.options)]?.connected === true,
    },
    camera_tally: {
      type: 'boolean',
      name: 'Camera on programme / preview (mixer tally)',
      description: 'From the mixer connected to the bridge and the camera\'s mixer input.',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(204, 0, 0) },
      options: [
        camera,
        {
          id: 'state',
          type: 'dropdown',
          label: 'State',
          default: 'program',
          choices: [
            { id: 'program', label: 'Programme' },
            { id: 'preview', label: 'Preview' },
          ],
        },
      ],
      callback: (fb) => s.cameraTally[camOf(fb.options)] === fb.options.state,
    },
    on_air_lock: {
      type: 'boolean',
      name: 'On-air lock on',
      description: 'False while the bridge has not said (camera unknown or link down).',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(255, 191, 0) },
      options: [camera],
      callback: (fb) => onAirLock(s, camOf(fb.options)) === true,
    },
    shot_held: {
      type: 'boolean',
      name: 'Recall held by the on-air lock',
      description: 'A recall was not carried out because the camera is on air. "Studio: move anyway" sends it.',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(255, 191, 0) },
      options: [anyCamera],
      callback: (fb) => isHeld(s, fb.options.cameraNumber === 'any' ? undefined : camOf(fb.options)),
    },
    move_running: {
      type: 'boolean',
      name: 'Move running',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(153, 0, 204) },
      options: [
        {
          id: 'move',
          type: 'dropdown',
          label: 'Move',
          default: 'any',
          choices: [{ id: 'any', label: 'Any move' }, ...moveChoices(s)],
        },
      ],
      callback: (fb) => moveRunning(s, fb.options.move === 'any' ? undefined : String(fb.options.move)),
    },
    active_shot_set: {
      type: 'boolean',
      name: 'Shot set active',
      description: 'Every camera of the set was last recalled to its shot of the set.',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(0, 204, 0) },
      options: [
        {
          id: 'set',
          type: 'dropdown',
          label: 'Shot set',
          default: setChoices(s)[0]?.id ?? '',
          choices: setChoices(s),
        },
      ],
      callback: (fb) => setActive(s, String(fb.options.set ?? '')),
    },
    active_shot: {
      type: 'boolean',
      name: 'Shot / preset active (last recalled)',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(0, 204, 0) },
      options: [
        camera,
        { id: 'preset', type: 'number', label: 'Shot', default: 1, min: 0, max: 255 },
        {
          id: 'source',
          type: 'dropdown',
          label: 'Source',
          default: 'head',
          choices: [
            { id: 'head', label: 'Preset in the head' },
            { id: 'plan', label: 'Planned shot' },
          ],
        },
      ],
      callback: (fb) =>
        shotActive(s, {
          cameraNumber: camOf(fb.options),
          preset: Number(fb.options.preset),
          source: fb.options.source === 'plan' ? 'plan' : 'head',
        }),
    },
    head_job_running: {
      type: 'boolean',
      name: 'Panorama scan / FOV measurement running',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(255, 191, 0) },
      options: [camera],
      callback: (fb) => jobRunning(s, camOf(fb.options)),
    },
    tally_program: {
      type: 'boolean',
      name: 'Program tally active',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(204, 0, 0) },
      options: [],
      callback: () => self.tallyState.program === true,
    },
    tally_preview: {
      type: 'boolean',
      name: 'Preview tally active',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(0, 204, 0) },
      options: [],
      callback: () => self.tallyState.preview === true,
    },
    tally_iso_rec: {
      type: 'boolean',
      name: 'ISO record active',
      defaultStyle: { color: WHITE, bgcolor: combineRgb(255, 102, 0) },
      options: [],
      callback: () => self.tallyState.isoRec === true,
    },
    // ADR-003 — der Fall, den die drei Feedbacks oben nicht ausdruecken
    // koennen. Sie sind boolesch: „unbestaetigt" sieht dort aus wie „aus",
    // und eine dunkle Tally-Lampe liest sich als Freigabe. Dieses Feedback
    // macht den Unterschied sichtbar, damit ein Button ihn zeigen kann
    // (Vorschlag: Amber). Es ersetzt keine der drei, es steht daneben.
    tally_unknown: {
      type: 'boolean',
      name: 'Tally state unconfirmed',
      description:
        'True while the bridge has not confirmed the tally state — before the first poll, or when /api/tally answered without a tally field. A dark program lamp does NOT mean "off" while this is true.',
      defaultStyle: { color: BLACK, bgcolor: combineRgb(255, 191, 0) },
      options: [],
      callback: () =>
        self.tallyState.program === undefined ||
        self.tallyState.preview === undefined ||
        self.tallyState.isoRec === undefined,
    },
  }
}

export function updateFeedbacks(self: ModuleInstance): void {
  self.setFeedbackDefinitions(buildFeedbacks(self))
}
