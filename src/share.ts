/**
 * Sharing a finding with an agent.
 *
 * The dashboard is where a human notices something — a fan-out that collected
 * the same doc thirty times, a run whose context is half duplicate plans, a day
 * that cost four times its neighbours. Telling an agent about it used to mean
 * retyping the numbers, which is both lossy and unverifiable.
 *
 * So every finding gets an address. A share ref names WHAT was found, not the
 * bytes of it: `bl://cohort?session=…&agent=test-writer` is the report, not a
 * snapshot of the report, and it is recomputed from the index on each read —
 * the agent that opens it tomorrow sees today's index, not a stale paste.
 *
 * One ref, two ways in, because the agent is not always where the server is:
 *
 *   http://127.0.0.1:4317/s/cohort?…   the server renders it (WebFetch, curl)
 *   burnlens show 'bl://cohort?…'   the CLI renders the same thing from
 *                                          the index, with no server running
 *
 * Both go through `resolveShare` + `renderMarkdown` here, so the two channels
 * cannot drift. Markdown is the default output because that is what survives a
 * context window; `?format=json` returns the same payload the dashboard's own
 * fetch gets, for anything that wants to compute rather than read.
 */

import type { DatabaseSync } from 'node:sqlite';

import { cacheReport, type CacheReport } from './cache.ts';
import { cohortReport, type CohortReport } from './cohort.ts';
import { contextReport, type ContextReport } from './context.ts';
import type { Metric } from './db.ts';
import { baselineRuns, diagReport, type DiagReport } from './diag.ts';
import { healthReport, type HealthReport } from './health.ts';
import { fmt, t } from './i18n.ts';
import { getProbe, listProbes, type ProbeDef } from './probeconfig.ts';
import { probeReport, type ProbeReport } from './probes.ts';
import { runHistory, type RunStep } from './runs.ts';
import {
  activeDays,
  agentRuns,
  breakdown,
  cohortRuns,
  indexSpan,
  runFiles,
  runSummary,
  sessionInfo,
  sessionRuns,
  sessionTimeline,
  totals,
  type Bucket,
  type Dimension,
  type Filters,
  type RunRow,
  type SessionInfo,
  type TimelinePoint,
} from './queries.ts';

export type ShareKind =
  | 'overview'
  | 'cache'
  | 'diag'
  | 'probe'
  | 'session'
  | 'agent'
  | 'run'
  | 'context'
  | 'cohort';

interface KindSpec {
  /** Params that identify the finding; a missing one is a 400, not a default. */
  required: string[];
  /** Everything else that survives into the ref, in a stable order. */
  optional: string[];
  title: string;
  /** One line telling an agent what it is looking at. */
  about: string;
}

const FILTER_PARAMS = ['from', 'to', 'project', 'agent', 'model', 'kind'];

export const SHARE_KINDS: Record<ShareKind, KindSpec> = {
  overview: {
    required: [],
    optional: [...FILTER_PARAMS, 'metric', 'top', 'source'],
    title: t('view.spend'),
    about: t('share.kind.overview.about'),
  },
  cache: {
    required: [],
    // `session` narrows the whole report to one session — what the session
    // drawer's cache tab hands over, the same way `diag` narrows below.
    optional: [...FILTER_PARAMS, 'session', 'metric', 'top', 'source'],
    title: t('view.cache'),
    about: t('share.kind.cache.about'),
  },
  diag: {
    required: [],
    // `session` narrows the whole report to one session — what the session
    // drawer's diagnostics tab hands over. The outlier medians then come from
    // the corpus rather than from the session, exactly as `/api/diag` does it.
    optional: [...FILTER_PARAMS, 'session', 'metric', 'top', 'source'],
    title: t('view.diag'),
    about: t('share.kind.diag.about'),
  },
  probe: {
    required: ['probe'],
    // A rule fires inside one session far more often than across the corpus,
    // so `session` narrows a probe the same way it narrows the diagnostics.
    optional: [...FILTER_PARAMS, 'session', 'metric', 'top', 'source'],
    title: t('share.kind.probe.title'),
    about: t('share.kind.probe.about'),
  },
  session: {
    required: ['session'],
    optional: ['metric', 'top', 'full', 'source'],
    title: t('share.kind.session.title'),
    about: t('share.kind.session.about'),
  },
  agent: {
    required: ['session', 'agent'],
    optional: ['metric', 'top', 'source'],
    title: t('share.kind.agent.title'),
    about: t('share.kind.agent.about'),
  },
  run: {
    required: ['session', 'run'],
    optional: ['metric', 'limit', 'source'],
    title: t('share.kind.run.title'),
    about: t('share.kind.run.about'),
  },
  context: {
    required: ['session', 'run'],
    optional: ['turn', 'top', 'source'],
    title: t('share.kind.context.title'),
    about: t('share.kind.context.about'),
  },
  cohort: {
    required: ['session', 'agent'],
    optional: ['workflow', 'metric', 'top', 'source'],
    title: t('share.kind.cohort.title'),
    about: t('share.kind.cohort.about'),
  },
};

export class ShareError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ShareRef {
  kind: ShareKind;
  params: Record<string, string>;
}

const isKind = (s: string): s is ShareKind => Object.hasOwn(SHARE_KINDS, s);

/**
 * Accepts every shape the ref travels in: the `bl://` form that goes into a
 * chat, the URL the browser copies, and the bare `/s/<kind>?…` path the server
 * sees. Unknown params are dropped rather than passed through — a ref is
 * canonical, so two links to one finding are the same string.
 */
export function parseRef(input: string): ShareRef {
  let s = String(input ?? '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!s) throw new ShareError(t('share.error.emptyRef'));

  let query = '';
  const qi = s.indexOf('?');
  if (qi > -1) {
    query = s.slice(qi + 1);
    s = s.slice(0, qi);
  }
  // `bl://kind`, `bl:kind` and `http://host/s/kind` all reduce to their last
  // path segment; the scheme carries no information beyond "this is a ref".
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[a-z][a-z0-9+.-]*:/i, '');
  const segs = s.split('/').filter(Boolean);
  const kind = (segs[segs.length - 1] ?? '').toLowerCase();
  if (!isKind(kind)) {
    throw new ShareError(
      t('share.error.unknownKind', { kind: kind || '—', list: Object.keys(SHARE_KINDS).join(', ') }),
      404
    );
  }

  const spec = SHARE_KINDS[kind];
  const q = new URLSearchParams(query);
  const params: Record<string, string> = {};
  for (const key of [...spec.required, ...spec.optional]) {
    const v = q.get(key);
    if (v != null && v !== '') params[key] = v;
  }
  for (const key of spec.required) {
    if (!params[key]) throw new ShareError(t('share.error.missingParam', { kind, key }));
  }
  return { kind, params };
}

/** Canonical query string — stable param order, shell-safe quoting. */
function queryOf(kind: ShareKind, params: Record<string, string>): string {
  const spec = SHARE_KINDS[kind];
  const q = new URLSearchParams();
  for (const key of [...spec.required, ...spec.optional]) {
    const v = params[key];
    if (v != null && v !== '') q.set(key, String(v));
  }
  // A ref is pasted inside single quotes on a shell line; an apostrophe in an
  // agent name would end the quoting early.
  return q.toString().replaceAll("'", '%27');
}

/** The portable form — what goes into a chat message or a CLI argument. */
export function refString(kind: ShareKind, params: Record<string, string>): string {
  const q = queryOf(kind, params);
  return `bl://${kind}${q ? '?' + q : ''}`;
}

/** The fetchable form, given the origin the dashboard is served from. */
export function shareUrl(base: string, kind: ShareKind, params: Record<string, string>): string {
  const q = queryOf(kind, params);
  return `${base.replace(/\/+$/, '')}/s/${kind}${q ? '?' + q : ''}`;
}

// ── resolving ────────────────────────────────────────────────

export interface ShareSource {
  id: string;
  label: string;
  root: string;
}

export interface Resolved {
  kind: ShareKind;
  title: string;
  subtitle: string[];
  ref: string;
  params: Record<string, string>;
  source: ShareSource | null;
  generatedAt: number;
  metric: Metric;
  data: Record<string, unknown>;
}

