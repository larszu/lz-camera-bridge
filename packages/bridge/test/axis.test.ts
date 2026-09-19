/**
 * Axis tests (run with `npm test` in packages/bridge).
 *
 * Issue #57 asks for the shutdown paths to be tested **individually, each on
 * its own**. That is what the first block below does: one test per way of
 * stopping, each arranged so only that one can fire.
 *
 * Time is passed in, never read from a clock, so a watchdog timeout is a
 * number in a call rather than a second of waiting.
 *
 * Nothing here drives anything. The axis returns effects; a test asserts on
 * the effects.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AxisProfile } from '../src/protocol/DeviceProfile.js';
import { Axis, type AxisEffect } from '../src/motion/Axis.js';

const TIMEOUTS = { feedbackTimeoutMs: 100, setpointTimeoutMs: 100, watchdogMs: 100 };

const mitBremse = (over: Partial<AxisProfile> = {}): AxisProfile => ({
  id: 'lift',
  kind: 'linear',
  unit: 'mm',
  travel: { min: 0, max: 1000 },
  directionSense: 'normal',
  drive: { ratio: 4 },
  feedback: { kind: 'hall', countsPerUnit: 12, zeroOffset: 0 },
  homing: { method: 'hard-stop', direction: 'toward-min', against: 'lower stop' },
  brake: { present: true, releaseBeforeMoveMs: 50, engageAfterStopMs: 100 },
  cutouts: { currentA: 8 },
  ...over,
});

const ohneBremse = (over: Partial<AxisProfile> = {}): AxisProfile =>
  mitBremse({ id: 'pan', kind: 'rotary', unit: 'degree', travel: { min: -180, max: 180 }, brake: { present: false }, ...over });

/** An axis that has been referenced and is moving, with every timer fresh. */
function fahrendeAchse(profile: AxisProfile, t = 1000): { axis: Axis; t: number } {
  const axis = new Axis(profile, TIMEOUTS);
  axis.kick(t);
  axis.feedback(0, t);
  const homing = axis.startHoming(t);
  assert.equal(homing.accepted, true);
  axis.kick(t);
  axis.feedback(0, t);
  assert.equal(axis.homingReached(0, t).accepted, true);

  const move = axis.moveTo(100, t);
  assert.equal(move.accepted, true);
  // Past the brake release, if there is one.
  axis.kick(t + 60);
  axis.feedback(1, t + 60);
  axis.refreshSetpoint(t + 60);
  axis.tick(t + 60);
  assert.equal(axis.status().state, 'moving');
  return { axis, t: t + 60 };
}

const kinds = (effects: readonly AxisEffect[]): string[] => effects.map((e) => e.kind);

// ─── Each shutdown path on its own ─────────────────────────────────────────

test('setpoint lost stops the motion', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  // Only the setpoint goes stale; feedback and watchdog stay fresh.
  axis.kick(t + 150);
  axis.feedback(5, t + 150);
  const effects = axis.tick(t + 150);
  assert.deepEqual(kinds(effects), ['halt']);
  assert.equal(axis.status().state, 'stopped');
  assert.equal(axis.status().reason, 'setpoint-lost');
});

test('feedback lost stops the motion', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  axis.kick(t + 150);
  axis.refreshSetpoint(t + 150);
  const effects = axis.tick(t + 150);
  assert.deepEqual(kinds(effects), ['halt']);
  assert.equal(axis.status().reason, 'feedback-lost');
});

test('the watchdog timing out stops the motion', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  axis.feedback(5, t + 150);
  axis.refreshSetpoint(t + 150);
  const effects = axis.tick(t + 150);
  assert.deepEqual(kinds(effects), ['halt']);
  assert.equal(axis.status().reason, 'watchdog');
});

test('a commanded stop takes the same path', () => {
  const { axis } = fahrendeAchse(ohneBremse());
  assert.deepEqual(kinds(axis.stopNow()), ['halt']);
  assert.equal(axis.status().reason, 'commanded');
});

test('nothing stops an axis whose three timers are all fresh', () => {
  // The negative control for the four tests above: without it they would also
  // pass against an axis that stops on every tick.
  const { axis, t } = fahrendeAchse(ohneBremse());
  axis.kick(t + 50);
  axis.feedback(5, t + 50);
  axis.refreshSetpoint(t + 50);
  assert.deepEqual(axis.tick(t + 50), []);
  assert.equal(axis.status().state, 'moving');
});

// ─── After a stop ──────────────────────────────────────────────────────────

test('a stopped axis does not start again by itself', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  axis.tick(t + 150);
  assert.equal(axis.status().state, 'stopped');

  // Everything comes back — feedback, setpoint, watchdog — and the axis stays
  // put. Whatever stopped it may still be standing there.
  axis.kick(t + 200);
  axis.feedback(5, t + 200);
  axis.refreshSetpoint(t + 200);
  assert.deepEqual(axis.tick(t + 200), []);
  assert.equal(axis.status().state, 'stopped');

  const wieder = axis.moveTo(50, t + 200);
  assert.equal(wieder.accepted, false);
  assert.match((wieder as { reason: string }).reason, /clear it first/);
});

test('clearing a stop leaves the axis unreferenced, not ready', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  axis.tick(t + 150);
  assert.equal(axis.clearStop().accepted, true);
  // It was cut mid-move: where it came to rest is not where anyone planned.
  assert.equal(axis.status().state, 'unreferenced');
  const move = axis.moveTo(50, t + 200);
  assert.equal(move.accepted, false);
  assert.match((move as { reason: string }).reason, /not referenced/);
});

// ─── Limits ────────────────────────────────────────────────────────────────

