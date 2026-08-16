/**
 * The diagnostics screen: the cost findings from `src/diag.ts` plus the four
 * run-health sections from `src/health.ts`, all in one `/api/diag` round-trip.
 *
 * The panels are ordered by how ACTIONABLE a finding is, not by how the server
 * computes it:
 *
 *   1. outliers    — the central diagnostic. A run is judged against the MEDIAN
 *      of its own agent, so a finding here is always "this dispatch went wrong",
 *      never "this agent is expensive". That is the only shape a person can act
 *      on without re-reading the whole flow.
 *   2. unit cost   — the same question one level up: not a bad run, a bad price
 *      per delivered artifact. Slower to act on, so it sits under the outliers.
 *   3. heaviest calls — one tool result, its turn and its carry. A named file on
 *      a named turn of a named run is a thing to change; the per-TOOL totals
 *      that used to head this screen were not, and were removed.
 *   4. run tail / duplicate briefs — flow shape. Real money, but the fix is a
 *      re-write of a prompt or a fan-out, not a one-line change.
 *   5. run health  — what HAPPENED (compaction, 429, failed call, cut-off).
 *      Last because the cost is a consequence: you act on it by changing the
 *      four above, not by acting on the event itself.
 *
 * Every number derived from characters is an ESTIMATE (`.est`); everything that
 * comes off the billing counters is exact. The screen never mixes the two in one
 * column without saying which it is.
 */

import {
  api, el, fmt, fmtDuration, fmtMetric, fmtTime, fmtTokens, go, kpiCard, panel, state, t,
} from './ui.js';

// ── small shared pieces ──────────────────────────────────────

const pct = (v, digits = 1) => (Number.isFinite(v) ? (100 * v).toFixed(digits) + '%' : '—');
const money = (v) => (Number.isFinite(v) ? fmtMetric(v) : '—');
const dash = (v) => (v == null || v === '' ? '—' : v);

/** Non-null money, or an em dash — a null denominator must not read as zero. */
const per = (value, n) => (n > 0 ? money(value / n) : '—');

/**
 * `writeUsd` / `carryUsd` exist only in dollars, while the row's `value` is
 * already in whatever metric the toolbar asks for. Splitting `value` by the
 * dollar ratio keeps both halves in one unit instead of printing dollars next
 * to limit-units in the same table.
 */
const part = (row, usdPart) => (row.usd > 0 ? (row.value * usdPart) / row.usd : 0);

const th = (...names) => el('thead', {}, el('tr', {}, ...names.map((label) => el('th', { text: label }))));

/** A row that goes somewhere, or one that visibly does not. */
const tr = (onclick, title, ...cells) =>
  el('tr', onclick ? { onclick, title } : { style: 'cursor:default' }, ...cells);

const num = (v, cls) => el('td', { class: 'num' + (cls ? ' ' + cls : ''), text: String(v) });
const txt = (v, cls) => el('td', { class: cls ?? '', text: String(v) });

const wrap = (...kids) => el('div', { class: 'table-scroll' }, el('table', {}, ...kids));

const subHead = (title, hint) =>
  el('div', { class: 'sub-head' },
    el('h3', { text: title }),
    hint ? el('span', { class: 'hint', text: hint }) : null);

const note = (text) => el('p', { class: 'note', text });

/**
 * An error message in one table row. Newlines are folded away because a cell is
 * one line by contract, and the untruncated text goes to `title` — the indexer
 * keeps 400 chars, which is a stack trace's worth and far more than fits here.
 */
const errCell = (text) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return el('td', { class: 'dim', text: '—' });
  return el('td', { class: 'err-cell', title: one },
    el('span', { text: one.length > 110 ? one.slice(0, 110) + '…' : one }));
};

/** An inline proportion bar plus its number — the share idiom. */
const meterCell = (share, width = 56, cls = 'meter') =>
  el('td', { class: 'num' },
    el('span', { class: cls, style: `width:${Math.max(2, width * (share || 0)).toFixed(1)}px` }),
    el('span', { class: 'est', text: ' ' + pct(share, 0) }));

