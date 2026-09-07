/**
 * Was die Bruecke ueber eine Kamera BEHAUPTET, faellt mit der Verbindung.
 *
 * BEFUND (Defektformen-Sweep, Form `zustand-nach-fehler`). Zustand, Herkunft
 * und Bestaetigungszeit sind Aussagen ueber ein Geraet, mit dem gerade
 * gesprochen wird. Nach einem Verbindungsverlust sind sie es nicht mehr — wer
 * die Kamera in der Zwischenzeit am Menue anfasst, macht jede davon still
 * falsch.
 *
 * Gemessen war es an drei Stellen unterschiedlich geregelt:
 *
 *   `disconnectCamera`        loeschte GAR NICHTS,
 *   `backend.on('disconnected')`  loeschte GAR NICHTS,
 *   `removeCamera`            loeschte Zustand und Herkunft, NICHT aber die
 *                             Bestaetigungszeit.
 *
 * Die letzte Luecke ist die lehrreiche: `cameraConfirmations` kam mit Bedarf
 * 102 dazu und wurde an der vorhandenen Aufraeumstelle schlicht vergessen.
 * Auf einem Melde-Weg (`push`) liest `freshness` aus einem stehengebliebenen
 * Zeitstempel dauerhaft „frisch" — also genau die Behauptung, die Bedarf 102
 * abschaffen wollte, nur eine Ebene tiefer.
 *
 * Deshalb raeumt jetzt EINE Methode auf (`vergissKamera`), und alle drei Wege
 * rufen sie. Eine vierte Karte kann so nicht wieder an zwei von drei Stellen
 * fehlen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeServer } from '../src/BridgeServer.js';

interface Innen {
  cameras: Map<number, unknown>;
  cameraStates: Map<number, Record<string, unknown>>;
  cameraOrigins: Map<number, Record<string, string>>;
  cameraConfirmations: Map<number, Record<string, number>>;
  vergissKamera: (num: number) => void;
  disconnectCamera: (num: number) => Promise<void>;
  stop: () => void;
}

/** Eine Bruecke mit einer verbundenen Kamera und vollen Karten. */
const server = (port: number) => {
  const s = new BridgeServer(port, { http: port + 100, ws: port + 200 });
  const innen = s as unknown as Innen;
  innen.cameras.set(1, {
    num: 1,
    connected: true,
    backend: { disconnect: async () => {}, on: () => {} },
    mapState: (x: unknown) => x,
  });
  innen.cameraStates.set(1, { iris: 42 });
  innen.cameraOrigins.set(1, { iris: 'confirmed' });
  innen.cameraConfirmations.set(1, { iris: 1_000 });
  return { s, innen };
};

const leer = (innen: Innen, wo: string) => {
  assert.equal(innen.cameraStates.has(1), false, `${wo}: Zustand blieb stehen`);
  assert.equal(innen.cameraOrigins.has(1), false, `${wo}: Herkunft blieb stehen`);
  assert.equal(
    innen.cameraConfirmations.has(1), false,
    `${wo}: die BESTAETIGUNGSZEIT blieb stehen — genau die Luecke aus Bedarf 102`,
  );
};

test('vergissKamera raeumt alle drei Karten', () => {
  const { innen } = server(19741);
  // `try/finally`, damit der Port AUCH DANN faellt, wenn eine Zusicherung
  // wirft. Ohne das haengt der Lauf im roten Fall, statt rot zu werden — und
  // ein Test, der bei einem Fehlschlag haengt, meldet keinen Fehlschlag.
  try {
    innen.vergissKamera(1);
    leer(innen, 'vergissKamera');
  } finally {
    innen.stop();
  }
});

test('das gewollte Trennen vergisst die Kamera', async () => {
  const { innen } = server(19742);
  try {
    await innen.disconnectCamera(1);
    leer(innen, 'disconnectCamera');
  } finally {
    innen.stop();
  }
});

test('eine andere Kamera bleibt unberuehrt', () => {
  // Gegenprobe: ohne sie koennte `vergissKamera` alles loeschen und die
  // beiden Tests darueber waeren trotzdem gruen.
  const { innen } = server(19743);
  try {
    innen.cameraStates.set(2, { iris: 7 });
    innen.cameraOrigins.set(2, { iris: 'commanded' });
    innen.cameraConfirmations.set(2, { iris: 2_000 });
    innen.vergissKamera(1);
    assert.deepEqual(innen.cameraStates.get(2), { iris: 7 });
    assert.deepEqual(innen.cameraOrigins.get(2), { iris: 'commanded' });
    assert.deepEqual(innen.cameraConfirmations.get(2), { iris: 2_000 });
  } finally {
    innen.stop();
  }
});

test('alle drei Aufraeumwege benutzen dieselbe Methode', async () => {
  // Quelltext, weil es um die VERDRAHTUNG geht: der ungewollte
  // Verbindungsverlust laeuft ueber einen Ereignis-Handler, den ein Test
  // ohne echtes Backend nicht ausloest. Was hier zaehlt, ist, dass keiner
  // der drei Wege wieder seine eigene Loeschliste bekommt.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const quelle = readFileSync(
    fileURLToPath(new URL('../src/BridgeServer.ts', import.meta.url)), 'utf8',
  );
  const aufrufe = quelle.match(/this\.vergissKamera\(/g) ?? [];
  assert.equal(aufrufe.length, 3, 'drei Wege: trennen, Verbindungsverlust, entfernen');
  assert.equal(
    (quelle.match(/this\.cameraConfirmations\.delete\(/g) ?? []).length, 1,
    'die Bestaetigungszeit wird an genau einer Stelle geloescht',
  );
});
