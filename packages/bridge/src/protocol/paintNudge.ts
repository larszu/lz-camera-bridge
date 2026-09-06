// ───────────────────────────────────────────────────────────────────────────
// Relative Kommandos ("Nudge") als erste Klasse auf dem Bus — Bedarf 129, P4.
//
//   > Software CCU surfaces offer absolute value setting only, so black level
//   > — the parameter adjusted most often — has to be jumped to a number
//   > rather than trimmed, and THE VALUE SCALE CAN BE WRONG (setting
//   > lift_luma 1 produces 0.5 on the ATEM).
//
// Belegt an `bitfocus/companion-module-bmd-atem#350` (Januar 2025): Bitte um
// Inkrement-Aktionen fuer Gain, Lift, Offset und Luma, mit „Lift Luma
// (Black Level)" ausdruecklich als dem am haeufigsten getrimmten Wert — plus
// der dokumentierten Halbierung gesetzter Werte.
//
// ─── WAS HIER SCHON DA WAR UND WARUM ES NICHT REICHTE ──────────────────────
//
// Der Bus konnte relativ — dreimal, an einer Stelle, und falsch:
// `BridgeServer.handleCompanionCommand` rechnete `irisUp/gainUp/ndUp` von
// Hand aus. Daran waren vier Dinge kaputt, und alle vier sind genau das,
// wovon der Beleg spricht:
//
//  1. NUR UEBER COMPANION. Das Web-RCP und jeder andere Client am WebSocket
//     hatten keinen Weg, relativ zu trimmen. Ausgerechnet `masterBlack` —
//     der Wert, den der Beleg als den meistgetrimmten benennt — hatte
//     ueberhaupt keine relative Bedienung.
//  2. GERATENE AUSGANGSWERTE: `(perCam.iris ?? 128) + 5`. Wenn die Bruecke
//     den Wert der Kamera nie gesehen hat, ist das kein Trimm, sondern ein
//     Sprung auf 133 — angezeigt, als haette jemand um 5 verstellt. Ein
//     Zustand, den niemand kommandiert hat, darf nicht behauptet werden
//     (ADR-003); ein Ausgangswert, den niemand abgelesen hat, ebenso wenig.
//  3. ZWEI OBERGRENZEN FUER DENSELBEN WERT: Companion klemmte `masterGain`
//     auf 0..7 und `ndFilter` auf 0..4, das Web-RCP auf 0..6 bzw. 0..3.
//     Sechs von sieben Backends lesen `masterGain` als INDEX in eine Tabelle
//     mit sieben Eintraegen (`gainIsoMap` 0..6, `GAIN_INDEX_TO_ISO`), und
//     `gainIsoMap[7]` faellt auf `|| 800` zurueck: die Companion-Taste
//     „Gain +" sprang von +18 dB zurueck auf 0 dB.
//  4. DIE SCHRITTWEITE STAND DREIMAL ALS ZAHL IM AUFRUF (5, 1, 1), ohne
//     Bezug zum Wertebereich des Parameters. Genau die Bauform, aus der die
//     falsche Skala im Beleg entsteht.
//
// Deshalb: EINE Aufloesung fuer alle relativen Kommandos, hier, rein — und
// alle Wege (WebSocket, Companion, Bedienpult) gehen durch sie hindurch. Die
// Backends sehen weiterhin ausschliesslich absolute Kommandos; es gibt keine
// zweite Sprache nach unten.
//
// ─── DIE ENGSTELLE: OHNE GELESENEN WERT KEIN TRIMM ─────────────────────────
//
// `resolveNudge` liefert eine ABSAGE MIT GRUND, wenn der aktuelle Wert
// unbekannt ist. Nicht 128, nicht 0, nicht „nimm die Mitte". Wer relativ
// verstellen will, muss wissen, wovon aus — sonst ist es ein absolutes
// Kommando in der Verkleidung eines Trimms, und der Bedienende merkt es erst
// am Bild.
//
// REIN: kein IO, keine Uhr, kein Netz.
// ───────────────────────────────────────────────────────────────────────────

