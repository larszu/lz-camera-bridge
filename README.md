# Camera Bridge

A universal camera-control hub. One software interface — a broadcast-style
**RCP** (paint controls) and a touch **PTZ panel** modelled on the Panasonic
AW‑RP150 — plus a normalizing **command bus** that drives cameras from many
vendors over their native protocols. The same commands also reach every camera
from a Bitfocus **Companion** surface or a USB **control panel**.

> **Status:** the bridge, protocols and UI are real and build clean; a
> committed unit-test suite covers the protocol framing. Where a family was
> verified against public docs or an official reference it is marked
> **verified** below. Items marked *tuning* need a first on-camera test to
> confirm value encodings. Nothing ships as a fake/demo device.

## Supported cameras

| Family | Mode | Transport | Status |
|---|---|---|---|
| Sony CCU (HXC/HDC, BRC) | `tcp` / `serial` | 700PTP over TCP :7700 / RS‑422 | paint verified; AWB/ABB deliberately disabled¹ |
| Sony FX / Alpha (FX3, FX6, A7 …) | `sony-usb` | PTP vendor extension over USB (libusb) | **verified** (codes from libgphoto2) |
| Sony Monitor & Control (FX WiFi) | `sony-mnc` | HTTP :10000 + SSDP discovery | unverified (undocumented app protocol) |
| Canon EOS (R5/R6/R7/R8/R10 …) | `canon-ccapi` | CCAPI HTTP REST :8080 | **verified** (official CCAPI) |
| Panasonic Lumix (S1/S5/GH5/GH6 …) | `lumix-http` | `cam.cgi` HTTP | verified |
| Blackmagic (Pocket/Studio/URSA, FW 8.6+) | `blackmagic` | `/control/api/v1` REST + WS | **verified** |
| Z CAM (E2 family) | `zcam` | `/ctrl/set` HTTP | verified |
| Panasonic AW PTZ (AW‑UE/HE) | `panasonic-ptz` | `aw_ptz` / `aw_cam` CGI | **verified** (AW protocol) |
| VISCA over IP (PTZOptics, Marshall, AVer, Sony BRC/SRG) | `visca` | UDP :1259 (raw) / :52381 (Sony header) | **verified** |
| JVC ConnectedCam / KY‑PZ | `jvc` | Digest login + `/cgi-bin/api.cgi` | verified vocabulary (some steps *tuning*) |
| BirdDog NDI PTZ | `birddog` | VISCA :52381 + REST :8080 | verified endpoints (*tuning*) |

¹ Sony's 700 protocol is NDA-only; no public source documents the auto‑setup
command codes, so those buttons stay disabled rather than guessing at a
broadcast CCU. See `packages/web-rcp/src/capabilities.ts`.

## Control surfaces

- **Web RCP** — Sony-style paint panel (iris, master black/gamma, R/G/B white &
  black balance, gain, ND, shutter, bars). Buttons are gated per backend so
  unsupported functions are disabled, not silently failing.
- **Touch PTZ panel** — AW‑RP150-style joystick (pan/tilt with speed),
  zoom/focus rockers, push‑AF, iris and a paged preset grid with a store mode.
- **Bitfocus Companion** — HTTP + WebSocket module; Streamdeck actions route to
  whichever camera is connected.
- **USB HID control panel** — a data-driven adapter maps a hardware panel's
  axes/buttons onto the command bus, so one panel controls any brand.

## Architecture

```
Input surfaces                 Bridge (command bus)              Camera backends
────────────────               ────────────────────              ───────────────
Web RCP  ─┐                                                      ┌─ Sony CCU (700PTP)
PTZ panel ┼─ WebSocket :9700 ─▶  BridgeServer                    ├─ Sony USB (PTP)
Companion ┼─ HTTP/WS :9701-2 ─▶   dispatchCameraCommand ─(RCP)──▶├─ Canon CCAPI
HID panel ─┘                      + per-mode connect/state       ├─ Lumix / Z CAM / Canon
                                                                 ├─ Blackmagic REST
                                                                 ├─ VISCA (raw / Sony)
                                                                 └─ Panasonic/JVC/BirdDog PTZ
```

Every backend exposes the same `handleRcpCommand(cmd, params)` contract, so a
single command vocabulary (`setIris`, `setMasterGain`, `ptz`, `recallPreset`, …)
fans out to all of them. A visual walk-through lives in
[`docs/architecture.html`](docs/architecture.html).

Live-video feasibility per camera family — which cameras can show a live
picture in the panel, at what cost — is documented in
[`docs/live-video.md`](docs/live-video.md).

The bridge reads the `camera-list` the AV Planner Suite's MultiCam Planner
exports and holds it against the cameras on the bus, so the control wall can
label a slot the way the show calls it ("CAM 3 — Bühne links") instead of by
number. Every match carries evidence — a measured model, a mere convention, or a
human — and where there is none, there is no match. See
[`docs/camera-plan.md`](docs/camera-plan.md).

## Packages

| Path | What it is |
|---|---|
| `packages/bridge` | Node/TypeScript bridge server, camera clients, protocols, HID input |
| `packages/web-rcp` | React UI (RCP + PTZ panel, connection wizard) |
| `packages/companion-module-sony-camera-bridge` | Bitfocus Companion module |
| `packages/electron-app` | Desktop wrapper around the web UI |
| `packages/firmware` | WIZ108SR serial↔TCP bridge firmware (C) |

## Getting started

```bash
npm install            # workspaces install
npm run dev            # bridge (ws://localhost:9700) + web UI (Vite)
npm test               # protocol framing unit tests
```

Build individually:

```bash
npm run build --workspace=packages/bridge
npm run build --workspace=packages/web-rcp
```

Optional native modules (loaded lazily, not required to build/run):

```bash
npm install usb      --workspace=packages/bridge   # Sony USB (PTP) discovery/control
npm install node-hid --workspace=packages/bridge   # USB control-panel input
```

## First run

Open the web UI and follow the setup wizard: pick a camera family, enter its
address (the wizard shows the right defaults per protocol), and connect. PTZ
cameras open the joystick panel automatically; paint cameras open the RCP.

- **Sony BRC/SRG PTZ:** choose the *VISCA over IP* tab and set port **52381** —
  the Sony transport header is applied automatically.
- **Sony FX/Alpha USB:** put the camera in *PC Remote* mode; install the `usb`
  module on the host.
- **Canon:** activate CCAPI once via Canon's tool, then enter the shown IP/port.

## License

Proprietär — © 2026 Lars Zumpe, alle Rechte vorbehalten. Nutzung der veröffentlichten Builds ist kostenlos; Weiterverbreitung und abgeleitete Werke sind es nicht. Siehe [LICENSE](LICENSE).
