# Carrier board v2 — decisions and lessons (2026-10-11/13)

Companion to [`hardware/b4-carrier-v2/README.md`](../../hardware/b4-carrier-v2/README.md).

## Which connector does what

| Connector | Direction | Why it exists |
|---|---|---|
| LENS (Hirose 12) | board → lens | Iris is the only *control* input on the 12-pin (pin 5, remote pin 8). Zoom and focus only report their position there (pins 10/11). Also VTR/RET (1/2) and 12 V. |
| ZOOM DEMAND | board → grip (black socket) | The lens servo takes the zoom command only on its demand socket: pin 6 speed, pin 7 5 V reference, pin 9 position. The board plays the zoom demand. |
| FOCUS DEMAND | board → grip (white socket, focus module) | Same principle for focus. Pinout **not measured**. |
| IRIS / ZOOM / FOCUS (JST 3-pin) | pot → board | **Inputs** for external pots (3V3, wiper, GND), selected per axis by a jumper against the on-board pots. Not a second iris output. |
| BUTTONS, TALLY, OLED | | external VTR/RET buttons with LED, tally in/out, display |

## Design decisions

* D+ and D− of the BQ25798 are tied together at the pins (BC1.2 "dedicated
  charger"); USB data is not needed because the CH224A negotiates 12 V PD.
  The firmware sets the input current limit.
* Charger core laid out by hand: U2 turned so SW1/SW2 face L1, PMID/SYS caps on
  short buses, PGND via pair between the SW nodes, PROG resistor and charge LED
  directly at their pins.
* Main current paths are locked 1.5–2 mm tracks on B.Cu (`power_trunks.py`),
  ending on via groups at the charger's VBAT and CHG_IN pins and at the eFuse
  input. Current capacity is **estimated** (IPC-2152), not measured.

## Layout lessons (for the next board)

* Freerouting cannot neck down and cannot use a plane layer properly → power
  nets must be pre-routed and widened with pours afterwards.
* 0.4 mm-pitch QFN power parts need a hand fan-out; an auto-placer packs them in.
* Never delete *locked* copper because KiCad's DRC calls it "dangling" before
  the pours exist; refill zones before judging.
* Freerouting is not deterministic: every new run gives a different layout;
  the pipeline (`fixup.py`, `postprocess.py`) closes the gaps and re-checks.
* Silkscreen: place references automatically next to the part, fall back to
  F.Fab; check board labels against pads.

## Open

* Firmware for v2 (OUT_EN gating, BQ25798 setup + ship mode, INA219, tally,
  buttons, OLED).
* Measure the focus module socket.
* Before ordering: connectors vs. real parts, holder polarity, inductor
  saturation currents; after building: measure currents/temperatures.
