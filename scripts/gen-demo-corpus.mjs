/**
 * Synthetic Claude Code corpus for burnlens README screenshots.
 * Writes a projects tree of fabricated sessions — no real logs are touched.
 *
 * Deterministic: a seeded PRNG, fixed base date, so re-running reproduces the
 * same numbers and the screenshots stay stable.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: gen-demo.mjs <projects-root>');
fs.rmSync(ROOT, { recursive: true, force: true });

// ---- deterministic randomness ---------------------------------------------
let seed = 20260815;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const OPUS = 'claude-opus-4-6-20260210';
const SONNET = 'claude-sonnet-4-6-20260115';
const HAIKU = 'claude-haiku-4-5-20251001';

const BASE = Date.parse('2026-08-03T09:00:00Z');
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString();

let uuidN = 0;
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const uuid = () => {
  uuidN++;
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
};
let msgN = 0;
const msgId = () => `msg_01Demo${(++msgN).toString(36).padStart(6, '0')}`;

// ---- corpus shape ----------------------------------------------------------
const PROJECTS = [
  { dir: '-Users-dev-work-orbit-api', cwd: '/Users/dev/work/orbit-api', branch: 'main' },
  { dir: '-Users-dev-work-atlas-web', cwd: '/Users/dev/work/atlas-web', branch: 'feat/checkout' },
  { dir: '-Users-dev-work-ledger-svc', cwd: '/Users/dev/work/ledger-svc', branch: 'main' },
  { dir: '-Users-dev-lab-notebooks', cwd: '/Users/dev/lab/notebooks', branch: 'main' },
];

const SUBAGENTS = [
  'test-writer', 'code-reviewer', 'scout', 'migrator',
  'doc-writer', 'general-purpose', 'perf-analyst',
];

const FILES = [
  'src/server/router.ts', 'src/server/auth.ts', 'src/db/schema.sql',
  'docs/architecture.md', 'docs/conventions.md', 'src/client/checkout.tsx',
  'tests/helpers/fixtures.ts', 'package.json', 'src/db/migrations/014_orders.sql',
];

// The document every fan-out sibling re-reads — the cohort headline.
const SHARED_DOC = 'docs/architecture.md';
const SHARED_DOC_CHARS = 41_000;

// ---- line builders ---------------------------------------------------------
const lines = new Map(); // file path -> array of json lines

function emit(file, obj) {
  if (!lines.has(file)) lines.set(file, []);
  lines.get(file).push(JSON.stringify(obj));
}

function userLine(file, { ts, cwd, branch, sessionId, text, parent }) {
  emit(file, {
    type: 'user', uuid: uuid(), parentUuid: parent ?? null, timestamp: iso(ts),
    sessionId, cwd, gitBranch: branch, version: '2.1.14',
    message: { role: 'user', content: text },
  });
}

/**
 * One assistant turn, written the way Claude Code writes it: one line per
 * content block, every line repeating message.usage, output_tokens only true
 * on the last. That shape is exactly what the parser is built to survive.
 */
function assistantTurn(file, o) {
  const {
    ts, cwd, branch, sessionId, model, agent, agentId, effort,
    text, toolUses = [], usage, stopReason = 'end_turn', extra = {},
  } = o;
  const id = msgId();
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const t of toolUses) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });

  blocks.forEach((block, i) => {
    const last = i === blocks.length - 1;
    const u = { ...usage };
    if (!last) u.output_tokens = Math.max(1, Math.round(usage.output_tokens * (0.2 + 0.5 * (i / blocks.length))));
    emit(file, {
      type: 'assistant', uuid: uuid(), timestamp: iso(ts), sessionId, cwd, gitBranch: branch,
      ...(agent ? { attributionAgent: agent } : {}),
      ...(agentId ? { agentId } : {}),
      ...(effort ? { effort } : {}),
      ...extra,
      message: {
        id, role: 'assistant', model, type: 'message',
        content: [block],
        ...(last ? { stop_reason: stopReason } : {}),
        usage: u,
      },
    });
  });
  return id;
}

function toolResults(file, o) {
  const { ts, cwd, branch, sessionId, results } = o;
  emit(file, {
    type: 'user', uuid: uuid(), timestamp: iso(ts), sessionId, cwd, gitBranch: branch,
    message: {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result', tool_use_id: r.id,
        ...(r.isError ? { is_error: true } : {}),
        content: [{ type: 'text', text: r.text }],
      })),
    },
  });
}

const usage = ({ input = 4, output = 600, read = 0, w5m = 0, w1h = 0 }) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: w5m + w1h,
  cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h },
});

