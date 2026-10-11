#!/usr/bin/env python3
"""
Finishes what Freerouting left open on routed.kicad_pcb:

1. prunes dead copper (vias and track ends that lead nowhere),
2. routes every remaining unconnected pair from KiCad's DRC with a small
   four-layer grid router (0.1 mm, via cost, own clearance check),
3. writes routed.kicad_pcb back. postprocess.py runs afterwards.
"""
import heapq
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
ROUTED = os.path.join(HERE, "routed.kicad_pcb")
CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
F, T = pcbnew.FromMM, pcbnew.ToMM
RES = 0.05     # pin centres of 0.4 / 0.5 / 0.65 mm pitch parts sit on this grid
CLR = 0.16     # board default clearance 0.15 + margin
VIA_D, VIA_DR = 0.45, 0.2   # PCBWay standard: 0.2 mm drill, 0.125 mm ring
POWER = {"V9", "V5", "ESP_5V", "TALLY_V", "BAL_VDD", "CHG_IN", "USB_VBUS", "DC_IN", "PMID", "VSYS", "VBAT",
         "VBAT_RAW", "VMID", "SW1", "SW2", "BST_SW", "V12", "V12E", "V12_LENS"}


def drc_unconnected(path):
    tmp = tempfile.mkdtemp()
    shutil.copy(path, os.path.join(tmp, "b.kicad_pcb"))
    shutil.copy(os.path.join(HERE, "b4-carrier-v2.kicad_pro"), os.path.join(tmp, "b.kicad_pro"))
    out = os.path.join(tmp, "d.json")
    subprocess.run([CLI, "pcb", "drc", "--format", "json", "-o", out, os.path.join(tmp, "b.kicad_pcb")],
                   capture_output=True)
    d = json.load(open(out))
    return d["unconnected_items"]


b = pcbnew.LoadBoard(ROUTED)
CU = [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]


# ------------------------------------------------------------------ 1. prune dead copper
def touches(x, y, r, item):
    if isinstance(item, pcbnew.PAD):
        return item.HitTest(pcbnew.VECTOR2I(F(x), F(y)), F(r))
    if isinstance(item, pcbnew.PCB_VIA):
        return math.hypot(x - T(item.GetPosition().x), y - T(item.GetPosition().y)) <= r + T(item.GetWidth(pcbnew.F_Cu)) / 2
    return item.HitTest(pcbnew.VECTOR2I(F(x), F(y)), F(r))


# rip-up: copper that blocks a pin which has no other way out (net, x, y, radius)
RIPUP = []
for (nn, rx, ry, rr) in RIPUP:
    for t in list(b.Tracks()):
        if nn == "*" and (t.GetNetname() in POWER or t.GetNetname() == "GND" or t.IsLocked() and T(t.GetWidth(pcbnew.F_Cu) if isinstance(t, pcbnew.PCB_VIA) else t.GetWidth()) >= 0.6):
            continue
        if nn != "*" and t.GetNetname() != nn:
            continue
        pts = [t.GetPosition()] if isinstance(t, pcbnew.PCB_VIA) else [t.GetStart(), t.GetEnd()]
        if any(math.hypot(T(p.x) - rx, T(p.y) - ry) < rr for p in pts):
            b.Delete(t)

# duplicate vias (same net, same spot) and zero-length tracks
seen = {}
for t in list(b.Tracks()):
    if isinstance(t, pcbnew.PCB_VIA):
        k = (t.GetNetCode(), round(T(t.GetPosition().x), 2), round(T(t.GetPosition().y), 2))
        if k in seen:
            b.Delete(t)
        else:
            seen[k] = t
    elif t.GetStart() == t.GetEnd():
        b.Delete(t)
    else:
        e = sorted([(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)])
        k = (t.GetNetCode(), t.GetLayer(), tuple(e))
        if k in seen:
            b.Delete(t)       # stacked copies keep each other "connected" and survive pruning
        else:
            seen[k] = t

