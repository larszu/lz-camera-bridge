/*
 * b4_frame.h — the group B serial frame, on the ESP32 side. Pure, no hardware.
 *
 *     <length> <cmd> <data 0..15> <crc>      crc = (0x100 - sum of the rest) & 0xFF
 *
 * The same layout packages/bridge/src/protocol/B4Lens.ts implements; the host
 * tests in test/native/ check both against the same vectors. Everything from
 * the lens is untrusted: length and CRC are validated before a frame is handed
 * out, a byte that cannot start a valid frame is dropped and counted.
 *
 * Also here: the transmit gate. Whether a frame MAY be sent is decided in one
 * pure function, so the refusals are testable without a UART.
 */
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>

static const uint8_t B4_MAX_DATA = 15;

inline uint8_t b4Crc(const uint8_t *body, size_t n) {
  uint8_t sum = 0;
  for (size_t i = 0; i < n; ++i) sum = static_cast<uint8_t>(sum + body[i]);
  return static_cast<uint8_t>(0x100 - sum);
}

/** Encode into `out` (at least len+3 bytes). Returns the frame length, 0 if the data is too long. */
inline size_t b4Encode(uint8_t cmd, const uint8_t *data, uint8_t len, uint8_t *out) {
  if (len > B4_MAX_DATA) return 0;
  out[0] = len;
  out[1] = cmd;
  if (len) memcpy(out + 2, data, len);
  out[2 + len] = b4Crc(out, 2 + len);
  return 3 + len;
}

struct B4Frame {
  uint8_t cmd;
  uint8_t len;
  uint8_t data[B4_MAX_DATA];
};

/** Streaming decoder: push one byte at a time, get a frame when one completes. */
class B4Decoder {
 public:
  uint32_t framesDecoded = 0, bytesDropped = 0, crcErrors = 0, lengthErrors = 0;

  /** Returns true and fills `out` when `b` completed a valid frame. */
  bool push(uint8_t b, B4Frame &out) {
    if (n_ < sizeof(buf_)) buf_[n_++] = b;
    return scan(out);
  }

  void reset() { n_ = 0; }

 private:
  uint8_t buf_[B4_MAX_DATA + 3];
  size_t n_ = 0;

  bool scan(B4Frame &out) {
    while (n_ >= 3) {
      const uint8_t len = buf_[0];
      if (len > B4_MAX_DATA) { drop(); ++lengthErrors; continue; }
      const size_t total = static_cast<size_t>(len) + 3;
      if (n_ < total) return false;
      if (b4Crc(buf_, total - 1) != buf_[total - 1]) { drop(); ++crcErrors; continue; }
      out.cmd = buf_[1];
      out.len = len;
      memcpy(out.data, buf_ + 2, len);
      ++framesDecoded;
      memmove(buf_, buf_ + total, n_ - total);
      n_ -= total;
      return true;
    }
    return false;
  }

  void drop() {
    memmove(buf_, buf_ + 1, n_ - 1);
    --n_;
    ++bytesDropped;
  }
};

/**
 * Assembles the lens name from the answers to 0x11 and 0x12, as the camera
 * polls them — docs/b4/b4-lens-control.md §5: 0x11 carries up to 15 ASCII
 * bytes; only when it carried all 15 does 0x12 follow with the rest.
 * Non-printable bytes are dropped, as in decodeLensName() on the bridge.
 */
class B4LensName {
 public:
  /** Feed every decoded frame. Returns true when the name is complete (again). */
  bool onFrame(const B4Frame &f) {
    if (f.cmd == 0x11) {
      firstLen_ = 0;
      for (uint8_t i = 0; i < f.len; ++i) if (f.data[i] >= 0x20 && f.data[i] <= 0x7e) first_[firstLen_++] = f.data[i];
      firstWasFull_ = f.len == B4_MAX_DATA;
      if (!firstWasFull_) return publish(nullptr, 0);
      return false;
    }
    if (f.cmd == 0x12 && firstWasFull_) {
      char second[B4_MAX_DATA];
      uint8_t n = 0;
      for (uint8_t i = 0; i < f.len; ++i) if (f.data[i] >= 0x20 && f.data[i] <= 0x7e) second[n++] = f.data[i];
      firstWasFull_ = false;
      return publish(second, n);
    }
    return false;
  }

  const char *name() const { return name_; }
  bool known() const { return name_[0] != 0; }

 private:
  char first_[B4_MAX_DATA];
  uint8_t firstLen_ = 0;
  bool firstWasFull_ = false;
  char name_[2 * B4_MAX_DATA + 1] = {0};

  bool publish(const char *second, uint8_t n) {
    size_t k = 0;
    for (uint8_t i = 0; i < firstLen_; ++i) name_[k++] = first_[i];
    for (uint8_t i = 0; i < n; ++i) name_[k++] = second[i];
    while (k > 0 && name_[k - 1] == ' ') --k; // trim like the bridge does
    name_[k] = 0;
    size_t s = 0;
    while (name_[s] == ' ') ++s;
    if (s) memmove(name_, name_ + s, k - s + 1);
    return true;
  }
};

/**
 * May this frame be sent? nullptr = yes, otherwise the reason.
 *
 * `codesResolved` is B4_COMMAND_CODES_RESOLVED: the source gives two
 * assignments for iris/zoom/focus control (0x20/0x21/0x22 vs 0x21/0x23/0x22),
 * and until capture has settled which one a camera really uses (#47), every
 * code in that disputed range is refused. `allowReset` is the explicit opt-in
 * for 0x01 with a data byte, which forces a lens reset.
 */
inline const char *b4TxRefusal(uint8_t cmd, uint8_t len, bool codesResolved, bool allowReset) {
  if (len > B4_MAX_DATA) return "more than 15 data bytes";
  if (!codesResolved && cmd >= 0x20 && cmd <= 0x23)
    return "control codes 0x20-0x23 are disputed in the source (#47); resolve by capture first";
  if (cmd == 0x01 && len > 0 && !allowReset) return "0x01 with a data byte forces a lens reset; pass allowReset";
  return nullptr;
}
