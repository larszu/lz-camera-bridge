# LZ Camera Bridge — lokal starten (Windows)
#
# ─── WAS GEMELDET WURDE (Nutzer, 2026-09-15) ────────────────────────────────
#
#   „intercom und kamerapult muss auch lokal laufen im av planner."
#
# ─── WARUM ES DIESE DATEI BRAUCHT ───────────────────────────────────────────
#
# `dev.sh` gibt es seit dem 2026-09-09 und es tut drei Dinge, die `npm run
# dev` nicht tut: es installiert fehlende Abhaengigkeiten, es raeumt die
# Bruecke beim Beenden ab, und es sagt, wo die Oberflaeche liegt. Auf Windows
# gab es davon nichts — dort blieb nur `npm run dev`, und das heisst hier
# woertlich `npm run bridge & npm run web`.
#
# GEMESSEN am 2026-09-15 an einem frischen Klon dieses Repos, mit genau dem
# Befehl, den der Start-Knopf der Suite absetzte:
#
#     sh: 1: tsx: not found
#     npm error command sh -c vite
#     EXIT=127
#
# `tsx` und `vite` liegen in `node_modules/.bin`. Wer das Repo frisch klont
# und auf „Lokal starten" drueckt, bekommt diese zwei Zeilen und sonst nichts.
#
# Das Gegenstueck zu `dev.sh`, Schalter fuer Schalter:
#
#     .\dev.ps1              Bruecke + Oberflaeche
#     .\dev.ps1 -Bridge      nur die Bruecke (fuer Companion / Tests)
#     .\dev.ps1 -Web         nur die Oberflaeche
param(
    [switch]$Bridge,
    [switch]$Web
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node ist nicht installiert. Node 20+ wird gebraucht."
    exit 1
}
$haupt = [int](node -p "process.versions.node.split('.')[0]")
if ($haupt -lt 20) {
    Write-Error "Node $(node --version) ist zu alt — 20+ wird gebraucht."
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "[bridge] npm install ..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Bridge) { npm run bridge; exit $LASTEXITCODE }
if ($Web)    { npm run web;    exit $LASTEXITCODE }

# Die Bruecke als eigener Prozess, die Oberflaeche im Vordergrund — und ein
# `finally`, das die Bruecke mitnimmt. Ohne das bleibt sie auf 9700 liegen
# und der naechste Start scheitert daran. Das ist dasselbe, was `dev.sh` mit
# seinem `trap` tut; PowerShell hat kein `trap` fuer Strg-C, wohl aber
# `try/finally` — das laeuft auch, wenn die Pipeline abgebrochen wird.
$bruecke = Start-Process -FilePath "npm.cmd" -ArgumentList "run","bridge" -NoNewWindow -PassThru

Write-Host ""
Write-Host "  Kamerapult laeuft."
Write-Host "    Oberflaeche:  http://localhost:3700/"
Write-Host "    Bruecke:      ws://localhost:9700  (die Adressen fuers Netz nennt sie selbst)"
Write-Host ""
Write-Host "  Ohne Kamera: im Reiter `"Demo (no camera)`" verbinden."
Write-Host ""

try {
    npm run web
} finally {
    if ($bruecke -and -not $bruecke.HasExited) {
        # /T nimmt die Kindprozesse mit: `npm run bridge` startet `tsx`, und
        # ein Kill nur auf npm liesse tsx auf dem Port sitzen.
        taskkill /PID $bruecke.Id /T /F 2>$null | Out-Null
    }
}
