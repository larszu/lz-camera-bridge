/**
 * Studio shots — what a robotic-camera desk does with stored shots, for every
 * camera on the bridge.
 *
 * 1. RECALL MODES. `cut` sends the camera to the shot as fast as it goes (the
 *    camera's own preset recall, or an absolute move at full speed). `fade`
 *    is a timed move: every axis starts and lands on the same eased time line
 *    (the preset glide, motion/PresetGlide.ts), so pan, tilt and zoom arrive
 *    together.
 * 2. SHOT SETS. One button, several cameras, one common move time.
 * 3. ON-AIR LOCK. A camera whose picture is on programme does not move on a
 *    recall unless the operator says so (`force`). On by default, per camera.
 * 4. SEAT SHOTS. A seating chart; each seat names shots on one or more
 *    cameras, best first. A click picks the first camera that is connected
 *    and NOT on air; only if every candidate is on air is the recall held
 *    back for a "move anyway". The chart is a rows × seats grid by default;
 *    with `layout: 'free'` the seats sit anywhere on a simple room plan
 *    (x/y in percent). The grid stays the quick way to fill a room.
 * 5. MOVES. A sequence of shots on one camera, each with its own move time
 *    and an optional hold — a keyframe move built from eased shots.
 *
 * Shots are references, not poses: a `head` shot is the camera's own preset
 * memory (number), a `plan` shot is a planned shot of the camera's plan
 * (protocol/ptzPose.ts turns it into a pose). Nothing here stores a second
 * copy of either.
 *
 * Pure functions: no network, no clock.
 */
import { GLIDE_TIME_MAX_MS, GLIDE_TIME_MIN_MS } from './PresetGlide.js';

export type RecallMode = 'cut' | 'fade';
export type ShotSource = 'head' | 'plan';

export interface ShotRef {
  cameraNumber: number;
  /** Preset number in the head, or the planned shot's number. */
  preset: number;
  /** Default `head`. */
  source?: ShotSource;
}

export interface ShotSet {
  id: string;
  name: string;
  shots: ShotRef[];
  /** Falls back to the defaults of `StudioShots`. */
  mode?: RecallMode;
  timeMs?: number;
}

export interface Seat {
  id: string;
  label?: string;
  /** Grid cell. A seat placed only on the room plan has none. */
  row?: number;
  col?: number;
  /** Position on the room plan, percent of its width / depth (0 = stage edge). */
  x?: number;
  y?: number;
  /** Candidates, best first. */
  shots: ShotRef[];
}

export type SeatLayout = 'grid' | 'free';

export interface SeatChart {
  rows: number;
  cols: number;
  /** Default `grid`. */
  layout?: SeatLayout;
  seats: Seat[];
}

export interface MoveStep {
  preset: number;
  source?: ShotSource;
  /** Move time to this step (ms). */
  timeMs?: number;
  /** Stand still on this step before the next one (ms). */
  holdMs?: number;
}

export interface ShotMove {
  id: string;
  name: string;
  cameraNumber: number;
  steps: MoveStep[];
}

export interface StudioShots {
  defaultMode: RecallMode;
  defaultTimeMs: number;
  sets: ShotSet[];
  seats: SeatChart;
  moves: ShotMove[];
}

export const MIN_TIME_MS = GLIDE_TIME_MIN_MS;
export const MAX_TIME_MS = GLIDE_TIME_MAX_MS;
export const DEFAULT_TIME_MS = 3000;
const MAX_ROWS = 40;
const MAX_COLS = 60;

export function emptyStudioShots(): StudioShots {
  return { defaultMode: 'fade', defaultTimeMs: DEFAULT_TIME_MS, sets: [], seats: { rows: 0, cols: 0, seats: [] }, moves: [] };
}