const num = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const metricOf = (p: Record<string, string>): Metric =>
  p.metric === 'weighted' || p.metric === 'raw' ? p.metric : 'usd';

function filtersOf(p: Record<string, string>): Filters {
  return {
    from: num(p.from),
    to: num(p.to),
    project: p.project,
    agent: p.agent,
    model: p.model,
    kind: p.kind,
  };
}

const OVERVIEW_DIMS: Dimension[] = ['project', 'agent', 'model', 'kind', 'workflow', 'day'];

/**
 * Recomputes the finding the ref points at. Everything here is the same call
 * the dashboard's own endpoint makes — the share path adds addressing, never a
 * second implementation of a report.
 */
export async function resolveShare(
  db: DatabaseSync,
  ref: ShareRef,
  source: ShareSource | null = null
): Promise<Resolved> {
  const { kind, params } = ref;
  const metric = metricOf(params);
  const top = Math.max(1, Math.min(500, num(params.top) ?? 20));
  const base = {
    kind,
    ref: refString(kind, params),
    params,
    source,
    generatedAt: Date.now(),
    metric,
  };

  if (kind === 'overview' || kind === 'cache' || kind === 'diag' || kind === 'probe') {
    const filters = filtersOf(params);
    const subtitle = [periodLabel(params), filterLabel(params)].filter(Boolean) as string[];
    if (kind === 'probe') {
      // The rule is resolved before the query: a report for a probe that no
      // longer exists would be an empty table indistinguishable from a rule
      // that simply found nothing.
      const def = getProbe(params.probe);
      if (!def) {
        const ids = listProbes().map((x) => x.id).join(', ');
        throw new ShareError(t('share.error.probeMissing', { probe: params.probe, list: ids || '—' }), 404);
      }
      const report = probeReport(
        db,
        def.id,
        { ...filters, ...(params.session ? { sessionId: params.session } : {}) },
        metric
      );
      return {
        ...base,
        title: t('share.report.probeTitle', { label: def.label }),
        subtitle: [...subtitle, ...(params.session ? [params.session] : [])],
        data: { report, probe: def },
      };
    }
    if (kind === 'cache') {
      const f = { ...filters, ...(params.session ? { sessionId: params.session } : {}) };
      return {
        ...base,
        title: t('share.report.cacheTitle'),
        subtitle,
        data: { report: cacheReport(db, f) as CacheReport },
      };
    }
    if (kind === 'diag') {
      // Both halves of the diagnostics screen, exactly as `/api/diag` builds
      // them: the same filters and metric, so the two channels cannot drift.
      // That includes the session-scoped corpus baseline for the outliers.
      const f = { ...filters, ...(params.session ? { sessionId: params.session } : {}) };
      const baseline = f.sessionId ? baselineRuns(db, {}, metric) : undefined;
      return {
        ...base,
        title: t('share.report.diagTitle'),
        subtitle,
        data: {
          total: totals(db, f, metric),
          diag: diagReport(db, f, metric, baseline),
          health: healthReport(db, f, metric),
        },
      };
    }
    const data: Record<string, unknown> = {
      total: totals(db, filters, metric),
      span: indexSpan(db),
      activeDays: activeDays(db),
    };
    for (const d of OVERVIEW_DIMS) {
      data[d] = breakdown(db, d, filters, metric, d === 'day' ? 400 : top);
    }
    data.sessions = breakdown(db, 'session', filters, metric, top).map((b) => ({
      ...b,
      info: sessionInfo(db, b.key),
    }));
    return { ...base, title: t('view.spend'), subtitle, data };
  }

  if (kind === 'session') {
    const id = params.session;
    const info = sessionInfo(db, id);
    if (!info) throw new ShareError(t('share.error.sessionNotFound'), 404);
    const timeline = sessionTimeline(db, id, metric);
    const runs = sessionRuns(db, id, metric);
    const total = timeline.reduce((s, p) => s + p.value, 0);
    // A session's timeline is one row per message — thousands of them. The
    // digest keeps what a reader acts on (runs, agents, the costliest moments)
    // and hands over the raw series only when asked, since it is the one part
    // that cannot be summarised without deciding for the reader.
    const peaks = [...timeline].sort((a, b) => b.value - a.value).slice(0, top);
    return {
      ...base,
      title: info.title ?? (info.firstPrompt ?? id).slice(0, 90),
      subtitle: [info.projectLabel, info.cwd, info.gitBranch, id].filter(Boolean) as string[],
      data: {
        info,
        total,
        messages: timeline.length,
        agents: breakdown(db, 'agent', { sessionId: id }, metric, 100),
        models: breakdown(db, 'model', { sessionId: id }, metric, 20),
        runs,
        peaks,
        ...(params.full === '1' ? { timeline } : {}),
      },
    };
  }

  if (kind === 'agent') {
    const runs = agentRuns(db, params.session, params.agent, metric);
    if (!runs.length) throw new ShareError(t('share.err.noAgentInSession'), 404);
    const info = sessionInfo(db, params.session);
    return {
      ...base,
      title: t('share.title.agentRuns', {
        agent: params.agent,
        n: runs.length,
        unit: t('share.plural.runs', { n: runs.length }),
      }),
      subtitle: [info?.title ?? null, info?.projectLabel ?? null, params.session].filter(Boolean) as string[],
      data: { agent: params.agent, session: params.session, runs, info },
    };
  }

  if (kind === 'run') {
    const files = runFiles(db, params.session, params.run);
    if (!files.length) throw new ShareError(t('share.err.noSuchRun'), 404);
    const run = runSummary(db, params.session, params.run, metric);
    const steps = await runHistory(files, metric);
    const info = sessionInfo(db, params.session);
    return {
      ...base,
      title: t('share.title.run', { agent: run?.agent ?? t('share.title.runFallback'), id: params.run.slice(0, 8) }),
      subtitle: [info?.title ?? null, run?.models?.replaceAll('claude-', '') ?? null, params.session].filter(
        Boolean
      ) as string[],
      data: { run, steps, info },
    };
  }

  if (kind === 'context') {
    const files = runFiles(db, params.session, params.run);
    if (!files.length) throw new ShareError(t('share.err.noSuchRun'), 404);
    const turn = num(params.turn);
    const report = await contextReport(files, { turn: turn && turn > 0 ? turn : undefined });
    const run = runSummary(db, params.session, params.run, metric);
    return {
      ...base,
      title: t('share.title.context', { agent: run?.agent ?? '', id: params.run.slice(0, 8) }).trim(),
      subtitle: [t('share.title.contextTurns', { from: report.segment.fromTurn, to: report.segment.toTurn }), params.session],
      data: { report, run },
    };
  }

  // cohort
  const workflow = params.workflow ?? null;
  const runs = cohortRuns(db, params.session, params.agent, metric, workflow);
  if (runs.length < 2) throw new ShareError(t('share.err.needTwoRuns'));
  const report = await cohortReport(runs, {
    metric,
    agent: params.agent,
    workflowId: workflow,
    actualValue: runs.reduce((s, r) => s + r.value, 0),
    limit: top,
  });
  const info = sessionInfo(db, params.session);
  return {
    ...base,
    title: t('share.title.cohort', { agent: params.agent }),
    subtitle: [
      workflow ? 'workflow ' + workflow : t('share.title.wholeSession'),
      info?.title ?? null,
      params.session,
    ].filter(Boolean) as string[],
    data: { report, agent: params.agent, workflowId: workflow },
  };
}

// ── formatting ───────────────────────────────────────────────

/**
 * The formatters are total on purpose. They are called from ~200 sites across
 * every renderer, and a SQL aggregate over an empty slice legitimately answers
 * `null` — which reaches here as `undefined` and used to throw inside
 * `toFixed`, killing the process. Guarding each call site is 200 chances to
 * miss one; guarding the funnel is one. A number that isn't a number is 0
 * here, and a report that prints `$0.00` for an empty slice is right anyway.
 */
const finite = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const fmtTokens = (raw: number | null | undefined): string => {
  const v = finite(raw);
  return (
    v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k'
    : String(Math.round(v))
  );
};