pruned = 0
for _ in range(2000):
    changed = False
    tracks = list(b.Tracks())
    by_net = {}
    for t in tracks:
        by_net.setdefault(t.GetNetCode(), []).append(t)
    pads_by_net = {}
    for p in b.GetPads():
        pads_by_net.setdefault(p.GetNetCode(), []).append(p)
    for t in tracks:
        if t.GetNetname() == "GND":
            continue
        others = [o for o in by_net.get(t.GetNetCode(), []) if o is not t] + pads_by_net.get(t.GetNetCode(), [])
        if isinstance(t, pcbnew.PCB_VIA):
            x, y = T(t.GetPosition().x), T(t.GetPosition().y)
            n = sum(1 for o in others if touches(x, y, T(t.GetWidth(pcbnew.F_Cu)) / 2, o))
            if n <= 1:
                b.Delete(t)
                changed = True
                pruned += 1
                break   # lists are stale now
            continue
        for end in (t.GetStart(), t.GetEnd()):
            x, y = T(end.x), T(end.y)
            ok = False
            for o in others:
                if isinstance(o, pcbnew.PAD):
                    if o.IsOnLayer(t.GetLayer()) and o.HitTest(end):
                        ok = True
                        break
                elif isinstance(o, pcbnew.PCB_VIA):
                    if touches(x, y, T(t.GetWidth()) / 2, o):
                        ok = True
                        break
                elif o.GetLayer() == t.GetLayer() and o.HitTest(end, F(T(t.GetWidth()) / 2)):
                    ok = True
                    break
            if not ok:
                b.Delete(t)
                changed = True
                pruned += 1
                break
        if changed:
            break
    if not changed:
        break
print("pruned dead copper:", pruned)
pcbnew.SaveBoard(ROUTED, b)


# ------------------------------------------------------------------ 2. grid router
class Win:
    def __init__(self, x1, y1, x2, y2):
        x1, y1 = math.floor(x1 / RES) * RES, math.floor(y1 / RES) * RES   # aligned grid
        self.x0, self.y0 = x1, y1
        self.nx, self.ny = int((x2 - x1) / RES) + 1, int((y2 - y1) / RES) + 1

    def ij(self, x, y):
        return int(round((x - self.x0) / RES)), int(round((y - self.y0) / RES))

    def xy(self, i, j):
        return self.x0 + i * RES, self.y0 + j * RES


def obstacles(board, netcode):
    """(layer or None for all, kind, geometry) of other-net copper"""
    obs = []
    for p in board.GetPads():
        if p.GetNetCode() == netcode and p.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH:
            continue
        bb = p.GetBoundingBox()
        box = (T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom()))
        if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
            obs.append((None, "box", box))
        else:
            for lay in CU:
                if p.IsOnLayer(lay):
                    obs.append((lay, "box", box))
    for t in board.Tracks():
        if t.GetNetCode() == netcode:
            continue
        if isinstance(t, pcbnew.PCB_VIA):
            r = T(t.GetWidth(pcbnew.F_Cu)) / 2
            x, y = T(t.GetPosition().x), T(t.GetPosition().y)
            obs.append((None, "seg", (x, y, x, y, r)))
        else:
            obs.append((t.GetLayer(), "seg", (T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x), T(t.GetEnd().y),
                                               T(t.GetWidth()) / 2)))
    return obs


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    u = 0 if L == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L))
    return math.hypot(px - (x1 + u * dx), py - (y1 + u * dy))


