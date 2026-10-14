# FreeD tracking from camera poses

Every camera that reports its pose can stream it as FreeD D1 over UDP — pan,
tilt, zoom and focus, plus a fixed mounting position and, on robotic heads
with an elevation column, its height. Virtual-studio and AR engines read it,
among them Unreal Engine through its Live Link FreeD source.

> **Status:** tested against the bridge's own decoder and a hand-written byte
> layout, over loopback UDP. **Not yet tested against Unreal or any other
> foreign receiver, and not on real camera hardware.** Issue #56 stays open
> for that.

## Which cameras

The paths whose backend answers a pose inquiry (`POSE_READ_MODES` in
`packages/bridge/src/cameras/backendFactory.ts`, held against the backends by a
test):

| Path | Pan/tilt | Zoom | Focus | Column |
|---|---|---|---|---|
| VISCA over IP / RS-232, BirdDog | inquiry | inquiry | `CAM_FocusPosInq` | — |
| Panasonic AW (`#PTV`) | yes | yes | yes | — |
| Panasonic AW, older heads (`#APC`) | yes | `#GZ` | — (sent as 0) | — |
| HTTP-CGI, Sony family (`inq=ptzf`) | yes | yes | yes | — |
| HTTP-CGI, VISCA family | inquiry | inquiry | inquiry | — |
| Robotic head (ASCII protocol, `ptzfxymi`) | yes | yes | yes | aux axis X or Y |
| Demo | yes | yes | — | — |

Zoom and focus come from the camera as 0..1 of its position counter. That is a
raw position, not a focal length or a distance.

## Setting it up in the panel

**Site → FreeD tracking**

1. Add one or more **targets** (receiver address and UDP port). Every target
   receives every camera. Port 40000 is pre-filled because it is where
   Unreal's FreeD source listens by default; FreeD itself has no registered
   port, so use whatever the receiver is set to.
2. Pick the **rate** — normally the show's frame or field rate (25, 50, 59.94,
   60 Hz …). Default 50 Hz.
3. Switch **FreeD on** for each camera. Cameras whose path reports no pose show
   that instead of a switch.

Under **Details** per camera:

| Setting | Meaning | Default |
|---|---|---|
| FreeD id | camera id byte in the packet, 0..255 | the camera number |
| X / Y / Z (mm) | mounting point in the room, in the receiver's frame | 0 / 0 / 0 |
| Column mm/count | robotic head: millimetres per raw column count, added to Z | not used |
| Pan / tilt offset (°) | added after inversion | 0 |
| Invert pan / tilt / zoom / focus | sign for angles, `1 − v` for zoom/focus | off |

Everything is kept in the site file (`freed` at the top level, `config.freed`
per camera) and survives a restart.

## How the stream behaves

- **Polling and interpolation.** Each enabled camera is polled for its pose
  every `pollMs` (default 50 ms; the next read starts when the previous one
  answered, so a slow camera is not flooded). Packets go out at the rate.
  Between two reads the pose moves on a straight line from the previous read
  to the latest, over the time the latest took to arrive — the output runs one
  read interval behind and never overshoots. A pan step of more than 180° is
  a wrap and is not drawn through the back.
- **A camera that stops answering goes silent.** When the latest read is older
  than `max(1 s, 5 × pollMs)`, nothing is sent for that camera — the receiver
  sees a source that stopped, not a camera that froze. Disconnecting the
  camera ends its stream.
- **Unreported zoom or focus is sent as 0** and named in the panel ("focus not
  reported"). That is not a measurement: switch the matching encoder off in
  the receiver.
- **Roll** is the configured offset (0). A pan/tilt head has no roll axis.
- A measured `zoomTable` / `focusTable` in `config.freed` (raw = 0..1
  position) maps through `LensCalibration.ts` like the lens path does; without
  one, the counter range maps linearly onto 0..4095. A reading outside a
  measured table is unknown and stops the stream rather than being clamped.

## The packet and Unreal Live Link FreeD

29 bytes, big-endian, as in the head of `packages/bridge/src/protocol/FreeD.ts`:

| Bytes | Field | Encoding |
|---|---|---|
| 0 | `0xD1` | message type |
| 1 | camera id | byte |
| 2–4, 5–7, 8–10 | pan, tilt, roll | 24-bit signed, degrees × 32768 (15 fractional bits) |
| 11–13, 14–16, 17–19 | X, Y, Z | 24-bit signed, millimetres × 64 |
| 20–22, 23–25 | zoom, focus | 24-bit unsigned, here 0..4095 |
| 26–27 | spare | 0 |
| 28 | checksum | `(0x40 − sum of bytes 0..27) & 0xFF` |

Pan positive is clockwise seen from above, tilt positive is up. The test
`freeDOutput.test.ts` writes one packet out byte by byte (pan 90° = `2D 00 00`,
X 1000 mm = `00 FA 00`, …) and checks that the sum of all 29 bytes is `0x40`,
which is how a receiver validates it.

In Unreal (Live Link window → Source → LiveLinkFreeD):

- IP address of the network adapter Unreal listens on, port as set in the
  target (default 40000).
- Zoom and focus arrive as raw encoder counts. Use the source's encoder
  settings (manual range 0 to 4095) and a lens file to turn them into focal
  length and focus distance; disable the encoder of an axis the camera does
  not report.
- How Unreal maps FreeD X/Y/Z onto its own axes and units, and whether the
  camera id selects the subject, is **not verified here** — check the subject's
  transform once with a camera at a known place.

## Checking a route without the receiver

```
cd packages/bridge
npx tsx src/tools/freedReceive.ts 40000        # ten lines a second, rates every 5 s
npx tsx src/tools/freedReceive.ts 40000 --raw  # every packet with its bytes
```

It prints sender, camera id, angles, position, zoom and focus, and counts
packets with a wrong length or checksum as INVALID. It proves the bridge
agrees with its own decoder, nothing more.

## Files

| File | Does |
|---|---|
| `protocol/FreeD.ts` | the 29 bytes, encode/decode |
| `protocol/freeDPose.ts` | settings, pose → sample, interpolation |
| `transport/FreeDSender.ts` | socket, rate, one or several targets |
| `transport/FreeDOutput.ts` | one stream per enabled camera: poll, interpolate, send |
| `tools/freedReceive.ts` | the receiver for checking a route |
| `tools/b4FreeD.ts` | the B4 lens path (zoom/focus from the lens interface, fixed pose) — see `docs/b4/freed-output.md` |

## Open

- Interop test against Unreal Live Link FreeD (#56), including the axis
  mapping of X/Y/Z and the behaviour when a source goes silent.
- No pose path has been run against a real head yet; the focus inquiries and
  the column reading in particular are from the protocol descriptions only.
- The B4 lens interface is still its own runner; a camera with a B4 lens on a
  robotic head does not yet combine head pose and lens zoom/focus.
