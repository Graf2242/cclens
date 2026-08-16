/**
 * Four diagnostics that answer one question together: WHERE does a fleet of
 * agents lose money that a bigger context window would not have saved.
 *
 * The charts in `queries.ts` say who spent what. They cannot say whether the
 * spend was earned. Each section here compares a run against a baseline that
 * comes from the corpus itself, never from an absolute threshold — a threshold
 * would just encode today's model prices and today's habits:
 *
 *   toolCensus    — the individually most expensive tool results, priced with
 *                   their carry (`estimate.ts`): a block read on turn 2 of a
 *                   40-turn run is paid ~40 times, once as a write and then as
 *                   a cache read. The per-TOOL breakdown that used to sit here
 *                   was dropped: "Read costs the most" is true in every corpus
 *                   and names nothing anyone can change.
 *   unitCost      — dollars per unit of DELIVERED output (artifacts written,
 *                   output tokens returned). An agent that reads a library and
 *                   returns one verdict block is visible only here.
 *   outliers      — a run against the MEDIAN of its own agent's runs. The
 *                   central diagnostic: the same flow's own history is the only
 *                   baseline that survives a model swap or a prompt rewrite.
 *                   Agents whose job description is "anything" are exempt —
 *                   see `OPEN_SCOPE_AGENTS`.
 *   dispatchBlobs — one brief re-sent to N agents. Every copy after the first
 *                   is written to cache again by an agent that starts cold.
 *   runTail       — turns spent after the last artifact was written. Work that
 *                   produced nothing the caller can read is the cheapest thing
 *                   to cut and the hardest to see from inside the run.
 *
 * Two sections were removed after being read in anger and found to name no
 * action: session DOMINANCE (one agent type taking most of a fan-out — true of
 * every serialized flow and not a defect), and the Sonnet COUNTERFACTUAL (it
 * held token counts fixed, which is the one thing a different model would not
 * do, so its delta answered a question nobody could act on).
 *
 * Everything is computed from two table scans (all `msgs`, all `tools` in the
 * window) plus one session-label lookup, then aggregated in memory: the index
 * is tens of thousands of rows, and a per-run subquery would be an N+1 over a
 * table SQLite could hand over whole.
 *
 * Anything derived from characters — the census, the blobs — is an ESTIMATE at
 * `CHARS_PER_TOKEN`, and its ranking is the product, not its third digit.
 * Anything derived from `msgs` counters is exact.
 */

import type { DatabaseSync } from 'node:sqlite';

import { median } from './context.ts';
import { METRIC_COLUMN, type Metric } from './db.ts';
import { carriedCost, tokensOf, toWeighted } from './estimate.ts';
import { MAIN_AGENT } from './parse.ts';
import { PRICES, tierOf } from './pricing.ts';
import { buildWhere, type Filters } from './queries.ts';

/** Tool calls that leave something behind for the caller to read. */
const ARTIFACT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'StructuredOutput']);

const TOP = 30;
const TOP_CALLS = 50;
/** A run is an outlier at 2x its agent's own median, and only if that median
 *  rests on enough runs to be one. */
const OUTLIER_RATIO = 2;
const OUTLIER_MIN_RUNS = 5;
/**
 * Agents with no fixed job description, and therefore no meaningful median.
 *
 * The outlier test asks "did THIS dispatch of a known task go wrong?" — it only
 * means something when every run of the name does roughly the same work. The
 * main thread and `general-purpose` do whatever they were asked to: one run is
 * a two-turn question, the next is a whole refactor, and a ×5 spread between
 * them is the normal state, not a regression. Judging them produces a list
 * nobody can act on, and — because they are usually the busiest names in the
 * corpus — one that buries the specialised agents where the test does work.
 * Their spend is still reported everywhere else (unit cost, tails, census).
 */
export const OPEN_SCOPE_AGENTS = new Set<string>([MAIN_AGENT, 'general-purpose']);

// ---------------------------------------------------------------- section 1

