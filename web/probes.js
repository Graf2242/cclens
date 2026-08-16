/**
 * The probes screen: the rules, what they found, and the editor that makes a
 * rule writable at all.
 *
 * A probe is a grep that knows what it costs — it finds a structured block in
 * the logs, PINS the find to the agent run that produced it, and the index
 * already knows what that run was billed. So the screen is not a search result
 * page; it is a report about money, and it is laid out in the order a rule is
 * actually lived with:
 *
 *   1. the LIST of rules — a rule is a long-lived object with its own coverage
 *      and its own staleness. "Numbers you see were produced by a rule that no
 *      longer exists" is the single most misleading state this screen can be
 *      in, so `stale` is a badge on the rule itself, not a footnote.
 *   2. the REPORT for the selected rule — and inside it the byAgent table
 *      first, because it is the only thing here that grep cannot do: flagged
 *      runs of an agent priced against the SAME agent's clean runs. Totals and
 *      samples are context for that comparison, not the other way round.
 *   3. the EDITOR with a preview — a probe is never right on the first try.
 *      `scope` decides which slice of the log the pattern even sees (measured:
 *      4516 naive hits vs 588 real returns) and `emptyIf` decides which literal
 *      means "nothing to report" (535 of those 588). Neither is guessable, both
 *      are tuned by looking at captures, so "Проверить" runs the rule without
 *      writing anything and shows what it caught right there in the form.
 *
 * Everything the user types is arbitrary log text on the way back — captures
 * are put on screen with `el()` only, never through `innerHTML`.
 */

import {
  api, el, fmt, fmtDuration, fmtMetric, fmtTime, go, kpiCard, panelWith, state, t, withSource,
} from './ui.js';

// ── vocabulary ───────────────────────────────────────────────

/**
 * The scopes, in the order they are worth trying. `short` is what a list row
 * shows, `label` what the select shows, `hint` why you would pick it.
 */
const SCOPES = [
  { id: 'return', short: t('probes.scope.return.short'), label: t('probes.scope.return.label'),
    hint: t('probes.scope.return.hint') },
  { id: 'assistant', short: t('probes.scope.assistant.short'), label: t('probes.scope.assistant.label'),
    hint: t('probes.scope.assistant.hint') },
  { id: 'thinking', short: t('probes.scope.thinking.short'), label: t('probes.scope.thinking.label'),
    hint: t('probes.scope.thinking.hint') },
  { id: 'prompt', short: t('probes.scope.prompt.short'), label: t('probes.scope.prompt.label'),
    hint: t('probes.scope.prompt.hint') },
  { id: 'dispatch', short: t('probes.scope.dispatch.short'), label: t('probes.scope.dispatch.label'),
    hint: t('probes.scope.dispatch.hint') },
  { id: 'write', short: t('probes.scope.write.short'), label: t('probes.scope.write.label'),
    hint: t('probes.scope.write.hint') },
  { id: 'tool_result', short: t('probes.scope.tool_result.short'), label: t('probes.scope.tool_result.label'),
    hint: t('probes.scope.tool_result.hint') },
  { id: 'any', short: t('probes.scope.any.short'), label: t('probes.scope.any.label'),
    hint: t('probes.scope.any.hint') },
];

const scopeShort = (scope) => {
  const [base, tool] = String(scope ?? '').split(':');
  const s = SCOPES.find((x) => x.id === base);
  return (s ? s.short : base || '—') + (tool ? ': ' + tool : '');
};

const money = (v) => (Number.isFinite(v) ? fmtMetric(v) : '—');
const shortId = (id) => String(id ?? '').slice(0, 8);
const dash = (v) => (v == null || v === '' ? '—' : String(v));

const th = (...names) => el('thead', {}, el('tr', {}, ...names.map((name) => el('th', { text: name }))));
const num = (v, cls) => el('td', { class: 'num' + (cls ? ' ' + cls : ''), text: String(v) });
const txt = (v, cls) => el('td', { class: cls ?? '', text: String(v) });
const tableIn = (...kids) => el('div', { class: 'table-scroll' }, el('table', {}, ...kids));
const subHead = (title, hint) =>
  el('div', { class: 'sub-head' },
    el('h3', { text: title }),
    hint ? el('span', { class: 'hint', text: hint }) : null);

