#!/usr/bin/env python3
"""
Look at a recorded calibration curve.

What you are looking for
------------------------
Not beauty. Three specific faults, each of which makes the closed loop behave
badly in a different way, and all three are obvious in a plot and invisible in
a column of numbers:

  * A FLAT SECTION. The drive moved and the blades did not. Usually the top or
    bottom of travel, where the lens is already against a stop — but in the
    middle it means the servo is fighting something.
  * A NON-MONOTONIC STEP. Position went backwards while drive went forwards.
    Either the settle time was too short, or the ground between the 12 V supply
    and the ESP32 is not solid.
  * A STRAIGHT LINE. Suspicious rather than good. A real iris is not linear in
    voltage; a perfectly straight curve usually means nothing was connected and
    you recorded the DAC monitor instead of pin 7.

Renders as text by default so it works over SSH with nothing installed.

    python3 tools/plot_calibration.py docs/b4/measurements/20260923-iris.csv
    python3 tools/plot_calibration.py --host 192.168.1.50
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request


def load(args) -> list[dict]:
    if args.host:
        with urllib.request.urlopen(
                f"http://{args.host}/api/calibration.csv", timeout=10) as r:
            text = r.read().decode()
    else:
        text = open(args.csv, encoding="utf-8").read()
    return list(csv.DictReader(io.StringIO(text)))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", help="calibration.csv")
    ap.add_argument("--host", help="read it from a device instead")
    ap.add_argument("--width", type=int, default=56)
    a = ap.parse_args()
    if not a.csv and not a.host:
        ap.error("give a csv file or --host")

    rows = load(a)
    if len(rows) < 2:
        sys.exit("fewer than two points — nothing to look at")

    bus = [int(r["bus_value"]) for r in rows]
    volts = [float(r["lens_volts"]) for r in rows]
    lo, hi = min(volts), max(volts)
    span = hi - lo

    print(f"{len(rows)} points   {lo:.3f} V … {hi:.3f} V   span {span:.3f} V\n")
    for b, v in zip(bus, volts):
        n = 0 if span < 1e-9 else int(round((v - lo) / span * a.width))
        print(f"  {b:3d} │{'█' * n}{'·' * (a.width - n)} {v:6.3f} V")

    print()
    faults = []
    if span < 0.3:
        faults.append("SPAN TOO SMALL: the blades barely moved. Check the barrel "
                      "switch is at A, pin 8 is at 5 V, and that the amplifier "
                      "output really reaches pin 5.")
    drops = [(bus[i], volts[i - 1], volts[i])
             for i in range(1, len(volts)) if volts[i] < volts[i - 1] - 0.02]
    if drops:
        faults.append(f"NON-MONOTONIC at {len(drops)} point(s), first at bus "
                      f"{drops[0][0]} ({drops[0][1]:.3f} → {drops[0][2]:.3f} V): "
                      "increase --settle, or suspect the common ground.")
    flats = [bus[i] for i in range(1, len(volts))
             if abs(volts[i] - volts[i - 1]) < span * 0.01]
    if len(flats) > len(rows) // 3:
        faults.append(f"FLAT over {len(flats)} of {len(rows) - 1} intervals: much "
                      "of the drive range does nothing. Narrow the amplifier "
                      "range to the part that moves.")
    if len(volts) >= 5 and span > 0.3:
        # A real iris curve bends. Perfect linearity usually means the wrong pin.
        mid = volts[len(volts) // 2]
        chord = lo + span / 2
        if abs(mid - chord) < span * 0.01:
            faults.append("PERFECTLY LINEAR: real iris travel is not. Check you "
                          "measured pin 7 and not the DAC monitor channel.")

    if faults:
        for f in faults:
            print(f"  ! {f}")
    else:
        print("  no obvious fault. Curve bends, rises throughout, decent span.")


if __name__ == "__main__":
    main()
