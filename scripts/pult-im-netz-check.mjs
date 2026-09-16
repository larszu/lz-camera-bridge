#!/usr/bin/env node
// ───────────────────────────────────────────────────────────────────────────
// Ist das Pult im Netz erreichbar? — Lauf: `npm run netz:check`
//
// ─── DER BEFUND (gemessen 2026-09-15) ──────────────────────────────────────
//
// `BridgeServer.start()` bindet JEDE Schnittstelle und nennt beim Start die
// LAN-Adressen. Der Grund steht im Quelltext daneben:
//
//     "A control surface on a tablet is the normal case for this
//      application, not the exception, and whoever sets it up has to be
//      told where to point it."
//
// Die OBERFLAECHE, die dieses Tablet oeffnen soll, lag dagegen auf
// `localhost`. Vite sagte es bei jedem Start selbst — „Network: use --host
// to expose" — und niemand las es als Befund. Die Bruecke nannte also
// `ws://192.168.1.42:9700`, und unter `http://192.168.1.42:3700` stand
// nichts.
//
// EINE ZUSAGE, DIE ZUR HAELFTE EINGELOEST IST, IST KEINE. Wer sie liest,
// baut darauf; wer sie aufbaut, steht vor einer Seite, die nicht aufgeht,
// und sucht den Fehler im WLAN.
//
// ─── WAS DIESER LAUF PRUEFT ────────────────────────────────────────────────
//
// Dass die beiden Haelften zusammenbleiben:
//
//   1. der Entwicklungsserver der Oberflaeche bindet nicht nur `localhost`
//      (`server.host` ist gesetzt),
//   2. die Bruecke bindet weiterhin jede Schnittstelle (`listen(port)` ohne
//      Host) und nennt die Adressen,
//   3. der Starter nennt die Netz-Adresse der Oberflaeche, nicht nur
//      `localhost` — eine Adresse, die nirgends steht, kann niemand raten.
//
// ─── WAS ER NICHT KANN ─────────────────────────────────────────────────────
//
// Er liest den Quelltext. Ob ein Tablet im Hallen-WLAN wirklich durchkommt,
// haengt an Client-Isolation, Firewall und VLAN — davon weiss diese Datei
// nichts, und sie behauptet auch nichts darueber. Geprueft ist die
// Voraussetzung, nicht die Wirkung.
// ───────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (p) => readFileSync(join(WURZEL, p), 'utf8');

const ohneKommentare = (quelle) =>
  quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((z) => !z.trim().startsWith('//') && !z.trim().startsWith('#'))
    .join('\n');

const befunde = [];

// ── 1. Die Oberflaeche ────────────────────────────────────────────────────
const vite = ohneKommentare(lies('packages/web-rcp/vite.config.ts'));
if (!/\bhost\s*:/.test(vite)) {
  befunde.push(
    'packages/web-rcp/vite.config.ts: `server.host` fehlt — die Oberflaeche ' +
      'bindet nur localhost. Die Bruecke ist im Netz, das Pult nicht; ein ' +
      'Tablet bekommt die Seite nicht auf.',
  );
}

// ── 2. Die Bruecke ────────────────────────────────────────────────────────
const bridge = ohneKommentare(lies('packages/bridge/src/BridgeServer.ts'));
// DAS MUSTER MUSS DEN HOST AUSSCHLIESSEN, nicht nur das Komma sehen.
// Gegengeprobt am 2026-09-15: der erste Anlauf verlangte
// `listen(this.wsPort,` — und `listen(this.wsPort, '127.0.0.1', …)` erfuellt
// das. Genau der Fall, den dieser Lauf fangen soll, rutschte damit durch.
// Jetzt muss auf den Port unmittelbar die Rueckruffunktion folgen; steht
// dort ein String, ist eine Adresse gebunden.
if (!/listen\(\s*this\.wsPort\s*,\s*(?:\(\s*\)\s*=>|function\b)/.test(bridge)) {
  befunde.push(
    'packages/bridge/src/BridgeServer.ts: `listen` bindet nicht mehr jede ' +
      'Schnittstelle — dann erreicht ein Pult-Tablet die Bruecke nicht, ' +
      'auch wenn die Oberflaeche aufgeht.',
  );
}
if (!/networkInterfaces\(\)/.test(bridge)) {
  befunde.push(
    'packages/bridge/src/BridgeServer.ts: die LAN-Adressen werden nicht mehr ' +
      'genannt. Eine Adresse, die nirgends steht, kann niemand raten.',
  );
}

// ── 3. Der Starter ────────────────────────────────────────────────────────
const dev = lies('dev.sh');
if (!/networkInterfaces/.test(dev)) {
  befunde.push(
    'dev.sh nennt die Netz-Adresse der Oberflaeche nicht — es bleibt bei ' +
      '`localhost`, und wer ein Tablet aufbaut, sucht sie sich aus `ip addr`.',
  );
}

if (befunde.length) {
  console.error('netz:check ROT');
  for (const b of befunde) console.error('  - ' + b);
  process.exit(1);
}

console.log(
  'OK netz:check — Bruecke und Oberflaeche sind beide im Netz, und beide ' +
    'Adressen stehen beim Start da.',
);
console.log(
  'NICHT gemessen: ob ein Tablet im Hallen-WLAN wirklich durchkommt. Das ' +
    'haengt an Client-Isolation, Firewall und VLAN — geprueft ist die ' +
    'Voraussetzung im Quelltext, nicht die Wirkung im Netz.',
);