/** Inline proportion bar — same idiom as the diagnostics screen. */
const meterCell = (share, width = 60) =>
  el('td', { class: 'num' },
    el('span', { class: 'meter', style: `width:${Math.max(2, width * (share || 0)).toFixed(1)}px` }));

const formRow = (label, control, hint) =>
  el('div', { class: 'form-row' },
    el('label', { text: label }),
    el('div', {}, control, hint ? el('span', { class: 'hint', text: hint }) : null));

/**
 * The one paragraph that has to land before anything else on this screen: what
 * a probe is, and why the two regex fields carry the whole design. Shown in the
 * editor and on the empty screen, because those are the two moments a person
 * has no idea what to type.
 */
const whatIsAProbe = () =>
  el('p', { class: 'note' },
    el('span', { text: t('probes.hint.probe.intro') }),
    el('b', { text: 'scope' }),
    el('span', { text: t('probes.hint.probe.scopeDesc') }),
    el('code', { text: '=== AGENT_ERRORS ===' }),
    el('span', { text: t('probes.hint.probe.scopeExample') }),
    el('b', { text: 'emptyIf' }),
    el('span', { text: t('probes.hint.probe.emptyIfDesc') }),
    el('code', { text: '<empty>' }),
    el('span', { text: t('probes.hint.probe.emptyIfExample') }));

// ── screen state ─────────────────────────────────────────────
//
// Kept at module level on purpose: the toolbar re-renders the whole screen when
// the period or the metric changes, and losing the selected probe (or a
// half-written rule in the editor) on a period switch would be a bug.

let probes = [];
let status = [];
let runState = { running: false, progress: null, last: null, error: null };
let runError = null;
let sel = null;
/**
 * Which rule the screen is currently reporting on. The toolbar's share button
 * lives in app.js and has to name a probe in the link, otherwise `bl://probe`
 * resolves to a 400 — so the selection has to leave this module.
 */
export const selectedProbe = () => sel;
let editing = null;      // { def, isNew } — the draft in the form, or null
let sampleLimit = 10;
let pollTimer = null;

let listBox = null;
let reportBox = null;
let editorBox = null;

const statusOf = (id) => status.find((s) => s.id === id) ?? null;
const probeOf = (id) => probes.find((p) => p.id === id) ?? null;

// ── entry point ──────────────────────────────────────────────

export async function renderProbes(box) {
  box.replaceChildren(el('div', { class: 'empty', text: t('probes.status.loading') }));
  let d;
  try {
    d = await api('/api/probes');
  } catch (err) {
    box.replaceChildren(el('div', { class: 'panel' },
      el('div', { class: 'empty', text: t('probes.status.serverError', { detail: String(err) }) })));
    return;
  }
  // The toolbar can switch screens while this request is in flight.
  if (state.view !== 'probes') return;

  probes = d.probes ?? [];
  status = d.status ?? [];
  runState = d.run ?? runState;
  if (!probeOf(sel)) sel = probes.find((p) => p.enabled !== false)?.id ?? probes[0]?.id ?? null;
  if (editing && !editing.isNew && !probeOf(editing.def.id)) editing = null;

  listBox = el('div', {});
  reportBox = el('div', {});
  editorBox = el('div', {});
  box.replaceChildren(listBox, editorBox, reportBox);

  drawList();
  drawEditor();
  await drawReport();
  if (runState.running) poll();
}

// ── 1. the list of rules ─────────────────────────────────────

function drawList() {
  if (!listBox) return;

  const actions = el('div', { class: 'form-actions' },
    el('button', {
      class: 'ghost', text: t('probes.action.run'), title: t('probes.action.runTitle'),
      disabled: runState.running ? '' : null,
      onclick: () => startRun({}),
    }),
    el('button', {
      class: 'ghost', text: t('probes.action.runForce'),
      title: t('probes.action.runForceTitle'),
      disabled: runState.running ? '' : null,
      onclick: () => startRun({ force: true }),
    }),
    el('button', {
      class: 'primary', text: t('probes.action.newProbe'),
      onclick: () => { editing = { def: blankProbe(), isNew: true }; drawEditor(); },
    }));

  if (!probes.length) {
    listBox.replaceChildren(panelWith(actions, t('probes.panel.title'), null,
      whatIsAProbe(),
      el('div', { class: 'empty', text: t('probes.list.empty') })));
    return;
  }

  const rows = probes.map((p) => probeRow(p));

  listBox.replaceChildren(panelWith(actions, t('probes.panel.title'), t('probes.panel.hint'),
    runBlock(),
    el('div', { class: 'dupes' }, ...rows)));
}

