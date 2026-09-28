# The axis

One interface for every moved axis — dolly, pan, tilt, lifting column — so the
second axis does not invent the first one again. It is driven by a validated
[device profile](device-profiles.md).

- Code: `packages/bridge/src/motion/Axis.ts`
- Tests: `packages/bridge/test/axis.test.ts`

## It does not move anything

`Axis` is a state machine. Every call returns **effects** — `release-brake`,
`drive`, `jog`, `halt`, `engage-brake` — and something else carries them out.
Time is passed in on every call rather than read from a clock.

That split is not tidiness. Issue #57 asks for the shutdown paths to be tested
individually, each on its own, and this is what makes that a test rather than
an intention: a watchdog timeout is a number in a call, not a second of
waiting, and a stop is an assertion on two effects in the right order.

## Fail safe

> Loss of setpoint, loss of feedback, or watchdog timeout stops motion. Never
> hold torque against an unknown obstruction.

This is the one place in the project where a mistake can injure somebody. Three
consequences that are easy to get backwards:

**After a stop the axis does not start again by itself.** Not on the next
setpoint, not when feedback returns. Somebody calls `clearStop()`. An axis that
resumes on its own has decided that whatever stopped it is gone, and it cannot
know that. `clearStop()` also drops the reference: the axis was driving and was
cut, so where it came to rest is not where anyone planned.

**Limits are checked before the move, not during it.** A target outside the
stated travel is refused with a reason — refused, not clamped. A clamp turns a
mistaken command into a move nobody asked for, silently. Checking while running
means the axis has already gone somewhere it should not be.

**On a stop with a brake, the brake engages before torque is cut.** "Never hold
torque" means the drive must not keep pushing against an obstruction; it does
not mean dropping a load. A column whose torque goes first and whose brake goes
second falls the distance in between. Without a brake the axis simply halts.

Going the other way, the brake is **released before the drive is commanded**,
and the wait is the profile's `releaseBeforeMoveMs`. Driving into a closed brake
is how a gearbox is destroyed, and the profile is required to state that time,
so there is nothing to guess.

## An unknown limit is not a limit

The profile's rule carries through. An axis whose travel is not stated refuses
absolute setpoints — it can still be jogged, because then a person is the
limit. The same for homing: until the axis has been referenced it does not know
where it is, and an absolute number would be a guess about a machine that is
about to move.

## States

| State | Meaning |
|---|---|
| `unreferenced` | powered, but does not know where it is |
| `homing` | referencing in progress |
| `ready` | referenced, standing still |
| `brake-releasing` | the brake is releasing; the drive has not been commanded |
| `moving` | driving toward a target |
| `stopped` | stopped by a rule or a person; does not resume by itself |
| `fault` | something a stop does not describe |

`status()` reports the state, whether the axis is referenced, the last known
position, the target, and — after a stop — the reason (`setpoint-lost`,
`feedback-lost`, `watchdog`, `limit`, `commanded`, `homing-failed`) with a
sentence of detail.

The three timeouts (`feedbackTimeoutMs`, `setpointTimeoutMs`, `watchdogMs`) are
required and have no defaults, for the same reason as the FreeD sender's: a
default would be a guess about somebody else's machine. They guard **motion**,
so an axis parked overnight does not wake up stopped.

## What is still open in #57

Nothing here has driven a motor. The state machine and every shutdown path are
covered by tests, but the criteria are written about an axis, and an axis that
exists only as a test fixture has not proved that its brake releases in the
time its profile claims. The first real axis is issue #59.

## Bench plan for the first axis (#59)

Written ahead so the dolly is tested against the criteria and not against
whatever happens to work. Hardware per #59: gimbal BLDC in direct drive,
AS5600 on the shaft, a SimpleFOC-capable driver, module 0.8 rack. **Buy after
phase 5**, as the issue says. Prices and part numbers are the issue's, not
checked here.

| # | Test | Pass when | Maps to |
|---|---|---|---|
| 1 | Profile for exactly this axis validates (`DeviceProfile.ts`) and is the one the runner loads | validation passes; a deliberately missing figure makes it fail | "Geräteprofil liegt vor und wird benutzt" |
| 2 | Homing ten times from random positions | reported home position spread within what the profile states | "Referenzfahrt reproduzierbar" |
| 3 | Setpoint, then hold 60 s | position within profile tolerance, no audible hunting | "fährt Sollwert an und hält ihn" |
| 4 | Stop sending setpoints while moving | `stopped / setpoint-lost` after `setpointTimeoutMs`, torque off | Abschaltpfad 1 |
| 5 | Unplug the AS5600 while moving | `stopped / feedback-lost` after `feedbackTimeoutMs`, torque off | Abschaltpfad 2 |
| 6 | Freeze the control loop (debug hook) | `stopped / watchdog`, torque off | Abschaltpfad 3 |
| 7 | Drive against a hand-held block (soft, e.g. foam on a board) | the axis stops and does **not** keep pushing | "hält kein Drehmoment gegen Widerstand" |
| 8 | Slow move recorded on camera at 50 fps | no visible steps or jerks at the chosen speeds | "ruckfrei genug für eine Kamerafahrt" |

Each of 4–6 alone, with the motor connected, as #57 and #59 require; after each,
confirm the axis does not resume by itself (`clearStop()` needed). Results go
under [`measurements/`](measurements/).
