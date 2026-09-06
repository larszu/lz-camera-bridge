# Relative Kommandos und die Skalen des Busses

Ein Bildtechniker verstellt den Schwarzwert nicht, indem er eine Zahl eingibt.
Er trimmt: ein Stück runter, hinsehen, noch ein Stück. Software-CCUs bieten
dafür oft nur absolute Werte an — und dann muss man die Zahl kennen, auf die
man springen will, statt von dort weiterzugehen, wo man steht.

> Software CCU surfaces offer absolute value setting only, so black level —
> the parameter adjusted most often — has to be jumped to a number rather than
> trimmed, and **the value scale can be wrong** (setting `lift_luma 1` produces
> 0.5 on the ATEM).
>
> — Bedarf 129 der Bedarfs-Datenbank, belegt an
> [`bitfocus/companion-module-bmd-atem#350`](https://github.com/bitfocus/companion-module-bmd-atem/issues/350)
> (Januar 2025)

Der Beleg nennt zwei Dinge in einem Atemzug, und sie hängen zusammen: es fehlen
Inkrement-Aktionen, **und** die Wertskala kann falsch sein. Wer relativ
verstellt, muss wissen, wovon aus und in welchen Einheiten — sonst wird aus dem
Trimm ein Sprung.

## Das relative Kommando

```jsonc
{ "type": "command", "cameraNumber": 3,
  "cmd": "nudge", "params": { "parameter": "masterBlack", "by": -1 } }
```

Aufgelöst wird es **einmal**, in
[`packages/bridge/src/protocol/paintNudge.ts`](../packages/bridge/src/protocol/paintNudge.ts),
gegen den Zustand, den die Brücke für diese Kamera führt. Was danach nach unten
geht, ist ein gewöhnliches absolutes Kommando (`setMasterBlack` mit einem Wert).
**Kein Backend kennt eine relative Sprache** — sonst müsste jedes von ihnen den
Ausgangswert selbst kennen, und es gäbe acht Antworten auf die Frage, wovon aus
getrimmt wird.

Dieselbe Auflösung bedienen auch die Companion-Tasten (`irisUp`, `blackDown`, …)
und die Auf-/Ab-Wähler des Web-RCP. Eine Rechnung, drei Wege.

### Ohne gelesenen Wert kein Trimm

Hat die Brücke den Wert an dieser Kamera noch nie gesehen, kommt **eine Absage
mit Grund** — nicht 128, nicht 0, nicht „nimm die Mitte":

| Absage | Wann | Was der Bedienende liest |
|---|---|---|
| `no-current-value` | Die Kamera hat den Wert noch nicht gemeldet | „Der aktuelle Wert ist unbekannt … Einmal absolut setzen, dann lässt sich von dort aus trimmen." |
| `at-limit` | Der Wert steht schon am Anschlag | „Der Wert steht bereits am Anschlag." |
| `zero-step` | `by` fehlt oder ist 0 | „Ein Trimm braucht eine Richtung." |
| `unknown-parameter` | Der Parameter steht nicht in der Tabelle | „Dieser Wert lässt sich nicht relativ verstellen." |

Das ist ADR-003 an der Bedienseite: was niemand abgelesen hat, wird nicht
behauptet. Vorher rechnete der Dispatcher `(perCam.iris ?? 128) + 5` und
schickte 133 an eine Kamera, deren Blende niemand gelesen hatte — angezeigt, als
hätte jemand um 5 verstellt.

Klemmt der Anschlag den Schritt nur ab (von 253 um 5 nach oben ⇒ 255), findet
der Zug statt und wird als `clamped` gemeldet.

## Die Skala des Busses

Der Bus hat **eine** Skala je Wert. Sie steht in `PAINT_PARAMETERS` und
nirgends sonst; jeder Eintrag trägt den Beleg, aus dem sein Bereich stammt.

| Parameter | Kommando | Bereich | Schritt | Woher der Bereich belegt ist |
|---|---|---|---|---|
| `iris` | `setIris` | 0..255 | 5 | `PtzPanel.tsx` nennt den Bereich; `BMDeviceClient` teilt durch 255 |
| `masterBlack` | `setMasterBlack` | 0..255 (Mitte 128) | 1 | `RotaryKnob detent={128}`; `BMDeviceClient` rechnet `(v-128)/128` |
| `masterGamma` | `setMasterGamma` | 0..255 (Mitte 128) | 1 | dieselbe bipolare Umrechnung |
| `saturation` | `setSaturation` | 0..255 (Mitte 128) | 1 | `BMDeviceClient`: `v/128` auf 0..2 |
| `masterGain` | `setMasterGain` | **Index** 0..6 | 1 | `GAIN_VALUES` (0/+3/…/+18 dB), `gainIsoMap`, `GAIN_INDEX_TO_ISO` |
| `ndFilter` | `setNdFilter` | **Index** 0..3 | 1 | `ND_VALUES` nennt vier Stellungen |

Ein Trimm ist der kleinste sinnvolle Zug, deshalb Schritt 1 — außer bei der
Blende, wo die vorhandene Companion-Taste seit jeher 5 bewegt (rund zwei Prozent
des Wegs). Wer anders trimmen will, gibt `by` mit; die Vorgabe ist eine Vorgabe,
keine Grenze.

### Was nicht in der Tabelle steht, und warum

Aufgenommen ist nur, wo sich der Bereich **aus dem Code belegen lässt**. Ein
erfundener Bereich wäre schlimmer als keiner: der Trimm bekäme stillschweigend
eine falsche Weite, und genau davon spricht der Beleg.

- **`detailLevel`** — `LumixClient` klemmt auf -7..+7, `CcuClient` reicht roh
  durch. Zwei unvereinbare Lesarten, keine gemeinsame Skala.
- **`shutterSpeed`** — ein Index in eine kameraabhängige Tabelle, deren Länge
  kein Backend nennt. Eine Obergrenze wäre geraten.
- **`blackR/G/B`, `whiteR/G/B`** — gehen als Tripel über `setBlackBalance` /
  `setWhiteBalance`. Ein Trimm einer einzelnen Achse müsste die beiden anderen
  mitschicken und dafür ebenfalls gelesen haben. Machbar, aber ein eigener
  Schritt.

## Was jedes Backend aus dem Bus-Wert macht

| Backend | `masterGain` | `ndFilter` | Bipolare Werte (Black/Gamma) |
|---|---|---|---|
| Sony CCU (`CcuClient`) | Index roh als CNS-Schaltwert | Index roh | 16-Bit-Analogwert, roh — siehe unten |
| Sony MNC | `gainIsoMap[0..6]` → ISO | POST `ndFilter` | — |
| Sony USB/PTP | `setGainIndex` | nicht unterstützt | — |
| Canon CCAPI | `GAIN_INDEX_TO_ISO` → ISO | nicht unterstützt | nicht unterstützt |
| Z CAM | `GAIN_INDEX_TO_ISO` → ISO | — | — |
| VISCA / BirdDog / Panasonic / JVC | Gain-Position 0..0x0f bzw. Auf-/Ab-Schritte | — | — |
| Blackmagic REST | **Index × 3 dB** | `stop` | `(v-128)/128` auf -1..+1 |
| Lumix | ISO-Stufen | ohne Wirkung (kein motorisches ND) | Belichtungskorrektur |

**Blackmagic und die dB-Frage.** Bis Bedarf 129 stand in `BMDeviceClient` ein
Kommentar: „treat the gain index as a dB value". Sechs von sieben Backends lesen
`masterGain` als Index; nur dieses eine tat es nicht. Damit erreichte Index 6 —
am Pult als „+18dB" beschriftet — eine Blackmagic-Kamera als **6 dB**. Genau die
stille Fehlskalierung, von der der Beleg spricht. Umgerechnet wird jetzt mit der
Stufung des Busses (`BUS_GAIN_STEP_DB = 3`).

**Offen: der Sony-CCU-Analogbereich.** `CcuClient` schickt die 0..255 des Busses
als 16-Bit-CNS-Analogwert weiter, ohne umzurechnen, und meldet umgekehrt den
vollen 16-Bit-Wert zurück. An einem echten CCU trifft also der obere Rand des
Busses nur den unteren Rand des CNS-Bereichs. Das steht hier und ist **nicht
stillschweigend repariert**: welche Breite die CNS-Analogwerte tatsächlich haben,
lässt sich nur an einem CCU messen, und eine geratene Umrechnung wäre wieder
dieselbe Klasse Fehler.

## Tasten

Die relativen Tasten stehen in `NUDGE_ACTIONS` — dieselbe Datei, dieselbe
Tabelle. Companion baut seine Preset-Liste daraus, statt sie danebenzuführen.

| Id | Wert | Id | Wert |
|---|---|---|---|
| `irisUp` / `irisDown` | Blende | `blackUp` / `blackDown` | Master Black |
| `gainUp` / `gainDown` | Master Gain | `gammaUp` / `gammaDown` | Master Gamma |
| `ndUp` / `ndDown` | ND-Filter | `satUp` / `satDown` | Saturation |

Die sechs alten Ids bleiben, wie sie waren: es liegen Companion-Seiten da
draußen, auf denen sie auf Tasten liegen.