def blocked(win, obs, lay, r):
    g = bytearray(win.nx * win.ny)
    W_, H_ = BW, BH
    for j in range(win.ny):
        for i in range(win.nx):
            x, y = win.xy(i, j)
            if x < 0.6 + r or y < 0.6 + r or x > W_ - 0.6 - r or y > H_ - 0.6 - r:
                g[j * win.nx + i] = 1
    for (l, kind, geo) in obs:
        if l is not None and l != lay:
            continue
        m = r + CLR
        if kind == "box":
            x1, y1, x2, y2 = geo
            i1, j1 = win.ij(x1 - m, y1 - m)
            i2, j2 = win.ij(x2 + m, y2 + m)
            for j in range(max(0, j1), min(win.ny, j2 + 1)):
                for i in range(max(0, i1), min(win.nx, i2 + 1)):
                    x, y = win.xy(i, j)
                    dx, dy = max(x1 - x, 0, x - x2), max(y1 - y, 0, y - y2)
                    if math.hypot(dx, dy) < m - 1e-6:
                        g[j * win.nx + i] = 1
        else:
            x1, y1, x2, y2, hw = geo
            mm_ = m + hw
            i1, j1 = win.ij(min(x1, x2) - mm_, min(y1, y2) - mm_)
            i2, j2 = win.ij(max(x1, x2) + mm_, max(y1, y2) + mm_)
            for j in range(max(0, j1), min(win.ny, j2 + 1)):
                for i in range(max(0, i1), min(win.nx, i2 + 1)):
                    x, y = win.xy(i, j)
                    if seg_dist(x, y, x1, y1, x2, y2) < mm_ - 1e-6:
                        g[j * win.nx + i] = 1
    return g