function probeRow(p) {
  const st = statusOf(p.id);
  const off = p.enabled === false;
  const selected = p.id === sel;

  const head = el('div', { class: 'dupe-head' },
    el('b', { text: p.label, style: off ? 'color:var(--fg-dim)' : 'color:var(--fg)' }),
    el('span', { class: 'badge', text: scopeShort(p.scope) }),
    p.builtin ? el('span', { class: 'badge', text: t('probes.badge.builtin') }) : null,
    off ? el('span', { class: 'badge', text: t('probes.badge.disabled') }) : null,
    st?.stale ? el('span', { class: 'badge warn', text: t('probes.badge.stale') }) : null);

  const facts = st
    ? t('probes.list.facts', {
        hits: t('probes.word.hits', { n: st.hits }),
        nonEmpty: fmt.n(st.nonEmpty),
        files: fmt.n(st.files),
        tail: st.scannedAt
          ? t('probes.list.factsScanned', { time: fmtTime(st.scannedAt) })
          : t('probes.list.factsNever'),
      })
    : t('probes.list.noRunData');

  const buttons = el('div', { class: 'dupe-members' },
    el('button', {
      class: 'chip-btn', text: t('probes.action.editRule'),
      onclick: (e) => { e.stopPropagation(); editing = { def: { ...p }, isNew: false }; sel = p.id; drawEditor(); drawList(); drawReport(); },
    }),
    el('button', {
      class: 'chip-btn', text: t('probes.action.runThis'),
      onclick: (e) => { e.stopPropagation(); startRun({ id: p.id }); },
    }));

  return el('div', {
    class: 'dupe',
    style: 'cursor:pointer' + (selected ? ';border-color:var(--accent)' : '') + (off ? ';opacity:.55' : ''),
    onclick: () => { if (sel !== p.id) { sel = p.id; sampleLimit = 10; drawList(); drawReport(); } },
  },
    head,
    el('div', { class: 'est', text: facts }),
    buttons);
}

/** Progress, the last outcome and every error the sweep reported — never silent. */
function runBlock() {
  const kids = [];
  const r = runState;

  if (r.running) {
    const p = r.progress;
    const share = p && p.total ? p.scanned / p.total : 0;
    kids.push(el('div', { class: 'progress' }, el('i', { style: `width:${(share * 100).toFixed(1)}%` })));
    kids.push(el('div', { class: 'est', text:
      p ? t('probes.status.scanningProgress', { scanned: fmt.n(p.scanned), total: fmt.n(p.total), hits: fmt.n(p.hits) })
        : t('probes.status.scanning') }));
  } else if (r.last) {
    const l = r.last;
    kids.push(el('div', { class: 'est', text: t('probes.list.lastRun.summary', {
      files: t('probes.word.files', { n: l.files }),
      scanned: fmt.n(l.scanned),
      hits: t('probes.word.hits', { n: l.hits }),
      duration: fmtDuration(l.elapsedMs),
      time: fmtTime(l.finishedAt),
    }) }));
  }

  if (r.error) kids.push(el('div', { class: 'form-error', text: t('probes.status.runFailed', { detail: r.error }) }));
  if (runError) kids.push(el('div', { class: 'form-error', text: runError }));
  for (const e of r.last?.errors ?? []) {
    kids.push(el('div', { class: 'form-error', text: t('probes.status.ruleSkipped', { id: e.id, message: e.message }) }));
  }

  return kids.length ? el('div', { style: 'display:grid;gap:6px;margin-bottom:10px' }, ...kids) : null;
}

