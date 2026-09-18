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
#include <ETH.h>
#include <SPI.h>
#include <Wire.h>
#include <WebServer.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_MCP4728.h>

#include "config.h"
#include "analog_filter.h"
#include "calibration.h"

// ── W5500 wiring on the Waveshare ESP32-S3-ETH ─────────────────────────────
#define ETH_PHY_TYPE ETH_PHY_W5500
#define ETH_PHY_ADDR 1
#define ETH_PHY_CS 16
#define ETH_PHY_IRQ 12
#define ETH_PHY_RST 39
#define ETH_SPI_SCK 15
#define ETH_SPI_MISO 14
#define ETH_SPI_MOSI 13

// ── I²C addresses ──────────────────────────────────────────────────────────
#define ADDR_MCP4728 0x60
#define ADDR_ADS1115 0x48

WebServer server(HTTP_PORT);
Adafruit_ADS1115 ads;
Adafruit_MCP4728 dac;
Calibration cal;

AnalogFilter fIris(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fZoom(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
AnalogFilter fFocus(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);

struct Health {
  bool dacPresent = false;
  bool adcPresent = false;
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

uint32_t lastFeedbackMs = 0;
uint32_t lastLoopMs = 0;
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
    const int16_t v = ads.readADC_SingleEnded(ch);
    if (v == 0 && i == 0 && ads.getLastConversionResults() == 0) {
      // A single zero is legitimate; a dead bus reads zero forever. The
      // distinction is made by the I²C probe below, not by guessing here.
    }
    acc += v;
  }
  out = static_cast<float>(acc) / ADC_OVERSAMPLE;
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

#if B4_ENABLE_IRIS_DRIVE
/**
 * One iteration of the outer loop.
 *
 * Integral only. The lens already closes its own position loop around the
 * servo; this corrects the residual error of the calibration table. A
 * proportional term stacked on a servo is how you get oscillation.
 */
static void serviceLoop(float irisCounts, bool haveFeedback) {
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

  const int error = static_cast<int>(drive.setpoint) - static_cast<int>(measured);
  const float pct = fabsf(error) * 100.0f / 255.0f;

  int step = static_cast<int>(error * LOOP_I_GAIN * 16.0f);
  step = constrain(step, -LOOP_MAX_STEP_COUNTS, LOOP_MAX_STEP_COUNTS);

  int next = static_cast<int>(drive.dacCode == 0 ? target : drive.dacCode) + step;
  next = constrain(next, 0, 4095);
  drive.dacCode = static_cast<uint16_t>(next);
  dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), drive.dacCode);

  drive.holding = pct <= LOOP_TOLERANCE_PCT;
  drive.fault = nullptr;
}
#endif

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

