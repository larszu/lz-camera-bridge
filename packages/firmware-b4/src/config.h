/*
 * config.h — the only file you should need to touch.
 *
 * Convention borrowed from larszu/dmx-bicolor-controller, where it earns its
 * keep for the same reason: everything that differs between one build and the
 * next lives in one place, so nobody edits control code to change a pin.
 *
 * Here it matters more than there. Hirose pin 6 carries +12 V and the ESP32-S3
 * GPIOs are 3.3 V and NOT 5 V tolerant. A wrong number in this file is not a
 * wrong colour temperature, it is a dead chip.
 *
 * EVERY ELECTRICAL VALUE BELOW IS UNVERIFIED. They come from third-party
 * reverse engineering (see docs/b4/b4-lens-control.md), whose authors state
 * their findings may be wrong. Measure your own lens before driving anything.
 */
#pragma once

// ───────────────────────────────────────────────────────────────────────────
// 1. SAFETY — read this before changing anything below
// ───────────────────────────────────────────────────────────────────────────

/*
 * The master switch for every output that reaches the lens.
 *
 * 0 = the firmware is an instrument: it reads, serves, logs, and drives
 *     NOTHING. The DAC is initialised but parked, and the enable lines stay
 *     low. This is the default and it is how phase 1 starts.
 * 1 = iris drive is compiled in. Still needs B4_DRIVE_ARMED at runtime.
 *
 * Two gates, not one, because claude-code-brief.md §3 requires a compile-time flag AND a
 * deliberate act. Flashing a build with this at 1 must not be enough to move
 * an iris the moment the cable is plugged in.
 */
/*
 * #ifndef, not a bare #define: platformio.ini's armed environment passes
 * -DB4_ENABLE_IRIS_DRIVE=1 on the command line, and a bare #define here would
 * silently override it. It did -- both builds came out byte-identical, so the
 * "armed" build was never armed and the CI job that built it was checking
 * nothing. Caught by comparing the flash figures of the two builds.
 */
#ifndef B4_ENABLE_IRIS_DRIVE
#define B4_ENABLE_IRIS_DRIVE 0
#endif

/*
 * Never transmit on the lens serial line (Hirose pin 12).
 *
 * claude-code-brief.md §3 makes this binding, and the protocol source is explicit: two
 * transmitters on one line will fight. On a group C lens there is no serial at
 * all and pin 11 is an ANALOG focus-position output — driving it would be
 * driving against the lens's own buffer. Leave this at 0.
 */
#ifndef B4_ENABLE_SERIAL_TX
#define B4_ENABLE_SERIAL_TX 0
#endif

/*
 * Listening on the lens serial line (group B, phase 2). Passive: a UART RX
 * behind a divider draws nothing a lens would notice. Off by default because
 * on a group C lens — the one this project has — pin 11 is analog focus and
 * there is nothing to hear. See §5 for pins and docs/b4/serial.md.
 */
#ifndef B4_ENABLE_SERIAL_RX
#define B4_ENABLE_SERIAL_RX 0
#endif

/*
 * The source gives two assignments for iris/zoom/focus control codes (0x20
 * iris / 0x21 zoom / 0x22 focus vs 0x21 / 0x23 / 0x22). Until capture has shown
 * which one a camera really sends (#47), the transmit path refuses 0x20–0x23.
 * Set to 1 only together with a note in b4-lens-control.md that resolves it.
 */
#ifndef B4_COMMAND_CODES_RESOLVED
#define B4_COMMAND_CODES_RESOLVED 0
#endif

#if B4_ENABLE_SERIAL_TX && !B4_ENABLE_SERIAL_RX
#error "B4_ENABLE_SERIAL_TX needs B4_ENABLE_SERIAL_RX: a sender that cannot hear the acknowledgement is guessing"
#endif

// ───────────────────────────────────────────────────────────────────────────
// 2. BOARD — Waveshare ESP32-S3-ETH
// ───────────────────────────────────────────────────────────────────────────

