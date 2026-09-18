# `firmware-b4` — the ESP32 in the lens cable

An ESP32-S3 that sits in the Hirose 12-pin cable between a broadcast camera and
a 2/3" B4 lens. Phase 1 of [`docs/b4/claude-code-brief.md`](../../docs/b4/claude-code-brief.md):
drive iris on pin 5, read it back on pin 7, and read zoom and focus position
while doing it.

Placement follows ADR-008; the runtime choice is
[`docs/b4/runtime.md`](../../docs/b4/runtime.md). Wiring, the amplifier maths and
the commissioning order are in [`docs/b4/wiring.md`](../../docs/b4/wiring.md).

> **Nothing here has touched a lens.** The firmware builds and the whole chain
> is exercised against a simulator; the parts arrive 2026-09-23. Until a reading
> appears in [`docs/b4/measurements/`](../../docs/b4/measurements/), every
> voltage in these files is a claim.

## What it refuses to do

These are the load-bearing parts, and they are refusals rather than features:

- **It cannot drive unless `B4_ENABLE_IRIS_DRIVE` is compiled in *and* the
  device is armed over the API.** Two gates, per the brief §3. A flashed board
  must not move a lens the moment a cable is plugged in.
- **It never transmits on the lens serial line.** On a group C lens pin 11 is an
  analog focus output; driving it would be driving against the lens's own buffer.
- **It does not guess a calibration curve.** With no table it reports
  `calibrated:false` and refuses. It does not fall back to a straight line
  between two voltages nobody measured — the same refusal `paintNudge` makes
  when it has no current value rather than assuming 128.
- **It never reports a value it did not read.** A field the ADC did not answer
  for is *absent* from `/api/status`, not zero. A zero here reads as a closed
  iris, and the loop would drive to open it.

No voltage constant appears anywhere in the control path. Scaling goes through a
table recorded per lens and stored in NVS.

## Build

```bash
pio run -e waveshare-esp32-s3-eth -t upload    # default: reads, drives nothing
./tools/flash.sh --armed                       # drive compiled in; prompts first
```

## Test it without hardware

`tools/simulator.py` serves the same HTTP API backed by a modelled servo iris —
non-linear curve, first-order lag, ADC noise, and the same refusals with the
same status codes.

```bash
python3 tools/simulator.py --port 8080
python3 tools/record_calibration.py --host 127.0.0.1:8080 --points 9 --settle 0.2
python3 tools/plot_calibration.py  --host 127.0.0.1:8080
```

The plotter names the three faults that are invisible in a column of numbers: a
flat section, a non-monotonic step, and a perfectly straight line — the last of
which usually means the DAC monitor was measured instead of pin 7.

It is a test double. It proves things about this code and nothing about a lens.

## HTTP API

| | |
|---|---|
| `GET /` | Status page the device serves itself. No CDN — a control device that needs the internet to show its own state stops working in an OB truck |
| `GET /api/status` | Full state. Unmeasured fields are absent |
| `POST /api/iris` | `{"value": 0..255}` — the bridge's scale, not volts, not F-stops |
| `POST /api/arm` | `{"armed": true\|false}` |
| `POST /api/calibrate/point` · `/finish` · `/clear` | Recording the curve |
| `GET /api/calibration.csv` · `/api/live.csv` | The artefacts worth keeping |

The device speaks the bridge's 0–255 iris scale so that `B4LensClient` needs no
conversion of its own. Turning that into a DAC code happens here, next to the
calibration table — the only thing that knows the mapping for a particular lens.
A host sending volts would be asserting a curve it cannot know.

## Layout

| | |
|---|---|
| `src/config.h` | **The only file you should need to touch.** Pins, divider values, loop gains, safety flags |
| `src/calibration.h` | The NVS-backed table and its interpolation, both directions |
| `src/analog_filter.h` | Oversample → EMA → deadband, adapted from `larszu/dmx-bicolor-controller` |
| `src/B4LensControl.ino` | Setup, I²C scan, reading, the closed loop, HTTP |
| `tools/` | Simulator, calibration recorder, curve inspector, flash script |
