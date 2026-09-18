#!/usr/bin/env python3
"""
Record the iris calibration curve.

Step 6 of the commissioning sequence in docs/b4/wiring.md: ramp the DAC, wait for
the blades to settle, and log what pin 7 reports. The result is the table the
firmware interpolates for the rest of its life, stored in the device's NVS.

Why a script and not a button on the page
-----------------------------------------
The plan says it plainly: comparing many recordings is the part a script does
better than a person. Each point needs a settle delay, a stable reading and a
monotonicity check, repeated a few dozen times. Done by hand it is both tedious
and unreliable, and an unreliable calibration is worse than none — the firmware
would then hold a wrong position confidently.

Safety
------
This script DRIVES THE IRIS. It refuses to start unless the device reports a
drive-capable build, and it arms and disarms around the run so the device does
not sit armed afterwards. Run it only once the readback is proven (step 2).

Usage
-----
    python3 packages/firmware-b4/tools/record_calibration.py --host 192.168.1.50
    python3 packages/firmware-b4/tools/record_calibration.py --host 127.0.0.1:8080 --points 17
    python3 packages/firmware-b4/tools/record_calibration.py --host … --dry-run    # no motion
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def call(host: str, path: str, body: dict | None = None, timeout: float = 10.0):
    url = f"http://{host}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except urllib.error.URLError as e:
        print(f"cannot reach {url}: {e.reason}", file=sys.stderr)
        sys.exit(2)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True, help="device address, e.g. 192.168.1.50")
    ap.add_argument("--points", type=int, default=17,
                    help="calibration points, 2..33 (default 17)")
    ap.add_argument("--settle", type=float, default=0.8,
                    help="seconds to wait after each DAC step (default 0.8)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan and read status; drive nothing")
    ap.add_argument("--keep-existing", action="store_true",
                    help="do not clear the table already on the device")
    a = ap.parse_args()

    if not 2 <= a.points <= 33:
        sys.exit("points must be between 2 and 33 (CAL_MAX_POINTS)")

    code, st = call(a.host, "/api/status")
    if code != 200:
        sys.exit(f"status failed: {code} {st}")

    print(f"device:      {st.get('firmware')}")
    print(f"drive build: {st.get('driveCompiledIn')}   adc: {st['i2c']['adc']}   "
          f"dac: {st['i2c']['dac']}")
    print(f"calibrated:  {st.get('calibrated')} ({st.get('calPoints')} points)")

    if not st["i2c"]["adc"]:
        sys.exit("no ADS1115 on the bus — there is nothing to measure against.")
    if not st.get("driveCompiledIn"):
        sys.exit("this build cannot drive (B4_ENABLE_IRIS_DRIVE=0).\n"
                 "Flash env:waveshare-esp32-s3-eth-armed, but only after step 2 passed.")
    if not st["i2c"]["dac"]:
        sys.exit("no MCP4728 on the bus — nothing to ramp.")

    steps = [(round(i * 255 / (a.points - 1)),
              round(i * 4095 / (a.points - 1))) for i in range(a.points)]

    if a.dry_run:
        print("\ndry run — would record:")
        for bus, dac in steps:
            print(f"  bus {bus:3d}  dac {dac:4d}")
        return

    print("\nTHIS WILL MOVE THE IRIS. Ctrl-C now if the lens is not ready.")
    for i in (3, 2, 1):
        print(f"  {i}…", end="", flush=True)
        time.sleep(1)
    print()

    if not a.keep_existing:
        call(a.host, "/api/calibrate/clear", {})
    call(a.host, "/api/arm", {"armed": True})

    recorded = []
    try:
        for bus, dac in steps:
            time.sleep(a.settle)
            code, r = call(a.host, "/api/calibrate/point", {"value": bus, "dac": dac})
            if code != 200:
                raise RuntimeError(f"point {bus} refused: {code} {r}")
            _, s = call(a.host, "/api/status")
            volts = s.get("lens", {}).get("irisVolts")
            recorded.append((bus, dac, volts))
            print(f"  bus {bus:3d}  dac {dac:4d}  ->  {volts} V")

        code, r = call(a.host, "/api/calibrate/finish", {})
        if code != 200:
            raise RuntimeError(f"finish refused: {code} {r}")
        print(f"\nstored {r.get('points')} points.")
    finally:
        call(a.host, "/api/arm", {"armed": False})
        print("disarmed.")

    # The monotonicity check the firmware cannot make for you: if the measured
    # voltage does not move with the drive, the loop has nothing to close on.
    volts = [v for _, _, v in recorded if isinstance(v, (int, float))]
    if len(volts) >= 2:
        span = max(volts) - min(volts)
        print(f"measured span: {span:.3f} V")
        if span < 0.3:
            print("WARNING: the position barely moved. Check pin 8 is at 5 V "
                  "(remote), the iris switch on the barrel is at A, and that "
                  "the op-amp output actually reaches pin 5.")
        drops = sum(1 for x, y in zip(volts, volts[1:]) if y < x - 0.02)
        if drops > len(volts) // 4:
            print("WARNING: the curve is not monotonic. Increase --settle, or "
                  "suspect a loose ground between the 12 V supply and the ESP32.")

    print(f"\ncsv: curl http://{a.host}/api/calibration.csv -o "
          "docs/b4/measurements/$(date +%Y%m%d)-iris-calibration.csv")


if __name__ == "__main__":
    main()