import type { CameraState } from './CcuClient.js';

/**
 * Die Parameter, die relativ getrimmt werden koennen.
 *
 * AUFNAHMEKRITERIUM: nur, wo sich der Wertebereich des Busses AUS DEM CODE
 * BELEGEN laesst — an den Reglern des Web-RCP und an den Umrechnungen der
 * Backends. Wo zwei Backends denselben Wert verschieden lesen, steht der
 * Parameter NICHT hier drin; ein erfundener Bereich waere schlimmer als
 * keiner, weil ein Trimm daraus stillschweigend eine falsche Weite bekaeme.
 *
 * Draussen geblieben und warum:
 *  - `detailLevel`: `LumixClient` klemmt auf -7..+7, `CcuClient` reicht roh
 *    durch. Zwei unvereinbare Lesarten, keine belegte gemeinsame Skala.
 *  - `shutterSpeed`: ein Index in eine kameraabhaengige Tabelle, deren Laenge
 *    kein Backend nennt. Eine Obergrenze waere geraten.
 *  - `blackR/G/B`, `whiteR/G/B`: gehen als Tripel ueber
 *    `setBlackBalance`/`setWhiteBalance`; ein Trimm einer einzelnen Achse
 *    muesste die beiden anderen mitschicken und dafuer ebenfalls gelesen
 *    haben. Machbar, aber ein eigener Schritt.
 */
export type PaintParameter =
  | 'iris'
  | 'masterBlack'
  | 'masterGamma'
  | 'saturation'
  | 'masterGain'
  | 'ndFilter';

export interface PaintParameterSpec {
  /** Das absolute Kommando, in das ein Trimm aufgeloest wird. */
  readonly command: string;
  /** Kleinster Wert auf dem Bus. */
  readonly min: number;
  /** Groesster Wert auf dem Bus. */
  readonly max: number;
  /** Was ein Tastendruck ohne eigene Angabe bewegt. */
  readonly step: number;
  /** Wie der Wert am Pult heisst. */
  readonly label: string;
  /** Womit der Bereich belegt ist — steht im Test und in der README. */
  readonly scale: string;
}

/**
 * Die eine Tabelle. Wertebereich UND Schrittweite stehen hier und nirgends
 * sonst; wer eine Taste anlegt, nimmt den Schritt von hier, statt ihn in den
 * Aufruf zu schreiben.
 *
 * ZU DEN SCHRITTWEITEN: ein Trimm ist der KLEINSTE sinnvolle Zug, deshalb 1
 * auf allen Skalen — ausser bei `iris`, wo die vorhandene Companion-Taste
 * seit jeher 5 bewegt und ein Sprung auf 1 eine bestehende Bedienung
 * verlangsamt haette. 5 von 255 sind rund zwei Prozent des Wegs; das ist der
 * Zug, den ein Bildtechniker an der Blende erwartet. Wer anders trimmen will,
 * gibt `by` mit — die Vorgabe ist eine Vorgabe, keine Grenze.
 */
