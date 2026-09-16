/**
 * DJI Osmo Pocket als PTZ-Kopf (DUML).
 *
 * WAS HIER GEPRUEFT IST UND WAS NICHT -- bitte vor dem Weiterbauen lesen.
 * Geprueft sind die Rechenwege in `protocol/Duml.ts` (Rahmen, beide
 * Pruefsummen, Stromleser) gegen Tests. NICHT geprueft ist, ob eine Pocket
 * die Pakete annimmt: in diesem Haus stand keine. Der Rahmen stammt aus der
 * oeffentlichen Aufarbeitung des Protokolls, nicht aus einer Herstellerangabe
 * -- DJI veroeffentlicht fuer die Pocket-Reihe keine Schnittstelle.
 *
 * ZUM TRANSPORT, und das ist die wichtigste Einschraenkung: der BELEGTE Weg
 * zur Pocket ist **BLE** (Merkmal fff5, writeWithoutResponse). Ueber USB gibt
 * es fuer die Pocket-Reihe KEINE oeffentliche Steuerschnittstelle; der
 * USB-C-Anschluss dient Massenspeicher und UVC-Webcam. Dieser Client spricht
 * deshalb DUML ueber eine SERIELLE Leitung: das trifft zu, wenn das Geraet
 * (oder ein Adapter davor) sich als CDC-ACM meldet, und es ist der Weg, der
 * ohne ein weiteres natives Modul auskommt. Meldet sich kein serielles
 * Geraet, ist das kein Defekt dieses Codes, sondern die Aussage, dass dieser
 * Weg bei diesem Geraet nicht offensteht -- dann fuehrt nur BLE hin, und das
 * braucht eine Erweiterung (siehe docs/dji-gimbal.md).
 *
 * Der Transport ist bewusst hinter `DumlTransport` gekapselt, damit BLE
 * spaeter danebengesetzt werden kann, ohne die Kommandos anzufassen.
 */
import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient } from './GenericCameraClient.js';
import {
  dumlBauen, DumlStromLeser, dumlGeschwindigkeit, dumlAbsoluterWinkel,
  DUML_CMDSET_GIMBAL, DUML_CMD_GIMBAL_GESCHWINDIGKEIT, DUML_CMD_GIMBAL_ABSOLUT,
  type DumlRahmen,
} from '../protocol/Duml.js';

/** Worueber DUML-Rahmen gehen. Heute seriell; BLE passt in dieselbe Form. */
export interface DumlTransport extends EventEmitter {
  open(): Promise<void>;
  close(): void;
  write(buf: Buffer): Promise<void>;
}

export class DumlSerialTransport extends EventEmitter implements DumlTransport {
  private port: SerialPort | null = null;
  private readonly leser = new DumlStromLeser();

  constructor(private readonly pfad: string, private readonly baudRate = 115200) {
    super();
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ path: this.pfad, baudRate: this.baudRate }, (err) =>
        err ? reject(err) : resolve(),
      );
      this.port.on('data', (chunk: Buffer) => {
        for (const r of this.leser.push(chunk)) this.emit('rahmen', r);
      });
      this.port.on('error', (err) => this.emit('error', err));
    });
  }

  close(): void {
    try {
      this.port?.close();
    } catch {
      /* beim Zumachen belanglos */
    }
    this.port = null;
  }

  write(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) return reject(new Error(`DUML-Port ${this.pfad} ist nicht offen`));
      this.port.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * Wie schnell der Kopf bei Vollausschlag dreht. 90 Grad/s ist zuegig, aber
 * noch bedienbar; darueber wird aus einer Korrektur ein Schwenk.
 */
const MAX_GRAD_PRO_SEKUNDE = 90;

/**
 * Takt, in dem eine laufende Fahrt nachgeschickt wird.
 *
 * DJI-Gimbals halten ein Geschwindigkeits-Kommando ABSICHTLICH nur kurz
 * (beim R SDK ausdruecklich 0,5 s) -- ein Sicherheitsnetz: reisst die
 * Verbindung mitten im Schwenk ab, bleibt der Kopf stehen statt
 * weiterzulaufen. Fuer eine Dauerfahrt muss man deshalb NACHTAKTEN. Wer das
 * uebersieht, baut einen Kopf, der nach einem halben Meter stehenbleibt und
 * sucht den Fehler im Kabel.
 */
const NACHTAKT_MS = 200;

export class DjiOsmoClient extends EventEmitter implements GenericCameraClient {
  private transport: DumlTransport | null = null;
  private connected = false;
  private _state: CameraState = {};
  private folge = 1;
  private fahrt: { yaw: number; pitch: number } | null = null;
  private takt: NodeJS.Timeout | null = null;

