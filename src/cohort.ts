/**
 * What a FLEET of sibling agents collected, and how much of it was the same
 * thing collected over and over.
 *
 * `context.ts` answers "what is in this one run's context". This answers the
 * question one level up: a workflow dispatches thirty `test-writer` subagents,
 * each starts cold, and each independently reads the adapter doc, the mechanic
 * design and the same six rule files before writing a line. Nothing in a single
 * run's report can see that — inside its own context each read happened once.
 * Across the cohort it happened thirty-one times, and thirty of those were paid
 * for nothing but isolation.
 *
 * The unit of duplication is CONTENT, not the file path: two agents that read
 * the same file get byte-identical tool results, and hashing the normalised
 * text finds them without trusting the path (a `Read` of the same doc under two
 * different absolute paths, or the same text arriving via `Read` in one agent
 * and `Grep` in another, still collapses into one group). Paths are then used
 * only as the label, because that is what a human recognises.
 *
 * Cost is not the block's size — it is the size times how long it was CARRIED.
 * A 12k doc read on turn 2 of a 40-turn run is written to cache once and then
 * re-sent as a cache read on all 38 turns that follow; on Opus the carry is the
 * larger half of the bill. So each copy is priced as one write plus its actual
 * re-sends, and a doc read early by a long run costs several times what the
 * same doc costs a run that read it last.
 *
 * The total splits into two halves that need DIFFERENT fixes, so it is reported
 * split:
 *
 *   write — each copy is written to cache by its own agent, at 12.5x the read
 *     rate. This half is recoverable by prefix sharing, and Claude Code already
 *     proves the mechanism works: siblings of one agent type start with an
 *     identical system prompt + tool schemas, and on the measured fan-out 22 of
 *     32 subagents read ~12k of it from a sibling's cache entry on their very
 *     first turn. Material collected once and placed in that identical prefix
 *     would be read, not re-written, by everyone after the first.
 *
 *   carry — every agent re-sends its copy on every later turn. This half is NOT
 *     recoverable by sharing a prefix: the tokens sit in each agent's own
 *     context window either way. It falls only to fewer agents, a smaller
 *     payload (a digest instead of the sources), or fewer turns.
 *
 * And prefix-loading is not free even for the write half. A block the agent
 * would have read on turn k is instead carried from turn 1, so the saving is
 * `tokens * (writeRate - k * readRate)` — break-even at k = writeRate/readRate,
 * 12.5 turns on Opus. Loading a doc the agents only reach on turn 30 into the
 * shared prefix LOSES money. `prefixRecoverable` therefore counts only the
 * copies where the trade actually pays.
 */

import fs from 'node:fs';
import { t } from './i18n.ts';
import readline from 'node:readline';
import crypto from 'node:crypto';

import { cutSegments, fitCharsPerToken, median } from './context.ts';
import { rawOf, usdOf, weightedOf, ZERO, type Counters } from './pricing.ts';
import type { Metric } from './db.ts';

/** Below this a block is noise: a one-line grep hit repeated is not a finding. */
const MIN_CHARS = 1500;
const PREVIEW = 140;

export interface CohortMember {
  runId: string;
  ts: number;
  /** Turns that re-sent this block after it landed, inside its own window. */
  resends: number;
  /** Turn this block landed on — how early a shared prefix would have to hold it. */
  turn: number;
  tokens: number;
  value: number;
  /** Cost of writing this copy to cache: the half a shared prefix recovers. */
  writeValue: number;
}

/** One distinct piece of text, and every run that paid to collect it. */
export interface CohortItem {
  hash: string;
  tool: string;
  /** File path, pattern or command — whatever identifies what was fetched. */
  target: string;
  preview: string;
  chars: number;
  tokens: number;
  runs: number;
  copies: number;
  /** Carrying every copy, in the requested metric. */
  value: number;
  /** Every copy but the cheapest — what the isolation added. */
  wasted: number;
  /** …of which re-writing to cache, the part a shared prefix would recover. */
  wastedWrite: number;
  /** …and what moving it into that prefix nets, after the earlier carry. */
  prefixRecoverable: number;
  members: CohortMember[];
}

