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
#   ./tools/flash.sh --devkit     classic ESP32 DevKit instead of the S3-ETH
#                                 (combine with --armed / --monitor)
set -euo pipefail

BOARD="waveshare-esp32-s3-eth"
ARMED=0
MONITOR=0

for arg in "$@"; do
  case "$arg" in
    --armed)   ARMED=1 ;;
    --devkit)  BOARD="esp32-devkit" ;;
    --monitor) MONITOR=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ENV_NAME="$BOARD"
[ "$ARMED" = "1" ] && ENV_NAME="$BOARD-armed"

command -v pio >/dev/null || { echo "PlatformIO not found: pip install platformio" >&2; exit 1; }

if [ "$ARMED" = "1" ]; then
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
