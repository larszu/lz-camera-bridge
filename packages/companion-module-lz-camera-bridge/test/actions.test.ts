/**
 * Actions, feedbacks and presets against a stand-in module (test/harness.ts):
 * which message each button sends, and which it refuses to send.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyMessage } from '../src/studio.js'
import { harness } from './harness.js'

function withBridge() {
  const h = harness()
  applyMessage(h.studio, {
    type: 'cameras',
    cameras: [
      { cameraNumber: 1, connected: true, config: { bridgePresets: { '3': { timeMs: 2000 } } } },
      { cameraNumber: 2, connected: true, config: { tallyProtect: false, bridgePresets: { '3': { soft: false } } } },
    ],
  }, 0)
  applyMessage(h.studio, {
    type: 'studioShots',
    shots: {
      defaultMode: 'fade',
      defaultTimeMs: 3000,
      sets: [{ id: 'wide', name: 'Wide', shots: [{ cameraNumber: 1, preset: 2 }] }],
      seats: { rows: 1, cols: 1, seats: [{ id: 'A1', row: 0, col: 0, shots: [{ cameraNumber: 1, preset: 7 }] }] },
      moves: [{ id: 'push', name: 'Push', cameraNumber: 2, steps: [{ preset: 1 }] }],
    },
  }, 0)
  return h
}

test('every existing action id is still there (no upgrade script needed)', () => {
  const ids = Object.keys(harness().actions())
  for (const id of [
    'iris_up', 'iris_down', 'gain_up', 'gain_down', 'black_up', 'black_down', 'gamma_up', 'gamma_down',
    'saturation_up', 'saturation_down', 'detail_up', 'detail_down', 'nd_up', 'nd_down',
    'set_bars', 'set_camera_power', 'tally_program', 'tally_preview', 'tally_clear',
  ]) assert.ok(ids.includes(id), id)
})

test('relative paint goes to the bridge nudge (it trims from the value it read)', async () => {
  const h = harness()
  await h.run('gain_up', { cameraNumber: 3 })
  await h.run('black_down', { cameraNumber: 2 })
  assert.deepEqual(h.http, [
    { action: 'gainUp', params: { cameraNumber: 3 } },
    { action: 'blackDown', params: { cameraNumber: 2 } },
  ])
})

test('detail and toggles refuse without a confirmed value — no invented 128, no !undefined', async () => {
  const h = harness({}, { 2: { detailLevel: 10, bars: true } })
  await h.run('detail_up', { cameraNumber: 1 })
  await h.run('set_bars', { cameraNumber: 1, on: 'toggle' })
  assert.deepEqual(h.http, [])
  assert.equal(h.logs.filter((l) => l.level === 'warn').length, 2)
  await h.run('detail_up', { cameraNumber: 2 })
  await h.run('set_bars', { cameraNumber: 2, on: 'toggle' })
  assert.deepEqual(h.http, [
    { action: 'setDetailLevel', params: { value: 14, cameraNumber: 2 } },
    { action: 'setBars', params: { on: false, cameraNumber: 2 } },
  ])
})

test('head: pan/tilt, zoom, focus and column as speed commands with a stop', async () => {
  const h = harness()
  await h.run('ptz_move', { cameraNumber: 1, direction: 'upleft', speed: 40 })
  await h.run('ptz_stop', { cameraNumber: 1 })
  await h.run('zoom', { cameraNumber: 1, direction: 'out', speed: 70 })
  await h.run('focus', { cameraNumber: 1, direction: 'far', speed: 20 })
  await h.run('column', { cameraNumber: 2, direction: 'down', speed: 500 })
  await h.run('column', { cameraNumber: 2, direction: 'stop' })
  assert.deepEqual(h.control.map((c) => c.payload), [
    { cameraNumber: 1, cmd: 'ptz', params: { pan: -40, tilt: 40 } },
    { cameraNumber: 1, cmd: 'ptz', params: { pan: 0, tilt: 0 } },
    { cameraNumber: 1, cmd: 'setZoom', params: { value: -70 } },
    { cameraNumber: 1, cmd: 'setFocus', params: { value: 20 } },
    { cameraNumber: 2, cmd: 'setColumn', params: { value: -100 } },
    { cameraNumber: 2, cmd: 'setColumn', params: { value: 0 } },
  ])
})

test('soft presets: recall with move time and force, store, move time / soft per preset', async () => {
  const h = withBridge()
  await h.run('preset_recall', { cameraNumber: 1, preset: 3, time: 4.5, force: true })
  await h.run('preset_recall', { cameraNumber: 1, preset: 3 })
  await h.run('preset_store', { cameraNumber: 1, preset: 5, time: 2 })
  await h.run('preset_motion', { cameraNumber: 1, preset: 3, time: 0, soft: 'off' })
  await h.run('preset_motion', { cameraNumber: 2, preset: 3, time: 0, soft: 'toggle' })
  await h.run('preset_motion', { cameraNumber: 1, preset: 3, time: 0.1, soft: 'keep' })
  await h.run('preset_motion', { cameraNumber: 1, preset: 3, time: 0, soft: 'keep' }) // nothing to change
  await h.run('preset_motion', { cameraNumber: 9, preset: 3, time: 1, soft: 'on' }) // not on the bridge
  assert.deepEqual(h.control, [
    { type: 'command', payload: { cameraNumber: 1, cmd: 'recallPreset', params: { value: 3, timeMs: 4500, force: true } } },
    { type: 'command', payload: { cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } } },
    { type: 'command', payload: { cameraNumber: 1, cmd: 'storePreset', params: { value: 5, timeMs: 2000 } } },
    { type: 'setPresetMotion', payload: { cameraNumber: 1, presetNumber: 3, soft: false } },
    { type: 'setPresetMotion', payload: { cameraNumber: 2, presetNumber: 3, soft: true } },
    { type: 'setPresetMotion', payload: { cameraNumber: 1, presetNumber: 3, timeMs: 300 } },
  ])
})

test('studio: shot, set, seat, move, stop, defaults', async () => {
  const h = withBridge()
  await h.run('recall_shot', { cameraNumber: 2, preset: 4, source: 'plan', mode: 'cut', time: 0 })
  await h.run('recall_shot', { cameraNumber: 1, preset: 1, source: 'head', mode: 'default', time: 1.5, force: true })
  await h.run('recall_shot_set', { set: 'wide' })
  await h.run('recall_seat', { seat: 'A1', force: true })
  await h.run('play_move', { move: 'push' })
  applyMessage(h.studio, { type: 'moveProgress', id: 'push', cameraNumber: 2, step: 1, of: 1, state: 'playing' }, 0)
  await h.run('stop_move', { target: 'running' })
  await h.run('stop_move', { target: 'camera', cameraNumber: 1 })
  await h.run('studio_defaults', { timeMode: 'add', seconds: 0.5, mode: 'toggle' })
  assert.deepEqual(h.control.slice(0, 7), [
    { type: 'recallShot', payload: { cameraNumber: 2, presetNumber: 4, source: 'plan', mode: 'cut' } },
    { type: 'recallShot', payload: { cameraNumber: 1, presetNumber: 1, source: 'head', timeMs: 1500, force: true } },
    { type: 'recallShotSet', payload: { id: 'wide' } },
    { type: 'recallSeat', payload: { id: 'A1', force: true } },
    { type: 'playMove', payload: { id: 'push' } },
    { type: 'stopMove', payload: { cameraNumber: 2 } },
    { type: 'stopMove', payload: { cameraNumber: 1 } },
  ])
  const defaults = h.control[7]
  assert.equal(defaults.type, 'setStudioShots')
  const shots = defaults.payload.shots as { defaultTimeMs: number; defaultMode: string; sets: unknown[] }
  assert.equal(shots.defaultTimeMs, 3500)
  assert.equal(shots.defaultMode, 'cut')
  assert.equal(shots.sets.length, 1, 'the rest of the studio shots goes back unchanged')
})

test('studio defaults refuse before the bridge sent its studio shots', async () => {
  const h = harness()
  await h.run('studio_defaults', { timeMode: 'set', seconds: 2, mode: 'keep' })
  assert.deepEqual(h.control, [])
  assert.match(h.logs[0].message, /not sent its studio shots/)
})

test('move anyway: resends the held recall with force; on-air lock toggle needs a known camera', async () => {
  const h = withBridge()
  await h.run('move_anyway')
  assert.deepEqual(h.control, [], 'nothing held, nothing sent')
  applyMessage(h.studio, { type: 'shotHeld', cameras: [1], label: 'Preset 3', retry: { type: 'command', cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 } } }, 0)
  assert.equal(h.check('shot_held', { cameraNumber: 'any' }), true)
  assert.equal(h.check('shot_held', { cameraNumber: 2 }), false)
  await h.run('move_anyway')
  assert.deepEqual(h.control.at(-1), { type: 'command', payload: { cameraNumber: 1, cmd: 'recallPreset', params: { value: 3 }, force: true } })
  assert.equal(h.check('shot_held', { cameraNumber: 'any' }), false)

  await h.run('on_air_lock', { cameraNumber: 1, mode: 'toggle' })
  await h.run('on_air_lock', { cameraNumber: 2, mode: 'toggle' })
  await h.run('on_air_lock', { cameraNumber: 7, mode: 'on' })
  assert.deepEqual(h.control.slice(-2), [
    { type: 'setCameraConfig', payload: { cameraNumber: 1, config: { tallyProtect: false } } },
    { type: 'setCameraConfig', payload: { cameraNumber: 2, config: { tallyProtect: true } } },
  ])
})

test('aim, panorama, mixer and connect', async () => {
  const h = withBridge()
  await h.run('aim_panorama_region', { cameraNumber: 1, x: 10, y: 20, w: 30, h: 40 })
  await h.run('scan_panorama', { cameraNumber: 1 })
  await h.run('calibrate_fov', { cameraNumber: 1 })
  await h.run('cancel_panorama', { cameraNumber: 1 })
  await h.run('zoom_to', { cameraNumber: 1, zoom: 150 })
  await h.run('switcher', { switcher: 1, command: 'take', source: 3 })
  await h.run('camera_connect', { cameraNumber: 2, mode: 'disconnect' })
  await h.run('camera_trigger', { cameraNumber: 2, command: 'autoFocus' })
  assert.deepEqual(h.control, [
    { type: 'aimFrame', payload: { cameraNumber: 1, source: 'panorama', frame: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } } },
    { type: 'scanPanorama', payload: { cameraNumber: 1 } },
    { type: 'calibrateFov', payload: { cameraNumber: 1 } },
    { type: 'cancelPanorama', payload: { cameraNumber: 1 } },
    { type: 'zoomTo', payload: { cameraNumber: 1, zoom: 1 } },
    { type: 'switcherCommand', payload: { switcherNumber: 1, cmd: 'take', params: { source: 3 } } },
    { type: 'disconnectCamera', payload: { cameraNumber: 2 } },
    { type: 'command', payload: { cameraNumber: 2, cmd: 'autoFocus', params: {} } },
  ])
})

test('dropdowns come from the bridge: cameras, sets, seats, moves', () => {
  const h = withBridge()
  const a = h.actions()
  const choices = (id: string, opt: string) =>
    (a[id].options.find((o) => o.id === opt) as { choices: Array<{ id: unknown }> }).choices.map((c) => c.id)
  assert.deepEqual(choices('recall_shot', 'cameraNumber'), [1, 2])
  assert.deepEqual(choices('recall_shot_set', 'set'), ['wide'])
  assert.deepEqual(choices('recall_seat', 'seat'), ['A1'])
  assert.deepEqual(choices('play_move', 'move'), ['push'])
})

test('feedbacks: on-air lock, mixer tally, active set and shot, move running', () => {
  const h = withBridge()
  assert.equal(h.check('on_air_lock', { cameraNumber: 1 }), true)
  assert.equal(h.check('on_air_lock', { cameraNumber: 2 }), false)
  assert.equal(h.check('on_air_lock', { cameraNumber: 5 }), false, 'unknown is not "on"')
  applyMessage(h.studio, { type: 'cameraTally', tally: { 1: 'program', 2: 'preview' } }, 0)
  assert.equal(h.check('camera_tally', { cameraNumber: 1, state: 'program' }), true)
  assert.equal(h.check('camera_tally', { cameraNumber: 2, state: 'program' }), false)
  assert.equal(h.check('camera_tally', { cameraNumber: 2, state: 'preview' }), true)
  assert.equal(h.check('active_shot_set', { set: 'wide' }), false)
  applyMessage(h.studio, { type: 'shotRecalled', cameraNumber: 1, presetNumber: 2, source: 'head', mode: 'fade', timeMs: 3000 }, 0)
  assert.equal(h.check('active_shot_set', { set: 'wide' }), true)
  assert.equal(h.check('active_shot', { cameraNumber: 1, preset: 2, source: 'head' }), true)
  assert.equal(h.check('active_shot', { cameraNumber: 1, preset: 2, source: 'plan' }), false)
  assert.equal(h.check('move_running', { move: 'any' }), false)
  applyMessage(h.studio, { type: 'moveProgress', id: 'push', cameraNumber: 2, step: 1, of: 1, state: 'playing' }, 0)
  assert.equal(h.check('move_running', { move: 'push' }), true)
})

test('presets: one button per set, seat and move; head, presets, lock and aim per camera; every action and feedback exists', () => {
  const h = withBridge()
  const p = h.presets()
  const actions = h.actions()
  const feedbacks = h.feedbacks()
  assert.ok(p.set_wide && p.seat_A1 && p.move_push)
  assert.ok(p.c1_ptz_up && p.c1_column_up && p.c2_recall_8 && p.c2_lock && p.c1_scan && p.c1_focus_near)
  for (const [id, def] of Object.entries(p)) {
    if (!def || def.type !== 'button') continue
    for (const step of def.steps) {
      for (const a of [...step.down, ...step.up]) assert.ok(actions[a.actionId], `${id}: action ${a.actionId}`)
    }
    for (const f of def.feedbacks) assert.ok(feedbacks[f.feedbackId], `${id}: feedback ${f.feedbackId}`)
  }
  // Hold-to-move buttons stop on release.
  assert.deepEqual(p.c1_ptz_up!.type === 'button' && p.c1_ptz_up!.steps[0].up, [{ actionId: 'ptz_stop', options: { cameraNumber: 1 } }])
  assert.match(String(p.c1_pose!.type === 'button' && p.c1_pose!.style.text), /\$\(lzcb:cam1_pan\)/)
})
