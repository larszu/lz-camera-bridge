/**
 * Den Kamera-Plan aus dem MultiCam-Planner gegen die Kameras am Bus halten
 * (B-41.1).
 *
 * WORUM ES GEHT. Der MultiCam-Planner exportiert eine `camera-list`: welche
 * Kameras geplant sind, mit Beschriftung ("CAM 1"), Hersteller, Modell und
 * Standort im Raum. Diese Bruecke kennt dieselben Kameras von der anderen
 * Seite: eine Nummer, eine Verbindungsart und eine Adresse. Beide Listen
 * beschreiben dieselbe Anlage, und niemand hat sie bisher aneinandergehalten.
 * Wer am Pult sitzt, sieht "Kamera 3" und muss selbst wissen, dass das die
 * ist, die im Plan "CAM 3 — Buehne links" heisst.
 *
 * WAS EIN ABGLEICH HIER HEISST — UND WAS NICHT. Diese Bruecke kann in vielen
 * Faellen NICHT wissen, welches Geraet an einer Adresse haengt: bei TCP und
 * seriell steht dort ein Host und ein Port, kein Modellname. Ein Abgleich, der
 * dann trotzdem etwas behauptet, waere geraten. Deshalb liefert die Zuordnung
 * hier immer einen BELEG mit (`matchedBy`), und wo es keinen gibt, liefert sie
 * nichts:
 *
 *   'model'   Die Bruecke KENNT das Modell (USB-Erkennung, MNC-Discovery) und
 *             es passt eindeutig zu genau einer geplanten Kamera. Gemessen.
 *   'number'  Die Beschriftung im Plan traegt dieselbe Zahl wie der Slot
 *             ("CAM 3" ↔ Kamera 3). Das ist eine Konvention, keine Messung —
 *             und es steht als Vorschlag da, nicht als Tatsache.
 *   'manual'  Ein Mensch hat sie zugeordnet. Ueberschreibt alles.
 *
 * EINDEUTIG ODER GAR NICHT. Passt ein Modell auf zwei Slots (zwei FX9 im
 * Rack), gibt es keinen Vorschlag. Zwei plausible Zuordnungen sind keine
 * halbe Zuordnung, sondern eine Verwechslungsgefahr — und die falsche Kamera
 * zu schwenken, weil das Pult sie falsch beschriftet hat, ist genau der
 * Schaden, gegen den das hier gebaut ist.
 *
 * Reine Funktionen: kein Netz, keine Datei, keine Uhr.
 */

export const CAMERA_LIST_KIND = 'camera-list';
/** Gelesen werden v1 bis v3; geschrieben wird hier nichts. */
export const CAMERA_LIST_READABLE_VERSIONS: readonly number[] = [1, 2, 3];
export const CAMERA_LIST_VERSION = 3;

/**
 * Ein geplanter Shot (v3): Pan/Tilt in Grad im RAUM (MultiCam: Pan 0 = nach
 * rechts im Grundriss, im Uhrzeigersinn positiv; Tilt negativ = nach unten),
 * Brennweite und Fokusdistanz. Wie daraus eine Kopf-Pose wird, steht in
 * `protocol/ptzPose.ts`.
 */
export interface PlanPreset {
  number: number;
  name: string;
  segment?: string;
  pan: number;
  tilt: number;
  focalMm?: number;
  focusM?: number;
  savedAt?: string;
}

export interface PlanLens {
  manufacturer?: string;
  model?: string;
  focalMinMm?: number;
  focalMaxMm?: number;
  mount?: string;
}

/** Eine geplante Kamera, wie der MultiCam-Planner sie herausgibt. */
export interface PlanCamera {
  id: string;
  label: string;
  manufacturer?: string;
  model?: string;
  /** Stabile Geraetetyp-Identitaet. Hier nur durchgereicht. */
  deviceTypeId?: string;
  /** Meter im Raum, von links / von oben; z = Hoehe. */
  x?: number;
  y?: number;
  z?: number;
  /** v3: geplante Ausrichtung des Kopfs in Ruhe — die Heimat-Richtung, Grad im Raum. */
  pan?: number;
  tilt?: number;
  /** v2: eingestellte Brennweite und Optik. */
  focalMm?: number;
  lens?: PlanLens;
  /** v3: gespeicherte Shots, nach Nummer. */
  presets?: PlanPreset[];
}

export interface CameraPlan {
  kind: typeof CAMERA_LIST_KIND;
  formatVersion: number;
  app: string;
  appVersion: string;
  exportedAt: string;
  cameras: PlanCamera[];
}

