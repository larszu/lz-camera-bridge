# Canon Super20 box lens — servo and interface notes

Notes on the Canon PH20x "Super" box lens (Type C) with a J20x8.5B SUPER
core. Values are not yet confirmed by our own measurement — measure before
relying on them.

Measured on our own PJ20x7.5B IE: see
[`measurements/20261020-canon-pj20x75b-box-adapter.md`](measurements/20261020-canon-pj20x75b-box-adapter.md).

## Supply

- Design supply **+15 V** with a separate return; the return is **not chassis**
  (the housing has its own pin). A −15 V line exists on the camera connector but
  is not used inside the lens.
- Internal rails derived on the follow interface board: +V1 ≈ 8.5 V,
  +VR ≈ 5.5 V (reference/centre), +V3 ≈ 2.5 V.

## Position outputs (follow interface amp)

Each axis pot is buffered and offered as a "/B" signal:

| Signal | Range (nominal) |
|---|---|
| IP/B — iris position | closed 2.5 V … open 8.5 V |
| ZP/B — zoom position | VR ± 3 V |
| FP/B — focus position | far VR − 3 V … near VR + 3 V (≈ 2.5–8.5 V) |

Note that 8.5 V through the 100k/68k divider used for the ADS1115 is ≈ 3.4 V —
too close to the input limit; use 100k/47k for these.

## Servo pack interface

Signals between the lens and the zoom/focus servo amplifier:

| Signal | Meaning |
|---|---|
| ZS/SP | **zoom speed command** in (centre = stop) |
| FS/IN | **focus command** in (position) |
| ZP/B, FP/B | zoom / focus position back |
| +B, G | supply and return |
| +V1, +VR, +V3 | reference rails |
| L/E (Z), L/E (F) | local/remote (external) select for zoom and focus |
| S/DF | servo mode select |

The servo amplifier has end-stop trimmers **WIDE PROT / TELE PROT** and
**NEAR PROT / FAR PROT** that slow the motor before the mechanical stops. A
zoom that stops short of the wide end may simply be WIDE PROT set early.

The servo motor modules are a DC motor plus tacho generator plus position pot
(50 kΩ), four wires.

## Camera interface (LDK-9 variant)

The LDK-9 camera connector of this lens carries, among others: focus position,
focus stop, focus follow, FS/IN, zoom position/stop/follow, ZS/SP, iris
position/follow, auto/remote iris, local/remote zoom/focus, tally, lens ID bits.
So the lens **does** offer focus position to a camera — whether a given B4
adapter routes it to Hirose pin 11 is a property of the adapter.

## Known fault

After a modification for a different
camera interface, the **zoom/focus remote/local mode can end up inverted**.
Worth checking if zoom or focus ignores remote commands.
