# Eigenes PTZ-Pult — Stueckliste

Ein Bedienpult fuer die LZ Camera Bridge: Joystick in der Art des DigitalBird
PTZplus, aber mit einem eingebauten Stream Deck und ohne die Schwaechen, die
sich an der DigitalBird-Firmware ablesen lassen.

**Was dieses Dokument ist:** eine Kaufliste mit Begruendung je Posten und die
Verdrahtung dazu. **Was es nicht ist:** ein geprueftes Design. Nichts davon
stand bisher auf einem Tisch. Preise sind Richtwerte (netto, Stand 2026-09) und
gehoeren vor der Bestellung nachgesehen; bei den Joysticks sind es
Familien-Namen und keine Bestellnummern.

## 1. Der Befund am Vorbild

Gelesen wurde `DB-PTZplusESP32-v7.00.ino` und `DB3_VISCA_Decoder_v6_02.ino` aus
`digitalbird01/DigitalBird-Camera-Slider`. Woertlich aus dem Quelltext:

```c
const int panS_PIN = 34;    // Pan Joy      -> analogRead(), ESP32-ADC, 12 bit
const int tiltS_PIN = 32;   // Tilt Joy
const int slidS_PIN = 35;   // Slider joy
const int focusS_PIN = 39;  // Focus joy
const int zoomS_PIN = 36;   // Zoom joy
const int masterA_PIN = 33; // Master pot
```

Daraus folgen vier Schwaechen, und die vier sind die ganze Begruendung fuer
diese Liste:

1. **Fuenf getrennte Analogachsen am ESP32-ADC.** Der ESP32-ADC ist
   nichtlinear und rauscht; die Firmware mittelt deshalb in Schleifen
   (`temp_pan += analogRead(panS_PIN)`). Gemittelt wird Rauschen, nicht
   behoben. Bei einer langsamen Live-Fahrt ist genau das der Ruckler.
2. **Zoom und Fokus liegen auf eigenen Joysticks**, nicht in der Hand, die
   schwenkt. Jedes echte PTZ-Pult (AW-RP150, PT-JOY) legt Zoom auf den
   Drehgriff derselben Achse.
3. **Funk als Normalfall** (ESP-NOW/WLAN zwischen Pult und Kopf). Im
   Hallen-WLAN ist das der Ausfall, den keiner nachstellen kann.
4. **Keine Rueckmeldung am Bedienelement.** Das Nextion-Display zeigt, was das
   Pult glaubt; welche Kamera on air ist, weiss es nicht.

Dazu kommt, was das Pult grundsaetzlich nicht kann: es spricht das
DigitalBird-eigene Funkprotokoll und damit **nur DigitalBird-Koepfe**. Die
Bridge spricht 15 Wege (Sony CCU, Canon CCAPI, Lumix, Blackmagic, Z CAM,
Panasonic AW, VISCA, JVC, BirdDog, DJI …). Ein Pult, das an der Bridge haengt,
faehrt sie alle.

## 2. Architektur

Die Bridge hat den Eingang dafuer bereits: `packages/bridge/src/input/
HidControlSurface.ts` nimmt ein beliebiges USB-HID-Pult und bildet
Report-Bytes datengetrieben auf RCP-Befehle ab. Das Pult muss also **kein**
eigenes Protokoll erfinden — es muss ein HID-Geraet sein.

Das Stream Deck ist ein zweites USB-Geraet und wird nicht von der Bridge
getrieben, sondern von **Bitfocus Companion**, fuer das in diesem Repo bereits
ein Modul liegt (`packages/companion-module-lz-camera-bridge`). Damit sind
Tastenbeschriftung, Tally-Rueckmeldung und Preset-Layout Konfiguration statt
Firmware.

```
   [Hall-Joystick 3 Achsen]---[ADS1115 16 bit]--I2C--+
   [Encoder Fokus/Zoom]------------------------------+--[Pico 2]==USB-HID==+
   [Taster, Fader]-----------------------------------+                     |
                                                                           v
   [Stream Deck XL]======================================USB=========>[Pi 5]
   [7" DSI-Touch] <--- Web-RCP http://localhost:3700 -------------------|
                                                                        |
                                            Gigabit-Ethernet (Kabel) ---+
                                                                        v
                                   DB3-Kopf (VISCA/UDP 1259), ATEM, andere Kameras
```