static float gIrisCounts = 0, gZoomCounts = 0, gFocusCounts = 0;
static bool gIrisOk = false, gZoomOk = false, gFocusOk = false;

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
static void handleStatus() {
  String j = "{";
  j += "\"firmware\":\"b4-lens-control/1\",";
  j += "\"uptimeMs\":" + String(millis()) + ",";
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
  j += "},";

  j += "\"drive\":{\"setpoint\":" + String(drive.setpoint) +
       ",\"dacCode\":" + String(drive.dacCode) +
       ",\"closedLoop\":" + String(drive.closedLoop ? "true" : "false") +
       ",\"holding\":" + String(drive.holding ? "true" : "false");
  if (drive.fault) j += ",\"fault\":\"" + String(drive.fault) + "\"";
  j += "}}";

  server.send(200, "application/json", j);
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

static void handleRoot();

/**
 * The built-in page.
 *
 * It exists because of where this device is used: you are standing at a lens
 * turning a focus ring, and the numbers you need are on a laptop on the other
 * side of the room. A page the lens serves itself is readable from a phone
 * over the same Ethernet that carries the control.
 *
 * Deliberately one file, no framework, no CDN. A control device that cannot
 * show its own state without fetching a megabyte from the internet is a
 * control device that stops working in an OB truck.
 */
static void handleRoot() {
  static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>B4 Lens Control</title>
<style>
 :root{color-scheme:light dark;--fg:#111;--bg:#fafafa;--mut:#666;--ok:#1a7f37;--bad:#b42318;--line:#ddd}
 @media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--mut:#999;--line:#333}}
 body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
 h1{font-size:18px;margin:0 0 4px}
 .sub{color:var(--mut);margin-bottom:16px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
 .card{border:1px solid var(--line);border-radius:8px;padding:12px}
 .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 .v{font-size:24px;font-variant-numeric:tabular-nums;margin-top:2px}
 .u{color:var(--mut);font-size:13px}
 .na{color:var(--mut);font-size:16px;font-style:italic}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
 .pill{padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
 .on{color:var(--ok);border-color:var(--ok)} .off{color:var(--bad);border-color:var(--bad)}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:right}
 th:first-child,td:first-child{text-align:left}
 button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
 input[type=range]{width:100%}
 .warn{border-left:3px solid var(--bad);padding-left:10px;color:var(--mut);margin:12px 0}
</style>
<h1>B4 Lens Control</h1>
<div class="sub">Canon/Fujinon 2/3&quot; B4 &mdash; Hirose 12-pin</div>
<div class="row" id="pills"></div>
<div class="grid" id="vals"></div>
<div id="drive"></div>
<div class="warn">Every electrical figure this device reports rests on a divider
ratio you entered in <code>config.h</code>. It is measuring, not certifying.</div>
<h2 style="font-size:15px">Calibration</h2>
<div id="cal"></div>
<script>
const $=s=>document.querySelector(s);
function cell(k,v,u){return `<div class="card"><div class="k">${k}</div>`+
 (v===undefined?`<div class="na">not read</div>`:`<div class="v">${v}<span class="u">${u||''}</span></div>`)+`</div>`}
async function tick(){
 let s; try{ s=await (await fetch('/api/status')).json() }catch(e){ return }
 $('#pills').innerHTML=
  `<span class="pill ${s.i2c.adc?'on':'off'}">ADC ${s.i2c.adc?'ok':'missing'}</span>`+
  `<span class="pill ${s.i2c.dac?'on':'off'}">DAC ${s.i2c.dac?'ok':'missing'}</span>`+
  `<span class="pill ${s.calibrated?'on':'off'}">${s.calibrated?'calibrated ('+s.calPoints+' pts)':'not calibrated'}</span>`+
  `<span class="pill ${s.armed?'on':'off'}">${s.armed?'ARMED':'disarmed'}</span>`+
  (s.driveCompiledIn?'':'<span class="pill off">drive not compiled in</span>');
 const L=s.lens||{};
 $('#vals').innerHTML=
  cell('Iris',L.iris,' / 255')+
  cell('Iris volts',L.irisVolts,' V')+
  cell('Zoom volts',L.zoomVolts,' V')+
  cell('Focus volts',L.focusVolts,' V');
 const d=s.drive;
 $('#drive').innerHTML=`<div class="card"><div class="k">Setpoint ${d.setpoint} &mdash; DAC ${d.dacCode}`+
  (d.fault?` &mdash; <span style="color:var(--bad)">${d.fault}</span>`:(d.holding?' &mdash; holding':''))+`</div>`+
  `<input type=range min=0 max=255 value="${d.setpoint}" id="sp" ${s.armed&&s.calibrated?'':'disabled'}></div>`;
 $('#sp').oninput=e=>fetch('/api/iris',{method:'POST',body:JSON.stringify({value:+e.target.value})});
 $('#cal').innerHTML=s.calPoints? '<a href="/api/calibration.csv">download calibration.csv</a>'
  : 'No table recorded. Run <code>packages/firmware-b4/tools/record_calibration.py</code>; the device refuses to drive until then.';
}
tick(); setInterval(tick,500);
</script>
)HTML";
  server.send_P(200, "text/html", PAGE);
}

static void setupRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/iris", HTTP_POST, handleSetIris);
  server.on("/api/arm", HTTP_POST, handleArm);
  server.on("/api/calibrate/point", HTTP_POST, handleCalPoint);
  server.on("/api/calibrate/finish", HTTP_POST, handleCalFinish);
  server.on("/api/calibrate/clear", HTTP_POST, handleCalClear);
  server.on("/api/calibration.csv", HTTP_GET, handleCalCsv);
  server.on("/api/live.csv", HTTP_GET, handleLiveCsv);
  server.onNotFound([]() { refuse(404, "no such endpoint"); });
}

// ───────────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(CONSOLE_BAUD);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);

  Serial.println();
  Serial.println(F("B4LensControl — ESP32-S3 B4 lens interface"));
  Serial.printf("  iris drive compiled in: %s\n", B4_ENABLE_IRIS_DRIVE ? "YES" : "no");
  Serial.printf("  serial TX to lens:      %s\n", B4_ENABLE_SERIAL_TX ? "YES" : "no (correct)");

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_CLOCK_HZ);
  scanI2C();

  health.adcPresent = i2cPresent(ADDR_ADS1115) && ads.begin(ADDR_ADS1115);
  if (health.adcPresent) {
    ads.setGain(ADS_GAIN_SETTING);
    Serial.println(F("ADS1115 ready."));
  } else {
    Serial.println(F("ADS1115 NOT found — no position readback. Reading only what exists."));
  }

  health.dacPresent = i2cPresent(ADDR_MCP4728) && dac.begin(ADDR_MCP4728);
  if (health.dacPresent) {
    dac.setChannelValue(static_cast<MCP4728_channel_t>(DAC_CH_IRIS), 0);
    Serial.println(F("MCP4728 ready, parked at 0."));
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

  SPI.begin(ETH_SPI_SCK, ETH_SPI_MISO, ETH_SPI_MOSI);
  ETH.begin(ETH_PHY_TYPE, ETH_PHY_ADDR, ETH_PHY_CS, ETH_PHY_IRQ, ETH_PHY_RST, SPI);
  ETH.setHostname(HOSTNAME);

  setupRoutes();
  server.begin();
  Serial.printf("HTTP on port %d. Waiting for a link…\n", HTTP_PORT);
}

void loop() {
  server.handleClient();

  if (!health.ethUp && ETH.linkUp()) {
    health.ethUp = true;
    Serial.print(F("Ethernet up: http://"));
    Serial.println(ETH.localIP());
  } else if (health.ethUp && !ETH.linkUp()) {
    health.ethUp = false;
    Serial.println(F("Ethernet link lost."));
  }

  const uint32_t now = millis();
  if (now - lastLoopMs < LOOP_INTERVAL_MS) return;
  lastLoopMs = now;

  float c;
  gIrisOk = readChannel(ADS_CH_IRIS_POSITION, c);
  if (gIrisOk) { gIrisCounts = c; fIris.push(c); }
  gZoomOk = readChannel(ADS_CH_ZOOM_POSITION, c);
  if (gZoomOk) { gZoomCounts = c; fZoom.push(c); }
  gFocusOk = readChannel(ADS_CH_FOCUS_POSITION, c);
  if (gFocusOk) { gFocusCounts = c; fFocus.push(c); }

#if B4_ENABLE_IRIS_DRIVE
  serviceLoop(fIris.stable(), gIrisOk && fIris.primed());
#endif
}
