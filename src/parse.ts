/**
 * Streaming JSONL reader: turns one session file into billable message rows,
 * the facts the diagnostics screens are built on, and whatever session-level
 * metadata the file happens to carry.
 *
 * Three things here are load-bearing and all three are easy to get wrong:
 *
 * 1. DE-DUPLICATION. An assistant turn is written to the log once per content
 *    block — text, thinking, each tool_use — and every one of those lines
 *    repeats the `message.usage` totals. In the corpus this was built against,
 *    29 803 of 50 182 usage-bearing lines were such repeats: counting lines
 *    instead of messages inflates spend ~2.5x. We key on `message.id`.
 *    We deliberately do NOT key on `requestId`: one request can contain several
 *    billed messages (see `usage.iterations`), so that key would drop real spend.
 *
 * 2. OUTPUT IS ONLY FINAL ON THE LAST LINE. The repeated lines are not quite
 *    identical after all: `output_tokens` on the early lines is a partial
 *    streaming count, and the true value lands on the line that also carries
 *    `stop_reason` (and `usage.iterations`). Keeping the FIRST line — which is
 *    what de-duplication naturally does — under-counted output 2.35x over the
 *    corpus: 15.1M tokens instead of 35.4M, ~$508 of Opus output priced away.
 *    So the row is kept but its counters are MERGED across the lines of one
 *    message, taking the max of each. The cache counters never differ between
 *    those lines (measured: zero disagreements), so only output moves.
 *
 *    The one case where the top-level totals themselves under-report is a
 *    message with several `usage.iterations` — there the top-level cache_read
 *    is the LAST iteration's, not the sum. Four messages in the corpus, but
 *    summing the iterations costs nothing and is simply correct.
 *
 * 3. AGENT ATTRIBUTION. Subagent files tag their assistant lines with
 *    `attributionAgent` (the agent type, e.g. "pie-tools:tech-designer"), so
 *    per-agent spend needs no reconstruction from parent Task tool calls.
 *
 * Beyond the counters this pass also emits FACTS — one row per tool call and
 * one per notable event. They answer questions the counters cannot ("which
 * tool results fill the context", "what did a compaction cost", "when did we
 * hit the rate limit"), and they are collected here rather than in a second
 * scan because the file is already open and already parsed.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';

import type { Counters } from './pricing.ts';
import type { FileKind } from './paths.ts';

export const MAIN_AGENT = '(main thread)';

export interface MessageRow {
  msgId: string;
  ts: number;
  sessionId: string;
  agent: string;
  agentId: string | null;
  kind: FileKind;
  model: string | null;
  effort: string | null;
  sessionKind: string | null;
  counters: Counters;
}

/**
 * One tool call and the result it brought back. The result lands in a later
 * message, so the row is completed out of order — see `pending` below.
 */
export interface ToolRow {
  ts: number;
  /** 1-based assistant turn this call was made on. */
  turn: number;
  tool: string;
  /** The one argument worth seeing at a glance: a path, a pattern, a command. */
  target: string | null;
  agent: string;
  agentId: string | null;
  /** Size of the arguments — for dispatches this is the brief itself. */
  inputChars: number;
  /** Identity of the arguments, so the same brief sent N times is countable. */
  inputHash: string | null;
  resultChars: number;
  isError: number;
  /** Head of the failure message; null unless `isError`. Enough to tell a
   *  missing file from a permission denial without opening the log. */
  errorText: string | null;
}

export type EventType = 'compaction' | 'api_error' | 'interrupt' | 'truncated';

/**
 * Something that happened to the run rather than something it did. `num1..3`
 * are typed by `type`, which keeps one narrow table instead of four.
 *
 *   compaction — num1 = tokens before, num2 = after, num3 = duration ms
 *   api_error  — num1 = HTTP status
 *   truncated  — num1 = output tokens at the cut
 *   interrupt  — no numbers
 */
export interface EventRow {
  ts: number;
  turn: number;
  type: EventType;
  agent: string;
  agentId: string | null;
  num1: number;
  num2: number;
  num3: number;
  text: string | null;
}

