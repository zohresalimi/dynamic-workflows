# Contributing to DeFlow

```bash
git clone && pnpm install && pnpm dev
```

Then open **http://127.0.0.1:7777**. That is the whole setup — no build step, no
second process, no `.env` required, no credentials.

The full reference is [03-local-development.md](./03-local-development.md). This file records the
things that must be re-verified against a clean checkout rather than trusted, and the handful of
decisions that look like annoyances until you know why they exist.

---

## The dev loop

`pnpm dev` starts **one** Node process serving the API, the SSE stream and the UI from one origin.
Vite runs in middleware mode inside DeFlowd, so its HMR websocket rides the daemon's own
`node:http` server rather than opening a second one (D10, [ADR 0011](./adr/0011-vite-middleware-mode-inside-the-daemon.md)).

| You save…                                        | What happens                                     |
| ------------------------------------------------ | ------------------------------------------------- |
| anything under `packages/{core,ledger,adapters,daemon,cli,mock-agent}/` | the daemon restarts, in well under 2 s |
| a `.vue` or anything else under `packages/web/`   | HMR updates the browser; the daemon does not restart |

Vite needs **two** options to do that, not one. `server: { middlewareMode: { server }, ws: { server } }`:
`middlewareMode.server` is consumed only when forwarding to a configured upstream, and it is
`server.ws.server` that attaches the HMR websocket to DeFlowd's socket. Verified 2026-08-04 against
`vite@8.2.0`'s shipped code; ADR 0011 and 03-local-development.md §4.2 carry the correction, because
both originally read the type declaration's doc comment as meaning HMR. Drop `ws.server` and Vite
silently opens a second listening socket on port 24678.

`node --watch` runs a small supervisor process alongside the daemon. It serves nothing and listens
on nothing: **exactly one socket is listening**, on `127.0.0.1:7777`, and it belongs to the daemon.
That is the property to check if you ever suspect a second server has appeared —
`lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` must print one line.

`packages/web` is deliberately **not** in the dev script's `--watch-path` list. The watch path and
the Vite root would overlap, so a single `.vue` save would produce a daemon restart *and* an HMR
update: the SSE stream would drop and the loop would be unusable while a run is going.

There is also deliberately **no `--env-file-if-exists=.env`** on the dev script, even though
[03-local-development.md §3](./03-local-development.md) shows one. **Verified 2026-08-04 on Node
24.18.0:** a relative env-file path combined with `--watch`/`--watch-path` makes the watcher react
to writes anywhere under the working directory, and Vite's dependency optimizer writes a fresh
`node_modules/.vite/deps_temp_*` on every boot — so the daemon restarts, Vite re-optimizes, and the
loop restarts about twice a second forever. An absolute path does not reproduce it. The daemon loads
`.env` in-process instead (`packages/daemon/src/env.ts`), which is portable and cannot regress into
this; a guard test rejects the flag if anyone re-adds it from the docs.

### The restart is the test

Every save kills DeFlowd mid-flight and starts a new process. Do not "fix" this with a hot-reload
scheme that preserves process state — **the restart is the test**. It is free, continuous,
adversarial testing of **F4.2** (resume after crash), which is the single property most competing
tools lack and the one hardest to be confident in. Keep a mock run going in another tab while you
work on the scheduler and every save becomes a crash-resume trial.

If the daemon does not come back cleanly, that is a real bug in the reducer, the migration or the
reconcile probe — not a dev-loop annoyance.

### Do not delete the ledger

When a restart fails, the instinct is to clear state. Resist it —
**the ledger is the source of truth**, and deleting `ledger.db` to get moving again
**destroys the evidence** — the only reproduction of a durability bug you are likely to get.
Snapshot it first:

```bash
DeFlow ledger snapshot <runId> --out /tmp/DeFlow-bug-1234.db
```

`VACUUM INTO` is measured at about 1 second for a 193 MB database, so there is no excuse.

### Readable logs

```bash
pnpm dev:pretty                                   # pipes through pino-pretty
pnpm dev | pino-pretty | grep '"mod":"scheduler"' # one subsystem
```

