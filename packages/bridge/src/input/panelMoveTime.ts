/**
 * Move time on the hardware panel itself (#133).
 *
 * Until now the move time of a preset recall or a shot lived in the web
 * panel only. An operator with a joystick in one hand does not want to reach
 * for a touch screen to make the next move slower. Two panel commands set
 * the bridge's default move time (`studioShots.defaultTimeMs`, the one the
 * Shots view shows and every recall without its own time uses):
 *
 *   setMoveTime  { value, span? }  — a fader or pot (one-sided axis binding),
 *                                    0..span mapped onto 0.3 s … 20 s on a log
 *                                    scale, so the short times get the travel.
 *   stepMoveTime { by: ±1 }        — a button pair or an encoder: one rung up
 *                                    or down a ladder of usual times.
 *
 * They are bridge commands, not camera commands: the panel input path handles
 * them before anything is dispatched to a camera. A preset recalled from a
 * panel that has one of them uses that time, so what the fader says is what
 * the next move does.
 */
import { MIN_TIME_MS, clampTime } from '../motion/studioShots.js';

export const MOVE_TIME_COMMANDS = ['setMoveTime', 'stepMoveTime'] as const;
export type MoveTimeCommand = (typeof MOVE_TIME_COMMANDS)[number];

export function isMoveTimeCommand(cmd: string): cmd is MoveTimeCommand {
  return (MOVE_TIME_COMMANDS as readonly string[]).includes(cmd);
}

/** Fader end: longer is rarely wanted live, and the Shots view still takes up to 60 s. */
export const FADER_MAX_MS = 20000;

/** The rungs of `stepMoveTime`. */
export const MOVE_TIME_LADDER = [300, 500, 800, 1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000, 20000, 30000, 60000];

/** Fader position 0..span → move time, log scale, rounded to 100 ms. */
export function moveTimeFromFader(value: number, span = 255): number {
  const s = span > 0 ? span : 255;
  const t = Math.max(0, Math.min(1, Math.abs(value) / s));
  const ms = MIN_TIME_MS * Math.pow(FADER_MAX_MS / MIN_TIME_MS, t);
  return clampTime(Math.round(ms / 100) * 100);
}

/** One rung up (`by` > 0) or down from the current time. */
export function stepMoveTime(currentMs: number, by: number): number {
  if (!by) return clampTime(currentMs);
  if (by > 0) return clampTime(MOVE_TIME_LADDER.find((m) => m > currentMs) ?? MOVE_TIME_LADDER[MOVE_TIME_LADDER.length - 1]);
  return clampTime([...MOVE_TIME_LADDER].reverse().find((m) => m < currentMs) ?? MOVE_TIME_LADDER[0]);
}

/** The new default move time for a panel move-time command, or null if the command carries nothing usable. */
export function panelMoveTime(cmd: MoveTimeCommand, params: Record<string, unknown>, currentMs: number): number | null {
  if (cmd === 'setMoveTime') {
    const v = Number(params.value);
    if (!Number.isFinite(v)) return null;
    const span = Number(params.span);
    return moveTimeFromFader(v, Number.isFinite(span) && span > 0 ? span : 255);
  }
  const by = Number(params.by ?? 1);
  return Number.isFinite(by) ? stepMoveTime(currentMs, Math.sign(by)) : null;
}
