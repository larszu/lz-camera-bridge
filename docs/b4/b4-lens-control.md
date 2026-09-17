# B4 Lens Control Reference

Working notes on controlling 2/3" B4 broadcast lenses (Fujinon, Canon) over the
Hirose 12-pin camera connector — analog and digital.

> **Status: unverified.** Everything below is compiled from third-party reverse
> engineering, not from manufacturer documentation. The upstream authors state
> their findings may be wrong. Verify against your own hardware before driving
> anything.

**Sources**
- <https://github.com/yasdfgr/fujinon-tv-lens-control> — protocol spec, pinout,
  UART parameters. Derived from a Fujinon XA20sx8.5BERM-K3.
- <https://github.com/s73ampunkca7/fujinon-tv-lens-control> — fork, adds hardware
  design and an ARIB standards survey.
- ARIB BTA S-1005 *Interconnection for HDTV Studio Equipment* — the original B4
  standard. Japanese only, paid. Describes analog and digital configurations of
  the 12-pin connector; its digital protocol was apparently never implemented.
- ARIB TR-B37 — newer, describes the hardware-level signal interface, but not the
  protocol on pins 11/12.

---

## 1. Lens groups

Three interface generations exist in the field:

| Group | Interface | Identification |
|---|---|---|
| **A** | True RS232-style serial, external port | Extra handshake pins next to TX/RX (CTS, DTE). Follows the DIGI POWER **L10** protocol. |
| **B** | Digital serial inside the 12-pin B4 connector | TX/RX on pins 11/12, alongside the legacy analog signals. Originally a Sony development, never published — but the frame format is identical to L10. |
| **C** | Analog only | No serial at all on the 12-pin connector. |

Group A has vendor demo software available, which is how the L10 command set was
observed. Because B reuses the L10 frame, work on either group transfers.

---

## 2. Hirose 12-pin pinout

Two configurations of the same connector. Pins 1–10 are identical; 11 and 12
differ.

| Pin | Analog only (C) | With serial control (B) | Direction |
|---|---|---|---|
| 1 | RET SW — return video select (off: open, on: 0 V) | same | lens → cam |
| 2 | VTR SW — record start/stop (idle: open, trigger: 0 V) | same | lens → cam |
| 3 | GND | same | cam → lens |
| 4 | Iris servo (off: 0 V, on: 5 V) | Iris auto enable | cam → lens |
| 5 | Iris control signal | same | cam → lens |
| 6 | Power, +12 V | same | cam → lens |
| 7 | Iris position | same | lens → cam |
| 8 | Iris mode (auto: 0 V, remote: 5 V) | same | cam → lens |
| 9 | Extender signal (out: open, in: 0 V) | same | lens → cam |
| 10 | Zoom position | same | lens → cam |
| 11 | Focus position | **TXD** (lens transmit, 0 V / 5 V) | lens → cam |
| 12 | — | **RXD** (lens receive, 0 V / 5 V) | cam → lens |

Pin 8 selects whether the lens obeys its own auto-iris or the camera. Remote
control of iris requires 5 V here.

### Analog signal levels

| Signal | Low end | High end |
|---|---|---|
| Iris control (pin 5) and iris position (pin 7) | closed 2.5 V | F16 3.4 V, F2.8 6.2 V |
| Zoom position (pin 10) | wide 2 V | tele 7 V |
| Focus position (pin 11, group C) | near 2 V | infinity 7 V |

Note there is **no analog zoom or focus drive input** on this connector. Only
iris can be commanded in the analog domain. Zoom and focus drive go through the
lens's own demand sockets, or through the serial protocol on group B.

---

## 3. Serial parameters (group B, pins 11/12)

| Parameter | Value |
|---|---|
| Baud rate | 78400 |
| Format | 8N1 |
| Levels | TTL, 0–5 V |
| Polarity | **inverted** — logical 0 is 5 V, logical 1 is 0 V |

The inversion means a plain RS232 transceiver (MAX232) reads the line correctly
without extra logic, since RS232 is itself inverted. It tolerates the 0–5 V swing
despite expecting ±12 V.

> **Do not connect TX to the camera or the lens** while experimenting. Read-only
> first. Two transmitters on one line will fight.

---

## 4. Frame format

```
<length> <cmd> <data 0..14> <crc>
```

- `length` — number of data bytes following the command byte, 0x00–0x0F.
- `cmd` — command / function code.
- `data` — 0 to 15 bytes, may be absent.
- `crc` — checksum.

**CRC**: sum all bytes starting with the length byte, then take the low byte of
`0x0100 - sum`.

Examples:

```
00 53 XX                                  minimal frame, no data
0A 53 01 02 03 04 05 06 07 08 09 0A XX    frame with 10 data bytes
```

---

## 5. Command set

The camera acts as host and polls; the lens answers using the same command code
it received.

### Identification and capabilities

