# Device profiles

A retro-fitted pan/tilt head or a foreign lifting column joins this bridge
through a **profile** — a file describing its axes — and not through a code
change. That is issue #58's test of the format, and it is a blunt one: if
adding the second device means editing `src/`, the format has failed.

- Format and validation: `packages/bridge/src/protocol/DeviceProfile.ts`
- A complete example: [`packages/bridge/profiles/example-pan-tilt.json`](../../packages/bridge/profiles/example-pan-tilt.json)
- Tests: `packages/bridge/test/deviceProfile.test.ts`

> The figures in the example profile are **invented**. They describe no real
> head. Copy the shape, measure your own numbers.

## What a profile holds

Per axis:

| Key | Meaning |
|---|---|
| `id`, `kind`, `unit` | `pan`/`tilt`/`lift`; `rotary` (degrees) or `linear` (mm) |
| `travel` | inclusive ends, in the axis unit. **Optional — see below** |
| `directionSense` | `normal` or `inverted`; a motor built the other way round is a statement, not a defect |
| `drive` | `ratio`, `toothModuleMm` (0.8 is the cine and broadcast standard), `poles` |
| `feedback` | `kind`, `countsPerUnit`, `zeroOffset` |
| `homing` | `method`, `direction` (`toward-min`/`toward-max`), `against` |
| `brake` | `present`, `releaseBeforeMoveMs`, `engageAfterStopMs` |
| `cutouts` | `currentA`, `followingError`, `commandTimeoutS` |

## A missing figure stays missing

The house rule, applied to a thing that can hurt someone. **A head whose
profile states no travel limits does not have limits at zero. It has unknown
limits** — and an axis with unknown limits is not sent to an absolute position.
It may still be jogged under someone's hand, because that person is the limit.

A default would have to be an invention either way: `0..0` reads as "cannot
move", `±180°` reads as "go anywhere", and neither was measured.

So `checkProfile` reports two separate lists, and they are not the same thing:

| List | Meaning | Consequence |
|---|---|---|
| `errors` | the profile is **wrong** — contradictory, malformed, unusable | rejected; nothing is filled in |
| `unknowns` | the profile is **honest** about what it does not state | accepted; the capability it costs is named |

`axisCapability(axis)` turns the second into an answer:

```ts
const cap = axisCapability(axis);
// { absoluteMove: false, jog: true, positionFeedback: false,
//   reasons: ['travel limits are not stated', 'the axis reports no position'] }
```

Absolute motion needs three things stated: where the ends are, where zero is,
and how to find zero. `absoluteAxes(profile)` is often shorter than
`profile.axes`, and that is the format working rather than failing.

## What is rejected outright

- `formatVersion` other than 1, or a missing `id` / `manufacturer` / `model`
- an empty axis list, or two axes sharing a name
- a rotary axis stated in mm (or the reverse) — that profile was copied from
  another device, and every figure under it is then suspect
- `travel.min` not below `travel.max`
- a `directionSense` that is neither `normal` nor `inverted`
- a non-positive `drive.ratio` or `feedback.countsPerUnit`
- **a declared brake with no release time.** Driving into a closed brake is how
  a gearbox is destroyed, so this one is not a gap to fill with zero

Every problem is reported at once. A check that stops at the first fault makes
whoever is writing the profile run it once per typo.

## What this file does not do

It does not open a serial port, drive an axis, or read a file from disk.
Loading the JSON is the caller's job; this module validates what it is handed.
The axis abstraction that acts on a validated profile is issue #57, and
nothing here moves anything until that exists.
