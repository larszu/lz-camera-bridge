import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 3700,
    // IM NETZ ERREICHBAR, wie die Bruecke auch (gemessen 2026-09-15).
    //
    // `BridgeServer.start()` bindet jede Schnittstelle und nennt beim Start
    // ausdruecklich die LAN-Adressen, mit der Begruendung im Quelltext:
    // „A control surface on a tablet is the normal case for this
    // application, not the exception, and whoever sets it up has to be told
    // where to point it."
    //
    // Die OBERFLAECHE, die dieses Tablet oeffnen soll, lag dagegen auf
    // `localhost` — Vite sagte es bei jedem Start selbst („Network: use
    // --host to expose"), und niemand las es als Befund. Die Bruecke nannte
    // also `ws://192.168.1.42:9700`, und unter
    // `http://192.168.1.42:3700` stand nichts. Die eine Haelfte des
    // Versprechens war eingeloest, die andere nicht.
    //
    // `useBridge.ts` baut seine Adresse aus `window.location.hostname` und
    // spricht die Bruecke DIREKT an, nicht ueber den Proxy unten — vom
    // Tablet aus wird daraus von selbst die richtige LAN-Adresse.
    //
    // Was das heisst, und es steht hier statt in einer Fussnote: der
    // Entwicklungsserver ist damit im ganzen Netz offen. Das ist bei einem
    // Regie-Pult der Zweck und in einem fremden WLAN ein Risiko; wer das
    // nicht will, startet mit `npm run web -- --host 127.0.0.1`.
    // `Broadcast-intercom` haelt es in seinem `apps/web` genauso.
    host: true,
    proxy: {
      '/ws': {
        target: 'ws://localhost:9700',
        ws: true,
      },
    },
  },
});
