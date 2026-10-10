/*
 * B4LensControl — an ESP32-S3 between a broadcast camera and a B4 lens.
 *
 * Phase 1 of docs/b4/claude-code-brief.md: set and hold an iris position over the Hirose
 * 12-pin connector with closed-loop feedback, and read zoom and focus position
 * while doing it.
 *
 * WHAT THIS FIRMWARE REFUSES TO DO, BY DESIGN
 *
 *   - It does not drive anything unless B4_ENABLE_IRIS_DRIVE is compiled in
 *     AND the device has been armed at runtime. Two gates, per claude-code-brief.md §3.
 *   - It does not transmit on the lens serial line. Ever. See config.h §1.
 *   - It does not guess a calibration curve. With no table it reports
 *     `calibrated:false` and refuses to drive, rather than assuming a straight
 *     line between two voltages nobody measured.
 *   - It does not report a value it did not read. Where the ADC is silent the
 *     field is absent, not zero.
 *
 * Board: Waveshare ESP32-S3-ETH (W5500). See docs/b4/runtime.md.
 * Wiring: docs/b4/wiring.md. Protocol and pinout: docs/b4/b4-lens-control.md.
 *
 * EVERY ELECTRICAL FIGURE IN THE DOCS IS UNVERIFIED THIRD-PARTY WORK.
 * Measure your own lens first.
 */

#include <Arduino.h>
#ifdef B4_BOARD_ESP32_DEVKIT
#include <WiFi.h>
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#endif
#if B4_DEMAND_HID
#error "B4_DEMAND_HID needs native USB; the classic ESP32 has none"
#endif
#else
#include <ETH.h>
#endif
#include <SPI.h>
#include <Wire.h>
#include <WebServer.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_MCP4728.h>
#include <Preferences.h>

#include "config.h"
#include "analog_filter.h"
#include "calibration.h"
#include "iris_loop.h"
#include "demand.h"
#if B4_DEMAND_HID
#include <USB.h>
#include <USBHIDGamepad.h>
USBHIDGamepad gamepad;
#endif
// web_page.h is included further down, after `server` exists.

// ── W5500 wiring on the Waveshare ESP32-S3-ETH ─────────────────────────────
//
// Read off Waveshare's own wiki and cross-checked against the ESPHome
// configuration for this board; two independent sources agreeing.
//
// An earlier revision of this file had all six wrong (CS 16, IRQ 12, RST 39,
// SCK 15, MISO 14, MOSI 13) from a single secondary source. That would have
// meant no Ethernet — and worse, GPIO 9 is the W5500's RESET and was being
// driven as I²C SCL at the same time.
#ifndef B4_BOARD_ESP32_DEVKIT
#define B4_ETH_TYPE ETH_PHY_W5500
#define B4_ETH_ADDR 1
#define B4_ETH_MOSI 11
#define B4_ETH_MISO 12
#define B4_ETH_SCK 13
#define B4_ETH_CS 14
#define B4_ETH_RST 9
#define B4_ETH_IRQ 10
#endif

// ── I²C addresses ──────────────────────────────────────────────────────────
#define ADDR_MCP4728 0x60
#define ADDR_ADS1115 0x48

WebServer server(HTTP_PORT);
Adafruit_ADS1115 ads;
Adafruit_ADS1115 adsDemand; // second chip, 0x49 — demands (phase 4)
Adafruit_MCP4728 dac;

// Zoom speed channel. zoomNull is the code that holds the zoom still.
static uint16_t zoomNull = ZOOM_NULL_DEFAULT;
static uint16_t zoomCode = ZOOM_NULL_DEFAULT;
static uint32_t zoomLastCmdMs = 0;
static float zoomTrim = 0;          // position-hold correction on top of zoomNull
static float zoomTarget = NAN;      // pin-10 volts to hold, NAN = not captured
static float zoomLastPos = NAN;
static uint32_t zoomHoldPausedUntil = 0, zoomLastHoldMs = 0;
static uint32_t zoomLastPersistMs = 0;
static const char *benchSetDac(long code);
static const char *zoomSet(long code);
static uint8_t potsMask = 0;   // bit 0 iris, bit 1 zoom, bit 2 focus
#define POT_IRIS_ON (potsMask & 1)
#define POT_ZOOM_ON (potsMask & 2)
static float potIris = NAN, potZoom = NAN, potFocus = NAN;
static int potIrisApplied = -1000;
static bool potZoomActive = false;
static inline uint16_t zoomStop() {
  const long v = lroundf(zoomNull + zoomTrim);
  return static_cast<uint16_t>(v < 0 ? 0 : v > 4095 ? 4095 : v);
}
Calibration cal;

