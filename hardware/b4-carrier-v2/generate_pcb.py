#!/usr/bin/env python3
"""
B4 lens carrier v2 - SMD, assembled by PCBWay, 4 layers, 2S 18650 on board.

Run with KiCad's Python:
    /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
        hardware/b4-carrier-v2/generate_pcb.py [--route]

Every chip value below comes from the manufacturer's datasheet (README.md lists
the sections). The analog stages are the ones measured and simulated for v1.

Power tree:
    USB-C (CH224A asks for 12 V) --B540C--+
    DC jack 6..20 V --------------B540C---+--> BQ25798 VBUS (buck-boost charger, 2S, NVDC)
                                               |  BAT <-> 2 x 18650 (fuse, BQ29209 balance/OVP)
                                               +--> VSYS 6..8.4 V
    VSYS --TPS55340 boost--> V12 (12.1 V) --TPS259541 eFuse (1.5 A, 13.7 V clamp)--> V12E
         --20 mOhm shunt (INA219)--> LENS +12 V
    V12 --LM317--> V9 (LM324, CD4066)          VSYS --AP63205--> V5 (ESP32, remote)
    V5 --AP2112K--> A3V3 (DAC, ADC, INA219, pots, OLED, offsets)
"""
from __future__ import annotations

import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "b4-carrier-v2.kicad_pcb")
FPROOT = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/"
FREEROUTING = os.path.join(HERE, "..", "..", ".tools", "freerouting.jar")
JAVA = "/opt/homebrew/opt/openjdk/bin/java"

W, H = 135.0, 92.0


def mm(v: float) -> int:
    return pcbnew.FromMM(v)


board = pcbnew.BOARD()
board.SetCopperLayerCount(4)
nets: dict[str, pcbnew.NETINFO_ITEM] = {}


def net(name: str):
    if name not in nets:
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        nets[name] = n
    return nets[name]


F = {
    "R": ("Resistor_SMD", "R_0603_1608Metric"),
    "R08": ("Resistor_SMD", "R_0805_2012Metric"),
    "R2512": ("Resistor_SMD", "R_2512_6332Metric"),
    "C": ("Capacitor_SMD", "C_0603_1608Metric"),
    "C08": ("Capacitor_SMD", "C_0805_2012Metric"),
    "C12": ("Capacitor_SMD", "C_1206_3216Metric"),
    "CP8": ("Capacitor_SMD", "CP_Elec_8x10"),
    "USBC": ("Connector_USB", "USB_C_Receptacle_HRO_TYPE-C-31-M-12"),
    "SSOP10EP": ("Package_SO", "SSOP-10-1EP_3.9x4.9mm_P1mm_EP2.1x3.3mm"),
    "DCJACK": ("Connector_BarrelJack", "BarrelJack_CUI_PJ-063AH_Horizontal"),
    "SMC": ("Diode_SMD", "D_SMC"),
    "SMB": ("Diode_SMD", "D_SMB"),
    "SOD323": ("Diode_SMD", "D_SOD-323"),
    "RQM": ("Package_DFN_QFN", "Texas_RQM0029A_VQFN-29_4x4mm_P0.4mm"),
    "L7": ("Inductor_SMD", "L_Bourns_SRP7028A_7.3x6.6mm"),
    "L4": ("Inductor_SMD", "L_Bourns-SRN4018"),
    "HTSSOP14": ("Package_SO", "Texas_HTSSOP-14-1EP_4.4x5mm_P0.65mm_EP3.4x5mm_Mask2.94x3.34mm_ThermalVias"),
    "DSG": ("Package_SON", "Texas_DSG0008A_WSON-8-1EP_2x2mm_P0.5mm_EP0.9x1.6mm"),
    "DRB": ("Package_SON", "VSON-8-1EP_3x3mm_P0.65mm_EP1.65x2.4mm"),
    "SOT223": ("Package_TO_SOT_SMD", "SOT-223-3_TabPin2"),
    "SOT23": ("Package_TO_SOT_SMD", "SOT-23"),
    "SOT235": ("Package_TO_SOT_SMD", "SOT-23-5"),
    "SOT236": ("Package_TO_SOT_SMD", "SOT-23-6"),
    "SOT238": ("Package_TO_SOT_SMD", "SOT-23-8"),
    "MSOP10": ("Package_SO", "MSOP-10_3x3mm_P0.5mm"),
    "SOIC14": ("Package_SO", "SOIC-14_3.9x8.7mm_P1.27mm"),
    "SMDIP4": ("Package_DIP", "SMDIP-4_W7.62mm"),
    "FUSE1812": ("Fuse", "Fuse_1812_4532Metric"),
    "FUSE1206": ("Fuse", "Fuse_1206_3216Metric"),
    "BAT": ("Battery", "BatteryHolder_Keystone_1042_1x18650"),
    "XH3": ("Connector_JST", "JST_XH_B3B-XH-A_1x03_P2.50mm_Vertical"),
    "XH4": ("Connector_JST", "JST_XH_B4B-XH-A_1x04_P2.50mm_Vertical"),
    "XH5": ("Connector_JST", "JST_XH_B5B-XH-A_1x05_P2.50mm_Vertical"),
    "XH10": ("Connector_JST", "JST_XH_B10B-XH-A_1x10_P2.50mm_Vertical"),
    "S15": ("Connector_PinSocket_2.54mm", "PinSocket_1x15_P2.54mm_Vertical"),
    "S20": ("Connector_PinSocket_2.54mm", "PinSocket_1x20_P2.54mm_Vertical"),
    "H3": ("Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical"),
    "POT": ("Potentiometer_THT", "Potentiometer_Alps_RK09K_Single_Vertical"),
    "SW": ("Button_Switch_SMD", "SW_SPST_PTS645Sx43SMTR92"),
    "LED": ("LED_SMD", "LED_0603_1608Metric"),
    "NTC": ("Resistor_SMD", "R_0603_1608Metric"),
    "TP": ("TestPoint", "TestPoint_Pad_D1.0mm"),
    "MH": ("MountingHole", "MountingHole_3.2mm_M3_DIN965_Pad"),
}

