/**
 * Buendelt die Bruecke in EINE Datei, die der Electron-Hauptprozess laden kann.
 *
 * WARUM UEBERHAUPT GEBUENDELT. Die Bruecke ist ESM und laeuft im Betrieb ueber
 * `tsx` direkt aus dem TypeScript. Im Installer gibt es kein tsx und keine
 * Quelldateien. Ein `tsc`-Lauf allein reichte auch nicht: er liesse einen Baum
 * aus ESM-Dateien zurueck, dessen Importe (`ws`, die Kamera-Module) zur
 * Laufzeit aus `node_modules` aufgeloest werden muessten -- also genau die
 * Aufloesung, die im asar-Archiv die Probleme macht. Ein Buendel hat keine
 * offenen Enden.
 *
 * WAS ABSICHTLICH DRAUSSEN BLEIBT (`external`): die drei nativen Module.
 * Sie sind `.node`-Binaerdateien und lassen sich nicht in JavaScript buendeln;
 * sie werden von electron-builder als echte Abhaengigkeit mitgegeben und via
 * `asarUnpack` (electron-builder.yml) ausgepackt, weil aus einem asar-Archiv
 * kein natives Modul geladen werden kann.
 *
 * DASS DAS IN ELECTRON UEBERHAUPT GEHT, haengt an einer Eigenschaft, die man
 * einmal nachgesehen haben muss: `@serialport/bindings-cpp` liefert
 * **N-API**-Prebuilds (`node.napi.glibc.node`). N-API ist ABI-stabil ueber
 * Node- UND Electron-Fassungen hinweg -- deshalb braucht es hier KEIN
 * `electron-rebuild`, und `npmRebuild: false` darf stehen bleiben. Waeren es
 * klassische NAN-Module, muesste dieser Absatz das Gegenteil sagen.
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const bridgeEntry = path.join(appDir, '..', 'bridge', 'src', 'BridgeServer.ts');

await esbuild.build({
  entryPoints: [bridgeEntry],
  outfile: path.join(appDir, 'dist', 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  // Electron 34 bringt Node 20 mit. Hoeher zu zielen hiesse, Syntax zu
  // erzeugen, die der Hauptprozess nicht liest.
  target: 'node20',
  format: 'cjs',
  external: ['serialport', 'usb', 'node-hid'],
  logLevel: 'info',
});
