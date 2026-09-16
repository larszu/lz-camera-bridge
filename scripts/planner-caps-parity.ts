// ───────────────────────────────────────────────────────────────────────────
// Bedarf 48 — der Guard gegen die zweite Wahrheit ueber die Kamera-Faehigkeiten.
// Lauf: `npm run caps:parity`
//
// WORUM ES GEHT. `packages/web-rcp/src/capabilities.ts` ist die Wahrheit
// darueber, welche Befehle jedes Backend WIRKLICH implementiert — der Kopf
// jener Datei sagt es selbst: „Mirrors exactly what each backend's
// handleRcpCommand actually implements."
//
// Der `multicam-planner` braucht dieselbe Auskunft zur PLANUNGSZEIT: er
// kennzeichnet Positionen, an denen sich Farbtemperatur oder Schwarzabgleich
// nicht fernstellen lassen (Bedarf 48). Importieren kann er sie nicht —
// getrennte Repos, und der Planer laeuft im Browser ohne jede Verbindung
// hierher. Er traegt deshalb eine KOPIE des Paint-Teils, in
// `src/utils/shadingCapability.ts` (`MODE_PAINT`), mit dieser Datei als
// benannter Herkunft.
//
// Eine Kopie, die niemand nachhaelt, ist nach dem zweiten Backend-Commit eine
// Falschauskunft — und zwar die teuerste Sorte: sie steht auf einem
// gedruckten Blatt und sagt einem Bildtechniker, er koenne vom Pult aus etwas
// einstellen, das dieses Repo gar nicht kennt.
//
// WARUM DER GUARD HIER LIEGT UND NICHT DORT. Erst stand er in der Suite, die
// ihre Nachbar-Repos ohnehin auscheckt. Gemessen (Lauf 34092050711): der
// Checkout von `larszu/lz-camera-bridge` scheitert dort an „Not Found" —
// dieses Repo ist privat, und `GITHUB_TOKEN` eines anderen Repos kommt nicht
// heran. Der Guard hat sich uebersprungen und der Job war gruen. Genau die
// Sorte Pruefung, die schlimmer ist als keine.
//
// Hier herum geht es auf: die Quelle ist lokal, und `larszu/multicam-planner`
// ist oeffentlich — sein Checkout gelingt mit dem Standard-Token. Geprueft
// wird ausserdem die richtige Seite: die Kopie gehoert im PLANER
// nachgezogen, nicht in einer vendorten Zwischenstufe.
//
// WARUM VERHALTEN UND NICHT TEXT. Aufgerufen wird `capabilitiesForMode` —
// dieselbe Funktion, die die Bedienoberflaeche fragt. Formatierung,
// Kommentare und Zeilenreihenfolge sind egal; was zaehlt, ist die Antwort.
// ───────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pfad } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = pfad(HIER, '..');

const argv = process.argv.slice(2);
const wert = (name: string, vorgabe: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : vorgabe;
};

/** Wo der Planer-Checkout liegt. In CI legt ihn der Workflow unter `upstream/`. */
const PLANER = pfad(REPO, wert('--planner', '../multicam-planner'));

const CAPS = pfad(REPO, 'packages/web-rcp/src/capabilities.ts');
const TYPEN = pfad(REPO, 'packages/web-rcp/src/types.ts');
const KOPIE = pfad(PLANER, 'src/utils/shadingCapability.ts');

if (!existsSync(KOPIE)) {
  // Laut, nicht still: ein Uebersprung ohne Satz liest sich im Log wie eine
  // bestandene Pruefung. In CI checkt der Workflow den Planer aus; bleibt
  // dieser Zweig dort stehen, ist der Workflow kaputt und nicht der Planer.
  console.log(
    `UEBERSPRUNGEN: kein multicam-planner-Checkout unter ${PLANER}.\n` +
      '  Die Paritaet der Faehigkeits-Tabelle wurde NICHT geprueft.\n' +
      '  In CI checkt der Workflow larszu/multicam-planner aus; lokal: git clone daneben.',
  );
  process.exit(0);
}

const bridge = (await import(pathToFileURL(CAPS).href)) as {
  capabilitiesForMode: (mode: string | undefined) => Record<string, boolean>;
};
const planer = (await import(pathToFileURL(KOPIE).href)) as {
  MODE_PAINT: Record<string, readonly string[]>;
  PAINT_FUNCTIONS: readonly string[];
  CONTROL_PATH_LABEL: Record<string, string>;
  BRIDGE_SOURCE: { repo: string; file: string; symbol: string; commit: string };
};

const fehler: string[] = [];

// ── 1. Welche Wege es gibt ────────────────────────────────────────────────
//
// `ConnectionMode` ist ein Typ und zur Laufzeit nicht da. Gelesen wird
// deshalb der Quelltext — eng umrissen, und mit einer Untergrenze abgesichert:
// eine Regex, die nichts findet, verglichen sonst zwei leere Mengen und
// meldete Erfolg.
const union = /export type ConnectionMode =([\s\S]*?);/.exec(readFileSync(TYPEN, 'utf8'));
if (!union) {
  console.error(
    `FEHLER: Typ ConnectionMode in ${TYPEN} nicht gefunden — Guard nicht durchfuehrbar.`,
  );
  process.exit(1);
}
/**
 * Wege, die es NUR HIER gibt und im Planer nichts zu suchen haben.
 *
 * `demo` ist eine Kamera, die nicht da ist — ein Werkzeug der Werkbank, um
 * das Pult ohne Hardware zu bedienen. Der Planer plant echte Aufbauten: dort
 * waere sie eine Kameraposition, die man auf ein Blatt drucken und aufbauen
 * kann. Genau das darf nicht sein.
 *
 * Die Liste steht hier und nicht im Planer, weil die Entscheidung hier
 * faellt — und sie steht als LISTE und nicht als `if`, damit der naechste
 * solche Weg eine Zeile mit Begruendung braucht und keinen Sonderfall im
 * Vergleich. Was nicht drinsteht, MUSS der Planer kennen; daran aendert sich
 * nichts.
 */
