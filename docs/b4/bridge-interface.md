# Why the lens is a connection mode

ADR-008 says the lens backend belongs in `packages/bridge/src/cameras/`, "like
any other device family". This records *how* that was done and which two
alternatives were rejected, because the rejected ones are the tempting ones.

## The contract it had to fit

```ts
interface CameraBackend extends EventEmitter {
  readonly isConnected: boolean;
  connect(): Promise<unknown>;
  disconnect(): void | Promise<void>;
  handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean>;
}
```

A B4 lens is not a camera. It has exactly one remotely settable value — iris —
and two readable ones, zoom and focus position.

## Rejected: a control surface

`HidControlSurface` turns a panel into a *source* of commands. Here the bridge
is the source and the lens obeys. Wrong direction, and it would have put the
lens on the input side of a bus it belongs on the output side of.

## Rejected: a parallel API beside the command bus

Tempting because the device already serves HTTP. But the bus already carries
`setIris` and `nudge` to eleven backends, and `paintNudge.ts` resolves relative
trims against the value the bridge has actually read. A second path would mean
two answers to "what is the iris at" — the exact defect `valueOrigin.ts` exists
to prevent, and the one ADR-008 gives as its reason in one line.

## Chosen: `b4-lens` as a `ConnectionMode`

`B4LensClient` polls the device's HTTP API and implements `handleRcpCommand`,
the way `ZCamClient` polls a Z CAM. Precedent for a backend that supports almost
nothing: `panasonic-ptz` declares only `{ iris, bars, focus }`. A narrow row in
the capability table is how this repo says "this path cannot do that", and the
panel disables the rest rather than failing at runtime.

**The API speaks the bridge's scale.** `POST /api/iris {"value": 0..255}` — not
volts, not F-stops. Turning that into a DAC code happens on the ESP32, beside
the calibration table, which is the only thing that knows the mapping for a
particular lens. A host sending volts would be asserting a curve it cannot know.

## The part that is actually new: this path reads back

`MODE_READBACK` records that six of the existing paths read **nothing** back and
echo what they were sent. `b4-lens` gets:

```ts
'b4-lens': ['iris'],
```

Iris is commanded on **pin 5** and measured on **pin 7** — a physically separate
conductor, through its own ADC. The feedback is an independent measurement of
where the blades went, not the device repeating its own instruction. Of the
whole bridge, this is the only path where that is true.

Two consequences follow, and both are asserted in `b4LensClient.test.ts` at the
event rather than claimed in a comment:

- `handleRcpCommand('setIris')` emits **no** `stateChanged`. Emitting one would
  launder a command into a confirmation and defeat the model.
- A field the device did not measure is **absent** from `/api/status`, and the
  client reports nothing rather than zero.

Zoom and focus position are read too but deliberately **do not** appear in
`MODE_READBACK`: `CameraState` has no fields for them, and inventing `zoom` /
`focus` paint fields to hold a number nothing can command would put two dead
knobs on the RCP. They belong to the FreeD work in phase 5.

## `autoIris` is true, and that is unusual here

Pin 8 physically switches the lens between its own auto-iris and remote. Unlike
the CCU's auto-setup codes — NDA-only, which is why `capabilities.ts` disables
them everywhere else — this one is a wire, so it can be honestly offered.

The same exception had to be carried into `multicam-planner`, whose test forbade
`autoIris` in every row. It is now a named exception with a counter-check: a path
on the allow-list *must* carry `autoIris`, so a forgotten entry cannot look like
a decision.

## Cost, paid

`npm run caps:parity` obliged the copy in `multicam-planner` to learn the same
row, and `npm run drift` obliged the vendored copy in `av-planner-suite` after
it. Three repositories for one row — that is the price of the guard, and the
guard is why a printed camera plan cannot promise a control this repo never had.
