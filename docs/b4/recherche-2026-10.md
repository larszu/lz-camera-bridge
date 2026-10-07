# Recherche Oktober 2026: Primärquellen zur B4-Objektivsteuerung

Desk-Recherche vom 07./08.10.2026, vor dem ersten Bankbetrieb der Iris-Steuerung
an der Canon J15ax8B4 IRS SX12. **Nichts hier ist gemessen.** Jede Aussage nennt
ihre Quelle und deren Art:

- **P** = Primärquelle (Norm, Hersteller-Handbuch, Hersteller-Spezifikation, Datenblatt, Patent)
- **S** = Sekundärquelle (Reverse Engineering, Forum, Wiki, Händler, Fremdhersteller-Handbuch über fremde Geräte)

Abgeleitete Zahlen (Rechnungen aus zwei Stützpunkten) sind als **abgeleitet**
markiert. Die heruntergeladenen Dokumente liegen unter [`quellen/`](quellen/)
(Liste am Ende). Sie sind urheberrechtlich geschützte Fremddokumente und
gehören **nicht** in das öffentliche Repository – vor einem Commit
`docs/b4/quellen/` ausschließen.

---

## Kurzfazit

**Belegt (neu durch Primärquellen):**

1. **Die 12-Pin-Belegung samt Pegeln ist genormt.** ARIB TR-B37 (2017, englisch,
   frei) Tabelle 4-2 für 2/3-Zoll-Objektive gibt alle zwölf Pins mit Pegeln,
   **Toleranzen und Impedanzen** an. Die Funktionen stimmen mit unserer Tabelle
   überein; Pin 5/7 F2,8 = 6,2 ± 0,1 V, F16 = 3,4 ± 0,1 V; Pin 10/11 2,0/7,0 ± 0,2 V.
   Die Iris-Steuerung über Pin 5 bei Canon bestätigt außerdem ein Canon-Patent.
2. **Pin 5 hat einen Eingangswiderstand von ≥ 100 kΩ, die Kamera treibt ihn mit
   ≤ 1 kΩ Quellwiderstand.** Unser Operationsverstärker plus 1 kΩ in Reihe hält das ein.
3. **Pin 6 liefert 10–17 V** (nicht stabil 12 V), Normalbetrieb 0,5 A, kurzzeitig
   bis 1,5 A. Bestätigt durch Canon (10–17 V), Sony (11–17 V, max. 1,0 A) und
   Panasonic (UNREG, max. 1,5 A).
4. **Die Funktionscodes 0x20 Iris / 0x21 Zoom / 0x22 Fokus sind belegt** – durch
   die Fujinon-Spezifikation „Protocol L10 Ver. 1.40“ selbst, mit Beispielrahmen.
   Damit ist die Prosa-Variante 0x21/0x23/0x22 für L10 **widerlegt**. 0x23 kommt
   auf der 12-Pin-Leitung trotzdem vor, laut Reverse Engineering als
   „absolute Iris“ (URSA).
5. **Der Detect-Pin einer Fujinon-Demand ist geklärt:** analoge Fokus-Demand = +12 V,
   analoge Zoom-Demand = offen, digitale Demand = +5 V (Fujinon-Handbuch).

**Widerlegt oder korrigiert:**

- „Iris zu = 2,5 V“ ist kein fester Wert: Sollwert *zu* = **2,1–2,9 V**,
  Rückmeldung *zu* = **1,5–2,9 V** (ARIB).
- Pin 4 ist **kein Servo-Enable**, sondern „Forced iris servo“ (Tasten-Funktion,
  entspricht der Canon-Taste „Instant Auto-Iris“). Offen gelassen gilt er als AUS.
- **Unser Rücklese-Teiler (10 k + 6,8 k = 16,8 kΩ) belastet Pin 7/10/11 stärker,
  als ARIB zulässt (≥ 20 kΩ).**
- **Der TL072 ist in unserer Verstärkerstufe nicht zulässig:** Sein
  Gleichtaktbereich reicht bei Einfachversorgung nicht bis 1,27 V am +Eingang
  (TI-Datenblatt). Nur der LM358 passt.
- **Der Detect-Teiler in `demand.md` verträgt die +12 V nicht**, die eine analoge
  Fokus-Demand auf Detect legt (4,9 V am ADS1115, zulässig sind 3,6 V).
- 78400 Bd: Der Fork, aus dem die Angabe stammt, hat sie inzwischen selbst auf
  **76800 Bd** (Sony) korrigiert; 78400 sei nur das ungenaue URSA-Timing (S).

**Offen:**

- Ob die alte, analoge Canon J15ax8B4 die ARIB-Pegel einhält, belegt kein
  Canon-Dokument. ARIB-Norm, Canon-Patent und die Austauschbarkeit an Kameras
  aller Hersteller sprechen stark dafür.
- Was Pin 8 im Objektiv bewirkt. Wahrscheinlich nur die Wahl zwischen
  „Auto-Iris-Gain“ und „Remote-Iris-Gain“ (die Canon getrennt einstellbar macht),
  nicht ob Pin 5 befolgt wird. Panasonic nennt Pin 8 sogar „IRIS-G-MAX“.
- Canon-Belegung der 8-Pin-Zoom-Remote und der 20-Pin-Demand-Buchse: keine
  Primärquelle gefunden.
- Ikegami-Protokolle: nicht recherchiert.

