# 2026-10-10 · Canon J15ax8B4 IRS SX12 · first remote iris drive

First time the iris moved under control of this project.

## Conditions

- Lens on 12 V (USB-C PD trigger, no current limit), iris switch **A**.
- Pin 8 at ESP32 VIN (USB 5 V) through 1 kΩ — level not measured.
- Pin 5 from the bench amplifier (see
  [`20261010-bench-amplifier-sweep.md`](20261010-bench-amplifier-sweep.md))
  through the 1 kΩ series resistor.
- Firmware `env:esp32-devkit-armed`, drive **not armed**, DAC set open-loop with
  the bench console `d<code>`, 2 s settle per step.
- Setpoint read back on ADS1115 A3 (100k/56k), position on A0 (pin 7, 100k/68k).
  Same ≈ 0.1 V ground offset on both, not corrected.

## Results

| DAC code | Setpoint pin 5 | Position pin 7 |
|---|---|---|
| 0 | 2.53 V | 2.62 V |
| 512 | 3.03 V | 3.10 V |
| 1024 | 3.54 V | 3.59 V |
| 1536 | 4.05 V | 4.07 V |
| 2048 | 4.56 V | 4.57 V |
| 2560 | 5.07 V | 5.07 V |
| 3072 | 5.57 V | 5.57 V |
| 3584 | 6.08 V | 6.06 V |
| 4095 | 6.58 V | 6.55 V |
| 2048 (down) | 4.54 V | 4.57 V |
| 0 (down) | 2.53 V | 2.62 V |

The lens's own iris servo follows pin 5 one-to-one (position ≈ setpoint,
max. deviation 0.09 V at the closed end), no hysteresis between up and down.
So on this Canon the pin 5/pin 7 scale is the same voltage, and the ARIB
values (closed 2.1–2.9 V, F2.8 6.2 V) hold within the bench accuracy;
the lens opens fully above ≈ 6.5 V.

## Open

- F-number per voltage (read the ring scale at several steps) → calibration table.
- Pin 8 level not measured; works with USB 5 V through 1 kΩ.
- Fault test (R1 pulled) still not done.
