/**
 * The module's picture of the bridge's control socket (src/studio.ts):
 * messages in, choices / variables / feedback answers out. Pure, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyMessage,
  cameraChoices,
  choiceSignature,
  emptyStudio,
  expireHeld,
  HELD_TTL_MS,
  isHeld,
  jobRunning,
  linkLost,
  moveRunning,
  onAirLock,
  seatChoices,
  setActive,
  studioVariableDefinitions,
  studioVariableValues,
  withDefaults,
} from '../src/studio.js'

const SHOTS = {
  defaultMode: 'fade',
  defaultTimeMs: 2500,
  sets: [{ id: 'wide', name: 'Wide', shots: [{ cameraNumber: 1, preset: 2 }, { cameraNumber: 2, preset: 5, source: 'plan' }] }],
  seats: { rows: 1, cols: 2, seats: [{ id: 'A1', row: 0, col: 1, shots: [{ cameraNumber: 1, preset: 7 }] }, { id: 'A2', label: 'Guest', row: 0, col: 0, shots: [] }] },
  moves: [{ id: 'push', name: 'Push in', cameraNumber: 2, steps: [{ preset: 1 }] }],
}

function withCameras() {
  const s = emptyStudio()
  applyMessage(s, {
    type: 'cameras',
    cameras: [
      { cameraNumber: 2, connected: false, config: { label: 'Stage', tallyProtect: false, bridgePresets: { '3': { timeMs: 4000, soft: false } } } },
      { cameraNumber: 1, connected: true, config: {}, plan: { label: 'Lectern' }, presetRecall: 'eased' },
    ],
  }, 0)
  applyMessage(s, { type: 'studioShots', shots: SHOTS }, 0)
  return s
}

test('cameras: plan label wins, unknown lock is undefined, an unset lock is on', () => {
  const s = emptyStudio()
  assert.equal(onAirLock(s, 1), undefined, 'nothing said yet')
  applyMessage(s, { type: 'cameras', cameras: [{ cameraNumber: 1, connected: true, config: {} }] }, 0)
  assert.equal(onAirLock(s, 1), true, 'no tallyProtect in the config = on (as in the bridge)')
  assert.equal(onAirLock(s, 9), undefined)
  const t = withCameras()
  assert.equal(t.cameras![1].label, 'Lectern')
  assert.equal(t.cameras![2].label, 'Stage')
  assert.equal(onAirLock(t, 2), false)
  assert.deepEqual(cameraChoices(t, []), [
    { id: 1, label: '1: Lectern' },
    { id: 2, label: '2: Stage' },
  ])
  applyMessage(t, { type: 'cameraConnected', cameraNumber: 2 }, 0)
  assert.equal(t.cameras![2].connected, true)
})

test('camera choices fall back to the configured targets until the bridge sent its list', () => {
  const fallback = [{ id: 1, label: 'Camera 1' }]
  assert.deepEqual(cameraChoices(emptyStudio(), fallback), fallback)
})

test('a set is active only when every camera of it was last recalled to its shot', () => {
  const s = withCameras()
  assert.equal(setActive(s, 'wide'), false)
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 1, presetNumber: 2, source: 'head', mode: 'fade', timeMs: 2500 }, 1)
  assert.equal(setActive(s, 'wide'), false, 'camera 2 still missing')
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 2, presetNumber: 5, source: 'head', mode: 'cut', timeMs: 0 }, 2)
  assert.equal(setActive(s, 'wide'), false, 'head preset 5 is not planned shot 5')
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 2, presetNumber: 5, source: 'plan', mode: 'cut', timeMs: 0 }, 3)
  assert.equal(setActive(s, 'wide'), true)
  assert.equal(studioVariableValues(s).active_set, 'Wide')
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 1, presetNumber: 3, source: 'head', mode: 'cut', timeMs: 0 }, 4)
  assert.equal(setActive(s, 'wide'), false, 'one camera moved away')
})

test('held recall: kept with force, cleared camera by camera when they move, expires', () => {
  const s = withCameras()
  const ch = applyMessage(s, { type: 'shotHeld', cameras: [1, 2], label: 'Wide', retry: { type: 'recallShotSet', id: 'wide', cameras: [1, 2] } }, 1000)
  assert.deepEqual(ch, ['held'])
  assert.equal(s.held!.retry.force, true)
  assert.equal(isHeld(s), true)
  assert.equal(isHeld(s, 1), true)
  assert.equal(isHeld(s, 3), false)
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 1, presetNumber: 2, source: 'head', mode: 'fade', timeMs: 1 }, 1100)
  assert.deepEqual(s.held!.cameras, [2])
  assert.equal(expireHeld(s, 1000 + HELD_TTL_MS), false)
  assert.equal(expireHeld(s, 1000 + HELD_TTL_MS + 1), true)
  assert.equal(s.held, null)
  assert.deepEqual(applyMessage(s, { type: 'shotHeld', cameras: [], retry: {} }, 0), [], 'nothing to retry, nothing held')
})

test('moves and head jobs: running until done / stopped / failed / cancelled', () => {
  const s = withCameras()
  applyMessage(s, { type: 'moveProgress', id: 'push', cameraNumber: 2, step: 1, of: 1, state: 'playing' }, 0)
  assert.equal(moveRunning(s), true)
  assert.equal(moveRunning(s, 'push'), true)
  assert.equal(moveRunning(s, 'other'), false)
  assert.equal(studioVariableValues(s).move_running, 'Push in 1/1')
  applyMessage(s, { type: 'moveProgress', id: 'push', cameraNumber: 2, step: 1, of: 1, state: 'done' }, 0)
  assert.equal(moveRunning(s), false)

  applyMessage(s, { type: 'panoramaProgress', cameraNumber: 1, step: 'picture', index: 3, total: 12 }, 0)
  assert.equal(jobRunning(s, 1), true)
  assert.equal(studioVariableValues(s).cam1_job, 'panorama picture 3/12')
  applyMessage(s, { type: 'panoramaProgress', cameraNumber: 1, step: 'cancelled' }, 0)
  assert.equal(jobRunning(s, 1), false)
  applyMessage(s, { type: 'fovProgress', cameraNumber: 1, step: 'starting', total: 4 }, 0)
  assert.equal(jobRunning(s, 1), true)
})

test('variables: per camera, unknown is said as unknown, pose from pose and aim', () => {
  const s = withCameras()
  const defs = studioVariableDefinitions(s).map((d) => d.variableId)
  assert.ok(defs.includes('cam1_shot') && defs.includes('cam2_pan') && defs.includes('default_move_time'))
  let v = studioVariableValues(s)
  assert.equal(v.cam1_tally, 'unknown', 'no mixer tally yet')
  assert.equal(v.cam1_on_air_lock, 'on')
  assert.equal(v.cam2_on_air_lock, 'off')
  assert.equal(v.default_move_time, '2.5')
  assert.equal(v.default_mode, 'fade')
  applyMessage(s, { type: 'cameraTally', tally: { 1: 'program', 2: 'bogus' } }, 0)
  applyMessage(s, { type: 'pose', cameraNumber: 1, pose: { pan: 12.345, tilt: -3, zoom: 0.25 } }, 0)
  applyMessage(s, { type: 'aim', cameraNumber: 2, pose: { pan: 1, tilt: 2 } }, 0)
  applyMessage(s, { type: 'shotRecalled', cameraNumber: 1, presetNumber: 4, source: 'plan', mode: 'fade', timeMs: 3200 }, 0)
  v = studioVariableValues(s)
  assert.equal(v.cam1_tally, 'program')
  assert.equal(v.cam2_tally, 'unknown')
  assert.equal(v.cam1_pan, '12.35')
  assert.equal(v.cam1_zoom, '0.250')
  assert.equal(v.cam2_tilt, '2.00')
  assert.equal(v.cam2_zoom, '')
  assert.equal(v.cam1_shot, 'P4')
  assert.equal(v.cam1_move_time, '3.2')
})

test('link lost: everything it said is forgotten (ADR-003)', () => {
  const s = withCameras()
  s.linkConnected = true
  applyMessage(s, { type: 'cameraTally', tally: { 1: 'off' } }, 0)
  linkLost(s)
  assert.equal(s.cameras, null)
  assert.equal(s.shots, null)
  assert.deepEqual(s.cameraTally, {})
  assert.equal(s.linkConnected, false)
  assert.equal(onAirLock(s, 1), undefined)
})

test('choice signature changes with the lists, seats get a readable label', () => {
  const s = withCameras()
  const a = choiceSignature(s, [])
  assert.deepEqual(seatChoices(s), [
    { id: 'A1', label: 'Row 1, seat 2' },
    { id: 'A2', label: 'Guest' },
  ])
  applyMessage(s, { type: 'studioShots', shots: { ...SHOTS, sets: [] } }, 0)
  assert.notEqual(choiceSignature(s, []), a)
})

test('defaults: move time clamped to the bridge limits, the rest kept', () => {
  const s = withCameras()
  const next = withDefaults(s.shots!, { timeMs: 100, mode: 'cut' })
  assert.equal(next.defaultTimeMs, 300)
  assert.equal(next.defaultMode, 'cut')
  assert.equal(next.sets.length, 1)
  assert.equal(withDefaults(s.shots!, { timeMs: 1e9 }).defaultTimeMs, 60000)
})
