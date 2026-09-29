# Live-Video-Einbindung — Machbarkeit pro Kamera-Familie

Dieses Dokument hält fest, wo Live-Video in den Kamera-Karten (Einzelansicht
und Multiview) technisch machbar ist, welcher Aufwand dahinter steckt und wie
eine saubere Integration in die bestehende Bridge aussähe.

> **Status (2026-09-28):** Kategorie 2 ist gebaut. `packages/bridge/src/multiview/RtspHub.ts`
> holt jeden RTSP-Stream mit einem ffmpeg, verkleinert ihn und liefert ihn als
> `multipart/x-mixed-replace` unter `GET /video/<n>.mjpeg` auf dem Port der
> Bruecke; die Ansicht *Video* zeigt ihn in einem `<img>`. Ein ffmpeg je Stream,
> geteilt von allen Kacheln; die Adresse bleibt in der Bruecke. Kategorie 1
> (MJPEG direkt) und 3 (Sony SDK) sind weiter offen. Die go2rtc-/mpv-/VLC-
> Generatoren (`multiviewGenerators.ts`) bleiben fuer den Weg ohne Bruecke.

## Scopes

> **Stand 2026-09-29.** Jede Videokachel hat einen Schalter *Scopes*. Er
> oeffnet unter der Kachel Waveform (Luma) und Vectorscope aus
> [LZ Scopes](https://github.com/larszu/lz-scopes), eingebettet unter
> `packages/web-rcp/src/vendor/lz-scopes` (Quelle, Commit und Abgleich in
> dessen `VENDOR.md`). Der Kopf jedes Panels schaltet auf RGB-/YRGB-/YCbCr-
> Parade, Histogramm, CIE oder Bild um; *4 scopes* zeigt Waveform,
> Vectorscope, Parade und Histogramm fensterfuellend (`Esc` schliesst).

**Weg.** `WS /scope/<n>` auf dem Port der Bruecke
(`packages/bridge/src/multiview/ScopeStream.ts`), `n` ist die Kameranummer
wie bei `/video/<n>.mjpeg`; die Stream-Adresse bleibt in der Bruecke, und
dieselbe Pruefung auf private Netze gilt. Die Bruecke spricht das
Frame-Protokoll von LZ Scopes: zuerst `{"type":"info",…}` mit Analyse- und
Quellgroesse, Codec und Farbangaben, dann je Bild eine Binaernachricht mit
`width × height × 4` Werten R, G, B, A (8 bit als Uint8, 16 bit als
Uint16 LE), einmal pro Sekunde `{"type":"stats","sent","dropped"}`, am Ende
`{"type":"error"|"end","message"}`.

| Query | Werte | Vorgabe |
|---|---|---|
| `depth` | `8` (`rgba`) oder `16` (`rgba64le`, fuer 10-bit-Quellen) | `8` |
| `width` | Analysebreite in px, 0 = nativ, hoechstens 3840; nie hochskaliert | `960` |
| `fps` | Bildrate begrenzen, 0 = wie die Quelle | `0` |

**Warum ein eigener ffmpeg und nicht das MJPEG der Kachel.** Ein Scope misst
Pegel; JPEG quantisiert sie neu und verschmiert mit der Farbunterabtastung
das Vectorscope. Deshalb dekodiert jeder offene Scope mit einem eigenen
ffmpeg zu rohem R'G'B', und zwar nur, solange der Client verbunden ist.
Schliesst das Panel, beendet die Bruecke den Prozess. Der MJPEG-Weg bleibt
davon unberuehrt. Folge: **jeder offene Scope ist eine weitere
RTSP-Sitzung an der Kamera.** Die Bruecke laesst hoechstens vier gleichzeitig
zu (`MAX_SCOPES`).

**Farbmatrix.** Groesse und Farbangaben holt ffprobe; fehlt ffprobe (die
Desktop-App bringt nur ffmpeg mit), liest die Bruecke dieselben Angaben aus
ffmpegs Stream-Zeile. Die Y'CbCr-Matrix wird ffmpeg **ausdruecklich**
vorgegeben (`scale=…:in_color_matrix=…:in_range=…`), weil swscale bei
ungetaggten Streams BT.601 annimmt und damit jede ungetaggte HD-Kamera im
Vectorscope verdreht: getaggter Wert zuerst, sonst BT.709 ueber SD-Hoehe
(> 576 Zeilen) und BT.601 darunter, BT.2020 wenn so getaggt. Range `pc` ist
Full Range, alles andere Limited. Die Transferfunktion bleibt unangetastet,
PQ und HLG kommen als Codewerte an.

**Gegendruck.** Liegen im Socket schon mehr als zwei Bilder, verwirft die
Bruecke das naechste, statt eine Warteschlange aufzubauen; die Zahl steht
in `stats.dropped` und in der Kopfzeile des Panels.

Gemessen 2026-09-29 am Mac gegen MediaMTX mit `testsrc2` 1920×1080/25p,
H.264 ungetaggt: `info` meldet `decodeMatrix: bt709`, Bilder 960×540×4 Byte
(8 bit), 640×360×8 Byte (`depth=16&width=640`) und 1920×1080×4 Byte
(`width=0`), jeweils rund 25 Bilder/s, kein verworfenes Bild bei einem
Node-Client, erstes Bild nach rund 3 s (Probe + erstes Schluesselbild);
nach dem Schliessen laeuft kein ffmpeg mehr.

## Die eine harte Randbedingung: der Browser

Das UI läuft im Browser, und ein Browser kann **nur** ein paar Transporte
nativ abspielen:

| Transport | Browser-fähig? | Wie eingebettet |
|---|---|---|
| **MJPEG / JPEG-Frames** | ✅ direkt | `<img>` bzw. Canvas |
| **HLS** | ✅ (nativ Safari, sonst hls.js) | `<video>` + hls.js |
| **WebRTC** | ✅ | `RTCPeerConnection` → `<video>` |
| **RTSP** | ❌ | muss transkodiert werden |
| **NDI** | ❌ | muss transkodiert werden |
| **SRT** | ❌ | muss transkodiert werden |
| **SDI / Glasfaser** | ❌ (kein IP) | externer Encoder/Capture nötig |

Daraus ergeben sich drei Kategorien.

## Kategorie 1 — direkt einbettbar (kein Transcoding)

Diese Familien liefern MJPEG/JPEG-Frames über HTTP. Sie lassen sich als
`<img>`/Canvas-Tile direkt in die Kamera-Karte legen; Host/Port stehen bereits
in der Slot-Config (`canonHost`, `camHost`, …).

| Familie | Quelle | Aufwand |
|---|---|---|
| **Canon CCAPI** | `/ccapi/verXXX/shooting/liveview` (JPEG-Frames) | gering |
| **Panasonic AW PTZ** (AW-UE…) | `http://<ip>/cgi-bin/mjpeg` bzw. Live-JPEG | gering |
| **Z CAM** | HTTP-MJPEG-Preview | gering–mittel |

## Kategorie 2 — machbar, aber Bridge muss transkodieren

Native IP-Kameras mit **RTSP/NDI/SRT**. Das Video ist vorhanden, aber der
Browser kann es nicht direkt spielen. Die Bridge müsste per **ffmpeg → WebRTC**
(niedrige Latenz, ~0,2–0,5 s) **oder → HLS** (simpler, ~2–6 s Delay) umsetzen,
z. B. mit eingebettetem `go2rtc`/MediaMTX.

| Familie | Video-Quelle |
|---|---|
| **BirdDog** | NDI/RTSP (Encoder ist der Kern des Geräts) |
| **VISCA-PTZ-Köpfe** (Sony SRG/BRC, generisch) | RTSP/NDI/SDI, getrennt von der VISCA-Steuerung |
| **JVC** (Connected Cam) | RTSP |

Merke: VISCA/CGI = **nur Steuerung**. Das Video kommt bei diesen Geräten aus
dem separaten Streaming-Teil der Kamera, nicht aus dem Steuerpfad.

## Kategorie 3 — Sony über das Camera Remote SDK

Für die **Alpha-/Cinema-Line** (FX3, FX6, FX9, FX30, BURANO, α-Bodies) liefert
Sonys offizielles **Camera Remote SDK** Live-Bild — das ist der Mechanismus
hinter *Monitor & Control* und *Imaging Edge*.

- Das SDK stellt **LiveView als JPEG-Frames** bereit (`GetLiveViewImage`),
  kein RTSP/H.264 — ein Frame-Feed, wie das Monitoring in der M&C-App.
- Passt ideal zur Architektur: die Bridge hält die SDK-Session und schiebt die
  JPEG-Frames über den **bereits vorhandenen WebSocket** an dasselbe Video-Tile
  wie Kategorie 1. Kein Transcoder nötig.
- Funktioniert über **USB-C-Tether** und bei unterstützten Bodies über
  **LAN/WiFi**.

**Der ehrliche Haken:**

1. Das SDK ist **nativer C++-Code** (`libCr_Core` + Adapter-Libs). Node/
   TypeScript braucht dafür ein **natives N-API-Addon** mit plattformspezifischen
   Binaries (Linux/Win/macOS).
2. **Sony-Registrierung nötig** — das SDK muss bei Sony angefragt und dessen
   Lizenz akzeptiert werden; es lässt sich nicht als npm-Dependency ziehen.
3. **Frame-basiert** — Auflösung/FPS sind SDK-limitiert (Monitoring-Qualität,
   kein Ersatz für den SDI-Programmweg).

> Der vorhandene `SonyMncClient` ist reverse-engineered, **nicht auf Hardware
> verifiziert** und zieht **kein Video** — er pollt nur eine HTTP-State-API. Er
> ist damit *kein* Ersatz für den SDK-Weg.

## Kategorie 4 — braucht externe Hardware

Hier gibt es aus dem Steuerpfad **kein** IP-Video:

| Familie | Warum | Lösung |
|---|---|---|
| **Sony CCU / 700PTP** (Broadcast) | Video über SDI/Glasfaser zur CCU, nicht über die Steuerverbindung | externer SDI→NDI/SRT-Encoder |
| **Blackmagic** (Studio/URSA über Ethernet) | REST-API steuert nur, Video ist SDI | Capture/Encoder |
| **Sony USB (generisches PTP)** | PTP-LiveView niedrig aufgelöst/wackelig | eher Notlösung; besser Kat. 3 (SDK) |

## Geplante Integration

Ein **Video-Tile** pro Kamera-Karte (Einzelansicht + Multiview), das je nach
Backend gefüllt wird:

```
Kat. 1 (MJPEG)   ─ Browser lädt Stream-URL direkt ──────────────▶ <img>-Tile
Kat. 3 (Sony)    ─ Bridge (SDK-Session) ─ JPEG-Frames über WS ──▶ <img>/Canvas-Tile
Kat. 2 (RTSP/NDI)─ Bridge (ffmpeg/go2rtc) ─ WebRTC/HLS ─────────▶ <video>-Tile
Kat. 4           ─ kein Stream ─────────────────────────────────▶ „kein Video verfügbar"
```

Empfohlene Reihenfolge:

1. **Video-Tile-UI + Kategorie 1** (MJPEG für Canon/Panasonic-AW/Z-CAM) —
   sofort lauffähig, keine neue Runtime-Abhängigkeit. Baut die Tile-
   Infrastruktur, die alle weiteren Kategorien mitbenutzen.
2. **Sony Camera Remote SDK** als eigenes Paket (`packages/sony-sdk-native`),
   sobald das SDK vorliegt — forwardet Frames in dasselbe Tile.
3. **Kategorie 2** (RTSP/NDI → WebRTC via go2rtc) als größerer Ausbau für die
   PTZ-/BirdDog-/JVC-Welt.

## Zusammenfassung

| Familie | Live-Video | Weg |
|---|---|---|
| Canon CCAPI | ✅ einfach | MJPEG direkt |
| Panasonic AW PTZ | ✅ einfach | MJPEG direkt |
| Z CAM | ✅ einfach | MJPEG direkt |
| Sony Alpha/FX | ✅ mittel | Camera Remote SDK (natives Addon) |
| BirdDog | ⚙️ Transcoder | RTSP/NDI → WebRTC |
| VISCA-PTZ (SRG/BRC) | ⚙️ Transcoder | RTSP/NDI → WebRTC |
| JVC | ⚙️ Transcoder | RTSP → WebRTC |
| Sony CCU (700PTP) | ❌ | externer SDI-Encoder |
| Blackmagic | ❌ | externer SDI-Capture |
