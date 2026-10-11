#!/usr/bin/env python3
"""
Post-processing for the routed v2 board (run by generate_pcb.py --route, or alone):

1. Power nets: every track of a HighCurrent / Power net gets a copper pour along
   it (1.5 mm / 0.8 mm wide), clipped automatically where other copper is near.
   Freerouting can only route one width per net; at the 0.4 mm pitch of the
   BQ25798 that has to be narrow, the pours make it wide everywhere else.
2. Every via of a HighCurrent net gets companions (3 vias), Power nets 2.
3. GND stitching vias wherever all four layers are ground.
4. Measures the copper width along every power track and lists bottlenecks.
5. Moves reference designators to a free spot next to their part (no pads,
   no other silk), hides the ones that do not fit (they stay on F.Fab).

Writes width-report.txt next to the board.
"""
from __future__ import annotations

import math
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "b4-carrier-v2.kicad_pcb")
F = pcbnew.FromMM
T = pcbnew.ToMM

HC_W, PW_W = 1.5, 0.8          # target copper width (mm)
HC_VIAS, PW_VIAS = 1, 1   # trunks already bring via clusters (power_trunks.py)
CU = [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]

b = pcbnew.LoadBoard(os.path.join(HERE, "routed.kicad_pcb"))   # Freerouting result, kept untouched
W = T(b.GetBoardEdgesBoundingBox().GetWidth())
H = T(b.GetBoardEdgesBoundingBox().GetHeight())


POWER = {"V9", "V5", "ESP_5V", "TALLY_V", "BAL_VDD"}
HIGH = {"CHG_IN", "USB_VBUS", "DC_IN", "PMID", "VSYS", "VBAT", "VBAT_RAW", "VMID", "SW1", "SW2", "BST_SW",
        "V12", "V12E", "V12_LENS"}   # same lists as generate_pcb.py


def netclass(item):
    n = item.GetNetname()
    return "HighCurrent" if n in HIGH else "Power" if n in POWER else "Default"


def capsule(x1, y1, x2, y2, hw, n=8):
    """Polygon of a track with half-width hw (round ends approximated)."""
    a = math.atan2(y2 - y1, x2 - x1)
    pts = []
    for k in range(n + 1):
        t = a + math.pi / 2 + math.pi * k / n
        pts.append((x2 + hw * math.cos(t - math.pi), y2 + hw * math.sin(t - math.pi)))
    for k in range(n + 1):
        t = a + math.pi / 2 + math.pi * k / n
        pts.append((x1 + hw * math.cos(t), y1 + hw * math.sin(t)))
    s = pcbnew.SHAPE_POLY_SET()
    s.NewOutline()
    for (x, y) in pts:
        s.Append(F(x), F(y))
    return s


def rect(x1, y1, x2, y2):
    s = pcbnew.SHAPE_POLY_SET()
    s.NewOutline()
    for (x, y) in [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]:
        s.Append(F(x), F(y))
    return s


# ---------------------------------------------------------------- clean old runs
for z in list(b.Zones()):
    if z.GetZoneName().startswith(("pp_", "gnd_")):
        b.Remove(z)
for t in list(b.GetTracks()):
    if isinstance(t, pcbnew.PCB_VIA) and t.IsLocked() and t.GetNetname() != "" and "pp" in str(t.GetFlags()):
        pass

# ---------------------------------------------------------------- 2. companion vias
def copper_items():
    out = []
    for t in b.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA):
            out.append((t.GetNetCode(), "via", T(t.GetPosition().x), T(t.GetPosition().y), T(t.GetWidth(pcbnew.F_Cu)) / 2, None))
        else:
            out.append((t.GetNetCode(), "seg", T(t.GetStart().x), T(t.GetStart().y), T(t.GetWidth()) / 2,
                        (T(t.GetEnd().x), T(t.GetEnd().y), t.GetLayer())))
    for p in b.GetPads():
        bb = p.GetBoundingBox()
        out.append((p.GetNetCode(), "pad", T(bb.GetX()), T(bb.GetY()), 0, (T(bb.GetRight()), T(bb.GetBottom()),
                    p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH))))
    return out


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    u = 0 if L == 0 else max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / L))
    return math.hypot(px - (x1 + u * dx), py - (y1 + u * dy))