/** Session ids are UUIDs; the first block is enough to tell two rows apart. */
const shortId = (id) => String(id ?? '').slice(0, 8);

/** "30 из 1572", or just the count when nothing was cut off. */
const shown = (n, total, tail) =>
  (total > n ? t('diag.shown.outOf', { n, total }) : String(n)) + (tail ? ' · ' + tail : '');

const runTitle = t('diag.actions.openRun');

/**
 * Where a row drills to.
 *
 * The same finding means a different next step depending on where it is read.
 * On the whole-corpus screen an agent name is a question about the fleet, and
 * the answer is the toolbar filter. Inside one session it is a question about
 * THIS fan-out, and the answer is that agent's runs in this session — the
 * drawer already has that level. A session cell is a drill-in on the screen
 * and a no-op in the drawer, where the session is what is open.
 */
const CORPUS_NAV = {
  agent: (a) => go.filter('agent', a),
  agentTitle: t('diag.nav.filterByAgent'),
  session: (sid) => go.session(sid),
  sessionTitle: t('diag.nav.openSession'),
};

export const sessionNav = (sessionId) => ({
  agent: (a) => go.agent(sessionId, a),
  agentTitle: t('diag.nav.agentRunsInSession'),
  session: null,
  sessionTitle: null,
});

/** A row that drills where the nav allows, or one that visibly does not. */
const navRow = (fn, title, arg, ...cells) =>
  tr(fn ? () => fn(arg) : null, fn ? title : null, ...cells);

// ── sections ─────────────────────────────────────────────────

/**
 * Every panel of the report, in the order a finding becomes actionable.
 * Shared by the screen and by the session drawer's diagnostics tab: the two
 * read the same `/api/diag` payload and differ only in scope and in nav.
 *
 * `.filter(Boolean)` is not cosmetic: `replaceChildren` stringifies whatever is
 * not a Node, so a panel that returns null for "nothing to show" used to render
 * the literal text «null» between the sections above and below it.
 */
export function diagSections(d, nav = CORPUS_NAV) {
  const { toolCensus, unitCost, outliers, dispatchBlobs, runTail } = d.diag;
  const h = d.health;
  return [
    kpis(toolCensus, outliers, h),
    outliersPanel(outliers, nav),
    unitCostPanel(unitCost, nav),
    callsPanel(toolCensus),
    runTailPanel(runTail, nav),
    blobsPanel(dispatchBlobs, nav),
    healthPanel(h, nav),
  ].filter(Boolean);
}

/** Whether the payload holds anything worth a screen at all. */
export const diagHasAnything = (d) =>
  d.diag.toolCensus.totals.calls > 0 ||
  d.diag.unitCost.length > 0 ||
  d.diag.outliers.runs.length > 0 ||
  d.health.compactions.rows.length > 0 ||
  d.health.throttling.totals.errors > 0;

// ── screen ───────────────────────────────────────────────────

export async function renderDiag(box) {
  box.replaceChildren(el('div', { class: 'empty', text: t('common.calculating') }));
  const d = await api('/api/diag');
  // The toolbar can switch screens while this request is in flight.
  if (state.view !== 'diag') return;

  if (!diagHasAnything(d)) {
    box.replaceChildren(
      el('div', { class: 'panel' },
        el('div', { class: 'empty', text: t('diag.empty') })));
    return;
  }

  box.replaceChildren(...diagSections(d));
}

// ── KPI ──────────────────────────────────────────────────────

