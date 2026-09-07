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

// ───────────────────────────────────────────────────────────────────────────
// Bedarf 102 — die Worte zu „bestaetigt ist nicht dauerhaft bestaetigt".
//
// Dasselbe Prinzip wie oben: das MODELL (Takt je Weg, Schwellen, Urteil)
// steht in der Bruecke; hier stehen die Saetze. Das Pult rechnet das Urteil
// NICHT selbst aus — es bekommt je Feld den Zeitstempel und je Kamera den
// Takt geschickt und ruft dieselbe `freshness` auf.
// ───────────────────────────────────────────────────────────────────────────

/** Wann ein Feld zuletzt bestaetigt wurde — vom Bus mitgeschickt. */
export type Confirmations = Record<string, number>;

export type CameraConfirmationsByNumber = Record<number, Confirmations>;

/** Dasselbe Vokabular wie in der Bruecke. */
export type Freshness = 'frisch' | 'alternd' | 'ueberholt' | 'unbestaetigt';

/**
 * Die beiden Grenzen in Millisekunden — FERTIG GERECHNET von der Bruecke.
 *
 * Das Pult bekommt weder die Takt-Tabelle noch die Schwellen. Es vergleicht
 * zwei Zahlen; die Regel bleibt an einer Stelle.
 */
export type FreshnessLimits = { agingAfterMs: number; staleAfterMs: number };

/**
 * Wie belastbar ein angezeigter Wert JETZT ist.
 *
 * `limits === null` erreicht die zweite Zeile nur auf einem Weg, auf dem die
 * KAMERA VON SICH AUS meldet: ein Weg, der gar nichts zurueckliest, hat nie
 * einen Zeitstempel, und den faengt die erste Zeile ab. Stille auf einem
 * Melde-Weg heisst „nichts hat sich geaendert" — daraus einen Befund zu
 * machen, meldete jede ruhige Kamera als Problem.
 */
export const freshnessOf = (
  confirmedAt: number | undefined,
  now: number,
  limits: FreshnessLimits | null | undefined,
): Freshness => {
  if (confirmedAt === undefined) return 'unbestaetigt';
  if (!limits) return 'frisch';
  const alter = now - confirmedAt;
  if (alter > limits.staleAfterMs) return 'ueberholt';
  if (alter > limits.agingAfterMs) return 'alternd';
  return 'frisch';
};

/**
 * Der Satz an einem ueberholten Wert.
 *
 * Er sagt NICHT „falsch". Der Wert kann stimmen; was fehlt, ist die
 * Bestaetigung. Genau das ist der Fall aus dem Beleg: wer am Kameramenue den
 * ND-Filter dreht, macht die Anzeige nicht falsch, sondern alt — und ein
 * Pult, das „falsch" behauptet, wo es „ungeprueft" meint, wird beim ersten
 * Fehlalarm nicht mehr geglaubt.
 */
export const STALE_NOTE = 'zuletzt bestätigt vor';

/** Die Klasse, die einen alternden bzw. ueberholten Wert kennzeichnet. */
export const AGING_CLASS = 'rcp-aging';
export const STALE_CLASS = 'rcp-stale';

/** „vor 12 s" / „vor 3 min" — kurz, weil es neben einer Zahl steht. */
export const alterText = (confirmedAt: number, now: number): string => {
  const s = Math.max(0, Math.round((now - confirmedAt) / 1000));
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  return `vor ${Math.round(m / 60)} h`;
};

/**
 * Klassenname + Titel fuer das Alter — analog zu `unconfirmedProps`, damit
 * beide nie auseinanderlaufen.
 *
 * `frisch` und `unbestaetigt` bekommen NICHTS: das erste braucht keine
 * Markierung, und das zweite hat mit `unconfirmedProps` bereits eine. Zwei
 * Markierungen an einem Wert waeren eine zu viel.
 */
export const freshnessProps = (
  stand: Freshness,
  confirmedAt: number | undefined,
  now: number,
): { markClass?: string; markTitle?: string } => {
  if (stand !== 'alternd' && stand !== 'ueberholt') return {};
  if (confirmedAt === undefined) return {};
  return {
    markClass: stand === 'ueberholt' ? STALE_CLASS : AGING_CLASS,
    markTitle: `${STALE_NOTE} ${alterText(confirmedAt, now)}`,
  };
};
