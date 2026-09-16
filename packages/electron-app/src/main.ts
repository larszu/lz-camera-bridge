import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { starteEingebauteBruecke, stoppeEingebauteBruecke, type BrueckenErgebnis } from './embeddedBridge.js';

let mainWindow: BrowserWindow | null = null;

// Der Zustand der Bruecke wird EINMAL beim Start ermittelt und gemerkt, weil
// das Pult ihn abfragt, sobald es geladen hat -- und das ist spaeter als der
// Start. Ohne dieses Feld ginge die Meldung eines Fehlversuchs verloren.
let brueckenZustand: BrueckenErgebnis | null = null;

function resolveUiEntry(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'web-rcp', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'ui', 'index.html'),
    path.join(app.getAppPath(), 'ui', 'index.html'),
  ];

  const uiEntry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!uiEntry) {
    throw new Error('Bundled web UI not found. Build packages/web-rcp first.');
  }

  return uiEntry;
}

function createMainWindow(): void {
  const uiEntry = resolveUiEntry();

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#101214',
    autoHideMenuBar: true,
    show: false,
    title: 'Camera Bridge',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(uiEntry);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // ZUERST die Bruecke, DANN das Fenster. Das Pult verbindet sich unmittelbar
  // nach dem Laden; horcht dann noch nichts auf 9700, sieht der Nutzer beim
  // Start einmal den Fehlversuch und wartet drei Sekunden auf den naechsten.
  // Die Reihenfolge kostet nichts und erspart genau das.
  brueckenZustand = starteEingebauteBruecke();
  if (!brueckenZustand.laeuft) {
    console.error(`[CameraBridge] ${brueckenZustand.fehler}`);
  }
  createMainWindow();
});

// Das Pult fragt, woran es ist. Antwort kommt aus dem gemerkten Zustand.
ipcMain.handle('bridge:status', (): BrueckenErgebnis =>
  brueckenZustand ?? { laeuft: false, port: 9700, fehler: 'Die Bruecke wurde noch nicht gestartet.' });

// Die Bruecke haelt Sockets und serielle Schnittstellen offen. Bliebe sie
// beim Beenden stehen, waere der Port beim naechsten Start belegt -- und die
// Anwendung meldete einen Fehler, dessen Ursache sie selbst war.
app.on('will-quit', () => {
  stoppeEingebauteBruecke();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