const fmtUsd = (raw: number | null | undefined): string => {
  const v = finite(raw);
  return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
};

const fmtMetric = (v: number | null | undefined, metric: Metric): string =>
  metric === 'usd' ? fmtUsd(v) : fmtTokens(v);

const METRIC_NAME: Record<Metric, string> = {
  usd: t('share.metric.usd'),
  weighted: t('share.metric.weighted'),
  raw: t('share.metric.raw'),
};

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString(fmt.locale, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const fmtClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(fmt.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('share.duration.sec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('share.duration.minSec', { m, s: s % 60 });
  return t('share.duration.hourMin', { h: Math.floor(m / 60), m: m % 60 });
}

const pct = (part: number, whole: number): string => (whole ? ((100 * part) / whole).toFixed(1) + '%' : '—');

function periodLabel(p: Record<string, string>): string {
  const from = num(p.from);
  const to = num(p.to);
  if (!from && !to) return t('share.period.all');
  const d = (ts: number) => new Date(ts).toLocaleDateString(fmt.locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (from && to) return t('share.period.range', { from: d(from), to: d(to) });
  return from ? t('share.period.from', { from: d(from) }) : t('share.period.to', { to: d(to!) });
}

function filterLabel(p: Record<string, string>): string {
  const parts = ['project', 'agent', 'model', 'kind']
    .filter((k) => p[k])
    .map((k) => `${k}=${p[k]}`);
  return parts.length ? t('share.filters', { list: parts.join(', ') }) : '';
}

/** Markdown cells cannot carry a raw pipe or newline; nothing here needs them. */
const cell = (v: unknown): string =>
  String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();

function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return t('share.empty') + '\n';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n') + '\n';
}

const short = (s: string | null | undefined, n = 80): string => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n) + '…' : text;
};

// ── markdown ─────────────────────────────────────────────────

export interface RenderOptions {
  /** Origin the ref is reachable at, when there is a server; enables links. */
  baseUrl?: string;
  /** Rows per table before truncation, unless the ref overrides it. */
  top?: number;
}

/**
 * The digest an agent reads. Every number here is the number on the screen the
 * human was looking at — the renderer picks what to show, never recomputes.
 */
export function renderMarkdown(r: Resolved, opts: RenderOptions = {}): string {
  const p = r.params;
  const top = Math.max(1, Math.min(500, num(p.top) ?? opts.top ?? 20));
  const out: string[] = [];

  out.push(`# ${r.title}`);
  out.push('');
  out.push(`_${SHARE_KINDS[r.kind].about}_`);
  out.push('');
  const meta = [
    r.source ? t('share.meta.source', { label: r.source.label, root: r.source.root }) : null,
    t('share.meta.metric', { name: METRIC_NAME[r.metric] }),
    ...r.subtitle,
    t('share.meta.collected', { at: fmtTime(r.generatedAt) }),
  ].filter(Boolean);
  for (const line of meta) out.push(`- ${line}`);
  out.push('');

  const body =
    r.kind === 'overview' ? renderOverview(r, top)
    : r.kind === 'cache' ? renderCache(r, top)
    : r.kind === 'diag' ? renderDiag(r, top)
    : r.kind === 'probe' ? renderProbe(r, top)
    : r.kind === 'session' ? renderSession(r, top)
    : r.kind === 'agent' ? renderAgent(r, top)
    : r.kind === 'run' ? renderRun(r, p)
    : r.kind === 'context' ? renderContext(r, top)
    : renderCohort(r, top);
  out.push(body.trimEnd(), '');

  out.push(...renderFooter(r, opts));
  return out.join('\n');
}

function renderFooter(r: Resolved, opts: RenderOptions): string[] {
  const link = (kind: ShareKind, params: Record<string, string>) =>
    opts.baseUrl ? shareUrl(opts.baseUrl, kind, params) : refString(kind, params);

  const next: string[] = [];
  const p = r.params;
  const keep = { ...(p.source ? { source: p.source } : {}), ...(p.metric ? { metric: p.metric } : {}) };
  const data = r.data as any;

  if (r.kind === 'session') {
    const runs: RunRow[] = data.runs ?? [];
    for (const run of runs.slice(0, 5)) {
      next.push(t('share.next.runHistoryOf', {
        link: link('run', { ...keep, session: p.session, run: run.runId }),
        agent: run.agent,
      }));
    }
    const agents = new Set(runs.map((x) => x.agent));
    for (const a of [...agents].slice(0, 3)) {
      next.push(t('share.next.allRunsOf', { link: link('agent', { ...keep, session: p.session, agent: a }), agent: a }));
    }
  } else if (r.kind === 'agent') {
    const runs: RunRow[] = data.runs ?? [];
    if (runs.length >= 2) {
      next.push(
        t('share.next.collectedSeparately', { link: link('cohort', { ...keep, session: p.session, agent: p.agent }) })
      );
    }
    for (const run of runs.slice(0, 5)) {
      next.push(t('share.next.runHistoryOf', {
        link: link('run', { ...keep, session: p.session, run: run.runId }),
        agent: run.runId.slice(0, 8),
      }));
    }
  } else if (r.kind === 'run') {
    next.push(t('share.next.contextOf', { link: link('context', { ...keep, session: p.session, run: p.run }) }));
    if (data.run?.agent) {
      next.push(t('share.next.neighbourRuns', { link: link('agent', { ...keep, session: p.session, agent: data.run.agent }) }));
    }
    next.push(t('share.next.wholeSession', { link: link('session', { ...keep, session: p.session }) }));
  } else if (r.kind === 'context') {
    next.push(t('share.next.thisRunHistory', { link: link('run', { ...keep, session: p.session, run: p.run }) }));
  } else if (r.kind === 'cohort') {
    next.push(t('share.next.cohortRunList', { link: link('agent', { ...keep, session: p.session, agent: p.agent }) }));
  } else if (r.kind === 'diag') {
    // A diagnostic is only useful if the run behind it can be opened; the top
    // outliers are the rows a reader acts on first, so they get the links.
    const runs: any[] = (data.diag?.outliers?.runs ?? []).slice(0, 3);
    for (const x of runs) {
      next.push(
        t('share.next.outlierHistory', {
          link: link('run', { ...keep, session: x.sessionId, run: x.agentId }),
          agent: x.agent,
          ratio: x.ratio.toFixed(1),
        })
      );
    }
  } else if (r.kind === 'probe') {
    // A hit is a claim about one run; the run is where it gets checked.
    const samples: any[] = (data.report?.samples ?? []).filter((x: any) => x.agentId).slice(0, 3);
    for (const s of samples) {
      next.push(
        t('share.next.flaggedHistory', {
          link: link('run', { ...keep, session: s.sessionId, run: s.agentId }),
          agent: s.agent,
        })
      );
    }
    const filters = Object.fromEntries(
      ['from', 'to', 'project', 'agent', 'model', 'kind'].filter((k) => p[k]).map((k) => [k, p[k]])
    );
    next.push(t('share.next.wholeWindow', { link: link('diag', { ...keep, ...filters }) }));
  } else if (r.kind === 'overview') {
    const sessions: any[] = (data.sessions ?? []).slice(0, 5);
    for (const s of sessions) {
      next.push(t('share.next.session', { link: link('session', { ...keep, session: s.key }), label: short(s.label, 50) }));
    }
  }

  const out = ['---', ''];
  if (next.length) {
    out.push(t('share.next.heading'), '');
    for (const n of next) out.push(`- ${n}`);
    out.push('');
  }
  out.push(t('share.next.otherForms'), '');
  if (opts.baseUrl) {
    const url = shareUrl(opts.baseUrl, r.kind, r.params);
    out.push(t('share.next.fullJson', { url: `${url}${url.includes('?') ? '&' : '?'}format=json` }));
  }
  out.push(t('share.next.noServer', { ref: r.ref }));
  out.push('');
  return out;
}

function bucketTable(rows: Bucket[], metric: Metric, total: number, top: number, head = t('common.col.what')): string {
  return table(
    [head, metric === 'usd' ? '$' : t('share.col.tokens'), t('common.col.share'), t('common.col.messages')],
    rows.slice(0, top).map((b) => [b.label, fmtMetric(b.value, metric), pct(b.value, total), b.messages])
  );
}

