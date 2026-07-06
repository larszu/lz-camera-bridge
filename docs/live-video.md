# Live-Video-Einbindung — Machbarkeit pro Kamera-Familie

Dieses Dokument hält fest, wo Live-Video in den Kamera-Karten (Einzelansicht
und Multiview) technisch machbar ist, welcher Aufwand dahinter steckt und wie
eine saubere Integration in die bestehende Bridge aussähe.

> **Status:** Analyse/Planung. Es ist noch **kein** Video-Pfad im Code
> implementiert — die Steuerung (RCP/PTZ) ist unberührt davon.

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
