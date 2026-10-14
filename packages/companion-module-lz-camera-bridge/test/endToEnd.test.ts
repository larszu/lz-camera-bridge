/**
 * The module's control link against a REAL bridge (packages/bridge) with two
 * demo cameras: the buttons send what the bridge understands, and the
 * bridge's answers land in the feedbacks. No Companion involved — the actions
 * run against the stand-in module (test/harness.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BridgeServer } from '../../bridge/src/BridgeServer.js'
import { ControlLink } from '../src/link.js'
import { applyMessage } from '../src/studio.js'
import { harness } from './harness.js'

async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('control link: cameras, studio shots, soft preset, shot set and on-air lock through a real bridge', async () => {
  const port = 19731
  const bridge = new BridgeServer(port, { http: port + 100, ws: port + 200 })
  bridge.start()
  const h = harness({ controlPort: port })
  const link = new ControlLink(`ws://127.0.0.1:${port}`, 100)
  link.onMessage = (msg) => applyMessage(h.studio, msg, Date.now())
  h.deliver((type, payload) => link.send(type, payload))
  link.connect()
  try {
    await until(() => link.open, 'link open')
    // Set up two demo cameras the way the panel does (not a module job).
    for (const n of [1, 2]) {
      link.send('setCameraConfig', { cameraNumber: n, config: { connectionMode: 'demo', label: `Demo ${n}` } })
      link.send('connectCamera', { cameraNumber: n })
    }
    await until(() => h.studio.cameras?.[1]?.connected === true && h.studio.cameras?.[2]?.connected === true, 'cameras connected')
    assert.equal(h.studio.cameras![1].label, 'Demo 1')

    // Studio shots set up on the bridge appear as dropdowns.
    link.send('setStudioShots', {
      shots: {
        defaultMode: 'fade',
        defaultTimeMs: 300,
        sets: [{ id: 'two', name: 'Two shot', shots: [{ cameraNumber: 1, preset: 1 }, { cameraNumber: 2, preset: 1 }] }],
        seats: { rows: 0, cols: 0, seats: [] },
        moves: [],
      },
    })
    await until(() => h.studio.shots?.sets.length === 1, 'studio shots')
    const setChoice = h.actions().recall_shot_set.options.find((o) => o.id === 'set') as { choices: Array<{ id: string }> }
    assert.deepEqual(setChoice.choices.map((c) => c.id), ['two'])

    // Store preset 1 on both (the bridge keeps the pose), give camera 1 a move time.
    await h.run('ptz_move', { cameraNumber: 1, direction: 'right', speed: 60 })
    await new Promise((r) => setTimeout(r, 150))
    await h.run('ptz_stop', { cameraNumber: 1 })
    await h.run('preset_store', { cameraNumber: 1, preset: 1, time: 0 })
    await h.run('preset_store', { cameraNumber: 2, preset: 1, time: 0 })
    await until(() => h.studio.cameras?.[1]?.bridgePresets['1']?.pan !== undefined, 'pose stored with preset 1')
    await h.run('preset_motion', { cameraNumber: 1, preset: 1, time: 0.5, soft: 'keep' })
    await until(() => h.studio.cameras?.[1]?.bridgePresets['1']?.timeMs === 500, 'move time stored')

    // The set: both cameras recalled → the set's feedback lights.
    await h.run('recall_shot_set', { set: 'two' })
    await until(() => h.check('active_shot_set', { set: 'two' }), 'set active')
    assert.equal(h.studio.lastShot[1].mode, 'fade')

    // Defaults from a button: +0.5 s, toggle to cut.
    await h.run('studio_defaults', { timeMode: 'add', seconds: 0.5, mode: 'toggle' })
    await until(() => h.studio.shots?.defaultTimeMs === 800 && h.studio.shots.defaultMode === 'cut', 'defaults changed')

    // On-air lock toggle reaches the camera config.
    await h.run('on_air_lock', { cameraNumber: 2, mode: 'toggle' })
    await until(() => h.studio.cameras?.[2]?.tallyProtect === false, 'lock off')
    assert.equal(h.check('on_air_lock', { cameraNumber: 2 }), false)
    assert.equal(h.check('on_air_lock', { cameraNumber: 1 }), true)

    // Read pose fills the pose variables.
    await h.run('read_pose', { cameraNumber: 1 })
    await until(() => h.studio.poses[1] !== undefined, 'pose')
  } finally {
    link.destroy()
    bridge.stop()
  }
})
