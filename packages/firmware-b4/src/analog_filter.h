/*
 * analog_filter.h — conditioning for a noisy analog position line.
 *
 * Adapted from larszu/dmx-bicolor-controller, whose README states the problem
 * exactly: "oversampling, an exponential moving average, and a deadband, so the
 * output does not shimmer from ADC noise."
 *
 * There it kept a lamp from flickering. Here the same raw signal feeds a closed
 * loop, so untreated noise does not merely look bad — the loop chases it and
 * the iris servo hunts. The three stages do different jobs and none of them
 * replaces another:
 *
 *   oversample  kills uncorrelated sample noise      (√N improvement)
 *   EMA         kills the remaining low-frequency wander
 *   deadband    stops the LOOP acting on movement too small to be real
 *
 * The deadband is applied last and only to the value the loop consumes. The
 * value the status page reports is the smoothed one WITHOUT the deadband,
 * because a deadbanded readout looks like a stuck sensor and hides exactly the
 * slow drift you want to see while taking a calibration curve.
 */
#pragma once

#include <Arduino.h>

class AnalogFilter {
 public:
  AnalogFilter(float alpha, int16_t deadband)
      : alpha_(alpha), deadband_(deadband) {}

  /** Feed one oversampled reading. Returns the smoothed value. */
  float push(float sample) {
    if (!primed_) {
      ema_ = sample;
      held_ = sample;
      primed_ = true;
      return ema_;
    }
    ema_ = alpha_ * sample + (1.0f - alpha_) * ema_;
    if (fabsf(ema_ - held_) > static_cast<float>(deadband_)) held_ = ema_;
    return ema_;
  }

  /** Smoothed, no deadband. What a human should be shown. */
  float smoothed() const { return ema_; }

  /** Deadbanded. What the control loop should act on. */
  float stable() const { return held_; }

  bool primed() const { return primed_; }

  void reset() { primed_ = false; }

 private:
  float alpha_;
  int16_t deadband_;
  float ema_ = 0.0f;
  float held_ = 0.0f;
  bool primed_ = false;
};

/**
 * Divider maths, in one place so the ratio cannot drift between the status
 * page and the control loop.
 *
 * counts → volts at the ADC pin → volts at the LENS pin. The second step is
 * the one that carries the resistor tolerance, which is why config.h asks for
 * the measured values rather than the nominal ones.
 */
inline float adcCountsToLensVolts(float counts, float voltsPerCount,
                                  float rTop, float rBottom) {
  const float atPin = counts * voltsPerCount;
  return atPin * ((rTop + rBottom) / rBottom);
}