`pino-pretty` is a **pipe**, never a runtime transport: a transport spawns a worker thread inside
DeFlowd and turns production logs into something other than ndjson. Every subsystem logs through
`log.child({ mod, runId })`, and redaction (`*.authorization`, `*.token`, `*.headers.cookie`,
`env.ANTHROPIC_API_KEY`, `env.OPENAI_API_KEY`, `env.GITHUB_TOKEN`) is configured at the root logger.

---

## Lint and format

```bash
pnpm format   # biome check --write . — the only thing that rewrites files
pnpm lint     # oxlint --type-aware && biome check . — checks, never writes
```

**One owner per concern.** `biome.json` sets `"linter": { "enabled": false }`: Biome formats
everything (`.ts`, `.js`, `.json`, `.jsonc`, `.css`, `.html`, `.vue`), and `oxlint` — with
`--type-aware` — is the linter for `packages/{core,ledger,adapters,daemon,cli}`. Running both
linters over the same file gives duplicate diagnostics and autofixes that fight each other across
runs; `test/integration/lint-format-pipeline.test.ts` turns Biome's linter back on once,
mechanically, to prove that duplication is real rather than assumed.

**Biome's `.vue` support is off by default**, gated behind `html.experimentalFullSupportEnabled` in
`biome.json`. Without that flag `biome check` silently no-ops on every `.vue` file in
`packages/web` — a green run and zero formatting — which is exactly the failure mode a
`stage_fixed: true` pre-commit hook (KAR-01.6) must never hit unnoticed. A guard test
(`test/lint-format-pipeline.test.ts`) asserts the flag is set rather than trusting it.

**The known gap: oxlint sees only the `<script>` block of a `.vue` file.** Template rules —
`vue/no-unused-components` and the rest of `eslint-plugin-vue`'s surface — are not enforced at M1.
A `.vue` file that registers a component its template never uses will not be flagged by `oxlint`.
This is deliberate, not an oversight: `eslint@10.8.0` + `eslint-plugin-vue@10.10.0` +
`vue-eslint-parser@10` + `eslint-plugin-oxlint@1.76.0`, scoped to `packages/web/**/*.vue` only, is
deferred to M2 (docs/02-tech-stack.md §8).

**oxlint's scope excludes every `test/` directory.** Every package's `tsconfig.json` sets
`"include": ["src"]` (`packages/testkit` adds `"bin"`), so `test/` directories sit outside every
project's type-checked graph — `pnpm typecheck` never sees them, and `--type-aware`'s tsconfig
auto-discovery falls back to weaker defaults for a file no config `"include"`s, producing both
false positives and false negatives rather than the real project's strict settings. `.oxlintrc.json`
scopes type-aware linting to what is actually typechecked; widening it needs `test/` added to a
tsconfig's `"include"` first, which is its own decision, not a side effect of a lint-pipeline story.

---

## Git hooks

`pnpm install` runs `prepare`, which is `lefthook install`, so the hooks are there after a clone
with no third step. There is no `|| true` on that script: if it fails you have no hooks, and the one
thing worse than no hooks is hooks you believe in. The consequence is that `pnpm install` needs a
git work tree — running it in a directory with no `.git` fails with `not a git repository`, which is
also why `test/integration/frozen-lockfile-install.test.ts` does a real `git init` first.

| Hook           | Jobs                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| **pre-commit** | `format` (`biome check --write` over staged files, `stage_fixed: true`) and `lint` (`oxlint`, no `--type-aware`), in parallel |
| **pre-push**   | `typecheck`, `lint` (`pnpm lint`, type-aware), `unit`                                    |

**The type-aware rules are on pre-push, not pre-commit — and that is a deviation from KAR-01.6's
AC4, taken deliberately.** AC4 asks for a commit carrying a floating promise to be *rejected*, while
AC1 and `EPIC-01-S20`'s own fourth scenario forbid `--type-aware` in the pre-commit lint job. Both
cannot hold, because all six of the correctness rules `.oxlintrc.json` turns on —
`typescript/no-floating-promises` first among them — live in oxlint's type-aware engine and are
simply not evaluated without the flag. **Measured 2026-08-04 on oxlint 1.76.0:** a plain `oxlint`
over a file with a floating promise exits 0 and reports nothing. So the net moved to the next hook
down, which is still before the code reaches a branch.
`test/integration/git-hooks.test.ts` asserts *both* halves, so if oxlint ever reports the rule
without a type graph the first assertion fails and the job moves back to pre-commit where AC4
wanted it.

