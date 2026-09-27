/*
 * iris_loop.h — one step of the outer iris loop, as a pure function.
 *
 * Split out of B4LensControl.ino so the arithmetic can be tested on the host
 * (test/native/) against a modelled servo, without an ESP32 or a lens. The
 * .ino keeps everything that touches hardware or time — the fail-safe paths,
 * the feedback timeout, the DAC write — and calls this for the number.
 *
 * Integral only. The lens closes its own position loop around the servo; this
 * corrects the calibration table's residual error. A proportional term stacked
 * on a servo is how you get oscillation.
 */
#pragma once

#include <stdint.h>
#include <math.h>

struct IrisLoopResult {
  uint16_t dacCode; // what to write to the DAC next
  bool holding;     // within tolerance of the setpoint
};

/**
 * @param setpoint     bus scale 0..255, what was asked for
 * @param measured     bus scale 0..255, what pin 7 says, mapped through the table
 * @param target       DAC code the table predicts for `setpoint`
 * @param currentDac   DAC code currently output; 0 means "not driving yet",
 *                     and the loop then starts from the table's prediction
 */
inline IrisLoopResult irisLoopStep(uint8_t setpoint, uint8_t measured, uint16_t target,
                                   uint16_t currentDac, float iGain, int maxStepCounts,
                                   float tolerancePct) {
  const int error = static_cast<int>(setpoint) - static_cast<int>(measured);
  const float pct = fabsf(static_cast<float>(error)) * 100.0f / 255.0f;

  int step = static_cast<int>(error * iGain * 16.0f);
  if (step > maxStepCounts) step = maxStepCounts;
  if (step < -maxStepCounts) step = -maxStepCounts;

  int next = static_cast<int>(currentDac == 0 ? target : currentDac) + step;
  if (next < 0) next = 0;
  if (next > 4095) next = 4095;

  return {static_cast<uint16_t>(next), pct <= tolerancePct};
}
