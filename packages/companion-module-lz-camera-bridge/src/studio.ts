/**
 * What the module knows from the bridge's control socket (port 9700, the
 * same socket the panel uses): the camera list, the studio shots, the
 * mixer-derived tally per camera, the last recalled shot, a recall held by
 * the on-air lock, running moves, poses and head jobs.
 *
 * Pure: no network, no clock (the time comes in as an argument). `main.ts`
 * feeds it messages and asks it for choices, variables and feedback answers.
 *
 * ADR-003 holds here too: what the bridge has not said is `undefined`, never
 * a guessed default. An unknown on-air lock is not "off", an unknown tally
 * is not "off".
 */

export type RecallMode = 'cut' | 'fade';
export type ShotSource = 'head' | 'plan';
export type CameraTally = 'program' | 'preview' | 'off';

export interface ShotRef {
  cameraNumber: number;
  preset: number;
  source?: ShotSource;
}

export interface StudioShots {
  defaultMode: RecallMode;
  defaultTimeMs: number;
  sets: Array<{ id: string; name: string; shots: ShotRef[]; mode?: RecallMode; timeMs?: number }>;
  seats: { rows: number; cols: number; seats: Array<{ id: string; label?: string; row: number; col: number; shots: ShotRef[] }> };
  moves: Array<{ id: string; name: string; cameraNumber: number; steps: Array<{ preset: number; source?: ShotSource; timeMs?: number; holdMs?: number }> }>;
}

export interface PresetMotion {
  timeMs?: number;
  soft?: boolean;
  pan?: number;
  tilt?: number;
  zoom?: number;
}

export interface CameraInfo {
  cameraNumber: number;
  label: string;
  connected: boolean;
  /** `undefined` in the bridge config means ON — see `onAirLockOn`. */
  tallyProtect?: boolean;
  /** 'eased' or 'camera', as the bridge reports it. */
  presetRecall?: string;
  bridgePresets: Record<string, PresetMotion>;
}

export interface Pose {
  pan: number;
  tilt: number;
  zoom?: number;
}

export interface ShotRecalled {
  preset: number;
  source: ShotSource;
  mode: RecallMode;
  timeMs: number;
  note?: string;
  at: number;
}

export interface HeldRecall {
  cameras: number[];
  label: string;
  /** The message that, sent again, moves the cameras anyway (`force: true` included). */
  retry: Record<string, unknown>;
  at: number;
}

export interface MoveRun {
  id: string;
  cameraNumber: number;
  step: number;
  of: number;
  state: 'playing' | 'done' | 'stopped';
}

export interface HeadJob {
  kind: 'panorama' | 'fov';
  step: string;
  index?: number;
  total?: number;
  message?: string;
}

export interface SwitcherInfo {
  switcherNumber: number;
  label: string;
  connected: boolean;
  inputLabels: string[];
}

export interface StudioState {
  linkConnected: boolean;
  /** `null` until the bridge sent its camera list. */
  cameras: Record<number, CameraInfo> | null;
  switchers: SwitcherInfo[];
  /** `null` until the bridge sent its studio shots. */
  shots: StudioShots | null;
  cameraTally: Record<number, CameraTally>;
  lastShot: Record<number, ShotRecalled>;
  held: HeldRecall | null;
  moves: Record<string, MoveRun>;
  poses: Record<number, Pose>;
  jobs: Record<number, HeadJob>;
  lastError?: string;
}

export type Change = 'link' | 'cameras' | 'switchers' | 'shots' | 'tally' | 'shot' | 'held' | 'move' | 'pose' | 'job' | 'error';

/** How long a held recall offers "move anyway" before it is stale. */
export const HELD_TTL_MS = 30_000;

export function emptyStudio(): StudioState {
  return {
    linkConnected: false,
    cameras: null,
    switchers: [],
    shots: null,
    cameraTally: {},
    lastShot: {},
    held: null,
    moves: {},
    poses: {},
    jobs: {},
  };
}

