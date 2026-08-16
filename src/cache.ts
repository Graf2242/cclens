/**
 * Cache-waste report.
 *
 * Two questions, both answered from the index alone — no JSONL scan, because
 * the counters plus message order are enough:
 *
 *   1. Where did a turn pay to re-cache a context it already had, and what did
 *      that cost? Such a turn pays the write rate (12.5–20x the read rate) for
 *      tokens that did not change.
 *   2. Would a 1-hour TTL have been cheaper? Counterfactual, not opinion:
 *      re-price every message that is on the 5-minute TTL today as if it had
 *      been written with `ttl: "1h"` — misses whose pause fell between the two
 *      TTLs turn into reads, but every write costs 2x input instead of 1.25x.
 *
 * Only misses the longer TTL could actually have prevented are credited as
 * savings: a miss after a 40-second pause on a 5-minute TTL was not an expiry
 * at all (see `cachemiss.ts`), and a longer TTL leaves it exactly where it is.
 *
 * Which TTL a message used is not a flag we have to trust — it is visible in
 * the counters, since the two buckets are billed separately and stored apart.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  CACHE_TTL_1H_MS,
  missCause,
  rewrittenTokens,
  ttlOf,
  type CacheTtl,
  type MissCause,
} from './cachemiss.ts';
import { usdOf, weightedOf, ZERO, type Counters } from './pricing.ts';
import { buildWhere, type Filters } from './queries.ts';

export interface CacheMissRow {
  ts: number;
  day: string;
  agent: string;
  sessionId: string;
  runId: string;
  model: string | null;
  /** Tokens re-cached that the previous turn had already paid to cache. */
  tokens: number;
  idleMs: number;
  /** The TTL this message actually used, read off its counters. */
  ttl: CacheTtl;
  /** Whether the TTL is even implicated: pause past it, or prefix dropped. */
  cause: MissCause;
  extraUsd: number;
  extraWeighted: number;
  /** What the whole turn cost, for context on the overpay. */
  turnUsd: number;
}

export interface CacheAgentRow {
  agent: string;
  misses: number;
  tokens: number;
  extraUsd: number;
  extraWeighted: number;
}

export interface CacheReport {
  /** Every miss, biggest overpay first (capped for transport). */
  misses: CacheMissRow[];
  missesTotal: number;
  byAgent: CacheAgentRow[];
  byDay: { day: string; extraUsd: number; extraWeighted: number; misses: number }[];
  totals: {
    messages: number;
    runs: number;
    /** Split by the TTL actually used — one is opt-in, the other is the default. */
    ttl5m: { misses: number; tokens: number; extraUsd: number; write: number };
    ttl1h: { misses: number; tokens: number; extraUsd: number; write: number };
    /** Split by cause: only `expired` is a TTL question at all. */
    expired: { misses: number; tokens: number; extraUsd: number };
    invalidated: { misses: number; tokens: number; extraUsd: number };
    /** Median / max pause that actually outlived a 5m entry. */
    medianIdleMs: number | null;
    maxIdleMs: number | null;
    /** Expired 5m misses whose pause was longer than an hour: 1h would not have helped. */
    lateMisses: number;
  };
  /** What `ENABLE_PROMPT_CACHING_1H` would have done to this window. */
  counterfactual: {
    actualUsd: number;
    hypoUsd: number;
    savedUsd: number;
    premiumUsd: number;
    actualWeighted: number;
    hypoWeighted: number;
    savedWeighted: number;
    premiumWeighted: number;
  };
}

interface Row {
  ts: number;
  day: string;
  agent: string;
  sid: string;
  rid: string;
  model: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_w5m: number;
  cache_w1h: number;
}

const counters = (r: Row): Counters => ({
  input: r.input,
  output: r.output,
  cacheRead: r.cache_read,
  cacheWrite5m: r.cache_w5m,
  cacheWrite1h: r.cache_w1h,
});

