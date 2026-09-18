/**
 * HID Control-Surface Input Adapter
 *
 * Turns a USB control panel (knobs / faders / buttons) into an *input* for the
 * bridge: instead of the bridge controlling a camera, the panel drives the
 * bridge's RCP command bus, so one physical surface controls whatever camera is
 * currently connected — Sony, Canon, Lumix, Blackmagic, PTZ, … all at once.
 *
 * This is the integration path for a Blackmagic (or any) USB-C control panel,
 * for ein selbstgebautes Pult (siehe `docs/ptz-pult-hardware.md`) und fuer
 * einen Spiele-Controller. Because every panel reports a different HID layout,
 * the mapping from report bytes to commands is data-driven (see HidBinding);
 * the user picks their device and tunes the mapping to its report format. The
 * native `node-hid` module is optional and loaded lazily, so the bridge runs
 * without it.
 *
 * ─── WARUM HIER MEHR STEHT ALS „Byte auf 0..255 skalieren" ──────────────────
 *
 * Ein Fader ist einseitig, ein Joystick nicht. Wer eine Stick-Achse mit der
 * Fader-Rechnung behandelt, bekommt fuer „ganz links" den Wert 0 und fuer
 * „Mitte" die 128 — eine Richtung gibt es dann nicht mehr, und ein Fahrbefehl
 * braucht genau die. Deshalb kennt eine Bindung drei Dinge, die es vorher
 * nicht gab:
 *
 *   1. `centre` macht die Achse ZWEISEITIG: Ausgabe -span … +span.
 *   2. `deadband` gibt die Ruhelage zurueck. Ein Stick in Ruhe wackelt in den
 *      letzten Bits; ohne Totband schickt das Pult dauernd Fahrbefehle, und
 *      der Kopf kriecht, obwohl niemand etwas anfasst.
 *   3. `group` buendelt zwei Achsen in EINEN Befehl. `ptz` will `pan` und
 *      `tilt` zusammen; zwei getrennte Befehle waeren zwei Fahrten, von denen
 *      die zweite die erste aufhebt.
 *
 * Und `bit` fuer Tasten: Gamepads legen acht Tasten in EIN Byte. Vorher war
 * der Merker fuer „hat sich geaendert" auf den Byte-Offset verschluesselt —
 * zwei Tasten im selben Byte haben sich damit gegenseitig ausgeloescht.
 */
import { EventEmitter } from 'events';

export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  path?: string;
}

export interface HidBinding {
  kind: 'axis' | 'button';
  /** Byte offset of the value within the HID input report. */
  offset: number;
  /** Number of bytes for an axis value (1 or 2, little-endian). Default 1. */
  bytes?: number;
  /** RCP command to emit, e.g. 'setIris'. */
  command: string;
  /** Param key for an axis value, e.g. 'value'. */
  paramKey?: string;
  /** Extra static params merged into the emitted command (e.g. { on: true }). */
  params?: Record<string, unknown>;
  /** Raw axis range. Defaults to 0..255 (or 0..65535 for `bytes: 2`). */
  min?: number;
  max?: number;

  /**
   * Bit innerhalb des Bytes bei `offset` (nur `kind: 'button'`).
   *
   * Fehlt es, zaehlt das ganze Byte als Taste — so war es vorher, und ein
   * Pult mit einer Taste je Byte bleibt damit unveraendert.
   */
  bit?: number;

  /**
   * Rohwert der Ruhelage. Gesetzt heisst: die Achse ist ZWEISEITIG und gibt
   * -`span` … +`span` aus statt 0 … `span`.
   */
  centre?: number;

  /**
   * Ausgabe-Spanne. Vorgabe 100 fuer zweiseitige Achsen (so rechnen die
   * Fahrbefehle), 255 fuer einseitige (so rechnen die Paint-Befehle).
   */
  span?: number;

  /** Rohwerte um `centre` (bzw. um `min`), die als Ruhe gelten. */
  deadband?: number;

  /** Faktor nach der Normierung. -1 dreht die Achse um. */
  gain?: number;