function kpis(census, outliers, h) {
  const tot = census.totals;
  const outlierSpend = outliers.byAgent.reduce((s, a) => s + a.value, 0);
  const thr = h.throttling.totals;
  const comp = h.compactions.totals;

  return el('div', { class: 'kpis' },
    kpiCard(t('diag.kpi.context.label'), money(tot.value),
      t('diag.kpi.context.sub', { carryShare: pct(tot.carryShare, 0), tokens: fmtTokens(tot.tokens) })),
    kpiCard(t('diag.outliers.title'), String(outliers.runsTotal),
      outliers.runsTotal
        ? t('diag.kpi.outliers.sub', { n: outliers.runsTotal, value: money(outlierSpend) })
        : t('diag.kpi.outliers.subEmpty')),
    kpiCard(t('diag.kpi.throttle.label'), String(thr.rateLimits),
      thr.rateLimits
        ? t('diag.kpi.throttle.sub', { n: thr.bursts, singles: thr.singles })
        : t('diag.kpi.throttle.subEmpty')),
    kpiCard(t('diag.kpi.compactions.label'), String(comp.count),
      comp.count
        ? t('diag.kpi.compactions.sub', { value: money(comp.rebuildValue), auto: comp.auto })
        : t('diag.kpi.compactions.subEmpty')));
}

// ── outliers ─────────────────────────────────────────────────

function outliersPanel(o, nav) {
  if (!o.runs.length) return null;

  const runs = wrap(
    th(t('diag.table.header.agent'), t('diag.table.header.when'), t('diag.table.header.cost'),
      t('diag.table.header.agentMedian'), t('diag.table.header.ratio'), t('diag.table.header.turns'),
      t('diag.table.header.model')),
    el('tbody', {}, ...o.runs.map((r) =>
      tr(() => go.run(r.sessionId, r.agent, r.agentId, r.ts), runTitle,
        txt(r.agent, 'name'),
        txt(fmtTime(r.ts)),
        num(money(r.value), 'accent'),
        num(money(r.medianValue)),
        el('td', { class: 'num' },
          el('span', { class: 'ratio' + (r.ratio >= 3 ? ' hot' : ''), text: '×' + r.ratio.toFixed(1) })),
        num(r.turns),
        txt(dash(r.model), 'name'))))
  );

  // `excessUsd` has no metric-aware twin, so it is shown as a SHARE of the
  // outlier spend — a ratio means the same thing in dollars and in limit-units.
  const corpus = o.baseline === 'corpus';

  // On the corpus screen the median rests on exactly the runs already in the
  // «запусков» column; only a wider baseline makes the two differ, and only
  // then is the second number worth a column.
  const byAgent = wrap(
    th(t('diag.table.header.agent'), t('diag.table.header.runs'),
      ...(corpus ? [t('diag.table.header.medianOf')] : []), t('diag.table.header.outliersOf'),
      t('diag.table.header.outlierCost'), t('diag.table.header.overMedian')),
    el('tbody', {}, ...o.byAgent.map((a) =>
      navRow(nav.agent, nav.agentTitle, a.agent,
        txt(a.agent, 'name'),
        num(a.runs),
        ...(corpus ? [num(a.baseRuns)] : []),
        el('td', { class: 'num' },
          el('span', {
            class: 'ratio' + (a.outliers / a.runs >= 0.3 ? ' hot' : ''),
            text: String(a.outliers),
          }),
          el('span', { class: 'est', text: ' ' + pct(a.outliers / a.runs, 0) })),
        num(money(a.value), 'accent'),
        meterCell(a.usd > 0 ? a.excessUsd / a.usd : 0))))
  );

  return panel(t('diag.outliers.title'), shown(o.runs.length, o.runsTotal, t('diag.hint.clickOpenRun')),
    note(
      [
        t('diag.outliers.note.intro'),
        corpus ? t('diag.outliers.note.corpusBaseline') : t('diag.outliers.note.sessionBaseline'),
        t('diag.outliers.note.tail'),
      ].join(' ') +
      (o.unjudged.length
        ? ' ' + t('diag.outliers.note.unjudged', { agents: o.unjudged.join(', ') })
        : '')),
    runs,
    o.byAgent.length
      ? el('div', {},
          subHead(t('diag.outliers.byAgent.title'),
            nav.agentTitle ? t('diag.hint.clickAction', { action: nav.agentTitle.toLowerCase() }) : null),
          note(t('diag.outliers.byAgent.note')),
          byAgent)
      : null);
}

