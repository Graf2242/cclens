/**
 * Dashboard. Talks to the local API, renders hand-rolled SVG — no chart
 * library, because the whole tool is meant to stay dependency-free.
 *
 * Four drill levels, each one a filter added to the same query:
 *   period → dimension slice (project / agent / model / workflow) → session →
 *   per-message timeline of that session with subagents on the same clock.
 */
import { cacheSections, cacheSessionNav, renderCache } from './cache.js';
import { diagHasAnything, diagSections, renderDiag, sessionNav } from './diag.js';
import { renderProbes, selectedProbe } from './probes.js';
import { applyStatic, locale, locales } from './i18n.js';
import {
  COLORS, MAIN_AGENT, PERIODS, SHARE_FORMATS, api, chartPicker, dayStart, el, fmt, fmtBytes, fmtDuration,
  fmtMetric, fmtTime, fmtTokens, fmtUsd, isoDay, kpiCard, missCauseHint, missCauseLong, missCauseShort,
  panel, panelWith, params, periodRange,
  qs, shareButton, shareFormat, shareQuery, shareRef, shareUrl, showCopyFallback,
  state, svgEl, t, withSource, withTooltip,
  copyText, go,
} from './ui.js';



const METRICS = [
  { id: 'usd', label: t('metric.usd.label'), title: t('metric.usd.title') },
  { id: 'weighted', label: t('metric.weighted.label'), title: t('metric.weighted.title') },
  { id: 'raw', label: t('metric.raw.label'), title: t('metric.raw.title') },
];

const DIMENSIONS = [
  { id: 'project', label: t('dimension.project') },
  { id: 'agent', label: t('dimension.agent') },
  { id: 'model', label: t('dimension.model') },
  { id: 'kind', label: t('dimension.kind') },
  { id: 'workflow', label: 'Workflow' },
  { id: 'effort', label: 'Effort' },
  { id: 'session_kind', label: t('dimension.session_kind') },
];

// A dimension key maps onto the filter of the same name; `kind` filters kind.
const FILTERABLE = new Set(['project', 'agent', 'model', 'kind']);



/** `YYYY-MM-DD` in local time — matches how the index computes its day key. */
function syncHash() {
  const q = new URLSearchParams();
  if (state.view !== 'spend') q.set('view', state.view);
  if (state.mode === 'day' && state.day) q.set('day', state.day);
  const view = nav[nav.length - 1];
  if (view) {
    q.set('session', view.sessionId);
    if (view.agent) q.set('agent', view.agent);
    if (view.runId) q.set('run', view.runId);
    // Only the non-default tab: a link to the overview is the bare session URL.
    if (view.kind === 'session' && view.tab !== 'overview') q.set('tab', view.tab);
  }
  const hash = q.toString();
  history.replaceState(null, '', hash ? '#' + hash : location.pathname);
}

function selectDay(iso) {
  state.mode = 'day';
  state.day = iso;
  refresh();
}

function shiftDay(delta) {
  const d = new Date(dayStart(state.day ?? isoDay(new Date())));
  d.setDate(d.getDate() + delta);
  selectDay(isoDay(d));
}


// ── toolbar ──────────────────────────────────────────────────

const VIEWS = [
  { id: 'spend', label: t('view.spend') },
  { id: 'cache', label: t('view.cache') },
  { id: 'diag', label: t('view.diag') },
  { id: 'probes', label: t('view.probes') },
];

/** Which `bl://` kind a screen hands over when you press «Поделиться». */
const SHARE_BY_VIEW = { spend: 'overview', cache: 'cache', diag: 'diag', probes: 'probe' };

/**
 * What the toolbar button hands over from the open screen. Everything shares
 * the period and the filters; «Пробы» additionally has to name the rule, and
 * falls back to the spend screen while no rule is selected — a `bl://probe`
 * without one is a 400, and a broken link is worse than a wider one.
 */
function toolbarShare() {
  const params = overviewParams();
  const kind = SHARE_BY_VIEW[state.view] ?? 'overview';
  if (kind !== 'probe') return { kind, params };
  const probe = selectedProbe();
  return probe ? { kind, params: { ...params, probe } } : { kind: 'overview', params };
}

function renderToolbar(activeDays) {
  const vg = document.getElementById('view-group');
  vg.replaceChildren(
    ...VIEWS.map((v) =>
      el('button', {
        text: v.label,
        'aria-pressed': String(state.view === v.id),
        onclick: () => {
          if (state.view === v.id) return;
          state.view = v.id;
          refresh();
        },
      })
    )
  );

  const pg = document.getElementById('period-group');
  pg.replaceChildren(
    ...PERIODS.map((p) =>
      el('button', {
        text: p.label,
        'aria-pressed': String(state.mode === 'range' && state.period === p.id),
        onclick: () => {
          state.mode = 'range';
          state.period = p.id;
          state.day = null;
          refresh();
        },
      })
    )
  );

  renderDayPicker(activeDays);

  const mg = document.getElementById('metric-group');
  mg.replaceChildren(
    ...METRICS.map((m) =>
      el('button', {
        text: m.label,
        title: m.title,
        'aria-pressed': String(state.metric === m.id),
        onclick: () => {
          state.metric = m.id;
          refresh();
        },
      })
    )
  );

  // Built once: the button reads state at click time, so re-rendering it on
  // every refresh would only throw away an open menu.
  const slot = document.getElementById('share-slot');
  if (!slot.children.length) {
    slot.append(
      // Each screen shares itself: the toolbar button follows the open view,
      // otherwise a finding on «Диагностика» would be handed over as «Расход».
      shareButton(toolbarShare, {
        title: t('toolbar.shareTitle'),
      })
    );
  }

  const ds = document.getElementById('dim-select');
  if (!ds.options.length) {
    ds.replaceChildren(...DIMENSIONS.map((d) => el('option', { value: d.id, text: d.label })));
    ds.addEventListener('change', () => {
      state.dim = ds.value;
      refresh();
    });
  }
  ds.value = state.dim;
}

/**
 * Day picker. The arrows are the point — stepping day by day is how you find
 * the day that broke the trend, and clicking through a date field is not that.
 */
function renderDayPicker(activeDays) {
  const box = document.getElementById('daypick');
  const isDay = state.mode === 'day';
  const today = isoDay(new Date());

  const input = el('input', {
    type: 'date',
    value: state.day ?? today,
    min: activeDays?.min ?? null,
    max: activeDays?.max ?? today,
    title: t('toolbar.specificDay'),
  });
  input.addEventListener('change', () => input.value && selectDay(input.value));

  const atEdge = (dir) => {
    if (!isDay || !state.day) return false;
    const bound = dir < 0 ? activeDays?.min : activeDays?.max;
    return bound ? (dir < 0 ? state.day <= bound : state.day >= bound) : false;
  };

  box.replaceChildren(
    el('button', {
      class: 'ghost arrow',
      text: '‹',
      title: t('toolbar.prevDay'),
      disabled: atEdge(-1) ? '' : null,
      onclick: () => shiftDay(-1),
    }),
    input,
    el('button', {
      class: 'ghost arrow',
      text: '›',
      title: t('toolbar.nextDay'),
      disabled: atEdge(1) ? '' : null,
      onclick: () => shiftDay(1),
    }),
    el('button', {
      class: 'ghost',
      text: isDay ? t('toolbar.resetDay') : t('toolbar.today'),
      onclick: () =>
        isDay
          ? ((state.mode = 'range'), (state.day = null), refresh())
          : selectDay(today),
    })
  );
  box.classList.toggle('active', isDay);
}

function renderChips() {
  const box = document.getElementById('chips');
  const entries = Object.entries(state.filters).filter(([, v]) => v);
  box.replaceChildren(
    ...entries.map(([k, v]) =>
      el(
        'span',
        { class: 'chip' },
        el('span', { text: k + ': ' }),
        el('b', { text: String(v).length > 46 ? String(v).slice(0, 46) + '…' : String(v) }),
        el('button', {
          text: '✕',
          title: t('toolbar.removeFilter'),
          onclick: () => {
            delete state.filters[k];
            refresh();
          },
        })
      )
    )
  );
}

// ── kpis ─────────────────────────────────────────────────────

function renderKpis(total, span) {
  const box = document.getElementById('kpis');
  const kpi = (label, value, sub, accent) =>
    el(
      'div',
      { class: 'kpi' },
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value' + (accent ? ' accent' : ''), text: value }),
      sub ? el('div', { class: 'sub', text: sub }) : null
    );

  const cacheShare = total.usd ? (100 * (total.cacheRead * 1.5)) / 1e6 / total.usd : 0;

  box.replaceChildren(
    kpi(t('spend.kpi.spend'), fmtMetric(total.value), t('spend.kpi.messages', { n: total.messages }), true),
    kpi('Cache read', fmtTokens(total.cacheRead), t('spend.kpi.cacheShare', { pct: cacheShare.toFixed(0) })),
    kpi('Cache write', fmtTokens(total.cacheWrite)),
    kpi('Output', fmtTokens(total.output)),
    kpi('Input', fmtTokens(total.input)),
    kpi(t('spend.kpi.sessions'), String(total.sessions))
  );

  const note = document.getElementById('span-note');
  note.textContent = span?.minTs
    ? t('toolbar.span', {
        messages: t('spend.kpi.messages', { n: span.messages }),
        from: fmt.date(span.minTs),
        to: fmt.date(span.maxTs),
      })
    : '';
}

// ── donut ────────────────────────────────────────────────────

function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rOuter, a0);
  const [x1, y1] = pt(rOuter, a1);
  const [x2, y2] = pt(rInner, a1);
  const [x3, y3] = pt(rInner, a0);
  return `M${x0},${y0}A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${rInner},${rInner} 0 ${large} 0 ${x3},${y3}Z`;
}

function renderDonut(buckets, total) {
  const svg = document.getElementById('donut');
  svg.replaceChildren();
  const legend = document.getElementById('legend');

  const sum = buckets.reduce((s, b) => s + b.value, 0);
  if (!sum) {
    legend.replaceChildren(el('li', { text: t('common.empty') }));
    return;
  }

  // Keep the chart legible: everything past the top 9 collapses into "прочее".
  const top = buckets.slice(0, 9);
  const restVal = buckets.slice(9).reduce((s, b) => s + b.value, 0);
  const slices = restVal > 0 ? [...top, { key: '(other)', label: t('common.other'), value: restVal }] : top;

  let angle = -Math.PI / 2;
  slices.forEach((b, i) => {
    const sweep = (b.value / sum) * Math.PI * 2;
    const path = svgEl('path', {
      d: arcPath(110, 110, 100, 62, angle, angle + Math.max(sweep, 0.002)),
      fill: COLORS[i % COLORS.length],
    });
    withTooltip(path, t('spend.chart.sliceTooltip', {
      label: b.label, value: fmtMetric(b.value), pct: ((100 * b.value) / sum).toFixed(1),
    }));
    if (b.key !== '(other)') path.addEventListener('click', () => drillDim(b.key));
    svg.append(path);
    angle += sweep;
  });

  const cv = svgEl('text', { x: 110, y: 108, 'text-anchor': 'middle', class: 'center-value' });
  cv.textContent = fmtMetric(total.value);
  const cl = svgEl('text', { x: 110, y: 122, 'text-anchor': 'middle', class: 'center-label' });
  cl.textContent = METRICS.find((m) => m.id === state.metric).title.split(' ')[0].toUpperCase();
  svg.append(cv, cl);

  legend.replaceChildren(
    ...slices.map((b, i) =>
      el(
        'li',
        { onclick: () => b.key !== '(other)' && drillDim(b.key) },
        el('span', { class: 'sw', style: `background:${COLORS[i % COLORS.length]}` }),
        el('span', { class: 'name', text: b.label, title: b.label }),
        el('span', { class: 'val', text: `${fmtMetric(b.value)} · ${((100 * b.value) / sum).toFixed(0)}%` })
      )
    )
  );
}

