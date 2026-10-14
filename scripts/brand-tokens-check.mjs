// Waechter fuer die Oberflaechen-Regeln (ADR-007 der lz-planner-suite).
// Lauf: `npm run brand:check`
//
// ─── WARUM ES DAS GIBT ─────────────────────────────────────────────────────
//
// Nutzer-Rueckmeldung 2026-09-07: „die ui ist nicht konsistent. lege globale
// ui regeln fest die fuer alle repos gelten." Die Regeln stehen in ADR-007;
// dieses Repo haengt nicht an `@avplan/ui`, also stehen die Werte hier ein
// zweites Mal — ohne diesen Check waere der Rueckweg eine Zeile, die
// niemandem auffaellt.
//
// 2026-10-13: ADR-007 geaendert (Design-Vertrag Oktober 2026, Skill
// `lzm-web`). Flaechen neutral statt Navy, Hell UND Dunkel (Anthrazit) mit
// sichtbarem Umschalter Auto · Hell · Dunkel, weiche Rundungen und leise
// Schatten — aber NUR ueber Tokens. Die alte Zusicherung „Radius 0, kein
// Schatten" ist damit ersetzt durch „Radius und Schatten nur aus
// `--radius-*` / `--shadow-*`". Die Werte unten sind dieselben wie im
// cable-planner; laufen sie auseinander, sehen zwei Werkzeuge derselben
// Marke verschieden aus, ohne dass jemand das entschieden haette.
//
// ─── WAS ER PRUEFT UND WAS AUSDRUECKLICH NICHT ─────────────────────────────
//
// Geprueft wird das DASHBOARD: `src/index.css` (die einzige Token-Datei),
// `styles/regie.css` (Mischer, Videowand, Anlage), `styles/dashboard.css`,
// `styles/wizard.css` und der Theme-Umschalter in `App.tsx`. NICHT geprueft —
// und nicht umgefaerbt — werden `styles/sony-rcp.css` und
// `styles/ptz-panel.css`: Nachbauten der Sony-Steuersoftware und der
// AW-RP150. Ihre Farben sind Wiedererkennung, kein Geschmack.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const web = (p) => resolve(hier, '..', 'packages/web-rcp', p);
const ohneKommentare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = ohneKommentare(readFileSync(web('src/index.css'), 'utf8'));