// ── unit cost ────────────────────────────────────────────────

function unitCostPanel(rows, nav) {
  if (!rows.length) return null;

  const body = wrap(
    th(t('diag.table.header.agent'), t('diag.table.header.runs'), t('diag.table.header.spend'),
      t('diag.table.header.perRun'), t('diag.table.header.per1kOutput'), t('diag.table.header.artifacts'),
      t('diag.table.header.perArtifact'), t('diag.table.header.reads'), t('diag.table.header.avgTurns')),
    el('tbody', {}, ...rows.map((r) =>
      navRow(nav.agent, nav.agentTitle, r.agent,
        txt(r.agent, 'name'),
        num(r.runs),
        num(money(r.value)),
        num(per(r.value, r.runs)),
        num(r.outputTokens > 0 ? money((r.value * 1000) / r.outputTokens) : '—', 'accent'),
        num(r.artifacts),
        num(per(r.value, r.artifacts), 'accent'),
        num(r.reads),
        num(r.avgTurns.toFixed(1)))))
  );

  return panel(t('diag.unitCost.title'),
    nav.agentTitle ? t('diag.hint.clickAction', { action: nav.agentTitle.toLowerCase() }) : null,
    note(t('diag.unitCost.note')),
    body);
}

// ── heaviest single calls ────────────────────────────────────

/**
 * One tool result at a time, ranked by what it cost to keep.
 *
 * The per-tool breakdown that used to open this screen is gone: «Read стоит
 * больше всех» is true of every corpus and names nothing to change. A single
 * call names a file, a turn and a run, and the turn is the actionable half —
 * the same result costs a multiple more when it lands early.
 */
function callsPanel(c) {
  if (!c.topCalls.length) return null;
  const tot = c.totals;

  const top = wrap(
    th(t('diag.table.header.tool'), t('diag.table.header.what'), t('diag.table.header.agent'),
      t('diag.table.header.turn'), t('diag.table.header.volume'), t('diag.table.header.carried'),
      t('diag.table.header.total')),
    el('tbody', {}, ...c.topCalls.map((r) =>
      tr(() => go.run(r.sessionId, r.agent, r.agentId, r.ts), runTitle,
        txt(r.tool),
        txt(dash(r.target), 'name'),
        txt(r.agent, 'name'),
        num(`${r.turn}/${r.turnsTotal}`),
        num(fmtTokens(r.tokens)),
        num(t('diag.calls.carryTurns', { n: r.carryTurns })),
        num(money(r.value), 'accent'))))
  );

  return panel(t('diag.calls.title'), shown(c.topCalls.length, tot.calls, t('diag.hint.clickOpenRun')),
    note(t('diag.calls.note', {
      carryShare: pct(tot.carryShare, 0),
      carryValue: money(part(tot, tot.carryUsd)),
      totalValue: money(tot.value),
    })),
    top,
    el('p', { class: 'est', text: t('diag.calls.estimateNote', { calls: fmt.n(tot.calls) }) }));
}

// ── run tail ─────────────────────────────────────────────────