BOM: list[tuple] = []
OFF = [0.0, 0.0]   # block offset: every block is drawn at its own origin and shifted here
FIXED: set[str] = set()   # parts the legaliser must not move
SMT_REFS: set[str] = set()


def place(ref, kind, value, x, y, rot=0.0, pads=None, mpn="", bottom=False, smt=True, note=""):
    lib, name = F[kind]
    fp = pcbnew.FootprintLoad(FPROOT + lib + ".pretty", name)
    if fp is None:
        sys.exit(f"footprint not found: {lib}:{name}")
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.SetPosition(pcbnew.VECTOR2I(mm(x + OFF[0]), mm(y + OFF[1])))
    fp.SetOrientationDegrees(rot)
    board.Add(fp)
    if bottom:
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_TOP_BOTTOM)
    names = {p.GetName() for p in fp.Pads()}
    for k in (pads or {}):
        if k not in names:
            print(f"WARN {ref}: pad {k} not in {lib}:{name} ({sorted(names)})")
    for pad in fp.Pads():
        n = (pads or {}).get(pad.GetName())
        if n:
            pad.SetNet(net(n))
        elif pad.GetName() and smt:
            print(f"open {ref}.{pad.GetName()}")
    BOM.append((ref, value, f"{lib}:{name}", mpn, "SMT" if smt else "hand", note))
    if smt:
        SMT_REFS.add(ref)
    return fp


def R(ref, val, a, b, x, y, rot=0.0, kind="R", mpn=""):
    return place(ref, kind, val, x, y, rot, {"1": a, "2": b}, mpn or f"{val} 1% {kind.replace('R', '') or '0603'}")


def C(ref, val, a, b, x, y, rot=0.0, kind="C", mpn=""):
    return place(ref, kind, val, x, y, rot, {"1": a, "2": b}, mpn or f"{val} X7R")


def text(s, x, y, size=1.2, layer=pcbnew.F_SilkS, rot=0.0, bold=True):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(s)
    t.SetPosition(pcbnew.VECTOR2I(mm(x + OFF[0]), mm(y + OFF[1])))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
    t.SetTextThickness(mm(size * (0.18 if bold else 0.12)))
    t.SetTextAngleDegrees(rot)
    if layer == pcbnew.B_SilkS:
        t.SetMirrored(True)
    board.Add(t)


def box(x1, y1, x2, y2, layer=pcbnew.F_Fab, label=None):
    for (a1, b1, a2, b2) in [(x1, y1, x2, y1), (x2, y1, x2, y2), (x2, y2, x1, y2), (x1, y2, x1, y1)]:
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(mm(a1), mm(b1)))
        s.SetEnd(pcbnew.VECTOR2I(mm(a2), mm(b2)))
        s.SetLayer(layer)
        s.SetWidth(mm(0.15))
        board.Add(s)
    if label:
        text(label, (x1 + x2) / 2, y2 - 1.2, 0.9, layer=layer, bold=False)


# --- outline + holes ---------------------------------------------------------------
for (x1, y1, x2, y2) in [(0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)]:
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(mm(x1), mm(y1)))
    s.SetEnd(pcbnew.VECTOR2I(mm(x2), mm(y2)))
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetWidth(mm(0.1))
    board.Add(s)
for i, (x, y) in enumerate([(14.2, 4), (W - 4, 4), (4, 66.5), (W - 4, H - 4)], 1):
    place(f"H{i}", "MH", "M3", x, y, pads={"1": "GND"}, smt=False)

# =============================== POWER IN ===========================================
place("J1", "USBC", "USB-C PD/CHARGE", 5.5, 8, 270, {
    "A4": "USB_VBUS", "A9": "USB_VBUS", "B4": "USB_VBUS", "B9": "USB_VBUS",
    "A1": "GND", "A12": "GND", "B1": "GND", "B12": "GND", "SH": "GND",
    "A5": "CC1", "B5": "CC2", "A6": "DP", "B6": "DP", "A7": "DM", "B7": "DM"},
    mpn="HRO TYPE-C-31-M-12 (LCSC C165948)")
place("U1", "SSOP10EP", "CH224A", 15.5, 11, 0, {
    "1": "USB_VBUS", "8": "USB_VBUS", "9": "PD_CFG1", "6": "CC2", "7": "CC1", "10": "PD_PG", "11": "GND"},
    mpn="WCH CH224A, 24k on CFG1 = 12 V (datasheet tab. 5-1)")
R("R1", "24k", "PD_CFG1", "GND", 19.5, 13.5)
C("C1", "1uF 25V", "USB_VBUS", "GND", 19.5, 8, kind="C08")
place("J2", "DCJACK", "DC 6-20V", 28, 12.5, 180, {"1": "DC_IN", "2": "GND", "MP": "GND"}, smt=False,
      mpn="CUI PJ-063AH")
place("D1", "SMC", "B540C", 38, 7, 90, {"2": "USB_VBUS", "1": "CHG_IN"}, mpn="Diodes B540C-13-F")
place("D2", "SMC", "B540C", 45, 7, 90, {"2": "DC_IN", "1": "CHG_IN"}, mpn="Diodes B540C-13-F")
place("D3", "SMB", "SMBJ22A", 51.2, 6, 90, {"1": "CHG_IN", "2": "GND"}, mpn="TVS SMBJ22A, cathode to CHG_IN")

# ------------------------------- charger BQ25798 ------------------------------------
OFF[:] = [-4, -14]
U2 = place("U2", "RQM", "BQ25798", 24, 40, 0, {
    "1": "CHG_STAT", "2": "CHG_IN", "3": "CHG_IN", "4": "BTST1", "5": "REGN",
    "6": "DP", "7": "DM", "8": "CHG_IN", "9": "CHG_IN", "10": "GND", "11": "GND",
    "12": "QON", "13": "CHG_CE", "14": "SCL", "15": "SDA", "16": "TS", "17": "REGN",
    "18": "BATP", "19": "BTST2", "20": "PROG", "21": "CHG_INT", "22": "VBAT", "23": "VBAT",
    "24": "SDRV", "25": "VSYS", "26": "SW2", "27": "GND", "28": "SW1", "29": "PMID"},
    mpn="TI BQ25798RQMR")
