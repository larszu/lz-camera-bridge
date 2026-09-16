import type { ModuleInstance } from './main.js'
import { parseCameraTargets } from './config.js'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getNumber(self: ModuleInstance, key: keyof ModuleInstance['cameraState'], fallback: number): number {
  const value = self.cameraState[key]
  return typeof value === 'number' ? value : fallback
}

function getTargetOptions(self: ModuleInstance) {
  const choices = parseCameraTargets(self.config).map((target) => ({ id: target.id, label: target.label }))
  return [
    {
      id: 'cameraNumber',
      type: 'dropdown' as const,
      label: 'Target Camera',
      default: self.config.defaultCamera,
      choices,
    },
  ]
}

function getTargetCamera(options: Record<string, unknown>, self: ModuleInstance): number {
  return Number(options.cameraNumber ?? self.config.defaultCamera)
}

function makeStepAction(
  self: ModuleInstance,
  name: string,
  command: string,
  stateKey: keyof ModuleInstance['cameraState'],
  step: number,
  min: number,
  max: number,
  fallback: number,
) {
  return {
    name,
    options: getTargetOptions(self),
    callback: async (event: { options: Record<string, unknown> }) => {
      const current = getNumber(self, stateKey, fallback)
      await self.sendCameraCommand(command, {
        value: clamp(current + step, min, max),
        cameraNumber: getTargetCamera(event.options, self),
      })
    },
  }
}

export function updateActions(self: ModuleInstance): void {
  self.setActionDefinitions({
    iris_up: makeStepAction(self, 'Iris +', 'setIris', 'iris', 5, 0, 255, 128),
    iris_down: makeStepAction(self, 'Iris -', 'setIris', 'iris', -5, 0, 255, 128),
    gain_up: makeStepAction(self, 'Gain +', 'setMasterGain', 'masterGain', 1, 0, 7, 0),
    gain_down: makeStepAction(self, 'Gain -', 'setMasterGain', 'masterGain', -1, 0, 7, 0),
    black_up: makeStepAction(self, 'Master Black +', 'setMasterBlack', 'masterBlack', 4, 0, 255, 128),
    black_down: makeStepAction(self, 'Master Black -', 'setMasterBlack', 'masterBlack', -4, 0, 255, 128),
    gamma_up: makeStepAction(self, 'Master Gamma +', 'setMasterGamma', 'masterGamma', 4, 0, 255, 128),
    gamma_down: makeStepAction(self, 'Master Gamma -', 'setMasterGamma', 'masterGamma', -4, 0, 255, 128),
    saturation_up: makeStepAction(self, 'Saturation +', 'setSaturation', 'saturation', 4, 0, 255, 128),
    saturation_down: makeStepAction(self, 'Saturation -', 'setSaturation', 'saturation', -4, 0, 255, 128),
    detail_up: makeStepAction(self, 'Detail +', 'setDetailLevel', 'detailLevel', 4, 0, 255, 128),
    detail_down: makeStepAction(self, 'Detail -', 'setDetailLevel', 'detailLevel', -4, 0, 255, 128),
    nd_up: makeStepAction(self, 'ND +', 'setNdFilter', 'ndFilter', 1, 0, 3, 0),
    nd_down: makeStepAction(self, 'ND -', 'setNdFilter', 'ndFilter', -1, 0, 3, 0),
    set_bars: {
      name: 'Bars toggle',
      options: [
        ...getTargetOptions(self),
        {
          id: 'on',
          type: 'dropdown',
          label: 'Bars',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' },
          ],
        },
      ],
      callback: async (event) => {
        const option = String(event.options.on)
        const next = option === 'toggle' ? !Boolean(self.cameraState.bars) : option === 'on'
        await self.sendCameraCommand('setBars', { on: next, cameraNumber: getTargetCamera(event.options, self) })
      },
    },
    set_camera_power: {
      name: 'Power toggle',
      options: [
        ...getTargetOptions(self),
        {
          id: 'on',
          type: 'dropdown',
          label: 'Power',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' },
          ],
        },
      ],
      callback: async (event) => {
        const option = String(event.options.on)
        const next = option === 'toggle' ? !Boolean(self.cameraState.cameraPower) : option === 'on'
        await self.sendCameraCommand('setCameraPower', { on: next, cameraNumber: getTargetCamera(event.options, self) })
      },
    },
    tally_program: {
      name: 'Set program tally',
      options: [
        {
          id: 'mode',
          type: 'dropdown',
          label: 'Mode',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' },
          ],
        },
      ],
      callback: async (event) => {
        const option = String(event.options.mode)
        // ADR-003 — „Toggle" leitet einen Befehl aus einem Zustand ab. Ist
        // der Zustand unbestaetigt, gibt es kein Gegenteil, das man bilden
        // koennte: `!undefined` waere `true` und haette die Kamera aus purer
        // Unkenntnis auf Sendung geschaltet. Der Befehl unterbleibt und sagt
        // es; „On" und „Off" an derselben Aktion bleiben jederzeit moeglich.
        if (option === 'toggle' && self.tallyState.program === undefined) {
          self.log('warn', 'tally_program: Zustand unbestaetigt — Toggle unterbleibt. On/Off waehlen.')
          return
        }
        const next = option === 'toggle' ? !self.tallyState.program : option === 'on'
        await self.sendTally({ program: next })
      },
    },
    tally_preview: {
      name: 'Set preview tally',
      options: [
        {
          id: 'mode',
          type: 'dropdown',
          label: 'Mode',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' },
          ],
        },
      ],
      callback: async (event) => {
        const option = String(event.options.mode)
        // ADR-003 — „Toggle" leitet einen Befehl aus einem Zustand ab. Ist
        // der Zustand unbestaetigt, gibt es kein Gegenteil, das man bilden
        // koennte: `!undefined` waere `true` und haette die Kamera aus purer
        // Unkenntnis auf Sendung geschaltet. Der Befehl unterbleibt und sagt
        // es; „On" und „Off" an derselben Aktion bleiben jederzeit moeglich.
        if (option === 'toggle' && self.tallyState.preview === undefined) {
          self.log('warn', 'tally_preview: Zustand unbestaetigt — Toggle unterbleibt. On/Off waehlen.')
          return
        }
        const next = option === 'toggle' ? !self.tallyState.preview : option === 'on'
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
  })
}