// ── 2. the sweep ─────────────────────────────────────────────
//
// Fire-and-poll, same shape as the reindex button: the first sweep reads the
// whole corpus and no browser holds a request open that long.

async function startRun(opts) {
  runError = null;
  try {
    const res = await fetch(withSource('/api/probes/run'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) runError = t('probes.status.runStartFailed', { detail: body.error ?? `HTTP ${res.status}` });
    else runState = body;
  } catch (err) {
    runError = t('probes.status.runStartFailed', { detail: String(err) });
  }
  drawList();
  drawEditor();
  if (!runError) poll();
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (state.view !== 'probes' || !listBox) return;
    try {
      const d = await fetch(withSource('/api/probes/status')).then((r) => r.json());
      runState = d.run ?? runState;
      status = d.status ?? status;
    } catch (err) {
      runError = t('probes.status.pollFailed', { detail: String(err) });
      drawList();
      return;
    }
    drawList();
    if (runState.running) poll();
    else {
      // The numbers under the report were produced by the sweep that just ended.
      drawEditor();
      void drawReport();
    }
  }, 700);
}

// ── 3. the report ────────────────────────────────────────────

async function drawReport() {
  if (!reportBox) return;
  if (!sel) return reportBox.replaceChildren();

  const asked = sel;
  const probe = probeOf(asked);
  reportBox.replaceChildren(el('div', { class: 'panel' },
    el('div', { class: 'empty', text: t('probes.status.computingReport') })));

  let rep;
  try {
    rep = await api('/api/probe', { id: asked });
  } catch (err) {
    reportBox.replaceChildren(el('div', { class: 'panel' },
      el('div', { class: 'empty', text: t('probes.status.reportFailed', { detail: String(err) }) })));
    return;
  }
  // Another probe (or another screen) may have been picked while this was in flight.
  if (state.view !== 'probes' || sel !== asked) return;
  if (rep.error) {
    reportBox.replaceChildren(el('div', { class: 'panel' },
      el('div', { class: 'empty', text: t('probes.status.reportFailed', { detail: rep.error }) })));
    return;
  }

  const st = statusOf(sel);
  const tot = rep.totals;
  const title = (rep.probe?.label ?? probe?.label ?? sel);

  const head = st?.stale
    ? el('p', { class: 'note' },
        el('span', { class: 'badge warn', text: t('probes.badge.stale') }),
        el('span', { text: t('probes.report.staleNote') }),
        el('button', { class: 'chip-btn', text: t('probes.action.runThisProbe'), onclick: () => startRun({ id: sel }) }))
    : null;

  if (!tot.hits) {
    reportBox.replaceChildren(panelWith(null, title, scopeShort(rep.probe?.scope ?? probe?.scope),
      head,
      el('div', { class: 'empty', text: t('probes.report.emptyHits') })));
    return;
  }

  reportBox.replaceChildren(panelWith(null, title, scopeShort(rep.probe?.scope ?? probe?.scope),
    head,
    kpis(tot),
    agentPanel(rep.byAgent),
    groupPanel(rep.byGroup, rep.probe ?? probe),
    dayPanel(rep.byDay),
    samplesPanel(rep.samples, tot)));
}

function kpis(tot) {
  return el('div', { class: 'kpis', style: 'margin-bottom:14px' },
    kpiCard(t('probes.kpi.hits.label'), fmt.n(tot.hits), t('probes.kpi.hits.sub', { empty: fmt.n(tot.empty) })),
    kpiCard(t('probes.kpi.nonEmpty.label'), fmt.n(tot.nonEmpty),
      tot.hits ? t('probes.kpi.nonEmpty.sub', { pct: Math.round((100 * tot.nonEmpty) / tot.hits) }) : ''),
    kpiCard(t('probes.kpi.flaggedRuns.label'), fmt.n(tot.runsFlagged),
      t('probes.kpi.flaggedRuns.sub', { n: tot.sessions })),
    kpiCard(t('probes.kpi.valueFlagged.label'), money(tot.valueInFlagged), t('probes.kpi.valueFlagged.sub')));
}

