#!/usr/bin/env node
/**
 * The catalog's tripwire. Three checks, all mechanical, all fail the build:
 *
 *   1. every `t('key')` in the source resolves to a leaf in the catalog
 *   2. every `data-i18n*="key"` in index.html resolves too
 *   3. no user-visible string literal in the source still holds Cyrillic
 *
 * (3) is the one that matters. A prose rule saying "put texts in the catalog"
 * is probabilistic — someone in a hurry writes the string inline and nothing
 * objects until a translator opens the file a year later. This check objects
 * immediately, and it is the reason the extraction stays extracted.
 *
 * Unused catalog keys are reported but do not fail: a key can legitimately be
 * reached through a computed path (`t(`share.widget.format.${id}.label`)`),
 * which no static reader can follow. Those prefixes are declared in
 * `DYNAMIC_PREFIXES` so the report stays honest about what it cannot see.
 *
 *   node scripts/i18n-lint.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Opt-out marker for Cyrillic that is data, not UI — written on the line
 * itself or the one above it. The only legitimate use so far is a probe
 * pattern, which matches text the model produced in a log.
 */
const EXEMPT = /i18n-exempt/;

/**
 * Key prefixes reached by a computed path. Anything under one of these is
 * exempt from the unused-key report — and only from that report.
 */
const DYNAMIC_PREFIXES = [
  'share.widget.format.',
  'metric.',
  'dimension.',
  'view.',
  'probeconfig.builtin.',
];

// ── source scanning ──────────────────────────────────────────
//
// Comments must not count as "user-visible text" and strings must not be
// mistaken for comments (`'http://…'`), so this is a real scanner rather than
// a regex sweep: it walks the file tracking which of line-comment, block
// comment, string, template or regex it is inside.

/** @returns {Array<{ quote: string, value: string, line: number }>} */
function scanStrings(src) {
  const out = [];
  let i = 0;
  let line = 1;
  // Last significant character, to tell `a / b` from a regex literal.
  let prev = '';

  const atLineStart = () => /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '';

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (c === '/' && atLineStart()) {
      // Regex literal — skipped whole; a character class may legitimately hold
      // Cyrillic and that is not a user-visible string.
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') { line++; break; }
        i++;
      }
      prev = '/';
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const startLine = line;
      const quote = c;
      let value = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { value += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === '\n') line++;
        // `${…}` inside a template is code, not text — step over it so a
        // Cyrillic identifier or nested string is judged on its own.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '\n') line++;
            i++;
          }
          continue;
        }
        value += src[i];
        i++;
      }
      i++;
      out.push({ quote, value, line: startLine });
      prev = quote;
      continue;
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out;
}

/** Literal keys — `t('a.b')` / `t("a.b")` / `t(\`a.b\`)` with no interpolation. */
function usedKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/\bt\(\s*(['"`])([^'"`$\\]+)\1/g)) keys.add(m[2]);
  return keys;
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

// ── catalog ──────────────────────────────────────────────────

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Flatten to addressable leaves. A plural object is one leaf, not six. */
function leaves(node, prefix = '', out = new Set()) {
  if (typeof node === 'string') { out.add(prefix); return out; }
  if (!node || typeof node !== 'object') return out;

  const keys = Object.keys(node);
  const isPlural =
    keys.length > 0 &&
    keys.every((k) => PLURAL_CATEGORIES.has(k) || k.startsWith('='));
  if (isPlural) { out.add(prefix); return out; }

  for (const k of keys) leaves(node[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// ── run ──────────────────────────────────────────────────────

const catalogPath = path.join(ROOT, 'locales', 'ru.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const known = leaves(catalog);

const sources = [
  ...walk(path.join(ROOT, 'src'), ['.ts']),
  ...walk(path.join(ROOT, 'web'), ['.js']),
  path.join(ROOT, 'locales', 'i18n.js'),
];

const missing = [];   // key used in code, absent from catalog
const stray = [];     // Cyrillic still living in a string literal
const used = new Set();

for (const file of sources) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');

  // The engine documents itself with example keys and carries the plural
  // fallback table — neither is a reference to the real catalog.
  if (rel === path.join('locales', 'i18n.js')) continue;

  for (const key of usedKeys(src)) {
    used.add(key);
    if (!known.has(key)) missing.push(`${rel}: t('${key}')`);
  }

  const lines = src.split('\n');

  for (const { value, line } of scanStrings(src)) {
    // A key handed to `t` through a ternary or a variable never appears next
    // to the call. Any literal that IS a catalog key counts as a reference —
    // the alternative is a false "unused" on every conditional label.
    if (known.has(value)) used.add(value);
    if (!CYRILLIC.test(value)) continue;
    // Not every Cyrillic literal is UI. A probe pattern matches what the model
    // wrote in the log, which is not the language the dashboard is rendered in
    // — translating it would break the probe. Such lines say so explicitly.
    if (EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')) continue;
    stray.push(`${rel}:${line}: ${JSON.stringify(value.slice(0, 72))}`);
  }
}

// index.html: keys in `data-i18n*`, and any Cyrillic left in the markup.
const htmlPath = path.join(ROOT, 'web', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
  used.add(m[1]);
  if (!known.has(m[1])) missing.push(`web/index.html: data-i18n="${m[1]}"`);
}
html.split('\n').forEach((text, idx) => {
  if (CYRILLIC.test(text)) stray.push(`web/index.html:${idx + 1}: ${text.trim().slice(0, 72)}`);
});

const unused = [...known]
  .filter((k) => !used.has(k))
  .filter((k) => !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)))
  .sort();

const report = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows) console.log('  ' + row);
};

report('MISSING — used in code, not in the catalog', missing);
report('STRAY — Cyrillic still inline, not in the catalog', stray);
report('UNUSED — in the catalog, never referenced', unused);

const failed = missing.length + stray.length;
console.log(
  `\ni18n: ${known.size} keys, ${used.size} referenced, ` +
    `${missing.length} missing, ${stray.length} stray, ${unused.length} unused`
);

if (failed) process.exit(1);