**The pre-commit lint job passes `--no-error-on-unmatched-pattern`, and it has to.** `.oxlintrc.json`
ignores every `test/` directory, and oxlint exits 1 with `No files found to lint` when its ignore
patterns eat the whole argument list — so without the flag a test-only commit, which in a TDD
project is most of them, fails a hook it has no business failing. Found the way these things usually
are: the hook rejected the commit that added it.

**`.vue` is not in the pre-commit format glob.** `stage_fixed: true` means whatever Biome writes is
in the commit before anyone reads it, and Biome's SFC support is still behind
`html.experimentalFullSupportEnabled`. KAR-00.6 is the spike that reviews a real before/after diff
and leaves a verdict in `docs/spikes/S7-biome-vue.md`; that note does not exist yet, so the answer
is no. `test/git-hooks.test.ts` holds the note and the glob to each other in both directions — the
day the note says `safe`, the test fails until `vue` is added. Until then `.vue` is formatted by
`pnpm format`, and CI's `biome ci .` catches a file that skipped it.

---

## CI

Three jobs in `.github/workflows/ci.yml`: `check` (Linux, Node 24), `test` (a four-leg matrix,
`{ubuntu-26.04, macos-26} × {24, 26}`, `fail-fast: false`) and `browser-e2e` (Linux only — a browser
job on the macOS legs triples macOS minutes for no extra signal).

**Action pins, verified against the marketplace on 2026-08-04** — roadmap risk A2-7, which recorded
`pnpm/action-setup@v6` and `actions/setup-node@v6` as *unverified*:

| Action                                | Pinned | What was found                                                                                              |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `actions/checkout`                    | `v5`   | tag exists; `v7.0.1` is the current release                                                                 |
| `pnpm/action-setup`                   | `v6`   | tag exists and is current — `v6.0.10`, released 2026-08-03                                                  |
| `actions/setup-node`                  | `v6`   | tag exists, `v6.5.0` released 2026-07-14; `v7.0.0` also exists                                              |
| `actions/upload-artifact`             | `v4`   | tag exists; `v7.0.1` is the current release                                                                 |
| `pnpm/setup` (the combined action)    | —      | real: `v1.0.0`, 2026-06-15, "install pnpm and a JavaScript runtime in one step". **Not adopted.** Seven weeks old, and it collapses the two steps whose separation is what gives `cache: pnpm`. Revisit at M2 |

The three tags the plan named all resolve, so they are pinned as written even where a newer major
exists: a major bump is its own change with its own diff, not something to fold into the story that
first writes the file.

**The artefact path is `${{ runner.temp }}/DeFlow-*`, not `/tmp/DeFlow-*`.** `os.tmpdir()` is `/tmp`
on the Linux runners and `/var/folders/…/T` on the macOS ones, so the path the strategy document
shows would match nothing on exactly the two legs whose failures you cannot reproduce locally — and
`upload-artifact` treats "no files matched" as a *warning*, so the leg would fail and hand you
nothing. The job pins `TMPDIR` to the runner temp directory and uploads from there;
`test/integration/ci-artifact-path.test.ts` globs the declared path against a directory the real
fixture creates, so the two cannot drift. Every temp directory in this repo is therefore prefixed
`DeFlow-`, case included: the glob is case-sensitive on Linux.

---

## Measurements

Re-measure these on a clean checkout at every milestone; a monorepo accretes implicit prerequisites
that whoever added them never notices.

| Measurement                                    | Budget           | Last measured                              |
| ---------------------------------------------- | ---------------- | ------------------------------------------ |
| Cold start: `pnpm dev` to first 200 on `/api/health` | < 3 s (NF3) | **299 ms** (298/299/300 over four runs, one with `packages/web/node_modules/.vite` deleted), 2026-08-04, macOS / Node 24.18.0 / Apple silicon |
| `pnpm install --frozen-lockfile`, warm store   | seconds          | see KAR-01.1                                |
| Pre-commit hook over 20 staged files            | < 2 s            | **352 ms** median (medians of 341/352/366 ms over three five-run rounds), 2026-08-04, macOS / Node 24.18.0 / Apple silicon |
| Full CI run on a green commit                   | < 10 min (AC12)  | **1 min 23 s** wall clock (run 30915210685, all six jobs green), 2026-08-04, GitHub-hosted runners |

