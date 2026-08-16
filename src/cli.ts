#!/usr/bin/env node
/**
 * burnlens — where your Claude Code tokens actually go.
 *
 *   burnlens index            build/refresh the index (incremental)
 *   burnlens report           terminal breakdown for a period
 *   burnlens serve            dashboard on localhost
 */

import { cohortReport } from './cohort.ts';
import { fmt, t } from './i18n.ts';
import { diagReport } from './diag.ts';
import { healthReport } from './health.ts';
import { listProbes, probesPath } from './probeconfig.ts';
import { probeReport, probeStatus, runProbes } from './probes.ts';
import { indexAll, openDb, METRIC_COLUMN, type Metric } from './db.ts';
import { breakdown, cohortRuns, indexSpan, totals, type Dimension, type Filters } from './queries.ts';
import { startServer } from './server.ts';
import { parseRef, renderIndex, renderMarkdown, resolveShare } from './share.ts';
import { builtinSource, ephemeralSource, listSources, type Source } from './sources.ts';

interface Args {
  cmd: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
  const flags: Record<string, string | boolean> = {};
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { cmd, flags };
}

const money = {
  usd: (v: number) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)),
  tokens: (v: number) =>
    v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : String(Math.round(v)),
};

function renderMetric(v: number, metric: Metric): string {
  return metric === 'usd' ? money.usd(v) : money.tokens(v);
}

/**
 * The diagnostics screen, in a terminal. Same report the dashboard reads, cut
 * down to the rows a person can act on: the whole thing is a dozen tables and
 * printing all of them would bury the two that matter.
 */
function cmdDiag(flags: Args['flags']) {
  const source = pickSources(flags, 'one')[0];
  const db = openDb(source.db);
  const days = flags.days === 'all' ? null : Number(flags.days ?? 30);
  const metric: Metric =
    flags.metric === 'weighted' || flags.metric === 'raw' ? (flags.metric as Metric) : 'usd';
  const filters: Filters = days == null ? {} : { from: Date.now() - days * 864e5 };
  if (typeof flags.project === 'string') filters.project = flags.project;
  if (typeof flags.agent === 'string') filters.agent = flags.agent;
  const top = Number(flags.top ?? 8);
  const m = (v: number) => renderMetric(v, metric);

  const tot = totals(db, filters, metric);
  if (!tot.messages) {
    console.log(t('cli.emptyIndex'));
    return;
  }

  const d = diagReport(db, filters, metric);
  const h = healthReport(db, filters, metric);
  const head = (s: string) => console.log(`\n  ── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`);

  console.log(
    t('cli.diag.summary', {
      period: days == null ? t('cli.period.all') : t('cli.period.lastDays', { n: days }),
      source: source.builtin ? '' : t('cli.sourceSuffix', { label: source.label }),
      value: m(tot.value),
      messages: t('cli.messages', { n: tot.messages }),
    })
  );

  const c = d.toolCensus;
  head(t('cli.diag.head.contextCost'));
  console.log(
    t('cli.diag.collected', { value: m(c.totals.value), percent: Math.round(100 * c.totals.carryShare) })
  );

  head(t('cli.diag.head.outliers'));
  if (!d.outliers.runs.length) console.log(t('cli.diag.noOutliers'));
  for (const r of d.outliers.runs.slice(0, top)) {
    console.log(
      '  ' + m(r.value).padStart(9) + ('  ' + r.ratio.toFixed(1) + '×').padStart(7) +
        '  ' + t('cli.diag.median') + ' ' + m(r.medianValue).padStart(8) +
        '  ' + String(r.turns).padStart(4) + ' ' + t('cli.diag.turnsLabel') + '  ' + r.agent
    );
  }
  if (d.outliers.unjudged.length) {
    console.log(t('cli.diag.unjudged', { list: d.outliers.unjudged.join(', ') }));
  }

  head(t('cli.diag.head.unitCost'));
  // The two per-unit columns are dollars by construction, whatever metric the
  // rest of the report is in — printing them through the token formatter would
  // turn $1.29 into "1".
  console.log(
    '  ' + t('cli.diag.col.spend').padStart(9) + '  ' + t('cli.diag.col.perArtifact').padStart(8) +
      '  ' + t('cli.diag.col.per1kOut').padStart(9) + '  ' + t('cli.diag.col.runsAgent')
  );
  for (const r of d.unitCost.slice(0, top)) {
    console.log(
      '  ' + m(r.value).padStart(9) + '  ' + (r.usdPerArtifact == null ? '—' : money.usd(r.usdPerArtifact)).padStart(8) +
        '  ' + (r.usdPer1kOutput == null ? '—' : money.usd(r.usdPer1kOutput)).padStart(9) +
        '  ' + String(r.runs).padStart(8) + '  ' + r.agent
    );
  }

  head(t('cli.diag.head.tail'));
  for (const r of d.runTail.byAgent.slice(0, top)) {
    console.log(
      '  ' + m(r.tailValue).padStart(9) + ('  ' + Math.round(100 * r.avgTailShare) + '%').padStart(7) +
        '  ' + String(r.runs).padStart(4) + ' ' + t('cli.diag.runsLabel') + '  ' + r.agent
    );
  }

  head(t('cli.diag.head.health'));
  const th = h.throttling.totals;
  console.log(
    t('cli.diag.rateLimit', {
      errors: th.rateLimits,
      bursts: t('cli.diag.bursts', { n: th.bursts }),
      singles: th.singles,
      days: th.days,
    })
  );
  for (const b of h.throttling.bursts.slice(0, 3)) {
    console.log(
      t('cli.diag.burstRow', {
        time: fmt.full(b.startTs),
        errors: b.errors,
        minutes: Math.round(b.durationMs / 60000),
        agents: b.agents,
      })
    );
  }
  const cm = h.compactions.totals;
  console.log(
    t('cli.diag.compactions', { count: cm.count, sessions: cm.sessions }) +
      (cm.count ? t('cli.diag.compactionsRebuild', { value: m(cm.rebuildValue) }) : '')
  );
  const tf = h.toolFailures.totals;
  console.log(
    t('cli.diag.toolFailures', {
      calls: tf.calls,
      allCalls: tf.allCalls,
      rate: (100 * tf.errorRate).toFixed(1),
      tokens: money.tokens(tf.tokens),
      value: m(tf.value),
    })
  );
  for (const r of h.toolFailures.repeats.slice(0, 3)) {
    console.log(t('cli.diag.failureLoop', { tool: r.tool, count: r.count, target: r.target ?? '—', agent: r.agent }));
  }
  const it = h.interruptions.totals;
  if (it.truncated || it.interrupts) {
    console.log(
      t('cli.diag.interruptions', { truncated: it.truncated, interrupts: it.interrupts, value: m(it.runValue) })
    );
  }
  console.log();
}

