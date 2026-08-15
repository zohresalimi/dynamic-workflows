# EPIC-01: Development environment and toolchain

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-01-dev-environment-flows.md)

|                      |                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-01                                                                                                                                                                                                                                 |
| **Status**           | Not started                                                                                                                                                                                                                             |
| **Priority**         | P0                                                                                                                                                                                                                                      |
| **Milestone**        | M1                                                                                                                                                                                                                                      |
| **Workstream**       | pre-W0 (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                        |
| **Size**             | ~11 days across 6 stories                                                                                                                                                                                                               |
| **Depends on**       | EPIC-00 (specifically KAR-00.2, KAR-00.3, KAR-00.6 and the KAR-00.7 go/no-go)                                                                                                                                                           |
| **Blocks**           | EPIC-02 and, transitively, every other epic; directly also EPIC-04 and EPIC-18                                                                                                                                                          |
| **PRD requirements** | NF3, NF4, NF5, NF6, NF8, NF9, F4.2                                                                                                                                                                                                      |
| **Architecture**     | [03-local-development.md](../../03-local-development.md), [16-repo-layout.md](../../16-repo-layout.md), with supporting detail in [02-tech-stack.md](../../02-tech-stack.md) and [14-testing-strategy.md](../../14-testing-strategy.md) |

## Goal

A fresh clone of the repository reaches a running DeFlow daemon serving its UI at
`http://127.0.0.1:7777` in four commands, on macOS and Linux, on Node 24 and Node 26, with no build
step, no compiler, no database server, no Docker, no credentials and no money spent. Every save
restarts the daemon and thereby exercises crash-resume; every commit is formatted and linted in
under two seconds; every push typechecks and runs the unit slice; and CI is green on a named,
pinned matrix. After this epic the machine is productive and the rest of the backlog is about
DeFlow rather than about tooling.

## Why this matters

Everything in the PRD's M1 definition of done — "you complete a real multi-hour task at work with
it, from spec to merged PR" — is downstream of an inner loop that is fast enough to use daily
alongside a job and a degree. Three of this epic's decisions are load-bearing beyond convenience.
The zero-build loop means `node`, `vite`, `vitest` and `tsc` all resolve to live TypeScript source
across package boundaries, so there is no watch-build chain and no stale `dist/` to debug. The
one-process, one-port design (D10) means dev and production routing are byte-identical apart from
which middleware serves the UI, which makes "works in dev, broken in the built package" almost
impossible — and it exists because Vite's dev proxy is documented-bad at SSE, and the entire UI is
an SSE projection of the ledger. And `node --watch` restarting the daemon on every save is not a
nuisance to be engineered away: it is free, continuous, adversarial testing of F4.2, the single
property most competing tools lack and the one hardest to be confident in.

Skip this epic and you get a project where the first three weeks of EPIC-03 are spent discovering
that a `paths` alias survives into the published bundle, that snapshots churn on every run, that an
integration test hangs for the full 30-second timeout in CI and passes locally, and that
`biome check` has been silently doing nothing to every `.vue` file since day one.

## Scope

**In scope:**

- The pnpm 11 workspace: eight packages plus `e2e`, the `catalog:` block, the `workspace:*`
  protocol, and the `publishConfig` exports-override that swaps live source for built JavaScript at
  pack time.
- `tsconfig.base.json` and the solution `tsconfig.json`, including `erasableSyntaxOnly` and the
  import conventions that fall out of it.
- `pnpm dev`: one Node process, port 7777, Vite in middleware mode, `node --watch` restarts.
- One root `vitest.config.ts` with four project slices, and the `@DeFlow/testkit` fixtures they all
  depend on: tmpdir, hermetic git, file-backed SQLite, `TestClock`, normalising snapshot
  serializer.
- `biome.json`, `.oxlintrc.json` and the `pnpm lint` / `pnpm format` scripts.
- `lefthook.yml` and `.github/workflows/ci.yml`.
- Mechanical guard tests for the rules that are silent in development and fatal in the published
  package: no `paths` aliases, no deep imports, no `server.proxy`, `@DeFlow/core` has no I/O
  dependency, `biome.json` carries the `html` opt-in.

**Out of scope:**

- The contents of the packages. `packages/core/src/` gets an `index.ts` that exports nothing but
  the `Clock` and `Db` port interfaces if that is what KAR-02 needs to start; the domain model is
  EPIC-02.
- The mock agent binary and the fake exec-shim agent. `@DeFlow/mock-agent` and
  `@DeFlow/testkit/bin/fake-agent.ts` are created as empty packages here so the workspace shape is
  right; their behaviour is EPIC-04.
- The `crash-fuzz` test project. The CI workflow in [14-testing-strategy.md §14](../../14-testing-strategy.md)
  runs `pnpm vitest run --project crash-fuzz`, but that project has nothing to run until the ledger
  exists — it is added by EPIC-03 (KAR-03.8). This epic ships CI **without** that step and EPIC-03
  adds it; shipping it now means a red build from day one.
- Tarball verification (`pnpm pack`, `publint`, `@arethetypeswrong/cli`, install into a clean
  tmpdir). The `pack:check` script is defined here; actually running it as a gate is EPIC-18
  (KAR-18.6).
- Windows. NF5 puts it at M3.
- ESLint for Vue template rules. oxlint lints only the `<script>` block of an SFC and will never
  implement `eslint-plugin-vue`'s template rules, so `vue/no-unused-components` and its siblings
  are simply not enforced at M1. This is a deliberate gap, recorded here rather than dropped.

## Definition of Ready (epic level)

- [ ] KAR-00.7 has recorded **GO** or **GO, re-weighted**.
- [ ] KAR-00.2's decision note says which of `node --watch` or `tsx@4.23.4` watch the `dev` script
      uses. If it says `tsx`, KAR-01.3's acceptance criteria 2 and 5 are rewritten before work
      starts.
- [ ] KAR-00.3's decision note confirms `middlewareMode: { server }` works at runtime, or supplies
      the two-port fallback configuration.
- [ ] KAR-00.6's decision note gives a verdict on `stage_fixed: true` for `.vue`.
- [ ] KAR-00.5's decision note names the `synchronous=` value, so KAR-01.4's SQLite fixture is
      written against it rather than against the Linux default.

KAR-01.1's content-level Definition of Ready is already satisfied by
[16-repo-layout.md §1, §3 and §5](../../16-repo-layout.md), which give the exact package list, the
exports trick and the full catalog. It moves to `Ready` the moment KAR-00.7 records GO.

## Definition of Done (epic level)

- [ ] All six stories are `Done`.
- [ ] Every scenario in [the flow file](../flows/EPIC-01-dev-environment-flows.md) passes as an
      automated test at the level its `Automated at:` line names. The three scenarios marked
      `manual` are re-verified at the end of the epic and their results recorded in
      `docs/CONTRIBUTING.md`.
- [ ] A genuinely fresh clone, on a machine with no `node_modules` cache and no compiler, reaches
      `http://127.0.0.1:7777` in four commands, timed and recorded.
- [ ] `docs/CONTRIBUTING.md` opens with literally `git clone && pnpm install && pnpm dev` and has
      been re-verified against a clean checkout.
- [ ] CI is green on all four `test` matrix legs plus `check` and `browser-e2e`.
- [ ] The pre-commit hook's wall-clock time is measured on a realistic staged change and recorded;
      it is under 2 seconds.
- [ ] No `Unverified` claim from [03-local-development.md](../../03-local-development.md) or
      [16-repo-layout.md](../../16-repo-layout.md) remains unverified in this area — specifically
      A2-1 (closed by KAR-00.2), A2-3 (closed by KAR-00.6), A2-7 (`pnpm/action-setup@v6` and
      `actions/setup-node@v6` tags, closed by KAR-01.6) and the runtime behaviour of
      `middlewareMode: { server }` (closed by KAR-00.3 and re-confirmed by KAR-01.3).

## User stories

### KAR-01.1 — pnpm workspace scaffold with catalog-pinned versions

|                 |                                                                        |
| --------------- | ---------------------------------------------------------------------- |
| **Status**      | Not started                                                            |
| **Priority**    | P0                                                                     |
| **Size**        | M                                                                      |
| **Depends on**  | KAR-00.2, KAR-00.5, KAR-00.7                                           |
| **PRD**         | NF5, NF6                                                               |
| **Verified by** | EPIC-01-S1, EPIC-01-S2, EPIC-01-S3, EPIC-01-S4, EPIC-01-S5, EPIC-01-S8 |

**As** the author, **I want** the nine-package pnpm workspace to exist with every shared version
pinned in one catalog and the dependency direction enforced by a test, **so that** nine packages
cannot drift, the published-package story is correct from the first commit, and
`@DeFlow/core`'s purity is structural rather than aspirational.

This creates the layout in [16-repo-layout.md §1](../../16-repo-layout.md): `packages/{core,
ledger, adapters, daemon, cli, web, testkit, mock-agent}` plus `e2e`, of which exactly one —
`packages/cli`, named `deflow` — is ever published. Every `@DeFlow/*` package is `"private": true`
and is inlined into the CLI bundle by tsdown via `noExternal: [/^@DeFlow\//]`, which deletes the
entire multi-package versioning problem: no changesets, no release orchestration, no inter-package
semver ranges. Each package's `exports` map exposes `.` and nothing else, and carries the
`publishConfig` override that resolves `.` to `./src/index.ts` in the workspace and to
`./dist/index.js` in a tarball. Two dependency rules are enforced mechanically rather than by
convention: **R1** `@DeFlow/core` depends on nothing in the workspace and on nothing that can
perform I/O; **R2** nothing depends on `@DeFlow/daemon` except `packages/cli`.

`@DeFlow/mock-agent` deliberately does **not** depend on `@DeFlow/core`. If it did, a bug in the
domain model could be mirrored on both sides of the wire and cancel itself out. It is an
independent implementation of the agent side of the same published schema, which is what makes it a
useful oracle.

**Acceptance criteria**

1. `pnpm-workspace.yaml` lists `packages/*` and `e2e`, and carries a `catalog:` block containing at
   minimum: `typescript: 6.0.3`, `zod: 4.4.3`, `vitest: 4.1.10`, `vite: 8.2.0`,
   `@types/node: ^24.0.0`, `hono: 4.12.33`, `@hono/node-server: 2.0.12`,
   `better-sqlite3: 13.0.2`, `@agentclientprotocol/sdk: 1.3.0`,
   `@modelcontextprotocol/sdk: 1.30.0`, `execa: 10.0.1`, `pino: 10.3.1`,
   `@biomejs/biome: 2.5.6`, `oxlint: 1.76.0`, `tsdown: 0.22.14`.
2. `@agentclientprotocol/sdk` and `tsdown` are pinned **exact, without a caret** — the ACP SDK went
   `0.4.5 → 1.3.0` and changed both npm scope and GitHub org inside about ten months, and tsdown is
   still 0.x.
3. Every cross-package dependency uses `workspace:*`; every shared third-party dependency uses
   `catalog:`. A grep for a literal version string inside a `packages/*/package.json` dependency
   block returns nothing.
4. `pnpm install --frozen-lockfile` completes from a cold store with **no `node-gyp` invocation and
   no compilation**, and the two native tarballs resolve to prebuilt binaries.
5. Root `package.json` declares `"packageManager": "pnpm@11.18.0"`, `"engines": { "node": ">=24" }`,
   `"type": "module"` and `"private": true`. Node 22 is **not** listed in `engines` — listing it
   obliges you to test it.
6. `.node-version` and `.tool-versions` are committed so `fnm`, `nvm` and `mise` all pick the major
   up automatically.
7. `packages/core/test/purity.test.ts` asserts that `@DeFlow/core`'s dependency list is exactly
   `['zod']` and that no file under `packages/core/src/` (excluding tests) contains
   `from 'node:`.
8. A second guard test asserts R2: no package other than `packages/cli` lists `@DeFlow/daemon` as a
   dependency.
9. `@DeFlow/mock-agent`'s `package.json` has no workspace dependencies at all, and a guard test
   asserts it.
10. `pnpm pack` inside `packages/core` produces a tarball whose `exports` resolve `.` to
    `./dist/index.js`, proving the `publishConfig` swap.

**Test plan (TDD)** — write these before the `package.json` files exist; the first two fail because
there is nothing to install.

| #   | Level       | Test                                                                                                                                            | Red when                                                                                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | integration | `pnpm install --frozen-lockfile` into a clean store; assert exit 0 and that the log contains no `gyp` line                                      | A native dependency compiles → NF6 is broken for anyone without a toolchain                      |
| 2   | unit        | Parse every `packages/*/package.json`; assert every non-`@DeFlow/*` dependency value is `catalog:` and every `@DeFlow/*` value is `workspace:*` | A literal version appears → nine packages can now drift                                          |
| 3   | unit        | `packages/core/test/purity.test.ts`: dependency keys equal `['zod']`                                                                            | Any second dependency appears → R1 is broken and NF9's deterministic core stops being structural |
| 4   | unit        | Glob `packages/core/src/**/*.ts` excluding tests; assert none matches `/from ['"]node:/`                                                        | A `node:` builtin import appears in core                                                         |
| 5   | unit        | Assert no `package.json` except `packages/cli` depends on `@DeFlow/daemon`                                                                      | R2 broken — the daemon has stopped being a leaf                                                  |
| 6   | unit        | Assert `@DeFlow/mock-agent` has zero `@DeFlow/*` dependencies                                                                                   | The oracle now shares code with the thing it is meant to check                                   |
| 7   | integration | `pnpm pack` in `packages/core`, unpack, assert `exports['.']` resolves to `./dist/index.js`                                                     | `publishConfig` is not applied → a published package would point at `.ts` files                  |

**Notes / risks** — `pnpm change` / `pnpm lane` (pnpm 11.13's native release management) is
deliberately not used: D5 ships exactly one package, so there is no coordination to manage, and the
feature was verified only from release notes (A2-6).

---

### KAR-01.2 — TypeScript configuration and the erasable-syntax constraint

|                 |                                    |
| --------------- | ---------------------------------- |
| **Status**      | Not started                        |
| **Priority**    | P0                                 |
| **Size**        | S                                  |
| **Depends on**  | KAR-01.1                           |
| **PRD**         | NF6, NF9                           |
| **Verified by** | EPIC-01-S6, EPIC-01-S7, EPIC-01-S8 |

**As** the author, **I want** `tsconfig.base.json` to ban, on day one, every piece of TypeScript
syntax that needs a runtime emit, **so that** `node packages/daemon/src/main.ts` keeps working
forever and nobody discovers at 5,000 lines that an `enum` cannot run.

This is D4 and it is permanent, not a preference. Node's type stripping is stable (Stability 2 as
of v24.12.0 / v25.2.0), but `--experimental-transform-types` was **removed in Node 26.0.0**. There
is no flag left. Any syntax needing a runtime emit is now permanently unrunnable by `node file.ts`
on a supported runtime. `erasableSyntaxOnly: true` bans `enum`, `const enum`, runtime `namespace`,
constructor parameter properties, decorators, `import X = require(...)` and `export =`; the
replacement idioms are tabulated in [02-tech-stack.md §10.3](../../02-tech-stack.md).

Two conventions fall out of the same design and are equally load-bearing. **Relative imports carry
explicit `.ts` extensions** — `allowImportingTsExtensions` plus `rewriteRelativeImportExtensions`
make `tsc` and `tsdown` rewrite them to `.js` on emit while `node src/main.ts` runs the source
directly. And **there are no `paths` aliases, ever**:
`rewriteRelativeImportExtensions` does not rewrite through them (microsoft/TypeScript#61991), so an
aliased `@/patch.ts` survives into the emitted JavaScript and the published bundle fails at runtime
with a module-not-found. The failure is invisible in development, because in development the `.ts`
file genuinely exists. [16-repo-layout.md §9](../../16-repo-layout.md) calls this the single most
expensive mistake available in this layout, which is why it gets a guard test rather than a
paragraph.

TypeScript is pinned to **6.0.3, not 7.x** (D3), and the reason is not conservatism:
`typescript@7.0.2` ships **only** `bin/tsc` — no `tsserver`, no public compiler API — so
`vue-tsc@3.3.9`/Volar cannot run at all, and `typescript-eslint@8.65.0`'s peer range is literally
`typescript >=4.8.4 <6.1.0`. Adopting 7 today means a split-version workspace with two lint configs
and two typecheck paths.

**Acceptance criteria**

1. `tsconfig.base.json` sets exactly: `target: es2024`, `lib: ["es2024"]`, `module: nodenext`,
   `moduleResolution: nodenext`, `moduleDetection: force`, `verbatimModuleSyntax: true`,
   `isolatedModules: true`, `erasableSyntaxOnly: true`, `allowImportingTsExtensions: true`,
   `rewriteRelativeImportExtensions: true`, `noEmit: true`, `strict: true`,
   `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
   `noImplicitOverride: true`, `skipLibCheck: true`, `types: ["node"]`.
2. The root `tsconfig.json` is a solution file containing only `references`, one per package, so
   `tsc -b` typechecks the graph in dependency order.
3. `pnpm typecheck` runs `tsc -b` **and** `pnpm --filter @DeFlow/web exec vue-tsc --noEmit`, and
   both pass on an empty workspace.
4. Each of the banned constructs, introduced into a package, fails `tsc -b` with
   `error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`
5. The same construct, run through `node`, fails at runtime with an unsupported-TypeScript-syntax
   error — proving the ban is enforced by the runtime and not only by the compiler.
6. A guard test asserts `tsconfig.base.json` and every package tsconfig contain **no `paths` key**.
7. A guard test asserts no source file imports another workspace package by a deep path
   (`@DeFlow/core/src/...`) — only the package root.
8. A guard test asserts every relative import in `packages/*/src/**` ends in `.ts`.
9. `typescript` resolves to exactly `6.0.3` across the whole workspace; a second TypeScript version
   anywhere in the tree fails the check.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                     | Red when                                                                                                     |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | unit        | Read `tsconfig.base.json`; assert each of the seventeen options equals its specified value                               | An option drifts — most of them are individually load-bearing and none is decorative                         |
| 2   | integration | Write a fixture file containing `enum E { A }` into a scratch package; run `tsc -b`; assert the output contains `TS1294` | It compiles → `erasableSyntaxOnly` is off and the zero-build loop is one PR away from breaking               |
| 3   | integration | Run the same fixture with `node`; assert non-zero exit and an unsupported-syntax error                                   | It runs → record it, but keep the ban: Node 26 removed the transform flag and there is no way back           |
| 4   | unit        | Recursively read every tsconfig; assert `compilerOptions.paths` is undefined everywhere                                  | A `paths` alias appears → the published bundle will fail at runtime and dev will look fine                   |
| 5   | unit        | Grep `packages/*/src/**/*.ts` for `@DeFlow/[a-z]+/`                                                                      | A deep import appears → it breaks the `publishConfig` source→dist swap and makes an internal file public API |
| 6   | unit        | Grep for relative imports without a `.ts` suffix                                                                         | An extensionless relative import appears → `nodenext` resolution will reject it                              |
| 7   | integration | `pnpm ls typescript -r --depth 0`; assert one version, `6.0.3`                                                           | A second version appears → the split-workspace problem D3 exists to avoid has arrived by accident            |

**Notes / risks** — The TS 7 unpin trigger is stated in [roadmap §5](../../17-roadmap.md) and is a
three-way condition: 7.1 published **and** `vue-tsc` announces support **and** `typescript-eslint`
(or an `oxlint-tsgolint` successor covering the same rules) publishes an admitting peer range.
Flip all three in one commit, never one at a time. Secondary sources put 7.1's stable programmatic
API around October 2026; no Microsoft primary source confirms a date (A2-2).

---

### KAR-01.3 — One-command dev loop: `pnpm dev` serves daemon and UI on one port

|                 |                                                                            |
| --------------- | -------------------------------------------------------------------------- |
| **Status**      | Not started                                                                |
| **Priority**    | P0                                                                         |
| **Size**        | M                                                                          |
| **Depends on**  | KAR-01.1, KAR-01.2, KAR-00.3                                               |
| **PRD**         | NF3, NF10, F4.2, F10.1, F10.6                                              |
| **Verified by** | EPIC-01-S1, EPIC-01-S9, EPIC-01-S10, EPIC-01-S11, EPIC-01-S12, EPIC-01-S13 |

**As** the author, **I want** `pnpm dev` to start exactly one Node process that serves the API, the
SSE stream and the UI from `http://127.0.0.1:7777`, and to restart on every save, **so that** the
inner loop is one command and every save is a free crash-resume trial.

This is D10 made concrete. `DeFlow_DEV=1 node --watch --watch-path=packages
--env-file-if-exists=.env packages/daemon/src/main.ts` starts `DeFlowd`; Hono on
`@hono/node-server` binds the port; the API mounts on `/api` **first** so it always wins over the
SPA fallback; and when `DeFlow_DEV=1`, Vite is dynamically imported and created with
`server: { middlewareMode: { server } }` against the daemon's own `node:http` server, so the HMR
websocket rides that server rather than opening a second one. Vite is a devDependency and the
dynamic import is what keeps it out of the published bundle. In production the same routes are
served with `serveStatic` from `dist/ui/` plus an SPA fallback — dev and production routing are
byte-identical apart from that one branch.

The restart behaviour is a feature and the story must not "fix" it. On every save the process dies
mid-flight, often with nodes running and effects `pending`; the new process reopens the ledger,
reduces the event log, rebuilds `RunState`, bumps `daemon_epoch`, takes the `flock`, reaps orphaned
children by matching `(pid, process_start_time)` — never by bare pid, because pids are recycled —
and reconciles every effect row the previous daemon life left `pending`. Completed nodes are never
re-executed. If the daemon fails to come back up cleanly, that is a real bug in the reducer, the
migration or the reconcile probe, not a dev-loop annoyance.

At this point in the backlog there is no ledger and no orchestrator, so this story delivers the
_process shape_ and the restart behaviour; the replay-on-start path it enables is implemented in
EPIC-03 (KAR-03.8) and EPIC-06 (KAR-06.9). The scenarios that assert on effect reconciliation are
written here and marked pending until those stories land — deliberately, so the loop is specified
before the code that must satisfy it.

**Acceptance criteria**

1. `pnpm dev` starts exactly one Node process, and exactly one socket listens, on 127.0.0.1:7777.
2. A request to `/api/health` returns from Hono; a request to `/` returns the Vue app; neither
   requires a CORS header, because there is one origin.
3. Editing any file under `packages/*/src` restarts the daemon within 2 seconds and the process
   serves requests again without manual intervention.
4. Editing a `.vue` file hot-reloads the module in the browser over the **same** port, and does not
   restart the daemon.
5. `pnpm dev:pretty` pipes through `pino-pretty`; `pino-pretty` is never wired as a runtime
   transport.
6. Pino redaction is configured from this commit for `*.authorization`, `*.token`,
   `env.ANTHROPIC_API_KEY`, `env.OPENAI_API_KEY` and `*.headers.cookie` — retrofitting it across
   six months of call sites is miserable.
7. A guard test asserts the string `server.proxy` (and a `proxy:` key inside any Vite config)
   appears nowhere in the repository.
8. A guard test asserts `vite` is imported only dynamically and only under the `DeFlow_DEV === '1'`
   branch, so it cannot enter the published bundle.
9. Logs are namespaced by subsystem via `logger.child({ mod, runId })` so
   `pnpm dev | pino-pretty | grep '"mod":"scheduler"'` works.
10. Cold start of `pnpm dev` to first served request is under 3 seconds (NF3), measured and
    recorded.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                        | Red when                                                                       |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | e2e         | Boot the daemon on an ephemeral port; assert exactly one listening socket and that `/api/health` and `/` both respond       | Two ports appear → Vite opened its own HMR server and D10's premise fails      |
| 2   | e2e         | Touch `packages/daemon/src/main.ts`; poll `/api/health`; assert it 503s or refuses, then responds again, within 2 s         | The restart never completes → `node --watch` is not usable as the loop         |
| 3   | e2e         | Open an SSE connection; touch a `.vue` file; assert an HMR update arrives and `EventSource.readyState` stays OPEN           | The stream drops on an SFC edit → the loop cannot be used while a run is going |
| 4   | unit        | Grep the repo for `server.proxy` and for a `proxy` key in any `vite.config.*`                                               | Someone added a proxy → the three documented SSE failure modes are back        |
| 5   | unit        | Parse `packages/daemon/src/http/server.ts`; assert the only `vite` import is a dynamic one inside the dev branch            | A static import appears → `vite` lands in the published tarball                |
| 6   | integration | Assert the Hono app's route table registers `/api` before the catch-all                                                     | The SPA fallback shadows the API and `/api/stream` returns HTML                |
| 7   | unit        | Feed the logger an object containing an `authorization` field; assert the serialised output shows the redaction placeholder | Redaction is not configured → a token reaches a log file                       |
| 8   | e2e         | Measure cold start to first 200 on `/api/health`                                                                            | Over 3 s → NF3 is missed at the point it is cheapest to fix                    |

**Notes / risks** — If KAR-00.2 took the `tsx` fallback, acceptance criteria 3 and the whole
crash-resume framing change: `tsx watch` restarts differently, and the note from KAR-00.2 must be
read before this story starts. Do not "fix" the restart with a hot-reload scheme that preserves
process state — the restart _is_ the test.

---

### KAR-01.4 — Test runner with four project slices and shared fixtures

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| **Status**      | Not started                                                                  |
| **Priority**    | P0                                                                           |
| **Size**        | M                                                                            |
| **Depends on**  | KAR-01.1, KAR-01.2                                                           |
| **PRD**         | NF9, F4.2                                                                    |
| **Verified by** | EPIC-01-S14, EPIC-01-S15, EPIC-01-S16, EPIC-01-S17, EPIC-01-S18, EPIC-01-S19 |

**As** the author, **I want** one root `vitest.config.ts` with four correctly-configured project
slices and a `@DeFlow/testkit` that provides the four fixtures every later epic depends on,
**so that** the test suite runs in seconds, offline, with no credentials, and tests the surfaces
where DeFlow's bugs actually live rather than testing its own mocks.

The slices come straight from [14-testing-strategy.md §2](../../14-testing-strategy.md):
`unit` (pure logic, default timeout, threads, run on every save), `integration` (real tmpdirs, real
`git`, real file-backed SQLite, fake agent binaries on `PATH`; 30 s timeout, `pool: 'forks'`),
`e2e` (a real `DeFlowd` on an ephemeral port; 180 s timeout, `forks`, `singleFork`,
`fileParallelism: false`) and `web` (Vue components in real Chromium, configured from
`packages/web/vitest.config.ts`). `pool: 'forks'` for anything spawning children is not a
preference: worker threads share a process, and a test that leaks a child process or an fd poisons
its neighbours in ways that are miserable to diagnose.

**`vitest.workspace.ts` and `defineWorkspace` were REMOVED in Vitest 4.** Any tutorial showing them
is pre-3.2 and will not run; a single root config with `test.projects` is the only shape that works.

The fixtures are the other half of the story and they carry the strategy's central trades. Real
tmpdirs, because `memfs` is invisible to a real `git` binary and to a real vendor CLI — it is
acceptable only for pure artifact-store unit tests that never hand a path to a child process. Real
`git`, hermetically, with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` and forced
author/committer identity, because without it the developer's own `~/.gitconfig` silently changes
test outcomes and produces the classic "passes locally, fails in CI" and its equally confusing
inverse. File-backed SQLite, because `:memory:` cannot exercise WAL, cannot be reopened after a
simulated crash, and hides fsync and ordering bugs — that is, it cannot test F4.2, the one property
that matters most. And time through an injected `Clock` port, never `Date.now()` or `setTimeout` in
engine code, because `vi.useFakeTimers()` while a child process is alive freezes the event loop's
timers, the child's real I/O never arrives, and the test deadlocks — usually as a spec that passes
locally and hangs for the full 30-second timeout in CI.

**Acceptance criteria**

1. One root `vitest.config.ts` defines `test.projects` with the four slices, each with the include
   glob, timeout and pool specified in the testing strategy. No `vitest.workspace.ts` exists, and a
   guard test asserts it never will.
2. `pnpm test:unit` runs the unit slice in about a second on an empty workspace and is the command
   the author runs constantly.
3. `pnpm test:int` uses `pool: 'forks'` and a 30 s timeout; `pnpm test:e2e` additionally uses
   `singleFork: true` and `fileParallelism: false`.
4. `@DeFlow/testkit` exports a `tmp` fixture built on `fs.mkdtemp(os.tmpdir(), 'DeFlow-')` that
   removes the directory on teardown **only when `DeFlow_KEEP_TMP` is unset**.
5. `@DeFlow/testkit` exports a `makeRepo({ branches, files, conflicts })` helper that runs real
   `git init -b main` with the hermetic environment, and a guard test asserts every `git`
   invocation in the testkit passes that environment.
6. `@DeFlow/testkit` exports an `agentPath` fixture that symlinks a fake binary into a tmp `bin/`
   and prepends it to `PATH`, and **also** resolves and returns the binary's absolute path — because
   DeFlowd's `PATH` at daemon-start differs from the user's login shell, so production code stores
   the absolute path rather than relying on lookup at spawn time.
7. `@DeFlow/testkit` exports a `TestClock` implementing the `Clock` port (`now`, `sleep`,
   `setTimer`) that is advanced manually.
8. `test/setup.ts` registers a normalising snapshot serializer **before any snapshot exists**, which
   normalises at minimum: timestamps, run/node/event ids (ULIDs and UUIDs), durations, absolute
   paths, ports and worktree directory names.
9. A guard test asserts no test file calls `vi.useFakeTimers()` outside an explicit allowlist, and
   that any allowlisted use scopes `toFake` rather than faking everything.
10. A guard test asserts no file under `packages/*/test/integration/**` opens a `:memory:` database.
11. The config leaves a documented slot for the `crash-fuzz` project that EPIC-03 adds, and CI does
    not reference it until then.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                               | Red when                                                                                                 |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | integration | Run `pnpm vitest --project unit` and `--project integration` on a trivial spec in each; assert both resolve and pass               | A project name is wrong → `--project` silently matches nothing and you believe a slice is green          |
| 2   | unit        | Read the root config; assert `integration` and `e2e` use `pool: 'forks'`, and `e2e` uses `singleFork` and `fileParallelism: false` | Threads are used for a child-spawning slice → one leaked fd poisons unrelated specs                      |
| 3   | integration | Use the `tmp` fixture, fail the test deliberately with `DeFlow_KEEP_TMP=1`, assert the directory still exists afterwards           | The directory is removed → post-mortem on a broken worktree becomes impossible, in CI especially         |
| 4   | integration | `makeRepo()` in a shell where `~/.gitconfig` sets `init.defaultBranch=trunk`; assert the created branch is `main`                  | The developer's global config leaks in → the classic pass-locally-fail-in-CI                             |
| 5   | integration | Spawn the fake binary via the `agentPath` fixture; assert the resolved absolute path was used, not a bare name                     | Spawn relies on `PATH` lookup → it works in tests and fails under a daemon with a different `PATH`       |
| 6   | unit        | Advance `TestClock` by six hours; assert a registered timer fired exactly once and `now()` moved                                   | The clock is not injectable → long-suspension tests need real time and NF9 is unprovable                 |
| 7   | unit        | Snapshot an object containing a ULID, an absolute tmp path and a duration; run twice; assert identical output                      | The serializer is missing → every snapshot churns and the mechanism becomes noise you learn to `-u` past |
| 8   | integration | Grep the repo for `vitest.workspace.ts` / `defineWorkspace`                                                                        | Either appears → removed in Vitest 4; the config will not run                                            |
| 9   | integration | Open a file-backed database, write, `close()`, construct a fresh instance over the same file, read                                 | The reopen path is untested → the exact code path a daemon restart takes is unexercised                  |

**Notes / risks** — Vitest 5.0.0-beta.7 exists and may go stable during M1, bringing another
`projects`/browser-mode migration (A2-5). Do not chase the beta; budget an afternoon if it lands.

---

### KAR-01.5 — Lint and format pipeline

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-01.1, KAR-01.2, KAR-00.6          |
| **PRD**         | NF9, F4.2                             |
| **Verified by** | EPIC-01-S20, EPIC-01-S21, EPIC-01-S22 |

**As** the author, **I want** exactly one tool responsible for formatting and exactly one
responsible for linting, with the type-aware correctness rules that actually catch orchestrator
bugs turned on, **so that** a floating promise in a three-hour run — which is a silent data-loss
bug, not a style issue — is caught at commit time.

Biome 2.5.6 formats everything: `.ts`, `.js`, `.json`, `.jsonc`, `.css`, `.html` and `.vue`. Its
`.vue` support is **off by default** and is gated behind
`"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }` — without
that flag `biome check` silently no-ops on every SFC in `packages/web` and you get a green run and
zero formatting. oxlint 1.76.0 with `--type-aware` lints `packages/{core,ledger,adapters,daemon,
cli}`; type-aware linting went stable in **1.75.0**, and it covers 59 of typescript-eslint's 61
type-aware rules at 12–18× the speed. The rule that keeps the pairing workable is that the two must
never lint the same globs — two linters over one file gives duplicate diagnostics and autofixes that
fight each other across runs — so `biome.json` sets `"linter": { "enabled": false }`.

**Acceptance criteria**

1. `biome.json` contains the `html` block with `experimentalFullSupportEnabled: true` and
   `formatter.enabled: true`, and `"linter": { "enabled": false }`. A guard test asserts all three.
2. `.oxlintrc.json` enables the `typescript`, `unicorn`, `promise` and `import` plugins, sets
   `categories: { correctness: "error", suspicious: "warn" }`, and turns on as errors:
   `typescript/no-floating-promises`, `typescript/no-misused-promises`,
   `typescript/await-thenable`, `typescript/require-await`,
   `typescript/no-unnecessary-condition`, `typescript/no-unsafe-argument`.
3. `pnpm lint` runs `oxlint --type-aware && biome check .` and exits non-zero on any violation.
4. `pnpm format` runs `biome check --write .`.
5. Running both tools over the same file produces no duplicate diagnostic and no autofix that the
   other reverses — verified once, mechanically.
6. `biome check` on a deliberately misformatted `.vue` file **produces a diff**, proving the opt-in
   is active. A guard test asserts the flag rather than trusting it.
7. The known gap is documented in `docs/CONTRIBUTING.md`: oxlint lints only the `<script>` block of
   an SFC and template rules such as `vue/no-unused-components` are not enforced at M1.
8. `@biomejs/biome` is pinned **exact** at 2.5.6, because formatter output must not change under
   you.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                               | Red when                                                                                               |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | unit        | Parse `biome.json`; assert `html.experimentalFullSupportEnabled === true` and `linter.enabled === false`           | The flag is missing → Biome silently no-ops on every `.vue` file, which is exactly the KAR-00.6 hazard |
| 2   | integration | Write a fixture with a floating promise; run `oxlint --type-aware`; assert `typescript/no-floating-promises` fires | Type-aware mode is off → the class of bug that silently loses a three-hour run is unlinted             |
| 3   | integration | Write a deliberately misformatted SFC; run `biome check --write`; assert the file changed                          | It does not change → the opt-in is not taking effect at this Biome version                             |
| 4   | integration | Enable Biome's linter temporarily and run both over one file; count diagnostics by rule                            | A duplicate appears → confirms `linter.enabled: false` is load-bearing                                 |
| 5   | unit        | Assert the six named type-aware rules are present and set to `error` in `.oxlintrc.json`                           | A rule is dropped → the correctness net is quietly smaller than the design says                        |
| 6   | unit        | Assert `@biomejs/biome` in the catalog has no `^` or `~`                                                           | A range appears → a patch bump reformats the entire repository in someone's next commit                |

**Notes / risks** — biomejs.dev, oxc.rs, vitest.dev, tsdown.dev and pnpm.io all returned 403 to the
research proxy, so versions came from the registry and unpacked tarballs while _feature and status
claims_ came from search summaries (A2-4). Re-read the two official config references before
writing `biome.json` and `.oxlintrc.json`, and record any divergence.

---

### KAR-01.6 — Git hooks and CI on macOS and Linux

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | KAR-01.4, KAR-01.5                                 |
| **PRD**         | NF4, NF5                                           |
| **Verified by** | EPIC-01-S20, EPIC-01-S21, EPIC-01-S23, EPIC-01-S24 |

**As** the author, **I want** a pre-commit hook that finishes in under two seconds and a CI matrix
pinned to explicit runner images, **so that** I never type `--no-verify`, and so that a failure on
one platform is diagnosable rather than a mystery.

`lefthook@2.1.10` replaces husky **and** lint-staged with one dependency — it ships a Go binary via
optionalDependencies, runs jobs in parallel, and has built-in staged-file globbing.
`"prepare": "lefthook install"` wires it up on `pnpm install`. The split is deliberate: pre-commit
runs `biome check --write --no-errors-on-unmatched {staged_files}` with `stage_fixed: true` plus
`oxlint {staged_files}` **without** `--type-aware`, because type-aware linting is too slow for a
hook; pre-push runs `pnpm typecheck` and `pnpm vitest run --project unit`.

> **Keep pre-commit under about 2 seconds.** Anything slower and you will start reaching for
> `--no-verify`, at which point the hooks are theatre and you have paid the setup cost for nothing.

CI has three jobs and every image is pinned. `check` runs on `ubuntu-26.04`: `pnpm biome ci .`,
`pnpm oxlint --type-aware`, `pnpm typecheck`. `test` runs a matrix of
`os: [ubuntu-26.04, macos-26] × node: ['24', '26']` with `fail-fast: false`, running the unit and
integration slices, with `DeFlow_KEEP_TMP=1` and `actions/upload-artifact@v4` on failure over
`/tmp/DeFlow-*`. `browser-e2e` runs on `ubuntu-26.04` **only** — do not triple macOS minutes on a
browser job — installing Chromium via `pnpm exec playwright install --with-deps chromium` and
running the `web` and `e2e` slices. `concurrency: { group: ci-${{ github.ref }},
cancel-in-progress: true }`.

Two 2026 footguns are enforced rather than documented. **Never `corepack enable`** — Corepack was
removed from Node 25+ distributions (TSC vote, March 2025) and is bundled only through Node 24, so
it fails outright on Node 25 and 26; use `pnpm/action-setup@v6` or `npm i -g pnpm@11`. **Never
`-latest` runner images** — `macos-latest` migrated to macOS 26 on Apple Silicon between 8 and 15
June 2026, and an implicit architecture change shifts native module prebuilds, `node-pty` behaviour
and filesystem case-sensitivity all at once.

**Acceptance criteria**

1. `lefthook.yml` defines `pre-commit` with `parallel: true` and two jobs — `format` (glob
   `*.{ts,vue,json,jsonc,css,html}`, `stage_fixed: true`) and `lint` (glob `*.ts`, no
   `--type-aware`) — and `pre-push` with `typecheck` and `unit`.
2. `stage_fixed: true` applies to `.vue` **only if** KAR-00.6's note gave a "safe" verdict;
   otherwise `.vue` is excluded from the format glob and the reason is a comment in the file.
3. The pre-commit hook's wall-clock time is measured on a realistic staged change (10–20 files) and
   is under 2 seconds. The number is recorded in `docs/CONTRIBUTING.md`.
4. A commit containing a floating promise in a staged `.ts` file is **rejected**, with oxlint's rule
   name in the output.
5. `pnpm install` runs `lefthook install` via `prepare`, so hooks exist after a fresh clone with no
   extra step.
6. `.github/workflows/ci.yml` contains the three jobs above with `actions/checkout@v5`,
   `pnpm/action-setup@v6` and `actions/setup-node@v6` with `node-version: 24, cache: pnpm`.
7. Every `runs-on` value is an explicit image (`ubuntu-26.04`, `macos-26`); a guard test greps the
   workflow for `-latest` and fails if found.
8. A guard test greps the workflow **and** `docs/` for `corepack enable` and fails if found.
9. `fail-fast: false` on the test matrix, so one failing leg does not hide the state of the other
   three.
10. On failure, the tmpdir artefact is uploaded and is named per matrix cell
    (`tmp-${{ matrix.os }}-${{ matrix.node }}`), so a macOS-only worktree bug is diagnosable from a
    laptop that is not a Mac — and vice versa.
11. CI does **not** reference `--project crash-fuzz` until EPIC-03 adds that project.
12. The full CI run on a green commit completes in under 10 minutes, measured and recorded, so the
    push loop stays usable.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                    | Red when                                                                                                                      |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration | In a scratch clone, stage a misformatted `.ts` file and commit; assert the file was reformatted and re-staged, and the commit succeeded | `stage_fixed` is not applied → you commit unformatted code and the next `biome check` in CI fails                             |
| 2   | integration | Stage a file with a floating promise; commit; assert exit non-zero and stderr names `no-floating-promises`                              | The hook passes → the correctness net is not in the loop where it is cheapest                                                 |
| 3   | integration | Time the pre-commit hook over a 20-file staged change, 5 runs, take the median                                                          | Median exceeds 2 s → the hook will be bypassed and is therefore worthless                                                     |
| 4   | unit        | Parse `lefthook.yml`; assert the `lint` job's command contains no `--type-aware`                                                        | Type-aware lint creeps into pre-commit → the budget is blown                                                                  |
| 5   | unit        | Grep `.github/workflows/*.yml` for `-latest`                                                                                            | An unpinned image appears → an OS or architecture migration lands under you without a commit                                  |
| 6   | unit        | Grep the workflow and `docs/` for `corepack enable`                                                                                     | It appears → CI fails outright on Node 25+ and the setup docs mislead a colleague at M2                                       |
| 7   | unit        | Parse the workflow; assert `fail-fast: false` and four matrix legs `{ubuntu-26.04, macos-26} × {24, 26}`                                | Node 22 appears, or a leg is missing → you are testing a maintenance-line runtime, or a platform silently stops being covered |
| 8   | unit        | Assert the workflow contains no `--project crash-fuzz` reference                                                                        | It does → CI is red from the first commit because the project has nothing to run yet                                          |
| 9   | integration | Force an integration test to fail on one leg; assert the artefact is uploaded under the per-cell name                                   | The artefact is missing or overwritten → a CI-only worktree failure is undiagnosable                                          |

**Notes / risks** — `pnpm/action-setup@v6` and `actions/setup-node@v6` tags were **unverified** by
the research, and a newer combined `pnpm/setup` action exists and is unevaluated (A2-7). Check both
against the marketplace before pinning, and record what was found — this is one of the few
`Unverified` items this epic is responsible for closing.

---

## Risks

| Risk                                                                                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic size (~11 days) approaches the 15-day warning line**, and none of it is DeFlow itself. It is the least motivating work in the backlog and the easiest to half-finish.                                             | The sequencing is deliberately front-loaded on value: after KAR-01.1 and KAR-01.3 the loop is usable and EPIC-02 could technically start. KAR-01.4 must land before EPIC-03, and KAR-01.5/01.6 before the first week of real commits — but if the schedule slips, slipping KAR-01.6's CI job past EPIC-02 is survivable in a way that slipping KAR-01.4 is not.   |
| **The whole epic is gated on KAR-00.7**, and two stories change shape depending on spike outcomes.                                                                                                                       | The epic's Definition of Ready names the exact notes to read and the exact acceptance criteria that change. Do not start KAR-01.3 before reading KAR-00.2's and KAR-00.3's notes.                                                                                                                                                                                 |
| **The guard tests become the point.** Ten mechanical greps is a lot of ceremony for a solo project.                                                                                                                      | Every one of them guards a failure that is **silent in development and fatal later**: `paths` aliases, deep imports, `server.proxy`, `:memory:` in a durability test, fake timers around a child, a missing snapshot serializer, `-latest` images, `corepack enable`. None of them guards a style preference. If a guard cannot be justified that way, delete it. |
| **Pre-commit creep.** Every future story will want to add "just one more check" to the hook.                                                                                                                             | The 2-second budget is an acceptance criterion with a recorded measurement, and criterion 4 of KAR-01.6's test plan asserts type-aware lint stays out. Typecheck and the full suite belong on pre-push and in CI.                                                                                                                                                 |
| **Toolchain drift during M1.** Vitest 5 may go stable; TypeScript 7.1 may ship; Vue 3.6 rewrites the reactivity core and `@vue-flow/core@1.48.2` peers `vue ^3.3.0` with no compatibility statement from either project. | [roadmap §5](../../17-roadmap.md) sets the re-check cadences and the unpin triggers. The relevant discipline for this epic: pin exactly, and do not upgrade Vue past 3.5.40 until Vue Flow publishes a release naming 3.6.                                                                                                                                        |
| **NF8's "every artifact inspectable on disk" has no story here.**                                                                                                                                                        | It is satisfied structurally by later epics (the ledger is a plain SQLite file, run exports are plain files), not by tooling. Named here so the board's requirement-coverage check does not attribute it to EPIC-01.                                                                                                                                              |

---

**Related:** [Flows](../flows/EPIC-01-dev-environment-flows.md) · [Board](../board.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md) · [02-tech-stack.md](../../02-tech-stack.md)

[← Back to the delivery plan](../README.md)
