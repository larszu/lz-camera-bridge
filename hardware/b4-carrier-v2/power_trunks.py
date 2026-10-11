"""
Pre-routes the high-current paths of the v2 board on B.Cu before Freerouting runs.

The bottom side is almost empty (cell holders, through-hole pins), so the main
current paths get wide tracks there: a cluster of vias next to a large pad on the
top (capacitor, diode, fuse), a grid router (A* / Dijkstra, 0.25 mm) on B.Cu,
then line-of-sight smoothing. Near a terminal, where the full width does not fit,
the path starts narrow ("escape") and widens as soon as there is room.
Everything placed here is locked, so Freerouting keeps it.
"""
from __future__ import annotations

import heapq
import math

import pcbnew

F = pcbnew.FromMM
T = pcbnew.ToMM
RES = 0.25          # grid (mm)
CLR = 0.25          # clearance to other nets on B.Cu (mm)
VIA_D, VIA_DRILL = 0.7, 0.35
ESCAPE_W = 0.6

# net, trunk width, terminals ("REF.PAD"), vias per top-side terminal
TRUNKS = [
    ("VMID", 2.0, ["BT1.1", "BT2.2"], 3),
    ("VBAT_RAW", 2.0, ["BT2.1", "F1.1"], 3),
    ("VBAT", 2.0, ["F1.2", "xy:17.05:27.0"], 3),   # vias at the BQ25798 VBAT pins
    ("CHG_IN", 2.0, ["D1.1", "D2.1", "C5.1", "C6.1", "xy:22.75:27.0"], 3),   # + via at U2 pins 2/3
    ("VSYS", 2.0, ["C12.1", "C25.1", "C41.1"], 3),
    ("V12", 1.5, ["C31.1", "xy:63.6:22.5", "U7.3", "F2.1"], 3),   # + via group at the eFuse input
    ("V12_LENS", 1.5, ["C37.1", "J3.1"], 3),
    ("DC_IN", 1.5, ["J2.1", "D2.2"], 3),
    ("USB_VBUS", 1.5, ["C1.1", "D1.2"], 3),
    ("ESP_5V", 1.0, ["D5.1", "J11.1", "J14.2"], 2),
]


class Grid:
    def __init__(self, board, W, H):
        self.b, self.W, self.H = board, W, H
        self.nx, self.ny = int(W / RES) + 1, int(H / RES) + 1
        # obstacles: (netcode, x1, y1, x2, y2, is_hole) on B.Cu and on F.Cu
        self.bot, self.top = [], []
        for p in board.GetPads():
            bb = p.GetBoundingBox()
            r = (p.GetNetCode(), T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom()),
                 p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH)
            tht = p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)
            if tht or p.IsOnLayer(pcbnew.B_Cu):
                self.bot.append(r)
            if tht or p.IsOnLayer(pcbnew.F_Cu):
                self.top.append(r)
        self.segs = []   # (netcode, x1, y1, x2, y2, halfwidth, layer)
        for t in board.Tracks():   # copper drawn before (charger fan-out)
            if isinstance(t, pcbnew.PCB_VIA):
                x, y, r = T(t.GetPosition().x), T(t.GetPosition().y), T(t.GetWidth(pcbnew.F_Cu)) / 2
                self.top.append((t.GetNetCode(), x - r, y - r, x + r, y + r, False))
                self.bot.append((t.GetNetCode(), x - r, y - r, x + r, y + r, False))
            else:
                self.segs.append((t.GetNetCode(), T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x),
                                  T(t.GetEnd().y), T(t.GetWidth()) / 2, t.GetLayer()))

    def cell(self, x, y):
        return int(round(x / RES)), int(round(y / RES))

    def blocked_for(self, netcode, hw):
        g = bytearray(self.nx * self.ny)
        m = hw + CLR
        edge = 1.2 + hw   # Freerouting keeps a 1 mm track keepout along the edge
        for j in range(self.ny):
            for i in range(self.nx):
                x, y = i * RES, j * RES
                if x < edge or y < edge or x > self.W - edge or y > self.H - edge:
                    g[j * self.nx + i] = 1
        for (nc, x1, y1, x2, y2, hole) in self.bot:
            if nc == netcode and not hole:
                continue
            mm_ = m + (0.1 if hole else 0)
            self._mark_rect(g, x1 - mm_, y1 - mm_, x2 + mm_, y2 + mm_)
        for (nc, x1, y1, x2, y2, shw, lay) in self.segs:
            if nc == netcode or lay != pcbnew.B_Cu:
                continue
            self._mark_seg(g, x1, y1, x2, y2, shw + m)
        return g

    def _mark_rect(self, g, x1, y1, x2, y2):
        i1, j1 = max(0, int(math.floor(x1 / RES))), max(0, int(math.floor(y1 / RES)))
        i2, j2 = min(self.nx - 1, int(math.ceil(x2 / RES))), min(self.ny - 1, int(math.ceil(y2 / RES)))
        for j in range(j1, j2 + 1):
            row = j * self.nx
            for i in range(i1, i2 + 1):
                g[row + i] = 1

    def _mark_seg(self, g, x1, y1, x2, y2, r):
        i1, j1 = max(0, int((min(x1, x2) - r) / RES)), max(0, int((min(y1, y2) - r) / RES))
        i2, j2 = min(self.nx - 1, int((max(x1, x2) + r) / RES) + 1), min(self.ny - 1, int((max(y1, y2) + r) / RES) + 1)
        for j in range(j1, j2 + 1):
            for i in range(i1, i2 + 1):
                if seg_dist(i * RES, j * RES, x1, y1, x2, y2) <= r:
                    g[j * self.nx + i] = 1


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    u = 0 if L == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L))
    return math.hypot(px - (x1 + u * dx), py - (y1 + u * dy))


