# Telemetrics robotics software — protocol extraction

Source: the CF card of a decommissioned Telemetrics robotic camera control
system (Windows embedded; `RCP.exe`, `TM.dll`, `RCPBL.exe`, `AppKeyboard.exe`,
`ReFrame.dll`, all .NET), analysed 2026-10-11/13 with ILSpy and REA.

**Where the specs are:** the per-protocol specifications are derived from
decompiled proprietary software. They are kept **locally**
(`~/Downloads/Telemetrics-Analysis/specs/`) and not published in this public
repository. What goes into the bridge is our own driver code written against
those specs, plus vendor documentation wherever it exists (Sony VISCA,
Panasonic AW, Blackmagic SDI camera control, TSL UMD are publicly documented).
Licence files and site data from the card are never copied anywhere.

## What the software drives (class inventory)

| Group | Drivers |
|---|---|
| Cameras | Blackmagic SDI, Canon BU-47 / EOS C700 / ME20 / XU-81, Grass Valley LDK, HDSC, Hitachi RCZ, Ikegami IUP / U4, JVC GY, Marshall CV420, Panasonic AK-HC / AK-UB300 / AW-HE / HE / HE60 / HPX / UE150, Q-Ball 1 / Qx, RoboEye / RoboEye2, Sony 700 (CCU), Sony BRC / BRC900 / BRC-X1000-H800 / BRC-Z330 / CNA / SRG, Sony VISCA, Vaddio HD |
| Pan/tilt heads | Telemetrics **S2, S5, RM-1**, Cambotics HDC Robotics, Canon BU (+AuxXY), Panasonic HE (+AuxXY), Q-Ball, Radamec SCP, RoboEye, Ross Cambot, Sony BRC (+AuxXY), Sony VISCA, Vaddio HD |
| Tally | TSL UMD, For-A TAL, Dataprobe iPIO, Image Video RDU-1100 |
| Control panels / input | RCCP-1 (serial), USB: RCCP-MJ, RCCP-PDL, RCMC-1, TeleKeys, DirectInput joysticks |
| Also present | 23 video switcher/router drivers, CG, automation (Mosart, Ignite, NewTek …), mic systems, OSC lighting, AJA Ki Pro |

## Status

Extraction of cameras, heads, tally and panels in progress (2026-10-13).
Summary of results and the integration plan for the bridge: GitHub issue
"Telemetrics-Protokolle in die Bridge einbinden".
