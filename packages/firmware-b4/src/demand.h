/*
 * demand.h — pure helpers for the demand reader (phase 4). No hardware here.
 */
#pragma once

#include <stdint.h>

/**
 * ADS1115 counts (0..32767, single-ended) → a signed 8-bit HID axis.
 *
 * Linear over the ADC's own scale, with no voltage assumed about the demand:
 * where the wiper really ends is the host's business (OS joystick calibration,
 * or the bridge's calibration table). Negative counts — a single-ended input
 * reading a hair below ground — clamp to the low end.
 */
inline int8_t demandHidAxis(float counts) {
  if (counts < 0) counts = 0;
  if (counts > 32767) counts = 32767;
  const long v = static_cast<long>(counts * 254.0f / 32767.0f + 0.5f) - 127;
  return static_cast<int8_t>(v < -127 ? -127 : (v > 127 ? 127 : v));
}
