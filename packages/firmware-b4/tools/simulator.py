#!/usr/bin/env python3
"""
A fake B4LensControl device.

Why this exists
---------------
The hardware arrives on a Wednesday. The bridge integration, the calibration
recorder and the plotting all have to be right before then, and none of them
should be debugged for the first time with a four-figure lens on the bench and
12 V on a breadboard.

This serves the SAME HTTP API as packages/firmware-b4/src, backed by a model of a
servo iris instead of a real one. Point `record_calibration.py`, the bridge's
B4LensClient, or a browser at it and the whole chain runs.

What it models, and why each part earns its place
-------------------------------------------------
* A non-linear voltage/position curve. A real iris is not linear in anything.
  If the calibration recorder only ever sees a straight line, it is not being
  tested — interpolation between points is the entire reason the table exists.
* Servo lag. The blades take time. Code that assumes a setpoint is reached the
  instant it is sent passes against an instant model and hunts against a lens.
* ADC noise. The filter chain in analog_filter.h exists for this; without noise
  here, a broken filter looks fine.
* Refusals. Not armed, not calibrated, no DAC — the simulator says no in
  exactly the cases the firmware says no, with the same status codes. A client
  that only ever sees success is untested.

Usage
-----
    python3 packages/firmware-b4/tools/simulator.py                 # :8080, drive compiled in
    python3 packages/firmware-b4/tools/simulator.py --port 9000
    python3 packages/firmware-b4/tools/simulator.py --no-drive      # behave like the safe build
    python3 packages/firmware-b4/tools/simulator.py --no-adc        # ADS1115 missing
    python3 packages/firmware-b4/tools/simulator.py --group-c       # no focus line (the real lens)

This is a TEST DOUBLE. It is not a lens and it proves nothing about one.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── The modelled lens ──────────────────────────────────────────────────────

VOLTS_PER_COUNT = 4.096 / 32768.0
R_TOP, R_BOTTOM = 10_000.0, 6_800.0


def lens_volts_to_counts(v: float) -> float:
    """Invert the readback divider: volts at the lens pin → ADC counts."""
    at_adc = v * (R_BOTTOM / (R_TOP + R_BOTTOM))
    return at_adc / VOLTS_PER_COUNT


class IrisModel:
    """
    A servo iris with lag and a curve that is deliberately not a straight line.

    The published figures (closed 2.5 V, F16 3.4 V, F2.8 6.2 V) are the
    third-party reconstruction quoted throughout this repo. They are used HERE,
    in a simulator, precisely because here they cannot hurt anything — the
    firmware itself carries no such constants.
    """

    V_CLOSED, V_OPEN = 2.5, 6.2

    def __init__(self) -> None:
        self.position = 0.0   # 0..1 of travel, where the blades actually are
        self.commanded = 0.0  # 0..1, where the drive voltage says to go
        self._lock = threading.Lock()

    def drive_volts(self, v: float) -> None:
        span = self.V_OPEN - self.V_CLOSED
        with self._lock:
            self.commanded = max(0.0, min(1.0, (v - self.V_CLOSED) / span))

    def step(self, dt: float) -> None:
        """First-order lag, ~150 ms to 63 % — a plausible ENG iris servo."""
        with self._lock:
            tau = 0.15
            self.position += (self.commanded - self.position) * min(1.0, dt / tau)

    def position_volts(self) -> float:
        """
        Where pin 7 says the blades are.

        The gamma bends the curve so that equal voltage steps are not equal
        position steps. That is what makes a two-point calibration wrong and a
        multi-point one right, which is the property the recorder must expose.
        """
        with self._lock:
            shaped = self.position ** 1.35
        return self.V_CLOSED + shaped * (self.V_OPEN - self.V_CLOSED)


class Device:
    def __init__(self, args) -> None:
        self.args = args
        self.iris = IrisModel()
        self.armed = False
        self.setpoint = 0
        self.dac_code = 0
        self.fault: str | None = None
        self.cal: list[dict] = []
        self.calibrated = False
        self.t0 = time.time()
        self.zoom = 0.35   # static unless someone turns the ring
        self.focus = 0.70
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        last = time.time()
        while True:
            now = time.time()
            dt, last = now - last, now
            # DAC code → op-amp output. Vout = 1.231 * Vdac + 2.54 (wiring.md §2).
            v_dac = (self.dac_code / 4095.0) * 3.3
            if self.armed and self.args.drive:
                self.iris.drive_volts(1.231 * v_dac + 2.54)
            self.iris.step(dt)
            time.sleep(0.02)

    # ── readings ───────────────────────────────────────────────────────────

    def _noisy(self, volts: float) -> float:
        c = lens_volts_to_counts(volts)
        return c + random.gauss(0, 6)  # ~±0.75 mV at the pin. Real, and small.

    def counts(self) -> dict:
        if not self.args.adc:
            return {}
        out = {
            "irisCounts": self._noisy(self.iris.position_volts()),
            "zoomCounts": self._noisy(2.0 + self.zoom * 5.0),
        }
        if not self.args.group_c_no_focus:
            out["focusCounts"] = self._noisy(2.0 + self.focus * 5.0)
        return out

    def bus_from_counts(self, c: float) -> int | None:
        """The inverse table lookup, same shape as Calibration::busFor."""
        if not self.calibrated or len(self.cal) < 2:
            return None
        pts = self.cal
        for a, b in zip(pts, pts[1:]):
            lo, hi = a["measured"], b["measured"]
            if min(lo, hi) <= c <= max(lo, hi):
                span = hi - lo
                t = 0.0 if abs(span) < 1e-6 else (c - lo) / span
                return int(round(a["bus"] + t * (b["bus"] - a["bus"])))
        return pts[0]["bus"] if c < pts[0]["measured"] else pts[-1]["bus"]

    def dac_for(self, bus: int) -> int | None:
        if not self.calibrated or len(self.cal) < 2:
            return None
        pts = self.cal
        if bus <= pts[0]["bus"]:
            return pts[0]["dac"]
        if bus >= pts[-1]["bus"]:
            return pts[-1]["dac"]
        for a, b in zip(pts, pts[1:]):
            if bus <= b["bus"]:
                t = (bus - a["bus"]) / (b["bus"] - a["bus"])
                return int(round(a["dac"] + t * (b["dac"] - a["dac"])))
        return pts[-1]["dac"]

    def status(self) -> dict:
        c = self.counts()
        lens: dict = {}
        if "irisCounts" in c:
            lens["irisCounts"] = round(c["irisCounts"], 1)
            lens["irisVolts"] = round(self.iris.position_volts(), 3)
            b = self.bus_from_counts(c["irisCounts"])
            if b is not None:
                lens["iris"] = b
        if "zoomCounts" in c:
            lens["zoomCounts"] = round(c["zoomCounts"], 1)
            lens["zoomVolts"] = round(2.0 + self.zoom * 5.0, 3)
        if "focusCounts" in c:
            lens["focusCounts"] = round(c["focusCounts"], 1)
            lens["focusVolts"] = round(2.0 + self.focus * 5.0, 3)

        drive = {
            "setpoint": self.setpoint,
            "dacCode": self.dac_code,
            "closedLoop": True,
            "holding": self.armed and self.fault is None,
        }
        if self.fault:
            drive["fault"] = self.fault
        return {
            "firmware": "b4-lens-control/1 (SIMULATOR)",
            "uptimeMs": int((time.time() - self.t0) * 1000),
            "driveCompiledIn": self.args.drive,
            "armed": self.armed,
            "calibrated": self.calibrated,
            "calPoints": len(self.cal),
            "i2c": {"dac": self.args.dac, "adc": self.args.adc},
            "lens": lens,
            "drive": drive,
        }


# ── HTTP ───────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    dev: Device = None  # type: ignore[assignment]

    def log_message(self, fmt, *a):  # quieter
        pass

    def _send(self, code: int, obj, ctype="application/json"):
        body = (json.dumps(obj) if ctype == "application/json" else obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _refuse(self, code: int, reason: str):
        self._send(code, {"ok": False, "reason": reason})

    def do_GET(self):
        d = self.dev
        if self.path == "/api/status":
            return self._send(200, d.status())
        if self.path == "/api/calibration.csv":
            csv = "bus_value,dac_code,measured_counts,lens_volts\n"
            for p in d.cal:
                csv += f"{p['bus']},{p['dac']},{int(p['measured'])},{p['volts']:.3f}\n"
            return self._send(200, csv, "text/csv")
        if self.path == "/api/live.csv":
            s = d.status()["lens"]
            csv = ("ms,iris_counts,iris_volts,zoom_counts,zoom_volts,"
                   "focus_counts,focus_volts,dac_code\n")
            csv += (f"{int((time.time()-d.t0)*1000)},"
                    f"{s.get('irisCounts','')},{s.get('irisVolts','')},"
                    f"{s.get('zoomCounts','')},{s.get('zoomVolts','')},"
                    f"{s.get('focusCounts','')},{s.get('focusVolts','')},{d.dac_code}\n")
            return self._send(200, csv, "text/csv")
        if self.path == "/":
            return self._send(200, "<h1>B4 Lens Control — SIMULATOR</h1>"
                                   "<p>The firmware serves a real page here. "
                                   "Use /api/status.</p>", "text/html")
        return self._refuse(404, "no such endpoint")

    def do_POST(self):
        d = self.dev
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._refuse(400, "bad json")

        if self.path == "/api/iris":
            v = body.get("value")
            if not isinstance(v, int):
                return self._refuse(400, "no value")
            if not (0 <= v <= 255):
                return self._refuse(400, "value out of range 0..255")
            if not d.args.drive:
                return self._refuse(409, "drive not compiled in (B4_ENABLE_IRIS_DRIVE=0)")
            if not d.armed:
                return self._refuse(409, "not armed")
            if not d.calibrated:
                return self._refuse(409, "not calibrated")
            if not d.args.dac:
                return self._refuse(503, "no DAC on the bus")
            d.setpoint = v
            code = d.dac_for(v)
            if code is not None:
                d.dac_code = code
            d.fault = None
            return self._send(200, {"ok": True})

        if self.path == "/api/arm":
            a = body.get("armed")
            if not isinstance(a, bool):
                return self._refuse(400, "no armed flag")
            if not d.args.drive:
                return self._refuse(409, "drive not compiled in (B4_ENABLE_IRIS_DRIVE=0)")
            d.armed = a
            if not a:
                d.dac_code, d.fault = 0, "disarmed"
            return self._send(200, {"ok": True})

        if self.path == "/api/calibrate/point":
            bus, dac = body.get("value"), body.get("dac")
            if not isinstance(bus, int) or not isinstance(dac, int):
                return self._refuse(400, "need value and dac")
            if not d.args.adc:
                return self._refuse(503, "no iris feedback to record")
            d.dac_code = dac
            time.sleep(0.6)  # let the modelled servo settle, as a human would
            volts = d.iris.position_volts()
            d.cal.append({"bus": bus, "dac": dac,
                          "measured": lens_volts_to_counts(volts), "volts": volts})
            return self._send(200, {"ok": True, "points": len(d.cal)})

        if self.path == "/api/calibrate/finish":
            if len(d.cal) < 2 or any(b["bus"] <= a["bus"]
                                     for a, b in zip(d.cal, d.cal[1:])):
                return self._refuse(422, "table not usable: need >=2 ascending points")
            d.calibrated = True
            return self._send(200, {"ok": True, "points": len(d.cal)})

        if self.path == "/api/calibrate/clear":
            d.cal, d.calibrated, d.dac_code = [], False, 0
            d.fault = "calibration cleared"
            return self._send(200, {"ok": True})

        return self._refuse(404, "no such endpoint")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--no-drive", dest="drive", action="store_false",
                    help="behave like the default safe build")
    ap.add_argument("--no-adc", dest="adc", action="store_false",
                    help="ADS1115 missing from the bus")
    ap.add_argument("--no-dac", dest="dac", action="store_false",
                    help="MCP4728 missing from the bus")
    ap.add_argument("--group-c", dest="group_c_no_focus", action="store_true",
                    help="no focus readback (pin 11 unread)")
    args = ap.parse_args()

    Handler.dev = Device(args)
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"B4LensControl SIMULATOR on http://127.0.0.1:{args.port}")
    print(f"  drive={'on' if args.drive else 'OFF'} "
          f"adc={'on' if args.adc else 'MISSING'} "
          f"dac={'on' if args.dac else 'MISSING'}")
    print("  This is a test double. It is not a lens.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
