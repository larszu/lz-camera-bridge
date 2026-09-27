# Canon desk research: our lens, its connectors, digital demands

Desk research for #38 (which group is our lens) and #50 (digital demand,
Canon 18-pin, conversion cable), done 2026-09-27. **Nothing here is a
measurement.** It narrows down what the bench has to check; it does not
replace the check.

Every statement below gives its source. Canon's own documents come first;
dealer and hobby pages are marked as such and count for less. Quotes are
verbatim from the source. Where nothing was found, the table says so. A gap
stays a gap here; it is not filled with a guess.

## Sources

| Key | Document | Kind |
|---|---|---|
| C09 | Canon broadcast lens pocket guide (2009), hosted at <https://www.theodoropoulos.info/attachments/076_Canon_Lenses.pdf> | Canon document, third-party host |
| C16 | Canon BCTV catalogue (2016), <http://downloads.canon.com/bctv/BCTV_Catalog_Updated_113016.pdf> | Canon |
| C23 | Canon 2023 Broadcast and Cine Lens Catalog, <https://asia.canon/media/document/2023/05/26/0561f0ecf86942bf9ca2e9b290f95a71_2023+Broadcast+and+Cine+Lens+Catalog.pdf> | Canon |
| ZSD | Canon ZSD-300D operation manual, <https://www.manualslib.com/manual/4095772/Canon-Zsd-300d.html> (also <https://archive.org/details/manuallib-id-2695248>) | Canon manual, third-party host |
| ABL | AbelCine product page ZSD-300D, <https://www.abelcine.com/buy/lenses-accessories/motors-control/canon-zsd-300d-remote-digital-zoom-servo-demand> | dealer |
| VL | Videolinea, BDC-11, <https://www.videolinea.com/en/broadcast-av-cables-connectors/244326-canon-conversion-cable-for-zdj-d02-fdj-d02> | dealer |
| CT | <https://www.cameratim.com/electronics/lens-zoom/> | hobby page, not Canon |
| SPC | 3ality SPC-7000 connector sheet, see [`spc7000-pinout.md`](spc7000-pinout.md) | third party, 2010 |

## #38 — what the name "J15ax8B4 IRS SX12" says

| Letter | Meaning | Source |
|---|---|---|
| I | "Built-in Extender for Portable Lenses" | C09 |
| R | "Zoom:Servo Focus:Manual (Standard ENG Drive Unit)" | C09 |
| S | "Iris Servo Control"; C16: "S = Iris Servo" | C09, C16 |
| D / E (absent here) | "D…Digital features for portable lenses", "E…Latest Enhanced digital features" | C09 |
| SX12 | **not found** in any Canon source | — |

What that implies, and how strongly:

- **Follow signals are a digital-variant feature.** C16: *"Follow signal display
  for Iris, Zoom, and Focus (IASD/IASE only) for virtual reality, robotic
  control, and other uses."* Our lens is IRS: no D, no E.
- **Canon's "12-pin serial communication" belongs to newer lenses.** C23 lists it
  with *"Applicable lens: CINE-SERVO Lens series."*
- **The zoom remote connector of a non-digital R-type is 8-pin.** ZSD: *"Connect
  the connector (20-pin) of the servo zoom demand cable to the zoom remote
  connector (8-pin, normally covered by a cap) at the bottom of the lens drive
  unit via the CC-0820 conversion cable"*, and *"The "R" type and "A" type lenses
  require conversion cable CC-0820 and some functions are limited."*

**Conclusion for #38:** everything points to **group C** (analog only). No
Canon document says so outright, though. The inventory therefore records
the lens as *expected C, unmeasured* until the passive check on pin 11 has
been done.

Not found: a manual or data sheet for the J15ax8B4 itself, Canon's own 12-pin
pin assignment, and any Canon voltage for iris control or position. The
voltages used in this repo remain the Fujinon reconstruction.

## #50 — digital demands and the conversion cable

| Question | Finding | Source |
|---|---|---|
| Which cable connects ZDJ-D02 / FDJ-D02? | *"BDC-11 20p - 18p cable. Required for FDJ-D02 / ZDJ-D02."* | C23 |
| The **BDC-10** named in `b4-lens-control.md` §7 and in #50 | **not found** in any Canon document; the current catalogue names **BDC-11** for this job. VL also lists the conversion cable for ZDJ-D02/FDJ-D02 as BDC-11 | C23, VL |
| Is BDC-11 passive? | **not found** | — |
| Interface of ZDJ-D02 / FDJ-D02 (RS-422?) | **not found** at Canon. Only SPC lists "Canon Digital Focus/Zoom" on an 8-pin Lemo beside RS-422 lines for Preston FIZ2 — that says the SPC-7000 accepted one there, not what Canon's protocol is | SPC |
| Other Canon demand cables | *"BDC-21 20p-12p cable. Required for FDJ-P01 / ZDJ-P01."*, *"CC-2008 20p - 8p cable. Required for ZSD-15II"* | C23 |
| ZSD-300D connector | 20-pin; ABL: *"one-touch, 20-pin connector"* | ZSD, ABL, C16 |
| Canon 8-pin zoom remote pinout | only CT, a hobby page: A 2.5 V (tele end), B 7.5 V (wide end), C/D 5 V, E/G ground, F record, H return — the author himself writes it is *"almost the same as the Fuji one, but with pins A and B swapped"*. **Unverified, not Canon.** | CT |

**Consequence for #50.** The step "measure BDC-10 through" names a cable
Canon does not list for this purpose. The candidate is **BDC-11**. Whether it is
passive can only be found out by continuity-testing a real cable, and the
decision between that and the 8-pin-Lemo/RS-422 route needs a price per route —
both belong to Lars at the bench and the till, not to this document.

For our IRS lens specifically, a *digital* demand is the wrong starting point
anyway: per ZSD the non-digital R-type takes a 20-pin demand only through
CC-0820 with limited functions, and its native zoom remote is 8-pin analog.

## Open, for the bench

1. Pin 11 at rest and while turning focus (#38): steady 2–7 V (group C) or a
   digital line (group B).
2. The 8-pin zoom remote connector on the lens: pin functions measured, not
   copied from CT.
3. BDC-11: passive or not — continuity test on a real cable.
4. `Detect` on a Fujinon B/C demand (#37, #49).
