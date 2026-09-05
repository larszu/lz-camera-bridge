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