function drillDim(key) {
  if (!FILTERABLE.has(state.dim)) return;
  state.filters[state.dim === 'kind' ? 'kind' : state.dim] = key;
  refresh();
}

// ── stacked bars ─────────────────────────────────────────────

function renderBars(data) {
  const svg = document.getElementById('bars');
  svg.replaceChildren();
  const W = 720, H = 260, padL = 46, padB = 26, padT = 10, padR = 8;
  const hourly = data.bucketSize === 'hour';

  document.getElementById('bars-title').textContent = hourly
    ? t('spend.chart.byHour', { day: state.day })
    : t('spend.chart.byDay');
  document.getElementById('bars-hint').textContent = hourly
    ? t('spend.chart.hourlyHint')
    : t('spend.chart.dailyHint');

  const byBucket = new Map();
  for (const c of data.cells) {
    if (!byBucket.has(c.bucket)) byBucket.set(c.bucket, new Map());
    const m = byBucket.get(c.bucket);
    m.set(c.key, (m.get(c.key) ?? 0) + c.value);
  }

  // In hourly mode show the whole 24h frame, so a burst at 03:00 reads as a
  // burst at 03:00 rather than as "the first bar of the day".
  const buckets = hourly
    ? Array.from({ length: 24 }, (_, h) => `${state.day} ${String(h).padStart(2, '0')}:00`)
    : data.buckets;
  if (!buckets.length) {
    const txt = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' });
    txt.textContent = t('common.empty');
    svg.append(txt);
    return;
  }

  const max = Math.max(
    ...buckets.map((d) => [...(byBucket.get(d)?.values() ?? [0])].reduce((s, v) => s + v, 0))
  );
  if (!max) {
    const txt = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' });
    txt.textContent = t('spend.chart.noSpendDay');
    svg.append(txt);
    return;
  }

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = Math.max(1, Math.min(26, (plotW / buckets.length) * 0.78));
  const step = plotW / buckets.length;
  const keyIndex = new Map(data.keys.map((k, i) => [k, i]));

  // y axis: three gridlines is enough to read magnitude without clutter
  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i;
    const y = padT + plotH - (v / max) * plotH;
    svg.append(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y }));
    const txt = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    txt.textContent = fmtMetric(v);
    svg.append(txt);
  }

  buckets.forEach((bucket, di) => {
    const m = byBucket.get(bucket) ?? new Map();
    let y = padT + plotH;
    const ordered = [...m.entries()].sort((a, b) => (keyIndex.get(a[0]) ?? 99) - (keyIndex.get(b[0]) ?? 99));
    for (const [key, val] of ordered) {
      const h = (val / max) * plotH;
      y -= h;
      const idx = keyIndex.get(key) ?? data.keys.length;
      const rect = svgEl('rect', {
        x: padL + di * step + (step - bw) / 2,
        y,
        width: bw,
        height: Math.max(h, 0.5),
        fill: key === '(other)' ? '#3d4654' : COLORS[idx % COLORS.length],
        rx: 1,
      });
      withTooltip(
        rect,
        t('spend.chart.barTooltip', { bucket, key, value: fmtMetric(val) }) +
          (hourly ? '' : '\n' + t('spend.chart.dayDrillHint'))
      );
      // In day mode the bar IS the drill target; once a day is fixed, clicking
      // an hour bar drills the dimension instead.
      rect.addEventListener('click', () =>
        hourly ? key !== '(other)' && drillDim(key) : selectDay(bucket)
      );
      svg.append(rect);
    }

    // Thin the tick labels so they never overlap.
    const every = Math.ceil(buckets.length / (hourly ? 12 : 14));
    if (di % every === 0) {
      const txt = svgEl('text', {
        x: padL + di * step + step / 2,
        y: H - padB + 14,
        'text-anchor': 'middle',
      });
      txt.textContent = hourly ? bucket.slice(11, 16) : bucket.slice(5);
      svg.append(txt);
    }
  });
}

// ── tables ───────────────────────────────────────────────────

function renderBreakdown(buckets, total) {
  const table = document.getElementById('breakdown');
  const dimLabel = DIMENSIONS.find((d) => d.id === state.dim)?.label ?? state.dim;
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      el('th', { text: dimLabel }),
      el('th', { text: t('common.col.share') }),
      el('th', { text: t('common.col.spend') }),
      el('th', { text: 'output' }),
      el('th', { text: 'cache read' }),
      el('th', { text: 'cache write' }),
      el('th', { text: t('common.col.messages') }),
      el('th', { text: t('common.col.sessions') })
    )
  );
  const body = el(
    'tbody',
    {},
    ...buckets.map((b) => {
      const share = total.value ? (100 * b.value) / total.value : 0;
      return el(
        'tr',
        { onclick: () => drillDim(b.key) },
        el('td', { class: 'name', text: b.label, title: b.label }),
        el(
          'td',
          { class: 'num' },
          el('span', { class: 'share', style: `width:${Math.max(2, share).toFixed(1)}px` }),
          el('span', { text: ' ' + share.toFixed(1) + '%' })
        ),
        el('td', { class: 'num', text: fmtMetric(b.value) }),
        el('td', { class: 'num', text: fmtTokens(b.output) }),
        el('td', { class: 'num', text: fmtTokens(b.cacheRead) }),
        el('td', { class: 'num', text: fmtTokens(b.cacheWrite) }),
        el('td', { class: 'num', text: String(b.messages) }),
        el('td', { class: 'num', text: String(b.sessions) })
      );
    })
  );
  table.replaceChildren(head, body);
}

function renderSessions(rows, total) {
  const table = document.getElementById('sessions');
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      el('th', { text: t('common.col.session') }),
      el('th', { text: t('spend.sessionsTable.project') }),
      el('th', { text: t('spend.sessionsTable.activity') }),
      el('th', { text: t('common.col.share') }),
      el('th', { text: t('common.col.spend') }),
      el('th', { text: 'cache read' }),
      el('th', { text: t('common.col.messages') })
    )
  );
  const body = el(
    'tbody',
    {},
    ...rows.map((r) => {
      const share = total.value ? (100 * r.value) / total.value : 0;
      return el(
        'tr',
        { onclick: () => openSession(r.key) },
        el('td', { class: 'name', text: r.label, title: r.info?.firstPrompt ?? r.key }),
        el('td', { text: r.info?.projectLabel ?? '' }),
        // Window-scoped, not the session's all-time last activity: with a
        // single day selected the two differ and only the former is meaningful.
        el('td', { text: r.lastTs ? fmtTime(r.lastTs) : '' }),
        el('td', { class: 'num', text: share.toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmtMetric(r.value) }),
        el('td', { class: 'num', text: fmtTokens(r.cacheRead) }),
        el('td', { class: 'num', text: String(r.messages) })
      );
    })
  );
  table.replaceChildren(head, body);
}

// ── drawer: session → agent → run ────────────────────────────

/**
 * The drawer is a navigation stack, not a single view. Clicking an agent used
 * to close the drawer and apply a global filter, which threw away the context
 * you had just built up; now it descends one level and the stack remembers
 * where you came from.
 */
const nav = [];

function pushView(view) {
  nav.push(view);
  renderDrawer();
}

function popView() {
  nav.pop();
  if (!nav.length) return closeDrawer();
  renderDrawer();
}

const openSession = (sessionId) => pushView({ kind: 'session', sessionId });
const openAgent = (sessionId, agent) => pushView({ kind: 'agent', sessionId, agent });
const openRun = (sessionId, agent, runId, focusTs) =>
  pushView({ kind: 'run', sessionId, agent, runId, focusTs });

/**
 * Jumping from a timeline bar straight into its run would leave a hole in the
 * breadcrumb trail, so the agent level is pushed unrendered underneath it —
 * the crumb still works, it just was never the current view.
 */
const openRunAt = (sessionId, agent, runId, focusTs) => {
  // Called from inside a session view (stack already has it) and from the
  // cache report (stack is empty) — the trail must be complete either way.
  const top = nav[nav.length - 1];
  if (!top || top.sessionId !== sessionId) nav.push({ kind: 'session', sessionId });
  nav.push({ kind: 'agent', sessionId, agent });
  openRun(sessionId, agent, runId, focusTs);
};

function currentView() {
  return nav[nav.length - 1] ?? null;
}

// The screen modules get drill-in without importing this file back.
Object.assign(go, {
  session: openSession,
  agent: openAgent,
  run: openRunAt,
  filter: (key, value) => {
    state.filters[key] = value;
    refresh();
  },
  day: selectDay,
  refresh: () => refresh(),
});


// ── поделиться находкой ──────────────────────────────────────
//
// Everything on this screen is addressable: a view is a `kind` plus the params
// that pin it down, and `/s/<kind>?…` renders exactly what is being looked at
// for someone who cannot see the screen. The button copies that address in
// whichever shape the receiver needs — a URL for an agent that can fetch, the
// payload itself for one that cannot, a CLI line for when the server is down.



/** Period + filters exactly as the toolbar has them — what the screen shows. */
const overviewParams = () => ({ metric: state.metric, ...periodRange(), ...state.filters });

function renderBreadcrumbs() {
  const box = document.getElementById('crumbs');
  const labels = nav.map((v) =>
    v.kind === 'session' ? t('drawer.session') : v.kind === 'agent' ? v.agent : t('drawer.runCrumb', { shortId: v.runId.slice(0, 8) })
  );
  // `replaceChildren` stringifies null into a literal "null" text node —
  // unlike `el()`, it does no filtering of its own.
  box.replaceChildren(
    ...labels.flatMap((label, i) => [
      i > 0 ? el('span', { class: 'sep', text: '›' }) : null,
      el('button', {
        class: 'crumb',
        text: label,
        'aria-current': i === labels.length - 1 ? 'page' : null,
        onclick: () => {
          nav.length = i + 1;
          renderDrawer();
        },
      }),
    ]).filter(Boolean)
  );
}

async function renderDrawer() {
  const view = currentView();
  if (!view) return closeDrawer();
  document.getElementById('drawer').hidden = false;
  state.session = view.sessionId;
  syncHash();
  renderBreadcrumbs();
  document.getElementById('drawer-back').hidden = nav.length < 2;

  // One button for whichever level is open — the drawer is the level, so the
  // share follows the breadcrumb rather than needing one button per screen.
  document.getElementById('drawer-share').replaceChildren(
    shareButton(
      () => {
        const v = currentView();
        if (!v) return null;
        // The session level has three tabs and they are three different
        // findings: handing over «Обзор» while «Диагностика»/«Кэш» is open
        // would give the reader the timeline they did not ask about.
        if (v.kind === 'session')
          return v.tab === 'cache'
            ? { kind: 'cache', params: { session: v.sessionId, metric: state.metric } }
            : v.tab === 'diag'
            ? { kind: 'diag', params: { session: v.sessionId, metric: state.metric } }
            : { kind: 'session', params: { session: v.sessionId, metric: state.metric } };
        if (v.kind === 'agent')
          return { kind: 'agent', params: { session: v.sessionId, agent: v.agent, metric: state.metric } };
        return { kind: 'run', params: { session: v.sessionId, run: v.runId, metric: state.metric } };
      },
      { compact: true, title: t('drawer.shareTitle') }
    )
  );

  const body = document.getElementById('drawer-body');
  body.replaceChildren(el('div', { class: 'empty', text: t('common.loading') }));

  if (view.kind === 'session') return renderSessionView(view);
  if (view.kind === 'agent') return renderAgentView(view);
  return renderRunView(view);
}