/**
 * Probes from the terminal: list the rules, sweep the corpus, read one report.
 *
 * The sweep is a separate step here for the same reason it is a button in the
 * dashboard rather than part of indexing — a rule is edited far more often
 * than the logs change, and re-reading a gigabyte per typo is not a workflow.
 */
async function cmdProbe(argv: string[], flags: Args['flags']) {
  const source = pickSources(flags, 'one')[0];
  const db = openDb(source.db);
  const id = argv.find((a) => !a.startsWith('--')) ?? (typeof flags.id === 'string' ? flags.id : null);
  const metric: Metric =
    flags.metric === 'weighted' || flags.metric === 'raw' ? (flags.metric as Metric) : 'usd';
  const m = (v: number) => renderMetric(v, metric);

  if (flags.run || flags.force) {
    const only = id ? listProbes().filter((p) => p.id === id) : undefined;
    if (id && !only?.length) {
      console.error(t('cli.probe.unknownId', { id, list: listProbes().map((p) => p.id).join(', ') }));
      process.exitCode = 1;
      return;
    }
    const r = await runProbes(db, {
      root: source.root,
      probes: only,
      force: !!flags.force,
      onProgress: (p) => {
        if (p.scanned % 50 === 0 || p.scanned === p.total) {
          process.stdout.write(t('cli.probe.progress', { scanned: p.scanned, total: p.total, hits: p.hits }));
        }
      },
    });
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(
      t('cli.probe.swept', {
        probes: r.probes,
        files: r.files,
        scanned: r.scanned,
        hits: r.hits,
        seconds: (r.elapsedMs / 1000).toFixed(1),
      })
    );
    for (const e of r.errors) console.error(t('cli.probe.error', { id: e.id, message: e.message }));
    if (!id) return;
  }

  // No id: the roster, so you can see what exists and what needs a sweep.
  if (!id) {
    const rows = probeStatus(db);
    console.log(t('cli.probe.listTitle', { path: probesPath() }));
    for (const s of rows) {
      const state = s.stale
        ? t('cli.probe.stale')
        : t('cli.probe.state', { hits: s.hits, nonEmpty: s.nonEmpty });
      console.log(
        `  ${s.id.padEnd(18)} ${(s.enabled ? ' ' : '·')} ${s.label.padEnd(28)} ${state}` +
          (s.scannedAt ? `  (${fmt.full(s.scannedAt)})` : '')
      );
    }
    console.log(t('cli.probe.hintRun'));
    console.log(t('cli.probe.hintReport'));
    return;
  }

  const days = flags.days === 'all' ? null : Number(flags.days ?? 30);
  const filters: Filters = days == null ? {} : { from: Date.now() - days * 864e5 };
  if (typeof flags.project === 'string') filters.project = flags.project;
  let r;
  try {
    r = probeReport(db, id, filters, metric);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return;
  }
  const top = Number(flags.top ?? 10);

  if (r.probe) console.log(`\n${r.probe.label}  ·  ${r.probe.scope}  ·  /${r.probe.pattern}/`);
  console.log(
    t('cli.probe.totals', {
      hits: r.totals.hits,
      nonEmpty: r.totals.nonEmpty,
      runsFlagged: r.totals.runsFlagged,
      value: m(r.totals.valueInFlagged),
    })
  );

  if (r.byAgent.length) {
    console.log(t('cli.probe.head.flagged'));
    console.log(
      '  ' + t('cli.probe.col.flagged').padStart(7) + '  ' + t('cli.probe.col.avgPrice').padStart(9) +
        '  ' + t('cli.probe.col.turns').padStart(6) + '  ' + t('cli.probe.col.others').padStart(9) +
        '  ' + t('cli.probe.col.avgPrice').padStart(9) + '  ' + t('cli.probe.col.turns').padStart(6) +
        '   ' + t('cli.probe.col.agent')
    );
    for (const a of r.byAgent.slice(0, top)) {
      console.log(
        '  ' + String(a.flaggedRuns).padStart(7) + '  ' + m(a.flaggedAvgValue).padStart(9) +
          '  ' + a.flaggedAvgTurns.toFixed(1).padStart(6) +
          '  ' + String(a.otherRuns).padStart(9) + '  ' + m(a.otherAvgValue).padStart(9) +
          '  ' + a.otherAvgTurns.toFixed(1).padStart(6) +
          '   ' + a.agent + (a.ratio ? `  ${a.ratio.toFixed(2)}×` : '')
      );
    }
  }

  if (r.byGroup.length) {
    console.log(t('cli.probe.head.byGroup'));
    for (const g of r.byGroup.slice(0, top)) {
      console.log('  ' + String(g.hits).padStart(5) + '  ' + m(g.value).padStart(9) + '  ' + (g.grp ?? '—'));
    }
  }

  if (r.samples.length) {
    console.log(t('cli.probe.head.samples'));
    for (const s of r.samples.slice(0, top)) {
      console.log(`\n  ${fmt.full(s.ts)}  ${s.agent}  ${s.sessionId.slice(0, 8)}`);
      for (const line of s.capture.split('\n').slice(0, 6)) console.log('    ' + line.trim());
    }
  }
  console.log();
}

