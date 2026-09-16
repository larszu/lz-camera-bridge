/**
 * Die Bruecke IM Installer -- der Grund, warum eine Installation reicht.
 *
 * VORHER war diese Anwendung die HAELFTE eines Werkzeugs. Der Installer
 * brachte das Pult mit, das Pult sucht seine Bruecke unter
 * `ws://localhost:9700` (web-rcp/hooks/useBridge.ts), und niemand startete
 * dort etwas. Wer die Anwendung installierte und oeffnete, sah eine
 * vollstaendige Oberflaeche, die alle drei Sekunden vergeblich neu verband:
 * kein Fehler, keine Kamera, keine Erklaerung. Dass dazu ein zweiter Prozess
 * aus einem Klon des Repos gehoert, stand nirgends in der Anwendung.
 *
 * Die Bruecke laeuft deshalb IM Hauptprozess, nicht als Kindprozess. Ein
 * Kindprozess haette den Pfad zu einer Node-Binaerdatei im asar-Archiv
 * aufloesen muessen; hier genuegt ein `require`.
 *
 * WAS DAS KOSTET, und warum es vertretbar ist: ein Absturz der Bruecke
 * risse die Oberflaeche mit. Genau deshalb faengt `starteEingebauteBruecke`
 * JEDEN Fehler ab und gibt ihn als Text zurueck, statt ihn zu werfen. Die
 * Anwendung geht dann trotzdem auf -- mit einem Hinweis statt mit einem
 * schwarzen Fenster. Eine Oberflaeche ohne Bruecke ist wenig; eine
 * Oberflaeche, die gar nicht erst startet, ist nichts.
 */
import type { Server } from 'node:http';

/** Was die gebuendelte Bruecke exportiert (siehe scripts/build-bridge.mjs). */
interface BridgeServerKlasse {
  new (wsPort?: number): { start(): void; stop(): void; httpServer?: Server };
}

export interface BrueckenErgebnis {
  /** Laeuft sie? Nur dann bedient das Pult ueberhaupt eine Kamera. */
  laeuft: boolean;
  /** Der Port, auf dem sie horcht -- derselbe, den useBridge.ts annimmt. */
  port: number;
  /** Gesetzt, wenn sie NICHT laeuft. Gehoert dem Nutzer gezeigt, nicht ins Log. */
  fehler?: string;
}

const STANDARD_PORT = 9700;

let laufende: { stop(): void } | null = null;

export function starteEingebauteBruecke(port = STANDARD_PORT): BrueckenErgebnis {
  try {
    // Erst zur Laufzeit geladen und nicht oben importiert: `bridge.cjs`
    // entsteht im Build-Schritt (esbuild). Ein statischer Import liesse
    // `tsc` ueber eine Datei stolpern, die es beim Typpruefen noch nicht gibt.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BridgeServer } = require('./bridge.cjs') as { BridgeServer: BridgeServerKlasse };
    const server = new BridgeServer(port);
    server.start();
    laufende = server;
    return { laeuft: true, port };
  } catch (err) {
    // Der haeufigste Fall im Feld ist ein belegter Port: eine zweite
    // Instanz der Anwendung, oder eine von Hand gestartete Bruecke. Beides
    // ist kein Defekt, und beides muss dastehen statt zu verschwinden.
    const text = err instanceof Error ? err.message : String(err);
    const belegt = /EADDRINUSE/i.test(text);
    return {
      laeuft: false,
      port,
      fehler: belegt
        ? `Port ${port} ist belegt. Laeuft die LZ Camera Bridge bereits -- als zweites Fenster oder von Hand gestartet? Das Pult verbindet sich mit der bereits laufenden Bruecke.`
        : `Die eingebaute Bruecke konnte nicht starten: ${text}`,
    };
  }
}

export function stoppeEingebauteBruecke(): void {
  try {
    laufende?.stop();
  } catch {
    // Beim Beenden ist ein Fehler aus dem Zumachen belanglos -- die
    // Sockets nimmt das Betriebssystem ohnehin mit.
  }
  laufende = null;
}
