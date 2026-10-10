# B4 lens carrier board v1

A 160 × 100 mm two-layer carrier for the bench circuit in
[`docs/b4/iris-anleitung.html`](../../docs/b4/iris-anleitung.html): everything
that was loose on two breadboards on 2026-10-10, on one board with plug-in
modules and locking connectors.

**Status: generated, not built.** Fully routed (Freerouting, 0 open
connections); KiCad DRC has no errors apart from the deliberate triple ESP32 row
(see below), only silkscreen warnings. Nothing on this board has been powered.
Measure the first one before a lens is connected.

There is **no KiCad schematic** (`.kicad_sch`) yet: the netlist lives in
`generate_pcb.py`, one `place()` / `res()` call per part with its nets — that is
the reviewable source. The stage formulas are in the table below.

## What is on it

| Block | Parts | Why |
|---|---|---|
| Power in | USB-C with **CH224A** (24 kΩ on CFG1 = 12 V, WCH datasheet table 5-1), or a 5.5/2.1 mm DC jack; both through 1N5822 Schottky diodes | PD supply like the bench, DC as a fallback |
| Protection | Polyfuse MF-RHT200 (2 A hold), TVS P6KE18A, 470 µF bulk | Motor current spikes, short, over-voltage |
| 9 V | L7809 + 330 nF / 100 nF / 10 µF | Replaces the 330 Ω / 1 kΩ divider; the zoom stop hung on that voltage |
| 5 V | RECOM R-78E5.0-0.5 switcher → ESP32 VIN through 1N5819 | The ESP32's USB can stay plugged in |
| 3.3 V (quiet) | LP2950CZ-3.3 from 5 V | DAC, ADC, OLED, pots and the iris offset, separate from the ESP32's noisy 3.3 V |
| Op-amps | **LM324** in a socket | A: iris stage as on the bench. B: zoom. C: focus. D: unused, tied off |
| Zoom / focus drive | Difference amplifier `Vout = REF + 1.8 · (V_B − V_C)`, REF = the demand socket's own 5 V centre (zoom socket pin 7) | "Stop" is now the lens's own reference when DAC B = DAC C, instead of a code that wandered 1270 … 1790 on the bench |
| Readback | 100 k / 68 k + 100 nF into ADS1115 A0–A3 (iris position, zoom position, focus position, iris setpoint) | As measured on the bench |
| Modules | ESP32 DevKit V1 (30 pin), Adafruit MCP4728, ADS1115 breakout, 0.96″ SSD1306 OLED — all on sockets | Swappable, and the DevKit's USB stays reachable |
| Pots | Two on-board 10 k (Alps RK09K, iris and zoom), three JST-XH for external pots; jumpers JP2 / JP3 choose on-board or external | Bench test without anything plugged in |
| Connectors | JST-XH, locking | Loose Dupont wires caused every fault on the bench |

## Connectors

| Ref | To | Pins (1 → n) |
|---|---|---|
| J3 | Lens Hirose 12-pin | +12 V (pin 6) · GND (3) · iris control (5) · iris position (7) · remote (8) · zoom position (10) · focus position (11) · pin 12 |
| J7 | Black zoom socket on the grip | GND · pin 6 (speed) · pin 7 (5 V centre, **REF**) · pin 9 (position) |
| J8 | Focus module socket | GND · control · REF · position — **pinout still to be measured** |
| J4 / J5 / J6 | External pots iris / zoom / focus | 3.3 V · wiper · GND |
| JP1 | Jumper: iris remote | On = pin 8 at 5 V through 1 kΩ |

## ESP32 DevKit V1: three widths

DOIT DevKit V1 clones exist with 22.86, 25.40 and 27.94 mm between the pin
rows. The 3V3 row (J10) is fixed; the VIN row is laid out three times (J11–J13).
**Solder a socket into only the one that fits your board.** DRC reports the
three as overlapping courtyards — that is intended. Measure: centre of one pin
row to the centre of the other.

## Firmware changes this board needs

* Zoom: DAC C fixed at mid-scale (2048); zoom speed = DAC B − DAC C. The stored
  stop becomes ≈ 2048 and should no longer wander; the position hold stays as
  a safety net.
* Focus: DAC D against DAC C, same scheme.
* OLED: SSD1306 on the existing I²C bus (0x3C) — WLAN, IP, iris ≈ F, zoom ≈ mm.
* Pots stay on GPIO 34 / 35 / 36.

## Regenerate

```
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
    hardware/b4-carrier/generate_pcb.py --route
```

Needs KiCad 10, Java (`brew install openjdk`) and Freerouting in `.tools/`
(not committed). The script writes the board, `bom.csv` and routes it.
`fab/` holds the files for PCBWay:

| File | What |
|---|---|
| `fab/b4-carrier-gerber.zip` | Gerbers + Excellon drill, upload as is |
| `fab/bom-smt.csv`, `fab/cpl-smt.csv` | SMT assembly of J1, U1, R1, C1 only |
| `bom.csv` | Every part with value and footprint, for ordering the through-hole parts |
| `fab/render-top.png`, `fab/render-bottom.png` | 3D renders |
| `fab/top-assembly.pdf` | Top copper, silkscreen and the module outlines (F.Fab) for placing parts |

Module outlines (ESP32, MCP4728, ADS1115) are drawn on F.Fab so nothing tall
ends up under a module on its header. The ADS1115 body is assumed to lie left of
its header (header on the module's right edge, VDD at the bottom) as on the
module used on the bench — check yours.

## Before ordering

1. Open `b4-carrier.kicad_pcb` in KiCad, look at every connector against the
   part you have (OLED pin order varies between modules!).
2. Check the ESP32 row width on your DevKit.
3. Order 2-layer, 1.6 mm, HASL, with **SMT assembly for J1, U1, R1, C1 only**
   (USB-C, CH224A and its two parts); everything else is through-hole.
