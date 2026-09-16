#!/usr/bin/env bash
# Sony Camera Bridge — lokal starten (Linux / macOS)
#
# ─── WAS GEMELDET WURDE (Nutzer, 2026-09-09) ────────────────────────────────
#
#   „Ebenso auch Kamerapult [muss man lokal starten koennen]."
#
# ─── WAS VORHER FEHLTE ──────────────────────────────────────────────────────
#
# `npm run dev` startete schon immer. Was es nicht konnte, war ETWAS ZEIGEN:
# jeder Weg in `backendFactory` braucht eine echte Adresse — eine CCU auf
# TCP, ein VISCA-Port, ein USB-Geraet im PC-Remote-Modus. Ohne eines davon
# kam das Pult leer hoch und jeder Regler war tot. Man konnte das RCP nicht
# sehen, den Joystick nicht probieren, kein Layout auf einem Notebook pruefen.
#
# Dazu kam die Form: `npm run dev` haengt die Bruecke mit `&` an und laesst
# sie stehen. Ein Strg-C beendet nur die Oberflaeche; die Bruecke bleibt auf
# Port 9700 liegen und der naechste Start scheitert daran.
#
# Dieses Skript raeumt auf (`trap`) und waehlt den Demo-Weg als Vorgabe.
#
#     ./dev.sh              Bruecke + Oberflaeche, Demo-Kamera vorgewaehlt
#     ./dev.sh --bridge     nur die Bruecke (fuer Companion / Tests)
#     ./dev.sh --web        nur die Oberflaeche

set -euo pipefail
cd "$(dirname "$0")"

WAS="beides"
for arg in "$@"; do
  case "$arg" in
    --bridge) WAS="bridge" ;;
    --web)    WAS="web" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unbekannter Schalter: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node ist nicht installiert. Node 20+ wird gebraucht." >&2
  exit 1
fi
HAUPT="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$HAUPT" -lt 20 ]; then
  echo "Node $(node --version) ist zu alt — 20+ wird gebraucht." >&2
  exit 1
fi

[ -d node_modules ] || { echo "[bridge] npm install ..."; npm install; }

case "$WAS" in
  bridge) exec npm run bridge ;;
  web)    exec npm run web ;;
esac

# Die Bruecke im Hintergrund, die Oberflaeche im Vordergrund — und ein
# `trap`, der die Bruecke mitnimmt. Ohne ihn bleibt sie auf 9700 liegen.
npm run bridge &
BRIDGE=$!
aufraeumen() {
  kill "$BRIDGE" 2>/dev/null || true
  wait "$BRIDGE" 2>/dev/null || true
}
trap aufraeumen EXIT INT TERM

echo
echo "  Kamerapult laeuft."
# 3700 und nicht 5173: `packages/web-rcp/vite.config.ts` setzt `server.port`
# ausdruecklich. Hier stand Vites Vorgabe — ein Satz, der die Konfiguration
# daneben nicht gelesen hat, und die Suite oeffnet 3700.
echo "    Oberflaeche:  http://localhost:3700/"
echo "    Bruecke:      ws://localhost:9700  (die Adressen fuers Netz nennt sie selbst)"
echo
echo "  Ohne Kamera: im Reiter „Demo (no camera)\" verbinden."
echo

npm run web
