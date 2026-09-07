# Kommandiert ist nicht bestätigt

*Bedarf 46 (P2). Modell: [`packages/bridge/src/protocol/valueOrigin.ts`](../packages/bridge/src/protocol/valueOrigin.ts) · Anzeige: [`packages/web-rcp/src/origin.ts`](../packages/web-rcp/src/origin.ts)*

## Der Befund

> On the Blackmagic SDI fleet the protocol is write-only, so **the controller
> only knows values it set itself**; ATEM camera-control variables
> (`gain_luma`, `lift_luma`, `gamma_luma`, `offset_luma`) return `null`;
> Panasonic AW-UE160 red/blue gain never feeds back. **Shaders work against a
> mental model, not the camera.**

Belegt am README von [`fiverecords/TallyCCUPro`](https://raw.githubusercontent.com/fiverecords/TallyCCUPro/main/README.md)
(„SDI protocol is write-only, system cannot query current camera settings"), an
[`companion-module-bmd-atem#350`](https://github.com/bitfocus/companion-module-bmd-atem/issues/350)
(vier Luma-Variablen liefern `null`) und an
[`companion-module-panasonic-cameras#56`](https://github.com/bitfocus/companion-module-panasonic-cameras/issues/56)
(Rot-/Blau-Gain meldet nie zurück, geschlossen als „not planned").

## Was hier wirklich passierte

Die Brücke führte je Kamera **einen** Zustand, und in ihn schrieben zwei
Quellen, die im Ergebnis nicht mehr zu unterscheiden waren:

1. `BridgeServer.echoState` — der optimistische Echo nach einem angenommenen
   Kommando. Sein Kommentar sagt selbst, er werde von pollenden Backends „mit
   dem echten Wert überschrieben".
2. `stateChanged` der Backends. Nur: **mehrere Backends senden darin ebenfalls
   den gerade geschickten Wert**, unmittelbar aus `handleRcpCommand` heraus —
   `ViscaClient` (`setIris`, `setMasterGain`), `JvcClient` (dito), `ZCamClient`,
   `PanasonicPtzClient` (`setIris`, `setBars`, `setCameraPower`) und
   `SonyPtpUsbClient`, dessen fünf `emitState()`-Aufrufe ausnahmslos direkt
   hinter einem `this.state.X = <kommandierter Wert>` stehen.

Es gab also **keinen Kanal, der Geräte-Wahrheit von einem Echo trennt**. Was
das Pult anzeigte, war auf diesen Wegen ausschließlich das zuletzt Gesendete.

## Die Tabelle entscheidet, nicht der Kanal

Die Herkunft wird deshalb nicht am Ereignis festgemacht — das wäre wieder nur
eine Vermutung —, sondern je Feld und Weg an `MODE_READBACK`. Dort steht,
welche Felder ein Backend überhaupt vom Gerät liest; jede Zeile ist am
Quelltext dieses Repos nachgelesen.

Ein Wert ist `confirmed` nur dann, wenn er über `stateChanged` kam **und** das
Feld in `MODE_READBACK` steht. Alles andere ist `commanded`. Ein Echo bleibt
ein Echo, auch wenn es als `stateChanged` verkleidet ankommt.

| Weg | liest zurück | woher |
|---|---|---|
| `tcp`, `serial` | Blende, Master-Black, Schwarz R/G/B, Weiß R/G/B, Gain, Gamma, Sättigung, Shutter, ND, White-Clip, Detail, Bars, Power | `CcuClient.handleMessage50` → `applyStateFromCommand` |
| `lumix-http` | Blende, Shutter, Gain | `LumixClient.pollState` (`mode=getstate`) |
| `canon-ccapi` | Blende, Shutter, Gain | `CanonCcapiClient.pollState` (av / tv / iso) |
| `blackmagic` | Blende, Gain, Shutter | `mapBmState` — siehe unten |
| `sony-mnc` | Blende, ND | `mapMncState` |
| `sony-usb`, `visca`, `zcam`, `panasonic-ptz`, `jvc`, `birddog` | **nichts** | alle `stateChanged` stehen in `handleRcpCommand` |

Zwei Zeilen verdienen eine Erklärung:

* **Blackmagic.** `BMDeviceClient.getState` *holt* `/colorCorrection/lift`,
  `/gamma`, `/gain`, `/offset`, `/contrast` und `/color` — `mapBmState` bildet
  davon **nichts** auf den Bildzustand ab. Genau der Fall aus dem Beleg: die
  Blackmagic gilt als die mit dem vollen Farbsatz, und die Farbregler des Pults
  zeigen trotzdem nur Gesendetes.
* **Lumix `cameraPower`.** `lumixStateToCamera` setzt es ausschließlich auf
  `true` und nie zurück. Eine Rückmeldung, die nur in eine Richtung geht, ist
  keine — deshalb steht das Feld nicht in der Tabelle.

## Auf dem Draht

```
{ type: 'state', cameraNumber, state, origins }
```

`origins` trägt je Feld `'confirmed'` oder `'commanded'`. Ein Feld ohne Eintrag
ist **nicht** unbestätigt, sondern gar nicht da — das Pult zeigt dafür `--`,
und `resolveNudge` sagt mit `no-current-value` ab (siehe
[`docs/paint-nudge.md`](paint-nudge.md)).

Die Kameraliste trägt zusätzlich `neverReadsBack` je Slot. Das Pult führt
**keine** Kopie von `MODE_READBACK`: es bekommt die fertige Auskunft. Eine
zweite Tabelle im selben Repo wäre die zweite Wahrheit, die dieser Bedarf
gerade abschafft.

## Was das Pult daraus macht

* Ein unbestätigter Wert wird **angezeigt** — er ist ja das Einzige, was es
  gibt —, aber nicht wie eine Messung: gedimmt, gestrichelt unterlegt, mit
  „gesendet, nicht zurückgelesen" als Tooltip. Kein Rot und kein Warnsymbol:
  es ist kein Fehler, sondern auf den meisten Wegen die Normallage, und Rot an
  zwanzig Reglern erzöge genau die Blindheit, gegen die die Markierung gebaut
  ist.
* Wo der Weg **gar nichts** zurückliest, steht der Satz **einmal** oben am
  Pult statt an jedem Regler. Zwanzig gleiche Markierungen sind keine Auskunft
  mehr, sondern Tapete.
* Ein Kommando entwertet eine frühere Bestätigung: was die Kamera *vor* dem
  Kommando gemeldet hat, gilt danach nicht mehr. Ein pollendes Backend setzt
  sie gleich wieder.

## Was hier ausdrücklich NICHT passiert

Kein Backend bekommt eine erfundene Leseroutine, und keine Zeile der Tabelle
behauptet eine Rückmeldung, die im Quelltext nicht steht. Wo dieses Repo nichts
liest, sagt das Pult das — statt eine Zahl zu zeigen, die nach Messung aussieht.