/**
 * Body of a file, deterministic in its path: the same document read by thirty
 * agents must be byte-identical, or the cohort's content hashing has nothing
 * to collapse. A path-seeded PRNG picks lines from a fixed vocabulary.
 */
const LINE_POOL = [
  'export async function createOrder(input: OrderInput): Promise<Order> {',
  '  const tx = await db.begin();',
  '  if (!input.customerId) throw new ValidationError("customerId is required");',
  '  const total = items.reduce((acc, i) => acc + i.price * i.qty, 0);',
  '  await tx.commit();',
  '}',
  '',
  '/** Guest checkout has no customer row yet, so the ledger entry is deferred. */',
  'const RETRY_BACKOFF_MS = [100, 400, 1600];',
  'type OrderState = "draft" | "placed" | "settled" | "refunded";',
  'describe("orders", () => {',
  '  it("rejects a guest checkout without an email", async () => {',
  '    await expect(createOrder({ ...base, email: null })).rejects.toThrow();',
  '  });',
  '});',
  'CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);',
  'ALTER TABLE orders ADD COLUMN settled_at timestamptz;',
  '- Every write goes through the ledger; nothing mutates a balance directly.',
  '- Reconciliation runs nightly and is idempotent by (order_id, attempt).',
  '- A migration is reversible or it does not ship.',
  'The checkout form keeps its own validation state and syncs on blur.',
];

const strHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

const bodyCache = new Map();
function bodyFor(key, chars) {
  const ck = `${key}::${chars}`;
  const hit = bodyCache.get(ck);
  if (hit) return hit;
  let s = strHash(key);
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  let len = 0;
  while (len < chars) {
    const line = LINE_POOL[Math.floor(next() * LINE_POOL.length)];
    out.push(line);
    len += line.length + 1;
  }
  const text = out.join('\n').slice(0, Math.max(0, chars));
  bodyCache.set(ck, text);
  return text;
}

/** Anonymous padding where the content itself carries no meaning. */
const filler = (n) => bodyFor('pad', n);

/** A body that a probe can match, so the Probes screen has something real. */
const agentReturn = (empty) =>
  empty
    ? '=== AGENT_ERRORS ===\n<empty>\n=== END AGENT_ERRORS ==='
    : `=== AGENT_ERRORS ===\nclass: ${pick(['partial-result', 'contract-violation', 'tool-failure'])}\nthe fixture helper does not expose a seeded clock; wrote the test against wall time\n=== END AGENT_ERRORS ===`;

// ---- one subagent run ------------------------------------------------------
function subagentRun(o) {
  const {
    projectDir, cwd, branch, sessionId, agent, wfId, startTs,
    turns, model, readsShared, expensive, failing,
  } = o;
  const runId = `agt_${hex(12)}`;
  const dir = wfId
    ? path.join(ROOT, projectDir, sessionId, 'subagents', 'workflows', wfId)
    : path.join(ROOT, projectDir, sessionId, 'subagents');
  const file = path.join(dir, `${runId}.jsonl`);

  let ts = startTs;
  let ctx = 16_800; // system prompt + tool schemas + the agent's own brief
  const common = { cwd, branch, sessionId, model, agent, agentId: runId };

  userLine(file, { ...common, ts, text: `Write the missing tests for ${pick(FILES)}.`, parent: null });

  // First turn: some siblings read a warm neighbour prefix, some write it cold.
  const warm = rnd() < 0.68;
  const firstTu = `tu_${uuid()}`;
  assistantTurn(file, {
    ...common, ts, text: 'Reading the conventions first.',
    toolUses: [{ id: firstTu, name: 'Read', input: { file_path: 'docs/conventions.md' } }],
    usage: usage(warm ? { read: 12_000, w5m: 4_800, output: 320 } : { w5m: ctx, output: 340 }),
  });
  toolResults(file, {
    ...common, ts: ts + 4000,
    results: [{ id: firstTu, text: bodyFor('docs/conventions.md', 7400) }],
  });

  for (let t = 2; t <= turns; t++) {
    ts += int(20_000, 90_000);
    const isSharedRead = readsShared && t === 2;
    const target = isSharedRead ? SHARED_DOC : pick(FILES);
    const resultChars = isSharedRead ? SHARED_DOC_CHARS : int(1200, 9000);
    const tuId = `tu_${uuid()}`;
    const tool = t === turns ? 'Write' : pick(['Read', 'Read', 'Grep', 'Edit', 'Bash']);

    const grew = Math.round(resultChars / 2.4);
    ctx += grew;

    // One deliberate cache miss mid-run: a pause outlives the 5m TTL.
    const miss = expensive && t === Math.floor(turns / 2);
    if (miss) ts += 14 * 60_000;

    assistantTurn(file, {
      ...common, ts,
      text: t === turns ? agentReturn(rnd() < 0.86) : null,
      toolUses: t === turns ? [] : [{
        id: tuId, name: tool,
        input: tool === 'Bash'
          ? { command: 'npm test -- --run tests/orders.spec.ts' }
          : tool === 'Grep'
            ? { pattern: 'seededClock', path: 'tests/' }
            : { file_path: target, ...(tool === 'Read' ? { offset: 1, limit: 400 } : {}) },
      }],
      usage: usage(
        miss
          ? { read: 0, w5m: ctx, output: int(700, 1500) }
          : { read: ctx, w5m: grew, output: int(400, 1800) }
      ),
      stopReason: t === turns ? 'end_turn' : 'tool_use',
    });

    if (t < turns) {
      const isError = failing && t === turns - 1;
      toolResults(file, {
        ...common, ts: ts + int(2000, 9000),
        results: [{
          id: tuId,
          isError,
          text: isError
            ? 'Error: ENOENT: no such file or directory, open \'tests/helpers/fixtures.ts\''
            : bodyFor(
                tool === 'Bash' ? 'bash:npm test' : tool === 'Grep' ? 'grep:seededClock' : target,
                resultChars
              ),
        }],
      });
    }
  }
  return { file, runId, endTs: ts };
}

