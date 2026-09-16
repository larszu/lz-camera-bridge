/**
 * DUML -- DJIs Binaerprotokoll, wie es die Osmo-Pocket-Reihe spricht.
 *
 * HERKUNFT DIESER ANGABEN, und warum das hier steht statt im Commit: DJI
 * veroeffentlicht fuer die Pocket-Reihe KEINE Schnittstelle. Der Rahmen
 * unten stammt aus der oeffentlichen Aufarbeitung des Protokolls
 * (github.com/yigitkonur/lib-osmo-ble, gewonnen aus Wireshark-Mitschnitten
 * der DJI-Mimo-App). Wer das aendert, aendert es gegen diese Quelle -- nicht
 * gegen eine Herstellerangabe, die es nicht gibt.
 *
 * NICHT AN HARDWARE GEPRUEFT. In diesem Haus stand keine Pocket. Geprueft
 * sind die Rechenwege (CRC, Rahmen, Hin- und Rueckweg) gegen sich selbst und
 * gegen die Beschreibung; NICHT geprueft ist, ob ein Geraet die Pakete
 * annimmt. Das ist ein Unterschied, den ein Kommentar benennen muss, weil man
 * ihn dem Code sonst nicht ansieht.
 *
 * RAHMEN:
 *   [0x55] [laenge:10 bit | fassung:6 bit, LE16] [CRC8 ueber die ersten 3]
 *   [ziel:LE16] [folge:BE16] [flags] [cmdSet] [cmdId] [nutzlast...] [CRC16 LE]
 *
 * Die Folgenummer ist das EINZIGE Feld in Big-Endian. Das ist keine Schoenheit,
 * sondern eine Falle: wer sie wie den Rest schreibt, bekommt Pakete, die
 * aussehen wie gueltige und als doppelt verworfen werden.
 */

/** Startbyte jedes DUML-Rahmens. */
export const DUML_SOF = 0x55;

/**
 * CRC8 ueber die ersten drei Bytes (SOF, Laenge/Fassung).
 * Polynom 0x31, Startwert 0xEE, gespiegelt -- gespiegelt heisst: mit dem
 * umgedrehten Polynom 0x8C von rechts nach links gerechnet.
 */
export function dumlCrc8(bytes: Uint8Array | number[]): number {
  let crc = 0xee;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? ((crc >> 1) ^ 0x8c) & 0xff : (crc >> 1) & 0xff;
  }
  return crc & 0xff;
}

/**
 * Startwert des CRC16.
 *
 * ACHTUNG, hier gehen die Quellen auseinander: fuer die Pocket-Reihe ist
 * 0x496C belegt, aeltere DJI-Geraete (und die verbreiteten
 * dji-firmware-tools) rechnen mit 0x3692. Deshalb steht der Wert als
 * benannte Konstante und nicht als Zahl mitten im Rechenweg -- wenn ein
 * Geraet alles abweist, ist das die erste Stellschraube, und man soll sie
 * finden.
 */
export const DUML_CRC16_START = 0x496c;

/** CRC16 ueber den ganzen Rahmen ohne die zwei Pruefbytes. Poly 0x1021 gespiegelt (0x8408). */
export function dumlCrc16(bytes: Uint8Array | number[], start = DUML_CRC16_START): number {
  let crc = start & 0xffff;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? ((crc >> 1) ^ 0x8408) & 0xffff : (crc >> 1) & 0xffff;
  }
  return crc & 0xffff;
}

export interface DumlRahmen {
  /** Absender und Empfaenger, je ein Byte. */
  sender: number;
  empfaenger: number;
  folge: number;
  flags: number;
  cmdSet: number;
  cmdId: number;
  nutzlast: Uint8Array;
  /** Protokollfassung, in der Praxis 1. */
  fassung?: number;
}

/** Baut einen vollstaendigen DUML-Rahmen. */
export function dumlBauen(r: DumlRahmen): Buffer {
  const nutzlast = Buffer.from(r.nutzlast);
  // 13 = SOF + len/ver(2) + crc8 + ziel(2) + folge(2) + flags + set + id + crc16(2)
  const gesamt = 13 + nutzlast.length;
  if (gesamt > 0x3ff) throw new Error(`DUML-Rahmen zu lang: ${gesamt} > 1023`);

  const buf = Buffer.alloc(gesamt);
  buf[0] = DUML_SOF;
  // Laenge (10 bit) und Fassung (6 bit) teilen sich 16 Bit, little-endian.
  buf.writeUInt16LE((gesamt & 0x3ff) | (((r.fassung ?? 1) & 0x3f) << 10), 1);
  buf[3] = dumlCrc8(buf.subarray(0, 3));
  buf[4] = r.sender & 0xff;
  buf[5] = r.empfaenger & 0xff;
  buf.writeUInt16BE(r.folge & 0xffff, 6); // einziges BE-Feld, siehe oben
  buf[8] = r.flags & 0xff;
  buf[9] = r.cmdSet & 0xff;
  buf[10] = r.cmdId & 0xff;
  nutzlast.copy(buf, 11);
  buf.writeUInt16LE(dumlCrc16(buf.subarray(0, gesamt - 2)), gesamt - 2);
  return buf;
}

