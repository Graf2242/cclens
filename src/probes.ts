/**
 * The probe engine: run user regex rules over the logs, pin every find to the
 * agent run that produced it, and price it from the index.
 *
 * A probe is a grep that knows what it costs. `probeconfig.ts` owns the rules;
 * this file owns finding, storing and reporting. The whole design follows from
 * three measurements on a 1.1 GB corpus, and none of them is negotiable:
 *
 * 1. SCOPE IS THE PRODUCT. A naive grep for `=== AGENT_ERRORS ===` returns 4516
 *    lines. 4435 are the contract being QUOTED — in a system prompt, in a
 *    dispatch brief, in a rule file some agent happened to Read. Applying the
 *    same pattern to what agents actually RETURNED leaves 649. So the engine
 *    never searches "the log"; it searches one named slice of it, and the rule
 *    is required to say which.
 *
 * 2. `return` MEANS THE SUBAGENT'S OWN LAST WORD. The obvious place to look for
 *    an agent's answer is the `tool_result` the parent received — and it does
 *    not work: the parent's copy is truncated and reshaped, and zero of the
 *    real blocks survive there intact. Every one of the 649 was recoverable
 *    from the LAST non-empty assistant text block of the subagent's own file.
 *    That is why `return` is restricted to `kind === 'subagent'` and why it is
 *    resolved at end-of-file instead of line by line.
 *
 * 3. ONE PASS SERVES EVERY PROBE. The corpus is 2112 files and re-reading it
 *    once per rule turns a 1-2 minute scan into a 10-minute one for five rules.
 *    So the file is opened once, and each line is offered to whichever probes
 *    asked for a slice it belongs to. Ahead of that sits the cheap filter that
 *    actually pays for itself: `JSON.parse` is the expensive part, so a line is
 *    only parsed when it contains one of the literal substrings the active
 *    patterns cannot match without (see `literalOf`). Probes whose pattern has
 *    no such literal switch the file into parse-everything mode — correctness
 *    first, and the rule's author can see the cost in the scan time.
 *
 * What the probe buys over `grep` is the last column: a hit carries `agent_id`,
 * and `msgs` knows what that run was billed. Measured on this corpus, runs of
 * `pie-tools:test-writer` that returned a non-empty AGENT_ERRORS block cost
 * ~1.8x what the clean runs of the same agent cost. That comparison is what
 * `probeReport` exists to compute; everything above only makes it trustworthy.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { dayKey, METRIC_COLUMN, type Metric } from './db.ts';
import { DISPATCH_TOOLS, MAIN_AGENT, resultText } from './parse.ts';
import { listSessionFiles, projectsRoot, type SessionFile } from './paths.ts';
import { getProbe, enabledProbes, groupCount, listProbes, type ProbeDef } from './probeconfig.ts';
import { buildWhere, type Filters } from './queries.ts';

/** Tools whose arguments are a file being written — the `write` scope. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * What `parse.ts` calls a subagent turn whose line carried no `attributionAgent`
 * — the opening lines of a subagent file often do not. 35 runs in the corpus
 * carry BOTH this placeholder and their real name, so any aggregate that picks
 * one name per run has to prefer the real one or it loses the run to a phantom
 * agent (measured: 7 of 108 `pie-tools:test-writer` runs).
 */
const UNKNOWN_AGENT = 'unknown-agent';

/** Stored captures are for reading, not for re-matching; 1 KB is a screenful. */
const CAPTURE_LIMIT = 1000;
/** The preview panel shows less again — it is a "does my regex work" check. */
const PREVIEW_CAPTURE_LIMIT = 400;
/** A pathological pattern on a 200 KB text block must not hang the scan. */
const MAX_HITS_PER_TEXT = 200;
/**
 * How many end-of-file candidate lines to keep for the `return` resolution.
 * The cheap `"type":"assistant"` test has false positives (an agent quoting
 * JSONL back at us), so we keep a few and walk backwards until one parses as a
 * real assistant turn with text.
 */
const RETURN_RING = 12;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PROBE_SCHEMA = `
-- Which (probe, file) pairs have been scanned, and against which rule version.
-- 'rev' is why an edited rule invalidates exactly its own hits and nothing
-- else: the pair is re-scanned when the file changed OR the rule did.
CREATE TABLE IF NOT EXISTS probe_files (
  probe_id   TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  mtime      REAL    NOT NULL,
  size       INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  hits       INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (probe_id, path)
);

-- One row per match. 'agent_id' is the load-bearing column: it is the join key
-- to 'msgs', which is what turns a find into a number of dollars.
CREATE TABLE IF NOT EXISTS probe_hits (
  id         INTEGER PRIMARY KEY,
  probe_id   TEXT NOT NULL,
  file       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  project    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent      TEXT NOT NULL,
  agent_id   TEXT,
  kind       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  capture    TEXT,
  grp        TEXT,
  is_empty   INTEGER NOT NULL,
  chars      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS probe_hits_ts      ON probe_hits(probe_id, ts);
CREATE INDEX IF NOT EXISTS probe_hits_run     ON probe_hits(probe_id, agent_id);
CREATE INDEX IF NOT EXISTS probe_hits_session ON probe_hits(session_id);
CREATE INDEX IF NOT EXISTS probe_hits_file    ON probe_hits(probe_id, file);
`;

