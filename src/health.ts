/**
 * Run health: what HAPPENED to the runs, not what they spent.
 *
 * Every other report in this tool answers "where did the money go" by summing
 * billed counters. This one answers a different question — "what went wrong" —
 * and the four sections here are together because they share one property: the
 * cost is a CONSEQUENCE, never a line item. Nothing in `msgs` is labelled
 * "compaction" or "retry"; the bill only shows the turns that followed.
 *
 *   1. compactions — the context was thrown away and rebuilt. The compaction
 *      itself is one summarising call; the real price is the next turn, which
 *      re-writes the whole surviving context into a cold cache at the write
 *      rate. That turn looks like an ordinary expensive turn in every other
 *      view, which is exactly why it needs pointing at.
 *   2. throttling — 429s. A rate limit costs nothing directly, it costs TIME,
 *      and it is evidence about shape: you hit the ceiling when a wide fan of
 *      agents was live, so the answer is "who was running", not "what it cost".
 *   3. toolFailures — a failed call is billed exactly like a useful one. The
 *      error text is written to the cache and re-read on every later turn of
 *      the run, so a failure early in a long run costs several times the same
 *      failure at the end. `carriedCost` is what makes that visible.
 *   4. interruptions — answers that were cut off (`max_tokens`) or stopped by
 *      the user. The tokens were produced and billed; the work was not
 *      delivered. The unit of loss here is the whole RUN, not the message.
 *
 * All four read the `events` and `tools` fact tables, whose `num1..3` columns
 * are typed by `type` — see `EventRow` in `parse.ts` for the contract. Money
 * that comes from `msgs` is billed and exact; money derived from characters is
 * an ESTIMATE via `estimate.ts` and is labelled as such in the UI. Every
 * section returns empty arrays and zeroed totals on an index that never saw
 * the thing it reports — an index with no compaction is normal, not an error.
 */

import type { DatabaseSync } from 'node:sqlite';

import { METRIC_COLUMN, type Metric } from './db.ts';
import { carriedCost, toWeighted, tokensOf } from './estimate.ts';
import { PRICES, tierOf } from './pricing.ts';
import { buildWhere, type Filters, type WhereParts } from './queries.ts';

/** Two errors closer together than this are one episode of hitting the wall. */
const BURST_GAP_MS = 120_000;
/** Two errors close together is a cluster; one is just a retry. */
const BURST_MIN_ERRORS = 2;

const ROW_CAP = 100;
const BURST_CAP = 20;
const CALL_CAP = 30;
/** A streak this long stops being bad luck and starts being a loop. */
const REPEAT_MIN = 3;

// ---------------------------------------------------------------------------
// Section 1 — compactions
// ---------------------------------------------------------------------------

export interface CompactionRow {
  sessionId: string;
  agent: string;
  agentId: string | null;
  ts: number;
  day: string;
  /** Context size the compaction ran on. */
  preTokens: number;
  /** What survived into the new window. */
  postTokens: number;
  durationMs: number;
  /** 'auto' when the context filled up, 'manual' when the user asked. */
  trigger: string | null;
  /** Cache-write tokens the first turn after the compaction had to pay for. */
  rebuildTokens: number;
  rebuildUsd: number;
  rebuildWeighted: number;
  rebuildValue: number;
  /** Model of that first turn — the rebuild is priced at its rate. */
  model: string | null;
}

export interface CompactionSection {
  rows: CompactionRow[];
  rowsTotal: number;
  totals: {
    count: number;
    sessions: number;
    /** Split by trigger: 'auto' is the context filling up on its own. */
    auto: number;
    manual: number;
    /** Typical context at which this setup compacts. */
    medianPreTokens: number | null;
    preTokens: number;
    postTokens: number;
    durationMs: number;
    rebuildUsd: number;
    rebuildWeighted: number;
    rebuildValue: number;
  };
}

// ---------------------------------------------------------------------------
// Section 2 — throttling
// ---------------------------------------------------------------------------

export interface ThrottleDay {
  day: string;
  errors: number;
  rateLimits: number;
  /** Spend on that whole day — a limit hit on a quiet day means something else. */
  usd: number;
  weighted: number;
  value: number;
}