/**
 * Which registered sources a command works on.
 *
 * `--root`/`--db` are explicit overrides and win over the registry; `--source`
 * picks one registered source by id, label or path; otherwise `index` walks
 * them all and the single-target commands take the built-in one.
 */
function pickSources(flags: Args['flags'], mode: 'all' | 'one'): Source[] {
  const dbPath = typeof flags.db === 'string' ? flags.db : undefined;
  const withDb = (s: Source) => (dbPath ? { ...s, db: dbPath } : s);
  if (typeof flags.root === 'string') return [withDb(ephemeralSource(flags.root))];

  const all = listSources();
  const list = all.map((s, i) => (i === 0 ? withDb(s) : s));
  if (typeof flags.source === 'string') {
    const q = flags.source;
    const hit = list.find((s) => s.id === q || s.label === q || s.root === q || s.root.includes(q));
    if (!hit) {
      console.error(t('cli.error.unknownSource', { query: q, list: list.map((s) => s.label).join(', ') }));
      process.exit(1);
    }
    return [hit];
  }
  return mode === 'all' ? list : [list[0] ?? builtinSource()];
}

async function cmdIndex(flags: Args['flags']) {
  const sources = pickSources(flags, 'all');
  for (const source of sources) {
    const tag = sources.length > 1 ? `${source.label} ` : '';
    const db = openDb(source.db);
    process.stdout.write(t('cli.index.start', { tag }));
    let lastPrint = 0;
    const r = await indexAll(db, {
      root: source.root,
      force: Boolean(flags.force),
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastPrint < 250) return;
        lastPrint = now;
        process.stdout.write(t('cli.index.progress', { tag, scanned: p.scanned, total: p.total, changed: p.changed }));
      },
    });
    process.stdout.write('\r' + ' '.repeat(78) + '\r');
    console.log(
      t('cli.index.done', {
        tag,
        changed: r.filesChanged,
        seen: r.filesSeen,
        messages: r.messages,
        pruned: r.pruned,
        seconds: (r.elapsedMs / 1000).toFixed(1),
      })
    );
    const span = indexSpan(db);
    if (span.minTs && span.maxTs) {
      console.log(
        t('cli.index.span', {
          tag,
          messages: span.messages,
          from: new Date(span.minTs).toISOString().slice(0, 10),
          to: new Date(span.maxTs).toISOString().slice(0, 10),
        })
      );
    }
    console.log(t('cli.index.db', { tag, path: source.db }));
  }
}

