# Testing strategy

> Part of the [Karvan architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

## 1. The guiding principle

Karvan's core dependency is **spawning external processes and mutating real git worktrees**.

Every test-double that shortcuts that — a mocked `spawn`, `memfs`, `isomorphic-git`, `:memory:`
SQLite for a durability test — removes exactly the surface where the bugs live. A mocked `spawn`
tests your mock. `memfs` is invisible to a real `git` binary. `isomorphic-git` cannot create a
worktree the real `git` CLI will honour. `:memory:` SQLite cannot be reopened after a simulated
crash, which is the one property that matters most.

So the whole strategy is one trade: **use real subprocesses, real filesystems, real git and real
SQLite — and make them fast by making the *other side* fake.** Fake the agent binary, not the
process boundary. Then the entire suite runs in seconds, offline, with no credentials and no vendor
CLI installed.

Two structural facts make this cheap:

- **Karvan is an ACP client (D8).** It sits in the path of every `fs/*` and `terminal/*` call, so the
  permission ladder, path-scope enforcement and command allowlist are pure functions in Karvan's own
  code. They become fast unit tests with no vendor CLI at all — see §10.
- **The plan is data and the ledger is the only truth (D7, F4.1).** So a run is a file, a projection
  is a pure function, and the UI's entire test story is "feed it a recorded ledger" — see §12.

A secondary constraint shapes everything below: this is built solo, alongside a job and a degree.
**Anything requiring a live provider to test will not get tested.**

---

## 2. Runner and project slices

**`vitest@4.1.10`.** A 5.0 beta exists; stay on 4. `node:test` is rejected — Vite ships anyway for
the UI, and `node:test` has no browser mode, weaker snapshots, and no project slicing.

> **`vitest.workspace.ts` and `defineWorkspace` were REMOVED in Vitest 4.** Any tutorial showing them
> is pre-3.2 and will not run. Use a single root config with `test.projects`.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    projects: [
      { extends: true, test: { name: 'unit', environment: 'node',
          include: ['packages/*/src/**/*.test.ts'] } },

      { extends: true, test: { name: 'integration', environment: 'node',
          include: ['packages/*/test/integration/**/*.test.ts'],
          testTimeout: 30_000, pool: 'forks' } },

      { extends: true, test: { name: 'e2e', environment: 'node',
          include: ['e2e/**/*.test.ts'], testTimeout: 180_000,
          pool: 'forks', poolOptions: { forks: { singleFork: true } },
          fileParallelism: false } },

      'packages/web/vitest.config.ts',   // browser-mode project, see §13
    ],
  },
})
```

| Project | Scope | Timeout | Pool | Runs |
|---|---|---|---|---|
| `unit` | Pure logic: reducers, projections, patch application, packet rendering, permission policy, path scoping | default | threads | every save, pre-push, CI |
| `integration` | Real tmpdirs, real `git`, real file-backed SQLite, fake agent binaries on PATH | 30 s | `forks` | pre-push, CI |
| `e2e` | Boots a real `karvand` on an ephemeral port; cross-process | 180 s | `forks`, single fork, no file parallelism | CI |
| `web` | Vue components in a real Chromium | — | browser | CI |

`pool: 'forks'` for anything spawning children: worker threads share a process, and a test that leaks
a child process or an fd will poison its neighbours in ways that are miserable to diagnose.
`singleFork` + `fileParallelism: false` on e2e because those specs bind ports and mutate a shared
data directory.

Run slices with `pnpm vitest --project unit`.

---

## 3. Fake binaries, not mocked modules

This is the central testing decision. **Never mock `child_process`.** Ship two real executables and
put them on a tmp `PATH`.

### 3.1 `@karvan/mock-agent` — the mock ACP agent (D17)

A first-class shipped package, not a test helper. Bin: `karvan-mock-agent`, implemented with the
*agent* side of `@agentclientprotocol/sdk@1.3.0` (`acp.agent({...})` mirrors `acp.client({...})`),
driven by a declarative script file. No network, no credentials, no tokens.

It must be able to reproduce, deterministically and on demand:

| # | Scenario | Exercises |
|---|---|---|
| 1 | Emit a `plan` update, then N `agent_message_chunk`s at a scripted cadence with delays | Streaming, backpressure, the `session.nextUpdate()` pull loop, live UI |
| 2 | `tool_call` → `tool_call_update` transitions through every status value | Node inspector, tool timeline |
| 3 | `session/request_permission`, behaving differently per chosen option including the `cancelled` outcome | Permission ladder, approval queue (F8.3) |
| 4 | Call back into the client: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | Every client method Karvan implements, path scoping, command allowlist |
| 5 | **Hang forever mid-turn** | Cancellation, timeouts, laptop-sleep recovery (F4.4, NF4) |
| 6 | **`process.exit(1)` mid-turn** | Crash recovery, orphan reaping |
| 7 | Emit a malformed JSON line, and a valid-JSON-but-schema-invalid frame | Parser hardening, `malformed-output` failure path (F3.4) |
| 8 | **A single 10 MB line** | The 8 MiB frame cap; the SDK's `LineBuffer` has no maximum line length |
| 9 | **Configurable `agentCapabilities`** | The uneven provider matrix, as a *unit* test |
| 10 | Honour `--seed` for all ids and timestamps | Byte-reproducible runs, stable snapshots |
| 11 | `--replay recordings/<provider>@<ver>/<case>.ndjson` | Turns a real captured session into a mock provider for free |

**Item 9 is the one people skip and regret.** The capability matrix is genuinely uneven — measured
live from each agent's `initialize` response on 2026-08-02:

| adapter | version | `session.resume` | `fork` | `list` | `mcp.acp` |
|---|---|---|---|---|---|
| `claude-agent-acp` | 0.64.1 | yes | yes | yes | no |
| `codex-acp` | 1.1.9 | yes | no | yes | `false` |
| `opencode acp` | 1.18.11 | yes | yes | yes | no |
| `copilot --acp` | 1.0.77 | **no** | no | yes | no |
| `gemini --acp` | 0.53.1 | **no** | no | **no** | no |

**Verified 2026-08-02.** Two of five cannot resume at all. Making `agentCapabilities` a mock-agent
flag turns "does `ResumeByReplay` work on a Gemini-shaped profile?" from an integration test that
requires an installed, authenticated Gemini CLI into a unit test that runs in 40 ms.

### 3.2 `@karvan/testkit` — the fake exec-shim agent

For the non-ACP fallback path ([provider adapter layer](./07-provider-adapter-layer.md)), a second
binary: `packages/testkit/bin/fake-agent.ts` with `#!/usr/bin/env node`, reading a scenario from
`$KARVAN_FAKE_SCENARIO`. Same idea, different wire format — it emits Claude-Code-shaped
`stream-json` or Codex-shaped JSONL rather than ACP frames.