export interface ThrottleBurst {
  startTs: number;
  endTs: number;
  durationMs: number;
  errors: number;
  rateLimits: number;
  sessionId: string;
  /** Agent that logged the first error of the episode. */
  agent: string;
  /** Distinct runs live in the window — the width of the fan that hit the wall. */
  agents: number;
  usd: number;
  weighted: number;
  value: number;
}

export interface ThrottlingSection {
  totals: {
    errors: number;
    rateLimits: number;
    days: number;
    bursts: number;
    /** Isolated retries — counted, but not shown as bursts. */
    singles: number;
  };
  byDay: ThrottleDay[];
  bursts: ThrottleBurst[];
  burstsTotal: number;
}

// ---------------------------------------------------------------------------
// Section 3 — tool failures
// ---------------------------------------------------------------------------

export interface ToolFailureBucket {
  tool: string;
  calls: number;
  chars: number;
  tokens: number;
  usd: number;
  weighted: number;
  value: number;
  /** Failed calls as a share of every call of this tool in the window. */
  errorRate: number;
}

export interface AgentFailureBucket {
  agent: string;
  calls: number;
  chars: number;
  tokens: number;
  usd: number;
  weighted: number;
  value: number;
  errorRate: number;
  /** The tool costing this agent the most in failures. */
  worstTool: string | null;
}

export interface FailedCall {
  tool: string;
  target: string | null;
  agent: string;
  agentId: string | null;
  sessionId: string;
  ts: number;
  /** 1-based turn of the run — the anchor for "open this turn". */
  turn: number;
  /** Turns in the whole run. With `turn` it explains the cost: an error on turn
   *  3 of 200 is carried 197 more times, the same error on turn 199 is not. */
  turnsTotal: number;
  chars: number;
  tokens: number;
  usd: number;
  weighted: number;
  value: number;
  /** Head of the failure text, not the whole of it — `chars` is what was billed. */
  error: string | null;
}

export interface FailureLoop {
  agentId: string;
  agent: string;
  tool: string;
  target: string | null;
  sessionId: string;
  count: number;
  chars: number;
  usd: number;
  weighted: number;
  value: number;
  firstTs: number;
  lastTs: number;
}

export interface ToolFailureSection {
  totals: {
    calls: number;
    /** Every call in the window, failed or not — the denominator. */
    allCalls: number;
    errorRate: number;
    chars: number;
    tokens: number;
    usd: number;
    weighted: number;
    value: number;
  };
  byTool: ToolFailureBucket[];
  byAgent: AgentFailureBucket[];
  topCalls: FailedCall[];
  repeats: FailureLoop[];
}

// ---------------------------------------------------------------------------
// Section 4 — interruptions
// ---------------------------------------------------------------------------

export interface BreakRow {
  type: 'truncated' | 'interrupt';
  agent: string;
  agentId: string | null;
  sessionId: string;
  ts: number;
  day: string;
  turn: number;
  /** Output tokens produced before the cut (`truncated` only). */
  outputTokens: number;
  /** Tool the user interrupted, when the log named one. */
  tool: string | null;
  /** What the whole run cost — the unit actually lost when it is cut short. */
  runUsd: number;
  runWeighted: number;
  runValue: number;
}

export interface InterruptionSection {
  truncated: BreakRow[];
  interrupts: BreakRow[];
  totals: {
    truncated: number;
    interrupts: number;
    /** Runs behind those rows, summed once even when a run broke twice. */
    runUsd: number;
    runWeighted: number;
    runValue: number;
  };
}

export interface HealthReport {
  metric: Metric;
  compactions: CompactionSection;
  throttling: ThrottlingSection;
  toolFailures: ToolFailureSection;
  interruptions: InterruptionSection;
}

// ---------------------------------------------------------------------------

/**
 * `value` in the requested metric.
 *
 * `usd` and `weighted` are two views of one price, so they always agree. `raw`
 * is a token count, and an estimated cost has no billed row to read one off —
 * so the caller passes the tokens the estimate was built from.
 */
function pick(metric: Metric, usd: number, weighted: number, raw: number): number {
  return metric === 'usd' ? usd : metric === 'weighted' ? weighted : raw;
}

/** `WHERE a AND b` without caring whether `buildWhere` produced anything. */
function and(w: WhereParts, extra: string): string {
  return w.sql ? `${w.sql} AND ${extra}` : `WHERE ${extra}`;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v ?? '');

/**
 * `events` carries no `model` column — the event is a property of the run, not
 * of a billed message. A model filter therefore has nothing to bind to there
 * and is dropped rather than made to error.
 */
