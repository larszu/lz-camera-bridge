// ───────────────────────────────────────────────────────────────────────────
// Bedarf 46 (P2) — kommandiert ist nicht bestaetigt.
//
// ─── DER BEFUND ────────────────────────────────────────────────────────────
//
//   > On the Blackmagic SDI fleet the protocol is write-only, so THE
//   > CONTROLLER ONLY KNOWS VALUES IT SET ITSELF; ATEM camera-control
//   > variables (gain_luma, lift_luma, gamma_luma, offset_luma) return null;
//   > Panasonic AW-UE160 red/blue gain never feeds back. SHADERS WORK
//   > AGAINST A MENTAL MODEL, NOT THE CAMERA.
//
// Belegt am README von `fiverecords/TallyCCUPro` („SDI protocol is
// write-only, system cannot query current camera settings"), an
// `bitfocus/companion-module-bmd-atem#350` (vier Luma-Variablen liefern
// `null`) und an `companion-module-panasonic-cameras#56` (Rot-/Blau-Gain
// meldet nie zurueck, geschlossen als „not planned").
//
// Die Bedarfs-Datenbank nennt die Massnahme woertlich:
//
//   > Model every paint value as COMMANDED VS CONFIRMED, sourced from a
//   > per-model capability table; RENDER UNCONFIRMED VALUES DISTINCTLY and
//   > NEVER FAKE A READOUT. Reuse and extend lz-camera-bridge
//   > capabilitiesForMode as the schema seed.
//
// ─── WAS HIER WIRKLICH PASSIERT (NACHGELESEN, NICHT VERMUTET) ──────────────
//
// Die Bruecke fuehrt je Kamera EINEN Zustand, und in ihn schreiben ZWEI
// Quellen, die im Ergebnis nicht mehr zu unterscheiden sind:
//
//  1. `BridgeServer.echoState` — der optimistische Echo nach einem
//     angenommenen Kommando. Sein Kommentar sagt selbst, er werde von
//     pollenden Backends „mit dem echten Wert ueberschrieben".
//  2. `stateChanged` der Backends. Nur: MEHRERE BACKENDS SENDEN DARIN
//     EBENFALLS DEN GERADE GESCHICKTEN WERT, unmittelbar aus
//     `handleRcpCommand` heraus — `ViscaClient` (`setIris`,
//     `setMasterGain`), `JvcClient` (dito), `ZCamClient`,
//     `PanasonicPtzClient` (`setIris`, `setBars`, `setCameraPower`) und
//     `SonyPtpUsbClient`, dessen fuenf `emitState()`-Aufrufe ausnahmslos
//     direkt hinter einem `this.state.X = <kommandierter Wert>` stehen.
//
// Es gibt also heute KEINEN Kanal, der Geraete-Wahrheit von einem Echo
// trennt. Was das Pult anzeigt, ist auf diesen Wegen ausschliesslich das
// zuletzt Gesendete — genau der „mental model, not the camera" des Belegs.
//
// ─── DIE TABELLE ENTSCHEIDET, NICHT DER KANAL ──────────────────────────────
//
// Deshalb wird die Herkunft NICHT am Ereignis festgemacht (das waere wieder
// nur eine Vermutung), sondern je FELD und WEG an `MODE_READBACK`: dort steht,
// welche Felder ein Backend ueberhaupt vom Geraet liest. Jede Zeile ist am
// Quelltext dieses Repos nachgelesen und traegt die Stelle im Kommentar.
//
// Ein Wert ist `confirmed` nur dann, wenn er ueber `stateChanged` kam UND das
// Feld in `MODE_READBACK` steht. Alles andere ist `commanded`. Ein Echo bleibt
// ein Echo, auch wenn es als `stateChanged` verkleidet ankommt.
//
// REIN: kein IO, keine Uhr, kein Netz.
// ───────────────────────────────────────────────────────────────────────────
import type { ConnectionMode } from '../cameras/backendFactory.js';
import type { CameraState } from './CcuClient.js';