// ── level 1: session ─────────────────────────────────────────

const SESSION_TABS = [
  { id: 'overview', label: t('session.tab.overview') },
  { id: 'diag', label: t('view.diag') },
  { id: 'cache', label: t('view.cache') },
];

/**
 * The tab strip of the session level.
 *
 * Three views of one session rather than one long scroll: «Обзор» answers WHEN
 * and WHO — the timeline and the agents; «Диагностика» answers WHERE the money
 * went that did not have to; «Кэш» answers where THIS session overpaid to
 * rewrite context it had already cached. The choice lives on the view object,
 * so stepping into a run and back via the breadcrumb returns to the tab you left.
 */
function sessionTabs(view, render) {
  return el('div', { class: 'group drawer-tabs', role: 'group', 'aria-label': t('session.tabs.ariaLabel') },
    ...SESSION_TABS.map((tab) =>
      el('button', {
        text: tab.label,
        'aria-pressed': String(view.tab === tab.id),
        onclick: () => {
          if (view.tab === tab.id) return;
          view.tab = tab.id;
          // The tab is part of the address, and nothing else re-syncs it: the
          // drawer is not re-entered, only re-drawn.
          syncHash();
          render();
        },
      })));
}

/**
 * The same report `/api/diag` builds for the whole corpus, narrowed to one
 * session. No period is sent: a session already is its own window, and the
 * toolbar's «7 дней» would only be able to cut it short.
 *
 * The payload is kept on the view, so switching tabs back and forth is free —
 * it is re-fetched only when the metric it was computed for is no longer the
 * one selected.
 */
async function renderSessionDiag(view, tabs) {
  const body = document.getElementById('drawer-body');
  body.replaceChildren(tabs, el('div', { class: 'empty', text: t('common.calculating') }));

  if (view.diag?.metric !== state.metric) {
    const d = await fetch(
      withSource(`/api/diag?session=${encodeURIComponent(view.sessionId)}&metric=${state.metric}`)
    ).then((r) => r.json());
    // The drawer can be navigated away from while this is in flight.
    if (currentView() !== view || view.tab !== 'diag') return;
    view.diag = { metric: state.metric, data: d };
  }

  const d = view.diag.data;
  document.getElementById('drawer-body').replaceChildren(
    tabs,
    ...(diagHasAnything(d)
      ? diagSections(d, sessionNav(view.sessionId))
      : [el('div', { class: 'panel' },
          el('div', { class: 'empty', text: t('session.diag.nothingToAnalyze') }))])
  );
}

/**
 * The same report `/api/cache` builds for the whole corpus, narrowed to one
 * session — no `&metric=`: unlike diagnostics, `cacheReport` carries both
 * `extraUsd` and `extraWeighted` at once, so a metric switch re-renders from
 * the payload already on the view instead of re-fetching.
 */
async function renderSessionCache(view, tabs) {
  const body = document.getElementById('drawer-body');
  body.replaceChildren(tabs, el('div', { class: 'empty', text: t('common.calculating') }));

  if (!view.cache) {
    const d = await fetch(
      withSource(`/api/cache?session=${encodeURIComponent(view.sessionId)}`)
    ).then((r) => r.json());
    // The drawer can be navigated away from while this is in flight.
    if (currentView() !== view || view.tab !== 'cache') return;
    view.cache = d;
  }

  document.getElementById('drawer-body').replaceChildren(
    tabs,
    ...cacheSections(view.cache, cacheSessionNav(view.sessionId))
  );
}

async function renderSessionView(view) {
  const data = await fetch(
    withSource(`/api/session?id=${encodeURIComponent(view.sessionId)}&metric=${state.metric}`)
  ).then((r) => r.json());
  if (currentView() !== view) return;

  document.getElementById('drawer-title').textContent =
    data.info?.title ?? (data.info?.firstPrompt ?? view.sessionId).slice(0, 90);
  document.getElementById('drawer-sub').textContent = [
    data.info?.cwd,
    data.info?.gitBranch,
    data.info?.firstTs ? fmtTime(data.info.firstTs) : null,
    view.sessionId,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Built once and re-inserted by every `draw()`: zooming the timeline must not
  // fold a prompt the person just opened.
  const promptPanel = buildRootPrompt(data.prompt);

  const points = data.timeline;
  const labels = new Map(data.agents.map((a) => [a.key, a.label]));
  // Session-wide order, so an agent keeps its colour at every zoom level.
  const order = aggregateAgents(points, labels).map((a) => a.key);
  // Zoom, isolation and the open tab live on the view, so stepping into a run
  // and coming back via the breadcrumb returns you to what you were looking at.
  view.win ??= null;
  view.only ??= null;
  view.tab ??= 'overview';

  const render = () =>
    view.tab === 'diag' ? renderSessionDiag(view, sessionTabs(view, render))
    : view.tab === 'cache' ? renderSessionCache(view, sessionTabs(view, render))
    : draw();

  const draw = () => {
    const inWin = view.win
      ? points.filter((p) => p.ts >= view.win.from && p.ts <= view.win.to)
      : points;
    const shown = view.only ? inWin.filter((p) => p.agent === view.only) : inWin;
    const totalVal = shown.reduce((s, p) => s + p.value, 0);
    const agents = aggregateAgents(shown, labels);
    const subs = agents.filter((a) => a.key !== MAIN_AGENT);
    const span = shown.length ? shown[shown.length - 1].ts - shown[0].ts : 0;

    const head = el('div', { class: 'panel-head' },
      el('h2', { text: t('session.timeline.title') }),
      view.win || view.only
        ? el('button', {
            class: 'ghost tiny',
            text: t('session.timeline.resetWindow'),
            onclick: () => { view.win = null; view.only = null; draw(); },
          })
        : null,
      el('span', { class: 'hint', text: t('session.timeline.hint') }));

    document.getElementById('drawer-body').replaceChildren(
      sessionTabs(view, render),
      el('div', { class: 'kpis' },
        kpiCard(view.win || view.only ? t('session.kpi.spendWindow') : t('session.kpi.spendSession'), fmtMetric(totalVal),
          view.win || view.only ? t('session.kpi.spendOutOf', { total: fmtMetric(points.reduce((s, p) => s + p.value, 0)) }) : null),
        kpiCard(t('session.kpi.messages'), String(shown.length), span ? fmtDuration(span) : null),
        kpiCard(t('session.kpi.subagents'), String(subs.length)),
        kpiCard(t('session.kpi.subagentShare'),
          totalVal ? Math.round((100 * subs.reduce((s, a) => s + a.value, 0)) / totalVal) + '%' : '0%')),
      promptPanel,
      el('div', { class: 'panel' }, head,
        buildTimeline(inWin, {
          only: view.only,
          order,
          onZoom: (from, to) => { view.win = from == null ? null : { from, to }; draw(); },
          onIsolate: (agent) => { view.only = view.only === agent ? null : agent; draw(); },
          onPick: (p) => openRunAt(view.sessionId, p.agent, p.runId, p.ts),
        })),
      panel(t('session.panel.agentsTitle'), t('session.panel.agentsHint'),
        el('div', { class: 'table-scroll' }, buildAgentTable(view.sessionId, agents, totalVal)))
    );
  };

  render();
}

/**
 * The turn that started the session, shown in full.
 *
 * A session's numbers only mean something next to what was asked for, and the
 * list label is a 90-char stub. When the session opened with a slash command
 * the visible text is just the command name, so its expansion — the body that
 * actually entered the context — is offered next to it, folded.
 */
function buildRootPrompt(p) {
  if (!p) {
    return panel(t('session.prompt.title'), null,
      el('div', { class: 'empty', text: t('session.prompt.notFound') }));
  }

  const chars = (n) => t('units.chars', { v: fmtTokens(n) });
  const parts = [];

  // A slash command is a name plus what was typed after it: the name reads as a
  // label, the arguments are the request and get the block.
  if (p.command) parts.push(el('div', { class: 'prompt-cmd' }, el('b', { text: p.command })));
  const shown = p.command ? p.args : p.text;
  if (shown) parts.push(el('pre', { class: 'body prompt-text', text: shown }));
  else if (!p.command) parts.push(el('div', { class: 'empty', text: t('session.prompt.empty') }));
  if (p.truncated) {
    parts.push(el('div', { class: 'hint', text: t('session.prompt.truncatedNote', { chars: chars(p.chars) }) }));
  }

  if (p.expansion) {
    const exp = el('pre', { class: 'body prompt-text', text: p.expansion.text });
    exp.hidden = true;
    const toggle = el('button', {
      class: 'ghost tiny',
      text: t('session.prompt.expandLabel', { chars: chars(p.expansion.chars) }) + ' ▾',
      onclick: () => {
        exp.hidden = !exp.hidden;
        toggle.textContent =
          t('session.prompt.expandLabel', { chars: chars(p.expansion.chars) }) + ' ' + (exp.hidden ? '▾' : '▴');
      },
    });
    parts.push(el('div', { class: 'prompt-more' }, toggle), exp);
  }

  const copy = el('button', {
    class: 'ghost tiny',
    text: t('session.prompt.copy'),
    onclick: async () => {
      const ok = await copyText(p.expansion ? p.text + '\n\n' + p.expansion.text : p.text);
      if (ok) {
        copy.textContent = t('session.prompt.copied');
        setTimeout(() => (copy.textContent = t('session.prompt.copy')), 1500);
      }
    },
  });

  return panelWith(copy, t('session.prompt.title'),
    [p.ts ? fmtTime(p.ts) : null, chars(p.chars)].filter(Boolean).join('  ·  '),
    el('div', { class: 'prompt-box' }, ...parts));
}

/** Re-aggregate the visible slice of the timeline — the window is client-side. */
function aggregateAgents(points, labels) {
  const by = new Map();
  for (const p of points) {
    let a = by.get(p.agent);
    if (!a) by.set(p.agent, (a = {
      key: p.agent, label: labels.get(p.agent) ?? p.agent,
      value: 0, output: 0, cacheRead: 0, messages: 0,
    }));
    a.value += p.value;
    a.output += p.output;
    a.cacheRead += p.cacheRead;
    a.messages++;
  }
  return [...by.values()].sort((x, y) => y.value - x.value);
}

function buildAgentTable(sessionId, agents, total) {
  const tbl = el('table');
  tbl.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('common.col.agent') }), el('th', { text: t('common.col.share') }), el('th', { text: t('common.col.spend') }),
      el('th', { text: 'output' }), el('th', { text: 'cache read' }), el('th', { text: t('common.col.messages') }),
      el('th', { text: '' }))),
    el('tbody', {}, ...agents.map((a) =>
      el('tr', { onclick: () => openAgent(sessionId, a.key) },
        el('td', { class: 'name', text: a.label }),
        el('td', { class: 'num', text: (total ? (100 * a.value) / total : 0).toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmtMetric(a.value) }),
        el('td', { class: 'num', text: fmtTokens(a.output) }),
        el('td', { class: 'num', text: fmtTokens(a.cacheRead) }),
        el('td', { class: 'num', text: String(a.messages) }),
        // The old behaviour, kept as an explicit action rather than as the
        // surprising side effect of clicking the row.
        el('td', {}, el('button', {
          class: 'ghost tiny',
          text: t('common.action.filterButton'),
          title: t('common.action.filterByAgentTitle'),
          onclick: (e) => {
            e.stopPropagation();
            state.filters.agent = a.key;
            closeDrawer();
            refresh();
          },
        })))))
  );
  return tbl;
}

// ── level 2: runs of one agent ───────────────────────────────