export const PAINT_PARAMETERS: Readonly<Record<PaintParameter, PaintParameterSpec>> = {
  iris: {
    command: 'setIris',
    min: 0,
    max: 255,
    step: 5,
    label: 'Iris',
    scale: '0..255; PtzPanel.tsx nennt den Bereich, BMDeviceClient teilt durch 255',
  },
  masterBlack: {
    command: 'setMasterBlack',
    min: 0,
    max: 255,
    step: 1,
    label: 'Master Black',
    scale: '0..255, Mitte 128; RotaryKnob detent=128, BMDeviceClient bipolar((v-128)/128)',
  },
  masterGamma: {
    command: 'setMasterGamma',
    min: 0,
    max: 255,
    step: 1,
    label: 'Master Gamma',
    scale: '0..255, Mitte 128; BMDeviceClient bipolar((v-128)/128)',
  },
  saturation: {
    command: 'setSaturation',
    min: 0,
    max: 255,
    step: 1,
    label: 'Saturation',
    scale: '0..255, Mitte 128; BMDeviceClient v/128 auf 0..2',
  },
  masterGain: {
    command: 'setMasterGain',
    min: 0,
    max: 6,
    step: 1,
    label: 'Master Gain',
    scale: 'Index 0..6 (0/+3/+6/+9/+12/+15/+18 dB); SonyRcpPanel GAIN_VALUES, SonyMncClient gainIsoMap, GAIN_INDEX_TO_ISO',
  },
  ndFilter: {
    command: 'setNdFilter',
    min: 0,
    max: 3,
    step: 1,
    label: 'ND Filter',
    scale: 'Index 0..3; SonyRcpPanel ND_VALUES nennt vier Stellungen',
  },
};

/** Warum ein Trimm nicht ausgefuehrt wird. */
export type NudgeRefusal =
  /** Der Parameter steht nicht in `PAINT_PARAMETERS`. */
  | 'unknown-parameter'
  /**
   * Die Bruecke hat diesen Wert an dieser Kamera noch nie gesehen. KEIN
   * geratener Ausgangswert — das ist die Engstelle dieses Moduls.
   */
  | 'no-current-value'
  /** `by` fehlt, ist 0 oder keine Zahl: ein Trimm ohne Richtung ist keiner. */
  | 'zero-step'
  /** Der Wert steht schon am Anschlag in der gewuenschten Richtung. */
  | 'at-limit';

export const NUDGE_REFUSAL_LABEL: Readonly<Record<NudgeRefusal, string>> = {
  'unknown-parameter': 'Dieser Wert laesst sich nicht relativ verstellen.',
  'no-current-value':
    'Der aktuelle Wert ist unbekannt — die Kamera hat ihn noch nicht gemeldet. ' +
    'Einmal absolut setzen, dann laesst sich von dort aus trimmen.',
  'zero-step': 'Ein Trimm braucht eine Richtung: "by" fehlt oder ist 0.',
  'at-limit': 'Der Wert steht bereits am Anschlag.',
};

export interface NudgeResolved {
  /** Das absolute Kommando, das jetzt an das Backend geht. */
  command: string;
  /** Sein Wert. Ganzzahlig und im Bereich. */
  value: number;
  /** Wovon aus getrimmt wurde — der GELESENE Wert, nie ein geratener. */
  from: number;
  /**
   * Ob der Anschlag den Schritt verkuerzt hat. Der Zug findet statt, ist
   * aber kleiner als verlangt; das Pult darf das anzeigen.
   */
  clamped: boolean;
}

export type NudgeResolution = NudgeResolved | { refusal: NudgeRefusal };

/** Steht in `PAINT_PARAMETERS`? */
export function isPaintParameter(name: string): name is PaintParameter {
  return Object.prototype.hasOwnProperty.call(PAINT_PARAMETERS, name);
}

/**
 * Die Engstelle: loest einen relativen Zug in ein absolutes Kommando auf.
 *
 * `state` ist der Zustand, den die Bruecke fuer diese Kamera FUEHRT — aus
 * Meldungen des Backends und aus dem Echo bestaetigter Kommandos. Fehlt der
 * Wert darin, kommt eine Absage; siehe `no-current-value`.
 */
