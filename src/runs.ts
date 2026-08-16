/**
 * One agent run, reconstructed from its JSONL on demand.
 *
 * The index stores counters, not content — content is read here, only for the
 * run you actually opened. That keeps a 1 GB corpus in a 4 MB index while the
 * history view still shows what the agent was doing.
 *
 * The same de-duplication rule as the indexer applies, but with the opposite
 * intent: an assistant turn spans several lines (text, thinking, each
 * tool_use), all carrying one `message.id` and one identical `usage`. The
 * indexer keeps the first and drops the rest; here we MERGE them, so a step is
 * one turn with all its blocks and its usage counted once.
 */

import fs from 'node:fs';
import readline from 'node:readline';

import {
  missCause,
  rewrittenTokens,
  ttlOf,
  type CacheTtl,
  type MissCause,
} from './cachemiss.ts';
import { toolBrief } from './parse.ts';
import { rawOf, usdOf, weightedOf, ZERO, type Counters } from './pricing.ts';
import type { Metric } from './db.ts';

const TEXT_LIMIT = 600;

/**
 * A turn that re-writes what the previous turn had already cached. Nothing
 * about the conversation changed — the same tokens are just billed at the
 * write rate instead of the read rate, 12.5x more. Why the entry was gone is
 * a separate question, answered by `cause`.
 */
export interface CacheMiss {
  /** Tokens re-written that the previous turn had already paid to cache. */
  tokens: number;
  /** Idle time before this turn. */
  idleMs: number;
  /** The TTL this turn's write actually used. */
  ttl: CacheTtl;
  /** Pause outlived the TTL, or the prefix was dropped for another reason. */
  cause: MissCause;
  /** Extra spend versus reading those tokens, in the requested metric. */
  extra: number;
  extraUsd: number;
}

export interface ToolCall {
  name: string;
  /** The one argument worth seeing at a glance: a path, a pattern, a command. */
  target: string | null;
  /** Full length of that argument, whatever `target` was clipped to. */
  targetChars?: number;
  /** Every other argument — what tells two calls of the same tool apart. */
  detail?: string | null;
}

export interface RunStep {
  ts: number;
  kind: 'prompt' | 'assistant' | 'tool_result';
  /** Assistant only: tokens actually sent to the API for this turn. */
  context?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Which bucket this turn's write was billed to. */
  cacheTtl?: CacheTtl;
  value?: number;
  usd?: number;
  /** Set when this turn paid to re-cache a context the previous turn had cached. */
  cacheMiss?: CacheMiss | null;
  model?: string | null;
  thinkingChars?: number;
  text?: string | null;
  truncated?: boolean;
  tools?: ToolCall[];
  /** Tool result only: the call it answers, resolved through `tool_use_id`. */
  toolName?: string | null;
  toolTarget?: string | null;
  isError?: boolean;
  /** What the result says about its own shape — `lines 1–200/1500`, `stderr 240`. */
  resultNote?: string | null;
  /** Full length of the message, whatever `text` was clipped to. */
  chars?: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function countersOf(usage: any): Counters {
  const creation = usage.cache_creation ?? {};
  const total = num(usage.cache_creation_input_tokens);
  const w1h = num(creation.ephemeral_1h_input_tokens);
  const w5m =
    creation.ephemeral_5m_input_tokens != null
      ? num(creation.ephemeral_5m_input_tokens)
      : Math.max(0, total - w1h);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  };
}

/**
 * The list payload carries a stub, not the message: a run with a few pasted
 * logs in it would otherwise be megabytes for a view that shows a preview.
 * `full` turns clipping off — that mode serves one step at a time, for the
 * step the reader actually unfolded (`stepText`).
 */
function clip(s: string, full: boolean): { text: string; truncated: boolean } {
  const t = s.trim();
  return !full && t.length > TEXT_LIMIT
    ? { text: t.slice(0, TEXT_LIMIT) + '…', truncated: true }
    : { text: t, truncated: false };
}