/** Was diese Bruecke ueber einen Slot weiss, soweit es fuer den Abgleich zaehlt. */
export interface SlotFacts {
  num: number;
  /**
   * Modellname, WENN die Bruecke ihn kennt: aus der USB-Erkennung
   * (`usbDeviceModel`) oder aus der MNC-Discovery. Bei TCP und seriell steht
   * hier nichts — dort weiss die Bruecke eine Adresse, kein Geraet.
   */
  knownModel?: string;
  /** Bereits zugeordnete Plan-Kamera (aus einer frueheren Sitzung). */
  planCameraId?: string;
}

export type MatchEvidence = 'model' | 'number' | 'manual';

export interface PlanMatch {
  planCameraId: string;
  label: string;
  /** Slot-Nummer, wenn es eine Zuordnung gibt. */
  cameraNumber?: number;
  matchedBy?: MatchEvidence;
  /**
   * Warum es KEINE Zuordnung gibt, im Klartext. Steht in der Antwort, damit
   * am Pult niemand raten muss, ob der Abgleich versagt hat oder ob es
   * schlicht nichts zu belegen gab.
   */
  reason?: string;
}

export interface PlanMatchResult {
  matches: PlanMatch[];
  /** Slots am Bus, denen keine geplante Kamera zugeordnet ist. */
  unmatchedSlots: number[];
}

/** Ein gelesener Wert, der ein Kamera-Plan sein soll. */
export function parseCameraPlan(text: string): CameraPlan | null {
  let roh: unknown;
  try {
    roh = JSON.parse(text);
  } catch {
    return null;
  }
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as Record<string, unknown>;
  if (o.kind !== CAMERA_LIST_KIND) return null;
  // Eine unbekannte Version wird benannt abgelehnt, nicht still gelesen: der
  // Vertrag der Liste (cameraListContract) verlangt, dass ein Leser, der
  // eine Version nicht kennt, die Presets nicht einfach verliert.
  if (typeof o.formatVersion !== 'number' || !CAMERA_LIST_READABLE_VERSIONS.includes(o.formatVersion)) return null;
  if (!Array.isArray(o.cameras)) return null;

  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  const nurBekannt = <T extends object>(obj: T): T =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;

  const cameras: PlanCamera[] = [];
  for (const c of o.cameras as unknown[]) {
    if (!c || typeof c !== 'object') continue;
    const x = c as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.label !== 'string') continue;
    const lensRaw = x.lens && typeof x.lens === 'object' ? (x.lens as Record<string, unknown>) : null;
    const lens = lensRaw
      ? nurBekannt<PlanLens>({
          manufacturer: str(lensRaw.manufacturer), model: str(lensRaw.model),
          focalMinMm: num(lensRaw.focalMinMm), focalMaxMm: num(lensRaw.focalMaxMm), mount: str(lensRaw.mount),
        })
      : undefined;
    const presets: PlanPreset[] = [];
    if (Array.isArray(x.presets)) {
      for (const p of x.presets as unknown[]) {
        if (!p || typeof p !== 'object') continue;
        const q = p as Record<string, unknown>;
        const number = num(q.number);
        const pan = num(q.pan);
        const tilt = num(q.tilt);
        if (number === undefined || !Number.isInteger(number) || number < 0 || pan === undefined || tilt === undefined) continue;
        presets.push(nurBekannt<PlanPreset>({
          number, pan, tilt,
          name: typeof q.name === 'string' ? q.name : '',
          segment: str(q.segment), focalMm: num(q.focalMm), focusM: num(q.focusM), savedAt: str(q.savedAt),
        }));
      }
      presets.sort((a, b) => a.number - b.number);
    }
    cameras.push(nurBekannt<PlanCamera>({
      id: x.id,
      label: x.label,
      manufacturer: str(x.manufacturer),
      model: str(x.model),
      deviceTypeId: str(x.deviceTypeId),
      x: num(x.x), y: num(x.y), z: num(x.z),
      pan: num(x.pan), tilt: num(x.tilt),
      focalMm: num(x.focalMm),
      lens: lens && Object.keys(lens).length ? lens : undefined,
      presets: presets.length ? presets : undefined,
    }));
  }

  return {
    kind: CAMERA_LIST_KIND,
    formatVersion: o.formatVersion,
    app: typeof o.app === 'string' ? o.app : '',
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : '',
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
    cameras,
  };
}

