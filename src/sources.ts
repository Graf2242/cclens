/**
 * Data sources — one Claude installation each.
 *
 * A second subscription lives in its own home dir (`~/.claude-personal`), with
 * its own `projects/` tree, and has nothing to do with the first: different
 * sessions, different projects, different money. So they are never merged into
 * one index — each source gets its OWN SQLite file and the dashboard switches
 * between them. That keeps every query in `queries.ts` untouched and makes it
 * impossible to accidentally sum two subscriptions into one total.
 *
 * The built-in source (`~/.claude/projects`, or `CLAUDE_PROJECTS_DIR`) is
 * always present, keeps the historical `index.db` path, and cannot be removed.
 * Anything added by the user is persisted next to the indexes in
 * `sources.json`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultDbPath } from './db.ts';
import { t } from './i18n.ts';
import { projectsRoot } from './paths.ts';

export interface Source {
  /** Stable id derived from the root path; the built-in one is `default`. */
  id: string;
  /** Human label, e.g. `~/.claude-personal`. */
  label: string;
  /** Absolute path to the `projects/` directory. */
  root: string;
  /** SQLite index for this source alone. */
  db: string;
  /** The built-in source: always listed, never removable. */
  builtin: boolean;
}

function dataDir(): string {
  return path.dirname(defaultDbPath());
}

export function sourcesConfigPath(): string {
  return path.join(dataDir(), 'sources.json');
}

/** `~`-relative when it helps, absolute otherwise — labels are read, not parsed. */
function labelFor(root: string): string {
  // The `projects/` segment is noise: what identifies an installation is the
  // directory holding it (`~/.claude`, `~/.claude-personal`).
  const base = path.basename(root) === 'projects' ? path.dirname(root) : root;
  const home = os.homedir();
  return base === home ? '~' : base.startsWith(home + path.sep) ? '~' + base.slice(home.length) : base;
}

function idFor(root: string): string {
  return 'src-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
}

export function builtinSource(): Source {
  const root = projectsRoot();
  return { id: 'default', label: labelFor(root), root, db: defaultDbPath(), builtin: true };
}

/**
 * The source a `projects/` root maps to — registered or not.
 *
 * The db path is derived from the root, so two corpora can never land in one
 * index file: `indexAll` prunes rows whose file is not on disk, and pointing a
 * second installation at the first one's db would wipe it.
 */
function sourceFor(root: string, label?: string): Source {
  if (root === projectsRoot()) return builtinSource();
  const id = idFor(root);
  return {
    id,
    label: label || labelFor(root),
    root,
    db: path.join(dataDir(), `index-${id}.db`),
    builtin: false,
  };
}

/** Same mapping for an ad-hoc `--root`, without touching the registry. */
export function ephemeralSource(input: string): Source {
  return sourceFor(resolveRoot(input));
}

/**
 * Turn whatever the user typed into a `projects/` root.
 * Both `~/.claude-personal` and `~/.claude-personal/projects` are accepted —
 * the first is what a person thinks of as "the folder", the second is what the
 * walker needs.
 */
export function resolveRoot(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error(t('sources.error.emptyPath'));
  const home = os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  const abs = path.resolve(expanded);

  for (const candidate of [path.join(abs, 'projects'), abs]) {
    if (isDir(candidate)) return candidate;
  }
  throw new Error(t('sources.error.notFound', { path: abs, projectsPath: path.join(abs, 'projects') }));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readConfig(): Array<{ root: string; label?: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcesConfigPath(), 'utf8'));
    const list = Array.isArray(parsed?.sources) ? parsed.sources : [];
    return list.filter((s: any) => typeof s?.root === 'string');
  } catch {
    return [];
  }
}

function writeConfig(entries: Array<{ root: string; label?: string }>): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(sourcesConfigPath(), JSON.stringify({ sources: entries }, null, 2) + '\n');
}

/** The built-in source first, then whatever the user added, deduped by root. */
export function listSources(): Source[] {
  const out = [builtinSource()];
  const seen = new Set(out.map((s) => s.root));
  for (const e of readConfig()) {
    const root = path.resolve(e.root);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(sourceFor(root, e.label));
  }
  return out;
}

/** Adds a folder (idempotent: an already-known root is returned as-is). */
export function addSource(input: string): Source {
  const root = resolveRoot(input);
  const existing = listSources().find((s) => s.root === root);
  if (existing) return existing;

  const entries = readConfig();
  entries.push({ root });
  writeConfig(entries);

  const added = listSources().find((s) => s.root === root);
  if (!added) throw new Error(t('sources.error.saveFailed'));
  return added;
}

/**
 * Deregisters a source. Its index file is left on disk: re-adding the same
 * folder then costs nothing, and no click in a dashboard should delete data.
 */
export function removeSource(id: string): Source {
  const src = listSources().find((s) => s.id === id);
  if (!src) throw new Error(t('sources.error.unknown', { id }));
  if (src.builtin) throw new Error(t('sources.error.builtinUndeletable'));
  writeConfig(readConfig().filter((e) => path.resolve(e.root) !== src.root));
  return src;
}