Its scenario vocabulary must cover the full F3.4 conformance battery:

- scripted stdout chunks with delays
- `--json` / `stream-json` structured output, and the `result` envelope
- malformed JSON
- non-zero exit
- **exit without any output at all**
- hang forever
- **ignore SIGTERM**, so you actually test the SIGKILL escalation path (F5.7)
- write files into the worktree (so path-scope detection has something to detect)
- emit a permission refusal
- a single 10 MB line

### 3.3 Putting them on PATH

```ts
export const it = base.extend<{ agentPath: string }>({
  agentPath: async ({ tmp }, use) => {
    const bin = path.join(tmp, 'bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.symlink(MOCK_AGENT_BIN, path.join(bin, 'claude'))
    await use(`${bin}${path.delimiter}${process.env.PATH}`)
  },
})
```

The daemon's spawn logic, its argv construction, its stream parser, its backpressure handling, its
timeout and its kill path are all exercised for real. A mocked `spawn` tests none of them.

> Always resolve and store an **absolute** path to the agent binary rather than relying on `PATH`
> lookup at spawn time — karvand's `PATH` at daemon-start differs from the user's login shell. The
> tests should reflect that by asserting on the resolved absolute path.

---

## 4. Record and replay

One mechanism, two requirements.

Put a `KARVAN_RECORD=1` mode in the **real** adapters that tees raw stdout, stderr, exit code and
inter-chunk timing to disk. The tee goes in the **transport**, never in the adapter's parsing logic —
otherwise you record your interpretation instead of the bytes.