const ready = new WeakSet<DatabaseSync>();

/** Idempotent; every public entry point here calls it before touching a table. */
export function ensureProbeTables(db: DatabaseSync): void {
  if (ready.has(db)) return;
  db.exec(PROBE_SCHEMA);
  ready.add(db);
}

// ---------------------------------------------------------------------------
// Compiling a rule
// ---------------------------------------------------------------------------

interface CompiledProbe {
  def: ProbeDef;
  id: string;
  rev: number;
  re: RegExp;
  emptyRe: RegExp | null;
  groupRe: RegExp | null;
  /** Group 1 IS the capture when the pattern has one; otherwise the whole match. */
  hasGroup1: boolean;
  /** `tool_result:Bash` splits into base `tool_result` and tool `Bash`. */
  scopeBase: string;
  scopeTool: string | null;
  /** Longest mandatory literal, or null when the pattern forces a full parse. */
  literal: string | null;
}

export interface ProbeError {
  id: string;
  message: string;
}

/**
 * `m` is added when the pattern uses an anchor, because a rule written with
 * `^`/`$` almost always means "a line", not "the whole block" — the text a
 * probe sees is a multi-line block by construction. `emptyIf` deliberately does
 * NOT get it: "the block is empty" is a statement about the whole capture, and
 * with `m` any block containing a lone `<empty>` line would read as empty.
 */
function compileProbe(def: ProbeDef): CompiledProbe {
  const anchored = /(^|[^\\])[$^]/.test(def.pattern);
  const re = new RegExp(def.pattern, anchored ? 'gm' : 'g');
  const [scopeBase, scopeTool] = String(def.scope).split(':');
  return {
    def,
    id: def.id,
    rev: def.rev ?? 1,
    re,
    emptyRe: def.emptyIf ? new RegExp(def.emptyIf) : null,
    groupRe: def.groupBy ? new RegExp(def.groupBy) : null,
    hasGroup1: groupCount(def.pattern) >= 1,
    scopeBase,
    scopeTool: scopeTool ?? null,
    literal: literalOf(def.pattern),
  };
}

/**
 * The longest substring the pattern cannot match without — used to skip
 * `JSON.parse` on lines that cannot possibly hit.
 *
 * Only TOP-LEVEL runs count. A literal inside `(...)` may sit behind an
 * alternation (`(?:=== END X ===|$)`) and is therefore optional; requiring it
 * would silently drop real hits. A top-level `|` makes the whole pattern
 * alternative, so nothing is mandatory and we give up. Same for a run whose
 * last character is quantified away by `?`, `*` or `{0,…}`.
 *
 * The alphabet is restricted to ASCII letters, digits, space, `_`, `-` and `=`
 * for one reason: those are the characters JSON never escapes, so the literal
 * appears byte-for-byte in the raw log line we are testing against.
 */
export function literalOf(pattern: string): string | null {
  let best = '';
  let run = '';
  let depth = 0;
  let inClass = false;

  const flush = (): void => {
    if (run.length >= 4 && run.length > best.length) best = run;
    run = '';
  };

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (inClass) {
      if (c === '\\') i++;
      else if (c === ']') inClass = false;
      continue;
    }
    if (c === '\\') {
      flush();
      i++;
      continue;
    }
    if (c === '[') {
      flush();
      inClass = true;
      continue;
    }
    if (c === '(') {
      flush();
      depth++;
      continue;
    }
    if (c === ')') {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (c === '|') {
      // A top-level alternation means no substring is required at all.
      if (depth === 0) return null;
      flush();
      continue;
    }
    if (c === '?' || c === '*') {
      // The preceding character is optional, so it is not part of a literal.
      run = run.slice(0, -1);
      flush();
      continue;
    }
    if (c === '{') {
      run = run.slice(0, -1);
      flush();
      const close = pattern.indexOf('}', i);
      i = close === -1 ? pattern.length : close;
      continue;
    }
    if (depth > 0 || !/[A-Za-z0-9 _\-=]/.test(c)) {
      flush();
      continue;
    }
    run += c;
  }
  flush();
  return best.length >= 4 ? best : null;
}

// ---------------------------------------------------------------------------
// Per-file scan plan: what one pass over a file has to do
// ---------------------------------------------------------------------------

interface ScanPlan {
  probes: CompiledProbe[];
  /** Probes resolved at end-of-file from the subagent's last assistant text. */
  returnProbes: CompiledProbe[];
  /** Everything else — resolved line by line. */
  lineProbes: CompiledProbe[];
  /** Union of the literals; a line matching none of them is never parsed. */
  literals: string[];
  /** A probe with no derivable literal forces every line through `JSON.parse`. */
  parseAll: boolean;
  needAssistant: boolean;
  needThinking: boolean;
  needPrompt: boolean;
  needDispatch: boolean;
  needWrite: boolean;
  needToolResult: boolean;
  /** Tool names a narrowed `tool_result:X` probe asked for. */
  narrowedTools: string[];
}

