/**
 * Cost model. Three metrics, all derived from the same raw counters:
 *
 *   usd      — API list price in dollars. Universal, comparable, but on a
 *              subscription it is only a proxy for what you actually burn.
 *   weighted — "limit units": tokens rescaled by how expensive each token
 *              class is relative to a plain Sonnet input token. This is the
 *              shape subscription limits have; the exact multipliers are not
 *              public, so WEIGHTS is a documented guess you can tune.
 *   raw      — literal token count, no weighting at all.
 *
 * Cache writes are billed at two rates depending on TTL: the 5-minute
 * ephemeral cache is 1.25x base input, the 1-hour one is 2x. The JSONL keeps
 * them apart in `usage.cache_creation`, so we do too — for this corpus the 1h
 * bucket dominates, and collapsing them understates spend by a wide margin.
 */

/** Dollars per million tokens: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]. */
export type PriceRow = readonly [number, number, number, number, number];

export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'unknown';

export const PRICES: Record<Tier, PriceRow> = {
  fable: [10, 50, 12.5, 20, 1],
  opus: [5, 25, 6.25, 10, 0.5],
  sonnet: [2, 10, 2.5, 4, 0.3],
  haiku: [1, 5, 1.25, 2, 0.1],
  unknown: [0, 0, 0, 0, 0],
};

/**
 * Multipliers for the `weighted` metric, in units of "one Sonnet input token".
 * Derived from PRICES so the two metrics stay proportional by construction;
 * override this table if you learn the real limit accounting.
 */
const WEIGHT_BASE = PRICES.sonnet[0];

export function tierOf(model: string | null | undefined): Tier {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return 'unknown';
}

/** The five raw counters we keep per assistant message. */
export interface Counters {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const ZERO: Counters = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

function apply(c: Counters, p: PriceRow): number {
  return (
    c.input * p[0] +
    c.output * p[1] +
    c.cacheWrite5m * p[2] +
    c.cacheWrite1h * p[3] +
    c.cacheRead * p[4]
  );
}

/** Dollars for one message's counters under the given model. */
export function usdOf(c: Counters, model: string | null | undefined): number {
  return apply(c, PRICES[tierOf(model)]) / 1e6;
}

/** Limit-units for one message's counters: price rescaled to Sonnet input tokens. */
export function weightedOf(c: Counters, model: string | null | undefined): number {
  return apply(c, PRICES[tierOf(model)]) / WEIGHT_BASE;
}

/** Literal token count, unweighted. */
export function rawOf(c: Counters): number {
  return c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h;
}
