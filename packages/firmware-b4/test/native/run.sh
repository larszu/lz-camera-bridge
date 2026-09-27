#!/usr/bin/env bash
# Host tests for the pure firmware headers. No ESP32, no lens, no PlatformIO:
# only a C++17 compiler. Run from anywhere; CI runs it in the firmware-b4 job.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for t in "$here"/test_*.cpp; do
  name="$(basename "$t" .cpp)"
  c++ -std=c++17 -Wall -Wextra -Werror -I"$here/stubs" -I"$here/../../src" "$t" -o "$out/$name"
  "$out/$name"
done