async function renderAgentView(view) {
  // Probe flags ride along with the runs: a run someone flagged should be
  // marked where the runs are listed, not only on the probes screen. A source
  // with no probes answers with an empty map, so it costs one small request.
  const [data, marks] = await Promise.all([
    fetch(
      withSource(
        `/api/runs?session=${encodeURIComponent(view.sessionId)}&agent=${encodeURIComponent(view.agent)}&metric=${state.metric}`
      )
    ).then((r) => r.json()),
    fetch(withSource(`/api/probe-flags?session=${encodeURIComponent(view.sessionId)}`))
      .then((r) => r.json())
      .catch(() => ({ flags: {} })),
  ]);
  if (currentView() !== view) return;

  const runs = data.runs ?? [];
  const total = runs.reduce((s, r) => s + r.value, 0);
  const byTime = [...runs].sort((a, b) => a.firstTs - b.firstTs);

  document.getElementById('drawer-title').textContent = view.agent;
  document.getElementById('drawer-sub').textContent =
    t('run.subtitle', { n: runs.length, value: fmtMetric(total) });

  document.getElementById('drawer-body').replaceChildren(
    el(
      'div',
      { class: 'kpis' },
      kpiCard(t('run.kpi.total'), fmtMetric(total)),
      kpiCard(t('run.kpi.runs'), String(runs.length)),
      kpiCard(t('run.kpi.avgRun'), runs.length ? fmtMetric(total / runs.length) : '—'),
      kpiCard(t('run.kpi.mostExpensive'), runs.length ? fmtMetric(runs[0].value) : '—',
        runs.length ? fmtDuration(runs[0].durationMs) : null),
      kpiCard(t('run.kpi.peakContext'), runs.length ? fmtTokens(Math.max(...runs.map((r) => r.peakContext))) : '—')
    ),
    panel(t('run.panel.byTimeTitle'), t('run.panel.byTimeHint'),
      buildRunBars(view, byTime)),
    // Only meaningful with siblings to compare: one run cannot duplicate a peer.
    runs.length >= 2 ? buildCohort(view, runs) : null,
    panel(t('run.panel.allTitle'), t('run.panel.allHint'),
      el('div', { class: 'table-scroll' }, buildRunTable(view, runs, total, marks.flags ?? {})))
  );
}

/**
 * What every dispatch of this agent collected, and how much of it was the same
 * thing collected independently.
 *
 * Lives at the agent level because that is where the siblings are: a fan-out
 * of thirty `test-writer` runs is invisible from inside any one of them — each
 * read its files exactly once. Only the cohort shows the file read thirty times.
 */
function buildCohort(view, runs) {
  // Two waves of the same workflow in one session share no work, so pooling
  // them would invent duplication the runs never had a chance to avoid. When
  // the runs span several workflow ids, the biggest one is the honest default.
  const wfs = [...new Set(runs.map((r) => r.workflowId).filter(Boolean))];
  const byWf = new Map();
  for (const r of runs) byWf.set(r.workflowId, (byWf.get(r.workflowId) ?? 0) + 1);
  let scope = wfs.length > 1
    ? wfs.reduce((a, b) => (byWf.get(b) > byWf.get(a) ? b : a))
    : (wfs[0] ?? null);

  const body = el('div', { class: 'compose-idle' },
    el('button', { class: 'ghost', text: t('common.action.expand'), onclick: () => load() }),
    el('span', { class: 'hint', text: t('cohort.panel.idleHint') }));
  // The share carries the workflow scope the panel is actually showing: the
  // whole point of the scope selector is that two waves are different findings.
  const box = panelWith(
    shareButton(
      () => ({
        kind: 'cohort',
        params: {
          session: view.sessionId,
          agent: view.agent,
          metric: state.metric,
          ...(scope ? { workflow: scope } : {}),
        },
      }),
      { compact: true, title: t('cohort.shareTitle') }
    ),
    t('cohort.panel.title'),
    null,
    body
  );

  const load = async () => {
    body.className = 'composition';
    // Count the runs actually about to be read, not every run of the agent:
    // scoped to one workflow that is usually a fraction of them, and a wait
    // explained by the wrong number reads as the tool being slow.
    const n = scope ? runs.filter((r) => r.workflowId === scope).length : runs.length;
    body.replaceChildren(el('div', { class: 'empty', text: t('cohort.loading', { n }) }));
    let d;
    try {
      // The key is omitted, never sent empty: URLSearchParams would stringify a
      // null into the literal "null" and the query would look for a workflow
      // by that name — which is also every agent that ran outside a workflow.
      d = await api('/api/cohort', {
        session: view.sessionId,
        agent: view.agent,
        ...(scope ? { workflow: scope } : {}),
      });
    } catch (e) {
      body.replaceChildren(el('div', { class: 'empty', text: t('common.error.failed', { detail: e }) }));
      return;
    }
    if (currentView() !== view) return;
    if (d.error) {
      body.replaceChildren(el('div', { class: 'empty', text: d.error }));
      return;
    }
    // `serve` loads its modules once at startup, so editing the analyzer while
    // it runs leaves a live process answering with the old shape while the
    // browser — served no-store — already has the new renderer. Name that,
    // because the symptom is a panel that just sits on "Читаю логи…".
    if (d.breakEvenTurn == null) {
      body.replaceChildren(el('div', { class: 'empty', text: t('cohort.error.staleServer') }));
      return;
    }
    // Rendering is inside the guard too: a throw here used to reject the
    // promise silently and leave the loading message up forever.
    try {
      body.replaceChildren(...cohortBody(d, view, wfs, scope, (next) => { scope = next; load(); }));
    } catch (e) {
      body.replaceChildren(el('div', { class: 'empty', text: t('cohort.error.renderFailed', { detail: e }) }));
      throw e;
    }
  };

  return box;
}

function cohortBody(d, view, wfs, scope, setScope) {
  const out = [];

  if (wfs.length > 1) {
    const sel = el('select', { class: 'wf-scope', onchange: (e) => setScope(e.target.value || null) });
    sel.append(el('option', { value: '', text: t('cohort.scope.wholeSession'), selected: scope === null ? '' : null }));
    for (const w of wfs) sel.append(el('option', { value: w, text: 'workflow ' + w, selected: scope === w ? '' : null }));
    out.push(el('div', { class: 'sub-head' },
      el('span', { class: 'hint', text: t('cohort.scope.hint') }),
      sel));
  }

  const shareOfCollected = d.collectedTokens ? (100 * d.sharedTokens) / d.collectedTokens : 0;
  const shareOfSpend = d.actualValue ? (100 * d.wastedValue) / d.actualValue : 0;

  out.push(el('p', { class: 'note', text: t('cohort.summary.collected', {
    activeRuns: d.activeRuns,
    collectedTokens: fmtTokens(d.collectedTokens),
    sharedTokens: fmtTokens(d.sharedTokens),
    shareOfCollected: shareOfCollected.toFixed(0),
    wastedValue: fmtMetric(d.wastedValue),
    actualValue: fmtMetric(d.actualValue),
    shareOfSpend: shareOfSpend.toFixed(0),
  }) }));

  // Two halves, two different fixes — one number would hide which lever works.
  out.push(el('p', { class: 'note', text: t('cohort.summary.writeVsCarry', {
    wastedWrite: fmtMetric(d.wastedWrite),
    breakEvenTurn: d.breakEvenTurn.toFixed(0),
    wastedCarry: fmtMetric(d.wastedCarry),
  }) }));

  out.push(el('p', { class: 'note dim', text: t('cohort.summary.prefixNote', {
    breakEvenTurn: d.breakEvenTurn.toFixed(0),
    breakEvenTurnExact: d.breakEvenTurn.toFixed(1),
    prefixRecoverable: fmtMetric(d.prefixRecoverable),
    charsPerToken: d.charsPerToken.toFixed(2),
  }) }));

  const maxRuns = Math.max(1, ...d.sources.map((s) => s.runs));
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('cohort.table.whatCollected') }), el('th', { text: t('common.col.runs') }),
      el('th', { text: t('common.col.size') }), el('th', { text: t('common.col.turn') }),
      el('th', { text: t('common.col.overpay') }), el('th', { text: t('cohort.table.prefixReturns') }))),
    el('tbody', {}, ...d.sources.map((s) => {
      const row = el('tr', { class: 'cohort-row' },
        el('td', { class: 'name' },
          el('span', { class: 'dim', text: s.tool + ' ' }),
          el('span', { text: s.label }),
          // More than one distinct content behind one path means the runs read
          // different windows of it — worth knowing before "just read it once".
          s.variants > 1 ? el('span', { class: 'dim', text: t('cohort.table.variantsSuffix', { n: s.variants }) }) : null),
        el('td', { class: 'num' },
          el('span', { class: 'share', style: `width:${Math.max(2, (60 * s.runs) / maxRuns)}px` }),
          el('span', { text: ' ' + t('cohort.table.runsOfTotal', { runs: s.runs, total: d.activeRuns }) })),
        el('td', { class: 'num', text: fmtTokens(s.tokens) }),
        // Past the break-even the hoist stops paying, so the turn is not decor.
        el('td', { class: 'num' + (s.medianTurn > d.breakEvenTurn ? ' dim' : ''),
          text: String(s.medianTurn) }),
        el('td', { class: 'num accent', text: fmtMetric(s.wasted) }),
        el('td', { class: 'num', text: s.prefixRecoverable > 0 ? fmtMetric(s.prefixRecoverable) : '—' }));
      const members = el('tr', { class: 'cohort-members hidden' },
        el('td', { colspan: '6' },
          el('div', { class: 'dupe-members' },
            ...s.runIds.map((id, i) =>
              el('button', { class: 'chip-btn', text: t('cohort.table.memberChip', { n: i + 1, id: id.slice(0, 8) }),
                onclick: () => openRun(view.sessionId, view.agent, id) })))));
      row.addEventListener('click', () => members.classList.toggle('hidden'));
      return [row, members];
    }).flat())
  );

  out.push(
    el('div', { class: 'sub-head' },
      el('h3', { text: t('cohort.section.duplicatesTitle') }),
      el('span', { class: 'hint', text: t('cohort.section.duplicatesHint') })),
    el('div', { class: 'table-scroll' }, table));

  const per = el('table');
  per.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('common.col.run') }), el('th', { text: t('common.col.start') }), el('th', { text: t('common.col.turns') }),
      el('th', { text: t('cohort.table.collected') }), el('th', { text: t('cohort.table.sharedOfCollected') }), el('th', { text: t('cohort.table.carry') }))),
    el('tbody', {}, ...d.perRun.map((r) =>
      el('tr', { onclick: () => openRun(view.sessionId, view.agent, r.runId) },
        el('td', { class: 'name', text: r.runId.slice(0, 8) }),
        el('td', { text: fmtTime(r.ts) }),
        el('td', { class: 'num', text: String(r.turns) }),
        el('td', { class: 'num', text: fmtTokens(r.collected) }),
        el('td', { class: 'num' },
          el('span', { text: fmtTokens(r.shared) }),
          el('span', { class: 'dim', text: r.collected ? ` · ${Math.round((100 * r.shared) / r.collected)}%` : '' })),
        el('td', { class: 'num', text: fmtMetric(r.value) }))))
  );
  out.push(
    el('div', { class: 'sub-head' },
      el('h3', { text: t('cohort.section.perRunTitle') }),
      el('span', { class: 'hint', text: t('cohort.section.perRunHint') })),
    el('div', { class: 'table-scroll' }, per));

  return out;
}