test('limits are checked before the move, and a target outside them is refused', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  const r = axis.moveTo(200, t);
  assert.equal(r.accepted, false);
  assert.match((r as { reason: string }).reason, /outside the stated travel -180\.\.180/);
  // Refused, not clamped, and not a stop either: nothing turned.
  assert.equal(axis.status().state, 'moving');
});

test('an axis with unstated travel refuses absolute setpoints', () => {
  const axis = new Axis(ohneBremse({ travel: undefined }), TIMEOUTS);
  axis.kick(1000);
  axis.feedback(0, 1000);
  axis.startHoming(1000);
  axis.homingReached(0, 1000);
  const r = axis.moveTo(10, 1000);
  assert.equal(r.accepted, false);
  assert.match((r as { reason: string }).reason, /travel limits are not stated/);
});

// ─── Homing ────────────────────────────────────────────────────────────────

test('without homing the axis refuses absolute setpoints', () => {
  const axis = new Axis(ohneBremse(), TIMEOUTS);
  const r = axis.moveTo(10, 1000);
  assert.equal(r.accepted, false);
  assert.match((r as { reason: string }).reason, /not referenced/);
  assert.equal(axis.status().referenced, false);
});

test('an axis whose profile defines no homing cannot be referenced', () => {
  const axis = new Axis(ohneBremse({ homing: undefined }), TIMEOUTS);
  const r = axis.startHoming(1000);
  assert.equal(r.accepted, false);
  assert.match((r as { reason: string }).reason, /no homing procedure/);
});

test('homing runs toward the stop the profile names', () => {
  const axis = new Axis(ohneBremse({ homing: { method: 'limit-switch', direction: 'toward-max' } }), TIMEOUTS);
  const r = axis.startHoming(1000);
  assert.equal(r.accepted, true);
  const jog = (r as { effects: AxisEffect[] }).effects.find((e) => e.kind === 'jog');
  assert.equal(jog?.kind === 'jog' && jog.rate > 0, true, 'toward-max must jog positive');
});

// ─── The brake ─────────────────────────────────────────────────────────────

test('the brake is released before the drive is commanded', () => {
  const axis = new Axis(mitBremse(), TIMEOUTS);
  axis.kick(1000);
  axis.feedback(0, 1000);
  axis.startHoming(1000);
  axis.homingReached(0, 1000);

  const move = axis.moveTo(500, 1000);
  assert.deepEqual(kinds((move as { effects: AxisEffect[] }).effects), ['release-brake']);
  assert.equal(axis.status().state, 'brake-releasing');

  // Before the stated release time, still nothing turns.
  axis.kick(1030);
  axis.feedback(0, 1030);
  axis.refreshSetpoint(1030);
  assert.deepEqual(axis.tick(1030), []);

  // After it, the drive is commanded.
  axis.kick(1055);
  axis.feedback(0, 1055);
  axis.refreshSetpoint(1055);
  const effects = axis.tick(1055);
  assert.deepEqual(kinds(effects), ['drive']);
  assert.equal(axis.status().state, 'moving');
});

test('on a stop the brake engages before torque is cut', () => {
  const { axis, t } = fahrendeAchse(mitBremse());
  const effects = axis.tick(t + 150);
  // The order is the point: torque first would let a column fall the distance
  // between the two commands.
  assert.deepEqual(kinds(effects), ['engage-brake', 'halt']);
});

test('reaching the target sets the brake, then cuts torque', () => {
  const { axis, t } = fahrendeAchse(mitBremse());
  const r = axis.reached(t);
  assert.deepEqual(kinds((r as { effects: AxisEffect[] }).effects), ['engage-brake', 'halt']);
  assert.equal(axis.status().state, 'ready');
});

test('an axis without a brake just cuts torque', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  assert.deepEqual(kinds(axis.stopNow()), ['halt']);
  const zweite = fahrendeAchse(ohneBremse(), 5000);
  assert.deepEqual(kinds((zweite.axis.reached(zweite.t) as { effects: AxisEffect[] }).effects), ['halt']);
});

// ─── Status ────────────────────────────────────────────────────────────────

test('status is readable from outside, with a reason', () => {
  const { axis, t } = fahrendeAchse(ohneBremse());
  const laufend = axis.status();
  assert.equal(laufend.state, 'moving');
  assert.equal(laufend.referenced, true);
  assert.equal(laufend.target, 100);
  assert.equal(laufend.reason, null);

  // Only the setpoint goes stale, so the reason is unambiguous.
  axis.kick(t + 150);
  axis.feedback(5, t + 150);
  axis.tick(t + 150);
  const gestoppt = axis.status();
  assert.equal(gestoppt.state, 'stopped');
  assert.equal(gestoppt.reason, 'setpoint-lost');
  assert.match(gestoppt.detail ?? '', /no setpoint for 100 ms/);
  assert.equal(gestoppt.target, null, 'a stopped axis carries no target');
});

test('a timeout must be stated — there is no default', () => {
  assert.throws(
    () => new Axis(ohneBremse(), { ...TIMEOUTS, watchdogMs: 0 }),
    /every timeout must be a positive number/,
  );
});

test('a standing axis is not stopped by a stale timer', () => {
  // Ready and not moving: the timeouts guard MOTION. An axis parked overnight
  // would otherwise wake up in the stopped state for no reason.
  const axis = new Axis(ohneBremse(), TIMEOUTS);
  axis.kick(1000);
  axis.feedback(0, 1000);
  axis.startHoming(1000);
  axis.homingReached(0, 1000);
  assert.deepEqual(axis.tick(999_000), []);
  assert.equal(axis.status().state, 'ready');
});
