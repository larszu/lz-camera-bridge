# 2026-10-10 · Canon J15ax8B4 IRS SX12 · zoom position per focal length

## Conditions

- Lens on 12 V, zoom moved with the servo rocker, stopped ≈ 5 s on each engraved
  mark of the zoom ring. Pin 10 through 100 kΩ / 68 kΩ to ADS1115 A1,
  ~2 samples/s over USB. ≈ 0.1 V ground offset not corrected. Marks set by eye.
- Raw data: [`20261010-canon-j15ax8b4-zoom-scale.csv`](20261010-canon-j15ax8b4-zoom-scale.csv).

## Results

| Ring | Pin 10 | ARIB TR-B37 |
|---|---|---|
| 8 mm (wide end) | 1.69 V | wide 2.0 V |
| 15 mm | 3.32 V | |
| 30 mm | 4.67 V | |
| 60 mm | 5.69 V | |
| 120 mm (tele end) | 6.77 V | tele 7.0 V |

Close to logarithmic in focal length (≈ 1.0–1.6 V per doubling, steeper at
the wide end). The web page interpolates log(focal length) between these points.

## Zoom drive (not done)

The 12-pin has no zoom input. Canon's R-type ENG lenses take the zoom demand on
an 8-pin remote connector on the drive unit; its pinout here is still only a
hobby source (see `research-canon.md`). Free hardware for it: MCP4728 VB and
LM358 half B.