const JOB_ENDS = new Set(['done', 'failed', 'cancelled']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function toPose(raw: unknown): Pose | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pan = num(o.pan);
  const tilt = num(o.tilt);
  if (pan === undefined || tilt === undefined) return null;
  const zoom = num(o.zoom);
  return { pan, tilt, ...(zoom !== undefined ? { zoom } : {}) };
}

function toCamera(raw: unknown): CameraInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const cameraNumber = num(o.cameraNumber);
  if (cameraNumber === undefined) return null;
  const config = (o.config && typeof o.config === 'object' ? o.config : {}) as Record<string, unknown>;
  const plan = (o.plan && typeof o.plan === 'object' ? o.plan : {}) as Record<string, unknown>;
  const presets = (config.bridgePresets && typeof config.bridgePresets === 'object' ? config.bridgePresets : {}) as Record<string, PresetMotion>;
  return {
    cameraNumber,
    label: str(plan.label) ?? str(config.label) ?? `Camera ${cameraNumber}`,
    connected: o.connected === true,
    ...(typeof config.tallyProtect === 'boolean' ? { tallyProtect: config.tallyProtect } : {}),
    ...(typeof o.presetRecall === 'string' ? { presetRecall: o.presetRecall } : {}),
    bridgePresets: { ...presets },
  };
}

/**
 * One message from the control socket into the state. Returns what changed,
 * so the caller only re-checks the feedbacks that can have moved.
 */
export function applyMessage(s: StudioState, msg: Record<string, unknown>, now: number): Change[] {
  const cam = num(msg.cameraNumber);
  switch (msg.type) {
    case 'cameras': {
      const list = Array.isArray(msg.cameras) ? msg.cameras : [];
      const next: Record<number, CameraInfo> = {};
      for (const c of list.map(toCamera)) if (c) next[c.cameraNumber] = c;
      s.cameras = next;
      return ['cameras'];
    }
    case 'cameraConnected':
    case 'cameraDisconnected': {
      if (cam === undefined || !s.cameras?.[cam]) return [];
      s.cameras[cam].connected = msg.type === 'cameraConnected';
      return ['cameras'];
    }
    case 'switchers': {
      const list = Array.isArray(msg.switchers) ? msg.switchers : [];
      s.switchers = list
        .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === 'object' && num((w as Record<string, unknown>).switcherNumber) !== undefined)
        .map((w) => {
          const config = (w.config && typeof w.config === 'object' ? w.config : {}) as Record<string, unknown>;
          const n = w.switcherNumber as number;
          return {
            switcherNumber: n,
            label: str(config.label) ?? `Switcher ${n}`,
            connected: w.connected === true,
            inputLabels: Array.isArray(w.inputLabels) ? w.inputLabels.map((l) => String(l ?? '')) : [],
          };
        });
      return ['switchers'];
    }
    case 'studioShots': {
      const shots = (msg.shots && typeof msg.shots === 'object' ? msg.shots : {}) as Partial<StudioShots>;
      s.shots = {
        defaultMode: shots.defaultMode === 'cut' ? 'cut' : 'fade',
        defaultTimeMs: num(shots.defaultTimeMs) ?? 3000,
        sets: Array.isArray(shots.sets) ? shots.sets : [],
        seats: shots.seats && Array.isArray(shots.seats.seats) ? shots.seats : { rows: 0, cols: 0, seats: [] },
        moves: Array.isArray(shots.moves) ? shots.moves : [],
      };
      return ['shots'];
    }
    case 'cameraTally': {
      const t = (msg.tally && typeof msg.tally === 'object' ? msg.tally : {}) as Record<string, unknown>;
      const next: Record<number, CameraTally> = {};
      for (const [k, v] of Object.entries(t)) {
        if (v === 'program' || v === 'preview' || v === 'off') next[Number(k)] = v;
      }
      s.cameraTally = next;
      return ['tally'];
    }
    case 'shotRecalled': {
      if (cam === undefined) return [];
      const preset = num(msg.presetNumber);
      if (preset === undefined) return [];
      s.lastShot[cam] = {
        preset,
        source: msg.source === 'plan' ? 'plan' : 'head',
        mode: msg.mode === 'cut' ? 'cut' : 'fade',
        timeMs: num(msg.timeMs) ?? 0,
        ...(str(msg.note) ? { note: str(msg.note) } : {}),
        at: now,
      };
      const changes: Change[] = ['shot'];
      if (s.held?.cameras.includes(cam)) {
        const rest = s.held.cameras.filter((c) => c !== cam);
        s.held = rest.length ? { ...s.held, cameras: rest } : null;
        changes.push('held');
      }
      return changes;
    }
    case 'shotHeld': {
      const cameras = Array.isArray(msg.cameras) ? msg.cameras.map(Number).filter(Number.isFinite) : [];
      const retry = msg.retry && typeof msg.retry === 'object' ? (msg.retry as Record<string, unknown>) : null;
      if (!cameras.length || !retry) return [];
      s.held = { cameras, label: String(msg.label ?? ''), retry: { ...retry, force: true }, at: now };
      return ['held'];
    }
    case 'moveProgress': {
      const id = str(msg.id);
      if (!id || cam === undefined) return [];
      const state = msg.state === 'playing' || msg.state === 'done' ? msg.state : 'stopped';
      s.moves[id] = { id, cameraNumber: cam, step: num(msg.step) ?? 0, of: num(msg.of) ?? 0, state };
      return ['move'];
    }
    case 'pose':
    case 'aim': {
      const pose = toPose(msg.pose);
      if (cam === undefined || !pose) return [];
      s.poses[cam] = pose;
      return ['pose'];
    }
    case 'panoramaProgress':
    case 'fovProgress': {
      if (cam === undefined) return [];
      const step = String(msg.step ?? '');
      s.jobs[cam] = {
        kind: msg.type === 'fovProgress' ? 'fov' : 'panorama',
        step,
        ...(num(msg.index) !== undefined ? { index: num(msg.index) } : {}),
        ...(num(msg.total) !== undefined ? { total: num(msg.total) } : {}),
        ...(str(msg.message) ? { message: str(msg.message) } : {}),
      };
      return ['job'];
    }
    case 'error': {
      const m = str(msg.message);
      if (!m) return [];
      s.lastError = cam !== undefined ? `Camera ${cam}: ${m}` : m;
      return ['error'];
    }
    default:
      return [];
  }
}

