#!/usr/bin/env bash
# Flash the board, with the safe build as the default.
#
# The habit is borrowed from larszu/photobooth and larszu/tally-pi: ship the
# deployment as a script rather than as instructions in a README, because the
# instructions are what drift.
#
#   ./tools/flash.sh              safe build — reads, drives nothing
#   ./tools/flash.sh --armed      drive compiled in (still needs arming at runtime)
#   ./tools/flash.sh --monitor    flash, then open the serial console
set -euo pipefail

ENV_NAME="waveshare-esp32-s3-eth"
MONITOR=0

for arg in "$@"; do
  case "$arg" in
    --armed)   ENV_NAME="waveshare-esp32-s3-eth-armed" ;;
    --monitor) MONITOR=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v pio >/dev/null || { echo "PlatformIO not found: pip install platformio" >&2; exit 1; }

if [ "$ENV_NAME" = "waveshare-esp32-s3-eth-armed" ]; then
  cat >&2 <<'WARN'
  ─────────────────────────────────────────────────────────────────
  ARMED BUILD. This firmware can move an iris.

  Flash it only once the readback of docs/b4/wiring.md §2 is proven and
  a calibration table exists. It still refuses to drive until armed
  over the API, but the drive path is live.
  ─────────────────────────────────────────────────────────────────
WARN
  read -r -p "  Continue? [y/N] " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { echo "aborted."; exit 1; }
fi

echo "building and uploading: $ENV_NAME"
pio run -e "$ENV_NAME" -t upload

if [ "$MONITOR" = "1" ]; then
  echo "opening console — the I2C scan runs at boot; press reset to see it."
  pio device monitor -e "$ENV_NAME"
fi
