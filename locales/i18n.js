/**
 * The message engine. One file, plain ESM, no dependencies — because both
 * runtimes import it verbatim: Node (CLI + the server-rendered markdown in
 * share.ts) and the browser (the dashboard, unbundled). A second copy of this
 * logic is how the codebase ended up with three different `plural()` helpers
 * before the texts were extracted; there is exactly one now.
 *
 * Everything locale-specific is delegated to the platform's `Intl`:
 * `Intl.PluralRules` for the plural category, `Intl.NumberFormat` for `{n,
 * number}`. That is the same CLDR data an i18n library would bundle, minus the
 * bundle — and it is correct for any locale added later, not just Russian.
 *
 * Catalog shape (`<locale>.json`), nested, addressed by dot-path:
 *
 *   { "spend": { "table": { "header": { "share": "доля" } } } }
 *      → t('spend.table.header.share')
 *
 * A leaf is either a string, or an object of CLDR plural categories:
 *
 *   { "one": "{n} находка", "few": "{n} находки", "many": "{n} находок" }
 *      → t('probes.status.hits', { n: 12 })   // picks by Intl.PluralRules
 *
 * Placeholders inside a leaf:
 *
 *   {name}          — String(value), verbatim
 *   {name, number}  — Intl.NumberFormat(locale).format(value)
 */

/** CLDR categories, in the order a missing one falls back through. */
const PLURAL_FALLBACK = ['other', 'many', 'few', 'one'];

const PLACEHOLDER = /\{(\w+)(?:\s*,\s*(\w+))?\}/g;

/**
 * Walk a dot-path into the catalog. Returns `undefined` rather than throwing:
 * a missing key must degrade to a visible placeholder in the UI, not blow up
 * a render. `i18n:lint` is what actually forbids missing keys, at dev time.
 */
function lookup(catalog, key) {
  let node = catalog;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Pick the plural form for `n`.
 *
 * The catalog is not required to spell out every category the locale has —
 * Russian `сессии/сессиях/сессиях` collapses few and many, and English needs
 * only one/other. Whatever is missing falls back through `PLURAL_FALLBACK`, so
 * a two-form entry works in a four-form language without repeating itself.
 */
function selectPlural(forms, n, rules) {
  const exact = forms['=' + n];
  if (typeof exact === 'string') return exact;
  const category = rules.select(n);
  if (typeof forms[category] === 'string') return forms[category];
  for (const fallback of PLURAL_FALLBACK) {
    if (typeof forms[fallback] === 'string') return forms[fallback];
  }
  return undefined;
}

function interpolate(template, params, numberFormat) {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name, kind) => {
    if (!(name in params)) return whole;
    const value = params[name];
    if (value == null) return '';
    if (kind === 'number') return numberFormat.format(Number(value));
    return String(value);
  });
}

/**
 * Build a `t` bound to one catalog.
 *
 * `onMissing` exists so the two runtimes can report a gap the way each one
 * can: the browser warns to the console, Node writes to stderr. Neither
 * throws — see `lookup`.
 */
export function createTranslator(locale, catalog, onMissing) {
  const rules = new Intl.PluralRules(locale);
  const numberFormat = new Intl.NumberFormat(locale);

  const miss = (key) => {
    if (onMissing) onMissing(key);
    return key;
  };

  /**
   * @param {string} key    dot-path into the catalog
   * @param {object} [params] placeholder values; `n` also drives plural choice
   */
  return function t(key, params) {
    const entry = lookup(catalog, key);

    if (typeof entry === 'string') {
      return interpolate(entry, params, numberFormat);
    }

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const n = params?.n;
      if (typeof n !== 'number') return miss(key);
      const form = selectPlural(entry, n, rules);
      if (form == null) return miss(key);
      return interpolate(form, params, numberFormat);
    }

    return miss(key);
  };
}

/**
 * The locale's own number/date formatting, in one place so no screen reaches
 * for a hardcoded `'ru-RU'` again — that literal was in twelve call sites
 * before extraction and every one of them was a language decision written as
 * a formatting detail.
 */
export function createFormatters(locale) {
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateTime = new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const full = new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  return {
    locale,
    /** 1234567 → "1 234 567" */
    n: (v) => number.format(Number(v ?? 0)),
    /** 21.03.2026 */
    date: (ts) => date.format(new Date(ts)),
    /** 21.03, 14:05 — the dashboard's compact timestamp */
    dateTime: (ts) => dateTime.format(new Date(ts)),
    /** 14:05:33 */
    time: (ts) => time.format(new Date(ts)),
    /** 21.03.2026, 14:05:33 — the terminal's timestamp */
    full: (ts) => full.format(new Date(ts)),
  };
}
