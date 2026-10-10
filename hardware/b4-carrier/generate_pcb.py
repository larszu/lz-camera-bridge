#!/usr/bin/env python3
"""
B4 lens carrier board, generated.

Run with KiCad's own Python (it carries the pcbnew module):

    /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
        hardware/b4-carrier/generate_pcb.py

The circuit is the one measured on the bench on 2026-10-10 (docs/b4/measurements/)
with the changes the bench taught us:

* USB-C PD (CH224A, 24 kOhm on CFG1 = 12 V) or a DC jack, diode-ORed, polyfuse, TVS.
* 9 V from a 7809 instead of the 330/1k divider; 5 V from a RECOM R-78E switcher
  for the ESP32; a separate quiet 3.3 V (LP2950) for DAC, ADC, OLED, pots and the
  iris offset.
* LM324 (four op-amps): iris stage as built, zoom and focus as difference
  amplifiers referenced to the demand socket's own 5 V centre, so "stop" no longer
  hangs on our supplies (bench finding: the zoom stop wandered 1270..1790).
* Plug-in modules: ESP32 DevKit V1 30-pin (second row in three widths), Adafruit
  MCP4728, ADS1115 breakout, 0.96" OLED.
* Locking JST-XH connectors to the lens 12-pin, the zoom and focus sockets on the
  grip, and three external pots; two on-board pots (iris, zoom) selectable by jumper.

Everything placed here is reviewed in docs, not trusted blindly: run DRC, look at
the renders, and measure the first board before connecting a lens.
"""
from __future__ import annotations

import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "b4-carrier.kicad_pcb")
FPROOT = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/"
FREEROUTING = os.path.join(HERE, "..", "..", ".tools", "freerouting.jar")
JAVA = "/opt/homebrew/opt/openjdk/bin/java"

W, H = 184.0, 100.0  # board, mm


def mm(v: float) -> int:
    return pcbnew.FromMM(v)


board = pcbnew.BOARD()
nets: dict[str, pcbnew.NETINFO_ITEM] = {}


def net(name: str) -> pcbnew.NETINFO_ITEM:
    if name not in nets:
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        nets[name] = n
    return nets[name]


FOOT = {
    "R": ("Resistor_THT", "R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"),
    "R0805": ("Resistor_SMD", "R_0805_2012Metric"),
    "C0805": ("Capacitor_SMD", "C_0805_2012Metric"),
    "C": ("Capacitor_THT", "C_Disc_D5.0mm_W2.5mm_P5.00mm"),
    "CP5": ("Capacitor_THT", "CP_Radial_D5.0mm_P2.00mm"),
    "CP10": ("Capacitor_THT", "CP_Radial_D10.0mm_P5.00mm"),
    "USBC": ("Connector_USB", "USB_C_Receptacle_HRO_TYPE-C-31-M-12"),
    "SSOP10EP": ("Package_SO", "SSOP-10-1EP_3.9x4.9mm_P1mm_EP2.1x3.3mm"),
    "DCJACK": ("Connector_BarrelJack", "BarrelJack_CUI_PJ-063AH_Horizontal"),
    "D201": ("Diode_THT", "D_DO-201AD_P12.70mm_Horizontal"),
    "D41": ("Diode_THT", "D_DO-41_SOD81_P10.16mm_Horizontal"),
    "D15": ("Diode_THT", "D_DO-15_P10.16mm_Horizontal"),
    "PTC": ("Fuse", "Fuse_Bourns_MF-RHT200"),
    "TO220": ("Package_TO_SOT_THT", "TO-220-3_Vertical"),
    "TO92": ("Package_TO_SOT_THT", "TO-92_Inline"),
    "R78E": ("Converter_DCDC", "Converter_DCDC_RECOM_R-78E-0.5_THT"),
    "DIP14": ("Package_DIP", "DIP-14_W7.62mm_Socket"),
    "XH3": ("Connector_JST", "JST_XH_B3B-XH-A_1x03_P2.50mm_Vertical"),
    "XH4": ("Connector_JST", "JST_XH_B4B-XH-A_1x04_P2.50mm_Vertical"),
    "XH8": ("Connector_JST", "JST_XH_B8B-XH-A_1x08_P2.50mm_Vertical"),
    "S4": ("Connector_PinSocket_2.54mm", "PinSocket_1x04_P2.54mm_Vertical"),
    "S6": ("Connector_PinSocket_2.54mm", "PinSocket_1x06_P2.54mm_Vertical"),
    "S10": ("Connector_PinSocket_2.54mm", "PinSocket_1x10_P2.54mm_Vertical"),
    "S15": ("Connector_PinSocket_2.54mm", "PinSocket_1x15_P2.54mm_Vertical"),
    "S20": ("Connector_PinSocket_2.54mm", "PinSocket_1x20_P2.54mm_Vertical"),
    "H2": ("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical"),
    "H3": ("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical"),
    "POT": ("Potentiometer_THT", "Potentiometer_Alps_RK09K_Single_Vertical"),
    "LED": ("LED_THT", "LED_D3.0mm"),
    "TP": ("TestPoint", "TestPoint_THTPad_1.5x1.5mm_Drill0.7mm"),
    "MH": ("MountingHole", "MountingHole_3.2mm_M3_DIN965_Pad"),
}