function buildRunBars(view, runs) {
  const W = 900, H = 170, padL = 50, padR = 12, padT = 12, padB = 22;
  const wrap = el('div', { class: 'tl-wrap' });
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}` });
  wrap.append(svg);
  if (!runs.length) return wrap;

  const max = Math.max(...runs.map((r) => r.value)) || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const step = plotW / runs.length;
  const bw = Math.max(2, Math.min(30, step * 0.7));

  for (let i = 0; i <= 2; i++) {
    const y = padT + plotH - (plotH / 2) * i;
    svg.append(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: y, y2: y }));
    const txt = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    txt.textContent = fmtMetric((max / 2) * i);
    svg.append(txt);
  }

  runs.forEach((r, i) => {
    const h = (r.value / max) * plotH;
    const rect = svgEl('rect', {
      x: padL + i * step + (step - bw) / 2,
      y: padT + plotH - h,
      width: bw,
      height: Math.max(h, 1),
      fill: COLORS[0],
      rx: 1,
    });
    svg.append(rect);
  });

  for (const frac of [0, 1]) {
    const r = runs[Math.round(frac * (runs.length - 1))];
    const txt = svgEl('text', {
      x: padL + (frac === 0 ? 0 : plotW),
      y: H - 6,
      'text-anchor': frac === 0 ? 'start' : 'end',
    });
    txt.textContent = fmtTime(r.firstTs);
    svg.append(txt);
  }

  const picker = chartPicker(svg, {
    padL, padT, plotW, plotH,
    count: () => runs.length,
    xAt: (i) => padL + i * step + step / 2,
    yAt: (i) => padT + plotH - (runs[i].value / max) * plotH,
    idle: t('run.bars.idleHint'),
    describe: (i) => {
      const r = runs[i];
      return [
        el('b', { text: t('run.bars.runLabel', { n: i + 1, total: runs.length }) }),
        el('span', { text: fmtTime(r.firstTs) }),
        el('b', { class: 'accent', text: fmtMetric(r.value) }),
        el('span', { class: 'dim', text:
          t('run.bars.runMeta', { messages: r.messages, duration: fmtDuration(r.durationMs), peakContext: fmtTokens(r.peakContext) }) +
          (r.workflowId ? ` · wf ${r.workflowId.slice(0, 8)}` : '') }),
        el('span', { class: 'dim', text: t('run.bars.clickToOpen') }),
      ];
    },
    onPick: (i) => openRun(view.sessionId, view.agent, runs[i].runId),
  });
  wrap.replaceChildren(picker.readout, svg);
  return wrap;
}

/** One chip per probe that flagged this run, with the hit count when >1. */
function probeBadges(hits) {
  if (!hits?.length) return [];
  return hits.map((h) =>
    el('span', {
      class: 'badge warn',
      // A plain HTML title: `withTooltip` speaks SVG and would be inert here.
      title: t('run.probeBadge.title', { n: h.hits, label: h.label }),
      text: '⚠ ' + h.label + (h.hits > 1 ? ` ×${h.hits}` : ''),
    })
  );
}

function buildRunTable(view, runs, total, flags = {}) {
  // Runs of one agent in one session can come from different workflow runs;
  // the column only appears when that is actually the case.
  const showWorkflow = runs.some((r) => r.workflowId);
  // A probe that flagged a run is shown right where the run is, not only on
  // the probes screen: that is the whole point of attaching hits to runs.
  const showFlags = runs.some((r) => flags[r.runId]?.length);
  const tbl = el('table');
  tbl.append(
    el('thead', {}, el('tr', {},
      showFlags ? el('th', { text: t('run.table.probes') }) : null,
      el('th', { text: t('common.col.start') }), el('th', { text: t('common.col.duration') }), el('th', { text: t('common.col.share') }),
      el('th', { text: t('common.col.spend') }), el('th', { text: t('run.table.peakContext') }), el('th', { text: 'cache read' }),
      el('th', { text: 'output' }), el('th', { text: t('common.col.messages') }), el('th', { text: t('common.col.model') }),
      el('th', { text: 'effort' }),
      showWorkflow ? el('th', { text: 'workflow' }) : null)),
    el('tbody', {}, ...runs.map((r) =>
      el('tr', { onclick: () => openRun(view.sessionId, view.agent, r.runId) },
        showFlags ? el('td', {}, ...probeBadges(flags[r.runId])) : null,
        el('td', { text: fmtTime(r.firstTs) }),
        el('td', { class: 'num', text: fmtDuration(r.durationMs) }),
        el('td', { class: 'num', text: (total ? (100 * r.value) / total : 0).toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmtMetric(r.value) }),
        el('td', { class: 'num', text: fmtTokens(r.peakContext) }),
        el('td', { class: 'num', text: fmtTokens(r.cacheRead) }),
        el('td', { class: 'num', text: fmtTokens(r.output) }),
        el('td', { class: 'num', text: String(r.messages) }),
        el('td', { text: (r.models || '').replaceAll('claude-', '') }),
        el('td', { text: r.effort ?? '' }),
        showWorkflow ? el('td', { text: r.workflowId ?? '—' }) : null)))
  );
  return tbl;
}

// ── level 3: one run — context and history ───────────────────

async function renderRunView(view) {
  const data = await fetch(
    withSource(
      `/api/run?session=${encodeURIComponent(view.sessionId)}&run=${encodeURIComponent(view.runId)}&metric=${state.metric}`
    )
  ).then((r) => r.json());
  if (currentView() !== view) return;

  const run = data.run;
  const steps = data.steps ?? [];
  const turns = steps.filter((s) => s.kind === 'assistant' && s.context != null);

  document.getElementById('drawer-title').textContent = t('run.drawer.title', { agent: view.agent, shortId: view.runId.slice(0, 8) });
  document.getElementById('drawer-sub').textContent = run
    ? [
        fmtTime(run.firstTs),
        fmtDuration(run.durationMs),
        (run.models || '').replaceAll('claude-', ''),
        run.effort ? 'effort ' + run.effort : null,
        run.workflowId,
      ]
        .filter(Boolean)
        .join('  ·  ')
    : '';

  const misses = steps.filter((s) => s.cacheMiss);
  const toolCounts = new Map();
  for (const s of steps) for (const tool of s.tools ?? []) toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);

  document.getElementById('drawer-body').replaceChildren(
    el(
      'div',
      { class: 'kpis' },
      kpiCard(t('run.kpi.spend'), run ? fmtMetric(run.value) : '—'),
      kpiCard(t('run.kpi.turnsCount'), String(turns.length)),
      kpiCard(t('run.kpi.peakContext'), run ? fmtTokens(run.peakContext) : '—',
        turns.length ? t('run.kpi.peakContextSub', { value: fmtTokens(turns[0].context) }) : null),
      kpiCard(t('run.kpi.toolCalls'), String([...toolCounts.values()].reduce((s, v) => s + v, 0)),
        topTools.slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' · ')),
      misses.length
        ? kpiCard(t('run.kpi.cacheRewrite'), '+' + fmtMetric(misses.reduce((s, m) => s + m.cacheMiss.extra, 0)),
            (() => {
              const exp = misses.filter((s) => s.cacheMiss.cause === 'expired').length;
              return [exp ? t('run.kpi.cacheRewriteExpired', { n: exp }) : null,
                      misses.length - exp ? t('run.kpi.cacheRewriteReset', { n: misses.length - exp }) : null]
                .filter(Boolean).join(' · ');
            })())
        : kpiCard('Output', run ? fmtTokens(run.output) : '—')
    ),
    panel(t('run.panel.contextTitle'), t('run.panel.contextHint'),
      buildContextChart(turns)),
    buildComposition(view, turns),
    panel(t('run.panel.historyTitle'), t('run.panel.historyStepsCount', { n: steps.length }), buildHistory(steps, view.focusTs, view))
  );
}

/**
 * "What is in those 391k" — a second pass over the same JSONL, so it is behind
 * a button rather than loaded with the run. Renders in place; the panel is the
 * same node before and after.
 */
function buildComposition(view, turns) {
  // The peak turn is the one worth explaining, and it also picks the window: a
  // long run compacts, and each window is a different context. Computed here
  // rather than inside `load`, because the share link names the same turn the
  // panel would show — an address for the finding, not for a neighbouring one.
  const peak = turns.reduce((a, b) => (b.context > a.context ? b : a), turns[0] ?? { context: 0 });
  const turnNo = Math.max(1, turns.indexOf(peak) + 1);

  const body = el('div', { class: 'compose-idle' },
    el('button', { class: 'ghost', onclick: () => load() , text: t('common.action.expand') }),
    el('span', { class: 'hint', text: t('context.panel.idleHint') }));
  const box = panelWith(
    shareButton(
      () => ({ kind: 'context', params: { session: view.sessionId, run: view.runId, turn: turnNo } }),
      { compact: true, title: t('context.shareTitle') }
    ),
    t('context.panel.title'),
    null,
    body
  );

  const load = async () => {
    // The idle state is a one-line flex row; the result is a stack. Same node,
    // so the class has to change with the content.
    body.className = 'composition';
    body.replaceChildren(el('div', { class: 'empty', text: t('context.loading') }));
    let d;
    try {
      d = await api('/api/context', { session: view.sessionId, run: view.runId, turn: turnNo });
    } catch (e) {
      body.replaceChildren(el('div', { class: 'empty', text: t('common.error.failed', { detail: e }) }));
      return;
    }
    if (currentView() !== view) return;
    body.replaceChildren(...compositionBody(d, view));
  };

  return box;
}

// Named in the language of "who put this here", because that is the actionable
// axis: a returned subagent and a Write of the same document are both text the
// main thread chose to keep, and both can be avoided.
const ORIGIN = {
  subagent: t('context.origin.subagent'),
  write: t('context.origin.write'),
  plan: t('context.origin.plan'),
  thinking: t('context.origin.thinking'),
  dispatch: t('context.origin.dispatch'),
  command: t('context.origin.command'),
  result: t('context.origin.result'),
  reminder: t('context.origin.reminder'),
  answer: t('context.origin.answer'),
  prompt: t('context.origin.prompt'),
};

function compositionBody(d, view) {
  const total = d.finalContext || 1;
  const body = d.byOrigin.reduce((s, o) => s + o.tokens, 0);
  const rest = Math.round(d.finalContext - d.fit.headTokens - body);

  const rows = [
    ...d.byOrigin.map((o) => ({ label: ORIGIN[o.origin] ?? o.origin, n: o.blocks, tokens: o.tokens, origin: o.origin })),
    { label: t('context.rows.systemPrompt'), n: 0, tokens: d.fit.headTokens, head: true },
    // The residual is shown, never spread across the rows: the ratio is fitted
    // and a silent 12% would read as measurement.
    ...(Math.abs(rest) > total * 0.02
      ? [{ label: rest > 0 ? t('context.rows.notRecovered') : t('context.rows.estimateError'), n: 0, tokens: rest, head: true }]
      : []),
  ].sort((a, b) => b.tokens - a.tokens);

  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('common.col.what') }), el('th', { text: t('context.table.blocks') }),
      el('th', { text: t('common.col.tokens') }), el('th', { text: t('common.col.share') }))),
    el('tbody', {}, ...rows.map((r) =>
      el('tr', { class: r.head ? 'muted' : '' },
        el('td', { class: 'name', text: r.label }),
        el('td', { class: 'num', text: r.n ? String(r.n) : '—' }),
        el('td', { class: 'num', text: (r.tokens < 0 ? '−' : '') + fmtTokens(Math.abs(r.tokens)) }),
        el('td', { class: 'num' },
          r.tokens > 0 ? el('span', { class: 'share', style: `width:${Math.max(2, (100 * r.tokens) / total)}px` }) : null,
          el('span', { class: 'dim', text: ' ' + ((100 * Math.abs(r.tokens)) / total).toFixed(1) + '%' })))))
  );

  const seg = d.segments.length > 1
    ? t('context.segment.multi', { from: d.segment.fromTurn, to: d.segment.toTurn, total: d.segments.length })
    : t('context.segment.single', { from: d.segment.fromTurn, to: d.segment.toTurn });

  const out = [
    el('p', { class: 'note', text: t('context.note.summary', {
      seg,
      finalContext: fmtTokens(d.finalContext),
      charsPerToken: d.fit.charsPerToken.toFixed(2),
      points: d.fit.points,
      errorSign: d.fit.errorPct >= 0 ? '+' : '',
      errorPct: d.fit.errorPct.toFixed(1),
    }) }),
    el('div', { class: 'table-scroll' }, table),
  ];

  if (d.dupes.length) {
    const list = el('div', { class: 'dupes' });
    for (const g of d.dupes.slice(0, 6)) {
      list.append(el('div', { class: 'dupe' },
        el('div', { class: 'dupe-head' },
          el('b', { class: 'accent', text: `×${g.copies}` }),
          el('span', { text: t('context.dupe.headSummary', { tokens: fmtTokens(g.tokens), wasted: fmtTokens(g.wastedTokens) }) })),
        el('div', { class: 'dupe-members' },
          ...g.members.map((m) =>
            el('button', { class: 'chip-btn', onclick: () => focusHistoryTurn(m.turn),
              text: t('context.dupe.memberChip', { turn: t('common.turn', { n: m.turn }), label: m.label, tokens: fmtTokens(m.tokens) }) }))),
        el('pre', { class: 'body dim', text: g.preview })));
    }
    out.push(
      el('div', { class: 'sub-head' },
        el('h3', { text: t('context.section.dupesTitle') }),
        el('span', { class: 'hint', text: t('context.section.dupesHint', { tokens: fmtTokens(d.dupeTokens), pct: ((100 * d.dupeTokens) / total).toFixed(1) }) })),
      list);
  }

  const top = el('table');
  top.append(
    el('thead', {}, el('tr', {},
      el('th', { text: t('common.col.turn') }), el('th', { text: t('common.col.tokens') }),
      el('th', { text: t('common.col.what') }), el('th', { text: t('context.table.preview') }))),
    el('tbody', {}, ...d.top.map((b) =>
      el('tr', { onclick: () => focusHistoryTurn(b.turn) },
        el('td', { class: 'num', text: String(b.turn) }),
        el('td', { class: 'num accent', text: fmtTokens(b.tokens) }),
        el('td', { text: `${ORIGIN[b.origin] ?? b.origin} · ${b.label}` }),
        el('td', { class: 'name dim', text: b.preview }))))
  );
  out.push(
    el('div', { class: 'sub-head' },
      el('h3', { text: t('context.section.topBlocksTitle') }),
      el('span', { class: 'hint', text: t('context.section.topBlocksHint') })),
    el('div', { class: 'table-scroll' }, top));

  return out;
}

/**
 * The context chart is the point of this level: an agent run gets expensive
 * because the context it re-sends grows every turn, and the shape of that
 * growth (steady climb vs a step after one huge tool result) is the diagnosis.
 * Cache-read and cache-write are stacked separately — a turn that re-writes
 * cache instead of reading it costs an order of magnitude more per token.
 */
function buildContextChart(turns) {
  const W = 900, H = 250, padL = 56, padR = 46, padT = 14, padB = 24;
  const wrap = el('div', { class: 'tl-wrap' });
  if (!turns.length) {
    return el('div', { class: 'tl-wrap' }, el('div', { class: 'empty', text: t('run.contextChart.noBillableTurns') }));
  }

  const LAYERS = [
    { key: 'cacheRead', color: '#5b8ff9', label: 'cache read' },
    { key: 'cacheWrite', color: '#f6bd16', label: 'cache write' },
    { key: 'input', color: '#61ddaa', label: 'input' },
  ];
  const PRICE = { key: 'price', color: '#d97757', label: t('common.col.turnPrice') };

  // Clicking a legend entry isolates that series. The vertical scale then
  // follows it alone, which is the whole point: a 5k input band is invisible
  // next to a 175k cache read until you look at it on its own.
  let only = null;

  const draw = () => {
    const svg = svgEl('svg', { class: 'chart tall', viewBox: `0 0 ${W} ${H}` });
    const areas = only == null ? LAYERS : LAYERS.filter((l) => l.key === only);
    const showPrice = only == null || only === PRICE.key;

    const plotW = W - padL - padR, plotH = H - padT - padB;
    const step = plotW / Math.max(turns.length, 1);
    const xOf = (i) => padL + i * step + step / 2;

    const stackAt = (i) => areas.reduce((sum, l) => sum + (turns[i][l.key] ?? 0), 0);
    const maxCtx = Math.max(1, ...turns.map((_, i) => stackAt(i)));
    const maxVal = Math.max(...turns.map((s) => s.value ?? 0)) || 1;
    const yOf = (v) => padT + plotH - (v / maxCtx) * plotH;

    for (let i = 0; i <= 3; i++) {
      const y = padT + plotH - (plotH / 3) * i;
      svg.append(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: y, y2: y }));
      if (areas.length) {
        const txt = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
        txt.textContent = fmtTokens((maxCtx / 3) * i);
        svg.append(txt);
      }
      if (showPrice) {
        const t2 = svgEl('text', { x: W - padR + 6, y: y + 3, 'text-anchor': 'start', class: 'right-axis' });
        t2.textContent = fmtMetric((maxVal / 3) * i);
        svg.append(t2);
      }
    }

    // Stacked area: cache read at the bottom (cheap), fresh input on top.
    const base = turns.map(() => 0);
    for (const layer of areas) {
      const upper = turns.map((s, i) => base[i] + (s[layer.key] ?? 0));
      const top = upper.map((v, i) => `${xOf(i)},${yOf(v)}`);
      const bottom = base.map((v, i) => `${xOf(i)},${yOf(v)}`).reverse();
      svg.append(svgEl('polygon', { points: [...top, ...bottom].join(' '), fill: layer.color, opacity: 0.5 }));
      for (let i = 0; i < turns.length; i++) base[i] = upper[i];
    }

    if (showPrice) {
      turns.forEach((s, i) => {
        const h = ((s.value ?? 0) / maxVal) * plotH;
        svg.append(svgEl('rect', {
          x: xOf(i) - 1.5, y: padT + plotH - h,
          width: 3, height: Math.max(h, 0.5), fill: PRICE.color, opacity: 0.9,
        }));
      });
    }

    // A spike you cannot explain from the shape alone gets a marker.
    turns.forEach((s, i) => {
      if (!s.cacheMiss) return;
      const dot = svgEl('circle', { cx: xOf(i), cy: padT + 4, r: 3, fill: '#f85149' });
      withTooltip(dot,
        missCauseLong(s.cacheMiss) + ' — ' +
        t('run.contextChart.missTooltip', { tokens: fmtTokens(s.cacheMiss.tokens), extra: fmtMetric(s.cacheMiss.extra) }));
      svg.append(dot);
    });

    const legend = svgEl('g');
    [...LAYERS, PRICE].forEach((l, i) => {
      const g = svgEl('g', { class: 'tl-legend-item' });
      g.append(
        svgEl('rect', { x: padL + i * 110, y: 1, width: 8, height: 8, fill: l.color, rx: 2 }),
        svgEl('rect', { x: padL + i * 110 - 3, y: -1, width: 108, height: 12, fill: 'transparent' })
      );
      const txt = svgEl('text', { x: padL + 12 + i * 110, y: 9, opacity: only && only !== l.key ? 0.35 : 1 });
      txt.textContent = l.label;
      g.append(txt);
      withTooltip(g, only === l.key ? t('run.contextChart.legendRemoveFilter', { label: l.label }) : t('run.contextChart.legendOnlyThis', { label: l.label }));
      g.addEventListener('click', () => { only = only === l.key ? null : l.key; draw(); });
      legend.append(g);
    });
    svg.append(legend);

    const first = svgEl('text', { x: padL, y: H - 6 });
    first.textContent = t('common.turn', { n: 1 });
    const last = svgEl('text', { x: W - padR, y: H - 6, 'text-anchor': 'end' });
    last.textContent = t('common.turn', { n: turns.length });
    svg.append(first, last);

    const picker = chartPicker(svg, {
      padL, padT, plotW, plotH,
      count: () => turns.length,
      xAt: xOf,
      yAt: (i) => (areas.length ? yOf(stackAt(i)) : padT + plotH - ((turns[i].value ?? 0) / maxVal) * plotH),
      colorAt: (i) => (turns[i].cacheMiss ? '#f85149' : PRICE.color),
      idle: only
        ? t('run.contextChart.filterActive', { label: [...LAYERS, PRICE].find((l) => l.key === only).label })
        : t('run.contextChart.idleHint'),
      describe: (i) => {
        const s = turns[i];
        return [
          el('b', { text: t('common.turn', { n: i + 1 }) }),
          el('span', { text: fmtTime(s.ts) }),
          el('span', { class: 'dim', text: t('run.contextChart.contextValue', { value: fmtTokens(s.context) }) }),
          el('b', { class: 'accent', text: fmtMetric(s.value ?? 0) }),
          el('span', { class: 'dim', text:
            t('run.contextChart.breakdown', {
              read: fmtTokens(s.cacheRead ?? 0), write: fmtTokens(s.cacheWrite ?? 0),
              input: fmtTokens(s.input ?? 0), output: fmtTokens(s.output ?? 0),
            }) }),
          s.cacheMiss
            ? el('span', { class: 'warn-inline', text: missCauseShort(s.cacheMiss) })
            : el('span', { class: 'dim', text: t('run.contextChart.clickToStep') }),
        ];
      },
      // The chart and the history are two views of one list: picking a turn
      // scrolls the history to it instead of opening anything new.
      onPick: (i) => focusHistoryTurn(i + 1),
    });
    wrap.replaceChildren(picker.readout, svg);
  };

  draw();
  return wrap;
}

/** Scroll the run history to one turn and mark it — driven by the chart above. */
function focusHistoryTurn(n) {
  const body = document.getElementById('drawer-body');
  const node = body.querySelector(`.step[data-turn="${n}"]`);
  if (!node) return;
  for (const old of body.querySelectorAll('.step.focus')) old.classList.remove('focus');
  node.classList.add('focus');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * A message body that unfolds.
 *
 * Two things cut a message down, and the fold undoes both: the server ships a
 * 600-char stub for anything longer (`truncated`), and the box itself is
 * height-capped so one pasted log cannot push the rest of the run off screen.
 * The rest of the text is fetched once, for the one step that was opened —
 * `index` is the step's position in the list the server just sent, and the
 * server walks the same file the same way to resolve it.
 *
 * The button only appears where something is actually hidden: `truncated` is
 * known up front, an overflowing box is measured after the history is on the
 * page.
 */
function buildBody(step, index, ctx) {
  if (!step.text) return null;
  const pre = el('pre', { class: 'body', text: step.text });
  const wrap = el('div', { class: 'body-wrap' }, pre);
  const chars = step.chars ? ' — ' + t('units.chars', { v: fmtTokens(step.chars) }) : '';
  const more = el('button', { class: 'ghost tiny fold' });
  let open = false;
  let whole = !step.truncated;
  let busy = false;

  const label = () => (more.textContent = open ? t('run.history.collapseLabel') + ' ▴' : t('run.history.expandLabel') + (whole ? '' : chars) + ' ▾');

  more.onclick = async () => {
    if (busy) return;
    if (!open && !whole) {
      busy = true;
      more.textContent = t('run.history.readingMore');
      try {
        const r = await api('/api/step', { session: ctx.sessionId, run: ctx.runId, index });
        if (typeof r?.text !== 'string') throw new Error(r?.error ?? t('run.history.noTextError'));
        pre.textContent = r.text;
        whole = true;
      } catch {
        busy = false;
        more.textContent = t('run.history.readFailed');
        return;
      }
      busy = false;
    }
    open = !open;
    wrap.classList.toggle('open', open);
    label();
  };

  const offerFold = () => {
    more.hidden = false;
    wrap.classList.add('clipped');
  };
  label();
  more.hidden = true;
  if (step.truncated) offerFold();
  // Detached at build time — the overflow check needs the real layout.
  else requestAnimationFrame(() => { if (pre.scrollHeight > pre.clientHeight + 4) offerFold(); });
  wrap.append(more);
  return wrap;
}

/**
 * One tool call: what it ran, and what tells it apart from the call above it.
 *
 * The chip is one line — a run makes twenty calls a turn and twenty unfolded
 * shell scripts is not a log. Clicking it drops the clipping, so a long
 * command or a heredoc is read where it was made instead of somewhere else.
 * `targetChars` is what the server had before its own cap: when the argument
 * was longer than the chip could ever carry, the chip says by how much rather
 * than ending in a silent ellipsis.
 */
function toolChip(tool) {
  const shown = tool.target?.length ?? 0;
  const cut = (tool.targetChars ?? 0) > shown;
  const chip = el('button', { class: 'tool', type: 'button', title: t('run.history.toolExpand') },
    el('b', { text: tool.name }),
    tool.target ? el('span', { class: 'tool-target', text: ' ' + tool.target }) : null,
    cut ? el('span', { class: 'tool-cut', text: ' ' + t('run.history.toolCut', { v: t('units.chars', { v: fmtTokens(tool.targetChars) }) }) }) : null,
    tool.detail ? el('span', { class: 'tool-detail', text: ' · ' + tool.detail }) : null);
  chip.onclick = () => chip.classList.toggle('open');
  return chip;
}

/**
 * `focusTs` comes from a click on the session timeline: the run opens scrolled
 * to the very message that bar represented, not to the top.
 */
function buildHistory(steps, focusTs, ctx) {
  const box = el('div', { class: 'history' });
  const nodes = [];
  const add = (ts, node) => { nodes.push([ts, node]); box.append(node); };
  let turn = 0;
  for (const [i, s] of steps.entries()) {
    if (s.kind === 'prompt') {
      add(s.ts,
        el('div', { class: 'step prompt' },
          el('div', { class: 'step-head' },
            el('span', { class: 'tag' , text: t('run.history.tag.prompt') }),
            el('span', { class: 'when', text: fmtTime(s.ts) }),
            el('span', { class: 'meta', text: t('units.chars', { v: fmtTokens(s.chars ?? 0) }) })),
          buildBody(s, i, ctx))
      );
    } else if (s.kind === 'tool_result') {
      // Which call this answers is resolved by id, not by proximity: parallel
      // calls come back out of order, and a bare «результат» next to four
      // identical-looking reads says nothing about which one landed.
      add(s.ts,
        el('div', { class: 'step result' + (s.isError ? ' err' : '') },
          el('span', { class: 'tag', text: s.isError ? t('run.history.tag.error') : t('run.history.tag.result') }),
          s.toolName
            ? el('span', { class: 'tool-of' },
                el('b', { text: s.toolName }),
                s.toolTarget ? el('span', { text: ' ' + s.toolTarget }) : null)
            : null,
          s.resultNote ? el('span', { class: 'meta', text: s.resultNote }) : null,
          el('span', { class: 'meta', text: t('units.chars', { v: fmtTokens(s.chars ?? 0) }) }))
      );
    } else {
      turn++;
      add(s.ts,
        el('div', { class: 'step assistant', 'data-turn': String(turn) },
          el('div', { class: 'step-head' },
            el('span', { class: 'tag accent', text: t('common.turn', { n: turn }) }),
            el('span', { class: 'when', text: fmtTime(s.ts) }),
            // The price of a turn is never self-evident from the context size
            // alone — the same 175k costs 12.5x more written than read, so the
            // split is spelled out next to it instead of hidden in a tooltip.
            s.context != null
              ? el('span', { class: 'meta', text:
                  t('run.history.turnContext.base', { context: fmtTokens(s.context), read: fmtTokens(s.cacheRead ?? 0), write: fmtTokens(s.cacheWrite ?? 0) }) +
                  ((s.input ?? 0) > 1 ? t('run.history.turnContext.inputPart', { input: fmtTokens(s.input) }) : '') +
                  t('run.history.turnContext.outputPart', { output: fmtTokens(s.output ?? 0) }) })
              : null,
            s.value != null ? el('span', { class: 'meta price', text: fmtMetric(s.value) }) : null,
            s.thinkingChars
              ? el('span', { class: 'meta', text: t('run.history.thinking', { chars: t('units.chars', { v: fmtTokens(s.thinkingChars) }) }) })
              : null),
          s.cacheMiss
            ? el('div', { class: 'warn-chip', title: missCauseHint(s.cacheMiss) },
                missCauseLong(s.cacheMiss) + ' — ' +
                t('run.history.cacheMissDetail', { tokens: fmtTokens(s.cacheMiss.tokens), extra: fmtMetric(s.cacheMiss.extra) }))
            : null,
          buildBody(s, i, ctx),
          s.tools?.length
            ? el('div', { class: 'tools' }, ...s.tools.map(toolChip))
            : null)
      );
    }
  }
  if (!steps.length) box.append(el('div', { class: 'empty', text: t('run.history.empty') }));

  if (focusTs && nodes.length) {
    const [, node] = nodes.reduce((best, cur) =>
      Math.abs(cur[0] - focusTs) < Math.abs(best[0] - focusTs) ? cur : best);
    node.classList.add('focus');
    // The box is still detached here — scroll once it is on the page.
    requestAnimationFrame(() => node.scrollIntoView({ block: 'center' }));
  }
  return box;
}


/**
 * Per-message bars on a real time axis plus a cumulative line. The bars are
 * positioned by timestamp, not by index, so idle gaps stay visible — a wall of
 * bars packed into ten minutes reads very differently from the same spend
 * spread over an afternoon.
 *
 * Interaction is the point here: drag to zoom into a window, click a bar to
 * open the run that produced it, click a legend entry to isolate one agent.
 * All of it is driven by one transparent capture rect over the plot rather
 * than by per-bar handlers — a long session has thousands of bars.
 */
function buildTimeline(points, opts = {}) {
  const W = 900, H = 240, padL = 50, padR = 12, padT = 12, padB = 24;
  const wrap = el('div', { class: 'tl-wrap' });
  const svg = svgEl('svg', { id: 'timeline', viewBox: `0 0 ${W} ${H}` });
  // The readout is created by the picker below; until then the chart is bare.
  wrap.append(svg);
  if (!points.length) {
    return el('div', { class: 'tl-wrap' }, el('div', { class: 'empty', text: t('session.timeline.emptyWindow') }));
  }

  const t0 = points[0].ts;
  const t1 = Math.max(points[points.length - 1].ts, t0 + 1);
  const maxVal = Math.max(...points.map((p) => p.value)) || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Colours come from the session-wide agent order, not from what happens to
  // be in the window — otherwise every zoom recolours the chart.
  const present = [...new Set(points.map((p) => p.agent))];
  const order = opts.order?.length ? opts.order : present;
  const agents = present.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const colorOf = (a) => (a === MAIN_AGENT ? '#8b98a8' : COLORS[order.indexOf(a) % COLORS.length]);
  const dimmed = (p) => opts.only && p.agent !== opts.only;
  /** Isolation dims the other agents but keeps them drawn; these are the live ones. */
  const focus = opts.only ? points.filter((p) => !dimmed(p)) : points;

  for (let i = 0; i <= 2; i++) {
    const y = padT + plotH - (plotH / 2) * i;
    svg.append(svgEl('line', { class: 'axis', x1: padL, x2: W - padR, y1: y, y2: y }));
    const txt = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    txt.textContent = fmtMetric((maxVal / 2) * i);
    svg.append(txt);
  }

  const x = (ts) => padL + ((ts - t0) / (t1 - t0)) * plotW;
  const tsAt = (px) => t0 + ((px - padL) / plotW) * (t1 - t0);
  // Bars widen as you zoom in: at 2000 messages they are hairlines, at 20 they
  // should still look like bars.
  const bw = Math.max(1.6, Math.min(9, (plotW / points.length) * 0.8));
  const yTop = (p) => padT + plotH - (p.value / maxVal) * plotH;

  for (const p of points) {
    svg.append(svgEl('rect', {
      x: x(p.ts) - bw / 2,
      y: yTop(p),
      width: bw,
      height: Math.max((p.value / maxVal) * plotH, 0.6),
      fill: colorOf(p.agent),
      opacity: dimmed(p) ? 0.12 : 1,
      rx: 0.8,
    }));
  }

  // The cumulative line is recomputed over the visible slice, so a zoomed
  // window shows what accumulated *in that window*, not the session offset —
  // and when one agent is isolated, it follows that agent alone.
  let acc = 0;
  const cumTotal = focus.reduce((s, p) => s + p.value, 0) || 1;
  const line = focus
    .map((p) => `${x(p.ts)},${padT + plotH - ((acc += p.value) / cumTotal) * plotH}`)
    .join(' ');
  svg.append(svgEl('polyline', {
    points: line, fill: 'none', stroke: '#d97757', 'stroke-width': 1.4, opacity: 0.85,
  }));

  for (const frac of [0, 0.5, 1]) {
    const ts = t0 + (t1 - t0) * frac;
    const txt = svgEl('text', {
      x: x(ts), y: H - 8,
      'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle',
    });
    txt.textContent = fmtTime(ts);
    svg.append(txt);
  }

  // ── interaction layer ──────────────────────────────────────
  let dragFrom = null;
  const brush = svgEl('rect', { class: 'tl-brush', y: padT, height: plotH, width: 0, visibility: 'hidden' });
  svg.append(brush);

  const picker = chartPicker(svg, {
    padL, padT, plotW, plotH,
    count: () => focus.length,
    xAt: (i) => x(focus[i].ts),
    yAt: (i) => yTop(focus[i]),
    colorAt: (i) => colorOf(focus[i].agent),
    idle: t('session.timeline.idleHint'),
    suspended: () => dragFrom != null,
    describe: (i) => {
      const p = focus[i];
      return [
        el('b', { text: fmtTime(p.ts) }),
        el('span', { class: 'sw', style: `background:${colorOf(p.agent)}` }),
        el('span', { text: p.agent }),
        el('span', { class: 'dim', text: (p.model ?? '').replace('claude-', '') }),
        el('b', { class: 'accent', text: fmtMetric(p.value) }),
        el('span', { class: 'dim', text:
          `output ${fmtTokens(p.output)} · cache read ${fmtTokens(p.cacheRead)} · cache write ${fmtTokens(p.cacheWrite)}` }),
        el('span', { class: 'dim', text: t('session.timeline.clickRun') }),
      ];
    },
  });
  wrap.replaceChildren(picker.readout, svg);

  const { capture, svgXOf, nearest } = picker;

  capture.addEventListener('mousemove', (e) => {
    if (dragFrom == null) return;
    const px = svgXOf(e);
    brush.setAttribute('visibility', 'visible');
    brush.setAttribute('x', Math.min(dragFrom, px));
    brush.setAttribute('width', Math.abs(px - dragFrom));
    const [a, b] = [tsAt(Math.min(dragFrom, px)), tsAt(Math.max(dragFrom, px))];
    const n = points.filter((p) => p.ts >= a && p.ts <= b);
    picker.readout.replaceChildren(
      el('b', { text: fmtDuration(b - a) }),
      el('span', { text: t('session.timeline.dragMessages', { n: n.length }) }),
      el('b', { class: 'accent', text: fmtMetric(n.reduce((s, p) => s + p.value, 0)) }),
      el('span', { class: 'dim', text: t('session.timeline.releaseToZoom') })
    );
  });

  // The drag finishes on `window`, not on the chart: releasing the button
  // anywhere must end the brush, otherwise it sticks to the cursor.
  capture.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragFrom = svgXOf(e);
    window.addEventListener('mouseup', finishDrag, { once: true });
  });

  function finishDrag(e) {
    const px = svgXOf(e);
    const from = dragFrom;
    dragFrom = null;
    brush.setAttribute('visibility', 'hidden');
    brush.setAttribute('width', 0);
    if (from == null) return;
    // Under ~6 SVG units of travel this was a click, not a drag.
    if (Math.abs(px - from) < 6) {
      const i = nearest(px);
      if (i >= 0 && opts.onPick) opts.onPick(focus[i]);
      return;
    }
    if (opts.onZoom) opts.onZoom(tsAt(Math.min(from, px)), tsAt(Math.max(from, px)));
  }

  // No double-click-to-reset: the first click of the pair already opens a run.
  // Resetting the window is the button in the panel head.

  const legend = svgEl('g');
  agents.slice(0, 6).forEach((a, i) => {
    const g = svgEl('g', { class: 'tl-legend-item' });
    g.append(
      svgEl('rect', { x: padL + i * 130, y: 2, width: 8, height: 8, fill: colorOf(a), rx: 2 }),
      svgEl('rect', { x: padL + i * 130 - 3, y: 0, width: 128, height: 12, fill: 'transparent' })
    );
    const txt = svgEl('text', {
      x: padL + 18 + i * 130, y: 10,
      opacity: opts.only && opts.only !== a ? 0.4 : 1,
    });
    txt.textContent = a.length > 18 ? a.slice(0, 18) + '…' : a;
    g.append(txt);
    withTooltip(g, opts.only === a ? t('session.timeline.legendRemoveFilter', { agent: a }) : t('session.timeline.legendIsolate', { agent: a }));
    g.addEventListener('click', () => opts.onIsolate?.(a));
    legend.append(g);
  });
  svg.append(legend);
  return wrap;
}

function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  nav.length = 0;
  state.session = null;
  syncHash();
}

// ── refresh ──────────────────────────────────────────────────

/**
 * The shared frame around a screen module: fetch what the toolbar needs, hand
 * the module its box, and keep the URL in step. `dims=none` asks the overview
 * for nothing but the span and the active days.
 */
async function renderScreen(render, boxId) {
  const box = document.getElementById(boxId);
  const meta = await api('/api/overview', { dims: 'none' });
  renderToolbar(meta.activeDays);
  syncHash();
  await render(box);
}

async function refresh() {
  renderChips();
  for (const v of VIEWS) document.getElementById(v.id + '-view').hidden = state.view !== v.id;
  // Each screen owns its box and its own fetching; the toolbar is shared, so
  // whoever renders has to render it too.
  if (state.view === 'cache') return renderScreen(renderCache, 'cache-view');
  if (state.view === 'diag') return renderScreen(renderDiag, 'diag-view');
  if (state.view === 'probes') return renderScreen(renderProbes, 'probes-view');

  const [overview, seriesData, sessions] = await Promise.all([
    api('/api/overview', { dims: state.dim }),
    api('/api/series', { dim: state.dim, bucket: state.mode === 'day' ? 'hour' : 'day' }),
    api('/api/sessions', { limit: 60 }),
  ]);
  renderToolbar(overview.activeDays);
  const buckets = overview[state.dim] ?? [];
  renderKpis(overview.total, overview.span);
  renderDonut(buckets, overview.total);
  renderBars(seriesData);
  renderBreakdown(buckets, overview.total);
  renderSessions(sessions.sessions, overview.total);
  syncHash();
}

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-back').addEventListener('click', popView);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeDrawer();
  // Backspace steps back up the stack, but never while typing in the date field.
  if (e.key === 'Backspace' && nav.length > 1 && e.target === document.body) {
    e.preventDefault();
    popView();
  }
});
// ── indexing ─────────────────────────────────────────────────
//
// The index runs on server start and on this button; both are the same job on
// the server, so the button reports the startup pass too instead of pretending
// nothing is happening. Fire-and-poll: a cold index takes minutes.

const REINDEX_LABEL = t('toolbar.reindex');
const reindexBtn = document.getElementById('reindex');
let indexWatcher = null;

function showIndexState(s) {
  if (s.running) {
    reindexBtn.disabled = true;
    reindexBtn.title = t('toolbar.index.runningTitle');
    const p = s.progress;
    reindexBtn.textContent = p && p.total ? t('toolbar.index.progress', { scanned: p.scanned, total: p.total }) : t('toolbar.index.running');
    return;
  }
  reindexBtn.disabled = false;
  if (s.error) {
    reindexBtn.textContent = t('toolbar.index.error');
    reindexBtn.title = s.error;
    return;
  }
  const l = s.last;
  reindexBtn.textContent = !l
    ? REINDEX_LABEL
    : l.filesChanged
      ? t('toolbar.index.changed', { files: l.filesChanged, messages: l.messages })
      : t('toolbar.index.upToDate');
  reindexBtn.title = l ? t('toolbar.index.lastRunTitle', { seconds: (l.elapsedMs / 1000).toFixed(1), files: l.filesSeen }) : '';
  // The outcome is worth a glance, not a permanent label.
  if (l) setTimeout(() => { if (!reindexBtn.disabled) reindexBtn.textContent = REINDEX_LABEL; }, 5000);
}

/** Polls until the run finishes, then reloads the dashboard off the new data. */
function watchIndex() {
  if (indexWatcher) return indexWatcher;
  indexWatcher = (async () => {
    try {
      for (;;) {
        const s = await fetch(withSource('/api/index-status')).then((r) => r.json());
        showIndexState(s);
        if (!s.running) {
          if (!s.error) await refresh();
          return s;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err) {
      reindexBtn.disabled = false;
      reindexBtn.textContent = t('toolbar.index.serverDown');
      reindexBtn.title = String(err);
    } finally {
      indexWatcher = null;
    }
  })();
  return indexWatcher;
}

reindexBtn.addEventListener('click', async () => {
  reindexBtn.disabled = true;
  reindexBtn.textContent = t('toolbar.index.running');
  try {
    const res = await fetch(withSource('/api/reindex'), { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    reindexBtn.disabled = false;
    reindexBtn.textContent = t('toolbar.index.error');
    reindexBtn.title = String(err);
    return;
  }
  watchIndex();
});

// ── sources ──────────────────────────────────────────────────
//
// Two Claude installations (two subscriptions, e.g. `~/.claude` and
// `~/.claude-personal`) are two independent indexes on the server. The picker
// only decides which one every request is aimed at — nothing is ever summed
// across them, because they are different money.
//
// Switching therefore drops the filters and the drawer stack: a project or
// session id from one installation means nothing in the other.

const ADD_OPTION = '__add__';
const sourceSelect = document.getElementById('source-select');
const sourceRemoveBtn = document.getElementById('source-remove');
let sources = [];
let sourcesMutable = true;

async function loadSources() {
  try {
    const d = await fetch('/api/sources').then((r) => r.json());
    sources = d.sources ?? [];
    sourcesMutable = d.mutable !== false;
  } catch {
    sources = [];
  }
  // A remembered source can be gone (removed here, or the server pinned to
  // one `--root`); fall back to the first one the server offers.
  if (sources.length && !sources.some((s) => s.id === state.source)) {
    state.source = sources[0].id;
    localStorage.setItem('bl:source', state.source);
  }
  renderSources();
}

function renderSources() {
  sourceSelect.replaceChildren(
    ...sources.map((s) => el('option', { value: s.id, text: s.label, title: s.root })),
    sourcesMutable ? el('option', { value: ADD_OPTION, text: t('sources.addOption') }) : null
  );
  if (state.source) sourceSelect.value = state.source;
  const cur = sources.find((s) => s.id === state.source);
  sourceRemoveBtn.hidden = !sourcesMutable || !cur || cur.builtin;
  sourceSelect.title = cur ? cur.root : '';
  // One fixed source and no way to add another — the picker is noise.
  document.getElementById('sourcepick').hidden = !sourcesMutable && sources.length < 2;
}

function switchSource(id) {
  if (!id || id === state.source) return;
  state.source = id;
  localStorage.setItem('bl:source', id);
  state.filters = {};
  state.session = null;
  nav.length = 0;
  document.getElementById('drawer').hidden = true;
  renderSources();
  refresh();
  // The new source may still be indexing (freshly added, or a startup pass) —
  // show that progress instead of a silently empty dashboard.
  fetch(withSource('/api/index-status'))
    .then((r) => r.json())
    .then((s) => { showIndexState(s); if (s.running) watchIndex(); })
    .catch(() => {});
}

async function addSourceFlow() {
  const input = prompt(t('sources.prompt.path'));
  if (!input) return;
  sourceSelect.disabled = true;
  try {
    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: input }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    sources = d.sources;
    renderSources();
    switchSource(d.source.id);
  } catch (err) {
    alert(t('sources.error.addFailed', { detail: err.message ?? err }));
  } finally {
    sourceSelect.disabled = false;
  }
}

async function removeSourceFlow() {
  const cur = sources.find((s) => s.id === state.source);
  if (!cur || cur.builtin) return;
  if (!confirm(t('sources.confirm.remove', { label: cur.label }))) return;
  try {
    const res = await fetch(`/api/sources?id=${encodeURIComponent(cur.id)}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    sources = d.sources;
    const next = sources[0]?.id ?? null;
    state.source = null; // force `switchSource` to actually switch
    switchSource(next);
    renderSources();
  } catch (err) {
    alert(t('sources.error.removeFailed', { detail: err.message ?? err }));
  }
}

