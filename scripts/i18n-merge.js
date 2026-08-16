#!/usr/bin/env node
/**
 * Fold catalog fragments into `locales/ru.json`.
 *
 * The extraction was done file by file, each producing its own namespace as a
 * separate fragment, because several writers on one JSON is how you lose a
 * namespace to a clobbered write. Merging is therefore a separate, boring,
 * checkable step — and it refuses to be clever: a key that already exists with
 * a DIFFERENT value is a collision, reported and left alone, never silently
 * overwritten. Same value twice is fine; that is just two screens sharing a
 * label.
 *
 *   node scripts/i18n-merge.js <fragment.json> [...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ROOT, 'locales', 'ru.json');

const fragments = process.argv.slice(2);
if (!fragments.length) {
  console.error('usage: node scripts/i18n-merge.js <fragment.json> [...]');
  process.exit(2);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const collisions = [];
let added = 0;

function merge(dst, src, trail = '') {
  for (const [key, value] of Object.entries(src)) {
    const at = trail ? `${trail}.${key}` : key;

    if (!(key in dst)) {
      dst[key] = value;
      if (typeof value === 'string') added++;
      else added += countStrings(value);
      continue;
    }

    if (isPlainObject(dst[key]) && isPlainObject(value)) {
      merge(dst[key], value, at);
      continue;
    }

    if (JSON.stringify(dst[key]) !== JSON.stringify(value)) {
      collisions.push({ at, existing: dst[key], incoming: value });
    }
  }
}

function countStrings(node) {
  if (typeof node === 'string') return 1;
  if (!isPlainObject(node)) return 0;
  return Object.values(node).reduce((n, v) => n + countStrings(v), 0);
}

const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));

for (const file of fragments) {
  if (!fs.existsSync(file)) {
    console.error(`missing fragment: ${file}`);
    process.exit(2);
  }
  merge(catalog, JSON.parse(fs.readFileSync(file, 'utf8')));
}

if (collisions.length) {
  console.log(`\nCOLLISIONS (${collisions.length}) — kept the existing value, resolve by hand:`);
  for (const c of collisions) {
    console.log(`  ${c.at}`);
    console.log(`    existing: ${JSON.stringify(c.existing)}`);
    console.log(`    incoming: ${JSON.stringify(c.incoming)}`);
  }
}

fs.writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n');
console.log(`\nmerged ${fragments.length} fragment(s): +${added} strings, ${collisions.length} collision(s)`);