/** The link dropped: everything it said is no longer known. */
export function linkLost(s: StudioState): void {
  const fresh = emptyStudio();
  Object.assign(s, fresh);
}

/** Drops a held recall that is older than `HELD_TTL_MS`. True when it did. */
export function expireHeld(s: StudioState, now: number): boolean {
  if (s.held && now - s.held.at > HELD_TTL_MS) {
    s.held = null;
    return true;
  }
  return false;
}

// ── Questions the feedbacks and actions ask ─────────────────────────────────

/** Same rule as the bridge: only an explicit `false` switches the lock off. Unknown camera → undefined. */
export function onAirLock(s: StudioState, cameraNumber: number): boolean | undefined {
  const c = s.cameras?.[cameraNumber];
  if (!c) return undefined;
  return c.tallyProtect !== false;
}

export function isHeld(s: StudioState, cameraNumber?: number): boolean {
  if (!s.held) return false;
  return cameraNumber === undefined ? true : s.held.cameras.includes(cameraNumber);
}

export function moveRunning(s: StudioState, id?: string, cameraNumber?: number): boolean {
  return Object.values(s.moves).some(
    (m) => m.state === 'playing' && (id === undefined || m.id === id) && (cameraNumber === undefined || m.cameraNumber === cameraNumber),
  );
}

export function jobRunning(s: StudioState, cameraNumber: number): boolean {
  const j = s.jobs[cameraNumber];
  return Boolean(j && !JOB_ENDS.has(j.step));
}

