/**
 * Probe definitions — user-written regex rules, and where they are stored.
 *
 * A probe is a grep that knows what it costs. It finds a structured block in
 * the logs, PINS the find to the agent run that produced it, and the index
 * already knows what that run was billed. `probes.ts` does the finding; this
 * file only owns the rules and their persistence.
 *
 * Two fields carry the whole design, and both were forced by measurement on a
 * real corpus (the `=== AGENT_ERRORS ===` contract in pie-tools):
 *
 *   scope — MANDATORY, never "anywhere". A naive grep for that marker over the
 *     corpus returns 4516 hits; 3928 of them are the contract being QUOTED —
 *     in a system prompt, in a dispatch brief, in a rule file an agent read.
 *     Restricting the search to what an agent actually RETURNED leaves 588.
 *     That ~8x of noise is not a filter you can add later in the UI; it is the
 *     difference between a report and a word count. So the scope decides which
 *     slice of the log text the pattern even sees.
 *
 *   emptyIf — MANDATORY in practice for any "did the agent report a problem"
 *     probe. Of those 588 returns, 535 carry the block with nothing in it: the
 *     agent is obeying a contract that says "always emit the block, write
 *     `<empty>` when there is nothing". Which literal means "nothing" is a
 *     PROJECT convention (`<empty>`, `(none)`, `-`), unknowable to the engine,
 *     so the rule brings it — including the HTML-escaped `&lt;empty&gt;` form,
 *     which 178 lines of the corpus carry because the agent escaped its own
 *     return. Without it a probe reports 588 incidents where there were 53.
 *
 * Storage mirrors `sources.ts`: a small JSON next to the indexes, absent until
 * something is saved, with the built-ins living in code so a fresh install has
 * working probes on day one.
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultDbPath } from './db.ts';
import { t } from './i18n.ts';

/**
 * Which text of the log the pattern is applied to.
 *
 * `return` is the one that needed measuring: an agent's answer reaches the
 * parent as a `tool_result`, but the parent's copy is truncated and reshaped —
 * all 588 real AGENT_ERRORS blocks in the corpus were recoverable only from
 * the LAST assistant text block of the subagent's own file. See `probes.ts`.
 */
export type ProbeScope =
  | 'return'      // last assistant text block of a SUBAGENT file — what it returned
  | 'assistant'   // any assistant text block
  | 'thinking'    // thinking blocks
  | 'prompt'      // a human turn: type==='user', not isSidechain, not a tool_result
  | 'dispatch'    // arguments of a DISPATCH_TOOLS call — the brief handed to a subagent
  | 'tool_result' // any tool result; may be narrowed as 'tool_result:Read'
  | 'write'       // arguments of Write/Edit/NotebookEdit — what was written to disk
  | 'any';        // union of everything above except `return` (a subset of `assistant`)

export interface ProbeDef {
  /** kebab-case, unique — also the foreign key every stored hit carries. */
  id: string;
  /** Human name for the UI. */
  label: string;
  /** `ProbeScope`, or a narrowed tool result like `tool_result:Bash`. */
  scope: ProbeScope | string;
  /** The regex. Capture group 1, when present, IS the capture; else the whole match. */
  pattern: string;
  /** Regex over the trimmed capture; a match means "block present but empty". */
  emptyIf?: string;
  /** Regex with one group over the capture — its group 1 becomes the breakdown key. */
  groupBy?: string;
  /** Default true. A disabled probe keeps its hits but is not re-scanned. */
  enabled?: boolean;
  /** Rule version. Editing the matching behaviour bumps it, which invalidates hits. */
  rev?: number;
  /** Shipped with the tool: editable and disableable, but not deletable. */
  builtin?: boolean;
}

/** The fields that change WHAT matches — a change to any of them invalidates hits. */
const MATCHING_FIELDS = ['pattern', 'scope', 'emptyIf', 'groupBy'] as const;