  /**
   * Erst ab dieser Ausgabe-Aenderung wird gesendet. Haelt das Zittern eines
   * gehaltenen Sticks von der Leitung fern; die Ruhelage 0 geht immer durch,
   * sonst bliebe ein Kopf im Zweifel fahren.
   */
  step?: number;

  /**
   * Bindungen mit derselben Gruppe und demselben `command` werden zu EINEM
   * Befehl zusammengefasst; jede steuert ueber ihren `paramKey` einen
   * Parameter bei.
   */
  group?: string;

  /**
   * In einer Gruppe auf denselben Parameter ADDIEREN statt ihn zu setzen.
   *
   * Dafuer gibt es einen konkreten Fall: die beiden Trigger eines Gamepads
   * fahren denselben Zoom in entgegengesetzte Richtungen. Als zwei eigene
   * Befehle heben sie sich je nach Reihenfolge gegenseitig auf -- einer
   * faehrt, der andere stoppt im selben Report. Addiert (der eine mit
   * `gain: -1`) ergibt sich EIN Wert, und beide gedrueckt heisst Stillstand.
   */
  sum?: boolean;
}

export interface HidSurfaceConfig {
  vendorId: number;
  productId: number;
  path?: string;
  bindings: HidBinding[];
  /** Rohe Reports mitschicken, damit man die Offsets eines Pultes ausmisst. */
  debug?: boolean;
}

/**
 * Vorgabe fuer ein PAINT-Pult (Fader und Knoepfe), nicht fuer einen Joystick.
 *
 * Das ist keine Kleinigkeit: `setIris` und `setMasterGain` sind bei VISCA
 * 9-Byte-Pakete, und der DigitalBird-DB3-Decoder liest bei dieser Groesse die
 * Bytes 6/7 als Pan/Tilt-Richtung (siehe `docs/ptz-pult-hardware.md`,
 * Anhang A). Eine Stick-Achse auf `setIris` laesst dort den Kopf losfahren.
 * Deshalb waehlt `standardBindungen()` fuer bekannte Gamepads eine andere
 * Tabelle, statt diese auf alles anzuwenden.
 */
export const DEFAULT_BINDINGS: HidBinding[] = [
  { kind: 'axis', offset: 1, command: 'setIris', paramKey: 'value' },
  { kind: 'axis', offset: 2, command: 'setMasterGain', paramKey: 'value', max: 7 },
  { kind: 'axis', offset: 3, bytes: 2, command: 'setColorTemp', paramKey: 'value', min: 0, max: 65535 },
  { kind: 'button', offset: 5, command: 'setRecording', params: { on: true } },
];

// ─── Gamepads ───────────────────────────────────────────────────────────────

/** Sony Interactive Entertainment. */
export const VENDOR_SONY = 0x054c;
export const PID_DUALSENSE = 0x0ce6;
export const PID_DUALSENSE_EDGE = 0x0df2;
export const PID_DUALSHOCK4_V1 = 0x05c4;
export const PID_DUALSHOCK4_V2 = 0x09cc;

/**
 * DualSense am USB-Kabel.
 *
 * Die Offsets sind das dokumentierte USB-Report-Format (Report-ID 0x01 an
 * Byte 0, danach LX, LY, RX, RY, L2, R2). **Sie sind nicht am Geraet
 * nachgemessen** — ueber Bluetooth liegt derselbe Controller anders, und ob
 * `node-hid` die Report-ID mitliefert, haengt an der Plattform. Wer eine
 * Achse an der falschen Stelle findet, schaltet `debug` ein: die Bruecke
 * schickt dann jeden Report als Hex, und die Offsets sind in einer Minute
 * ausgezaehlt. Lieber eine Tabelle, die man pruefen kann, als eine, die man
 * glauben muss.
 *
 * Belegung: linker Stick Pan/Tilt, die analogen Trigger Zoom (R2 tele,
 * L2 weit), rechter Stick senkrecht Fokus, die vier Symboltasten rufen die
 * Posen 1-4, L1 loest den Autofokus aus.
 */
