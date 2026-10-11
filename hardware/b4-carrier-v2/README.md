# B4 lens carrier board v2

135 × 92 mm, 4 layers (GND poured on every layer), SMD assembled by PCBWay, two 18650
cells on the bottom. Successor of [v1](../b4-carrier/README.md): same analog
stages (measured on the bench on 2026-10-10, simulated in
[`../b4-carrier/simulation/`](../b4-carrier/simulation/README.md)), but every
chip is on the board and the board runs on its battery.

**Status: draft, not ordered, nothing powered.** Fully routed. KiCad DRC
(zones refilled): 0 unconnected, 0 clearance, 0 silkscreen errors; the only
entries are the four intended overlaps of the fused ESP32 header courtyards.
The netlist lives in `generate_pcb.py` (one `place()` / `R()` / `C()` call per
part with its nets); there is no `.kicad_sch`.

## Rules and current paths

| Rule | Value |
|---|---|
| Clearance | 0.15 mm (signals), 0.2–0.25 mm for pours and power trunks |
| Track / via minimum | 0.12 mm / 0.45 mm via, 0.2 mm drill (PCBWay standard) |
| Copper to board edge | 0.5 mm; trunks keep ≥ 1.2 mm |
| Main current paths (B.Cu trunks, `power_trunks.py`) | 2.0 mm: VBAT_RAW, VMID, VBAT, CHG_IN, VSYS · 1.5 mm: V12, V12_LENS, DC_IN, USB_VBUS · 1.0 mm: ESP_5V — each with a via cluster at its capacitor |
| Power pours (`postprocess.py`) | every power track gets a 1.5 mm (0.8 mm for 5 V / 9 V) pour along it, clipped where other copper is near |
| Width check | `width-report.txt`: narrowest copper per power net away from pads |

Sized for 1.5 A lens current from 2S cells (6–8.4 V): VSYS / VBAT then carry up
to ≈ 3.5 A; 2 mm on 35 µm outer copper is ≈ 4 A at 20 K rise (IPC-2152,
estimate, not measured). The trunks also end directly on via groups at the
BQ25798's VBAT and CHG_IN pins and at the eFuse input. Narrow entries left in
`width-report.txt` are branches that carry no load current (test points,
balancer sense line) and the SW1 / SW2 stubs right at the BQ25798 pins, which
cannot be wider than the 0.25 mm pins themselves.

The charger core is laid out by hand (`charger_core()`): U2 turned so SW1/SW2
face L1 directly, PMID and SYS capacitors on short buses right at their pins,
the power-ground pin straight into the planes with two vias between SW1 and SW2,
PROG resistor directly at pin 20, charge LED at STAT. D+ and D− are tied at the
pins (BC1.2 "dedicated charger"): PD is negotiated by the CH224A, the input
current limit is set by the firmware.

## Blocks