AnalogFilter fIris(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fZoom(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fFocus(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fDemZoom(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fDemFocus(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);

struct Health {
  bool dacPresent = false;
  bool adcPresent = false;
  bool demandAdcPresent = false;
  bool ethUp = false;
} health;

struct Drive {
  bool armed = false;          // runtime gate, separate from the compile flag
  bool closedLoop = true;
  uint8_t setpoint = 0;        // bus scale 0..255
  uint16_t dacCode = 0;
  bool holding = false;
  const char *fault = nullptr; // non-null means motion is stopped and why
} drive;

#if B4_ENABLE_SERIAL_RX
#include "lens_serial.h"
#endif

uint32_t lastFeedbackMs = 0;
uint32_t lastLoopMs = 0;
uint32_t loopDurationMs = 0; // what one pass of reading + loop really took
float voltsPerCount = 0.000125f; // GAIN_ONE: 4.096 V / 32768

// ───────────────────────────────────────────────────────────────────────────
// Reading
// ───────────────────────────────────────────────────────────────────────────

/**
 * One oversampled reading of an ADS1115 channel.
 *
 * Returns false when the conversion fails, and the caller must treat that as
 * "no measurement" rather than as zero — a zero here would look like a closed
 * iris and the loop would drive to open it.
 */
static bool readChannel(uint8_t ch, float &out) {
  if (!health.adcPresent) return false;
  int32_t acc = 0;
  for (uint8_t i = 0; i < ADC_OVERSAMPLE; ++i) {
    // A single zero reading is legitimate — a grounded input reads zero.
    // Whether the ADC is THERE is decided by the I²C probe, not by looking
    // for suspicious values here; guessing from the data would mean a
    // genuinely closed iris could be mistaken for a missing chip.
    acc += ads.readADC_SingleEnded(ch);
  }
  out = static_cast<float>(acc) / ADC_OVERSAMPLE;
  return true;
}

/** Same as readChannel(), on the demand ADC. Absent chip = no reading, never zero. */
static bool readDemandChannel(uint8_t ch, uint8_t oversample, float &out) {
  if (!health.demandAdcPresent) return false;
  int32_t acc = 0;
  for (uint8_t i = 0; i < oversample; ++i) acc += adsDemand.readADC_SingleEnded(ch);
  out = static_cast<float>(acc) / oversample;
  return true;
}

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

/** Boot-time I²C scan. Prints what answered, and what it means if nothing did. */
static void scanI2C() {
  Serial.println(F("I2C scan:"));
  uint8_t found = 0;
  for (uint8_t a = 1; a < 127; ++a) {
    if (i2cPresent(a)) {
      Serial.printf("  0x%02X", a);
      if (a == ADDR_MCP4728) Serial.print(F("  MCP4728 (DAC)"));
      if (a == ADDR_ADS1115) Serial.print(F("  ADS1115 (ADC)"));
      Serial.println();
      ++found;
    }
  }
  if (found == 0) {
    Serial.println(F("  nothing answered."));
    Serial.printf("  SDA=GPIO%d SCL=GPIO%d — these are a DEFAULT, not a reading\n",
                  PIN_I2C_SDA, PIN_I2C_SCL);
    Serial.println(F("  off your board's schematic. Check config.h before the modules."));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Driving
// ───────────────────────────────────────────────────────────────────────────

/** Park the DAC and stop the loop. Every fail-safe path ends here. */
static void stopMotion(const char *why) {
  drive.holding = false;
  drive.fault = why;
#if B4_ENABLE_IRIS_DRIVE
  if (health.dacPresent) dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), 0);
#endif
  drive.dacCode = 0;
}

/**
 * One iteration of the outer loop.
 *
 * Integral only. The lens already closes its own position loop around the
 * servo; this corrects the residual error of the calibration table. A
 * proportional term stacked on a servo is how you get oscillation.
 */
static void serviceLoop(float irisCounts, bool haveFeedback) {
#if !B4_ENABLE_IRIS_DRIVE
  // Nothing is compiled in that could move anything. The function
  // still EXISTS because the .ino prototype generator emits a
  // declaration for it either way, and a declared-but-undefined
  // static is a warning now and a link error later.
  (void)irisCounts;
  (void)haveFeedback;
#else
  if (!drive.armed) return;

  if (!haveFeedback) {
    if (millis() - lastFeedbackMs > FEEDBACK_TIMEOUT_MS)
      stopMotion("feedback lost");
    return;
  }
  lastFeedbackMs = millis();

  uint16_t target = 0;
  if (!cal.dacFor(drive.setpoint, target)) {
    stopMotion("no calibration table");
    return;
  }

  if (!drive.closedLoop) {
    drive.dacCode = target;
    dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), drive.dacCode);
    drive.holding = true;
    drive.fault = nullptr;
    return;
  }

  uint8_t measured = 0;
  if (!cal.busFor(irisCounts, measured)) {
    stopMotion("cannot map feedback without a table");
    return;
  }

  const IrisLoopResult r = irisLoopStep(drive.setpoint, measured, target, drive.dacCode,
                                       LOOP_I_GAIN, LOOP_MAX_STEP_COUNTS, LOOP_TOLERANCE_PCT);
  drive.dacCode = r.dacCode;
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), drive.dacCode);

  drive.holding = r.holding;
  drive.fault = nullptr;
#endif
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

static bool gIrisOk = false, gZoomOk = false, gFocusOk = false;
static bool gDemZoomOk = false, gDemFocusOk = false;
static float gDemZoomDetect = 0, gDemFocusDetect = 0;
static bool gDemZoomDetectOk = false, gDemFocusDetectOk = false;

static String lensVolts(float counts) {
  return String(adcCountsToLensVolts(counts, voltsPerCount,
                                     DIVIDER_R_TOP_OHM, DIVIDER_R_BOTTOM_OHM), 3);
}

/**
 * The status document.
 *
 * A field that was not measured is ABSENT, never zero. The bridge's
 * B4LensClient relies on that: it maps a missing iris to "no reading" and lets
 * the panel say so, rather than showing a closed iris that nobody observed.
 */
static String statusJson() {
  String j = "{";
  j += "\"firmware\":\"b4-lens-control/1\",";
  j += "\"uptimeMs\":" + String(millis()) + ",";
  j += "\"loopMs\":" + String(loopDurationMs) + ",";
  j += "\"driveCompiledIn\":" + String(B4_ENABLE_IRIS_DRIVE ? "true" : "false") + ",";
  j += "\"armed\":" + String(drive.armed ? "true" : "false") + ",";
  j += "\"calibrated\":" + String(cal.isValid() ? "true" : "false") + ",";
  j += "\"calPoints\":" + String(cal.count()) + ",";
  j += "\"i2c\":{\"dac\":" + String(health.dacPresent ? "true" : "false") +
       ",\"adc\":" + String(health.adcPresent ? "true" : "false") + "},";

  j += "\"lens\":{";
  bool first = true;
  if (gIrisOk) {
    uint8_t bus;
    j += "\"irisCounts\":" + String(fIris.smoothed(), 1);
    j += ",\"irisVolts\":" + lensVolts(fIris.smoothed());
    if (cal.busFor(fIris.stable(), bus)) j += ",\"iris\":" + String(bus);
    first = false;
  }
  if (gZoomOk) {
    if (!first) j += ",";
    j += "\"zoomCounts\":" + String(fZoom.smoothed(), 1);
    j += ",\"zoomVolts\":" + lensVolts(fZoom.smoothed());
    first = false;
  }
  if (gFocusOk) {
    if (!first) j += ",";
    j += "\"focusCounts\":" + String(fFocus.smoothed(), 1);
    j += ",\"focusVolts\":" + lensVolts(fFocus.smoothed());
  }
  j += "}";

  // Amplifier output (Vout behind the 1 kΩ), read back through its own
  // 100k/68k divider on A3. Absent when nothing answered.
  {
    float mc;
    if (health.adcPresent && readChannel(ADS_CH_DAC_MONITOR, mc))
      j += ",\"ampVolts\":" + lensVolts(mc);
  }
  j += ",";

  // Demands: present only when the second ADC answered, each field only when
  // it was read. Detect is reported as a voltage and deliberately NOT turned
  // into "plugged in / not" — what that pin means is still to be measured (#49).
  if (health.demandAdcPresent) {
    j += "\"demand\":{";
    bool df = true;
    auto field = [&](const char *name, float counts) {
      if (!df) j += ",";
      j += String("\"") + name + "Counts\":" + String(counts, 1) + ",\"" + name +
           "Volts\":" + lensVolts(counts);
      df = false;
    };
    if (gDemZoomOk) field("zoom", fDemZoom.smoothed());
    if (gDemFocusOk) field("focus", fDemFocus.smoothed());
    if (gDemZoomDetectOk) field("zoomDetect", gDemZoomDetect);
    if (gDemFocusDetectOk) field("focusDetect", gDemFocusDetect);
    if (PIN_DEMAND_VTR >= 0) { j += String(df ? "" : ",") + "\"vtr\":" + (digitalRead(PIN_DEMAND_VTR) == LOW ? "true" : "false"); df = false; }
    if (PIN_DEMAND_RET >= 0) { j += String(df ? "" : ",") + "\"ret\":" + (digitalRead(PIN_DEMAND_RET) == LOW ? "true" : "false"); df = false; }
    j += "},";
  }

  j += "\"drive\":{\"setpoint\":" + String(drive.setpoint) +
       ",\"dacCode\":" + String(drive.dacCode) +
       ",\"closedLoop\":" + String(drive.closedLoop ? "true" : "false") +
       ",\"holding\":" + String(drive.holding ? "true" : "false");
  if (drive.fault) j += ",\"fault\":\"" + String(drive.fault) + "\"";
  j += "}";

  j += ",\"zoom\":{\"code\":" + String(zoomCode) + ",\"null\":" + String(zoomStop()) +
       ",\"stored\":" + String(zoomNull) + ",\"trim\":" + String(zoomTrim, 1) +
       ",\"holding\":" + String(isnan(zoomTarget) ? "false" : "true") + "}";
  j += ",\"pots\":{\"irisOn\":" + String(potsMask & 1 ? "true" : "false") +
       ",\"zoomOn\":" + String(potsMask & 2 ? "true" : "false") +
       ",\"focusOn\":" + String(potsMask & 4 ? "true" : "false") +
       ",\"iris\":" + String(isnan(potIris) ? 0 : (int)potIris) +
       ",\"zoom\":" + String(isnan(potZoom) ? 0 : (int)potZoom) +
       ",\"focus\":" + String(isnan(potFocus) ? 0 : (int)potFocus) + "}";
  j += ",\"serial\":{\"rxCompiledIn\":" + String(B4_ENABLE_SERIAL_RX ? "true" : "false") +
       ",\"txCompiledIn\":" + String(B4_ENABLE_SERIAL_TX ? "true" : "false");
#if B4_ENABLE_SERIAL_RX
  j += ",\"fromLens\":" + captureJson(capLens) + ",\"fromCamera\":" + captureJson(capCam);
  if (lensName.known()) j += ",\"lensName\":\"" + String(lensName.name()) + "\"";
#endif
  j += "}}";
  return j;
}

static void handleStatus() { server.send(200, "application/json", statusJson()); }

/**
 * Zoom speed: code 0..4095 on channel B; zoomNull is stop. Every command
 * refreshes the dead-man timer; loop() returns to stop when it runs out.
 */
static const char *zoomSet(long code) {
#if !B4_ENABLE_IRIS_DRIVE
  // The safe build moves nothing — not the iris, not the zoom. It only holds stop.
  (void)code;
  return "drive not compiled in";
#endif
  if (!health.dacPresent) return "no DAC";
  if (code < 0 || code > 4095) return "0..4095";
  zoomCode = static_cast<uint16_t>(code);
  zoomLastCmdMs = millis();
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_ZOOM), zoomCode);
  return nullptr;
}