def via_free(x, y, r, netcode, items, clr=0.2):
    if not (1.0 < x < W - 1.0 and 1.0 < y < H - 1.0):
        return False
    for (nc, kind, a, c, hw, e) in items:
        if kind == "via":
            if math.hypot(x - a, y - c) < r + hw + (clr if nc != netcode else 0.25):
                return False
        elif kind == "seg":
            if nc != netcode and seg_dist(x, y, a, c, e[0], e[1]) < r + hw + clr:
                return False
        else:
            if (nc != netcode or e[2]) and a - r - clr < x < e[0] + r + clr and c - r - clr < y < e[1] + r + clr:
                return False
    return True


items = copper_items()
added = 0
extra_polys = {}   # (netname, layer) -> list of SHAPE_POLY_SET
for v in [t for t in b.GetTracks() if isinstance(t, pcbnew.PCB_VIA)]:
    cls = netclass(v)
    want = {"HighCurrent": HC_VIAS, "Power": PW_VIAS}.get(cls, 1) - 1
    if want <= 0:
        continue
    x0, y0 = T(v.GetPosition().x), T(v.GetPosition().y)
    r = T(v.GetWidth(pcbnew.F_Cu)) / 2
    for (dx, dy) in [(1.0, 0), (-1.0, 0), (0, 1.0), (0, -1.0), (0.75, 0.75), (-0.75, 0.75), (0.75, -0.75), (-0.75, -0.75)]:
        if want == 0:
            break
        x, y = x0 + dx, y0 + dy
        if via_free(x, y, r, v.GetNetCode(), items):
            nv = pcbnew.PCB_VIA(b)
            nv.SetPosition(pcbnew.VECTOR2I(F(x), F(y)))
            nv.SetWidth(v.GetWidth(pcbnew.F_Cu))
            nv.SetDrill(v.GetDrill())
            nv.SetNet(v.GetNet())
            b.Add(nv)
            items.append((v.GetNetCode(), "via", x, y, r, None))
            for lay in CU:
                extra_polys.setdefault((v.GetNetname(), lay), []).append(capsule(x0, y0, x, y, 0.5))
            added += 1
            want -= 1
print("companion vias:", added)

# ---------------------------------------------------------------- 1. widening pours
polys = {}
for t in b.GetTracks():
    if isinstance(t, pcbnew.PCB_VIA):
        continue
    cls = netclass(t)
    if cls not in ("HighCurrent", "Power"):
        continue
    hw = (HC_W if cls == "HighCurrent" else PW_W) / 2
    polys.setdefault((t.GetNetname(), t.GetLayer()), []).append(
        capsule(T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x), T(t.GetEnd().y), hw))
for p in b.GetPads():
    if p.GetNetname() and netclass(p) in ("HighCurrent", "Power"):
        bb = p.GetBoundingBox()
        for lay in CU:
            if p.IsOnLayer(lay):
                polys.setdefault((p.GetNetname(), lay), []).append(
                    rect(T(bb.GetX()) - 0.25, T(bb.GetY()) - 0.25, T(bb.GetRight()) + 0.25, T(bb.GetBottom()) + 0.25))
for k, v in extra_polys.items():
    polys.setdefault(k, []).extend(v)

