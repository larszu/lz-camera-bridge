/*
 * lens_serial_http.h — the HTTP side of lens_serial.h: capture download,
 * clearing, and (only with B4_ENABLE_SERIAL_TX) the transmit endpoint.
 * Included after the JSON helpers and refuse() it uses.
 */
#pragma once

static void handleCaptureBin() {
  const bool cam = server.arg("dir") == "cam";
  const Capture &c = cam ? capCam : capLens;
  server.setContentLength(c.len);
  server.send(200, "application/octet-stream", "");
  server.sendContent(reinterpret_cast<const char *>(c.buf), c.len);
}

static void handleCaptureClear() {
  capLens.len = capCam.len = 0;
  capLens.overflow = capCam.overflow = 0;
  capLens.dec.reset();
  capCam.dec.reset();
  server.send(200, "application/json", "{\"ok\":true}");
}

#if B4_ENABLE_SERIAL_TX
/** Parse `"data":[1,2,3]` — the one array this API accepts. */
static int jsonBytes(const String &body, uint8_t *out, int max) {
  const int k = body.indexOf("\"data\"");
  if (k < 0) return 0;
  const int a = body.indexOf('[', k), z = body.indexOf(']', k);
  if (a < 0 || z < a) return -1;
  int n = 0, i = a + 1;
  while (i < z) {
    while (i < z && (body[i] == ' ' || body[i] == ',')) ++i;
    if (i >= z) break;
    if (n >= max) return -1;
    const long v = body.substring(i).toInt();
    if (v < 0 || v > 255) return -1;
    out[n++] = static_cast<uint8_t>(v);
    while (i < z && body[i] != ',') ++i;
  }
  return n;
}

/**
 * Send one frame. Compiled only with B4_ENABLE_SERIAL_TX — without it this
 * function, its route and the string below are not in the binary at all, and
 * CI checks exactly that. Even compiled in, the physical jumper in the TX line
 * decides whether anything reaches pin 12.
 */
static void handleLensSend() {
  const String body = server.arg("plain");
  long cmd = -1;
  if (!jsonNumber(body, "cmd", cmd) || cmd < 0 || cmd > 255) return refuse(400, "need cmd 0..255");
  uint8_t data[B4_MAX_DATA + 1];
  const int len = jsonBytes(body, data, B4_MAX_DATA + 1);
  if (len < 0) return refuse(400, "data must be at most 15 bytes 0..255");
  bool allowReset = false;
  jsonBool(body, "allowReset", allowReset);
  const char *why = b4TxRefusal(static_cast<uint8_t>(cmd), static_cast<uint8_t>(len),
                                B4_COMMAND_CODES_RESOLVED, allowReset);
  if (why) return refuse(409, why);
  uint8_t frame[B4_MAX_DATA + 3];
  const size_t n = b4Encode(static_cast<uint8_t>(cmd), data, static_cast<uint8_t>(len), frame);
  Serial1.write(frame, n);
  Serial.printf("B4 TX: frame sent, cmd 0x%02X, %d data bytes\n", static_cast<int>(cmd), len);
  server.send(200, "application/json", String("{\"ok\":true,\"bytes\":") + n + "}");
}
#endif
