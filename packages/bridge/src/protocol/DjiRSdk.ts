/**
 * DJI R SDK -- das Protokoll der Ronin-Koepfe (RS 2, RS 3 Pro).
 *
 * HERKUNFT: DJI veroeffentlicht hierfuer, anders als fuer die Pocket, ein
 * Dokument ("Protocol and User Interface DJI R SDK", Fassung 2.3). Der Rahmen
 * unten folgt ihm und den offenen Umsetzungen, die darauf aufbauen
 * (ArduPilot AP_Mount_DJIRS2, ConstantRobotics/DJIR_SDK).
 *
 * NICHT AN HARDWARE GEPRUEFT -- hier stand kein Ronin. Geprueft sind Rahmen
 * und Pruefsummen gegen Tests, nicht die Annahme durch ein Geraet.
 *
 * WELCHE KOEPFE: RS 2 und RS 3 Pro sprechen es. RS 3 und RSC 2 ausdruecklich
 * NICHT -- sie sehen gleich aus und koennen es trotzdem nicht. Wer das
 * verwechselt, sucht den Fehler im Kabel.
 *
 * RAHMEN (16 Bit Laenge/Fassung little-endian, wie im Dokument):
 *   0      SOF = 0xAA
 *   1-2    Laenge (13 bit) | Fassung (3 bit), LE
 *   3      CmdType
 *   4      ENC (Verschluesselung; 0 = keine)
 *   5-7    reserviert
 *   8-9    Folge, LE
 *   10-11  CRC16 ueber Byte 0..9
 *   12     CmdSet
 *   13     CmdId
 *   14..   Nutzlast
 *   letzte 4  CRC32 ueber alles davor
 */

export const RSDK_SOF = 0xaa;

/**
 * Startwert BEIDER Pruefsummen.
 *
 * Als benannte Konstante und nicht als Zahl im Rechenweg: weicht ein Geraet
 * alles ab, ist das die erste Stellschraube. DJI nutzt 0x3692 quer durch das
 * R SDK; die Pocket-Reihe rechnet mit einem anderen Startwert (siehe
 * Duml.ts) -- die beiden nicht vermischen.
 */
export const RSDK_CRC_START = 0x3692;

/** CRC16, Polynom 0x1021 gespiegelt (0x8408). */
export function rsdkCrc16(bytes: Uint8Array | number[], start = RSDK_CRC_START): number {
  let crc = start & 0xffff;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? ((crc >> 1) ^ 0x8408) & 0xffff : (crc >> 1) & 0xffff;
  }
  return crc & 0xffff;
}

/** CRC32, Polynom 0x04C11DB7 gespiegelt (0xEDB88320). */
export function rsdkCrc32(bytes: Uint8Array | number[], start = RSDK_CRC_START): number {
  let crc = start >>> 0;
  for (const b of bytes) {
    crc = (crc ^ (b & 0xff)) >>> 0;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : crc >>> 1;
  }
  return crc >>> 0;
}

export const RSDK_CMDSET_GIMBAL = 0x0e;
export const RSDK_CMD_POSITION = 0x00;
export const RSDK_CMD_GESCHWINDIGKEIT = 0x01;
/** Anfrage; Antworten und Meldungen tragen 0x20 in Byte 3. */
export const RSDK_CMDTYPE_ANFRAGE = 0x03;

export interface RsdkRahmen {
  cmdType?: number;
  folge: number;
  cmdSet: number;
  cmdId: number;
  nutzlast: Uint8Array;
}

export function rsdkBauen(r: RsdkRahmen): Buffer {
  const nutzlast = Buffer.from(r.nutzlast);
  const gesamt = 18 + nutzlast.length; // 14 Kopf + Nutzlast + 4 CRC32
  if (gesamt > 0x1fff) throw new Error(`R-SDK-Rahmen zu lang: ${gesamt}`);
  const buf = Buffer.alloc(gesamt);
  buf[0] = RSDK_SOF;
  // Fassung 1 in den oberen 3 Bit, Laenge in den unteren 13.
  buf.writeUInt16LE((gesamt & 0x1fff) | (1 << 13), 1);
  buf[3] = r.cmdType ?? RSDK_CMDTYPE_ANFRAGE;
  buf[4] = 0x00; // keine Verschluesselung
  // 5..7 bleiben 0 (reserviert)
  buf.writeUInt16LE(r.folge & 0xffff, 8);
  buf.writeUInt16LE(rsdkCrc16(buf.subarray(0, 10)), 10);
  buf[12] = r.cmdSet & 0xff;
  buf[13] = r.cmdId & 0xff;
  nutzlast.copy(buf, 14);
  buf.writeUInt32LE(rsdkCrc32(buf.subarray(0, gesamt - 4)), gesamt - 4);
  return buf;
}

export class RsdkPruefFehler extends Error {}

export function rsdkLesen(buf: Buffer): RsdkRahmen {
  if (buf.length < 18) throw new RsdkPruefFehler(`zu kurz: ${buf.length}`);
  if (buf[0] !== RSDK_SOF) throw new RsdkPruefFehler(`kein SOF: 0x${buf[0].toString(16)}`);
  const laenge = buf.readUInt16LE(1) & 0x1fff;
  if (laenge !== buf.length) throw new RsdkPruefFehler(`Laenge ${laenge} != ${buf.length}`);
  if (buf.readUInt16LE(10) !== rsdkCrc16(buf.subarray(0, 10))) throw new RsdkPruefFehler('CRC16 falsch');
  if (buf.readUInt32LE(buf.length - 4) !== rsdkCrc32(buf.subarray(0, buf.length - 4))) {
    throw new RsdkPruefFehler('CRC32 falsch');
  }
  return {
    cmdType: buf[3],
    folge: buf.readUInt16LE(8),
    cmdSet: buf[12],
    cmdId: buf[13],
    nutzlast: new Uint8Array(buf.subarray(14, buf.length - 4)),
  };
}

function zehntel(wert: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(wert * 10)));
}

/**
 * Nutzlast "fahre auf diese Winkel" (0x0E/0x00).
 * `zeitFuerFahrt` in Zehntelsekunden: wie lange der Kopf sich dafuer nehmen
 * soll. Zu klein gewaehlt ruckt er, zu gross wird die Fahrt zaeh.
 */
export function rsdkPosition(
  ziel: { yaw?: number; roll?: number; pitch?: number },
  zeitFuerFahrt = 20,
): Uint8Array {
  const b = Buffer.alloc(8);
  b.writeInt16LE(zehntel(ziel.yaw ?? 0), 0);
  b.writeInt16LE(zehntel(ziel.roll ?? 0), 2);
  b.writeInt16LE(zehntel(ziel.pitch ?? 0), 4);
  b[6] = 0x01; // absolute Winkel
  b[7] = zeitFuerFahrt & 0xff;
  return new Uint8Array(b);
}

/**
 * Nutzlast "bewege dich mit dieser Geschwindigkeit" (0x0E/0x01).
 *
 * Das Steuerbyte 0x80 ist die UEBERNAHME: ohne es ignoriert der Kopf die
 * Fahrt, weil er sie als Beiwerk zur Handbedienung liest.
 */
export function rsdkGeschwindigkeit(ziel: { yaw?: number; roll?: number; pitch?: number }): Uint8Array {
  const b = Buffer.alloc(7);
  b.writeInt16LE(zehntel(ziel.yaw ?? 0), 0);
  b.writeInt16LE(zehntel(ziel.roll ?? 0), 2);
  b.writeInt16LE(zehntel(ziel.pitch ?? 0), 4);
  b[6] = 0x80;
  return new Uint8Array(b);
}
