# 3ality SPC-7000 — connector pinout (transcription)

Transcribed 2026-09-17 from `spc7000-pinout.pdf` in this folder
(*"Connector Pinout SPC-7000, Sep 21 2010, Bernie"*). The PDF is the source; this
file exists so the tables are greppable and diffable.

## Why this document matters to the B4 project

It is a **second, independent source** for two things the rest of our material
only has from reverse engineering:

1. **The 12-pin Hirose lens connector.** The SPC-7000's `ANALOG 1` / `ANALOG 2`
   connectors go to a camera body's "Lens" socket, and their pin functions match
   `b4-lens-control.md` pin for pin. That raises the pinout from *one
   reconstruction* to *two independent sources agreeing* — a commercial product
   shipped in 2010 and a 2020s reverse-engineering effort.

2. **The Fujinon B/C demand pinout.** The Umsetzungsplan (§7, *Testaufbau C*)
   still says to find the potentiometer pins with a continuity tester. This
   document gives them directly, including three voltage references and a
   `Detect` pin that the plan did not anticipate at all.

It also bears on an open question: the `DIGITAL-1` / `DIGITAL-2` connectors are
labelled for *"Preston PPA(HU3), or Preston HU2(FIZ2), or **Canon Digital
Focus/Zoom**"* and carry **RS-422**, not the 12-pin serial line. That is the
first hard evidence in our material about how Canon digital demands talk.

> **Direction convention.** The PDF describes signals from the **SPC-7000's**
> point of view ("to SPC", "from SPC"). When comparing against
> `b4-lens-control.md`, which is written from the lens/camera point of view,
> the directions read inverted. The pin *functions* are what corroborate; do
> not copy the direction words across without thinking.

> **Still unverified.** Transcription errors are possible and the device is from
> 2010. Measure before connecting anything.

---

## Left 1 — `COM OUT, Local/Rig` · 10-pin Lemo size 1B

To the rig, or looped through to a further SPC-7000.

| Pin | Function |
|---|---|
| 1 | +12 V raw to SPC from rig, fused at 1.35 A |
| 2 | Ground, common to/from SPC |
| 3 | RS-422 RA+ to SPC from rig (status stream) |
| 4 | RS-422 RB− to SPC from rig (status stream) |
| 5 | RS-422 TA+ from SPC to rig (control stream) |
| 6 | RS-422 TB− from SPC to rig (control stream) |
| 7 | RS-232 RxD to SPC (unused) |
| 8 | RS-232 TxD from SPC (unused) |
| 9 | +12 V raw to SPC from rig, fused at 1.35 A |
| 10 | Ground, common to/from SPC |

## Left 2 / Left 3 — `ANALOG 1/2, Iris` · 12-pin Hirose **male**

To the camera body's "Lens" connector. `ANALOG 1` is the right eye, `ANALOG 2`
optionally the left.

| Pin | Function (SPC-7000 sheet) | `b4-lens-control.md` | Agreement |
|---|---|---|---|
| 1 | "RET" switch from SPC | RET SW, return video select | ✅ |
| 2 | "VTR" switch from SPC | VTR SW, record start/stop | ✅ |
| 3 | Ground common | GND | ✅ |
| 4 | Auto servo to SPC | Iris servo / auto enable | ✅ |
| 5 | Analog iris **control** to SPC | Iris control signal | ✅ |
| 6 | Unreg (unused) | Power, +12 V | ✅ (unregulated supply) |
| 7 | Analog iris **position** from SPC | Iris position | ✅ |
| 8 | Auto/Manual (unused) | Iris mode (auto 0 V / remote 5 V) | ✅ |
| 9 | Extender (unused) | Extender signal | ✅ |
| 10 | Analog zoom position (unused) | Zoom position | ✅ |
| 11 | Analog focus position (unused) | Focus position **or TXD** | ✅ (analog case) |
| 12 | **Lens Tx** (unused) | **RXD** | ✅ (serial exists) |

**All twelve agree.** Two points worth keeping:

- Pin 12 is named **"Lens Tx"** here, where our serial reference calls it RXD
  (camera → lens). The naming is from opposite ends of the link; both describe
  the same wire. It confirms a serial line is present on the 12-pin even in a
  2010 analog product that did not use it.
- Only iris is wired for control. Zoom and focus appear as **position** only —
  which is exactly the Umsetzungsplan's warning that there is no analog drive
  input for zoom or focus on this connector.

## Left 4 — `ANALOG 3, R/C (F)` · 3-pin Lemo size 1B

A Preston R/C, sometimes used for focus. The simple potentiometer case.

| Pin | Function |
|---|---|
| 1 | +5.0 V reference from SPC |
| 2 | Analog wiper position |
| 3 | Ground, common to/from SPC |

## Left 5 — `ANALOG 4, B/C Focus` · 12-pin Hirose **female**

For an analog Fujinon B/C focus demand. **This is the table that replaces the
continuity-tester step in the Umsetzungsplan §7.**