/** Ein Feld des Bildzustands. */
export type PaintField = keyof CameraState;

export type ValueOrigin =
  /** Vom Geraet gelesen. */
  | 'confirmed'
  /** Von uns geschickt und nie zurueckgelesen. Keine Aussage ueber die Kamera. */
  | 'commanded';

/**
 * Was ein Wert ohne Herkunft heisst.
 *
 * Es gibt keinen dritten Wert: ein Feld, das in keinem der beiden Wege
 * vorkam, steht schlicht nicht im Zustand. „Unbekannt" ist die Abwesenheit
 * des Eintrags und nicht eine Herkunft — `resolveNudge` liest genau das so
 * (`no-current-value`).
 */
export type Origins = Partial<Record<PaintField, ValueOrigin>>;

/**
 * Welche Felder ein Backend WIRKLICH vom Geraet liest.
 *
 * Jede Zeile ist im Quelltext nachgelesen. Was hier fehlt, ist keine
 * Nachlaessigkeit, sondern die Aussage: dieser Weg liest es nicht zurueck.
 */
export const MODE_READBACK: Readonly<Record<ConnectionMode, readonly PaintField[]>> = {
  // Der Demo-Weg haelt den Zustand SELBST und gibt ihn nach jedem Befehl
  // zurueck. Das ist die vollstaendigste Rueckmeldung ueberhaupt — und sie
  // sagt trotzdem nichts ueber eine Kamera aus, weil da keine ist.
  //
  // Genau deshalb steht hier die volle Liste und nicht `[]`: die Oberflaeche
  // soll den Demo-Betrieb so behandeln, wie sie eine antwortende Kamera
  // behandelt (Werte gelten als `confirmed`, nichts altert weg). Dass es
  // keine Kamera ist, steht an einer anderen Stelle — `isDemo` im Zustand —
  // und nicht hier. Eine leere Liste waere die falsche Art, es zu sagen:
  // sie hiesse „liest nicht zurueck", und dann zeigte das Pult jeden
  // gezogenen Regler als unbestaetigt an, obwohl er unmittelbar antwortet.
  demo: [
    'iris', 'masterBlack', 'blackR', 'blackG', 'blackB', 'whiteR', 'whiteG', 'whiteB',
    'masterGain', 'masterGamma', 'saturation', 'shutterSpeed', 'ndFilter',
    'masterWhiteClip', 'detailLevel', 'bars', 'cameraPower',
  ],
  // `CcuClient.handleMessage50` wertet den Message-50-Strom der CCU aus und
  // setzt in `applyStateFromCommand` genau diese Felder. Der einzige Weg mit
  // nennenswerter Rueckmeldung.
  tcp: [
    'iris', 'masterBlack', 'blackR', 'blackG', 'blackB', 'whiteR', 'whiteG', 'whiteB',
    'masterGain', 'masterGamma', 'saturation', 'shutterSpeed', 'ndFilter',
    'masterWhiteClip', 'detailLevel', 'bars', 'cameraPower',
  ],
  serial: [
    'iris', 'masterBlack', 'blackR', 'blackG', 'blackB', 'whiteR', 'whiteG', 'whiteB',
    'masterGain', 'masterGamma', 'saturation', 'shutterSpeed', 'ndFilter',
    'masterWhiteClip', 'detailLevel', 'bars', 'cameraPower',
  ],
  // `LumixClient.pollState` (`mode=getstate`) → `lumixStateToCamera`. Nur
  // diese drei kommen aus der Antwort; `cameraPower` wird dort ausschliesslich
  // auf `true` gesetzt und nie zurueck — eine Halbwahrheit, die als
  // Rueckmeldung nicht taugt und deshalb hier nicht steht.
  'lumix-http': ['iris', 'shutterSpeed', 'masterGain'],
  // `SonyPtpUsbClient`: alle fuenf `emitState()` stehen unmittelbar hinter
  // `this.state.X = <kommandierter Wert>`. Es wird nichts gelesen.
  'sony-usb': [],
  // `SonyMncClient.getState` pollt; `mapMncState` bildet daraus zwei Felder ab.
  'sony-mnc': ['iris', 'ndFilter'],
  // `BMDeviceClient.getState` HOLT sehr viel — /colorCorrection/lift, /gamma,
  // /gain, /offset, /contrast, /color —, aber `mapBmState` bildet davon NICHTS
  // ab. Im Zustand landen nur diese drei. Genau der Fall aus dem Beleg: die
  // Blackmagic gilt als die mit dem vollen Farbsatz, und die Farbregler des
  // Pults zeigen trotzdem nur, was jemand gesendet hat.
  blackmagic: ['iris', 'masterGain', 'shutterSpeed'],
  // `CanonCcapiClient.pollState` liest av, tv und iso.
  'canon-ccapi': ['iris', 'shutterSpeed', 'masterGain'],
  // `ZCamClient`: beide `stateChanged` stehen in `handleRcpCommand`.
  zcam: [],
  // `PanasonicPtzClient`: `setIris`, `setBars`, `setCameraPower` — alle drei
  // melden den gerade geschickten Wert.
  'panasonic-ptz': [],
  // `ViscaClient`: `setIris`, `setMasterGain`, `setCameraPower` — dito.
  visca: [],
  // Derselbe `ViscaClient`, nur am Kabel statt auf IP: dieselben Kommandos,
  // dieselben `stateChanged` aus `handleRcpCommand`. Antworten der Kamera
  // (ACK/Completion) werden als `visca`-Ereignis durchgereicht, aber auf
  // kein Feld des Bildzustands abgebildet — also liest auch dieser Weg
  // nichts zurueck.
  'visca-serial': [],
  // Gimbals melden Telemetrie (Lage des Kopfes), aber KEIN Feld des
  // Bildzustands -- Blende und Gain gehoeren der Kamera darauf. Also liest
  // dieser Weg nichts von dem zurueck, was das Pult anzeigt.
  'dji-osmo': [],
  'dji-ronin': [],
  // `JvcClient` pollt zwar (`GetCamStatusMinimum` alle 3 s), bildet die
  // Antwort aber auf kein Feld des Bildzustands ab. Die beiden
  // `stateChanged` stehen in `handleRcpCommand`.
  jvc: [],
  // `BirddogClient` reicht die Ereignisse seines ViscaClient durch.
  birddog: [],
};