```
recordings/<provider>@<exact-version>/<case>.ndjson
  {"t": <msOffset>, "dir": "in" | "out", "msg": { ... }}
```

- **`pnpm test:record` is manual, never CI.** It runs against the developer's installed, authenticated
  CLIs and costs real quota.
- **CI replays.** `karvan-mock-agent --replay <file>` serves the recording; assertions compare
  outgoing frames modulo JSON-RPC `id` and `_meta`.
- **Key the directory on the exact agent version.** `claude-agent-acp@0.64.1` and `@0.65.0` get
  separate directories, so a version bump produces a visible new directory in a PR rather than
  silently invalidating old goldens.

This single mechanism serves both:

- **F4.9 deterministic replay** of a completed run with providers stubbed from recorded outputs, and
- **G7 flag-churn detection** — the adapter brittleness gap. Three breakages are already visible in
  the current release set: Claude Code's `--permission-prompt-tool` is gone from `--help`, Codex's
  `exec --full-auto` is gone, and Gemini's `--experimental-acp` and `--allowed-tools` are both
  deprecated. **Verified 2026-08-02.** Re-recording is how you find the fourth one before a user's
  three-hour run does.

### Schema conformance as a free extra

There is **no official ACP conformance kit**. **Verified negative 2026-08-02:** the
`agentclientprotocol/agent-client-protocol` repo has no `conformance/`, `compliance/` or `tests/`
directory, and no `@agentclientprotocol/conformance`, `acp-conformance` or
`@agentclientprotocol/test-kit` exists on npm. (Web search confidently asserts otherwise; that claim
conflates it with an unrelated academic protocol also abbreviated ACP. Do not chase it.)

What does exist is `@agentclientprotocol/sdk/schema/schema.json`, **262 `$defs`**, generated by the
same pipeline that generates the types. Validate every recorded frame against it with `ajv` — which
arrives transitively via the MCP SDK, so it costs nothing. This fires the instant an upstream SDK
bump changes the wire shape.

---

## 5. Filesystem fixtures: real tmpdirs

```ts
export const it = base.extend<{ tmp: string }>({
  tmp: async ({}, use) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'karvan-'))
    await use(dir)
    if (!process.env.KARVAN_KEEP_TMP) await fs.rm(dir, { recursive: true, force: true })
  },
})
```

`KARVAN_KEEP_TMP=1` is not optional polish. You *will* need to inspect a failed worktree, and in CI
it pairs with `actions/upload-artifact` on failure — post-mortem on a broken worktree is otherwise
impossible.

**`memfs@4.64.0` is useless for anything downstream of a spawn.** Real `git` and real vendor CLIs
cannot see a virtual filesystem. It is acceptable only for pure artifact-store unit tests that never
hand a path to a child process.

---

## 6. Git fixtures: real `git`, hermetically

Never mock git. `git init` into a temp dir is well under a second per scenario.

The load-bearing detail is environment isolation — without it the developer's own `~/.gitconfig`
(`init.defaultBranch`, `commit.gpgsign`, aliases, hooks) silently changes test outcomes, which is the
classic "passes locally, fails in CI" and its equally confusing inverse:

```ts
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',      GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',   GIT_COMMITTER_EMAIL: 't@x',
} as const

await execa('git', ['init', '-b', 'main'], { cwd: tmp, env: GIT_ENV })
```

Build a `makeRepo({ branches, files, conflicts })` helper on top and test against real git:

- worktree lifecycle: `add --lock -b`, `add --detach --lock`, `list --porcelain -z`, `unlock`,
  `remove`, `prune`
- the dirty-removal path (`fatal: '<path>' contains modified or untracked files`) and the
  WIP-salvage commit that must precede `remove --force`
- the double-force case for a locked worktree (`remove -f -f`)
- gitignored files **not** blocking removal (verified: a worktree containing only `node_modules/`
  removed cleanly with exit 0)
- branch-uniqueness refusal, with the real error string `already used by worktree at` — **not** "is
  already checked out at", which is what most blog posts claim
- the assertion in the `Git` wrapper that throws if anyone passes `--force` to `worktree add`
- `merge-tree --write-tree` conflict detection: exit 0 clean, exit 1 conflict (D14)
- the flat branch scheme `karvan/<runId>__<nodeId>` (D13) — and a regression test that the PRD's
  original `karvan/<run-id>/<node-id>` scheme fails, so nobody reintroduces it

`isomorphic-git@1.40.0` is **not** a substitute: it has no worktree support at all (its full export
list was enumerated at runtime — there is no `worktree*` function), and worktrees are F5.1.
`simple-git@3.36.0` has no worktree API either. **Verified 2026-08-02.**

---

## 7. SQLite fixtures: file-backed, always, for durability

The store is `better-sqlite3@13.0.2` behind a thin ~60-line `Db` port (D6 —
see [durable execution](./05-durable-execution.md)).

```ts
const db = new Database(path.join(tmp, 'ledger.db'))
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000')
```

> **`:memory:` cannot test the one property that matters most.** It cannot exercise WAL, it cannot be
> reopened after a simulated crash, and it hides fsync and ordering bugs. That is F4.2 — resume after
> crash — which is the entire durability thesis.

Test resume by `db.close()` and constructing a **fresh engine over the same file**. That is the real
code path a daemon restart takes.

`:memory:` is permitted for **pure projection unit tests only** — feed events in, assert on the
reduced state, no durability semantics involved.

better-sqlite3 v13 migrated to N-API and the npm tarball ships 8 prebuilt binaries
(`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`) with `gypfile: false` and no install
script; `npm i better-sqlite3@13.0.2` completed in **1 second** with zero compilation.
**Verified 2026-08-02.** So there is no CI cost to using the real driver everywhere.

---

## 8. Time: an injected `Clock`, not fake timers

NF9 requires a deterministic core — no nondeterminism outside adapter boundaries. That has a concrete
tooling consequence: **time enters through a port**.

```ts
// packages/core/src/clock.ts
export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  setTimer(ms: number, fn: () => void): Disposable
}
```

Pass a `TestClock` you advance manually. Most scheduler tests then need no timer faking at all, and
when one fails you can print the clock's state instead of interrogating sinon's internals.

> **Hard rule: never use fake timers while a child process is alive.**

`vi.useFakeTimers()` (Vitest wraps `@sinonjs/fake-timers@15.4.0`) freezes the event loop's timers.
The child process's real I/O never arrives, your `await` never resolves, and you deadlock — usually
manifesting as a test that passes locally and hangs for the full 30 s timeout in CI. Since the
retry-backoff, budget-ceiling, no-progress-detection and long-suspension paths (F4.5, F4.6, F4.7,
F4.8) are all *about* time *around* child processes, this is not a corner case.

If you genuinely must fake timers in a narrow unit test, scope them:

```ts
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })  // leave nextTick/queueMicrotask real
```

---

## 9. Snapshots, with a normalizing serializer

`toMatchFileSnapshot` for anything structural — PlanGraphs, ledger dumps, assembled context packets.
Real files in git that diff readably in a PR:

```ts
await expect(plan).toMatchFileSnapshot('__snapshots__/plan-v3.json')
```

`toMatchInlineSnapshot()` for short event sequences, so the expectation sits next to the assertion.

> **Register a normalizing snapshot serializer before writing the first snapshot, or every snapshot
> is churn.**

```ts
// test/setup.ts
expect.addSnapshotSerializer({
  test: (v) => !!v && typeof v === 'object' && 't' in v && 'ts' in v,
  serialize: (e, cfg, ind, d, refs, printer) =>
    printer({ ...e, ts: '<ts>', runId: '<run>', durationMs: '<dur>' }, cfg, ind, d, refs),
})
```

Normalize, at minimum: timestamps, run/node/event IDs (ULIDs and UUIDs), durations, absolute paths,
ports, and worktree directory names. Without this, a snapshot changes on every single run and the
whole mechanism becomes noise you learn to `-u` past — which is worse than having no snapshots.

`render(segments) -> string` is a pure function ([context and memory](./08-context-and-memory.md)),
so golden-file packet tests per node archetype cost nothing and turn a context regression into a
readable diff in CI.

---

## 10. The safety model tests need no vendor CLI at all

This is a strong secondary argument for ACP-first (D8), and it deserves to be stated as such rather
than treated as a happy accident.

Because Karvan is the ACP **client**, it implements `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`,
`terminal/wait_for_exit`, `terminal/kill` and `terminal/release`. **Karvan sits in the path of every
file access and every command execution.** The permission ladder therefore collapses from an
N-vendors × M-levels mapping matrix into **one policy function in Karvan's own code**:

| Level | `fs/write_text_file` | `terminal/create` | Network |
|---|---|---|---|
| `read` | reject all | reject all non-readonly | deny |
| `worktree` | allow iff `resolve(path)` is inside the worktree | allow iff the command passes the allowlist | deny |
| `worktree+net` | same | same | allow (domain allowlist) |
| `full` | allow in worktree | allow | allow |

Which means all of this is a **fast unit test with nothing installed**:

- the whole ladder, every level × every method
- path-scope enforcement, including the ones that actually bite: `..` traversal, symlinks pointing
  outside the worktree, absolute paths, and paths that resolve outside after `realpath`
- the default-deny command allowlist, and the syntactic second-layer checks that force a gate even
  for allowlisted binaries (`git push --force` vs `--force-with-lease`, `git reset --hard` outside
  the worktree, `rm -r` on a path ≤2 segments deep, `terraform apply|destroy`, `kubectl delete`,
  `psql` against a non-localhost host)
- environment scrubbing — that `AWS_*`, `KUBECONFIG`, `DATABASE_URL`, `*_TOKEN`, `*_API_KEY`, `TF_*`
  and `VAULT_*` are absent from the constructed child env unless the node's level explicitly requests
  them. This is the control that would actually have prevented the Kiro incident (PRD §4.5), so it
  gets a dedicated test file.
- `mediatedExecution: false` adapters being **refused scheduling** rather than silently escalated
  (F5.4)

See [workspace and safety](./09-workspace-and-safety.md) for the model itself.

### The process-tree kill fixture

F5.7's kill switch needs a real process tree, and it has a verified false-negative trap.

```ts
const child = spawn('bash', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'],
                    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
// ... assert pgid === child.pid for all four processes
process.kill(-child.pid, 'SIGTERM')
```

**The trap, verified by measurement:** after a *successful* group SIGKILL, `ps` still lists the
grandchildren. They are in state **`Z` (zombie)** with `ppid=1` — already dead, awaiting reaping by
init. A naive "did the kill work?" assertion concludes the group kill failed when it did not.

> **Any kill-verification assertion must exclude `Z`-state processes.**

```sh
ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'
```

Zombie reaping is prompt under launchd and systemd but can lag badly inside containers — so this
bites hardest in exactly the environment where you cannot attach a debugger.

