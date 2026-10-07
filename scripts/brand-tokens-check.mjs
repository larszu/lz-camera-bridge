// Waechter fuer die Oberflaechen-Regeln (ADR-007 der av-planner-suite).
// Lauf: `npm run brand:check`
//
// ─── WAS ER PRUEFT UND WAS AUSDRUECKLICH NICHT ─────────────────────────────
//
// Geprueft wird das DASHBOARD (`packages/web-rcp/src/index.css`) und die
// Regie-Ansichten (`styles/regie.css`: Mischer, Videowand, Anlage). NICHT
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

// ─── Die Regie-Ansichten: nur Tokens, keine Form ──────────────────────────
//
// `styles/regie.css` kam mit dem Mischer, der Videowand und der Anlage dazu.
// Es darf KEINE eigene Farbe mitbringen (rohes Hex), keine Rundung, keinen
// Schatten, keinen Verlauf -- alles kommt aus den Tokens oben.
const regie = readFileSync(resolve(hier, '..', 'packages/web-rcp/src/styles/regie.css'), 'utf8');
const ohneKommentare = regie.replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(ohneKommentare), 'regie.css: rohes Hex gefunden -- Tokens benutzen');
assert.ok(!/border-radius/.test(ohneKommentare), 'regie.css: Rundung gefunden');
assert.ok(!/box-shadow/.test(ohneKommentare), 'regie.css: Schatten gefunden');
assert.ok(!/gradient\(/.test(ohneKommentare), 'regie.css: Verlauf gefunden');
assert.ok(/var\(--signal\)/.test(ohneKommentare), 'regie.css: das Tally-Rot kommt aus --signal');
console.log('brand:check ok — regie.css nur aus Tokens, ohne Rundung, Schatten, Verlauf');

// ─── lzm-web 2026: Assistent und Dashboard-Rahmen, Hell, Schrift, Icons ────
//
// `styles/wizard.css` (Ersteinrichtung) und `styles/dashboard.css` (Kopf,
// Kameraliste, Multiview-Karten, Kamera-Plan) trugen bis Oktober 2026 eigenes
// Grau, Sony-Blau und Rundungen. Sie sind Dashboard, kein Nachbau -- also
// dieselbe Regel wie regie.css.
for (const datei of ['wizard.css', 'dashboard.css']) {
  const roh = readFileSync(resolve(hier, '..', 'packages/web-rcp/src/styles', datei), 'utf8');
  const ohne = roh.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(ohne), `${datei}: rohes Hex gefunden -- Tokens benutzen`);
  assert.ok(!/rgba?\(/.test(ohne), `${datei}: rgba gefunden -- Tokens benutzen`);
  assert.ok(!/border-radius/.test(ohne), `${datei}: Rundung gefunden`);
  assert.ok(!/box-shadow/.test(ohne), `${datei}: Schatten gefunden`);
  assert.ok(!/gradient\(/.test(ohne), `${datei}: Verlauf gefunden`);
  assert.ok(!/var\(--signal\)/.test(ohne), `${datei}: Tally-Rot hat im Werkzeug ausser dem Fokus nichts verloren`);
}

// Hell gibt es -- per Systemvorgabe und per Wahl im Kopf -- und dort steht
// Navy auf Off-White, Stahlblau nie als Text.
assert.ok(css.includes(":root[data-theme='light']"), 'Hell-Modus fehlt');
assert.ok(/prefers-color-scheme:\s*light/.test(css), 'Systemvorgabe Hell fehlt');
const hell = css.slice(css.indexOf(":root[data-theme='light']"));
assert.ok(/--text-muted:\s*var\(--schiefer\)/.test(hell), 'Hell: Sekundaertext ist Schiefer, nicht Stahlblau');

// Public Sans kommt aus dem Paket, nicht aus dem Netz (DSGVO, Electron offline).
const main = readFileSync(resolve(hier, '..', 'packages/web-rcp/src/main.tsx'), 'utf8');
assert.ok(main.includes("@fontsource-variable/public-sans"), 'Public Sans wird nicht lokal geladen');
const html = readFileSync(resolve(hier, '..', 'packages/web-rcp/index.html'), 'utf8');
assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html + css), 'Schrift-Abruf von Google gefunden');

// Keine Emoji als Bedienzeichen in den Marken-Ansichten (Nachbauten ausgenommen).
const { readdirSync } = await import('node:fs');
const komp = resolve(hier, '..', 'packages/web-rcp/src/components');
const emoji = /[\u{1F300}-\u{1FAFF}\u{2699}\u{25CE}]/u;
for (const f of readdirSync(komp)) {
  if (/^(Sony|PtzPanel|RotaryKnob)/.test(f)) continue;
  assert.ok(!emoji.test(readFileSync(resolve(komp, f), 'utf8')), `${f}: Emoji als Icon -- components/Icon.tsx benutzen`);
}

console.log('brand:check ok — lzm-web: Assistent, Dashboard-Rahmen, Hell, lokale Schrift, Linien-Icons');
