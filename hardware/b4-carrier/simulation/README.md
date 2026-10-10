# Simulation of the carrier's analog stages (ngspice)

Run: `cd hardware/b4-carrier/simulation && for f in *.cir; do ngspice -b $f; done`.
The op-amp is a behavioural LM324 section (`opamp.lib`): gain 1e5, output from
0.02 V to V+ − 1.5 V. DC only — enough for these stages.

## Iris stage vs. the bench (2026-10-10)

Board values (Ra 10k + 5.6k, Rb 10k, R1 = R2 = 10k, 1k out), 3.3 V quiet supply,
lens pin 5 as 100 kΩ.

| DAC code | Sim pin 5 | Bench pin 5 | Δ | Sim ADC A3 |
|---|---|---|---|---|
| 0 | 2.54 V | 2.51 V | +0.03 | 1.03 V |
| 1024 | 3.53 V | 3.53 V | 0.00 | 1.43 V |
| 2048 | 4.52 V | 4.56 V | −0.04 | 1.83 V |
| 3071 | 5.51 V | 5.58 V | −0.07 | 2.23 V |
| 4095 | 6.50 V | 6.59 V | −0.09 | 2.63 V |

Within 0.1 V. The bench ran its offset and DAC from the ESP32's 3.4 V instead
of 3.3 V, which explains the slightly higher bench values at the top. A3 stays
below 2.7 V, inside the ADS1115's range.

## Zoom stage: why the stop wandered, and the fix

Lens pin 6 modelled as the grip's own 5.0 V neutral behind an unknown internal
resistance (2.2 k / 10 k / 47 k), lens pin-7 reference behind 1 kΩ (assumed).

| | Breadboard stage (offset from the 9 V divider) | Carrier stage (difference amp on pin 7) |
|---|---|---|
| Pin-6 shift per volt of "9 V" at a fixed DAC code | **227 mV/V** | **0 mV/V** |
| Stop position | depends on the 9 V, the 12 V input and the load | DAC B = DAC C, for every internal resistance tried |
| Range at pin 6 (Rint 10 k) | — | 2.3 … 7.2 V |

The bench's stop codes 1270 → 1282 → 1560 → 1790 are what a 227 mV/V
sensitivity does with a divider-fed 9 V that sags under motor current.

With 10k/18k the carrier stage pulled the lens reference down by ≈ 0.1 V
through the assumed 1 kΩ, so the stop sat at DAC B = 1.70 V instead of 1.65 V.
**100k/180k** (now on the board) brings that to 11 mV and the stop back to
DAC B = DAC C.

Tolerance (Monte Carlo, 5000 runs, 1 % resistors, LM324 offset ±7 mV): the
stop lies within ±34 mV of DAC B = DAC C (±42 codes). That is a fixed offset the
firmware stores once; it no longer drifts.

## Not simulated

The lens servo itself, motor currents on the ground, the PD negotiation, and
the switcher's ripple. Measure those on the first board.
