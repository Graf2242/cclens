/**
 * Local HTTP server: static dashboard + a small read-only JSON API over the
 * index. Binds to 127.0.0.1 only — the index contains prompt text.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheReport } from './cache.ts';
import { cohortReport } from './cohort.ts';
import { baselineRuns, diagReport } from './diag.ts';
import { healthReport } from './health.ts';
import { contextReport } from './context.ts';
import { availableLocales, LOCALES_DIR, locale as activeLocale, t } from './i18n.ts';
import { openDb, type Metric } from './db.ts';
import { createIndexer, type Indexer } from './indexer.ts';
import { deleteProbe, listProbes, saveProbe } from './probeconfig.ts';
import { ensureProbeTables, previewProbe, probeFlags, probeReport, probeStatus } from './probes.ts';
import { createProbeRunner, type ProbeRunner } from './proberunner.ts';
import { rootPrompt } from './prompt.ts';
import { runHistory, stepText } from './runs.ts';
import {
  parseRef,
  renderIndex,
  renderMarkdown,
  resolveShare,
  ShareError,
} from './share.ts';
import { addSource, ephemeralSource, listSources, removeSource, type Source } from './sources.ts';

const withDb = (s: Source, dbPath?: string): Source => (dbPath ? { ...s, db: dbPath } : s);
import {
  activeDays,
  agentRuns,
  breakdown,
  cohortRuns,
  indexSpan,
  series,
  runFiles,
  runSummary,
  sessionInfo,
  sessionTimeline,
  totals,
  type Dimension,
  type Filters,
} from './queries.ts';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Static roots, tried in order by request prefix. `locales/` is served as-is
 * rather than copied into `web/` so the browser imports the very engine file
 * Node imports — the moment there are two copies, they drift.
 */
const STATIC_ROOTS: Array<{ prefix: string; dir: string }> = [
  { prefix: '/locales/', dir: LOCALES_DIR },
  { prefix: '/', dir: WEB_DIR },
];

const DIMENSIONS: Dimension[] = [
  'project',
  'agent',
  'model',
  'kind',
  'day',
  'session',
  'effort',
  'session_kind',
  'workflow',
];

function readFilters(q: URLSearchParams): Filters {
  const num = (k: string) => {
    const v = q.get(k);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) => q.get(k) || undefined;
  return {
    from: num('from'),
    to: num('to'),
    project: str('project'),
    agent: str('agent'),
    model: str('model'),
    kind: str('kind'),
    sessionId: str('session'),
  };
}

function readMetric(q: URLSearchParams): Metric {
  const m = q.get('metric');
  return m === 'weighted' || m === 'raw' ? m : 'usd';
}