place("L1", "L7", "2.2uH", 27, 49.5, 0, {"1": "SW1", "2": "SW2"}, mpn="2.2 uH >= 8 A sat, e.g. Bourns SRP7028A-2R2M")
C("C2", "47nF 25V", "BTST1", "SW1", 18.5, 36.5)
C("C3", "47nF 25V", "BTST2", "SW2", 29.5, 36.5)
C("C4", "4.7uF 16V", "REGN", "GND", 18.5, 43.5, kind="C08")
for i, (x, y) in enumerate([(16, 33), (16, 47)]):
    C(f"C{5 + i}", "10uF 25V", "CHG_IN", "GND", x, y, kind="C12")
C("C7", "100nF 50V", "CHG_IN", "GND", 20, 33)
for i, (x, y) in enumerate([(32, 31), (32, 34.5), (32, 38)]):
    C(f"C{8 + i}", "10uF 25V", "PMID", "GND", x, y, kind="C12")
C("C11", "100nF 50V", "PMID", "GND", 28, 33)
for i, (x, y) in enumerate([(32, 43), (32, 46.5), (32, 50), (35.5, 43), (35.5, 46.5)]):
    C(f"C{12 + i}", "10uF 25V", "VSYS", "GND", x, y, kind="C12")
C("C17", "100nF 50V", "VSYS", "GND", 28, 46)
C("C18", "10uF 25V", "VBAT", "GND", 16, 50.5, kind="C12")
C("C19", "10uF 25V", "VBAT", "GND", 16, 54, kind="C12")
R("R2", "8.2k", "PROG", "GND", 20, 46.5, mpn="8.2k 1% 0603: 750 kHz, 2S (datasheet 7.3.2)")
R("R3", "100", "VBAT", "BATP", 24, 46.5)
C("C20", "1nF 50V", "SDRV", "GND", 28, 49)
R("R4", "5.23k", "REGN", "TS", 13, 40)
R("R5", "30.1k", "TS", "GND", 13, 43)
place("RT1", "NTC", "10k NTC 103AT", 41, 52, 0, {"1": "TS", "2": "GND"}, mpn="Semitec 103AT-2 or 10k B3435 0603, at the cells")
R("R6", "10k", "CHG_INT", "A3V3", 13, 46)
R("R7", "1k", "A3V3", "LED_CHG", 13, 37)
place("LED1", "LED", "CHG", 9, 37, 0, {"1": "CHG_STAT", "2": "LED_CHG"}, mpn="0603 orange")
place("TP1", "TP", "QON", 9, 41, pads={"1": "QON"})

# ------------------------------- cells, fuse, balancer -------------------------------
OFF[:] = [0, 0]
place("BT1", "BAT", "18650 low", 46.5, 26, 0, {"1": "VMID", "2": "GND"}, bottom=True, smt=False,
      mpn="Keystone 1042 + 18650 cell (protected cell recommended)")
place("BT2", "BAT", "18650 high", 46.5, 50, 0, {"1": "VBAT_RAW", "2": "VMID"}, bottom=True, smt=False,
      mpn="Keystone 1042 + 18650 cell")
OFF[:] = [0, -12]
place("F1", "FUSE1812", "5A", 9, 56, 90, {"1": "VBAT_RAW", "2": "VBAT"}, mpn="Littelfuse 1812L500 or SMD fuse 5 A 1812")
place("U3", "DRB", "BQ29209", 9, 64, 0, {
    "1": "BAL_VC2", "2": "BAL_VC1", "3": "BAL_CB", "4": "BAL_CD", "5": "GND",
    "6": "BAL_VDD", "7": "BAL_VDD", "8": "BAL_OUT", "9": "GND"},
    mpn="TI BQ29209DRBR: 2S OVP + balancing")
R("R8", "1k", "VBAT_RAW", "BAL_VC2", 14, 61)
R("R9", "1k", "VMID", "BAL_VC1", 14, 64)
C("C21", "100nF", "BAL_VC2", "BAL_VC1", 14, 67)
C("C22", "100nF", "BAL_VC1", "GND", 14, 70)
R("R10", "910", "VMID", "BAL_CB", 4, 67, mpn="910 5% 0603: ~3 mA balance current")
R("R11", "100", "VBAT_RAW", "BAL_VDD", 4, 61)
C("C23", "100nF", "BAL_VDD", "GND", 4, 64)
C("C24", "100nF", "BAL_CD", "GND", 9, 70)
R("R12", "100k", "BAL_OUT", "CHG_CE", 4, 71, mpn="OUT high on cell overvoltage -> CE high -> no charging")
R("R13", "47k", "CHG_CE", "GND", 4, 74)

# ------------------------------- boost VSYS -> 12 V (TPS55340) -----------------------
OFF[:] = [-1, 10]
place("U4", "HTSSOP14", "TPS55340", 48, 13, 0, {
    "1": "BST_SW", "2": "BST_SW", "3": "VSYS", "4": "BST_EN", "5": "BST_SS", "6": "GND",
    "7": "GND", "8": "BST_COMP", "9": "BST_FB", "10": "BST_FREQ", "11": "GND",
    "12": "GND", "13": "GND", "14": "GND", "15": "GND"}, mpn="TI TPS55340PWPR")
place("L2", "L7", "10uH", 40, 22, 0, {"1": "VSYS", "2": "BST_SW"}, mpn="10 uH >= 6 A sat, e.g. Bourns SRP7028A-100M")
place("D4", "SMC", "B540C", 52, 22, 0, {"2": "BST_SW", "1": "V12"}, mpn="Diodes B540C-13-F")
C("C25", "10uF 25V", "VSYS", "GND", 40, 8, kind="C12")
C("C26", "10uF 25V", "VSYS", "GND", 40, 11.5, kind="C12")
C("C27", "100nF 50V", "VSYS", "GND", 44, 8)
R("R14", "100k", "VSYS", "BST_EN", 44, 17.5)
C("C28", "47nF", "BST_SS", "GND", 52, 17.5)
R("R15", "78.7k", "BST_FREQ", "GND", 55, 15.5, mpn="78.7k 1%: 600 kHz (datasheet 8.2.1.2.2)")
R("R16", "2k", "BST_COMP", "BST_RC", 55, 11)
C("C29", "100nF", "BST_RC", "GND", 55, 8)
C("C30", "100pF", "BST_COMP", "GND", 52, 8)
R("R17", "88.7k", "V12", "BST_FB", 59, 13, mpn="88.7k 1%: 12.13 V with 10k (eq. 24)")
R("R18", "10k", "BST_FB", "GND", 59, 16)
for i, (x, y) in enumerate([(58, 22), (58, 25.5), (61.5, 22)]):
    C(f"C{31 + i}", "10uF 25V", "V12", "GND", x, y, kind="C12")