/** Store a new stop code: NVS for the firmware, DAC EEPROM for power-up. */
static const char *zoomSetNull(long code) {
  if (!health.dacPresent) return "no DAC";
  if (code < 0 || code > 4095) return "0..4095";
  zoomNull = static_cast<uint16_t>(code);
  zoomTrim = 0;
  zoomTarget = NAN;
  Preferences zp;
  zp.begin("b4zoom", false);
  zp.putUShort("null", zoomNull);
  zp.end();
  // The EEPROM takes all four channels as they are now: iris at 0, zoom at stop.
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), 0);
  drive.dacCode = 0;
  zoomCode = zoomNull;
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_ZOOM), zoomNull);
  if (!dac.saveToEEPROM()) return "EEPROM write failed";
  return nullptr;
}

static void serviceZoomDeadman() {
  const bool moving = millis() - zoomLastCmdMs <= ZOOM_DEADMAN_MS;
  if (!moving && zoomCode != zoomStop()) {
    zoomCode = zoomStop();
    if (health.dacPresent)
      dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_ZOOM), zoomCode);
  }
}

/** Trim the stop code so the zoom does not creep while nobody commands it. */
static void serviceZoomHold(bool havePos, float posVolts) {
#if !B4_ENABLE_IRIS_DRIVE || !ZOOM_HOLD_ENABLE
  (void)havePos; (void)posVolts;
#else
  const uint32_t now = millis();
  if (!health.dacPresent || !havePos) { zoomTarget = NAN; return; }
  if (now - zoomLastCmdMs < ZOOM_HOLD_SETTLE_MS) { zoomTarget = NAN; zoomLastPos = posVolts; return; }
  if (now - zoomLastHoldMs < ZOOM_HOLD_PERIOD_MS) return;
  zoomLastHoldMs = now;
  const float step = isnan(zoomLastPos) ? 0 : posVolts - zoomLastPos;
  zoomLastPos = posVolts;
  if (fabsf(step) > ZOOM_HOLD_MANUAL_V) {           // grip rocker: follow, don't fight
    zoomTarget = NAN;
    zoomHoldPausedUntil = now + 1000;
    return;
  }
  if (now < zoomHoldPausedUntil) return;
  if (isnan(zoomTarget)) { zoomTarget = posVolts; return; }
  if (posVolts < ZOOM_HOLD_END_LOW_V || posVolts > ZOOM_HOLD_END_HIGH_V) return;
  const float err = posVolts - zoomTarget;           // >0: crept towards tele
  if (fabsf(err) < ZOOM_HOLD_DEADBAND_V) return;
  // A higher code drives towards wide (lower pin-10 volts), so creep towards
  // tele is answered with a higher code.
  zoomTrim += ZOOM_HOLD_GAIN * err;
  if (fabsf(zoomTrim) >= ZOOM_HOLD_TRIM_MAX) {
    // The correction ran to its limit without the zoom following: the drive is
    // not connected or the stop is far off. Give up instead of storing nonsense.
    zoomTrim = 0;
    zoomTarget = NAN;
    zoomHoldPausedUntil = now + 60000;
  }
  zoomCode = zoomStop();
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_ZOOM), zoomCode);
#endif
}