// The whole reason the screen exists: flagged runs priced against the SAME
// agent's clean runs in the SAME window.
function agentPanel(rows) {
  if (!rows?.length) return null;

  const body = tableIn(
    th(t('common.col.agent'), t('probes.table.header.flagged'), t('probes.table.header.theirAvg'),
      t('common.col.turns'), t('probes.table.header.others'), t('probes.table.header.theirAvg'),
      t('common.col.turns'), t('probes.table.header.ratio')),
    el('tbody', {}, ...rows.map((r) =>
      el('tr', { onclick: () => go.filter('agent', r.agent), title: t('common.action.filterByAgentTitle') },
        txt(r.agent, 'name'),
        num(fmt.n(r.flaggedRuns)),
        num(money(r.flaggedAvgValue), 'accent'),
        num(r.flaggedAvgTurns.toFixed(1)),
        num(fmt.n(r.otherRuns)),
        num(money(r.otherAvgValue)),
        num(r.otherAvgTurns.toFixed(1)),
        el('td', { class: 'num' },
          r.ratioValue == null
            ? el('span', { class: 'est', text: '—' })
            : el('span', {
                class: 'ratio' + (r.ratioValue >= 1.5 ? ' hot' : ''),
                text: '×' + r.ratioValue.toFixed(2),
              })))))
  );

  return el('div', {},
    subHead(t('probes.panel.flaggedPrice.title'), t('probes.panel.flaggedPrice.hint')),
    el('p', { class: 'note' },
      el('span', { text: t('probes.panel.flaggedPrice.noteFlagged') }),
      el('b', { text: t('probes.panel.flaggedPrice.noteOthers') }),
      el('span', { text: t('probes.panel.flaggedPrice.noteBaseline') })),
    body);
}

function groupPanel(rows, probe) {
  if (!rows?.length) return null;

  const max = Math.max(...rows.map((r) => r.value || 0), 1);
  const body = tableIn(
    th(t('probes.table.header.slice'), t('probes.table.header.hits'), t('common.col.runs'),
      t('probes.table.header.spendInThem'), ''),
    el('tbody', {}, ...rows.map((r) =>
      el('tr', { class: 'muted' },
        txt(dash(r.grp), 'name'),
        num(fmt.n(r.hits)),
        num(fmt.n(r.runs)),
        num(money(r.value), 'accent'),
        meterCell(r.value / max))))
  );

  return el('div', {},
    subHead(t('probes.panel.groupBy.title'), probe?.groupBy ? probe.groupBy : null),
    el('p', { class: 'note', text: t('probes.panel.groupBy.note') }),
    body);
}

function dayPanel(rows) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.hits || 0), 1);

  const body = tableIn(
    th(t('diag.table.header.day'), t('probes.table.header.hits'), t('probes.table.header.nonEmpty'), ''),
    el('tbody', {}, ...rows.map((r) =>
      el('tr', { class: 'muted' },
        txt(r.day),
        num(fmt.n(r.hits)),
        num(fmt.n(r.nonEmpty), 'accent'),
        meterCell(r.hits / max, 90))))
  );

  return el('div', {}, subHead(t('probes.panel.byDay.title'), t('probes.panel.byDay.hint')), body);
}

function samplesPanel(samples, tot) {
  if (!samples?.length) return null;
  const shown = samples.slice(0, sampleLimit);

  const cards = shown.map((s) =>
    el('div', {
      class: 'dupe',
      style: 'cursor:pointer',
      title: t('probes.samples.openTitle'),
      onclick: () => go.run(s.sessionId, s.agent, s.agentId ?? 'main', s.ts),
    },
      el('div', { class: 'dupe-head' },
        el('b', { text: s.agent }),
        el('span', { text: fmtTime(s.ts) }),
        el('span', { text: t('probes.samples.sessionPrefix', { id: shortId(s.sessionId) }) }),
        s.project ? el('span', { text: s.project }) : null,
        s.grp ? el('span', { class: 'badge accent', text: s.grp }) : null),
      el('div', { class: 'capture', text: s.capture || t('probes.samples.emptyCapture') })));

  const more = samples.length > sampleLimit
    ? el('button', {
        class: 'ghost tiny',
        text: t('probes.samples.showMore', { n: Math.min(10, samples.length - sampleLimit) }),
        onclick: () => { sampleLimit += 10; void drawReport(); },
      })
    : null;

  return el('div', {},
    subHead(t('probes.panel.samples.title'), t('probes.panel.samples.hint', {
      shown: shown.length, total: fmt.n(samples.length), nonEmpty: fmt.n(tot.nonEmpty),
    })),
    el('p', { class: 'note', text: t('probes.panel.samples.note') }),
    el('div', { class: 'dupes' }, ...cards),
    more ? el('div', { class: 'form-actions', style: 'margin-top:10px' }, more) : null);
}

