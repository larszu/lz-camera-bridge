# Lens inventory

Issue #38: for **every** lens on hand, which interface group it belongs to
(A: RS-232 at an extra socket · B: serial inside the 12-pin · C: analog only,
see [`b4-lens-control.md`](b4-lens-control.md) §1), and **how that was found
out**. A row without a method is a guess. A lens whose group cannot be settled
stays **unklar**.

| Manufacturer | Type | Serial no. | Group | How determined | Date |
|---|---|---|---|---|---|
| Canon | J15ax8B4 IRS SX12 | *(read off the barrel)* | **C (analog) — probable** | Pin 11 stays at ground level while focus is turned (no focus sensor on this IRS SX12, so pin 11 cannot settle it); iris drives over the analog pin 5 and reports on pin 7 1:1 ([`20261010-canon-j15ax8b4-first-drive.md`](measurements/20261010-canon-j15ax8b4-first-drive.md)). Pin 12 and a logic analyser on 11/12 not yet done. | 2026-10-10 |

## Measuring procedure (passive, drives nothing)

1. Lens on 12 V only (pin 6 +12 V, pin 3 GND), nothing else connected.
2. Pin 11 against ground, multimeter first, then the logic analyser:
   - steady voltage that follows the focus ring (reference says 2–7 V) → **C**
   - digital activity; per the source the idle pattern is `FB 03` → **B**
3. Pin 12: activity yes/no.
4. Look over the housing for an extra serial socket with handshake pins → **A**.
5. Write the note under [`measurements/`](measurements/) (naming and required
   content per its README), then replace the row above: group, method, date.