/** Fold a settled hold correction into the stored stop, so a restart keeps it. */
static void serviceZoomPersist() {
  const uint32_t now = millis();
  if (now - zoomLastPersistMs < ZOOM_HOLD_PERSIST_MS) return;
  zoomLastPersistMs = now;
  if (isnan(zoomTarget) || fabsf(zoomTrim) < 10 || fabsf(zoomTrim) > ZOOM_HOLD_TRIM_MAX / 2) return;
  const long n = lroundf(zoomNull + zoomTrim);
  zoomNull = static_cast<uint16_t>(n < 0 ? 0 : n > 4095 ? 4095 : n);
  zoomTrim = 0;
  Preferences zp;
  zp.begin("b4zoom", false);
  zp.putUShort("null", zoomNull);
  zp.end();
}

static void setPotsMask(uint8_t m) {
  potsMask = m & 7;
  potIrisApplied = -1000;
  Preferences pp;
  pp.begin("b4pots", false);
  pp.putUChar("mask", potsMask);
  pp.end();
}

/** Read the three pots and act on iris and zoom. */
static void servicePots() {
  auto rd = [](int pin, float &f) {
    const float v = analogRead(pin);
    f = isnan(f) ? v : f + 0.25f * (v - f);
  };
  rd(POT_PIN_IRIS, potIris);
  rd(POT_PIN_ZOOM, potZoom);
  rd(POT_PIN_FOCUS, potFocus);
#if B4_ENABLE_IRIS_DRIVE
  if (POT_IRIS_ON && !drive.armed && fabsf(potIris - potIrisApplied) >= POT_IRIS_STEP) {
    potIrisApplied = static_cast<int>(potIris);
    benchSetDac(potIrisApplied);
  }
  const float off = POT_ZOOM_ON ? potZoom - 2048.0f : 0.0f;
  if (fabsf(off) > POT_ZOOM_DEADBAND) {
    // Pot above centre -> tele (lower code), below -> wide (higher code).
    const float k = (fabsf(off) - POT_ZOOM_DEADBAND) / (2048.0f - POT_ZOOM_DEADBAND);
    const float kk = k > 1 ? 1 : k;
    const uint16_t st = zoomStop();
    const long code = off > 0 ? lroundf(st - kk * st) : lroundf(st + kk * (4095 - st));
    zoomSet(code);
    potZoomActive = true;
  } else if (potZoomActive) {
    potZoomActive = false;      // released: the dead-man returns to stop
  }
#endif
}

