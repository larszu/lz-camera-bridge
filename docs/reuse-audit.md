# Reuse Audit — B4 Lens Control / Camera Bridge

Audit requested by `CLAUDE-CODE-BRIEF.md` §1, carried out 2026-09-17 against the
repositories actually present on the `larszu` account (28 repositories
enumerated, not the list in the brief — see *Corrections* below).

Verdicts are **reuse** (take as-is), **adapt** (take the shape, change the
content) or **not applicable**.

> **Scope note.** Nothing here has been measured against hardware. This is a
> source audit. Every electrical claim in `b4-lens-control.md` and the
> Umsetzungsplan remains unverified and must be measured before anything is
> connected or driven.

---

## Corrections to the brief

| Claim in the brief | Finding |
|---|---|
| Repo `stagecue` — "likely already has a network control surface, cue/state model, and possibly OSC" | **Does not exist.** Not among the 28 repositories on the account, not archived, not local. The OSC assumption in Phase 4 rests on it and therefore has no basis. There is **no OSC implementation anywhere in the account** (checked across the bridge, intercom and planner repos). |
| `facility-planner` | Actual name is `larszu-facility-planner`. |
| "Broadcast intercom repo" | `larszu/Broadcast-intercom` — note the capital B; the default branch and clone URL are case-sensitive. |
| `gh repo list` as the enumeration method | `gh` is not available in this environment. Enumerated via the GitHub API instead. |

**Consequence for Phase 4:** `Expose demand as OSC source` is not "check
stagecue first" — it is a green-field decision. See the recommendation under
*Transport* below, which argues against OSC as the first output.

---

## The headline finding

`sony-camera-bridge` — product name **LZ Camera Bridge** — is not a Sony tool.
It is already the camera-control hub this project needs a host for, and it
already contains an embedded-firmware package. Roughly 70 % of the non-lens
work in the brief exists here in working form.

```
packages/
  bridge/                          Node/TS control hub, WebSocket on :9700
    cameras/                       VISCA, Sony MNC/PTP, Panasonic, JVC,
                                   Birddog, Blackmagic, DJI Ronin, Lumix
    protocol/                      Ptp700Protocol, SonyProtocol, SonyPtp,
                                   Duml, CcuClient, DjiRSdk, LumixClient
    transport/ViscaSerialTransport.ts
    discovery/WiznetDiscovery.ts
    companion/CompanionServer.ts
    input/HidControlSurface.ts
    plan/cameraPlan.ts
  firmware/                        bare-metal C, WIZnet W7500P (Cortex-M0)
  companion-module-lz-camera-bridge/
  electron-app/
  web-rcp/
```