sourceSelect.addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === ADD_OPTION) {
    e.target.value = state.source ?? '';
    return void addSourceFlow();
  }
  switchSource(v);
});
sourceRemoveBtn.addEventListener('click', () => void removeSourceFlow());

const localeSelect = document.getElementById('locale-select');
localeSelect.replaceChildren(...locales.map((loc) => el('option', { value: loc, text: loc.toUpperCase() })));
localeSelect.value = locale;
localeSelect.addEventListener('change', (e) => {
  localStorage.setItem('bl:locale', e.target.value);
  location.reload();
});

// ── init ─────────────────────────────────────────────────────

applyStatic();

// The hash restores the whole drawer stack, not just the session:
// `#day=…&session=…&tab=…&agent=…&run=…`.
const initial = new URLSearchParams(location.hash.slice(1));
if (VIEWS.some((v) => v.id === initial.get('view'))) state.view = initial.get('view');
if (/^\d{4}-\d{2}-\d{2}$/.test(initial.get('day') ?? '')) {
  state.mode = 'day';
  state.day = initial.get('day');
}

// Sources first: every request below carries the selected one.
await loadSources();

// A page opened while the startup index is still running picks up its progress
// and reloads itself when it lands.
fetch(withSource('/api/index-status'))
  .then((r) => r.json())
  .then((s) => { if (s.running) watchIndex(); })
  .catch(() => {});

refresh().then(() => {
  const sessionId = initial.get('session');
  if (!sessionId) return;
  const agent = initial.get('agent');
  const runId = initial.get('run');
  nav.push({ kind: 'session', sessionId, tab: ['diag', 'cache'].includes(initial.get('tab')) ? initial.get('tab') : 'overview' });
  if (agent) nav.push({ kind: 'agent', sessionId, agent });
  if (agent && runId) nav.push({ kind: 'run', sessionId, agent, runId });
  renderDrawer();
});