const sameShot = (a: ShotRecalled | undefined, ref: ShotRef) =>
  Boolean(a && a.preset === ref.preset && a.source === (ref.source ?? 'head'));

/** The camera's last recalled shot is this one. */
export function shotActive(s: StudioState, ref: ShotRef): boolean {
  return sameShot(s.lastShot[ref.cameraNumber], ref);
}

/** Every camera of the set stands on its shot of the set (as far as the bridge reported recalls). */
export function setActive(s: StudioState, id: string): boolean {
  const set = s.shots?.sets.find((x) => x.id === id);
  if (!set || set.shots.length === 0) return false;
  return set.shots.every((ref) => shotActive(s, ref));
}

export function activeSetNames(s: StudioState): string[] {
  return (s.shots?.sets ?? []).filter((x) => setActive(s, x.id)).map((x) => x.name);
}

// ── Dropdown choices ────────────────────────────────────────────────────────

export interface Choice {
  id: string | number;
  label: string;
}

/** Bridge cameras when known, otherwise the configured targets. */
export function cameraChoices(s: StudioState, fallback: Choice[]): Choice[] {
  const list = s.cameras ? Object.values(s.cameras) : [];
  if (!list.length) return fallback;
  return list
    .sort((a, b) => a.cameraNumber - b.cameraNumber)
    .map((c) => ({ id: c.cameraNumber, label: c.label === `Camera ${c.cameraNumber}` ? c.label : `${c.cameraNumber}: ${c.label}` }));
}

export function setChoices(s: StudioState): Choice[] {
  return (s.shots?.sets ?? []).map((x) => ({ id: x.id, label: x.name }));
}

export function seatLabel(seat: { label?: string; row: number; col: number }): string {
  return seat.label ?? `Row ${seat.row + 1}, seat ${seat.col + 1}`;
}

export function seatChoices(s: StudioState): Choice[] {
  return (s.shots?.seats.seats ?? []).map((x) => ({ id: x.id, label: seatLabel(x) }));
}

export function moveChoices(s: StudioState): Choice[] {
  return (s.shots?.moves ?? []).map((x) => ({ id: x.id, label: `${x.name} (camera ${x.cameraNumber})` }));
}

export function switcherChoices(s: StudioState): Choice[] {
  return s.switchers.length ? s.switchers.map((w) => ({ id: w.switcherNumber, label: w.label })) : [{ id: 1, label: 'Switcher 1' }];
}

/** A key that changes whenever any dropdown would change — re-define actions only then. */
export function choiceSignature(s: StudioState, fallback: Choice[]): string {
  return JSON.stringify([cameraChoices(s, fallback), setChoices(s), seatChoices(s), moveChoices(s), switcherChoices(s)]);
}

// ── Variables ───────────────────────────────────────────────────────────────

const seconds = (ms: number | undefined) => (ms === undefined ? '' : (ms / 1000).toFixed(1));
const deg = (v: number | undefined) => (v === undefined ? '' : v.toFixed(2));

export function cameraNumbers(s: StudioState): number[] {
  return s.cameras ? Object.keys(s.cameras).map(Number).sort((a, b) => a - b) : [];
}