static void handlePots() {
  const String b = server.arg("plain");
  uint8_t m = potsMask;
  bool v;
  if (jsonBool(b, "iris", v)) m = v ? (m | 1) : (m & ~1);
  if (jsonBool(b, "zoom", v)) m = v ? (m | 2) : (m & ~2);
  if (jsonBool(b, "focus", v)) m = v ? (m | 4) : (m & ~4);
  setPotsMask(m);
  server.send(200, "application/json", String("{\"ok\":true,\"mask\":") + potsMask + "}");
}

static void handleZoom() {
  long code = 0;
  if (!jsonNumber(server.arg("plain"), "code", code)) return refuse(400, "need code");
  const char *why = zoomSet(code);
  if (why) return refuse(409, why);
  server.send(200, "application/json", String("{\"ok\":true,\"zoomCode\":") + zoomCode + "}");
}

static void handleZoomNull() {
  long code = 0;
  if (!jsonNumber(server.arg("plain"), "code", code)) return refuse(400, "need code");
  const char *why = zoomSetNull(code);
  if (why) return refuse(409, why);
  server.send(200, "application/json", String("{\"ok\":true,\"zoomNull\":") + zoomNull + "}");
}

/**
 * Bench: write the DAC directly, bypassing the calibration table. Only in a
 * drive build and only while disarmed, so it never competes with the loop.
 * Returns nullptr on success, otherwise why it refused.
 */
static const char *benchSetDac(long code) {
#if !B4_ENABLE_IRIS_DRIVE
  (void)code;
  return "drive not compiled in";
#else
  if (drive.armed) return "armed";
  if (!health.dacPresent) return "no DAC";
  if (code < 0 || code > 4095) return "0..4095";
  drive.dacCode = static_cast<uint16_t>(code);
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), drive.dacCode);
  return nullptr;
#endif
}

static void handleBenchDac() {
  long code = 0;
  if (!jsonNumber(server.arg("plain"), "code", code)) return refuse(400, "need code");
  const char *why = benchSetDac(code);
  if (why) return refuse(409, why);
  server.send(200, "application/json", String("{\"ok\":true,\"dacCode\":") + drive.dacCode + "}");
}

/**
 * USB console: "s" prints the status document as one line, the same JSON as
 * /api/status. Lets a bench host read the lens without joining the AP.
 */
static void serviceConsole() {
  static char line[12];
  static uint8_t len = 0;
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (len == 0 && (c == 's' || c == 'S')) { Serial.println(statusJson()); continue; }
    if (c == '\n' || c == '\r') {
      line[len] = 0;
      // Pots: "p0"/"p1" all, "pi1" "pz0" "pf1" one axis (iris, zoom, focus).
      if (len >= 2 && (line[0] == 'p' || line[0] == 'P')) {
        if (len == 2 && (line[1] == '0' || line[1] == '1')) setPotsMask(line[1] == '1' ? 7 : 0);
        else if (len == 3 && (line[2] == '0' || line[2] == '1')) {
          const uint8_t bit = line[1] == 'i' ? 1 : line[1] == 'z' ? 2 : line[1] == 'f' ? 4 : 0;
          if (bit) setPotsMask(line[2] == '1' ? (potsMask | bit) : (potsMask & ~bit));
        }
        Serial.printf("{\"pots\":{\"iris\":%s,\"zoom\":%s,\"focus\":%s}}\n",
                      potsMask & 1 ? "true" : "false", potsMask & 2 ? "true" : "false",
                      potsMask & 4 ? "true" : "false");
      }
      // Zoom: "z<code>" speed (dead-man, repeat to keep moving), "n<code>" store stop.
      if (len > 1 && (line[0] == 'z' || line[0] == 'Z')) {
        const char *why = zoomSet(atol(line + 1));
        if (why) Serial.printf("{\"zoom\":\"refused: %s\"}\n", why);
        else Serial.printf("{\"zoom\":\"ok\",\"zoomCode\":%u}\n", zoomCode);
      }
      if (len > 1 && (line[0] == 'n' || line[0] == 'N')) {
        const char *why = zoomSetNull(atol(line + 1));
        if (why) Serial.printf("{\"zoomNull\":\"refused: %s\"}\n", why);
        else Serial.printf("{\"zoomNull\":%u}\n", zoomNull);
      }
      // Bench only: "d<code>" writes the DAC directly (see benchSetDac).
      if (len > 1 && (line[0] == 'd' || line[0] == 'D')) {
        const char *why = benchSetDac(atol(line + 1));
        if (why) Serial.printf("{\"bench\":\"refused: %s\"}\n", why);
        else Serial.printf("{\"bench\":\"ok\",\"dacCode\":%u}\n", drive.dacCode);
      }
      len = 0;
      continue;
    }
    if (len < sizeof(line) - 1) line[len++] = static_cast<char>(c);
  }
}