place("C34", "CP8", "100uF 25V", 47, 30, 0, {"1": "V12", "2": "GND"}, mpn="100 uF 25 V low-ESR electrolytic, 8x10")

# ------------------------------- eFuse + current monitor -----------------------------
OFF[:] = [0, 10]
place("U5", "DSG", "TPS259541", 66, 12, 0, {
    "1": "EF_DVDT", "2": "EF_EN", "3": "V12", "4": "V12", "5": "V12E", "6": "EF_FLT",
    "7": "EF_ILM", "8": "GND", "9": "GND"}, mpn="TI TPS259541DSGR: 13.7 V clamp, auto-retry")
C("C35", "22nF", "EF_DVDT", "GND", 63, 9)
R("R19", "1.4k", "EF_ILM", "GND", 69, 9, mpn="1.40k 1%: ~1.5 A limit (datasheet ILIMIT table)")
R("R20", "100k", "V12", "EF_EN", 63, 16)
R("R21", "13.7k", "EF_EN", "GND", 66, 16, mpn="UVLO ~10 V")
place("Q1", "SOT23", "AO3400A", 70, 16, 0, {"1": "LENS_OFF", "2": "GND", "3": "EF_EN"}, mpn="AO3400A: GPIO high = lens power off")
R("R22", "100k", "LENS_OFF", "GND", 73, 16)
R("R23", "10k", "EF_FLT", "A3V3", 73, 12)
place("RS1", "R2512", "20mR", 77, 8, 0, {"1": "V12E", "2": "V12_LENS"}, mpn="20 mOhm 1% 2512, 1 W")
place("U6", "SOT238", "INA219", 77, 14, 0, {
    "1": "GND", "2": "GND", "3": "SDA", "4": "SCL", "5": "A3V3", "6": "GND", "7": "V12_LENS", "8": "V12E"},
    mpn="TI INA219AIDCNR (SOT-23-8: A1 A0 SDA SCL VS GND IN- IN+), addr 0x40")
C("C36", "100nF", "A3V3", "GND", 81, 17)
C("C37", "10uF 25V", "V12_LENS", "GND", 82, 11, kind="C12")

# ------------------------------- 9 V, 5 V, 3.3 V -------------------------------------
OFF[:] = [5, -16]
place("U7", "SOT223", "LM317", 86, 22, 0, {"1": "LDO_ADJ", "2": "V9", "3": "V12"}, mpn="LM317 SOT-223")
R("R24", "240", "V9", "LDO_ADJ", 82, 27)
R("R25", "1.5k", "LDO_ADJ", "GND", 85, 27, mpn="9.06 V")
C("C38", "1uF 25V", "V12", "GND", 82, 22, kind="C08")
C("C39", "10uF 25V", "V9", "GND", 90, 27, kind="C12")
OFF[:] = [-20, 12]
place("U8", "SOT236", "AP63205", 40, 36, 0, {
    "1": "V5", "2": "VSYS", "3": "VSYS", "4": "GND", "5": "B5_SW", "6": "B5_BST"},
    mpn="Diodes AP63205WU-7 (FB VOUT, EN, VIN, GND, SW, BST)")
place("L3", "L4", "4.7uH", 40, 42, 0, {"1": "B5_SW", "2": "V5"}, mpn="4.7 uH >= 3 A, e.g. Bourns SRN4018-4R7M")
C("C40", "100nF", "B5_BST", "B5_SW", 44, 34)
C("C41", "10uF 25V", "VSYS", "GND", 36, 33, kind="C12")
C("C42", "22uF 10V", "V5", "GND", 44.5, 40, kind="C12")
C("C43", "22uF 10V", "V5", "GND", 44.5, 43.5, kind="C12")
place("D5", "SOD323", "BAT60A", 48, 36, 0, {"2": "V5", "1": "ESP_5V"}, mpn="Schottky 1 A SOD-323: no back-feed from the ESP32's USB")
place("U9", "SOT235", "AP2112K-3.3", 48, 42, 0, {"1": "V5", "2": "GND", "3": "V5", "5": "A3V3"}, mpn="Diodes AP2112K-3.3TRG1")
C("C44", "1uF", "V5", "GND", 52, 40)
C("C45", "4.7uF", "A3V3", "GND", 52, 44, kind="C08")
R("R26", "1k", "V5", "LED_PWR", 48, 47)
place("LED2", "LED", "PWR", 52, 47, 0, {"1": "GND", "2": "LED_PWR"}, mpn="0603 green")

# =============================== ANALOG =============================================
OFF[:] = [4, 1]
place("U10", "MSOP10", "MCP4728", 59, 33, 0, {
    "1": "A3V3", "2": "SCL", "3": "SDA", "4": "GND", "6": "DAC_A", "7": "DAC_B",
    "8": "DAC_C", "9": "DAC_D", "10": "GND"}, mpn="Microchip MCP4728-E/UN, LDAC low")
C("C46", "100nF", "A3V3", "GND", 59, 29)
place("U11", "MSOP10", "ADS1115", 76, 33, 0, {
    "1": "GND", "3": "GND", "4": "ADC0", "5": "ADC1", "6": "ADC2", "7": "ADC3",
    "8": "A3V3", "9": "SDA", "10": "SCL"}, mpn="TI ADS1115IDGSR, ADDR=GND -> 0x48")
