/**
 * What is actually IN a run's context, block by block.
 *
 * The run view answers "how much" — this answers "of what". Both read the same
 * JSONL; this one keeps every block's text long enough to do two things the
 * counters cannot:
 *
 *   1. Attribute the context to what put it there. A 391k context is never one
 *      big thing; it is twenty ~15k things, and which twenty is the finding.
 *   2. Find the same text sitting in the context more than once — a plan
 *      written to a file AND passed to ExitPlanMode AND echoed back by the
 *      approval is three copies of one document, all of them billed.
 *
 * Tokens are not counted, they are FITTED. The log stores characters; the
 * usage counters store tokens for the whole prefix. Regressing the GROWTH of
 * the context against the characters added between consecutive turns gives
 * characters-per-token for this run's own mix of Russian, English and code —
 * and growth survives what a cumulative fit does not: a long run compacts, the
 * context falls back, and characters-so-far stops tracking it entirely.
 *
 * Which is also why the report is scoped to ONE context window. A compaction
 * throws the history away and starts over; summing every block of a 279-turn
 * run would describe a context that never existed. Segments are cut where the
 * context drops, and the caller picks one by turn number.
 */

import fs from 'node:fs';
import { t } from './i18n.ts';
import readline from 'node:readline';

/** Coarse origin buckets — what put this text in the context. */
export type Origin =
  | 'subagent'
  | 'write'
  | 'plan'
  | 'thinking'
  | 'dispatch'
  | 'command'
  | 'result'
  | 'reminder'
  | 'answer'
  | 'prompt';

export interface ContextBlock {
  ts: number;
  /** Turn that first paid for this block (1-based); 0 = before the first turn. */
  turn: number;
  origin: Origin;
  /** Tool name, attachment type, or a short description. */
  label: string;
  chars: number;
  tokens: number;
  preview: string;
}

export interface DupeGroup {
  copies: number;
  tokens: number;
  /** Everything past the first copy — what could have been avoided. */
  wastedTokens: number;
  preview: string;
  members: { ts: number; turn: number; origin: Origin; label: string; tokens: number }[];
}

export interface ContextSegment {
  /** 1-based turn range of this context window. */
  fromTurn: number;
  toTurn: number;
  /** Context at the last turn of the window — the size being explained. */
  peakContext: number;
}

export interface ContextReport {
  /** Context at the end of the reported window, from its counters. */
  finalContext: number;
  turns: number;
  /** Every context window of the run, and which one this report covers. */
  segments: ContextSegment[];
  segment: ContextSegment;
  fit: {
    charsPerToken: number;
    /** What the log does not store: system prompt, tools, CLAUDE.md, summary. */
    headTokens: number;
    /** Turns the fit ran over, and how far it lands from the real last context. */
    points: number;
    errorPct: number;
  };
  byOrigin: { origin: Origin; blocks: number; tokens: number }[];
  /** Same origin split one level finer, by tool / attachment name. */
  byLabel: { origin: Origin; label: string; blocks: number; tokens: number }[];
  dupes: DupeGroup[];
  dupeTokens: number;
  top: ContextBlock[];
  /** Per-turn context growth, for pointing at when it ballooned. */
  growth: { turn: number; ts: number; context: number; delta: number }[];
}

const PREVIEW = 160;
/** Below this a block is noise for both the top list and dupe detection. */
const BIG_CHARS = 4000;

const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, PREVIEW);

/** A tool result is classified by the tool that produced it, so keep the map. */
interface Raw {
  ts: number;
  origin: Origin;
  label: string;
  text: string;
}