/** Items rolled up to the thing a human names: one file, one command. */
export interface CohortSource {
  tool: string;
  target: string;
  label: string;
  preview: string;
  /** Distinct contents behind this label — >1 means partial or changed reads. */
  variants: number;
  tokens: number;
  runs: number;
  copies: number;
  value: number;
  wasted: number;
  wastedWrite: number;
  prefixRecoverable: number;
  /** Median turn the copies landed on — under the break-even, a prefix pays. */
  medianTurn: number;
  runIds: string[];
}

export interface CohortRun {
  runId: string;
  ts: number;
  turns: number;
  charsPerToken: number;
  /** Sizable blocks this run collected. */
  collected: number;
  /** …of which also collected by at least one sibling. */
  shared: number;
  value: number;
}

export interface CohortReport {
  agent: string;
  workflowId: string | null;
  runs: number;
  /** Runs big enough to have collected anything — the denominator for "N of M". */
  activeRuns: number;
  metric: Metric;
  charsPerToken: number;
  /** Sizable collected blocks, deduped inside each run, in tokens. */
  collectedTokens: number;
  sharedTokens: number;
  /** Carry cost of every sizable block the cohort collected. */
  collectedValue: number;
  /** What the redundant copies cost in total — write plus carry. */
  wastedValue: number;
  /** Re-writing the same bytes in each agent: the half prefix sharing removes. */
  wastedWrite: number;
  /** Re-sending them turn after turn: the half it does not. */
  wastedCarry: number;
  /**
   * Net return of collecting once and putting it in the agents' shared prompt
   * prefix — write converted to a read, minus carrying it from turn 1, counted
   * only where that trade wins.
   */
  prefixRecoverable: number;
  /** Turns past which prefix-loading stops paying: writeRate / readRate. */
  breakEvenTurn: number;
  /** What the cohort really spent, from the index, for honest framing. */
  actualValue: number;
  sources: CohortSource[];
  items: CohortItem[];
  perRun: CohortRun[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const hashOf = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

/** The argument that says what a call went after — same order as `runs.ts`. */
function targetOf(input: any): string {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'path', 'pattern', 'command', 'query', 'skill', 'url', 'prompt']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return norm(v).slice(0, 200);
  }
  return '';
}

/** Last two path segments — enough to recognise a file, short enough to read. */
function shortTarget(target: string): string {
  if (!target) return '';
  const parts = target.split(/[/\\]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : target;
}

interface RawItem {
  ts: number;
  tool: string;
  target: string;
  text: string;
}

interface ParsedRun {
  runId: string;
  items: RawItem[];
  turns: { ts: number; context: number }[];
  /** Characters that arrived before each turn — the fit's x axis. */
  charsBefore: number[];
  model: string | null;
  /** Whether this run's cache writes went to the 1h bucket. */
  longTtl: boolean;
}

async function parseRun(runId: string, files: string[]): Promise<ParsedRun> {
  const toolName = new Map<string, string>();
  const toolTarget = new Map<string, string>();
  const items: RawItem[] = [];
  const turns: { ts: number; context: number }[] = [];
  const charsBefore: number[] = [];
  const seen = new Set<string>();
  let model: string | null = null;
  let w1h = 0;
  let w5m = 0;
  let pending = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;

      if (o.type === 'attachment' && o.attachment) {
        const text = str(o.attachment.content ?? o.attachment);
        pending += text.length;
        items.push({ ts, tool: String(o.attachment.type ?? 'attachment'), target: '', text });
        continue;
      }

      if (o.type === 'user' && o.message) {
        const c = o.message.content;
        if (typeof c === 'string') {
          pending += c.length;
          items.push({ ts, tool: t('context.origin.prompt'), target: '', text: c });
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b?.type === 'tool_result') {
              const text =
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('')
                    : str(b.content);
              pending += text.length;
              items.push({
                ts,
                tool: toolName.get(b.tool_use_id) ?? '?',
                target: toolTarget.get(b.tool_use_id) ?? '',
                text,
              });
            } else if (b?.type === 'text' && b.text) {
              pending += b.text.length;
              items.push({ ts, tool: t('context.origin.prompt'), target: '', text: b.text });
            }
          }
        }
        continue;
      }

      if (o.type !== 'assistant' || !o.message) continue;
      model ??= o.message.model ?? null;

      for (const b of o.message.content ?? []) {
        if (b?.type === 'text') pending += (b.text ?? '').length;
        else if (b?.type === 'thinking') pending += (b.thinking ?? '').length;
        else if (b?.type === 'tool_use') {
          if (b.id) {
            toolName.set(b.id, b.name);
            toolTarget.set(b.id, targetOf(b.input));
          }
          pending += str(b.input).length;
        }
      }

      // One turn spans several lines, all repeating one `message.id` and one
      // usage — the same rule the indexer and `runs.ts` apply.
      const id: string = o.message.id ?? o.uuid;
      const u = o.message.usage;
      if (u && id && !seen.has(id)) {
        seen.add(id);
        const cc = u.cache_creation ?? {};
        w1h += cc.ephemeral_1h_input_tokens ?? 0;
        w5m += cc.ephemeral_5m_input_tokens ?? 0;
        turns.push({
          ts,
          context:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (cc.ephemeral_5m_input_tokens ?? 0) +
            (cc.ephemeral_1h_input_tokens ?? 0),
        });
        charsBefore.push(pending);
        pending = 0;
      }
    }
  }

  items.sort((a, b) => a.ts - b.ts);
  return { runId, items, turns, charsBefore, model, longTtl: w1h > w5m };
}