/** Liest dieser Weg dieses Feld ueberhaupt vom Geraet? */
export const readsBack = (mode: ConnectionMode, field: PaintField): boolean =>
  MODE_READBACK[mode]?.includes(field) ?? false;

/**
 * Ein Weg, der GAR NICHTS zurueckliest.
 *
 * Das gehoert einmal an die Kamera geschrieben und nicht an jeden Regler: wo
 * kein einziger Wert je bestaetigt wird, ist die Markierung am Einzelwert
 * Tapete, und die Aussage geht in ihr unter.
 */
export const neverReadsBack = (mode: ConnectionMode): boolean =>
  (MODE_READBACK[mode]?.length ?? 0) === 0;

// Die SAETZE dazu stehen nicht hier, sondern im Pult
// (`packages/web-rcp/src/origin.ts`). Dieses Modul ist das Modell; die Worte
// sind Bedienoberflaeche. Und die Tabelle bleibt trotzdem einmalig: das Pult
// bekommt kein Duplikat von `MODE_READBACK`, sondern je Kamera-Slot die
// fertige Auskunft `neverReadsBack` mit der Kameraliste geschickt.

/**
 * DIE ENGSTELLE: die Herkunft der Felder einer Meldung.
 *
 * `kind: 'command'` ist immer `commanded` — ein Echo bleibt eines. `'read'`
 * ist nur dort `confirmed`, wo `MODE_READBACK` es hergibt; die Backends, die
 * ihr eigenes Kommando als `stateChanged` zurueckwerfen, kommen genau hier
 * nicht durch.
 *
 * Rein und ohne Seiteneffekt: das Ergebnis ist ein neues Objekt, damit der
 * Broadcast nicht auf einem Zustand sitzt, den jemand danach noch aendert.
 */
