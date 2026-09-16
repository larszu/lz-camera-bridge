/**
 * CAN ueber einen USB-Seriell-Adapter (SLCAN / "LAWICEL"-ASCII).
 *
 * WARUM SLCAN UND NICHT SocketCAN: SocketCAN gibt es nur unter Linux, und
 * dieses Werkzeug soll auf Windows und macOS laufen. SLCAN sprechen die
 * verbreiteten USB-CAN-Stecker (CANable, USBtin, Lawicel), sie melden sich
 * als serielles Geraet -- damit kommt der CAN-Zugang OHNE ein weiteres
 * natives Modul aus, und der Installer bleibt so schlank wie er ist.
 *
 * DAS PROTOKOLL ist ASCII, jede Zeile endet mit CR (0x0D):
 *   S8      Bitrate 1 Mbit/s  (S0=10k S1=20k S2=50k S3=100k S4=125k
 *                              S5=250k S6=500k S7=800k S8=1M)
 *   O       Kanal oeffnen
 *   C       Kanal schliessen
 *   tIIILDD Standard-Rahmen senden: III = 3 Hex-Ziffern Kennung,
 *           L = Anzahl Datenbytes, DD = Daten als Hex
 * Antworten kommen im selben `t`-Format zurueck.
 *
 * Das DJI R SDK faehrt 1 Mbit/s; Host->Gimbal auf Kennung 0x223,
 * Gimbal->Host auf 0x222.
 */
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';

export const CAN_ID_ZU_GIMBAL = 0x223;
export const CAN_ID_VOM_GIMBAL = 0x222;

export interface CanRahmen {
  id: number;
  daten: Buffer;
}

/** Baut eine SLCAN-Sendezeile fuer einen Standard-Rahmen (11-bit-Kennung). */
export function slcanSendezeile(rahmen: CanRahmen): string {
  if (rahmen.id < 0 || rahmen.id > 0x7ff) throw new Error(`CAN-Kennung ausserhalb 11 bit: ${rahmen.id}`);
  if (rahmen.daten.length > 8) throw new Error(`CAN-Rahmen traegt hoechstens 8 Bytes, waren ${rahmen.daten.length}`);
  const id = rahmen.id.toString(16).toUpperCase().padStart(3, '0');
  const daten = [...rahmen.daten].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  return `t${id}${rahmen.daten.length}${daten}\r`;
}

/** Liest eine SLCAN-Empfangszeile. `null`, wenn es kein Datenrahmen ist. */
export function slcanLeseZeile(zeile: string): CanRahmen | null {
  const z = zeile.trim();
  if (!z.startsWith('t')) return null; // 'T' waere erweitert, 'z'/'Z' Bestaetigungen
  if (z.length < 5) return null;
  const id = parseInt(z.slice(1, 4), 16);
  const anzahl = parseInt(z.slice(4, 5), 16);
  if (Number.isNaN(id) || Number.isNaN(anzahl)) return null;
  const hex = z.slice(5, 5 + anzahl * 2);
  if (hex.length < anzahl * 2) return null; // abgeschnitten
  const daten = Buffer.from(hex, 'hex');
  return { id, daten };
}

/**
 * Zerlegt einen R-SDK-Rahmen in CAN-Rahmen zu je hoechstens 8 Bytes.
 * Das Protokoll laeuft als Folge solcher Haeppchen; der Empfaenger setzt sie
 * ab dem 0xAA wieder zusammen.
 */
export function inCanHaeppchen(nutzlast: Buffer, id = CAN_ID_ZU_GIMBAL): CanRahmen[] {
  const haeppchen: CanRahmen[] = [];
  for (let i = 0; i < nutzlast.length; i += 8) {
    haeppchen.push({ id, daten: nutzlast.subarray(i, Math.min(i + 8, nutzlast.length)) });
  }
  return haeppchen;
}

export class SlcanTransport extends EventEmitter {
  private port: SerialPort | null = null;
  private zeilenPuffer = '';

  constructor(private readonly pfad: string, private readonly baudRate = 115200) {
    super();
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.port = new SerialPort({ path: this.pfad, baudRate: this.baudRate }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    this.port!.on('data', (chunk: Buffer) => this.aufnehmen(chunk));
    this.port!.on('error', (err) => this.emit('error', err));
    // Erst schliessen (falls der Stecker noch offen war), dann Bitrate, dann
    // oeffnen. Die Reihenfolge ist nicht beliebig: einen offenen Kanal nimmt
    // der Adapter keine neue Bitrate ab, und der Fehler kommt still.
    await this.schreibe('C\r');
    await this.schreibe('S8\r'); // 1 Mbit/s -- die Rate des R SDK
    await this.schreibe('O\r');
  }

  private aufnehmen(chunk: Buffer): void {
    this.zeilenPuffer += chunk.toString('ascii');
    for (;;) {
      const bruch = this.zeilenPuffer.indexOf('\r');
      if (bruch < 0) break;
      const zeile = this.zeilenPuffer.slice(0, bruch);
      this.zeilenPuffer = this.zeilenPuffer.slice(bruch + 1);
      const rahmen = slcanLeseZeile(zeile);
      if (rahmen) this.emit('can', rahmen);
    }
  }

  private schreibe(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) return reject(new Error(`SLCAN-Port ${this.pfad} ist nicht offen`));
      this.port.write(text, (err) => (err ? reject(err) : resolve()));
    });
  }

  async sende(rahmen: CanRahmen): Promise<void> {
    await this.schreibe(slcanSendezeile(rahmen));
  }

  /** Schickt eine ganze R-SDK-Nutzlast als Folge von CAN-Rahmen. */
  async sendeNutzlast(nutzlast: Buffer, id = CAN_ID_ZU_GIMBAL): Promise<void> {
    for (const h of inCanHaeppchen(nutzlast, id)) await this.sende(h);
  }

  close(): void {
    try {
      this.port?.write('C\r');
      this.port?.close();
    } catch {
      /* beim Zumachen belanglos */
    }
    this.port = null;
  }
}