function resultChars(o: any): number {
  const r = o.toolUseResult;
  if (typeof r === 'string') return r.length;
  if (r && typeof r === 'object') {
    if (typeof r.content === 'string') return r.content.length;
    try {
      return JSON.stringify(r).length;
    } catch {
      return 0;
    }
  }
  const c = o.message?.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b?.type === 'tool_result') {
        const v = b.content;
        if (typeof v === 'string') return v.length;
        if (Array.isArray(v)) return v.reduce((s, x) => s + (typeof x?.text === 'string' ? x.text.length : 0), 0);
      }
    }
  }
  return 0;
}

/**
 * What the result itself adds to the call above it. A `Read` that asked for
 * nothing still answers with a range, and the range is the whole reason four
 * reads of one file are four different steps; a `Bash` that was cut off or
 * wrote to stderr says so here rather than in a body nobody stores.
 *
 * Anything else gets nothing: the size is already on the line.
 */
function resultNote(o: any): string | null {
  const r = o.toolUseResult;
  if (!r || typeof r !== 'object') return null;

  const f = r.file;
  if (f && typeof f === 'object' && typeof f.totalLines === 'number') {
    const from = num(f.startLine) || 1;
    const shown = num(f.numLines);
    return `lines ${from}–${from + Math.max(shown, 1) - 1}/${f.totalLines}`;
  }

  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const parts: string[] = [];
    if (r.interrupted === true) parts.push('interrupted');
    const err = typeof r.stderr === 'string' ? r.stderr.trim().length : 0;
    if (err) parts.push(`stderr ${err}`);
    return parts.join(' ') || null;
  }

  return null;
}

/**
 * Read one run's files in order and return its steps.
 * `files` is normally a single file — the DB is the authority on which.
 */
export async function runHistory(
  files: string[],
  metric: Metric,
  opts: { full?: boolean } = {}
): Promise<RunStep[]> {
  const full = opts.full === true;
  const steps: RunStep[] = [];
  const byMsgId = new Map<string, RunStep>();
  // A result carries `tool_use_id` and nothing else identifying: the tool name
  // it used to show came from `toolUseResult.type`, which is the shape of the
  // payload (`text`, `update`), not the tool. The call is always earlier in
  // the file, so one map resolves it exactly.
  const byToolId = new Map<string, ToolCall>();

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

      if (o.type === 'user') {
        const content = o.message?.content;
        if (typeof content === 'string') {
          const { text, truncated } = clip(content, full);
          steps.push({ ts, kind: 'prompt', text, truncated, chars: content.length });
        } else if (Array.isArray(content)) {
          const block = content.find((b: any) => b?.type === 'tool_result');
          if (block) {
            const call = typeof block.tool_use_id === 'string' ? byToolId.get(block.tool_use_id) : undefined;
            steps.push({
              ts,
              kind: 'tool_result',
              toolName: call?.name ?? null,
              // A back-reference, not the call itself: the full argument is on
              // the turn above, and repeating 1200 chars per result would put
              // every command in the payload twice.
              toolTarget: call?.target ? call.target.slice(0, 200) : null,
              isError: block.is_error === true,
              resultNote: resultNote(o),
              chars: resultChars(o),
            });
          } else {
            const textBlock = content.find((b: any) => b?.type === 'text' && b.text?.trim());
            if (textBlock) {
              const { text, truncated } = clip(textBlock.text, full);
              steps.push({ ts, kind: 'prompt', text, truncated, chars: textBlock.text.length });
            }
          }
        }
        continue;
      }

      if (o.type !== 'assistant' || !o.message) continue;

      const msgId: string = o.message.id ?? o.uuid;
      let step = msgId ? byMsgId.get(msgId) : undefined;

      if (!step) {
        const usage = o.message.usage;
        const c = usage ? countersOf(usage) : null;
        step = {
          ts,
          kind: 'assistant',
          model: o.message.model ?? null,
          thinkingChars: 0,
          text: null,
          tools: [],
        };
        if (c) {
          // Context = everything sent to the API for this turn. This is the
          // number that grows across a run and is the actual cost driver.
          step.context = c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h;
          step.input = c.input;
          step.output = c.output;
          step.cacheRead = c.cacheRead;
          step.cacheWrite = c.cacheWrite5m + c.cacheWrite1h;
          step.cacheTtl = ttlOf(c.cacheWrite5m);
          step.usd = usdOf(c, o.message.model);
          step.value =
            metric === 'usd' ? step.usd : metric === 'weighted' ? weightedOf(c, o.message.model) : rawOf(c);
        }
        steps.push(step);
        if (msgId) byMsgId.set(msgId, step);
      }

      // Merge this line's blocks into the turn.
      for (const b of o.message.content ?? []) {
        if (b?.type === 'text' && b.text?.trim() && !step.text) {
          const { text, truncated } = clip(b.text, full);
          step.text = text;
          step.truncated = truncated;
          step.chars = b.text.trim().length;
        } else if (b?.type === 'thinking') {
          step.thinkingChars = (step.thinkingChars ?? 0) + (b.thinking?.length ?? 0);
        } else if (b?.type === 'tool_use') {
          // De-duplicated by the call's own id, not by how it reads: two
          // parallel greps that differ only in `-i` are two calls, and the old
          // name+target rule silently dropped the second one.
          const id = typeof b.id === 'string' ? b.id : null;
          if (id && byToolId.has(id)) continue;
          const brief = toolBrief(b.input);
          const call: ToolCall = {
            name: b.name,
            target: brief.target,
            targetChars: brief.targetChars,
            detail: brief.detail,
          };
          if (id) byToolId.set(id, call);
          step.tools?.push(call);
        }
      }
    }
  }

  steps.sort((a, b) => a.ts - b.ts);
  markCacheMisses(steps, metric);
  return steps;
}