/**
 * How many turns re-READ a block after it landed — the carry.
 *
 * The first turn after the block arrived is the one that writes it to cache and
 * is therefore not a re-send; every turn after that one re-reads it. Bounded by
 * the block's own context window: a compaction throws the history away, so
 * turns past the cut never re-sent it and must not be billed for it.
 */
function resendsAt(turns: { ts: number; context: number }[], segEnd: number[], ts: number): number {
  let i = 0;
  while (i < turns.length && turns[i].ts <= ts) i++;
  if (i >= turns.length) return 0;
  return Math.max(0, segEnd[i] - i);
}

/**
 * Run `fn` over the list with at most `limit` in flight, results in input order.
 *
 * A cohort is dozens of files, and read in series each one waits for the
 * previous — on a cold cache that serialisation is the whole latency, and it
 * is the only case where opening the panel feels slow.
 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    })
  );
  return out;
}

const READ_CONCURRENCY = 8;

export async function cohortReport(
  runs: { runId: string; files: string[] }[],
  opts: { metric?: Metric; agent?: string; workflowId?: string | null; actualValue?: number; limit?: number } = {}
): Promise<CohortReport> {
  const metric = opts.metric ?? 'usd';
  const limit = opts.limit ?? 40;

  const valueOf = (c: Counters, model: string | null) =>
    metric === 'usd' ? usdOf(c, model) : metric === 'weighted' ? weightedOf(c, model) : rawOf(c);

  interface Copy {
    runId: string;
    ts: number;
    resends: number;
    turn: number;
    tokens: number;
    value: number;
    writeValue: number;
    /** Net gain of hoisting this copy into a shared prefix; may be negative. */
    prefixGain: number;
    tool: string;
    target: string;
    chars: number;
    preview: string;
  }

  const perRun: CohortRun[] = [];
  const copiesByHash = new Map<string, Copy[]>();
  const cpts: number[] = [];
  // The cohort's price sheet: one model and one cache bucket across siblings.
  let cohortModel: string | null = null;
  let cohortLongTtl = false;

  // Each run is parsed and immediately reduced to copies, so what is retained
  // is bounded by the runs in flight rather than by the whole cohort. Measured
  // on the corpus's largest fan-out (63 runs): 1.4s either way on a warm cache,
  // peak heap 141 MB against 85 MB when read one at a time — the concurrency
  // buys nothing here, where the work is JSON parsing, and everything on a cold
  // cache, where reading files in series leaves the disk idle between them.
  await mapPool(runs, READ_CONCURRENCY, async (r) => {
    const p = await parseRun(r.runId, r.files);
    cohortModel ??= p.model;
    cohortLongTtl ||= p.longTtl;
    // Same fit as the single-run report: characters per token from how much the
    // context GREW against how much text arrived, median over the pairs.
    const segs = cutSegments(p.turns.map((t) => t.context));
    const inSeg = (i: number) => segs.some((s) => i - 1 >= s.from && i <= s.to);
    const { charsPerToken } = fitCharsPerToken(
      p.turns
        .slice(1)
        .map((t, i) => ({ i: i + 1, chars: p.charsBefore[i + 1] ?? 0, tokens: t.context - p.turns[i].context }))
        .filter((x) => inSeg(x.i))
    );
    cpts.push(charsPerToken);

    // For every turn, the last turn of its window — the carry stops there.
    const segEnd: number[] = new Array(p.turns.length).fill(Math.max(0, p.turns.length - 1));
    for (const s of segs) for (let i = s.from; i <= s.to; i++) segEnd[i] = s.to;

    let collected = 0;
    let value = 0;
    // A run that reads one file twice paid twice, but for "which runs share
    // this" it counts once — otherwise one sloppy run reads as a whole cohort.
    const seenHere = new Set<string>();

    for (const it of p.items) {
      if (it.text.length < MIN_CHARS) continue;
      const hash = hashOf(norm(it.text));
      const tokens = Math.round(it.text.length / charsPerToken);
      const resends = resendsAt(p.turns, segEnd, it.ts);
      const writeKey = p.longTtl ? 'cacheWrite1h' : 'cacheWrite5m';
      // Written to cache once, then re-read on every turn that follows it.
      const carried: Counters = { ...ZERO, [writeKey]: tokens, cacheRead: tokens * resends };
      const v = valueOf(carried, p.model);
      const writeValue = valueOf({ ...ZERO, [writeKey]: tokens }, p.model);
      // Hoisted into a shared prefix this copy is read instead of written, but
      // it is then carried from turn 1 rather than from the turn it was read.
      const turn = Math.max(1, p.turns.length - resends);
      const prefixGain =
        writeValue - valueOf({ ...ZERO, cacheRead: tokens * (turn - 1) }, p.model);
      if (!seenHere.has(hash)) {
        seenHere.add(hash);
        collected += tokens;
        value += v;
      }
      const list = copiesByHash.get(hash) ?? [];
      // Only the preview is kept, never the block itself: copies of one hash
      // are identical by construction, so one 140-char sample describes them
      // all and the megabytes go out of scope with this run.
      list.push({
        runId: p.runId, ts: it.ts, resends, turn, tokens,
        value: v, writeValue, prefixGain,
        tool: it.tool, target: it.target,
        chars: it.text.length, preview: norm(it.text).slice(0, PREVIEW),
      });
      copiesByHash.set(hash, list);
    }

    perRun.push({
      runId: p.runId,
      ts: p.turns[0]?.ts ?? 0,
      turns: p.turns.length,
      charsPerToken,
      collected,
      shared: 0,
      value,
    });
  });

  const byRun = new Map(perRun.map((r) => [r.runId, r]));

  const items: CohortItem[] = [];
  for (const [hash, copies] of copiesByHash) {
    const runIds = new Set(copies.map((c) => c.runId));
    if (runIds.size < 2) continue;
    // Runs are now read concurrently, so "whichever landed first" is not a
    // stable choice — the earliest copy by clock is.
    const first = copies.reduce((a, b) => (b.ts < a.ts ? b : a));
    // One run may hold several copies; the cohort keeps the cheapest single
    // carry and everything else is what the isolation added.
    const total = copies.reduce((s, c) => s + c.value, 0);
    const cheapest = copies.reduce((a, b) => (b.value < a.value ? b : a));
    const rest = copies.filter((c) => c !== cheapest);
    for (const id of runIds) {
      const r = byRun.get(id);
      if (r) r.shared += copies.find((c) => c.runId === id)!.tokens;
    }
    items.push({
      hash,
      tool: first.tool,
      target: first.target,
      preview: first.preview,
      chars: first.chars,
      tokens: Math.round(median(copies.map((c) => c.tokens))),
      runs: runIds.size,
      copies: copies.length,
      value: total,
      wasted: total - cheapest.value,
      wastedWrite: rest.reduce((s, c) => s + c.writeValue, 0),
      // A copy the agent only reaches late costs more in the prefix than it
      // saves, and the sane response is to leave that one alone — so a losing
      // trade contributes nothing rather than eating the winners' gain.
      prefixRecoverable: rest.reduce((s, c) => s + Math.max(0, c.prefixGain), 0),
      members: copies
        .map((c) => ({
          runId: c.runId, ts: c.ts, resends: c.resends, turn: c.turn,
          tokens: c.tokens, value: c.value, writeValue: c.writeValue,
        }))
        .sort((a, b) => b.value - a.value),
    });
  }
  items.sort((a, b) => b.wasted - a.wasted);

  // Roll up to the label a human recognises. Grouping is by content, so two
  // different reads of one file stay two items but land in one source row.
  const sourceMap = new Map<string, CohortSource & { runSet: Set<string>; turns: number[] }>();
  for (const it of items) {
    const key = it.tool + ' ' + (it.target || it.preview.slice(0, 60));
    const s =
      sourceMap.get(key) ??
      ({
        tool: it.tool,
        target: it.target,
        label: shortTarget(it.target) || it.preview.slice(0, 60),
        preview: it.preview,
        variants: 0,
        tokens: 0,
        runs: 0,
        copies: 0,
        value: 0,
        wasted: 0,
        wastedWrite: 0,
        prefixRecoverable: 0,
        medianTurn: 0,
        runIds: [],
        runSet: new Set<string>(),
        turns: [] as number[],
      } as CohortSource & { runSet: Set<string>; turns: number[] });
    s.variants++;
    s.tokens = Math.max(s.tokens, it.tokens);
    s.copies += it.copies;
    s.value += it.value;
    s.wasted += it.wasted;
    s.wastedWrite += it.wastedWrite;
    s.prefixRecoverable += it.prefixRecoverable;
    for (const m of it.members) {
      s.runSet.add(m.runId);
      s.turns.push(m.turn);
    }
    sourceMap.set(key, s);
  }
  const sources: CohortSource[] = [...sourceMap.values()]
    .map(({ runSet, turns, ...s }) => ({
      ...s,
      runs: runSet.size,
      runIds: [...runSet],
      medianTurn: Math.round(median(turns)) || 0,
    }))
    .sort((a, b) => b.wasted - a.wasted);

  const collectedTokens = perRun.reduce((s, r) => s + r.collected, 0);
  const collectedValue = perRun.reduce((s, r) => s + r.value, 0);
  const wastedValue = items.reduce((s, i) => s + i.wasted, 0);
  const wastedWrite = items.reduce((s, i) => s + i.wastedWrite, 0);

  // The break-even is a property of the price sheet, not of this cohort: a
  // write costs `writeRate/readRate` reads, so hoisting a block into a shared
  // prefix pays exactly while the agents would have read it before that turn.
  const one: Counters = { ...ZERO, [cohortLongTtl ? 'cacheWrite1h' : 'cacheWrite5m']: 1 };
  const breakEvenTurn = valueOf(one, cohortModel) / valueOf({ ...ZERO, cacheRead: 1 }, cohortModel);

  return {
    agent: opts.agent ?? '',
    workflowId: opts.workflowId ?? null,
    runs: runs.length,
    activeRuns: perRun.filter((r) => r.collected > 0).length,
    metric,
    charsPerToken: median(cpts) || 0,
    collectedTokens,
    sharedTokens: perRun.reduce((s, r) => s + r.shared, 0),
    collectedValue,
    wastedValue,
    wastedWrite,
    wastedCarry: wastedValue - wastedWrite,
    prefixRecoverable: items.reduce((s, i) => s + i.prefixRecoverable, 0),
    breakEvenTurn,
    actualValue: opts.actualValue ?? 0,
    sources: sources.slice(0, limit),
    items: items.slice(0, limit),
    perRun: perRun.sort((a, b) => a.ts - b.ts),
  };
}