def route(board, netname, a, b_):
    """a, b_: (x, y, [layers]) -> list of (layer, [(x, y)...]) runs, via positions"""
    net = board.GetNetsByName()[netname]
    w = 0.15  # fits between 0.4 mm pitch pins; postprocess.py pours power nets wide
    pad = 5.0
    win = Win(max(0, min(a[0], b_[0]) - pad), max(0, min(a[1], b_[1]) - pad),
              min(BW, max(a[0], b_[0]) + pad), min(BH, max(a[1], b_[1]) + pad))
    obs = obstacles(board, net.GetNetCode())
    g = {lay: blocked(win, obs, lay, w / 2) for lay in CU}
    gv = blocked(win, [(None, k, geo) for (_, k, geo) in obs], None, VIA_D / 2)
    for (pt, lays) in ((a[:2], a[2]), (b_[:2], b_[2])):
        ci, cj = win.ij(*pt)
        for lay in lays:
            for dj in range(-2, 3):
                for di in range(-2, 3):
                    ii, jj = ci + di, cj + dj
                    if 0 <= ii < win.nx and 0 <= jj < win.ny:
                        g[lay][jj * win.nx + ii] = 0
    nx = win.nx
    si = win.ij(*a[:2])
    gi = win.ij(*b_[:2])
    start = [(CU.index(l), si[1] * nx + si[0]) for l in a[2]]
    goals = {(CU.index(l), gi[1] * nx + gi[0]) for l in b_[2]}
    dist, prev, pq = {}, {}, []
    for s in start:
        dist[s] = 0
        heapq.heappush(pq, (0, s))
    steps = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    found = None
    while pq:
        d, (L, c) = heapq.heappop(pq)
        if (L, c) in goals:
            found = (L, c)
            break
        if d > dist.get((L, c), 1e18):
            continue
        i, j = c % nx, c // nx
        nbrs = []
        for (di, dj, cost) in steps:
            ii, jj = i + di, j + dj
            if 0 <= ii < nx and 0 <= jj < win.ny:
                n = jj * nx + ii
                if not g[CU[L]][n] or (L, n) in goals:
                    nbrs.append(((L, n), cost))
        if not gv[c]:
            for L2 in range(4):
                if L2 != L and not g[CU[L2]][c]:
                    nbrs.append(((L2, c), 12))
        for (s, cost) in nbrs:
            nd = d + cost
            if nd < dist.get(s, 1e18):
                dist[s] = nd
                prev[s] = (L, c)
                heapq.heappush(pq, (nd, s))
    if not found:
        return None
    path = [found]
    while path[-1] in prev:
        path.append(prev[path[-1]])
    path.reverse()
    # cut into layer runs, smooth each run on its own grid
    runs, cur = [], [path[0]]
    for s in path[1:]:
        if s[0] != cur[-1][0]:
            runs.append(cur)
            cur = [s]
        else:
            cur.append(s)
    runs.append(cur)
    out, vias = [], []
    for k, run in enumerate(runs):
        lay = CU[run[0][0]]
        cells = [c for (_, c) in run]
        gl = g[lay]
        pts = [cells[0]]
        m = 0
        while m < len(cells) - 1:
            far = m + 1
            for q in range(len(cells) - 1, m, -1):
                if visible(win, gl, cells[m], cells[q]):
                    far = q
                    break
            pts.append(cells[far])
            m = far
        out.append((lay, [win.xy(c % nx, c // nx) for c in pts]))
        if k > 0:
            vias.append(win.xy(cells[0] % nx, cells[0] // nx))
    # exact end points
    out[0][1].insert(0, a[:2])     # short stubs to the exact end points; the checked grid path stays as is
    out[-1][1].append(b_[:2])
    return out, vias, w


def visible(win, g, a, b_):
    nx = win.nx
    (x1, y1), (x2, y2) = (a % nx, a // nx), (b_ % nx, b_ // nx)
    n = int(max(abs(x2 - x1), abs(y2 - y1)) * 2) + 1
    for k in range(n + 1):
        t = k / n
        c = int(round(y1 + (y2 - y1) * t)) * nx + int(round(x1 + (x2 - x1) * t))
        if g[c]:
            return False
    return True


bb = b.GetBoardEdgesBoundingBox()
BW, BH = T(bb.GetWidth()), T(bb.GetHeight())
LAYER_BY_NAME = {"F.Cu": pcbnew.F_Cu, "In1.Cu": pcbnew.In1_Cu, "In2.Cu": pcbnew.In2_Cu, "B.Cu": pcbnew.B_Cu}


def endpoint(item):
    desc, pos = item["description"], item["pos"]
    x, y = pos["x"], pos["y"]
    if desc.startswith("Via") or desc.startswith("PTH pad"):
        lays = CU
    else:
        lays = [l for n, l in LAYER_BY_NAME.items() if f"on {n}" in desc] or [pcbnew.F_Cu]
    # a track's DRC position lies on its centre line: good enough as an end point
    return (x, y, lays)


def add_route(brd, net, res):
    runs, vias, w = res
    nets = brd.GetNetsByName()
    for (lay, pts) in runs:
        for p, q in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(brd)
            t.SetStart(pcbnew.VECTOR2I(F(p[0]), F(p[1])))
            t.SetEnd(pcbnew.VECTOR2I(F(q[0]), F(q[1])))
            t.SetWidth(F(w))
            t.SetLayer(lay)
            t.SetNet(nets[net])
            brd.Add(t)
    have = {(round(T(v.GetPosition().x), 2), round(T(v.GetPosition().y), 2)) for v in brd.Tracks()
            if isinstance(v, pcbnew.PCB_VIA) and v.GetNetname() == net}
    for (x, y) in vias:
        if (round(x, 2), round(y, 2)) in have:
            continue
        v = pcbnew.PCB_VIA(brd)
        v.SetPosition(pcbnew.VECTOR2I(F(x), F(y)))
        v.SetWidth(F(VIA_D))
        v.SetDrill(F(VIA_DR))
        v.SetNet(nets[net])
        brd.Add(v)


def net_of(u):
    return u["items"][0]["description"].split("[")[1].split("]")[0]


BASE = ROUTED.replace(".kicad_pcb", ".base.kicad_pcb")
shutil.copy(ROUTED, BASE)
prefer = []
work = ROUTED.replace(".kicad_pcb", ".work.kicad_pcb")
stuck = []    # end points of connections that failed: their neighbourhood is ripped up next time
for attempt in range(10):
    shutil.copy(BASE, work)
    if stuck:
        bb_ = pcbnew.LoadBoard(work)
        for t in list(bb_.Tracks()):
            if t.IsLocked():
                continue
            pts = [t.GetPosition()] if isinstance(t, pcbnew.PCB_VIA) else [t.GetStart(), t.GetEnd()]
            if any(math.hypot(T(p.x) - x, T(p.y) - y) < 1.2 for p in pts for (x, y, n) in stuck if n != t.GetNetname()):
                bb_.Delete(t)
        pcbnew.SaveBoard(work, bb_)
    failed = []
    for rnd in range(4):
        items = drc_unconnected(work)
        if not items:
            break
        b = pcbnew.LoadBoard(work)
        items.sort(key=lambda u: (prefer.index(net_of(u)) if net_of(u) in prefer else len(prefer),
                                  net_of(u) not in POWER))
        failed = []
        for u in items:
            it = u["items"]
            net = net_of(u)
            res = route(b, net, endpoint(it[0]), endpoint(it[1]))
            if res:
                add_route(b, net, res)
            elif net not in failed:
                failed.append(net)
        pcbnew.SaveBoard(work, b)
    left = drc_unconnected(work)
    for u in left:
        for it in u["items"]:
            stuck.append((it["pos"]["x"], it["pos"]["y"], net_of(u)))
    print(f"attempt {attempt}: {len(left)} unconnected", sorted({net_of(u) for u in left}))
    if not left:
        break
    prefer = [net_of(u) for u in left] + [n for n in prefer if n not in {net_of(u) for u in left}]
    prefer = list(dict.fromkeys(prefer))
shutil.copy(work, ROUTED)
os.remove(work)
os.remove(BASE)


# ------------------------------------------------------------------ 3. leftovers
def drc_all(path):
    tmp = tempfile.mkdtemp()
    shutil.copy(path, os.path.join(tmp, "b.kicad_pcb"))
    shutil.copy(os.path.join(HERE, "b4-carrier-v2.kicad_pro"), os.path.join(tmp, "b.kicad_pro"))
    out = os.path.join(tmp, "d.json")
    subprocess.run([CLI, "pcb", "drc", "--format", "json", "-o", out, os.path.join(tmp, "b.kicad_pcb")], capture_output=True)
    return json.load(open(out))


def brd_layer(t):
    return {pcbnew.F_Cu: "F.Cu", pcbnew.In1_Cu: "In1.Cu", pcbnew.In2_Cu: "In2.Cu", pcbnew.B_Cu: "B.Cu"}[t.GetLayer()]


removed = 0
for _ in range(10):
    d = drc_all(ROUTED)
    bad = [v["items"][0] for v in d["violations"] if v["type"] in ("via_dangling", "track_dangling")]
    b = pcbnew.LoadBoard(ROUTED)
    kill = []
    for t in b.Tracks():
        if t.GetNetname() == "GND" and not isinstance(t, pcbnew.PCB_VIA) and T(t.GetWidth()) < 0.15:
            kill.append(t)          # Freerouting slivers; the GND pour carries it
            continue
        if t.IsLocked():
            continue                 # locked copper (charger core, trunks) is never touched
        for it in bad:
            p = it["pos"]
            if isinstance(t, pcbnew.PCB_VIA):
                pos = t.GetPosition()
                if it["description"].startswith("Via") and abs(T(pos.x) - p["x"]) < 0.01 and abs(T(pos.y) - p["y"]) < 0.01:
                    kill.append(t)
            elif it["description"].startswith("Track") and f"[{t.GetNetname()}]" in it["description"] \
                    and f"on {brd_layer(t)}" in it["description"] and t.HitTest(pcbnew.VECTOR2I(F(p["x"]), F(p["y"])), F(0.01)):
                kill.append(t)
    if not kill:
        break
    for t in kill:
        b.Delete(t)
    removed += len(kill)
    pcbnew.SaveBoard(ROUTED, b)
left = drc_all(ROUTED)["unconnected_items"]
print("leftovers removed:", removed, "- unconnected now:", len(left))