export function cacheReport(db: DatabaseSync, filters: Filters, limit = 80): CacheReport {
  const where = buildWhere(filters);
  // Ordered by run, then time: the miss rule only ever looks one turn back,
  // and a run never spans two sessions.
  const rows = db
    .prepare(
      `SELECT m.ts, m.day, m.agent, m.session_id AS sid, coalesce(m.agent_id, 'main') AS rid,
              m.model, m.input, m.output, m.cache_read, m.cache_w5m, m.cache_w1h
       FROM msgs m ${where.sql}
       ORDER BY m.session_id, rid, m.ts`
    )
    .all(...where.params) as unknown as Row[];

  const misses: CacheMissRow[] = [];
  const byAgent = new Map<string, CacheAgentRow>();
  const byDay = new Map<string, { day: string; extraUsd: number; extraWeighted: number; misses: number }>();
  const gaps: number[] = [];

  const t5 = { misses: 0, tokens: 0, extraUsd: 0, write: 0 };
  const t1 = { misses: 0, tokens: 0, extraUsd: 0, write: 0 };
  const byCause = {
    expired: { misses: 0, tokens: 0, extraUsd: 0 },
    invalidated: { misses: 0, tokens: 0, extraUsd: 0 },
  };
  let actualUsd = 0, hypoUsd = 0, savedUsd = 0, premiumUsd = 0;
  let actualW = 0, hypoW = 0, savedW = 0, premiumW = 0;
  let lateMisses = 0;
  let runs = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const c = counters(r);
    const write = r.cache_w5m + r.cache_w1h;
    const aUsd = usdOf(c, r.model), aW = weightedOf(c, r.model);
    actualUsd += aUsd;
    actualW += aW;

    const prev = i > 0 && rows[i - 1].sid === r.sid && rows[i - 1].rid === r.rid ? rows[i - 1] : null;
    if (!prev) runs++;

    // The TTL is inferred from where the write landed. A message with no write
    // at all is neutral: nothing to re-price either way.
    const ttl = ttlOf(r.cache_w5m);
    const on5m = ttl === '5m';
    (on5m ? t5 : t1).write += write;

    let rewritten = 0, gap = 0;
    if (prev) {
      const prevCtx = prev.input + prev.cache_read + prev.cache_w5m + prev.cache_w1h;
      rewritten = rewrittenTokens(prevCtx, r.cache_read, write);
      gap = r.ts - prev.ts;
    }
    // Only an expiry is a TTL question; a shorter pause than the TTL means the
    // prefix was dropped for another reason, and no TTL setting recovers it.
    const cause = missCause(gap, ttl);
    const recoverable = rewritten > 0 && on5m && cause === 'expired' && gap <= CACHE_TTL_1H_MS;

    if (rewritten) {
      // Priced against the bucket the write actually used: 1.25x input on the
      // 5m TTL, 2x on the 1h one, against 0.1x for the read it replaced.
      const written: Counters = on5m
        ? { ...ZERO, cacheWrite5m: rewritten }
        : { ...ZERO, cacheWrite1h: rewritten };
      const asRead: Counters = { ...ZERO, cacheRead: rewritten };
      const extraUsd = usdOf(written, r.model) - usdOf(asRead, r.model);
      const extraW = weightedOf(written, r.model) - weightedOf(asRead, r.model);

      const bucket = on5m ? t5 : t1;
      bucket.misses++;
      bucket.tokens += rewritten;
      bucket.extraUsd += extraUsd;
      byCause[cause].misses++;
      byCause[cause].tokens += rewritten;
      byCause[cause].extraUsd += extraUsd;
      if (on5m && cause === 'expired') {
        gaps.push(gap);
        if (gap > CACHE_TTL_1H_MS) lateMisses++;
      }

      misses.push({
        ts: r.ts, day: r.day, agent: r.agent, sessionId: r.sid, runId: r.rid, model: r.model,
        tokens: rewritten, idleMs: gap, ttl, cause,
        extraUsd, extraWeighted: extraW, turnUsd: aUsd,
      });

      let a = byAgent.get(r.agent);
      if (!a) byAgent.set(r.agent, (a = { agent: r.agent, misses: 0, tokens: 0, extraUsd: 0, extraWeighted: 0 }));
      a.misses++;
      a.tokens += rewritten;
      a.extraUsd += extraUsd;
      a.extraWeighted += extraW;

      let d = byDay.get(r.day);
      if (!d) byDay.set(r.day, (d = { day: r.day, extraUsd: 0, extraWeighted: 0, misses: 0 }));
      d.extraUsd += extraUsd;
      d.extraWeighted += extraW;
      d.misses++;
    }

    // Counterfactual. Messages already on the 1h TTL are held fixed: turning
    // the flag on changes nothing for them, and their misses are evidence the
    // TTL was not the cause.
    if (!on5m) {
      hypoUsd += aUsd;
      hypoW += aW;
      continue;
    }
    if (recoverable) {
      const hc: Counters = {
        input: r.input, output: r.output,
        cacheRead: r.cache_read + rewritten,
        cacheWrite5m: 0, cacheWrite1h: write - rewritten,
      };
      const h = usdOf(hc, r.model), hw = weightedOf(hc, r.model);
      savedUsd += aUsd - h;
      savedW += aW - hw;
      hypoUsd += h;
      hypoW += hw;
    } else {
      const hc: Counters = {
        input: r.input, output: r.output, cacheRead: r.cache_read,
        cacheWrite5m: 0, cacheWrite1h: write,
      };
      const h = usdOf(hc, r.model), hw = weightedOf(hc, r.model);
      premiumUsd += h - aUsd;
      premiumW += hw - aW;
      hypoUsd += h;
      hypoW += hw;
    }
  }

  gaps.sort((a, b) => a - b);
  misses.sort((a, b) => b.extraUsd - a.extraUsd);

  return {
    misses: misses.slice(0, limit),
    missesTotal: misses.length,
    byAgent: [...byAgent.values()].sort((a, b) => b.extraUsd - a.extraUsd),
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    totals: {
      messages: rows.length,
      runs,
      ttl5m: t5,
      ttl1h: t1,
      expired: byCause.expired,
      invalidated: byCause.invalidated,
      medianIdleMs: gaps.length ? gaps[gaps.length >> 1] : null,
      maxIdleMs: gaps.length ? gaps[gaps.length - 1] : null,
      lateMisses,
    },
    counterfactual: {
      actualUsd, hypoUsd, savedUsd, premiumUsd,
      actualWeighted: actualW, hypoWeighted: hypoW, savedWeighted: savedW, premiumWeighted: premiumW,
    },
  };
}
