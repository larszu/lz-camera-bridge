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
//   > NEVER FAKE A READOUT. Reuse and extend sony-camera-bridge
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