export function studioVariableDefinitions(s: StudioState): Array<{ variableId: string; name: string }> {
  const out = [
    { variableId: 'control_connected', name: 'Bridge control link connected' },
    { variableId: 'default_move_time', name: 'Default move time (s)' },
    { variableId: 'default_mode', name: 'Default recall mode (cut/fade)' },
    { variableId: 'held_label', name: 'Recall held by the on-air lock (label)' },
    { variableId: 'held_cameras', name: 'Cameras of the held recall' },
    { variableId: 'active_set', name: 'Active shot set(s)' },
    { variableId: 'move_running', name: 'Running move(s)' },
    { variableId: 'last_error', name: 'Last bridge message' },
  ];
  for (const n of cameraNumbers(s)) {
    out.push(
      { variableId: `cam${n}_label`, name: `Camera ${n}: label` },
      { variableId: `cam${n}_connected`, name: `Camera ${n}: connected` },
      { variableId: `cam${n}_tally`, name: `Camera ${n}: mixer tally (program/preview/off)` },
      { variableId: `cam${n}_on_air_lock`, name: `Camera ${n}: on-air lock` },
      { variableId: `cam${n}_shot`, name: `Camera ${n}: current shot` },
      { variableId: `cam${n}_shot_mode`, name: `Camera ${n}: recall mode of the current shot` },
      { variableId: `cam${n}_move_time`, name: `Camera ${n}: move time of the current shot (s)` },
      { variableId: `cam${n}_pan`, name: `Camera ${n}: pan (deg)` },
      { variableId: `cam${n}_tilt`, name: `Camera ${n}: tilt (deg)` },
      { variableId: `cam${n}_zoom`, name: `Camera ${n}: zoom (0-1)` },
      { variableId: `cam${n}_job`, name: `Camera ${n}: panorama / FOV job` },
    );
  }
  return out;
}

export function studioVariableValues(s: StudioState): Record<string, string> {
  const running = Object.values(s.moves).filter((m) => m.state === 'playing');
  const moveName = (id: string) => s.shots?.moves.find((m) => m.id === id)?.name ?? id;
  const out: Record<string, string> = {
    control_connected: s.linkConnected ? 'true' : 'false',
    default_move_time: s.shots ? seconds(s.shots.defaultTimeMs) : '',
    default_mode: s.shots?.defaultMode ?? '',
    held_label: s.held?.label ?? '',
    held_cameras: s.held ? s.held.cameras.join(',') : '',
    active_set: activeSetNames(s).join(', '),
    move_running: running.map((m) => `${moveName(m.id)} ${m.step}/${m.of}`).join(', '),
    last_error: s.lastError ?? '',
  };
  for (const n of cameraNumbers(s)) {
    const c = s.cameras![n];
    const shot = s.lastShot[n];
    const pose = s.poses[n];
    const job = s.jobs[n];
    const lock = onAirLock(s, n);
    out[`cam${n}_label`] = c.label;
    out[`cam${n}_connected`] = c.connected ? 'true' : 'false';
    out[`cam${n}_tally`] = s.cameraTally[n] ?? 'unknown';
    out[`cam${n}_on_air_lock`] = lock === undefined ? 'unknown' : lock ? 'on' : 'off';
    out[`cam${n}_shot`] = shot ? `${shot.source === 'plan' ? 'P' : ''}${shot.preset}` : '';
    out[`cam${n}_shot_mode`] = shot?.mode ?? '';
    out[`cam${n}_move_time`] = shot ? seconds(shot.timeMs) : '';
    out[`cam${n}_pan`] = deg(pose?.pan);
    out[`cam${n}_tilt`] = deg(pose?.tilt);
    out[`cam${n}_zoom`] = pose?.zoom === undefined ? '' : pose.zoom.toFixed(3);
    out[`cam${n}_job`] = job ? `${job.kind} ${job.step}${job.total ? ` ${job.index ?? 0}/${job.total}` : ''}` : '';
  }
  return out;
}

/** Studio shots with new defaults — the whole object goes back, the bridge keeps it in the site. */
export function withDefaults(shots: StudioShots, change: { mode?: RecallMode; timeMs?: number }): StudioShots {
  return {
    ...shots,
    ...(change.mode ? { defaultMode: change.mode } : {}),
    ...(change.timeMs !== undefined ? { defaultTimeMs: clampMoveTime(change.timeMs) } : {}),
  };
}

/** The bridge's limits for a move time (motion/PresetGlide.ts): 0.3 s .. 60 s. */
export const MOVE_TIME_MIN_MS = 300;
export const MOVE_TIME_MAX_MS = 60_000;

export function clampMoveTime(ms: number): number {
  return Math.round(Math.min(MOVE_TIME_MAX_MS, Math.max(MOVE_TIME_MIN_MS, ms)));
}
