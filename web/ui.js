/**
 * Shared UI kit: the state every screen reads, the formatters every table
 * uses, the DOM/SVG helpers, and the share button.
 *
 * It exists because the dashboard is no longer one screen. Spend, cache,
 * diagnostics and probes are separate modules that must look and behave the
 * same — same colours, same money formatting, same "click a row to drill in".
 * Anything two screens need lives here; anything one screen needs stays with
 * that screen.
 *
 * No user-visible string is written here. Everything a person reads comes from
 * `t()` against `locales/<locale>.json`; the formatters below take their
 * locale from the same place, so there is no `'ru-RU'` left in the dashboard.
 */

import { fmt, t } from './i18n.js';

export { fmt, t };

export const PERIODS = [
  { id: '7d', label: t('toolbar.periodDays', { n: 7 }), days: 7 },
  { id: '30d', label: t('toolbar.periodDays', { n: 30 }), days: 30 },
  { id: '90d', label: t('toolbar.periodDays', { n: 90 }), days: 90 },
  { id: 'all', label: t('common.all'), days: null },
];

export const COLORS = [
  '#d97757', '#5b8ff9', '#61ddaa', '#f6bd16', '#7262fd',
  '#78d3f8', '#9661bc', '#f6903d', '#008685', '#f08bb4',
];

/** Must match `MAIN_AGENT` in src/parse.ts — the main thread's agent key. */
export const MAIN_AGENT = '(main thread)';

export const state = {
  // Which screen: spend breakdown or the cache-waste report. Both read the
  // same period, metric and filters from the toolbar.
  view: 'spend',
  // 'range' — one of the presets above; 'day' — a single calendar day, which
  // also switches the time chart to hourly buckets.
  mode: 'range',
  period: '30d',
  day: null,
  metric: 'usd',
  dim: 'project',
  filters: {},
  session: null,
  // Which Claude installation (subscription) we are looking at. Server-side
  // each one is a separate index; `null` means "whatever the server lists
  // first". Remembered across reloads — it is a workspace, not a filter.
  source: localStorage.getItem('bl:source') || null,
};

// ── formatting ───────────────────────────────────────────────

export const fmtTokens = (v) =>
  v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
  : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
  : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k'
  : String(Math.round(v));

export const fmtUsd = (v) => (v >= 100 ? '$' + fmt.n(Math.round(v)) : '$' + v.toFixed(2));

export function fmtMetric(v, metric = state.metric) {
  return metric === 'usd' ? fmtUsd(v) : fmtTokens(v);
}

export const fmtTime = (ts) => fmt.dateTime(ts);

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  n.append(...kids.filter(Boolean));
  return n;
};

export const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

/** Native SVG tooltip — hovering a slice/bar should always explain itself. */
export function withTooltip(node, text) {
  const t = svgEl('title');
  t.textContent = text;
  node.append(t);
  return node;
}

// ── query params ─────────────────────────────────────────────