C("C47", "100nF", "A3V3", "GND", 76, 29)
place("U12", "SOIC14", "LM324", 59, 45, 0, {
    "1": "I_OUT", "2": "I_N", "3": "I_P", "4": "V9", "5": "Z_P", "6": "Z_N", "7": "Z_OUT",
    "8": "F_OUT", "9": "F_N", "10": "F_P", "11": "GND", "12": "GND", "13": "D_OUT", "14": "D_OUT"},
    mpn="LM324DR")
C("C48", "100nF", "V9", "GND", 54, 39)
place("U13", "SOIC14", "CD4066B", 71, 45, 0, {
    "1": "I_SW", "2": "IRIS_CTRL", "3": "ZOOM_CTRL", "4": "Z_SW", "5": "SW_CTRL", "6": "SW_CTRL",
    "7": "GND", "8": "F_SW", "9": "FOCUS_CTRL", "10": "REMOTE", "11": "REM_SRC", "12": "SW_CTRL",
    "13": "SW_CTRL", "14": "V9"}, mpn="TI CD4066BM96: outputs open until the firmware enables them")
C("C49", "100nF", "V9", "GND", 76, 39)

# iris stage (bench values)
R("R30", "10k", "DAC_A", "I_P", 52, 51)
R("R31", "10k", "A3V3", "I_RA", 55, 51)
R("R32", "5.6k", "I_RA", "I_P", 58, 51)
R("R33", "10k", "I_N", "GND", 61, 51)
R("R34", "10k", "I_OUT", "I_N", 64, 51)
R("R35", "1k", "I_OUT", "I_SW", 67, 51)
C("C50", "100nF", "I_P", "GND", 52, 54)
# zoom / focus: REF + 1.8*(DAC - DAC_C), 100k/180k (simulated, v1 simulation/README.md)
R("R40", "100k", "DAC_C", "Z_N", 55, 54)
R("R41", "180k", "Z_N", "Z_OUT", 58, 54)
R("R42", "100k", "DAC_B", "Z_P", 61, 54)
R("R43", "180k", "Z_P", "ZREF", 64, 54)
R("R44", "1.2k", "Z_OUT", "Z_SW", 67, 54)
R("R45", "100k", "DAC_C", "F_N", 55, 57)
R("R46", "180k", "F_N", "F_OUT", 58, 57)
R("R47", "100k", "DAC_D", "F_P", 61, 57)
R("R48", "180k", "F_P", "FREF", 64, 57)
R("R49", "1.2k", "F_OUT", "F_SW", 67, 57)
R("R50", "1k", "V5", "REM_SRC", 70, 51, mpn="pin 8 remote: 5 V through 1k (through the CD4066)")
# readback 100k/68k + 100nF
for i, (src, dst) in enumerate([("IRIS_CTRL", "ADC3"), ("IRIS_POS", "ADC0"), ("ZOOM_POS", "ADC1"), ("FOCUS_POS", "ADC2")]):
    R(f"R{51 + 2 * i}", "100k", src, dst, 73 + 3 * i, 51)
    R(f"R{52 + 2 * i}", "68k", dst, "GND", 73 + 3 * i, 54)
    C(f"C{51 + i}", "100nF", dst, "GND", 73 + 3 * i, 57)
# output-enable level shifter: GPIO high -> 9 V on the CD4066 controls
place("Q2", "SOT23", "AO3401A", 80, 41, 0, {"1": "SW_G", "2": "V9", "3": "SW_CTRL"}, mpn="AO3401A P-ch")
place("Q3", "SOT23", "AO3400A", 80, 46, 0, {"1": "OUT_EN", "2": "GND", "3": "SW_GD"}, mpn="AO3400A N-ch")
R("R60", "100k", "V9", "SW_G", 84, 41)
R("R61", "10k", "SW_GD", "SW_G", 84, 44)
R("R62", "100k", "OUT_EN", "GND", 84, 47)
R("R63", "100k", "SW_CTRL", "GND", 84, 50)

# =============================== ESP32 (DevKit V1 or S3-ETH) ==========================
# Fused block: DevKit rows at x0 and x0+22.86/25.40/27.94 (15 pins); S3-ETH rows at
# x0+2.54 (VBUS row) and x0+20.32 (IO20 row), RJ45 end towards the bottom edge.
OFF[:] = [0, 0]
X0, Y0 = 102.0, 9.0
dk_l = ["-", "GND", "-", "-", "BTN_LED", "-", "-", "-", "-", "STAT_LED", "SDA", "-", "-", "SCL", "-"]
dk_r = ["ESP_5V", "GND", "BTN_RET", "-", "TALLY_G", "TALLY_R", "LENS_OFF", "OUT_EN", "BTN_VTR", "TALLY_IN",
        "POT_Z", "POT_I", "CHG_INT", "POT_F", "-"]
# DevKit GPIOs: 4 BTN_LED, 16 EF_FLT, 19 STAT, 21 SDA, 22 SCL | VIN, 13 RET, 14 TALLY_G, 27 TALLY_R,
# 26 LENS_OFF, 25 OUT_EN, 33 VTR, 32 TALLY_IN, 35 POT_Z, 34 POT_I, 39 (VN) CHG_INT, 36 (VP) POT_F.
dk_l[5] = "EF_FLT"  # left row pin 6 = RX2 = GPIO16
place("J10", "S15", "DEVKIT 3V3 ROW", X0, Y0, 0, {str(i + 1): n for i, n in enumerate(dk_l) if n != "-"},
      smt=False, mpn="female header 1x15, DevKit V1")
for k, gap in enumerate([22.86, 25.40, 27.94]):
    place(f"J{11 + k}", "S15", f"DEVKIT VIN ROW {gap:.2f}", X0 + gap, Y0, 0,
          {str(i + 1): n for i, n in enumerate(dk_r) if n != "-"}, smt=False,
          mpn=f"female header 1x15 - fit only the {gap:.2f} mm row your DevKit needs")
# S3-ETH turned 180 deg (RJ45 down): pin 1 of each Waveshare row is at the bottom.
s3_vbus_row = ["-", "ESP_5V", "GND", "-", "-", "-", "SCL", "GND", "SDA", "CHG_INT", "-", "OUT_EN", "GND",
               "POT_F", "POT_Z", "POT_I", "-", "GND", "EF_FLT", "STAT_LED"]   # VBUS VSYS GND 3V3EN 3V3 IO21 IO17 GND IO16 IO18 RUN IO15 GND IO3 IO2 IO1 IO0 GND IO44 IO43
