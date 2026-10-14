import type { ModuleInstance } from './main.js'
import { studioVariableDefinitions } from './studio.js'

export function updateVariableDefinitions(self: ModuleInstance): void {
  self.setVariableDefinitions([
    { variableId: 'bridge_connected', name: 'Bridge reachable' },
    { variableId: 'camera_connected', name: 'Camera connected' },
    // Paint values: the default camera (config), as the bridge reported them.
    { variableId: 'iris', name: 'Iris value (0-255), default camera' },
    { variableId: 'master_black', name: 'Master black, default camera' },
    { variableId: 'master_gain', name: 'Master gain, default camera' },
    { variableId: 'master_gamma', name: 'Master gamma, default camera' },
    { variableId: 'saturation', name: 'Saturation, default camera' },
    { variableId: 'detail_level', name: 'Detail level, default camera' },
    { variableId: 'shutter_speed', name: 'Shutter speed, default camera' },
    { variableId: 'nd_filter', name: 'ND filter, default camera' },
    { variableId: 'bars', name: 'Bars enabled, default camera' },
    { variableId: 'camera_power', name: 'Camera power enabled, default camera' },
    { variableId: 'tally_program', name: 'Program tally' },
    { variableId: 'tally_preview', name: 'Preview tally' },
    { variableId: 'tally_iso_rec', name: 'ISO record tally' },
    ...studioVariableDefinitions(self.studio),
  ])
}