/*
 * WHAT IS ALREADY SPOKEN FOR ON THIS BOARD
 *
 * From Waveshare's wiki for the ESP32-S3-ETH, cross-checked against the
 * ESPHome configuration for the same board.
 *
 *   W5500 Ethernet   9 (RST), 10 (INT), 11 (MOSI), 12 (MISO), 13 (SCLK), 14 (CS)
 *   TF card slot     4 (CS), 5 (MISO), 6 (MOSI), 7 (SCLK)
 *   RGB LED          21 (WS2812)
 *   Camera header    1, 2, 3, 15, 18, 38, 39, 40, 41, 42, 45, 46, 47, 48
 *   Native USB       19, 20
 *   SPI flash        26–32
 *   OCTAL PSRAM      33–37   ← an S3R8. A generic S3 pinout will not show this
 *
 * That leaves 8, 16, 17, and 43/44 (the UART0 pins, free here because the
 * console runs over native USB-CDC).
 *
 * The camera pins are listed as taken even with no camera fitted: the header
 * is on the board, and a pin that becomes a conflict the day someone plugs a
 * sensor in is not a pin worth saving.
 */

/*
 * I²C for the MCP4728 (DAC) and ADS1115 (ADC).
 *
 * 16 and 17: an adjacent free pair from the map above, and among the very few
 * pins on this board that collide with nothing.
 *
 * These were 8 and 9 in an earlier revision, chosen as a generic ESP32-S3
 * default rather than read off this board. **GPIO 9 is the W5500's RESET.**
 * Driving it as a clock line would have held the Ethernet controller in reset
 * — and the symptom would have been "no network", which nobody would have
 * traced back to the I²C configuration.
 *
 * If the boot scan reports nothing on the bus, suspect the wiring and these
 * two numbers before suspecting the modules; the scan prints that hint itself.
 */
#ifndef B4_BOARD_ESP32_DEVKIT
#define PIN_I2C_SDA 16
#define PIN_I2C_SCL 17
#else
/*
 * Classic ESP32 DevKit (env:esp32-devkit). 21/22 are the core's default I²C
 * pair and neither is a strapping pin. Avoided on this chip: 0, 2, 5, 12, 15
 * (strapping — 12 at boot sets the flash voltage), 6–11 (SPI flash), 1/3
 * (UART0 = the USB console), 34–39 (input only). Full map:
 * docs/b4/pinout-esp32-devkit.md.
 */
#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#endif
#define I2C_CLOCK_HZ 400000

/*
 * Hirose pin 8 — iris mode. 0 V = the lens runs its own auto-iris, 5 V = it
 * accepts remote control. And Hirose pin 4 — iris servo enable.
 *
 * Both are 5 V lines and an ESP32 GPIO cannot drive them directly. Each needs a
 * level shifter or a small N-MOSFET pulling a 5 V line, with the GPIO on the
 * gate. Set to -1 if you have hardwired the line to 5 V instead, which is fine
 * for bench work and is what the wiring guide describes first.
 */
#define PIN_IRIS_MODE_REMOTE -1
#define PIN_IRIS_SERVO_ENABLE -1

// ───────────────────────────────────────────────────────────────────────────
// 3. ANALOG CHAIN
// ───────────────────────────────────────────────────────────────────────────

/* ADS1115 channels. Wire them this way or change these. */
#define ADS_CH_IRIS_POSITION 0  // Hirose pin 7,  via divider
#define ADS_CH_ZOOM_POSITION 1  // Hirose pin 10, via divider
#define ADS_CH_FOCUS_POSITION 2 // Hirose pin 11, via divider — GROUP C ONLY
#define ADS_CH_DAC_MONITOR 3    // op-amp output, via divider — optional but useful

/* MCP4728 channel that feeds the op-amp stage into Hirose pin 5. */
#define DAC_CH_IRIS 0

