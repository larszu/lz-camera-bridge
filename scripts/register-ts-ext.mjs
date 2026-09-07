// Registriert den ts-ext-Resolve-Hook fuer die Check-Skripte, die
// TypeScript-Quelldateien direkt ausfuehren (hier: die Faehigkeits-Tabelle
// dieses Repos gegen die Kopie im multicam-planner).
// Nutzung: node --experimental-strip-types --import ./scripts/register-ts-ext.mjs <script>
import { register } from 'node:module';
register('./ts-ext-hooks.mjs', import.meta.url);