export const DUALSENSE_BINDINGS: HidBinding[] = [
  { kind: 'axis', offset: 1, command: 'ptz', paramKey: 'pan', group: 'stick', centre: 128, deadband: 6, span: 100, step: 3 },
  // Am Stick ist oben der KLEINE Rohwert; `gain: -1` dreht das um, damit
  // „Stick nach oben" auch „Kopf nach oben" heisst.
  { kind: 'axis', offset: 2, command: 'ptz', paramKey: 'tilt', group: 'stick', centre: 128, deadband: 6, span: 100, step: 3, gain: -1 },
  { kind: 'axis', offset: 4, command: 'setFocus', paramKey: 'value', centre: 128, deadband: 10, span: 100, step: 5, gain: -1 },
  { kind: 'axis', offset: 6, command: 'setZoom', paramKey: 'value', group: 'zoom', sum: true, deadband: 8, span: 100, step: 5 },
  { kind: 'axis', offset: 5, command: 'setZoom', paramKey: 'value', group: 'zoom', sum: true, deadband: 8, span: 100, step: 5, gain: -1 },
  { kind: 'button', offset: 8, bit: 4, command: 'recallPreset', params: { value: 1 } },
  { kind: 'button', offset: 8, bit: 5, command: 'recallPreset', params: { value: 2 } },
  { kind: 'button', offset: 8, bit: 6, command: 'recallPreset', params: { value: 3 } },
  { kind: 'button', offset: 8, bit: 7, command: 'recallPreset', params: { value: 4 } },
  { kind: 'button', offset: 9, bit: 0, command: 'autoFocus' },
];

/**
 * DualShock 4 am USB-Kabel — dieselbe Belegung, andere Offsets.
 *
 * Der Unterschied ist der Grund fuer zwei Tabellen statt einer mit
 * Sonderfaellen: beim DS4 liegen die analogen Trigger auf 8/9 und die
 * Symboltasten im oberen Nibble von Byte 5.
 */
export const DUALSHOCK4_BINDINGS: HidBinding[] = [
  { kind: 'axis', offset: 1, command: 'ptz', paramKey: 'pan', group: 'stick', centre: 128, deadband: 6, span: 100, step: 3 },
  { kind: 'axis', offset: 2, command: 'ptz', paramKey: 'tilt', group: 'stick', centre: 128, deadband: 6, span: 100, step: 3, gain: -1 },
  { kind: 'axis', offset: 4, command: 'setFocus', paramKey: 'value', centre: 128, deadband: 10, span: 100, step: 5, gain: -1 },
  { kind: 'axis', offset: 9, command: 'setZoom', paramKey: 'value', group: 'zoom', sum: true, deadband: 8, span: 100, step: 5 },
  { kind: 'axis', offset: 8, command: 'setZoom', paramKey: 'value', group: 'zoom', sum: true, deadband: 8, span: 100, step: 5, gain: -1 },
  { kind: 'button', offset: 5, bit: 4, command: 'recallPreset', params: { value: 1 } },
  { kind: 'button', offset: 5, bit: 5, command: 'recallPreset', params: { value: 2 } },
  { kind: 'button', offset: 5, bit: 6, command: 'recallPreset', params: { value: 3 } },
  { kind: 'button', offset: 5, bit: 7, command: 'recallPreset', params: { value: 4 } },
  { kind: 'button', offset: 6, bit: 0, command: 'autoFocus' },
];

/**
 * Welche Tabelle gilt, wenn der Aufrufer keine mitgibt.
 *
 * Ein bekanntes Gamepad bekommt die Fahr-Belegung, alles Uebrige die
 * Paint-Belegung. Der Grund steht bei `DEFAULT_BINDINGS`: die falsche Tabelle
 * ist an einem PTZ-Kopf nicht bloss unbrauchbar, sie faehrt.
 */
export function standardBindungen(vendorId: number, productId: number): HidBinding[] {
  if (vendorId !== VENDOR_SONY) return DEFAULT_BINDINGS;
  if (productId === PID_DUALSENSE || productId === PID_DUALSENSE_EDGE) return DUALSENSE_BINDINGS;
  if (productId === PID_DUALSHOCK4_V1 || productId === PID_DUALSHOCK4_V2) return DUALSHOCK4_BINDINGS;
  return DEFAULT_BINDINGS;
}

/** Ist das ein Gamepad, fuer das eine Fahr-Belegung hinterlegt ist? */
export function istBekanntesGamepad(vendorId: number, productId: number): boolean {
  return standardBindungen(vendorId, productId) !== DEFAULT_BINDINGS;
}

