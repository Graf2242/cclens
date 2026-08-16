/**
 * The browser side of the message layer.
 *
 * The engine itself is `/locales/i18n.js` — the very file the Node side
 * imports, served straight out of `locales/` by the server. The catalog
 * arrives from `/api/i18n`, which also names the locale, so the dashboard and
 * the CLI can never disagree about which language they are in.
 *
 * This module top-level-awaits both. That is deliberate: every screen imports
 * `t` and renders synchronously, so the catalog has to be in hand before any
 * of them get a chance to run. Blocking one module graph on one local fetch is
 * the cheapest way to buy that, and it keeps `t` a plain function everywhere
 * else instead of a promise every caller has to remember to await.
 */

import { createFormatters, createTranslator } from '/locales/i18n.js';

const warned = new Set();

const wantedLocale = localStorage.getItem('bl:locale') || 'en';
const res = await fetch(`/api/i18n?locale=${encodeURIComponent(wantedLocale)}`);
const { locale, catalog, locales } = await res.json();

export const t = createTranslator(locale, catalog, (key) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`i18n: missing key ${key} (${locale})`);
});

export const fmt = createFormatters(locale);

export { locale, locales };

/** `data-i18n-aria-label` → `aria-label` */
const attrName = (dataKey) =>
  dataKey.slice('i18n'.length).replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/**
 * Translate the markup that ships in `index.html` — the shell the dashboard
 * renders into, which exists before any screen module runs and so cannot be
 * built through `t` the way every other node is.
 *
 *   <h2 data-i18n="spend.panel.breakdown">
 *   <button data-i18n-title="toolbar.sourceRemove">
 *   <div data-i18n-aria-label="toolbar.view">
 *
 * Text is only replaced on `data-i18n`; the attribute variants leave
 * `textContent` alone, so a button with both an icon child and a title keeps
 * its icon.
 */
export function applyStatic(root = document) {
  // `<html lang>` is a real behaviour, not decoration: it picks the hyphenation
  // and quotation rules the browser applies to everything below it.
  if (root === document) document.documentElement.lang = locale;

  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('*')) {
    for (const dataKey of Object.keys(node.dataset)) {
      if (dataKey === 'i18n' || !dataKey.startsWith('i18n')) continue;
      node.setAttribute(attrName(dataKey), t(node.dataset[dataKey]));
    }
  }
}
