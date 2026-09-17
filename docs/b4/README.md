# B4 lens control — source documents

Working material for controlling 2/3" B4 broadcast lenses over the Hirose 12-pin
connector, and for reading zoom/focus demands as input devices.

> ## ⚠️ Nothing here is verified against hardware
>
> Every voltage, pin assignment, baud rate and command code in this folder comes
> from third-party reverse engineering or from a 2010 product sheet. The upstream
> authors state their findings may be wrong. **Measure on the actual lens before
> connecting or driving anything.** A broadcast lens costs four to five figures;
> one mis-assigned control pin destroys the servo electronics.

| File | What it is |
|---|---|
| [`b4-lens-control.md`](b4-lens-control.md) | Protocol and pinout reference. Lens groups A/B/C, the 12-pin pinout, analog signal levels, the serial parameters and the L10-style frame format and command set. **Read this first.** |
| [`umsetzungsplan.pdf`](umsetzungsplan.pdf) | Workshop plan: phases with hard completion criteria, safety rules, three test rigs with dimensioned circuits, and bills of material with prices. German. |
| [`spc7000-pinout.md`](spc7000-pinout.md) | Transcription of the 3ality SPC-7000 connector sheet, with an analysis of what it corroborates and what it adds. |
| [`spc7000-pinout.pdf`](spc7000-pinout.pdf) | The original sheet (2010). Source for the transcription above. |
| [`claude-code-brief.md`](claude-code-brief.md) | The execution brief this work started from. **Partly outdated** — see below. |
| [`../reuse-audit.md`](../reuse-audit.md) | What already exists in this repository and the other repositories, with a reuse verdict per criterion. |

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
