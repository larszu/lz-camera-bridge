# 2026-10-10 · Bench · amplifier sweep without lens

Amplifier stage for Hirose pin 5, measured with the lens **not** connected to
pin 5 (lens otherwise powered on the bench).

## Conditions

- LM358P on breadboard, supply from a 330 Ω / 1 kΩ divider off 12 V (no
  regulator in stock). Ra = 10 kΩ + 5.6 kΩ in series (no 16 kΩ in stock),
  Rb = R1 = R2 = 10 kΩ, 1 kΩ series output.
- DAC: MCP4728 channel A, VDD 3.3 V reference, set with the bench console
  command `d<code>` (`env:esp32-devkit-armed`, drive not armed).
- Readback: amplifier output behind the 1 kΩ, through 100 kΩ / 56 kΩ to ADS1115
  A3, converted by hand (firmware assumes 100k/68k, factor 156/56 · 68/168).
  Known ≈ 0.1 V ground offset at the ADC not corrected.

## Results

| DAC code | Vdac | Vout measured | Vout expected (1.219·Vdac + 2.58) |
|---|---|---|---|
| 0 | 0.00 | 2.51 | 2.58 |
| 512 | 0.41 | 3.02 | 3.08 |
| 1024 | 0.83 | 3.53 | 3.59 |
| 1536 | 1.24 | 4.04 | 4.09 |
| 2048 | 1.65 | 4.56 | 4.59 |
| 2560 | 2.06 | 5.07 | 5.09 |
| 3072 | 2.48 | 5.58 | 5.60 |
| 3584 | 2.89 | 6.10 | 6.10 |
| 4095 | 3.30 | 6.59 | 6.60 |

Linear over the full range, within 0.07 V of the design line. The top end
reaches 6.6 V with the 9 V divider supply, so the LM358 headroom is enough.

## Failures on the way (worth keeping)

- LM358 first inserted reversed (pins 4/8 swapped): divider collapsed to 0.9 V,
  pin 3 at 0.13 V, output ≈ 0.6 V. Rotating the chip fixed it.
- Resistor leg without contact in the breadboard read OL in circuit, 5.6 kΩ out
  of circuit.
- A3 divider top on 12 V by mistake: A3 at 4.2 V, ADC pinned at full scale.
- Divider bottom 1.2 kΩ left over from an earlier value.

## Open

- Fault test: pull R1, output must stay ≤ ≈ 7.5 V.
