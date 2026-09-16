# DJI-Gimbals als PTZ-Kopf

Zwei Wege, zwei sehr verschiedene Ausgangslagen. Dieses Dokument haelt fest,
**was belegt ist und was nicht** — weil man einem Stueck Code nicht ansieht,
ob es je an einem Geraet war.

## Kurzfassung

| | DJI Ronin (RS 2 / RS 3 Pro) | DJI Osmo Pocket (3 / 4) |
|---|---|---|
| Protokoll | DJI R SDK | DUML |
| Herstellerangabe | **ja** (Dokument „Protocol and User Interface DJI R SDK", 2.3) | **nein** |
| Belegter Transport | CAN, 1 Mbit/s | **Bluetooth LE** |
| Hier umgesetzt | CAN ueber USB-SLCAN-Stecker | DUML ueber serielles (CDC) Geraet |
| An Hardware geprueft | **nein** | **nein** |

## Was geprueft ist

Die Rechenwege, und zwar durch Tests im Repo
(`packages/bridge/test/duml.test.ts`, `packages/bridge/test/djiGimbal.test.ts`):

- Rahmenbau und -zerlegung, Hin- und Rueckweg feldweise
- beide Pruefsummen je Protokoll, samt Nachweis, dass ein verfaelschtes Byte
  auffaellt
- der Stromleser an den Faellen, an denen ein naiver Leser scheitert: zwei
  Rahmen in einem Haeppchen, ein Rahmen byteweise, ein `0x55` **in** der
  Nutzlast
- die SLCAN-Zeilen hin und zurueck, samt Abweisung zu langer Rahmen und zu
  grosser Kennungen
- Winkelbegrenzung: 40 000 Grad ergeben 32 767 und keinen Ueberlauf — sonst
  faehrt der Kopf irgendwohin

## Was NICHT geprueft ist

Ob ein Geraet die Pakete annimmt. Hier stand weder ein Ronin noch eine
Pocket. Wer das nachholt, sollte zuerst an diesen beiden Stellschrauben
drehen, wenn nichts antwortet:

1. **Der Startwert der Pruefsummen.** `DUML_CRC16_START` (`Duml.ts`) steht auf
   `0x496C`, belegt fuer die Pocket-Reihe; aeltere DJI-Geraete und die
   verbreiteten `dji-firmware-tools` rechnen mit `0x3692`. `RSDK_CRC_START`
   (`DjiRSdk.ts`) steht auf `0x3692`. Beide sind benannte Konstanten, genau
   damit man sie findet.
2. **Die Kennungen von Absender und Empfaenger** im DUML-Rahmen
   (`DjiOsmoClient.sende`, heute `0x0A` → `0x03`).

## Warum beim Osmo kein USB

Gefragt war USB-Steuerung fuer die Osmo Pocket 4. Die Lage:

- DJI veroeffentlicht fuer die Pocket-Reihe **keine** Steuerschnittstelle.
- Der USB-C-Anschluss bedient Massenspeicher und UVC-Webcam — beides sind
  keine Gimbal-Steuerung.
- Der einzige oeffentlich aufgearbeitete Weg ist **DUML ueber Bluetooth LE**
  (Merkmal `fff5`, `writeWithoutResponse`; gewonnen aus Mitschnitten der
  DJI-Mimo-App).

Umgesetzt ist deshalb DUML ueber eine **serielle** Leitung. Das trifft zu,
wenn sich das Geraet oder ein Adapter davor als CDC-ACM meldet. Meldet sich
kein serielles Geraet, ist das kein Defekt dieses Codes, sondern die Aussage,
dass dieser Weg bei diesem Geraet nicht offensteht.

**BLE nachzuruesten ist vorbereitet, aber nicht getan.** `DumlTransport`
(`DjiOsmoClient.ts`) ist die Naht: ein BLE-Transport wird danebengesetzt, die
Kommandos bleiben unberuehrt. Was dabei zu bedenken ist: die verbreiteten
Node-BLE-Module (`@abandonware/noble`) bringen native Bestandteile **ohne**
N-API-Prebuilds mit. Damit fiele die Eigenschaft, auf der die
Ein-Klick-Installation beruht (siehe `electron-builder.yml`, `npmRebuild`),
und der Installer braeuchte `electron-rebuild`. Das ist die eigentliche
Entscheidung, nicht die Protokollarbeit.

## Welche Geraete

**Ronin:** RS 2 und RS 3 Pro sprechen das R SDK. **RS 3 und RSC 2 nicht** —
sie sehen gleich aus und koennen es trotzdem nicht.

**Verkabelung Ronin:** SLCAN-Stecker an den Focus-Wheel-Anschluss, 1 Mbit/s.
Host → Gimbal auf Kennung `0x223`, Gimbal → Host auf `0x222`. Auf demselben
Bus fahren die Rahmen des Focus-Rads mit rund 400 Hz (`0x530`, `0x531`,
`0x426`); der Client filtert auf `0x222`, sonst ertraenkt er sich selbst.

## Was ein Gimbal NICHT kann

Blende, Gain, Weissabgleich. Ein Gimbal traegt eine Kamera, er ist keine.
`capabilities.ts` fuehrt beide Wege deshalb mit leeren Faehigkeiten, und das
Pult graut die Bildregler aus, statt sie wirkungslos anzubieten. Gefahren
wird ueber `ptz` (Pan/Tilt), `gotoAngle` und `recenter`.

## Dauerfahrt

Beide Koepfe halten ein Geschwindigkeits-Kommando **absichtlich** nur kurz —
das R-SDK-Dokument nennt 0,5 s. Reisst die Verbindung mitten im Schwenk ab,
bleibt der Kopf stehen statt weiterzulaufen. Fuer eine Dauerfahrt muss
nachgetaktet werden; beide Clients tun das alle 200 ms und schicken beim
Loslassen ein ausdrueckliches Null-Kommando, statt nur das Nachtakten
einzustellen — sonst liefe der Kopf bis zum Ablauf seines eigenen
Sicherheitsnetzes weiter, also bis zu eine halbe Sekunde zu weit.
