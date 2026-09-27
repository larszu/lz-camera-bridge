// calibration.h on the host: interpolation both ways, and "no table" refusing.
//
// Issue #40 asks for exactly these two: unit tests for the interpolation and
// for the case where no curve is loaded. The firmware must refuse, not guess.
#include "check.h"
#include "calibration.h"

static Calibration twoPoint() {
  Calibration c;
  c.clear();
  c.addPoint(0, 0, 10000);
  c.addPoint(255, 4000, 20000);
  c.finalise();
  return c;
}

TEST(no_table_refuses_both_directions) {
  Calibration c;
  uint16_t dac = 1234;
  uint8_t bus = 77;
  CHECK(!c.isValid());
  CHECK(!c.dacFor(128, dac));
  CHECK(!c.busFor(15000.0f, bus));
  // The out-parameters are not touched: nobody can read a default out of them.
  CHECK(dac == 1234);
  CHECK(bus == 77);
}

TEST(one_point_is_not_a_table) {
  Calibration c;
  c.clear();
  c.addPoint(0, 0, 10000);
  CHECK(!c.finalise());
  uint16_t dac = 0;
  CHECK(!c.dacFor(0, dac));
}

TEST(non_ascending_bus_values_are_rejected) {
  Calibration c;
  c.clear();
  c.addPoint(0, 0, 10000);
  c.addPoint(128, 2000, 15000);
  c.addPoint(128, 2100, 15100); // duplicate bus value
  CHECK(!c.finalise());
  CHECK(!c.isValid());
}

TEST(dac_for_interpolates_and_clamps_to_the_recorded_ends) {
  Calibration c = twoPoint();
  CHECK(c.isValid());
  uint16_t dac = 0;
  CHECK(c.dacFor(0, dac) && dac == 0);
  CHECK(c.dacFor(255, dac) && dac == 4000);
  CHECK(c.dacFor(51, dac) && dac == 800); // 51/255 = 0.2
}

TEST(bus_for_is_the_inverse_and_handles_a_falling_curve) {
  Calibration c = twoPoint();
  uint8_t bus = 0;
  CHECK(c.busFor(15000.0f, bus) && bus == 128); // 127.5 rounds up
  CHECK(c.busFor(10000.0f, bus) && bus == 0);

  // A lens whose pin 7 FALLS as the iris opens. Direction is a property of the
  // lens, and the table has to carry it rather than the code assuming it.
  Calibration f;
  f.clear();
  f.addPoint(0, 0, 20000);
  f.addPoint(255, 4000, 10000);
  CHECK(f.finalise());
  CHECK(f.busFor(20000.0f, bus) && bus == 0);
  CHECK(f.busFor(10000.0f, bus) && bus == 255);
  CHECK(f.busFor(12000.0f, bus) && bus == 204);
}

TEST(multi_point_uses_the_right_segment) {
  Calibration c;
  c.clear();
  c.addPoint(0, 0, 10000);
  c.addPoint(100, 1000, 11000); // shallow segment
  c.addPoint(255, 4000, 20000); // steep segment
  CHECK(c.finalise());
  uint16_t dac = 0;
  CHECK(c.dacFor(50, dac) && dac == 500);
  CHECK(c.dacFor(100, dac) && dac == 1000);
  uint8_t bus = 0;
  CHECK(c.busFor(10500.0f, bus) && bus == 50);
  CHECK(c.busFor(15500.0f, bus) && bus == 178); // 100 + 155 * 0.5 = 177.5
}

TEST(nvs_round_trip_and_corrupt_table) {
  nvs_stub::store().clear();
  Calibration none;
  CHECK(!none.load()); // empty flash: no table, and it says so

  Calibration c = twoPoint();
  CHECK(c.save());
  Calibration back;
  CHECK(back.load());
  uint16_t dac = 0;
  CHECK(back.dacFor(51, dac) && dac == 800);

  // Damage the stored magic: a table that fails its own check is no table.
  auto &blob = nvs_stub::store()[std::string(CAL_NVS_NAMESPACE) + "/" + CAL_NVS_KEY];
  blob[0] ^= 0xFF;
  Calibration broken;
  CHECK(!broken.load());
  CHECK(!broken.dacFor(51, dac));
}

TEST(an_invalid_table_is_never_saved) {
  nvs_stub::store().clear();
  Calibration c;
  c.clear();
  c.addPoint(0, 0, 10000);
  CHECK(!c.finalise());
  CHECK(!c.save());
  CHECK(nvs_stub::store().empty());
}

int main() {
  RUN(no_table_refuses_both_directions);
  RUN(one_point_is_not_a_table);
  RUN(non_ascending_bus_values_are_rejected);
  RUN(dac_for_interpolates_and_clamps_to_the_recorded_ends);
  RUN(bus_for_is_the_inverse_and_handles_a_falling_curve);
  RUN(multi_point_uses_the_right_segment);
  RUN(nvs_round_trip_and_corrupt_table);
  RUN(an_invalid_table_is_never_saved);
  return finish("calibration");
}