function renderOverview(r: Resolved, top: number): string {
  const d = r.data as any;
  const tot: Bucket = d.total;
  const m = r.metric;
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  out.push(
    t('share.overview.totals', { value: fmtMetric(tot.value, m), messages: tot.messages, sessions: tot.sessions }) +
      (m !== 'usd' ? ` · ${fmtUsd(tot.usd)}` : '')
  );
  out.push('');
  out.push(
    t('share.overview.tokenLine', {
      output: fmtTokens(tot.output),
      cacheRead: fmtTokens(tot.cacheRead),
      cacheWrite: fmtTokens(tot.cacheWrite),
      input: fmtTokens(tot.input),
    })
  );
  out.push('');

  const NAMES: Partial<Record<Dimension, string>> = {
    project: t('share.group.project'),
    agent: t('share.group.agent'),
    model: t('share.group.model'),
    kind: t('share.group.kind'),
    workflow: t('share.group.workflow'),
    day: t('share.group.day'),
  };
  for (const dim of OVERVIEW_DIMS) {
    const rows: Bucket[] = d[dim] ?? [];
    if (!rows.length) continue;
    const limit = dim === 'day' ? Math.max(top, 45) : top;
    out.push(`## ${NAMES[dim] ?? dim}`, '');
    out.push(bucketTable(rows, m, tot.value, limit, dim));
    if (rows.length > limit) out.push(t('share.shownOf', { n: limit, total: rows.length }), '');
  }

  const sessions: any[] = d.sessions ?? [];
  if (sessions.length) {
    out.push(t('share.head.topSessions'), '');
    out.push(
      table(
        [t('common.col.session'), r.metric === 'usd' ? '$' : t('share.col.tokens'), t('common.col.share'), t('share.col.project'), t('share.col.startedAt'), 'id'],
        sessions.slice(0, top).map((s) => [
          short(s.info?.title ?? s.label, 60),
          fmtMetric(s.value, m),
          pct(s.value, tot.value),
          s.info?.projectLabel ?? '',
          s.info?.firstTs ? fmtTime(s.info.firstTs) : '',
          s.key,
        ])
      )
    );
  }
  return out.join('\n');
}

function renderCache(r: Resolved, top: number): string {
  const rep: CacheReport = (r.data as any).report;
  const tot = rep.totals;
  const c = rep.counterfactual;
  const asLimit = r.metric === 'weighted';
  const w = (o: { extraUsd: number; extraWeighted: number }) => (asLimit ? o.extraWeighted : o.extraUsd);
  const fmtW = (v: number) => (asLimit ? fmtTokens(v) : fmtUsd(v));
  const waste = tot.expired.extraUsd + tot.invalidated.extraUsd;
  const wasteW = asLimit ? rep.byAgent.reduce((s, a) => s + a.extraWeighted, 0) : waste;
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  out.push(
    t('share.cache.totals', {
      misses: rep.missesTotal,
      tokens: fmtTokens(tot.expired.tokens + tot.invalidated.tokens),
    })
  );
  out.push('');
  out.push(
    c.actualUsd
      ? t('share.cache.overpayOfSpend', { value: fmtW(wasteW), pct: pct(waste, c.actualUsd) })
      : t('share.cache.overpay', { value: fmtW(wasteW) })
  );
  out.push('');
  out.push(
    table(
      [t('share.col.cause'), t('share.col.misses'), t('common.col.tokens'), t('share.col.overpayUsd')],
      [
        [t('share.cache.causeExpired'), tot.expired.misses, fmtTokens(tot.expired.tokens), fmtUsd(tot.expired.extraUsd)],
        [t('share.cache.causeInvalidated'), tot.invalidated.misses, fmtTokens(tot.invalidated.tokens), fmtUsd(tot.invalidated.extraUsd)],
      ]
    )
  );
  out.push(
    tot.maxIdleMs
      ? t('share.cache.medianIdleMax', {
          median: tot.medianIdleMs ? fmtDuration(tot.medianIdleMs) : '—',
          max: fmtDuration(tot.maxIdleMs),
        })
      : t('share.cache.medianIdle', { median: tot.medianIdleMs ? fmtDuration(tot.medianIdleMs) : '—' })
  );
  out.push(t('share.cache.overHour', { n: tot.lateMisses }));
  out.push(t('share.cache.writtenByTtl', { ttl5m: fmtTokens(tot.ttl5m.write), ttl1h: fmtTokens(tot.ttl1h.write) }));
  out.push('');

  out.push(t('share.head.ifHourTtl'), '');
  const saved = asLimit ? c.savedWeighted : c.savedUsd;
  const premium = asLimit ? c.premiumWeighted : c.premiumUsd;
  const delta = asLimit ? c.hypoWeighted - c.actualWeighted : c.hypoUsd - c.actualUsd;
  out.push(
    t('share.cache.counterfactual', {
      saved: fmtW(saved),
      premium: fmtW(premium),
      verdict: delta <= 0 ? t('share.cache.gain', { v: fmtW(-delta) }) : t('share.cache.loss', { v: fmtW(delta) }),
    })
  );
  out.push('');

  if (rep.byDay.length) {
    out.push(t('share.head.overpayByDay'), '');
    out.push(
      table(
        [t('share.col.day'), t('common.col.overpay'), t('share.col.misses')],
        [...rep.byDay]
          .sort((a, b) => w(b) - w(a))
          .slice(0, top)
          .map((x) => [x.day, fmtW(w(x)), x.misses])
      )
    );
  }
  if (rep.byAgent.length) {
    out.push(t('share.head.whoLoses'), '');
    out.push(
      table(
        [t('common.col.agent'), t('common.col.overpay'), t('share.col.misses'), t('common.col.tokens')],
        rep.byAgent.slice(0, top).map((a) => [a.agent, fmtW(w(a)), a.misses, fmtTokens(a.tokens)])
      )
    );
  }
  if (rep.misses.length) {
    out.push(t('share.head.topMisses'), '');
    out.push(
      table(
        [t('share.col.time'), t('common.col.agent'), t('common.col.tokens'), t('share.col.pause'), 'ttl', t('share.col.cause'), t('common.col.overpay'), t('common.col.session'), t('common.col.run')],
        rep.misses.slice(0, top).map((m) => [
          fmtTime(m.ts),
          m.agent,
          fmtTokens(m.tokens),
          fmtDuration(m.idleMs),
          m.ttl,
          m.cause === 'expired' ? t('share.cache.shortExpired') : t('share.cache.shortInvalidated'),
          fmtW(w(m)),
          m.sessionId,
          m.runId,
        ])
      )
    );
    if (rep.missesTotal > rep.misses.length) {
      out.push(t('share.shownOf', { n: Math.min(top, rep.misses.length), total: rep.missesTotal }), '');
    }
  }
  return out.join('\n');
}

/**
 * The diagnostics screen as a reading, not a dump.
 *
 * Five independent diagnostics arrive as five equal tables, and an agent that
 * gets them that way has to re-derive the ranking the report already did. So the
 * order here is by what a reader can act on: the run that broke its own agent's
 * median comes first, the standing background cost of carrying context second,
 * and everything with nothing to say is dropped instead of printed empty.
 *
 * Per-unit prices are divided out of `value`, not read off the `usd*` fields:
 * those are dollars by construction, and on `weighted`/`raw` a dollar formatted
 * as tokens would be a wrong number rather than a converted one.
 */
