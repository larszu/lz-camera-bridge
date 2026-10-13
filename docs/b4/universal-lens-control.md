# Universal lens control — goal and architecture

Status: **concept** (2026-10-13). Nothing here is built beyond the B4 bench
(iris + zoom on the Canon J15ax8B4) and the carrier boards
[`hardware/b4-carrier`](../../hardware/b4-carrier/README.md) (v1) and
[`hardware/b4-carrier-v2`](../../hardware/b4-carrier-v2/README.md).
Issues: epic #121 (#122 filter channel, #123 external motors, #124 demand inputs, #125 station to station).

## Goal

Control **focus, iris, zoom and a fourth channel "filter"** (e.g. ND wheel or
variable ND) of any lens over the network:

* **B4 / PL broadcast lenses with their own servos** — the lens motors are
  driven through the 12-pin Hirose (iris) and the grip's demand sockets
  (zoom, focus), as on the bench.
* **Lenses without motors** — external motors on the gear rings:
  Tilta Nucleus-N / Nucleus-M, ARRI, Heden, Chrosziel, DJI (RS focus motor,
  Focus Pro motor, the small USB-C motors).
* **Mixed setups** — e.g. zoom and iris through the lens servo, focus through
  a DJI motor on the ring.

Every channel is addressed the same way regardless of what moves it.

## Channels

| Channel | Value | Typical endpoints |
|---|---|---|
| 1 Focus | 0…1 (near…far), or metres once calibrated | B4 focus module / focus demand socket, external motor |
| 2 Iris | 0…1 (close…open), or T/F-stop once calibrated (`measurements/…fstop-scale`) | 12-pin pin 5 (B4), external motor |
| 3 Zoom | position 0…1 or speed −1…+1 | grip zoom socket pin 6 (speed, B4), external motor |
| 4 Filter | step (ND wheel position) or 0…1 (variable ND) | camera ND (via camera protocol), motorised filter, external motor on a VND ring |

Speed vs. position: B4 zoom servos take **speed** (the grip socket has no
position input; the position comes back on 12-pin pin 10). The firmware closes
the loop when a position is commanded (the zoom position hold already does this).

## Endpoints (outputs)

| Endpoint | Interface | Known? |
|---|---|---|
| B4 iris | analog 12-pin pin 5 (+ remote on pin 8) | **measured** on the Canon (`measurements/`) |
| B4 zoom | analog speed on the grip zoom socket pin 6, ref pin 7 | **measured** (`demand.md`) |
| B4 focus | white socket on the grip (focus module) | **not measured** — no module at hand |
| B4 digital (group B, L10-style serial) | 12-pin serial | documented in `b4-lens-control.md`, not tested |
| Tilta Nucleus-N / Nucleus-M | wireless / wired motor protocol | **unknown**, research issue |
| ARRI cforce motors | LBUS (CAN-based) | **unknown in detail**, research issue |
| Heden, Chrosziel | motor protocols | **unknown**, research issue |
| DJI RS focus motor | via DJI RS 2 / RS 3 Pro gimbal, DJI R SDK over CAN | partly: R SDK is public for the gimbal; focus via R SDK is reported for the Ronin-S by third parties, **not verified** |
| DJI Focus Pro motor | RF to hand unit, USB-C to DJI devices | **no public protocol found** |
| Camera ND / iris / focus | camera protocols (Sony, Panasonic, Canon, Blackmagic …) | many are in the Telemetrics protocol extraction (local, see below) |

## Inputs (demands)

| Input | Interface | Known? |
|---|---|---|
| Canon zoom/focus demands, analog | 8-pin zoom / focus sockets | partly (`research-canon.md`) |
| Canon demands, digital | serial | partly (`research-canon.md`) |
| Fujinon demands, analog + digital | | **to research** |
| Blackmagic Focus Demand / Zoom Demand | USB-C (to URSA Broadcast / Studio cameras) | **to research** |
| Pots on the carrier board, external pots | analog | **built** (v1/v2 boards) |
| Network (HTTP API, Companion, OSC) | Wi-Fi / Ethernet | HTTP API built for iris/zoom; Companion module in the bridge |

## Network topology

```
 demand station (carrier board #2)          lens station (carrier board #1)
 ─ Canon/Fuji/BMD demands, pots       ──►   ─ B4 lens servos (iris, zoom, focus)
 ─ sends channel values over UDP            ─ external motors (e.g. DJI focus)
                                             ─ reports positions back
            ▲                                         ▲
            └──── lz-camera-bridge / Bitfocus Companion ┘
```

* Any board can be a **lens station**, a **demand station**, or both.
* The bridge sees each board as a device with four channels; Companion
  buttons and the bridge UI write the same channels.
* Demand → lens over the network needs: low latency (UDP, ≥ 50 Hz for
  focus/zoom), a deadman timeout (the zoom deadman already exists: 400 ms),
  ownership (who controls a channel right now), and position feedback.

## Open decisions

1. Wire format station↔station (own UDP frame vs. OSC vs. the bridge bus).
2. Which external motor first (whichever protocol is documented/obtainable).
3. Hardware for external motors: CAN transceiver, USB host (ESP32-S3), RS-485 —
   the v2 board has none of these yet.

## Related findings

* Ian Morrish, *Controlling Fujinon B4 lens iris* (2019): Arduino PWM, LM358
  ×2 to 0–10 V, Fujinon A19x8.7BRM — same approach as our bench; zoom/focus not
  done there. <https://ianmorrish.wordpress.com/2019/01/19/controlling-fujinon-b4-lens-iris/>
* DJI: [ArduPilot DJI RS2/RS3-Pro (R SDK over CAN)](https://ardupilot.org/copter/docs/common-djirs2-gimbal.html),
  [RamirosLab Ronin-S CAN notes](https://github.com/videofeedback/RamirosLab/blob/main/20211223_Unreal_Engine_Motion_Control_S-Bus_CAN-Bus.md).
* Telemetrics robotics software (CF card of a decommissioned system, analysed
  locally 2026-10-13): drivers for ~31 camera models, ~20 pan/tilt heads incl.
  Telemetrics S2/S5/RM-1, tally and control panels. Protocol specs are kept
  **outside this public repo** (derived from decompiled proprietary software;
  see `telemetrics-protocols.md`).