Also test, with `detached: true` and negative-pid group signalling:

- `process.kill(child.pid, ...)` (positive) leaves grandchildren alive, reparented to PID 1 — the
  regression test that stops anyone "simplifying" the kill path
- SIGTERM → 5 s grace → SIGKILL → 2 s → ledger failure escalation
- orphan reaping on daemon boot, including the **PID-reuse guard**: compare stored process start time,
  never a bare PID
- `git worktree unlock` for any worktree whose owning process is gone

---

## 11. The crash-fuzz test

This is the test that proves the thesis. It belongs in CI and it should run on every push.

```
for i in 1..N:
  1. start karvand with mock agents on PATH and a scripted multi-node run
  2. sleep for a random interval within the run's expected duration
  3. kill -9 the daemon (SIGKILL — no cleanup, no flush, no handlers)
  4. restart karvand over the same .karvan/ directory
  5. assert:
       a. no effect was executed twice        (effect journal, idempotency keys F4.3)
       b. reduced state == pre-crash projection at the last durably-written seq
       c. PRAGMA integrity_check == 'ok'
       d. the run either completes or halts with a typed failure — never wedges
```

Notes that make it actually work:

- **`kill -9`, not SIGTERM.** SIGTERM tests your shutdown handler; SIGKILL tests your durability.
- Assertion (a) is checked against the effect journal plus the fake agents' own side-effect log —
  each fake binary appends `{runId, nodeId, attempt, idempotencyKey}` to a file on every invocation,
  so "executed twice" is a duplicate-key check on a text file, not an inference.
- Assertion (b) needs the pre-crash projection, so the harness snapshots the SSE-projected state on
  every event before the kill.
- Randomise the kill point across runs and seed it from `$GITHUB_RUN_ID` so a failure is reproducible
  from the log.
- The mock agents' `--seed` flag makes the pre-crash side deterministic, so the *only* variable is
  where the knife lands.

Everything else in the durability design is theory until this test is green.

---

## 12. Ledger replay fixtures — the UI's entire test and dev story

Because the plan is data and every view is a projection (F4.1, NF10), a recorded ledger is
simultaneously a test fixture, a dev-mode data source and a demo. The production ledger is one global
database ([repo layout §7.2](./16-repo-layout.md)), but a fixture is exported per run, so a whole run
commits as a single file.

```
test/fixtures/runs/
  happy-path/ledger.db
  three-patches/ledger.db
  gate-failure-repair/ledger.db
  compaction/ledger.db
  crash-resume-seq-gap/ledger.db
  stress-400/ledger.db
```

The corpus to record:

| Fixture | What it must contain | Which views it proves |
|---|---|---|
| **happy path** | A small run, all nodes pass, one gate, one worktree merged | Plan graph, timeline, diff surface |
| **three PlanPatches** | Insert, split, provider-replace — each with a reason and a decision (`auto`/`approved`) | Plan evolution scrubber (F10.2, the marquee feature) |
| **gate failure with repair loop** | A failing gate, a surgical fix node, a second attempt, a pass | Acceptance-criteria board, repair loop, gate verdicts inline on the diff |
| **compaction event** | Both fidelities: a `karvan.packet` compaction with exact before/after, and a `vendor.session` one with `after: null` | Context-budget visualization (F10.5), and the honest rendering of the vendor's missing post-count |
| **crash + resume with a seq gap** | A ledger whose sequence numbers jump, as a real SIGKILL produces | SSE `Last-Event-ID` resume, the `?since=<seq>` hydrate path, "did the UI notice?" |
| **400-node stress** | A wide `map` fan-out | Vue Flow render budget, elk layout time, scrubber responsiveness |

A `karvan replay <fixture>` command serves a fixture over the same HTTP + SSE contract as a live run,
at configurable speed. That is the UI's development loop: no daemon orchestration, no agents, no
quota, and a 400-node graph on demand. It is also what the Playwright E2E smokes drive (§13).

