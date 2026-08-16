/**
 * One indexing job at a time, shared by the CLI's startup pass and the
 * dashboard's button.
 *
 * Both callers land on the same `DatabaseSync` connection, and `indexAll`
 * drives explicit BEGIN/COMMIT — two overlapping runs would nest transactions
 * on one connection and blow up mid-file. So a second caller does not start a
 * second run: it joins the one already in flight and gets its result.
 */

import type { DatabaseSync } from 'node:sqlite';

import { indexAll, type IndexProgress, type IndexResult } from './db.ts';

export interface IndexState {
  running: boolean;
  startedAt: number | null;
  /** Live counters of the current run; null between runs. */
  progress: { scanned: number; total: number; changed: number } | null;
  last: (IndexResult & { finishedAt: number }) | null;
  error: string | null;
}

export interface Indexer {
  /** Starts a run, or joins the one in flight. `onProgress` fires either way. */
  run(onProgress?: (p: IndexProgress) => void): Promise<IndexResult>;
  state(): IndexState;
}

export function createIndexer(db: DatabaseSync, opts: { root?: string } = {}): Indexer {
  let inflight: Promise<IndexResult> | null = null;
  const listeners = new Set<(p: IndexProgress) => void>();
  const state: IndexState = {
    running: false,
    startedAt: null,
    progress: null,
    last: null,
    error: null,
  };

  function run(onProgress?: (p: IndexProgress) => void): Promise<IndexResult> {
    if (onProgress) listeners.add(onProgress);
    if (inflight) return inflight;

    state.running = true;
    state.startedAt = Date.now();
    state.progress = null;
    state.error = null;

    const job = indexAll(db, {
      root: opts.root,
      onProgress: (p) => {
        state.progress = { scanned: p.scanned, total: p.total, changed: p.changed };
        for (const l of listeners) l(p);
      },
    })
      .then(
        (r) => {
          state.last = { ...r, finishedAt: Date.now() };
          return r;
        },
        (e) => {
          state.error = String(e);
          throw e;
        }
      )
      .finally(() => {
        state.running = false;
        state.progress = null;
        listeners.clear();
        inflight = null;
      });

    inflight = job;
    // A failed background run must not take the process down with it; every
    // caller that awaits `job` still sees the rejection.
    job.catch(() => {});
    return job;
  }

  return { run, state: () => ({ ...state }) };
}