export interface ToolCallRow {
  tool: string;
  target: string | null;
  agent: string;
  /** `agent_id`, or the literal 'main' for the main thread — with `sessionId`
   *  this is what the history view opens. */
  agentId: string;
  sessionId: string;
  ts: number;
  turn: number;
  turnsTotal: number;
  chars: number;
  tokens: number;
  writeUsd: number;
  carryUsd: number;
  usd: number;
  weighted: number;
  value: number;
  /** Turns this block was re-sent on after it landed. */
  carryTurns: number;
}

export interface ToolCensus {
  topCalls: ToolCallRow[];
  totals: {
    calls: number;
    chars: number;
    tokens: number;
    writeUsd: number;
    carryUsd: number;
    usd: number;
    weighted: number;
    value: number;
    /** How much of the bill is re-sending, not collecting. */
    carryShare: number;
  };
}

// ---------------------------------------------------------------- section 2

export interface UnitCostRow {
  agent: string;
  runs: number;
  usd: number;
  weighted: number;
  value: number;
  avgUsdPerRun: number;
  avgTurns: number;
  outputTokens: number;
  /** Dollars per 1k tokens actually returned — the "read a lot, say little" tell. */
  usdPer1kOutput: number | null;
  artifacts: number;
  usdPerArtifact: number | null;
  reads: number;
}

// ---------------------------------------------------------------- section 3

export interface OutlierRow {
  agent: string;
  agentId: string;
  sessionId: string;
  ts: number;
  model: string | null;
  turns: number;
  usd: number;
  weighted: number;
  value: number;
  /** This agent's own median run, in the window. */
  medianUsd: number;
  medianValue: number;
  /** Runs behind that median — see `OutlierAgentRow.baseRuns`. */
  baseRuns: number;
  ratio: number;
  /** Spend above the agent's own median — what the regression actually cost. */
  excessUsd: number;
  excessValue: number;
}

export interface OutlierAgentRow {
  agent: string;
  runs: number;
  /** Runs the median rests on — equal to `runs` unless a wider baseline was
   *  supplied, in which case it is the agent's whole recorded history. */
  baseRuns: number;
  outliers: number;
  medianUsd: number;
  usd: number;
  weighted: number;
  value: number;
  excessUsd: number;
}

export interface Outliers {
  runs: OutlierRow[];
  runsTotal: number;
  byAgent: OutlierAgentRow[];
  /** Where the medians came from: the report's own scope, or a wider one. */
  baseline: 'scope' | 'corpus';
  /** `OPEN_SCOPE_AGENTS` present in scope and deliberately not judged — named
   *  so the exclusion is visible in the report instead of silent. */
  unjudged: string[];
}

// ---------------------------------------------------------------- section 4

export interface DispatchBlobRow {
  hash: string;
  /** How many agents got this exact brief. */
  copies: number;
  chars: number;
  tokens: number;
  tool: string;
  target: string | null;
  agents: string[];
  sessions: number;
  /** One session that sent it, so the UI can drill in. */
  sessionId: string;
  firstTs: number;
  lastTs: number;
  /** Cache-write cost of every copy after the first, at the sender's model rate. */
  wasteUsd: number;
  wasteWeighted: number;
  wasteValue: number;
}

export interface DispatchBlobs {
  /** Briefs sent more than once — the recoverable half. */
  groups: DispatchBlobRow[];
  /** The biggest briefs, repeated or not: how heavy one dispatch payload is. */
  heaviest: DispatchBlobRow[];
  totals: {
    dispatches: number;
    groups: number;
    chars: number;
    tokens: number;
    duplicateCopies: number;
    wasteUsd: number;
    wasteWeighted: number;
    wasteValue: number;
  };
}

// ---------------------------------------------------------------- section 5

export interface RunTailRow {
  agent: string;
  agentId: string;
  sessionId: string;
  model: string | null;
  ts: number;
  turnsTotal: number;
  /** Turn of the last artifact-producing call; 0 when the run made none. */
  lastArtifactTurn: number;
  tailTurns: number;
  runUsd: number;
  tailUsd: number;
  tailWeighted: number;
  tailValue: number;
  tailShare: number;
}

