/**
 * Aggregation layer. Every question the UI asks is a GROUP BY over `msgs`,
 * with the metric column swapped in — the three metrics are precomputed at
 * index time so switching between dollars, limit-units and raw tokens is free.
 */

import type { DatabaseSync } from 'node:sqlite';

import { METRIC_COLUMN, type Metric } from './db.ts';
import { decodeProjectName, shortProjectName } from './paths.ts';

export type Dimension =
  | 'project'
  | 'agent'
  | 'model'
  | 'kind'
  | 'day'
  | 'session'
  | 'effort'
  | 'session_kind'
  | 'workflow';

const DIMENSION_SQL: Record<Dimension, string> = {
  project: 'm.project',
  agent: 'm.agent',
  model: "coalesce(m.model, '(unknown)')",
  kind: 'm.kind',
  day: 'm.day',
  session: 'm.session_id',
  effort: "coalesce(m.effort, '(default)')",
  session_kind: "coalesce(m.session_kind, '(fg)')",
  workflow: "coalesce(m.workflow_id, '(no workflow)')",
};

export interface Filters {
  from?: number;
  to?: number;
  project?: string;
  agent?: string;
  model?: string;
  kind?: string;
  sessionId?: string;
}

export interface WhereParts {
  sql: string;
  params: (string | number)[];
}