function eventFilters(f: Filters): Filters {
  const { model: _model, ...rest } = f;
  return rest;
}

/** Split a long IN-list so no single statement blows past the parameter limit. */
function chunks<T>(xs: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------

function compactionSection(db: DatabaseSync, filters: Filters, metric: Metric): CompactionSection {
  const where = buildWhere(eventFilters(filters));
  const events = db
    .prepare(
      `SELECT m.ts, m.day, m.session_id AS sid, m.agent, m.agent_id AS aid, m.file,
              m.num1 AS pre, m.num2 AS post, m.num3 AS dur, m.text AS trigger
       FROM events m ${and(where, "m.type = 'compaction'")}
       ORDER BY m.ts`
    )
    .all(...where.params) as any[];

  // The rebuild is the first billed turn of the SAME file at or after the
  // event: after a compaction the model is handed a fresh context and pays the
  // cache-WRITE rate for all of it, where an uninterrupted turn would have paid
  // the read rate. Filters are deliberately not applied — the price of the
  // event is whatever actually followed it.
  const nextTurn = db.prepare(
    `SELECT model, cache_w5m, cache_w1h FROM msgs
     WHERE file = ? AND ts >= ? ORDER BY ts LIMIT 1`
  );

  const rows: CompactionRow[] = [];
  const sessions = new Set<string>();
  const pres: number[] = [];
  let auto = 0, manual = 0;
  let sumPre = 0, sumPost = 0, sumDur = 0;
  let tUsd = 0, tW = 0, tRaw = 0;

  for (const e of events) {
    sessions.add(str(e.sid));
    const pre = num(e.pre), post = num(e.post), dur = num(e.dur);
    pres.push(pre);
    sumPre += pre;
    sumPost += post;
    sumDur += dur;
    if (e.trigger === 'auto') auto++;
    else manual++;

    const next = nextTurn.get(str(e.file), num(e.ts)) as any;
    const model: string | null = next?.model ?? null;
    const w5 = num(next?.cache_w5m), w1 = num(next?.cache_w1h);
    const p = PRICES[tierOf(model)];
    const usd = (w5 * p[2] + w1 * p[3]) / 1e6;
    const weighted = toWeighted(usd);
    const tokens = w5 + w1;

    tUsd += usd;
    tW += weighted;
    tRaw += tokens;

    rows.push({
      sessionId: str(e.sid),
      agent: str(e.agent),
      agentId: e.aid ?? null,
      ts: num(e.ts),
      day: str(e.day),
      preTokens: pre,
      postTokens: post,
      durationMs: dur,
      trigger: e.trigger ?? null,
      rebuildTokens: tokens,
      rebuildUsd: usd,
      rebuildWeighted: weighted,
      rebuildValue: pick(metric, usd, weighted, tokens),
      model,
    });
  }

  rows.sort((a, b) => b.rebuildUsd - a.rebuildUsd);

  return {
    rows: rows.slice(0, ROW_CAP),
    rowsTotal: rows.length,
    totals: {
      count: events.length,
      sessions: sessions.size,
      auto,
      manual,
      medianPreTokens: median(pres),
      preTokens: sumPre,
      postTokens: sumPost,
      durationMs: sumDur,
      rebuildUsd: tUsd,
      rebuildWeighted: tW,
      rebuildValue: pick(metric, tUsd, tW, tRaw),
    },
  };
}

// ---------------------------------------------------------------------------

function throttlingSection(db: DatabaseSync, filters: Filters, metric: Metric): ThrottlingSection {
  const where = buildWhere(eventFilters(filters));
  const col = METRIC_COLUMN[metric];

  // Ordered by session then time: a burst is chained inside one session, since
  // that is the scope where "who else was running" has an answer. Rate limits
  // are account-wide, so two sessions throttled at once show up as two bursts —
  // honest, if conservative.
  const errors = db
    .prepare(
      `SELECT m.ts, m.day, m.session_id AS sid, m.agent, m.num1 AS status
       FROM events m ${and(where, "m.type = 'api_error'")}
       ORDER BY m.session_id, m.ts`
    )
    .all(...where.params) as any[];

  const days = new Map<string, ThrottleDay>();
  for (const e of errors) {
    const d = str(e.day);
    let row = days.get(d);
    if (!row) days.set(d, (row = { day: d, errors: 0, rateLimits: 0, usd: 0, weighted: 0, value: 0 }));
    row.errors++;
    if (num(e.status) === 429) row.rateLimits++;
  }

  // Day spend comes from `msgs` under the same filters, so "we hit the limit"
  // can be read against "this is what we were burning that day".
  if (days.size) {
    const mw = buildWhere(filters);
    for (const r of db
      .prepare(
        `SELECT m.day AS day, sum(m.usd) AS usd, sum(m.weighted) AS w, sum(${col}) AS v
         FROM msgs m ${mw.sql} GROUP BY m.day`
      )
      .all(...mw.params) as any[]) {
      const row = days.get(str(r.day));
      if (!row) continue;
      row.usd = num(r.usd);
      row.weighted = num(r.w);
      row.value = num(r.v);
    }
  }

  // What was live while we were being throttled. The window opens one gap
  // BEFORE the first error, because the requests that earned the 429 were sent
  // in the seconds leading up to it, not after.
  const windowStat = db.prepare(
    `SELECT count(DISTINCT coalesce(m.agent_id, 'main')) AS agents,
            sum(m.usd) AS usd, sum(m.weighted) AS w, sum(${col}) AS v
     FROM msgs m ${and(buildWhere(filters), 'm.session_id = ? AND m.ts >= ? AND m.ts <= ?')}`
  );
  const windowParams = buildWhere(filters).params;

  const bursts: ThrottleBurst[] = [];
  let open: { sid: string; agent: string; start: number; end: number; errors: number; rl: number } | null = null;

  const flush = () => {
    if (!open) return;
    const s = windowStat.get(...windowParams, open.sid, open.start - BURST_GAP_MS, open.end) as any;
    bursts.push({
      startTs: open.start,
      endTs: open.end,
      durationMs: open.end - open.start,
      errors: open.errors,
      rateLimits: open.rl,
      sessionId: open.sid,
      agent: open.agent,
      agents: num(s?.agents),
      usd: num(s?.usd),
      weighted: num(s?.w),
      value: num(s?.v),
    });
    open = null;
  };

  for (const e of errors) {
    const sid = str(e.sid), ts = num(e.ts);
    if (open && open.sid === sid && ts - open.end < BURST_GAP_MS) {
      open.end = ts;
      open.errors++;
      if (num(e.status) === 429) open.rl++;
      continue;
    }
    flush();
    open = { sid, agent: str(e.agent), start: ts, end: ts, errors: 1, rl: num(e.status) === 429 ? 1 : 0 };
  }
  flush();

  // A lone retry is not a burst. Counting singletons as one would report 225
  // "bursts" for 425 errors and hide the thing worth seeing: the handful of
  // clusters where a fan-out ran into the ceiling and stayed there.
  const clustered = bursts.filter((b) => b.errors >= BURST_MIN_ERRORS);
  const ranked = [...clustered].sort((a, b) => b.errors - a.errors || b.usd - a.usd);

  return {
    totals: {
      errors: errors.length,
      rateLimits: errors.reduce((n, e) => n + (num(e.status) === 429 ? 1 : 0), 0),
      days: days.size,
      bursts: clustered.length,
      singles: bursts.length - clustered.length,
    },
    byDay: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    bursts: ranked.slice(0, BURST_CAP),
    burstsTotal: clustered.length,
  };
}

// ---------------------------------------------------------------------------

function toolFailureSection(db: DatabaseSync, filters: Filters, metric: Metric): ToolFailureSection {
  const where = buildWhere(filters);

  // Ordered by run then time so the repeat detector below can walk streaks in
  // one pass; the aggregates do not care about order.
  const rows = db
    .prepare(
      `SELECT m.ts, m.session_id AS sid, m.agent, m.agent_id AS aid, m.model, m.tool, m.target,
              m.turn, m.turns_total AS total, m.result_chars AS chars, m.error_text
       FROM tools m ${and(where, 'm.is_error = 1')}
       ORDER BY m.session_id, coalesce(m.agent_id, 'main'), m.ts`
    )
    .all(...where.params) as any[];

  // Denominators. An error rate is only interesting against how often the tool
  // was used at all — 12 failed Reads out of 4000 is noise, out of 30 is a bug.
  const allByTool = new Map<string, number>();
  const allByAgent = new Map<string, number>();
  let allCalls = 0;
  for (const r of db
    .prepare(`SELECT m.tool, m.agent, count(*) AS n FROM tools m ${where.sql} GROUP BY m.tool, m.agent`)
    .all(...where.params) as any[]) {
    const n = num(r.n);
    allCalls += n;
    allByTool.set(str(r.tool), (allByTool.get(str(r.tool)) ?? 0) + n);
    allByAgent.set(str(r.agent), (allByAgent.get(str(r.agent)) ?? 0) + n);
  }

  const byTool = new Map<string, ToolFailureBucket>();
  const byAgent = new Map<string, AgentFailureBucket>();
  const agentTools = new Map<string, Map<string, number>>();
  const calls: FailedCall[] = [];
  const repeats: FailureLoop[] = [];

  let tCalls = 0, tChars = 0, tTokens = 0, tUsd = 0, tW = 0;

  // Streak state for the repeat detector: same run, same tool, same target,
  // back to back.
  let run: FailureLoop | null = null;
  let runKey = '';
  const closeRun = () => {
    if (run && run.count >= REPEAT_MIN) repeats.push(run);
    run = null;
    runKey = '';
  };

  for (const r of rows) {
    const chars = num(r.chars);
    // The error TEXT is what a failure adds to the context. The arguments were
    // already billed as the model's own output, so counting them here would
    // charge the same tokens twice.
    const tokens = tokensOf(chars);
    const { usd } = carriedCost(tokens, num(r.turn), num(r.total), r.model);
    const weighted = toWeighted(usd);
    // Literal tokens billed: written once, then re-read on every later turn.
    const raw = tokens * (1 + Math.max(0, num(r.total) - num(r.turn)));
    const tool = str(r.tool);
    const agent = str(r.agent);

    tCalls++;
    tChars += chars;
    tTokens += tokens;
    tUsd += usd;
    tW += weighted;

    let tb = byTool.get(tool);
    if (!tb) byTool.set(tool, (tb = { tool, calls: 0, chars: 0, tokens: 0, usd: 0, weighted: 0, value: 0, errorRate: 0 }));
    tb.calls++;
    tb.chars += chars;
    tb.tokens += tokens;
    tb.usd += usd;
    tb.weighted += weighted;
    tb.value += pick(metric, usd, weighted, raw);

    let ab = byAgent.get(agent);
    if (!ab)
      byAgent.set(agent, (ab = {
        agent, calls: 0, chars: 0, tokens: 0, usd: 0, weighted: 0, value: 0, errorRate: 0, worstTool: null,
      }));
    ab.calls++;
    ab.chars += chars;
    ab.tokens += tokens;
    ab.usd += usd;
    ab.weighted += weighted;
    ab.value += pick(metric, usd, weighted, raw);

    let at = agentTools.get(agent);
    if (!at) agentTools.set(agent, (at = new Map()));
    at.set(tool, (at.get(tool) ?? 0) + usd);

    calls.push({
      tool,
      target: r.target ?? null,
      agent,
      agentId: r.aid ?? null,
      sessionId: str(r.sid),
      ts: num(r.ts),
      turn: num(r.turn),
      turnsTotal: num(r.total),
      chars,
      tokens,
      usd,
      weighted,
      value: pick(metric, usd, weighted, raw),
      error: r.error_text ?? null,
    });

    const aid = r.aid ?? 'main';
    const key = `${str(r.sid)}\u0000${aid}\u0000${tool}\u0000${r.target ?? ''}`;
    if (run && key === runKey) {
      run.count++;
      run.chars += chars;
      run.usd += usd;
      run.weighted += weighted;
      run.value += pick(metric, usd, weighted, raw);
      run.lastTs = num(r.ts);
      continue;
    }
    closeRun();
    runKey = key;
    run = {
      agentId: String(aid),
      agent,
      tool,
      target: r.target ?? null,
      sessionId: str(r.sid),
      count: 1,
      chars,
      usd,
      weighted,
      value: pick(metric, usd, weighted, raw),
      firstTs: num(r.ts),
      lastTs: num(r.ts),
    };
  }
  closeRun();

  for (const t of byTool.values()) {
    const all = allByTool.get(t.tool) ?? 0;
    t.errorRate = all ? t.calls / all : 0;
  }
  for (const a of byAgent.values()) {
    const all = allByAgent.get(a.agent) ?? 0;
    a.errorRate = all ? a.calls / all : 0;
    const tools = [...(agentTools.get(a.agent) ?? new Map()).entries()].sort((x, y) => y[1] - x[1]);
    a.worstTool = tools.length ? tools[0][0] : null;
  }

  const tRaw = calls.reduce((n, c) => n + c.tokens, 0);

  return {
    totals: {
      calls: tCalls,
      allCalls,
      errorRate: allCalls ? tCalls / allCalls : 0,
      chars: tChars,
      tokens: tTokens,
      usd: tUsd,
      weighted: tW,
      value: pick(metric, tUsd, tW, tRaw),
    },
    byTool: [...byTool.values()].sort((a, b) => b.usd - a.usd),
    byAgent: [...byAgent.values()].sort((a, b) => b.usd - a.usd),
    topCalls: calls.sort((a, b) => b.usd - a.usd).slice(0, CALL_CAP),
    repeats: repeats.sort((a, b) => b.count - a.count || b.usd - a.usd),
  };
}

// ---------------------------------------------------------------------------

function interruptionSection(db: DatabaseSync, filters: Filters, metric: Metric): InterruptionSection {
  const where = buildWhere(eventFilters(filters));
  const col = METRIC_COLUMN[metric];

  const events = db
    .prepare(
      `SELECT m.ts, m.day, m.session_id AS sid, m.agent, m.agent_id AS aid, m.file,
              m.turn, m.type, m.num1 AS out, m.text
       FROM events m ${and(where, "m.type IN ('truncated', 'interrupt')")}
       ORDER BY m.ts`
    )
    .all(...where.params) as any[];

  // A cut-off answer is not a message-sized loss: the run it belongs to spent
  // everything it spent and then failed to deliver. One file is one run, so the
  // file's own total is the honest unit — looked up in bulk, filters applied so
  // the number matches the rest of the window.
  const files = [...new Set(events.map((e) => str(e.file)))];
  const cost = new Map<string, { usd: number; weighted: number; value: number }>();
  const mw = buildWhere(filters);
  for (const batch of chunks(files)) {
    const marks = batch.map(() => '?').join(',');
    for (const r of db
      .prepare(
        `SELECT m.file AS file, sum(m.usd) AS usd, sum(m.weighted) AS w, sum(${col}) AS v
         FROM msgs m ${and(mw, `m.file IN (${marks})`)} GROUP BY m.file`
      )
      .all(...mw.params, ...batch) as any[]) {
      cost.set(str(r.file), { usd: num(r.usd), weighted: num(r.w), value: num(r.v) });
    }
  }

  const truncated: BreakRow[] = [];
  const interrupts: BreakRow[] = [];
  for (const e of events) {
    const c = cost.get(str(e.file)) ?? { usd: 0, weighted: 0, value: 0 };
    const row: BreakRow = {
      type: e.type === 'interrupt' ? 'interrupt' : 'truncated',
      agent: str(e.agent),
      agentId: e.aid ?? null,
      sessionId: str(e.sid),
      ts: num(e.ts),
      day: str(e.day),
      turn: num(e.turn),
      outputTokens: num(e.out),
      tool: e.text ?? null,
      runUsd: c.usd,
      runWeighted: c.weighted,
      runValue: c.value,
    };
    (row.type === 'interrupt' ? interrupts : truncated).push(row);
  }

  truncated.sort((a, b) => b.runUsd - a.runUsd);
  interrupts.sort((a, b) => b.runUsd - a.runUsd);

  // Summed over DISTINCT runs: a run that was cut twice was still paid for once.
  let rUsd = 0, rW = 0, rV = 0;
  for (const c of cost.values()) {
    rUsd += c.usd;
    rW += c.weighted;
    rV += c.value;
  }

  return {
    truncated,
    interrupts,
    totals: {
      truncated: truncated.length,
      interrupts: interrupts.length,
      runUsd: rUsd,
      runWeighted: rW,
      // Already summed from the metric column — billed money needs no estimate.
      runValue: rV,
    },
  };
}

// ---------------------------------------------------------------------------

export function healthReport(db: DatabaseSync, filters: Filters, metric: Metric): HealthReport {
  return {
    metric,
    compactions: compactionSection(db, filters, metric),
    throttling: throttlingSection(db, filters, metric),
    toolFailures: toolFailureSection(db, filters, metric),
    interruptions: interruptionSection(db, filters, metric),
  };
}
