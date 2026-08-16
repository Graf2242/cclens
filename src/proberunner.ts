/**
 * One probe sweep at a time per source, shared by the dashboard's buttons.
 *
 * Same shape and same reason as `indexer.ts`: a first sweep reads the whole
 * corpus, no browser holds a request open that long, and two overlapping
 * sweeps on one `DatabaseSync` would nest transactions mid-file. So a second
 * caller joins the run in flight instead of starting another.
 *
 * It is deliberately NOT folded into the indexer. Indexing is about what the
 * logs cost; a probe is a question the user asked this afternoon and may edit
 * again in a minute. Tying the two would mean re-reading a gigabyte of JSONL
 * every time someone fixes a typo in a regex.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ProbeDef } from './probeconfig.ts';
import { runProbes, type ProbeRunProgress, type ProbeRunResult } from './probes.ts';

export interface ProbeRunState {
  running: boolean;
  startedAt: number | null;
  progress: { scanned: number; total: number; hits: number } | null;
  last: (ProbeRunResult & { finishedAt: number }) | null;
  error: string | null;
}

export interface ProbeRunner {
  run(opts?: { probes?: ProbeDef[]; force?: boolean }): Promise<ProbeRunResult>;
  state(): ProbeRunState;
}

export function createProbeRunner(db: DatabaseSync, opts: { root?: string } = {}): ProbeRunner {
  let inflight: Promise<ProbeRunResult> | null = null;
  const state: ProbeRunState = {
    running: false,
    startedAt: null,
    progress: null,
    last: null,
    error: null,
  };

  function run(runOpts: { probes?: ProbeDef[]; force?: boolean } = {}): Promise<ProbeRunResult> {
    if (inflight) return inflight;

    state.running = true;
    state.startedAt = Date.now();
    state.progress = null;
    state.error = null;

    const job = runProbes(db, {
      root: opts.root,
      probes: runOpts.probes,
      force: runOpts.force,
      onProgress: (p: ProbeRunProgress) => {
        state.progress = { scanned: p.scanned, total: p.total, hits: p.hits };
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
        inflight = null;
      });

    inflight = job;
    // A failed sweep must not take the server down; awaiting callers still see it.
    job.catch(() => {});
    return job;
  }

  return { run, state: () => ({ ...state }) };
}