export interface SessionMeta {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  slug: string | null;
  title: string | null;
  firstPrompt: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

export interface ParsedFile {
  rows: MessageRow[];
  tools: ToolRow[];
  events: EventRow[];
  /** Assistant turns in the file — the denominator for "how long was this carried". */
  turns: number;
  meta: SessionMeta;
}

/** Pull the two cache-write buckets apart; older logs only have the total. */
function readCounters(usage: Record<string, any>): Counters {
  const creation = (usage.cache_creation ?? {}) as Record<string, number>;
  const total = num(usage.cache_creation_input_tokens);
  const w1h = num(creation.ephemeral_1h_input_tokens);
  // When the split is absent, everything falls into the 5m bucket, which is
  // the cheaper of the two — this under-reports rather than invents spend.
  const w5m = creation.ephemeral_5m_input_tokens != null
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
 * Counters for one message, iterations included. A request that ran several
 * inference iterations reports each of them separately AND reports top-level
 * totals that only describe the last one for the cache fields — so the sum
 * wins wherever it is larger.
 */
export function messageCounters(usage: Record<string, any>): Counters {
  const top = readCounters(usage);
  const its = usage.iterations;
  if (!Array.isArray(its) || its.length < 2) return top;
  const sum = its.reduce<Counters>((acc, it) => {
    const c = readCounters(it ?? {});
    return {
      input: acc.input + c.input,
      output: acc.output + c.output,
      cacheRead: acc.cacheRead + c.cacheRead,
      cacheWrite5m: acc.cacheWrite5m + c.cacheWrite5m,
      cacheWrite1h: acc.cacheWrite1h + c.cacheWrite1h,
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  return mergeCounters(top, sum);
}

/** The larger of each counter — see the header on why lines disagree. */
export function mergeCounters(a: Counters, b: Counters): Counters {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Argument names in the order they answer "what was this call aimed at".
 * `skill` and `notebook_path` are last resorts: without them those calls read
 * as a bare tool name with nothing after it.
 */
const TARGET_KEYS = [
  'file_path',
  'path',
  'pattern',
  'command',
  'query',
  'description',
  'summary',
  'prompt',
  'url',
  'skill',
  'notebook_path',
];

function targetEntry(input: any): [string, string] | null {
  if (!input || typeof input !== 'object') return null;
  for (const k of TARGET_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return [k, v.trim()];
  }
  return null;
}

/** The argument that identifies what a tool call was aimed at. */
export function toolTarget(input: any): string | null {
  const e = targetEntry(input);
  if (!e) return null;
  const one = e[1].replaceAll('\n', ' ');
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}

/**
 * The target alone does not tell two calls apart: four `Read`s of one file in
 * a row differ only by `offset`/`limit`, and reading them as four identical
 * lines is what makes a log useless. `detail` is every OTHER argument, in the
 * order the model wrote them, so the difference is on the line.
 *
 * The rendering is deliberately generic — `key=value`, argument names as the
 * API spells them — rather than a case per tool: a per-tool table only ever
 * covers the tools that existed when it was written, and MCP servers add new
 * ones per session. Long values keep their head and state their size, so a
 * 40 KB prompt costs one line here, not 40 KB.
 */
export interface ToolBrief {
  target: string | null;
  /** Full length of the target argument, whatever `target` was clipped to. */
  targetChars: number;
  detail: string | null;
}

/** Generous next to the index's 120: this one is read, not aggregated. */
const BRIEF_TARGET_CAP = 1200;
const BRIEF_DETAIL_CAP = 240;
const BRIEF_VALUE_CAP = 56;

const briefChars = (n: number): string =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);

function briefArg(k: string, v: unknown): string | null {
  if (v == null || v === '' || v === false) return null;
  // A flag that is on is its own name; one that is off says nothing.
  if (v === true) return k;
  if (typeof v === 'number') return `${k}=${v}`;
  if (typeof v === 'string') {
    const one = v.replace(/\s+/g, ' ').trim();
    if (!one) return null;
    return one.length > BRIEF_VALUE_CAP
      ? `${k}=«${one.slice(0, BRIEF_VALUE_CAP)}…» ${briefChars(one.length)}`
      : `${k}=${one}`;
  }
  if (Array.isArray(v)) return `${k}×${v.length}`;
  if (typeof v === 'object') return `${k}{${Object.keys(v as object).slice(0, 4).join(',')}}`;
  return null;
}

export function toolBrief(input: any): ToolBrief {
  const e = targetEntry(input);
  const full = e ? e[1] : '';
  const parts: string[] = [];
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (e && k === e[0]) continue;
      const part = briefArg(k, v);
      if (part) parts.push(part);
    }
  }
  const detail = parts.join(' ');
  return {
    // Newlines survive the cap: the chip collapses them, the unfolded call
    // shows the shell script the way it was written.
    target: !e ? null : full.length > BRIEF_TARGET_CAP ? full.slice(0, BRIEF_TARGET_CAP) + '…' : full,
    targetChars: full.length,
    detail: !detail ? null : detail.length > BRIEF_DETAIL_CAP ? detail.slice(0, BRIEF_DETAIL_CAP) + '…' : detail,
  };
}

/** Identity of a text block, whitespace-insensitive — same rule as `cohort.ts`. */
export function contentHash(text: string): string {
  return crypto.createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** First readable text of a message body — a bare string, or its text block. */
export function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        const t = (block as any).text;
        if (typeof t === 'string' && t.trim()) return t;
      }
    }
  }
  return null;
}