function runTailPanel(tot, nav) {
  if (!tot.runs.length) return null;

  const runs = wrap(
    th(t('diag.table.header.agent'), t('diag.table.header.when'), t('diag.table.header.turns'),
      t('diag.table.header.lastArtifact'), t('diag.table.header.tail'), t('diag.table.header.tailCost'),
      t('diag.table.header.runShare')),
    el('tbody', {}, ...tot.runs.map((r) =>
      tr(() => go.run(r.sessionId, r.agent, r.agentId, r.ts), runTitle,
        txt(r.agent, 'name'),
        txt(fmtTime(r.ts)),
        num(r.turnsTotal),
        num(t('common.turn', { n: r.lastArtifactTurn })),
        num(r.tailTurns),
        num(money(r.tailValue), 'accent'),
        meterCell(r.tailShare))))
  );

  const byAgent = wrap(
    th(t('diag.table.header.agent'), t('diag.table.header.runs'), t('diag.table.header.avgTailShare'),
      t('diag.table.header.tailCost')),
    el('tbody', {}, ...tot.byAgent.map((a) =>
      navRow(nav.agent, nav.agentTitle, a.agent,
        txt(a.agent, 'name'),
        num(a.runs),
        meterCell(a.avgTailShare),
        num(money(a.tailValue), 'accent'))))
  );

  return panel(t('diag.runTail.title'), shown(tot.runs.length, tot.runsTotal, t('diag.hint.clickOpenRun')),
    note(t('diag.runTail.note')),
    runs,
    tot.byAgent.length
      ? el('div', {},
          subHead(t('diag.runTail.byAgent.title'),
            nav.agentTitle ? t('diag.hint.clickAction', { action: nav.agentTitle.toLowerCase() }) : null),
          byAgent)
      : null);
}

// ── duplicate briefs ─────────────────────────────────────────

function blobsPanel(b, nav) {
  // The server ranks every dispatch group, duplicated or not; a group of one is
  // simply a brief that was sent once, and has no place under this heading.
  const groups = b.groups.filter((g) => g.copies > 1);
  if (!groups.length) return null;
  const tot = b.totals;

  // Scoped to one session, "сессий" is the constant 1 in every row — a column
  // that answers nothing, so it is not shown rather than shown as noise.
  const cross = Boolean(nav.session);

  const body = wrap(
    th(t('diag.table.header.signature'), t('diag.table.header.tool'), t('diag.table.header.copies'),
      t('diag.table.header.agents'), ...(cross ? [t('diag.table.header.sessions')] : []),
      t('diag.table.header.size'), t('diag.table.header.overpay')),
    el('tbody', {}, ...groups.map((g) =>
      navRow(nav.session, nav.sessionTitle, g.sessionId,
        txt(dash(g.target), 'name'),
        txt(g.tool),
        num('×' + g.copies),
        num(g.agents.length),
        ...(cross ? [num(g.sessions)] : []),
        num(fmtTokens(g.tokens)),
        num(money(g.wasteValue), 'accent'))))
  );

  return panel(t('diag.duplicates.title'),
    t('diag.duplicates.groupsHint', { n: groups.length }),
    note(t('diag.duplicates.note', {
      n: tot.duplicateCopies, dispatches: tot.dispatches, wasteValue: money(tot.wasteValue),
    })),
    body,
    el('p', { class: 'est', text: t('diag.duplicates.sizeNote') }));
}

// ── run health ───────────────────────────────────────────────

function healthPanel(h, nav) {
  const parts = [
    compactions(h.compactions, nav),
    throttling(h.throttling, nav),
    toolFailures(h.toolFailures),
    interruptions(h.interruptions),
  ].filter(Boolean);
  if (!parts.length) return null;

  return panel(t('diag.health.title'), t('diag.health.hint'),
    note(t('diag.health.note')),
    ...parts);
}