function renderDiag(r: Resolved, top: number): string {
  const d = r.data as { total: Bucket; diag: DiagReport; health: HealthReport };
  const rep = d.diag;
  const h = d.health;
  const m = r.metric;
  const M = (v: number) => fmtMetric(v, m);
  const spend = d.total.value;
  const c = rep.toolCensus;
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  out.push(
    t('share.diag.totals', { spend: M(spend), messages: d.total.messages, sessions: d.total.sessions }) +
      // A window with no tool calls has no census to price, and "0% из $0" reads
      // like a finding rather than an empty index.
      (c.totals.calls
        ? t('share.diag.assembled', { value: M(c.totals.value) }) +
          (spend ? t('share.diag.assembledOfSpend', { pct: pct(c.totals.value, spend) }) : '') +
          t('share.diag.carryTail', { pct: (100 * c.totals.carryShare).toFixed(0) })
        : '')
  );
  out.push('');

  const ol = rep.outliers;
  if (ol.runs.length) {
    const judged = ol.byAgent.reduce((s, a) => s + a.runs, 0);
    out.push(t('share.head.outliers'), '');
    out.push(
      t('share.diag.outliers', {
        n: ol.runsTotal,
        unit: t('share.plural.runsWentOver', { n: ol.runsTotal }),
        agents: ol.byAgent.length,
        agentUnit: t('share.plural.agents', { n: ol.byAgent.length }),
        judged,
        judgedUnit: t('share.plural.runs', { n: judged }),
      }) +
        (ol.baseline === 'corpus' ? t('share.diag.medianWholeHistory') : t('share.diag.medianWindow')) +
        (ol.unjudged.length ? t('share.diag.unjudged', { list: ol.unjudged.join(', ') }) : '')
    );
    out.push('');
    out.push(
      table(
        [t('common.col.agent'), t('common.col.spend'), t('share.col.xMedian'), t('share.col.median'), t('share.col.overMedian'), t('common.col.turns'), t('common.col.model'), t('share.col.startedAt'), t('common.col.session'), 'run'],
        ol.runs.slice(0, top).map((x) => [
          x.agent,
          M(x.value),
          x.ratio.toFixed(1) + '×',
          M(x.medianValue),
          M(x.excessValue),
          x.turns,
          (x.model || '').replaceAll('claude-', ''),
          fmtTime(x.ts),
          x.sessionId,
          x.agentId,
        ])
      )
    );
    if (ol.runsTotal > Math.min(top, ol.runs.length)) {
      out.push(t('share.shownOf', { n: Math.min(top, ol.runs.length), total: ol.runsTotal }), '');
    }
  }

  if (c.topCalls.length) {
    out.push(t('share.head.topCalls'), '');
    for (const x of c.topCalls.slice(0, 3)) {
      out.push(
        t('share.diag.call', {
          value: M(x.value),
          tool: x.tool,
          target: short(x.target ?? '', 70),
          tokens: fmtTokens(x.tokens),
          turn: x.turn,
          turnsTotal: x.turnsTotal,
          carry: x.carryTurns,
          agent: x.agent,
        })
      );
    }
    out.push('');
    out.push(
      t('share.diag.callsNote'),
      ''
    );
  }

  if (rep.unitCost.length) {
    out.push(t('share.head.costPerUnit'), '');
    out.push(
      table(
        [t('common.col.agent'), t('common.col.spend'), t('share.col.perArtifact'), t('share.col.per1kOutput'), t('common.col.runs'), t('share.col.avgTurns'), t('share.col.artifacts'), t('share.col.reads')],
        rep.unitCost.slice(0, top).map((x) => [
          x.agent,
          M(x.value),
          x.artifacts > 0 ? M(x.value / x.artifacts) : '—',
          x.outputTokens > 0 ? M((x.value * 1000) / x.outputTokens) : '—',
          x.runs,
          x.avgTurns.toFixed(1),
          x.artifacts,
          x.reads,
        ])
      )
    );
  }

  const tail = rep.runTail.byAgent;
  if (tail.length) {
    out.push(t('share.head.tail'), '');
    out.push(
      t('share.diag.tailTotal', { value: M(tail.reduce((s, x) => s + x.tailValue, 0)), runs: rep.runTail.runsTotal })
    );
    out.push('');
    out.push(
      table(
        [t('common.col.agent'), t('share.col.tail'), t('share.col.tailShare'), t('common.col.runs')],
        tail.slice(0, top).map((x) => [
          x.agent,
          M(x.tailValue),
          Math.round(100 * x.avgTailShare) + '%',
          x.runs,
        ])
      )
    );
  }

  // Health is four counters that are only interesting when non-zero; the whole
  // section disappears on an index where nothing went wrong.
  const events: string[] = [];
  const th = h.throttling.totals;
  if (th.errors) {
    events.push(
      t('share.diag.rateLimits', {
        n: th.rateLimits,
        bursts: th.bursts,
        unit: t('share.plural.bursts', { n: th.bursts }),
        singles: th.singles,
        days: th.days,
      })
    );
  }
  const cm = h.compactions.totals;
  if (cm.count) {
    events.push(
      t('share.diag.compactions', {
        n: cm.count,
        sessions: cm.sessions,
        unit: t('share.plural.sessionsIn', { n: cm.sessions }),
        auto: cm.auto,
        manual: cm.manual,
        value: M(cm.rebuildValue),
      }) + (cm.medianPreTokens ? t('share.diag.compactionsMedian', { tokens: fmtTokens(cm.medianPreTokens) }) : '')
    );
  }
  const tf = h.toolFailures.totals;
  if (tf.calls) {
    events.push(
      t('share.diag.toolFailures', {
        calls: tf.calls,
        allCalls: tf.allCalls,
        rate: (100 * tf.errorRate).toFixed(1),
        tokens: fmtTokens(tf.tokens),
        value: M(tf.value),
      })
    );
  }
  const it = h.interruptions.totals;
  if (it.truncated || it.interrupts) {
    events.push(
      t('share.diag.interrupts', { truncated: it.truncated, interrupts: it.interrupts, value: M(it.runValue) })
    );
  }
  if (events.length) {
    out.push(t('share.head.whatHappened'), '');
    out.push(...events, '');
    if (h.throttling.bursts.length) {
      out.push(
        table(
          [t('share.col.startedAt'), t('share.col.errors'), t('share.col.of429'), t('share.col.lasted'), t('share.col.liveRuns'), t('share.col.spendInWindow'), t('common.col.session')],
          h.throttling.bursts.slice(0, Math.min(top, 5)).map((b) => [
            fmtTime(b.startTs),
            b.errors,
            b.rateLimits,
            fmtDuration(b.durationMs),
            b.agents,
            M(b.value),
            b.sessionId,
          ])
        )
      );
    }
    // The list, not just the rate. A reader who opens this link because 2% of
    // calls failed wants to know WHICH call said WHAT — the error head is the
    // whole reason the indexer keeps it, and a share that stops at the
    // percentage sends them back to the UI for the only useful half.
    if (h.toolFailures.topCalls.length) {
      out.push(t('share.diag.topOfThem'), '');
      out.push(
        table(
          [t('share.col.cost'), t('share.col.tool'), t('share.col.onWhat'), t('common.col.turn'), t('common.col.agent'), t('share.col.returned'), t('common.col.session'), 'run'],
          h.toolFailures.topCalls.slice(0, top).map((x) => [
            M(x.value),
            x.tool,
            short(x.target ?? '—', 50),
            `${x.turn}/${x.turnsTotal}`,
            x.agent,
            short((x.error ?? '—').replace(/\s+/g, ' ').trim(), 90),
            x.sessionId,
            x.agentId ?? 'main',
          ])
        )
      );
    }
    if (h.toolFailures.repeats.length) {
      out.push(t('share.diag.cycles'), '');
      out.push(
        table(
          [t('share.col.repeats'), t('share.col.tool'), t('share.col.onWhat'), t('common.col.agent'), t('share.col.cost'), t('common.col.session')],
          h.toolFailures.repeats.slice(0, top).map((x) => [
            '×' + x.count,
            x.tool,
            short(x.target ?? '—', 70),
            x.agent,
            M(x.value),
            x.sessionId,
          ])
        )
      );
    }
  }

  const heavy = rep.dispatchBlobs.heaviest;
  if (heavy.length) {
    out.push(t('share.head.heavyBriefs'), '');
    out.push(
      t('share.diag.briefs', {
        dispatches: rep.dispatchBlobs.totals.dispatches,
        tokens: fmtTokens(rep.dispatchBlobs.totals.tokens),
        copies: rep.dispatchBlobs.totals.duplicateCopies,
        value: M(rep.dispatchBlobs.totals.wasteValue),
      })
    );
    out.push('');
    out.push(
      table(
        // `agents` is who SENT the brief — the recipient is a fresh agent that
        // does not exist until the dispatch lands.
        [t('share.col.chars'), t('common.col.tokens'), t('share.col.copies'), t('share.col.tool'), t('share.col.sender'), t('share.col.about')],
        heavy.slice(0, top).map((x) => [
          x.chars,
          fmtTokens(x.tokens),
          x.copies,
          x.tool,
          x.agents.join(', '),
          short(x.target ?? '—', 70),
        ])
      )
    );
  }
  return out.join('\n');
}