export function clampTime(ms: unknown, fallback = DEFAULT_TIME_MS): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(MAX_TIME_MS, Math.max(MIN_TIME_MS, n)));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const int = (v: unknown): number | undefined => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
const mode = (v: unknown): RecallMode | undefined => (v === 'cut' || v === 'fade' ? v : undefined);
const source = (v: unknown): ShotSource | undefined => (v === 'plan' || v === 'head' ? v : undefined);
/** 0…100, one decimal; anything else is "not placed". */
const percent = (v: unknown): number | undefined => {
  if (v === null || v === '' || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n)) * 10) / 10 : undefined;
};

export function normaliseShotRef(raw: unknown): ShotRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const cameraNumber = int(o.cameraNumber);
  const preset = int(o.preset);
  if (cameraNumber === undefined || cameraNumber < 1 || preset === undefined || preset < 0) return null;
  const s = source(o.source);
  return { cameraNumber, preset, ...(s && s !== 'head' ? { source: s } : {}) };
}

/**
 * Whatever came in (a client, an old site file) → a valid `StudioShots`.
 * Broken entries are dropped, not repaired into something nobody stored.
 */
export function normaliseStudioShots(raw: unknown): StudioShots {
  const out = emptyStudioShots();
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  out.defaultMode = mode(o.defaultMode) ?? out.defaultMode;
  out.defaultTimeMs = clampTime(o.defaultTimeMs, out.defaultTimeMs);
  const refs = (v: unknown) => (Array.isArray(v) ? v.map(normaliseShotRef).filter((r): r is ShotRef => r !== null) : []);
  const ids = new Set<string>();
  const freshId = (v: unknown, prefix: string) => {
    let id = str(v) ?? `${prefix}${ids.size + 1}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);
    return id;
  };

  for (const s of Array.isArray(o.sets) ? o.sets : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const m = mode(r.mode);
    out.sets.push({
      id: freshId(r.id, 'set'),
      name: str(r.name) ?? 'Shot set',
      shots: refs(r.shots),
      ...(m ? { mode: m } : {}),
      ...(r.timeMs !== undefined && r.timeMs !== null && r.timeMs !== '' ? { timeMs: clampTime(r.timeMs) } : {}),
    });
  }

  const chart = (o.seats && typeof o.seats === 'object' ? o.seats : {}) as Record<string, unknown>;
  const rows = Math.min(MAX_ROWS, Math.max(0, int(chart.rows) ?? 0));
  const cols = Math.min(MAX_COLS, Math.max(0, int(chart.cols) ?? 0));
  out.seats = { rows, cols, seats: [] };
  if (chart.layout === 'free') out.seats.layout = 'free';
  const taken = new Set<string>();
  for (const s of Array.isArray(chart.seats) ? chart.seats : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const row = int(r.row);
    const col = int(r.col);
    const x = percent(r.x);
    const y = percent(r.y);
    const placed = x !== undefined && y !== undefined;
    const key = `${row}:${col}`;
    const inGrid = row !== undefined && col !== undefined && row >= 0 && col >= 0 && row < rows && col < cols && !taken.has(key);
    // A seat needs somewhere to be: a free grid cell, or a spot on the room plan.
    if (!inGrid && !placed) continue;
    if (inGrid) taken.add(key);
    const label = str(r.label);
    out.seats.seats.push({
      id: freshId(r.id, 'seat'),
      ...(inGrid ? { row, col } : {}),
      ...(placed ? { x, y } : {}),
      shots: refs(r.shots),
      ...(label ? { label } : {}),
    });
  }

  for (const m of Array.isArray(o.moves) ? o.moves : []) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const cameraNumber = int(r.cameraNumber);
    if (cameraNumber === undefined || cameraNumber < 1) continue;
    const steps: MoveStep[] = [];
    for (const st of Array.isArray(r.steps) ? r.steps : []) {
      if (!st || typeof st !== 'object') continue;
      const q = st as Record<string, unknown>;
      const preset = int(q.preset);
      if (preset === undefined || preset < 0) continue;
      const src = source(q.source);
      const hold = Number(q.holdMs);
      steps.push({
        preset,
        ...(src && src !== 'head' ? { source: src } : {}),
        ...(q.timeMs !== undefined && q.timeMs !== null && q.timeMs !== '' ? { timeMs: clampTime(q.timeMs) } : {}),
        ...(Number.isFinite(hold) && hold > 0 ? { holdMs: Math.round(Math.min(MAX_TIME_MS, hold)) } : {}),
      });
    }
    out.moves.push({ id: freshId(r.id, 'move'), name: str(r.name) ?? 'Move', cameraNumber, steps });
  }
  return out;
}

// ── On-air lock ──────────────────────────────────────────────────────────────

/** Per camera, default on: only an explicit `false` switches the lock off. */
export function onAirLockOn(config: { tallyProtect?: boolean } | undefined): boolean {
  return config?.tallyProtect !== false;
}

/** Whether a recall on this camera has to wait for "move anyway". */
export function heldByOnAir(onAir: boolean, config: { tallyProtect?: boolean } | undefined, force?: boolean): boolean {
  return onAir && onAirLockOn(config) && !force;
}

// ── Seat shots ───────────────────────────────────────────────────────────────

/** What a seat is called when nobody named it. */
export function seatLabel(seat: Pick<Seat, 'id' | 'label' | 'row' | 'col'>): string {
  if (seat.label) return seat.label;
  if (seat.row !== undefined && seat.col !== undefined) return `Row ${seat.row + 1}, seat ${seat.col + 1}`;
  return `Seat ${seat.id}`;
}

/** Room plan depth kept free for the stage when a grid is placed on it (%). */
const GRID_TOP = 12;

/**
 * Where a seat sits on the room plan (percent): its own spot, else the
 * centre of its grid cell, with the grid filling the room below the stage.
 */
export function seatPosition(seat: Pick<Seat, 'row' | 'col' | 'x' | 'y'>, chart: Pick<SeatChart, 'rows' | 'cols'>): { x: number; y: number } {
  if (seat.x !== undefined && seat.y !== undefined) return { x: seat.x, y: seat.y };
  const rows = Math.max(1, chart.rows);
  const cols = Math.max(1, chart.cols);
  const r = seat.row ?? 0;
  const c = seat.col ?? 0;
  return {
    x: Math.round(((c + 0.5) / cols) * 1000) / 10,
    y: Math.round((GRID_TOP + ((r + 0.5) / rows) * (100 - GRID_TOP)) * 10) / 10,
  };
}

export interface CameraFacts {
  cameraNumber: number;
  connected: boolean;
  onAir: boolean;
  tallyProtect?: boolean;
}

export type SeatPick =
  | { shot: ShotRef; held: false }
  /** Every connected candidate is on air and locked; `shot` is the one "move anyway" would take. */
  | { shot: ShotRef; held: true }
  | null;

/**
 * The camera for a seat: the first candidate (in the order the operator
 * listed them) that is connected and free to move. A camera that is on air
 * but has its lock switched off counts as free — that was the operator's
 * choice. Only when no candidate is free does the first connected one come
 * back as `held`.
 */
export function pickSeatShot(seat: Pick<Seat, 'shots'>, cameras: CameraFacts[]): SeatPick {
  const facts = new Map(cameras.map((c) => [c.cameraNumber, c]));
  const connected = seat.shots.filter((s) => facts.get(s.cameraNumber)?.connected);
  const free = connected.find((s) => {
    const f = facts.get(s.cameraNumber)!;
    return !heldByOnAir(f.onAir, f);
  });
  if (free) return { shot: free, held: false };
  if (connected.length > 0) return { shot: connected[0], held: true };
  return null;
}

/** Total run time of a move: every step's move time plus its hold. */
export function moveDurationMs(move: Pick<ShotMove, 'steps'>, defaultTimeMs = DEFAULT_TIME_MS): number {
  return move.steps.reduce((sum, s) => sum + (s.timeMs ?? defaultTimeMs) + (s.holdMs ?? 0), 0);
}

