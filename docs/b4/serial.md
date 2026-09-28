# The lens serial line: listen, decode, and the locked transmit path

Phases 2 and 3 of the plan, for a **group B** lens: serial on Hirose pins 11/12
beside the analog signals (see [`b4-lens-control.md`](b4-lens-control.md) §1–§5).

> **Does this apply to our lens?** Probably not. The lens on hand is a Canon
> J15ax8B4 **IRS** SX12. In Canon's nomenclature `R` is the standard ENG drive
> and `D`/`E` mark the digital variants; Canon's catalogue ties the follow
> signals for iris, zoom and focus to "IASD/IASE only" (sources in
> [`research-canon.md`](research-canon.md)). That makes it very likely group C,
> which has nothing on this line — but "very likely" is not a measurement.
> Issue #38 settles it passively first. Everything here is for the day a
> group B lens is on the bench, and it is built so that day starts with
> tested tools instead of a blank page.

Nothing below has been connected to anything.

## What is built

| Part | Where | Tested how |
|---|---|---|
| Frame encode, CRC, streaming decoder, lens-name assembly (0x11 + 0x12), transmit gate | `firmware-b4/src/b4_frame.h` | host tests `test/native/test_b4_frame.cpp`, same vectors as the bridge's `B4Lens.ts` |
| Capture of both directions, inverted in the UART, 78400 8N1 | `firmware-b4/src/lens_serial.h` | compiles in CI (`env:…-serial`) |
| `GET /api/capture.bin?dir=lens\|cam`, `POST /api/capture/clear`, counters and `lensName` in `/api/status` → `serial` | `lens_serial_http.h` | compiles in CI |
| Transmit endpoint `POST /api/lens/send {cmd, data, allowReset}` | same, **only with `B4_ENABLE_SERIAL_TX`** | CI proves it is absent from the default binary |
| Capture comparison and lens name on the host | `bridge/src/tools/b4Capture.ts` | `test/b4CaptureTool.test.ts` |

## Compile flags

| Flag | Default | Effect |
|---|---|---|
| `B4_ENABLE_SERIAL_RX` | 0 | Listen on pin 11 (UART1 RX, GPIO 44) and pin 12 (UART2 RX, GPIO 8). No TX pin is attached: `HardwareSerial::begin()` fills in default pins only when both RX and TX are -1 |
| `B4_ENABLE_SERIAL_TX` | 0 | Adds TX on GPIO 43 and the send endpoint. Refuses to build without RX. Lights the board LED red |
| `B4_COMMAND_CODES_RESOLVED` | 0 | While 0, the gate refuses **0x20–0x23**: the source gives two assignments (0x20/0x21/0x22 vs 0x21/0x23/0x22) and #47 must settle which one a camera really sends |

`0x01` Connect with a data byte forces a lens reset (§5); the gate refuses it
unless the request says `"allowReset": true`.

## Bench order

### 1. Breakout (#42)

Cut a 12-pin extension in half, reconnect all twelve conductors, and bring out
pins 11, 12 and 3. Per line, a divider before anything 3.3 V:

```
pin 11 (lens TXD) ──10k──┬──15k── GND      node ≈ 3.0 V at 5 V → GPIO 44 and LA ch 0
pin 12 (cam → lens) ─10k──┬──15k── GND      same → GPIO 8 and LA ch 1
pin 3 ───────────────────── GND of ESP32 and logic analyser
```

Check first that camera and lens behave exactly as without the breakout, and
measure the node: about 3.0 V at a 5 V line level. Label which end is camera
and which is lens.

### 2. Capture (#43)

Flash `env:waveshare-esp32-s3-eth-serial` **with the TX jumper pulled** (or an
RX-only build: `-DB4_ENABLE_SERIAL_RX=1` alone). Then:

```bash
curl -X POST http://b4-lens/api/capture/clear
# 10 s of rest — touch nothing
curl -o 20260923-idle-lens.bin 'http://b4-lens/api/capture.bin?dir=lens'
curl -o 20260923-idle-cam.bin  'http://b4-lens/api/capture.bin?dir=cam'
curl http://b4-lens/api/status        # serial.fromLens / fromCamera counters
```

`overflow` above zero means the 16 KiB buffer was full; shorten the take.
Record the same take with PulseView at the same time — the ESP32 is not its own
witness. Whether the idle `FB 03` the source mentions appears is a result
either way; note it.

### 3. Lens name (#45)

The camera polls 0x11/0x12 by itself. If the name comes out as readable ASCII
matching the lens barrel, baud rate, inversion, framing and CRC are confirmed
in one go. It appears on the USB console (`Lens name: …`), in
`/api/status` → `serial.lensName`, and from any capture:

```bash
npx tsx packages/bridge/src/tools/b4Capture.ts 20260923-idle-lens.bin
```

### 4. Which code is which (#47)

One control at a time, one file each, idle first:

```bash
npx tsx packages/bridge/src/tools/b4Capture.ts idle.bin zoom-tele.bin:zoom \
    focus-far.bin:focus iris-open.bin:iris
```

The tool names a candidate only when exactly one control was operated and
exactly one code moved; repeat in the opposite direction before believing it.
Record the result in `b4-lens-control.md` §5 (the conflict box) and only then
set `B4_COMMAND_CODES_RESOLVED` to 1.

### 5. Transmitting (#48) — two locks, not one

1. **Compile flag** — default off; without it the send function is not in the
   binary (CI: `strings firmware.bin` contains no `B4 TX:`).
2. **Physical jumper** in the TX line after the level shifter and the 1 kΩ,
   open when pulled. With the jumper pulled and the flag set, measure pin 12:
   no level change while sending.

First send goes to a **loopback** (TX joined to the GPIO 8 RX through the
jumper, nothing else attached): the frame must come back byte for byte in
`capture.bin?dir=cam`. Only after that, and after #41, a lens — `0x01` first.