/**
 * A probe's findings, read as a price rather than as a count.
 *
 * The count is the least interesting number here: a rule that fires 588 times
 * and costs nothing is a logging convention, not a finding. So the comparison
 * table goes first and everything else supports it — how much MORE a flagged
 * run of an agent cost than a clean run of THAT SAME agent. Ordering is by that
 * ratio, not by the report's own `flaggedUsd` order, because the expensive
 * agent is already known and the surprising one is not.
 *
 * Agents with no clean run in the window keep their row: their absence of a
 * baseline is itself worth seeing, and inventing one from the corpus would be
 * the comparison this report exists to avoid.
 */
function renderProbe(r: Resolved, top: number): string {
  const rep: ProbeReport = (r.data as any).report;
  const def: ProbeDef | null = rep.probe;
  const tot = rep.totals;
  const m = r.metric;
  const M = (v: number) => fmtMetric(v, m);
  const p = r.params;
  const keep = { ...(p.source ? { source: p.source } : {}), ...(p.metric ? { metric: p.metric } : {}) };
  const out: string[] = [];

  if (def) {
    out.push(t('share.head.rule'), '');
    out.push(
      `**${def.label}** \`${def.id}\`` +
        (def.builtin ? t('share.probe.builtin') : '') +
        (def.enabled === false ? t('share.probe.disabled') : '') +
        (def.rev ? ` · rev ${def.rev}` : '')
    );
    out.push('');
    out.push(t('share.probe.scope', { scope: def.scope }));
    out.push(t('share.probe.pattern', { pattern: short(def.pattern, 200) }));
    if (def.emptyIf) out.push(t('share.probe.emptyIf', { rule: short(def.emptyIf, 160) }));
    if (def.groupBy) out.push(t('share.probe.groupBy', { rule: short(def.groupBy, 160) }));
    out.push('');
  }

  out.push(t('share.head.total'), '');
  if (!tot.hits) {
    out.push(t('share.probe.neverFired'), '');
    return out.join('\n');
  }
  out.push(
    t('share.probe.totals', {
      nonEmpty: tot.nonEmpty,
      unit: t('share.plural.nonEmptyHits', { n: tot.nonEmpty }),
      hits: tot.hits,
      empty: tot.empty,
      runs: tot.runsFlagged,
      runUnit: t('share.plural.runs', { n: tot.runsFlagged }),
      sessions: tot.sessions,
      sessionUnit: t('share.plural.sessionsIn', { n: tot.sessions }),
    })
  );
  out.push('');
  out.push(
    t('share.probe.flaggedCost', {
      value: M(tot.valueInFlagged),
      usd: fmtUsd(tot.usdInFlagged),
      weighted: fmtTokens(tot.weightedInFlagged),
    })
  );
  out.push('');

  if (rep.byAgent.length) {
    // Nulls last: an agent without a clean run has no ratio, and sorting it as
    // zero would put the least comparable rows at the bottom by accident.
    const rows = [...rep.byAgent].sort((a, b) => (b.ratioValue ?? -1) - (a.ratioValue ?? -1));
    out.push(t('share.head.flaggedVsClean'), '');
    out.push(
      table(
        [
          t('common.col.agent'),
          t('share.col.xClean'),
          t('share.col.flagged'),
          t('share.col.avgFlagged'),
          t('common.col.turns'),
          t('share.col.clean'),
          t('share.col.avgClean'),
          t('common.col.turns'),
        ],
        rows.slice(0, top).map((x) => [
          x.agent,
          x.ratioValue == null ? '—' : x.ratioValue.toFixed(2) + '×',
          x.flaggedRuns,
          M(x.flaggedAvgValue),
          x.flaggedAvgTurns.toFixed(1),
          x.otherRuns || '—',
          x.otherRuns ? M(x.otherAvgValue) : '—',
          x.otherRuns ? x.otherAvgTurns.toFixed(1) : '—',
        ])
      )
    );
    if (rows.length > top) out.push(t('share.shownOf', { n: top, total: rows.length }), '');
    out.push(
      t('share.probe.xCleanNote'),
      ''
    );
  }

  if (rep.byGroup.length) {
    out.push(t('share.head.byRuleGroup'), '');
    out.push(
      table(
        [t('share.col.group'), t('share.col.hits'), t('common.col.runs'), t('share.col.spendFlagged')],
        rep.byGroup.slice(0, top).map((x) => [x.grp, x.hits, x.runs, M(x.value)])
      )
    );
    if (rep.byGroup.length > top) out.push(t('share.shownOf', { n: top, total: rep.byGroup.length }), '');
  }

  if (rep.byDay.length) {
    const limit = Math.max(top, 45);
    out.push(t('share.head.byDay'), '');
    out.push(
      table(
        [t('share.col.day'), t('share.col.hits'), t('share.col.nonEmptyOfThem')],
        rep.byDay.slice(-limit).map((x) => [x.day, x.hits, x.nonEmpty])
      )
    );
    if (rep.byDay.length > limit) out.push(t('share.shownLastOf', { n: limit, total: rep.byDay.length }), '');
  }

  if (rep.samples.length) {
    const shown = rep.samples.slice(0, Math.min(top, 8));
    out.push(t('share.head.whatWasFound'), '');
    for (const s of shown) {
      out.push(
        t('share.probe.sampleHead', { agent: s.agent, at: fmtTime(s.ts), project: s.project }) +
          (s.grp ? t('share.probe.sampleGroup', { group: s.grp }) : '')
      );
      out.push('');
      out.push('> ' + short(s.capture, 200));
      out.push('');
      out.push(
        s.agentId
          ? t('share.probe.sampleRunLink', { link: refString('run', { ...keep, session: s.sessionId, run: s.agentId }) })
          : t('share.probe.sampleNoRun', { session: s.sessionId })
      );
      out.push('');
    }
    out.push(
      t('share.probe.samplesNote', { n: shown.length, total: tot.nonEmpty }),
      ''
    );
  }
  return out.join('\n');
}

function renderSession(r: Resolved, top: number): string {
  const d = r.data as any;
  const info: SessionInfo = d.info;
  const m = r.metric;
  const total: number = d.total;
  const runs: RunRow[] = d.runs ?? [];
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  out.push(
    t('share.session.totals', {
      value: fmtMetric(total, m),
      messages: d.messages,
      runs: runs.length,
      unit: t('share.plural.runs', { n: runs.length }),
    }) +
      (info.firstTs && info.lastTs ? ` · ${fmtDuration(info.lastTs - info.firstTs)}` : '')
  );
  out.push('');
  if (info.firstTs) out.push(t('share.session.firstTs', { at: fmtTime(info.firstTs) }));
  if (info.lastTs) out.push(t('share.session.lastTs', { at: fmtTime(info.lastTs) }));
  if (info.firstPrompt) out.push(t('share.session.firstPrompt', { text: short(info.firstPrompt, 300) }));
  out.push('');

  const agents: Bucket[] = d.agents ?? [];
  if (agents.length) {
    out.push(t('share.head.agents'), '');
    out.push(bucketTable(agents, m, total, top, t('common.col.agent')));
  }
  const models: Bucket[] = d.models ?? [];
  if (models.length) {
    out.push(t('share.head.models'), '');
    out.push(bucketTable(models, m, total, top, t('common.col.model')));
  }
  if (runs.length) {
    out.push(t('share.head.runs'), '');
    out.push(
      table(
        [t('common.col.agent'), m === 'usd' ? '$' : t('share.col.tokens'), t('common.col.share'), t('common.col.turns'), t('common.col.duration'), t('share.col.peakContext'), t('share.col.startedAt'), 'run'],
        runs.slice(0, top).map((x) => [
          x.agent,
          fmtMetric(x.value, m),
          pct(x.value, total),
          x.messages,
          fmtDuration(x.durationMs),
          fmtTokens(x.peakContext),
          fmtTime(x.firstTs),
          x.runId,
        ])
      )
    );
    if (runs.length > top) out.push(t('share.shownOf', { n: top, total: runs.length }), '');
  }

  const peaks: TimelinePoint[] = d.peaks ?? [];
  if (peaks.length) {
    out.push(t('share.head.topMessages'), '');
    out.push(
      table(
        [t('share.col.time'), t('common.col.agent'), m === 'usd' ? '$' : t('share.col.tokens'), 'output', t('share.col.cacheRead'), t('share.col.cacheWrite'), 'run'],
        peaks.slice(0, Math.min(top, 15)).map((x) => [
          fmtTime(x.ts),
          x.agent,
          fmtMetric(x.value, m),
          fmtTokens(x.output),
          fmtTokens(x.cacheRead),
          fmtTokens(x.cacheWrite),
          x.runId,
        ])
      )
    );
  }
  if (!d.timeline) {
    out.push(
      t('share.session.noTimeline'),
      ''
    );
  }
  return out.join('\n');
}

