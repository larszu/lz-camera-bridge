# Claude Code Brief — B4 Lens Control / Camera Bridge

Drop this into the repo root (or `docs/`) and point Claude Code at it. It is
written to be executed, not just read.

Companion document: `b4-lens-control.md` — the protocol and pinout reference.
Read it first; everything below assumes its content.

---

## 0. Context in one paragraph

Goal is an ESP32-based bridge that sits between a broadcast camera and a B4
(2/3") lens. It reads and writes the camera-to-lens interface on the Hirose
12-pin connector — analog iris control plus a serial protocol on pins 11/12 —
and additionally reads zoom/focus demands so they can be used as input devices
(e.g. for a simulator). Later phases add motorized axes (dolly, pan, tilt,
column) behind a common axis abstraction, and FreeD output for virtual
production.

The ESP32 in use has PoE. Target runtime is FreeRTOS via ESP-IDF or Arduino
core — decide once and record the decision as an ADR.

---

## 1. What I want you to do first

**Audit the existing repos before writing any new code.** Several existing
projects likely already contain pieces this project needs. Do not duplicate
them.

```
# enumerate what actually exists rather than trusting this list
gh repo list --limit 100 --json name,description,updatedAt,isArchived
```

Repos worth checking specifically (verify they exist; ignore archived ones):

| Repo | Why it's relevant |
|---|---|
| `cable-planner` | Most mature of the planner suite. Reference for project skeleton, CI gates, release flow. |
| `av-planner-suite` and siblings (`light-planner`, `multicam-planner`, `inventory-planner`, `facility-planner`) | Shared `@avplan/ui`, house conventions, Electron/Vite/TS skeleton. |
| `stagecue` | Live control tool. Likely already has a network control surface, cue/state model, and possibly OSC — all directly reusable for axis control. |
| `photobooth` | Embedded hardware + kiosk. Reference for device/host split and deployment. |
| Broadcast intercom repo | Broadcast-domain networking patterns. |

### Audit criteria

For each repo, answer in writing:

1. **Transport.** Does it already implement OSC, UDP, WebSocket, or an HTTP
   control API that this project should reuse rather than reinvent?
2. **Device/host protocol.** Is there an existing serial or network protocol
   between a microcontroller and a host app? If so, extend it instead of
   inventing a third one.
3. **UI shell.** Is there a shared component library or Electron shell that a
   lens/axis control surface should be built on?
4. **Domain model.** Any existing representation of cameras, lenses, channels,
   or devices that this project should align with instead of parallel-modelling.
5. **CI and release.** What gates must pass before push, and what is the
   release mechanism? Mirror it here rather than inventing a new one.

Write the result to `docs/reuse-audit.md` in this repo. One section per repo,
with a clear verdict per criterion: **reuse**, **adapt**, or **not applicable**,
and a file path or module name where relevant.

---

## 2. Issues to open

After the audit — not before, because the audit changes their wording — propose
issues. **Show me the list and wait for approval before creating anything.** Then
create with `gh issue create`.

Use these labels: `phase-0` … `phase-6`, plus `hardware`, `firmware`,
`protocol`, `research`, `safety`.

### Proposed issue set

**Phase 0 — classification**
- `Determine lens group (A/B/C) for each available lens` — measurement procedure
  from the reference doc; output is a table in `docs/lens-inventory.md`.

**Phase 1 — iris**
- `Iris control board: DAC + op-amp stage + ADC readback` (hardware)
- `Iris closed-loop firmware with software calibration curve` (firmware)
- `Safety review: series resistors, common ground, level limits` (safety)

**Phase 2 — sniffing**
- `12-pin breakout cable with pins 11/12/3 broken out` (hardware)
- `UART capture at 78400 8N1 with hardware inversion` (firmware)
- `Frame decoder + CRC validation` (protocol)
- `Acceptance test: lens name via 0x11/0x12 returns readable ASCII` (protocol)
- `Capture comparison tooling — diff captures across isolated actions` (research)

**Phase 3 — transmit**
- `Resolve command-code conflict (0x20/0x21/0x22 vs 0x21/0x22/0x23) by
  observation` (protocol) — blocked by Phase 2
- `Transmit path with TX isolation jumper` (hardware)

**Phase 4 — demands as input**
- `Analog demand reader (ADS1115)` (firmware)
- `Expose demand as OSC source` (firmware) — check stagecue audit first
- `Expose demand as USB HID` (firmware)

**Phase 5 — FreeD**
- `FreeD UDP packet encoder` (protocol)
- `Map lens zoom/focus to FreeD 0–4095 range` (firmware)
- `Interop test against Unreal Live Link` (protocol)

**Phase 6 — axes**
- `Axis abstraction: setpoint, feedback, limits, homing, status` (firmware)
- `Device profile format for retrofitting third-party heads` (firmware)
- `First axis: dolly` (hardware)

Each issue body must contain: goal, acceptance criterion, dependencies, and a
link to the relevant section of `b4-lens-control.md`.

---

## 3. Hard constraints for any code you write

- **Never transmit on the lens serial line by default.** TX must be behind an
  explicit compile-time flag *and* a physical jumper. The protocol source warns
  against connecting TX; treat that as binding.
- **Every value from the lens is untrusted.** Validate length byte and CRC
  before acting on a frame. Drop silently, count the drop, never guess.
- **No hardcoded voltage constants in control paths.** All scaling goes through
  a calibration table loaded at boot, because the published values are
  unverified.
- **Axis code must fail safe.** Loss of setpoint, loss of feedback, or watchdog
  timeout stops motion. Never hold torque against an unknown obstruction.
- **Document measurements, including failed ones,** in `docs/measurements/`.
  Public information on this interface is scarce; the notes have value beyond
  this project.

---

## 4. Definition of done for the first milestone

A running ESP32 that:

1. sets and holds an iris position over the 12-pin connector with closed-loop
   feedback, and
2. logs decoded, CRC-valid frames from the lens serial line, including the
   lens name in plain text.

Nothing else. No motors, no UI, no network control surface until both hold.
