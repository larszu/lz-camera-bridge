// Waechter fuer die Oberflaechen-Regeln (ADR-007 der av-planner-suite).
// Lauf: `npm run brand:check`
//
// ─── WAS ER PRUEFT UND WAS AUSDRUECKLICH NICHT ─────────────────────────────
//
// Geprueft wird das DASHBOARD (`packages/web-rcp/src/index.css`). NICHT
// geprueft — und nicht umgefaerbt — werden `styles/sony-rcp.css` und
// `styles/ptz-panel.css`: die sind Nachbauten der Sony-Steuersoftware und der
// AW-RP150. Ihre Farben sind kein Geschmack, sondern Wiedererkennung; wer das
// Geraet kennt, findet den Knopf blind. Eine Marken-Regel fuer
// Planungswerkzeuge ist kein Grund, ein Instrument umzulackieren.
//
// Die Werte stehen hier ein zweites Mal, weil dieses Repo nicht an
// `@avplan/ui` haengt. Ohne diesen Check waere der Rueckweg eine Zeile, die
// niemandem auffaellt.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(hier, '..', 'packages/web-rcp/src/index.css'), 'utf8');

const token = (name) => {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
};

assert.equal(token('--bg'), '#132040', 'Grund ist Deep Navy');
assert.equal(token('--surface'), '#1D324F', 'Flaeche ist Zumpe Navy');
assert.equal(token('--text'), '#E1ECEF', 'Fliesstext ist Eisblau');
assert.equal(token('--text-muted'), '#8C9CB3', 'Gedaempft ist Stahlblau');
assert.equal(token('--accent'), '#F6F5F0', 'Aktionsflaeche ist Off-White');
assert.equal(token('--accent-text'), '#132040', 'darauf steht Navy');

assert.equal(token('--success'), '#2F7D5C');
assert.equal(token('--warning'), '#C8892B');
assert.equal(token('--danger'), '#B04A3F');
assert.equal(token('--signal'), '#D6402E', 'Tally-Rot ist das Signal');
assert.notEqual(token('--danger'), token('--signal'), 'zwei Toene, zwei Zwecke');

const rotZeilen = css
  .split('\n')
  .map((z) => z.trim())
  .filter((z) => z.toUpperCase().includes('#D6402E'));
assert.ok(
  rotZeilen.every((z) => z.startsWith('--signal:')),
  `Tally-Rot steht ausserhalb von --signal: ${rotZeilen.join(' | ')}`,
);

assert.ok(css.includes('outline: 2px solid var(--signal)'), 'Fokusring fehlt');
assert.ok(css.includes('outline-offset: 3px'), 'Fokus-Abstand fehlt');

assert.equal(token('--radius'), '0', 'Radius ist null');
assert.ok(!/border-radius:\s*(50%|[1-9])/.test(css), 'harter Radius gefunden');
assert.ok(!/linear-gradient|radial-gradient/.test(css), 'Verlauf gefunden');
assert.ok(!/box-shadow:(?!\s*none\s*;)[^;]+;/.test(css), 'Schatten gefunden');

// Weisse Schrift auf der Off-White-Flaeche ist unlesbar — und faellt erst
// auf, wenn jemand mit der Maus darueber geht.
const unlesbar = css
  .split('\n')
  .filter((z) => z.includes('var(--accent)') && /color:\s*(#fff|white)/i.test(z));
assert.deepEqual(unlesbar, [], `Weiss auf Off-White: ${unlesbar.join(' | ')}`);

console.log('brand:check ok — Oberflaechen-Regeln (ADR-007) eingehalten');
