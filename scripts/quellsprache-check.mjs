// ───────────────────────────────────────────────────────────────────────────
// Die Quellsprache dieses Repos — erklaert, und der Sprachmix gedeckelt
// (E-17/E-20, B-26).
//
// DIE ENTSCHEIDUNG (Eigentuemer, 2026-09-08): ENGLISCH ist die Quellsprache
// dieses Repos — und zwar nach dem Bestand, nicht nach dem Wunsch: gemessen
// 140 englische gegen 32 deutsche Stellen. Die Oberflaeche ist ein
// RCP-Dashboard fuer Technik, deren Vokabular ohnehin englisch ist (Iris,
// Gain, ND, Paint). 140 Stellen ins Deutsche umzuschreiben, um dann „Blende"
// neben `WB` zu setzen, kostet Arbeit und verschlechtert das Ergebnis.
//
// WAS DAS PROBLEM IST (B-26). Es ist kein Uebersetzungsrueckstand, sondern ein
// UNEINHEITLICHES PRODUKT: `ConnectionPanel` beschriftet „Kamera IP
// (WiFi/LAN)" und „Kamera-Nr." zwischen englischen Feldern, der
// `FirstStartWizard` fragt auf Deutsch und listet darunter englische
// Beschreibungen. Ein Nutzer kann sich auf keine Sprache verlassen, und es
// gibt keinen Schalter, mit dem er etwas daran aendern koennte.
//
// WAS DIESER LAUF DESHALB TUT — UND WAS ER NICHT BEHAUPTET. Er misst die
// deutschen Zeichenketten und haelt ihre Zahl bei DER GRENZE, die beim
// Einfuehren gemessen wurde. Er behauptet NICHT, das Produkt sei einsprachig:
// es ist es nicht, und die Grenze sagt das laut. Sie hat einen Zweck und nur
// den einen: der Mix darf nicht WACHSEN, waehrend B-26 offen ist. Wer
// uebersetzt, setzt die Grenze herunter — das ist die einzige erlaubte
// Richtung, und der Lauf verlangt es aktiv, sobald sie unterschritten wird.
//
// Und er schaltet sich selbst scharf: sobald `t('key', 'Fallback')`-Aufrufe
// auftauchen (also i18n eingezogen wird), misst er zusaetzlich die Fallbacks
// und faellt bei jedem deutschen.
// ───────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname
const UI = join(ROOT, 'packages', 'web-rcp', 'src')

/**
 * Die Grenze: so viele deutsche Zeichenketten standen am 2026-09-08 in der
 * Oberflaeche. Nach OBEN ist sie ein Fehler, nach UNTEN ebenfalls — wer
 * uebersetzt, traegt die neue Zahl hier ein, sonst verliert die Grenze beim
 * naechsten Mal ihre Bedeutung.
 */
const GRENZE = 19

/** Woerter, die es NUR im Deutschen gibt. */
const DEUTSCH = [
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'nicht', 'kein',
  'keine', 'keinen', 'ist', 'sind', 'wird', 'werden', 'wurde', 'für', 'fuer',
  'mit', 'von', 'vom', 'zum', 'zur', 'beim', 'aus', 'eine', 'einen', 'einem',
  'einer', 'nur', 'noch', 'schon', 'wenn', 'dann', 'auch', 'kann', 'muss',
  'darf', 'soll', 'sollen', 'steht', 'gibt', 'sich', 'dieser', 'diese',
  'dieses', 'nach', 'bei', 'über', 'ueber', 'ohne', 'durch', 'gegen', 'sowie',
  'damit', 'wieder', 'immer', 'jede', 'jeder', 'jedes', 'alle', 'allen',
  'wählen', 'wähle', 'möchtest', 'einrichten', 'Gerät', 'Geräte', 'Kamera',
]

/**
 * Woerter, die es NUR im Englischen gibt.
 *
 * `a`, `an`, `was`, `will`, `also`, `in`, `so`, `man` und `only` fehlen in
 * beiden Listen mit Absicht: sie kommen in beiden Sprachen vor (oder in
 * Fachbegriffen wie „read-only") und meldeten in einer fruehen Fassung im
 * cable-planner deutsche Zeilen als englisch. Ein Waechter, der bei richtigen
 * Zeilen anschlaegt, wird abgeschaltet und nicht gelesen.
 */
const ENGLISCH = [
  'the', 'and', 'not', 'with', 'for', 'from', 'this', 'that', 'these',
  'those', 'your', 'you', 'are', 'been', 'have', 'has', 'if', 'then', 'than',
  'when', 'which', 'what', 'who', 'how', 'there', 'into', 'about', 'before',
  'after', 'each', 'every', 'any', 'some', 'please', 'cannot', 'does',
  'doesn', 'isn', 'aren', 'would', 'should', 'could', 'must', 'select',
  'missing', 'unknown',
]

const wortMuster = (woerter) =>
  new RegExp(`(^|[^\\p{L}])(${woerter.join('|')})([^\\p{L}]|$)`, 'iu')

const DE_MUSTER = wortMuster(DEUTSCH)
const EN_MUSTER = wortMuster(ENGLISCH)
const UMLAUTE = /[äöüßÄÖÜ]/