**Sicherheit beim ersten Anschluss:** siehe [Empfehlungen](#empfehlungen-für-den-bankbetrieb-der-iris-steuerung).
Die wichtigsten Punkte: Irisring nur in Stellung **M** von Hand drehen, keinen
TL072 verwenden, Ausgang der Verstärkerstufe auf ≤ 7,5 V begrenzen, Pin 4 offen
lassen.

---

## 1. Canon-B4-Objektive und die 12-Pin-Buchse

### 1.1 ARIB TR-B37 – die Norm mit Pegeln und Impedanzen (P)

ARIB TR-B37 v1.1-E2 „Interconnection for UHDTV Camera and Lens“ (2017) ist auf
der ARIB-Seite für Mitglieder und Nichtmitglieder frei abrufbar. Sie verweist
auf BTA S-1005B (1997), den kostenpflichtigen, nur japanischen Ursprungsstandard.
Kapitel 4 gilt für 2/3-Zoll-Kameras (B4-Bajonett, Auflagemaß 48,00 mm). Die
Tabelle 2-2 (Super-35-8K) ist inhaltlich gleich und weicht nur in einer Impedanz
ab (siehe Pin 8).

Steckverbinder: Objektivseite HR10-10P-12P, Kameraseite HR10-10R-12S (Hirose).

| Pin | Signal (ARIB) | Richtung | Pegel und Impedanz laut Tabelle 4-2 |
|---|---|---|---|
| 1 | Return video SW-1 | L→K | Taster. AUS: offen, Ausgangsimpedanz ≥ 10 MΩ. EIN: ≤ 0,5 V, ≤ 1,5 kΩ (Tab. 2-2; in Tab. 4-2 steht „1,5 Ω“, offensichtlich ein Druckfehler). Eingangsimpedanz Kamera ≥ 10 kΩ |
| 2 | VTR control | L→K | wie Pin 1 |
| 3 | GND | – | Rückleiter des Versorgungsstroms |
| 4 | **Forced iris servo** | K→L | AUS: ≤ 0,5 V bei ≤ 1,5 kΩ **oder ≥ 100 kΩ (offen)**. EIN: 5,0 ± 0,5 V, ≤ 10 kΩ. Eingangsimpedanz Objektiv ≥ 100 kΩ |
| 5 | **Iris control** | K→L | F2,8: 6,2 ± 0,1 V · F16: 3,4 ± 0,1 V · **Zu: 2,1–2,9 V** · Eingangsimpedanz Objektiv **≥ 100 kΩ** · Ausgangsimpedanz Kamera **≤ 1 kΩ** |
| 6 | + Power | K→L | DC +12 V, **Betriebsbereich +10 bis +17 V**, Normalbetrieb **0,5 A**, beim Antrieb kurzzeitig **bis 1,5 A** |
| 7 | **Iris position** | L→K | F2,8: 6,2 ± 0,1 V · F16: 3,4 ± 0,1 V · **Zu: 1,5–2,9 V** · Eingangsimpedanz Kamera **≥ 20 kΩ** · Ausgangsimpedanz Objektiv ≤ 1 kΩ |
| 8 | **Iris mode control** | K→L | Auto: ≤ 0,5 V bei ≤ 1,5 kΩ **oder ≥ 100 kΩ (offen)**. Remote: 5,0 ± 0,5 V, Ausgangsimpedanz ≤ 10 kΩ (Tab. 4-2) bzw. **≤ 1,0 kΩ** (Tab. 2-2). Eingangsimpedanz ≥ 100 kΩ |
| 9 | Extender response | L→K | AUS (OUT): offen, ≥ 10 MΩ · EIN (IN): ≤ 0,5 V, ≤ 1,5 kΩ · Eingangsimpedanz Kamera ≥ 10 kΩ |
| 10 | Zoom position | L→K | Weit: 2,0 ± 0,2 V · Tele: 7,0 ± 0,2 V · ≥ 20 kΩ / ≤ 1 kΩ |
| 11 | Digital commands / focus position | L→K | Digitale Befehlsleitung Objektiv→Kamera; **wenn nicht digital genutzt**, darf hier die Fokusposition liegen: Nah 2,0 ± 0,2 V, Unendlich 7,0 ± 0,2 V, ≥ 20 kΩ / ≤ 1 kΩ |
| 12 | Digital commands | K→L | Digitale Befehlsleitung Kamera→Objektiv |
| Gehäuse | GND | – | – |

Daraus folgt:

- **Pin 4 und Pin 8 dürfen offen bleiben**, das gilt dann als AUS bzw. Auto.
- „Zu“ ist ein **Band**: 2,1–2,9 V auf Pin 5 schließt die Blende, die Rückmeldung
  kann dann irgendwo zwischen 1,5 und 2,9 V liegen.
- Die Norm setzt **≥ 20 kΩ Last** auf den Positionsausgängen voraus.
- Eine Obergrenze für Pin 5 nennt die Norm nicht.

**Abgeleitet, nicht belegt:** ARIB nennt nur zwei Stützpunkte. Liegt die Kennlinie
linear in Blendenstufen (F2,8→F16 = 5 Stufen), ergibt das 0,56 V pro Stufe. Unsere
J15ax8B4 hat laut Händlerangaben (S) F1,7. Dann läge „ganz offen“ bei etwa
**7,0 V** – oberhalb der 6,6 V, die unsere Verstärkerstufe liefert (≈ F2,2).
Sicherheitsrelevant ist das nicht, nur eine Bereichsgrenze. Nachmessen: Pin 7 bei
ganz offener Blende in Stellung M.

### 1.2 Kamera-Handbücher (P)

| Quelle | Pin 4 | Pin 6 | Pin 8 | Pin 11/12 |
|---|---|---|---|---|
| Panasonic AJ-PX5100G / AJ-CX4000G (HTML-Handbuch, LENS-Buchse HR10A-10R-12SC) | IRIS-AUTO | **UNREG +12 V (max. 1,5 A)** | **IRIS-G-MAX** | FOCUS-POSI / SPARE |
| Panasonic AK-UB300G (IRIS-Buchse) | „Iris manual switching“ | UNREG +12 V | IRIS-G-MAX | LENS-RXD / LENS-TXD |
| Sony PXW-X400 / PXW-Z450 (Spezifikationen) | – | „lens power source (11 V to 17 V DC, 1.0 A maximum rated current)“ | – | – |

**Widerspruch Pin 8:** ARIB, Fujinon, SKAARHOJ und unsere Doku sagen „Iris
Auto/Remote“. Panasonic nennt ihn „IRIS-G-MAX“. Was das bedeutet, ist **offen**.
Für den Bankbetrieb ändert sich nichts: 5 V auf Pin 8 ist der in ARIB definierte
Remote-Pegel.

Laut Panasonic dürfen LENS-, DC-OUT-, VF- und REMOTE-Ausgang zusammen höchstens
2,5 A bzw. 30 W abgeben (je nach Modell).

### 1.3 Canon-eigene Dokumente (P)

**Canon BCTV-Handbuch „Lens“ (CJ/KJ-Serie, aktuell)** –
`portls-omls-d020a_eng.pdf`:

- *„Rated voltage: 12 VDC. Normal operation range: 10 to 17 VDC“*; außerhalb kann
  *„the drive unit … be damaged“*; Verpolung beschädigt das Produkt.
- **Stromaufnahme (Spezifikationstabellen):** R-Typ max. 300 mA, A-Typ max. 500 mA.
  Das gilt für moderne Objektive, ein Wert für die J15ax8B4 ist nicht gefunden.
- **Irisbetrieb:** Schalter auf **„A“** – *„The iris operation is performed
  automatically by the instruction from the camera“*. Auf **„M“** folgt die Blende
  dem Ring.
- **Warnung:** *„The iris operation mode change-over switch must be set to the M
  position before performing manual iris operations. The lens may be damaged if
  manual iris operations are forcibly performed with the knob at the A position.“*
- **Instant Auto-Iris Switch:** *„When the instant auto-iris switch is pressed
  during manual iris operation mode, the iris changes to automatic operation mode
  while the switch is held down.“* Das ist die Tastenfunktion, die ARIB auf Pin 4
  als „Forced iris servo“ führt.
- **Iris-Gain-Trimmer** vorn an der Antriebseinheit: *„set it to the position of
  maximum gain at which no iris hunting occurs.“* Er ist ab Werk auf Mitte
  gestellt. Ob die J15ax8B4 so einen Trimmer hat, ist am Objektiv zu prüfen.

**Canon-Handbuch „Information display“** – `portls-omdp-d021a-eng.pdf`:

- Es gibt getrennt einstellbare Werte für **„Auto Iris Gain“ und „Remote Iris
  Gain“**. Um den Remote-Gain einzustellen: *„Confirm that the drive unit A/M
  switch is set to [Auto] mode. → Set the camera iris mode to [Remote].“*
  Daraus folgt (Deutung, nicht belegt): Pin 8 wählt im Objektiv den Regelkreis-Gain.
  Er entscheidet vermutlich nicht darüber, ob Pin 5 befolgt wird.
- *„Two types of camera–lens interfaces are available: analog control or control
  via serial communication … By default … auto detection of whether serial or
  analog control is used.“* Moderne Canon-Objektive erkennen also selbst, ob die
  Kamera seriell spricht. Für unsere alte IRS-Optik ohne D/E belegt das nichts.

**Canon-Patent EP 1 377 043 A2** (Anmelder Canon, 2004, Prioritätsanmeldung 1999):
*„an iris control signal for controlling a television lens diaphragm from the
television camera uses a fifth pin of a 12-pin connector between television lens
and camera.“* Das ist eine Canon-Primärquelle für **Pin 5 = Iris-Steuerung**.
Spannungen nennt das Patent nicht.

**Nicht gefunden:** ein Handbuch oder Servicehandbuch der J15ax8B4 oder einer
anderen analogen J-Serie-Optik mit Pinbelegung. Manualsbase führt zur YJ19x9B IRS
nur einen vierseitigen Prospekt.

### 1.4 Wie Kameras Pin 5 treiben

- ARIB: Ausgangsimpedanz der Kamera ≤ 1 kΩ, Eingangsimpedanz des Objektivs ≥ 100 kΩ (P).
- SKAARHOJ-Handbuch „B4 Links“ (Fremdhersteller, S): Die Box legt *„an analog value
  between 2.5 and 7.5V“* auf Pin 5. Ein kommerzielles Produkt fährt also bis 7,5 V.
  Das ist kein Beleg für eine Grenze, zeigt aber, dass Objektive das ohne bekannten
  Schaden hinnehmen.
- SKAARHOJ legt eine PID-Regelung über den objektiveigenen Servo (Standard
  Kp 20 / Ki 0,16 / Kd 0 bei 50 Hz; `pid=20,0,0` *„works nicely on old lenses (a bit
  slow)“*). Laut Hersteller schadet das Tuning den Objektiven nicht, *„because they
  are limited internally“* (S). Unsere Firmware nutzt nur einen I-Anteil
  (`config.h`); beides beruht auf derselben Überlegung.

**Gefährlicher Fehler im SKAARHOJ-Handbuch (S):** *„Enable iris adjustment … by
pulling **pin 6** to 5V through a 10 K resistor. To turn off iris adjustment, it
will short **pin 6** to ground.“* Pin 6 ist die +12-V-Versorgung. Gemeint ist
offensichtlich Pin 8. **Nicht abschreiben.** Dasselbe Handbuch rät, den
Objektivschalter auf „Manual“ zu stellen. Das widerspricht Canon (Stellung **A**
für Steuerung durch die Kamera); maßgeblich ist Canon.

### 1.5 B3 ist nicht B4

Ein DVinfo-Beitrag (S, vom Verfasser selbst als ungeprüft bezeichnet) zeigt für ein
Canon J8 B3 (Ikegami-Bajonett) eine völlig andere 12-Pin-Belegung (Iris-Steuerung
auf Pin 6). Unsere Optik trägt „B4“ im Namen. Kabel von B3-Objektiven niemals
quer verwenden.

---

## 2. Digitale Protokolle (Pins 11/12, L10)

### 2.1 Fujinon „Protocol L10 Specifications Ver. 1.40“ (P)

Fujinon-Dokument 416B10443504, zweisprachig. Es ist frei im Netz abgelegt (Wikipedia
verlinkt es, die Upstream-Repos enthalten es). Dazu kommt die Fujinon-Spezifikation
„DIGI POWER Series TV Lens RS-232C External Control Specifications“ vom 28.06.2006 (P).

- **Physik:** RS-232C, **38,4 kbit/s**, 8N1, an einer **eigenen** Buchse – bei
  Handobjektiven Hirose HR10G-10R-10S (10-polig, mit DTR/DSR/RTS/CTS), bei
  Studio-Objektiven DE-9. Das ist unsere **Gruppe A**. L10 beschreibt **nicht**
  die 12-Pin-Leitung.
- **Rahmen und Prüfsumme** wie in `b4-lens-control.md` §4. Beispiele im Original:
  `02 20 80 80 DE` (Iris auf 8080h), Quittung `00 20 E0`, Anfrage `00 30 D0`,
  Antwort `02 30 80 20 2E`.
- **Funktionscodes:** 01 Connect, 11/12 Name, 13 Open-F, 14/15/16 Brennweiten/MOD,
  **20 Iris control, 21 Zoom control, 22 Focus control**, **30/31/32** Positionen,
  42/43/44/46 Switch 2/3/4/6 control, 52/53/54/56 Switch-Positionen, 60/70 Multiple
  data, A1/A5/A7/AF und B1/B5/B6/B7/BF PF-Funktionen (Precision Focus).
- **Bedeutung der Switch-Codes** (bisher in §7 offen):
  - Switch 2 (0x42/0x52): Bit 5 *Forced iris servo*, Bit 4 *IRIS auto/remote*.
    Das sind die digitalen Gegenstücke zu **Pin 4 und Pin 8**.
  - Switch 3 (0x43/0x53): Extender-Faktor (Tabelle ×1,0/×2,0/×2,4/×0,8/×1,2),
    4:3-Modus, Projector.
  - Switch 4 (0x44/0x54): Iris host/camera, Zoom host/local, Focus host/local.
  - Switch 6 (0x46/0x56): Stabilisator.
- **Zeitverhalten:** Antwort ≤ 10 ms, Byteabstand innerhalb eines Blocks < 1 ms.
  **Nach 5 s ohne Host-Befehl schaltet das Objektiv auf lokal/Kamera zurück**
  und hält die Position, bis sich das lokale Signal ändert.
- **Namenslänge:** L10 v1.40 sagt *„up to 30 ASCII characters“*, die Spezifikation
  von 2006 sagt *„up to 80“*. Beide sind Primärquellen und widersprechen sich.

### 2.2 Issue #47: 0x20/0x21/0x22 gegen 0x21/0x23/0x22

| Quelle | Iris | Zoom | Fokus | Art |
|---|---|---|---|---|
| L10 v1.40 (Tabelle **und** Beispielrahmen) | **0x20** | **0x21** | **0x22** | P |
| Fujinon RS-232C 2006 | 0x20 | 0x21 | 0x22 | P |
| yasdfgr-README, Tabelle | 0x20 | 0x21 | 0x22 | S |
| yasdfgr-README, Prosa | 0x21 | 0x23 | 0x22 | S – Platzhalter „0xxx“. Die zugehörigen Mitschnitte liegen im Repo-Ordner `uart protocol analysis/wrong/` |
| s73ampunkca7, „Observed Protocol Specs“ (URSA Broadcast G1 + XA17x7.6 / A13x4.5) | 0x20 (+ **0x23** „Probably Absolute Iris, used by URSA to set iris“) | 0x21 (+ 0x24 absolut, 0x26 Geschwindigkeit) | 0x22 (+ 0x25 absolut, 0x27 Geschwindigkeit) | S |

**Ergebnis:** Für L10 ist die Zuordnung **0x20/0x21/0x22 durch den Hersteller
belegt**. Die Prosa-Variante ist widerlegt. Auf der 12-Pin-Leitung (Gruppe B)
sendet laut Fork zumindest die URSA zusätzlich 0x23–0x27. 0x23 ist dort also
**kein** Zoom-Code, sondern vermutlich ein zweiter Iris-Befehl. Ob die
12-Pin-Leitung 0x20–0x22 genauso benutzt wie L10, steht in keiner Primärquelle.
Die Wikipedia-Formulierung „basiert auf L10“ ist nicht belegt.

Weitere beobachtete Codes laut Fork (S): 0x05 (Init-Ende?), 0x10 Herstellername,
0x17 Seriennummer (ASCII), 0x2D/0x90 Backfokus, 0x33–0x37 (0x36 Austrittspupille),
0x3B/0x3C Zoom-/Fokus-Geschwindigkeit, 0x40/0x41/0x45/0x4F/0x5F, 0x61/0x62/0x71/0x72.
Ein Längenbyte mit oberem Nibble 0xF öffnet einen herstellerspezifischen Befehlssatz.
**0x4F/0x5F** schalten laut Fork zwischen seriell und „parallel“ (= analoge 12-Pin-Signale).

### 2.3 Baudrate der 12-Pin-Leitung

| Aussage | Quelle | Art |
|---|---|---|
| 78400 Bd, 8N1, invertiert, 0–5 V | yasdfgr-README (XA20sx8.5BERM-K3) | S |
| *„~~78.400~~ 76800 Baud … Lenses are ~~probably~~ not autobouding. Sony seems to be using 76800 baud. Blackmagics Timing is off (measured 78400Baud, close enough)“* (Commit „added sony baudrate“, 01.09.2025) | s73ampunkca7, Protocol.md | S |
| *„The lens has to be capable of automatically detecting the baudrate … The Blackmagic Design Ursa line uses 78400Boud“* – ohne Beleg | Wikipedia „B4-mount“ | S |

**Widerspruch:** Wikipedia sagt Autobauding, der Fork sagt nein. Beide sind
Sekundärquellen. 76800 = 2 × 38400 passt zur L10-Familie; 78400 ist kein
üblicher Teilerwert. Die Abweichung beträgt 2,1 % und liegt für 8N1 meist noch
innerhalb der Toleranz. Ein Mitschnitt mit 78400 Bd an einer 76800-Leitung
dürfte also lesbar sein. Für ein eigenes Senden zählt aber die Bitzeit, die der
Logikanalysator misst.

### 2.4 Fujinon-Warnung zu Pins 11/12 (P)

Fujinon „Serial data communication between camera and Fujinon broadcast lenses“
(18.01.2005):

- Seriell können nur bestimmte digitale ENG-Objektive ab bestimmten Revisionen
  (RM-M28/RD-S28/… ab „1C“, …-48 alle). Die Funktion ist ab Werk **abgeschaltet**
  und wird per DIP-Schalter und Tastenkombination aktiviert.
- *„Enabling serial digital communication on non-matching equipment may cause
  malfunction or damage to lens and/or camera“*.
- *„If the camera does provide analog control of lens functions (e.g. zoom or
  focus) via pins 11 & 12, it is essential to disable the serial data
  communication“*. **Es gibt also Kameras, die Pins 11/12 analog nutzen.**
  Ein Signal auf Pin 11/12 ist deshalb nicht automatisch seriell.
- Laut Fujinon kann die Kamera die Seriennummer des Objektivs **nicht** abfragen
  (Stand 2005; der Fork beobachtet später 0x17).

### 2.5 Canon digital

- Canon 2023 (bereits in `research-canon.md`): „12-pin serial communication“ für
  CINE-SERVO.
- Cyanview verwendet für „2/3" B4“ und für „Canon Cine Servo (12P digital)“
  **dasselbe** Kabel CY-CBL-6P-B4-01 (S). Das ist ein Indiz für eine gemeinsame
  Protokollbasis, kein Beweis.
- Ein Canon-Patent (EP 1 377 043) beschreibt eine Befehl-Antwort-Seriellverbindung
  mit Header- und Datenteil, die sich einen Pin mit einem herkömmlichen
  Analogsignal teilt (P). Ob Canon das so gebaut hat, ist offen.

### 2.6 Open-Source-Projekte

| Projekt | Stand | Nutzen |
|---|---|---|
| [yasdfgr/fujinon-tv-lens-control](https://github.com/yasdfgr/fujinon-tv-lens-control) | WIP; Mitschnitte und Arduino-Analyser | Herkunft von 78400 Bd und der Prosa-Codes |
| [s73ampunkca7/fujinon-tv-lens-control](https://github.com/s73ampunkca7/fujinon-tv-lens-control) | aktiv; „Observed Protocol Specs“, Logic-Analyzer-Dateien (`.sal`) für A13x4.5 und XA17x, ESP32-Sketches (SD-Dump, OTA), enthält L10-, Digipower- und Fujinon-Sony-PDF | **wichtigste Sekundärquelle**; ein Canon-Vergleich ist „geplant“, aber noch nicht vorhanden |
| [LAK132/b4rpi](https://github.com/LAK132/b4rpi) | KiCad-HAT für Raspberry Pi (2022); Netznamen wie Wikipedia | keine Pegel, keine Firmware |
| [RainbowLabsDE/Fujinon2TiltaNucleus](https://github.com/RainbowLabsDE/Fujinon2TiltaNucleus) | STM32 soll ein Fujinon-Objektiv gegenüber der Kamera spielen; Firmware ist ein Gerüst (UART per CubeMX auf 38400) | **kein** Beleg für Kamera-Baudraten |

Ein Projekt, das ein **analoges Canon**-Objektiv steuert oder ausliest, wurde nicht
gefunden.

---

## 3. Analoge Zoom- und Fokus-Demands

### 3.1 Fujinon-Demand-Buchse (P)

Fujinon-Handbücher UA13x4.5/UA24x7.8 und UA22x4.8 (Serie S10, 2026 auf
fujifilm.com) beschreiben die Buchsen am **Objektiv**, an die die Demand
angeschlossen wird. Das Objektiv ist hier der Host:

| Pin | Fokus-Buchse (HR10G-10R-12S) | Zoom-Buchse (HR10G-10R-12S) |
|---|---|---|
| 1 | +V (+12 V DC) | +V (+12 V DC) |
| 2 | GND | GND |
| 3 | COM+V (7,5 V DC) | COM+V (7,5 V DC) |
| 4 | COM (5,0 V DC) | COM (5,0 V DC) |
| 5 | COM−V (2,5 V DC) | COM−V (2,5 V DC) |
| 6 | **DETECT: analoge Demand = +12 V, digitale Demand = +5 V** | **DETECT: analoge Demand = offen, digitale Demand = +5 V** |
| 7 | FOCUS CONTROL (Far = 7,5 V, Near = 2,5 V) | ZOOM CONTROL (Wide = 7,5 V, Tele = 2,5 V) |
| 8 | FOCUS POSITION (Far = 2,5 V, Near = 7,5 V) | ZOOM POSITION (Wide = 2,5 V, Tele = 7,5 V) |
| 9 | ECU CONTROL SIGNAL | VTR SW |
| 10 | N.C. | VTR SW COM |
| 11 | N.C. | RET SW |
| 12 | N.C. | RET SW COM |

Abgleich mit dem SPC-7000-Blatt ([`spc7000-pinout.md`](spc7000-pinout.md)):

- Pins 1–7 stimmen überein, ebenso die Referenzen 7,5/5,0/2,5 V und das
  Vorhandensein von Detect. Das ist jetzt **primär bestätigt**.
- **Pin 8 weicht ab:** SPC „RS-485 B (unused)“, Fujinon „Position“ vom Host zur
  Demand.
- **Pin 9 (Fokus) weicht ab:** SPC „RS-485 A“, Fujinon „ECU control signal“.
- Bei der Zoom-Demand stimmen die Pins 9–12 (VTR/RET) überein.
- Detect wird **von der Demand getrieben**, und zwar mit **bis zu +12 V**. Damit
  ist #49 Punkt 1 in der Sache beantwortet. Ob ältere Fujinon-B/C-Demands sich
  genauso verhalten, steht nicht im Handbuch; es ist anzunehmen.

### 3.2 Canon

- Zur 8-Pin-Zoom-Remote der R-Typen und zur 20-Pin-Buchse (ZSD-300D, FPD-400D)
  wurde **keine** Primärquelle mit Belegung gefunden.
- Libec ZC-9PRO hat einen **Umschalter Canon/Fujinon** am 8-Pin-Kabel (Händlerangaben,
  S). Das stützt die Aussage von cameratim (S), dass sich die Canon-Belegung von
  der Fujinon-Belegung unterscheidet (A/B vertauscht).
- Canon-Konverterkabel laut Händlern: CC-2008 (20p→8p für ZSD-300M), Libec A-20P
  (8p→20p). Eine Belegung nennt keiner.

---

## 4. Kamerasteuerung allgemein (für die Brücke)

Die Brücke hat bereits Sony 700PTP/RCP (`CcuClient.ts`), Panasonic AW über HTTP
(`PanasonicPtzClient.ts`) und die Blackmagic-REST-API (`BMDeviceClient.ts`).
Neu oder ergänzend:

### 4.1 FreeD (für #54)

- **Sony „Integration manual – Camera Tracking function for AR/VR“** (BRC-X1000/X400,
  31.07.2020, P), zitiert den free-d-Standard (Anhang B):
  - Winkel als 24 Bit Zweierkomplement, 1 Vorzeichen-, 8 Ganzzahl- und
    15 Nachkommabits. **Bestätigt `FreeD.ts`.**
  - Zoom und Fokus: Die free-d-Spezifikation *„doesn't specifically state about data
    representation format“* außer „24 bit positive unsigned“. Das bestätigt den
    Kalibriertabellen-Ansatz in [`freed-output.md`](freed-output.md).
  - Sony belegt das Feld „Spare/User Defined“ (16 Bit) mit **Blendenzahl × 100
    (12 Bit) plus 4-Bit-Framezähler**. Das ist eine Sony-Erweiterung, kein Standard.
  - UDP-Port frei wählbar 1025–65534, **Sony-Standard 40000**. Andere
    Installationen nutzen 6301. Das bestätigt die Entscheidung „kein Standardport“.
  - Ursprünglich RS-422/485, Stream- und Polled-Modus (D0 schaltet den Stream).
    Konfiguration bei Sony per `/command/freedconfig.cgi` (HTTP Digest, nur GET).
    Das passt zum HTTP-CGI-Weg der Brücke.
- **Positionsskala 1/64 mm:** keine Primärquelle gefunden. Zwei unabhängige
  Sekundärquellen passen dazu:
  - Derivative nennt ±131,07 m. Das ist genau 2²³ / 64 mm (abgeleitet).
  - Vizrt Tracking Hub teilt Positionen durch 640 (= Zentimeter bei 64 pro mm,
    abgeleitet); seriell 38400 Bd, ungerade Parität.
- Vizrt und Pixotope ziehen bei Zoom/Fokus optional **0x80000** ab. Manche Quellen
  liefern Encoderwerte also versetzt. Bei Interop-Tests (#56) beachten.

### 4.2 TSL UMD (P: TSL „UMD Protocols“, Stand 19.09.2009)

- **V3.1:** RS-422/485, **38,4 kBd, 8E1** (gerade Parität). Header = Adresse
  (0–126) + 0x80; Steuerbyte mit Bit 0–3 = Tally 1–4 und Bit 4–5 = Helligkeit;
  16 ASCII-Zeichen (0x20–0x7E). Über UDP: ein Paket pro Nachricht.
- **V4.0:** V3.1 plus Prüfsumme (Zweierkomplement mod 128) und XDATA mit Tallyfarben.
- **V5.0:** UDP, max. 2048 Byte. Optional per TCP mit DLE/STX-Rahmung (DLE = 0xFE,
  Byte-Stuffing). Aufbau `PBC(16) VER(8) FLAGS(8) SCREEN(16)`, dann je Display
  `INDEX(16) CONTROL(16) LENGTH(16) TEXT`. CONTROL: Bit 0–1 RH-Tally, 2–3 Text-Tally,
  4–5 LH-Tally, 6–7 Helligkeit; 2-Bit-Werte 0 = aus, 1 = rot, 2 = grün, 3 = gelb.
  0xFFFF = Broadcast. FLAGS Bit 0 = UTF-16LE.
- **Offen:** Die Spezifikation legt die **Byte-Reihenfolge** der 16-Bit-Felder und
  einen UDP-Port nicht fest. Vor einer Implementierung gegen ein reales Gerät
  (z. B. ATEM, Multiviewer) mitschneiden.

### 4.3 Blackmagic SDI Camera Control

Die offizielle Entwicklerdoku „Blackmagic Camera Control“ (v1.3, 2018, P;
<https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl/20181019-740d71/BlackmagicCameraControl.pdf>)
beschreibt das SDI-Protokoll, das ATEM und das 3G-SDI-Arduino-Shield sprechen.
Kategorie 0 = Lens. Eine maschinenlesbare Fassung liegt in
[coral/blackmagic-camera-protocol](https://github.com/coral/blackmagic-camera-protocol) (S).
Interessant für Kameras ohne REST. Nicht heruntergeladen, nicht geprüft.

### 4.4 Ikegami, Sony-RCP-Details

Nicht recherchiert. Das Budget ging an Schwerpunkt 1. Offen.

---

## Bestätigt / Widerspricht unserer Doku

| # | Aussage in unserer Doku | Befund | Quelle (Art) | Betroffene Datei |
|---|---|---|---|---|
| 1 | Funktionen der Pins 1–12 | **bestätigt** | ARIB TR-B37 Tab. 4-2 (P), Panasonic (P), Canon-Patent für Pin 5 (P) | `b4-lens-control.md` §2, `spc7000-pinout.md` |
| 2 | Pin 5/7: F2,8 = 6,2 V, F16 = 3,4 V | **bestätigt**, ± 0,1 V | ARIB (P) | `b4-lens-control.md` §2, `wiring.md` §2 |
| 3 | „closed 2.5 V“ | **präzisiert/widerlegt:** Sollwert zu 2,1–2,9 V, Rückmeldung zu 1,5–2,9 V | ARIB (P) | `b4-lens-control.md` §2, `wiring.md` §2/§4, `safety-review.md` C12 |
| 4 | Pin 10 Zoom 2/7 V, Pin 11 Fokus 2/7 V | **bestätigt**, ± 0,2 V | ARIB (P) | `b4-lens-control.md` §2 |
| 5 | Pin 4 „Iris servo (off 0 V, on 5 V)“ / „servo enable“ | **korrigiert:** „Forced iris servo“ (Taste), offen = AUS, für Remote nicht nötig | ARIB (P), L10 Switch 2 Bit 5 (P), Canon Instant Auto-Iris (P) | `b4-lens-control.md` §2, `wiring.md` §3, `firmware-b4/src/config.h` (Kommentar) |
| 6 | Pin 8: auto 0 V / remote 5 V | **bestätigt** (auto auch offen; remote 5,0 ± 0,5 V, Quellwiderstand ≤ 1 kΩ / ≤ 10 kΩ) | ARIB (P) | `b4-lens-control.md` §2, `wiring.md` §3 |
| 7 | Pin 8 = 0 V: „the lens runs its own auto-iris“; „without 5 V the lens will not accept remote control at all“ | **zweifelhaft:** In A folgt die Blende immer der Kamera; Canon unterscheidet Auto- und Remote-*Gain*. Panasonic nennt Pin 8 „IRIS-G-MAX“ | Canon (P), Panasonic (P) | `firmware-b4/src/config.h`, `wiring.md` §3 |
| 8 | Pin 6 „+12 V“ / SPC „Unreg“ | **präzisiert:** 10–17 V, 0,5 A normal, ≤ 1,5 A kurzzeitig | ARIB, Canon, Sony, Panasonic (P) | `spc7000-pinout.md` (Abweichungstabelle), `wiring.md` |
| 9 | Rücklese-Teiler 10 k/6,8 k (16,8 kΩ Last) | **widerspricht** ARIB (Kamera-Eingang ≥ 20 kΩ) | ARIB (P) | `wiring.md` §2, `safety-review.md` A, `firmware-b4/src/config.h` |
| 10 | „LM358 **or** TL072 … same pinout“ | **widerspricht** dem TI-Datenblatt: Der TL072 braucht am +Eingang ≥ V− + 1,5 V (TL072H) bzw. etwa ≥ V− + 3–4 V (TL072 alt), die Stufe hat 1,27 V. Ausgangshub des alten TL072 bis 2,54 V nicht garantiert | TI TL072 (P) | `wiring.md` §3, `iris-anleitung.html/.pdf` |
| 11 | Irisschalter auf A für Fernsteuerung | **bestätigt** (Canon). SKAARHOJ sagt „Manual“ (S, widerspricht) | Canon (P) | `wiring.md` §3 |
| 12 | Iris am Ring „by hand“ bewegen (Inbetriebnahme Schritt 2, C12) | **Sicherheitslücke:** Canon warnt, dass Drehen in Stellung A das Objektiv beschädigen kann. Schalter vorher auf M | Canon (P) | `wiring.md` §4 Schritt 2, `safety-review.md` C12 |
| 13 | Verstärker 2,54–6,6 V | innerhalb ARIB (zu-Band, F2,8). Reicht vermutlich nicht bis F1,7 (≈ 7,0 V, **abgeleitet**). SKAARHOJ fährt bis 7,5 V (S) | ARIB (P), SKAARHOJ (S) | `wiring.md` §3 |
| 14 | L10-Rahmen, Prüfsumme | **bestätigt** | L10 v1.40, Fujinon 2006 (P) | `b4-lens-control.md` §4 |
| 15 | Konflikt 0x20/0x21/0x22 gegen 0x21/0x23/0x22 (#47) | **für L10 aufgelöst: 0x20/0x21/0x22.** 0x23 auf 12-Pin = „absolute Iris“ (S) | L10 (P), Fork (S) | `b4-lens-control.md` §5, `serial.md`, `firmware-b4/src/config.h` (`B4_COMMAND_CODES_RESOLVED`) |
| 16 | 0x42–0x44/0x52–0x54 „undocumented“ | **dokumentiert:** Switch 2 = Forced servo/A-R, 3 = Extender, 4 = Host/Local, dazu 0x46/0x56 Stabilisator | L10 (P) | `b4-lens-control.md` §7 |
| 17 | Namenslänge „up to 80 chars“ | **widersprüchlich in Primärquellen:** L10 v1.40 = 30, Fujinon 2006 = 80 | L10, 2006 (P) | `b4-lens-control.md` §5 |
| 18 | Gruppe A = RS-232 mit Handshake | **bestätigt und präzisiert:** 38,4 kbit/s, Hirose HR10G-10R-10S bzw. DE-9 | L10, 2006 (P) | `b4-lens-control.md` §1 |
| 19 | 12-Pin seriell 78400 Bd | **angezweifelt:** Fork korrigiert auf 76800 (Sony), 78400 = URSA-Ungenauigkeit (S). Autobauding strittig | Fork (S), Wikipedia (S) | `b4-lens-control.md` §3, `serial.md`, `firmware-b4/src/config.h` |
| 20 | Leerlauf `FB 03` | weder bestätigt noch widerlegt | – | `b4-lens-control.md` §5 |
| 21 | Fujinon-B/C-Demand: Referenzen 7,5/5,0/2,5 V, Detect | **bestätigt (P);** Pin 8/9 abweichend. Detect = +12 V (analoger Fokus) / offen (analoger Zoom) / +5 V (digital) | Fujinon UA S10 (P) | `spc7000-pinout.md`, `demand.md` |
| 22 | Detect-Teiler 10 k/6,8 k zum ADS1115 | **widerspricht:** 12 V → 4,86 V, der ADS1115 erlaubt höchstens VDD + 0,3 V = 3,6 V | Fujinon (P), TI ADS1115 (P) | `demand.md`, `firmware-b4/src/config.h` |
| 23 | Canon 8-Pin ≠ Fujinon | **gestützt** (Libec-Umschalter Canon/Fujinon) | Händler (S) | `research-canon.md` |
| 24 | FreeD-Winkelformat | **bestätigt** | Sony Integration manual (P) | `freed-output.md` |
| 25 | FreeD Position 64/mm (#54) | **gestützt**, nicht primär belegt | Derivative, Vizrt (S, Rechnung) | `freed-output.md` |
| 26 | FreeD: kein Standardport | **gestützt** (Sony 40000, anderswo 6301) | Sony (P) | `freed-output.md` |

---

## Empfehlungen für den Bankbetrieb der Iris-Steuerung

In Reihenfolge des Aufbaus. Sie ersetzen `safety-review.md` nicht, sie ergänzen es.
Freigabe bleibt bei Lars.

**Vor dem Aufbau**

1. **Keinen TL072 verwenden, nur LM358** (oder einen anderen Operationsverstärker,
   dessen Eingangsbereich bis V− reicht). Mit 1,27 V am +Eingang ist der TL072
   außerhalb seines Gleichtaktbereichs. Sein Verhalten ist dann nicht spezifiziert;
   bei JFET-Verstärkern dieser Generation ist Phasenumkehr bekannt (Allgemeinwissen,
   nicht im Datenblatt nachgelesen). Im schlimmsten Fall springt der Ausgang an die
   obere Grenze.
2. **Ausgangsspannung hart begrenzen.** Ein LM358 an 12 V kann im Fehlerfall
   (z. B. R1 offen) etwa 10,5 V ausgeben, an 17 V etwa 15,5 V. Eine Obergrenze für
   Pin 5 nennt keine Quelle. Der höchste belegte Wert, den ein Produkt anlegt, ist
   7,5 V (SKAARHOJ). Möglichkeiten:
   - den Verstärker aus einem **9-V-Regler** speisen (LM358-Hub dann etwa ≤ 7,5 V,
     Gleichtaktbereich bis 7 V reicht für 3,3 V), oder
   - hinter dem 1-kΩ-Widerstand gegen GND mit einer ~7,5-V-Z-Diode klemmen.

   Ersteres ist robuster.
3. **Rücklese-Teiler 10× hochohmiger: 100 kΩ / 68 kΩ.** Das Verhältnis bleibt gleich,
   `config.h` bekommt nur neue Werte. Die Last steigt auf 168 kΩ (ARIB fordert
   ≥ 20 kΩ). Der Quellwiderstand von 40 kΩ gegen die 6 MΩ Gleichtaktimpedanz des
   ADS1115 (bei ±4,096 V) ergibt etwa 0,7 % Fehler; die Kalibrierung fängt ihn ab.
   Optional 10–100 nF am ADC-Eingang.
4. Die **5 V für Pin 8** über 1 kΩ einspeisen. Das hält auch die strengere
   ARIB-Grenze (≤ 1 kΩ) ein. **Pin 4 offen lassen**, er wird nicht gebraucht.
5. Die MCP4728 lädt beim Einschalten ihren **EEPROM**. Ab Werk: Code 0 mit interner
   2,048-V-Referenz, also 0 V. Die Firmware darf den EEPROM nie beschreiben.
   Prüfen: Steht nach dem Flashen im Prüfschritt 4 (Endwert) nur etwa **5,06 V**
   statt 6,6 V an, läuft der Kanal mit interner 2,048-V-Referenz statt VDD.

**Ohne Objektiv (`safety-review.md` B, ergänzt)**

6. Zusätzlich zu B4/B5: Ausgang beim **Einschalten** messen, bevor die Firmware den
   DAC setzt. Erwartet: ≈ 2,54 V. Dann den **Fehlerfall** prüfen: R1 kurz abklemmen,
   der Ausgang muss unter der gewählten Grenze bleiben (Punkt 2).
7. Die Versorgung der Bank ist ein 12-V-Labornetzteil mit **Strombegrenzung 1,0 A**.
   ARIB sieht 0,5 A Dauerlast und 1,5 A Spitze vor. Geht das Netzteil beim
   Servoanlauf in die Begrenzung, auf höchstens 1,5 A erhöhen. Ruhe- und
   Antriebsstrom notieren; die Stromaufnahme der J15ax8B4 ist unbekannt.
   **Polarität doppelt prüfen** (Canon warnt ausdrücklich vor Verpolung).

**Mit Objektiv, passiv**

8. **Irisschalter am Objektiv zuerst auf M.** Nur in M den Irisring von Hand drehen.
   Canon: In A kann erzwungenes Drehen das Objektiv beschädigen.
   (`wiring.md` §4 Schritt 2 und `safety-review.md` C12 sagen das bisher nicht.)
9. In M Pin 7 über den ganzen Ring aufnehmen, besonders **ganz offen** (≈ 7 V
   erwartet, abgeleitet) und **ganz zu** (1,5–2,9 V laut ARIB). Ob Pin 7 in M
   überhaupt die Position meldet, ist eine Messfrage. Pin 10 beim Zoomen und
   Pin 11 beim Fokussieren aufnehmen (#38, Gruppe C). Pin 9 im Leerlauf ohne
   Beschaltung messen: Erwartet ist offen; er wird später mit Pull-up gelesen.
10. **Pin 5 nie offen lassen, solange der Schalter auf A steht.** Der Eingang ist
    hochohmig (≥ 100 kΩ), offen ist sein Zustand undefiniert. Reihenfolge:
    Verstärkerausgang liegt auf ≈ 2,54 V (zu-Band) → Pin 5 verbinden → Pin 8 auf 5 V
    → erst dann Schalter auf A.

**Erster Antrieb**

11. Zuerst **ohne äußere Regelschleife** fahren: nur DAC-Stufen setzen und Pin 7
    beobachten. Das Objektiv regelt selbst. Erst danach den I-Anteil der Firmware
    zuschalten. Pendelt die Iris („iris hunting“), zuerst den Iris-Gain-Trimmer am
    Objektiv prüfen (falls vorhanden), nicht die Firmware.
12. **Gegenprobe zu Pin 8:** Mit Schalter A und Pin 8 offen (= Auto) prüfen, ob die
    Blende Pin 5 trotzdem folgt. Das klärt Zeile 7 der Tabelle oben.
13. Kalibrierpunkte auch unterhalb von 3,4 V (F16) bis ins zu-Band aufnehmen, und
    oberhalb von 6,2 V bis zum Ende des Verstärkerhubs.

**Für später (nicht morgen)**

- Demand-Leser: Teiler für **Detect auf 12 V** auslegen (z. B. 33 k / 10 k → 2,8 V)
  und die 7,5/5,0/2,5-V-Referenzen sowie +12 V bereitstellen, bevor eine Demand
  angesteckt wird.
- Serieller Mitschnitt: Bitzeit messen und 76800 gegen 78400 entscheiden. Den Gate
  `B4_COMMAND_CODES_RESOLVED` für 0x20–0x22 nur mit Mitschnitt aufheben; 0x23–0x27
  getrennt behandeln. Beim Senden die 5-s-Rückfallzeit und < 1 ms Byteabstand
  einhalten.

---

## Quellenliste

### Primärquellen (heruntergeladen nach `quellen/`)

| Datei | Dokument | URL |
|---|---|---|
| `arib/8-TR-B37v1_1-E2.pdf` | ARIB TR-B37 v1.1-E2 „Interconnection for UHDTV Camera and Lens“ (2017), Tab. 2-2 und 4-2 | <https://www.arib.or.jp/english/html/overview/doc/8-TR-B37v1_1-E2.pdf> (Seite: <https://www.arib.or.jp/english/std_tr/broadcasting/tr-b37.html>) |
| `fujinon-l10/fujinon-l10-protocol.pdf` | Fujinon „DIGI POWER TV Lens System – Protocol L10 Specifications Ver. 1.40“, Dok. 416B10443504 | <https://cdck-file-uploads-europe1.s3.dualstack.eu-west-1.amazonaws.com/arduino/original/2X/d/d868b98f5db6cbb17e6d38ad65a6e3a0ff15f367.pdf> |
| `fujinon-l10/2006-06-28-rs232-digipower-protocol.pdf` | Fujinon „DIGI POWER Series TV Lens RS-232C External Control Specifications“ (28.06.2006) | <https://github.com/s73ampunkca7/fujinon-tv-lens-control/tree/main/uart%20protocol%20docs> |
| `fujinon-l10/serial-data-communication-lenses-sony-cameras.pdf` | Fujinon „Serial data communication between camera and Fujinon broadcast lenses“ (18.01.2005) | wie oben |
| `fujinon-handbuecher/ua13x4.5_s10_ua24x7.8_s10.pdf`, `ua22x4.8_s10.pdf` | Fujinon UA-Serie S10, Betriebsanleitungen, Kap. 14 „Pin assignment of connectors“ | <https://asset.fujifilm.com/global/files/2026-04/2a92e953e0af97969e9319f0eb47b065/ua13x4.5_s10_ua24x7.8_s10.pdf>, <https://asset.fujifilm.com/global/files/2026-04/e2d879f93ee9219820a507b5999267c6/ua22x4.8_s10.pdf> |
| `canon-handbuecher/portls-omls-d020a_eng.pdf` | Canon BCTV Zoom Lens, Operation Manual „Lens“ (CJ/KJ) | <https://gdlp01.c-wss.com/gds/9/0300045219/01/portls-omls-d020a_eng.pdf> |
| `canon-handbuecher/portls-omdp-d021a-eng.pdf` | Canon BCTV Zoom Lens, Operation Manual „Information display“ | <https://gdlp01.c-wss.com/gds/2/0300045222/01/portls-omdp-d021a-eng.pdf> |
| `sony-handbuecher/PXW-X400.pdf`, `PXW-Z450.pdf` | Sony-Betriebsanleitungen, Spezifikation LENS 12-pin | <https://www.adorama.com/col/productManuals/SOPXWX400KC.pdf>, <https://www.adorama.com/col/productManuals/SOPXWZ450.pdf> |
| `kamerasteuerung/SON-BRC-X1000_X400_cameraTracking.pdf` | Sony Integration manual „Camera Tracking function for AR/VR application“ (2020) | <https://shop.ccisolutions.com/StoreFront/jsp/pdf/SON-BRC-X1000_X400_series_cameraTracking.pdf> |
| `kamerasteuerung/TSL-UMD-protocol.pdf` | TSL „UMD Protocols“ V3.1/4.0/5.0 | <https://tslproducts.com/wp-content/uploads/TSL-UMD-protocol.pdf> |
| `datenblaetter/ads1115.pdf` | TI ADS1115 | <https://www.ti.com/lit/ds/symlink/ads1115.pdf> |
| `datenblaetter/tl072.pdf` | TI TL07xx (SLOS080W, 2025) | <https://www.ti.com/lit/ds/symlink/tl072.pdf> |
| `datenblaetter/lm358.pdf` | TI LM358 | <https://www.ti.com/lit/ds/symlink/lm358.pdf> |
| `datenblaetter/mcp4728.pdf` | Microchip MCP4728 (22187E) | <https://ww1.microchip.com/downloads/en/DeviceDoc/22187E.pdf> |

### Primärquellen (online gelesen)

- Panasonic AJ-PX5100G, LENS-Buchse: <https://pro-av.panasonic.net/manual/html/AJ-PX5100G(DVQP1798ZA)_E/chapter10_02.htm>
- Panasonic AJ-CX4000G: <https://pro-av.panasonic.net/manual/html/AJ-CX4000G(DVQP2127YA)_E/chapter11_03.htm>
- Panasonic AK-UB300G, IRIS-Buchse: <https://pro-av.panasonic.net/manual/html/AK-UB300G(DVQP1279WA)_E/chapter09_02.htm>
- Canon-Patent EP 1 377 043 A2: <https://data.epo.org/publication-server/rest/v1.2/patents/EP1377043NWA2/document.html>
- ARIB BTA S-1005 (Übersicht): <https://www.arib.or.jp/english/std_tr/broadcasting/desc/bta-s-1005.html>

### Sekundärquellen

- `skaarhoj/Skaarhoj_B4_Links.pdf` – SKAARHOJ „B4 Links“-Handbuch (Fremdhersteller über fremde Geräte, enthält den Pin-6-Fehler): <https://github.com/SKAARHOJ/Support/blob/master/Manuals/Tutorials/Skaarhoj_B4_Links.pdf>
- SKAARHOJ-Wiki, PID: <https://wiki.skaarhoj.com/books/device-core-articles/page/eth-b4-link-lens-control>
- Wikipedia „B4-mount“ (stützt die Pinbelegung auf das Fujinon-Handbuch A13x4.5BERD-S48, S. 38, das nicht online gefunden wurde): <https://en.wikipedia.org/wiki/B4-mount>
- s73ampunkca7/fujinon-tv-lens-control, „Observed Protocol Specs/Protocol.md“: <https://github.com/s73ampunkca7/fujinon-tv-lens-control>
- yasdfgr/fujinon-tv-lens-control: <https://github.com/yasdfgr/fujinon-tv-lens-control>
- LAK132/b4rpi: <https://github.com/LAK132/b4rpi>
- RainbowLabsDE/Fujinon2TiltaNucleus: <https://github.com/RainbowLabsDE/Fujinon2TiltaNucleus>
- DVinfo „Fujinon 12 pin“ (2008): <https://dvinfo.net/forum/archive/index.php/t-127790.html>
- DVinfo „B3 lens wiring diagram“: <https://www.dvinfo.net/forum/archive/index.php/t-536917.html>
- Cyanview B4 Lens: <https://support.cyanview.com/docs/Integrations/Lens/B4Lens>, Lens Control: <https://support-next.cyanview.com/docs/configure/lens-control/>
- Vizrt Tracking Hub, FreeD: <https://docs.vizrt.com/tracking-hub-guide/1.6/Description_of_the_FreeD_protocol.html>
- Derivative FreeD Out CHOP: <https://derivative.ca/UserGuide/FreeD_Out_CHOP>
- Pixotope Tracking-Protokolle: <https://help.pixotope.com/phc/26.1/supported-tracking-protocols>
- tslumd-Doku: <https://tslumd.readthedocs.io/en/latest/protocol.html>
- coral/blackmagic-camera-protocol: <https://github.com/coral/blackmagic-camera-protocol>
- Händler: J15ax8B4 F1,7 (eBay/Adorama-Angebote), Libec ZC-9PRO (7bd.com, B&H)

### Gesucht, nicht gefunden

- Handbuch oder Servicehandbuch der Canon J15ax8B4 bzw. einer analogen Canon-J-/YJ-Optik
  mit Pinbelegung.
- Fujinon A13x4.5BERD-S48-Handbuch (die Wikipedia-Quelle).
- Canon-Belegung der 8-Pin-Zoom-Remote und der 20-Pin-Demand-Buchse; BDC-11 passiv ja/nein.
- Primärquelle zu 76800/78400 Bd auf der 12-Pin-Leitung.
- free-d-Originalspezifikation (Sony verweist auf das „free-d installation manual“,
  Anhang A/B, nur über den Vertrieb).