export function applyOrigins(
  vorher: Origins | undefined,
  mode: ConnectionMode | undefined,
  felder: readonly PaintField[],
  kind: 'read' | 'command',
): Origins {
  const out: Origins = { ...(vorher ?? {}) };
  for (const f of felder) {
    out[f] =
      kind === 'read' && mode !== undefined && readsBack(mode, f) ? 'confirmed' : 'commanded';
  }
  return out;
}

/** Die Felder einer Teilmeldung — ohne die, die gar keinen Wert tragen. */
export const feldnamen = (teil: Partial<CameraState>): PaintField[] =>
  (Object.keys(teil) as PaintField[]).filter((k) => teil[k] !== undefined);

// ───────────────────────────────────────────────────────────────────────────
// Bedarf 102 (P3) — bestaetigt ist nicht dauerhaft bestaetigt.
//
// ─── DER BEFUND ────────────────────────────────────────────────────────────
//
//   > Parameters changed in the camera's own menu or web UI never update the
//   > control surface; an ND filter change executes but THE DISPLAYED
//   > VARIABLE STAYS STALE, and SHORTENING THE POLL INTERVAL FROM 3000ms TO
//   > 200ms CHANGES NOTHING.
//
// Belegt an `bitfocus/companion-module-canon-ptz#53` (November 2024), mit dem
// Reporter woertlich zitiert.
//
// Die Bedarfs-Datenbank nennt die Massnahme ebenso woertlich:
//
//   > TIMESTAMP EVERY STORED VALUE WITH WHEN IT WAS LAST CONFIRMED, and
//   > SURFACE STALENESS RATHER THAN HIDING IT.
//
// ─── WAS BEDARF 46 SCHON LEISTET, UND WAS NICHT ────────────────────────────
//
// `ValueOrigin` trennt oben `commanded` von `confirmed`. Das beantwortet:
// „hat die Kamera das je gesagt?" Es beantwortet NICHT: „gilt das noch?"
//
// Und genau das ist der Fall aus dem Beleg. Wer am Kameramenue den ND-Filter
// dreht, aendert einen Wert, den das Pult einmal korrekt gelesen hat. Die
// Herkunft bleibt `confirmed` — und ist ab diesem Augenblick eine Aussage
// ueber die Vergangenheit. Ein Alter macht den Unterschied sichtbar; das
// Nachschaerfen des Poll-Takts nicht, wie der Reporter gemessen hat.
//
// ─── WARUM DAS ALTER NICHT GEGEN EINE FESTE SEKUNDENZAHL LAEUFT ────────────
//
// „Aelter als fuenf Sekunden" waere geraten. Gemessen wird gegen den TAKT DES
// JEWEILIGEN WEGES: ein Weg, der jede Sekunde fragt und seit dreissig
// Sekunden nichts bestaetigt hat, fragt nicht mehr — bei einem Weg, der alle
// zwei Sekunden fragt, heisst dieselbe halbe Minute etwas anderes.
//
// Und ein Weg, auf dem die KAMERA VON SICH AUS meldet, bekommt gar kein
// Verfallsdatum: dort ist Stille die Aussage „nichts hat sich geaendert".
// Ein Alter als Fehler zu zeigen, waere dort falsch.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wann ein Feld zuletzt vom Geraet BESTAETIGT wurde — Millisekunden seit
 * Epoche, so wie der Aufrufer sie hereingibt.
 *
 * Nur bestaetigte Werte stehen hier. Ein Kommando LOESCHT den Eintrag (siehe
 * `applyConfirmations`), es setzt ihn nicht: was die Kamera vor dem Kommando
 * gemeldet hat, ist danach keine Aussage mehr ueber das, was jetzt gilt.
 */
export type Confirmations = Partial<Record<PaintField, number>>