export class DumlPruefFehler extends Error {}

/** Zerlegt einen Rahmen und PRUEFT beide Pruefsummen. */
export function dumlLesen(buf: Buffer): DumlRahmen {
  if (buf.length < 13) throw new DumlPruefFehler(`zu kurz: ${buf.length}`);
  if (buf[0] !== DUML_SOF) throw new DumlPruefFehler(`kein SOF: 0x${buf[0].toString(16)}`);
  const kopf = buf.readUInt16LE(1);
  const laenge = kopf & 0x3ff;
  if (laenge !== buf.length) throw new DumlPruefFehler(`Laenge ${laenge} != ${buf.length}`);
  if (buf[3] !== dumlCrc8(buf.subarray(0, 3))) throw new DumlPruefFehler('CRC8 falsch');
  const erwartet = dumlCrc16(buf.subarray(0, buf.length - 2));
  if (buf.readUInt16LE(buf.length - 2) !== erwartet) throw new DumlPruefFehler('CRC16 falsch');
  return {
    sender: buf[4],
    empfaenger: buf[5],
    folge: buf.readUInt16BE(6),
    flags: buf[8],
    cmdSet: buf[9],
    cmdId: buf[10],
    nutzlast: new Uint8Array(buf.subarray(11, buf.length - 2)),
    fassung: (kopf >> 10) & 0x3f,
  };
}

/**
 * Zerlegt einen Strom in Rahmen. Wie beim seriellen VISCA gilt: ein
 * Lesevorgang ist kein Paket. Hier kommt erschwerend dazu, dass 0x55 auch in
 * der Nutzlast vorkommt -- ein Rahmenanfang ist deshalb erst dann einer, wenn
 * die Laenge passt UND der CRC8 stimmt. Genau dafuer ist er da.
 */
export class DumlStromLeser {
  private puffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DumlRahmen[] {
    this.puffer = Buffer.concat([this.puffer, chunk]);
    const fertig: DumlRahmen[] = [];
    for (;;) {
      const start = this.puffer.indexOf(DUML_SOF);
      if (start < 0) {
        this.puffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) this.puffer = this.puffer.subarray(start);
      if (this.puffer.length < 4) break;
      if (this.puffer[3] !== dumlCrc8(this.puffer.subarray(0, 3))) {
        // Falscher Anfang: dieses 0x55 war Nutzlast. Ein Byte weiter suchen.
        this.puffer = this.puffer.subarray(1);
        continue;
      }
      const laenge = this.puffer.readUInt16LE(1) & 0x3ff;
      if (laenge < 13) {
        this.puffer = this.puffer.subarray(1);
        continue;
      }
      if (this.puffer.length < laenge) break; // noch nicht vollstaendig
      const roh = this.puffer.subarray(0, laenge);
      try {
        fertig.push(dumlLesen(Buffer.from(roh)));
        this.puffer = this.puffer.subarray(laenge);
      } catch {
        this.puffer = this.puffer.subarray(1);
      }
    }
    return fertig;
  }
}

// ── Gimbal-Kommandos (CmdSet 0x04) ─────────────────────────────────────────

export const DUML_CMDSET_GIMBAL = 0x04;
export const DUML_CMD_GIMBAL_PWM = 0x01;
export const DUML_CMD_GIMBAL_ABSOLUT = 0x0a;
export const DUML_CMD_GIMBAL_GESCHWINDIGKEIT = 0x0c;
export const DUML_CMD_GIMBAL_TELEMETRIE = 0x05;
export const DUML_CMD_GIMBAL_ZEITWINKEL = 0x14;
export const DUML_CMD_GIMBAL_SCHRITT = 0x15;

/** int16 in Zehntelgrad -- die Einheit, in der DJI Winkel fuehrt. */
function zehntelGrad(grad: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(grad * 10)));
}

export interface GimbalZiel {
  /** Neigen, Grad. */
  pitch?: number;
  /** Rollen, Grad. */
  roll?: number;
  /** Schwenken, Grad. */
  yaw?: number;
}

/** Nutzlast fuer "fahre auf diesen Winkel" (0x04/0x0A). */
export function dumlAbsoluterWinkel(ziel: GimbalZiel): Uint8Array {
  const b = Buffer.alloc(7);
  b.writeInt16LE(zehntelGrad(ziel.yaw ?? 0), 0);
  b.writeInt16LE(zehntelGrad(ziel.roll ?? 0), 2);
  b.writeInt16LE(zehntelGrad(ziel.pitch ?? 0), 4);
  b[6] = 0x01; // Modus: absolut
  return new Uint8Array(b);
}

/** Nutzlast fuer "bewege dich mit dieser Geschwindigkeit" (0x04/0x0C). */
export function dumlGeschwindigkeit(ziel: GimbalZiel): Uint8Array {
  const b = Buffer.alloc(7);
  b.writeInt16LE(zehntelGrad(ziel.yaw ?? 0), 0);
  b.writeInt16LE(zehntelGrad(ziel.roll ?? 0), 2);
  b.writeInt16LE(zehntelGrad(ziel.pitch ?? 0), 4);
  b[6] = 0x00;
  return new Uint8Array(b);
}