nets = b.GetNetsByName()
nz = 0
for (name, lay), ps in polys.items():
    u = pcbnew.SHAPE_POLY_SET()
    for p in ps:
        u.BooleanAdd(p)
    u.Simplify()
    z = pcbnew.ZONE(b)
    z.SetZoneName(f"pp_{name}")
    z.SetLayer(lay)
    z.SetNet(nets[name])
    z.SetAssignedPriority(2 if netclass(z) == "HighCurrent" else 1)
    z.SetLocalClearance(F(0.2))
    z.SetMinThickness(F(0.2))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    o = z.Outline()   # copy point by point: SetOutline() would keep a pointer to a Python-owned set
    for i in range(u.OutlineCount()):
        c = u.COutline(i)
        o.NewOutline()
        for j in range(c.PointCount()):
            pt = c.CPoint(j)
            o.Append(pt.x, pt.y)
    b.Add(z)
    nz += 1
for z in b.Zones():
    if not z.GetIsRuleArea() and z.GetNetname() == "GND" and not z.GetZoneName():
        z.SetZoneName("gnd_pour")
        z.SetAssignedPriority(0)
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
print("power pours:", nz)
pcbnew.ZONE_FILLER(b).Fill(b.Zones())

# ---------------------------------------------------------------- 3. GND stitching
gnd = nets["GND"]
fills = {lay: [] for lay in CU}
for z in b.Zones():
    if z.GetNetname() == "GND" and not z.GetIsRuleArea():
        for lay in CU:
            if z.IsOnLayer(lay):
                fills[lay].append(z.GetFilledPolysList(lay))


def in_gnd_everywhere(x, y, r):
    for lay in CU:
        for (dx, dy) in [(0, 0), (r, 0), (-r, 0), (0, r), (0, -r), (r * .7, r * .7), (-r * .7, r * .7), (r * .7, -r * .7), (-r * .7, -r * .7)]:
            pt = pcbnew.VECTOR2I(F(x + dx), F(y + dy))
            if not any(fp.Contains(pt) for fp in fills[lay]):
                return False
    return True


items = copper_items()
stitched = 0
y = 2.5
while y < H - 2:
    x = 2.5
    while x < W - 2:
        if in_gnd_everywhere(x, y, 0.65) and via_free(x, y, 0.3, gnd.GetNetCode(), items, 0.25):
            nv = pcbnew.PCB_VIA(b)
            nv.SetPosition(pcbnew.VECTOR2I(F(x), F(y)))
            nv.SetWidth(F(0.6))
            nv.SetDrill(F(0.3))
            nv.SetNet(gnd)
            b.Add(nv)
            items.append((gnd.GetNetCode(), "via", x, y, 0.3, None))
            stitched += 1
        x += 4.0
    y += 4.0
print("GND stitching vias:", stitched)
pcbnew.ZONE_FILLER(b).Fill(b.Zones())

# ---------------------------------------------------------------- 4. width report
same = {}
for z in b.Zones():
    if z.GetZoneName().startswith("pp_"):
        same.setdefault((z.GetNetname(), z.GetLayer()), []).append(z.GetFilledPolysList(z.GetLayer()))
pads_xy = [(T(p.GetPosition().x), T(p.GetPosition().y)) for p in b.GetPads()]
report = []
worst = {}
for t in b.GetTracks():
    if isinstance(t, pcbnew.PCB_VIA):
        continue
    cls = netclass(t)
    if cls not in ("HighCurrent", "Power"):
        continue
    target = HC_W if cls == "HighCurrent" else PW_W
    x1, y1, x2, y2 = T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x), T(t.GetEnd().y)
    L = math.hypot(x2 - x1, y2 - y1)
    if L < 0.05:
        continue
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    nx, ny = -uy, ux
    tw = T(t.GetWidth())
    fl = same.get((t.GetNetname(), t.GetLayer()), [])
    s = 0.2
    while s < L - 0.2:
        cx, cy = x1 + ux * s, y1 + uy * s
        if min(math.hypot(cx - px, cy - py) for (px, py) in pads_xy) > 1.5:
            wsum = 0.0
            for sign in (1, -1):
                d = tw / 2
                while d < target:
                    pt = pcbnew.VECTOR2I(F(cx + sign * nx * (d + 0.05)), F(cy + sign * ny * (d + 0.05)))
                    if not any(f.Contains(pt) for f in fl):
                        break
                    d += 0.05
                wsum += d
            key = t.GetNetname()
            if wsum < worst.get(key, (99,))[0]:
                worst[key] = (wsum, cx, cy, pcbnew.LayerName(t.GetLayer()) if hasattr(pcbnew, "LayerName") else b.GetLayerName(t.GetLayer()), target)
        s += 0.4