// ---- one session -----------------------------------------------------------
function session(o) {
  const { project, dayOffset, hour, prompt, fanout, fanoutAgent, turns, wf, extras = {} } = o;
  const sessionId = uuid();
  const cwd = project.cwd, branch = project.branch, projectDir = project.dir;
  const file = path.join(ROOT, projectDir, `${sessionId}.jsonl`);
  let ts = BASE + dayOffset * DAY + hour * 3_600_000;
  const common = { cwd, branch, sessionId, model: OPUS, agentId: null };

  userLine(file, { ...common, ts, text: prompt, parent: null });

  let ctx = 22_000;
  for (let t = 1; t <= turns; t++) {
    ts += int(30_000, 150_000);
    const grew = int(1500, 12_000);
    ctx += grew;
    const tuId = `tu_${uuid()}`;
    const dispatching = fanout && t === 2;

    if (dispatching) {
      // The orchestrator's fan-out: one Task per sibling, one brief each.
      const tus = Array.from({ length: fanout }, (_, i) => ({
        id: `tu_${uuid()}`,
        name: 'Task',
        input: {
          subagent_type: fanoutAgent,
          description: `write tests batch ${i + 1}`,
          prompt: `You are writing the autotests for batch ${i + 1}. Read ${SHARED_DOC} and the conventions before you start. ${filler(3200)}`,
        },
      }));
      assistantTurn(file, {
        ...common, ts, text: `Fanning out ${fanout} writers.`, toolUses: tus,
        usage: usage({ read: ctx, w5m: grew, output: 2400 }), stopReason: 'tool_use',
      });

      let childTs = ts + 10_000;
      const wfId = wf ? `wf_${sessionId.slice(0, 8)}` : null;
      for (let i = 0; i < fanout; i++) {
        const r = subagentRun({
          projectDir, cwd, branch, sessionId, agent: fanoutAgent, wfId,
          startTs: childTs,
          turns: i === 0 ? 34 : int(9, 22),      // one long sibling — an outlier
          model: i % 5 === 0 ? SONNET : OPUS,
          readsShared: i !== 3,                   // nearly everyone re-reads it
          expensive: i % 4 === 0,
          failing: i % 6 === 0,
        });
        childTs += int(40_000, 200_000);
        ts = Math.max(ts, r.endTs);
      }
      toolResults(file, {
        ...common, ts: ts + 5000,
        results: tus.map((t2) => ({ id: t2.id, text: filler(int(1500, 4000)) })),
      });
      continue;
    }

    const tool = pick(['Read', 'Edit', 'Bash', 'Grep', 'Write']);
    const mainTarget = pick(FILES);
    const key = tool === 'Bash' ? 'bash:npm run typecheck'
      : tool === 'Grep' ? 'grep:createOrder' : mainTarget;
    assistantTurn(file, {
      ...common, ts,
      toolUses: [{
        id: tuId, name: tool,
        input: tool === 'Bash'
          ? { command: 'npm run typecheck' }
          : tool === 'Grep'
            ? { pattern: 'createOrder\\(', path: 'src/' }
            : { file_path: mainTarget },
      }],
      usage: usage({ read: ctx, w5m: grew, w1h: t === 1 ? 18_000 : 0, output: int(500, 2600) }),
      stopReason: 'tool_use',
      extra: extras.effortAt === t ? { effort: 'high' } : {},
    });
    toolResults(file, {
      ...common, ts: ts + int(2000, 12_000),
      results: [{ id: tuId, text: bodyFor(key, int(800, 26_000)) }],
    });
  }

  // Session-level events: a compaction, a rate-limit burst, a cut-off answer.
  if (extras.compaction) {
    ts += 60_000;
    emit(file, {
      type: 'system', uuid: uuid(), timestamp: iso(ts), sessionId, cwd, gitBranch: branch,
      compactMetadata: { preTokens: 168_400, postTokens: 32_100, durationMs: 24_800, trigger: 'auto' },
      message: { role: 'system', content: 'Context compacted' },
    });
    assistantTurn(file, {
      ...common, ts: ts + 30_000, text: 'Continuing after compaction.',
      usage: usage({ w5m: 32_100, output: 900 }),
    });
  }
  if (extras.throttle) {
    for (let i = 0; i < extras.throttle; i++) {
      emit(file, {
        type: 'system', uuid: uuid(), timestamp: iso(ts + i * 40_000), sessionId, cwd, gitBranch: branch,
        isApiErrorMessage: true, apiErrorStatus: 429,
        message: { role: 'system', content: 'API rate limit' },
      });
    }
    ts += extras.throttle * 40_000;
  }
  if (extras.truncated) {
    ts += 45_000;
    assistantTurn(file, {
      ...common, ts, text: 'Here is the full migration plan' + filler(400),
      usage: usage({ read: ctx, output: 32_000 }), stopReason: 'max_tokens',
    });
  }
  return sessionId;
}

