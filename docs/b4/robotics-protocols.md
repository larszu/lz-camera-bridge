# Robotic camera system — protocol extraction

Source: the storage card of a decommissioned robotic camera control system
(Windows embedded, .NET applications), analysed in October 2026.

**Where the specs are:** the per-protocol specifications are derived from that
system's software. They are kept **locally** and not published in this public
repository. What goes into the bridge is our own driver code, plus vendor
documentation wherever it exists (Sony VISCA, Panasonic AW, Blackmagic SDI
camera control and TSL UMD are publicly documented). Licence files and site
data from the card are never copied anywhere.

## Device classes it drives

| Group | Drivers |
|---|---|
| Cameras | Blackmagic SDI, Canon BU-47 / EOS C700 / ME20 / XU-81, Grass Valley LDK, HDSC, Hitachi RCZ, Ikegami IUP / U4, JVC GY, Marshall CV420, Panasonic AK-HC / AK-UB300 / AW-HE / HE / HE60 / HPX / UE150, Q-Ball 1 / Qx, Sony BRC / BRC900 / BRC-X1000-H800 / BRC-Z330 / CNA / SRG, Sony CCU (700 protocol), Sony VISCA, Vaddio HD |
| Pan/tilt heads | the system's own heads (ASCII protocol with keyframe streaming, see `RoboticHeadClient`), Cambotics HDC Robotics, Canon BU, Panasonic HE, Q-Ball, Radamec SCP, Ross Cambot, Sony BRC, Sony VISCA, Vaddio HD |
| Tally | TSL UMD, For-A TAL, Dataprobe iPIO, Image Video RDU-1100 |
| Control panels / input | serial panel, USB panels and joysticks |
| Also present | video switcher/router drivers, CG, newsroom automation, microphone systems, OSC lighting, AJA Ki Pro |

## Status

Integration in the bridge: connection mode `robotic-head` (#141) and the
issue "Robotik-Protokolle in die Bridge einbinden" (#130).
