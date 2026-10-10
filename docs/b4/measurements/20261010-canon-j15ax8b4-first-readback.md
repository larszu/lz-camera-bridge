# 2026-10-10 · Canon J15ax8B4 IRS SX12 · first readback (iris, zoom, focus)

First measurement on real glass. Until today every figure in this repo was
from other people's work or the simulator.

## Conditions

- **Lens:** Canon J15ax8B4 IRS SX12. Serial not noted. Extender: not noted.
- **Connected:** lab supply 12 V (limit 1.0 A) on Hirose pin 6, GND on pin 3.
  Pins 7 / 10 / 11 to ADS1115 A0 / A1 / A2, each through 100 kΩ / 68 kΩ.
  Pin 4, 5, 8, 12 open. **No camera.** MCP4728 not fitted.
- **Instrument:** ADS1115 (`0x48`) on an ESP32-DevKit, firmware
  `env:esp32-devkit` (drive not compiled in), read over USB with the `s`
  console command, ~2.5 samples/s. Volts are lens-side, converted through the
  nominal divider ratio, resistor tolerance not corrected.
- **Iris switch:** M, ring turned by hand.
- Supply current: not recorded. Servo started audibly on power-up.

## Results

Raw data: [`20261010-canon-j15ax8b4-first-readback.csv`](20261010-canon-j15ax8b4-first-readback.csv).

| Signal | Pin | Measured | Expected (ARIB TR-B37) | Match |
|---|---|---|---|---|
| Iris, closed | 7 | **1.83 V** | 1.5–2.9 V (closed band) | yes |
| Iris, fully open (F2.8 on this lens) | 7 | **6.88–6.93 V** | F2.8 6.2 V | **no, ~0.7 V higher** |
| Zoom, wide | 10 | **1.62–1.66 V** | 2.0 V | ~0.35 V low |
| Zoom, tele | 10 | **6.80 V** | 7.0 V | roughly |
| Focus | 11 | **−0.24 to −0.47 V** | 2–7 V (group C) | **failed: input floating** |

Iris sweep, closed and back: 6.88 → 1.83 → 6.88 V within about 4 s, smooth,
no steps (CSV rows t = 5.3–9.8 s).

## Failures and oddities

- **Focus never read.** Negative counts on a single-ended ADS1115 input mean
  nothing drives it; the pin 11 wire or its divider was not connected. Group
  (B or C) is therefore **still open**.
- **Common-mode dips.** All three channels drop together for single samples
  (e.g. t = 15.6 s, 22.1 s in the CSV; −0.1…−0.2 V each). Suspected loose
  ground on the breadboard; not confirmed.
- **Pin numbering trap on the bench:** pin 3 and 6 were first identified the
  wrong way round, because the socket is numbered mirror-image to the plug.
  Not recorded whether power was applied in that state; the lens works. See the
  connector drawing in `iris-anleitung`.

## Open

- Focus on pin 11 → settles group B / C.
- Repeat the iris sweep slowly with the extender state noted; check whether
  6.9 V at F2.8 is this lens or the divider tolerance (measure the resistors).
