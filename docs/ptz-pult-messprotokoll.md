# Messprotokoll: was am Geraet noch zu pruefen ist

Zwei Dinge in `docs/ptz-pult-hardware.md` und in `HidControlSurface.ts` stehen
auf Papier und nicht auf einer Messung. Dieses Blatt sagt, wie man sie misst —
damit es jemand tun kann, ohne die Sitzung zu kennen, in der sie entstanden
sind.

**Beide sind mit Absicht offen geblieben.** Eine Tabelle, die man pruefen kann,
ist mehr wert als eine, die man glauben muss; der Preis dafuer ist dieses
Blatt.

## 1. Die Byte-Offsets des Gamepads

### Warum

`DUALSENSE_BINDINGS` und `DUALSHOCK4_BINDINGS` in
`packages/bridge/src/input/HidControlSurface.ts` tragen das **dokumentierte**
USB-Report-Format, nicht ein gemessenes. Drei Dinge koennen es verschieben:

- Ueber Bluetooth liegt derselbe Controller anders als am Kabel.
- Ob `node-hid` die Report-ID als Byte 0 mitliefert, haengt an der Plattform.
  Fehlt sie, rutscht **alles um eins**.
- DualSense und DualShock 4 unterscheiden sich untereinander (deshalb zwei
  Tabellen und keine mit Sonderfaellen).

Eine Achse an der falschen Stelle ist nicht bloss wirkungslos: sie kann auf
einem Nachbar-Byte liegen und etwas anderes fahren.

### Vorbereitung

```bash
npm install node-hid --workspace=packages/bridge   # optionales natives Modul
npm run bridge                                     # Bruecke auf ws://localhost:9700
```

Unter Linux braucht der Zugriff auf `hidraw` je nach Distribution eine
udev-Regel oder Rechte; meldet die Bruecke „HID-Zugriff fehlgeschlagen", liegt
es daran und nicht am Controller.

### Messen

Die Oberflaeche hat keinen Debug-Schalter; der Weg geht ueber die WebSocket.
Erst das Geraet suchen, dann mit `debug: true` aktivieren:

```jsonc
// 1. senden:
{ "type": "listHidDevices" }
// Antwort: { "type": "hidDevices", "devices": [ { "vendorId": 1356, "productId": 3302, "path": "..." } ] }

// 2. senden (vendorId/productId/path aus der Antwort):
{ "type": "enableControlSurface",
  "surface": { "vendorId": 1356, "productId": 3302, "path": "...", "bindings": [], "debug": true } }
```

Ab jetzt schickt die Bruecke jeden Report als
`{ "type": "hidReport", "hex": "01800080800000..." }`.

**`bindings: []` ist hier Absicht:** dann greift `standardBindungen()`, und die
Meldung `controlSurface.info.gamepad` sagt, ob der Controller als bekanntes
Gamepad erkannt wurde. Steht dort `false`, gilt die **Paint**-Belegung — siehe
die Warnung unten.

Jetzt je eine Bewegung isoliert ausfuehren und die Hex-Zeilen vergleichen:

| Bewegung | erwartete Stelle (DualSense/USB) |
|---|---|
| linker Stick ganz links / rechts | Byte 1 faellt auf `00` / steigt auf `ff` |
| linker Stick ganz hoch / runter | Byte 2 |
| rechter Stick senkrecht | Byte 4 |
| L2 ganz durchgedrueckt | Byte 5 |
| R2 ganz durchgedrueckt | Byte 6 |
| Quadrat, Kreuz, Kreis, Dreieck | Byte 8, Bits 4-7 |
| L1 | Byte 9, Bit 0 |

Je zwei Hex-Zeichen sind ein Byte; Byte 0 sind also die ersten zwei Zeichen.
Ein Stick in Ruhe steht auf `80` (128).

### Eintragen

