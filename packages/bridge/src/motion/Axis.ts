/**
 * The axis: setpoint, feedback, limits, homing, status — and stopping.
 *
 * One interface for every moved axis (dolly, pan, tilt, lifting column), so
 * the second axis does not invent the first one again. It is driven by a
 * validated `AxisProfile` (see `protocol/DeviceProfile.ts`), which means a
 * retro-fitted head is described rather than coded for.
 *
 * ── THIS FILE DOES NOT MOVE ANYTHING ───────────────────────────────────────
 *
 * It is a state machine. Every call returns EFFECTS — release the brake, drive
 * to a target, cut torque, engage the brake — and something else carries them
 * out. Two reasons, and the second is the important one:
 *
 *   1. The shutdown paths can then be tested individually, on a fake clock,
 *      which is what the acceptance criterion asks for.
 *   2. The rules live in one readable place instead of being spread across
 *      whatever talks to a motor controller this month.
 *
 * ── FAIL SAFE IS NOT A FEATURE HERE ────────────────────────────────────────
 *
 * This is the one place in this project where a mistake can injure somebody.
 * A lens costs money; a lifting column driving into a person costs more.
 *
 *   Loss of setpoint, loss of feedback, or watchdog timeout stops motion.
 *   Never hold torque against an unknown obstruction.
 *
 * Three details follow from that and are easy to get backwards:
 *
 *   - **After a stop the axis does not start again by itself.** Not on the
 *     next setpoint, not when feedback returns. Somebody clears it with
 *     `clearStop()`. An axis that resumes on its own has decided that whatever
 *     stopped it is gone, and it cannot know that.
 *   - **Limits are checked before the move, not during it.** A move that would
 *     leave the stated travel is refused, with a reason. Checking while running
 *     means the axis has already gone somewhere it should not be.
 *   - **On a stop with a brake, the brake engages BEFORE torque is cut.**
 *     "Never hold torque" means the drive must not keep pushing against an
 *     obstruction; it does not mean dropping a load. A column whose torque
 *     goes first and whose brake goes second falls the distance in between.
 *     Without a brake the axis simply cuts torque.
 *
 * ── AN UNKNOWN LIMIT IS NOT A LIMIT ────────────────────────────────────────
 *
 * The profile's rule carries through: an axis whose travel is not stated
 * refuses absolute setpoints. It can still be jogged, because then a person is
 * the limit. The same holds for homing — until the axis has been referenced it
 * does not know where it is, and a number would be a guess about a machine
 * that is about to move.
 */
import { axisCapability, type AxisProfile } from '../protocol/DeviceProfile.js';

export type AxisState =
  /** Powered, but the axis does not know where it is. */
  | 'unreferenced'
  /** Referencing in progress. */
  | 'homing'
  /** Referenced, standing still, ready. */
  | 'ready'
  /** The brake is releasing; the drive has not been commanded yet. */
  | 'brake-releasing'
  | 'moving'
  /** Stopped by a rule or by a person. Does not resume on its own. */
  | 'stopped'
  /** Something is wrong that a stop does not describe. */
  | 'fault';

export type StopReason =
  | 'setpoint-lost'
  | 'feedback-lost'
  | 'watchdog'
  | 'limit'
  | 'commanded'
  | 'homing-failed';

export type AxisEffect =
  | { kind: 'release-brake' }
  | { kind: 'engage-brake' }
  /** Command the drive toward a position in the axis unit. */
  | { kind: 'drive'; target: number }
  /** Cut torque. Never a hold. */
  | { kind: 'halt' }
  /** Move at a rate, for jogging, in axis units per second. */
  | { kind: 'jog'; rate: number };

export interface AxisStatus {
  state: AxisState;
  referenced: boolean;
  /** Last known position, or null when the axis has never reported one. */
  position: number | null;
  target: number | null;
  /** Why the axis stopped or faulted, in one word plus a sentence. */
  reason: StopReason | null;
  detail: string | null;
}

export type Refusal = { accepted: false; reason: string };
export type Accepted = { accepted: true; effects: readonly AxisEffect[] };
export type AxisResult = Accepted | Refusal;