s3_io20_row = ["-", "-", "GND", "BTN_LED", "BTN_RET", "-", "-", "GND", "BTN_VTR", "TALLY_IN", "TALLY_G", "TALLY_R",
               "GND", "LENS_OFF", "-", "-", "-", "GND", "-", "-"]     # IO20 IO19 GND IO48 IO47 IO46 IO45 GND IO42 IO41 IO40 IO39 GND IO38 IO37 IO36 IO35 GND IO34 IO33
place("J14", "S20", "S3-ETH VBUS ROW", X0 + 2.54, Y0 + 19 * 2.54, 180,
      {str(i + 1): n for i, n in enumerate(s3_vbus_row) if n != "-"}, smt=False, mpn="female header 1x20, ESP32-S3-ETH")
place("J15", "S20", "S3-ETH IO20 ROW", X0 + 20.32, Y0 + 19 * 2.54, 180,
      {str(i + 1): n for i, n in enumerate(s3_io20_row) if n != "-"}, smt=False, mpn="female header 1x20, ESP32-S3-ETH")
box(X0 - 2.6, Y0 - 8, X0 + 25.4 + 2.6, Y0 + 43.5, label="DEVKIT V1")
box(X0 + 0.9, Y0 - 3, X0 + 21.96, Y0 + 48.26 + 20, label="ESP32-S3-ETH")
text("ESP32: DEVKIT V1  oder  S3-ETH (+PoE)", X0 + 10, Y0 - 5.5, 0.85)
text("NUR EIN BOARD", X0 + 14, Y0 + 71, 1.0)

R("R64", "4.7k", "SDA", "A3V3", 95, 33)
R("R65", "4.7k", "SCL", "A3V3", 95, 36)
R("R66", "330", "STAT_LED", "LED_ST", 95, 39)
place("LED3", "LED", "STATUS", 95, 42, 0, {"1": "GND", "2": "LED_ST"}, mpn="0603 blue")

# =============================== I/O: buttons, tally, pots ==========================
# VTR / RET: on-board switch, external JST, lens grip (via Schottky, wired-OR)
for nm, sw_x, lens in [("VTR", 11, "LENS_VTR"), ("RET", 24, "LENS_RET")]:
    place(f"SW_{nm}", "SW", nm, sw_x + 1, 73.5, 0, {"1": f"BTN_{nm}_RAW", "2": "GND"}, mpn="C&K PTS645SM43SMTR92")
    R(f"R_{nm}P", "10k", f"BTN_{nm}_RAW", "A3V3", sw_x - 4.5, 66)
    R(f"R_{nm}S", "1k", f"BTN_{nm}_RAW", f"BTN_{nm}", sw_x - 1.5, 66)
    C(f"C_{nm}", "100nF", f"BTN_{nm}", "GND", sw_x + 1.5, 66)
    place(f"D_{nm}", "SOD323", "BAT54J", sw_x + 4.5, 66, 0, {"2": f"BTN_{nm}_RAW", "1": lens},
          mpn="Schottky SOD-323: lens grip button pulls the line low, lens voltage blocked")
text("VTR", 12, 69.3, 1.0)
text("RET", 25, 69.3, 1.0)
place("Q4", "SOT23", "AO3400A", 32, 72, 0, {"1": "BTN_LED", "2": "GND", "3": "BTN_LED_D"}, mpn="AO3400A")
R("R67", "150", "BTN_LED_D", "BTN_LED_K", 35.5, 72)
R("R68", "100k", "BTN_LED", "GND", 32, 75)
place("J20", "XH5", "BUTTONS", 33, 87.8, 0, {"1": "V5", "2": "BTN_LED_K", "3": "BTN_VTR_RAW", "4": "BTN_RET_RAW", "5": "GND"},
      smt=False, mpn="JST B5B-XH-A")
text("BUTTONS", 38, 81.5, 1.0)
for i, lbl in enumerate(["5V", "LED", "VTR", "RET", "GND"]):
    text(lbl, 33 + 2.5 * i, 83.4, 0.8, bold=False, rot=90)

# tally: two 12 V low-side outputs, one optocoupled input
place("U14", "SMDIP4", "PC817", 97, 59, 90, {"1": "TIN_A", "2": "TIN_N", "3": "GND", "4": "TALLY_IN"}, mpn="PC817C SMD")
R("R73", "2.2k", "TIN_P", "TIN_A", 93.5, 55, kind="R08", mpn="2.2k 0805: 5-24 V tally input")
R("R74", "10k", "TALLY_IN", "A3V3", 100.5, 55)
place("F2", "FUSE1206", "0.5A PTC", 97, 66, 0, {"1": "V12", "2": "TALLY_V"}, mpn="0.5 A hold PTC 1206")
place("Q5", "SOT23", "AO3400A", 95, 71, 0, {"1": "TALLY_R_G", "2": "GND", "3": "TALLY_R_D"}, mpn="AO3400A")
place("Q6", "SOT23", "AO3400A", 95, 77, 0, {"1": "TALLY_G_G", "2": "GND", "3": "TALLY_G_D"}, mpn="AO3400A")
R("R69", "100", "TALLY_R", "TALLY_R_G", 99.5, 70)
R("R70", "100", "TALLY_G", "TALLY_G_G", 99.5, 76)
R("R71", "100k", "TALLY_R_G", "GND", 99.5, 72.5)
R("R72", "100k", "TALLY_G_G", "GND", 99.5, 78.5)
place("J21", "XH5", "TALLY", 93, 87.8, 0, {"1": "TALLY_V", "2": "TALLY_R_D", "3": "TALLY_G_D", "4": "TIN_P", "5": "TIN_N"},
      smt=False, mpn="JST B5B-XH-A")
text("TALLY", 98, 81.5, 1.0)
for i, lbl in enumerate(["12V", "RED", "GRN", "IN+", "IN-"]):
    text(lbl, 93 + 2.5 * i, 83.4, 0.8, bold=False, rot=90)

