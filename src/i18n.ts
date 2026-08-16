/**
 * The Node side of the message layer — everything the CLI prints and
 * everything `share.ts` renders into markdown.
 *
 * The catalog is read from disk rather than `import`ed with a type attribute:
 * JSON module imports are still gated behind flags in some Node builds, and a
 * dashboard that fails to boot over an import attribute is a worse trade than
 * one synchronous `readFileSync` at startup.
 *
 * `LOCALES_DIR` is exported because `server.ts` serves the same directory to
 * the browser — one catalog, two runtimes, no copy that can drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFormatters, createTranslator, type Formatters, type Translator } from '../locales/i18n.js';

export type { TParams, Translator, Formatters } from '../locales/i18n.js';

export const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');

/** Locales with a catalog on disk. The dashboard offers exactly these. */
export function availableLocales(): string[] {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export const DEFAULT_LOCALE = 'ru';

/**
 * `BURNLENS_LOCALE=en burnlens report` overrides. An unknown value falls back
 * rather than throwing: a typo in an env var should not make the tool refuse
 * to run, and the missing-key warnings will say plenty.
 */
function pickLocale(): string {
  const want = process.env.BURNLENS_LOCALE?.trim();
  if (want && availableLocales().includes(want)) return want;
  return DEFAULT_LOCALE;
}

function readCatalog(loc: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${loc}.json`), 'utf8'));
}

export const locale = pickLocale();

/**
 * Missing keys go to stderr, never stdout: `report` and `share` output is
 * piped and diffed, and a warning in the middle of a markdown table would
 * corrupt the artefact it is warning about.
 */
const warned = new Set<string>();
function onMissing(key: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`i18n: missing key ${key} (${locale})\n`);
}

export const t: Translator = createTranslator(locale, readCatalog(locale), onMissing);

export const fmt: Formatters = createFormatters(locale);
