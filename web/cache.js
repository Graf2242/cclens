/**
 * The cache screen: where the prompt cache expired and what that cost, and
 * whether a 1-hour TTL would have been cheaper. The second question is a
 * counterfactual over the same window, not an opinion — see `src/cache.ts`.
 *
 * Shared by the global screen and the session drawer's cache tab, the same way
 * `diag.js` is shared: both read the same `/api/cache` payload and differ only
 * in scope (a `session=` filter) and in nav (`CACHE_CORPUS_NAV` vs
 * `cacheSessionNav`).
 *
 * Waste is shown in dollars or limit-units; the «токены» metric is meaningless
 * here, because a cache miss does not change how many tokens were sent, only
 * the rate they were billed at.
 */

import {
  api, el, fmtDuration, fmtMetric, fmtTime, fmtTokens, fmtUsd, go, kpiCard, missCauseHint, panel, state,
  svgEl, t, withTooltip,
} from './ui.js';

/**
 * Where a row in the «по агентам» table drills to — the corpus screen filters
 * the whole dashboard, the session drawer opens that agent's runs in this
 * session (`cacheSessionNav`). `openRunAt`/`go.run` in the misses table is not
 * part of `nav`: it always opens the specific run, corpus or session alike.
 */
const CACHE_CORPUS_NAV = {
  agent: (a) => go.filter('agent', a),
  agentTitle: t('diag.nav.filterByAgent'),
};

export const cacheSessionNav = (sessionId) => ({
  agent: (a) => go.agent(sessionId, a),
  agentTitle: t('diag.nav.agentRunsInSession'),
});

// ── sections ─────────────────────────────────────────────────

/**
 * Every panel of the report. Shared by the screen and by the session drawer's
 * cache tab: `.filter(Boolean)` is not cosmetic — `replaceChildren` stringifies
 * whatever is not a Node, so a panel that returns null for "nothing to show"
 * would render the literal text «null» between the panels above and below it.
 */
export function cacheSections(d, nav = CACHE_CORPUS_NAV) {
  const asLimit = state.metric === 'weighted';
  const w = (o) => (asLimit ? o.extraWeighted : o.extraUsd);
  const fmtW = (v) => (asLimit ? fmtTokens(v) : fmtUsd(v));
  const tot = d.totals, c = d.counterfactual;
  const spend = asLimit ? c.actualWeighted : c.actualUsd;
  const waste = w({
    extraUsd: tot.expired.extraUsd + tot.invalidated.extraUsd,
    extraWeighted: d.byAgent.reduce((s, a) => s + a.extraWeighted, 0),
  });
  const delta = asLimit ? c.hypoWeighted - c.actualWeighted : c.hypoUsd - c.actualUsd;
  const share = (v) =>
    waste ? t('cache.share.suffix', { pct: Math.round((100 * v) / (tot.expired.extraUsd + tot.invalidated.extraUsd)) }) : '';

  return [
    el('div', { class: 'kpis' },
      kpiCard(t('cache.kpi.rewrites'), String(d.missesTotal),
        t('cache.kpi.rewritesSub', { tokens: fmtTokens(tot.expired.tokens + tot.invalidated.tokens) })),
      kpiCard(t('cache.kpi.overpay'), fmtW(waste),
        spend ? t('cache.kpi.overpaySub', { pct: ((100 * waste) / spend).toFixed(1) }) : null),
      // The split that decides whether the TTL question is even the right one.
      kpiCard(t('cache.kpi.expired'), String(tot.expired.misses),
        t('cache.kpi.expiredSub', { value: tot.medianIdleMs ? fmtDuration(tot.medianIdleMs) : '—' }) + share(tot.expired.extraUsd)),
      kpiCard(t('cache.kpi.invalidated'), String(tot.invalidated.misses),
        t('cache.kpi.invalidatedSub') + share(tot.invalidated.extraUsd)),
      kpiCard(t('cache.kpi.ttlWrites'), `${fmtTokens(tot.ttl5m.write)} / ${fmtTokens(tot.ttl1h.write)}`,
        t('cache.kpi.ttlWritesSub'))),

    buildTtlVerdict(d, asLimit, fmtW, delta),

    d.byDay.length
      ? panel(t('cache.panel.byDayTitle'), t('cache.panel.byDayHint'), buildWasteBars(d.byDay, asLimit, fmtW))
      : null,

    d.byAgent.length
      ? panel(t('cache.panel.byAgentTitle'), t('cache.panel.byAgentHint'),
          el('div', { class: 'table-scroll' }, buildWasteAgents(d.byAgent, w, fmtW, waste, nav)))
      : null,

    d.misses.length
      ? panel(t('cache.panel.missesTitle'),
          d.missesTotal > d.misses.length ? t('cache.panel.missesHintCount', { shown: d.misses.length, total: d.missesTotal }) : t('cache.panel.missesHint'),
          el('div', { class: 'table-scroll' }, buildMissTable(d.misses, w, fmtW)))
      : el('div', { class: 'panel' }, el('div', { class: 'empty', text: t('cache.panel.noMisses') })),
  ].filter(Boolean);
}

// ── screen ───────────────────────────────────────────────────

export async function renderCache(box) {
  box.replaceChildren(el('div', { class: 'empty', text: t('common.calculating') }));
  const d = await api('/api/cache');
  // The toolbar can switch screens while this request is in flight.
  if (state.view !== 'cache') return;
  box.replaceChildren(...cacheSections(d));
}

/**
 * The `ENABLE_PROMPT_CACHING_1H` verdict. A 1h write costs 2x input against
 * 1.25x for the 5m one, so the flag only pays off if the misses it prevents
 * are worth more than the 60% surcharge on every other write.
 */
