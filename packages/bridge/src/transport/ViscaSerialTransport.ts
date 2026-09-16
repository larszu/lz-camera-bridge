/**
 * VISCA ueber RS-232 (und RS-422/485-Wandler).
 *
 * WARUM DAS NEBEN `ViscaClient` STEHT UND NICHT DARIN. Die VISCA-Kommandos
 * sind auf Draht und auf IP DIESELBEN Bytes -- `81 01 04 3F 02 01 FF` ist ein
 * Preset-Aufruf, ob er per UDP oder per Kabel kommt. Verschieden ist nur, was
 * darum herum passiert: auf IP steckt Sony optional einen 8-Byte-Kopf davor
 * und zaehlt Sequenzen, auf dem Draht steht das Paket nackt. Genau deshalb
 * ist der Transport getrennt: die Kodierung in `ViscaClient` bleibt EINE,
 * sonst driften zwei Kopien desselben Befehlssatzes auseinander.
 *
 * RAHMEN. VISCA hat keine Laengenangabe. Ein Paket beginnt mit einem Byte,
 * dessen oberes Nibble die Adressen traegt (0x8x an die Kamera, 0x9x zurueck),
 * und endet mit dem Terminator 0xFF. Gelesen wird deshalb bis 0xFF -- und
 * NICHT auf eine feste Laenge, weil Antworten unterschiedlich lang sind
 * (ACK 3 Bytes, Completion 3, Inquiry-Antworten bis 16).
 *
 * ADRESSEN. Auf dem Draht ist VISCA eine Kette: bis zu sieben Kameras an
 * einem Strang, jede mit einer Adresse 1..7, das Kommando traegt sie im
 * ersten Byte (0x80 | adresse). Auf IP ist fast immer 1 richtig, weil dort
 * jede Kamera ihre eigene Adresse hat; am Kabel ist sie es NICHT
 * zwangslaeufig, und wer sie falsch setzt, schwenkt die Nachbarkamera.
 * Deshalb ist sie hier konfigurierbar und nicht fest verdrahtet.
 *
 * BAUDRATE. Sony BRC/SRG und die meisten PTZ-Koepfe sprechen ab Werk 9600;
 * einige (und die RS-422-Wandler davor) koennen 38400. Vorgabe ist deshalb
 * 9600 -- die Einstellung, mit der ein unveraendertes Geraet antwortet.
 */
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';

/** VISCA-Terminator: jedes Paket endet damit. */
export const VISCA_TERMINATOR = 0xff;

export interface ViscaSerialOptions {
  path: string;
  /** Vorgabe 9600 -- Werkseinstellung der meisten VISCA-Koepfe. */
  baudRate?: number;
}

/**
 * Zerlegt einen Bytestrom in vollstaendige VISCA-Pakete.
 *
 * Eigenstaendig und ohne SerialPort, damit er ohne Hardware pruefbar ist:
 * serielle Daten kommen in beliebigen Haeppchen an, und der Fehler, den man
 * dabei macht, ist anzunehmen, ein `data`-Ereignis sei ein Paket. Zwei
 * Pakete koennen in einem Haeppchen liegen, eines ueber drei verteilt sein.
 */
export class ViscaFrameParser {
  private puffer: number[] = [];

  /** Nimmt ein Haeppchen und gibt die daraus VOLLSTAENDIGEN Pakete zurueck. */
  push(chunk: Buffer | number[]): Buffer[] {
    const fertige: Buffer[] = [];
    for (const b of chunk) {
      this.puffer.push(b);
      if (b === VISCA_TERMINATOR) {
        fertige.push(Buffer.from(this.puffer));
        this.puffer = [];
      }
    }
    return fertige;
  }

  /** Was noch kein vollstaendiges Paket ist. Fuer Tests und Diagnose. */
  get angefangen(): number[] {
    return [...this.puffer];
  }
}

/** Erstes Byte eines Kommandos an Kamera `adresse` (1..7). */
export function viscaKopf(adresse: number): number {
  if (!Number.isInteger(adresse) || adresse < 1 || adresse > 7) {
    throw new Error(`VISCA-Adresse muss 1..7 sein, war ${adresse}`);
  }
  return 0x80 | adresse;
}

/**
 * IF_Clear als Rundruf: raeumt haengende Kommandos in ALLEN Geraeten der
 * Kette ab. Gehoert an den Anfang jeder Verbindung -- eine Kamera, die noch
 * auf die Antwort eines abgebrochenen Laufs wartet, nimmt sonst nichts Neues.
 */
export function buildIfClearBroadcast(): Buffer {
  return Buffer.from([0x88, 0x01, 0x00, 0x01, 0xff]);
}

export class ViscaSerialTransport extends EventEmitter {
  private port: SerialPort | null = null;
  private readonly parser = new ViscaFrameParser();
  private readonly options: Required<ViscaSerialOptions>;

  constructor(options: ViscaSerialOptions) {
    super();
    this.options = { baudRate: 9600, ...options };
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 8N1 ohne Flusskontrolle -- die VISCA-Festlegung. (Sonys 9-Pin-
      // RS-422-Protokoll ist ein ANDERES und nutzt odd parity; siehe
      // Rs422Transport.ts. Die beiden nicht verwechseln.)
      this.port = new SerialPort(
        { path: this.options.path, baudRate: this.options.baudRate, dataBits: 8, parity: 'none', stopBits: 1 },
        (err) => (err ? reject(err) : resolve()),
      );
      this.port.on('data', (chunk: Buffer) => {
        for (const paket of this.parser.push(chunk)) this.emit('paket', paket);
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
      if (!this.port?.isOpen) return reject(new Error(`Serieller Port ${this.options.path} ist nicht offen`));
      this.port.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }
}