# pots: on-board or external per axis
for i, (ax, gpio) in enumerate([("I", "POT_I"), ("Z", "POT_Z"), ("F", "POT_F")]):
    x = 49.5 + i * 14.6
    name = ("IRIS", "ZOOM", "FOCUS")[i]
    place(f"RV{i + 1}", "POT", f"10k {name}", x, 74, 0, {"1": "A3V3", "2": f"RV{ax}W", "3": "GND"},
          smt=False, mpn="Alps RK09K1130A (zoom: with centre detent)")
    place(f"JP{i + 1}", "H3", f"POT {ax}", x + 1, 66.5, 90, {"1": f"RV{ax}W", "2": f"P{ax}", "3": f"EXT_{ax}"}, smt=False,
          mpn="1x3 header + jumper: 1-2 on-board, 2-3 external")
    R(f"R{80 + i}", "1k", f"P{ax}", gpio, x + 9, 64)
    C(f"C{80 + i}", "100nF", gpio, "GND", x + 9, 66.5)
    place(f"J{22 + i}", "XH3", f"EXT POT {ax}", x + 1.5, 87.8, 0, {"1": "A3V3", "2": f"EXT_{ax}", "3": "GND"}, smt=False,
          mpn="JST B3B-XH-A")
    text(name, x + 6, 83.4, 1.0)
    text("BRD  EXT", x + 3, 63.6, 0.8, bold=False)

# =============================== external connectors =================================
place("J3", "XH10", "LENS", 3.5, 87.8, 0, {
    "1": "V12_LENS", "2": "GND", "3": "IRIS_CTRL", "4": "IRIS_POS", "5": "REMOTE",
    "6": "ZOOM_POS", "7": "FOCUS_POS", "8": "LENS_RET", "9": "LENS_VTR", "10": "LENS12"},
    smt=False, mpn="JST B10B-XH-A to Hirose HR10 12-pin")
text("LENS (HIROSE 12)", 14.75, 78.3, 1.2)
for i, lbl in enumerate(["6 +12V", "3 GND", "5 IRIS", "7 IPOS", "8 REM", "10 ZPOS", "11 FPOS", "1 RET", "2 VTR", "12"]):
    text(lbl, 3.5 + i * 2.5, 81.6, 0.8, bold=False, rot=90)
place("J4", "XH4", "ZOOM DEMAND", 71, 3, 0, {"1": "GND", "2": "ZOOM_CTRL", "3": "ZREF", "4": "ZSOCK_POS"},
      smt=False, mpn="JST B4B-XH-A to the black grip socket: GND, 6, 7, 9")
text("ZOOM DEMAND", 75, 8.0, 1.0)
text("GND 6 7 9", 75, 9.6, 0.8, bold=False)
place("J5", "XH4", "FOCUS DEMAND", 111, 87.8, 0, {"1": "GND", "2": "FOCUS_CTRL", "3": "FREF", "4": "FSOCK_POS"},
      smt=False, mpn="JST B4B-XH-A, focus module socket (pinout to be measured)")
text("FOCUS DEMAND", 115, 81.5, 1.0)
for i, lbl in enumerate(["GND", "CTL", "REF", "POS"]):
    text(lbl, 111 + 2.5 * i, 83.4, 0.8, bold=False, rot=90)
place("J6", "XH4", "OLED", 57.5, 3, 0, {"1": "GND", "2": "A3V3", "3": "SCL", "4": "SDA"}, smt=False,
      mpn="JST B4B-XH-A: OLED SSD1306 on a cable (GND VCC SCL SDA)")
text("OLED", 61.5, 8.0, 1.0)
text("GND 3V3 SCL SDA", 61.5, 9.6, 0.8, bold=False)
text("USB-C", 5.5, 15, 0.9)
text("DC 6-20V", 28, 15.6, 0.9)
text("2x 18650 - POLUNG BEACHTEN", 46.5, 38, 1.5, layer=pcbnew.B_SilkS)
text("B4 LENS CARRIER v2  github.com/larszu/lz-camera-bridge", 46.5, 63, 1.2, layer=pcbnew.B_SilkS)