export interface AxisOptions {
  /**
   * Milliseconds without fresh feedback after which motion stops. Required:
   * a default would be a guess about somebody else's machine.
   */
  feedbackTimeoutMs: number;
  /** Milliseconds without a fresh setpoint after which motion stops. */
  setpointTimeoutMs: number;
  /** Milliseconds without a watchdog kick after which motion stops. */
  watchdogMs: number;
}

const refuse = (reason: string): Refusal => ({ accepted: false, reason });
const accept = (...effects: AxisEffect[]): Accepted => ({ accepted: true, effects });

/**
 * One axis.
 *
 * Time is passed in on every call rather than read from a clock, so each
 * shutdown path can be tested on its own without waiting for it.
 */
export class Axis {
  private state: AxisState = 'unreferenced';
  private position: number | null = null;
  private target: number | null = null;
  private reason: StopReason | null = null;
  private detail: string | null = null;

  private lastFeedbackMs: number | null = null;
  private lastSetpointMs: number | null = null;
  private lastKickMs: number | null = null;
  /** When the brake was told to release, so the tick knows when to drive. */
  private brakeReleasingSinceMs: number | null = null;
  private pendingTarget: number | null = null;

  constructor(
    readonly profile: AxisProfile,
    private readonly options: AxisOptions,
  ) {
    if (options.feedbackTimeoutMs <= 0 || options.setpointTimeoutMs <= 0 || options.watchdogMs <= 0) {
      throw new Error('Axis: every timeout must be a positive number of milliseconds');
    }
  }

  status(): AxisStatus {
    return {
      state: this.state,
      referenced: this.state !== 'unreferenced' && this.state !== 'homing',
      position: this.position,
      target: this.target,
      reason: this.reason,
      detail: this.detail,
    };
  }

  /** Fresh position from the axis. Also feeds the feedback timeout. */
  feedback(position: number, atMs: number): void {
    this.position = position;
    this.lastFeedbackMs = atMs;
  }

  /** The watchdog kick. Nothing else resets it. */
  kick(atMs: number): void {
    this.lastKickMs = atMs;
  }

  /**
   * Reference the axis.
   *
   * The profile has to say how; without a homing procedure the axis cannot
   * establish where it is, and no amount of driving will change that.
   */
  startHoming(atMs: number): AxisResult {
    if (this.state === 'stopped' || this.state === 'fault') {
      return refuse(`axis is ${this.state} — clear it first`);
    }
    const homing = this.profile.homing;
    if (!homing) return refuse('the profile defines no homing procedure');

    this.state = 'homing';
    this.reason = null;
    this.detail = null;
    this.lastSetpointMs = atMs;
    const effects: AxisEffect[] = [];
    if (this.profile.brake?.present) effects.push({ kind: 'release-brake' });
    effects.push({ kind: 'jog', rate: homing.direction === 'toward-min' ? -1 : 1 });
    return { accepted: true, effects };
  }

  /** The reference point was reached; `at` is the position it corresponds to. */
  homingReached(at: number, atMs: number): AxisResult {
    if (this.state !== 'homing') return refuse('the axis is not homing');
    this.position = at;
    this.lastFeedbackMs = atMs;
    this.state = 'ready';
    return accept({ kind: 'halt' }, ...(this.profile.brake?.present ? [{ kind: 'engage-brake' as const }] : []));
  }