export interface SourceRuntime {
  source: Source;
  db: ReturnType<typeof openDb>;
  indexer: Indexer;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      // Nothing legitimate posts here beyond a path; the cap is just a guard.
      if (body.length > 1e5) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startServer(opts: {
  port: number;
  dbPath?: string;
  root?: string;
}): Promise<{ port: number; sources: () => SourceRuntime[] }> {
  // `--root` pins the server to one directory: an explicit override is not a
  // registry entry, so nothing is written to `sources.json` and the dashboard
  // hides the add/remove affordances.
  const pinned = opts.root
    ? [withDb(ephemeralSource(opts.root), opts.dbPath)]
    : null;

  function sourceList(): Source[] {
    if (pinned) return pinned;
    const list = listSources();
    // `--db` still means "the main index lives here".
    return opts.dbPath ? [withDb(list[0], opts.dbPath), ...list.slice(1)] : list;
  }

  // A source's db and indexer are opened on first use and then kept: the
  // dashboard flips between them, and reopening SQLite per request would drop
  // the in-flight index state the status endpoint reports.
  const runtimes = new Map<string, SourceRuntime>();
  /** One probe sweep per source, kept alongside its runtime. */
  const probeRunners = new Map<string, ProbeRunner>();

  function probeRunnerFor(rt: SourceRuntime): ProbeRunner {
    let runner = probeRunners.get(rt.source.id);
    if (!runner) probeRunners.set(rt.source.id, (runner = createProbeRunner(rt.db, { root: rt.source.root })));
    return runner;
  }

  /** A deleted rule takes its hits with it — they can never be shown again. */
  function dropProbeHits(db: ReturnType<typeof openDb>, id: string): void {
    ensureProbeTables(db);
    db.prepare('DELETE FROM probe_hits WHERE probe_id = ?').run(id);
    db.prepare('DELETE FROM probe_files WHERE probe_id = ?').run(id);
  }

  function runtimeFor(source: Source): SourceRuntime {
    const cached = runtimes.get(source.id);
    if (cached && cached.source.root === source.root && cached.source.db === source.db) return cached;
    const db = openDb(source.db);
    const rt: SourceRuntime = { source, db, indexer: createIndexer(db, { root: source.root }) };
    runtimes.set(source.id, rt);
    return rt;
  }

  /** Unknown or stale ids fall back to the built-in source rather than 404. */
  function resolveRuntime(q: URLSearchParams): SourceRuntime {
    const list = sourceList();
    const id = q.get('source');
    return runtimeFor((id && list.find((s) => s.id === id)) || list[0]);
  }

  const describe = (s: Source) => ({ id: s.id, label: s.label, root: s.root, builtin: s.builtin });

  /**
   * Origin to build shareable links against. The port is whatever `serve` got,
   * including a random one, so it is read back off the request rather than
   * assumed — a link that names the wrong port is worse than no link.
   */
  const baseUrlOf = (req: http.IncomingMessage) =>
    'http://' + (req.headers.host ?? '127.0.0.1:4317');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(json);
    };
    const sendText = (code: number, body: string) => {
      res.writeHead(code, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    try {
      // ── sources ──────────────────────────────────────────────
      if (url.pathname === '/api/sources' && (req.method ?? 'GET') === 'GET') {
        return send(200, { mutable: !pinned, sources: sourceList().map(describe) });
      }

      if (url.pathname === '/api/sources' && req.method === 'POST') {
        if (pinned) return send(400, { error: t('server.error.rootPinned') });
        void readBody(req).then(
          (body) => {
            let source: Source;
            try {
              const input = String(JSON.parse(body || '{}').path ?? '');
              source = addSource(input);
            } catch (e) {
              return send(400, { error: e instanceof Error ? e.message : String(e) });
            }
            // A folder just added has no index yet; start one so the switch
            // lands on data instead of an empty dashboard.
            void runtimeFor(source).indexer.run();
            send(200, { source: describe(source), sources: sourceList().map(describe) });
          },
          (e) => send(400, { error: String(e) })
        );
        return;
      }

      if (url.pathname === '/api/sources' && req.method === 'DELETE') {
        if (pinned) return send(400, { error: t('server.error.rootPinned') });
        const id = url.searchParams.get('id');
        if (!id) return send(400, { error: 'id required' });
        try {
          removeSource(id);
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : String(e) });
        }
        const dropped = runtimes.get(id);
        runtimes.delete(id);
        // Best effort: an index still running holds the handle, and the file
        // stays on disk either way.
        try {
          dropped?.db.close();
        } catch {}
        return send(200, { sources: sourceList().map(describe) });
      }

      const runtime = resolveRuntime(url.searchParams);
      const { db, indexer } = runtime;

      // ── shared findings ──────────────────────────────────────
      //
      // `/s/<kind>?…` is the address of a finding, meant to be pasted to an
      // agent. It answers in plain text (markdown source) rather than
      // `text/markdown`, because both a browser tab and a fetching agent show
      // that inline, while a markdown content-type makes the browser download
      // the file instead of rendering anything.
      if (url.pathname === '/s' || url.pathname === '/s/') {
        return sendText(200, renderIndex(baseUrlOf(req)));
      }

      if (url.pathname.startsWith('/s/')) {
        const wantsJson = url.searchParams.get('format') === 'json';
        const respond = (r: Awaited<ReturnType<typeof resolveShare>>) => {
          if (wantsJson) return send(200, r);
          sendText(200, renderMarkdown(r, { baseUrl: baseUrlOf(req) }));
        };
        const fail = (e: unknown) => {
          const status = e instanceof ShareError ? e.status : 500;
          const msg = e instanceof Error ? e.message : String(e);
          if (wantsJson) return send(status, { error: msg });
          sendText(status, t('server.error.page', { message: msg, indexUrl: `${baseUrlOf(req)}/s` }));
        };
        try {
          const ref = parseRef(url.pathname + '?' + url.searchParams.toString());
          // `.then(respond, fail)` would leave a throw INSIDE respond — i.e. any
          // bug in a renderer — as an unhandled rejection, and an unhandled
          // rejection takes the whole server down with it. One bad link must
          // cost the reader an error page, not everyone else their session.
          void resolveShare(db, ref, describe(runtime.source)).then(respond).catch(fail);
        } catch (e) {
          fail(e);
        }
        return;
      }

      if (url.pathname === '/api/overview') {
        const filters = readFilters(url.searchParams);
        const metric = readMetric(url.searchParams);
        const dims = (url.searchParams.get('dims')?.split(',') ?? [
          'project',
          'agent',
          'model',
          'kind',
          'day',
        ]) as Dimension[];
        const out: Record<string, unknown> = {
          metric,
          total: totals(db, filters, metric),
          span: indexSpan(db),
          activeDays: activeDays(db),
        };
        for (const d of dims) {
          if (!DIMENSIONS.includes(d)) continue;
          out[d] = breakdown(db, d, filters, metric, d === 'day' ? 400 : 40);
        }
        return send(200, out);
      }

      if (url.pathname === '/api/series') {
        const dim = (url.searchParams.get('dim') ?? 'project') as Dimension;
        if (!DIMENSIONS.includes(dim)) return send(400, { error: 'bad dim' });
        const metric = readMetric(url.searchParams);
        const bucket = url.searchParams.get('bucket') === 'hour' ? 'hour' : 'day';
        return send(200, series(db, dim, readFilters(url.searchParams), metric, 8, bucket));
      }

      if (url.pathname === '/api/sessions') {
        const filters = readFilters(url.searchParams);
        const metric = readMetric(url.searchParams);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return send(200, {
          metric,
          sessions: breakdown(db, 'session', filters, metric, limit).map((b) => ({
            ...b,
            info: sessionInfo(db, b.key),
          })),
        });
      }

      if (url.pathname === '/api/session') {
        const id = url.searchParams.get('id');
        if (!id) return send(400, { error: 'id required' });
        const metric = readMetric(url.searchParams);
        const data = {
          metric,
          info: sessionInfo(db, id),
          agents: breakdown(db, 'agent', { sessionId: id }, metric, 100),
          models: breakdown(db, 'model', { sessionId: id }, metric, 20),
          timeline: sessionTimeline(db, id, metric),
        };
        // The prompt is read off disk, and the read stops at the first human
        // turn — but a session whose file was deleted still has a timeline
        // worth showing, so a failure here degrades to `prompt: null`.
        void rootPrompt(runFiles(db, id, 'main')).then(
          (prompt) => send(200, { ...data, prompt }),
          () => send(200, { ...data, prompt: null })
        );
        return;
      }

      if (url.pathname === '/api/runs') {
        const sessionId = url.searchParams.get('session');
        const agent = url.searchParams.get('agent');
        if (!sessionId || !agent) return send(400, { error: 'session and agent required' });
        const metric = readMetric(url.searchParams);
        return send(200, { metric, agent, runs: agentRuns(db, sessionId, agent, metric) });
      }

      if (url.pathname === '/api/run') {
        const sessionId = url.searchParams.get('session');
        const runId = url.searchParams.get('run');
        if (!sessionId || !runId) return send(400, { error: 'session and run required' });
        const metric = readMetric(url.searchParams);
        const files = runFiles(db, sessionId, runId);
        if (!files.length) return send(404, { error: 'unknown run' });
        void runHistory(files, metric).then(
          (steps) => send(200, { metric, run: runSummary(db, sessionId, runId, metric), steps }),
          (e) => send(500, { error: String(e) })
        );
        return;
      }

      // One message, unclipped — the history sends previews, this fills in the
      // one the reader unfolded.
      if (url.pathname === '/api/step') {
        const sessionId = url.searchParams.get('session');
        const runId = url.searchParams.get('run');
        const raw = url.searchParams.get('index');
        const index = Number(raw);
        if (!sessionId || !runId) return send(400, { error: 'session and run required' });
        if (raw == null || !Number.isInteger(index) || index < 0) return send(400, { error: 'index required' });
        const files = runFiles(db, sessionId, runId);
        if (!files.length) return send(404, { error: 'unknown run' });
        void stepText(files, index).then(
          (text) => (text == null ? send(404, { error: 'unknown step' }) : send(200, { index, text })),
          (e) => send(500, { error: String(e) })
        );
        return;
      }

      if (url.pathname === '/api/context') {
        const sessionId = url.searchParams.get('session');
        const runId = url.searchParams.get('run');
        if (!sessionId || !runId) return send(400, { error: 'session and run required' });
        const files = runFiles(db, sessionId, runId);
        if (!files.length) return send(404, { error: 'unknown run' });
        const turn = Number(url.searchParams.get('turn'));
        void contextReport(files, { turn: Number.isFinite(turn) && turn > 0 ? turn : undefined }).then(
          (r) => send(200, r),
          (e) => send(500, { error: String(e) })
        );
        return;
      }

      // The cohort report re-reads every run of one agent, so it is behind an
      // explicit request in the UI, never part of the agent view's first load.
      if (url.pathname === '/api/cohort') {
        const sessionId = url.searchParams.get('session');
        const agent = url.searchParams.get('agent');
        if (!sessionId || !agent) return send(400, { error: 'session and agent required' });
        const metric = readMetric(url.searchParams);
        const workflowId = url.searchParams.get('workflow');
        const runs = cohortRuns(db, sessionId, agent, metric, workflowId);
        if (runs.length < 2) return send(400, { error: t('server.error.needTwoRuns') });
        void cohortReport(runs, {
          metric,
          agent,
          workflowId,
          actualValue: runs.reduce((s, r) => s + r.value, 0),
        }).then(
          (r) => send(200, r),
          (e) => send(500, { error: String(e) })
        );
        return;
      }

      if (url.pathname === '/api/cache') {
        return send(200, cacheReport(db, readFilters(url.searchParams)));
      }

      // Both halves of the diagnostics screen in one round-trip: they share the
      // period and the filters, and splitting them would only make the screen
      // render in two jumps.
      //
      // Scoped to ONE session (the drawer's diagnostics tab) the outlier medians
      // come from the whole index instead: a session holds a handful of runs per
      // agent, which is not a history, and judging a fan-out against itself
      // answers a different question than the one the section is for.
      if (url.pathname === '/api/diag') {
        const filters = readFilters(url.searchParams);
        const metric = readMetric(url.searchParams);
        const baseline = filters.sessionId ? baselineRuns(db, {}, metric) : undefined;
        return send(200, {
          metric,
          diag: diagReport(db, filters, metric, baseline),
          health: healthReport(db, filters, metric),
        });
      }

      // ── probes ───────────────────────────────────────────────
      //
      // The rules live in one JSON file next to the index and are the same for
      // every source; the HITS are per-source, because they are attributed to
      // that source's runs.
      if (url.pathname === '/api/probes' && (req.method ?? 'GET') === 'GET') {
        return send(200, { probes: listProbes(), status: probeStatus(db), run: probeRunnerFor(runtime).state() });
      }

      if (url.pathname === '/api/probes' && req.method === 'POST') {
        void readBody(req).then(
          (body) => {
            let saved;
            try {
              saved = saveProbe(JSON.parse(body || '{}') as never);
            } catch (e) {
              // `field` rides alongside the message so the editor can highlight
              // the offending input without parsing translated prose.
              const field = (e as { field?: string }).field;
              return send(400, {
                error: e instanceof Error ? e.message : String(e),
                ...(field ? { field } : {}),
              });
            }
            send(200, { probe: saved, probes: listProbes(), status: probeStatus(db) });
          },
          (e) => send(400, { error: String(e) })
        );
        return;
      }

      if (url.pathname === '/api/probes' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return send(400, { error: 'id required' });
        try {
          deleteProbe(id);
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : String(e) });
        }
        dropProbeHits(db, id);
        return send(200, { probes: listProbes(), status: probeStatus(db) });
      }

      // A first sweep reads the whole corpus, so it is fire-and-poll like the
      // index; later sweeps are incremental and usually finish before the poll.
      if (url.pathname === '/api/probes/run' && req.method === 'POST') {
        void readBody(req).then(
          (body) => {
            let opts: any;
            try {
              opts = JSON.parse(body || '{}');
            } catch {
              return send(400, { error: t('server.error.badJson') });
            }
            const only = typeof opts.id === 'string' ? listProbes().filter((p) => p.id === opts.id) : undefined;
            void probeRunnerFor(runtime).run({ probes: only, force: !!opts.force });
            send(202, probeRunnerFor(runtime).state());
          },
          () => send(400, { error: t('server.error.unreadableBody') })
        );
        return;
      }

      if (url.pathname === '/api/probes/status') {
        return send(200, { run: probeRunnerFor(runtime).state(), status: probeStatus(db) });
      }

      // The editor's "try it" button: a rule is run over the newest files and
      // nothing is written, so a half-finished regex costs nothing.
      if (url.pathname === '/api/probes/preview' && req.method === 'POST') {
        void readBody(req).then(
          (body) => {
            let def;
            try {
              def = JSON.parse(body || '{}');
            } catch (e) {
              return send(400, { error: t('server.error.badJson') });
            }
            return previewProbe(db, def, { root: runtime.source.root }).then(
              (r) => send(200, r),
              (e) => send(400, { error: e instanceof Error ? e.message : String(e) })
            );
          },
          (e) => send(400, { error: String(e) })
        );
        return;
      }

      if (url.pathname === '/api/probe') {
        const id = url.searchParams.get('id');
        if (!id) return send(400, { error: 'id required' });
        try {
          return send(200, probeReport(db, id, readFilters(url.searchParams), readMetric(url.searchParams)));
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Badges in the session's run tables: which runs a probe flagged.
      if (url.pathname === '/api/probe-flags') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return send(400, { error: 'session required' });
        return send(200, { flags: probeFlags(db, sessionId) });
      }

      // Reindex is fire-and-poll: a cold index runs for minutes, which no
      // browser would hold a request open for. The click starts (or joins)
      // the run, `/api/index-status` reports how it goes.
      if (url.pathname === '/api/reindex' && req.method === 'POST') {
        void indexer.run();
        return send(202, indexer.state());
      }

      if (url.pathname === '/api/index-status') {
        return send(200, indexer.state());
      }

      // The dashboard's messages. Locale and catalog travel together so the
      // browser cannot end up rendering one language's catalog under another
      // language's plural rules. `?locale=` lets the browser ask for a
      // locale independent of the server's own `BURNLENS_LOCALE` — an unknown
      // code falls back to it, same check `pickLocale()` does.
      if (url.pathname === '/api/i18n') {
        const wanted = url.searchParams.get('locale');
        const locales = availableLocales();
        const locale = wanted && locales.includes(wanted) ? wanted : activeLocale;
        return send(200, {
          locale,
          catalog: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')),
          locales,
        });
      }

      // Static files
      const root = STATIC_ROOTS.find((r) => url.pathname.startsWith(r.prefix))!;
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(root.prefix.length);
      const file = path.join(root.dir, rel);
      if (!file.startsWith(root.dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      // No caching for the dashboard's own assets: this is a local tool that
      // gets edited while it runs, and a stale styles.css reads as a bug.
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      return res.end(fs.readFileSync(file));
    } catch (err) {
      send(500, { error: String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        sources: () => sourceList().map(runtimeFor),
      });
    });
  });
}
