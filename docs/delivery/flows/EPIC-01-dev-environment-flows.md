# EPIC-01 flows — Development environment and toolchain

> Behavioural specification for [EPIC-01](../epics/EPIC-01-dev-environment.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor          | Description                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Developer**  | The author at M1; a Voyado colleague at M2. The person a broken inner loop costs an afternoon              |
| **pnpm**       | The package manager: workspace linking, `catalog:` resolution, `workspace:*`, `publishConfig` at pack time |
| **DeFlowd**    | The local daemon started by `pnpm dev` — orchestrator, ledger, HTTP + SSE, and in dev the Vite host        |
| **Vite**       | Runs in middleware mode _inside_ DeFlowd (D10). Never a second server, never behind a proxy                |
| **lefthook**   | The Go hook runner installed by `prepare`; owns pre-commit and pre-push                                    |
| **CI**         | GitHub Actions: `check`, a four-leg `test` matrix, and `browser-e2e`                                       |
| **Guard test** | A mechanical assertion protecting a rule that is silent in development and fatal in the published package  |

## Preconditions common to all flows

```gherkin
Background:
  Given the repository is the DeFlow monorepo at the layout described in 16-repo-layout.md §1
  And Node 24 is the active major unless a scenario says otherwise
  And pnpm 11.18.0 is installed via "npm i -g pnpm@11", never via "corepack enable"
  And git >= 2.38 is on PATH
  And no vendor agent CLI is installed, and no provider credential exists on this machine
  And no Docker daemon is running and no database server is installed
  And the catalog in pnpm-workspace.yaml pins typescript 6.0.3, vitest 4.1.10, vite 8.2.0,
      better-sqlite3 13.0.2, @agentclientprotocol/sdk 1.3.0, @biomejs/biome 2.5.6 and oxlint 1.76.0
```

The "no agent CLI, no credential, no Docker, no database server" line is not scene-setting. It is
the design goal this epic serves: **the whole application must run and be testable on one laptop
with no credentials, no cloud account, no Docker, no database server, and no money spent.** Any
scenario in this file that needed one of those would be a scenario describing a bug.

## Flow index

| Scenario    | Title                                                             | Verifies           | Type       |
| ----------- | ----------------------------------------------------------------- | ------------------ | ---------- |
| EPIC-01-S1  | First clone: four commands to a running app                       | KAR-01.1, KAR-01.3 | Happy path |
| EPIC-01-S2  | Frozen-lockfile install with zero compilation                     | KAR-01.1           | Happy path |
| EPIC-01-S3  | Install invokes node-gyp because the wrong pty package crept in   | KAR-01.1           | Failure    |
| EPIC-01-S4  | `corepack enable` fails on Node 26                                | KAR-01.1           | Failure    |
| EPIC-01-S5  | Dependency direction R1 and R2 are enforced by test               | KAR-01.1           | Edge case  |
| EPIC-01-S6  | `tsc -b` typechecks the solution graph, `vue-tsc` covers the SFCs | KAR-01.2           | Happy path |
| EPIC-01-S7  | Banned syntax is rejected by both the compiler and the runtime    | KAR-01.2           | Failure    |
| EPIC-01-S8  | The two breakages that are invisible in development               | KAR-01.1, KAR-01.2 | Failure    |
| EPIC-01-S9  | The daily inner loop: a save restarts the daemon                  | KAR-01.3           | Happy path |
| EPIC-01-S10 | A save mid-run, with effects left pending                         | KAR-01.3           | Edge case  |
| EPIC-01-S11 | The daemon fails to come back after a save                        | KAR-01.3           | Failure    |
| EPIC-01-S12 | An SFC edit hot-reloads without dropping the SSE stream           | KAR-01.3           | Happy path |
| EPIC-01-S13 | Someone adds a Vite proxy                                         | KAR-01.3           | Failure    |
| EPIC-01-S14 | Four slices, each with the right pool and timeout                 | KAR-01.4           | Happy path |
| EPIC-01-S15 | A git fixture inherits the developer's global config              | KAR-01.4           | Failure    |
| EPIC-01-S16 | Fake timers around a live child process deadlock                  | KAR-01.4           | Failure    |
| EPIC-01-S17 | Snapshots churn because the serializer was registered too late    | KAR-01.4           | Failure    |
| EPIC-01-S18 | `defineWorkspace` copied from a tutorial                          | KAR-01.4           | Failure    |
| EPIC-01-S19 | `:memory:` SQLite cannot test the one property that matters       | KAR-01.4           | Failure    |
| EPIC-01-S20 | A lint failure blocks a commit                                    | KAR-01.5, KAR-01.6 | Failure    |
| EPIC-01-S21 | The pre-commit budget, measured and defended                      | KAR-01.5, KAR-01.6 | Edge case  |
| EPIC-01-S22 | The formatter/linter ownership split holds                        | KAR-01.5           | Edge case  |
| EPIC-01-S23 | CI green on the named matrix                                      | KAR-01.6           | Happy path |
| EPIC-01-S24 | CI fails on one matrix leg only                                   | KAR-01.6           | Failure    |

---

## EPIC-01-S1 — First clone: four commands to a running app

**Verifies:** KAR-01.1, KAR-01.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: A fresh machine reaches a running DeFlow in four commands

  Background:
    Given a machine with a shell, a browser, Node 24 and pnpm 11.18.0, and nothing else
    And no C or C++ compiler is installed
    And the pnpm store is cold

  Scenario: clone, install, run
    When the developer runs "git clone https://github.com/<you>/DeFlow.git"
    And runs "cd DeFlow"
    And runs "pnpm install"
    And runs "pnpm dev"
    Then exactly one node process is running
    And exactly one socket is listening, on 127.0.0.1:7777
    And opening "http://127.0.0.1:7777" in a browser renders the DeFlow UI
    And no build step ran
    And no directory named "dist" exists under any package

  Scenario: what pnpm install did, observably
    Then the seven "@DeFlow/*" workspace packages are linked by symlink under node_modules
    And "better-sqlite3" resolved to a prebuilt binary with no compilation
    And "@lydell/node-pty" resolved to a per-platform optionalDependency with no compilation
    And "lefthook install" ran via the "prepare" script
    And ".git/hooks/pre-commit" now exists

  Scenario: cold start is inside the NF3 budget
    When the developer measures the time from "pnpm dev" to the first 200 response on "/api/health"
    Then the elapsed time is under 3 seconds
    And the number is recorded in docs/CONTRIBUTING.md
```

**Notes:** This is the M2 "a colleague installs it unaided" rehearsal, run on every milestone rather
than once. `docs/CONTRIBUTING.md` should open with literally `git clone && pnpm install && pnpm
dev`, and the reason it must be re-verified rather than trusted is that a monorepo accretes implicit
prerequisites — a global tool, an env file, a one-off script — that the person who added them never
notices. First install on a warm store takes seconds; cold, it is dominated by the two native
tarballs (`better-sqlite3` is 11.4 MB and installs in about 1 second; `@lydell/node-pty` in 514 ms).

---

## EPIC-01-S2 — Frozen-lockfile install with zero compilation

**Verifies:** KAR-01.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Versions are pinned in one place and resolve identically everywhere

  Scenario: the lockfile is authoritative
    When the developer runs "pnpm install --frozen-lockfile"
    Then the install completes with exit code 0
    And the install log contains no line matching "gyp"
    And pnpm-lock.yaml is unchanged afterwards

  Scenario: no package declares its own version of a shared dependency
    When a guard test parses every packages/*/package.json dependency block
    Then every "@DeFlow/*" dependency value is "workspace:*"
    And every shared third-party dependency value is "catalog:"
    And no literal semver string appears in any package's dependency block

  Scenario Outline: the two dependencies that must be pinned exact
    When the guard test reads the catalog entry for <package>
    Then the value has no "^" and no "~" prefix
    And the value is <version>

    Examples:
      | package                      | version |
      | @agentclientprotocol/sdk     | 1.3.0   |
      | tsdown                       | 0.22.14 |
      | @biomejs/biome               | 2.5.6   |

  Scenario: exactly one TypeScript version resolves across the workspace
    When the developer runs "pnpm ls typescript -r --depth 0"
    Then exactly one version is reported
    And it is 6.0.3
```

**Notes:** The exact pins are not fussiness. `@agentclientprotocol/sdk` went `0.4.5 → 1.3.0` **and**
changed both its npm scope and its GitHub org inside about ten months; `tsdown` is still 0.x; and
Biome's formatter output must not change under you, because a patch bump that reflows the repository
turns the next commit into an unreviewable diff. The single-TypeScript-version assertion is the
mechanical guard against D3's split-workspace failure mode arriving by accident through a transitive
dependency.

---

## EPIC-01-S3 — Install invokes node-gyp because the wrong pty package crept in

**Verifies:** KAR-01.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Neither native dependency may ever invoke node-gyp

  Scenario: upstream node-pty is added by mistake
    Given a package.json lists "node-pty" version 1.1.0 instead of "@lydell/node-pty"
    When the developer runs "pnpm install" on a machine with no compiler
    Then the install fails
    And the log shows the install script "node scripts/prebuild.js || node-gyp rebuild" falling back to a compile
    And the guard test that greps every package.json for a bare "node-pty" dependency fails first, in CI

  Scenario: the correct package degrades rather than failing
    Given "@lydell/node-pty" is an optionalDependency
    And the current platform has no matching per-platform package
    When the developer runs "pnpm install"
    Then the install completes with exit code 0
    And the daemon starts
    And "pnpm doctor" reports that the pty did not load and that "terminal/*" degrades to a no-TTY spawn
```

**Notes:** This is the number-one install-failure class for a solo-maintained tool distributed by
`npx`, and it is why `@lydell/node-pty` — which uses npm-native per-platform `optionalDependencies`
and installed in 514 ms with zero compilation — was chosen over upstream `node-pty@1.1.0`, whose
fallback-to-compile was verified to fail outright in a toolchain-less environment. The second
scenario is the important half: the correct behaviour on an unsupported platform is a working
install with a reduced capability, not a failed install. No agent process needs a TTY — ACP and
every headless mode are pure pipe protocols — so the degradation is survivable.

---

## EPIC-01-S4 — `corepack enable` fails on Node 26

**Verifies:** KAR-01.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Corepack is never used, in CI or in the setup docs

  Scenario: the command does not exist
    Given the active Node major is 26
    When the developer runs "corepack enable"
    Then the shell reports "corepack: command not found"
    And the troubleshooting table in 03-local-development.md §13 names this exact symptom

  Scenario: the guard catches it before a colleague does
    Given someone adds "corepack enable" to .github/workflows/ci.yml or to docs/CONTRIBUTING.md
    When the guard test greps the workflows and docs for that string
    Then the test fails naming the file and line

  Scenario: the packageManager field is still read
    Given package.json declares "packageManager": "pnpm@11.18.0"
    And pnpm was installed with "npm i -g pnpm@11"
    When the developer runs any pnpm command from a version other than 11.18.0
    Then pnpm reports the version assertion
```

**Notes:** Corepack was **removed from Node 25+ distributions** by TSC vote in March 2025 and is
bundled only through Node 24. A `corepack enable` line in CI or in setup docs therefore works today
and breaks the moment anyone moves to a current Node — which is precisely the M2 "a colleague
installs it unaided" scenario. The third scenario records the non-obvious survival: pnpm still reads
`packageManager` as a version assertion even though Corepack is gone.

---

## EPIC-01-S5 — Dependency direction R1 and R2 are enforced by test

**Verifies:** KAR-01.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The functional core is pure structurally, not by convention

  Scenario: R1 — core depends on nothing that can perform I/O
    When the guard test reads packages/core/package.json
    Then its dependency keys are exactly ["zod"]
    And no file under packages/core/src, excluding tests, contains "from 'node:"

  Scenario: R1 fails loudly the first time it is broken
    Given someone adds "better-sqlite3" to packages/core/package.json
    When the purity test runs
    Then it fails naming the added dependency
    And the reviewer is pointed at the rule that time, randomness and ids enter through ports declared in core and implemented in daemon or testkit

  Scenario: R2 — the daemon stays a leaf
    When the guard test scans every package.json
    Then only packages/cli depends on "@DeFlow/daemon"

  Scenario: the mock agent is an independent oracle
    When the guard test reads packages/mock-agent/package.json
    Then it has zero "@DeFlow/*" dependencies
    And the note in 16-repo-layout.md §1 is quoted in the failure message: if it depended on core, a bug in the domain model could be mirrored on both sides of the wire and cancel itself out
```

**Notes:** R1 is what makes NF9's "deterministic core" and the functional-core/imperative-shell
split structural rather than aspirational — `reduce`, `decide`, the patch policy engine and the
permission ladder are pure because `@DeFlow/core` has no dependency capable of impurity. The test is
cheap and it must be added **before the first temptation**, not after; by EPIC-06 there will be a
plausible-sounding reason to reach for a driver in core, and by then the test is a negotiation
rather than a fact.

---

## EPIC-01-S6 — `tsc -b` typechecks the solution graph, `vue-tsc` covers the SFCs

**Verifies:** KAR-01.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One typecheck command covers nine packages in dependency order

  Scenario: the solution build
    Given the root tsconfig.json contains only "references", one per package
    When the developer runs "pnpm typecheck"
    Then "tsc -b" runs the packages in dependency order
    And "vue-tsc --noEmit" runs against packages/web
    And both exit 0
    And the spec allows the solution build 120 s, not the slice's 30 s default,
        because a cold nine-package check is the suite's most expensive subprocess

  Scenario: a type error in core surfaces in the package that consumes it
    Given packages/core exports a function whose signature changes incompatibly
    When "tsc -b" runs
    Then the error is reported against the consuming package
    And no build artefact was emitted, because noEmit is true

  Scenario: the base config is exactly as specified
    When the guard test reads tsconfig.base.json
    Then "erasableSyntaxOnly" is true
    And "verbatimModuleSyntax" is true
    And "allowImportingTsExtensions" is true
    And "rewriteRelativeImportExtensions" is true
    And "noUncheckedIndexedAccess" is true
    And "exactOptionalPropertyTypes" is true
    And "module" and "moduleResolution" are both "nodenext"
```

**Notes:** `vue-tsc` is the single reason TypeScript is pinned at 6.0.3 rather than 7.0.2:
`typescript@7.0.2` ships only `bin/tsc` with no `tsserver` and no public compiler API, and
`vue-tsc@3.3.9`/Volar embed that API. No API means no template type-checking across the P0 views,
which is not an acceptable trade for a faster `tsc`. The third scenario is a guard rather than a
behaviour because these options are each individually load-bearing —
`rewriteRelativeImportExtensions` in particular is what lets `node src/main.ts` and a published
bundle both work from the same source.

**Amended 2026-08-06** (EPIC-07 gate): the first scenario did not fail an assertion — it ran out of
time. The integration slice's 30 s default was sized on an idle machine and the solution build is
the most expensive single subprocess the suite starts, so beside a full-suite run it was the ceiling
that broke, not the build. It is cold on every invocation: with `noEmit` the referenced projects are
not composite, so `.tsbuildinfo` buys nothing. **Measured 2026-08-06** on an 8-core macOS box,
TypeScript 6.0.3: **4.90 s, 5.03 s, 5.10 s and 5.20 s** idle — indistinguishable with and without
the buildinfo files present — against **13.8 s** beside twelve CPU hogs and **24.1 s** beside a live
full suite, having exceeded 30 s on the gate run itself. The spec now carries its own **120 s**
timeout: 24× the idle build and 5× the worst honest sample, still short enough to fail in reasonable
time if `tsc` wedges. What it asserts is unchanged — exit 0, with the compiler's own output as the
failure message. The neighbouring `vue-tsc` spec keeps the default; it covers one package and
measures **1.33 s** idle.

---

## EPIC-01-S7 — Banned syntax is rejected by both the compiler and the runtime

**Verifies:** KAR-01.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: erasableSyntaxOnly is enforced, and there is no escape hatch left

  Scenario Outline: the compiler rejects it
    Given a source file in packages/core containing <construct>
    When the developer runs "tsc -b"
    Then the output contains "error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled."
    And the suggested replacement is <replacement>

    Examples:
      | construct                                      | replacement                                                          |
      | enum Status { Ok, Fail }                       | const Status = { Ok: 'ok', Fail: 'fail' } as const, plus a union type |
      | const enum Level { Read }                      | the same; const enum also breaks isolatedModules                      |
      | namespace X { export const y = 1 }             | a module: export from a .ts file and import it                        |
      | constructor(private readonly db: Db) {}        | declare the field and assign it in the constructor body               |
      | @decorator on a class member                   | a plain higher-order function or an explicit registration call        |
      | import Foo = require('foo')                    | import Foo from 'foo'                                                 |

  Scenario: the runtime rejects it too, which is what a developer meets first
    Given the same file is left in place
    When the developer runs "pnpm dev"
    Then the daemon fails to start
    And stderr names an unsupported TypeScript syntax error
    And the failure occurs before "tsc" has been run, because the dev loop has no build step

  Scenario: there is no flag that would make it work
    Then the guard test asserts no script anywhere passes "--experimental-transform-types"
    And the reason is recorded: the flag was removed in Node 26.0.0
```

**Notes:** The asymmetry in the second scenario is the practical point. In a zero-build loop the
runtime is the first thing to complain, and a developer who has not internalised D4 will read
"unsupported TypeScript syntax" as a Node bug rather than as a design rule. The ban is permanent
because the escape hatch is gone: type stripping is stable (Stability 2 as of v24.12.0 / v25.2.0)
but `--experimental-transform-types` was removed in Node 26.0.0, so any syntax needing a runtime
emit is permanently unrunnable by `node file.ts` on a supported runtime.

---

## EPIC-01-S8 — The two breakages that are invisible in development

**Verifies:** KAR-01.1, KAR-01.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The failures that work locally and break only in the tarball are caught mechanically

  Scenario: a paths alias is added
    Given someone adds "paths": { "@/*": ["./src/*"] } to tsconfig.base.json
    And a file imports "@/patch.ts"
    When the developer runs "pnpm dev"
    Then it works, because the .ts file genuinely exists in the workspace
    And when the guard test runs, it fails naming the tsconfig and the alias
    And the failure message states that rewriteRelativeImportExtensions does not rewrite through paths aliases
    And it cites microsoft/TypeScript#61991
    And it states that the aliased specifier would survive into the published bundle and fail at runtime with module-not-found

  Scenario: a deep cross-package import is added
    Given a file imports "@DeFlow/core/src/reduce.ts" instead of "@DeFlow/core"
    When the developer runs "pnpm dev"
    Then it works, because the deep path exists in the workspace
    And when the guard test runs, it fails naming the file and the specifier
    And the failure message states that the deep path does not exist in the tarball, because publishConfig swaps exports to ./dist/index.js
    And it states that deep imports turn every internal file into public API

  Scenario: the correct forms pass
    Given the file imports "@DeFlow/core" and "./patch.ts"
    Then both guard tests pass
```

**Notes:** [16-repo-layout.md §9](../../16-repo-layout.md) calls the `paths` alias "the single most
expensive mistake available in this layout", and the reason is exactly the structure of these two
scenarios: **the development behaviour is correct**, so there is no signal until a user installs the
package. There is no warning, no deprecation and no type error — just a module-not-found in someone
else's terminal. Two greps, written on day one, are the whole defence.

---

## EPIC-01-S9 — The daily inner loop: a save restarts the daemon

**Verifies:** KAR-01.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: Every save is a crash-resume trial

  Background:
    Given "pnpm dev" is running under "node --watch --watch-path=packages"
    And the daemon holds the flock on the global lock file and has bumped daemon_epoch

  Scenario: an edit to engine code restarts the process
    When the developer saves a change to packages/core/src/reduce.ts
    Then the running daemon process exits
    And a new daemon process starts within 2 seconds
    And the new process reopens the ledger at $XDG_DATA_HOME/DeFlow/ledger.db
    And it reduces the event log and rebuilds RunState
    And it bumps daemon_epoch and retakes the flock
    And "/api/health" responds again

  Scenario: the restart is not "fixed" into a state-preserving hot reload
    Then the guard test asserts the dev script uses "node --watch" and not a process-state-preserving reloader
    And docs/CONTRIBUTING.md records why: the restart is free, continuous, adversarial testing of F4.2
```

**Notes:** For most projects a restart-on-save is a mild nuisance. Here it is the cheapest possible
test of the single property that most competing tools lack: if resume breaks, you find out in
seconds while writing unrelated code, rather than in hour three of a real run. The practical habit
this enables — keep a mock run going in another tab while working on the scheduler — is worth
writing into `CONTRIBUTING.md`, because it turns every save into a crash-resume trial for free.

---

## EPIC-01-S10 — A save mid-run, with effects left pending

**Verifies:** KAR-01.3 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: A restart mid-flight resumes rather than repeats

  Background:
    Given a mock run is in progress with at least one node running
    And at least one effect row is in state "pending"
    And at least one node has already completed

  Scenario: the new daemon resumes from the last completed boundary
    When the developer saves a file and the daemon restarts
    Then the completed node is not re-executed
    And every effect row left "pending" by the previous daemon life is reconciled
    And orphaned child processes are reaped by matching (pid, process_start_time), never by bare pid
    And the run continues or halts with a typed failure, and never wedges

  Scenario: a stale-epoch write from the old process is rejected
    Given the previous daemon process has not fully exited and attempts a ledger write
    When the write carries the previous daemon_epoch
    Then the write is rejected
    And the new daemon's state is unaffected

  Scenario: reconciliation legitimately cannot tell
    Given an effect landed in the world but its "done" row never committed
    When the new daemon probes it
    Then the reconciliation result is "unknown"
    And the run pauses for a human decision rather than guessing
```

**Notes:** The third scenario encodes a finding that is a **product** decision, not an engineering
one: the gap between an effect landing in the world and its `state='done'` row committing is
irreducible, reconciliation can legitimately return `'unknown'`, and there is **no correct automatic
action** (A1-5, graded **High**). The human-gate path for `'unknown'` is designed on day one of W4.
It appears in this file because the dev loop is where it will first be encountered — a save at
exactly the wrong microsecond is a far more frequent producer of this state than a real crash. The
implementing stories are KAR-06.4 and KAR-06.9; these scenarios stay pending until then.

---

## EPIC-01-S11 — The daemon fails to come back after a save

**Verifies:** KAR-01.3 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: A failed restart is a real bug, not a dev-loop annoyance

  Scenario: the reducer cannot reduce its own log
    Given the ledger contains an event whose kind the current reducer does not know
    When the daemon restarts after a save
    Then the daemon exits with a typed startup failure
    And the failure names the offending event kind and its seq
    And it does not start serving on 7777 in a partially-reduced state

  Scenario: the developer's response is to fix the code, not to delete the ledger
    Then docs/CONTRIBUTING.md states that the ledger is the source of truth and a failed restart means the reducer, the migration or the reconcile probe is wrong
    And it states that deleting ledger.db to "get moving again" destroys the evidence

  Scenario: the ledger can be snapshotted for a bug report before anything is changed
    When the developer runs "DeFlow ledger snapshot <runId> --out /tmp/DeFlow-bug-1234.db"
    Then a single consistent file is produced with no WAL sidecar
    And "PRAGMA integrity_check" on it returns "ok"
    And the events can be read with plain sqlite3
```

**Notes:** The middle scenario is a documentation assertion rather than a code one, and it is here
deliberately: the instinct when the loop breaks is to clear state, and doing that once destroys the
only reproduction of a durability bug you will ever get. `VACUUM INTO` is **measured at 1007 ms for
a 193 MB database**, so the snapshot is cheap enough that there is no excuse. NF8's "every artefact
inspectable on disk in an open format" is what makes the third scenario possible at all.

---

## EPIC-01-S12 — An SFC edit hot-reloads without dropping the SSE stream

**Verifies:** KAR-01.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: One port, one origin, HMR and SSE together

  Background:
    Given "pnpm dev" is running with DeFlow_DEV=1
    And Vite was created with server: { middlewareMode: { server } } against DeFlowd's own node:http server
    And a browser tab is connected to "/api/stream"

  Scenario: the UI hot-reloads and the stream survives
    When the developer saves a change to a .vue file under packages/web/src
    Then the browser applies an HMR update
    And the daemon process does NOT restart
    And EventSource.readyState never leaves OPEN
    And no event is missed and none is duplicated

  Scenario: there is no CORS, because there is no second origin
    When the browser requests "/api/runs"
    Then the request succeeds without any Access-Control-Allow-Origin header being required
    And no preflight request was made

  Scenario: the API wins over the SPA fallback
    When a request is made to "/api/stream"
    Then the response content-type is "text/event-stream"
    And it is not the SPA index.html
    And the guard test asserts the "/api" route is registered before the catch-all
```

**Notes:** The reason the daemon must _not_ restart on a `.vue` save is that
`--watch-path=packages` covers `packages/web` too; the watch path and the Vite root overlap, and if
both react to the same save you get a restart _and_ an HMR update, the stream drops, and the loop
becomes unusable while a run is going. The mount-order assertion looks pedantic until the first time
`/api/stream` returns `index.html` with a 200 and an SSE client sits there silently consuming HTML.

---

## EPIC-01-S13 — Someone adds a Vite proxy

**Verifies:** KAR-01.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The proxy rule is enforced, not merely documented

  Scenario: the guard fires
    Given someone adds "server: { proxy: { '/api': 'http://localhost:7778' } }" to packages/web/vite.config.ts
    When the guard test greps the repository for a proxy key in any Vite config
    Then the test fails naming the file
    And the failure message lists the three documented consequences

  Scenario Outline: the three consequences, restated in the failure message
    Then the message includes "<failure mode>" and "<why it is fatal here>"

    Examples:
      | failure mode                        | why it is fatal here                                                              |
      | events buffer until the stream ends | the live plan graph would appear frozen for hours and then flood                   |
      | the stream dies after some minutes  | runs are measured in hours, so the dev loop could not exercise the core use case    |
      | close events do not propagate       | leaked subscriptions per reload, and the backpressure path never gets tested        |

  Scenario: the production reverse-proxy note is not a licence to proxy in dev
    Then the API contract still documents "timeout: 0", "proxyTimeout: 0", "X-Accel-Buffering: no",
      "Cache-Control: no-cache, no-transform" and no compression middleware
    And the documentation states these exist for anyone who later puts a reverse proxy in front of DeFlowd, not for the dev loop
```

**Notes:** All three failure modes are reported against Vite and none is theoretical
(vitejs/vite#12157, discussion #10851). The rule in
[03-local-development.md §4.3](../../03-local-development.md) is blunt — _if you ever find yourself
adding `server.proxy` to `packages/web/vite.config.ts`, stop_ — and the guard test exists because
the temptation reappears every time the daemon restart feels slow. The trade being refused is a
slightly faster restart in exchange for debugging your transport instead of your product.

---

## EPIC-01-S14 — Four slices, each with the right pool and timeout

**Verifies:** KAR-01.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One root config, four project slices, correct isolation per slice

  Scenario Outline: each slice resolves and runs with its specified configuration
    When the developer runs "pnpm vitest run --project <project>"
    Then at least one spec is collected from "<include>"
    And the effective timeout is <timeout>
    And the effective pool is <pool>

    Examples:
      | project     | include                                     | timeout | pool    |
      | unit        | packages/*/src/**/*.test.ts                  | default | threads |
      | integration | packages/*/test/integration/**/*.test.ts     | 30000   | forks   |
      | e2e         | e2e/**/*.test.ts                             | 180000  | forks   |
      | web         | packages/web (browser mode, real Chromium)   | default | browser |

  Scenario: e2e is additionally serialised
    Then the e2e project sets singleFork true and fileParallelism false
    And the reason is recorded: those specs bind ports and mutate a shared data directory

  Scenario: the unit slice is fast enough to run constantly
    When the developer runs "pnpm test:unit" on the scaffolded workspace
    Then it completes in about a second

  Scenario: a mistyped project name does not silently pass
    When the developer runs "pnpm vitest run --project unti"
    Then the command reports that no project matched
    And it does not exit 0 having run nothing
```

**Notes:** `pool: 'forks'` for any slice that spawns children is not a preference — worker threads
share a process, and a spec that leaks a child process or an fd poisons its neighbours in ways that
are miserable to diagnose. The last scenario guards a real trap: a `--project` filter that matches
nothing can look exactly like a green run, which is how a whole slice quietly stops being executed
in CI.

---

## EPIC-01-S15 — A git fixture inherits the developer's global config

**Verifies:** KAR-01.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Git fixtures are hermetic, or they are worthless

  Scenario: the developer's ~/.gitconfig leaks in
    Given the developer's global git config sets init.defaultBranch to "trunk"
    And a fixture calls "git init" without an isolated environment
    When the test asserts the repository is on branch "main"
    Then the test fails locally and passes in CI
    And the inverse happens for a developer whose global config sets commit.gpgsign

  Scenario: the hermetic environment
    Given the fixture sets GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_SYSTEM=/dev/null
    And it sets GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL explicitly
    When "git init -b main" runs in a fresh tmpdir
    Then the branch is "main" regardless of the developer's own configuration
    And commits succeed without a signing key

  Scenario: the guard
    When the guard test scans @DeFlow/testkit for every git invocation
    Then each one passes the isolated environment
    And a new invocation that omits it fails the test

  Scenario: isomorphic-git is not an alternative
    Then the guard test asserts "isomorphic-git" and "simple-git" appear in no package.json
    And the reason is recorded: neither has worktree support at all, and worktrees are F5.1
```

**Notes:** This is the classic "passes locally, fails in CI" and its equally confusing inverse, and
in this project it is not a nuisance — EPIC-07's entire worktree lifecycle is tested against real
`git`, so an unhermetic fixture makes those results meaningless. The last scenario closes off the
tempting shortcut: `isomorphic-git@1.40.0`'s full export list was enumerated at runtime and there is
no `worktree*` function at all, and `simple-git@3.36.0` has no worktree API either. **Verified
2026-08-02.**

---

## EPIC-01-S16 — Fake timers around a live child process deadlock

**Verifies:** KAR-01.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Time enters through an injected Clock, never through fake timers around a subprocess

  Scenario: the deadlock
    Given a test spawns a real child process
    And the test calls "vi.useFakeTimers()" while that child is alive
    When the test awaits output from the child
    Then the await never resolves
    And the spec hangs for the full 30 second integration timeout
    And it typically passes locally and hangs in CI

  Scenario: the TestClock alternative
    Given the engine takes time through the Clock port with now, sleep and setTimer
    And the test injects a TestClock
    When the test advances the clock by six hours
    Then a registered timer fires exactly once
    And a six-hour human gate is exercised in microseconds
    And no real timer was faked, so the child's I/O still arrives

  Scenario: a narrowly-scoped exception
    Given a pure unit test with no child process genuinely needs fake timers
    When it calls vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    Then nextTick and queueMicrotask remain real
    And the file is on the guard test's explicit allowlist

  Scenario: the guard
    When the guard test greps for "useFakeTimers" outside the allowlist
    Then it fails naming the file
```

**Notes:** `vi.useFakeTimers()` wraps `@sinonjs/fake-timers@15.4.0` and freezes the event loop's
timers, so the child's real I/O never arrives. This is not a corner case for DeFlow specifically:
the retry-backoff, budget-ceiling, no-progress-detection and long-suspension paths (F4.5–F4.8) are
all _about time around child processes_, so they are exactly the tests most likely to reach for a
fake timer and exactly the ones that will deadlock. The `Clock` port is also what NF9 requires —
no nondeterminism outside adapter boundaries — so this is one mechanism serving two requirements.

---

## EPIC-01-S17 — Snapshots churn because the serializer was registered too late

**Verifies:** KAR-01.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: A normalising snapshot serializer is registered before the first snapshot exists

  Scenario: without the serializer
    Given no snapshot serializer is registered
    And a snapshot is written for an object containing a ULID, a timestamp, a duration and an absolute tmp path
    When the same test runs again
    Then the snapshot differs
    And every run produces a diff
    And the developer learns to run "-u" reflexively, which is worse than having no snapshots

  Scenario: with the serializer
    Given test/setup.ts registers a serializer normalising ts, run and node and event ids, durations, absolute paths, ports and worktree directory names
    When the same test runs twice
    Then the two outputs are identical
    And a genuine change to the event shape still produces a readable diff

  Scenario: file snapshots for structural artefacts
    When a PlanGraph is asserted with toMatchFileSnapshot("__snapshots__/plan-v3.json")
    Then a real file is written next to the spec
    And it diffs readably in a pull request

  Scenario: the guard
    When the guard test inspects the setup file order
    Then the serializer registration precedes any snapshot loading
```

**Notes:** The failure mode here is social rather than technical: an assertion mechanism that
produces a diff on every run stops being read, and once `-u` becomes a reflex the snapshots are
actively harmful — they will happily record a regression. This is why the strategy states the rule
as an ordering constraint ("before writing the first snapshot") rather than as a nice-to-have. It
matters most for `render(segments) -> string`, the pure context-packet renderer, where golden files
per node archetype turn a context regression into a readable CI diff.

---

## EPIC-01-S18 — `defineWorkspace` copied from a tutorial

**Verifies:** KAR-01.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Vitest 4 removed the workspace file, and the failure should be immediate

  Scenario: the removed API
    Given someone adds a vitest.workspace.ts using defineWorkspace, following a tutorial
    When the test suite is run
    Then the configuration does not take effect
    And the guard test fails naming the file
    And the failure message states that vitest.workspace.ts and defineWorkspace were REMOVED in Vitest 4 and that any tutorial showing them is pre-3.2

  Scenario: the supported shape
    Given a single root vitest.config.ts using test.projects
    Then all four slices resolve
    And "pnpm vitest --project unit" runs only the unit slice
```

**Notes:** Small scenario, real cost. The removal is recent enough that the majority of search
results still show the old shape, and the failure when you copy one is not a clean error — the
config is simply ignored, and you get a run that looks plausible over the wrong set of files.

---

## EPIC-01-S19 — `:memory:` SQLite cannot test the one property that matters

**Verifies:** KAR-01.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Durability tests are file-backed, always

  Scenario: the shortcut fails on the property that matters
    Given a durability test opens ":memory:"
    When it closes the database and tries to construct a fresh engine over the same handle
    Then there is nothing to reopen
    And WAL was never exercised
    And fsync and ordering bugs are hidden

  Scenario: the real code path
    Given the fixture opens a database file inside the tmpdir
    And it executes "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000"
    When the test writes events, calls close(), and constructs a fresh engine over the same file
    Then the events are read back in order
    And this is the same code path a daemon restart takes

  Scenario: the permitted use
    Given a pure projection unit test feeds events into reduce() and asserts on the reduced state
    Then ":memory:" is acceptable, because no durability semantics are involved

  Scenario: the guard
    When the guard test greps packages/*/test/integration for ":memory:"
    Then it fails naming the file
```

**Notes:** `:memory:` cannot exercise WAL, cannot be reopened after a simulated crash, and hides
fsync and ordering bugs — which is to say it cannot test F4.2, the entire durability thesis. There
is no performance excuse for the real driver either: `better-sqlite3@13.0.2` ships prebuilt N-API
binaries and installed in **1 second** with zero compilation, so file-backed SQLite costs the suite
nothing. The `synchronous=` value in the second scenario comes from KAR-00.5's APFS measurement, not
from the Linux default.

---

## EPIC-01-S20 — A lint failure blocks a commit

**Verifies:** KAR-01.5, KAR-01.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The correctness net sits in the loop where it is cheapest

  Background:
    Given lefthook is installed via the "prepare" script
    And pre-commit runs a format job and a lint job in parallel

  Scenario: a floating promise is rejected at commit time
    Given a staged .ts file calls an async function without awaiting it or handling its rejection
    When the developer runs "git commit"
    Then the commit is rejected
    And the output names "typescript/no-floating-promises"
    And the developer fixes it before the code reaches a branch

  Scenario: formatting is fixed and re-staged rather than rejected
    Given a staged .ts file is misformatted
    When the developer runs "git commit"
    Then "biome check --write --no-errors-on-unmatched" rewrites it
    And "stage_fixed: true" re-stages the rewritten file
    And the commit succeeds with the formatted content

  Scenario: the hook only looks at staged files
    Given the repository contains an unrelated file with a lint error that is not staged
    When the developer commits a clean staged change
    Then the commit succeeds
    And the unrelated error is caught later by "pnpm lint" in CI

  Scenario: what pre-commit deliberately does not do
    Then the lint job does not pass "--type-aware"
    And typecheck and the unit slice run on pre-push instead
    And the full suite runs in CI
```

**Notes:** A floating promise in a three-hour orchestrator run is a silent data-loss bug, not a
style issue — which is why the six type-aware rules are errors rather than warnings, and why oxlint
was chosen: type-aware linting went stable in **1.75.0** and covers 59 of typescript-eslint's 61
type-aware rules at 12–18× the speed, so those rules are affordable at all. The fourth scenario is
the budget discipline in behavioural form: the hook catches the cheap, fast class and defers
everything else.

---

## EPIC-01-S21 — The pre-commit budget, measured and defended

**Verifies:** KAR-01.5, KAR-01.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The hook stays under two seconds or it stops existing

  Scenario: the measurement
    Given a realistic staged change of 20 files across .ts and .vue
    When the developer times the pre-commit hook five times
    And alternates each of those runs with a control timing the hook's own two jobs bare
    Then on a quiet machine the median wall-clock time is under 2 seconds
    And on a busy one the median of the paired hook-over-control ratios is under 2
    And the number is recorded in docs/CONTRIBUTING.md

  Scenario: a proposed addition breaks the budget
    Given someone adds "pnpm typecheck" to the pre-commit jobs
    When the timing test runs
    Then the hook costs more than 2 seconds and more than twice its own two jobs
    And the test fails
    And the failure message states that the moment you type "--no-verify" the hooks stop existing

  Scenario: the jobs run in parallel
    Then lefthook.yml sets "parallel: true" on pre-commit
    And the format and lint jobs do not serialise

  Scenario: pre-push carries what pre-commit refuses
    When the developer runs "git push"
    Then "pnpm typecheck" runs
    And "pnpm vitest run --project unit" runs
    And a failure in either aborts the push
```

**Notes:** This scenario exists because the budget will be attacked repeatedly and always for a good
reason. Making it an assertion with a recorded number converts the argument from taste into
evidence. `lefthook@2.1.10` is what makes 2 seconds achievable: one Go binary shipped through
optionalDependencies, parallel jobs, and built-in staged-file globbing, replacing husky **and**
lint-staged with a single dependency.

---

## EPIC-01-S22 — The formatter/linter ownership split holds

**Verifies:** KAR-01.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: One owner per concern, enforced by configuration

  Scenario: Biome does not lint
    When the guard test parses biome.json
    Then "linter.enabled" is false
    And "html.experimentalFullSupportEnabled" is true
    And "html.formatter.enabled" is true

  Scenario: the .vue opt-in is actually doing something
    Given a deliberately misformatted SFC under packages/web
    When the developer runs "biome check --write packages/web"
    Then the file is rewritten
    And "git diff --name-only -- '*.vue'" is not empty

  Scenario: without the opt-in, the silence is the bug
    Given the html block is removed from biome.json
    When the developer runs "biome check --write packages/web"
    Then the command exits 0
    And no .vue file changed
    And the guard test from the first scenario is what catches this, because nothing else will

  Scenario: two linters over one file fight
    Given Biome's linter is enabled alongside oxlint over the same glob
    When both run twice in sequence
    Then at least one diagnostic is reported by both tools
    And at least one autofix applied by one tool is reverted by the other

  Scenario: the accepted gap is documented rather than forgotten
    Given a .vue file registers a component its template never uses
    When "oxlint" runs
    Then nothing is reported
    And docs/CONTRIBUTING.md records that oxlint lints only the <script> block, that template rules need ESLint, and that this is deliberately out of M1
```

**Notes:** The third scenario is the whole reason KAR-00.6 exists as an M0 spike: a green run and
zero formatting is indistinguishable from a green run and correct formatting, and a `stage_fixed:
true` hook that quietly does nothing is worse than no hook. The fifth scenario is included so the
gap is a decision on record rather than something discovered in a review at M2.

---

## EPIC-01-S23 — CI green on the named matrix

**Verifies:** KAR-01.6 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: CI covers both target platforms and both supported Node majors

  Background:
    Given .github/workflows/ci.yml defines jobs "check", "test" and "browser-e2e"
    And concurrency is grouped on ci-${{ github.ref }} with cancel-in-progress true
    And every runs-on value is an explicit pinned image

  Scenario: the check job
    Given "check" runs on ubuntu-26.04
    When it runs
    Then "pnpm biome ci ." passes
    And "pnpm oxlint --type-aware" passes
    And "pnpm typecheck" passes

  Scenario Outline: the test matrix
    Given the test job runs on <os> with Node <node>
    When "pnpm vitest run --project unit --project integration" runs
    Then it passes
    And DeFlow_KEEP_TMP is set for the run

    Examples:
      | os           | node |
      | ubuntu-26.04 | 24   |
      | ubuntu-26.04 | 26   |
      | macos-26     | 24   |
      | macos-26     | 26   |

  Scenario: the browser job runs on Linux only
    Given "browser-e2e" runs on ubuntu-26.04
    When "pnpm exec playwright install --with-deps chromium" and the web and e2e slices run
    Then they pass
    And the job is not duplicated onto macOS, so macOS minutes are not tripled

  Scenario: Node 22 is nowhere
    Then "engines" does not list Node 22
    And no matrix leg uses Node 22
    And the reason is recorded: Node 22 entered maintenance on 2025-10-21, and listing it in engines obliges you to test it

  Scenario: crash-fuzz is not referenced yet
    Then the workflow contains no "--project crash-fuzz" step
    And a comment records that EPIC-03 adds both the project and the step together
```

**Notes:** The matrix is exactly four legs for a reason: Node 24 is the Active LTS floor per D2 and
Node 26 is Current, and macOS and Linux are the two platforms NF5 promises at M1. The last scenario
avoids a self-inflicted red build — the strategy document's example workflow includes a `crash-fuzz`
step that has nothing to run until the ledger exists.

---

## EPIC-01-S24 — CI fails on one matrix leg only

**Verifies:** KAR-01.6 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: A single-platform failure is visible, diagnosable and does not hide the others

  Scenario: the other legs still report
    Given the test matrix sets "fail-fast: false"
    And an integration spec fails on macos-26 with Node 26
    When the workflow completes
    Then the other three legs still ran to completion and reported their own status
    And the failing leg is identifiable by name in the checks list

  Scenario: the evidence is uploaded
    Given DeFlow_KEEP_TMP=1 was set for the run
    When the leg fails
    Then "actions/upload-artifact@v4" uploads "/tmp/DeFlow-*"
    And the artefact name includes the os and node values, so it does not collide with another leg's upload
    And the developer can download the preserved tmpdir and inspect the worktree with git status, git log and git worktree list

  Scenario: a macOS-only failure is diagnosable without a Mac in front of you
    Given the failure is a git worktree behaviour difference on a case-insensitive filesystem
    When the developer opens the uploaded tmpdir
    Then the worktree directory names are visible
    And the guard against it — sanitising generated ids to a single case and running every id through "git check-ref-format --branch" — is named in the failure triage notes

  Scenario: an implicit runner migration is prevented rather than diagnosed
    Given someone changes a runs-on value to "macos-latest"
    When the guard test greps the workflows for "-latest"
    Then it fails
    And the failure message records that macos-latest migrated to macOS 26 on Apple Silicon between 8 and 15 June 2026, shifting native module prebuilds, node-pty behaviour and filesystem case-sensitivity at once
```

**Notes:** `DeFlow_KEEP_TMP=1` plus `upload-artifact` on failure is what makes a CI-only worktree
failure diagnosable at all — without it, post-mortem on a broken worktree from a platform you are
not sitting in front of is guesswork. The third scenario names a real, low-probability-high-
confusion case (A5-7: macOS/APFS case-insensitivity could collide worktree paths for node ids
differing only in case), which is exactly the kind of thing that only ever appears on one matrix
leg. The fourth is the cheapest control in this file: an unpinned runner image is an architecture
change that lands under you without a commit.

---

**Related:** [EPIC-01](../epics/EPIC-01-dev-environment.md) · [Board](../board.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