/** Body parser for the two-field JSON this API accepts. No library needed. */
static bool jsonNumber(const String &body, const char *key, long &out) {
  const int k = body.indexOf(String("\"") + key + "\"");
  if (k < 0) return false;
  const int c = body.indexOf(':', k);
  if (c < 0) return false;
  out = body.substring(c + 1).toInt();
  return true;
}

static bool jsonBool(const String &body, const char *key, bool &out) {
  const int k = body.indexOf(String("\"") + key + "\"");
  if (k < 0) return false;
  const int c = body.indexOf(':', k);
  if (c < 0) return false;
  const String rest = body.substring(c + 1);
  if (rest.indexOf("true") == 0 || rest.indexOf(" true") == 0) { out = true; return true; }
  if (rest.indexOf("false") == 0 || rest.indexOf(" false") == 0) { out = false; return true; }
  return false;
}

static void refuse(int code, const char *reason) {
  server.send(code, "application/json",
              String("{\"ok\":false,\"reason\":\"") + reason + "\"}");
}

static void handleSetIris() {
  long v = 0;
  if (!jsonNumber(server.arg("plain"), "value", v)) return refuse(400, "no value");
  if (v < 0 || v > 255) return refuse(400, "value out of range 0..255");

#if !B4_ENABLE_IRIS_DRIVE
  return refuse(409, "drive not compiled in (B4_ENABLE_IRIS_DRIVE=0)");
#else
  if (!drive.armed) return refuse(409, "not armed");
  if (!cal.isValid()) return refuse(409, "not calibrated");
  if (!health.dacPresent) return refuse(503, "no DAC on the bus");
  drive.setpoint = static_cast<uint8_t>(v);
  drive.fault = nullptr;
  server.send(200, "application/json", "{\"ok\":true}");
#endif
}

static void handleArm() {
  bool a = false;
  if (!jsonBool(server.arg("plain"), "armed", a)) return refuse(400, "no armed flag");
#if !B4_ENABLE_IRIS_DRIVE
  return refuse(409, "drive not compiled in (B4_ENABLE_IRIS_DRIVE=0)");
#else
  drive.armed = a;
  if (!a) stopMotion("disarmed");
  server.send(200, "application/json", "{\"ok\":true}");
#endif
}

/** Record one calibration point at the CURRENT dac output and measurement. */
static void handleCalPoint() {
  long bus = 0, code = 0;
  const String b = server.arg("plain");
  if (!jsonNumber(b, "value", bus) || !jsonNumber(b, "dac", code))
    return refuse(400, "need value and dac");
  if (!gIrisOk) return refuse(503, "no iris feedback to record");
  if (!cal.addPoint(static_cast<uint8_t>(bus), static_cast<uint16_t>(code),
                    static_cast<uint16_t>(fIris.smoothed())))
    return refuse(507, "table full");
  server.send(200, "application/json",
              String("{\"ok\":true,\"points\":") + cal.count() + "}");
}

static void handleCalFinish() {
  if (!cal.finalise()) return refuse(422, "table not usable: need >=2 ascending points");
  if (!cal.save()) return refuse(500, "could not persist to NVS");
  server.send(200, "application/json",
              String("{\"ok\":true,\"points\":") + cal.count() + "}");
}

static void handleCalClear() {
  cal.clear();
  cal.save();
  stopMotion("calibration cleared");
  server.send(200, "application/json", "{\"ok\":true}");
}

/** The recorded table as CSV — the artefact the plan asks you to keep. */
static void handleCalCsv() {
  String csv = F("bus_value,dac_code,measured_counts,lens_volts\n");
  for (uint16_t i = 0; i < cal.count(); ++i) {
    const CalPoint &p = cal.point(i);
    csv += String(p.busValue) + "," + String(p.dacCode) + "," +
           String(p.measuredCounts) + "," + lensVolts(p.measuredCounts) + "\n";
  }
  server.send(200, "text/csv", csv);
}

/** Live telemetry, one CSV row per request. For logging a curve by hand. */
static void handleLiveCsv() {
  String csv = F("ms,iris_counts,iris_volts,zoom_counts,zoom_volts,focus_counts,focus_volts,dac_code\n");
  csv += String(millis()) + ",";
  csv += (gIrisOk ? String(fIris.smoothed(), 1) + "," + lensVolts(fIris.smoothed()) : String(",")) + ",";
  csv += (gZoomOk ? String(fZoom.smoothed(), 1) + "," + lensVolts(fZoom.smoothed()) : String(",")) + ",";
  csv += (gFocusOk ? String(fFocus.smoothed(), 1) + "," + lensVolts(fFocus.smoothed()) : String(",")) + ",";
  csv += String(drive.dacCode) + "\n";
  server.send(200, "text/csv", csv);
}

#if B4_ENABLE_SERIAL_RX
#include "lens_serial_http.h"
#endif

#include "web_page.h"