export function buildWhere(f: Filters): WhereParts {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (f.from != null) {
    clauses.push('m.ts >= ?');
    params.push(f.from);
  }
  if (f.to != null) {
    clauses.push('m.ts < ?');
    params.push(f.to);
  }
  for (const [col, val] of [
    ['m.project', f.project],
    ['m.agent', f.agent],
    ['m.model', f.model],
    ['m.kind', f.kind],
    ['m.session_id', f.sessionId],
  ] as const) {
    if (val != null && val !== '') {
      clauses.push(`${col} = ?`);
      params.push(val);
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export interface Bucket {
  key: string;
  label: string;
  value: number;
  usd: number;
  weighted: number;
  raw: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  messages: number;
  sessions: number;
  /** First/last activity WITHIN the filtered window, not over all time. */
  firstTs: number | null;
  lastTs: number | null;
}

const AGG_COLUMNS = `
  sum(m.usd)                        AS usd,
  sum(m.weighted)                   AS weighted,
  sum(m.raw)                        AS raw,
  sum(m.input)                      AS input,
  sum(m.output)                     AS output,
  sum(m.cache_read)                 AS cache_read,
  sum(m.cache_w5m + m.cache_w1h)    AS cache_write,
  count(*)                          AS messages,
  count(DISTINCT m.session_id)      AS sessions,
  min(m.ts)                         AS first_ts,
  max(m.ts)                         AS last_ts
`;

function toBucket(r: any, key: string, label: string, metric: Metric): Bucket {
  return {
    key,
    label,
    value: Number(r[METRIC_COLUMN[metric]] ?? 0),
    usd: Number(r.usd ?? 0),
    weighted: Number(r.weighted ?? 0),
    raw: Number(r.raw ?? 0),
    input: Number(r.input ?? 0),
    output: Number(r.output ?? 0),
    cacheRead: Number(r.cache_read ?? 0),
    cacheWrite: Number(r.cache_write ?? 0),
    messages: Number(r.messages ?? 0),
    sessions: Number(r.sessions ?? 0),
    firstTs: r.first_ts != null ? Number(r.first_ts) : null,
    lastTs: r.last_ts != null ? Number(r.last_ts) : null,
  };
}

/** Group spend by one dimension, biggest first. */
export function breakdown(
  db: DatabaseSync,
  dim: Dimension,
  filters: Filters,
  metric: Metric,
  limit = 100
): Bucket[] {
  const where = buildWhere(filters);
  const expr = DIMENSION_SQL[dim];
  const orderCol = dim === 'day' ? 'k' : METRIC_COLUMN[metric];
  const dir = dim === 'day' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `SELECT ${expr} AS k, ${AGG_COLUMNS}
       FROM msgs m ${where.sql}
       GROUP BY k ORDER BY ${orderCol} ${dir} LIMIT ?`
    )
    .all(...where.params, limit) as any[];

  if (dim === 'session') return rows.map((r) => toBucket(r, String(r.k), sessionLabel(db, String(r.k)), metric));
  if (dim === 'project') {
    const labels = projectLabels(db);
    return rows.map((r) => toBucket(r, String(r.k), labels.get(String(r.k)) ?? String(r.k), metric));
  }
  return rows.map((r) => toBucket(r, String(r.k), String(r.k), metric));
}

/**
 * Readable project names.
 *
 * The directory name is the cwd with `/` replaced by `-`, which cannot be
 * inverted: "-Users-me-data-second-head" decodes to ".../second/head", so a
 * project called `second-head` renders as "head". The real cwd is recorded
 * inside the session files, so we prefer that and only fall back to the lossy
 * decode when a project has no session carrying one.
 */
function projectLabels(db: DatabaseSync): Map<string, string> {
  const cwds = new Map<string, string>();
  for (const r of db
    .prepare('SELECT project, cwd FROM sessions WHERE cwd IS NOT NULL GROUP BY project')
    .all() as any[]) {
    cwds.set(String(r.project), String(r.cwd));
  }

  const map = new Map<string, string>();
  const taken = new Map<string, number>();
  for (const r of db.prepare('SELECT DISTINCT project FROM msgs').all() as any[]) {
    const p = String(r.project);
    const full = cwds.get(p) ?? decodeProjectName(p);
    let label = shortProjectName(full);
    // Sandboxed workspaces all end in the same segment (".../<uuid>/_default"),
    // so a bare basename collides. Widen to the parent segment until unique.
    const parts = full.split('/').filter(Boolean);
    for (let extra = 2; taken.has(label) && extra <= parts.length; extra++) {
      label = parts.slice(-extra).join('/');
    }
    taken.set(label, (taken.get(label) ?? 0) + 1);
    map.set(p, label);
  }
  return map;
}

export type Bucket_ = 'day' | 'hour';

export interface SeriesCell {
  bucket: string;
  key: string;
  label: string;
  value: number;
}

/**
 * Time x dimension matrix for the stacked bar chart: how the mix of spend
 * shifts over time, not just the height of each bar.
 *
 * Granularity follows the selected window — a single day zoomed to hours,
 * where a run of heavy hours is the thing worth seeing.
 */
export function series(
  db: DatabaseSync,
  dim: Dimension,
  filters: Filters,
  metric: Metric,
  topN = 8,
  bucket: Bucket_ = 'day'
): { buckets: string[]; keys: string[]; cells: SeriesCell[]; bucketSize: Bucket_ } {
  const tops = breakdown(db, dim, filters, metric, topN);
  const top = tops.map((b) => b.key);
  const labels = new Map(tops.map((b) => [b.key, b.label]));
  const where = buildWhere(filters);
  const expr = DIMENSION_SQL[dim];
  // `day` is precomputed at index time in local time; the hour bucket has to
  // match that convention, hence the explicit 'localtime' modifier.
  const bucketExpr =
    bucket === 'hour' ? "strftime('%Y-%m-%d %H:00', m.ts/1000, 'unixepoch', 'localtime')" : 'm.day';

  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS b, ${expr} AS k, sum(${METRIC_COLUMN[metric]}) AS v
       FROM msgs m ${where.sql} GROUP BY b, k ORDER BY b ASC`
    )
    .all(...where.params) as any[];

  const bucketSet = new Set<string>();
  const cells: SeriesCell[] = [];
  for (const r of rows) {
    const b = String(r.b);
    bucketSet.add(b);
    // Everything outside the top N collapses into one slice so the bars stay
    // readable without hiding spend.
    const key = top.includes(String(r.k)) ? String(r.k) : '(other)';
    cells.push({ bucket: b, key, label: labels.get(key) ?? key, value: Number(r.v ?? 0) });
  }
  return {
    buckets: [...bucketSet].sort(),
    keys: [...top, '(other)'],
    cells,
    bucketSize: bucket,
  };
}

/** Days that actually carry spend, for the day picker's bounds. */
export function activeDays(db: DatabaseSync): { min: string | null; max: string | null } {
  const r = db.prepare('SELECT min(day) AS a, max(day) AS b FROM msgs WHERE raw > 0').get() as any;
  return { min: r?.a ?? null, max: r?.b ?? null };
}

/** Grand totals for the current filter window. */
export function totals(db: DatabaseSync, filters: Filters, metric: Metric): Bucket {
  const where = buildWhere(filters);
  const r = db
    .prepare(`SELECT ${AGG_COLUMNS} FROM msgs m ${where.sql}`)
    .get(...where.params) as any;
  return toBucket(r ?? {}, 'total', 'total', metric);
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  projectLabel: string;
  title: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

function sessionLabel(db: DatabaseSync, sessionId: string): string {
  const r = db
    .prepare('SELECT title, first_prompt FROM sessions WHERE session_id = ?')
    .get(sessionId) as any;
  const t = r?.title ?? r?.first_prompt;
  if (typeof t === 'string' && t.trim()) return t.trim().replaceAll('\n', ' ').slice(0, 90);
  return sessionId.slice(0, 8);
}

export function sessionInfo(db: DatabaseSync, sessionId: string): SessionInfo | null {
  const r = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as any;
  if (!r) return null;
  return {
    sessionId,
    project: r.project,
    projectLabel: shortProjectName(r.cwd ?? decodeProjectName(r.project)),
    title: r.title ?? null,
    firstPrompt: r.first_prompt ?? null,
    cwd: r.cwd ?? null,
    gitBranch: r.git_branch ?? null,
    firstTs: r.first_ts ?? null,
    lastTs: r.last_ts ?? null,
  };
}

export interface TimelinePoint {
  ts: number;
  agent: string;
  /** The dispatch this message belongs to — lets a click on the chart drill in. */
  runId: string;
  kind: string;
  model: string | null;
  value: number;
  usd: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cumulative: number;
}

/**
 * Per-message timeline for one session, main thread and every subagent
 * interleaved on one clock — this is the view that answers "at what point did
 * this session start burning".
 */
export function sessionTimeline(
  db: DatabaseSync,
  sessionId: string,
  metric: Metric
): TimelinePoint[] {
  const col = METRIC_COLUMN[metric];
  const rows = db
    .prepare(
      `SELECT ts, agent, coalesce(agent_id, 'main') AS run_id, kind, model,
              usd, output, cache_read,
              (cache_w5m + cache_w1h) AS cache_write, ${col} AS value
       FROM msgs WHERE session_id = ? ORDER BY ts ASC`
    )
    .all(sessionId) as any[];

  let acc = 0;
  return rows.map((r) => {
    acc += Number(r.value ?? 0);
    return {
      ts: Number(r.ts),
      agent: String(r.agent),
      runId: String(r.run_id),
      kind: String(r.kind),
      model: r.model ?? null,
      value: Number(r.value ?? 0),
      usd: Number(r.usd ?? 0),
      output: Number(r.output ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      cacheWrite: Number(r.cache_write ?? 0),
      cumulative: acc,
    };
  });
}

export interface RunRow {
  /** `agent_id` for a subagent; the literal 'main' for the main thread. */
  runId: string;
  agent: string;
  sessionId: string;
  workflowId: string | null;
  models: string;
  effort: string | null;
  firstTs: number;
  lastTs: number;
  durationMs: number;
  messages: number;
  value: number;
  usd: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Largest single-turn context in the run — how heavy it got at its peak. */
  peakContext: number;
}

/**
 * Every dispatch of one agent inside one session, newest-costliest first.
 *
 * A run is one `agent_id` (one file on disk); the main thread has no agent_id
 * and is therefore a single run named 'main'.
 */
const RUN_COLUMNS = (metric: Metric) =>
  `coalesce(m.agent_id, 'main')        AS run_id,
   m.agent                             AS agent,
   m.workflow_id                       AS workflow_id,
   group_concat(DISTINCT m.model)      AS models,
   max(m.effort)                       AS effort,
   min(m.ts)                           AS first_ts,
   max(m.ts)                           AS last_ts,
   count(*)                            AS messages,
   sum(${METRIC_COLUMN[metric]})       AS value,
   sum(m.usd)                          AS usd,
   sum(m.output)                       AS output,
   sum(m.cache_read)                   AS cache_read,
   sum(m.cache_w5m + m.cache_w1h)      AS cache_write,
   max(m.input + m.cache_read + m.cache_w5m + m.cache_w1h) AS peak_context`;

const toRunRow = (r: any, sessionId: string): RunRow => ({
  runId: String(r.run_id),
  agent: String(r.agent),
  sessionId,
  workflowId: r.workflow_id ?? null,
  models: String(r.models ?? ''),
  effort: r.effort ?? null,
  firstTs: Number(r.first_ts),
  lastTs: Number(r.last_ts),
  durationMs: Number(r.last_ts) - Number(r.first_ts),
  messages: Number(r.messages ?? 0),
  value: Number(r.value ?? 0),
  usd: Number(r.usd ?? 0),
  output: Number(r.output ?? 0),
  cacheRead: Number(r.cache_read ?? 0),
  cacheWrite: Number(r.cache_write ?? 0),
  peakContext: Number(r.peak_context ?? 0),
});

/**
 * Every run of a session, whatever agent produced it — the flat list a shared
 * session digest needs, where the dashboard drills agent by agent instead.
 */
export function sessionRuns(db: DatabaseSync, sessionId: string, metric: Metric): RunRow[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS(metric)}
       FROM msgs m
       WHERE m.session_id = ?
       GROUP BY run_id
       ORDER BY value DESC`
    )
    .all(sessionId) as any[];
  return rows.map((r) => toRunRow(r, sessionId));
}

export function agentRuns(
  db: DatabaseSync,
  sessionId: string,
  agent: string,
  metric: Metric
): RunRow[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS(metric)}
       FROM msgs m
       WHERE m.session_id = ? AND m.agent = ?
       GROUP BY run_id
       ORDER BY value DESC`
    )
    .all(sessionId, agent) as any[];

  return rows.map((r) => ({ ...toRunRow(r, sessionId), agent }));
}

/** Source files backing one run — the history reader needs these. */
export function runFiles(db: DatabaseSync, sessionId: string, runId: string): string[] {
  const rows = db
    .prepare(
      runId === 'main'
        ? 'SELECT DISTINCT file FROM msgs WHERE session_id = ? AND agent_id IS NULL'
        : 'SELECT DISTINCT file FROM msgs WHERE session_id = ? AND agent_id = ?'
    )
    .all(...(runId === 'main' ? [sessionId] : [sessionId, runId])) as any[];
  return rows.map((r) => String(r.file));
}

export interface CohortRunRef {
  runId: string;
  files: string[];
  value: number;
}

/**
 * The runs that make up a cohort, with the files each one lives in.
 *
 * A cohort is every dispatch of one agent inside one session — optionally
 * narrowed to a single workflow run, which is the honest scope when a session
 * launched the same workflow twice: two waves of `test-writer` over different
 * work share nothing, and pooling them would invent duplication that the runs
 * never had the chance to share.
 */
export function cohortRuns(
  db: DatabaseSync,
  sessionId: string,
  agent: string,
  metric: Metric,
  workflowId?: string | null
): CohortRunRef[] {
  const rows = db
    .prepare(
      `SELECT coalesce(agent_id, 'main')      AS run_id,
              group_concat(DISTINCT file)     AS files,
              sum(${METRIC_COLUMN[metric]})   AS value,
              min(ts)                         AS first_ts
       FROM msgs
       WHERE session_id = ? AND agent = ?${workflowId ? ' AND workflow_id = ?' : ''}
       GROUP BY run_id
       ORDER BY first_ts`
    )
    .all(...(workflowId ? [sessionId, agent, workflowId] : [sessionId, agent])) as any[];

  return rows.map((r) => ({
    runId: String(r.run_id),
    // `group_concat` joins on a comma, and no session path contains one.
    files: String(r.files ?? '').split(',').filter(Boolean),
    value: Number(r.value ?? 0),
  }));
}

export function runSummary(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
  metric: Metric
): RunRow | null {
  const agent = db
    .prepare(
      runId === 'main'
        ? "SELECT agent FROM msgs WHERE session_id = ? AND agent_id IS NULL LIMIT 1"
        : 'SELECT agent FROM msgs WHERE session_id = ? AND agent_id = ? LIMIT 1'
    )
    .get(...(runId === 'main' ? [sessionId] : [sessionId, runId])) as any;
  if (!agent) return null;
  return agentRuns(db, sessionId, String(agent.agent), metric).find((r) => r.runId === runId) ?? null;
}

/** Window of data actually present in the index. */
export function indexSpan(db: DatabaseSync): { minTs: number | null; maxTs: number | null; messages: number } {
  const r = db.prepare('SELECT min(ts) AS a, max(ts) AS b, count(*) AS n FROM msgs').get() as any;
  return { minTs: r?.a ?? null, maxTs: r?.b ?? null, messages: Number(r?.n ?? 0) };
}
