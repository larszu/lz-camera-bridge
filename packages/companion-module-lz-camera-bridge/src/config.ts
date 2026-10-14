import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
  host: string
  httpPort: number
  wsPort: number
  /** The bridge's control socket — the one the panel uses (studio shots, camera list, aim). */
  controlPort: number
  pollInterval: number
  /** Read the pose of every connected camera this often (ms); 0 = only on demand. */
  posePoll: number
  cameraTargets: string
  defaultCamera: number
}

export const DEFAULT_CONFIG: ModuleConfig = {
  host: '127.0.0.1',
  httpPort: 9702,
  wsPort: 9701,
  controlPort: 9700,
  pollInterval: 1000,
  posePoll: 0,
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
        'Connects to LZ Camera Bridge. Start the bridge first. HTTP and WebSocket ports carry paint commands and tally; the control port (the panel\'s port, 9700) carries cameras, presets, studio shots, moves and panorama aim.',
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
      id: 'controlPort',
      label: 'Control Port (panel WebSocket)',
      width: 6,
      default: DEFAULT_CONFIG.controlPort,
      min: 1,
      max: 65535,
    },
    {
      type: 'number',
      id: 'posePoll',
      label: 'Pose Poll Interval (ms, 0 = off)',
      width: 6,
      default: DEFAULT_CONFIG.posePoll,
      min: 0,
      max: 60000,
      tooltip: 'Reads pan/tilt/zoom of every connected camera for the pose variables. Each read asks the head; leave at 0 if the variables are not needed.',
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
      tooltip: 'Comma-separated camera/RCP ids, for example: 1,2,3,4. Used until the bridge has sent its camera list.',
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