function renderAgent(r: Resolved, top: number): string {
  const d = r.data as any;
  const runs: RunRow[] = d.runs ?? [];
  const m = r.metric;
  const total = runs.reduce((s, x) => s + x.value, 0);
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  out.push(
    t('share.agent.totals', {
      value: fmtMetric(total, m),
      runs: runs.length,
      unit: t('share.plural.runs', { n: runs.length }),
      avg: fmtMetric(total / Math.max(1, runs.length), m),
      peak: fmtTokens(Math.max(...runs.map((x) => x.peakContext), 0)),
    })
  );
  out.push('');
  const wfs = [...new Set(runs.map((x) => x.workflowId).filter(Boolean))];
  if (wfs.length) out.push(`- workflow: ${wfs.join(', ')}`, '');

  out.push(t('share.head.runs'), '');
  out.push(
    table(
      ['run', m === 'usd' ? '$' : t('share.col.tokens'), t('common.col.share'), t('common.col.turns'), t('common.col.duration'), t('share.col.peakContext'), 'output', t('common.col.model'), t('share.col.startedAt')],
      runs.slice(0, top).map((x) => [
        x.runId,
        fmtMetric(x.value, m),
        pct(x.value, total),
        x.messages,
        fmtDuration(x.durationMs),
        fmtTokens(x.peakContext),
        fmtTokens(x.output),
        (x.models || '').replaceAll('claude-', ''),
        fmtTime(x.firstTs),
      ])
    )
  );
  if (runs.length > top) out.push(t('share.shownOf', { n: top, total: runs.length }), '');
  return out.join('\n');
}

/**
 * Tool calls of one turn, as one readable line. The other arguments ride along
 * because the target alone does not tell two calls apart — four reads of one
 * file differ only by `offset`/`limit`.
 */
const toolLine = (s: RunStep): string =>
  (s.tools ?? [])
    .map((t) => `${t.name}(${short(t.target ?? '', 60)})${t.detail ? ` · ${short(t.detail, 80)}` : ''}`)
    .join(', ');

function renderRun(r: Resolved, p: Record<string, string>): string {
  const d = r.data as any;
  const run: RunRow | null = d.run;
  const steps: RunStep[] = d.steps ?? [];
  const m = r.metric;
  const turns = steps.filter((s) => s.kind === 'assistant' && s.context != null);
  const limit = Math.max(1, Math.min(5000, num(p.limit) ?? 200));
  const out: string[] = [];

  out.push(t('share.head.total'), '');
  if (run) {
    out.push(
      t('share.run.totals', {
        value: fmtMetric(run.value, m),
        turns: turns.length,
        duration: fmtDuration(run.durationMs),
        peak: fmtTokens(run.peakContext),
        output: fmtTokens(run.output),
      })
    );
    out.push('');
    out.push(t('share.run.times', { from: fmtTime(run.firstTs), to: fmtTime(run.lastTs) }));
    out.push(t('share.run.model', {
      model: (run.models || '').replaceAll('claude-', '') + (run.effort ? t('share.run.modelEffort', { effort: run.effort }) : ''),
    }));
    if (run.workflowId) out.push(`- workflow: ${run.workflowId}`);
    out.push('');
  }

  const tools = new Map<string, number>();
  for (const s of steps) for (const t of s.tools ?? []) tools.set(t.name, (tools.get(t.name) ?? 0) + 1);
  if (tools.size) {
    out.push(t('share.head.tools'), '');
    out.push(
      table(
        [t('share.col.tool'), t('share.col.calls')],
        [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, c])
      )
    );
  }

  const misses = steps.filter((s) => s.cacheMiss);
  if (misses.length) {
    out.push(t('share.head.cacheRewrites'), '');
    out.push(
      table(
        [t('share.col.time'), t('common.col.tokens'), t('share.col.pause'), 'ttl', t('share.col.cause'), t('common.col.overpay')],
        misses.map((s) => [
          fmtClock(s.ts),
          fmtTokens(s.cacheMiss!.tokens),
          fmtDuration(s.cacheMiss!.idleMs),
          s.cacheMiss!.ttl,
          s.cacheMiss!.cause === 'expired' ? t('share.cache.shortExpired') : t('share.cache.shortInvalidated'),
          fmtMetric(s.cacheMiss!.extra, m),
        ])
      )
    );
  }

  out.push(t('share.head.contextByTurn'), '');
  out.push(
    table(
      [t('common.col.turn'), t('share.col.time'), t('share.col.context'), t('share.col.cacheRead'), t('share.col.cacheWrite'), 'output', m === 'usd' ? '$' : t('share.col.tokens')],
      turns.map((s, i) => [
        i + 1,
        fmtClock(s.ts),
        fmtTokens(s.context ?? 0),
        fmtTokens(s.cacheRead ?? 0),
        fmtTokens(s.cacheWrite ?? 0),
        fmtTokens(s.output ?? 0),
        fmtMetric(s.value ?? 0, m),
      ])
    )
  );

  out.push(t('share.head.history'), '');
  const shown = steps.slice(0, limit);
  let turnNo = 0;
  for (const s of shown) {
    if (s.kind === 'prompt') {
      out.push(t('share.run.promptStep', { at: fmtClock(s.ts) }) + (s.chars ? t('share.run.promptChars', { n: s.chars }) : ''), '');
      if (s.text) out.push('> ' + s.text.replaceAll('\n', '\n> '), '');
    } else if (s.kind === 'assistant') {
      turnNo += 1;
      const head =
        t('share.run.turnStep', { n: turnNo, at: fmtClock(s.ts) }) +
        t('share.run.turnStats', { context: fmtTokens(s.context ?? 0), output: fmtTokens(s.output ?? 0) }) +
        `${fmtMetric(s.value ?? 0, m)}` +
        (s.thinkingChars ? t('share.run.thinking', { n: s.thinkingChars }) : '') +
        (s.cacheMiss ? t('share.run.cacheRewrite', { value: fmtMetric(s.cacheMiss.extra, m) }) : '');
      out.push(head, '');
      if (s.text) out.push(s.text, '');
      const tl = toolLine(s);
      if (tl) out.push(`→ ${tl}`, '');
    } else {
      // The log stores a tool result's size, not its body — the same thing the
      // run view shows. The call it answers is resolved by `tool_use_id`, so
      // the line names the tool and its target instead of repeating the turn
      // above and hoping the order matched.
      const of = s.toolName ? ` ${s.toolName}${s.toolTarget ? ` ${short(s.toolTarget, 60)}` : ''}` : '';
      out.push(
        t('share.run.resultLine', {
          kind: s.isError ? t('share.run.resultError') : t('share.run.resultOk'),
          of,
          note: s.resultNote ? ` · ${s.resultNote}` : '',
          chars: s.chars ? t('share.run.resultChars', { n: s.chars }) : '',
        }),
        ''
      );
    }
  }
  if (steps.length > shown.length) {
    out.push(
      t('share.run.truncated', { n: shown.length, total: steps.length }),
      ''
    );
  }
  out.push(
    t('share.run.note'),
    ''
  );
  return out.join('\n');
}