**Variante A (empfohlen): Rechner im Pult.** Pi 5 im Gehaeuse, laeuft Bridge +
Companion. Ein Netzwerkkabel raus, sonst nichts. Das Pult ist ein Geraet.

**Variante B: Pult am Laptop.** Nur Pico + Stream Deck im Gehaeuse, beide per
USB an den Rechner, auf dem die Desktop-App ohnehin laeuft. Spart rund 200 EUR
und den halben Aufbau — kostet aber, dass ohne diesen Laptop nichts geht.

## 3. Stueckliste Variante A

### 3.1 Rechner und Bedienflaeche

| # | Teil | Menge | ca. EUR | Warum genau das |
|---|---|---|---|---|
| 1 | Raspberry Pi 5, 4 GB | 1 | 65 | Bridge (Node) und Companion laufen beide arm64. 4 GB reichen; 8 GB nur, wenn zusaetzlich OBS o. ae. drauf soll. |
| 2 | Aktivkuehler fuer Pi 5 | 1 | 6 | Pflicht, nicht optional — ein gedrosselter Pi bedient sich zaeh. |
| 3 | NVMe-HAT + 256 GB NVMe | 1 | 45 | SD-Karten sterben an Dauerbetrieb. Wer spart: A2-SD-Karte 32 GB fuer 10 EUR und alle drei Monate ein Image. |
| 4 | Netzteil USB-C PD 27 W (offiziell) | 1 | 14 | Nur mit diesem Netzteil gibt der Pi 5 die volle USB-Stromgrenze frei; das Stream Deck XL haengt daran. |
| 5 | Elgato Stream Deck XL (32 Tasten) | 1 | 250 | 4 Kameras × 8 Presets auf einer Ebene, ohne Blaettern. Companion treibt es direkt ueber USB — die Elgato-Software wird nicht gebraucht und laeuft auf dem Pi ohnehin nicht. |
| 6 | Raspberry Pi Touch Display 2 (7", DSI) | 1 | 70 | Zeigt das Web-RCP der Bridge (`:3700`) im Kiosk. Damit ist die Pult-Oberflaeche dieselbe wie auf dem Desktop — kein zweites UI wie DigitalBirds Nextion-`.tft`. |

Statt Pos. 5 denkbar: **Stream Deck + (Plus)** mit 8 Tasten und 4 Drehgebern
(~230 EUR). Die Drehgeber koennen Fokus/Iris/Weissabgleich uebernehmen und
sparen die Encoder aus 3.3 — dafuer fehlen die Preset-Tasten. Beides zusammen
ist die Vollausbau-Variante und kostet ~480 EUR.

### 3.2 Joystick — die eine Entscheidung, die das Pult ausmacht

Drei Klassen. Der Unterschied ist nicht die Genauigkeit auf dem Papier, sondern
ob das Ding nach zwei Jahren Tourbetrieb in der Mitte noch Ruhe gibt.

| Klasse | Typ | ca. EUR | Beurteilung |
|---|---|---|---|
| **Sparsam** | 3-Achsen-PTZ-Joystick-Modul aus dem Kamera-Zubehoer (Poti, Zoom per Drehgriff) | 40–90 | Genau die Bauart, die DigitalBird verwendet, aber wenigstens alle drei Achsen in einer Hand. Potis verschleissen, die Mittelstellung wandert. |
| **Empfohlen** | Hall-Effekt-Joystick, 3 Achsen mit Drehgriff — APEM HF-Serie oder CH Products HFX | 250–450 | Kontaktlos, kein Verschleiss, ratiometrisch 0,5–4,5 V. Das ist die Bauart, die in Industriepulten 10 Jahre haelt. **Bestellnummer vor dem Kauf pruefen**, die Serien haben viele Varianten (Achszahl, Federrate, Griffform). |
| **Kompromiss** | APEM Ruffy RF (2 Achsen, Hall, Fingertip) + separater Encoder fuer Zoom | 60–90 | Kontaktlos zum kleinen Preis, aber Zoom wandert wieder aus der Schwenkhand. |

Empfehlung: **Hall, 3 Achsen, Drehgriff.** Der Preisunterschied ist einmalig,
das Zittern eines Potis begleitet einen bei jeder Probe.

### 3.2.1 Der Gamepad-Weg — und warum er trotzdem der erste Schritt ist

Ein Spiele-Controller ist ein USB-HID-Geraet mit zwei Analogsticks und zwei
Analogtriggern. Er faellt damit in denselben `HidControlSurface`-Adapter wie
alles andere in diesem Dokument. Der Unterschied zwischen den beiden Lagern
ist aber nicht kosmetisch:

| | PlayStation (DualSense / DualShock 4) | Xbox (Series / One) |
|---|---|---|
| Am USB | **Standard-HID.** Meldet Achsen und Trigger in einem festen Report, `node-hid` liest ihn direkt. | **Kein Standard-HID.** Microsoft fuehrt das GIP/XInput-Protokoll; unter Linux nimmt der `xpad`-Treiber das Geraet weg und gibt es als evdev aus, nicht als brauchbares hidraw. |
| Ueber Bluetooth | HID, anderer Report als am Kabel | HID — hier geht es, weil die BT-Firmware einen Gamepad-Descriptor mitbringt |
| Urteil | **nimm den** | nur ueber Bluetooth oder ueber einen zweiten Adapter auf evdev |

Praktisch heisst das: **ein DualSense am Kabel ist der kuerzeste Weg zu einem
fahrenden Kopf.** Kosten 0 EUR, wenn einer da ist, sonst rund 70.

Was ein Gamepad kann, und das ist mehr, als man erwartet:

- Linker Stick Pan/Tilt, die **analogen** Trigger L2/R2 auf Zoom ein und aus —
  das ist naeher an einem PTZ-Pult als DigitalBirds zweiter Joystick.
- Die Achsen liefern 8 bit, also 256 Stufen. **Fuer einen VISCA-Kopf ist das
  nicht die Grenze:** das Protokoll kennt fuer Pan nur 24 Geschwindigkeiten
  (`0x01`…`0x18`), fuer Tilt 20. Das Argument „16 bit" aus 3.3 gilt fuer die
  Paint-Werte und fuer direkt angesteuerte Schrittmotoren, nicht fuer
  VISCA-Fahrbefehle. Wer hier etwas anderes behauptet, verkauft Aufloesung,
  die auf dem Draht gar nicht ankommt.
- Rund ein Dutzend Tasten fuer Presets, bis das Stream Deck da ist.

Warum es trotzdem nicht das Endergebnis ist, und diese drei Gruende sind
koerperlich und nicht elektrisch:

1. **Der Weg ist zu kurz.** Ein Gamepad-Stick hat rund 8 mm Auslenkung, ein
   PTZ-Joystick gut das Dreifache. Die langsame Fahrt lebt vom Weg, nicht von
   der Zahl der Stufen.
2. **Die Feder ist falsch.** Ein Gamepad zentriert schnell und hart, weil es
   fuer Zielen gebaut ist. Einen Schwenk ueber acht Sekunden haelt man damit
   nicht ruhig.
3. **Stick-Drift.** Die Sticks sind Potis und das bekannte Verschleissteil der
   Bauart. Es gibt Hall-Ersatzmodule (GuliKit u. ae., ~25 EUR das Paar), die
   genau das beheben — ein billiger Test, ob Hall den Unterschied macht, den
   dieses Dokument behauptet.

**Empfohlene Reihenfolge:** Gamepad zuerst. Die drei Luecken aus Abschnitt 6
muessen ohnehin geschlossen werden, und sie lassen sich an einem Controller
schliessen, der schon in der Schublade liegt. Erst wenn Pan/Tilt/Zoom damit
sauber fahren, ist die Frage nach dem 400-EUR-Joystick ueberhaupt zu
beantworten — und dann beantwortet sie die Hand und nicht das Datenblatt.

Zwei Dinge dabei im Blick behalten:

- **Die Byte-Offsets im Report unterscheiden sich je Modell und je
  Anschlussart** (DualShock 4 und DualSense liegen anders, USB und Bluetooth
  ebenfalls). Sie gehoeren einmal mit `hidraw` ausgemessen und dann in die
  `HidBinding`-Tabelle geschrieben — nicht aus einem Forenbeitrag abgeschrieben.
- **Companion sieht ein Gamepad nicht.** Es treibt Stream Decks und
  Satellite-Flaechen, kein HID-Gamepad. Der Controller haengt also am Bridge-
  Eingang, das Stream Deck an Companion. Zwei Wege, mit Absicht.

### 3.3 Achsen-Erfassung und Bedienelemente

| # | Teil | Menge | ca. EUR | Warum |
|---|---|---|---|---|
| 7 | Raspberry Pi Pico 2 (RP2350) | 1 | 8 | Meldet sich als USB-HID-Geraet. TinyUSB ist ausgereift; ein ESP32 haette hier nichts besser gemacht. |
| 8 | ADS1115 Breakout (16 bit, 4 Kanal, I2C) | 2 | 2 × 5 | **Der Kern des Ganzen.** 16 bit statt der 12 des ESP32, echte Referenz, PGA. Acht Kanaele: Pan, Tilt, Zoom-Twist, Master-Speed, Iris-Fader, drei frei. |
| 9 | Pegelwandler I2C (TXS0102 o. ae.) | 1 | 3 | Der Hall-Joystick will 5 V, der Pico 3,3 V. ADS1115 laeuft an 5 V, I2C wird gewandelt. Alternative ohne Wandler: ADS an 3,3 V und je Achse ein 2:1-Teiler — kostet die halbe Spanne, bei 16 bit verkraftbar. |
| 10 | Drehgeber Fokus, optisch/industriell 600 P/U, 5 V | 1 | 20–35 | Fokus braucht Aufloesung und Gleichlauf, kein Rasten. DigitalBird nimmt dafuer ein Poti; das ist der Grund, warum man dort nicht sauber nachziehen kann. |
| 11 | Drehgeber Bourns PEC11R, 24 Rasten, mit Taster | 2 | 2 × 3 | Kamera-Wahl und Menue. Rasten sind hier richtig: man zaehlt Klicks, ohne hinzusehen. |
| 12 | Drehknoepfe, 6 mm, Alu | 3 | 3 × 6 | Gewicht am Fokusknopf ist kein Luxus, es ist die Feinfuehligkeit. |
| 13 | Fader ALPS RSA0N11M9, 100 mm, 10k | 1 | 15 | Iris/Master. Optional motorisiert (~30 EUR), dann folgt er dem Rueckkanal der Kamera — sinnvoll erst, wenn der jeweilige Weg wirklich zurueckliest. |
| 14 | Taster, beleuchtet, 16 mm, kurzhubig | 6 | 6 × 4 | Record, Home, Preset speichern, Not-Halt. Was staendig gebraucht wird, gehoert nicht auf eine Bildschirmtaste. |
| 15 | WS2812B-Tally-LEDs | 4 | 5 | Eine je Kamera, am Pico. Rueckmeldung am Pult statt nur im Bild. |

### 3.4 Gehaeuse, Netz, Kleinteile

| # | Teil | Menge | ca. EUR | Warum |
|---|---|---|---|---|
| 16 | Pultgehaeuse Alu, geneigt, ca. 300 × 200 × 80 mm (Hammond 1456-Serie o. ae.) | 1 | 60–120 | Fertig gekauft spart die Passung. Wer druckt: Unterteil FDM, Frontplatte 3 mm Alu gefraest — eine gedruckte Frontplatte biegt sich unter dem Joystick. |
| 17 | Frontplatte gefraest/graviert (Schaeffer o. ae.) | 1 | 80–150 | Der Ausschnitt fuer das Stream Deck muss sitzen. **Die Aussenmasse am eigenen Geraet nachmessen**, nicht dem Datenblatt glauben. |
| 18 | USB-Einbaubuchsen + kurze Kabel (A auf C, gewinkelt) | 3 | 15 | Stream Deck und Pico werden intern verkabelt; eine Buchse nach aussen fuer Service. |
| 19 | RJ45-Einbaukupplung Cat6 + Patchkabel intern | 1 | 12 | **Kabel, kein WLAN.** Das ist der dritte Befund aus Abschnitt 1. |
| 20 | Kleinteile: Kabel, Schrumpfschlauch, Abstandsbolzen, Schrauben | — | 30 | — |
| 21 | Optional: PoE-HAT fuer Pi 5 | 1 | 25 | Ein Kabel statt zwei. Mechanik mit Aktivkuehler und NVMe-HAT vorher pruefen — die drei streiten sich um denselben Platz. |

### 3.5 Summe

| Ausbau | ca. EUR |
|---|---|
| Erprobung (Gamepad am vorhandenen Rechner, siehe 3.2.1) | 0–70 |
| Sparsam (Poti-Joystick, SD statt NVMe, gedrucktes Gehaeuse, Stream Deck MK.2) | 550–650 |
| Empfohlen (Hall-Joystick 3 Achsen, NVMe, Alu-Pult, Stream Deck XL) | 1.050–1.300 |
| Vollausbau (zusaetzlich Stream Deck +, motorisierter Fader, PoE) | 1.400–1.700 |

Zum Vergleich: ein Panasonic AW-RP60 liegt bei rund 3.000 EUR und spricht nur
Panasonic; ein PTZOptics PT-JOY bei rund 500 EUR und spricht nur VISCA.

## 4. Variante B (Pult am Laptop)

Entfallen: Pos. 1–4, 6, 21. Bleibt: Stream Deck, Pico, ADS1115, Joystick,
Bedienelemente, Gehaeuse. **Summe ca. 700–900 EUR** im empfohlenen Ausbau.
Companion und Bridge laufen dann auf dem Rechner, der ohnehin dasteht.

Der Preis dafuer ist nicht das Geld: ein Pult, das ohne einen bestimmten Laptop
nichts tut, ist im Aufbau das erste, was fehlt.

## 5. Verdrahtung in Stichworten

- **Joystick → ADS1115 #1**, Kanaele A0–A2 (Pan, Tilt, Zoom-Twist), A3 =
  Master-Speed-Poti. Versorgung 5 V, Signal ratiometrisch.
- **ADS1115 #2**: A0 = Iris-Fader, A1–A3 frei (zweiter Fader, Pedal, T-Bar).
- **Beide ADS1115 → I2C des Pico** (Adressen 0x48/0x49 ueber ADDR-Pin), ueber
  den Pegelwandler.
- **Encoder + Taster → GPIO des Pico**, Fokus-Encoder auf die PIO-Einheit
  (RP2350 zaehlt Quadratur damit ohne CPU-Last).
- **Pico → Pi per USB**, meldet einen HID-Report fester Form:
  Byte 0 Report-ID, Bytes 1–16 acht Achsen zu je 2 Byte little-endian,
  Bytes 17–18 Tasten-Bitfeld. Diese Form ist mit Absicht so gewaehlt: sie
  passt 1:1 auf `HidBinding { offset, bytes: 2 }` in der Bridge.
- **Stream Deck → Pi per USB**, Companion greift direkt darauf zu.
- **Display → DSI**, Chromium im Kiosk auf `http://localhost:3700`.

## 6. Was in der Software noch fehlt

Ehrlich aufgeschrieben, damit niemand bestellt und dann feststellt, dass die
Haelfte noch zu bauen ist. Gelesen in `HidControlSurface.ts`:

1. **Achsen sind heute vorzeichenlos.** `onReport` skaliert jeden Rohwert auf
   0–255 und schickt einen einzelnen Parameter. Der `ptz`-Befehl des
   `ViscaClient` will aber `pan` und `tilt` zusammen und mit Vorzeichen
   (−100…100). Es braucht eine Bindungsart „bipolare Achse" und eine, die zwei
   Achsen zu einem Befehl buendelt.
2. **Kein Totband.** Ein Hall-Joystick in Ruhe wackelt in den letzten Bits;
   `last` vergleicht exakt und wuerde bei jedem Bit einen Fahrbefehl senden.
   Mittelwert-Fenster und Totband gehoeren in den Adapter, nicht in die
   Firmware — sonst sind sie je Pult neu einzustellen.
3. **`this.last` ist auf `offset` verschluesselt.** Zwei Bindungen auf
   denselben Byte-Offset (ein Tasten-Bitfeld mit acht Tasten) loeschen sich
   gegenseitig aus. Fuer Tasten braucht es eine Bit-Maske im `HidBinding`.
4. **Fuer den DB3-Kopf gilt die Sperre aus Anhang A:** `setIris` und
   `setMasterGain` sind 9-Byte-VISCA-Pakete, die der DigitalBird-Decoder als
   Pan/Tilt-Richtung missversteht und den Kopf losfahren laesst. Ein
   Iris-Fader am Pult darf diesen Kopf nicht erreichen.

Punkt 1–3 sind ueberschaubar und liegen alle in einer Datei. Punkt 4 ist eine
Eigenschaft der Gegenstelle und gehoert in den Geraeteweg, nicht ins Pult.

## 7. Vor dem Bestellen zu klaeren

- Genaue Bestellnummer des Hall-Joysticks: Achszahl, Federrate, ob der
  Drehgriff rastet, Steckerbelegung.
- Aussenmasse und Einbautiefe des Stream Deck XL am eigenen Geraet.
- Ob Aktivkuehler, NVMe-HAT und PoE-HAT zusammen auf den Pi 5 passen.
- Ob Companion und Bridge auf einem Pi 5 nebeneinander genug Luft haben — vor
  dem Gehaeusebau einmal auf einem nackten Pi messen.
- Die Byte-Offsets des Gamepads aus 3.2.1, falls der Weg ueber die Erprobung
  geht: einmal mit `hidraw` ausmessen, je Modell und je Anschlussart.

## Anhang A: Was der DB3-Kopf von unserem `ViscaClient` versteht

Gelesen wurde `DB3/DB3_VISCA_Decoder_v6_02.ino` gegen
`packages/bridge/src/cameras/ViscaClient.ts`. Der Decoder laeuft auf einem
WT32-ETH01 (PoE), lauscht **UDP 1259 auf rohem VISCA ohne Sony-Kopf** und gibt
per UART 115200 an den Kopf weiter. Das ist genau der Vorgabe-Zweig des
`ViscaClient` (`port = 1259`, Sony-Kopf erst ab 52381).

| Bridge sendet | DB3 macht daraus | Urteil |
|---|---|---|
| `ptz` → `81 01 06 01 VV WW 0p 0q FF` | Paketgroesse 9 → Codes 11/12/13/21/22/23/31/32/33, Geschwindigkeit aus Byte 4/5 | passt, Richtungscodes decken sich |
| Pan-Speed max `0x18`, Tilt `0x14` | Kopf rechnet mit 1…24 (Sonderfall > 20) | passt |
| `setZoom` `81 01 04 07 2p/3p FF` | 732…739 Zoom ein, 748…756 Zoom aus, 700 Stopp | passt |
| `setFocus` `81 01 04 08 2p/3p FF` | 832…839 / 848…855, 800 Stopp | **Richtung pruefen** — der Decoder beschriftet `2p` als *Near*, VISCA sagt *Far* |
| `storePreset` / `recallPreset` `04 3F 01/02 pp` | 41 Save Pose, 42 Move to Pose, Nummern 1…16 | passt; 15 und 16 loesen A-B- bzw. Sequencer-Fahrt aus |
| `setIris`, `setMasterGain` (9 Byte) | Decoder liest bei Groesse 9 die Bytes 6/7 als Pan/Tilt-Richtung | **gefaehrlich** — Blendenwert `0x11` wird zu „Up Left", der Kopf faehrt los |
| `setCameraPower` `04 00 02/03` | Fall 2/3 = Record Start/Stopp | anders als erwartet, aber brauchbar |
| `autoFocus`, `autoWhiteBalance` | kein Fall trifft | wird verworfen |

Weiteres: die IP des Decoders steht statisch im Sketch (192.168.x oder 10.x,
kein DHCP), pro Kopf ein Decoder-Board, und alle Teile des DigitalBird-Systems
muessen dieselbe Hauptversion tragen (heute 7.x). Der Decoder beantwortet
Pan/Tilt- und Zoom-Abfragen — unser `ViscaClient` fragt nichts ab.

Lizenz des DigitalBird-Repos: BSD-3-Clause (Colin Henderson).
