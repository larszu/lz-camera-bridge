# Pinbelegung: ESP32-DevKit an der Canon J15ax8B4

Der Bankaufbau für Phase 1 (Iris) läuft auf einem **klassischen ESP32-DevKit**,
nicht auf dem Waveshare ESP32-S3-ETH, für das `config.h` ursprünglich
geschrieben ist. Diese Seite ist die verbindliche Belegung für genau diesen
Aufbau. Schaltung und Inbetriebnahme-Reihenfolge stehen in
[`wiring.md`](wiring.md) und gelten unverändert.

> **Alle Spannungsangaben auf der Objektivseite sind ungeprüft** (Quelle:
> fremde Rekonstruktion, siehe [`b4-lens-control.md`](b4-lens-control.md)).
> Bis ein Messwert in [`measurements/`](measurements/) steht, sind es
> Behauptungen.

## Das Board

| | |
|---|---|
| Chip | ESP32-D0WD-V3, Revision 3.1, Dual Core 240 MHz |
| Flash | 4 MB, kein PSRAM |
| USB | CP2102 (USB-UART), am Mac `/dev/cu.usbserial-0001` |
| MAC | `68:09:47:b1:6c:94` |
| Netz | WLAN — kein Ethernet |
| Build | `pio run -e esp32-devkit` (sicher) · `esp32-devkit-armed` (Drive einkompiliert) |

Ausgelesen am 08.10.2026 mit `esptool flash_id`.

## ESP32-Pins

| GPIO | Funktion | Verbunden mit | Status |
|---|---|---|---|
| **21** | I²C SDA | MCP4728 SDA, ADS1115 SDA (beide) | belegt |
| **22** | I²C SCL | MCP4728 SCL, ADS1115 SCL (beide) | belegt |
| **3V3** | Versorgung | MCP4728 VCC, ADS1115 VDD, Op-Amp-Offset (Ra) | belegt |
| **GND** | Masse | Module, Op-Amp, 12-V-Netzteil-Masse, Hirose Pin 3 | belegt |
| 2 | Onboard-LED (blau) | — | nur Sendebau, den es für dieses Board nicht gibt |
| 16 | UART1 RX ← Hirose 11 | — | reserviert Gruppe B, **nicht verdrahten** (Canon = Gruppe C) |
| 4 | UART2 RX ← Hirose 12 | — | reserviert Gruppe B, nicht verdrahten |
| 17 | UART1 TX → Hirose 12 | — | reserviert, kein Build sendet |
| 25 / 26 | später Pin 8 / Pin 4 per MOSFET | — | frei; in `config.h` steht -1 (Leitungen fest verdrahtet) |
| 32 / 33 | später VTR / RET des Demands | — | frei; `config.h` -1 |

**Nicht verwenden:** 0, 2, 5, 12, 15 (Strapping — GPIO 12 high beim Booten
schaltet die Flash-Spannung auf 1,8 V und das Board startet nicht mehr),
6–11 (SPI-Flash), 1/3 (USB-Konsole), 34–39 (nur Eingang).

**Kein ESP32-Pin ist mit dem Objektiv verbunden.** Alles läuft über I²C zu DAC
und ADC; die einzige Verbindung zur Objektivseite ist die gemeinsame Masse.
Die GPIOs sind 3,3 V und nicht 5-V-fest.

## I²C-Bus

| Adresse | Baustein | Aufgabe |
|---|---|---|
| `0x60` | MCP4728 (4-Kanal-DAC), **an 3,3 V** | Kanal A → Op-Amp → Pin 5 |
| `0x48` | ADS1115 (ADDR an GND) | Rücklesung Pin 7 / 10 / 11 |
| `0x49` | ADS1115 (ADDR an VDD) | Demands, Phase 4 — für die Iris nicht nötig |

Beim Booten scannt die Firmware den Bus und meldet auf der Konsole, was
antwortet. Stand 08.10.: nichts (Module noch nicht gesteckt).

## ADS1115 `0x48` — Rücklesung

Jeder Eingang über Teiler **100 kΩ (oben) / 68 kΩ (unten)** (ARIB verlangt ≥ 20 kΩ Last an Pin 7; optional 10–100 nF am ADC-Eingang); 7,0 V am
Objektiv → 2,83 V am ADC.

| ADS-Eingang | Hirose-Pin | Signal |
|---|---|---|
| A0 | 7 | Iris-Position |
| A1 | 10 | Zoom-Position |
| A2 | 11 | Fokus-Position (Gruppe C) |
| A3 | — | Op-Amp-Ausgang (Kontrolle, optional) |