function readBlocks(lines: any[]): { raw: Raw[]; turns: { ts: number; context: number }[] } {
  const toolName = new Map<string, string>();
  const raw: Raw[] = [];
  const turns: { ts: number; context: number }[] = [];
  const seenTurn = new Set<string>();

  for (const o of lines) {
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;

    if (o.type === 'attachment' && o.attachment) {
      const type = String(o.attachment.type ?? 'attachment');
      const text = str(o.attachment.content ?? o.attachment);
      // A queued command is whatever was waiting in the queue — usually a
      // finished subagent, so it counts against the same budget.
      const subagent = type === 'queued_command' && text.includes('<task-notification');
      const plan = type.startsWith('plan_');
      raw.push({
        ts,
        origin: subagent ? 'subagent' : plan ? 'plan' : 'reminder',
        label: type,
        text,
      });
      continue;
    }

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        raw.push({
          ts,
          origin: c.startsWith('<task-notification') ? 'subagent' : 'prompt',
          label: c.startsWith('<task-notification')
            ? t('context.origin.subagentReturn')
            : t('context.origin.prompt'),
          text: c,
        });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') {
            const name = toolName.get(b.tool_use_id) ?? '?';
            const text = str(b.content);
            const isPlan = /approved your plan/i.test(text);
            raw.push({
              ts,
              origin: isPlan ? 'plan' : name === 'Agent' || name === 'SendMessage' ? 'subagent' : 'result',
              label: name,
              text,
            });
          } else if (b?.type === 'text' && b.text) {
            raw.push({ ts, origin: 'prompt', label: t('context.origin.prompt'), text: b.text });
          }
        }
      }
      continue;
    }

    if (o.type !== 'assistant' || !o.message) continue;

    // Turns are deduped by message.id: one turn's blocks span several lines,
    // all repeating the same usage.
    const id: string = o.message.id ?? o.uuid;
    const u = o.message.usage;
    if (u && id && !seenTurn.has(id)) {
      seenTurn.add(id);
      const cc = u.cache_creation ?? {};
      turns.push({
        ts,
        context:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (cc.ephemeral_5m_input_tokens ?? 0) +
          (cc.ephemeral_1h_input_tokens ?? 0),
      });
    }

    // Blocks, however, are NOT deduped: a repeated tool_use with its own id is
    // a real second copy in the context, and that is exactly what we hunt.
    for (const b of o.message.content ?? []) {
      if (b?.type === 'text' && b.text) raw.push({ ts, origin: 'answer', label: t('context.origin.answer'), text: b.text });
      else if (b?.type === 'thinking')
        raw.push({
          ts,
          origin: 'thinking',
          label: t('context.origin.thinking'),
          text: (b.thinking ?? '') + (b.signature ?? ''),
        });
      else if (b?.type === 'tool_use') {
        if (b.id) toolName.set(b.id, b.name);
        const text = str(b.input);
        const origin: Origin =
          b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit'
            ? 'write'
            : b.name === 'ExitPlanMode'
              ? 'plan'
              : b.name === 'Agent' || b.name === 'SendMessage' || b.name === 'Workflow'
                ? 'dispatch'
                : 'command';
        raw.push({ ts, origin, label: b.name, text });
      }
    }
  }

  raw.sort((a, b) => a.ts - b.ts);
  turns.sort((a, b) => a.ts - b.ts);
  return { raw, turns };
}

/**
 * Characters per token, from growth: how many tokens the context gained
 * against how many characters arrived between two turns. Through the origin —
 * zero new text is zero new tokens — and only over pairs that grew, so a
 * compaction's drop cannot drag the slope.
 */
const FALLBACK_CHARS_PER_TOKEN = 3;

export const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

/**
 * Median of per-pair ratios, not least squares. A handful of turns are not
 * conversation growth at all — a side call on its own prefix, a compaction
 * restart, a turn whose text the log never stored — and one such pair drags a
 * mean estimator right out of the plausible range. The median ignores them.
 */
export function fitCharsPerToken(pairs: { chars: number; tokens: number }[]): { charsPerToken: number; points: number } {
  const use = pairs.filter((p) => p.chars >= 2000 && p.tokens > 0);
  const v = median(use.map((p) => p.chars / p.tokens));
  return {
    charsPerToken: use.length >= 5 && v >= 1.5 && v <= 8 ? v : FALLBACK_CHARS_PER_TOKEN,
    points: use.length,
  };
}