/*
 * Zoom speed (bench build, docs/b4/iris-anleitung.html "Aufbau 3"): MCP4728
 * channel B through LM358 half B into pin 6 of the zoom socket on the grip.
 * 5.0 V there is "stop"; the DAC code that produces it depends on the resistors,
 * so it is stored (NVS + DAC EEPROM) rather than computed. ZOOM_NULL_DEFAULT is
 * the stop measured on the bench build (Raz 56k, Rbz 10k, R1z 10k, R2z 6.8k, 1.2k into the socket). The design value was 2360 (5.0 V at the op-amp); the lens input loads the stage, so the real stop is lower.
 */
#define DAC_CH_ZOOM 1
#define ZOOM_NULL_DEFAULT 1560  // bench 2026-10-10, found by hand (earlier 1270/1282; it wanders)
#define ZOOM_DEADMAN_MS 400   // no command for this long -> back to stop
/*
 * Position hold: the stop code wanders (it hangs on the 9 V divider and the
 * lens's own reference), so a fixed code lets the zoom creep. While nobody
 * zooms, the firmware watches pin 10 and trims the stop code against drift.
 * Grip-rocker moves are recognised by their speed and followed, not fought.
 */
#define ZOOM_HOLD_ENABLE 1
#define ZOOM_HOLD_SETTLE_MS 600      // after the last command, before capturing the target
#define ZOOM_HOLD_PERIOD_MS 200
#define ZOOM_HOLD_DEADBAND_V 0.04f   // lens-side volts on pin 10
#define ZOOM_HOLD_GAIN 25.0f         // DAC codes per volt of error, per period
#define ZOOM_HOLD_TRIM_MAX 600       // codes either side of the stored stop
#define ZOOM_HOLD_MANUAL_V 0.12f     // faster than this per period = someone zooms by hand
#define ZOOM_HOLD_END_LOW_V 1.80f    // near the end stops nothing can be held
#define ZOOM_HOLD_END_HIGH_V 6.65f

/*
 * The readback divider, docs/b4/wiring.md §3.
 *
 *   lens pin ──[ R_TOP ]──┬── ADS1115 input
 *                         │
 *                      [ R_BOTTOM ]
 *                         │
 *                        GND
 *
 * With 100k/68k (ARIB TR-B37 asks >= 20 kΩ load on pin 7; 10k/6k8 was
 * 16.8 kΩ — docs/b4/recherche-2026-10.md): 7.00 V at the pin becomes 2.83 V at the ADC. Measure the two
 * resistors you actually fitted and put the real values here — this ratio sits
 * directly in every voltage the firmware reports, and a 5 % resistor is a 5 %
 * lie about the iris.
 */
#define DIVIDER_R_TOP_OHM 100000.0f
#define DIVIDER_R_BOTTOM_OHM 68000.0f

/*
 * ADS1115 full-scale range. GAIN_ONE is ±4.096 V, which comfortably covers the
 * 2.83 V the divider produces at the top of the zoom range while keeping
 * resolution at 125 µV per count.
 */
#define ADS_GAIN_SETTING GAIN_ONE

/*
 * ADS1115 data rate. The Adafruit driver defaults to 128 SPS and its
 * readADC_SingleEnded() BLOCKS until the conversion is done, so one reading is
 * about 8 ms. Eight oversamples on three channels at 128 SPS is ~190 ms — the
 * 50 ms loop below would really have run at about 5 Hz. At 860 SPS (the
 * fastest rate in TI's datasheet) the same 24 conversions take ~28 ms. Faster
 * conversions are noisier per sample; the oversampling and the EMA below are
 * what pays for that. `loopMs` in /api/status shows what the loop really takes.
 */
#define ADS_DATA_RATE RATE_ADS1115_860SPS

/*
 * Input conditioning, adapted from larszu/dmx-bicolor-controller.
 *
 * That project needed it so a DMX fixture would not shimmer from ADC noise.
 * Here the same noise would do something worse: feed a closed loop and make
 * the iris hunt audibly. Oversample, smooth, then refuse to act on changes too
 * small to be real.
 */
