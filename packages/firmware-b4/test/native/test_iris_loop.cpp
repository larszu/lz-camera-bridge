// The outer iris loop against a modelled servo iris.
//
// The plant is the same model tools/simulator.py serves over HTTP: a
// non-linear pin-7 curve, first-order servo lag, Gaussian ADC noise. The
// firmware's own pieces run unchanged around it — AnalogFilter, Calibration,
// irisLoopStep — with the constants from config.h.
//
// What this proves: the loop arithmetic converges, holds under 2 % and does not
// hunt, and it corrects a table that has drifted, which open-loop cannot.
// What it does NOT prove: anything about a real lens. The <2 % criterion of
// issue #40 is a bench measurement and stays open until one exists in
// docs/b4/measurements/.
#include <random>
#include "check.h"
#include "analog_filter.h"
#include "calibration.h"
#include "iris_loop.h"

// The loop constants the firmware is built with.
#define GAIN_ONE 0
#include "config.h"

namespace {

constexpr float kVoltsPerCount = 4.096f / 32768.0f;
constexpr float kRTop = DIVIDER_R_TOP_OHM, kRBottom = DIVIDER_R_BOTTOM_OHM;

// tools/simulator.py, IrisModel. The published Fujinon figures live HERE, in a
// model, where they cannot hurt anything; the firmware carries none of them.
struct Plant {
  float vClosed = 2.5f, vOpen = 6.2f;
  float inputOffsetV = 0.0f; // drift of the lens's control input after calibration
  float position = 0.0f, commanded = 0.0f;
  std::mt19937 rng{1234};
  std::normal_distribution<float> noise{0.0f, 6.0f};

  void driveDac(uint16_t code) {
    const float vDac = code / 4095.0f * 3.3f;
    const float vOut = 1.231f * vDac + 2.54f; // wiring.md §2
    float c = (vOut - vClosed - inputOffsetV) / (vOpen - vClosed);
    commanded = c < 0 ? 0 : (c > 1 ? 1 : c);
  }
  void step(float dt) {
    const float tau = 0.15f;
    const float k = dt / tau < 1.0f ? dt / tau : 1.0f;
    position += (commanded - position) * k;
  }
  float pin7Volts() const { return vClosed + powf(position, 1.35f) * (vOpen - vClosed); }
  float trueCounts() const { return pin7Volts() * (kRBottom / (kRTop + kRBottom)) / kVoltsPerCount; }
  // One oversampled ADS1115 reading, as readChannel() takes it.
  float readCounts() {
    float acc = 0;
    for (int i = 0; i < ADC_OVERSAMPLE; ++i) acc += trueCounts() + noise(rng);
    return acc / ADC_OVERSAMPLE;
  }
  void run(float seconds, AnalogFilter &f) {
    for (float t = 0; t < seconds; t += LOOP_INTERVAL_MS / 1000.0f) {
      step(LOOP_INTERVAL_MS / 1000.0f);
      f.push(readCounts());
    }
  }
};

// tools/record_calibration.py: n points, bus and DAC ramped together.
Calibration record(Plant &p, AnalogFilter &f, int points) {
  Calibration c;
  c.clear();
  for (int i = 0; i < points; ++i) {
    const uint8_t bus = static_cast<uint8_t>(lroundf(i * 255.0f / (points - 1)));
    const uint16_t dac = static_cast<uint16_t>(lroundf(i * 4095.0f / (points - 1)));
    p.driveDac(dac);
    p.run(0.8f, f); // --settle default
    c.addPoint(bus, dac, static_cast<uint16_t>(f.smoothed()));
  }
  c.finalise();
  return c;
}

struct Outcome {
  float worstErrPct;   // over the last second, against the noise-free reading
  int posSpread;       // max - min true position (bus counts) over the last second:
                       // hunting shows here. Not the DAC code: above full open the
                       // DAC can wander without moving a blade, and that is not hunting.
};

// serviceLoop() minus the hardware: same order, same calls.
Outcome holdSetpoint(Plant &p, AnalogFilter &f, const Calibration &cal, uint8_t setpoint,
                     uint16_t &dacCode, bool closedLoop, float seconds = 4.0f) {
  Outcome o{0, 0};
  int lo = 255, hi = 0;
  const float dt = LOOP_INTERVAL_MS / 1000.0f;
  const int n = static_cast<int>(seconds / dt);
  for (int i = 0; i < n; ++i) {
    p.step(dt);
    f.push(p.readCounts());
    uint16_t target = 0;
    CHECK(cal.dacFor(setpoint, target));
    if (!closedLoop) {
      dacCode = target;
    } else {
      uint8_t measured = 0;
      CHECK(cal.busFor(f.stable(), measured));
      dacCode = irisLoopStep(setpoint, measured, target, dacCode, LOOP_I_GAIN,
                             LOOP_MAX_STEP_COUNTS, LOOP_TOLERANCE_PCT).dacCode;
    }
    p.driveDac(dacCode);
    if (i >= n - static_cast<int>(1.0f / dt)) {
      uint8_t actual = 0;
      cal.busFor(p.trueCounts(), actual);
      const float err = fabsf(static_cast<float>(actual) - setpoint) * 100.0f / 255.0f;
      if (err > o.worstErrPct) o.worstErrPct = err;
      if (actual < lo) lo = actual;
      if (actual > hi) hi = actual;
    }
  }
  o.posSpread = hi - lo;
  return o;
}

const uint8_t kSetpoints[] = {20, 64, 128, 200, 250};

}  // namespace