const SCOPES: ReadonlySet<string> = new Set<ProbeScope>([
  'return',
  'assistant',
  'thinking',
  'prompt',
  'dispatch',
  'tool_result',
  'write',
  'any',
]);

/**
 * The two probes the tool ships with — starting points a user is expected to
 * edit, which is why they are ordinary rows in the same list rather than
 * special-cased code. Project-specific contracts (the `AGENT_ERRORS` rule the
 * fields above were measured on) are deliberately NOT here: they belong to the
 * project whose agents emit them, and live as user rules in `probes.json`.
 *
 * A rule tuned the way that measurement demands, for reference:
 *
 *   scope    return
 *   pattern  === AGENT_ERRORS ===((?:(?!=== AGENT_ERRORS ===)[\s\S])*?)=== END AGENT_ERRORS ===
 *   emptyIf  ^(<empty>|&lt;empty&gt;|\(empty\)|empty|\(none\)|none|нет|n/a|-|—)$
 *
 * The pattern's inner negative lookahead is not decoration: a plain lazy
 * `[\s\S]*?` starts at the FIRST opener in the text — often the agent quoting
 * its own contract mid-answer — and swallows everything up to the real block's
 * closer, which on the corpus produced captures beginning mid-sentence.
 */
const BUILTINS: readonly ProbeDef[] = [
  {
    id: 'blocked',
    label: 'BLOCKED',
    scope: 'return',
    pattern: '=== BLOCKED ===((?:(?!=== BLOCKED ===)[\\s\\S])*?)(?:=== END BLOCKED ===|$)',
    // i18n-exempt: matches what the agent wrote in the log, not dashboard text.
    emptyIf: '^(<empty>|&lt;empty&gt;|\\(empty\\)|\\(none\\)|none|нет|-|—)$',
    rev: 3,
    builtin: true,
  },
  {
    id: 'refusals',
    label: t('probeconfig.builtin.refusals.label'),
    scope: 'return',
    // i18n-exempt: matches what the agent wrote in the log, not dashboard text.
    pattern: '(?:не могу|cannot proceed|unable to complete|I refuse|blocked by)([^\\n]{0,200})',
    rev: 1,
    builtin: true,
  },
];

function dataDir(): string {
  // Same anchor as `sources.ts`: whatever directory the index lives in, which
  // `BURNLENS_DB` may move.
  return path.dirname(defaultDbPath());
}

export function probesPath(): string {
  return path.join(dataDir(), 'probes.json');
}

function readConfig(): ProbeDef[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(probesPath(), 'utf8'));
    const list = Array.isArray(parsed?.probes) ? parsed.probes : [];
    return list.filter((p: any) => typeof p?.id === 'string' && typeof p?.pattern === 'string');
  } catch {
    return [];
  }
}

