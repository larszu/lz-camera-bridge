# Wiring and commissioning

> **Every electrical figure on this page is unverified.** It comes from
> third-party reverse engineering (see [`b4-lens-control.md`](b4-lens-control.md)),
> whose authors state their findings may be wrong. Measure your own lens before
> connecting or driving anything. A wrongly wired control pin destroys the
> servo electronics.

---

## 0. Safety rules, before any of the steps

| Rule | Why |
|---|---|
| 1 kΩ in series on every line going **towards** the lens | Limits fault current to something harmless |
| Do not connect TX on the first build | Two transmitters on one line; the protocol source says so explicitly |
| Tie the 12 V supply ground to the ESP32 ground | Without a common reference every analog reading is meaningless |
| Measure passively first, drive second | You cannot know a safe output range before you have seen the real one |
| ESP32-S3 GPIOs are 3.3 V and **not** 5 V tolerant | The lens side carries 5 V and 12 V. Without a divider the chip is dead |

**The single most expensive mistake available here is Hirose pin 6.** It carries
+12 V. Label that wire before you label any other, and keep it out of the
breadboard row that feeds anything.

**The socket is numbered mirror-image to the plug.** Counting from the wrong
side swaps pin 3 and pin 6, so 12 V lands on ground. The mix-up happened on the
bench (2026-10-10). Before powering anything, confirm pin 3 by continuity to
the connector shell or lens housing.

---

## 1. First: which group is your lens?

This decides most of the project, costs nothing, and needs only a multimeter.

1. Without power, confirm **pin 3** by continuity to the housing (see the
   mirrored-socket warning above). Then power the lens from 12 V on **pin 6** against **pin 3** (GND). Nothing else
   connected. The servo should be audible.
2. Measure **pin 11** against ground while turning the **focus ring**.

| What you see | What it means |
|---|---|
| A steady voltage sweeping roughly 2 V → 7 V with the ring | **Group C.** Pin 11 is analog focus position. There is no serial. |
| A fixed level that ignores the ring | **Group B.** Pin 11 is TXD and there is a protocol on it |

For a **Canon J15ax8B4 IRS SX12** — an SD-era ENG lens — expect group C. The
protocol source could not confirm a serial interface on Canon at all, and the
digital line was a Sony development. Expect, then verify.

Record the result in `docs/b4/measurements/`, including the case where it did not
work. That file is the point of doing this.

---

## 2. Reading only — no drive, nothing to lose

Three dividers, six resistors. This is the whole of phase 1a and it is where
you should spend the first evening.

```
lens pin ──[ 100k ]──┬── ADS1115 Ax
                    │
                 [ 68k ]
                    │
                   GND  ── common with ESP32 GND and the 12 V supply
```

| Lens pin | Signal | ADS1115 channel | Range at the pin |
|---|---|---|---|
| 7 | Iris position | A0 | 2.5 V closed … 6.2 V at F2.8 |
| 10 | Zoom position | A1 | 2 V wide … 7 V tele |
| 11 | Focus position (group C only) | A2 | 2 V near … 7 V infinity |

7.00 V at the pin becomes **2.83 V** at the ADC, comfortably inside the ±4.096 V
the ADS1115 is set to. Put the **measured** resistor values into `config.h` —
a 5 % resistor is a 5 % lie about the iris, and it propagates into every
voltage the device reports.

Flash the default build (`env:waveshare-esp32-s3-eth`). It cannot drive: the
DAC is parked and `B4_ENABLE_IRIS_DRIVE` is 0. Open the device's page and turn
the rings by hand. If the numbers move sensibly, phase 1a is done.

---

## 3. Driving the iris

Only after §2 works.

```
ESP32 ──I²C──▶ MCP4728 ──▶ op-amp stage ──▶ 1 kΩ ──▶ pin 5
                (0–3.3 V)    (2.5–6.6 V)

pin 8  ──▶ 5 V   (remote, not the lens's own auto-iris)
pin 4  ──▶ per the lens's behaviour
pin 6  ──▶ +12 V      pin 3 ──▶ GND, common with the ESP32
```

**Power the MCP4728 from 3.3 V, not 5 V.** Two reasons, and the second one is
the one that bites: the ESP32-S3's I²C is 3.3 V so the levels match without a
shifter, and the gain figures below assume a 0–3.3 V DAC output. At 5 V you
would need a gain of 0.82, which a non-inverting amplifier cannot produce — it
never goes below 1 — and the stage would have to be redesigned.