// ─── Report-Auswertung (rein, damit sie pruefbar ist) ────────────────────────

export interface EmittedCommand {
  cmd: string;
  params: Record<string, unknown>;
}

/** Rohwert einer Bindung aus dem Report holen. */
export function rohWert(buf: Buffer, b: HidBinding): number {
  if ((b.bytes ?? 1) === 2) {
    return b.offset + 1 < buf.length ? buf.readUInt16LE(b.offset) : 0;
  }
  return b.offset < buf.length ? buf[b.offset] : 0;
}

/**
 * Rohwert einer Achse auf den Ausgabewert bringen.
 *
 * Zweiseitig, sobald `centre` gesetzt ist; sonst die alte Fader-Rechnung, die
 * die vorhandenen Pult-Bindungen unveraendert laesst.
 */
export function achsenWert(b: HidBinding, raw: number): number {
  const voll = (b.bytes ?? 1) === 2 ? 65535 : 255;
  const min = b.min ?? 0;
  const max = b.max ?? voll;
  const gain = b.gain ?? 1;
  const tot = b.deadband ?? 0;

  if (b.centre !== undefined) {
    const span = b.span ?? 100;
    const d = raw - b.centre;
    if (Math.abs(d) <= tot) return 0;
    // Die halbe Spanne haengt an der Richtung: eine Achse, deren Ruhelage
    // nicht in der Mitte liegt, hat nach oben und unten verschieden viel Weg.
    const halb = d > 0 ? max - b.centre : b.centre - min;
    const nutz = Math.max(1, halb - tot);
    const ab = Math.sign(d) * (Math.abs(d) - tot);
    const out = Math.round((ab / nutz) * span) * gain;
    return Math.max(-span, Math.min(span, out));
  }

  const span = b.span ?? 255;
  if (raw - min <= tot) return 0;
  const nutz = Math.max(1, max - min - tot);
  const out = Math.round(((raw - min - tot) / nutz) * span) * gain;
  return Math.max(-span, Math.min(span, out));
}

/**
 * Der Zustand zwischen zwei Reports: je Bindung der zuletzt GESENDETE Wert.
 *
 * Auf den Index verschluesselt und nicht mehr auf den Byte-Offset. Das ist die
 * Behebung des Fehlers, an dem sich zwei Tasten im selben Byte gegenseitig
 * ausgeloescht haben.
 */
export type ReportZustand = Map<number, number>;

/**
 * Einen Report auswerten und die faelligen Befehle zurueckgeben.
 *
 * Gesendet wird nur, was sich geaendert hat — ein Fahrbefehl laeuft, bis der
 * naechste kommt, und ein wiederholter waere bloss Last auf der Leitung.
 */