export function isoDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` string, avoiding the UTC parse of `new Date(s)`. */
export function dayStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function periodRange() {
  if (state.mode === 'day' && state.day) {
    const from = dayStart(state.day);
    const end = new Date(from);
    end.setDate(end.getDate() + 1); // via Date, so DST-shifted days stay whole
    return { from, to: end.getTime() };
  }
  const p = PERIODS.find((x) => x.id === state.period);
  if (!p || p.days === null) return {};
  return { from: Date.now() - p.days * 864e5 };
}

/**
 * The URL carries the day and the open session, so a particular view is
 * linkable — "look at 30 июля" should survive being pasted into a note.
 */

export function params(extra = {}) {
  const q = new URLSearchParams({ metric: state.metric, ...periodRange(), ...state.filters, ...extra });
  if (state.source) q.set('source', state.source);
  for (const [k, v] of [...q.entries()]) if (v === '' || v == null) q.delete(k);
  return q.toString();
}

/** Every request is aimed at one source; hand-built URLs go through this. */
export const withSource = (url) =>
  state.source ? url + (url.includes('?') ? '&' : '?') + 'source=' + encodeURIComponent(state.source) : url;

export const api = (path, extra) => fetch(`${path}?${params(extra)}`).then((r) => r.json());

export const kpiCard = (label, value, sub) =>
  el(
    'div',
    { class: 'kpi' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    sub ? el('div', { class: 'sub', text: sub }) : null
  );

export const panelWith = (action, title, hint, ...body) =>
  el(
    'div',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h2', { text: title }),
      hint ? el('span', { class: 'hint', text: hint }) : null,
      action ? el('div', { class: 'panel-action' }, action) : null
    ),
    ...body
  );

export const panel = (title, hint, ...body) => panelWith(null, title, hint, ...body);

export const SHARE_FORMATS = ['link', 'json', 'md', 'cli'].map((id) => ({
  id,
  label: t(`share.widget.format.${id}.label`),
  hint: t(`share.widget.format.${id}.hint`),
}));

// The last chosen shape is the default one, because sharing is a habit: the
// same person keeps handing findings to the same kind of receiver.
export const shareFormat = () =>
  SHARE_FORMATS.some((f) => f.id === localStorage.getItem('bl:share'))
    ? localStorage.getItem('bl:share')
    : 'link';

/** Drops empty params and pins the source, so a link never means "whatever is selected". */
export function shareQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  if (state.source) q.set('source', state.source);
  // An apostrophe inside an agent name would close the quoting of the CLI form.
  return q.toString().replaceAll("'", '%27');
}

export const shareUrl = (kind, params) => `${location.origin}/s/${kind}${qs(shareQuery(params))}`;
export const shareRef = (kind, params) => `bl://${kind}${qs(shareQuery(params))}`;
export const qs = (q) => (q ? '?' + q : '');

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Clipboard access can be refused (permissions, non-secure context). The
  // selection-based path still works in that case; if even that fails the text
  // is shown, because a copy button that silently does nothing is a bug.
  const ta = el('textarea', { class: 'copy-fallback' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  if (!ok) showCopyFallback(text);
  return ok;
}

export function showCopyFallback(text) {
  const ta = el('textarea', { class: 'copy-box', readonly: '' });
  ta.value = text;
  const box = el('div', { class: 'copy-overlay' },
    el('div', { class: 'copy-modal' },
      el('div', { class: 'copy-head' },
        el('b', { text: t('share.widget.copyManually') }),
        el('button', { class: 'ghost tiny', text: '✕', onclick: () => box.remove() })),
      ta));
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  document.body.append(box);
  ta.focus();
  ta.select();
}

/**
 * `target()` is called at click time, not at build time: the metric, the day
 * and a panel's own scope keep changing under a button that was rendered once.
 */
export function shareButton(target, opts = {}) {
  const main = el('button', { class: 'ghost sharemain' });
  const caret = el('button', {
    class: 'ghost sharecaret',
    text: '▾',
    title: t('share.widget.otherFormat'),
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': t('share.widget.pickFormat'),
  });
  const menu = el('div', { class: 'share-menu', hidden: '' });
  const wrap = el('div', { class: 'sharewrap' }, main, caret, menu);

  const current = () => SHARE_FORMATS.find((f) => f.id === shareFormat());
  const label = () => current()?.label ?? t('share.widget.button');
  const setLabel = () => {
    main.textContent =
      t(opts.compact ? 'share.widget.buttonCompactPrefix' : 'share.widget.buttonPrefix') + label();
    main.title = t('share.widget.titleWithHint', {
      title: opts.title ?? t('share.widget.defaultTitle'),
      hint: current()?.hint ?? '',
    });
  };

  let flash;
  const say = (text, ms = 1500) => {
    main.textContent = text;
    clearTimeout(flash);
    flash = setTimeout(setLabel, ms);
  };

  // `format`, not `fmt` — `fmt` is the locale formatter this module imports.
  const run = async (format) => {
    const tgt = target();
    if (!tgt) return say(t('share.widget.nothingToShare'));
    const { kind, params } = tgt;
    try {
      if (format === 'link') {
        return say(
          (await copyText(shareUrl(kind, params)))
            ? t('share.widget.linkCopied')
            : t('share.widget.copyByHand')
        );
      }
      if (format === 'cli') {
        const cmd = `burnlens show '${shareRef(kind, params)}'`;
        return say(
          (await copyText(cmd)) ? t('share.widget.commandCopied') : t('share.widget.copyByHand')
        );
      }
      // json / md have to be fetched: the payload is computed on the server,
      // and copying anything the screen assembled itself would be a second,
      // divergent implementation of the same report.
      say(t('share.widget.working'), 60000);
      const url =
        shareUrl(kind, params) +
        (format === 'json' ? (shareQuery(params) ? '&' : '?') + 'format=json' : '');
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) return say(t('share.widget.failed', { detail: text.slice(0, 40) }));
      say(
        (await copyText(text))
          ? t('share.widget.copied', { size: fmtBytes(text.length) })
          : t('share.widget.copyByHand'),
        2500
      );
    } catch (e) {
      say(t('share.widget.threw', { detail: String(e).slice(0, 40) }), 3000);
    }
  };

  const closeMenu = () => {
    menu.hidden = true;
    caret.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onOutside = (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  };
  const onEsc = (e) => {
    if (e.key !== 'Escape') return;
    // The drawer also closes on Escape; an open menu is the nearer thing.
    e.stopPropagation();
    closeMenu();
  };

  menu.replaceChildren(
    ...SHARE_FORMATS.map((f) =>
      el('button', {
        class: 'share-item',
        onclick: () => {
          localStorage.setItem('bl:share', f.id);
          setLabel();
          closeMenu();
          run(f.id);
        },
      },
      el('span', { class: 'name', text: f.label }),
      el('span', { class: 'hint', text: f.hint }))
    )
  );

  main.addEventListener('click', () => {
    closeMenu();
    run(shareFormat());
  });
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      menu.hidden = false;
      caret.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    } else closeMenu();
  });

  setLabel();
  return wrap;
}

