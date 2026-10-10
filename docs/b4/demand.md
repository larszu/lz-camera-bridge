# Zoom and focus demands as an input (phase 4)

> **Do not plug in a demand with the divider below.** An analog Fujinon focus
> demand puts +12 V on Detect (Fujinon manual, see
> [`recherche-2026-10.md`](recherche-2026-10.md)); through 10k/6k8 that is
> 4.9 V at the ADS1115, whose absolute maximum is 3.6 V. Redesign first.

A demand is the hand control of a broadcast lens: a thumb rocker for zoom, a
knob for focus. Phase 4 reads one and puts it where this repository already
routes commands. This file describes what is built, which of two ways is used
when, and what is still missing because it needs a demand on the bench.

> **Nothing here has touched a demand.** The firmware builds, the bridge side
> is tested against a fake device and the simulator. Every voltage below is
> taken from a third-party document and is labelled as such.

## What the sources say, and what they do not

| Fact | Source | Status |
|---|---|---|
| Fujinon B/C demand, 12-pin Hirose: pin 1 +12 V, 2 GND, 3/4/5 = 7.5/5.0/2.5 V reference **from the host**, 6 `Detect` to the host, 7 the wiper; zoom demand adds VTR/RET buttons with their commons on 9–12 | 3ality SPC-7000 sheet, transcribed in [`spc7000-pinout.md`](spc7000-pinout.md) | third party, 2010, unmeasured |
| What `Detect` is (pull-up, strap, identifying resistor) | — | **unknown**, #49 |
| Whether a zoom rocker's wiper encodes *speed* (centre = stop) or *position* | — | **unknown** for our demands; the bridge treats both through the calibration table (below) |
| Canon non-digital "R"-type ENG lenses take the zoom demand on an **8-pin** remote connector; a 20-pin servo demand needs the CC-0820 conversion cable, "some functions are limited" | Canon ZSD-300D manual (via [manualslib](https://www.manualslib.com/manual/4095772/Canon-Zsd-300d.html)) | Canon document |

The consequence for the design: **the firmware interprets nothing it cannot
know.** It reports the wiper and the Detect line as voltages. The bridge maps a
wiper reading to a command only through a table measured on that demand.

## Signal path

```
demand pin 7 (wiper) ──10k──┬── ADS1115 #2 (0x49) A0 zoom / A1 focus
                            6k8
demand pin 6 (Detect) ─10k──┬── A2 zoom / A3 focus   (reported raw only)
                            6k8
```

The divider is the same 10 kΩ / 6.8 kΩ as the lens readback: at the 7.5 V
reference the ADC sees 3.04 V, below the ADS1115's absolute maximum of
VDD + 0.3 V (TI ADS1115 datasheet). The second ADS1115 has its ADDR pin on VDD,
which the datasheet (table 7-2) gives as address 0x49.

**Not designed yet:** the 2.5 / 5.0 / 7.5 V references the demand expects from
the host. The SPC-7000 supplies them; our board does not. Until that circuit
exists and #49 has measured what a demand draws from it, nothing is connected.

## Firmware

`/api/status` gains a `demand` block when the second ADC answers — each field
only when it was read (`zoomCounts`/`zoomVolts`, `focusCounts`/`focusVolts`,
`zoomDetectCounts`/`zoomDetectVolts`, `focusDetect…`, and `vtr`/`ret` when those
pins are wired). An unread field is absent, never zero; that absence is what
lets the bridge notice an unplugged demand.

`loopMs` reports how long one pass of reading and control really took. It
exists because the ADS1115 driver blocks for each conversion: at the chip's
default 128 SPS, eight oversamples on three channels are about 190 ms, so the
"50 ms" loop ran at roughly 5 Hz. The ADCs now run at 860 SPS
(`ADS_DATA_RATE` in `config.h`), and the demand is oversampled four times
instead of eight.

## Two ways out, one at a time

### Through the bridge (#51) — `input/DemandSource.ts`

The bridge polls the device and turns the wiper into the bus's existing rate
commands, `setZoom` / `setFocus` with `value` -100..100 (0 = stop) — the same
vocabulary the VISCA, Panasonic and JVC backends and the PTZ panel use. Enabled
over the WebSocket on `:9700`:

```json
{ "type": "enableDemand", "demand": {
    "host": "192.168.1.50", "pollMs": 50,
    "bindings": [{
      "axis": "zoom", "cameraNumber": 2, "command": "setZoom",
      "calibration": { "axis": "zoom-demand", "rawUnit": "adc-count", "valueUnit": "rate-percent",
                       "points": [ {"raw": 8000, "value": -100}, {"raw": 16000, "value": 0}, {"raw": 24000, "value": 100} ],
                       "source": "measured 2026-..-.., see measurements/…" } }] } }
```

(The numbers above are placeholders for the format, not a measurement.)

| Rule | Why |
|---|---|
| Target camera per binding | the issue asks for it; a demand is not tied to "the lowest connected camera" |
| No table → refused at enable time | the mapping is per demand; no voltage is assumed |
| Outside the table = unknown | a floating wiper is not an end stop |
| Deadband (default ±3) around 0 | a resting rocker does not creep |
| Step (default 2) and at most one command per 50 ms | no flood at ADC rate |
| A stop is never rate-limited | a late stop is an overshoot |
| Field absent, outside the table, or device unreachable → **one** `value: 0`, then silence | the issue: an unplugged demand must not keep its last value |
| Broadcast `{ type: 'demand', …, origin: 'commanded' }` | the demand is a setpoint source; `setZoom`/`setFocus` never become a confirmation |

### As a USB HID gamepad (#52) — `env:waveshare-esp32-s3-eth-demand-hid`

For a computer **without** the bridge: the firmware itself enumerates as a
gamepad, so any OS sees the demand as an axis with no extra software.

**Decision: an own HID device in the firmware, not `HidControlSurface.ts`.**
`HidControlSurface` is the bridge *reading* a HID device — it only helps when
the bridge runs, which is exactly the case #52 is not about. Inside the bridge
the HTTP way above already exists; a second in-bridge path would be the
duplicate the issue warns about.

| | |
|---|---|
| Axes | X = zoom demand, Y = focus demand; the Arduino core's `USBHIDGamepad`, **8 bit signed** (-127..127) |
| Scale | ADC counts 0..32767 linearly onto -127..127 — the ADC's scale, no voltage claim. With the 2.5–7.5 V band behind the divider that is roughly 140 usable steps per axis; calibrate in the OS |
| Rate | one report per firmware loop, only when a value changed; the loop period is `loopMs` (target 50 ms) |
| Jitter | the axes are taken from the filter's deadbanded value (`AnalogFilter::stable()`), so a resting demand does not flicker |
| No reading | the axis reports centre |
| Buttons | 0 = VTR, 1 = RET, when those pins are wired |
| Build | TinyUSB (`ARDUINO_USB_MODE=0`); the console stays on USB-CDC in the same composite device |

### Which one is active when

- Bridge running → use `enableDemand`. The HID build may still be plugged in;
  the bridge does not read it unless someone binds it in a control surface.
- No bridge (simulator, foreign software) → the HID build.
- **Both on the same command is refused**: `enableDemand` fails while a HID
  control surface is bound to `setZoom`/`setFocus`, and the other way round,
  with a message saying which one to switch off. Two sources on one axis
  cancel each other out report by report.

## What #49 still has to measure

1. Pin 6 `Detect` on a real demand: what it is, and whether a host must present
   something there before the demand delivers a wiper voltage at all.
2. The wiper range against the 2.5–7.5 V references, and whether it stays under
   the divider's limit.
3. Zoom rocker: speed or position.
4. VTR/RET: dry contacts or not — only then may `PIN_DEMAND_VTR/RET` be set.
5. The reference supply circuit, designed and measured before a demand is
   connected.

Each goes into [`measurements/`](measurements/), and the calibration table for
`enableDemand` is taken from the same session.

## Canon J15ax8B4: sockets on the grip (2026-10-10)

Underside of the drive unit, top to bottom:

| Socket | What it is | Source |
|---|---|---|
| Round, **black insert**, rubber cap | **Zoom control** (remote / demand). Matches Canon's documented 8-pin zoom remote of non-digital R-type lenses; pin count not yet confirmed | Lars, 2026-10-10 |
| 12-pin Hirose, **white insert** | For an **add-on focus motor module** — not zoom | Lars, 2026-10-10 |
| Round, capped | not identified | — |

Measured on the black socket so far: one pin follows the zoom position and stays
there — ≈ 2 V at wide, ≈ 7 V at tele (same curve as 12-pin pin 10). That is an
**output** (position), not the control input. Which hole it is and what the other
pins carry is still open; the hobby pinout for the 8-pin (A 2.5 V tele end,
B 7.5 V wide end, C/D 5 V, E/G GND, F record, H return) is unconfirmed.
Free drive hardware on the bench: MCP4728 VB and LM358 half B.