/** Cut the run where the context collapses — each piece is one context window. */
export function cutSegments(contexts: number[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = 0;
  for (let i = 1; i < contexts.length; i++) {
    if (contexts[i] < contexts[i - 1] * 0.7) {
      out.push({ from, to: i - 1 });
      from = i;
    }
  }
  out.push({ from, to: Math.max(0, contexts.length - 1) });
  return out;
}

/** 10-word shingles, every 3rd word: cheap, and robust to small edits. */
function shingles(s: string): Set<string> {
  const w = s.replace(/\s+/g, ' ').split(' ');
  const out = new Set<string>();
  for (let i = 0; i + 10 <= w.length; i += 3) out.add(w.slice(i, i + 10).join(' '));
  return out;
}

function findDupes(blocks: ContextBlock[], texts: string[]): DupeGroup[] {
  const idx = blocks.map((b, i) => i).filter((i) => blocks[i].chars >= BIG_CHARS);
  const sh = new Map<number, Set<string>>();
  for (const i of idx) sh.set(i, shingles(texts[i]));

  const used = new Set<number>();
  const groups: DupeGroup[] = [];
  for (const i of idx) {
    if (used.has(i)) continue;
    const a = sh.get(i)!;
    if (!a.size) continue;
    const group = [i];
    used.add(i);
    for (const k of idx) {
      if (used.has(k)) continue;
      const b = sh.get(k)!;
      if (!b.size) continue;
      let inter = 0;
      for (const x of b) if (a.has(x)) inter++;
      // Containment, not Jaccard: an excerpt of a big document is still a copy.
      if (inter / Math.min(a.size, b.size) > 0.35) {
        group.push(k);
        used.add(k);
      }
    }
    if (group.length < 2) continue;
    const tokens = group.reduce((s, g) => s + blocks[g].tokens, 0);
    groups.push({
      copies: group.length,
      tokens,
      wastedTokens: tokens - Math.max(...group.map((g) => blocks[g].tokens)),
      preview: blocks[group[0]].preview,
      members: group.map((g) => ({
        ts: blocks[g].ts,
        turn: blocks[g].turn,
        origin: blocks[g].origin,
        label: blocks[g].label,
        tokens: blocks[g].tokens,
      })),
    });
  }
  return groups.sort((a, b) => b.wastedTokens - a.wastedTokens);
}

export async function contextReport(
  files: string[],
  opts: { turn?: number; topLimit?: number } = {}
): Promise<ContextReport> {
  const topLimit = opts.topLimit ?? 20;
  const lines: any[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* a partially written last line is normal on a live session */
      }
    }
  }

  const { raw, turns } = readBlocks(lines);

  // Assign every block to the turn that first paid for it, and total the
  // characters that arrived between turns — the fit's x axis.
  const turnOf: number[] = new Array(raw.length).fill(1);
  const charsBefore: number[] = new Array(turns.length).fill(0);
  {
    let t = 0;
    let pending = 0;
    for (let i = 0; i < raw.length; i++) {
      while (t < turns.length && turns[t].ts <= raw[i].ts) {
        charsBefore[t] = pending;
        pending = 0;
        t++;
      }
      turnOf[i] = Math.min(t + 1, Math.max(turns.length, 1));
      pending += raw[i].text.length;
    }
    while (t < turns.length) {
      charsBefore[t] = pending;
      pending = 0;
      t++;
    }
  }

  // Which context window to explain: the one holding the requested turn, else
  // the biggest — that is the one worth looking at.
  const segs = cutSegments(turns.map((x) => x.context));

  // Growth pairs, but only inside a window: the first turn after a compaction
  // gains a whole summary the log did not deliver as characters.
  const inSeg = (i: number) => segs.some((s) => i - 1 >= s.from && i <= s.to);
  const { charsPerToken, points } = fitCharsPerToken(
    turns
      .slice(1)
      .map((x, i) => ({ i: i + 1, chars: charsBefore[i + 1], tokens: x.context - turns[i].context }))
      .filter((p) => inSeg(p.i))
  );
  const tokensOf = (chars: number) => Math.max(0, Math.round(chars / charsPerToken));
  const chosen =
    (opts.turn ? segs.find((s) => opts.turn! - 1 >= s.from && opts.turn! - 1 <= s.to) : null) ??
    segs.reduce((a, b) => (turns[b.to]?.context > turns[a.to]?.context ? b : a), segs[0]) ??
    { from: 0, to: Math.max(0, turns.length - 1) };

  const segment: ContextSegment = {
    fromTurn: chosen.from + 1,
    toTurn: chosen.to + 1,
    peakContext: turns[chosen.to]?.context ?? 0,
  };

  const all: ContextBlock[] = raw.map((r, i) => ({
    ts: r.ts,
    turn: turnOf[i],
    origin: r.origin,
    label: r.label,
    chars: r.text.length,
    tokens: tokensOf(r.text.length),
    preview: clean(r.text),
  }));
  // Blocks that arrived after this window opened. What was there before it is
  // gone from the context (or folded into the summary counted as head).
  const keep = all.map((b, i) => (b.turn > segment.fromTurn && b.turn <= segment.toTurn ? i : -1)).filter((i) => i >= 0);
  const blocks = keep.map((i) => all[i]);

  const finalContext = segment.peakContext;
  const bodyTokens = blocks.reduce((s, b) => s + b.tokens, 0);
  // The head is what the log never stores: system prompt, tool schemas,
  // CLAUDE.md — plus the compact summary when this window follows one. It is
  // the part of every turn's context the blocks do not explain, so take it as
  // the median residual across the window rather than trusting one turn.
  const residuals: number[] = [];
  {
    let cum = 0;
    for (let i = chosen.from; i <= chosen.to; i++) {
      cum += charsBefore[i] ?? 0;
      if (i > chosen.from) residuals.push(turns[i].context - tokensOf(cum));
    }
  }
  const headTokens = Math.max(0, Math.round(median(residuals) || 0));
  const predicted = headTokens + bodyTokens;

  const byOrigin = new Map<Origin, { origin: Origin; blocks: number; tokens: number }>();
  const byLabel = new Map<string, { origin: Origin; label: string; blocks: number; tokens: number }>();
  for (const b of blocks) {
    if (!b.tokens) continue;
    const o = byOrigin.get(b.origin) ?? { origin: b.origin, blocks: 0, tokens: 0 };
    o.blocks++;
    o.tokens += b.tokens;
    byOrigin.set(b.origin, o);
    const key = b.origin + ' ' + b.label;
    const l = byLabel.get(key) ?? { origin: b.origin, label: b.label, blocks: 0, tokens: 0 };
    l.blocks++;
    l.tokens += b.tokens;
    byLabel.set(key, l);
  }

  const dupes = findDupes(blocks, keep.map((i) => raw[i].text));

  const growth = turns.slice(chosen.from, chosen.to + 1).map((x, i, arr) => ({
    turn: chosen.from + i + 1,
    ts: x.ts,
    context: x.context,
    delta: i ? x.context - arr[i - 1].context : x.context,
  }));

  return {
    finalContext,
    turns: turns.length,
    segments: segs.map((s) => ({
      fromTurn: s.from + 1,
      toTurn: s.to + 1,
      peakContext: turns[s.to]?.context ?? 0,
    })),
    segment,
    fit: {
      charsPerToken,
      headTokens,
      points,
      errorPct: finalContext ? (100 * (predicted - finalContext)) / finalContext : 0,
    },
    byOrigin: [...byOrigin.values()].sort((a, b) => b.tokens - a.tokens),
    byLabel: [...byLabel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 24),
    dupes,
    dupeTokens: dupes.reduce((s, d) => s + d.wastedTokens, 0),
    top: [...blocks].sort((a, b) => b.tokens - a.tokens).slice(0, topLimit),
    growth,
  };
}
