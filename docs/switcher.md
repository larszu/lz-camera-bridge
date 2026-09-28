# VIS-CATC — Mischer an der Bruecke

Der Vissonic VIS-CATC ist ein Videomischer mit **einem** Ausgang und einem
Multi-Image-Bild: beide HDMI-Buchsen und der UVC-Ausgang zeigen dasselbe. Die
vier „Ausgaenge" `out1..out4` seiner Antworten sind die **Fenster** in diesem
Bild — deshalb heissen sie hier *Ziele* bzw. *windows*, nicht Ausgaenge.

Code: `packages/bridge/src/switcher/` — `visCatcProtocol.ts` (reine
Zeichenketten und Parser), `layouts.ts` (die zwoelf Darstellungen),
`switcherBus.ts` (PGM/PVW-Logik), `VisCatcClient.ts` (Transport, Poll, Bus).

## Bedienlogik

Nach Pult-Vorbild (ATEM): **PGM** ist, was hinausgeht; **PVW** die Vorauswahl;
**CUT** tauscht beide. Der VIS-CATC kennt nur den einen Ausgang, also lebt der
Vorschau-Bus in der **Bruecke** — nicht im Browser. Zwei Fenster zeigen so
dieselbe Vorauswahl, und das Oeffnen eines zweiten setzt sie nicht zurueck.
Eine weiche Blende gibt es nicht; das Geraet schaltet hart und
unterbrechungsfrei.

Der Programm-Ausgang ist das **groesste Fenster** der aktuellen Darstellung
(`mainWindow(mode)`), sofern die Anlage kein `pgmWindow` vorgibt. Bei
Bild-im-Bild ist das das Hauptbild, nicht die Einblendung.

Tasten (nach `event.code`, nicht `event.key` — mit Shift ist `key` je nach
Layout `!`, `"` oder `§`):

| Taste | Wirkung |
|---|---|
| `1`…`6` | Quelle in die Vorschau |
| `Shift`+`1`…`6` | Quelle direkt auf den Ausgang |
| `Enter`, `Leertaste` | CUT |

## Netzwerk (Geraeteseite VIS-CATC.html)

`POST /`, `Content-Type: application/x-www-form-urlencoded; charset=utf-8`,
Werte **unescaped** (`URLSearchParams` wuerde die Punkte einer IP kodieren, und
das Geraet antwortet mit nichts). Antwort ist JSON-aehnlich; `parseJsonLoose`
repariert einfache Anfuehrungszeichen, nachgestellte Kommas und nackte
Schluessel.

| Body | Wirkung |
|---|---|
| `param=3V1` | Quelle 3 (SDI-1) in Fenster 1 |
| `param=mode2` | Darstellung (0…11) |
| `param=audio1` | Audioquelle (0…3) |
| `param=status` | → `out1…out4`, `mode`, `audio` |
| `param=inputinfo` | → Signalerkennung je Eingang (`"true"`/`"false"`) |
| `param=version` | → Firmwarestand |
| `param=netInfo` | → IP, Gateway, Subnetz, MAC |

Quellen: `1=HDMI-1, 2=HDMI-2, 3=SDI-1, 4=SDI-2, 5=SDI-3, 6=SDI-4`.

## RS-232 (Handbuch VIS-CATC-B §6.3, 9600 bps 8N1)

| Befehl | Wirkung | Rueckmeldung |
|---|---|---|
| `[x]V[y].` | Eingang x auf Fenster y | `V:[x] -> [y]` |
| `<#Splice_mode[x]>` | Darstellung, x = 0…11 | `<Splice_mode[x]>` |
| `<#Audio_chn[x]>` | Audiokanal | `<Audio_chn[x]>` |
| `FREEZE[x].` | Einfrierzeit in Sekunden (1…6) | `FREEZE[x].` |
| `SetFreeze.` | Einfrieren ausloesen | — |
| `<^NET>` | Netzwerkparameter abfragen | `<SPORT…><SIPR…><GAR…><SUBR…><SHAR…>` |
| `<#SIPR…>` `<#GAR…>` `<#SUBR…>` `<#SHAR…>` | IP, Gateway, Maske, MAC setzen | jeweils bestaetigt |
| `<#NETDEFAULT>` | Netzwerk auf Werkszustand | — |

Eine serielle Antwort ist vollstaendig bei einem geschlossenen `<…>`-Paar am
Ende, einem Punkt am Ende oder dem Schalt-Echo — **nicht** bei einem nackten
`>`, das auch im Pfeil von `V:3 ->` steckt.

Die serielle Leitung erreicht die Bruecke entweder ueber ein TCP-Seriell-
Gateway (Moxa, USR-TCP232; `serial.transport: 'tcp'`, ein Client, je Befehl
eine Verbindung) oder einen Port am Bruecken-Rechner (`'port'`, ueber
`serialport`, also auch unter Windows).

## Welcher Weg wozu

| | HTTP | RS-232 |
|---|---|---|
| Umschalten | ja (Geraeteseite) | ja (Handbuch) |
| Darstellung, Audio | ja | ja |
| Status zuruecklesen | ja | nein |
| Einfrieren | nein | ja |

Das Handbuch dokumentiert das Umschalten fuer RS-232 und das Frontpanel; die
Geraeteseite setzt dieselben Befehle ueber HTTP ab. Beides schaltet an den
gemessenen Geraeten. Der Weg (`path`) ist eine Anlagen-Einstellung.

**Vertrauter Schaltbefehl.** Der Status kommt immer ueber HTTP. Wird seriell
geschaltet, hinkt er einen Poll nach; die Bruecke haelt den letzten seriellen
Schaltbefehl bis zu zwei Poll-Takte fuer wahr, bis der Status ihn bestaetigt —
sonst sprang die Programmreihe nach jedem Cut auf den alten Wert zurueck.

## Die zwoelf Darstellungen

`mode` ist die Nummer im Befehl (0-basiert); die Geraetetasten zaehlen ab 1.
Die Fensternummer ist das `data`-Attribut der Geraeteseite und damit das `y`
in `[x]V[y]`. Sie folgt **nicht** der Leserichtung: in Darstellung 5
(`mode 4`) ist Fenster 1 das kleine Bild und Fenster 2 das grosse; in 6 bis 9
ist es umgekehrt. `layouts.ts` traegt die Geometrie in Prozent; die Kopie in
`packages/web-rcp/src/lib/layouts.ts` haelt ein Test zeilengleich.

## Tally je Kamera

Jede Kamera nennt in ihrer Konfiguration ihren Mischer-Eingang
(`switcherInput`). Die Bruecke leitet daraus Programm/Vorschau ab und sendet
`{ type: 'cameraTally', tally: { [cameraNumber]: 'program' | 'preview' | 'off' } }`
— abgeleitet, nicht gespeichert. Der globale Companion-Tally bleibt daneben.

## Bruecken-Nachrichten

```
{ type: 'setSwitcherConfig', switcherNumber, switcherConfig }
{ type: 'connectSwitcher' | 'disconnectSwitcher' | 'removeSwitcher', switcherNumber }
{ type: 'switcherCommand', switcherNumber, cmd, params }
   cmd: preview {source} | cut | take {source} | route {source, window}
      | setLayout {mode} | setAudio {channel} | freeze {seconds} | refresh
→ { type: 'switchers', switchers: [{ switcherNumber, config, connected, state, inputLabels }] }
→ { type: 'switcherState', switcherNumber, state }
→ { type: 'cameraTally', tally }
```

Companion (HTTP `/api/action`): `switcherPreview`, `switcherTake`
(`{source}`), `switcherCut`.