function cmdReport(flags: Args['flags']) {
  const source = pickSources(flags, 'one')[0];
  const db = openDb(source.db);
  const days = Number(flags.days ?? 30);
  const metric: Metric =
    flags.metric === 'weighted' || flags.metric === 'raw' ? (flags.metric as Metric) : 'usd';
  const filters: Filters = { from: Date.now() - days * 864e5 };
  if (typeof flags.project === 'string') filters.project = flags.project;

  const tot = totals(db, filters, metric);
  if (!tot.messages) {
    console.log(t('cli.emptyIndex'));
    return;
  }
  console.log(
    t('cli.report.summary', {
      days,
      source: source.builtin ? '' : t('cli.sourceSuffix', { label: source.label }),
      value: renderMetric(tot.value, metric),
      messages: tot.messages,
      sessions: tot.sessions,
    })
  );
  console.log(
    t('cli.report.tokens', {
      output: money.tokens(tot.output),
      cacheRead: money.tokens(tot.cacheRead),
      cacheWrite: money.tokens(tot.cacheWrite),
      input: money.tokens(tot.input),
    })
  );

  const dims: Dimension[] = (typeof flags.by === 'string' ? flags.by.split(',') : ['kind', 'project', 'agent', 'model']) as Dimension[];
  for (const dim of dims) {
    const rows = breakdown(db, dim, filters, metric, Number(flags.top ?? 12));
    if (!rows.length) continue;
    console.log(t('cli.report.byDim', { dim, rule: '─'.repeat(Math.max(0, 46 - dim.length)) }));
    for (const b of rows) {
      const share = tot.value ? (100 * b.value) / tot.value : 0;
      console.log(
        '  ' +
          renderMetric(b.value, metric).padStart(9) +
          ('  ' + share.toFixed(1) + '%').padStart(8) +
          '  ' +
          bar(share) +
          '  ' +
          b.label
      );
    }
  }
  console.log();
}

/**
 * Sibling agents re-collecting the same context.
 *
 * With `--session`/`--agent` it reports one cohort. Without them it hunts:
 * every agent dispatched several times inside one session is a candidate, the
 * costliest are opened in turn, and the ones that turn out to have collected
 * the same material independently are ranked. That is the discovery path —
 * you rarely know which fan-out is the wasteful one before measuring it.
 */
