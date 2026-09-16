import type { ModuleInstance } from './main.js'

export function updateVariableDefinitions(self: ModuleInstance): void {
  self.setVariableDefinitions([
    { variableId: 'bridge_connected', name: 'Bridge reachable' },
    { variableId: 'camera_connected', name: 'Camera connected' },
    { variableId: 'iris', name: 'Iris value (0-255)' },
    { variableId: 'master_black', name: 'Master black' },
    { variableId: 'master_gain', name: 'Master gain' },
    { variableId: 'master_gamma', name: 'Master gamma' },
    { variableId: 'saturation', name: 'Saturation' },
    { variableId: 'detail_level', name: 'Detail level' },
    { variableId: 'shutter_speed', name: 'Shutter speed' },
    { variableId: 'nd_filter', name: 'ND filter' },
    { variableId: 'bars', name: 'Bars enabled' },
    { variableId: 'camera_power', name: 'Camera power enabled' },
    { variableId: 'tally_program', name: 'Program tally' },
    { variableId: 'tally_preview', name: 'Preview tally' },
    { variableId: 'tally_iso_rec', name: 'ISO record tally' },
  ])
}
