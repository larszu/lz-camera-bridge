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
// WAS DIESER LAUF TUT. Er misst die fremdsprachigen Zeichenketten der
// Oberflaeche und haelt ihre Zahl bei DER GRENZE. Am 2026-09-08 stand sie bei
// 19 und hatte genau einen Zweck: der Mix durfte nicht WACHSEN, waehrend B-26
// offen war.
//
// SEIT 2026-09-09 IST SIE NULL (`sony#22`). Die 19 Stellen sind uebersetzt,
// die Oberflaeche ist einsprachig englisch, und die Grenze sagt das jetzt,
// statt es zu behaupten: eine einzige deutsche Beschriftung laesst den Lauf
// fallen. Sie bleibt in BEIDE Richtungen scharf — wer weiter uebersetzt (etwa
// nach dem Einziehen einer i18n), traegt die neue Zahl hier ein, sonst
// verliert sie beim naechsten Mal ihre Bedeutung.
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
 * Die Grenze: so viele fremdsprachige Zeichenketten duerfen in der Oberflaeche
 * stehen. Nach OBEN ist sie ein Fehler, nach UNTEN ebenfalls — wer
 * uebersetzt, traegt die neue Zahl hier ein, sonst verliert die Grenze beim
 * naechsten Mal ihre Bedeutung.
 *
 * SEIT 2026-09-09 IST SIE NULL (B-26 erledigt, `sony#22`). Am 2026-09-08 stand
 * sie bei 19, und sie hatte damals genau einen Zweck: der Mix durfte nicht
 * WACHSEN, waehrend B-26 offen war. Jetzt ist er weg — die Oberflaeche ist
 * einsprachig englisch —, und die Grenze sagt das, statt es zu behaupten:
 * eine einzige deutsche Beschriftung laesst den Lauf fallen.
 */
const GRENZE = 0

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

/**
 * Kommentare raus, BEVOR gemessen wird.
 *
 * Gemessen 2026-09-09, beim Uebersetzen der Oberflaeche (B-26): der Lauf
 * schlug auf einem KOMMENTAR an — einem deutschen Satz in `origin.ts`, der
 * ein englisches Wort in Anfuehrungszeichen zitierte. Der Waechter sah darin
 * ein Literal.
 *
 * Das ist keine Kleinigkeit, sondern die Sorte Fehler, die einen Waechter
 * abschaltet: die Kommentare dieses Repos sind DEUTSCH (Konvention), die
 * Oberflaeche ist ENGLISCH (E-17). Ein Lauf, der beides in einen Topf wirft,
 * meldet bei jedem gut kommentierten Commit einen Verstoss, den es nicht
 * gibt — und wer ihn dreimal wegdrueckt, liest ihn beim vierten Mal nicht
 * mehr. Sein eigener Kopf sagt seit der ersten Fassung, dass er LITERALE
 * misst; hier tut er es auch.
 */
const ohneKommentare = (quelle) =>
  quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((z) => !z.trim().startsWith('//'))
    .join('\n')

const istText = (s) => /\s/.test(s) && !/^[\w./@-]+$/.test(s)

/**
 * TEXT ZWISCHEN DEN TAGS — und warum das hier stehen MUSS.
 *
 * Gegengeprobt 2026-09-09: die Oberflaeche wurde uebersetzt, die Grenze fiel
 * auf 0, und dann wurde eine deutsche Beschriftung wieder eingebaut, um zu
 * sehen, ob der Lauf sie faengt. ER FING SIE NICHT.
 *
 * Der Grund: `textMuster` sieht nur Zeichenketten in Anfuehrungszeichen. Der
 * groesste Teil der sichtbaren Texte dieser Oberflaeche steht aber gar nicht
 * dort, sondern als JSX-Text zwischen den Tags — jeder Absatz des
 * Einrichtungs-Assistenten, jede Ueberschrift, jeder Hinweis. Der Lauf hat
 * also nie die Oberflaeche gemessen, sondern ihre Attribute; die „19" von
 * 2026-09-08 waren der Ausschnitt, den er sehen konnte.
 *
 * Ein Waechter, der bei einem echten Verstoss gruen bleibt, ist schlimmer als
 * keiner: er wird zitiert. Deshalb misst dieser Lauf jetzt beides.
 *
 * Ausgenommen bleibt, was Code ist und kein Text: alles mit `{` oder `}`
 * darin ist ein eingebetteter Ausdruck, und `istText` verlangt ohnehin ein
 * Leerzeichen — `<code>7700</code>` und `<strong>Start</strong>` fallen damit
 * heraus, ohne dass eine Ausnahmeliste sie einzeln nennen muesste.
 */
const jsxTextMuster = () => />([^<>{}]{4,300})</g

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
  const quelle = ohneKommentare(readFileSync(datei, 'utf8'))
  const rel = relative(UI, datei)

  for (const m of quelle.matchAll(textMuster())) {
    if (!istText(m[2])) continue
    if (klassifiziere(m[2]) !== erklaert && klassifiziere(m[2]) !== null) {
      fremdsprachig.push(`${rel}: ${m[2].slice(0, 90)}`)
    }
  }

  for (const m of quelle.matchAll(jsxTextMuster())) {
    const text = m[1].replace(/\s+/g, ' ').trim()
    if (!istText(text)) continue
    if (klassifiziere(text) !== erklaert && klassifiziere(text) !== null) {
      fremdsprachig.push(`${rel}: ${text.slice(0, 90)}`)
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

if (GRENZE === 0 && fremdsprachig.length === 0) {
  console.log(
    `\nKeine fremdsprachige Zeichenkette in der Oberflaeche — sie ist einsprachig ` +
      `"${erklaert}" (B-26 erledigt). Eine einzige laesst diesen Lauf fallen.`,
  )
} else {
  console.log(
    `\n${fremdsprachig.length} fremdsprachige Zeichenkette(n) in der Oberflaeche ` +
      `(Grenze: ${GRENZE}):`,
  )
  for (const z of fremdsprachig) console.log(`  ${z}`)
}

if (fremdsprachig.length > GRENZE) {
  console.error(
    `\nFEHLER: der Sprachmix ist gewachsen (${fremdsprachig.length} > ${GRENZE}). ` +
      'Neue Oberflaechen-Texte gehoeren in die Quellsprache dieses Repos.',
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