// ---- the corpus ------------------------------------------------------------
session({
  project: PROJECTS[0], dayOffset: 0, hour: 2, turns: 14,
  prompt: 'The orders endpoint returns 500 for guest checkout. Find out why and fix it.',
  extras: { compaction: true },
});
session({
  project: PROJECTS[0], dayOffset: 1, hour: 10, turns: 9,
  prompt: 'Cover the orders module with autotests — one writer per endpoint group.',
  fanout: 12, fanoutAgent: 'test-writer', wf: true,
  extras: { throttle: 14 },
});
session({
  project: PROJECTS[1], dayOffset: 2, hour: 11, turns: 22,
  prompt: 'Rewrite the checkout form to use the new validation hook everywhere.',
  fanout: 6, fanoutAgent: 'migrator',
  extras: { truncated: true },
});
session({
  project: PROJECTS[1], dayOffset: 3, hour: 15, turns: 7,
  prompt: 'Review the last three commits on feat/checkout for regressions.',
  fanout: 4, fanoutAgent: 'code-reviewer',
});
session({
  project: PROJECTS[2], dayOffset: 4, hour: 9, turns: 18,
  prompt: 'Add the double-entry ledger migration and backfill script.',
  fanout: 5, fanoutAgent: 'scout', extras: { compaction: true, throttle: 6 },
});
session({
  project: PROJECTS[2], dayOffset: 5, hour: 16, turns: 11,
  prompt: 'Why is the nightly reconciliation job 40 minutes slower this week?',
  fanout: 3, fanoutAgent: 'perf-analyst',
});
session({
  project: PROJECTS[3], dayOffset: 6, hour: 13, turns: 6,
  prompt: 'Summarise the experiment notebooks from July into one report.',
  fanout: 4, fanoutAgent: 'doc-writer',
});
session({
  project: PROJECTS[0], dayOffset: 7, hour: 8, turns: 12,
  prompt: 'Bump the SDK and fix whatever breaks.',
  fanout: 8, fanoutAgent: 'general-purpose', wf: true,
  extras: { truncated: true, throttle: 9 },
});
session({
  project: PROJECTS[1], dayOffset: 8, hour: 12, turns: 16,
  prompt: 'Ship the checkout A/B test behind a flag.',
  fanout: 7, fanoutAgent: 'test-writer', wf: true,
});
session({
  project: PROJECTS[3], dayOffset: 9, hour: 14, turns: 8,
  prompt: 'Clean up the notebook helpers and document the data loader.',
  fanout: 3, fanoutAgent: 'doc-writer',
});

// ---- flush -----------------------------------------------------------------
let files = 0, bytes = 0;
for (const [file, ls] of lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = ls.join('\n') + '\n';
  fs.writeFileSync(file, body);
  files++; bytes += body.length;
}
console.log(`wrote ${files} files, ${(bytes / 1e6).toFixed(1)} MB into ${ROOT}`);