  /**
   * Go to a position.
   *
   * Everything that can refuse the move does so here, before anything turns:
   * an axis that is not referenced, travel that is not stated, a target
   * outside it, a stop that nobody cleared.
   */
  moveTo(target: number, atMs: number): AxisResult {
    if (this.state === 'stopped' || this.state === 'fault') {
      return refuse(`axis is ${this.state} (${this.reason ?? 'no reason recorded'}) — clear it first`);
    }
    const cap = axisCapability(this.profile);
    if (!cap.absoluteMove) {
      return refuse(`absolute moves are not available: ${cap.reasons.join('; ')}`);
    }
    if (this.state === 'unreferenced' || this.state === 'homing') {
      return refuse('the axis is not referenced');
    }
    const travel = this.profile.travel!;
    if (target < travel.min || target > travel.max) {
      // Refused, not clamped: a clamp turns a mistaken command into a move
      // nobody asked for, and does it silently.
      return refuse(`target ${target} is outside the stated travel ${travel.min}..${travel.max}`);
    }

    this.target = target;
    this.lastSetpointMs = atMs;
    this.reason = null;
    this.detail = null;

    const brake = this.profile.brake;
    if (brake?.present) {
      // Driving into a closed brake is how a gearbox is destroyed. The profile
      // is required to state the release time, so there is nothing to guess.
      this.state = 'brake-releasing';
      this.brakeReleasingSinceMs = atMs;
      this.pendingTarget = target;
      return accept({ kind: 'release-brake' });
    }
    this.state = 'moving';
    return accept({ kind: 'drive', target });
  }

  /** The target was reached. */
  reached(atMs: number): AxisResult {
    if (this.state !== 'moving') return refuse('the axis is not moving');
    this.state = 'ready';
    this.lastFeedbackMs = atMs;
    const brake = this.profile.brake;
    return brake?.present
      ? accept({ kind: 'engage-brake' }, { kind: 'halt' })
      : accept({ kind: 'halt' });
  }

  /**
   * A tick. Pass the current time; this is where every timeout fires.
   *
   * Returns the effects of whatever it decided, which is usually nothing.
   */
  tick(atMs: number): readonly AxisEffect[] {
    if (this.state === 'stopped' || this.state === 'fault') return [];

    const bewegt = this.state === 'moving' || this.state === 'homing' || this.state === 'brake-releasing';
    if (!bewegt) return [];

    const ueber = (last: number | null, limit: number): boolean =>
      last === null || atMs - last > limit;

    if (ueber(this.lastKickMs, this.options.watchdogMs)) {
      return this.stop('watchdog', `no watchdog kick for ${this.options.watchdogMs} ms`);
    }
    if (ueber(this.lastFeedbackMs, this.options.feedbackTimeoutMs)) {
      return this.stop('feedback-lost', `no feedback for ${this.options.feedbackTimeoutMs} ms`);
    }
    if (ueber(this.lastSetpointMs, this.options.setpointTimeoutMs)) {
      return this.stop('setpoint-lost', `no setpoint for ${this.options.setpointTimeoutMs} ms`);
    }

    if (this.state === 'brake-releasing') {
      const seit = atMs - (this.brakeReleasingSinceMs ?? atMs);
      if (seit >= (this.profile.brake?.releaseBeforeMoveMs ?? 0)) {
        this.state = 'moving';
        const target = this.pendingTarget!;
        this.pendingTarget = null;
        this.brakeReleasingSinceMs = null;
        return [{ kind: 'drive', target }];
      }
    }
    return [];
  }

  /** Keep the setpoint fresh while a move runs. Does not change the target. */
  refreshSetpoint(atMs: number): void {
    this.lastSetpointMs = atMs;
  }

  /** Stop now, by command. Same path as every other stop. */
  stopNow(detail = 'stopped by command'): readonly AxisEffect[] {
    return this.stop('commanded', detail);
  }

  /**
   * Leave the stopped state.
   *
   * Deliberately separate from everything else: it is the moment somebody
   * decides the reason is gone, and nothing in this file may decide that.
   */
  clearStop(): AxisResult {
    if (this.state !== 'stopped') return refuse('the axis is not stopped');
    // Referencing does not survive a stop that happened mid-move: the axis was
    // driving and was cut, so where it ended up is not where anybody planned.
    this.state = 'unreferenced';
    this.reason = null;
    this.detail = null;
    this.target = null;
    return accept();
  }

  private stop(reason: StopReason, detail: string): readonly AxisEffect[] {
    this.state = 'stopped';
    this.reason = reason;
    this.detail = detail;
    this.target = null;
    this.pendingTarget = null;
    this.brakeReleasingSinceMs = null;
    // Brake first, torque second — see the head of this file.
    return this.profile.brake?.present
      ? [{ kind: 'engage-brake' }, { kind: 'halt' }]
      : [{ kind: 'halt' }];
  }
}
