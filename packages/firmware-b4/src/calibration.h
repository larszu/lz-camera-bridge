/*
 * calibration.h — the table that maps bus scale to DAC code, per lens.
 *
 * claude-code-brief.md §3, binding: "No hardcoded voltage constants in control paths. All
 * scaling goes through a calibration table loaded at boot, because the
 * published values are unverified."
 *
 * So this file contains NO volts. The published figures — iris closed at
 * 2.5 V, F16 at 3.4 V, F2.8 at 6.2 V — are third-party reconstruction from a
 * Fujinon, and the lens this is built for is a Canon. They appear in the docs
 * as expectations to measure against, and nowhere in the control path.
 *
 * WHAT THE TABLE IS. A set of points (busValue 0..255 → dacCode 0..4095),
 * recorded by ramping the DAC and logging what pin 7 reported back. Between
 * points the firmware interpolates linearly. It is stored in NVS and survives
 * reflashing of the application.
 *
 * WHAT IT IS NOT. It is not an F-stop table. Nothing here claims to know the
 * aperture; it knows where the blades sit as a fraction of their travel. F
 * numbers would need the open-F-number the lens reports over the serial
 * protocol (command 0x13), which a group C lens does not have.
 *
 * NO TABLE IS A VALID STATE. An uncalibrated device reports `calibrated:false`
 * and refuses to drive. It does not fall back to a guessed straight line — that
 * is the same class of mistake as the bridge's refusal to start a relative trim
 * from an assumed 128.
 */
#pragma once

#include <Arduino.h>
#include <Preferences.h>

#define CAL_MAX_POINTS 33
#define CAL_NVS_NAMESPACE "b4lens"
#define CAL_NVS_KEY "caltable"
#define CAL_MAGIC 0x42344C43UL // 'B4LC'

struct CalPoint {
  uint8_t busValue; // 0..255, the bridge's iris scale
  uint16_t dacCode; // 0..4095, what we must output to land there
  uint16_t measuredCounts; // what pin 7 read at that point, for the record
};

struct CalTable {
  uint32_t magic;
  uint16_t count;
  uint16_t reserved;
  CalPoint points[CAL_MAX_POINTS];
};

class Calibration {
 public:
  bool load() {
    Preferences p;
    if (!p.begin(CAL_NVS_NAMESPACE, true)) return false;
    const size_t n = p.getBytesLength(CAL_NVS_KEY);
    bool ok = false;
    if (n == sizeof(CalTable)) {
      p.getBytes(CAL_NVS_KEY, &table_, sizeof(CalTable));
      ok = table_.magic == CAL_MAGIC && table_.count >= 2 &&
           table_.count <= CAL_MAX_POINTS && monotonic();
    }
    p.end();
    valid_ = ok;
    if (!ok) table_.count = 0;
    return ok;
  }

  bool save() {
    if (!valid_) return false;
    Preferences p;
    if (!p.begin(CAL_NVS_NAMESPACE, false)) return false;
    const size_t w = p.putBytes(CAL_NVS_KEY, &table_, sizeof(CalTable));
    p.end();
    return w == sizeof(CalTable);
  }

  void clear() {
    table_.magic = CAL_MAGIC;
    table_.count = 0;
    valid_ = false;
  }

  bool addPoint(uint8_t busValue, uint16_t dacCode, uint16_t measuredCounts) {
    if (table_.count >= CAL_MAX_POINTS) return false;
    table_.magic = CAL_MAGIC;
    table_.points[table_.count++] = {busValue, dacCode, measuredCounts};
    return true;
  }

  /** Call once a recording run is complete. Rejects a table that is not usable. */
  bool finalise() {
    valid_ = table_.count >= 2 && monotonic();
    return valid_;
  }

  bool isValid() const { return valid_; }
  uint16_t count() const { return table_.count; }
  const CalPoint &point(uint16_t i) const { return table_.points[i]; }

  /**
   * Bus value → DAC code, linear between recorded points.
   *
   * Returns false when there is no table. The caller must NOT substitute a
   * default; refusing is the answer.
   */
  bool dacFor(uint8_t busValue, uint16_t &out) const {
    if (!valid_) return false;
    const CalPoint *pts = table_.points;
    const uint16_t n = table_.count;
    if (busValue <= pts[0].busValue) { out = pts[0].dacCode; return true; }
    if (busValue >= pts[n - 1].busValue) { out = pts[n - 1].dacCode; return true; }
    for (uint16_t i = 1; i < n; ++i) {
      if (busValue <= pts[i].busValue) {
        const float span = static_cast<float>(pts[i].busValue - pts[i - 1].busValue);
        const float t = span <= 0.0f ? 0.0f
                                     : (busValue - pts[i - 1].busValue) / span;
        out = static_cast<uint16_t>(pts[i - 1].dacCode +
                                    t * (pts[i].dacCode - pts[i - 1].dacCode) + 0.5f);
        return true;
      }
    }
    out = pts[n - 1].dacCode;
    return true;
  }

  /**
   * Measured ADC counts → bus value, the inverse direction.
   *
   * This is what makes the readback meaningful: it converts what pin 7 actually
   * reports into the same 0..255 the bridge speaks, using the same recorded
   * points. Without it the loop would be comparing a setpoint in bus units
   * against a measurement in ADC counts.
   */
  bool busFor(float measuredCounts, uint8_t &out) const {
    if (!valid_ || table_.count < 2) return false;
    const CalPoint *pts = table_.points;
    const uint16_t n = table_.count;
    const bool rising = pts[n - 1].measuredCounts >= pts[0].measuredCounts;
    for (uint16_t i = 1; i < n; ++i) {
      const float a = pts[i - 1].measuredCounts, b = pts[i].measuredCounts;
      const bool between = rising ? (measuredCounts >= a && measuredCounts <= b)
                                  : (measuredCounts <= a && measuredCounts >= b);
      if (between) {
        const float span = b - a;
        const float t = fabsf(span) < 1e-6f ? 0.0f : (measuredCounts - a) / span;
        out = static_cast<uint8_t>(pts[i - 1].busValue +
                                   t * (pts[i].busValue - pts[i - 1].busValue) + 0.5f);
        return true;
      }
    }
    out = rising ? (measuredCounts < pts[0].measuredCounts ? pts[0].busValue
                                                          : pts[n - 1].busValue)
                 : (measuredCounts > pts[0].measuredCounts ? pts[0].busValue
                                                           : pts[n - 1].busValue);
    return true;
  }

 private:
  /** Bus values must ascend, or interpolation is nonsense. */
  bool monotonic() const {
    for (uint16_t i = 1; i < table_.count; ++i)
      if (table_.points[i].busValue <= table_.points[i - 1].busValue) return false;
    return true;
  }

  CalTable table_{CAL_MAGIC, 0, 0, {}};
  bool valid_ = false;
};