Weicht etwas ab, die `offset`-Werte in der betroffenen Tabelle korrigieren —
**nicht** eine dritte Tabelle anlegen. Ist nur die Report-ID nicht dabei,
sind alle Offsets um eins zu verringern.

Danach:

```bash
npm test --workspace=packages/bridge   # gamepadBindungen.test.ts baut die Reports nach
```

Die Testdatei setzt dieselben Offsets; sie muss mitgezogen werden, sonst misst
sie die alte Annahme.

### Die Falle, die dahinter liegt

`standardBindungen()` gibt einem **unbekannten** Geraet die Paint-Belegung, und
die legt Achse 1 und 2 auf `setIris` und `setMasterGain`. Am
DigitalBird-DB3-Kopf sind das 9-Byte-VISCA-Pakete, deren Bytes 6/7 der Decoder
als Pan/Tilt-Richtung liest — der Kopf faehrt dann los. Wer ein Gamepad
anschliesst, dessen Vendor/Product-ID nicht in der Liste steht, traegt sie
zuerst dort ein, statt es „einfach mal" zu aktivieren. Die IDs stehen in der
Antwort auf `listHidDevices`.

## 2. Die Fokus-Richtung am DB3-Kopf

### Warum

Der DigitalBird-Decoder (`DB3/DB3_VISCA_Decoder_v6_02.ino` im Repo
`digitalbird01/DigitalBird-Camera-Slider`) beschriftet die VISCA-Codes
umgekehrt zum Standard:

| VISCA-Befehl | Standard (Sony) | DB3-Decoder |
|---|---|---|
| `81 01 04 08 2p FF` | Focus **Far** | Codes 832-839, beschriftet „Focus **Near**" |
| `81 01 04 08 3p FF` | Focus **Near** | Codes 848-855, beschriftet „Focus **Far**" |

Ob das nur eine falsche Beschriftung im Quelltext ist oder die Fahrt wirklich
andersherum geht, entscheidet der Kopf und nicht das Lesen.

### Messen

Kopf am Netz, Decoder erreichbar (statische IP im Sketch, UDP 1259, rohes
VISCA ohne Sony-Kopf). Objektiv auf eine Mitte stellen, dann:

```bash
# Focus 2p, Geschwindigkeit 2 -- nach Standard waere das FAR
printf '\x81\x01\x04\x08\x22\xff' | nc -u -w1 <decoder-ip> 1259
# Stopp
printf '\x81\x01\x04\x08\x00\xff' | nc -u -w1 <decoder-ip> 1259
```

Beobachten, ob der Fokus auf **unendlich** (far) oder auf **nah** laeuft.

### Eintragen

- Faehrt er nach **far**: Standard gilt, nichts zu tun. Den Vermerk in
  `docs/ptz-pult-hardware.md`, Anhang A, durch das Messergebnis ersetzen.
- Faehrt er nach **nah**: die Richtung ist vertauscht. Dann gehoert der Fix in
  den **Geraeteweg**, nicht ins Pult — also in `ViscaClient.handleRcpCommand`
  unter `setFocus`, und zwar nur fuer diesen Kopf. Eine Umkehr per `gain: -1`
  in der Gamepad-Tabelle waere die falsche Stelle: sie drehte den Fokus auch
  fuer jede andere VISCA-Kamera am selben Pult um.

In beiden Faellen: Datum und Geraet dazuschreiben. Eine Messung ohne beides
ist in einem Jahr wieder eine Annahme.

## 3. Was dieses Blatt NICHT offen laesst

Damit niemand danach sucht: die Punkte in `docs/ptz-pult-hardware.md`
Abschnitt 6.1 — zweiseitige Achsen, Totband, Tasten im Bitfeld, die
Summen-Gruppe fuer die Trigger — sind erledigt und mit Tests belegt
(`packages/bridge/test/gamepadBindungen.test.ts`, 11 Faelle). Offen ist
ausschliesslich, was ein Geraet beantworten muss.
