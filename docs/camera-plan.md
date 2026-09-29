# Kamera-Plan aus dem MultiCam-Planner (`camera-list`)

Der MultiCam-Planner der AV Planner Suite plant die Kameras einer Show: welche
stehen wo, welches Modell, welche Beschriftung. Diese Brücke kennt dieselben
Kameras von der anderen Seite — eine Nummer, eine Verbindungsart, eine Adresse.
Beide Listen beschreiben dieselbe Anlage, und niemand hat sie bisher
aneinandergehalten. Wer am Pult sitzt, sieht „Kamera 3" und muss selbst wissen,
dass das die ist, die im Plan „CAM 3 — Bühne links" heißt.

## Wo

**Multiview → Kamera-Plan.** Die `camera-list` laden, **Abgleichen**, das
Ergebnis lesen, dann **Übernehmen**. Danach steht die Beschriftung aus dem Plan
auf jeder Kachel.

## Was ein Abgleich hier heißt — und was nicht

Diese Brücke kann in vielen Fällen **nicht** wissen, welches Gerät an einer
Adresse hängt: bei TCP und seriell steht dort ein Host und ein Port, kein
Modellname. Ein Abgleich, der dann trotzdem etwas behauptet, wäre geraten.

Deshalb trägt jede Zuordnung einen **Beleg**:

| Beleg | Was er bedeutet |
|---|---|
| `model` | Die Brücke **kennt** das Modell (USB-Erkennung, MNC-Discovery) und es passt eindeutig zu genau einer geplanten Kamera. Gemessen. |
| `number` | Die Beschriftung im Plan trägt dieselbe Zahl wie der Slot („CAM 3" ↔ Kamera 3). Eine Konvention, keine Messung — steht deshalb als **Vorschlag** da, auf der Kachel mit `?` markiert. |
| `manual` | Ein Mensch hat sie zugeordnet. Überschreibt alles und überlebt jeden weiteren Abgleich. |

Wo es keinen Beleg gibt, gibt es **keine Zuordnung** — und der Grund steht im
Klartext daneben, statt dass jemand raten muss, ob der Abgleich versagt hat oder
ob es schlicht nichts zu belegen gab.

## Eindeutig oder gar nicht

Passt ein Modell auf zwei Slots (zwei FX9 im Rack), gibt es keinen Vorschlag.
Passen zwei geplante Kameras auf dasselbe Gerät, ebenso wenig. Zwei plausible
Zuordnungen sind keine halbe Zuordnung, sondern eine Verwechslungsgefahr — und
die falsche Kamera zu schwenken, weil das Pult sie falsch beschriftet hat, ist
genau der Schaden, gegen den das gebaut ist.

Modellnamen werden ohne Leerzeichen, Bindestriche und Groß-/Kleinschreibung
verglichen, und in beide Richtungen enthaltend: der USB-Produktstring sagt
`ILME-FX3`, der Katalog des Planers `FX3`, ein SSDP-Header nennt gern noch die
Firmware dazu.

## Die drei Nachrichten

Über denselben WebSocket wie alles andere (`ws://<host>:9700`):

| Nachricht | Wirkung |
|---|---|
| `{ type: 'matchCameraPlan', plan }` | Antwortet mit `cameraPlanMatch` — was zusammengehört und womit belegt. Ändert nichts. |
| `{ type: 'applyCameraPlan', plan }` | Schreibt die Zuordnung an die Slots und sendet die neue Kameraliste an alle. |
| `{ type: 'assignPlanCamera', cameraNumber, planCameraId, plan }` | Von Hand zuordnen (`planCameraId: null` löst die Zuordnung). Dieselbe geplante Kamera liegt danach auf genau einem Slot — sonst wären zwei Pulte für dasselbe Gerät beschriftet, und eines davon lügt. |

`plan` nimmt die Datei als Text **oder** als Objekt — sonst bräuchte der Weg von
Hand und der Weg aus einem anderen Programm zwei Eingänge.

Die Kameraliste (`type: 'cameras'`) trägt seitdem pro Slot `plan` und
`planMatchedBy` mit, wenn eine Zuordnung besteht.

## Wo es geprüft ist

`packages/bridge/test/cameraPlan.test.ts` (`npm test`): Modell quer durch drei
Schreibweisen, zwei gleiche Modelle am Bus ergeben nichts, die Gegenrichtung
derselben Regel, Modell schlägt Nummer, eine Zuordnung von Hand überlebt den
Abgleich, ein Slot wird höchstens einmal vergeben, und ohne Beleg steht ein
Grund da statt eines Schweigens.


## Geplante Shots anfahren und speichern (v3)

Seit v3 traegt die Kamera-Liste je Kamera die geplante **Ausrichtung** (`pan`,
`tilt`, Grad im Raum: Pan 0 = nach rechts im Grundriss, im Uhrzeigersinn
positiv; Tilt negativ = nach unten) und ihre **Shots** (`presets[]`: Nummer,
Name, Pan, Tilt, Brennweite, Fokusdistanz). Die Bruecke liest v1 bis v3 und
lehnt eine unbekannte Version benannt ab.

`protocol/ptzPose.ts` rechnet einen Shot in eine Kopf-Pose um:

```
headPan  = shotPan  − homeHeading + offset.pan
headTilt = shotTilt              + offset.tilt
```

`homeHeading` ist die Raumrichtung, in die der Kopf bei Pan 0 schaut — die
geplante Ausrichtung der Kamera, solange die Anlage nichts anderes sagt
(`config.homeHeading`). `offset` ist der Montagefehler, **vor Ort gemessen**:
Kopf von Hand auf einen bekannten Shot steuern, *Head is here* — die Bruecke
liest die echte Pose des Kopfs und merkt sich die Differenz zur geplanten.
Ein Kopf, der 3° neben der Zeichnung sitzt, setzt jeden Shot 3° daneben; eine
Messung korrigiert alle. Der Offset steht in der Anlagendatei.

**Zoom** ist die ehrliche Luecke: der Kopf nimmt eine Zoom-*Position*
(VISCA 0..0x4000, AW 0x555..0xFFF), der Plan kennt eine *Brennweite*. Die
beiden Enden sind Definitionen (Position 0 = weit, Maximum = tele); dazwischen
ist die Kurve je Modell nichtlinear. Ohne gemessene Tabelle interpoliert die
Bruecke linear und sagt das (`fit: 'linear'`, im Panel „zoom estimated"); mit
`config.zoomTable` (`[{ position, focalMm }]`, an diesem Modell gemessen)
zwischen den Messpunkten.

Absolute Fahrten je Weg:

| Weg | Anfahren | Pose lesen |
|---|---|---|
| VISCA (IP, RS-232) | `81 01 06 02 …` AbsolutePosition, `81 01 04 47` Zoom Direct | `81 09 06 12`, `81 09 04 47` |
| Sony SRG/BRC CGI | `ptzf.cgi?AbsolutePanTilt=`, `AbsoluteZoom=` | `inquiry.cgi?inq=ptzf` → `AbsolutePTZF` |
| Vissonic / PTZOptics CGI | keine absolute CGI — VISCA ueber TCP 5678 | VISCA ueber TCP 5678 |
| Panasonic AW | `#APC`, `#AXZ` | `#PTV` (UE150/UE100/UE80), sonst `#APC` und `#GZ` |

Skala: 14,4 VISCA-Einheiten je Grad (Sony BRC/SRG, PTZOptics: ±170° = ±0x0990);
`config.unitsPerDeg` fuer Koepfe, die abweichen. Panasonic AW nach den
Interface-Spezifikationen des Herstellers (HD/4K v1.12, UE150/HE145, UE100,
UE80/50/40/30): Pan 0x2D09 (−175°) bis 0xD2F5 (+175°); Tilt **umgekehrt** —
der Wert sinkt, wenn der Kopf nach oben schaut: 0x8E38 = −30°, 0x5555 = +90°,
bei HE120/HE130/HR140 bis 0x1C71 = +210°. Die Tabellen des Herstellers drucken
„5555(−30deg) – 8E38(+90deg)"; Rechnung und die #HAC-Zeile der UE80-Spezifikation
zeigen die hier benutzte Richtung. Am Kopf gegengeprueft ist das noch nicht.

Nachrichten: `drivePlannedPreset`, `storePlannedPresets` (faehrt jeden Shot
an, wartet `settleMs`, dann `storePreset` — Fortschritt als
`plannedProgress`), `calibratePose`, `setPoseOffset`, `readPose` → `pose`.
Die Demo-Kamera fuehrt eine Pose und ist damit der Pruefstand ohne Hardware
(`test/plannedShots.test.ts`).