/**
 * Vergleichsform eines Modellnamens.
 *
 * Ohne Leerzeichen, Bindestriche und Gross-/Kleinschreibung: "ILME-FX3",
 * "ILME FX3" und "ilmefx3" sind dasselbe Geraet, und die drei Schreibweisen
 * kommen aus drei Quellen (USB-Produktstring, SSDP-Header, Katalog des
 * Planers). Weiter zu normalisieren waere geraten.
 */
const modelKey = (s: string): string => s.toLowerCase().replace(/[\s\-_]+/g, '');

/**
 * Passt ein bekanntes Modell zu einer geplanten Kamera?
 *
 * Enthaltensein in BEIDE Richtungen, weil die Quellen verschieden ausfuehrlich
 * sind: der USB-Produktstring sagt "ILME-FX3", der Katalog "FX3", und ein
 * SSDP-Header nennt gern noch die Firmware dazu.
 */
const modelPasst = (bekannt: string, geplant: string): boolean => {
  const a = modelKey(bekannt);
  const b = modelKey(geplant);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
};

/** Die Zahl in einer Beschriftung ("CAM 3", "Kamera 3", "3"). */
const zahlIn = (label: string): number | null => {
  const m = label.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
};

/**
 * Plan gegen Slots halten.
 *
 * Reihenfolge der Belege: was ein Mensch gesetzt hat, gilt. Danach das
 * gemessene Modell. Danach die Zahl in der Beschriftung — als Vorschlag.
 * Ein Slot wird hoechstens einmal vergeben.
 */
export function matchCameraPlan(plan: CameraPlan, slots: SlotFacts[]): PlanMatchResult {
  const vergeben = new Set<number>();
  const matches: PlanMatch[] = [];

  const nimm = (m: PlanMatch) => {
    if (m.cameraNumber !== undefined) vergeben.add(m.cameraNumber);
    matches.push(m);
  };

  // 1) Was ein Mensch zugeordnet hat. Ein Abgleich, der eine bestaetigte
  //    Zuordnung ueberschreibt, waere kein Abgleich, sondern ein Rueckschritt.
  const offen: PlanCamera[] = [];
  for (const cam of plan.cameras) {
    const slot = slots.find((s) => s.planCameraId === cam.id);
    if (slot) nimm({ planCameraId: cam.id, label: cam.label, cameraNumber: slot.num, matchedBy: 'manual' });
    else offen.push(cam);
  }

  // 2) Gemessenes Modell, und nur bei Eindeutigkeit in BEIDE Richtungen.
  const nachModell: PlanCamera[] = [];
  for (const cam of offen) {
    if (!cam.model) {
      nachModell.push(cam);
      continue;
    }
    const passende = slots.filter(
      (s) => !vergeben.has(s.num) && s.knownModel && modelPasst(s.knownModel, cam.model as string),
    );
    if (passende.length !== 1) {
      nachModell.push(cam);
      continue;
    }
    // Gegenrichtung: passt dieser Slot auch nur zu DIESER geplanten Kamera?
    const auchAndere = offen.filter(
      (c) => c.id !== cam.id && c.model && modelPasst(passende[0].knownModel as string, c.model),
    );
    if (auchAndere.length > 0) {
      nachModell.push(cam);
      continue;
    }
    nimm({ planCameraId: cam.id, label: cam.label, cameraNumber: passende[0].num, matchedBy: 'model' });
  }

  // 3) Die Zahl in der Beschriftung. Konvention, kein Beweis.
  for (const cam of nachModell) {
    const n = zahlIn(cam.label);
    const slot = n === null ? undefined : slots.find((s) => s.num === n && !vergeben.has(s.num));
    if (slot) {
      nimm({ planCameraId: cam.id, label: cam.label, cameraNumber: slot.num, matchedBy: 'number' });
      continue;
    }
    // Kein Beleg. Der Grund gehoert in die Antwort, nicht in ein Schweigen.
    const grund = !cam.model
      ? 'Der Plan nennt kein Modell, und die Beschriftung trägt keine freie Kameranummer.'
      : slots.some((s) => s.knownModel && modelPasst(s.knownModel, cam.model as string))
        ? 'Mehr als ein Gerät am Bus passt auf dieses Modell — eindeutig oder gar nicht.'
        : 'Kein Gerät am Bus meldet dieses Modell. Bei TCP und seriell kennt die Brücke nur eine Adresse.';
    nimm({ planCameraId: cam.id, label: cam.label, reason: grund });
  }

  return {
    matches,
    unmatchedSlots: slots.filter((s) => !vergeben.has(s.num)).map((s) => s.num).sort((a, b) => a - b),
  };
}