// ── 4. the editor ────────────────────────────────────────────

const blankProbe = () => ({
  id: '', label: '', scope: 'return', pattern: '', emptyIf: '', groupBy: '', enabled: true,
});

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * Which field the server complained about.
 *
 * It says so outright: `saveProbe` attaches a `field` code next to the message
 * (`src/probeconfig.ts`). Reading it out of the message text is not an option —
 * the message is a catalog string, so any translation would silently stop the
 * editor from highlighting anything.
 *
 * The regex fallback stays only for the messages that never carry a code —
 * regex-compiler output naming `pattern`/`emptyIf`/`groupBy`, which are field
 * identifiers rather than prose and are the same in every language.
 */
function fieldOfError(body) {
  if (body && typeof body === 'object' && typeof body.field === 'string') return body.field;
  const m = String(body && typeof body === 'object' ? (body.error ?? '') : body);
  if (/pattern/.test(m)) return 'pattern';
  if (/emptyIf/.test(m)) return 'emptyIf';
  if (/groupBy/.test(m)) return 'groupBy';
  return null;
}

function drawEditor() {
  if (!editorBox) return;
  if (!editing) return editorBox.replaceChildren();

  const { def, isNew } = editing;
  const saved = !isNew ? probeOf(def.id) : null;
  const st = !isNew ? statusOf(def.id) : null;

  const inputs = {};
  const mk = (name, attrs) => (inputs[name] = el('input', { type: 'text', value: def[name] ?? '', ...attrs }));

  const labelIn = mk('label', {
    placeholder: 'AGENT_ERRORS (pie-tools)',
    oninput: () => {
      def.label = labelIn.value;
      // A new rule needs an id, and typing one twice is busywork; the moment
      // the id is touched by hand this stops.
      if (isNew && !editing.idTouched) { def.id = slug(labelIn.value); inputs.id.value = def.id; }
    },
  });

  const idIn = mk('id', {
    placeholder: 'agent-errors',
    disabled: isNew ? null : '',
    oninput: () => { editing.idTouched = true; def.id = idIn.value.trim(); },
  });

  const [scopeBase, scopeTool] = String(def.scope ?? 'return').split(':');
  const scopeSel = el('select', {
    onchange: () => {
      toolIn.disabled = scopeSel.value !== 'tool_result';
      if (toolIn.disabled) toolIn.value = '';
      syncScope();
    },
  }, ...SCOPES.map((s) => el('option', { value: s.id, text: s.label, selected: s.id === scopeBase ? '' : null })));
  const toolIn = el('input', {
    type: 'text', value: scopeTool ?? '', placeholder: 'Read',
    disabled: scopeBase === 'tool_result' ? null : '',
    oninput: () => syncScope(),
  });
  const syncScope = () => {
    const tool = toolIn.value.trim();
    def.scope = scopeSel.value + (scopeSel.value === 'tool_result' && tool ? ':' + tool : '');
    scopeHint.textContent = SCOPES.find((s) => s.id === scopeSel.value)?.hint ?? '';
  };
  const scopeHint = el('span', { class: 'hint', text: SCOPES.find((s) => s.id === scopeBase)?.hint ?? '' });

  const patternIn = el('textarea', {
    rows: '3', spellcheck: 'false', placeholder: '=== RUN ANOMALIES ===([\\s\\S]*?)=== END RUN ANOMALIES ===',
    oninput: () => { def.pattern = patternIn.value; },
  });
  patternIn.value = def.pattern ?? '';
  inputs.pattern = patternIn;

  const emptyIn = mk('emptyIf', {
    // i18n-exempt: example regex — literal Russian log token, not dashboard text.
    placeholder: '^(<empty>|none|нет|-)$',
    oninput: () => { def.emptyIf = emptyIn.value; },
  });
  const groupIn = mk('groupBy', {
    placeholder: 'class\\s*:\\s*([a-z-]+)',
    oninput: () => { def.groupBy = groupIn.value; },
  });
  const enabledIn = el('input', {
    type: 'checkbox', checked: def.enabled !== false ? '' : null,
    onchange: () => { def.enabled = enabledIn.checked; },
  });

  const errBox = el('div', {});
  const previewBox = el('div', {});
  const say = (node) => errBox.replaceChildren(node ?? document.createTextNode(''));
  const clearBad = () => Object.values(inputs).forEach((i) => i.classList.remove('bad'));

  // `body` is the server's JSON when there is one, so the field code survives;
  // a thrown client-side error arrives as a plain string.
  const showError = (body) => {
    clearBad();
    const msg = body && typeof body === 'object' ? (body.error ?? String(body)) : String(body);
    const f = fieldOfError(body);
    const target = f === 'scope' ? scopeSel : inputs[f];
    if (target) target.classList.add('bad');
    say(el('div', { class: 'form-error', text: msg }));
  };

  const previewBtn = el('button', {
    class: 'ghost', text: t('probes.action.check'),
    onclick: async () => {
      previewBtn.disabled = true;
      previewBtn.textContent = t('probes.action.checking');
      previewBox.replaceChildren();
      say(null);
      try {
        const res = await fetch(withSource('/api/probes/preview'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(defForWire(def)),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) showError(body.error ? body : `HTTP ${res.status}`);
        else { clearBad(); previewBox.replaceChildren(previewResult(body)); }
      } catch (err) {
        showError(String(err));
      }
      previewBtn.disabled = false;
      previewBtn.textContent = t('probes.action.check');
    },
  });

  const saveBtn = el('button', {
    class: 'primary', text: t('probes.action.save'),
    onclick: async () => {
      saveBtn.disabled = true;
      say(null);
      try {
        const res = await fetch(withSource('/api/probes'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(defForWire(def)),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) showError(body.error ? body : `HTTP ${res.status}`);
        else {
          clearBad();
          probes = body.probes ?? probes;
          status = body.status ?? status;
          sel = body.probe?.id ?? sel;
          sampleLimit = 10;
          editing = { def: { ...body.probe }, isNew: false };
          drawList();
          drawEditor();
          void drawReport();
        }
      } catch (err) {
        showError(String(err));
      }
      saveBtn.disabled = false;
    },
  });

  // Two-step instead of a native confirm: deleting a rule also drops every hit
  // it stored, and a dialog that steals focus is a bad place to learn that.
  let armed = false;
  const delBtn = el('button', {
    class: 'ghost',
    text: t('probes.action.delete'),
    disabled: isNew || def.builtin ? '' : null,
    title: def.builtin
      ? t('probes.action.deleteTitleBuiltin')
      : t('probes.action.deleteTitle'),
    onclick: async () => {
      if (!armed) {
        armed = true;
        delBtn.textContent = t('probes.action.deleteConfirm');
        delBtn.classList.add('tiny');
        setTimeout(() => { armed = false; delBtn.textContent = t('probes.action.delete'); delBtn.classList.remove('tiny'); }, 4000);
        return;
      }
      delBtn.disabled = true;
      try {
        const res = await fetch(withSource('/api/probes?id=' + encodeURIComponent(def.id)), { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { showError(body.error ? body : `HTTP ${res.status}`); delBtn.disabled = false; return; }
        probes = body.probes ?? probes;
        status = body.status ?? status;
        if (sel === def.id) sel = probes[0]?.id ?? null;
        editing = null;
        drawList();
        drawEditor();
        void drawReport();
      } catch (err) {
        showError(String(err));
        delBtn.disabled = false;
      }
    },
  });

  const cancelBtn = el('button', {
    class: 'ghost', text: t('probes.action.close'),
    onclick: () => { editing = null; drawEditor(); },
  });

  // After a save `rev` moves and the stored hits stop describing the rule. The
  // screen says so where the change was made, not only in the list.
  const staleNote = st?.stale
    ? el('div', { class: 'form-actions' },
        el('span', { class: 'badge warn', text: t('probes.badge.stale') }),
        el('span', { class: 'est', text: t('probes.editor.staleHint') }),
        el('button', {
          class: 'chip-btn', text: t('probes.action.runThisProbe'),
          disabled: runState.running ? '' : null,
          onclick: () => startRun({ id: def.id }),
        }))
    : null;

  const title = isNew ? t('probes.editor.newTitle') : t('probes.editor.titlePrefix', { label: saved?.label ?? def.label });
  const hint = saved
    ? t('probes.editor.hintSaved', { id: saved.id, rev: saved.rev ?? 1 })
    : t('probes.editor.hintNew');

  editorBox.replaceChildren(panelWith(cancelBtn, title, hint,
    whatIsAProbe(),
    el('div', { class: 'form' },
      formRow(t('probes.editor.field.name.label'), labelIn, t('probes.editor.field.name.hint')),
      formRow('id', idIn, isNew ? t('probes.editor.field.id.hintNew') : t('probes.editor.field.id.hintSaved')),
      formRow(t('probes.editor.field.scope.label'), el('div', { style: 'display:grid;gap:6px' }, scopeSel,
        el('div', { style: 'display:flex;gap:8px;align-items:center' },
          el('span', { class: 'est', text: t('probes.editor.toolHint') }), toolIn)), null),
      el('div', { class: 'form-row' }, el('label', {}), scopeHint),
      formRow(t('probes.editor.field.pattern.label'), patternIn, t('probes.editor.field.pattern.hint')),
      formRow(t('probes.editor.field.emptyIf.label'), emptyIn, t('probes.editor.field.emptyIf.hint')),
      formRow(t('probes.editor.field.groupBy.label'), groupIn, t('probes.editor.field.groupBy.hint')),
      formRow(t('probes.editor.field.enabled.label'), enabledIn, t('probes.editor.field.enabled.hint')),
      el('div', { class: 'form-actions' }, previewBtn, saveBtn, delBtn,
        def.builtin ? el('span', { class: 'est', text: t('probes.editor.builtinNote') }) : null),
      errBox,
      staleNote,
      previewBox)));
}

/** Empty strings must not reach the server as fields — it stores what it gets. */
function defForWire(def) {
  return {
    id: (def.id ?? '').trim(),
    label: (def.label ?? '').trim(),
    scope: def.scope || 'return',
    pattern: def.pattern ?? '',
    ...(def.emptyIf?.trim() ? { emptyIf: def.emptyIf.trim() } : {}),
    ...(def.groupBy?.trim() ? { groupBy: def.groupBy.trim() } : {}),
    enabled: def.enabled !== false,
  };
}

function previewResult(r) {
  const head = el('p', { class: 'note', text: t('probes.preview.summary', {
    scanned: t('probes.word.files', { n: r.scanned }),
    matched: fmt.n(r.matched),
    empty: fmt.n(r.empty),
    duration: fmtDuration(r.elapsedMs),
  }) });

  if (!r.hits?.length) {
    return el('div', {}, head,
      el('div', { class: 'empty', text: t('probes.preview.noMatches') }));
  }

  return el('div', {}, head,
    el('div', { class: 'dupes' }, ...r.hits.slice(0, 8).map((h) =>
      el('div', { class: 'dupe' },
        el('div', { class: 'dupe-head' },
          el('b', { text: h.agent }),
          el('span', { text: fmtTime(h.ts) }),
          el('span', { text: h.file }),
          h.isEmpty
            ? el('span', { class: 'badge', text: t('probes.preview.badge.empty') })
            : el('span', { class: 'badge accent', text: t('probes.preview.badge.nonEmpty') }),
          h.grp ? el('span', { class: 'badge', text: h.grp }) : null),
        el('div', { class: 'capture', text: h.capture || t('probes.preview.emptyCaptureShort') })))),
    r.hits.length > 8
      ? el('div', { class: 'est', text: t('probes.preview.moreHits', { n: r.hits.length - 8 }) })
      : null);
}