/**
 * The unclipped text of one step, addressed by its position in `runHistory`.
 *
 * The index is the one the client already holds: both reads walk the same
 * files with the same rules and the same stable sort, so step `i` is step `i`.
 * Re-reading the run for one message is the price of not shipping every
 * message in full to a view that shows previews.
 */
export async function stepText(files: string[], index: number): Promise<string | null> {
  if (!Number.isInteger(index) || index < 0) return null;
  const steps = await runHistory(files, 'raw', { full: true });
  return steps[index]?.text ?? null;
}

/** Flag the turns that re-cached — the rule lives in `cachemiss.ts`. */
function markCacheMisses(steps: RunStep[], metric: Metric): void {
  const valueOf = (c: Counters, model: string | null | undefined) =>
    metric === 'usd' ? usdOf(c, model) : metric === 'weighted' ? weightedOf(c, model) : rawOf(c);

  const turns = steps.filter((s) => s.kind === 'assistant' && s.context != null);
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1], cur = turns[i];
    const rewritten = rewrittenTokens(prev.context ?? 0, cur.cacheRead ?? 0, cur.cacheWrite ?? 0);
    if (!rewritten) continue;

    // Priced against the bucket the write actually landed in: a 1h write is
    // 2x input, a 5m one 1.25x, and a run mixes neither.
    const ttl = cur.cacheTtl ?? '5m';
    const written: Counters =
      ttl === '1h' ? { ...ZERO, cacheWrite1h: rewritten } : { ...ZERO, cacheWrite5m: rewritten };
    const read: Counters = { ...ZERO, cacheRead: rewritten };
    const idleMs = cur.ts - prev.ts;
    cur.cacheMiss = {
      tokens: rewritten,
      idleMs,
      ttl,
      cause: missCause(idleMs, ttl),
      extra: valueOf(written, cur.model) - valueOf(read, cur.model),
      extraUsd: usdOf(written, cur.model) - usdOf(read, cur.model),
    };
  }
}
