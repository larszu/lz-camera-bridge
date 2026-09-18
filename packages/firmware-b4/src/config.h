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
#define PIN_I2C_SDA 16
#define PIN_I2C_SCL 17
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
 * The readback divider, docs/b4/wiring.md §3.
 *
 *   lens pin ──[ R_TOP ]──┬── ADS1115 input
 *                         │
 *                      [ R_BOTTOM ]
 *                         │
 *                        GND
 *
 * With 10k/6k8: 7.00 V at the pin becomes 2.83 V at the ADC. Measure the two
 * resistors you actually fitted and put the real values here — this ratio sits
 * directly in every voltage the firmware reports, and a 5 % resistor is a 5 %
 * lie about the iris.
 */
#define DIVIDER_R_TOP_OHM 10000.0f
#define DIVIDER_R_BOTTOM_OHM 6800.0f

/*
 * ADS1115 full-scale range. GAIN_ONE is ±4.096 V, which comfortably covers the
 * 2.83 V the divider produces at the top of the zoom range while keeping
 * resolution at 125 µV per count.
 */
#define ADS_GAIN_SETTING GAIN_ONE

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
// 5. NETWORK
// ───────────────────────────────────────────────────────────────────────────

#define HTTP_PORT 80
#define HOSTNAME "b4-lens"

/* Serial console baud. The S3 uses native USB-CDC, which ignores this. */
#define CONSOLE_BAUD 115200

/* How often the status page and CSV stream refresh, milliseconds. */
#define TELEMETRY_INTERVAL_MS 100