BOM: list[tuple[str, str, str, str]] = []  # ref, value, footprint, note


def place(ref, kind, value, x, y, rot=0.0, pads=None, note="", dnp=False):
    lib, name = FOOT[kind]
    fp = pcbnew.FootprintLoad(FPROOT + lib + ".pretty", name)
    if fp is None:
        sys.exit(f"footprint not found: {lib}:{name}")
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
    fp.SetOrientationDegrees(rot)
    if dnp:
        fp.SetDNP(True)
    board.Add(fp)
    for pad in fp.Pads():
        n = (pads or {}).get(pad.GetName())
        if n:
            pad.SetNet(net(n))
    BOM.append((ref, value, f"{lib}:{name}", ("DNP " if dnp else "") + note))
    return fp


def res(ref, value, a, b, x, y, rot=0.0, note="", dnp=False):
    return place(ref, "R", value, x, y, rot, {"1": a, "2": b}, note, dnp)


def cap(ref, value, a, b, x, y, kind="C", rot=0.0, note=""):
    return place(ref, kind, value, x, y, rot, {"1": a, "2": b}, note)


def text(s, x, y, size=1.0, layer=pcbnew.F_SilkS, rot=0.0):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
    t.SetTextThickness(mm(size * 0.15))
    t.SetTextAngleDegrees(rot)
    board.Add(t)


def outline(x1, y1, x2, y2, label):
    """Silkscreen rectangle for a plug-in module's body, so nothing tall goes under it."""
    for (a1, b1, a2, b2) in [(x1, y1, x2, y1), (x2, y1, x2, y2), (x2, y2, x1, y2), (x1, y2, x1, y1)]:
        sh = pcbnew.PCB_SHAPE(board)
        sh.SetShape(pcbnew.SHAPE_T_SEGMENT)
        sh.SetStart(pcbnew.VECTOR2I(mm(a1), mm(b1)))
        sh.SetEnd(pcbnew.VECTOR2I(mm(a2), mm(b2)))
        sh.SetLayer(pcbnew.F_Fab)
        sh.SetWidth(mm(0.15))
        board.Add(sh)
    text(label, (x1 + x2) / 2, y2 - 1.2, 0.8, layer=pcbnew.F_Fab)


# --- outline -----------------------------------------------------------------
for (x1, y1, x2, y2) in [(0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)]:
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(mm(x1), mm(y1)))
    s.SetEnd(pcbnew.VECTOR2I(mm(x2), mm(y2)))
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetWidth(mm(0.1))
    board.Add(s)

for i, (x, y) in enumerate([(4, 4), (W - 4, 4), (4, H - 4), (W - 4, H - 4)], 1):
    place(f"H{i}", "MH", "M3", x, y, pads={"1": "GND"})

# --- power input: USB-C PD and DC jack ------------------------------------------
place("J1", "USBC", "USB-C PD 12V", 5.5, 14, 270, {
    "A4": "VBUS", "A9": "VBUS", "B4": "VBUS", "B9": "VBUS",
    "A1": "GND", "A12": "GND", "B1": "GND", "B12": "GND", "SH": "GND",
    "A5": "CC1", "B5": "CC2", "A6": "DP", "B6": "DP", "A7": "DM", "B7": "DM"},
    note="HRO TYPE-C-31-M-12 (LCSC C165948), SMT by PCBWay")