| Pin | Function |
|---|---|
| 1 | +12 V raw from SPC, fused at 900 mA, to the B/C focus |
| 2 | Ground, common to/from SPC |
| 3 | **7.5 V reference** from SPC |
| 4 | **5.0 V reference** from SPC |
| 5 | **2.5 V reference** from SPC |
| 6 | **Detect** to SPC |
| 7 | **Focus analog** from the B/C focus |
| 8 | RS-485 B (unused) |
| 9 | RS-485 A (unused) |
| 10–12 | unused |

## Right 5 — `ANALOG 5, B/C Zoom` · 12-pin Hirose **female**

For an analog Fujinon B/C zoom demand. Pins 1–8 as the focus demand above; the
tail differs because the zoom demand carries the two buttons.

| Pin | Function |
|---|---|
| 1 | +12 V raw from SPC, fused at 900 mA, to the B/C zoom |
| 2 | Ground, common to/from SPC |
| 3 | **7.5 V reference** from SPC |
| 4 | **5.0 V reference** from SPC |
| 5 | **2.5 V reference** from SPC |
| 6 | **Detect** to SPC |
| 7 | **Zoom analog** from the B/C zoom |
| 8 | RS-485 B (unused) |
| 9 | "VTR" button from the B/C zoom |
| 10 | "VTR" common (ground) |
| 11 | "RET" button from the B/C zoom |
| 12 | "RET" common (ground) |

### What the three references imply

A demand fed with 2.5 V and 7.5 V rails, returning a wiper voltage on pin 7,
lands in the **2–7 V** band that `b4-lens-control.md` gives for analog zoom and
focus *position* on the lens connector. The two documents are consistent, from
different directions. 5.0 V is presumably the mid/centre reference.

**The `Detect` pin is new information.** Our own plan assumed a bare
potentiometer. Something on pin 6 tells the host a demand is plugged in — a
pull-up, a strap, or an identifying resistance. Measure it before energising
anything; a demand that is never "detected" may simply not be read.

## Right 1 — `COM IN, Remote/SIP` · 10-pin Lemo size 1B

| Pin | Function |
|---|---|
| 1 | +12 V raw from SPC, fused at 900 mA (to power an external device) |
| 2 | Ground, common to/from SPC |
| 3 | RS-422 TA+ from SPC (typically metadata) |
| 4 | RS-422 TB− from SPC (typically metadata) |
| 5 | RS-422 RA+ to SPC (3ality protocols) |
| 6 | RS-422 RB− to SPC (3ality protocols) |
| 7 | RS-232 TxD from SPC (to SIP) |
| 8 | RS-232 RxD to SPC (from SIP) |
| 9 | +12 V raw from SPC, fused at 900 mA |
| 10 | Ground, common to/from SPC |

## Right 2 / Right 3 — `DIGITAL-1/2, F|Z` · 8-pin Lemo size 1B

For a Preston PPA (HU3), a Preston HU2 (FIZ2), **or a Canon digital focus/zoom**.

| Pin | Function |
|---|---|
| 1 | +12 V raw from SPC, fused at 900 mA |
| 2 | Ground, common to/from SPC |
| 3 | RS-232 RxD to SPC (unused) |
| 4 | RS-232 TxD from SPC (unused) |
| 5 | RS-422 TB− from SPC (metadata) |
| 6 | RS-422 TA+ from SPC (metadata) |
| 7 | RS-422 RB− to SPC (FIZ2 protocol) |
| 8 | RS-422 RA+ to SPC (FIZ2 protocol) |

**Bearing on our open question about Canon.** A commercial product treats a
Canon digital demand as an **RS-422** device on an 8-pin Lemo, interchangeable
at the connector with Preston FIZ hardware — metadata outbound, demand data
inbound. It does not tell us the frame format, and it says nothing about the
12-pin lens connector. But it does mean the digital demand is a differential
serial device, not something exotic, and that an 8-pin Lemo cable is a cheaper
entry point than the 18-pin route the Umsetzungsplan describes.

## Right 4 — `ANALOG 6, DMF` · 6-pin Lemo size 1B

For a Preston DMF.

| Pin | Function |
|---|---|
| 1 | +12 V raw from SPC, fused at 900 mA, to the Preston DMF |
| 2 | Ground, common to/from SPC |
| 3 | Run On/Off from the DMF |
| 4 | Run Mom from the DMF |
| 5 | 5 V reference to the DMF |
| 6 | Zoom analog from the DMF |

---

## Follow-ups this document creates

- Measure pin 6 (`Detect`) on a real B/C demand before designing a reader.
- Decide whether the demand reader targets the **8-pin Lemo RS-422** path
  (Preston/Canon digital) rather than, or in addition to, the analog B/C path.
  The digital demand can be investigated on the bench with no lens attached.
- Cross-check the 7.5 / 5.0 / 2.5 V references against the 2–7 V position band
  once a demand is on the bench.