with open(os.path.join(HERE, "width-report.txt"), "w") as f:
    f.write("Narrowest copper width per power net (away from pads, mm)\n")
    for k, (w, x, y, lay, target) in sorted(worst.items(), key=lambda kv: kv[1][0] / kv[1][4]):
        line = f"{k:12s} {w:5.2f} of {target:.1f}  at ({x:6.1f},{y:6.1f}) {lay}"
        f.write(line + "\n")
        report.append(line)
print("\n".join(report[:12]))

# ---------------------------------------------------------------- 5. silkscreen
# the fused ESP32 headers: keep J10's outline only, the overlapping copies go
for f in b.GetFootprints():
    if f.GetReference() in ("J11", "J12", "J13", "J14", "J15"):
        for g in list(f.GraphicalItems()):
            if g.GetLayer() == pcbnew.F_SilkS and not isinstance(g, pcbnew.PCB_TEXT):
                f.Remove(g)

obst = []      # boxes the silk must not touch
def box_of(bb, g=0.0):
    return [T(bb.GetX()) - g, T(bb.GetY()) - g, T(bb.GetRight()) + g, T(bb.GetBottom()) + g]
def hit(a, c):
    return a[0] < c[2] and c[0] < a[2] and a[1] < c[3] and c[1] < a[3]

for p in b.GetPads():
    if p.IsOnLayer(pcbnew.F_Cu) or p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
        obst.append(box_of(p.GetBoundingBox(), 0.15))
for f in b.GetFootprints():
    for g in f.GraphicalItems():
        if g.GetLayer() == pcbnew.F_SilkS and not isinstance(g, pcbnew.PCB_TEXT):
            obst.append(box_of(g.GetBoundingBox(), 0.1))
# board labels first: shift a label off pads / outlines if it landed on them
labels_moved = []
for d in b.GetDrawings():
    if not (isinstance(d, pcbnew.PCB_TEXT) and d.GetLayer() == pcbnew.F_SilkS):
        continue
    p0 = d.GetPosition()
    for (dx, dy) in [(0, 0), (0, -0.8), (0, 0.8), (0, -1.6), (0, 1.6), (-1.5, 0), (1.5, 0), (-3, 0), (3, 0),
                     (0, -2.4), (0, 2.4), (-1.5, -0.8), (1.5, -0.8), (-1.5, 0.8), (1.5, 0.8),
                     (-4.5, 0), (4.5, 0), (0, -3.2), (0, 3.2), (-6, 0), (6, 0), (-4.5, -1.6), (4.5, -1.6)]:
        d.SetPosition(pcbnew.VECTOR2I(p0.x + F(dx), p0.y + F(dy)))
        bx = box_of(d.GetBoundingBox(), 0.05)
        if not any(hit(bx, o) for o in obst) and 0.6 < bx[0] and bx[2] < W - 0.6 and 0.6 < bx[1] and bx[3] < H - 0.6:
            if (dx, dy) != (0, 0):
                labels_moved.append(d.GetText())
            break
    else:
        d.SetPosition(p0)
        print("WARN label without a free spot:", d.GetText())
    obst.append(box_of(d.GetBoundingBox(), 0.15))
print("labels moved:", labels_moved)