function compactions(c, nav) {
  if (!c.rows.length) return null;
  const tot = c.totals;
  const cross = Boolean(nav.session);

  const body = wrap(
    th(...(cross ? [t('diag.table.header.session')] : []), t('diag.table.header.when'),
      t('diag.table.header.wasToBecome'), t('diag.table.header.duration'), t('diag.table.header.trigger'),
      t('diag.table.header.rebuild')),
    el('tbody', {}, ...c.rows.map((r) =>
      navRow(nav.session, nav.sessionTitle, r.sessionId,
        ...(cross ? [txt(shortId(r.sessionId))] : []),
        txt(fmtTime(r.ts)),
        num(`${fmtTokens(r.preTokens)} → ${fmtTokens(r.postTokens)}`),
        num(fmtDuration(r.durationMs)),
        el('td', {}, el('span', {
          class: 'badge' + (r.trigger === 'auto' ? ' warn' : ''),
          text: r.trigger === 'auto' ? t('diag.compactions.trigger.auto') : t('diag.compactions.trigger.manual'),
        })),
        num(money(r.rebuildValue), 'accent'))))
  );

  return el('div', {},
    subHead(t('diag.compactions.title'),
      shown(c.rows.length, c.rowsTotal, cross ? t('diag.compactions.sessionHint') : null)),
    note(
      t('diag.compactions.note.intro') + ' ' +
      t('diag.compactions.note.summary', {
        n: tot.sessions, count: tot.count, auto: tot.auto, manual: tot.manual,
        medianTokens: fmtTokens(tot.medianPreTokens ?? 0), rebuildValue: money(tot.rebuildValue),
      })),
    body);
}

function throttling(thr, nav) {
  const tot = thr.totals;
  if (!tot.errors) return null;

  const bursts = thr.bursts.length
    ? wrap(
        th(t('diag.table.header.start'), t('diag.table.header.duration'), t('diag.table.header.errors'),
          t('diag.table.header.liveRuns'), t('diag.table.header.firstErrorAgent'),
          t('diag.table.header.windowSpend')),
        el('tbody', {}, ...thr.bursts.map((b) =>
          navRow(nav.session, nav.sessionTitle, b.sessionId,
            txt(fmtTime(b.startTs)),
            num(fmtDuration(b.durationMs)),
            num(b.errors),
            el('td', { class: 'num' },
              el('span', { class: 'ratio' + (b.agents >= 10 ? ' hot' : ''), text: String(b.agents) })),
            txt(b.agent, 'name'),
            num(money(b.value), 'accent'))))
      )
    : null;

  const byDay = thr.byDay.length
    ? wrap(
        th(t('diag.table.header.day'), t('diag.table.header.errors'), t('diag.table.header.rateLimitsOf'),
          t('diag.table.header.daySpend')),
        el('tbody', {}, ...thr.byDay.map((r) =>
          tr(null, null,
            txt(r.day),
            num(r.errors),
            num(r.rateLimits),
            num(money(r.value)))))
      )
    : null;

  return el('div', {},
    subHead(t('diag.throttle.title'), thr.bursts.length && nav.session ? t('diag.throttle.burstHint') : null),
    note(
      t('diag.throttle.note.intro') + ' ' +
      t('diag.throttle.note.summary', {
        bursts: t('diag.throttle.note.burstWord', { n: tot.bursts }),
        days: t('diag.throttle.note.dayWord', { n: tot.days }),
        singles: tot.singles,
      })),
    bursts,
    byDay ? el('div', {}, subHead(t('diag.throttle.byDay.title'), t('diag.throttle.byDay.hint')), byDay) : null);
}