/**
 * Wie eine Bestaetigung auf diesem Weg ueberhaupt zustande kommt.
 *
 * Das ist keine Vorliebe, sondern der Unterschied zwischen „wir fragen" und
 * „die Kamera meldet". Nur im ersten Fall ist Ausbleiben ein Befund.
 */
export type ConfirmCadence =
  /** Wir fragen in diesem Takt. Ausbleiben heisst: es wird nicht mehr gefragt. */
  | { kind: 'poll'; everyMs: number }
  /** Die Kamera meldet von sich aus. Stille heisst: nichts hat sich geaendert. */
  | { kind: 'push' }
  /** Dieser Weg liest gar nichts zurueck (`MODE_READBACK` ist leer). */
  | { kind: 'none' }

/**
 * Der Takt je Weg — jede Zeile im Quelltext dieses Repos nachgelesen.
 *
 * Wo eine Zahl steht, steht daneben, wo sie herkommt. Was nichts zurueckliest,
 * bekommt `none` und nicht etwa einen erfundenen Takt.
 */
export const MODE_CADENCE: Readonly<Record<ConnectionMode, ConfirmCadence>> = {
  // `DemoCameraClient` sendet `stateChanged` unmittelbar nach jedem Befehl
  // und sonst nie. Das ist `push` im Wortsinn: Stille heisst, dass sich
  // nichts geaendert hat — hier sogar zwingend, weil ausser Befehlen nichts
  // etwas aendern KANN. Kein Drift, kein Rauschen, kein Timer.
  demo: { kind: 'push' },
  // `CcuClient`: Nachricht 0x50 kommt UNAUFGEFORDERT von der CCU — der Client
  // beantwortet sie nur (`handleMessage50`, dann `buildMessageResponse`). Der
  // 1000-ms-Timer daneben ist ein HEARTBEAT, keine Zustandsabfrage. Also
  // `push`: bleibt die Meldung aus, hat sich nichts geaendert.
  tcp: { kind: 'push' },
  serial: { kind: 'push' },
  // `LumixClient`: `setInterval(() => this.pollState(), this.pollInterval)`,
  // Vorgabe 2000 ms.
  'lumix-http': { kind: 'poll', everyMs: 2000 },
  // `SonyMncClient.startPolling`: `}, 1000)`.
  'sony-mnc': { kind: 'poll', everyMs: 1000 },
  // `BMDeviceClient`: `}, 1000)`.
  blackmagic: { kind: 'poll', everyMs: 1000 },
  // `CanonCcapiClient`: `this.pollMs = opts.pollInterval ?? 2000`.
  'canon-ccapi': { kind: 'poll', everyMs: 2000 },
  // Die uebrigen stehen in `MODE_READBACK` mit leerer Liste: sie lesen nichts
  // zurueck, also gibt es auch nichts, das altern koennte.
  'sony-usb': { kind: 'none' },
  zcam: { kind: 'none' },
  'panasonic-ptz': { kind: 'none' },
  visca: { kind: 'none' },
  'visca-serial': { kind: 'none' },
  'dji-osmo': { kind: 'none' },
  'dji-ronin': { kind: 'none' },
  jvc: { kind: 'none' },
  birddog: { kind: 'none' },
}

/**
 * Ab wie vielen ausgelassenen Takten ein Wert auffaellt bzw. als ueberholt
 * gilt.
 *
 * Drei, weil ein einzelner ausgelassener Takt jedes Netz kennt und eine
 * Meldung darueber nur Rauschen waere. Zehn, weil dann nicht mehr von einem
 * Aussetzer die Rede sein kann.
 */
export const AGING_POLLS = 3
export const STALE_POLLS = 10

export type Freshness =
  /** Innerhalb des erwarteten Takts bestaetigt. */
  | 'frisch'
  /** Mehr als `AGING_POLLS` Takte her — auffaellig, noch kein Befund. */
  | 'alternd'
  /** Mehr als `STALE_POLLS` Takte her. Der Wert beschreibt die Vergangenheit. */
  | 'ueberholt'
  /** Nie bestaetigt — entweder noch nicht, oder dieser Weg liest gar nicht. */
  | 'unbestaetigt'

