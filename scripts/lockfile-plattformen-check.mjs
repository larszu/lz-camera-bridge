/**
 * Traegt die package-lock.json die Plattformen, auf denen wir BAUEN?
 *
 * DER FALL, GEGEN DEN DAS GESCHRIEBEN IST, ist am 2026-09-16 passiert und
 * hat einen vollen Release-Lauf gekostet. Jemand (ich) hat die Lockfile mit
 * `rm package-lock.json && npm install` neu erzeugt -- unter Linux. npm
 * schreibt bei einem frischen Install nur die optionalen Pakete in die
 * Lockfile, die zur LAUFENDEN Plattform passen. Von 25 `@rollup/rollup-*`
 * blieben zwei uebrig, beide linux-x64.
 *
 * Lokal faellt das NIE auf: hier ist Linux die Plattform. Auf den
 * Windows- und macOS-Runnern starb dann `vite build` mit
 *
 *     Cannot find module @rollup/rollup-darwin-arm64
 *     requireStack: [ .../node_modules/rollup/dist/native.js ]
 *
 * -- in BEIDEN Jobs, bevor ueberhaupt eine Datei entstand. Ein Fehler, der
 * ausschliesslich dort auftritt, wo man ihn am teuersten bemerkt.
 *
 * DIE ABHILFE ist `npm install --package-lock-only` bei ABWESENDEM
 * node_modules: dann loest npm den vollen Baum auf, statt gegen den
 * installierten abzugleichen, und alle Plattformen stehen drin. Das ist
 * nicht offensichtlich, deshalb steht es hier und nicht nur im Commit.
 *
 * Geprueft wird ABSICHTLICH nur gegen die Plattformen, auf denen dieses Repo
 * wirklich baut (siehe release.yml: windows-latest, macos-latest, plus Linux
 * fuer die CI). Eine Liste aller denkbaren Tripel waere Pflegeaufwand ohne
 * Ertrag -- fehlt ein freebsd-Paket, baut hier nichts schief.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const LOCK = resolve(HIER, '..', 'package-lock.json');

/**
 * Pakete, die ihre Binaerdatei je Plattform in einem EIGENEN optionalen
 * Paket ausliefern. Genau die verliert ein plattform-lokaler Install.
 * (`serialport` gehoert NICHT dazu: es liefert seine Prebuilds als Dateien
 * IM Paket und ist deshalb von diesem Fehler nicht betroffen.)
 */
const FAMILIEN = ['@rollup/rollup', '@esbuild'];

/** Worauf dieses Repo baut. release.yml: windows-latest + macos-latest. */
const GEFORDERT = [
  { name: 'macOS (Apple Silicon)', muster: /(darwin-arm64)/ },
  { name: 'macOS (Intel)', muster: /(darwin-x64)/ },
  { name: 'Windows (x64)', muster: /(win32-x64)/ },
  { name: 'Linux (x64)', muster: /(linux-x64)/ },
];

const roh = readFileSync(LOCK, 'utf8');
const lock = JSON.parse(roh);
const pfade = Object.keys(lock.packages ?? {});

const fehler = [];
for (const familie of FAMILIEN) {
  const treffer = pfade.filter((p) => p.includes(`node_modules/${familie}`));
  if (treffer.length === 0) continue; // Familie gar nicht im Baum -- nichts zu pruefen
  for (const { name, muster } of GEFORDERT) {
    if (!treffer.some((p) => muster.test(p))) {
      fehler.push(`${familie}: kein Paket fuer ${name}`);
    }
  }
}

if (fehler.length > 0) {
  console.error('FEHLER: der package-lock.json fehlen Plattform-Pakete:\n');
  for (const f of fehler) console.error(`  · ${f}`);
  console.error(
    '\nSo entsteht das: `rm package-lock.json && npm install` schreibt nur die\n' +
      'optionalen Pakete der LAUFENDEN Plattform. Lokal faellt es nie auf, auf den\n' +
      'Windows- und macOS-Runnern stirbt `vite build` mit "Cannot find module\n' +
      '@rollup/rollup-darwin-arm64".\n\n' +
      'So wird es behoben:\n' +
      '  rm -rf node_modules package-lock.json\n' +
      '  npm install --package-lock-only\n' +
      '  npm ci\n\n' +
      'Das `--package-lock-only` OHNE node_modules ist der Punkt: dann loest npm\n' +
      'den vollen Baum auf, statt gegen den installierten abzugleichen.',
  );
  process.exit(1);
}

const gezaehlt = FAMILIEN.map((f) => {
  const n = pfade.filter((p) => p.includes(`node_modules/${f}`)).length;
  return `${f}: ${n}`;
}).join(', ');
console.log(`OK: package-lock.json traegt alle Bau-Plattformen (${gezaehlt}).`);