place("U1", "SSOP10EP", "CH224A", 20, 13, 0, {
    "1": "VBUS", "8": "VBUS", "9": "CFG1", "4": "DP", "5": "DM",
    "6": "CC2", "7": "CC1", "10": "PG", "11": "GND"},
    note="WCH CH224A ESSOP-10, PD sink; SMT by PCBWay")
place("R1", "R0805", "24k 1%", 20, 19, 0, {"1": "CFG1", "2": "GND"}, note="CFG1 -> 12 V (WCH datasheet table 5-1)")
place("C1", "C0805", "1uF 25V", 15, 19, 0, {"1": "VBUS", "2": "GND"}, note="VHV decoupling")
place("LED1", "LED", "green", 24, 5.5, 0, {"1": "PG", "2": "PGLED"}, note="PD power good")
res("R2", "4.7k", "V12", "PGLED", 29, 5.5)

place("J2", "DCJACK", "DC 12V", 12.5, 34, 270, {"1": "VDC", "2": "GND", "MP": "GND"},
      note="5.5/2.1 mm, alternative to USB-C")
place("D2", "D201", "1N5822", 22, 23, 0, {"2": "VBUS", "1": "VIN12"}, note="OR-ing, USB-C path")
place("D3", "D201", "1N5822", 22, 30, 0, {"2": "VDC", "1": "VIN12"}, note="OR-ing, DC jack path")
place("F1", "PTC", "MF-RHT200", 38.5, 25, 90, {"1": "VIN12", "2": "V12"}, note="2 A hold, lens + board")
place("D5", "D15", "P6KE18A", 20, 41, 0, {"1": "V12", "2": "GND"}, note="TVS, cathode to +12 V")
cap("C2", "470uF 25V", "V12", "GND", 13, 53, "CP10", note="bulk for motor current")

# lens 12-pin breakout: order follows the Hirose pin numbers printed beside it
place("J3", "XH8", "LENS 12-pin", 4.5, 71, 90, {
    "1": "V12", "2": "GND", "3": "IRIS_CTRL", "4": "IRIS_POS",
    "5": "REMOTE", "6": "ZOOM_POS", "7": "FOCUS_POS", "8": "LENS12"},
    note="to Hirose HR10 12-pin: 6, 3, 5, 7, 8, 10, 11, 12")
text("LENS 12-PIN", 13.5, 71, 1.0, rot=90)
for i, lbl in enumerate(["6 +12V", "3 GND", "5 IRIS", "7 IPOS", "8 REM", "10 ZPOS", "11 FPOS", "12"]):
    text(lbl, 10.5, 71 - 8.75 + i * 2.5, 0.8)

# --- regulators -------------------------------------------------------------------
place("U2", "TO220", "L7809", 46, 9, 0, {"1": "V12", "2": "GND", "3": "V9"}, note="9 V for the LM324")
cap("C3", "330nF", "V12", "GND", 44, 16)
cap("C4", "100nF", "V9", "GND", 52, 16)
cap("C5", "10uF 25V", "V9", "GND", 57, 9, "CP5")
place("U3", "R78E", "R-78E5.0-0.5", 45, 27, 0, {"1": "V12", "2": "GND", "3": "V5"}, note="5 V switcher for the ESP32")
cap("C6", "10uF 25V", "V12", "GND", 39.5, 36, "CP5")
cap("C7", "22uF 16V", "V5", "GND", 54, 33, "CP5")
place("U4", "TO92", "LP2950CZ-3.3", 45, 44, 0, {"1": "A3V3", "2": "GND", "3": "V5"}, note="quiet 3.3 V: DAC, ADC, OLED, pots")
cap("C8", "1uF", "V5", "GND", 39, 50)
cap("C9", "10uF 16V", "A3V3", "GND", 52, 44, "CP5")
cap("C10", "100nF", "A3V3", "GND", 47, 50)
place("D4", "D41", "1N5819", 41, 57, 0, {"2": "V5", "1": "ESP_VIN"}, note="no back-feed from the ESP32's USB")
place("LED2", "LED", "red", 37, 64, 0, {"1": "GND", "2": "PWRLED"}, note="5 V present")
res("R3", "1k", "V5", "PWRLED", 44, 64)