async function cmdCohort(flags: Args['flags']) {
  const source = pickSources(flags, 'one')[0];
  const db = openDb(source.db);
  const metric: Metric =
    flags.metric === 'weighted' || flags.metric === 'raw' ? (flags.metric as Metric) : 'usd';
  const m = (v: number) => renderMetric(v, metric);

  const session = typeof flags.session === 'string' ? flags.session : null;
  const agent = typeof flags.agent === 'string' ? flags.agent : null;
  const workflow = typeof flags.workflow === 'string' ? flags.workflow : null;

  if (session && agent) {
    const runs = cohortRuns(db, session, agent, metric, workflow);
    if (runs.length < 2) {
      console.log(t('cli.cohort.needTwoRuns'));
      return;
    }
    const r = await cohortReport(runs, {
      metric,
      agent,
      workflowId: workflow,
      actualValue: runs.reduce((s, x) => s + x.value, 0),
      limit: Number(flags.top ?? 20),
    });
    printCohort(r, m);
    return;
  }

  // Discovery: rank the fan-outs, then measure the costliest few.
  const scan = Number(flags.scan ?? 12);
  const candidates = db
    .prepare(
      `SELECT session_id, agent, workflow_id, count(DISTINCT agent_id) AS runs,
              sum(${METRIC_COLUMN[metric]}) AS value
       FROM msgs
       WHERE agent_id IS NOT NULL
       GROUP BY session_id, agent, workflow_id
       HAVING runs >= 3
       ORDER BY value DESC
       LIMIT ?`
    )
    .all(scan) as any[];

  if (!candidates.length) {
    console.log(t('cli.cohort.noFanOut'));
    return;
  }

  console.log(t('cli.cohort.scanning', { n: candidates.length }));
  const found: { label: string; r: Awaited<ReturnType<typeof cohortReport>> }[] = [];
  for (const c of candidates) {
    const runs = cohortRuns(db, String(c.session_id), String(c.agent), metric, c.workflow_id);
    if (runs.length < 2) continue;
    const r = await cohortReport(runs, {
      metric,
      agent: String(c.agent),
      workflowId: c.workflow_id ?? null,
      actualValue: runs.reduce((s, x) => s + x.value, 0),
      limit: 6,
    });
    found.push({
      label: `${c.agent} · ${String(c.session_id).slice(0, 8)}${c.workflow_id ? ' · ' + c.workflow_id : ''}`,
      r,
    });
  }
  found.sort((a, b) => b.r.wastedValue - a.r.wastedValue);

  for (const f of found) {
    const share = f.r.actualValue ? (100 * f.r.wastedValue) / f.r.actualValue : 0;
    console.log(
      t('cli.cohort.row', {
        wasted: m(f.r.wastedValue).padStart(9),
        share: (share.toFixed(0) + '%').padStart(4),
        runs: String(f.r.activeRuns).padStart(3),
        label: f.label,
      })
    );
    for (const s of f.r.sources.slice(0, 3)) {
      console.log(
        t('cli.cohort.sourceRow', {
          pad: ' '.repeat(9),
          wasted: m(s.wasted).padStart(8),
          runs: s.runs,
          total: f.r.activeRuns,
          tool: s.tool,
          label: s.label,
        })
      );
    }
  }
  console.log(
    t('cli.cohort.detailHint', { workflow: found[0]?.r.workflowId ? ' [--workflow <id>]' : '' })
  );
}

function printCohort(r: Awaited<ReturnType<typeof cohortReport>>, m: (v: number) => string) {
  const shareCollected = r.collectedTokens ? (100 * r.sharedTokens) / r.collectedTokens : 0;
  const shareSpend = r.actualValue ? (100 * r.wastedValue) / r.actualValue : 0;
  console.log(
    t('cli.cohort.title', {
      agent: r.agent,
      workflow: r.workflowId ? ` · ${r.workflowId}` : '',
      runs: r.activeRuns,
      value: m(r.actualValue),
    })
  );
  console.log(
    t('cli.cohort.collected', {
      collected: money.tokens(r.collectedTokens),
      shared: money.tokens(r.sharedTokens),
      percent: shareCollected.toFixed(0),
    })
  );
  console.log(
    t('cli.cohort.wasted', { value: m(r.wastedValue), percent: shareSpend.toFixed(0) })
  );
  console.log(
    t('cli.cohort.wastedWrite', { value: m(r.wastedWrite).padStart(9) })
  );
  console.log(
    t('cli.cohort.wastedCarry', { value: m(r.wastedCarry).padStart(9) })
  );
  console.log(
    t('cli.cohort.prefixHint', { value: m(r.prefixRecoverable), turn: r.breakEvenTurn.toFixed(1) })
  );
  console.log(
    '  ' + t('cli.cohort.col.overpay').padStart(9) + '  ' + t('cli.cohort.col.prefix').padStart(8) +
      '  ' + t('cli.cohort.col.rest')
  );
  for (const s of r.sources) {
    console.log(
      '  ' +
        m(s.wasted).padStart(9) +
        '  ' +
        m(s.prefixRecoverable).padStart(8) +
        '  ' +
        t('cli.cohort.ofRuns', { runs: s.runs, total: r.activeRuns }).padStart(8) +
        '  ' +
        money.tokens(s.tokens).padStart(6) +
        '  ' +
        String(s.medianTurn).padStart(3) +
        '  ' +
        `${s.tool} ${s.label}` +
        (s.variants > 1 ? t('cli.cohort.variants', { n: s.variants }) : '')
    );
  }
  console.log();
}

