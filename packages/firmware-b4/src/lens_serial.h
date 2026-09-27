/*
 * lens_serial.h — listening on the lens serial line (phase 2, group B).
 *
 * A header rather than part of the .ino for the reason web_page.h gives: the
 * .ino prototype generator emits declarations for everything that looks like
 * a function, including code inside a disabled #if, and it places them above
 * the types they use. Headers are not run through it.
 *
 * Included only when B4_ENABLE_SERIAL_RX is set, after `server` exists.
 */
#pragma once

#include "b4_frame.h"

// ── Lens serial line: capture, decode, lens name (phase 2) ────────────────
//
// Two directions, two UARTs, each only with an RX pin. `begin()` with a TX pin
// of -1 attaches no TX at all (the core fills in default pins only when BOTH
// are -1), so in a listen-only build nothing on this board can drive pin 12.
struct Capture {
  uint8_t buf[CAPTURE_BYTES];
  size_t len = 0;
  uint32_t overflow = 0; // bytes that did not fit — counted, never silently lost
  B4Decoder dec;
};
static Capture capLens, capCam; // pin 11 (lens → camera), pin 12 (camera → lens)
static B4LensName lensName;

static void pump(HardwareSerial &port, Capture &c, bool fromLens) {
  while (port.available()) {
    const uint8_t b = static_cast<uint8_t>(port.read());
    if (c.len < CAPTURE_BYTES) c.buf[c.len++] = b;
    else ++c.overflow;
    B4Frame f;
    if (c.dec.push(b, f) && fromLens && lensName.onFrame(f)) {
      Serial.printf("Lens name: %s\n", lensName.name());
    }
  }
}

static void serviceSerial() {
  pump(Serial1, capLens, true);
  pump(Serial2, capCam, false);
}

static String captureJson(const Capture &c) {
  return String("{\"bytes\":") + c.len + ",\"overflow\":" + c.overflow +
         ",\"frames\":" + c.dec.framesDecoded + ",\"crcErrors\":" + c.dec.crcErrors +
         ",\"lengthErrors\":" + c.dec.lengthErrors + ",\"dropped\":" + c.dec.bytesDropped + "}";
}