/**
 * Wie belastbar ein gespeicherter Wert JETZT ist.
 *
 * `now` kommt vom Aufrufer: dieses Modul liest keine Uhr, sonst waere es
 * nicht pruefbar.
 *
 * Auf einem `push`-Weg gibt es kein `alternd` und kein `ueberholt`. Das ist
 * keine Nachlaessigkeit, sondern die Bedeutung von Stille auf so einem Weg —
 * wer daraus einen Befund macht, meldet jede ruhige Kamera als Problem, und
 * eine Meldung, die immer ansteht, wird abgeschaltet.
 */
export const freshness = (
  confirmedAt: number | undefined,
  now: number,
  cadence: ConfirmCadence,
): Freshness => {
  if (confirmedAt === undefined) return 'unbestaetigt'
  // Als `switch` und nicht als Kette von `if`s, und das ist der Punkt: faellt
  // ein Zweig weg, hat die Funktion einen Pfad ohne Rueckgabewert und der
  // Typpruefer meldet es. Als `if`-Kette rutschte der `push`-Fall in die
  // Poll-Rechnung, `cadence.everyMs` waere `undefined`, jeder Vergleich
  // gegen NaN falsch — und das Ergebnis waere zufaellig wieder `frisch`.
  // Eine Regel, die nur aus Versehen stimmt, ist keine.
  switch (cadence.kind) {
    case 'none':
      return 'unbestaetigt'
    case 'push':
      return 'frisch'
    case 'poll': {
      const alter = now - confirmedAt
      if (alter > cadence.everyMs * STALE_POLLS) return 'ueberholt'
      if (alter > cadence.everyMs * AGING_POLLS) return 'alternd'
      return 'frisch'
    }
  }
}

/**
 * DIE ENGSTELLE fuer die Zeitstempel — dieselbe Regel wie `applyOrigins`,
 * damit Herkunft und Alter nicht auseinanderlaufen koennen.
 *
 * Ein Kommando LOESCHT den Zeitstempel des Feldes. Ihn stehenzulassen waere
 * die stillste Art zu luegen: die Anzeige zeigte dann das Alter einer
 * Bestaetigung, die einen ANDEREN Wert betraf.
 */
export function applyConfirmations(
  vorher: Confirmations | undefined,
  mode: ConnectionMode | undefined,
  felder: readonly PaintField[],
  kind: 'read' | 'command',
  now: number,
): Confirmations {
  const out: Confirmations = { ...(vorher ?? {}) }
  for (const f of felder) {
    if (kind === 'read' && mode !== undefined && readsBack(mode, f)) out[f] = now
    else delete out[f]
  }
  return out
}

/**
 * Was das Pult braucht, um ein Alter zu beurteilen — FERTIG GERECHNET.
 *
 * Es bekommt weder die Takt-Tabelle noch die Schwellen, sondern zwei Zahlen
 * in Millisekunden. Damit gibt es die Konstanten `AGING_POLLS`/`STALE_POLLS`
 * weiterhin genau einmal, hier; dieselbe Regel wie bei `neverReadsBack`.
 *
 * `null` heisst: dieser Weg hat keine Verfallsfrist. Entweder meldet die
 * Kamera von sich aus (dann heisst Stille „nichts hat sich geaendert"), oder
 * er liest gar nichts zurueck — dann gibt es auch keinen Zeitstempel, der
 * altern koennte.
 */
export interface FreshnessLimits {
  agingAfterMs: number
  staleAfterMs: number
}

export const freshnessLimits = (cadence: ConfirmCadence): FreshnessLimits | null =>
  cadence.kind === 'poll'
    ? {
        agingAfterMs: cadence.everyMs * AGING_POLLS,
        staleAfterMs: cadence.everyMs * STALE_POLLS,
      }
    : null
