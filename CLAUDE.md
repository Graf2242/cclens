# CLAUDE.md

Guidance for agents and contributors working in this repository.

## Build & run

```bash
npm install               # dev only: tsc. Running the sources needs nothing
node src/cli.ts index     # build/update the index (incremental)
node src/cli.ts serve     # dashboard on http://127.0.0.1:4317
node src/cli.ts report    # spend report
node src/cli.ts diag      # outliers, cost-per-result, expensive calls, tails
node src/cli.ts cohort    # where a subagent fan-out collected the same context
node src/cli.ts probe     # custom regex rules over the logs, priced by run
node src/cli.ts show 'bl://<view>?<params>'   # hand a finding to an agent
npm run check              # typecheck + i18n:lint
npm run build              # emit dist/ for the npm package (prepack runs it)
```

There is no build step for running the code — Node executes `src/*.ts`
directly. `npm run build` exists only to publish: Node refuses to strip types
under `node_modules`, so the package ships JS emitted by
`tsconfig.build.json`. Keep `src/` the source of truth; `dist/` is generated
and gitignored.

Full command reference and the file-by-file breakdown live in `README.md`
("Device" table and command snippets) — this file does not duplicate them.

## Test policy

There is no test runner: no `test` script in `package.json`, no
vitest/jest/`node:test` config, no `*.test.*`/`*.spec.*` files anywhere in the
repo. Do not claim test coverage that does not exist. Verify a change today
with:

```bash
npm run typecheck   # tsc --noEmit
npm run i18n:lint   # scripts/i18n-lint.js
```

## Language convention

This file and `README.md` are English — the two contributor/agent-facing
entry points of the repo. Code identifiers and comments are English.
Commit messages and UI strings remain Russian; UI strings live in
`locales/*.json`, never inline in source.

## i18n lint scripts

`scripts/i18n-lint.js` and `scripts/i18n-merge.js` gate the localization
catalogs: no key referenced in code may be missing from a catalog, and no
stray Cyrillic string literal may live outside `locales/*.json`. Cyrillic
that isn't UI text (a probe regex matching what a model wrote to the log) is
marked with an `i18n-exempt` comment. Run via `npm run i18n:lint` or
`npm run check`.
