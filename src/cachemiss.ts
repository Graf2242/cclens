/**
 * Why did a turn pay to re-cache a context it had already cached?
 *
 * One rule, two callers: the run view detects it per step while reading a
 * JSONL, the cache report detects it per message while walking the index.
 * Both must agree, so the predicate lives here and nowhere else.
 *
 * Detection is comparative, not absolute. A turn is a miss when it re-writes
 * tokens the PREVIOUS turn had already cached and reads back little or
 * nothing: same conversation, same tokens, billed at the write rate instead
 * of the read rate. The first turn of a run writes its whole context too, but
 * there was nothing to reuse — that write is the price of starting, not waste.
 *
 * A miss is NOT the same thing as an expiry, and conflating them mis-prices
 * the 1h-TTL question. Measured over the corpus: 72 of 181 misses happened
 * with the pause SHORTER than the TTL that was in force — the whole main
 * thread runs on the 1h TTL, yet 39 of its 70 misses follow pauses of
 * seconds. Those are prefix invalidations: the request's stable head changed
 * (a tool schema loaded by ToolSearch, a skill/agent listing refreshed), so
 * everything after it had to be written again. Their signature is a read of
 * exactly the system+tools prefix — the same 18–22k in every miss of a given
 * session — while the whole conversation is re-written.
 *
 * The distinction is load-bearing: a longer TTL cannot prevent a miss whose
 * pause never reached the current TTL.
 */

/** Default ephemeral TTL. The 1h TTL is opt-in per request. */
export const CACHE_TTL_5M_MS = 5 * 60 * 1000;
export const CACHE_TTL_1H_MS = 60 * 60 * 1000;

/** Half the previous context is the bar for "this is a re-write, not a delta". */
const SHARE = 0.5;

/** Which TTL a turn used — not a flag to trust, the two buckets bill apart. */
export type CacheTtl = '5m' | '1h';

/**
 * `expired` — the pause outlived the TTL, so a longer TTL would have helped.
 * `invalidated` — the pause was shorter than the TTL: the cached prefix was
 * dropped for some other reason and no TTL setting would have saved it.
 */
export type MissCause = 'expired' | 'invalidated';

export function ttlOf(cacheWrite5m: number): CacheTtl {
  return cacheWrite5m > 0 ? '5m' : '1h';
}

export function ttlMs(ttl: CacheTtl): number {
  return ttl === '1h' ? CACHE_TTL_1H_MS : CACHE_TTL_5M_MS;
}

export function missCause(idleMs: number, ttl: CacheTtl): MissCause {
  return idleMs >= ttlMs(ttl) ? 'expired' : 'invalidated';
}

/**
 * Tokens this turn paid to re-cache that the previous turn had already cached.
 * Zero when the turn is not a miss.
 */
export function rewrittenTokens(
  prevContext: number,
  cacheRead: number,
  cacheWrite: number
): number {
  if (prevContext <= 0) return 0;
  if (cacheRead >= prevContext * SHARE) return 0;
  const rewritten = Math.min(cacheWrite, prevContext);
  return rewritten >= prevContext * SHARE ? rewritten : 0;
}