/** Text of a tool result block, whatever shape it arrived in. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const b of content) {
      if (b && typeof b === 'object' && (b as any).type === 'text') out += (b as any).text ?? '';
    }
    if (out) return out;
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/** Tools whose arguments ARE the payload — the brief an agent starts from. */
export const DISPATCH_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage']);

/**
 * How much of a failure text is kept. The first lines carry the reason; a
 * stack trace or a 200-line diff behind it would put the whole error corpus in
 * the index for nothing.
 */
export const ERROR_TEXT_CAP = 400;

export async function parseSessionFile(
  file: string,
  sessionId: string,
  kind: FileKind
): Promise<ParsedFile> {
  const rows: MessageRow[] = [];
  const tools: ToolRow[] = [];
  const events: EventRow[] = [];
  const meta: SessionMeta = {
    sessionId,
    cwd: null,
    gitBranch: null,
    version: null,
    slug: null,
    title: null,
    firstPrompt: null,
    firstTs: null,
    lastTs: null,
  };
  const byId = new Map<string, MessageRow>();
  /** tool_use_id -> the half-built row waiting for its result. */
  const pending = new Map<string, ToolRow>();
  /** A cut-off message repeats its `stop_reason` on every line; count it once. */
  const truncated = new Set<string>();
  let turn = 0;
  let agent = kind === 'subagent' ? 'unknown-agent' : MAIN_AGENT;
  let agentId: string | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a truncated tail line on a session still being written
    }

    if (typeof o.cwd === 'string' && !meta.cwd) meta.cwd = o.cwd;
    if (typeof o.gitBranch === 'string' && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (typeof o.version === 'string') meta.version = o.version;
    if (typeof o.slug === 'string' && !meta.slug) meta.slug = o.slug;
    if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) meta.title = o.aiTitle;
    if (typeof o.attributionAgent === 'string') agent = o.attributionAgent;
    if (typeof o.agentId === 'string') agentId = o.agentId;

    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (meta.firstTs == null || ts < meta.firstTs) meta.firstTs = ts;
      if (meta.lastTs == null || ts > meta.lastTs) meta.lastTs = ts;
    }

    // The first human turn is the most useful fallback label for a session.
    if (o.type === 'user' && kind === 'main' && !meta.firstPrompt && !o.isSidechain) {
      const t = textOf(o.message?.content);
      if (t) meta.firstPrompt = t.slice(0, 300);
    }

    const at = Number.isFinite(ts) ? ts : (meta.lastTs ?? 0);

    // --- events that live on the envelope, not inside the message ---------
    if (o.compactMetadata && typeof o.compactMetadata === 'object') {
      const c = o.compactMetadata;
      events.push({
        ts: at,
        turn,
        type: 'compaction',
        agent,
        agentId,
        num1: num(c.preTokens),
        num2: num(c.postTokens),
        num3: num(c.durationMs),
        text: typeof c.trigger === 'string' ? c.trigger : null,
      });
    }
    if (o.isApiErrorMessage) {
      events.push({
        ts: at,
        turn,
        type: 'api_error',
        agent,
        agentId,
        num1: num(o.apiErrorStatus),
        num2: 0,
        num3: 0,
        text: typeof o.apiErrorStatus === 'number' ? String(o.apiErrorStatus) : 'unknown',
      });
    }

    const message = o.message;
    if (!message) continue;

    // Turn bookkeeping runs BEFORE the content blocks, so a tool call made on
    // the first line of a message is attributed to that message's own turn.
    if (o.type === 'assistant' && message.usage && Number.isFinite(ts)) {
      const msgId: string = message.id ?? o.uuid;
      if (msgId) {
        const counters = messageCounters(message.usage);
        const known = byId.get(msgId);
        if (known) {
          // Same message, a later content line: only its output can be truthier.
          known.counters = mergeCounters(known.counters, counters);
        } else {
          turn++;
          const row: MessageRow = {
            msgId,
            ts,
            sessionId,
            agent: kind === 'subagent' ? (o.attributionAgent ?? 'unknown-agent') : MAIN_AGENT,
            agentId: typeof o.agentId === 'string' ? o.agentId : null,
            kind,
            model: typeof message.model === 'string' ? message.model : null,
            effort: typeof o.effort === 'string' ? o.effort : null,
            sessionKind: typeof o.sessionKind === 'string' ? o.sessionKind : null,
            counters,
          };
          byId.set(msgId, row);
          rows.push(row);
        }
        if (message.stop_reason === 'max_tokens' && !truncated.has(msgId)) {
          truncated.add(msgId);
          events.push({ ts, turn, type: 'truncated', agent, agentId, num1: counters.output, num2: 0, num3: 0, text: null });
        }
      }
    }

    // --- tool calls and their results -------------------------------------
    const content = message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          if (pending.has(b.id)) continue; // the same tool_use line, repeated
          const input = b.input ?? {};
          const raw = typeof input === 'string' ? input : safeStringify(input);
          pending.set(b.id, {
            ts: at,
            turn: Math.max(1, turn),
            tool: typeof b.name === 'string' ? b.name : '?',
            target: toolTarget(input),
            agent,
            agentId,
            inputChars: raw.length,
            inputHash: DISPATCH_TOOLS.has(b.name) && raw.length > 200 ? contentHash(raw) : null,
            resultChars: 0,
            isError: 0,
            errorText: null,
          });
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const row = pending.get(b.tool_use_id);
          if (!row) continue;
          pending.delete(b.tool_use_id);
          const text = resultText(b.content);
          row.resultChars = text.length;
          row.isError = b.is_error ? 1 : 0;
          // A failure with an empty body says nothing, so it stays null rather
          // than becoming an empty string the reports would have to special-case.
          row.errorText = row.isError ? text.trim().slice(0, ERROR_TEXT_CAP) || null : null;
          tools.push(row);
          if (text.includes('[Request interrupted')) {
            events.push({ ts: at, turn, type: 'interrupt', agent, agentId, num1: 0, num2: 0, num3: 0, text: row.tool });
          }
        }
      }
    } else if (typeof content === 'string' && content.includes('[Request interrupted')) {
      events.push({ ts: at, turn, type: 'interrupt', agent, agentId, num1: 0, num2: 0, num3: 0, text: null });
    }

  }

  // One subagent file is one run, so every row in it belongs to one agent —
  // but `attributionAgent` only appears from some line onward, and the rows
  // before it would otherwise be filed under a phantom `unknown-agent` that
  // then shows up in every per-agent table with a handful of runs and no
  // spend. Backfill once the real name is known.
  if (kind === 'subagent' && agent !== 'unknown-agent') {
    for (const r of rows) if (r.agent === 'unknown-agent') r.agent = agent;
    for (const t of tools) if (t.agent === 'unknown-agent') t.agent = agent;
    for (const e of events) if (e.agent === 'unknown-agent') e.agent = agent;
  }
  if (agentId) {
    for (const r of rows) r.agentId ??= agentId;
    for (const t of tools) t.agentId ??= agentId;
    for (const e of events) e.agentId ??= agentId;
  }

  // A call whose result never arrived (interrupted run, still-open file) is
  // still a call that was paid for; it just carries no result size.
  for (const row of pending.values()) tools.push(row);
  tools.sort((a, b) => a.ts - b.ts || a.turn - b.turn);

  return { rows, tools, events, turns: turn, meta };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