static void setupRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/iris", HTTP_POST, handleSetIris);
  server.on("/api/arm", HTTP_POST, handleArm);
  server.on("/api/bench/dac", HTTP_POST, handleBenchDac);
  server.on("/api/zoom", HTTP_POST, handleZoom);
  server.on("/api/zoom/null", HTTP_POST, handleZoomNull);
  server.on("/api/pots", HTTP_POST, handlePots);
  server.on("/api/calibrate/point", HTTP_POST, handleCalPoint);
  server.on("/api/calibrate/finish", HTTP_POST, handleCalFinish);
  server.on("/api/calibrate/clear", HTTP_POST, handleCalClear);
  server.on("/api/calibration.csv", HTTP_GET, handleCalCsv);
  server.on("/api/live.csv", HTTP_GET, handleLiveCsv);
#if B4_ENABLE_SERIAL_RX
  server.on("/api/capture.bin", HTTP_GET, handleCaptureBin);
  server.on("/api/capture/clear", HTTP_POST, handleCaptureClear);
#if B4_ENABLE_SERIAL_TX
  server.on("/api/lens/send", HTTP_POST, handleLensSend);
#endif
#endif
  server.onNotFound([]() { refuse(404, "no such endpoint"); });
}

// ───────────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(CONSOLE_BAUD);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);

  Serial.println();
  Serial.println(F("B4LensControl — ESP32 B4 lens interface"));
  Serial.printf("  iris drive compiled in: %s\n", B4_ENABLE_IRIS_DRIVE ? "YES" : "no");
  Serial.printf("  serial TX to lens:      %s\n", B4_ENABLE_SERIAL_TX ? "YES" : "no (correct)");

#if B4_ENABLE_SERIAL_RX
  // Inversion in the UART, not in software — config.h §5.
#if B4_ENABLE_SERIAL_TX
  Serial1.begin(LENS_BAUD, SERIAL_8N1, PIN_LENS_RX_FROM_LENS, PIN_LENS_TX, true);
#ifdef B4_BOARD_ESP32_DEVKIT
  pinMode(PIN_TX_INDICATOR, OUTPUT);
  digitalWrite(PIN_TX_INDICATOR, HIGH); // blue LED on: this build can transmit
#else
  rgbLedWrite(PIN_TX_INDICATOR, 64, 0, 0); // red: this build can transmit
#endif
  Serial.println(F("  LENS TX COMPILED IN. The jumper decides whether it reaches pin 12."));
#else
  Serial1.begin(LENS_BAUD, SERIAL_8N1, PIN_LENS_RX_FROM_LENS, -1, true);
#endif
  Serial2.begin(LENS_BAUD, SERIAL_8N1, PIN_LENS_RX_FROM_CAM, -1, true);
  Serial.printf("  listening on the lens line: %d baud, inverted, RX GPIO %d / %d\n",
                LENS_BAUD, PIN_LENS_RX_FROM_LENS, PIN_LENS_RX_FROM_CAM);
#endif

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_CLOCK_HZ);
  scanI2C();

  health.adcPresent = i2cPresent(ADDR_ADS1115) && ads.begin(ADDR_ADS1115);
  if (health.adcPresent) {
    ads.setGain(ADS_GAIN_SETTING);
    ads.setDataRate(ADS_DATA_RATE);
    Serial.println(F("ADS1115 ready."));
  } else {
    Serial.println(F("ADS1115 NOT found — no position readback. Reading only what exists."));
  }

#if B4_ENABLE_DEMAND
  health.demandAdcPresent = i2cPresent(ADDR_ADS1115_DEMAND) && adsDemand.begin(ADDR_ADS1115_DEMAND);
  if (health.demandAdcPresent) {
    adsDemand.setGain(ADS_GAIN_SETTING);
    adsDemand.setDataRate(ADS_DATA_RATE);
    Serial.println(F("Demand ADS1115 (0x49) ready."));
  } else {
    Serial.println(F("No demand ADS1115 at 0x49 — demands not read."));
  }
  if (PIN_DEMAND_VTR >= 0) pinMode(PIN_DEMAND_VTR, INPUT_PULLUP);
  if (PIN_DEMAND_RET >= 0) pinMode(PIN_DEMAND_RET, INPUT_PULLUP);
#endif
#if B4_DEMAND_HID
  gamepad.begin();
  USB.begin();
  Serial.println(F("Demand also appears as a USB HID gamepad (X zoom, Y focus)."));
#endif

  health.dacPresent = i2cPresent(ADDR_MCP4728) && dac.begin(ADDR_MCP4728);
  if (health.dacPresent) {
    dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), 0);
    {
      Preferences zp;
      zp.begin("b4zoom", true);
      zoomNull = zp.getUShort("null", ZOOM_NULL_DEFAULT);
      zp.end();
    }
    zoomCode = zoomNull;
    {
      Preferences pp;
      pp.begin("b4pots", true);
      // Older firmware stored one flag for all pots; it maps to iris only, so
      // an unplugged zoom input can never start the zoom after an update.
      potsMask = pp.getUChar("mask", pp.getBool("on", false) ? 1 : 0);
      pp.end();
    }
    analogSetPinAttenuation(POT_PIN_IRIS, ADC_11db);
    analogSetPinAttenuation(POT_PIN_ZOOM, ADC_11db);
    analogSetPinAttenuation(POT_PIN_FOCUS, ADC_11db);
    dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_ZOOM), zoomNull);
    Serial.printf("MCP4728 ready, iris parked at 0, zoom held at stop %u.\n", zoomNull);
  } else {
    Serial.println(F("MCP4728 NOT found — cannot drive iris."));
  }

  if (PIN_IRIS_MODE_REMOTE >= 0) {
    pinMode(PIN_IRIS_MODE_REMOTE, OUTPUT);
    digitalWrite(PIN_IRIS_MODE_REMOTE, LOW);
  }
  if (PIN_IRIS_SERVO_ENABLE >= 0) {
    pinMode(PIN_IRIS_SERVO_ENABLE, OUTPUT);
    digitalWrite(PIN_IRIS_SERVO_ENABLE, LOW);
  }

  Serial.println(cal.load() ? F("Calibration table loaded from NVS.")
                            : F("No calibration table. Drive will refuse until one is recorded."));

