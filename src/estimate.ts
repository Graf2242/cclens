/**
 * Turning sizes in the log into money.
 *
 * The log stores characters; the bill is in tokens. `context.ts` fits the
 * ratio per run from that run's own context growth, which is the accurate way
 * and costs a second pass over the JSONL. The diagnostics here work off the
 * index instead — thousands of tool calls across the whole corpus — so they
 * use the ratio that fit converges to on this mix of Russian, English and
 * code. Every number derived from it is an ESTIMATE and is labelled as one in
 * the UI; the ranking it produces is what matters, not the third digit.
 *
 * The second idea is CARRY. A tool result is not paid for once. It is written
 * to the cache on the turn it arrives and then re-sent as a cache read on
 * every later turn of the same context window — on Opus the read side of a
 * block that lands early is the larger half of its cost. So the price of a
 * block is one write plus its actual re-sends, which is why a 12k document
 * read on turn 2 of a 40-turn run costs several times the same document read
 * on the last turn.
 */

import { PRICES, tierOf } from './pricing.ts';

/**
 * Characters per token. Measured across the corpus by `context.ts`'s own fit:
 * 2.3–2.5 depending on the run's mix, converging to 2.4.
 */
export const CHARS_PER_TOKEN = 2.4;

export function tokensOf(chars: number): number {
  return chars / CHARS_PER_TOKEN;
}

/**
 * What a block of `tokens` costs when it enters the context on `turn` of a run
 * that lasted `turnsTotal`: written to cache once, then read back on each
 * remaining turn.
 *
 * `turnsTotal` is the whole file, which over-states the carry of a run that
 * compacted mid-way (after a compaction the history is thrown away and there
 * is nothing left to carry). Compactions are rare — 36 across the corpus — and
 * the `compactions` diagnostic reports them separately, so the over-statement
 * is visible rather than hidden.
 */
export function carriedCost(
  tokens: number,
  turn: number,
  turnsTotal: number,
  model: string | null | undefined
): { writeUsd: number; carryUsd: number; usd: number; carryTurns: number } {
  const p = PRICES[tierOf(model)];
  const carryTurns = Math.max(0, turnsTotal - turn);
  const writeUsd = (tokens * p[2]) / 1e6;
  const carryUsd = (tokens * carryTurns * p[4]) / 1e6;
  return { writeUsd, carryUsd, usd: writeUsd + carryUsd, carryTurns };
}

/** Same shape in limit-units, so the metric switch keeps working everywhere. */
export function toWeighted(usd: number): number {
  return usd / (PRICES.sonnet[0] / 1e6);
}

/**
 * The break-even turn for moving a block into a shared prefix: below it the
 * write saved outweighs the extra carry, above it the trade loses money.
 * `cohort.ts` derives the same 12.5 on Opus — this is the general form.
 */
export function breakEvenTurn(model: string | null | undefined): number {
  const p = PRICES[tierOf(model)];
  return p[2] / p[4];
}