---

## 13. UI testing

**Vitest 4 browser mode with real Chromium.** Stable in Vitest 4 — no longer experimental.

```ts
// packages/web/vitest.config.ts
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    name: 'web',
    browser: {
      enabled: true, provider: playwright(), headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})
```

Deps: `@vitest/browser@4.1.10`, `@vitest/browser-playwright@4.1.10`, `playwright@1.62.1`,
`vitest-browser-vue@2.1.0`.

### Why jsdom and happy-dom cannot serve the visualization surface

The nine P0 views are the product (PRD §7.10). They are built on `@vue-flow/core@1.48.2`, `d3` and
`xterm.js`, and those need real layout and real measurement.

jsdom and happy-dom have **no SVG measurement** (`getBBox`, `getComputedTextLength`, `getScreenCTM`),
**no canvas**, and **no WebGL** — and the failure mode is not a clean error. They return `0` from
`getBBox()`, stub `getContext('2d')` to `null` or a no-op, and report element sizes as zero. So a
test asserting "the node label fits inside the node" passes against a `0×0` box; a test asserting
"the Gantt bar is positioned at the right offset" passes against `NaN` coerced to `0`; a terminal
that never rendered a single glyph reports a clean mount. **They will lie to you about all three**,
which is strictly worse than not testing.

`@vue/test-utils@2.4.11` + `happy-dom@20.11.1` is acceptable **only** for pure-logic components:
composables, the ledger-projection store, formatters, and anything with no geometry.

### Rejected

| Option | Why not |
|---|---|
| **Playwright component testing** | Still officially experimental in 2026, and 1.59 (April 2026) deleted `@playwright/experimental-ct-svelte` with no deprecation period. Not a foundation. |
| **Cypress** (15.19.0) | Maintained and fine, but it is a second runner, a second assertion library and a second browser download for zero incremental signal over browser mode. |
| **Storybook** | It is a component *catalogue*, and Karvan's UI is not a component library — it is six stateful views over one event stream. Every interesting state is "a particular ledger at a particular offset", which `karvan replay` already expresses better, with real data, in the real app. Storybook would mean maintaining a second set of fake props that drift from the real event shapes, plus a second build pipeline, to get a worse fidelity. If a design-system extraction ever happens, revisit. |

### Real Playwright E2E, sparingly

Keep `@playwright/test@1.62.1` for roughly **five** full-stack smokes, driven against
`karvan replay` on an ephemeral port with fake agents on PATH:

1. Load a completed run; the plan graph renders every node with the right state colour.
2. Drag the plan-evolution scrubber back to v1 and forward through each patch; the diff renders.
3. Open the node inspector; the context packet's segment token breakdown sums to the header total.
4. Live SSE: replay at speed, kill the connection, assert the UI reconnects and backfills without a
   gap or a duplicate.
5. The approval queue: a `human` node blocks, the approval is submitted, the run advances.

Five is a ceiling, not a target. E2E specs are the slowest and flakiest tests you own; every one of
them needs to justify itself against a browser-mode component test that would catch the same bug.

---

## 14. CI

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }

jobs:
  check:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm biome ci .
      - run: pnpm oxlint --type-aware
      - run: pnpm typecheck

  test:
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-26.04, macos-26], node: ['24', '26'] }
    runs-on: ${{ matrix.os }}
    steps:
      - ...setup...
      - run: pnpm vitest run --project unit --project integration
      - run: pnpm vitest run --project crash-fuzz
        env: { KARVAN_KEEP_TMP: '1' }
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: tmp-${{ matrix.os }}-${{ matrix.node }}, path: /tmp/karvan-* }

  browser-e2e:
    runs-on: ubuntu-26.04          # Linux only — do not triple macOS minutes on a browser job
    steps:
      - ...setup...
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm vitest run --project web --project e2e
```

### Two 2026 footguns

> **Do not use `corepack enable`.** Corepack was **removed from Node 25+ distributions** (TSC vote,
> March 2025); it is only bundled through Node 24. `corepack enable` in CI, or in your setup docs,
> fails outright on Node 25 and 26. Use `pnpm/action-setup@v6` (which added pnpm 11 support) or
> `npm i -g pnpm@11`. Keep `"packageManager": "pnpm@11.18.0"` in `package.json` — pnpm still reads it
> as a version assertion.

> **Pin runner images; never use `-latest`.** `macos-latest` migrated to **macOS 26 on Apple Silicon**
> between 8 and 15 June 2026. An implicit architecture change under you is exactly the kind of thing
> that eats a solo developer's weekend — native module prebuilds, `node-pty` behaviour, and
> filesystem case-sensitivity all shift at once. Use `macos-26` and `ubuntu-26.04` explicitly.

Node matrix: **24** (Active LTS, the floor per D2) and **26** (Current). Node 22 is in maintenance
since 2025-10-21 — do not list it in `engines` and do not test it.

`KARVAN_KEEP_TMP=1` plus `upload-artifact` on failure is what makes a CI-only worktree failure
diagnosable at all.

### The pre-commit budget rule

`lefthook@2.1.10` — it ships a Go binary via optionalDependencies, runs jobs in parallel, and has
built-in staged-file globbing, so it replaces husky **and** lint-staged with one dependency.

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  jobs:
    - name: format
      glob: '*.{ts,vue,json,jsonc,css,html}'
      run: pnpm biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true
    - name: lint
      glob: '*.ts'
      run: pnpm oxlint {staged_files}      # no --type-aware here: too slow for a hook
pre-push:
  jobs:
    - name: typecheck
      run: pnpm typecheck
    - name: unit
      run: pnpm vitest run --project unit
```

> **Keep pre-commit under ~2 seconds.** Anything slower and you will start reaching for
> `--no-verify`, at which point the hooks are theatre and you have paid the setup cost for nothing.
> Typecheck, type-aware lint and the full suite belong on pre-push and in CI.

---

## 15. What not to do

- **Do not mock `child_process` / `spawn`.** It tests your mock. The parser, backpressure, timeout and
  kill paths all go untested.
- **Do not use `memfs`** for anything a real process will touch.
- **Do not use `isomorphic-git`** — no worktree support at all, and worktrees are F5.1.
- **Do not use `:memory:` SQLite for durability tests.** No WAL, no reopen-after-crash, hidden
  ordering bugs. It cannot test F4.2.
- **Do not use `vi.useFakeTimers()` while a child process is alive.** Guaranteed deadlock.
- **Do not write a snapshot before registering the normalizing serializer.**
- **Do not test the visualization surface in jsdom or happy-dom.** No SVG measurement, no canvas, no
  WebGL, and it fails silently rather than loudly.
- **Do not use `vitest.workspace.ts` / `defineWorkspace`.** Removed in Vitest 4.
- **Do not `corepack enable` in CI.** Removed from Node 25+.
- **Do not use `macos-latest` / `ubuntu-latest`.** Pin the image.
- **Do not run git fixtures without `GIT_CONFIG_GLOBAL=/dev/null`** and forced identity env.
- **Do not assert a kill succeeded without excluding `Z`-state processes.**
- **Do not chase an official ACP conformance kit.** It does not exist; the search results are a
  conflation with an unrelated protocol. Build the two-layer suite in §4.
- **Do not run `pnpm test:record` in CI.** It costs real quota against the developer's own
  subscription and is nondeterministic by construction.

---

**Related:** [Local development](./03-local-development.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) ·
[Durable execution](./05-durable-execution.md) ·
[Workspace and safety](./09-workspace-and-safety.md) ·
[Frontend architecture](./12-frontend-architecture.md)

[← Back to index](./README.md)