  constructor(
    private readonly pfad: string,
    private readonly baudRate = 115200,
    transport?: DumlTransport,
  ) {
    super();
    if (transport) this.transport = transport;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    this.transport ??= new DumlSerialTransport(this.pfad, this.baudRate);
    this.transport.on('error', (err) => this.emit('error', err));
    this.transport.on('rahmen', (r: DumlRahmen) => this.emit('duml', r));
    await this.transport.open();
    this.connected = true;
    this.emit('connected', { pfad: this.pfad, protokoll: 'DUML' });
    return { pfad: this.pfad };
  }

  disconnect(): void {
    this.haltAn();
    this.connected = false;
    this.transport?.close();
    this.transport = null;
    this.emit('disconnected');
  }

  private async sende(cmdId: number, nutzlast: Uint8Array): Promise<void> {
    if (!this.transport) throw new Error('DUML-Transport ist nicht offen');
    const rahmen = dumlBauen({
      // 0x0A ist die uebliche Kennung der App-Seite, 0x03 der Gimbal.
      sender: 0x0a,
      empfaenger: 0x03,
      folge: this.folge,
      // 0x40: Anfrage ohne erzwungene Antwort.
      flags: 0x40,
      cmdSet: DUML_CMDSET_GIMBAL,
      cmdId,
      nutzlast,
    });
    this.folge = (this.folge + 1) & 0xffff;
    await this.transport.write(rahmen);
  }

  private haltAn(): void {
    if (this.takt) clearInterval(this.takt);
    this.takt = null;
    this.fahrt = null;
  }

  /** Startet/erneuert die Dauerfahrt, oder haelt sie an, wenn beide Achsen 0 sind. */
  private fahre(yawGradProS: number, pitchGradProS: number): Promise<void> {
    if (yawGradProS === 0 && pitchGradProS === 0) {
      this.haltAn();
      // Ein ausdrueckliches Null-Kommando, statt nur das Nachtakten
      // einzustellen: sonst liefe der Kopf bis zum Ablauf seines eigenen
      // Sicherheitsnetzes weiter -- bis zu einer halben Sekunde zu weit.
      return this.sende(DUML_CMD_GIMBAL_GESCHWINDIGKEIT, dumlGeschwindigkeit({ yaw: 0, pitch: 0 }));
    }
    this.fahrt = { yaw: yawGradProS, pitch: pitchGradProS };
    if (!this.takt) {
      this.takt = setInterval(() => {
        if (!this.fahrt) return;
        void this.sende(
          DUML_CMD_GIMBAL_GESCHWINDIGKEIT,
          dumlGeschwindigkeit({ yaw: this.fahrt.yaw, pitch: this.fahrt.pitch }),
        ).catch((err) => this.emit('error', err));
      }, NACHTAKT_MS);
      // `unref`, damit ein laufender Takt den Prozess nicht am Beenden hindert.
      this.takt.unref?.();
    }
    return this.sende(DUML_CMD_GIMBAL_GESCHWINDIGKEIT, dumlGeschwindigkeit({ yaw: yawGradProS, pitch: pitchGradProS }));
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'ptz': {
        // Das Pult liefert -100..100 je Achse, 0 ist Halt.
        const yaw = (num('pan') / 100) * MAX_GRAD_PRO_SEKUNDE;
        // Tilt ist am Pult "hoch ist positiv"; der Gimbal zaehlt Pitch
        // andersherum. Ohne dieses Minus faehrt der Kopf nach unten, wenn
        // der Bediener nach oben drueckt -- der Klassiker.
        const pitch = -(num('tilt') / 100) * MAX_GRAD_PRO_SEKUNDE;
        await this.fahre(yaw, pitch);
        return true;
      }
      case 'gotoAngle': {
        // Absolut anfahren: fuer Presets und fuer die Rueckkehr in die Mitte.
        this.haltAn();
        await this.sende(
          DUML_CMD_GIMBAL_ABSOLUT,
          dumlAbsoluterWinkel({ yaw: num('yaw'), pitch: num('pitch'), roll: num('roll') }),
        );
        return true;
      }
      case 'recenter': {
        this.haltAn();
        await this.sende(DUML_CMD_GIMBAL_ABSOLUT, dumlAbsoluterWinkel({ yaw: 0, pitch: 0, roll: 0 }));
        return true;
      }
      default:
        // Ein Gimbal ist kein CCU: Blende, Gain und Weissabgleich gehoeren
        // der Kamera und nicht diesem Weg. `false` heisst "kann ich nicht",
        // und das Pult graut den Regler aus, statt ihn wirkungslos anzubieten.
        return false;
    }
  }

  get state(): CameraState {
    return this._state;
  }
}
