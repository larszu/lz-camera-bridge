// The ESP32-side frame code against the rules in b4-lens-control.md §4/§5 and
// against the vectors the bridge's B4Lens.ts produces for the same input.
#include "check.h"
#include "b4_frame.h"

TEST(crc_and_encode_match_the_bridge_vectors) {
  // encodeB4Frame(0x53) on the bridge side gives 00 53 ad.
  uint8_t out[18];
  CHECK(b4Encode(0x53, nullptr, 0, out) == 3);
  CHECK(out[0] == 0x00 && out[1] == 0x53 && out[2] == 0xAD);
  const uint8_t ten[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
  CHECK(b4Encode(0x53, ten, 10, out) == 13);
  CHECK(out[12] == 0x6C); // bridge: encodeB4Frame(0x53, [1..10]) → …0a 6c
  uint8_t sum = 0;
  for (int i = 0; i < 13; ++i) sum = static_cast<uint8_t>(sum + out[i]);
  CHECK(sum == 0); // every valid frame sums to zero
  uint8_t sixteen[16] = {0};
  CHECK(b4Encode(0x53, sixteen, 16, out) == 0);
}

TEST(decoder_resyncs_after_noise_and_counts_what_it_dropped) {
  B4Decoder d;
  B4Frame f;
  const uint8_t stream[] = {0xFF, 0x03 /*noise*/, 0x00, 0x53, 0xAD, 0x02, 0x31, 0x12, 0x34, 0x00};
  // fix the second frame's CRC
  uint8_t s[sizeof(stream)];
  memcpy(s, stream, sizeof(s));
  s[9] = b4Crc(s + 5, 4);
  int got = 0;
  uint8_t cmds[4];
  for (uint8_t b : s) if (d.push(b, f)) cmds[got++] = f.cmd;
  CHECK(got == 2);
  CHECK(cmds[0] == 0x53 && cmds[1] == 0x31);
  CHECK(d.framesDecoded == 2);
  CHECK(d.bytesDropped >= 1);
}

TEST(bad_crc_is_never_a_frame) {
  B4Decoder d;
  B4Frame f;
  const uint8_t bad[] = {0x00, 0x53, 0xAE};
  bool any = false;
  for (uint8_t b : bad) any |= d.push(b, f);
  CHECK(!any);
  CHECK(d.crcErrors == 1);
}

static B4Frame frame(uint8_t cmd, const char *text) {
  B4Frame f{cmd, static_cast<uint8_t>(strlen(text)), {0}};
  memcpy(f.data, text, f.len);
  return f;
}

TEST(lens_name_short_and_split) {
  B4LensName n;
  CHECK(!n.known());
  CHECK(n.onFrame(frame(0x11, "TEST LENS 1")));
  CHECK(strcmp(n.name(), "TEST LENS 1") == 0);
  // Full first half: wait for 0x12, then join.
  B4LensName m;
  CHECK(!m.onFrame(frame(0x11, "ABCDEFGHIJKLMNO")));
  CHECK(!m.known());
  CHECK(m.onFrame(frame(0x12, "PQR  ")));
  CHECK(strcmp(m.name(), "ABCDEFGHIJKLMNOPQR") == 0);
  // 0x12 without a full 0x11 before it is ignored, not glued on.
  B4LensName o;
  CHECK(!o.onFrame(frame(0x12, "XYZ")));
  CHECK(!o.known());
}

TEST(tx_gate) {
  CHECK(b4TxRefusal(0x20, 2, false, false) != nullptr);
  CHECK(b4TxRefusal(0x23, 2, false, false) != nullptr);
  CHECK(b4TxRefusal(0x21, 2, true, false) == nullptr);
  CHECK(b4TxRefusal(0x11, 0, false, false) == nullptr);
  CHECK(b4TxRefusal(0x01, 0, false, false) == nullptr);
  CHECK(b4TxRefusal(0x01, 1, false, false) != nullptr);
  CHECK(b4TxRefusal(0x01, 1, false, true) == nullptr);
  CHECK(b4TxRefusal(0x11, 16, true, true) != nullptr);
}

int main() {
  RUN(crc_and_encode_match_the_bridge_vectors);
  RUN(decoder_resyncs_after_noise_and_counts_what_it_dropped);
  RUN(bad_crc_is_never_a_frame);
  RUN(lens_name_short_and_split);
  RUN(tx_gate);
  return finish("b4 frame");
}
