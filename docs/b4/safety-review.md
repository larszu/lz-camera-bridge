# Safety review before the first connection to a lens (#41)

A broadcast lens costs four to five figures; one wrong control pin destroys
its servo electronics. This is the form to fill in **at the built board**,
not at the schematic. The release is **Lars's decision** and his signature at
the bottom; this document prepares it, it does not give it.

Fill in with a pen, then file a photo or a transcription under
[`measurements/`](measurements/) — including the rows that showed something
unexpected.

## A. Prepared in the documents (desk check, done 2026-09-27)

| Check | Result |
|---|---|
| Amplifier stage formula against the resistor placement | **Error found and fixed.** `wiring.md` and the workshop sheet had 10k from 3.3 V and 16k from the DAC under a formula that only holds the other way round. As drawn, the stage gives 4.06–6.60 V instead of 2.54–6.60 V. Now: **Ra = 16k from 3.3 V, Rb = 10k from the DAC**. Issue #39's text still shows the old placement. |
| Readback divider 100k / 68k (was 10k / 6k8 — below the ARIB ≥ 20 kΩ load) | 7.00 V at the pin → 2.83 V at the ADC; below the ADS1115's absolute maximum VDD + 0.3 V (TI datasheet) at 3.3 V supply |
| I²C pins | GPIO 16/17; the earlier 8/9 collided with the W5500 reset (GPIO 9) — fixed in `config.h` |
| Default firmware drives nothing | `B4_ENABLE_IRIS_DRIVE` 0; CI proves the drive build differs and the safe build refuses `POST /api/iris` with 409 |
| Serial TX | not in any default build; CI proves `B4 TX:` is absent from the safe and the iris build (after the serial PR is merged) |

## B. At the built board — lens NOT connected

| # | Rule | How to prove it | Measured | OK | Who / date |
|---|---|---|---|---|---|
| 1 | Continuity: **no** connection between +12 V (Hirose pin 6) and any ESP32 pin | meter in continuity mode, pin 6 against every wired GPIO, 3V3 and 5V | | | |
| 2 | Common ground: 12 V supply GND, Hirose pin 3 and ESP32 GND connected | continuity | | | |
| 3 | **1 kΩ in series in every line towards the lens** (pin 5; pins 4/8 if driven; pin 12 if ever used) | measure each series resistor in circuit, lens side to driver side | | | |
| 4 | Amplifier: DAC code 0 → output | expect ≈ 2.54 V. **≈ 4.06 V means Ra/Rb are swapped** | | | |
| 5 | Amplifier: DAC code 4095 → output | expect ≈ 6.60 V | | | |
| 6 | Amplifier linear in between | 5 points, plot or table | | | |
| 7 | Readback divider: 7.0 V from a bench supply at the lens-side input | expect ≈ 2.83 V at the ADS1115 pin, never above 3.3 V | | | |
| 8 | 5 V lines (pins 4/8) not on any GPIO directly | only via MOSFET/level shifter, or hard-wired to 5 V | | | |
| 9 | Serial TX not connected (group B only) | wire physically absent or jumper pulled | | | |
| 10 | Firmware flashed is the safe build for the first power-up | `/api/status` → `driveCompiledIn: false` | | | |

## C. Passive, lens connected, nothing driven

| # | Step | Expectation (unverified source values) | Measured | OK |
|---|---|---|---|---|
| 11 | Lens on 12 V only | lens powers up, servo audible | | |
| 12 | Pin 7 while turning the iris by hand | steady, roughly 2.5–6.2 V (Fujinon reconstruction; Canon unknown) | | |
| 13 | Pin 10/11 while zooming/focusing | steady 2–7 V → group C (#38) | | |

## D. Release

| | |
|---|---|
| Every row in B and C done at the real board | ☐ |
| Every unexpected reading written down in `measurements/` | ☐ |
| Second pair of eyes **or** at least one day between build and first drive | ☐ — by: ______ / date: ______ |
| **Released for the first drive of pin 5** | ☐ Lars Zumpe, date: ______ |

Only after this: flash `env:waveshare-esp32-s3-eth-armed`, continue with
`wiring.md` §4 step 5.