export const fmtBytes = (n) =>
  n >= 1e6 ? t('units.megabytes', { v: (n / 1e6).toFixed(1) })
  : n >= 1e3 ? t('units.kilobytes', { v: Math.round(n / 1e3) })
  : t('units.bytes', { v: n });

export const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('units.seconds', { v: s });
  const m = Math.floor(s / 60);
  return m < 60
    ? t('units.minutesSeconds', { m, s: s % 60 })
    : t('units.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
};

// Two different failures wear identical counters, and only one of them is a
// TTL question. A pause shorter than the TTL in force means the entry had not
// expired — the cached prefix was dropped for another reason, and no TTL
// setting would have saved it. Shared by the run-history timeline and the
// cache report — every place a miss is shown says the same thing.
export const TTL_NAME = { '5m': t('cache.miss.ttlName.5m'), '1h': t('cache.miss.ttlName.1h') };
export const missCauseShort = (m) =>
  m.cause === 'expired'
    ? t('cache.miss.shortExpired', { duration: fmtDuration(m.idleMs) })
    : t('cache.miss.shortInvalidated', { duration: fmtDuration(m.idleMs) });
export const missCauseLong = (m) =>
  m.cause === 'expired'
    ? t('cache.miss.longExpired', { duration: fmtDuration(m.idleMs) })
    : t('cache.miss.longInvalidated', { duration: fmtDuration(m.idleMs), ttl: TTL_NAME[m.ttl] ?? m.ttl });
export const missCauseHint = (m) =>
  m.cause === 'expired'
    ? t('cache.miss.hintExpired', { ttl: TTL_NAME[m.ttl] ?? m.ttl, rate: m.ttl === '1h' ? 20 : 12.5 })
    : t('cache.miss.hintInvalidated');

/**
 * Make an SVG chart pickable.
 *
 * Bars are often 2px wide — per-bar hover and click handlers are unusable at
 * that size. Instead one transparent capture rect covers the plot, the nearest
 * item is found by x, and a crosshair plus a readout line above the chart says
 * what is under the cursor. Every chart in the drawer uses this, so they all
 * behave the same way.
 */
export function chartPicker(svg, cfg) {
  const { padL, padT, plotW, plotH, count, xAt, yAt, describe, colorAt, onPick, idle, suspended } = cfg;
  const readout = el('div', { class: 'tl-readout', text: idle ?? '' });

  const marker = svgEl('g', { class: 'tl-marker', visibility: 'hidden' });
  const cross = svgEl('line', { class: 'tl-cross', y1: padT, y2: padT + plotH });
  const dot = svgEl('circle', { r: 3.2, class: 'tl-dot' });
  marker.append(cross, dot);
  svg.append(marker);

  const capture = svgEl('rect', {
    class: 'tl-capture', x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent',
  });
  svg.append(capture);

  // Screen px → viewBox units through the element's own CTM. Stretching the
  // box width over `W` would only be right if the rendered box had the
  // viewBox's aspect ratio; it does not — the charts are `width:100%` with a
  // fixed pixel height, so `xMidYMid meet` letterboxes them and the drawing is
  // narrower than the box and centred in it. Mapping across the full width
  // then pulls every reading towards the middle of the chart.
  const svgXOf = (e) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return padL;
    const px = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()).x;
    // Clamped: a drag that ends outside the chart still means "to the edge".
    return Math.min(Math.max(px, padL), padL + plotW);
  };

  const nearest = (px) => {
    let best = -1, bestD = Infinity;
    for (let i = 0, n = count(); i < n; i++) {
      const d = Math.abs(xAt(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const show = (i) => {
    if (i < 0) return;
    marker.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', xAt(i));
    cross.setAttribute('x2', xAt(i));
    dot.setAttribute('cx', xAt(i));
    dot.setAttribute('cy', yAt(i));
    dot.setAttribute('fill', colorAt ? colorAt(i) : '#d97757');
    readout.replaceChildren(...describe(i));
  };

  const clear = () => {
    marker.setAttribute('visibility', 'hidden');
    readout.replaceChildren(document.createTextNode(idle ?? ''));
  };

  capture.addEventListener('mousemove', (e) => {
    if (suspended?.()) return;
    show(nearest(svgXOf(e)));
  });
  capture.addEventListener('mouseleave', () => {
    if (suspended?.()) return;
    clear();
  });
  if (onPick) {
    capture.addEventListener('click', (e) => {
      const i = nearest(svgXOf(e));
      if (i >= 0) onPick(i);
    });
  }

  return { readout, capture, svgXOf, nearest, show, clear };
}

/**
 * Drill-in, filled by app.js at startup. Screen modules open a session or a
 * run without importing app.js — which would be a cycle, since app.js imports
 * them. The dashboard owns navigation; the screens only ask for it.
 */
export const go = {
  session: null,   // (sessionId)
  agent: null,     // (sessionId, agent)
  run: null,       // (sessionId, agent, runId, focusTs?)
  filter: null,    // (key, value) — add a toolbar filter chip
  day: null,       // (iso) — drill the toolbar into one calendar day
  refresh: null,   // re-render the current screen
};