Gemessene Widerstandswerte in `config.h` eintragen (`DIVIDER_R_TOP_OHM`,
`DIVIDER_R_BOTTOM_OHM`).

## MCP4728 `0x60` → Op-Amp → Pin 5

| DAC-Kanal | Ziel |
|---|---|
| A (`DAC_CH_IRIS 0`) | Rb 10 kΩ → +Eingang des Op-Amps |
| B, C, D | frei |

Op-Amp **nur LM358, kein TL072** (Gleichtaktbereich), Versorgung über **9-V-Regler** aus Hirose 6, damit Pin 5 im Fehlerfall nicht über ≈ 7,5 V geht:
Ra 16 kΩ von 3,3 V an +In · Rb 10 kΩ vom DAC an +In · R1 10 kΩ −In → GND ·
R2 10 kΩ Ausgang → −In. Ergebnis `1,231 · Vdac + 2,54` → 2,54–6,60 V,
dann **1 kΩ in Serie** zu Pin 5.

## Hirose 12-Pin (Objektiv)

**Achtung:** An der Buchse läuft die Nummerierung spiegelverkehrt zum Stecker.
Von der falschen Seite gezählt sind Pin 3 (GND) und Pin 6 (+12 V) vertauscht —
so beim Bankaufbau am 10.10.2026 verwechselt. Pin 3 vor dem Einschalten per
Durchgang gegen das Gehäuse bestätigen.

| Pin | Signal | Verbunden mit |
|---|---|---|
| 3 | GND | gemeinsame Masse (ESP32, Module, Netzteil) |
| 4 | Forced Iris Servo (Tastenfunktion, kein Enable) | **offen lassen** |
| 5 | Iris-Sollwert | Op-Amp-Ausgang über 1 kΩ — **erst Schritt 5 der Inbetriebnahme** |
| 6 | **+12 V** (Norm: 10–17 V) | Labornetzteil 12 V, **Strombegrenzung 1,0 A**, Polarität doppelt prüfen; 9-V-Regler für den Op-Amp. **Nie an ESP32 oder Module** |
| 7 | Iris-Position | Teiler → ADS1115 A0 |
| 8 | Iris Remote/Auto | 5 V über **1 kΩ** (Remote); offen = Auto |
| 10 | Zoom-Position | Teiler → ADS1115 A1 |
| 11 | Fokus-Position | Teiler → ADS1115 A2 |
| 12 | seriell (Gruppe B) | nicht verbunden |

Am Objektiv: für die Steuerung Iris-Schalter auf **A**, sonst ignoriert es Pin 5.
**Den Irisring nur in M von Hand drehen** — Canon warnt, dass Drehen in A das
Objektiv beschädigen kann. Pin 5 nie offen lassen, solange A steht; Reihenfolge:
Verstärker auf ≈ 2,54 V → Pin 5 verbinden → Pin 8 auf 5 V → erst dann A.

Pegel laut ARIB TR-B37 (Norm, nicht an dieser Optik gemessen): Pin 5/7 bei
F2,8 = 6,2 V, F16 = 3,4 V; „zu" ist ein Band (Sollwert 2,1–2,9 V, Rückmeldung
1,5–2,9 V). Quellen: [`recherche-2026-10.md`](recherche-2026-10.md).

## Netz

Das Board öffnet immer einen eigenen Access Point:

| | |
|---|---|
| WLAN | `b4-lens` |
| Passwort | `b4-iris-bench` |
| Adresse | <http://192.168.4.1> |

Soll es zusätzlich ins Hausnetz: `src/wifi_secrets.example.h` nach
`src/wifi_secrets.h` kopieren (gitignored), Zugangsdaten eintragen, neu
flashen. Die Adresse im Hausnetz steht dann auf der Konsole
(`pio device monitor -e esp32-devkit`); der Access Point bleibt zusätzlich an.

## Was auf dem Board ist

Seit 08.10.2026 der **sichere Build** (`esp32-devkit`): liest, treibt nichts,
DAC wird auf 0 geparkt. Für die Blendensteuerung nach bestandener Rücklesung
(wiring.md §2) und aufgenommener Kalibriertabelle:

```bash
cd packages/firmware-b4
pio run -e esp32-devkit-armed -t upload
```

Auch dieser Build fährt erst, wenn er über `POST /api/arm` scharfgeschaltet
ist und eine Kalibriertabelle existiert.
