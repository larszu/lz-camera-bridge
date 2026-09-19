# FreeD output

Tracking data leaves the bridge as FreeD D1 datagrams over UDP. FreeD comes
from BBC R&D and is read by, among others, Unreal Engine through Live Link.

Two files, deliberately separate:

| File | Does | Does not |
|---|---|---|
| `packages/bridge/src/protocol/FreeD.ts` | builds and parses the 29 bytes | open a socket, keep a clock |
| `packages/bridge/src/transport/FreeDSender.ts` | destination, rate, what a tick does | decide what a byte means |

## The packet

29 bytes, big-endian throughout, checksum `(0x40 − sum of bytes 0..27) & 0xFF`.
The field table is in the head of `FreeD.ts` and is not copied here — a second
copy of a byte table is the kind of thing that drifts silently.

**What is verified and what is not.** Length, identifier, checksum rule and the
angle format (sign in bit 23, 8 integer and 15 fractional bits, i.e. 1/32768
degree) come from public sources. The position scale `POSITION_UNITS_PER_MM =
64` is the widely used value but **not confirmed** against an authoritative
document; issue #54 stays open for exactly that check. Angles, zoom and focus
are unaffected, so a lens that only reports zoom and focus is already fully
covered.

## Configuring the sender

```ts
import { createFreeDSender } from './transport/FreeDSender.js';

const sender = createFreeDSender({
  host: '10.0.1.50',   // unicast, broadcast or multicast
  port: 6301,          // whatever the receiving system was set to
  rateHz: 50,          // packets per second
  onIncomplete: (missing) => log.warn(`FreeD: no ${missing.join(', ')} yet`),
  onError: (err) => log.error(err),
});

sender.update(sample);   // store the latest tracking sample
sender.start();          // begin ticking
```

### Address, port and rate have no defaults

All three are required, and `createFreeDSender` throws rather than filling one
in.

- **FreeD has no registered UDP port.** Whoever sets a system up tells each end
  which port to use. The numbers that circulate — 6301 is the common one — are
  site conventions, not a specification. A default here would look like a
  standard and would not be one, and the first person to hit it would debug a
  silent receiver instead of reading an error message.
- **The rate belongs to the installation, not to the protocol.** Tracking is
  normally sent once per video field or frame, which makes 25, 50 and 60 Hz the
  usual choices; which one is right depends on the format the show runs in, and
  this program does not know that. `intervalMs` on the sender reports the
  derived tick spacing (`1000 / rateHz`) so a caller can show what it settled
  on.

A rate that is not a positive finite number, and a port outside 1..65535, are
rejected instead of repaired.

### A tick with nothing to say sends nothing

`encodeFreeD` refuses a sample with a null axis, and the sender does not work
around that:

| Situation | On the wire | Counter | Callback |
|---|---|---|---|
| complete sample | one datagram | `sent` | — |
| an axis is `null` | nothing | `skippedIncomplete` | `onIncomplete(missing)` |
| no sample yet | nothing | `skippedNoSample` | — |
| socket error | — | `errors` | `onError(err)` |

Zero-filling a missing axis would put the camera at the origin pointing
straight ahead — a statement nobody made, and one the receiver cannot tell from
a measurement. Silence is the honest report of "no tracking yet".

`sendNow()` sends a single packet outside the tick, opening and closing its own
socket, and returns `{ ok: false, reason }` with the same three cases. It is
there so someone checking a route gets an answer rather than a guess.

## Tests

`packages/bridge/test/freeD.test.ts` covers the bytes,
`packages/bridge/test/freeDSender.test.ts` the wire — the latter binds a real
loopback receiver on a kernel-chosen port, because a mocked `send()` would only
prove that a function was called.

Neither proves byte-exactness against a capture from real FreeD equipment. That
capture does not exist here, and issue #54 names it as the remaining item.

## Zoom and focus: where the numbers come from

The raw readings and the FreeD range do not share a scale, and the three
sources do not agree with each other:

| Origin | Range |
|---|---|
| serial `0x31` / `0x32` | `0x0000`–`0xFFFF` (zoom wide→tele, focus MOD→infinity) |
| analog position, pin 10 / pin 11 | 2–7 V |
| FreeD | 0–4095 |

None of those pairs is a fixed relationship, so the mapping is **not a constant
in the code**. `packages/bridge/src/protocol/LensCalibration.ts` interpolates
between measured points held in a table per lens and per axis; the same tables
serve the iris loop (issue #40), because two mapping mechanisms would be two
behaviours.

```ts
const zoom: CalibrationTable = {
  axis: 'zoom',
  rawUnit: 'serial-16bit',   // or 'millivolt' for the analog pins
  valueUnit: 'mm',           // focal length, so the count means something physical
  points: [
    { raw: 0x0000, value: 9.3 },
    { raw: 0x8000, value: 80 },
    { raw: 0xffff, value: 410 },
  ],
  source: 'measured on <lens>, <date>',
};

const axes = freeDLensAxes({ zoom: { table: zoom, raw: reading } });
sender.update({ ...sample, zoom: axes.zoom, focus: axes.focus });
```

Commands `0x14`/`0x15` (focal length at tele and wide) and `0x16` (minimum
object distance) are what make the value column physical rather than an
arbitrary counter.

### Outside the measured span the answer is "unknown"

`interpolate` returns null beyond the outermost points instead of clamping to
the end value. Clamping would assert the axis is at its stop — exactly what was
*not* measured; all that is known is that the calibration does not reach this
far. The null travels on as a missing axis, the encoder refuses it and the
sender stays quiet, which is the correct report. A clamped 4095 would look like
a lens racked fully to tele.

No table means no value. Nothing here estimates.

### What the checker rejects

`checkCalibration` reports **every** problem, not the first: fewer than two
points, a raw reading that appears twice, a non-monotone raw column, a flat
step, and a value column that reverses direction. A descending value column is
fine — that is how direction sense is stated.

### Still open in #55

The table mechanism, monotonicity and the "no calibration, no value" rule are
covered by unit tests over both raw ranges. What is **not** covered is an axis
driven over its full mechanical travel on a real lens: the numbers in the tests
are fixtures, not measurements, and whether `0x0000`–`0xFFFF` spans the whole
travel of a given lens is exactly the thing a hardware session has to answer.