function buildPlan(probes: CompiledProbe[]): ScanPlan {
  const plan: ScanPlan = {
    probes,
    returnProbes: probes.filter((p) => p.scopeBase === 'return'),
    lineProbes: probes.filter((p) => p.scopeBase !== 'return'),
    literals: [],
    parseAll: false,
    needAssistant: false,
    needThinking: false,
    needPrompt: false,
    needDispatch: false,
    needWrite: false,
    needToolResult: false,
    narrowedTools: [],
  };

  const tools = new Set<string>();
  const lits = new Set<string>();
  for (const p of plan.lineProbes) {
    if (p.literal) lits.add(p.literal);
    else plan.parseAll = true;

    switch (p.scopeBase) {
      case 'assistant': plan.needAssistant = true; break;
      case 'thinking': plan.needThinking = true; break;
      case 'prompt': plan.needPrompt = true; break;
      case 'dispatch': plan.needDispatch = true; break;
      case 'write': plan.needWrite = true; break;
      case 'tool_result':
        plan.needToolResult = true;
        if (p.scopeTool) tools.add(p.scopeTool);
        break;
      case 'any':
        plan.needAssistant = true;
        plan.needThinking = true;
        plan.needPrompt = true;
        plan.needDispatch = true;
        plan.needWrite = true;
        plan.needToolResult = true;
        break;
    }
  }
  plan.literals = [...lits];
  plan.narrowedTools = [...tools];
  return plan;
}

// ---------------------------------------------------------------------------
// Extracting the text a scope refers to
// ---------------------------------------------------------------------------

interface Piece {
  /** `assistant` | `thinking` | `prompt` | `dispatch` | `write` | `tool_result:<Tool>` */
  kind: string;
  text: string;
}

/**
 * Every slice of one log line that some active scope cares about.
 *
 * Claude Code writes one content block per line, so this normally yields at
 * most one piece — but a line carrying several blocks is legal and cheap to
 * support, so we walk the whole array.
 */
function collectPieces(o: any, plan: ScanPlan, toolNames: Map<string, string>, out: Piece[]): void {
  const message = o?.message;
  const content = message?.content;

  if (o?.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (plan.needAssistant && b.type === 'text' && typeof b.text === 'string') {
        out.push({ kind: 'assistant', text: b.text });
      } else if (plan.needThinking && b.type === 'thinking' && typeof b.thinking === 'string') {
        out.push({ kind: 'thinking', text: b.thinking });
      }
    }
  }

  // A human turn. `isSidechain` is what separates the user from a subagent's
  // synthesised opening prompt, and a tool_result is not a prompt at all — it
  // rides the same `type: 'user'` envelope but is machine output.
  if (plan.needPrompt && o?.type === 'user' && !o.isSidechain) {
    if (typeof content === 'string') {
      out.push({ kind: 'prompt', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
          out.push({ kind: 'prompt', text: b.text });
        }
      }
    }
  }

  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (plan.needDispatch && DISPATCH_TOOLS.has(name)) {
        out.push({ kind: 'dispatch', text: safeStringify(b.input) });
      }
      if (plan.needWrite && WRITE_TOOLS.has(name)) {
        out.push({ kind: 'write', text: safeStringify(b.input) });
      }
    } else if (plan.needToolResult && b.type === 'tool_result') {
      // The result block names no tool; only the `tool_use` that opened it did.
      // We remembered that mapping only for the tools a narrowed probe asked
      // about, so an unnarrowed probe sees an empty suffix and matches anyway.
      const name = (typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) : null) ?? '';
      out.push({ kind: 'tool_result:' + name, text: resultText(b.content) });
    }
  }
}

function pieceMatches(probe: CompiledProbe, kind: string): boolean {
  if (probe.scopeBase === 'any') return true;
  if (probe.scopeBase === 'tool_result') {
    if (!kind.startsWith('tool_result:')) return false;
    return probe.scopeTool == null || kind.slice('tool_result:'.length) === probe.scopeTool;
  }
  return kind === probe.scopeBase;
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** First non-empty assistant text of a parsed line — the `return` candidate. */
function assistantText(o: any): string | null {
  if (o?.type !== 'assistant') return null;
  const content = o.message?.content;
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface RawHit {
  probe: CompiledProbe;
  scope: string;
  capture: string;
  grp: string | null;
  isEmpty: number;
  chars: number;
}

/**
 * Apply one rule to one text block.
 *
 * A capture that is blank after trimming counts as empty whatever `emptyIf`
 * says: 71 of the 157 non-`<empty>` AGENT_ERRORS captures in the corpus were
 * literally whitespace, and reporting those as incidents is the same mistake
 * `emptyIf` exists to prevent.
 */
function matchText(probe: CompiledProbe, scope: string, text: string, out: RawHit[]): void {
  if (!text) return;
  probe.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = probe.re.exec(text)) !== null) {
    const capture = (probe.hasGroup1 ? m[1] : m[0]) ?? '';
    const trimmed = capture.trim();
    const isEmpty = trimmed === '' || (probe.emptyRe != null && probe.emptyRe.test(trimmed)) ? 1 : 0;

    let grp: string | null = null;
    if (probe.groupRe) {
      probe.groupRe.lastIndex = 0;
      grp = probe.groupRe.exec(capture)?.[1] ?? null;
    }

    out.push({ probe, scope, capture, grp, isEmpty, chars: capture.length });

    // A zero-width match would spin `exec` forever on the same index.
    if (m[0].length === 0) probe.re.lastIndex++;
    if (++found >= MAX_HITS_PER_TEXT) break;
  }
}