export interface RunTailAgentRow {
  agent: string;
  runs: number;
  avgTailShare: number;
  runUsd: number;
  tailUsd: number;
  tailWeighted: number;
  tailValue: number;
}

export interface RunTail {
  runs: RunTailRow[];
  runsTotal: number;
  byAgent: RunTailAgentRow[];
}

export interface DiagReport {
  toolCensus: ToolCensus;
  unitCost: UnitCostRow[];
  outliers: Outliers;
  dispatchBlobs: DispatchBlobs;
  runTail: RunTail;
}

// ----------------------------------------------------------------- internals

interface MsgRow {
  ts: number;
  agent: string;
  sid: string;
  rid: string;
  model: string | null;
  usd: number;
  weighted: number;
  value: number;
  /** The only raw counter still read here: `unitCost` divides by it. */
  output: number;
}

interface ToolRow {
  ts: number;
  agent: string;
  sid: string;
  rid: string;
  model: string | null;
  tool: string;
  target: string | null;
  turn: number;
  turns_total: number;
  input_chars: number;
  input_hash: string | null;
  result_chars: number;
}

/** A dispatch: one `agent_id`, or one session's main thread. */
interface Run {
  agent: string;
  sessionId: string;
  agentId: string;
  model: string | null;
  usd: number;
  weighted: number;
  value: number;
  output: number;
  messages: { ts: number; usd: number; weighted: number; value: number }[];
  firstTs: number;
  /** From `tools.turns_total` (the whole file); falls back to billed messages
   *  for a run that never called a tool. */
  toolTurns: number;
  artifacts: number;
  reads: number;
  lastArtifactTs: number;
  lastArtifactTurn: number;
}

const key = (sid: string, rid: string): string => `${sid}\u0000${rid}`;

const pick = (metric: Metric, usd: number, weighted: number, raw: number): number =>
  metric === 'usd' ? usd : metric === 'weighted' ? weighted : raw;

/** Estimated money in the requested metric; `raw` has no dollars, only tokens. */
const estValue = (metric: Metric, usd: number, tokens: number): number =>
  pick(metric, usd, toWeighted(usd), tokens);

const safeMedian = (xs: number[]): number => (xs.length ? median(xs) : 0);

const turnsOf = (r: Run): number => r.toolTurns || r.messages.length;

/** One agent's run costs over a scope wider than the report's own. */
export interface AgentBaseline {
  usd: number[];
  value: number[];
}

/**
 * Per-agent run costs for the OUTLIER baseline, over any scope.
 *
 * Scoping the report to one session also scopes its medians to that session,
 * and a session usually holds too few runs of an agent to have one — a fan-out
 * of three is judged against itself or not judged at all. Handing `outliers` a
 * baseline built over the whole index keeps the question the same ("is this
 * dispatch a regression against how this agent normally runs?") while taking
 * the answer from the only place that has enough runs to answer it.
 *
 * Aggregated in SQL, not in memory: this walks the corpus, not the window, and
 * only two sums per run ever leave the database.
 */