#define ADC_OVERSAMPLE 8       // samples averaged per reading
#define ADC_EMA_ALPHA 0.25f    // 0..1, lower is smoother and slower
#define ADC_DEADBAND_COUNTS 12 // ignore movement smaller than this

// ───────────────────────────────────────────────────────────────────────────
// 4. CLOSED LOOP  (only used when B4_ENABLE_IRIS_DRIVE is 1)
// ───────────────────────────────────────────────────────────────────────────

/*
 * claude-code-brief.md's milestone asks for "sets and holds an iris position with closed
 * loop feedback", and the plan's acceptance criterion is under 2 % deviation.
 *
 * Integral only, no proportional term worth the name: the plant is a servo that
 * already closes its own position loop, so this outer loop only has to correct
 * the calibration table's residual error. A P term on top of a servo is how you
 * get oscillation.
 */
#define LOOP_INTERVAL_MS 50
#define LOOP_I_GAIN 0.08f
#define LOOP_MAX_STEP_COUNTS 64 // per iteration, limits how fast we can be wrong
#define LOOP_TOLERANCE_PCT 1.0f

/*
 * Fail-safe. claude-code-brief.md §3: loss of setpoint or feedback stops motion.
 *
 * If the ADC stops answering, the loop does not keep integrating against a
 * stale number — it parks the DAC and says so. Never hold a setpoint against a
 * measurement you no longer have.
 */
#define FEEDBACK_TIMEOUT_MS 500

// ───────────────────────────────────────────────────────────────────────────
// 5. LENS SERIAL LINE  (group B only — see B4_ENABLE_SERIAL_RX / _TX in §1)
// ───────────────────────────────────────────────────────────────────────────

/*
 * 78400 8N1, TTL, INVERTED (b4-lens-control.md §3). The inversion is set in the
 * UART itself (HardwareSerial::begin(…, invert=true) → uart_set_line_inverse),
 * not by flipping bits afterwards: software inversion keeps the wrong framing
 * and break detection, and the error then shows up at the CRC.
 *
 * Pins are the free ones from the board map in §2. Both lens-side lines come
 * in through a divider (10k over 15k: 5 V → 3.0 V, docs/b4/wiring.md), never
 * directly. TX needs a real level shifter, 1 kΩ in series AND the physical
 * jumper; the compile flag alone is not enough (issue #48).
 */
#define LENS_BAUD 78400
#ifndef B4_BOARD_ESP32_DEVKIT
#define PIN_LENS_RX_FROM_LENS 44 // Hirose pin 11 (lens TXD) via divider → UART1 RX
#define PIN_LENS_RX_FROM_CAM 8   // Hirose pin 12 (camera → lens) via divider → UART2 RX
#define PIN_LENS_TX 43           // → level shifter → jumper → 1 kΩ → pin 12. TX builds only.
#else
#define PIN_LENS_RX_FROM_LENS 16 // Hirose pin 11 via divider → UART1 RX (not wired: group C)
#define PIN_LENS_RX_FROM_CAM 4   // Hirose pin 12 via divider → UART2 RX (not wired: group C)
#define PIN_LENS_TX 17           // TX builds only — none exists for this board
#endif
#define CAPTURE_BYTES 16384      // per direction; what does not fit is counted, not wrapped

/* The board's WS2812 (GPIO 21, §2) shows red while a TX-capable build runs. */
#ifndef B4_BOARD_ESP32_DEVKIT
#define PIN_TX_INDICATOR 21
#else
#define PIN_TX_INDICATOR 2 // the DevKit's plain blue LED, not a WS2812
#endif

// 6. DEMANDS  (phase 4 — reading only, nothing here drives anything)
// ───────────────────────────────────────────────────────────────────────────