// ---------------------------------------------------------------------------
// One pass over one file
// ---------------------------------------------------------------------------

interface FileHit extends RawHit {
  ts: number;
  agent: string;
  agentId: string | null;
}

/**
 * Read a file once and produce every hit every probe in the plan would make.
 *
 * The two cheap string tests before `JSON.parse` are the whole performance
 * story: `includes` over a 500 KB file costs microseconds, parsing its ~2000
 * lines costs tens of milliseconds, and most lines can never match anything.
 */
function scanFile(f: SessionFile, plan: ScanPlan): FileHit[] {
  const hits: FileHit[] = [];
  let body: string;
  try {
    body = fs.readFileSync(f.file, 'utf8');
  } catch {
    return hits;
  }

  const wantReturn = plan.returnProbes.length > 0 && f.kind === 'subagent';
  const wantLines = plan.lineProbes.length > 0;
  if (!wantReturn && !wantLines) return hits;

  // Markers a narrowed `tool_result:X` probe needs: only tool_use lines naming
  // X have to be parsed, and only to learn their id.
  const toolMarkers = plan.narrowedTools.map((t) => '"name":"' + t + '"');
  const toolNames = new Map<string, string>();

  let agent = f.kind === 'subagent' ? 'unknown-agent' : MAIN_AGENT;
  let agentId: string | null = null;
  let agentResolved = f.kind !== 'subagent';
  let lastTs = f.mtimeMs;
  const ring: string[] = [];
  const pieces: Piece[] = [];

  for (const line of body.split('\n')) {
    if (line.length < 2) continue;

    // `return` candidates: cheap shape test now, parse at most RETURN_RING of
    // them at the end. The last assistant text of the file is not knowable
    // until the file ends, so this cannot be decided in the loop.
    if (wantReturn && line.includes('"type":"assistant"') && line.includes('"type":"text"')) {
      ring.push(line);
      if (ring.length > RETURN_RING) ring.shift();
    }

    if (!wantLines) continue;

    let parse = plan.parseAll;
    if (!parse) {
      for (const lit of plan.literals) {
        if (line.includes(lit)) { parse = true; break; }
      }
    }
    let forTools = false;
    if (!parse && toolMarkers.length && line.includes('"tool_use"')) {
      for (const marker of toolMarkers) {
        if (line.includes(marker)) { forTools = true; break; }
      }
    }
    // The agent name lives on the envelope, not in the text; one parse per file
    // is enough because a subagent file belongs to exactly one run.
    const forAgent = !agentResolved && line.includes('"attributionAgent"');
    if (!parse && !forTools && !forAgent) continue;

    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a half-written tail line on a session still being appended to
    }

    if (typeof o.attributionAgent === 'string') {
      agent = o.attributionAgent;
      agentResolved = true;
    }
    if (typeof o.agentId === 'string') agentId = o.agentId;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) lastTs = ts;

    if (toolMarkers.length && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b && typeof b === 'object' && b.type === 'tool_use' && typeof b.id === 'string') {
          if (plan.narrowedTools.includes(b.name)) toolNames.set(b.id, b.name);
        }
      }
    }
    if (!parse) continue;

    pieces.length = 0;
    collectPieces(o, plan, toolNames, pieces);
    if (!pieces.length) continue;

    const at = Number.isFinite(ts) ? ts : lastTs;
    const raw: RawHit[] = [];
    for (const piece of pieces) {
      for (const probe of plan.lineProbes) {
        if (!pieceMatches(probe, piece.kind)) continue;
        matchText(probe, piece.kind, piece.text, raw);
      }
    }
    for (const r of raw) hits.push({ ...r, ts: at, agent, agentId });
  }

  // --- the `return` slice, resolved now that the file has ended -------------
  if (wantReturn && ring.length) {
    for (let i = ring.length - 1; i >= 0; i--) {
      let o: any;
      try {
        o = JSON.parse(ring[i]);
      } catch {
        continue;
      }
      const text = assistantText(o);
      if (!text) continue;
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      const at = Number.isFinite(ts) ? ts : lastTs;
      const a = typeof o.attributionAgent === 'string' ? o.attributionAgent : agent;
      const aid = typeof o.agentId === 'string' ? o.agentId : agentId;
      const raw: RawHit[] = [];
      for (const probe of plan.returnProbes) matchText(probe, 'return', text, raw);
      for (const r of raw) hits.push({ ...r, ts: at, agent: a, agentId: aid });
      break;
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// runProbes
// ---------------------------------------------------------------------------

export interface ProbeRunProgress {
  scanned: number;
  total: number;
  file: string;
  hits: number;
}

export interface ProbeRunResult {
  probes: number;
  files: number;
  scanned: number;
  hits: number;
  elapsedMs: number;
  /** Rules that would not compile — skipped, never fatal. */
  errors: ProbeError[];
}

/**
 * Scan the corpus and store every hit.
 *
 * Incremental on (mtime, size) AND on the rule's `rev`, per (probe, file) pair.
 * A file none of the probes needs is never opened — which is what makes the
 * second run of a 2100-file corpus take a second instead of a minute.
 */
export async function runProbes(
  db: DatabaseSync,
  opts: {
    root?: string;
    probes?: ProbeDef[];
    force?: boolean;
    onProgress?: (p: ProbeRunProgress) => void;
  } = {}
): Promise<ProbeRunResult> {
  ensureProbeTables(db);
  const started = Date.now();

  const errors: ProbeError[] = [];
  const compiled: CompiledProbe[] = [];
  for (const def of opts.probes ?? enabledProbes()) {
    try {
      compiled.push(compileProbe(def));
    } catch (err) {
      errors.push({ id: def.id, message: (err as Error).message });
    }
  }

  const files = listSessionFiles(opts.root ?? projectsRoot());

  // Prior state, keyed "<probeId>|<path>" — probe ids are kebab-case, so the
  // separator is unambiguous without resorting to a control character.
  const known = new Map<string, { mtime: number; size: number; rev: number }>();
  for (const r of db.prepare('SELECT probe_id, path, mtime, size, rev FROM probe_files').all() as any[]) {
    known.set(`${r.probe_id}|${r.path}`, {
      mtime: Number(r.mtime),
      size: Number(r.size),
      rev: Number(r.rev),
    });
  }

  const insertHit = db.prepare(`
    INSERT INTO probe_hits (probe_id, file, ts, day, project, session_id, agent, agent_id,
                            kind, scope, capture, grp, is_empty, chars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clearHits = db.prepare('DELETE FROM probe_hits WHERE probe_id = ? AND file = ?');
  const upsertFile = db.prepare(`
    INSERT INTO probe_files (probe_id, path, mtime, size, rev, hits, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(probe_id, path) DO UPDATE SET
      mtime = excluded.mtime, size = excluded.size, rev = excluded.rev,
      hits = excluded.hits, scanned_at = excluded.scanned_at
  `);

  // One plan per distinct probe subset; most files need the same subset, so
  // this is built two or three times for a whole corpus.
  const plans = new Map<string, ScanPlan>();
  let scanned = 0;
  let touched = 0;
  let totalHits = 0;

  for (const f of files) {
    scanned++;
    const due = compiled.filter((p) => {
      if (opts.force) return true;
      const prev = known.get(`${p.id}|${f.file}`);
      return !prev || prev.mtime !== f.mtimeMs || prev.size !== f.size || prev.rev !== p.rev;
    });
    opts.onProgress?.({ scanned, total: files.length, file: f.file, hits: totalHits });
    if (!due.length) continue;
    touched++;

    const key = due.map((p) => p.id).join(',');
    let plan = plans.get(key);
    if (!plan) plans.set(key, (plan = buildPlan(due)));

    const hits = scanFile(f, plan);
    const perProbe = new Map<string, number>();
    for (const p of due) perProbe.set(p.id, 0);
    for (const h of hits) perProbe.set(h.probe.id, (perProbe.get(h.probe.id) ?? 0) + 1);

    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const p of due) clearHits.run(p.id, f.file);
      for (const h of hits) {
        insertHit.run(
          h.probe.id,
          f.file,
          h.ts,
          dayKey(h.ts),
          f.project,
          f.sessionId,
          h.agent,
          h.agentId,
          f.kind,
          h.scope,
          h.capture.slice(0, CAPTURE_LIMIT),
          h.grp,
          h.isEmpty,
          h.chars
        );
      }
      for (const p of due) {
        upsertFile.run(p.id, f.file, f.mtimeMs, f.size, p.rev, perProbe.get(p.id) ?? 0, now);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    totalHits += hits.length;
  }

  // Files gone from disk take their hits with them, as do probes that were
  // deleted from the config while their rows stayed behind.
  const onDisk = new Set(files.map((f) => f.file));
  const liveIds = new Set(listProbes().map((p) => p.id));
  const seenPaths = new Set<string>();
  for (const key of known.keys()) {
    const cut = key.indexOf('|');
    const probeId = key.slice(0, cut);
    const p = key.slice(cut + 1);
    if (!onDisk.has(p) && !seenPaths.has(p)) {
      seenPaths.add(p);
      db.prepare('DELETE FROM probe_hits WHERE file = ?').run(p);
      db.prepare('DELETE FROM probe_files WHERE path = ?').run(p);
    }
    if (!liveIds.has(probeId)) {
      db.prepare('DELETE FROM probe_hits WHERE probe_id = ?').run(probeId);
      db.prepare('DELETE FROM probe_files WHERE probe_id = ?').run(probeId);
    }
  }

  return {
    probes: compiled.length,
    files: files.length,
    scanned: touched,
    hits: totalHits,
    elapsedMs: Date.now() - started,
    errors,
  };
}

// ---------------------------------------------------------------------------
// previewProbe
// ---------------------------------------------------------------------------

export interface PreviewHit {
  capture: string;
  agent: string;
  sessionId: string;
  ts: number;
  isEmpty: boolean;
  grp: string | null;
  /** Basename only — the editor shows where, not a path to open. */
  file: string;
}

export interface PreviewResult {
  hits: PreviewHit[];
  scanned: number;
  matched: number;
  empty: number;
  elapsedMs: number;
}

/**
 * Dry-run one rule over the most recent files and show what it would catch.
 *
 * Nothing is written: this is the "проверить" button in the rule editor, and a
 * half-tuned regex must not be able to leave rows behind. Recency is the right
 * sample because a rule is almost always written about something that just
 * happened.
 */
export async function previewProbe(
  db: DatabaseSync,
  def: ProbeDef,
  opts: { root?: string; files?: number; limit?: number } = {}
): Promise<PreviewResult> {
  ensureProbeTables(db);
  const started = Date.now();
  const limit = opts.limit ?? 20;

  const probe = compileProbe(def); // an invalid pattern throws to the caller here
  const plan = buildPlan([probe]);
  const files = listSessionFiles(opts.root ?? projectsRoot())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.files ?? 300);

  const hits: PreviewHit[] = [];
  let matched = 0;
  let empty = 0;

  for (const f of files) {
    for (const h of scanFile(f, plan)) {
      matched++;
      if (h.isEmpty) empty++;
      if (hits.length < limit) {
        hits.push({
          capture: h.capture.slice(0, PREVIEW_CAPTURE_LIMIT),
          agent: h.agent,
          sessionId: f.sessionId,
          ts: h.ts,
          isEmpty: h.isEmpty === 1,
          grp: h.grp,
          file: path.basename(f.file),
        });
      }
    }
  }

  return { hits, scanned: files.length, matched, empty, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// probeReport
// ---------------------------------------------------------------------------

export interface ProbeAgentRow {
  agent: string;
  flaggedRuns: number;
  flaggedUsd: number;
  flaggedWeighted: number;
  flaggedValue: number;
  flaggedAvgUsd: number;
  flaggedAvgWeighted: number;
  flaggedAvgValue: number;
  flaggedAvgTurns: number;
  otherRuns: number;
  otherUsd: number;
  otherWeighted: number;
  otherValue: number;
  otherAvgUsd: number;
  otherAvgWeighted: number;
  otherAvgValue: number;
  otherAvgTurns: number;
  /** flaggedAvg / otherAvg — null when the agent has no clean run to compare to. */
  ratio: number | null;
  ratioWeighted: number | null;
  ratioValue: number | null;
}

export interface ProbeGroupRow {
  grp: string;
  hits: number;
  runs: number;
  usd: number;
  weighted: number;
  value: number;
}

export interface ProbeSample {
  capture: string;
  agent: string;
  agentId: string | null;
  sessionId: string;
  ts: number;
  project: string;
  grp: string | null;
}

export interface ProbeReport {
  probe: ProbeDef | null;
  totals: {
    hits: number;
    nonEmpty: number;
    empty: number;
    runsFlagged: number;
    sessions: number;
    usdInFlagged: number;
    weightedInFlagged: number;
    valueInFlagged: number;
  };
  byAgent: ProbeAgentRow[];
  byGroup: ProbeGroupRow[];
  byDay: { day: string; hits: number; nonEmpty: number }[];
  samples: ProbeSample[];
}

/** Runs of `msgs` in the window, keyed by `agent_id`. */
interface RunCost {
  agent: string;
  usd: number;
  weighted: number;
  value: number;
  turns: number;
}

/**
 * The report the whole engine exists for: what the flagged runs cost against
 * what the same agent's clean runs cost.
 *
 * "Other" is deliberately the SAME agent, not the corpus average — comparing a
 * flagged `test-writer` to a global mean would mostly measure that test-writers
 * are expensive, which we already knew. Comparing it to a clean test-writer
 * measures the block.
 */
export function probeReport(
  db: DatabaseSync,
  probeId: string,
  filters: Filters,
  metric: Metric
): ProbeReport {
  ensureProbeTables(db);
  const col = METRIC_COLUMN[metric];

  // `probe_hits` carries no model, so a model filter is silently dropped rather
  // than crashing the query. Everything else in `Filters` has a column here.
  const hitWhere = buildWhere({ ...filters, model: undefined });
  const msgWhere = buildWhere(filters);

  const totalsRow = db
    .prepare(
      `SELECT count(*) AS hits,
              sum(CASE WHEN m.is_empty = 0 THEN 1 ELSE 0 END) AS non_empty,
              count(DISTINCT m.session_id) AS sessions
       FROM probe_hits m
       ${hitWhere.sql ? hitWhere.sql + ' AND' : 'WHERE'} m.probe_id = ?`
    )
    .get(...hitWhere.params, probeId) as any;

  const flaggedIds = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT DISTINCT m.agent_id AS aid
       FROM probe_hits m
       ${hitWhere.sql ? hitWhere.sql + ' AND' : 'WHERE'} m.probe_id = ? AND m.is_empty = 0
        AND m.agent_id IS NOT NULL`
    )
    .all(...hitWhere.params, probeId) as any[]) {
    flaggedIds.add(String(r.aid));
  }

  // Every subagent run in the window with its price. One `agent_id` is one run.
  const runs = new Map<string, RunCost>();
  for (const r of db
    .prepare(
      `SELECT m.agent_id AS aid,
              coalesce(max(CASE WHEN m.agent <> ? THEN m.agent END), ?) AS agent,
              sum(m.usd) AS usd, sum(m.weighted) AS weighted, sum(${col}) AS value,
              count(*) AS turns
       FROM msgs m
       ${msgWhere.sql ? msgWhere.sql + ' AND' : 'WHERE'} m.agent_id IS NOT NULL
       GROUP BY m.agent_id`
    )
    .all(UNKNOWN_AGENT, UNKNOWN_AGENT, ...msgWhere.params) as any[]) {
    runs.set(String(r.aid), {
      agent: String(r.agent),
      usd: Number(r.usd ?? 0),
      weighted: Number(r.weighted ?? 0),
      value: Number(r.value ?? 0),
      turns: Number(r.turns ?? 0),
    });
  }

  interface Side {
    runs: number;
    usd: number;
    weighted: number;
    value: number;
    turns: number;
  }
  const zero = (): Side => ({ runs: 0, usd: 0, weighted: 0, value: 0, turns: 0 });
  const split = new Map<string, { flagged: Side; other: Side }>();
  let usdInFlagged = 0;
  let weightedInFlagged = 0;
  let valueInFlagged = 0;

  for (const [aid, run] of runs) {
    let row = split.get(run.agent);
    if (!row) split.set(run.agent, (row = { flagged: zero(), other: zero() }));
    const isFlagged = flaggedIds.has(aid);
    const side = isFlagged ? row.flagged : row.other;
    side.runs++;
    side.usd += run.usd;
    side.weighted += run.weighted;
    side.value += run.value;
    side.turns += run.turns;
    if (isFlagged) {
      usdInFlagged += run.usd;
      weightedInFlagged += run.weighted;
      valueInFlagged += run.value;
    }
  }

  const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
  const avg = (n: number, d: number): number => (d > 0 ? n / d : 0);

  const byAgent: ProbeAgentRow[] = [];
  for (const [agent, s] of split) {
    if (!s.flagged.runs) continue; // an agent with no flagged run is not in this report
    const fAvgUsd = avg(s.flagged.usd, s.flagged.runs);
    const fAvgW = avg(s.flagged.weighted, s.flagged.runs);
    const fAvgV = avg(s.flagged.value, s.flagged.runs);
    const oAvgUsd = avg(s.other.usd, s.other.runs);
    const oAvgW = avg(s.other.weighted, s.other.runs);
    const oAvgV = avg(s.other.value, s.other.runs);
    byAgent.push({
      agent,
      flaggedRuns: s.flagged.runs,
      flaggedUsd: s.flagged.usd,
      flaggedWeighted: s.flagged.weighted,
      flaggedValue: s.flagged.value,
      flaggedAvgUsd: fAvgUsd,
      flaggedAvgWeighted: fAvgW,
      flaggedAvgValue: fAvgV,
      flaggedAvgTurns: avg(s.flagged.turns, s.flagged.runs),
      otherRuns: s.other.runs,
      otherUsd: s.other.usd,
      otherWeighted: s.other.weighted,
      otherValue: s.other.value,
      otherAvgUsd: oAvgUsd,
      otherAvgWeighted: oAvgW,
      otherAvgValue: oAvgV,
      otherAvgTurns: avg(s.other.turns, s.other.runs),
      ratio: ratio(fAvgUsd, oAvgUsd),
      ratioWeighted: ratio(fAvgW, oAvgW),
      ratioValue: ratio(fAvgV, oAvgV),
    });
  }
  byAgent.sort((a, b) => b.flaggedUsd - a.flaggedUsd);

  // --- breakdown by the rule's own groupBy ---------------------------------
  const probe = getProbe(probeId);
  const byGroup: ProbeGroupRow[] = [];
  if (probe?.groupBy) {
    const counts = new Map<string, { hits: number; ids: Set<string> }>();
    for (const r of db
      .prepare(
        `SELECT m.grp AS grp, m.agent_id AS aid, count(*) AS hits
         FROM probe_hits m
         ${hitWhere.sql ? hitWhere.sql + ' AND' : 'WHERE'} m.probe_id = ? AND m.is_empty = 0
          AND m.grp IS NOT NULL
         GROUP BY m.grp, m.agent_id`
      )
      .all(...hitWhere.params, probeId) as any[]) {
      const key = String(r.grp);
      let c = counts.get(key);
      if (!c) counts.set(key, (c = { hits: 0, ids: new Set<string>() }));
      c.hits += Number(r.hits ?? 0);
      if (r.aid != null) c.ids.add(String(r.aid));
    }
    for (const [grp, c] of counts) {
      let usd = 0, weighted = 0, value = 0;
      for (const aid of c.ids) {
        const run = runs.get(aid);
        if (!run) continue;
        usd += run.usd;
        weighted += run.weighted;
        value += run.value;
      }
      byGroup.push({ grp, hits: c.hits, runs: c.ids.size, usd, weighted, value });
    }
    byGroup.sort((a, b) => b.hits - a.hits);
  }

  const byDay = (
    db
      .prepare(
        `SELECT m.day AS day, count(*) AS hits,
                sum(CASE WHEN m.is_empty = 0 THEN 1 ELSE 0 END) AS non_empty
         FROM probe_hits m
         ${hitWhere.sql ? hitWhere.sql + ' AND' : 'WHERE'} m.probe_id = ?
         GROUP BY m.day ORDER BY m.day ASC`
      )
      .all(...hitWhere.params, probeId) as any[]
  ).map((r) => ({ day: String(r.day), hits: Number(r.hits ?? 0), nonEmpty: Number(r.non_empty ?? 0) }));

  const samples = (
    db
      .prepare(
        `SELECT m.capture, m.agent, m.agent_id, m.session_id, m.ts, m.project, m.grp
         FROM probe_hits m
         ${hitWhere.sql ? hitWhere.sql + ' AND' : 'WHERE'} m.probe_id = ? AND m.is_empty = 0
         ORDER BY m.ts DESC LIMIT 50`
      )
      .all(...hitWhere.params, probeId) as any[]
  ).map((r) => ({
    capture: String(r.capture ?? '').slice(0, PREVIEW_CAPTURE_LIMIT),
    agent: String(r.agent),
    agentId: r.agent_id ?? null,
    sessionId: String(r.session_id),
    ts: Number(r.ts),
    project: String(r.project),
    grp: r.grp ?? null,
  }));

  const hits = Number(totalsRow?.hits ?? 0);
  const nonEmpty = Number(totalsRow?.non_empty ?? 0);

  return {
    probe,
    totals: {
      hits,
      nonEmpty,
      empty: hits - nonEmpty,
      runsFlagged: flaggedIds.size,
      sessions: Number(totalsRow?.sessions ?? 0),
      usdInFlagged,
      weightedInFlagged,
      valueInFlagged,
    },
    byAgent,
    byGroup,
    byDay,
    samples,
  };
}

// ---------------------------------------------------------------------------
// probeFlags / probeStatus — what the rest of the UI needs
// ---------------------------------------------------------------------------

export interface ProbeFlag {
  probeId: string;
  label: string;
  hits: number;
}

/**
 * Which runs of one session tripped which probe, keyed by `agent_id`.
 *
 * Empty hits are excluded on purpose: a run that emitted the block correctly
 * with nothing in it did nothing wrong, and badging it would train the reader
 * to ignore the badge.
 */
export function probeFlags(db: DatabaseSync, sessionId: string): Record<string, ProbeFlag[]> {
  ensureProbeTables(db);
  const labels = new Map(listProbes().map((p) => [p.id, p.label]));
  const out: Record<string, ProbeFlag[]> = {};

  for (const r of db
    .prepare(
      `SELECT agent_id AS aid, probe_id, count(*) AS hits
       FROM probe_hits
       WHERE session_id = ? AND is_empty = 0 AND agent_id IS NOT NULL
       GROUP BY agent_id, probe_id`
    )
    .all(sessionId) as any[]) {
    const aid = String(r.aid);
    const id = String(r.probe_id);
    (out[aid] ??= []).push({ probeId: id, label: labels.get(id) ?? id, hits: Number(r.hits ?? 0) });
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.hits - a.hits);
  return out;
}

export interface ProbeStatusRow {
  id: string;
  label: string;
  enabled: boolean;
  rev: number;
  files: number;
  hits: number;
  nonEmpty: number;
  scannedAt: number | null;
  /** No file has been scanned at the current `rev` — the rule needs a run. */
  stale: boolean;
}

/**
 * Coverage of each rule: how much of the corpus its stored hits actually
 * describe. `stale` is the honest answer to "can I trust this report" — after
 * an edit `saveProbe` bumps `rev`, and until a scan catches up the numbers on
 * screen were produced by a rule that no longer exists.
 */
export function probeStatus(db: DatabaseSync, probes?: ProbeDef[]): ProbeStatusRow[] {
  ensureProbeTables(db);
  const defs = probes ?? listProbes();

  const files = db.prepare(
    `SELECT count(*) AS n, sum(hits) AS hits, max(scanned_at) AS at,
            sum(CASE WHEN rev = ? THEN 1 ELSE 0 END) AS current
     FROM probe_files WHERE probe_id = ?`
  );
  const nonEmpty = db.prepare(
    'SELECT count(*) AS n FROM probe_hits WHERE probe_id = ? AND is_empty = 0'
  );

  return defs.map((def) => {
    const rev = def.rev ?? 1;
    const f = files.get(rev, def.id) as any;
    const ne = nonEmpty.get(def.id) as any;
    return {
      id: def.id,
      label: def.label,
      enabled: def.enabled !== false,
      rev,
      files: Number(f?.n ?? 0),
      hits: Number(f?.hits ?? 0),
      nonEmpty: Number(ne?.n ?? 0),
      scannedAt: f?.at != null ? Number(f.at) : null,
      stale: Number(f?.current ?? 0) === 0,
    };
  });
}