const NUR_WERKBANK: readonly string[] = ['demo'];

const bridgeWege = [...union[1].matchAll(/'([a-z0-9-]+)'/g)]
  .map((m) => m[1])
  .filter((w) => !NUR_WERKBANK.includes(w))
  .sort();
if (bridgeWege.length < 10) {
  console.error(
    `FEHLER: nur ${bridgeWege.length} Verbindungswege aus ${TYPEN} gelesen — das ist zu wenig, ` +
      'um eine Aussage zu sein. Hat sich die Schreibweise der Union geaendert?',
  );
  process.exit(1);
}

const planerWege = Object.keys(planer.CONTROL_PATH_LABEL)
  .filter((w) => w !== 'none')
  .sort();

for (const w of bridgeWege) {
  if (!planerWege.includes(w)) {
    fehler.push(`Weg "${w}" gibt es hier, aber nicht in der Kopie des Planers.`);
  }
}
for (const w of planerWege) {
  if (!bridgeWege.includes(w)) {
    fehler.push(`Weg "${w}" steht im Planer, dieses Repo kennt ihn nicht (mehr).`);
  }
}

// Die Gegenprobe zur Ausnahme: ein Werkbank-Weg darf NICHT im Planer stehen.
// Ohne sie waere `NUR_WERKBANK` eine Einbahnstrasse — der Weg fiele hier aus
// dem Vergleich und koennte im Planer trotzdem auftauchen, ohne dass es
// jemand meldet.
for (const w of NUR_WERKBANK) {
  if (planerWege.includes(w)) {
    fehler.push(
      `Weg "${w}" ist ein Werkbank-Weg und steht trotzdem im Planer. Er gehoert ` +
        'dort nicht hin: der Planer plant Aufbauten, und eine Kamera, die es ' +
        'nicht gibt, laesst sich nicht aufbauen.',
    );
  }
}

// ── 2. Sind die Paint-Namen ueberhaupt echte Felder? ──────────────────────
//
// Ohne diese Probe verglichen sich Tippfehler mit `undefined` — und
// `undefined === false` ist wahr. Der Guard waere dann fuer genau die Spalte
// blind, die jemand falsch geschrieben hat.
const alleFelder = bridge.capabilitiesForMode(undefined);
for (const fn of planer.PAINT_FUNCTIONS) {
  if (!(fn in alleFelder)) {
    fehler.push(
      `Paint-Funktion "${fn}" ist kein Feld von CameraCapabilities — die Spalte prueft nichts.`,
    );
  }
}

// ── 3. Die eigentliche Paritaet ───────────────────────────────────────────
for (const weg of bridgeWege.filter((w) => planerWege.includes(w))) {
  const echt = bridge.capabilitiesForMode(weg);
  const kopie = planer.MODE_PAINT[weg] ?? [];
  for (const fn of planer.PAINT_FUNCTIONS) {
    if (!(fn in alleFelder)) continue; // schon oben gemeldet
    const soll = echt[fn] === true;
    const ist = kopie.includes(fn);
    if (soll !== ist) {
      fehler.push(
        `${weg}.${fn}: dieses Repo sagt ${soll ? 'JA' : 'NEIN'}, die Kopie sagt ${ist ? 'JA' : 'NEIN'}.`,
      );
    }
  }
}

// ── 4. „von Hand am Body" ist leer, und bleibt es ─────────────────────────
if ((planer.MODE_PAINT.none ?? []).length > 0) {
  fehler.push('MODE_PAINT.none ist nicht leer — „von Hand am Body" kann nichts fernsteuern.');
}

// ── 5. Zeigt die Herkunftsangabe dorthin, wo wirklich geprueft wurde? ─────
if (planer.BRIDGE_SOURCE.repo !== 'lz-camera-bridge') {
  fehler.push(
    `BRIDGE_SOURCE.repo ist "${planer.BRIDGE_SOURCE.repo}", geprueft wurde lz-camera-bridge.`,
  );
}
if (!CAPS.endsWith(planer.BRIDGE_SOURCE.file)) {
  fehler.push(
    `BRIDGE_SOURCE.file ist "${planer.BRIDGE_SOURCE.file}", geprueft wurde ${CAPS}. ` +
      'Die Angabe auf dem Blatt zeigt woandershin als der Guard.',
  );
}

if (fehler.length > 0) {
  console.error(
    'FEHLER: die Faehigkeits-Tabelle des multicam-planners weicht von diesem Repo ab ' +
      `(${fehler.length} Abweichung(en)):\n` +
      fehler.map((f) => `  · ${f}`).join('\n') +
      '\n\nZu tun: `MODE_PAINT` in src/utils/shadingCapability.ts des multicam-planners ' +
      'nachziehen und BRIDGE_SOURCE.commit auf den neuen Stand setzen. Danach die ' +
      'vendorte Kopie in av-planner-suite mitziehen (`npm run drift`).',
  );
  process.exit(1);
}

console.log(
  `OK: ${bridgeWege.length} Verbindungswege × ${planer.PAINT_FUNCTIONS.length} Paint-Funktionen ` +
    'gegen den multicam-planner geprueft — seine Kopie stimmt.',
);
