# Objektiv-Angaben gehören nicht in `caps:parity`

*Antwort auf Issue #36, entschieden 2026-09-18. Betrifft
[`packages/web-rcp/src/capabilities.ts`](../../packages/web-rcp/src/capabilities.ts),
[`scripts/planner-caps-parity.ts`](../../scripts/planner-caps-parity.ts) und
[`packages/bridge/src/plan/cameraPlan.ts`](../../packages/bridge/src/plan/cameraPlan.ts).*

## Die Frage

Eine B4-Optik meldet über das serielle Protokoll Angaben, die planungsrelevant
sind und nicht nur steuerungsrelevant:

| Code | Angabe |
|---|---|
| `0x11` / `0x12` | Objektivname, bis 80 Zeichen |
| `0x13` | Offenblende, `FNo = 2^(8·(1 − data/0x10000))` |
| `0x14` / `0x15` | Brennweite Tele / Weitwinkel |
| `0x16` | MOD, Naheinstellgrenze |

Gehören sie in den Capability-Vertrag, den `caps:parity` zwischen diesem Repo
und dem `multicam-planner` hält?

## Die Antwort: nein

Und der Grund ist nicht Geschmack, sondern dass die beiden Seiten **etwas
anderes für wahr halten**.

### 1. Eine Fähigkeit ist ein Ja/Nein über das Repo. Eine Objektiv-Angabe ist eine Messung am Gerät.

`capabilities.ts` sagt es im eigenen Kopf: „Mirrors exactly what each backend's
`handleRcpCommand` actually implements." Der Wert eines Eintrags hängt am
**Quelltext dieses Repos** und ändert sich nur, wenn hier jemand etwas baut.
`caps:parity` kann deshalb Verhalten gegen Verhalten prüfen: beide Seiten
rechnen dieselbe Funktion aus, und das Ergebnis ist reproduzierbar.

Die Offenblende einer Optik hängt an keinem Quelltext. Sie ist das, was ein
Stück Glas an Kamera 3 gerade meldet — und morgen hängt dort ein anderes. Ein
CI-Gate, das solche Werte vergleicht, prüft entweder nichts (weil kein Gerät
angeschlossen ist) oder es geht rot, weil jemand ein Objektiv gewechselt hat.
Beides ist die Sorte Prüfung, die abgeschaltet wird.

### 2. Der Capability-Vertrag hat keinen Platz für „noch nicht zurückgelesen".

Ein Eintrag in `capabilities.ts` ist ein `boolean`. Eine Objektiv-Angabe hat
drei mögliche Zustände, und der dritte ist der, auf den es ankommt:
**gelesen**, **nicht gelesen**, **nicht lesbar** (die Optik antwortet nicht,
oder die Antwort ist keine zwei Byte lang — `decodeOpenFNumber` gibt dann
bewusst `null` zurück). Genau diese Unterscheidung trägt dieses Repo schon,
aber an einer anderen Stelle: `state` trennt `origins` von `confirmations`
(siehe [`value-origin.md`](../value-origin.md)). Ein Sollwert, der nicht
zurückgelesen wurde, ist kein Wert.

Presste man die Angaben in den Capability-Vertrag, hieße `true` dort
zwangsläufig „diese Brücke kann eine Offenblende melden" — und das sagt über
die Zahl, die auf dem Pult steht, nichts.

### 3. Der Planer hat diese Angaben schon, und aus einer belegten Quelle.

`multicam-planner` führt 798 Objektive mit `manufacturerUrl` als
Herkunftsnachweis. Brennweiten, Offenblende und MOD stehen dort als
**Datenblatt-Werte** — nachgeschlagen, nicht gemessen. Sie ein zweites Mal aus
diesem Repo zu liefern hieße, zwei Wahrheiten über dasselbe Objektiv zu führen,
und die Frage „welche gilt" wäre nicht beantwortbar: das Datenblatt sagt, was
das Modell kann, die Optik sagt, was dieses Exemplar gerade meldet.

## Wo sie stattdessen leben

**Im Kamera-Plan-Kanal**, als Angabe über den Slot — dort, wo dieses Repo
ohnehin sagt, was es über ein angeschlossenes Gerät weiß (`SlotFacts`,
`knownModel`). Eine gemeldete Objektiv-Angabe ist von derselben Art wie ein
erkannter Modellname: eine Beobachtung an diesem Aufbau, zu diesem Zeitpunkt,
mit der Möglichkeit, dass sie fehlt.

Was das für den Abgleich mit dem Plan bedeutet, ist die nützliche Hälfte: der
Planer hat „Canon CJ20ex5B" geplant, die Brücke liest „CJ20ex5B IASE T" aus
`0x11`/`0x12` — **das** ist ein Beleg für die Zuordnung, und zwar ein
stärkerer als die Kameranummer. Dafür braucht es keinen Capability-Eintrag,
sondern ein Feld in `SlotFacts` und eine Zeile in `MatchEvidence`.

## Folgen

* `caps:parity` bleibt, was es ist, und wird um keine Zeile erweitert. Es
  bleibt grün, weil sich an beiden verglichenen Seiten nichts ändert.
* Das Lens-Backend (Issue #35) füllt `state.confirmations`, wenn eine Angabe
  zurückgelesen wurde, und nichts, wenn nicht. Es legt keine Capability an.
* Kommt die Zuordnung „gelesener Objektivname → geplante Kamera" (die nützliche
  Hälfte oben), gehört sie nach `plan/cameraPlan.ts` und trägt dort ihre eigene
  `MatchEvidence` — `lens`, neben `model`, `number` und `manual`.
* Sollte der Planer eines Tages **gemessene** statt nachgeschlagener
  Objektivdaten wollen, ist das ein eigener Weg mit eigenem Format und eigener
  Herkunftsangabe. Er wird hier eingetragen, mit Datum — nicht stillschweigend
  an den Capability-Vertrag gehängt.
