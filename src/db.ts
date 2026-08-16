/**
 * The index: one SQLite row per billed assistant message, plus a session table
 * for labels. Built on node:sqlite so the whole tool stays dependency-free.
 *
 * Indexing is incremental on (path, mtime, size). A session file that is still
 * being appended to gets re-parsed wholesale when it changes — files are small
 * (~1 MB) and `msg_id` is the primary key, so re-parsing is idempotent.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listSessionFiles, projectsRoot, type SessionFile } from './paths.ts';
import { parseSessionFile } from './parse.ts';
import { rawOf, usdOf, weightedOf } from './pricing.ts';

export type Metric = 'usd' | 'weighted' | 'raw';

export const METRIC_COLUMN: Record<Metric, string> = {
  usd: 'usd',
  weighted: 'weighted',
  raw: 'raw',
};

export function defaultDbPath(): string {
  return (
    process.env.BURNLENS_DB ??
    path.join(os.homedir(), '.claude', 'burnlens', 'index.db')
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  mtime      REAL NOT NULL,
  size       INTEGER NOT NULL,
  rows       INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS msgs (
  msg_id       TEXT PRIMARY KEY,
  ts           INTEGER NOT NULL,
  day          TEXT NOT NULL,
  project      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent        TEXT NOT NULL,
  agent_id     TEXT,
  kind         TEXT NOT NULL,
  workflow_id  TEXT,
  model        TEXT,
  effort       TEXT,
  session_kind TEXT,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_w5m    INTEGER NOT NULL,
  cache_w1h    INTEGER NOT NULL,
  usd          REAL NOT NULL,
  weighted     REAL NOT NULL,
  raw          INTEGER NOT NULL,
  file         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS msgs_ts       ON msgs(ts);
CREATE INDEX IF NOT EXISTS msgs_session  ON msgs(session_id, ts);
CREATE INDEX IF NOT EXISTS msgs_project  ON msgs(project, ts);
CREATE INDEX IF NOT EXISTS msgs_agent    ON msgs(agent, ts);
CREATE INDEX IF NOT EXISTS msgs_file     ON msgs(file);
CREATE INDEX IF NOT EXISTS msgs_workflow ON msgs(workflow_id);

-- One row per tool call, with the size of what it brought back. This is the
-- table the "what fills the context" census reads: the counters know a turn
-- cost 40k tokens, only this knows 32k of them were one Read.
CREATE TABLE IF NOT EXISTS tools (
  id           INTEGER PRIMARY KEY,
  file         TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  day          TEXT NOT NULL,
  project      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent        TEXT NOT NULL,
  agent_id     TEXT,
  kind         TEXT NOT NULL,
  model        TEXT,
  workflow_id  TEXT,
  turn         INTEGER NOT NULL,
  turns_total  INTEGER NOT NULL,
  tool         TEXT NOT NULL,
  target       TEXT,
  input_chars  INTEGER NOT NULL,
  input_hash   TEXT,
  result_chars INTEGER NOT NULL,
  is_error     INTEGER NOT NULL,
  -- Head of the error text, and only on is_error = 1: "Read failed" is not a
  -- diagnosis, "file does not exist" is. Empty on every successful call.
  error_text   TEXT
);

CREATE INDEX IF NOT EXISTS tools_ts      ON tools(ts);
CREATE INDEX IF NOT EXISTS tools_file    ON tools(file);
CREATE INDEX IF NOT EXISTS tools_session ON tools(session_id, ts);
CREATE INDEX IF NOT EXISTS tools_run     ON tools(agent_id);
CREATE INDEX IF NOT EXISTS tools_tool    ON tools(tool);
CREATE INDEX IF NOT EXISTS tools_hash    ON tools(input_hash);

-- Things that happened TO a run: compactions, rate limits, interrupts, cut-off
-- answers. 'num1..3' are typed by 'type' — see 'EventRow' in parse.ts.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  file       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  project    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent      TEXT NOT NULL,
  agent_id   TEXT,
  kind       TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  num1       INTEGER NOT NULL,
  num2       INTEGER NOT NULL,
  num3       INTEGER NOT NULL,
  text       TEXT
);

CREATE INDEX IF NOT EXISTS events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS events_file ON events(file);
CREATE INDEX IF NOT EXISTS events_type ON events(type, ts);

-- Key/value for anything about the index itself. 'facts_version' is the one
-- that matters: a bump means the extraction changed and every file has to be
-- re-read, which 'indexAll' then does without being asked.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  cwd          TEXT,
  git_branch   TEXT,
  version      TEXT,
  slug         TEXT,
  title        TEXT,
  first_prompt TEXT,
  first_ts     INTEGER,
  last_ts      INTEGER
);
`;

export function openDb(dbPath = defaultDbPath()): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
  // table, so a column added to SCHEMA never reaches an index built by an older
  // build. ALTER is the only way in, and it has no IF NOT EXISTS — hence the
  // table_info probe, which makes the step idempotent.
  const toolCols = new Set(
    (db.prepare('PRAGMA table_info(tools)').all() as any[]).map((c) => String(c.name))
  );
  if (!toolCols.has('error_text')) db.exec('ALTER TABLE tools ADD COLUMN error_text TEXT');
  return db;
}

/** Local-time day key — spend questions are asked in the user's own days. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface IndexProgress {
  scanned: number;
  changed: number;
  total: number;
  file: string;
}

export interface IndexResult {
  filesSeen: number;
  filesChanged: number;
  messages: number;
  pruned: number;
  elapsedMs: number;
}

/**
 * Bumped whenever `parse.ts` extracts something new or differently. An index
 * built by an older version is not wrong, it is INCOMPLETE — so the next run
 * re-reads every file instead of quietly serving half-empty diagnostics.
 *
 *   1 — counters only
 *   2 — output merged across a message's lines (was under-counted 2.35x),
 *       plus the `tools` and `events` fact tables
 *   3 — a subagent run's rows all carry its real agent name, and the walker
 *       stopped indexing a resumed session's duplicate copy of itself
 *   4 — a failed tool call carries the first 400 chars of its error text
 */