const ORIGIN_NAME: Record<string, string> = {
  subagent: t('share.origin.subagent'),
  write: t('share.origin.write'),
  plan: t('share.origin.plan'),
  thinking: t('share.origin.thinking'),
  dispatch: t('share.origin.dispatch'),
  command: t('share.origin.command'),
  result: t('share.origin.result'),
  reminder: t('share.origin.reminder'),
  answer: t('share.origin.answer'),
  prompt: t('share.origin.prompt'),
};

function renderContext(r: Resolved, top: number): string {
  const rep: ContextReport = (r.data as any).report;
  const out: string[] = [];
  const total = rep.finalContext || 1;

  out.push(t('share.head.total'), '');
  out.push(
    t('share.context.totals', {
      tokens: fmtTokens(rep.finalContext),
      from: rep.segment.fromTurn,
      to: rep.segment.toTurn,
      turns: rep.turns,
    })
  );
  out.push('');
  out.push(
    t('share.context.dupes', { tokens: fmtTokens(rep.dupeTokens), pct: pct(rep.dupeTokens, total) })
  );
  out.push(
    t('share.context.invisible', { tokens: fmtTokens(rep.fit.headTokens) })
  );
  out.push(
    t('share.context.fit', {
      ratio: rep.fit.charsPerToken.toFixed(2),
      points: rep.fit.points,
      error: rep.fit.errorPct.toFixed(1),
    })
  );
  if (rep.segments.length > 1) {
    out.push(
      t('share.context.windows', {
        n: rep.segments.length,
        list: rep.segments.map((s) => `${s.fromTurn}–${s.toTurn}: ${fmtTokens(s.peakContext)}`).join('; '),
      })
    );
  }
  out.push('');

  out.push(t('share.head.byOrigin'), '');
  out.push(
    table(
      [t('share.col.kind'), t('share.col.blocks'), t('common.col.tokens'), t('common.col.share')],
      rep.byOrigin.map((o) => [
        ORIGIN_NAME[o.origin] ?? o.origin,
        o.blocks,
        fmtTokens(o.tokens),
        pct(o.tokens, total),
      ])
    )
  );

  out.push(t('share.head.whoPutIt'), '');
  out.push(
    table(
      [t('share.col.kind'), t('share.col.label'), t('share.col.blocks'), t('common.col.tokens'), t('common.col.share')],
      rep.byLabel.slice(0, top).map((o) => [
        ORIGIN_NAME[o.origin] ?? o.origin,
        o.label,
        o.blocks,
        fmtTokens(o.tokens),
        pct(o.tokens, total),
      ])
    )
  );

  if (rep.dupes.length) {
    out.push(t('share.head.duplicates'), '');
    out.push(
      table(
        [t('share.col.copies'), t('common.col.tokens'), t('share.col.extra'), t('share.col.turns'), t('share.col.kind')],
        rep.dupes.slice(0, top).map((g) => [
          g.copies,
          fmtTokens(g.tokens),
          fmtTokens(g.wastedTokens),
          g.members.map((mm) => mm.turn).join(', '),
          short(g.preview, 100),
        ])
      )
    );
  }

  out.push(t('share.head.biggestBlocks'), '');
  out.push(
    table(
      [t('common.col.turn'), t('share.col.kind'), t('share.col.label'), t('common.col.tokens'), t('common.col.share'), t('share.col.textStart')],
      rep.top.slice(0, top).map((b) => [
        b.turn,
        ORIGIN_NAME[b.origin] ?? b.origin,
        b.label,
        fmtTokens(b.tokens),
        pct(b.tokens, total),
        short(b.preview, 100),
      ])
    )
  );

  const grew = [...rep.growth].sort((a, b) => b.delta - a.delta).slice(0, Math.min(top, 15));
  if (grew.length) {
    out.push(t('share.head.biggestGrowth'), '');
    out.push(
      table(
        [t('common.col.turn'), t('share.col.time'), t('share.col.growth'), t('share.col.contextAfter')],
        grew.map((g) => [g.turn, fmtClock(g.ts), fmtTokens(g.delta), fmtTokens(g.context)])
      )
    );
  }
  return out.join('\n');
}

function renderCohort(r: Resolved, top: number): string {
  const rep: CohortReport = (r.data as any).report;
  const m = r.metric;
  const out: string[] = [];
  const shareCollected = rep.collectedTokens ? (100 * rep.sharedTokens) / rep.collectedTokens : 0;
  const shareSpend = rep.actualValue ? (100 * rep.wastedValue) / rep.actualValue : 0;

  out.push(t('share.head.total'), '');
  out.push(
    t('share.cohort.collected', {
      runs: rep.activeRuns,
      tokens: fmtTokens(rep.collectedTokens),
      shared: fmtTokens(rep.sharedTokens),
      pct: shareCollected.toFixed(0),
    })
  );
  out.push('');
  out.push(
    t('share.cohort.wasted', {
      wasted: fmtMetric(rep.wastedValue, m),
      actual: fmtMetric(rep.actualValue, m),
      pct: shareSpend.toFixed(0),
    })
  );
  out.push('');
  out.push(
    table(
      [t('share.col.halfOverpay'), m === 'usd' ? '$' : t('share.col.tokens'), t('share.col.howRemoved')],
      [
        [t('share.cohort.writeRow'), fmtMetric(rep.wastedWrite, m), t('share.cohort.writeFix')],
        [t('share.cohort.carryRow'), fmtMetric(rep.wastedCarry, m), t('share.cohort.carryFix')],
      ]
    )
  );
  out.push(
    t('share.cohort.prefix', {
      value: fmtMetric(rep.prefixRecoverable, m),
      breakEven: rep.breakEvenTurn.toFixed(1),
    })
  );
  out.push('');

  out.push(t('share.head.collectedSeparately'), '');
  out.push(
    table(
      [t('common.col.overpay'), t('share.col.prefixReturns'), t('common.col.runs'), t('common.col.size'), t('share.col.medianTurn'), t('share.col.tool'), t('common.col.what')],
      rep.sources.slice(0, top).map((s) => [
        fmtMetric(s.wasted, m),
        fmtMetric(s.prefixRecoverable, m),
        t('share.cohort.runsOf', { n: s.runs, total: rep.activeRuns }),
        fmtTokens(s.tokens),
        s.medianTurn,
        s.tool,
        s.label + (s.variants > 1 ? t('share.cohort.variants', { n: s.variants }) : ''),
      ])
    )
  );
  if (rep.sources.length > top) out.push(t('share.shownOf', { n: top, total: rep.sources.length }), '');

  if (rep.perRun.length) {
    out.push(t('share.head.cohortRuns'), '');
    out.push(
      table(
        ['run', t('share.col.startedAt'), t('common.col.turns'), t('share.col.collected'), t('share.col.ofItShared'), m === 'usd' ? '$' : t('share.col.tokens')],
        rep.perRun.slice(0, top).map((x) => [
          x.runId,
          fmtTime(x.ts),
          x.turns,
          fmtTokens(x.collected),
          fmtTokens(x.shared),
          fmtMetric(x.value, m),
        ])
      )
    );
  }
  return out.join('\n');
}

/** The `/s` landing page: an agent that got only the origin still finds its way. */
export function renderIndex(baseUrl?: string): string {
  const out = [
    t('share.index.title'),
    '',
    t('share.index.intro'),
    t('share.index.format'),
    '',
    t('share.index.tableHead'),
    '| --- | --- | --- |',
  ];
  for (const [kind, spec] of Object.entries(SHARE_KINDS)) {
    out.push(`| \`${kind}\` | ${spec.required.map((x) => `\`${x}\``).join(', ') || '—'} | ${spec.about} |`);
  }
  out.push('');
  out.push(t('share.index.optional'));
  out.push('');
  out.push(t('share.index.cli'));
  out.push('');
  if (baseUrl) out.push(t('share.index.example', { url: shareUrl(baseUrl, 'overview', { metric: 'usd' }) }), '');
  return out.join('\n');
}