function buildTtlVerdict(d, asLimit, fmtW, delta) {
  const c = d.counterfactual;
  const saved = asLimit ? c.savedWeighted : c.savedUsd;
  const premium = asLimit ? c.premiumWeighted : c.premiumUsd;
  const actual = asLimit ? c.actualWeighted : c.actualUsd;
  const cheaper = delta < 0;
  const pct = actual ? Math.abs((100 * delta) / actual).toFixed(1) : '0';

  const row = (label, value, cls) =>
    el('div', { class: 'vrow' },
      el('span', { class: 'vlabel', text: label }),
      el('span', { class: 'vvalue ' + (cls ?? ''), text: value }));

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', { text: t('cache.verdict.title') }),
      el('span', { class: 'hint', text: state.metric === 'raw'
        ? t('cache.verdict.rawHint')
        : t('cache.verdict.counterfactualHint') })),
    el('div', { class: 'verdict ' + (cheaper ? 'good' : 'bad') },
      cheaper
        ? t('cache.verdict.cheaper', { value: fmtW(-delta), pct })
        : t('cache.verdict.moreExpensive', { value: fmtW(delta), pct })),
    el('div', { class: 'vgrid' },
      row(t('cache.verdict.row.actual'), fmtW(actual)),
      row(t('cache.verdict.row.hourlyTtl'), fmtW(asLimit ? c.hypoWeighted : c.hypoUsd), cheaper ? 'good' : 'bad'),
      row(t('cache.verdict.row.savedMisses'), '−' + fmtW(saved), 'good'),
      row(t('cache.verdict.row.premium'), '+' + fmtW(premium), 'bad')),
    el('p', { class: 'note', text: t('cache.verdict.note', {
      n: d.totals.invalidated.misses,
      lateMisses: d.totals.lateMisses,
    }) }));
}

function buildWasteBars(days, asLimit, fmtW) {
  const W = 900, H = 150, padL = 54, padR = 12, padT = 10, padB = 22;
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}` });
  const max = Math.max(...days.map((d) => (asLimit ? d.extraWeighted : d.extraUsd))) || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const step = plotW / days.length;
  const bw = Math.max(3, Math.min(34, step * 0.72));

  for (let i = 0; i <= 2; i++) {
    const y = padT + plotH - (plotH / 2) * i;
    svg.append(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: y, y2: y }));
    const txt = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    txt.textContent = fmtW((max / 2) * i);
    svg.append(txt);
  }

  days.forEach((d, i) => {
    const v = asLimit ? d.extraWeighted : d.extraUsd;
    const h = (v / max) * plotH;
    const r = svgEl('rect', {
      x: padL + i * step + (step - bw) / 2, y: padT + plotH - h,
      width: bw, height: Math.max(h, 1), fill: '#f85149', opacity: 0.85, rx: 1,
    });
    withTooltip(r, t('cache.chart.barTooltip', { day: d.day, value: fmtW(v), misses: d.misses }));
    r.addEventListener('click', () => go.day(d.day));
    svg.append(r);
    if (days.length <= 20 || i % Math.ceil(days.length / 14) === 0) {
      const txt = svgEl('text', { x: padL + i * step + step / 2, y: H - 7, 'text-anchor': 'middle' });
      txt.textContent = d.day.slice(5);
      svg.append(txt);
    }
  });
  return svg;
}

function buildWasteAgents(rows, w, fmtW, total, nav) {
  const tbl = el('table');
  tbl.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('common.col.agent') }), el('th', { text: t('cache.table.misses') }),
      el('th', { text: t('cache.table.rewritten') }), el('th', { text: t('common.col.overpay') }), el('th', { text: t('common.col.share') }))),
    el('tbody', {}, ...rows.map((r) =>
      el('tr', {
        onclick: nav.agent ? () => nav.agent(r.agent) : null,
        title: nav.agentTitle,
        style: nav.agent ? null : 'cursor:default',
      },
        el('td', { class: 'name', text: r.agent }),
        el('td', { class: 'num', text: String(r.misses) }),
        el('td', { class: 'num', text: fmtTokens(r.tokens) }),
        el('td', { class: 'num', text: fmtW(w(r)) }),
        el('td', { class: 'num', text: total ? ((100 * w(r)) / total).toFixed(1) + '%' : '—' }))))
  );
  return tbl;
}

function buildMissTable(rows, w, fmtW) {
  const tbl = el('table');
  tbl.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('cache.table.when') }), el('th', { text: t('common.col.agent') }), el('th', { text: t('cache.table.pause') }),
      el('th', { text: t('cache.table.rewritten') }), el('th', { text: t('common.col.turnPrice') }), el('th', { text: t('cache.table.wasted') }),
      el('th', { text: 'ttl' }), el('th', { text: t('cache.table.reason') }))),
    el('tbody', {}, ...rows.map((r) =>
      // Straight into the turn that paid for it — the run view opens scrolled
      // to this message with the miss chip on it.
      el('tr', { onclick: () => go.run(r.sessionId, r.agent, r.runId, r.ts) },
        el('td', { text: fmtTime(r.ts) }),
        el('td', { class: 'name', text: r.agent }),
        el('td', { class: 'num', text: fmtDuration(r.idleMs) }),
        el('td', { class: 'num', text: fmtTokens(r.tokens) }),
        el('td', { class: 'num', text: fmtUsd(r.turnUsd) }),
        el('td', { class: 'num accent', text: fmtW(w(r)) }),
        el('td', { text: r.ttl }),
        el('td', { class: r.cause === 'expired' ? 'dim' : 'warn-inline', title: missCauseHint(r),
          text: r.cause === 'expired' ? t('cache.table.expired') : t('cache.table.reset') }))))
  );
  return tbl;
}