export function berechneBefehle(
  bindings: HidBinding[],
  buf: Buffer,
  zustand: ReportZustand,
): EmittedCommand[] {
  const befehle: EmittedCommand[] = [];
  const gruppen = new Map<string, { cmd: string; params: Record<string, unknown>; geaendert: boolean }>();

  bindings.forEach((b, i) => {
    const raw = rohWert(buf, b);

    if (b.kind === 'button') {
      const wert = b.bit === undefined ? (raw === 0 ? 0 : 1) : (raw >> b.bit) & 1;
      const vorher = zustand.get(i) ?? 0;
      zustand.set(i, wert);
      // Nur die steigende Flanke: Loslassen ist kein zweiter Tastendruck.
      if (vorher === 0 && wert === 1) {
        befehle.push({ cmd: b.command, params: { ...(b.params ?? {}) } });
      }
      return;
    }

    const wert = achsenWert(b, raw);
    const vorher = zustand.get(i);
    const schritt = b.step ?? 1;
    /**
     * Neu ist ein Wert, wenn es keinen Vorgaenger gibt, wenn die Achse
     * ZUR Ruhe kommt (der Stopp darf nie verschluckt werden, sonst faehrt
     * der Kopf weiter) oder wenn der Schritt gross genug ist.
     *
     * Die Ruhe selbst ist ausdruecklich NICHT jedes Mal neu: sonst schickte
     * ein Pult, das niemand anfasst, mit jedem Report einen Stopp.
     */
    const neu = vorher === undefined
      || (wert === 0 && vorher !== 0)
      || Math.abs(wert - vorher) >= schritt;
    if (neu) zustand.set(i, wert);
    // Eine Gruppe braucht auch von der unveraenderten Achse einen Wert --
    // sonst stuende im gemeinsamen Befehl fuer sie nichts.
    const wirksam = neu ? wert : (vorher ?? 0);

    if (b.group) {
      const g = gruppen.get(b.group) ?? { cmd: b.command, params: {}, geaendert: false };
      Object.assign(g.params, b.params ?? {});
      const key = b.paramKey ?? 'value';
      const span = b.span ?? (b.centre !== undefined ? 100 : 255);
      const summe = b.sum ? ((g.params[key] as number | undefined) ?? 0) + wirksam : wirksam;
      g.params[key] = Math.max(-span, Math.min(span, summe));
      if (neu) g.geaendert = true;
      gruppen.set(b.group, g);
      return;
    }

    if (neu) {
      befehle.push({ cmd: b.command, params: { [b.paramKey ?? 'value']: wert, ...(b.params ?? {}) } });
    }
  });

  for (const g of gruppen.values()) {
    if (g.geaendert) befehle.push({ cmd: g.cmd, params: g.params });
  }
  return befehle;
}

async function loadHid(): Promise<any | null> {
  try {
    const moduleName = 'node-hid';
    return await import(moduleName);
  } catch {
    return null;
  }
}

/** Enumerate connected HID devices so the user can pick their control panel. */
export async function listHidDevices(): Promise<{ devices: HidDeviceInfo[]; reason?: string }> {
  const hid = await loadHid();
  if (!hid) {
    return {
      devices: [],
      reason: 'Natives Modul fehlt: npm install node-hid --workspace=packages/bridge',
    };
  }
  try {
    const list = (hid.devices() as any[]).map((d) => ({
      vendorId: d.vendorId,
      productId: d.productId,
      product: d.product,
      manufacturer: d.manufacturer,
      path: d.path,
    }));
    return { devices: list };
  } catch (err) {
    return { devices: [], reason: `HID-Zugriff fehlgeschlagen: ${(err as Error).message}` };
  }
}

export class HidControlSurface extends EventEmitter {
  private device: any = null;
  private bindings: HidBinding[];
  private vendorId: number;
  private productId: number;
  private path?: string;
  private debug: boolean;
  private zustand: ReportZustand = new Map();
  private running = false;

  constructor(config: HidSurfaceConfig) {
    super();
    this.vendorId = config.vendorId;
    this.productId = config.productId;
    this.path = config.path;
    this.debug = config.debug ?? false;
    this.bindings = config.bindings?.length
      ? config.bindings
      : standardBindungen(config.vendorId, config.productId);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Welche Tabelle gerade gilt — die Oberflaeche sagt es dem Bedienenden. */
  get aktiveBindungen(): readonly HidBinding[] {
    return this.bindings;
  }

  async start(): Promise<void> {
    const hid = await loadHid();
    if (!hid) {
      throw new Error('Natives Modul fehlt: npm install node-hid --workspace=packages/bridge');
    }
    this.device = this.path ? new hid.HID(this.path) : new hid.HID(this.vendorId, this.productId);
    this.device.on('data', (buf: Buffer) => this.onReport(buf));
    this.device.on('error', (err: Error) => this.emit('error', err));
    this.running = true;
    this.emit('started', {
      vendorId: this.vendorId,
      productId: this.productId,
      gamepad: istBekanntesGamepad(this.vendorId, this.productId),
      bindings: this.bindings.length,
    });
  }

  stop(): void {
    try {
      this.device?.close();
    } catch {
      /* ignore */
    }
    this.device = null;
    this.running = false;
    this.zustand.clear();
    this.emit('stopped');
  }

  private onReport(buf: Buffer): void {
    if (this.debug) this.emit('report', buf.toString('hex'));
    for (const befehl of berechneBefehle(this.bindings, buf, this.zustand)) {
      this.emit('command', befehl);
    }
  }
}