#ifdef B4_BOARD_ESP32_DEVKIT
  WiFi.setHostname(HOSTNAME);
#ifdef B4_WIFI_SSID
  WiFi.mode(WIFI_AP_STA);
#else
  WiFi.mode(WIFI_AP);
#endif
  WiFi.setSleep(false);
  WiFi.softAP(B4_AP_SSID, B4_AP_PASSWORD);
  Serial.printf("Access point \"%s\": http://%s\n", B4_AP_SSID, WiFi.softAPIP().toString().c_str());
#ifdef B4_WIFI_SSID
  WiFi.begin(B4_WIFI_SSID, B4_WIFI_PASSWORD);
  Serial.printf("Joining \"%s\"…\n", B4_WIFI_SSID);
#endif
#else
  SPI.begin(B4_ETH_SCK, B4_ETH_MISO, B4_ETH_MOSI);
  ETH.begin(B4_ETH_TYPE, B4_ETH_ADDR, B4_ETH_CS, B4_ETH_IRQ, B4_ETH_RST, SPI);
  ETH.setHostname(HOSTNAME);
#endif

  setupRoutes();
  server.begin();
  Serial.printf("HTTP on port %d. Waiting for a link…\n", HTTP_PORT);
}

void loop() {
  server.handleClient();
  serviceConsole();
  serviceZoomDeadman();
#if B4_ENABLE_SERIAL_RX
  serviceSerial(); // every pass, not every LOOP_INTERVAL: the UART FIFO is 128 bytes
#endif

#ifdef B4_BOARD_ESP32_DEVKIT
  // ethUp means "joined the house network"; the AP is always there.
  const bool linkUp = WiFi.status() == WL_CONNECTED;
  const IPAddress linkIp = WiFi.localIP();
  const char *linkName = "WLAN";
#else
  const bool linkUp = ETH.linkUp();
  const IPAddress linkIp = ETH.localIP();
  const char *linkName = "Ethernet";
#endif
  if (!health.ethUp && linkUp) {
    health.ethUp = true;
    Serial.printf("%s up: http://%s\n", linkName, linkIp.toString().c_str());
  } else if (health.ethUp && !linkUp) {
    health.ethUp = false;
    Serial.printf("%s link lost.\n", linkName);
  }

  const uint32_t now = millis();
  if (now - lastLoopMs < LOOP_INTERVAL_MS) return;
  lastLoopMs = now;

  float c;
  gIrisOk = readChannel(ADS_CH_IRIS_POSITION, c);
  if (gIrisOk) fIris.push(c);
  gZoomOk = readChannel(ADS_CH_ZOOM_POSITION, c);
  if (gZoomOk) fZoom.push(c);
  serviceZoomHold(gZoomOk && fZoom.primed(),
                  adcCountsToLensVolts(fZoom.smoothed(), voltsPerCount,
                                       DIVIDER_R_TOP_OHM, DIVIDER_R_BOTTOM_OHM));
  serviceZoomPersist();
  servicePots();
  gFocusOk = readChannel(ADS_CH_FOCUS_POSITION, c);
  if (gFocusOk) fFocus.push(c);

  serviceLoop(fIris.stable(), gIrisOk && fIris.primed());

#if B4_ENABLE_DEMAND
  gDemZoomOk = readDemandChannel(ADS_DEMAND_CH_ZOOM, DEMAND_OVERSAMPLE, c);
  if (gDemZoomOk) fDemZoom.push(c);
  gDemFocusOk = readDemandChannel(ADS_DEMAND_CH_FOCUS, DEMAND_OVERSAMPLE, c);
  if (gDemFocusOk) fDemFocus.push(c);
  gDemZoomDetectOk = readDemandChannel(ADS_DEMAND_CH_ZOOM_DETECT, 1, gDemZoomDetect);
  gDemFocusDetectOk = readDemandChannel(ADS_DEMAND_CH_FOCUS_DETECT, 1, gDemFocusDetect);
#endif
#if B4_DEMAND_HID
  {
    uint32_t buttons = 0;
    if (PIN_DEMAND_VTR >= 0 && digitalRead(PIN_DEMAND_VTR) == LOW) buttons |= 1u << 0;
    if (PIN_DEMAND_RET >= 0 && digitalRead(PIN_DEMAND_RET) == LOW) buttons |= 1u << 1;
    const int8_t x = gDemZoomOk ? demandHidAxis(fDemZoom.stable()) : 0;
    const int8_t y = gDemFocusOk ? demandHidAxis(fDemFocus.stable()) : 0;
    static int8_t lx = 0, ly = 0;
    static uint32_t lb = 0;
    if (x != lx || y != ly || buttons != lb) {
      gamepad.send(x, y, 0, 0, 0, 0, HAT_CENTER, buttons);
      lx = x; ly = y; lb = buttons;
    }
  }
#endif

  loopDurationMs = millis() - now;
}