The cold-start number is asserted by `e2e/dev-loop.test.ts`, which prints the measurement it took,
so a regression shows up in the test log rather than in a vague sense that the loop got slower. The
pre-commit number works the same way, in `test/integration/git-hooks.test.ts`: it measures five runs
of the real hook over twenty real files, asserts the median against the budget, and prints what it
saw. The budget will be attacked repeatedly and always for a good reason; making it an assertion
with a number converts the argument from taste into evidence.

**The CI figure comes from a real run**, because it cannot come from anywhere else: AC12 asks for
GitHub-hosted runner wall clock. Run
[30915210685](https://github.com/zohresalimi/dynamic-workflows/actions/runs/30915210685), on
`epic/01-dev-environment`, all six jobs green, 13:43:08 → 13:44:31 UTC — **83 seconds** against a
600-second budget. The run page names the commit it ran on: this story's tree, with this note and
the assertion that guards it as the only changes since. Per job:

| Job                     | Duration | Notes                                                        |
| ----------------------- | -------- | ------------------------------------------------------------ |
| `check`                 | 32 s     | pnpm store restored from cache                               |
| `test (ubuntu-26.04, 24)` | 47 s   | cache hit                                                    |
| `test (ubuntu-26.04, 26)` | 49 s   | cache hit                                                    |
| `test (macos-26, 24)`   | 51 s     | **cold** store — this leg wrote the macOS cache              |
| `test (macos-26, 26)`   | 78 s     | the critical path; the run is as long as this leg            |
| `browser-e2e`           | 45 s     | includes `playwright install --with-deps chromium`           |

`test/ci-workflow.test.ts` asserts this row against the budget, so it cannot drift back to a
placeholder or quietly record a number over ten minutes. The figure is generous headroom today and
the shape to watch is the macOS legs: they are the slowest, they are the ones whose pnpm store cache
misses most often, and EPIC-03's crash-fuzz slice lands on them. Re-measure when it does.

**Three things had to be fixed before any of this could be measured, and none of them were visible
from a laptop.** They are recorded here because each is a class of failure, not a typo:

1. **`env:` on a job may not name `runner.*`.** The first push (run 30913790575) failed in six
   seconds with *zero jobs* and no logs: GitHub rejects the whole file at parse time, because the
   runner contexts do not exist until a runner has been assigned, which is after the job header is
   evaluated. Every static guard in the repo read the YAML happily — the YAML was valid. `TMPDIR`
   now sits on the vitest step, and `checkJobLevelContexts` fails on any job-level expression naming
   a context GitHub does not provide there.
2. **`pnpm exec playwright` resolved locally and nowhere else.** `node_modules/.bin` at the
   workspace root keeps shims from every package ever installed there, so the root form ran fine on
   the machine that wrote it and died on the first clean `--frozen-lockfile` install with `Command
   "playwright" not found` (run 30914294996). playwright belongs to `packages/web`; the step is now
   `pnpm --filter @DeFlow/web exec …`, and `checkWorkflowExecutablesAreDeclared` checks every
   `pnpm exec` in the workflow against the manifest it runs in. Note that
   `docs/14-testing-strategy.md` §14 still shows the root form.
3. **A test that only passed for an AI agent.** `test/integration/project-slices.test.ts` asserted
   on the literal string `Test Files  1 passed` in a nested runner's output. vitest disables colour
   when `std-env` detects an agent (`CLAUDECODE` in the environment) and tinyrainbow enables it for
   any process with `CI` in its environment — which that helper sets deliberately. So the assertion
   held on an agent's laptop and failed on all four legs, and would fail in a colleague's terminal
   too. The helper now strips SGR escapes before anything reads the output.

For reference, the local floor — the work each job does, on the machine above, excluding all runner
overhead — is `check` 3.5 s, `test` (unit + integration) 7.9 s, `browser-e2e` 2.8 s excluding the
Chromium download. Runner overhead dominates: 83 s of wall clock against ~14 s of work.