/**
 * The offline half of sharing: the same ref the dashboard copies, rendered
 * straight from the index. An agent handed a link has no idea whether the
 * server is still up — this path does not care, and is what the copied command
 * form uses.
 */
async function cmdShow(argv: string[], flags: Args['flags']) {
  const input = argv.find((a) => !a.startsWith('--')) ?? (typeof flags.ref === 'string' ? flags.ref : '');
  if (!input) {
    console.error(t('cli.show.usage'));
    console.log(renderIndex());
    process.exit(1);
  }

  let ref;
  try {
    ref = parseRef(input);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // The ref carries the source it was copied from; `--source` still wins, so a
  // link from one subscription can be re-read against another.
  const all = listSources();
  const wanted = typeof flags.source === 'string' ? flags.source : (ref.params.source ?? '');
  const source =
    (wanted ? all.find((s) => s.id === wanted || s.label === wanted || s.root === wanted) : undefined) ??
    pickSources(flags, 'one')[0];
  if (wanted && source.id !== wanted && !flags.source) {
    console.error(t('cli.show.sourceNotFound', { wanted, label: source.label }));
  }

  const db = openDb(source.db);
  try {
    const resolved = await resolveShare(db, ref, { id: source.id, label: source.label, root: source.root });
    console.log(flags.json ? JSON.stringify(resolved, null, 2) : renderMarkdown(resolved));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

function cmdSources() {
  for (const s of listSources()) {
    const span = indexSpan(openDb(s.db));
    console.log(
      t('cli.sources.row', {
        id: s.id.padEnd(12),
        label: s.label.padEnd(24),
        root: s.root,
        pad: ' '.repeat(12),
        db: s.db,
        span: span.messages
          ? t('cli.sources.indexed', { messages: span.messages })
          : t('cli.sources.notIndexed'),
      })
    );
  }
}

function bar(pct: number): string {
  const n = Math.max(0, Math.min(20, Math.round(pct / 5)));
  return ('█'.repeat(n) + '·'.repeat(20 - n));
}

async function cmdServe(flags: Args['flags']) {
  const { port, sources } = await startServer({
    port: Number(flags.port ?? 4317),
    dbPath: typeof flags.db === 'string' ? flags.db : undefined,
    root: typeof flags.root === 'string' ? flags.root : undefined,
  });
  console.log(t('cli.serve.ready', { port }));
  if (flags['no-index']) return;

  // The dashboard is already answering; the startup index refreshes behind it,
  // so a cold first run over thousands of files doesn't hold the UI hostage.
  // The page polls /api/index-status and shows the same progress.
  //
  // Every configured source is refreshed, one after another: switching to the
  // second subscription should not mean waiting for its first index there.
  const all = sources();
  for (const { source, indexer } of all) {
    const tag = all.length > 1 ? `${source.label}: ` : '';
    let lastPrint = 0;
    try {
      const r = await indexer.run((p) => {
        const now = Date.now();
        if (now - lastPrint < 250) return;
        lastPrint = now;
        process.stdout.write(`\r  ${tag}indexing… ${p.scanned}/${p.total} files (${p.changed} changed)   `);
      });
      process.stdout.write('\r' + ' '.repeat(78) + '\r');
      console.log(
        `  ${tag}index: ${r.filesChanged} files changed, ${r.messages} messages, ${(r.elapsedMs / 1000).toFixed(1)}s`
      );
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(78) + '\r');
      console.error(`  ${tag}index failed: ${err}`);
    }
  }
}

const { cmd, flags } = parseArgs(process.argv.slice(2));

switch (cmd) {
  case 'index':
    await cmdIndex(flags);
    break;
  case 'report':
    cmdReport(flags);
    break;
  case 'serve':
    await cmdServe(flags);
    break;
  case 'diag':
    cmdDiag(flags);
    break;
  case 'probe':
    await cmdProbe(process.argv.slice(3), flags);
    break;
  case 'cohort':
    await cmdCohort(flags);
    break;
  case 'show':
    await cmdShow(process.argv.slice(3), flags);
    break;
  case 'sources':
    cmdSources();
    break;
  default:
    console.log(t('cli.usage'));
}
