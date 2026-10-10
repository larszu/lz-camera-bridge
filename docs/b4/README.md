# B4 lens control — source documents

Working material for controlling 2/3" B4 broadcast lenses over the Hirose 12-pin
connector, and for reading zoom/focus demands as input devices.

> ## Status 2026-10-10: measured on the Canon J15ax8B4 IRS SX12
>
> **Verified on our lens:** the 12-pin pinout (and the trap that the socket is
> numbered mirror-image to the plug), iris and zoom readback, the bench
> amplifier, **iris drive over pin 5** (the lens follows the setpoint 1:1), and
> the voltage per F-stop and per focal length. See [`measurements/`](measurements/).
>
> **Still unverified:** serial (group B), focus position (this lens has no focus
> sensor), demands, and the zoom socket on the grip. Everything not listed as
> measured is third-party material — **measure on the actual lens before
> connecting or driving anything.** One mis-assigned control pin destroys the
> servo electronics.

| File | What it is |
|---|---|
| [`b4-lens-control.md`](b4-lens-control.md) | Protocol and pinout reference. Lens groups A/B/C, the 12-pin pinout, analog signal levels, the serial parameters and the L10-style frame format and command set. **Read this first.** |
| [`umsetzungsplan.pdf`](umsetzungsplan.pdf) | Workshop plan: phases with hard completion criteria, safety rules, three test rigs with dimensioned circuits, and bills of material with prices. German. |
| [`spc7000-pinout.md`](spc7000-pinout.md) | Transcription of the 3ality SPC-7000 connector sheet, with an analysis of what it corroborates and what it adds. |
| [`spc7000-pinout.pdf`](spc7000-pinout.pdf) | The original sheet (2010). Source for the transcription above. |
| [`claude-code-brief.md`](claude-code-brief.md) | The execution brief this work started from. **Partly outdated** — see below. |
| [`bridge-interface.md`](bridge-interface.md) | How the lens became the `b4-lens` connection mode, which two alternatives were rejected, and why this is the only path in the bridge whose iris readback is an independent measurement. |
| [`runtime.md`](runtime.md) | Why the firmware is Arduino-ESP32 and not ESP-IDF, and what would reopen it. Settles the first point ADR-008 left open. |
| [`iris-anleitung.pdf`](iris-anleitung.pdf) | **Werkstattanleitung Iris-Steuerung**, sechs Seiten A4 zum Ausdrucken und Mitnehmen an die Werkbank: Teile, Pinbelegung, beide Aufbauten dimensioniert, Inbetriebnahme in sechs Schritten, Fehlersuche. Quelle: `iris-anleitung.html`. German, deliberately — it is read with a soldering iron in the other hand. |
| [`wiring.md`](wiring.md) | Dividers, the op-amp stage dimensioned, and the commissioning order. Step 4 — measure the amplifier with the lens *disconnected* — is the one people skip and the only one that catches a wrong resistor in time. |
| [`pinout-esp32-devkit.md`](pinout-esp32-devkit.md) | The exact pin map of the bench build: classic ESP32 DevKit (WLAN, no Ethernet) → MCP4728/ADS1115 → Hirose 12-pin on the Canon. What is on the board and how to reach it. |
| [`recherche-2026-10.md`](recherche-2026-10.md) | Desk research Oct 2026 (German): ARIB TR-B37 levels for the 12-pin, Canon warnings, L10 command codes (#47), op-amp and divider corrections, bench recommendations. Source PDFs stay local in `quellen/` (gitignored). |
| [`serial.md`](serial.md) | Phases 2–3 for a group B lens: breakout, capture of both directions, lens name, resolving the command codes, and the transmit path behind a compile flag *and* a jumper. Probably not needed for our Canon (group C expected). |
| [`lens-inventory.md`](lens-inventory.md) | Every lens on hand with its group (A/B/C), the method and the date — #38. Currently one row, *expected C, unmeasured*. |
| [`research-canon.md`](research-canon.md) | Desk research with sources: what Canon's own documents say about our J15ax8B4 IRS, the 8-pin zoom remote, digital demands and the BDC-11 cable (the BDC-10 of §7 does not appear at Canon). |
| [`demand.md`](demand.md) | Phase 4: zoom/focus demands read by the firmware, as `setZoom`/`setFocus` on the bus (#51) or as a USB HID gamepad (#52), which of the two runs when, and what #49 still has to measure. |
| [`safety-review.md`](safety-review.md) | #41 as a form for the bench: what was checked on paper (and the amplifier error it found), what must be measured on the built board with the lens disconnected, and the release line only Lars signs. |
| [`unreal-livelink.md`](unreal-livelink.md) | #56: the interop test against Unreal Live Link FreeD, runnable by someone without this repo's history, with `tools/b4FreeD.ts` as the sender and Epic's documentation as the source. |
| [`measurements/`](measurements/) | Real readings, including the ones that failed. First readings on the Canon 2026-10-10: readback, amplifier sweep, first drive, F-stop and zoom scales. |
| [`freed-output.md`](freed-output.md) | FreeD D1 output: the split between encoder and sender, what the byte table is verified against, and why address, port and rate have no defaults. |
| [`axis.md`](axis.md) | The axis state machine: setpoint, feedback, limits, homing, status — and the order in which a stop engages the brake and cuts torque. |
| [`device-profiles.md`](device-profiles.md) | Profile format for retro-fitted foreign heads: what a profile holds, what is rejected outright, and why an unstated figure costs capability instead of getting a default. |
| [`../reuse-audit.md`](../reuse-audit.md) | What already exists in this repository and the other repositories, with a reuse verdict per criterion. |

## Where this work lives

Decided 2026-09-17 and recorded as
[ADR-008](https://github.com/larszu/av-planner-suite/blob/main/docs/decisions/ADR-008-b4-objektivsteuerung-ablage.md)
in `av-planner-suite`, where the suite's decisions live:

| Part | Where |
|---|---|
| ESP32 firmware (iris, serial protocol, demands) | `packages/firmware-b4` |
| Lens backend, frame handling | `packages/bridge/src/cameras/` and `protocol/`, like any other device family |
| Operation | `packages/web-rcp` — **the same iris as every other camera** |
| Source material, measurements | this folder |

The reason, in one line: iris, focus and zoom are not an interface *to* this
bridge, they are already the normalized commands *of* it, across eight camera
clients. A separate repository would have produced a second iris that behaves
differently from the first.

**Both points ADR-008 left open are now settled.**

The **runtime is Arduino-ESP32 core 3.x** — see [`runtime.md`](runtime.md). The
criterion recorded here did not survive checking: Arduino-ESP32's
`HardwareSerial::begin()` takes an `invert` flag that calls ESP-IDF's
`uart_set_line_inverse()`, so the hardware inversion is reached from both and
does not distinguish them. What decided it instead was the hardware that
actually exists — mature Arduino libraries for the MCP4728 and ADS1115, one
board, and a logic analyzer that takes the ESP32 out of the serial question
entirely.

`firmware-b4` **is built in CI**, both the safe and the armed variant. The armed
build is the one that matters: it is the only place the drive path compiles at
all, so a break in it would otherwise surface for the first time on a bench next
to a lens.

## Corrections to the brief

`claude-code-brief.md` is kept verbatim as the record of what was asked. Three
of its assumptions did not survive the audit:

- **`stagecue` does not exist.** Not on the account, not archived. Phase 4's
  "check stagecue audit first" for OSC has no basis, and there is no OSC
  implementation anywhere on the account. The audit recommends the reverse
  order: this repository's existing WebSocket bus first, then USB HID via the
  existing `HidControlSurface.ts`, and OSC only once something outside the
  account needs to consume it.
- **`facility-planner`** is `larszu-facility-planner`; the intercom repository
  is `Broadcast-intercom` with a capital B.
- The brief assumes `gh`. Issues were created through the GitHub API instead.

## Safety rules that bind any code in this repository

Taken from the brief §3 and the Umsetzungsplan §2. These are not style
preferences:

- **Never transmit on the lens serial line by default.** TX requires a
  compile-time flag *and* a physical jumper. Two transmitters on one line fight.
- **Every value from the lens is untrusted.** Validate the length byte and the
  CRC before acting on a frame. Drop silently, count the drop, never guess.
- **No hardcoded voltage constants in control paths.** All scaling goes through
  a calibration table loaded at boot, because the published values are
  unverified.
- **1 kΩ in series on every line going towards the lens.**
- **Common ground** between the 12 V supply and the controller, or every analog
  reading is meaningless.
- **ESP32 GPIOs are 3.3 V and not 5 V tolerant.** The lens side carries 5 V and
  up to 12 V.
- **Axis code fails safe.** Loss of setpoint, loss of feedback or a watchdog
  timeout stops motion. Never hold torque against an unknown obstruction.
- **Document measurements, including the failed ones,** under `docs/b4/measurements/`.
  Public information on this interface is scarce; the notes have value beyond
  this project.

## First milestone

An ESP32 that (1) sets and holds an iris position over the 12-pin connector with
closed-loop feedback, and (2) logs decoded, CRC-valid frames from the lens serial
line, including the lens name in plain text. Nothing else — no motors, no UI, no
network control surface until both hold.