export function resolveNudge(
  parameter: string,
  by: number,
  state: Readonly<Partial<CameraState>> | undefined,
): NudgeResolution {
  if (!isPaintParameter(parameter)) return { refusal: 'unknown-parameter' };
  if (!Number.isFinite(by) || by === 0) return { refusal: 'zero-step' };

  const spec = PAINT_PARAMETERS[parameter];
  const gelesen = state?.[parameter];
  if (typeof gelesen !== 'number' || !Number.isFinite(gelesen)) {
    return { refusal: 'no-current-value' };
  }

  // Der gelesene Wert kann selbst ausserhalb des Bus-Bereichs liegen (eine
  // Kamera meldet, was sie will). Er wird fuer die Rechnung hereingeholt,
  // aber `from` bleibt der gemeldete Wert: das Pult soll sehen, was die
  // Kamera gesagt hat, nicht was die Bruecke daraus gemacht hat.
  const basis = klemmen(Math.round(gelesen), spec);
  const gewuenscht = basis + Math.round(by);
  const ziel = klemmen(gewuenscht, spec);

  if (ziel === basis) return { refusal: 'at-limit' };

  return {
    command: spec.command,
    value: ziel,
    from: gelesen,
    clamped: ziel !== gewuenscht,
  };
}

const klemmen = (v: number, spec: PaintParameterSpec): number =>
  Math.max(spec.min, Math.min(spec.max, v));

/**
 * Die relativen Tasten, wie Companion und das Bedienpult sie kennen.
 *
 * EINE Liste fuer beides: die Aktions-Ids, die `CompanionServer` als Presets
 * anbietet, und die Aufloesung, die `BridgeServer` darauf anwendet. Vorher
 * standen die Ids in der Preset-Liste und die Rechnung im Dispatcher, und
 * `masterBlack` fehlte in beiden.
 *
 * Die vier alten Ids (`irisUp`, `irisDown`, `gainUp`, `gainDown`, `ndUp`,
 * `ndDown`) bleiben unveraendert: es gibt Companion-Seiten da draussen, auf
 * denen sie auf Tasten liegen.
 */
export interface NudgeAction {
  readonly parameter: PaintParameter;
  /** Um wie viel, mit Vorzeichen. Aus `PAINT_PARAMETERS[...].step`. */
  readonly by: number;
  readonly label: string;
  readonly category: string;
}

const auf = (p: PaintParameter, label: string, category: string): NudgeAction => ({
  parameter: p,
  by: PAINT_PARAMETERS[p].step,
  label,
  category,
});
const ab = (p: PaintParameter, label: string, category: string): NudgeAction => ({
  parameter: p,
  by: -PAINT_PARAMETERS[p].step,
  label,
  category,
});

export const NUDGE_ACTIONS: Readonly<Record<string, NudgeAction>> = {
  irisUp: auf('iris', 'Iris +', 'Exposure'),
  irisDown: ab('iris', 'Iris -', 'Exposure'),
  // „Gain +3dB" hiess die Taste frueher. Das stimmt nur, solange die Kamera
  // die Sony-Tabelle in 3-dB-Stufen benutzt — auf einer Canon oder Z CAM ist
  // derselbe Index ein ISO-Wert aus einer anderen Reihe. Die Taste bewegt
  // eine STUFE; was die Stufe an der jeweiligen Kamera bedeutet, steht in der
  // Skalen-Tabelle der README.
  gainUp: auf('masterGain', 'Gain + (1 step)', 'Exposure'),
  gainDown: ab('masterGain', 'Gain - (1 step)', 'Exposure'),
  ndUp: auf('ndFilter', 'ND +', 'Exposure'),
  ndDown: ab('ndFilter', 'ND -', 'Exposure'),
  // Der Wert aus dem Beleg. Bis hierher gab es fuer ihn ueberhaupt keine
  // relative Bedienung — weder in Companion noch am Web-RCP.
  blackUp: auf('masterBlack', 'Master Black +', 'Black'),
  blackDown: ab('masterBlack', 'Master Black -', 'Black'),
  gammaUp: auf('masterGamma', 'Master Gamma +', 'Picture'),
  gammaDown: ab('masterGamma', 'Master Gamma -', 'Picture'),
  satUp: auf('saturation', 'Saturation +', 'Picture'),
  satDown: ab('saturation', 'Saturation -', 'Picture'),
};