| Block | Parts | Datasheet values used |
|---|---|---|
| Input | USB-C with **CH224A** (24 kΩ CFG1 → asks for 12 V) or DC jack 6–20 V, each through B540C, TVS SMBJ22A | CH224A table 5-1 |
| Charger | **BQ25798** buck-boost, 2S, NVDC: VSYS keeps running from the input while the cells charge; D+/D− tied at the pins (no USB data needed, PD is the CH224A's) | PROG 8.2 kΩ = 2S / 750 kHz, L 2.2 µH, TS divider 5.23k/30.1k + 10k NTC, BATP 100 Ω, SDRV 1 nF, VAC1/VAC2 on VBUS, ACDRV to GND (no input FETs) |
| Cells | 2 × Keystone 1042 (bottom), 5 A fuse, **BQ29209** overvoltage + balancing | OUT pulls CE high → charging stops on a cell overvoltage |
| 12 V | **TPS55340** boost from VSYS (6–8.4 V) | FB 88.7k/10k = 12.13 V, FREQ 78.7k = 600 kHz, L 10 µH, B540C |
| Lens protection | **TPS259541** eFuse: ~1.5 A limit, 13.7 V clamp, UVLO ≈ 10 V; `LENS_OFF` switches lens power off | ILM 1.40k, dVdt 22 nF |
| Lens current | **INA219** (0x40) over 20 mΩ | jammed servo or short shows up as current |
| 9 V / 5 V / 3.3 V | LM317 (9.06 V for LM324 + CD4066), AP63205 (5 V for ESP32 + remote), AP2112K-3.3 (quiet analog 3.3 V) | |
| Analog | MCP4728 (0x60), ADS1115 (0x48), LM324: iris stage as on the bench, zoom/focus `REF + 1.8·(V_B/D − V_C)` with 100k/180k | |
| Outputs off at start | **CD4066** in iris, zoom, focus and remote; closes only when the firmware sets `OUT_EN` | no twitch while the ESP32 boots |
| VTR / RET | On-board buttons, JST **BUTTONS** for external ones (with LED), lens grip pins 1/2 through Schottky (wired-OR) | |
| Tally | 2 × 12 V low-side outputs (AO3400, 0.5 A PTC), 1 optocoupled input (PC817, 5–24 V) | for box lenses / tally lamps |
| Pots | 3 on-board (Alps RK09K) + 3 JST, jumper per axis | |

## Connectors

| Ref | Label | Pins (1 → n) |
|---|---|---|
| J3 | LENS | 6 +12 V · 3 GND · 5 iris · 7 iris pos · 8 remote · 10 zoom pos · 11 focus pos · 1 RET · 2 VTR · 12 |
| J4 | ZOOM DEMAND | GND · 6 (speed) · 7 (5 V ref) · 9 (position) of the black grip socket |
| J5 | FOCUS DEMAND | GND · control · ref · position (**to be measured**) |
| J6 | OLED | GND · 3V3 · SCL · SDA |
| J20 | BUTTONS | 5 V · LED (cathode, 150 Ω on board) · VTR · RET · GND |
| J21 | TALLY | 12 V · red (low-side) · green (low-side) · IN+ · IN− |
| J22–J24 | EXT POT | 3V3 · wiper · GND |

## ESP32: one block, two boards

DevKit V1 rows at x0 and x0 + 22.86 / 25.40 / 27.94 mm (fit **one** of the
three VIN-row sockets); Waveshare ESP32-S3-ETH rows at x0 + 2.54 and
x0 + 20.32, turned 180° (RJ45 towards the bottom edge). **Fit only one board.**
The DRC reports the overlapping header courtyards — intended.

| Signal | DevKit GPIO | S3-ETH GPIO |
|---|---|---|
| SDA / SCL | 21 / 22 | 16 / 17 |
| Pot iris / zoom / focus | 34 / 35 / 36 | 1 / 2 / 3 |
| CHG_INT (charger) | 39 | 18 |
| OUT_EN (CD4066) | 25 | 15 |
| LENS_OFF (eFuse) | 26 | 38 |
| Tally red / green / in | 27 / 14 / 32 | 39 / 40 / 41 |
| Button VTR / RET / LED | 33 / 13 / 4 | 42 / 47 / 48 |
| eFuse fault | 16 | 44 |
| Status LED | 19 | 43 |

## Firmware this board needs

* `OUT_EN` high only after the DAC holds sane values (iris at the measured
  position, B = C = D = mid-scale).
* Zoom/focus: DAC C fixed at 2048, speed = DAC B/D − DAC C.
* BQ25798 over I²C (0x6B): watchdog off or fed, charge current, ADC for
  VBAT/VSYS; **ship mode below ~6.4 V pack** (cell undervoltage is software).
* INA219 lens current on the status page; `LENS_OFF` on overcurrent.
* Tally, VTR/RET, OLED.

## Regenerate

```
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
    hardware/b4-carrier-v2/generate_pcb.py --route
```

Takes ~20 minutes. Steps:

1. `generate_pcb.py`: places the blocks (charger core by hand, a legaliser
   pushes passives off anything they land on and off the holder pegs), draws the
   charger fan-out, then `power_trunks.py` lays the wide power paths on B.Cu
   (grid router, locked).
2. Freerouting routes the rest on all four layers.
3. `fixup.py`: removes dead copper, routes what Freerouting left open with a
   clearance-checked four-layer grid router (rip-up and retry), removes stray vias.
4. `postprocess.py`: power pours, GND stitching vias, width report, moves
   reference designators to free spots (the ones that do not fit stay on F.Fab,
   i.e. in `fab/top-assembly.pdf`).

Freerouting is not deterministic: a new run gives a different (also DRC-clean,
check it) layout.

## Before ordering

1. Check every connector against the parts you have (OLED pin order varies).
2. Check the polarity print of the holders (pad 1 = +) and the cell orientation.
3. Run the DRC once more in KiCad after any change.
4. 4 layers, 1.6 mm, ENIG, SMT assembly top (`fab/bom-smt.csv`,
   `fab/cpl-smt.csv`); holders, headers, JSTs, pots and DC jack by hand.
5. Inductor saturation currents (L1 ≥ 8 A, L2 ≥ 6 A) are what matters when
   PCBWay offers alternatives.
