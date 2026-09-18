# Firmware runtime: Arduino-ESP32, not ESP-IDF

**Decided 2026-09-18.** Settles the first of the two points
[`README.md`](README.md) records as left open by ADR-008.

## The criterion in ADR-008 does not survive checking

`README.md` states the runtime is not a matter of taste:

> The serial line runs inverted, and the inversion belongs in the UART's
> hardware setting, not in software.

The premise is right and the conclusion does not follow. **Arduino-ESP32
exposes exactly that hardware setting.** `HardwareSerial::begin()` takes a
`bool invert` parameter, and there are `setRxInvert()` / `setTxInvert()` beside
it; all of them call ESP-IDF's `uart_set_line_inverse()` with
`UART_SIGNAL_RXD_INV` / `UART_SIGNAL_TXD_INV`. It is the same register bit,
reached through a thinner wrapper. Arduino-ESP32 *is* ESP-IDF with a layer on
top — FreeRTOS is present either way.

So the one argument that was supposed to decide this does not distinguish the
two at all.

## What does decide it: the hardware that exists

The hardware is fixed, not a plan. One ESP32, and a parts order that arrives
2026-09-23:

| | |
|---|---|
| Board | Waveshare ESP32-S3-ETH, read off the unit over USB — ESP32-S3 (QFN56) rev v0.2, 16 MB flash, 8 MB octal PSRAM, W5500, MAC `3c:0f:02:d7:8a:40` |
| DAC | MCP4728 |
| ADC | ADS1115 |
| Op-amp | LM358P, from a DIP-8 assortment |
| Cable | 12-pin Hirose extension, 30 cm, to be cut |
| Also ordered | 8-channel 24 MHz logic analyzer (FX2, sigrok-native) |

Three consequences, in order of weight:

**1. The two I²C parts have mature Arduino libraries.** Adafruit ships both.
Under ESP-IDF both become hand-written I²C drivers. That is a week of work that
buys nothing: neither part sits on a hot path, and neither needs a register the
libraries hide. There is one board and five days.

**2. The logic analyzer removes the ESP32 from the serial question entirely.**
This is the point that dissolves the original criterion rather than arguing
with it. When the serial line on pins 11/12 is first examined, the instrument
will be sigrok and PulseView on the FX2 — not a UART peripheral on the S3. The
firmware does not need to decode anything to find out what is on that wire, so
the quality of its UART abstraction is not on the critical path for phase 2.

**3. The lens on the bench probably has no serial line at all.** A **Canon
J15ax8B4 IRS SX12**, SD-era ENG glass, is expected to be group C: pin 11 carries
focus position as an analog voltage and pin 12 is unused.
[`wiring.md`](wiring.md) §1 gives the five-minute measurement that settles it.

Point 3 is an expectation and could be wrong. Points 1 and 2 hold regardless.

## Decision

**Arduino-ESP32 core 3.x**, built with PlatformIO against the `pioarduino`
platform fork, which is what currently packages core 3.x. Core 3.x rather than
2.x is not cosmetic: `ETH.begin(ETH_PHY_W5500, …)` is native there, where
2.0.11 — the version the board's factory demo was built with — needed LilyGO's
out-of-tree `ETHClass`.

## Revisit this if

- The pin 11 measurement says **group B**, *and* the decision is made to decode
  the protocol on the ESP32 rather than on the logic analyzer. Even then the
  inversion is available; what would need re-checking is framing and break
  detection under the Arduino layer, which is a narrower question than the
  runtime.
- A second board arrives, making a parallel ESP-IDF build cheap to try.

## One fact that holds under either runtime

**The ESP32-S3 has no DAC.** The original ESP32 and the S2 have two 8-bit DACs;
the S3 has none. The external MCP4728 is therefore mandatory rather than
convenient, and PWM plus a low-pass is not an acceptable substitute for an iris
setpoint on a lens of this value.

## The pin map, because a generic S3 pinout will mislead

Read off Waveshare's wiki for this board and cross-checked against the ESPHome
configuration for it.

| Function | GPIO |
|---|---|
| W5500 Ethernet | 9 RST, 10 INT, 11 MOSI, 12 MISO, 13 SCLK, 14 CS |
| TF card | 4 CS, 5 MISO, 6 MOSI, 7 SCLK |
| RGB LED (WS2812) | 21 |
| Camera header | 1, 2, 3, 15, 18, 38, 39, 40, 41, 42, 45, 46, 47, 48 |
| Native USB | 19, 20 |
| SPI flash | 26–32 |
| **Octal PSRAM** (S3R8) | **33–37** |

**Free: 8, 16, 17, and 43/44** (the UART0 pins, available because the console
runs over native USB-CDC). I²C uses 16 and 17.

Two of these are worth stating as warnings rather than as a table row. The
octal PSRAM claiming 33–37 appears on no generic S3 pinout. And **GPIO 9 is the
W5500's reset** — an earlier revision of this firmware used it as I²C SCL,
which would have held the Ethernet controller in reset while presenting as
"no network", a symptom nobody traces back to an I²C setting.

## Sources

- [Arduino-ESP32 Serial (UART) API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/serial.html)
- [`HardwareSerial.cpp`](https://github.com/espressif/arduino-esp32/blob/master/cores/esp32/HardwareSerial.cpp) — the `invert` path into `uart_set_line_inverse()`
