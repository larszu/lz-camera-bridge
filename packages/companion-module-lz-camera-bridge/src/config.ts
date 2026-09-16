import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
  host: string
  httpPort: number
  wsPort: number
  pollInterval: number
  cameraTargets: string
  defaultCamera: number
}

export const DEFAULT_CONFIG: ModuleConfig = {
  host: '127.0.0.1',
  httpPort: 9702,
  wsPort: 9701,
  pollInterval: 1000,
  cameraTargets: '1,2,3,4',
  defaultCamera: 1,
}

export interface CameraTargetChoice {
  id: number
  label: string
}

export function parseCameraTargets(config: ModuleConfig): CameraTargetChoice[] {
  const rawTargets = String(config.cameraTargets || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value, index, all) => Number.isInteger(value) && value >= 0 && all.indexOf(value) === index)

  const targets = rawTargets.length > 0 ? rawTargets : [config.defaultCamera || 1]
  return targets.map((target) => ({
    id: target,
    label: `Camera ${target}`,
  }))
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: 'static-text',
      id: 'info',
      width: 12,
      label: 'Information',
      value:
        'Connects to the local Sony/Blackmagic bridge. Start the bridge first, then add actions/feedbacks in Companion.',
    },
    {
      type: 'textinput',
      id: 'host',
      label: 'Bridge Host',
      width: 6,
      default: DEFAULT_CONFIG.host,
      useVariables: true,
      regex: Regex.SOMETHING,
    },
    {
      type: 'number',
      id: 'httpPort',
      label: 'HTTP Port',
      width: 3,
      default: DEFAULT_CONFIG.httpPort,
      min: 1,
      max: 65535,
    },
    {
      type: 'number',
      id: 'wsPort',
      label: 'WebSocket Port',
      width: 3,
      default: DEFAULT_CONFIG.wsPort,
      min: 1,
      max: 65535,
    },
    {
      type: 'number',
      id: 'pollInterval',
      label: 'HTTP Poll Interval (ms)',
      width: 6,
      default: DEFAULT_CONFIG.pollInterval,
      min: 250,
      max: 10000,
    },
    {
      type: 'textinput',
      id: 'cameraTargets',
      label: 'Camera Targets',
      width: 6,
      default: DEFAULT_CONFIG.cameraTargets,
      tooltip: 'Comma-separated camera/RCP ids, for example: 1,2,3,4',
      useVariables: true,
      regex: Regex.SOMETHING,
    },
    {
      type: 'number',
      id: 'defaultCamera',
      label: 'Default Camera',
      width: 6,
      default: DEFAULT_CONFIG.defaultCamera,
      min: 0,
      max: 255,
    },
  ]
}