// ── 1. Beide Modi: exakte Werte ────────────────────────────────────────────
// Der Block wird nach dem Selektor ausgeschnitten; Tokens werden darin gelesen.
const block = (start) => {
  const i = css.indexOf(start);
  assert.ok(i >= 0, `Block fehlt: ${start}`);
  const auf = css.indexOf('{', i);
  let tiefe = 0;
  for (let j = auf; j < css.length; j++) {
    if (css[j] === '{') tiefe++;
    if (css[j] === '}' && --tiefe === 0) return css.slice(auf + 1, j);
  }
  throw new Error(`Block nicht geschlossen: ${start}`);
};
const token = (rumpf, name) => {
  const m = rumpf.match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`));
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
};

const HELL = {
  '--surface-0': '#FAFAF8', '--surface-1': '#FFFFFF', '--surface-2': '#F1F1EE',
  '--surface-3': '#FFFFFF', '--surface-sunken': '#F4F4F1',
  '--text-strong': '#16181D', '--text': '#2B2E35', '--text-muted': '#6A6E77',
  '--line': 'rgba(22, 24, 29, 0.08)', '--line-strong': 'rgba(22, 24, 29, 0.18)',
  '--accent': '#1D324F', '--accent-text': '#F6F5F0',
  '--accent-soft': 'color-mix(in oklab, var(--accent) 10%, transparent)',
  '--logo': 'var(--navy)',
  '--glow-1': 'rgba(29, 50, 79, 0.10)', '--glow-2': 'rgba(200, 137, 43, 0.10)',
  '--shadow-1': '0 1px 2px rgba(22, 24, 29, 0.06)',
  '--shadow-2': '0 4px 16px rgba(22, 24, 29, 0.08)',
  '--shadow-3': '0 16px 48px rgba(22, 24, 29, 0.14)',
};
const DUNKEL = {
  '--surface-0': '#1E1F23', '--surface-1': '#28292E', '--surface-2': '#33343A',
  '--surface-3': '#3B3C42', '--surface-sunken': '#19191D',
  '--text-strong': '#F6F5F0', '--text': '#E6E6E3', '--text-muted': '#A9ACB4',
  '--line': 'rgba(246, 245, 240, 0.09)', '--line-strong': 'rgba(246, 245, 240, 0.20)',
  '--accent': '#B9C7D8', '--accent-text': '#132040',
  '--accent-soft': 'color-mix(in oklab, var(--accent) 12%, transparent)',
  '--logo': 'var(--off-white)',
  '--glow-1': 'rgba(185, 199, 216, 0.16)', '--glow-2': 'rgba(200, 137, 43, 0.10)',
  '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.30)',
  '--shadow-2': '0 4px 16px rgba(0, 0, 0, 0.40)',
  '--shadow-3': '0 16px 48px rgba(0, 0, 0, 0.55)',
};

const hell = block(':root {');
for (const [n, w] of Object.entries(HELL)) assert.equal(token(hell, n), w, `Hell: ${n}`);

// Dunkel steht zweimal (Systemvorgabe und Wahl im Kopf) und muss gleich sein.
const dunkelSystem = block("@media (prefers-color-scheme: dark)");
assert.ok(dunkelSystem.includes(":root:not([data-theme='light'])"), 'Dunkel per System: Wahl „Hell“ muss es ueberstimmen');
const dunkelWahl = block(":root[data-theme='dark']");
for (const [n, w] of Object.entries(DUNKEL)) {
  assert.equal(token(dunkelSystem, n), w, `Dunkel (System): ${n}`);
  assert.equal(token(dunkelWahl, n), w, `Dunkel (Wahl): ${n}`);
}

// Kit-Farben und Status — in beiden Modi gleich.
assert.equal(token(hell, '--navy'), '#1D324F');
assert.equal(token(hell, '--off-white'), '#F6F5F0');
assert.equal(token(hell, '--success'), '#2F7D5C');
assert.equal(token(hell, '--warning'), '#C8892B');
assert.equal(token(hell, '--danger'), '#B04A3F');
assert.equal(token(hell, '--signal'), '#D6402E', 'Tally-Rot ist das Signal');

// Formen: genau die Vertragswerte.
const RADIUS = { '--radius-s': '6px', '--radius-m': '10px', '--radius-l': '20px', '--radius-xl': '24px', '--radius-full': '999px' };
for (const [n, w] of Object.entries(RADIUS)) assert.equal(token(hell, n), w, `Radius ${n}`);

// ── 2. Signal-Rot: genau einmal definiert, nie als rohe Farbe ──────────────
const rot = css.split('\n').map((z) => z.trim()).filter((z) => z.toUpperCase().includes('#D6402E'));
assert.equal(rot.length, 1, `Tally-Rot ist ${rot.length}x definiert`);
assert.ok(rot[0].startsWith('--signal:'), `Tally-Rot steht ausserhalb von --signal: ${rot[0]}`);
assert.ok(css.includes('outline: 2px solid var(--signal)'), 'Fokusring fehlt');
assert.ok(css.includes('outline-offset: 3px'), 'Fokus-Abstand fehlt');

// Logo: Buchstaben in --logo, Punkt in --signal; --logo nie an den Akzent gekoppelt.
assert.ok(/\.logo__mark\s*\{\s*fill:\s*var\(--logo\)/.test(css), 'Signet-Buchstaben nicht in --logo');
assert.ok(/\.logo__dot\s*\{\s*fill:\s*var\(--signal\)/.test(css), 'Signet-Punkt nicht in --signal');
assert.ok(!/--logo:\s*var\(--accent/.test(css), '--logo haengt am Akzent');
const logo = readFileSync(web('src/components/Logo.tsx'), 'utf8');
assert.ok(!/#[0-9a-fA-F]{3,8}\b|fill="(?!none)/.test(logo), 'Logo.tsx bringt eigene Farbe mit -- nur ueber CSS');

// ── 3. Radius und Schatten nur ueber Tokens ────────────────────────────────
// Erlaubt: var(--radius-*), 0 (Logo, Tally-Punkt bleiben eckig) bzw.
// var(--shadow-*), none. Alles andere — rohe px, 50 %, eigene Schatten — nicht.
const RADIUS_OK = /^(0|var\(--radius-(s|m|l|xl|full)\)|inherit)$/;
const SCHATTEN_OK = /^(none|var\(--shadow-(1|2|3|accent)\)(\s*,\s*var\(--shadow-(1|2|3)\))?)$/;
const DATEIEN = {
  'index.css': css,
  'regie.css': ohneKommentare(readFileSync(web('src/styles/regie.css'), 'utf8')),
  'dashboard.css': ohneKommentare(readFileSync(web('src/styles/dashboard.css'), 'utf8')),
  'wizard.css': ohneKommentare(readFileSync(web('src/styles/wizard.css'), 'utf8')),
};
for (const [datei, inhalt] of Object.entries(DATEIEN)) {
  for (const m of inhalt.matchAll(/(?<![-\w])border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)) {
    assert.ok(RADIUS_OK.test(m[1].trim()), `${datei}: Rundung "${m[1].trim()}" -- nur var(--radius-*)`);
  }
  for (const m of inhalt.matchAll(/(?<![-\w])box-shadow:\s*([^;}]+)/g)) {
    assert.ok(SCHATTEN_OK.test(m[1].trim()), `${datei}: Schatten "${m[1].trim()}" -- nur var(--shadow-*)`);
  }
}

// Die Teil-Stilblaetter bringen KEINE eigene Farbe mit: alles kommt aus
// index.css. Rot im Werkzeug nur dort, wo es Tally/Live bedeutet (regie.css).
for (const datei of ['regie.css', 'dashboard.css', 'wizard.css']) {
  const inhalt = DATEIEN[datei];
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(inhalt), `${datei}: rohes Hex gefunden -- Tokens benutzen`);
  assert.ok(!/rgba?\(/.test(inhalt), `${datei}: rgba gefunden -- Tokens benutzen`);
  assert.ok(!/gradient\(/.test(inhalt), `${datei}: Verlauf gefunden -- der Schein gehoert nur auf den Grund (index.css)`);
}
assert.ok(/var\(--signal\)/.test(DATEIEN['regie.css']), 'regie.css: Tally/Live kommt aus --signal');
for (const datei of ['dashboard.css', 'wizard.css']) {
  assert.ok(!/var\(--signal\)/.test(DATEIEN[datei]), `${datei}: Tally-Rot hat im Werkzeug ausser Fokus und Tally nichts verloren`);
}

// Weisse Schrift auf dem Akzent waere im Dunkelmodus unlesbar.
const unlesbar = Object.values(DATEIEN).join('\n').split('\n')
  .filter((z) => z.includes('var(--accent)') && /color:\s*(#fff|white)/i.test(z));
assert.deepEqual(unlesbar, [], `Weiss auf Akzent: ${unlesbar.join(' | ')}`);

// Satzschreibung: Versalien nur fuer kleine Overlines/Badges (<= 12 px).
for (const [datei, inhalt] of Object.entries(DATEIEN)) {
  for (const regel of inhalt.split('}')) {
    if (!/text-transform:\s*uppercase/.test(regel)) continue;
    const gr = /font-size:\s*(var\(--fs-overline\)|(\d+)px)/.exec(regel);
    assert.ok(gr && (gr[1] === 'var(--fs-overline)' || Number(gr[2]) <= 12),
      `${datei}: Versalien ueber 12 px -- Satzschreibung: ${regel.trim().split('{')[0]}`);
  }
}
console.log('brand:check ok — Tokens Hell + Dunkel, Signal einmal, Logo in Kit-Farben, Radius/Schatten nur ueber Tokens');

// ── 4. Theme-Umschalter Auto · Hell · Dunkel, sichtbar und gespeichert ────
const app = readFileSync(web('src/App.tsx'), 'utf8');
assert.ok(app.includes('className="themes"'), 'Theme-Umschalter (.themes) fehlt im Kopf');
for (const t of ['auto', 'light', 'dark']) assert.ok(app.includes(`id: '${t}'`), `Theme-Wahl „${t}“ fehlt`);
assert.ok(/aria-pressed=\{theme === t\.id\}/.test(app), 'Theme-Umschalter zeigt die Wahl nicht an (aria-pressed)');
assert.ok(/localStorage\.setItem\(THEME_KEY/.test(app), 'Theme-Wahl wird nicht gespeichert');
assert.ok(/\.app__header\s*\{[^}]*backdrop-filter:\s*blur\(16px\) saturate\(1\.4\)/.test(css), 'Glas-Kopfzeile fehlt');

// ── 5. Schrift lokal, Linien-Icons statt Emoji ─────────────────────────────
const main = readFileSync(web('src/main.tsx'), 'utf8');
assert.ok(main.includes('@fontsource-variable/public-sans'), 'Public Sans wird nicht lokal geladen');
const html = readFileSync(web('index.html'), 'utf8');
assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html + css), 'Schrift-Abruf von Google gefunden');

const komp = web('src/components');
const emoji = /[\u{1F300}-\u{1FAFF}\u{2699}\u{25CE}]/u;
for (const f of readdirSync(komp)) {
  if (/^(Sony|PtzPanel|RotaryKnob)/.test(f)) continue;
  assert.ok(!emoji.test(readFileSync(resolve(komp, f), 'utf8')), `${f}: Emoji als Icon -- components/Icon.tsx benutzen`);
}

console.log('brand:check ok — Theme-Umschalter, Glas-Kopf, lokale Schrift, Linien-Icons');