/** Die Sprache EINER Zeichenkette — oder `null` ohne eindeutiges Merkmal. */
export const klassifiziere = (roh) => {
  const text = String(roh).replace(/\{[^}]*\}/g, ' ')
  if (text.trim().length < 4) return null
  const de = UMLAUTE.test(text) || DE_MUSTER.test(text)
  const en = EN_MUSTER.test(text)
  if (de && !en) return 'de'
  if (en && !de) return 'en'
  return null
}

/** Als Funktion, weil ein `/g`-Ausdruck seinen Suchstand mitschleppt. */
export const fallbackMuster = () =>
  /\b(?:t|translate)\(\s*(?:[A-Za-z]+\s*,\s*)?(['"])[^'"]+\1\s*,\s*(['"])((?:[^\\]|\\.)*?)\2/g

/**
 * Zeichenketten-Literale, die ueberhaupt Text sein KOENNEN.
 *
 * Bezeichner, Pfade, CSS-Klassen und Einzelwoerter fallen raus: `btn--sm` ist
 * keine englische Zeile, und `Iris` ist in beiden Sprachen dasselbe Wort. Was
 * bleibt, sind mehrwortige Literale — und genau die sind die Beschriftungen,
 * um die es in B-26 geht.
 */
const textMuster = () => /(['"])((?:[^'"\\\n]|\\.){4,160})\1/g

const istText = (s) => /\s/.test(s) && !/^[\w./@-]+$/.test(s)

const dateien = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) dateien(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const fehler = (satz) => {
  console.error(`FEHLER: ${satz}`)
  process.exit(1)
}

const paket = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const erklaert = paket.avplan?.sourceLanguage
if (!erklaert) fehler('package.json: avplan.sourceLanguage fehlt — die Quellsprache ist nicht erklaert.')
if (erklaert !== 'de' && erklaert !== 'en') {
  fehler(`package.json: avplan.sourceLanguage ist "${erklaert}" — erlaubt sind "de" und "en".`)
}

// Die zweite Stelle: die README, die ein Mensch liest. Gehen beide
// auseinander, glaubt jede Seite etwas anderes — und jeder zitiert die, die
// ihm passt.
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const inReadme = /\*\*Source language:\*\*\s*`([a-z]{2})`/.exec(readme)
if (!inReadme) fehler('README.md nennt die Quellsprache nicht.')
if (inReadme[1] !== erklaert) {
  fehler(`README.md sagt "${inReadme[1]}", package.json sagt "${erklaert}".`)
}

const fremdsprachig = []
const fallbackAbweichungen = []
let fallbacks = 0

for (const datei of dateien(UI)) {
  const quelle = readFileSync(datei, 'utf8')
  const rel = relative(UI, datei)

  for (const m of quelle.matchAll(textMuster())) {
    if (!istText(m[2])) continue
    if (klassifiziere(m[2]) !== erklaert && klassifiziere(m[2]) !== null) {
      fremdsprachig.push(`${rel}: ${m[2].slice(0, 90)}`)
    }
  }

  // Selbst-Scharfschaltung: sobald i18n eingezogen wird, gilt fuer die
  // Fallbacks die harte Regel — keine Grenze, keine Toleranz.
  for (const m of quelle.matchAll(fallbackMuster())) {
    fallbacks += 1
    const sprache = klassifiziere(m[3])
    if (sprache && sprache !== erklaert) {
      fallbackAbweichungen.push(`${rel}: ${m[3].slice(0, 90)}`)
    }
  }
}

console.log(`Quellsprache "${erklaert}" (package.json und README stimmen ueberein).`)

if (fallbacks > 0) {
  console.log(`${fallbacks} uebersetzte Zeichenkette(n) gefunden — die i18n ist im Aufbau.`)
  if (fallbackAbweichungen.length) {
    console.error(`\n${fallbackAbweichungen.length} Fallback(s) nicht in der Quellsprache:`)
    for (const z of fallbackAbweichungen) console.error(`  ${z}`)
    process.exit(1)
  }
} else {
  console.log(
    'Keine i18n vorhanden: die Oberflaeche traegt ihre Texte fest im Quelltext ' +
      '(B-26). Der Lauf misst deshalb die Literale und schaltet sich selbst ' +
      'scharf, sobald der erste Fallback auftaucht.',
  )
}

console.log(
  `\n${fremdsprachig.length} fremdsprachige Zeichenkette(n) in der Oberflaeche ` +
    `(Grenze: ${GRENZE}) — das ist der Sprachmix aus B-26, nicht ein Rueckstand:`,
)
for (const z of fremdsprachig) console.log(`  ${z}`)

if (fremdsprachig.length > GRENZE) {
  console.error(
    `\nFEHLER: der Sprachmix ist gewachsen (${fremdsprachig.length} > ${GRENZE}). ` +
      'Neue Oberflaechen-Texte gehoeren in die Quellsprache dieses Repos. ' +
      'Solange B-26 offen ist, darf der Bestand bleiben — wachsen darf er nicht.',
  )
  process.exit(1)
}

if (fremdsprachig.length < GRENZE) {
  console.error(
    `\nFEHLER: es sind nur noch ${fremdsprachig.length} statt ${GRENZE}. Das ist eine ` +
      'gute Nachricht und trotzdem ein Fehler: die Grenze in scripts/quellsprache-check.mjs ' +
      'muss auf den neuen Stand herunter, sonst deckt sie ab morgen wieder Zuwachs.',
  )
  process.exit(1)
}

console.log('\nQuellsprache erklaert, Sprachmix unveraendert.')