function writeConfig(defs: ProbeDef[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(probesPath(), JSON.stringify({ probes: defs }, null, 2) + '\n');
}

/** A stored def wins over the built-in of the same id — that is how one is edited. */
export function listProbes(): ProbeDef[] {
  const stored = new Map(readConfig().map((p) => [p.id, p]));
  const out: ProbeDef[] = [];
  for (const b of BUILTINS) {
    const s = stored.get(b.id);
    stored.delete(b.id);
    out.push(s ? { ...b, ...s, builtin: true } : { ...b });
  }
  for (const s of stored.values()) out.push({ ...s, builtin: false });
  return out;
}

export function getProbe(id: string): ProbeDef | null {
  return listProbes().find((p) => p.id === id) ?? null;
}

/** Probes an unattended scan should run: everything not explicitly switched off. */
export function enabledProbes(): ProbeDef[] {
  return listProbes().filter((p) => p.enabled !== false);
}

/**
 * Which form field a validation error is about.
 *
 * The message itself is a catalog string and therefore translatable, so the
 * editor cannot recognise the field by reading it — it used to, by grepping the
 * Russian prose, which quietly stopped working the moment the texts moved into
 * `locales/`. The code below travels next to the message instead.
 */
export type ProbeField = 'id' | 'label' | 'scope' | 'pattern' | 'emptyIf' | 'groupBy';

export interface ProbeFieldError extends Error {
  field: ProbeField;
}

const fieldError = (field: ProbeField, message: string): ProbeFieldError =>
  Object.assign(new Error(message), { field });

function compile(source: string, field: ProbeField): RegExp {
  try {
    return new RegExp(source, 'g');
  } catch (err) {
    throw fieldError(field, t('probeconfig.error.invalidRegex', { field, message: (err as Error).message }));
  }
}

/** Number of capture groups, needed to know whether group 1 exists. */
export function groupCount(source: string): number {
  // The empty alternative can never match, so the count comes free and without
  // running the pattern against anything.
  return new RegExp(source + '|').exec('')!.length - 1;
}

/**
 * Validates and persists. Saving is also the only way a built-in gets edited —
 * it is copied into the file on first write and shadows the shipped version.
 *
 * `rev` is bumped here, not by the caller: the whole point is that a UI cannot
 * forget to do it and leave stale hits from the previous rule on screen.
 */
export function saveProbe(def: ProbeDef): ProbeDef {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.id ?? '')) {
    throw fieldError('id', t('probeconfig.error.idFormat', { id: def.id }));
  }
  if (!def.label || !def.label.trim()) throw fieldError('label', t('probeconfig.error.labelRequired'));

  const scope = String(def.scope ?? '');
  const [base, tool] = scope.split(':');
  if (!SCOPES.has(base)) throw fieldError('scope', t('probeconfig.error.unknownScope', { scope }));
  if (tool != null && base !== 'tool_result') {
    throw fieldError('scope', t('probeconfig.error.toolOnlyForToolResult', { scope }));
  }
  if (tool != null && !tool.trim()) throw fieldError('scope', t('probeconfig.error.emptyToolName', { scope }));

  compile(def.pattern ?? '', 'pattern');
  if (def.emptyIf) compile(def.emptyIf, 'emptyIf');
  if (def.groupBy) {
    compile(def.groupBy, 'groupBy');
    if (groupCount(def.groupBy) < 1) throw fieldError('groupBy', t('probeconfig.error.groupByNeedsOneGroup'));
  }

  const prev = getProbe(def.id);
  const changed = prev != null && MATCHING_FIELDS.some((f) => (prev[f] ?? null) !== (def[f] ?? null));
  const rev = prev == null ? (def.rev ?? 1) : changed ? (prev.rev ?? 1) + 1 : (prev.rev ?? 1);

  const saved: ProbeDef = {
    id: def.id,
    label: def.label.trim(),
    scope,
    pattern: def.pattern,
    ...(def.emptyIf ? { emptyIf: def.emptyIf } : {}),
    ...(def.groupBy ? { groupBy: def.groupBy } : {}),
    enabled: def.enabled !== false,
    rev,
    builtin: BUILTINS.some((b) => b.id === def.id),
  };

  const entries = readConfig().filter((p) => p.id !== def.id);
  entries.push(saved);
  writeConfig(entries);
  return saved;
}

/**
 * Removes a user probe. Built-ins are not deletable — a shipped rule you do
 * not want is `enabled: false`, so it comes back when a later version fixes it
 * rather than vanishing from a list nothing can restore it to.
 * Hits are NOT deleted here; `runProbes` prunes orphans on its next pass.
 */
export function deleteProbe(id: string): ProbeDef {
  const probe = getProbe(id);
  if (!probe) throw new Error(t('probeconfig.error.unknownProbe', { id }));
  if (BUILTINS.some((b) => b.id === id)) {
    throw new Error(t('probeconfig.error.builtinUndeletable'));
  }
  writeConfig(readConfig().filter((p) => p.id !== id));
  return probe;
}