function toolFailures(f) {
  if (!f.totals.calls) return null;
  const tot = f.totals;

  const repeats = f.repeats.length
    ? wrap(
        th(t('diag.table.header.agent'), t('diag.table.header.tool'), t('diag.table.header.target'),
          t('diag.table.header.inARow'), t('diag.table.header.when'), t('diag.table.header.howLong'),
          t('diag.table.header.cost')),
        el('tbody', {}, ...f.repeats.map((r) =>
          tr(() => go.run(r.sessionId, r.agent, r.agentId, r.firstTs), runTitle,
            txt(r.agent, 'name'),
            txt(r.tool),
            txt(dash(r.target), 'name'),
            el('td', { class: 'num' },
              el('span', { class: 'ratio' + (r.count >= 5 ? ' hot' : ''), text: '×' + r.count })),
            txt(fmtTime(r.firstTs)),
            num(fmtDuration(r.lastTs - r.firstTs)),
            num(money(r.value), 'accent'))))
      )
    : null;

  // The list the section exists for: not "Bash fails 3% of the time" but WHICH
  // call, on which turn of which run, and what it said back. `error` is the
  // first 400 chars the indexer kept; the cell shows one line and hands the
  // rest to the tooltip, because a stack trace would blow the row height apart.
  const calls = f.topCalls.length
    ? wrap(
        th(t('diag.table.header.tool'), t('diag.table.header.what'), t('diag.table.header.agent'),
          t('diag.table.header.when'), t('diag.table.header.turn'), t('diag.table.header.whatReturned'),
          t('diag.table.header.cost')),
        el('tbody', {}, ...f.topCalls.map((r) =>
          tr(() => go.run(r.sessionId, r.agent, r.agentId ?? 'main', r.ts), runTitle,
            txt(r.tool),
            txt(dash(r.target), 'name'),
            txt(r.agent, 'name'),
            txt(fmtTime(r.ts)),
            num(`${r.turn}/${r.turnsTotal}`),
            errCell(r.error),
            num(money(r.value), 'accent'))))
      )
    : null;

  const byTool = f.byTool.length
    ? wrap(
        th(t('diag.table.header.tool'), t('diag.table.header.errors'), t('diag.table.header.errorShare'),
          t('diag.table.header.errorVolume'), t('diag.table.header.cost')),
        el('tbody', {}, ...f.byTool.map((r) =>
          tr(null, null,
            txt(r.tool, 'name'),
            num(r.calls),
            num(pct(r.errorRate)),
            num(fmtTokens(r.tokens)),
            num(money(r.value)))))
      )
    : null;

  return el('div', {},
    subHead(t('diag.failures.title'),
      t('diag.failures.subtitle', { calls: tot.calls, allCalls: fmt.n(tot.allCalls), errorRate: pct(tot.errorRate) })),
    note(t('diag.failures.note', { value: money(tot.value) })),
    calls
      ? el('div', {},
          subHead(t('diag.failures.topCalls.title'),
            shown(f.topCalls.length, tot.calls,
              t('diag.failures.topCalls.hoverHint') + ' · ' + t('diag.hint.clickOpenRun'))),
          calls)
      : null,
    repeats
      ? el('div', {},
          subHead(t('diag.failures.repeats.title'),
            t('diag.failures.repeats.hint') + ' · ' + t('diag.hint.clickOpenRun')),
          repeats)
      : null,
    byTool ? el('div', {}, subHead(t('diag.failures.byTool.title'), t('diag.failures.byTool.hint')), byTool) : null);
}

function interruptions(i) {
  if (!i.truncated.length && !i.interrupts.length) return null;

  const rows = [...i.truncated, ...i.interrupts].sort((a, b) => b.ts - a.ts);

  const body = wrap(
    th(t('diag.table.header.what'), t('diag.table.header.agent'), t('diag.table.header.when'),
      t('diag.table.header.turn'), t('diag.table.header.gotOut'), t('diag.table.header.tool'),
      t('diag.table.header.runCost')),
    el('tbody', {}, ...rows.map((r) =>
      tr(() => go.run(r.sessionId, r.agent, r.agentId ?? 'main', r.ts), runTitle,
        el('td', {}, el('span', {
          class: 'badge ' + (r.type === 'truncated' ? 'warn' : 'accent'),
          text: r.type === 'truncated' ? t('diag.interruptions.badge.truncated') : t('diag.interruptions.badge.interrupted'),
        })),
        txt(r.agent, 'name'),
        txt(fmtTime(r.ts)),
        num(r.turn),
        num(r.outputTokens ? fmtTokens(r.outputTokens) : '—'),
        txt(dash(r.tool), 'name'),
        num(money(r.runValue), 'accent'))))
  );

  return el('div', {},
    subHead(t('diag.interruptions.title'),
      t('diag.interruptions.subtitle', { truncated: i.totals.truncated, interrupts: i.totals.interrupts })
        + ' · ' + t('diag.hint.clickOpenRun')),
    note(t('diag.interruptions.note', { value: money(i.totals.runValue) })),
    body);
}