**Decided: the B4 work is built here, as `packages/firmware-b4` plus a lens
backend in the bridge.** The owner settled this on 2026-09-17; the reasoning is
recorded as
[ADR-008](https://github.com/larszu/av-planner-suite/blob/main/docs/decisions/ADR-008-b4-objektivsteuerung-ablage.md)
in `av-planner-suite`, where the suite's decisions live. A separate repository
would have duplicated the transport, the Companion surface, the CI gates and the
release flow, and would have left two answers to "what is the current iris
value".

The counter-argument was weighed and the cost accepted: the existing firmware is
bare-metal `arm-none-eabi-gcc` with a hand-written `Makefile`, while the B4
target is an ESP32 with PoE. That is a second toolchain in one repository — but
the packages build independently, so the pain stays inside the toolchain and
reaches nobody who only builds the bridge.

**Still open**, and deliberately not settled by ADR-008: the runtime (ESP-IDF vs
Arduino core), and whether `firmware-b4` is built in CI.

---

## Per repository

### `sony-camera-bridge` (LZ Camera Bridge) — v1.2.0, 73 commits

**1. Transport — reuse.**
`packages/bridge/src/BridgeServer.ts` is a WebSocket server on
`ws://localhost:9700` with a documented, already-stable message schema:

```
in:   { type: 'listCameras' }
      { type: 'setCameraConfig', cameraNumber, config }
      { type: 'connectCamera' | 'disconnectCamera' | 'removeCamera', cameraNumber }
      { type: 'command', cameraNumber, cmd, params }
      { type: 'listPorts' | 'discoverWiznet' | 'configureWiznet' | 'discoverSonyUsb' }
out:  { type: 'cameras', cameras: [...] }
      { type: 'state', cameraNumber, state, origins, confirmations }
      { type: 'cameraConnected' | 'cameraDisconnected', cameraNumber, info? }
      { type: 'tally' | 'ports' | 'wiznetDevices' | 'sonyUsbDevices' | 'error' }
```

A lens is a device with commands and state. It fits `{ type: 'command', …, cmd,
params }` and reports through `{ type: 'state', …, origins, confirmations }`
without a new transport. **Do not add a second server, a second port, or a
second schema.**

`origins` and `confirmations` in the state message are worth studying before
designing anything: the bridge already distinguishes *what was commanded* from
*what the device confirmed*. That is precisely the distinction an unverified
lens interface needs — a setpoint that has not been read back is not a value.

**2. Device/host protocol — reuse the pattern, add a backend.**
`packages/bridge/src/cameras/` holds one client per vendor behind a common
factory (`backendFactory.ts`). `packages/bridge/src/protocol/` holds the framing
separately from the client, with committed unit tests. A B4 lens is a new pair:
a framing module for the L10-style `<length><cmd><data><crc>` frame, and a
client that speaks it. That is the established shape of this repository, not a
new invention.

`transport/ViscaSerialTransport.ts` is the closest existing analogue — a serial
protocol with framing, behind the same interface as the network clients.
**adapt** it for the ESP32 link.

**3. UI shell — reuse.**
`packages/web-rcp` is a broadcast-style RCP with paint controls;
`packages/electron-app` wraps it and starts the bridge with the application.
Iris, and later zoom and focus, belong on the surface that already has iris for
every other camera family. `npm run slider:check` is an existing CI gate over
those controls — a new lens control must satisfy it.

**4. Domain model — reuse, and align rather than parallel-model.**
Iris, focus and zoom already exist as concepts across
`ViscaClient`, `PanasonicPtzClient`, `BMDeviceClient`, `JvcClient`,
`BirddogClient`, `SonyPtpUsbClient`, `DjiRoninClient` and others. **A B4 lens
must map onto the same normalized names**, or the RCP will grow a second iris
that behaves differently from the first. This is the single most important
finding of the audit for the design: read `backendFactory.ts` and the state
shape in `BridgeServer.ts` before defining a lens type.

`plan/cameraPlan.ts` and `npm run caps:parity -- --planner upstream/multicam-planner`
show that camera capabilities are already mirrored against `multicam-planner`.
A lens that reports `0x13` open F-number, `0x14`/`0x15` focal lengths and `0x16`
MOD is planner-relevant data — check whether it belongs in that parity contract
before inventing a separate path.

**5. CI and release — reuse, mirror exactly.**
`.github/workflows/ci.yml` gates: `npm ci`, `npm test`, `lock:check`,
`actions:check`, `brand:check`, `slider:check`, `netz:check`, `lang:check`,
`caps:parity`. Release via `release.yml`, Pages via `pages.yml`.

> ⚠️ **Default branch is `master`, not `main`.** Verified 2026-09-17. Getting
> this wrong is the documented failure mode across this account's repositories.

`lock:check` exists because a package-lock without the mac and Windows entries
killed those builds once (commit `3abe3a5`). A new package must not repeat it.

**6. Firmware precedent — adapt.**
`packages/firmware/src/` is a frame-aware RS-422↔TCP bridge for the WIZnet
WIZ108SR: `sony_frame.c/h` does frame-boundary detection, `network.c/h` the
socket work, `config.c/h` persisted device configuration, with a `Makefile` and
a linker script. The **structure** transfers directly to the ESP32 target —
framing separated from transport separated from configuration — even though not
one line of the code does.

`discovery/WiznetDiscovery.ts` plus `configureWiznet` shows how a network device
is found and configured from the host. A PoE ESP32 has the same problem.

---

### `photobooth` — private

**Transport / device split — adapt.** The README documents an **ESP32 PoE
trigger, a remote shutter over Ethernet with local buzzer feedback**. That is
the closest existing precedent on the account for the exact hardware class in
this brief. Worth reading for the PoE bring-up and the host-side handling, not
for its protocol.

**Not applicable** for UI shell, domain model, CI. Note the repository's own
warning: CI does not execute (private repo, exhausted Actions budget), the
updater performs no signature verification, and the credentials in its history
are to be treated as burned. **Do not** copy its update mechanism.

---

### `Broadcast-intercom` — v0.1.0, 32 commits

`apps/server`, `apps/web`, `apps/desktop`, `packages/shared`, plus a
`companion-module/`. WebSocket present in `apps/server/src/index.ts` and
`apps/web/src/hooks/useIntercomStore.ts`.

**Verdict: not applicable.** It is a thinner instance of the same shape
`sony-camera-bridge` already implements more completely. Taking transport from
here would mean choosing the less mature of two in-house answers. The one thing
worth a look is `PluginBridgeSettings.tsx` if a settings surface for a plugged
device is needed.

---

### `tally-pi` — 63 commits

Python on a Pi: `atem_watcher.py` (UDP to an ATEM), `numato_watcher.py`,
`gpio_watcher.py`, `cmd_channel.py` (Unix-domain socket command channel with a
documented Windows fallback), systemd units per watcher.

**Adapt, for operational shape only.** The one-process-per-concern layout with
a systemd unit each, and the command channel between them, is a good model if a
host-side daemon is ever needed. The protocol work is not transferable.

---

### `cable-planner` (v9.0.2) and the planner suite

**Not applicable** for transport, device protocol or domain model.
**Reuse** as reference for project skeleton and house conventions; `@avplan/ui`
lives in `av-planner-suite/packages/ui`. Relevant here only if a lens/axis
control surface is ever built outside `web-rcp` — which, per the finding above,
it should not be.

---

### `multicam-planner`

**Not applicable** to this project directly, but note the existing coupling:
`caps:parity` compares this repository's camera capabilities against it, and
`BRIDGE_SOURCE.repo` there points back here. A lens capability added to the
bridge may need a corresponding entry there. Check before, not after.

---

## Summary table

| Criterion | Verdict | Where |
|---|---|---|
| Transport | **reuse** | `packages/bridge/src/BridgeServer.ts`, WS `:9700` |
| Device/host protocol | **adapt** | `cameras/` + `protocol/` pair; `transport/ViscaSerialTransport.ts` |
| UI shell | **reuse** | `packages/web-rcp`, `packages/electron-app` |
| Domain model | **reuse** | normalized iris/focus/zoom across `cameras/`; `plan/cameraPlan.ts` |
| CI and release | **reuse** | `.github/workflows/ci.yml` — 9 gates; branch `master` |
| Firmware structure | **adapt** | `packages/firmware/src/` framing/network/config split |
| OSC | **green field** | does not exist anywhere on the account |

## Recommendation on Phase 4 output

The brief lists OSC first and USB HID second. The audit inverts that priority:

1. **The bridge's own WebSocket** — already there, already has state semantics
   with `origins`/`confirmations`, already reaches the RCP, Companion and the
   Electron app. A demand becomes an input to the existing command bus.
2. **USB HID** — `packages/bridge/src/input/HidControlSurface.ts` already exists
   as the in-house answer for a physical control surface.
3. **OSC** — only if something outside this account needs to consume it. It
   would be a new dependency and a new surface, justified by a consumer, not by
   the brief's assumption about a repository that does not exist.
