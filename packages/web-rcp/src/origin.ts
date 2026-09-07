// ───────────────────────────────────────────────────────────────────────────
// Bedarf 46 — die Worte zu „kommandiert ist nicht bestaetigt".
//
// Das MODELL steht in der Bruecke (`packages/bridge/src/protocol/
// valueOrigin.ts`) samt der Tabelle, welcher Weg welches Feld wirklich vom
// Geraet liest. Hier stehen nur die Saetze und die Klassennamen — und
// ABSICHTLICH KEINE Kopie der Tabelle: das Pult bekommt je Kamera die
// fertige Auskunft `neverReadsBack` und je Wert die Herkunft mit dem
// `state`-Broadcast geschickt. Eine zweite Tabelle waere genau die zweite
// Wahrheit, die dieser Bedarf abschafft.
// ───────────────────────────────────────────────────────────────────────────

/** Woher ein angezeigter Wert stammt. Vom Bus mitgeschickt. */
export type ValueOrigin = 'confirmed' | 'commanded';

/** Herkunft je Feld des Bildzustands. Fehlt ein Eintrag, gibt es den Wert nicht. */
export type Origins = Record<string, ValueOrigin>;

export type CameraOriginsByNumber = Record<number, Origins>;

/**
 * Der Satz an einem einzelnen unbestaetigten Wert.
 *
 * Als `title` am Wert und nicht als Zeile daneben: an einem Pult mit zwanzig
 * Reglern waere zwanzigmal derselbe Satz die Sorte Hinweis, die man nach dem
 * dritten Mal nicht mehr sieht.
 */
export const UNCONFIRMED_NOTE = 'gesendet, nicht zurückgelesen';

/**
 * Der Satz fuer einen Weg, der GAR NICHTS zurueckliest.
 *
 * Der gehoert einmal an die Kamera und nicht an jeden Regler: wo kein
 * einziger Wert je bestaetigt wird, ist die Markierung am Einzelwert Tapete,
 * und die Aussage geht in ihr unter.
 */
export const NO_READBACK_NOTE =
  'Dieser Weg liest nichts zurück: alle Werte hier sind das, was zuletzt gesendet ' +
  'wurde — keine Aussage darüber, was an der Kamera steht.';

/**
 * Ist dieser Wert unbestaetigt?
 *
 * Ein Wert OHNE Eintrag ist nicht unbestaetigt, sondern gar nicht da — das
 * Pult zeigt dafuer „--" und nicht eine markierte Zahl. Wer das
 * zusammenwirft, markiert die leere Anzeige und macht die Markierung
 * bedeutungslos.
 */
export const istUnbestaetigt = (origins: Origins | undefined, feld: string): boolean =>
  origins?.[feld] === 'commanded';

/** Die Klasse, die einen unbestaetigten Wert kennzeichnet. */
export const UNCONFIRMED_CLASS = 'rcp-unconfirmed';

/** Klassenname + Titel in einem — damit beide nie auseinanderlaufen. */
export const unconfirmedProps = (
  origins: Origins | undefined,
  feld: string,
): { className: string; title?: string } =>
  istUnbestaetigt(origins, feld)
    ? { className: ` ${UNCONFIRMED_CLASS}`, title: UNCONFIRMED_NOTE }
    : { className: '' };
