# 2026-10-10 · Canon J15ax8B4 IRS SX12 · iris voltage per F-stop

## Conditions

- Lens on 12 V, iris switch **M**, ring turned by hand to each engraved mark and
  held ≈ 5 s, from the closed end stop to the open end stop.
- Pin 7 through 100 kΩ / 68 kΩ to ADS1115 A0, ~3 samples/s over USB (`s`).
  ≈ 0.1 V ground offset (see first-readback note) not corrected. Ring set by eye.
- Raw data: [`20261010-canon-j15ax8b4-fstop-scale.csv`](20261010-canon-j15ax8b4-fstop-scale.csv).

## Results

| Ring | Pin 7 (median of the rest) | ARIB TR-B37 |
|---|---|---|
| end stop beyond C | 1.87 V | closed band 1.5–2.9 V |
| C | 2.11 V | |
| 16 | 2.98 V | 3.4 V |
| 11 | 3.51 V | |
| 8 | 4.09 V | |
| 5.6 | 4.75 V | |
| 4 | 5.20 V | |
| 2.8 | 5.75 V | 6.2 V |
| 1.7 | ≈ 6.46 V (drifting 6.41–6.48) | |
| end stop beyond 1.7 | 6.93 V | |

≈ 0.55 V per stop between 16 and 2.8. The Canon sits ≈ 0.4–0.45 V **below**
the ARIB points (F16, F2.8) — so ARIB is a guide here, not this lens's scale.

## Consequence for the bench amplifier

With Ra = 15.6 kΩ the amplifier bottoms out at 2.53 V: the iris reaches about
F22 but **not C** (2.11 V). Ra = 22 kΩ (single resistor, in stock) gives
`Vout = 1.375 · Vdac + 2.06` → 2.06–6.60 V, which covers C to F1.7.

## Driven, iris switch A (same evening)

Each stop approached open-loop with the bench console `d<code>` and corrected
from pin 7 (≤ 4 steps, 1.8 s settle). Ra still 15.6 kΩ.

| Target | DAC code | Pin 7 reached |
|---|---|---|
| (DAC 0, lowest possible) | 0 | 2.62 V ≈ F22 |
| F16 2.98 V | 407 | 3.00 V |
| F11 3.51 V | 946 | 3.51 V |
| F8 4.09 V | 1537 | 4.08 V |
| F5.6 4.75 V | 2209 | 4.73 V |
| F4 5.20 V | 2706 | 5.22 V |
| F2.8 5.75 V | 3262 | 5.75 V |
| F1.7 6.46 V | 3997 | 6.46 V |

Every stop from F16 to F1.7 reached within 0.02 V. C stays out of reach until Ra
is raised (see above).
