# Interop test: Unreal Live Link receives zoom and focus (phase 5, #56)

The acceptance test of phase 5: a **foreign** implementation reads what this
project sends. A decoder written here would only share this project's
assumptions. This page is written to be followed by someone without this repo's
history.

> **Status: prepared, not run.** Everything Unreal-specific below is from Epic's
> documentation (sources at the end), not from a session in the editor. Where
> the documentation is vague or silent, the step says so and asks you to
> write down what you saw.

## What runs where

```
B4 lens ──12-pin── ESP32 (firmware-b4) ──HTTP── b4FreeD.ts ──UDP FreeD D1── Unreal (Live Link FreeD)
          pins 10/11             /api/status      calibration tables        port you choose
```

`packages/bridge/src/tools/b4FreeD.ts` polls the device, maps `zoomCounts` /
`focusCounts` through the per-lens calibration tables to 0..4095, and sends
FreeD D1 at a fixed rate.

## 1. The sender

Write `b4-freed.json` (all fields are required; nothing has a default):

```json
{
  "device": { "host": "192.168.1.50" },
  "freed":  { "host": "192.168.1.20", "port": 40000, "rateHz": 50, "cameraId": 1 },
  "zoomTable":  { "axis": "zoom",  "rawUnit": "adc-count", "valueUnit": "percent",
                  "points": [ {"raw": 0, "value": 0}, {"raw": 0, "value": 100} ],
                  "source": "measured YYYY-MM-DD, measurements/…" },
  "focusTable": { "axis": "focus", "rawUnit": "adc-count", "valueUnit": "percent",
                  "points": [ {"raw": 0, "value": 0}, {"raw": 0, "value": 100} ],
                  "source": "…" },
  "staticPose": { "panDeg": 0, "tiltDeg": 0, "rollDeg": 0, "xMm": 0, "yMm": 0, "zMm": 0 }
}
```

- **Tables:** replace the `raw` placeholders with `zoomCounts` / `focusCounts`
  read from `/api/status` at the wide/tele and near/far stops of *this* lens.
  With placeholder raws of 0 the table is rejected, which is intended.
- **`staticPose`:** FreeD also carries pan, tilt, roll and position. A lens does
  not know them, and the encoder refuses to invent them. For a fixed mount,
  write the pose down here; that is a statement you make, not a default.
- **Port 40000** is chosen to match Unreal's default (below). FreeD itself has
  no registered port.
- **Rate:** the show format (25 / 50 / 60 Hz).

```bash
npx tsx packages/bridge/src/tools/b4FreeD.ts b4-freed.json
```

Every 5 s it prints `sent / incomplete / errors`. `incomplete` rising means an
axis is null (device unreachable or a reading outside its table), and in that
case **nothing is sent**.

## 2. Unreal

1. **Plugins:** enable **Live Link** and **Live Link FreeD** (under Virtual
   Production; Epic marks it Beta). Restart the editor.
2. **Live Link window** (from the Window menu; the exact submenu differs
   between engine versions and was not verified here — write down the path you
   used): **Source → LiveLinkFreeD Source**.
   - IP address **0.0.0.0** when the camera data comes in over UDP to this PC
     (Epic: *"the IP Address must be set to 0.0.0.0"*).
   - Port **40000** (Epic: *"The default Port Number is 40000."*).
3. The subject appears under the FreeD camera ID; Epic notes the ID *"can't be
   modified in UE"*. Note which name it shows for `cameraId` 1.
4. **Encoder ranges — do not leave them on auto.** By default Live Link FreeD
   auto-ranges: *"you must calibrate the encoder by forcing the camera to reach
   its min and max values a few times … every time"*. For a reproducible test,
   open the source settings, and for **Focal Length Encoder Data** and **Focus
   Distance Encoder Data** set **Use Manual Range** with **Min 0, Max 4095**
   (the range `b4FreeD.ts` sends). Note the MaskBits value shown; Epic's
   documentation does not state its default.
5. **Evaluation mode:** *Latest* — no interpolation, so a delay you see is a
   real one.

## 3. Acceptance, as #56 asks

| # | Action | Pass when | Seen / notes |
|---|---|---|---|
| 1 | Sender running, source added | subject shows a **green** light without touching the plugin settings beyond the steps above | |
| 2 | Zoom from wide to tele | focal-length value rises monotonically, no perceptible lag | |
| 3 | Zoom back | falls monotonically | |
| 4 | Focus near → far and back | the same for focus | |
| 5 | Pull the Ethernet cable of the ESP32 | sender prints `incomplete` rising; in Unreal the subject light turns **yellow** (Epic: yellow = connected but no data for a configurable time) — the value must not sit there looking live | |
| 6 | Stop the sender (Ctrl-C) | as 5 | |
| 7 | Plug back / restart | green again, values follow the lens | |
| 8 | Negative test: one packet with a wrong checksum (below) | write down whether Unreal drops it; Epic's docs do not say | |

For 8, send one bad packet by hand:

```bash
node -e "const d=require('dgram').createSocket('udp4');const b=Buffer.alloc(29);b[0]=0xd1;b[1]=1;b[28]=0x00;d.send(b,40000,'127.0.0.1',()=>d.close())"
```

Record: Unreal version, OS, the settings as you left them, a screen capture
of rows 2 and 5, and the outcome of every row under
[`measurements/`](measurements/). Only then close #56.

## What the documentation does not settle

- The stale timeout. The Live Link setting is
  `TimeWithoutFrameToBeConsiderAsInvalid`; Epic's page gives the default as
  "0.5ms", which is probably a typo. Read it off *Project Settings → Live Link*.
- Default Min/Max/MaskBits of the encoder data.
- Whether the plugin checks the FreeD checksum (row 8).
- How the normalised value becomes a focal length in mm or a focus distance
  (lens file / camera component). This test only checks direction and
  liveness, not calibration in real units.

## Sources (opened 2026-09-27)

- Epic, *Live Link FreeD* (UE 5.x): <https://dev.epicgames.com/documentation/en-us/unreal-engine/live-link-freed--in-unreal-engine>
- Epic, *Live Link FreeD* (UE 4.27): <https://dev.epicgames.com/documentation/en-us/unreal-engine/live-link-freed?application_version=4.27>
- Epic API, `ULiveLinkFreeDSourceSettings`, `FFreeDEncoderData`: <https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/LiveLinkFreeD>
- Epic, *Live Link* (status lights, evaluation modes): <https://dev.epicgames.com/documentation/en-us/unreal-engine/live-link-in-unreal-engine>
- Epic API, `ULiveLinkSettings`: <https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/LiveLink/ULiveLinkSettings>
- FreeD D1 layout and checksum: Vinten Radamec *free-d Installation Manual* v1.4.4, appendix A (third-party host: <https://www.manualsdir.com/manuals/641433/vinten-radamec-free-d.html>) — see also [`freed-output.md`](freed-output.md).