/*
 * A second ADS1115 for zoom and focus demands. Its ADDR pin goes to VDD, which
 * gives 0x49 (TI ADS1115 datasheet, table 7-2: GND 0x48, VDD 0x49, SDA 0x4A,
 * SCL 0x4B). Missing chip = no demand fields in /api/status, not zeros.
 *
 * Pin roles come from the 3ality SPC-7000 sheet (docs/b4/spc7000-pinout.md,
 * Fujinon B/C demands): pin 7 is the wiper, pin 6 is "Detect". What Detect
 * actually is — pull-up, strap, identifying resistor — is NOT known (#49). The
 * firmware therefore reports its voltage raw and interprets nothing. The
 * demand also needs its 2.5 / 5.0 / 7.5 V references supplied by the host;
 * that circuit is not designed yet (docs/b4/demand.md).
 *
 * Both lines go through the same 10k/6k8 divider as the lens readback: the
 * ADS1115 must never see more than VDD + 0.3 V (datasheet, absolute maximum).
 */
#ifndef B4_ENABLE_DEMAND
#define B4_ENABLE_DEMAND 1
#endif
#define ADDR_ADS1115_DEMAND 0x49
#define ADS_DEMAND_CH_ZOOM 0         // zoom demand pin 7, via divider
#define ADS_DEMAND_CH_FOCUS 1        // focus demand pin 7, via divider
#define ADS_DEMAND_CH_ZOOM_DETECT 2  // zoom demand pin 6, via divider — raw only
#define ADS_DEMAND_CH_FOCUS_DETECT 3 // focus demand pin 6, via divider — raw only
#define DEMAND_OVERSAMPLE 4          // fewer than the iris: it is a hand, not a loop

/*
 * VTR and RET buttons of a B/C zoom demand (pins 9/10 and 11/12 on the
 * SPC-7000 sheet: button and its common). Read as INPUT_PULLUP, active low,
 * with the common on ground — which is only safe if the contacts really are
 * dry contacts. Unmeasured, so -1 (not wired) until #49 has looked. Pins 8, 43
 * and 44 were free on this board (§2) but are now the lens serial line of §5
 * (group B builds). Before wiring VTR/RET, pick pins that are free in the build
 * that will actually run — a group B build needs all three for the lens.
 */
#define PIN_DEMAND_VTR -1
#define PIN_DEMAND_RET -1

/*
 * The demand as a USB HID gamepad (#52), so it works on a computer with no
 * bridge running. Needs the TinyUSB stack (ARDUINO_USB_MODE=0), which is why it
 * is its own build environment in platformio.ini and off by default.
 *
 * Axes are the stock Arduino USBHIDGamepad: 8 bit signed. X = zoom demand,
 * Y = focus demand, raw ADC counts scaled linearly from 0..32767 onto
 * -127..127 — the ADC's scale, not a claim about the demand's voltages. A
 * missing reading reports the centre. Buttons 0/1 = VTR/RET when wired.
 */
#ifndef B4_DEMAND_HID
#define B4_DEMAND_HID 0
#endif

// ───────────────────────────────────────────────────────────────────────────
// 7. NETWORK
// ───────────────────────────────────────────────────────────────────────────

#define HTTP_PORT 80
#define HOSTNAME "b4-lens"

/*
 * WLAN — classic ESP32 DevKit only (it has no Ethernet).
 *
 * The board always opens its own access point, so it is reachable on a bench
 * with no network at all: join B4_AP_SSID, open http://192.168.4.1. If
 * src/wifi_secrets.h exists (gitignored, copy wifi_secrets.example.h) it ALSO
 * joins that network and prints its address on the console. The AP stays up
 * either way — losing the house WLAN must not lose the device.
 *
 * Power save is off: modem sleep adds 100+ ms of latency to every request,
 * which a control loop driven over HTTP would feel.
 */
#define B4_AP_SSID "b4-lens"
#define B4_AP_PASSWORD "b4-iris-bench" // WPA2 needs >= 8 characters

/* Serial console baud. The S3 uses native USB-CDC, which ignores this. */
#define CONSOLE_BAUD 115200

/* How often the status page and CSV stream refresh, milliseconds. */
#define TELEMETRY_INTERVAL_MS 100