# --- LM324: iris (A), zoom (B), focus (C) --------------------------------------
place("U5", "DIP14", "LM324", 64, 34, 0, {
    "1": "I_OUT", "2": "I_N", "3": "I_P", "4": "V9",
    "5": "Z_P", "6": "Z_N", "7": "Z_OUT",
    "8": "F_OUT", "9": "F_N", "10": "F_P", "11": "GND",
    "12": "GND", "13": "D_OUT", "14": "D_OUT"}, note="in a socket")
cap("C11", "100nF", "V9", "GND", 64, 27.5)

# iris stage: Vout = 1.219*Vdac + 2.58 V (bench values); R14 parallel to R13 and
# Ra 22k + 6.8k widen the range to the end stops once measured on the bench.
res("R10", "10k", "DAC_A", "I_P", 77, 53)
res("R11", "10k", "A3V3", "I_RA", 77, 57, note="Ra1; 22k for full range")
res("R12", "5.6k", "I_RA", "I_P", 77, 61, note="Ra2; 6.8k for full range")
res("R13", "10k", "I_N", "GND", 77, 65)
res("R14", "100k", "I_N", "GND", 77, 69, note="parallel to R13, full range only", dnp=True)
res("R15", "10k", "I_OUT", "I_N", 77, 73)
res("R16", "1k", "I_OUT", "IRIS_CTRL", 77, 77)
cap("C12", "100nF", "I_P", "GND", 77, 81)

# zoom and focus: Vout = REF + 1.8 * (V_ch - V_C); DAC C held at mid-scale.
# 100k/180k rather than 10k/18k: SPICE showed 10k/18k loading the lens's 5 V
# reference by ~0.1 V through an assumed 1 kOhm source (simulation/README.md).
res("R20", "100k", "DAC_C", "Z_N", 60, 53)
res("R21", "180k", "Z_N", "Z_OUT", 60, 57)
res("R22", "100k", "DAC_B", "Z_P", 60, 61)
res("R23", "180k", "Z_P", "ZREF", 60, 65)
res("R24", "1.2k", "Z_OUT", "ZOOM_CTRL", 60, 69)
res("R30", "100k", "DAC_C", "F_N", 60, 73)
res("R31", "180k", "F_N", "F_OUT", 60, 77)
res("R32", "100k", "DAC_D", "F_P", 60, 81)
res("R33", "180k", "F_P", "FREF", 60, 85)
res("R34", "1.2k", "F_OUT", "FOCUS_CTRL", 60, 89)

# readback dividers 100k/68k (as on the bench) + 100 nF
res("R41", "100k", "IRIS_CTRL", "ADC3", 93, 53)
res("R42", "68k", "ADC3", "GND", 93, 57)
res("R43", "100k", "IRIS_POS", "ADC0", 93, 61)
res("R44", "68k", "ADC0", "GND", 93, 65)
res("R45", "100k", "ZOOM_POS", "ADC1", 93, 69)
res("R46", "68k", "ADC1", "GND", 93, 73)
res("R47", "100k", "FOCUS_POS", "ADC2", 93, 77)
res("R48", "68k", "ADC2", "GND", 93, 81)
cap("C13", "100nF", "ADC3", "GND", 93, 85)
cap("C14", "100nF", "ADC0", "GND", 93, 89)
cap("C15", "100nF", "ADC1", "GND", 77, 85)
cap("C16", "100nF", "ADC2", "GND", 77, 89)

# pin 8: remote via jumper
res("R40", "1k", "V5", "REM_J", 22, 66)
place("JP1", "H2", "REMOTE", 22, 72, 90, {"1": "REM_J", "2": "REMOTE"}, note="jumper on = iris remote (pin 8)")
text("REMOTE", 22, 76, 0.8)

# --- modules -----------------------------------------------------------------------
# Adafruit MCP4728 (from Adafruit's own board file): JP2 row (GND VA VB VC VD VCC)
# is the upper one seen from the top, JP1 (VCC GND SCL SDA LDAC RDY) the lower,
# 12.7 mm apart, pin 1 of both on the left.
place("U8", "S6", "MCP4728 JP2", 70, 7, 90, {"1": "GND", "2": "DAC_A", "3": "DAC_B", "4": "DAC_C", "5": "DAC_D", "6": "A3V3"},
      note="Adafruit 4470, row JP2: GND VA VB VC VD VCC")