export const FACTS_VERSION = 4;

export function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any;
  return row ? String(row.value) : null;
}

export function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export async function indexAll(
  db: DatabaseSync,
  opts: { root?: string; force?: boolean; onProgress?: (p: IndexProgress) => void } = {}
): Promise<IndexResult> {
  const started = Date.now();
  const root = opts.root ?? projectsRoot();
  const files = listSessionFiles(root);

  const stale = Number(metaGet(db, 'facts_version') ?? 0) < FACTS_VERSION;
  const force = opts.force || stale;

  const known = new Map<string, { mtime: number; size: number }>();
  for (const r of db.prepare('SELECT path, mtime, size FROM files').all() as any[]) {
    known.set(r.path as string, { mtime: r.mtime as number, size: r.size as number });
  }

  const insertMsg = db.prepare(`
    INSERT INTO msgs (msg_id, ts, day, project, session_id, agent, agent_id, kind, workflow_id,
                      model, effort, session_kind, input, output, cache_read, cache_w5m, cache_w1h,
                      usd, weighted, raw, file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(msg_id) DO UPDATE SET
      -- The same message can appear in two files (a resumed session keeps a
      -- copy of its tree). Whoever wrote last owns the row, because the prune
      -- pass deletes by path: a row still pointing at a file that is no longer
      -- walked would be deleted even though the message is very much alive.
      file       = excluded.file,
      output     = max(msgs.output, excluded.output),
      cache_read = max(msgs.cache_read, excluded.cache_read),
      cache_w5m  = max(msgs.cache_w5m, excluded.cache_w5m),
      cache_w1h  = max(msgs.cache_w1h, excluded.cache_w1h),
      usd        = max(msgs.usd, excluded.usd),
      weighted   = max(msgs.weighted, excluded.weighted),
      raw        = max(msgs.raw, excluded.raw)
  `);
  const upsertFile = db.prepare(`
    INSERT INTO files (path, mtime, size, rows, indexed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size,
      rows=excluded.rows, indexed_at=excluded.indexed_at
  `);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, project, cwd, git_branch, version, slug, title,
                          first_prompt, first_ts, last_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd          = coalesce(excluded.cwd, sessions.cwd),
      git_branch   = coalesce(excluded.git_branch, sessions.git_branch),
      version      = coalesce(excluded.version, sessions.version),
      slug         = coalesce(excluded.slug, sessions.slug),
      title        = coalesce(excluded.title, sessions.title),
      first_prompt = coalesce(sessions.first_prompt, excluded.first_prompt),
      first_ts     = min(coalesce(excluded.first_ts, sessions.first_ts),
                         coalesce(sessions.first_ts, excluded.first_ts)),
      last_ts      = max(coalesce(excluded.last_ts, sessions.last_ts),
                         coalesce(sessions.last_ts, excluded.last_ts))
  `);

  const insertTool = db.prepare(`
    INSERT INTO tools (file, ts, day, project, session_id, agent, agent_id, kind, model, workflow_id,
                       turn, turns_total, tool, target, input_chars, input_hash, result_chars, is_error,
                       error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (file, ts, day, project, session_id, agent, agent_id, kind, turn,
                        type, num1, num2, num3, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Facts are re-derived wholesale per file, so the old ones have to go first:
  // unlike `msgs` they have no natural primary key to collide on.
  const clearTools = db.prepare('DELETE FROM tools WHERE file = ?');
  const clearEvents = db.prepare('DELETE FROM events WHERE file = ?');

  let changed = 0;
  let messages = 0;
  let scanned = 0;

  for (const f of files) {
    scanned++;
    const prev = known.get(f.file);
    const unchanged = prev && prev.mtime === f.mtimeMs && prev.size === f.size;
    opts.onProgress?.({ scanned, changed, total: files.length, file: f.file });
    if (unchanged && !force) continue;
    changed++;

    const { rows, tools, events, turns, meta } = await parseSessionFile(f.file, f.sessionId, f.kind);
    // A run's model is not on the tool call itself; it is whatever the run was
    // using, and the first billed message of the file says so.
    const model = rows.length ? rows[0].model : null;

    db.exec('BEGIN');
    try {
      clearTools.run(f.file);
      clearEvents.run(f.file);
      for (const t of tools) {
        insertTool.run(
          f.file, t.ts, dayKey(t.ts), f.project, f.sessionId, t.agent, t.agentId, f.kind, model,
          f.workflowId, t.turn, turns, t.tool, t.target, t.inputChars, t.inputHash,
          t.resultChars, t.isError, t.errorText
        );
      }
      for (const e of events) {
        insertEvent.run(
          f.file, e.ts, dayKey(e.ts), f.project, f.sessionId, e.agent, e.agentId, f.kind,
          e.turn, e.type, e.num1, e.num2, e.num3, e.text
        );
      }
      for (const r of rows) {
        insertMsg.run(
          r.msgId,
          r.ts,
          dayKey(r.ts),
          f.project,
          r.sessionId,
          r.agent,
          r.agentId,
          r.kind,
          f.workflowId,
          r.model,
          r.effort,
          r.sessionKind,
          r.counters.input,
          r.counters.output,
          r.counters.cacheRead,
          r.counters.cacheWrite5m,
          r.counters.cacheWrite1h,
          usdOf(r.counters, r.model),
          weightedOf(r.counters, r.model),
          rawOf(r.counters),
          f.file
        );
      }
      upsertSession.run(
        meta.sessionId,
        f.project,
        meta.cwd,
        meta.gitBranch,
        meta.version,
        meta.slug,
        meta.title,
        meta.firstPrompt,
        meta.firstTs,
        meta.lastTs
      );
      upsertFile.run(f.file, f.mtimeMs, f.size, rows.length, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    messages += rows.length;
  }

  // Files deleted from disk take their messages with them.
  const onDisk = new Set(files.map((f) => f.file));
  let pruned = 0;
  for (const p of known.keys()) {
    if (onDisk.has(p)) continue;
    db.prepare('DELETE FROM msgs WHERE file = ?').run(p);
    db.prepare('DELETE FROM tools WHERE file = ?').run(p);
    db.prepare('DELETE FROM events WHERE file = ?').run(p);
    db.prepare('DELETE FROM files WHERE path = ?').run(p);
    pruned++;
  }

  metaSet(db, 'facts_version', String(FACTS_VERSION));

  return {
    filesSeen: files.length,
    filesChanged: changed,
    messages,
    pruned,
    elapsedMs: Date.now() - started,
  };
}

export function fileList(root?: string): SessionFile[] {
  return listSessionFiles(root ?? projectsRoot());
}
