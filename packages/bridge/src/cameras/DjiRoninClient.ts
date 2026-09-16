/**
 * DJI Ronin (RS 2 / RS 3 Pro) als PTZ-Kopf, ueber das DJI R SDK auf CAN.
 *
 * NUR RS 2 UND RS 3 PRO. RS 3 und RSC 2 sehen gleich aus und sprechen das
 * SDK nicht -- das steht hier, weil der Unterschied am Geraet nicht steht.
 *
 * NICHT AN HARDWARE GEPRUEFT: hier stand kein Ronin. Geprueft sind Rahmen,
 * Pruefsummen und die SLCAN-Zeilen gegen Tests.
 *
 * Der CAN-Zugang laeuft ueber einen USB-SLCAN-Stecker (CANable, USBtin,
 * Lawicel) -- siehe transport/SlcanTransport.ts, wo auch steht, warum nicht
 * SocketCAN.
 */
import { EventEmitter } from 'events';
import { CameraState } from '../protocol/CcuClient.js';
import { GenericCameraClient } from './GenericCameraClient.js';
import { SlcanTransport, CAN_ID_VOM_GIMBAL } from '../transport/SlcanTransport.js';
import {
  rsdkBauen, rsdkGeschwindigkeit, rsdkPosition,
  RSDK_CMDSET_GIMBAL, RSDK_CMD_GESCHWINDIGKEIT, RSDK_CMD_POSITION,
} from '../protocol/DjiRSdk.js';

/** Vollausschlag am Pult. Ronin-Koepfe tragen deutlich mehr als eine Pocket. */
const MAX_GRAD_PRO_SEKUNDE = 120;

/**
 * DAS DOKUMENT SAGT ES AUSDRUECKLICH: ein Geschwindigkeits-Kommando gilt
 * hoechstens 0,5 s, "aus Sicherheitsgruenden". Fuer eine Dauerfahrt muss
 * nachgetaktet werden. 200 ms laesst genug Luft, falls ein Takt verlorengeht.
 */
const NACHTAKT_MS = 200;

export class DjiRoninClient extends EventEmitter implements GenericCameraClient {
  private can: SlcanTransport | null = null;
  private connected = false;
  private folge = 1;
  private fahrt: { yaw: number; pitch: number } | null = null;
  private takt: NodeJS.Timeout | null = null;
  private _state: CameraState = {};

  constructor(private readonly pfad: string, private readonly baudRate = 115200) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<unknown> {
    this.can = new SlcanTransport(this.pfad, this.baudRate);
    this.can.on('error', (err) => this.emit('error', err));
    this.can.on('can', (r: { id: number; daten: Buffer }) => {
      // Nur die Gegenrichtung ist interessant. Auf demselben Bus fahren die
      // Rahmen des Focus-Rads mit rund 400 Hz (0x530/0x531/0x426); wer die
      // mitliest, ertraenkt sich selbst.
      if (r.id === CAN_ID_VOM_GIMBAL) this.emit('rsdk', r.daten);
    });
    await this.can.open();
    this.connected = true;
    this.emit('connected', { pfad: this.pfad, protokoll: 'DJI R SDK / SLCAN' });
    return { pfad: this.pfad };
  }

  disconnect(): void {
    this.haltAn();
    this.connected = false;
    this.can?.close();
    this.can = null;
    this.emit('disconnected');
  }

  private async sende(cmdId: number, nutzlast: Uint8Array): Promise<void> {
    if (!this.can) throw new Error('CAN-Zugang ist nicht offen');
    const rahmen = rsdkBauen({
      folge: this.folge,
      cmdSet: RSDK_CMDSET_GIMBAL,
      cmdId,
      nutzlast,
    });
    this.folge = (this.folge + 1) & 0xffff;
    await this.can.sendeNutzlast(rahmen);
  }

  private haltAn(): void {
    if (this.takt) clearInterval(this.takt);
    this.takt = null;
    this.fahrt = null;
  }

  private fahre(yaw: number, pitch: number): Promise<void> {
    if (yaw === 0 && pitch === 0) {
      this.haltAn();
      return this.sende(RSDK_CMD_GESCHWINDIGKEIT, rsdkGeschwindigkeit({ yaw: 0, pitch: 0 }));
    }
    this.fahrt = { yaw, pitch };
    if (!this.takt) {
      this.takt = setInterval(() => {
        if (!this.fahrt) return;
        void this.sende(RSDK_CMD_GESCHWINDIGKEIT, rsdkGeschwindigkeit(this.fahrt)).catch((err) =>
          this.emit('error', err),
        );
      }, NACHTAKT_MS);
      this.takt.unref?.();
    }
    return this.sende(RSDK_CMD_GESCHWINDIGKEIT, rsdkGeschwindigkeit({ yaw, pitch }));
  }

  async handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean> {
    const num = (k: string, d = 0) => Number(params[k] ?? d);
    switch (cmd) {
      case 'ptz': {
        const yaw = (num('pan') / 100) * MAX_GRAD_PRO_SEKUNDE;
        // Minus wie beim Osmo: das Pult zaehlt "hoch ist positiv", der Kopf
        // zaehlt Pitch andersherum.
        const pitch = -(num('tilt') / 100) * MAX_GRAD_PRO_SEKUNDE;
        await this.fahre(yaw, pitch);
        return true;
      }
      case 'gotoAngle':
        this.haltAn();
        await this.sende(RSDK_CMD_POSITION, rsdkPosition({ yaw: num('yaw'), pitch: num('pitch'), roll: num('roll') }));
        return true;
      case 'recenter':
        this.haltAn();
        await this.sende(RSDK_CMD_POSITION, rsdkPosition({ yaw: 0, pitch: 0, roll: 0 }));
        return true;
      default:
        // Ein Gimbal traegt kein Bild: Blende und Gain gehoeren der Kamera.
        return false;
    }
  }

  get state(): CameraState {
    return this._state;
  }
}