place("U7", "S6", "MCP4728 JP1", 70, 19.7, 90, {"1": "A3V3", "2": "GND", "3": "SCL", "4": "SDA", "5": "GND"},
      note="Adafruit 4470, row JP1: VCC GND SCL SDA LDAC RDY")
outline(63.65, 4.46, 89.05, 22.24, "MCP4728 (Adafruit)")
# ADS1115 breakout, header vertical, VDD at the bottom; the module body lies to
# the left of the header (as on Lars's module: header on the right edge).
place("U6", "S10", "ADS1115", 96, 46.86, 180, {
    "1": "A3V3", "2": "GND", "3": "SCL", "4": "SDA", "5": "GND",
    "7": "ADC0", "8": "ADC1", "9": "ADC2", "10": "ADC3"},
    note="ADS1115 breakout: VDD GND SCL SDA ADDR ALRT A0 A1 A2 A3, VDD at the bottom")
outline(78.5, 22.7, 97.4, 48.2, "ADS1115")
# 0.96in OLED: socket at the top edge, the module hangs over the edge (firmware
# turns the picture by 180 deg), so the pin order reads SDA SCL VCC GND from left.
place("U9", "S4", "OLED", 100, 2.6, 90, {"1": "SDA", "2": "SCL", "3": "A3V3", "4": "GND"},
      note="0.96in SSD1306: module hangs over the board edge; check your module's pin order")
text("OLED ^ ueber Rand: SDA SCL VCC GND", 104, 6.3, 0.8)
place("J9", "XH4", "OLED cable", 112.5, 3, 0, {"1": "GND", "2": "A3V3", "3": "SCL", "4": "SDA"},
      note="alternative: OLED on a cable in the case lid (GND VCC SCL SDA)")

# ESP32 DevKit V1 30-pin, USB towards the top edge.
ESPX, ESPY = 125.0, 16.0
left = ["ESP_3V3", "GND", "D15", "D2", "D4", "RX2", "TX2", "D5", "D18", "D19", "SDA", "RX0", "TX0", "SCL", "D23"]
right = ["ESP_VIN", "GND", "D13", "D12", "D14", "D27", "D26", "LED_STAT", "D33", "D32", "POT_Z", "POT_I", "VN", "POT_F", "EN"]
place("J10", "S15", "ESP32 L", ESPX, ESPY, 0, {str(i + 1): n for i, n in enumerate(left) if n not in ("ESP_3V3",) and not n.startswith(("D1", "D2", "D4", "D5", "RX", "TX", "D23"))},
      note="ESP32 DevKit V1 3V3 row")
for k, gap in enumerate([22.86, 25.40, 27.94]):
    place(f"J{11 + k}", "S15", f"ESP32 R {gap:.2f}", ESPX + gap, ESPY, 0,
          {str(i + 1): n for i, n in enumerate(right) if n in ("ESP_VIN", "GND", "LED_STAT", "POT_Z", "POT_I", "POT_F")},
          note=f"VIN row at {gap:.2f} mm - fit only the one your board needs")
text("ESP32 DEVKIT V1  USB ^", ESPX + 12, ESPY - 5.5, 1.0)
outline(ESPX - 2.6, ESPY - 8.0, ESPX + 25.4 + 2.6, ESPY + 43.5, "ESP32 board (25.40 variant)")
text("22.86 / 25.40 / 27.94", ESPX + 25, ESPY + 39, 0.8)

# Waveshare ESP32-S3-ETH (with or without the PoE module, which sits on the
# top side beside the RJ45): 2 x 20 pins, rows 17.78 mm apart, front (RJ45)
# up, RJ45 end towards the top edge. Pin labels from Waveshare's drawing.
S3X, S3Y = 161.0, 28.0
s3l = ["IO20", "IO19", "GND", "IO48", "IO47", "IO46", "IO45", "GND", "IO42", "IO41",
       "IO40", "IO39", "GND", "IO38", "IO37", "IO36", "IO35", "GND", "IO34", "IO33"]