hidden, moved = [], 0
fps = sorted(b.GetFootprints(), key=lambda f: -T(f.GetBoundingBox(False).GetWidth()) * T(f.GetBoundingBox(False).GetHeight()))
for f in fps:
    ref = f.Reference()
    if f.GetSide() != 0 or not ref.IsVisible():
        continue
    cy = f.GetCourtyard(pcbnew.F_CrtYd)
    cb = box_of(cy.BBox()) if cy.OutlineCount() else box_of(f.GetBoundingBox(False))
    cx, cyy = (cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2
    ref.SetTextSize(pcbnew.VECTOR2I(F(0.8), F(0.8)))
    ref.SetTextThickness(F(0.12))
    cands = []
    for rot in (0, 90):
        for off in (0, -1.5, 1.5, -3, 3):
            if rot == 0:
                cands += [(cx + off, cb[1] - 0.65, rot), (cx + off, cb[3] + 0.65, rot)]
            else:
                cands += [(cb[0] - 0.65, cyy + off, rot), (cb[2] + 0.65, cyy + off, rot)]
    ok = False
    for (x, y, rot) in cands:
        ref.SetTextAngleDegrees(rot)   # absolute angle of the field
        ref.SetPosition(pcbnew.VECTOR2I(F(x), F(y)))
        bx = box_of(ref.GetBoundingBox(), 0.05)
        if 0.6 < bx[0] and bx[2] < W - 0.6 and 0.6 < bx[1] and bx[3] < H - 0.6 and not any(hit(bx, o) for o in obst):
            obst.append(bx)
            ok = True
            moved += 1
            break
    if not ok:
        ref.SetVisible(False)
        hidden.append(f.GetReference())
print("references placed:", moved, "hidden (still on F.Fab):", len(hidden), " ".join(sorted(hidden)))

pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(PCB, b)

# ---------------------------------------------------------------- 6. final clean-up
# with the pours in place KiCad may still see a stray via or a stub that leads
# nowhere; unlocked ones go (locked copper is the charger core and the trunks)
import json, shutil, subprocess, tempfile   # noqa: E401,E402
CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
LN = {"F.Cu": pcbnew.F_Cu, "In1.Cu": pcbnew.In1_Cu, "In2.Cu": pcbnew.In2_Cu, "B.Cu": pcbnew.B_Cu}
for _ in range(5):
    tmp = tempfile.mkdtemp()
    shutil.copy(PCB, os.path.join(tmp, "b.kicad_pcb"))
    shutil.copy(PCB.replace(".kicad_pcb", ".kicad_pro"), os.path.join(tmp, "b.kicad_pro"))
    subprocess.run([CLI, "pcb", "drc", "--refill-zones", "--format", "json", "-o", os.path.join(tmp, "d.json"),
                    os.path.join(tmp, "b.kicad_pcb")], capture_output=True)
    bad = [v["items"][0] for v in json.load(open(os.path.join(tmp, "d.json")))["violations"]
           if v["type"] in ("via_dangling", "track_dangling")]
    if not bad:
        break
    b = pcbnew.LoadBoard(PCB)
    kill = []
    for t in b.Tracks():
        if t.IsLocked():
            continue
        for it in bad:
            p, d = it["pos"], it["description"]
            if f"[{t.GetNetname()}]" not in d:
                continue
            if isinstance(t, pcbnew.PCB_VIA):
                q = t.GetPosition()
                if d.startswith("Via") and abs(T(q.x) - p["x"]) < 0.01 and abs(T(q.y) - p["y"]) < 0.01:
                    kill.append(t)
            elif d.startswith("Track") and any(f"on {n}" in d and t.GetLayer() == l for n, l in LN.items()) \
                    and t.HitTest(pcbnew.VECTOR2I(F(p["x"]), F(p["y"])), F(0.01)):
                kill.append(t)
    if not kill:
        break
    for t in kill:
        b.Delete(t)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(PCB, b)
    print("final clean-up removed", len(kill))
print("saved")