### The op-amp stage

A non-inverting amplifier with summing at the + input. Four resistors, one
op-amp, fed from the 12 V rail.

```
Ra = 16k   from 3.3 V        to +input
Rb = 10k   from DAC output   to +input
R1 = 10k   from −input       to GND
R2 = 10k   from output       to −input

Vp   = (Vdac·Ra + 3.3·Rb) / (Ra + Rb)
Vout = Vp · (1 + R2/R1)   =   1.231 · Vdac + 2.54
```

| Vdac | Vout |
|---|---|
| 0.00 V | 2.54 V — iris closed |
| 3.30 V | 6.60 V — iris open |

**Which resistor goes where matters.** At a summing node each source is
weighted by the *other* resistor (superposition: Vdac reaches the node through
Rb, divided against Ra). An earlier revision of this page had 10k from 3.3 V
and 16k from the DAC under the same formula — built that way the stage gives
0.769 · Vdac + 4.06, i.e. **4.06–6.60 V**, and the iris could never close. Step
4 below would have caught it on the bench; the check at 0 V DAC is 2.54 V, not
4 V.

The range only has to be approximately right. The exact voltage-to-aperture
relationship is calibrated in software, which is why no voltage appears
anywhere in the firmware's control path.

Use an **LM358**, **not a TL072.** The + input sits at 1.27 V at the bottom of
the range; the TL072's common-mode range does not reach that close to V− on a
single supply (TI datasheet), and outside it the output is unspecified — up to
jumping to the top rail.

**Limit the output.** With R1 open, an LM358 on 12 V puts about 10.5 V on pin 5.
No source gives a maximum for pin 5; the highest a product is documented to
apply is 7.5 V. Feed the amplifier from a **9 V regulator** off pin 6 (the bench build uses a 470 Ω / 1.2 kΩ divider instead, 8.6 V) (swing
then ≈ ≤ 7.5 V), and check the fault case on the bench: disconnect R1, the
output must stay below that.

Source for these and the ARIB levels: [`recherche-2026-10.md`](recherche-2026-10.md).

### Two things on the lens itself

- The **iris switch on the barrel must be at A**. In M the aperture follows the
  manual ring and ignores pin 5 completely.
- **Pin 8 must be at 5 V** (5.0 ± 0.5 V, fed through **1 kΩ**) for remote.
- **Pin 4 is "forced iris servo"**, not an enable (ARIB TR-B37). Leave it open.
- **Never leave pin 5 open while the switch is at A.** Order: amplifier output
  at ≈ 2.54 V → connect pin 5 → pin 8 to 5 V → only then switch to A.

---

## 4. Commissioning, in this order

Do not skip ahead. Each step tells you whether the next one is safe.

| Step | Action | Expected |
|---|---|---|
| 1 | Lens on 12 V only (pins 6/3), nothing else | Lens starts, servo audible |
| 2 | Iris switch on the barrel to **M** first, then measure pin 7 and turn the ring by hand. **Never turn the ring in A** — Canon warns this can damage the lens | Voltage changes smoothly; closed 1.5–2.9 V, F2.8 6.2 V (ARIB TR-B37) |
| 3 | Put pin 8 at 5 V | Lens accepts remote control |
| 4 | Measure the amplifier output **with the lens disconnected**, sweep the DAC | 2.5–6.6 V, linear |
| 5 | Only now, amplifier output through 1 kΩ to pin 5 | Aperture follows the setpoint |
| 6 | Record the curve: `python3 packages/firmware-b4/tools/record_calibration.py --host <ip>` | Table for the software calibration |

Step 4 is the one people skip. It is also the only step that catches a wrong
resistor before the wrong voltage reaches a lens.

---

## 5. Testing without any of this

The hardware is not required to develop against. `packages/firmware-b4/tools/simulator.py` serves
the same HTTP API backed by a model of a servo iris — non-linear curve, servo
lag, ADC noise, and the same refusals with the same status codes.

```bash
python3 packages/firmware-b4/tools/simulator.py --port 8080
python3 packages/firmware-b4/tools/record_calibration.py --host 127.0.0.1:8080 --points 9 --settle 0.2
```

It is a test double. It proves things about the code and nothing about a lens.
