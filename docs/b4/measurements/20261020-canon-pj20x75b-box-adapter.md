# 2026-10-20 · Canon PJ20x7.5B IE (Super20 box lens) · adapter pinout, iris drive, readback

Second lens on the bench. An old Canon studio box lens (housing label
"Super20"; per the service notes in [`../canon-super20-servo.md`](../canon-super20-servo.md)
the optical/servo core is a J20x8.5B SUPER) on a *large lens adapter* that
breaks the lens connector out to B4-style plugs.

## Hardware

| Part | What it is |
|---|---|
| Blue 36-pin ribbon connector (Centronics/Amphenol type), pins 1–36 | lens side of the adapter |
| 12-pin Hirose | camera-style B4 plug, connects to the bench ESP32 setup as before |
| DE-9 male, 5 pins populated | **power input** (see below) |
| 8-pin round "TO SW BOX" | same connector type as the zoom socket on the J15 grip — **not** zoom, see below |
| 18-pin round (military style) | servo chain: Canon **FDJ-I01** focus demand, Canon **ZDJ-A01** zoom demand plugged into the FDJ |

## Adapter continuity (no power, lens disconnected)

| Blue 36-pin | Goes to | Meaning |
|---|---|---|
| 4 | DE-9 pin 1 | **+12 V in** (probable) |
| 6 | DE-9 pin 3 | **GND** (probable) |
| 5 | DE-9 pin 6 | unknown |
| 14 | DE-9 pin 5 | unknown |
| 21 | DE-9 pin 4 | unknown |
| 12, 13, 17, 18 | 12-pin Hirose (pins not identified by eye) | per a public box-lens-sled photo: Hirose 7 (iris position), 10 (zoom position), 5 (iris control), 8 (iris auto/remote) — consistent with the readback below |

DE-9 pins 2, 7, 8, 9: not connected. **No DE-9 pin has continuity to the
housing, nor to Hirose pin 3 or 6.** The lens ground is isolated from the
chassis.

The "+12 V on blue 4 / GND on blue 6" assignment comes from a public photo of a
*different* box-lens sled, where blue 4 → Hirose 6 and blue 6 → Hirose 3.
On this adapter those two lines go to the DE-9 instead. That is why the lens
stayed dead with 12 V on Hirose 6 only.

## Power

With +12 V on DE-9 (bench supply) the lens comes up. Canon's service notes
give +15 V as the design supply; 12 V is enough for iris and zoom servo on the
bench. Not tested: 15 V, current draw.

## Iris drive

Firmware `env:esp32-devkit-armed`, not armed, bench console `d<code>`, 2.5–3 s
settle. Setpoint = bench amplifier output (ADS A3), position = Hirose 7 (ADS A0).
Iris switch **A**.

| DAC code | Setpoint | Iris position |
|---|---|---|
| 0 | 2.17 V | 3.35 V |
| 1000 | 3.06 V | 4.49 V |
| 2000 | 3.93 V | 5.20 V |
| 3000 | 4.85 V | 5.94 V |
| 4000 | 5.72 V | 6.23 V |
| 4095 | 5.84 V | 6.16 V |
| 2000 (down) | 3.92 V | 5.11 V |

Iris follows. Lars read the ring: **F2 … F16 reachable; F22, C and F1.5 not.**
The bench amplifier (2.16–5.84 V) is too narrow for this lens. Proposed change:
Ra 15.6 k → **47 k**, R1 10 k → **6.8 k** ⇒ Vout ≈ 1.43 V + 2.04·Vdac ≈
1.4–6.9 V (computed from the measured end point, not yet built).

## Zoom position (Hirose 10)

Zoomed with the original ZDJ-A01 while logging ADS A1: clean, repeatable swing
**≈ 2.0 V ↔ ≈ 5.9 V** between the two end stops. Without demands connected the
channel sits at ≈ 2.0 V with ±0.1 V noise.

Mechanical note (Lars): servo zoom stops at **8 mm, not 7.5 mm** — with the
original demand, so not a bench issue. Candidates: WIDE PROT end-stop trimmer
in the servo amp, mechanics, or engraving tolerance. Not investigated.

## Focus position (Hirose 11)

Nothing. A2 stays at −0.3 … −0.4 V while focus is turned on the FDJ; the small
movements correlate with zoom (cross-talk). Blue 16 (Hirose 11 on the reference
sled) was not found in the continuity check, so the adapter most likely does not
route focus position at all. The lens does generate one (FP/B, see
[`../canon-super20-servo.md`](../canon-super20-servo.md)) — it is reachable on
the servo side.

## "TO SW BOX" is an iris input

The zoom output (LM358 B via 1.2 kΩ) was first put on pin 6 of "TO SW BOX"
(nothing moved), then on a pin reading ≈ 5.9 V: **commanding zoom moved the
iris.** So this socket carries an iris remote input (switch box), not zoom.
Wire removed; pin number still to note.

## Zoom/focus control — open

Zoom speed (ZS/SP) and focus command (FS/IN) arrive on the 18-pin from the
FDJ/ZDJ chain. The plugged connector cannot be probed. Plan: open the FDJ and
ZDJ, find the pot wipers, trace them to the 18-pin by continuity, measure their
voltage range in operation, then feed DAC B (zoom) / C (focus) there — ideally
via a switch inside the FDJ so the hand wheel keeps working.

## Same day, J15ax8B4

"Control stopped working": iris switch was on **M**, and the NVS calibration
table was empty (`nvs_open failed: NOT_FOUND`, `calPoints 0`). The chain
DAC → amplifier was fine (2.13–5.65 V linear).