| Code | Function | Request | Response |
|---|---|---|---|
| 0x01 | Connect | 0 bytes | 0 bytes. Sending 1 data byte instead forces a lens reset (lenses without reset support answer with a 0-byte frame). |
| 0x11 | Lens name, first half | 0 | 0–15 ASCII bytes. Full name up to 80 chars. If this returns 15 bytes, request 0x12 for the rest. |
| 0x12 | Lens name, second half | 0 | 0–15 ASCII bytes |
| 0x13 | Open F number | 0 | 2 bytes. 0x10000 ≙ F1.0, 0x1000 per stop. `FNo = 2^(8*(1 - data/0x10000))` |
| 0x14 | Tele-end focal length | 0 | 2 bytes |
| 0x15 | Wide-end focal length | 0 | 2 bytes |
| 0x16 | MOD (minimum object distance) | 0 | 2 bytes |

### Control (host → lens)

| Code | Function | Data | Range |
|---|---|---|---|
| 0x20 | Iris control | 2 bytes | 0x0000 closed … 0xFFFF open |
| 0x21 | Zoom control | 2 bytes | 0x0000 wide … 0xFFFF tele |
| 0x22 | Focus control | 2 bytes | 0x0000 MOD … 0xFFFF infinity |
| 0x42/0x43/0x44 | Switch 2/3/4 control | 1 byte | — |
| 0x70 | Multiple data setting | 1–4 bytes | — |

All control commands are acknowledged with a 0-byte response.

### Readback (lens → host)

| Code | Function | Response | Range |
|---|---|---|---|
| 0x30 | Iris position | 2 bytes | as 0x20 |
| 0x31 | Zoom position | 2 bytes | as 0x21 |
| 0x32 | Focus position | 2 bytes | as 0x22 |
| 0x52/0x53/0x54 | Switch 2/3/4 position | 1 byte | — |
| 0x60 | Multiple data | 1–7 bytes | — |

### Idle

With no communication running, the lens reportedly emits `FB 03`.

> **Conflict in the source.** The upstream README's main command table lists
> 0x20 iris / 0x21 zoom / 0x22 focus, but a later prose section lists
> 0x21 iris / 0x22 focus / 0x23 zoom. Resolve this by observation before
> transmitting anything. The table is the more complete and internally
> consistent of the two.

---

## 6. Implementation notes (ESP32)

- **Baud rate.** 78400 is non-standard but the ESP32 UART derives arbitrary rates
  from its clock divider. No special handling needed.
- **Inversion.** Handle in hardware via the UART's signal inversion setting
  rather than inverting in software — this keeps the peripheral's framing and
  break detection correct.
- **Level shifting.** Lens side is 0–5 V, ESP32 GPIOs are 3.3 V and not
  5 V tolerant. A divider works for RX; use a proper level shifter for TX.
- **Analog iris.** DAC (e.g. MCP4728, I²C) into a non-inverting op-amp stage
  scaling 0–3.3 V up to roughly 2.5–6.5 V, powered from the lens's 12 V rail.
  Read pin 7 back through a divider into a 16-bit ADC (e.g. ADS1115) to close the
  loop. Series resistors (~1 kΩ) on every line going into the lens.
- **Common ground.** If powering the lens from a separate supply, tie its ground
  to the ESP32 ground or the analog references are meaningless.
- **Wiring harness.** Cut a 12-pin Hirose male-to-female extension cable in half
  rather than sourcing bare connectors. Gives you an inline tap for sniffing and
  both genders for later.

---

## 7. Open questions

- **Canon.** The upstream author could not confirm a serial interface on Canon
  lenses and suspected there is none; the fork author claims Canon does provide
  one but may use a different protocol, and has not tested it. Canon evidence
  from elsewhere suggests digital communication exists: Panasonic's AK-UCX100
  drives phase-detect autofocus on B4 lenses and reads lens correction data, and
  supports remote back focus — all of which imply bidirectional command traffic.
  Unresolved whether the frame format matches.
- **Sony's LA-EB1** B4 adapter states it supports only lenses with serial digital
  communication, carries servo zoom and the REC trigger, and surfaces iris and
  focus as metadata — but explicitly does *not* do autofocus. Suggests focus
  *drive* may need commands beyond what the readback path uses.
- **Box lens demands.** Canon digital demands (ZDJ-D02 zoom, FDJ-D02 focus) for
  DIGISUPER lenses use an 18-pin connector and their own protocol. Canon's
  BDC-10 conversion cable bridges 18-pin to the 20-pin digital drive standard,
  which is a far better documented and cheaper world to work in. Unknown whether
  the BDC-10 is passive rewiring or contains electronics — if passive, measuring
  it yields the 18-pin pinout for free.
- **Command codes 0x42–0x44 / 0x52–0x54** ("switch 2/3/4") are undocumented as to
  what they actually switch.

---

## 8. Prior art

- **Fujinon L10 controller software** — <https://imagelabs.com/imaging-system-components/security/fujinon-lens-controller-software/>
- **Skaarhoj ETH-B4-Link** — commercial B4 lens control over Ethernet
- **Levitezer B4 control box** — commercial
- **CyanView** B4 lens integration — <https://support.cyanview.com/docs/Integrations/Lens/B4Lens>

## 9. Tooling used by the upstream research

- PicoScope 2204A USB oscilloscope with RS232 decoding
- PulseView (sigrok) for logic analysis
- csv2vcd to convert PicoScope exports into PulseView — <https://github.com/feecat/csv2vcd>
- YAT (Yet Another Terminal) for binary protocol work