s3r = ["VBUS", "ESP_VIN", "GND", "3V3_EN", "3V3", "IO21", "SCL", "GND", "SDA", "IO18",
       "RUN", "IO15", "GND", "POT_F", "POT_Z", "POT_I", "IO0", "GND", "IO44", "IO43"]
place("J14", "S20", "S3-ETH IO20 row", S3X, S3Y, 0, {str(i + 1): n for i, n in enumerate(s3l) if n == "GND"},
      note="ESP32-S3-ETH left row (IO20 ... IO33)")
place("J15", "S20", "S3-ETH VBUS row", S3X + 17.78, S3Y, 0,
      {str(i + 1): n for i, n in enumerate(s3r) if n in ("ESP_VIN", "GND", "SCL", "SDA", "POT_F", "POT_Z", "POT_I")},
      note="ESP32-S3-ETH right row: VSYS <- 5 V, IO16 SDA, IO17 SCL, IO1/2/3 pots")
outline(S3X - 1.6, S3Y - 20.0, S3X + 17.78 + 1.6, S3Y + 48.26 + 3.0, "ESP32-S3-ETH")
text("ESP32-S3-ETH (+PoE)  RJ45 ^", S3X + 9, 6.0, 0.9)
text("ONLY ONE ESP32 BOARD", 150, 64, 0.9)

place("LED3", "LED", "blue", 103, 58, 0, {"1": "GND", "2": "STATLED"}, note="status, GPIO25")
res("R53", "330", "LED_STAT", "STATLED", 108, 58)

# --- pots: on-board (iris, zoom) or external, by jumper ---------------------------
place("RV1", "POT", "10k lin IRIS", 103.2, 85, 0, {"1": "A3V3", "2": "RV1W", "3": "GND"}, note="Alps RK09K")
place("RV2", "POT", "10k lin ZOOM", 118, 85, 0, {"1": "A3V3", "2": "RV2W", "3": "GND"}, note="Alps RK09K with centre detent")
place("JP2", "H3", "IRIS POT", 105, 75, 90, {"1": "RV1W", "2": "PI", "3": "EXT_I"}, note="1-2 on-board, 2-3 external")
place("JP3", "H3", "ZOOM POT", 120, 75, 90, {"1": "RV2W", "2": "PZ", "3": "EXT_Z"}, note="1-2 on-board, 2-3 external")
place("RV3", "POT", "10k lin FOCUS", 132.8, 85, 0, {"1": "A3V3", "2": "RV3W", "3": "GND"}, note="Alps RK09K")
place("JP4", "H3", "FOCUS POT", 135, 75, 90, {"1": "RV3W", "2": "PF", "3": "EXT_F"}, note="1-2 on-board, 2-3 external")
text("ONBOARD | EXT", 138, 72.5, 0.8)
text("ONBOARD | EXT", 108, 72.5, 0.8)
text("ONBOARD | EXT", 123, 72.5, 0.8)
res("R50", "1k", "PI", "POT_I", 108, 62)
res("R51", "1k", "PZ", "POT_Z", 108, 66)
res("R52", "1k", "PF", "POT_F", 108, 70)
cap("C20", "100nF", "POT_I", "GND", 120, 62)
cap("C21", "100nF", "POT_Z", "GND", 120, 66)
cap("C22", "100nF", "POT_F", "GND", 120, 70)
for i, (ref, wn, lbl) in enumerate([("J4", "EXT_I", "POT IRIS"), ("J5", "EXT_Z", "POT ZOOM"), ("J6", "EXT_F", "POT FOCUS")]):
    x = 26 + i * 12
    place(ref, "XH3", lbl, x, 95, 0, {"1": "A3V3", "2": wn, "3": "GND"}, note="3V3 / wiper / GND")
    text(lbl, x + 2.5, 91, 0.8)

# --- demand emulator outputs to the grip sockets ----------------------------------
place("J7", "XH4", "ZOOM DEMAND", 5, 85, 90, {"1": "GND", "2": "ZOOM_CTRL", "3": "ZREF", "4": "ZSOCK_POS"},
      note="black grip socket: GND, pin 6, pin 7, pin 9")