# test points
for i, n in enumerate(["CHG_IN", "VSYS", "VBAT", "V12", "V12_LENS", "V9", "V5", "A3V3", "IRIS_CTRL", "ZOOM_CTRL", "GND", "GND"]):
    place(f"TP{10 + i}", "TP", n, 30 + (i % 6) * 2.6, 64.5 + (i // 6) * 3.4, pads={"1": n})
text("TEST", 23.5, 66.2, 0.8)

# =============================== legaliser ===========================================
# Blocks are drawn by hand; small parts that land on something are pushed to the
# nearest free spot (courtyard boxes, 0.2 mm gap; bottom-side holder pads count).
SMALL = ("R", "C", "LED", "TP", "Q", "D", "RT", "F")


def cy_box(fp, grow=0.0):
    cy = fp.GetCourtyard(pcbnew.F_CrtYd if fp.GetSide() == 0 else pcbnew.B_CrtYd)
    bb = cy.BBox() if cy.OutlineCount() else fp.GetBoundingBox(False)
    return [pcbnew.ToMM(bb.GetX()) - grow, pcbnew.ToMM(bb.GetY()) - grow,
            pcbnew.ToMM(bb.GetRight()) + grow, pcbnew.ToMM(bb.GetBottom()) + grow]


def hit(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def is_small(fp):
    r = fp.GetReference()
    return r.startswith(SMALL) and not r.startswith(("CP",)) and r not in ("C34", "D1", "D2", "D3", "D4", "F1", "RS1")


holder_pads = []   # pads and pegs of the bottom-side cell holders
for fp in board.GetFootprints():
    if fp.GetSide() != 0:
        for p in fp.Pads():
            if p.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH:
                continue   # SMD tabs on the bottom do not bother the top side
            bb = p.GetBoundingBox()
            holder_pads.append([pcbnew.ToMM(bb.GetX()) - 0.6, pcbnew.ToMM(bb.GetY()) - 0.6,
                                pcbnew.ToMM(bb.GetRight()) + 0.6, pcbnew.ToMM(bb.GetBottom()) + 0.6])
holders = [cy_box(fp) for fp in board.GetFootprints() if fp.GetSide() != 0]
obst = list(holder_pads)
for fp in board.GetFootprints():
    if fp.GetSide() != 0 or is_small(fp):
        continue
    obst.append(cy_box(fp, 0.1))
    for p in fp.Pads():
        bb = p.GetBoundingBox()
        pb = [pcbnew.ToMM(bb.GetX()), pcbnew.ToMM(bb.GetY()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom())]
        if any(hit(pb, o) for o in holder_pads):
            print("WARN", fp.GetReference(), "pad", p.GetName(), "on a holder pad/peg")
            break
    if any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and p.GetDrillSize().x > mm(0.4) for p in fp.Pads()):
        if any(hit(cy_box(fp), h) for h in holders):
            print("WARN THT over holder:", fp.GetReference())
moved = 0
for fp in board.GetFootprints():
    if fp.GetSide() != 0 or not is_small(fp):
        continue
    bx = cy_box(fp, 0.1)
    if not any(hit(bx, o) for o in obst) and 0.6 < bx[0] and bx[2] < W - 0.6 and 0.6 < bx[1] and bx[3] < H - 0.6:
        obst.append(bx)
        continue
    p0 = fp.GetPosition()
    best = None
    for r in range(1, 60):
        for k in range(-r, r + 1):
            for (dx, dy) in ((k, -r), (k, r), (-r, k), (r, k)):
                d = (dx * 0.25, dy * 0.25)
                b = [bx[0] + d[0], bx[1] + d[1], bx[2] + d[0], bx[3] + d[1]]
                if 0.6 < b[0] and b[2] < W - 0.6 and 0.6 < b[1] and b[3] < H - 0.6 and not any(hit(b, o) for o in obst):
                    if best is None or d[0] ** 2 + d[1] ** 2 < best[0] ** 2 + best[1] ** 2:
                        best = d
        if best:
            break
    if best is None:
        print("WARN no room for", fp.GetReference())
        obst.append(bx)
        continue
    fp.SetPosition(pcbnew.VECTOR2I(p0.x + mm(best[0]), p0.y + mm(best[1])))
    obst.append([bx[0] + best[0], bx[1] + best[1], bx[2] + best[0], bx[3] + best[1]])
    moved += 1
print("legaliser moved", moved, "parts")

# =============================== rules, zones ==========================================
ds = board.GetDesignSettings()
nsx = ds.m_NetSettings
def nc(name, w, clr=0.15, via=0.6, drill=0.3):
    c = pcbnew.NETCLASS(name)
    c.SetTrackWidth(mm(w)); c.SetClearance(mm(clr)); c.SetViaDiameter(mm(via)); c.SetViaDrill(mm(drill))
    nsx.SetNetclass(name, c)
nc("Power", 0.4, 0.15, 0.6, 0.3)
nc("HighCurrent", 0.5, 0.15, 0.7, 0.35)
for n in ["V9", "V5", "ESP_5V", "TALLY_V", "BAL_VDD"]:
    nsx.SetNetclassPatternAssignment(n, "Power")
for n in ["CHG_IN", "USB_VBUS", "DC_IN", "PMID", "VSYS", "VBAT", "VBAT_RAW", "VMID", "SW1", "SW2", "BST_SW",
          "V12", "V12E", "V12_LENS"]:
    nsx.SetNetclassPatternAssignment(n, "HighCurrent")
d = nsx.GetDefaultNetclass()
d.SetTrackWidth(mm(0.2)); d.SetClearance(mm(0.15)); d.SetViaDiameter(mm(0.6)); d.SetViaDrill(mm(0.3))
nsx.RecomputeEffectiveNetclasses()
ds.m_CopperEdgeClearance = mm(0.5)
ds.m_TrackMinWidth = mm(0.12)
ds.m_MinThroughDrill = mm(0.2)   # thermal vias under the TPS55340

for fp in board.GetFootprints():   # silkscreen: references only, small
    fp.Value().SetVisible(False)
    fp.Reference().SetTextSize(pcbnew.VECTOR2I(mm(0.8), mm(0.8)))
    fp.Reference().SetTextThickness(mm(0.12))
pcbnew.SaveBoard(OUT, board)
print("placed", len(board.GetFootprints()), "footprints,", len(nets), "nets")

with open(os.path.join(HERE, "bom.csv"), "w") as f:
    f.write("Ref,Value,Footprint,Part / MPN,Assembly,Note\n")
    for r in BOM:
        f.write(",".join('"' + str(c).replace('"', "'") + '"' for c in r) + "\n")

if "--route" in sys.argv:
    for (x1, y1, x2, y2) in [(0, 0, W, 1.0), (0, H - 1.0, W, H), (0, 0, 1.0, H), (W - 1.0, 0, W, H)]:
        k = pcbnew.ZONE(board); k.SetIsRuleArea(True); k.SetDoNotAllowTracks(True); k.SetDoNotAllowVias(True)
        k.SetDoNotAllowZoneFills(False); k.SetDoNotAllowPads(False); k.SetDoNotAllowFootprints(False)
        k.SetLayerSet(pcbnew.LSET.AllCuMask())
        o = k.Outline(); o.NewOutline()
        for (x, y) in [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]:
            o.Append(mm(x), mm(y))
        board.Add(k)
    # all four layers route; GND is poured on every layer afterwards (In1 stays mostly solid)
    dsn = OUT.replace(".kicad_pcb", ".dsn"); ses = OUT.replace(".kicad_pcb", ".ses")
    pcbnew.ExportSpecctraDSN(board, dsn)
    subprocess.run([JAVA, "-jar", FREEROUTING, "-de", dsn, "-do", ses, "-mp", "60", "--gui.enabled=false"], check=True)
    pcbnew.ImportSpecctraSES(board, ses)
    for layer in (pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(net("GND"))
        z.SetLocalClearance(mm(0.25)); z.SetMinThickness(mm(0.2))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
        o = z.Outline(); o.NewOutline()
        for (x, y) in [(0.4, 0.4), (W - 0.4, 0.4), (W - 0.4, H - 0.4), (0.4, H - 0.4)]:
            o.Append(mm(x), mm(y))
        board.Add(z)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(OUT, board)
    print("routed")
