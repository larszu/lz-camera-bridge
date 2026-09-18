# Measurements

`brief.md` §3 makes this binding: *"Document measurements, including failed
ones. Public information on this interface is scarce; the notes have value
beyond this project."*

That is the whole reason this directory exists. Every voltage quoted in
[`wiring.md`](wiring.md) and [`b4-lens-control.md`](b4-lens-control.md)
comes from someone else's reconstruction of a **Fujinon**. Nothing in this
repository has confirmed any of it on a **Canon**. A measurement here is worth
more than a table there.

## Naming

```
YYYYMMDD-<lens>-<what>.md      the note
YYYYMMDD-<lens>-<what>.csv     the data, if any
```

For example `20260923-canon-j15ax8b4-group-check.md`.

## What a note must contain

A note that omits the conditions is not a measurement, it is a memory.

- **Lens**, exactly: model, serial if legible, extender in or out.
- **What was connected**, including what was *not*. "Lens on 12 V only" is a
  different measurement from the same reading with a camera attached.
- **Instrument** and its resolution. A 3½-digit multimeter and a 16-bit ADC
  disagree in the last place, and it matters which one said so.
- **The numbers**, raw. Not only the conclusion.
- **What you expected**, from the tables in this repo, and whether it matched.
- **Failures.** A ring that did nothing, a pin that read 0 V, a reading that
  would not settle. These are the entries worth the most later, and the ones
  everyone is tempted to leave out.

## Open questions these notes should eventually answer

From [`b4-lens-control.md`](b4-lens-control.md) §7:

- Is there **any** serial interface on Canon B4 glass? Two sources disagree and
  neither tested it.
- Do the published iris voltages (closed 2.5 V, F16 3.4 V, F2.8 6.2 V) hold on a
  Canon, or are they Fujinon-specific?
- What do command codes `0x42`–`0x44` / `0x52`–`0x54` ("switch 2/3/4") switch?
- Is the Canon BDC-10 conversion cable passive? If so, measuring it yields the
  18-pin demand pinout for free.