def dijkstra(grid, g, starts, goals):
    """Shortest 8-connected path from any start cell to any goal cell."""
    nx = grid.nx
    dist = {}
    prev = {}
    pq = []
    for s in starts:
        dist[s] = 0.0
        heapq.heappush(pq, (0.0, s))
    goals = set(goals)
    steps = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
             (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    while pq:
        d, c = heapq.heappop(pq)
        if c in goals:
            path = [c]
            while path[-1] in prev:
                path.append(prev[path[-1]])
            return path[::-1]
        if d > dist.get(c, 1e18):
            continue
        i, j = c % nx, c // nx
        for (di, dj, w) in steps:
            ii, jj = i + di, j + dj
            if 0 <= ii < nx and 0 <= jj < grid.ny:
                n = jj * nx + ii
                if g[n] and n not in goals:
                    continue
                nd = d + w
                if nd < dist.get(n, 1e18):
                    dist[n] = nd
                    prev[n] = c
                    heapq.heappush(pq, (nd, n))
    return None


def visible(grid, g, a, b, allow=()):
    nx = grid.nx
    (x1, y1), (x2, y2) = (a % nx, a // nx), (b % nx, b // nx)
    n = int(max(abs(x2 - x1), abs(y2 - y1)) * 2) + 1
    for k in range(n + 1):
        t = k / n
        i, j = int(round(x1 + (x2 - x1) * t)), int(round(y1 + (y2 - y1) * t))
        c = j * nx + i
        if g[c] and c not in allow:
            return False
    return True


def smooth(grid, g, path, allow=()):
    out = [path[0]]
    k = 0
    while k < len(path) - 1:
        far = k + 1
        for m in range(len(path) - 1, k, -1):
            if visible(grid, g, path[k], path[m], allow):
                far = m
                break
        out.append(path[far])
        k = far
    return out


def line_cells(grid, pts):
    nx = grid.nx
    out = []
    for a, b in zip(pts, pts[1:]):
        (x1, y1), (x2, y2) = (a % nx, a // nx), (b % nx, b // nx)
        n = int(max(abs(x2 - x1), abs(y2 - y1))) + 1
        for k in range(n + 1):
            t = k / n
            i, j = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
            out.append(int(round(j)) * nx + int(round(i)))   # cell centre <= RES/2 from the line
    return out or list(pts)


def run(board, W, H, net_by_name, keepouts=()):
    grid = Grid(board, W, H)
    for (x1, y1, x2, y2) in keepouts:   # no trunk vias in fan-out areas
        grid.top.append((-1, x1, y1, x2, y2, False))
    nx = grid.nx
    log = []

    def add_track(netname, x1, y1, x2, y2, w, layer):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pcbnew.VECTOR2I(F(x1), F(y1)))
        t.SetEnd(pcbnew.VECTOR2I(F(x2), F(y2)))
        t.SetWidth(F(w))
        t.SetLayer(layer)
        t.SetNet(net_by_name[netname])
        t.SetLocked(True)
        board.Add(t)
        grid.segs.append((net_by_name[netname].GetNetCode(), x1, y1, x2, y2, w / 2, layer))

    def add_via(netname, x, y):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(F(x), F(y)))
        v.SetWidth(F(VIA_D))
        v.SetDrill(F(VIA_DRILL))
        v.SetNet(net_by_name[netname])
        v.SetLocked(True)
        board.Add(v)
        nc = net_by_name[netname].GetNetCode()
        r = VIA_D / 2
        grid.top.append((nc, x - r, y - r, x + r, y + r, False))
        grid.bot.append((nc, x - r, y - r, x + r, y + r, False))

    def free_top(x, y, r, nc, x0=None, y0=None, w=0.0):
        """via at (x, y) and the top track from the pad centre to it are clear of other nets"""
        for (onc, a1, b1, a2, b2, hole) in grid.top + grid.bot:
            if onc == nc and not hole:
                continue
            m = r + CLR + (0.1 if hole else 0)
            if a1 - m < x < a2 + m and b1 - m < y < b2 + m:
                return False
            if x0 is not None and onc != nc:
                # sample the stub against the obstacle box
                for k in range(11):
                    sx, sy = x0 + (x - x0) * k / 10, y0 + (y - y0) * k / 10
                    mm_ = w / 2 + CLR
                    if a1 - mm_ < sx < a2 + mm_ and b1 - mm_ < sy < b2 + mm_:
                        return False
        for (onc, a1, b1, a2, b2, shw, lay) in grid.segs:
            if onc != nc and seg_dist(x, y, a1, b1, a2, b2) < shw + r + CLR:
                return False
        return 1.0 < x < W - 1.0 and 1.0 < y < H - 1.0

    for (netname, width, terms, nvias) in TRUNKS:
        net = net_by_name[netname]
        nc = net.GetNetCode()
        points = []   # B.Cu terminal points
        for t in terms:
            if t.startswith("xy:"):          # an existing via of this net
                _, xs, ys = t.split(":")
                points.append((float(xs), float(ys)))
                continue
            ref, padname = t.split(".")
            fp = board.FindFootprintByReference(ref)
            pad = [p for p in fp.Pads() if p.GetName() == padname][0]
            assert pad.GetNetname() == netname, (t, pad.GetNetname())
            px, py = T(pad.GetPosition().x), T(pad.GetPosition().y)
            if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH or pad.IsOnLayer(pcbnew.B_Cu):
                points.append((px, py))
                continue
            # top SMD pad: cluster of vias next to it
            bb = pad.GetBoundingBox()
            hx, hy = T(bb.GetWidth()) / 2, T(bb.GetHeight()) / 2
            stub_w = min(1.0, 2 * min(hx, hy))
            cands = []
            for ring in (0.0, 0.8, 1.6):
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)]:
                    n = math.hypot(dx, dy)
                    ux, uy = dx / n, dy / n
                    reach = abs(ux) * hx + abs(uy) * hy + 0.25 + VIA_D / 2 + ring
                    cands.append((px + ux * reach, py + uy * reach))
            placed = []
            for (x, y) in cands:
                if len(placed) >= nvias:
                    break
                if any(math.hypot(x - a, y - c) < VIA_D + 0.3 for (a, c) in placed):
                    continue
                if free_top(x, y, VIA_D / 2, nc, px, py, stub_w):
                    placed.append((x, y))
                    add_via(netname, x, y)
                    add_track(netname, px, py, x, y, stub_w, pcbnew.F_Cu)
            if not placed:
                log.append(f"{netname}: no room for a via at {t}")
                continue
            for (x, y) in placed[1:]:
                add_track(netname, placed[0][0], placed[0][1], x, y, 0.8, pcbnew.B_Cu)
            points.append(placed[0])

        g_wide = grid.blocked_for(nc, width / 2)
        g_narrow = grid.blocked_for(nc, ESCAPE_W / 2)
        tree = []    # cells already on this net's trunk
        for k, (x, y) in enumerate(points):
            c = grid.cell(x, y)
            cid = c[1] * nx + c[0]
            for (di, dj) in [(a, b_) for a in range(-2, 3) for b_ in range(-2, 3)]:
                g_narrow[(c[1] + dj) * nx + c[0] + di] = 0   # the terminal's own surroundings
            add_track(netname, x, y, c[0] * RES, c[1] * RES, ESCAPE_W, pcbnew.B_Cu)
            # escape: narrow path from the terminal to the first cell where the full width fits
            if g_wide[cid]:
                goals = [i for i in range(nx * grid.ny) if not g_wide[i]]
                esc = dijkstra(grid, g_narrow, [cid], goals)
            else:
                esc = [cid]
            if esc is None:
                log.append(f"{netname}: terminal {terms[k]} cannot escape")
                continue
            if len(esc) > 1:
                pts = smooth(grid, g_narrow, esc, allow={cid})
                for a, b_ in zip(pts, pts[1:]):
                    add_track(netname, (a % nx) * RES, (a // nx) * RES, (b_ % nx) * RES, (b_ // nx) * RES, ESCAPE_W, pcbnew.B_Cu)
            head = esc[-1]
            if not tree:
                tree = [head]
                continue
            path = dijkstra(grid, g_wide, [head], tree)
            if path is None:
                log.append(f"{netname}: no wide path to {terms[k]}")
                continue
            pts = smooth(grid, g_wide, path)
            for a, b_ in zip(pts, pts[1:]):
                add_track(netname, (a % nx) * RES, (a // nx) * RES, (b_ % nx) * RES, (b_ // nx) * RES, width, pcbnew.B_Cu)
            tree += line_cells(grid, pts)   # the drawn (smoothed) copper, not the raw grid path
        log.append(f"{netname}: {len(points)}/{len(terms)} terminals, width {width}")
    return log