TEST(step_starts_from_the_table_and_is_bounded) {
  // Not driving yet (dac 0): start at the table's prediction.
  IrisLoopResult r = irisLoopStep(128, 128, 2000, 0, 0.08f, 64, 1.0f);
  CHECK(r.dacCode == 2000 && r.holding);
  // A huge error moves at most maxStep per iteration.
  r = irisLoopStep(255, 0, 2000, 2000, 0.08f, 64, 1.0f);
  CHECK(r.dacCode == 2064 && !r.holding);
  r = irisLoopStep(0, 255, 2000, 2000, 0.08f, 64, 1.0f);
  CHECK(r.dacCode == 1936);
  // Never outside the DAC's range.
  r = irisLoopStep(255, 0, 4095, 4090, 0.08f, 64, 1.0f);
  CHECK(r.dacCode == 4095);
  r = irisLoopStep(0, 255, 0, 5, 0.08f, 64, 1.0f);
  CHECK(r.dacCode == 0);
}

TEST(closed_loop_holds_under_two_percent_without_hunting) {
  Plant p;
  AnalogFilter f(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
  const Calibration cal = record(p, f, 9);
  CHECK(cal.isValid());
  uint16_t dac = 0;
  for (uint8_t sp : kSetpoints) {
    const Outcome o = holdSetpoint(p, f, cal, sp, dac, true);
    std::printf("    setpoint %3u: worst %.2f %%, position spread %d\n", sp, o.worstErrPct, o.posSpread);
    CHECK(o.worstErrPct < 2.0f);
    // Near full open the modelled lens saturates: the amplifier reaches 6.6 V,
    // the model's iris is fully open at 6.2 V, so the recorder's top point lands
    // on a plateau and the last table segment spans only a few ADC counts.
    // There noise moves the mapped reading by several bus steps and the loop
    // follows it — still inside 2 %, but it is not holding still. That is what
    // plot_calibration.py reports as a "flat section"; on a real lens it means:
    // record more points near the top, or end the ramp where pin 7 stops rising.
    if (sp <= 200) CHECK(o.posSpread <= 2);
  }
}

TEST(closed_loop_corrects_a_drifted_table_that_open_loop_cannot) {
  Plant p;
  AnalogFilter f(ADC_EMA_ALPHA, ADC_DEADBAND_COUNTS);
  const Calibration cal = record(p, f, 9);
  p.inputOffsetV = 0.12f; // the lens has drifted since the table was taken

  uint16_t dac = 0;
  float worstOpen = 0;
  for (uint8_t sp : kSetpoints) {
    const Outcome o = holdSetpoint(p, f, cal, sp, dac, false);
    if (o.worstErrPct > worstOpen) worstOpen = o.worstErrPct;
  }
  // The test is only worth something if the drift is visible open-loop.
  std::printf("    open loop worst %.2f %%\n", worstOpen);
  CHECK(worstOpen > 2.0f);

  dac = 0;
  for (uint8_t sp : kSetpoints) {
    const Outcome o = holdSetpoint(p, f, cal, sp, dac, true);
    std::printf("    closed loop setpoint %3u: worst %.2f %%\n", sp, o.worstErrPct);
    CHECK(o.worstErrPct < 2.0f);
  }
}

int main() {
  RUN(step_starts_from_the_table_and_is_bounded);
  RUN(closed_loop_holds_under_two_percent_without_hunting);
  RUN(closed_loop_corrects_a_drifted_table_that_open_loop_cannot);
  return finish("iris loop");
}