text("ZOOM: GND 6 7 9", 10, 82, 0.8)
place("J8", "XH4", "FOCUS DEMAND", 63, 95, 0, {"1": "GND", "2": "FOCUS_CTRL", "3": "FREF", "4": "FSOCK_POS"},
      note="focus module socket - pinout to be measured")
text("FOCUS: GND CTRL REF POS", 67, 91, 0.8)

# --- test points ---------------------------------------------------------------------
for i, n in enumerate(["V12", "V9", "V5", "A3V3", "IRIS_CTRL", "ZOOM_CTRL", "FOCUS_CTRL", "I_P", "GND", "GND"]):
    place(f"TP{i + 1}", "TP", n, 29 + i * 3, 82, 0, {"1": n})

text("B4 LENS CARRIER v1", 88, 97.6, 0.9)

# --- net classes ----------------------------------------------------------------
ds = board.GetDesignSettings()
nsx = ds.m_NetSettings
pw = pcbnew.NETCLASS("Power")
pw.SetTrackWidth(mm(1.0))
pw.SetClearance(mm(0.2))
pw.SetViaDiameter(mm(1.0))
pw.SetViaDrill(mm(0.5))
nsx.SetNetclass("Power", pw)
vb = pcbnew.NETCLASS("VBUS")
vb.SetTrackWidth(mm(0.4))
vb.SetClearance(mm(0.15))
vb.SetViaDiameter(mm(0.8))
vb.SetViaDrill(mm(0.4))
nsx.SetNetclass("VBUS", vb)
nsx.SetNetclassPatternAssignment("VBUS", "VBUS")
for n in ["V12", "VIN12", "VDC", "GND", "V9", "V5", "ESP_VIN"]:
    nsx.SetNetclassPatternAssignment(n, "Power")
dflt = nsx.GetDefaultNetclass()
dflt.SetTrackWidth(mm(0.3))
dflt.SetClearance(mm(0.15))
dflt.SetViaDiameter(mm(0.8))
dflt.SetViaDrill(mm(0.4))
nsx.RecomputeEffectiveNetclasses()
ds.m_CopperEdgeClearance = mm(0.6)
ds.m_TrackMinWidth = mm(0.15)  # router necks signal tracks to 0.18 between pins; PCBWay: 0.1

pcbnew.SaveBoard(OUT, board)
print("placed", len(board.GetFootprints()), "footprints,", len(nets), "nets ->", OUT)

with open(os.path.join(HERE, "bom.csv"), "w") as f:
    f.write("Ref,Value,Footprint,Note\n")
    for r in BOM:
        f.write(",".join('"' + c.replace('"', "'") + '"' for c in r) + "\n")

if "--route" in sys.argv:
    dsn = OUT.replace(".kicad_pcb", ".dsn")
    ses = OUT.replace(".kicad_pcb", ".ses")
    for (x1, y1, x2, y2) in [(0, 0, W, 1.2), (0, H - 1.2, W, H), (0, 0, 1.2, H), (W - 1.2, 0, W, H)]:
        k = pcbnew.ZONE(board)
        k.SetIsRuleArea(True)
        k.SetDoNotAllowTracks(True)
        k.SetDoNotAllowVias(True)
        k.SetDoNotAllowZoneFills(False)
        k.SetDoNotAllowPads(False)
        k.SetDoNotAllowFootprints(False)
        k.SetLayerSet(pcbnew.LSET.AllCuMask())
        o = k.Outline()
        o.NewOutline()
        for (x, y) in [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]:
            o.Append(mm(x), mm(y))
        board.Add(k)
    pcbnew.ExportSpecctraDSN(board, dsn)
    subprocess.run([JAVA, "-jar", FREEROUTING, "-de", dsn, "-do", ses, "-mp", "40", "--gui.enabled=false"], check=True)
    pcbnew.ImportSpecctraSES(board, ses)
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer)
        z.SetNet(net("GND"))
        z.SetLocalClearance(mm(0.3))
        z.SetMinThickness(mm(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)  # solid; GND pads are small
        poly = z.Outline()
        poly.NewOutline()
        for (x, y) in [(0.5, 0.8), (W - 0.5, 0.8), (W - 0.5, H - 0.5), (0.5, H - 0.5)]:
            poly.Append(mm(x), mm(y))
        board.Add(z)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(OUT, board)
    print("routed ->", OUT)