export function baselineRuns(
  db: DatabaseSync,
  filters: Filters,
  metric: Metric
): Map<string, AgentBaseline> {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT m.agent AS agent, sum(m.usd) AS usd, sum(${METRIC_COLUMN[metric]}) AS value
       FROM msgs m ${where.sql}
       GROUP BY m.agent, m.session_id, coalesce(m.agent_id, 'main')`
    )
    .all(...where.params) as unknown as { agent: string; usd: number; value: number }[];

  const out = new Map<string, AgentBaseline>();
  for (const r of rows) {
    let b = out.get(r.agent);
    if (!b) out.set(r.agent, (b = { usd: [], value: [] }));
    b.usd.push(r.usd);
    b.value.push(r.value);
  }
  return out;
}

export function diagReport(
  db: DatabaseSync,
  filters: Filters,
  metric: Metric,
  baseline?: Map<string, AgentBaseline>
): DiagReport {
  const where = buildWhere(filters);
  const col = METRIC_COLUMN[metric];

  const msgs = db
    .prepare(
      `SELECT m.ts, m.agent, m.session_id AS sid, coalesce(m.agent_id, 'main') AS rid,
              m.model, m.usd, m.weighted, ${col} AS value, m.output
       FROM msgs m ${where.sql} ORDER BY m.ts`
    )
    .all(...where.params) as unknown as MsgRow[];

  const tools = db
    .prepare(
      `SELECT m.ts, m.agent, m.session_id AS sid, coalesce(m.agent_id, 'main') AS rid,
              m.model, m.tool, m.target, m.turn, m.turns_total,
              m.input_chars, m.input_hash, m.result_chars
       FROM tools m ${where.sql} ORDER BY m.ts`
    )
    .all(...where.params) as unknown as ToolRow[];

  const runs = new Map<string, Run>();
  const runOf = (sid: string, rid: string, agent: string, model: string | null, ts: number): Run => {
    const k = key(sid, rid);
    let r = runs.get(k);
    if (!r) {
      runs.set(
        k,
        (r = {
          agent, sessionId: sid, agentId: rid, model,
          usd: 0, weighted: 0, value: 0, output: 0, messages: [],
          firstTs: ts, toolTurns: 0, artifacts: 0, reads: 0,
          lastArtifactTs: 0, lastArtifactTurn: 0,
        })
      );
    }
    return r;
  };

  for (const m of msgs) {
    const r = runOf(m.sid, m.rid, m.agent, m.model, m.ts);
    // The first billed message names the model; a run that switched mid-way is
    // rare enough that the first one is the honest label.
    r.model ??= m.model;
    r.usd += m.usd;
    r.weighted += m.weighted;
    r.value += m.value;
    r.output += m.output;
    r.messages.push({ ts: m.ts, usd: m.usd, weighted: m.weighted, value: m.value });
  }

  // The census walks `tools` and fills in each run's turn count, artifact and
  // read tallies on the way, so it has to run before anything reading those.
  const toolCensus = census(tools, metric, runOf);

  return {
    toolCensus,
    unitCost: unitCost(runs),
    outliers: outliers(runs, baseline),
    dispatchBlobs: blobs(tools, metric),
    runTail: runTail(runs),
  };
}

/**
 * The individually most expensive tool results, and what carrying them cost.
 *
 * Only calls that brought something back count — a `Write` pays for its input,
 * not for the "File created" it returns, and that side is the blob census.
 * Artifact and read counts, on the other hand, are taken from EVERY call,
 * because a zero-length result is still a call that happened.
 *
 * Ranking is by the CALL, not by the tool. A per-tool total always ranks `Read`
 * first in every corpus, which is a fact about what agents do rather than about
 * where this fleet's money went; a single call names a turn, a file and a run,
 * and that is the granularity a person can act on.
 */
function census(
  tools: ToolRow[],
  metric: Metric,
  runOf: (sid: string, rid: string, agent: string, model: string | null, ts: number) => Run
): ToolCensus {
  const calls: ToolCallRow[] = [];
  let calln = 0, chars = 0, tokens = 0, writeUsd = 0, carryUsd = 0;

  for (const t of tools) {
    const run = runOf(t.sid, t.rid, t.agent, t.model, t.ts);
    run.toolTurns = Math.max(run.toolTurns, t.turns_total);
    if (t.tool === 'Read') run.reads++;
    if (ARTIFACT_TOOLS.has(t.tool)) {
      run.artifacts++;
      if (t.ts >= run.lastArtifactTs) {
        run.lastArtifactTs = t.ts;
        run.lastArtifactTurn = t.turn;
      }
    }
    if (t.result_chars <= 0) continue;

    const tok = tokensOf(t.result_chars);
    const c = carriedCost(tok, t.turn, t.turns_total, t.model);
    calln++;
    chars += t.result_chars;
    tokens += tok;
    writeUsd += c.writeUsd;
    carryUsd += c.carryUsd;

    calls.push({
      tool: t.tool, target: t.target, agent: t.agent, agentId: t.rid, sessionId: t.sid,
      ts: t.ts, turn: t.turn, turnsTotal: t.turns_total,
      chars: t.result_chars, tokens: tok,
      writeUsd: c.writeUsd, carryUsd: c.carryUsd, usd: c.usd,
      weighted: toWeighted(c.usd), value: estValue(metric, c.usd, tok),
      carryTurns: c.carryTurns,
    });
  }

  const usd = writeUsd + carryUsd;
  calls.sort((a, b) => b.usd - a.usd);

  return {
    topCalls: calls.slice(0, TOP_CALLS),
    totals: {
      calls: calln, chars, tokens, writeUsd, carryUsd, usd,
      weighted: toWeighted(usd), value: estValue(metric, usd, tokens),
      carryShare: usd > 0 ? carryUsd / usd : 0,
    },
  };
}

/**
 * Price per unit of delivered output.
 *
 * Two denominators, because agents deliver two different things: artifacts for
 * the ones that write files, output tokens for the ones that return a verdict.
 * An agent that is expensive on both read a great deal to say very little.
 */
function unitCost(runs: Map<string, Run>): UnitCostRow[] {
  const agg = new Map<string, UnitCostRow & { turns: number }>();
  for (const r of runs.values()) {
    let a = agg.get(r.agent);
    if (!a) {
      agg.set(r.agent, (a = {
        agent: r.agent, runs: 0, usd: 0, weighted: 0, value: 0, avgUsdPerRun: 0,
        avgTurns: 0, outputTokens: 0, usdPer1kOutput: null, artifacts: 0,
        usdPerArtifact: null, reads: 0, turns: 0,
      }));
    }
    a.runs++;
    a.usd += r.usd;
    a.weighted += r.weighted;
    a.value += r.value;
    a.outputTokens += r.output;
    a.artifacts += r.artifacts;
    a.reads += r.reads;
    a.turns += turnsOf(r);
  }
  return [...agg.values()]
    .map((a) => {
      const { turns, ...row } = a;
      row.avgUsdPerRun = row.runs ? row.usd / row.runs : 0;
      row.avgTurns = row.runs ? turns / row.runs : 0;
      row.usdPer1kOutput = row.outputTokens > 0 ? (row.usd * 1000) / row.outputTokens : null;
      row.usdPerArtifact = row.artifacts > 0 ? row.usd / row.artifacts : null;
      return row;
    })
    .sort((a, b) => b.usd - a.usd);
}

/**
 * Regression against an agent's OWN history.
 *
 * No absolute dollar threshold: a `tech-designer` run costing $12 is normal and
 * a `recon-merger` run costing $12 is a bug, and only the agent's own median
 * knows which. The median needs enough runs to be a median, so agents with
 * fewer than five dispatches behind the median are not judged at all rather
 * than judged badly — and neither are the open-scope names, whose runs share a
 * label but not a task (`OPEN_SCOPE_AGENTS`).
 *
 * With a `base` the medians come from a WIDER scope than the runs being judged
 * — that is what makes the section work inside one session, where an agent's
 * three dispatches are not a history. The runs reported are still only the
 * ones in scope: the baseline changes what "normal" means, never who is shown.
 */
function outliers(runs: Map<string, Run>, base?: Map<string, AgentBaseline>): Outliers {
  const byAgent = new Map<string, Run[]>();
  for (const r of runs.values()) {
    const list = byAgent.get(r.agent);
    if (list) list.push(r);
    else byAgent.set(r.agent, [r]);
  }

  const out: OutlierRow[] = [];
  const agents: OutlierAgentRow[] = [];
  const unjudged: string[] = [];
  for (const [agent, list] of byAgent) {
    // A name that covers any task has no normal run size — see OPEN_SCOPE_AGENTS.
    if (OPEN_SCOPE_AGENTS.has(agent)) {
      unjudged.push(agent);
      continue;
    }
    // An agent absent from the baseline has no history to be judged against;
    // falling back to its in-scope runs would silently re-introduce the very
    // self-comparison the baseline exists to replace.
    const sample = base ? base.get(agent) : { usd: list.map((r) => r.usd), value: list.map((r) => r.value) };
    if (!sample || sample.usd.length < OUTLIER_MIN_RUNS) continue;
    const medUsd = safeMedian(sample.usd);
    const medValue = safeMedian(sample.value);
    // A zero median (synthetic-only runs) would make every paid run an outlier.
    if (medUsd <= 0) continue;

    const hits = list.filter((r) => r.usd >= OUTLIER_RATIO * medUsd);
    if (!hits.length) continue;
    for (const r of hits) {
      out.push({
        agent, agentId: r.agentId, sessionId: r.sessionId, ts: r.firstTs,
        model: r.model, turns: turnsOf(r),
        usd: r.usd, weighted: r.weighted, value: r.value,
        medianUsd: medUsd, medianValue: medValue, baseRuns: sample.usd.length,
        ratio: r.usd / medUsd,
        excessUsd: r.usd - medUsd,
        excessValue: r.value - medValue,
      });
    }
    agents.push({
      agent, runs: list.length, baseRuns: sample.usd.length, outliers: hits.length, medianUsd: medUsd,
      usd: hits.reduce((s, r) => s + r.usd, 0),
      weighted: hits.reduce((s, r) => s + r.weighted, 0),
      value: hits.reduce((s, r) => s + r.value, 0),
      excessUsd: hits.reduce((s, r) => s + r.usd - medUsd, 0),
    });
  }

  out.sort((a, b) => b.excessUsd - a.excessUsd);
  agents.sort((a, b) => b.excessUsd - a.excessUsd);
  unjudged.sort();
  return {
    runs: out.slice(0, TOP),
    runsTotal: out.length,
    byAgent: agents,
    baseline: base ? 'corpus' : 'scope',
    unjudged,
  };
}

/**
 * One brief, many recipients.
 *
 * `input_hash` is only set for dispatch-shaped calls with a substantial
 * argument, so a group is literally the same text handed to N cold agents.
 * Only the WRITE side is charged here: each recipient caches its own copy, and
 * that half is what a shared prefix would remove. The carry half stays with
 * whoever received it and is not waste of this kind.
 */
function blobs(tools: ToolRow[], metric: Metric): DispatchBlobs {
  const groups = new Map<string, DispatchBlobRow & { agentSet: Set<string>; sessionSet: Set<string>; model: string | null }>();
  let dispatches = 0, chars = 0, tokens = 0;

  for (const t of tools) {
    if (!t.input_hash) continue;
    dispatches++;
    chars += t.input_chars;
    tokens += tokensOf(t.input_chars);

    let g = groups.get(t.input_hash);
    if (!g) {
      groups.set(t.input_hash, (g = {
        hash: t.input_hash, copies: 0, chars: t.input_chars, tokens: tokensOf(t.input_chars),
        tool: t.tool, target: t.target, agents: [], sessions: 0, sessionId: t.sid,
        firstTs: t.ts, lastTs: t.ts, wasteUsd: 0, wasteWeighted: 0, wasteValue: 0,
        agentSet: new Set(), sessionSet: new Set(), model: t.model,
      }));
    }
    g.copies++;
    g.agentSet.add(t.agent);
    g.sessionSet.add(t.sid);
    g.lastTs = Math.max(g.lastTs, t.ts);
    g.target ??= t.target;
  }

  let wasteUsd = 0, wasteTokens = 0, duplicateCopies = 0;
  const rows = [...groups.values()].map((g) => {
    const { agentSet, sessionSet, model, ...row } = g;
    row.agents = [...agentSet];
    row.sessions = sessionSet.size;
    const extra = row.copies - 1;
    // Index 2 of a PriceRow is the 5-minute cache-write rate: what a cold agent
    // pays to put its own copy of the brief into its own context.
    row.wasteUsd = (extra * row.tokens * PRICES[tierOf(model)][2]) / 1e6;
    row.wasteWeighted = toWeighted(row.wasteUsd);
    row.wasteValue = estValue(metric, row.wasteUsd, extra * row.tokens);
    wasteUsd += row.wasteUsd;
    wasteTokens += extra * row.tokens;
    duplicateCopies += extra;
    return row;
  });
  rows.sort((a, b) => b.wasteUsd - a.wasteUsd || b.chars - a.chars);

  // Identical briefs turn out to be rare: a dispatch usually differs from its
  // siblings by a line. The other half of the pie-evolution "state blob"
  // question survives that — how BIG is the payload the orchestrator re-sends
  // per dispatch at all — so the heaviest briefs are reported whether or not
  // anyone repeated them.
  const heaviest = [...rows].sort((a, b) => b.chars - a.chars).slice(0, TOP);

  return {
    groups: rows.filter((r) => r.copies > 1).slice(0, TOP),
    heaviest,
    totals: {
      dispatches, groups: rows.length, chars, tokens, duplicateCopies,
      wasteUsd, wasteWeighted: toWeighted(wasteUsd),
      wasteValue: estValue(metric, wasteUsd, wasteTokens),
    },
  };
}

/**
 * What a run spent after it had nothing left to deliver.
 *
 * The boundary is the last artifact-producing call. Turns in `msgs` are not
 * numbered, so the cut is by TIMESTAMP: every billed message later than that
 * call belongs to the tail — wrap-up prose, a summary of what was already
 * written, a re-read of the file just saved.
 *
 * A run that wrote NOTHING is skipped, not counted as 100% tail. It used to be
 * listed with a badge, and it drowned the section: a reviewer, a router or a
 * matcher returning only prose is doing exactly its job, so "no artifact" is a
 * fact about the agent's contract and not a finding about this dispatch. What
 * is left is the question the section was for — a run that HAD something to
 * deliver, delivered it, and then kept going.
 */
function runTail(runs: Map<string, Run>): RunTail {
  const rows: RunTailRow[] = [];
  for (const r of runs.values()) {
    if (!r.messages.length || r.lastArtifactTs === 0) continue;
    let usd = 0, weighted = 0, value = 0;
    for (const m of r.messages) {
      if (m.ts > r.lastArtifactTs) {
        usd += m.usd;
        weighted += m.weighted;
        value += m.value;
      }
    }
    const turnsTotal = turnsOf(r);
    rows.push({
      agent: r.agent, agentId: r.agentId, sessionId: r.sessionId, model: r.model,
      ts: r.firstTs, turnsTotal,
      lastArtifactTurn: r.lastArtifactTurn,
      tailTurns: Math.max(0, turnsTotal - r.lastArtifactTurn),
      runUsd: r.usd, tailUsd: usd, tailWeighted: weighted, tailValue: value,
      tailShare: r.usd > 0 ? usd / r.usd : 0,
    });
  }

  const agg = new Map<string, RunTailAgentRow & { shareSum: number }>();
  for (const row of rows) {
    let a = agg.get(row.agent);
    if (!a) {
      agg.set(row.agent, (a = {
        agent: row.agent, runs: 0, avgTailShare: 0,
        runUsd: 0, tailUsd: 0, tailWeighted: 0, tailValue: 0, shareSum: 0,
      }));
    }
    a.runs++;
    a.runUsd += row.runUsd;
    a.tailUsd += row.tailUsd;
    a.tailWeighted += row.tailWeighted;
    a.tailValue += row.tailValue;
    a.shareSum += row.tailShare;
  }
  const byAgent = [...agg.values()]
    .map((a) => {
      const { shareSum, ...row } = a;
      row.avgTailShare = row.runs ? shareSum / row.runs : 0;
      return row;
    })
    .sort((a, b) => b.tailUsd - a.tailUsd);

  rows.sort((a, b) => b.tailUsd - a.tailUsd);
  return { runs: rows.slice(0, TOP), runsTotal: rows.length, byAgent };
}
