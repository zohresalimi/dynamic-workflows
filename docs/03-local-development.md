# Local development

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the runbook. It assumes a fresh machine and nothing installed except a shell and a browser.

The design goal it serves is blunt: **the whole application must run and be testable on one laptop
with no credentials, no cloud account, no Docker, no database server, and no money spent.** Every
decision below is downstream of that. If a step here starts requiring a provider subscription to
make progress on a UI view, the step is wrong.

Three properties make it work, and they are architectural rather than tooling conveniences:

- **One process, one port.** `pnpm dev` starts `DeFlowd` and nothing else. Vite runs _inside_ it
  (D10).
- **A deterministic mock agent binary** that speaks real ACP over a real subprocess (D17), so the
  adapter layer, the scheduler and the crash paths are all exercisable offline.
- **`DeFlow replay`**, which serves the normal API from a recorded run, so all nine P0 views are
  developable against real data with zero agents running.

---

## 1. Prerequisites

| Requirement   | Minimum                     | Check            | Notes                                                                                                          |
| ------------- | --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Node.js**   | `>=24`                      | `node --version` | Active LTS. `.node-version` and `.tool-versions` are committed, so `fnm`/`nvm`/`mise` pick it up automatically |
| **pnpm**      | `11.18.0`                   | `pnpm --version` | `npm i -g pnpm@11`. **Do not run `corepack enable`** — Corepack was removed from Node 25+ distributions        |
| **git**       | `>= 2.38`, prefer `>= 2.45` | `git --version`  | See below                                                                                                      |
| **A browser** | Chromium or Firefox         |                  | Chromium is also what the browser-mode tests drive                                                             |

Nothing else is required to build, run and test DeFlow.

### Why git >= 2.38

`git merge-tree --write-tree` is the ground truth for conflict detection between concurrent write
nodes (D14). It landed in **git 2.38**, and it is not optional — declared path scopes (F5.3) are
demoted to a plan-time prediction precisely because agents violate them, so merge-tree is the gate.

`>= 2.45` is preferred because `git worktree list --porcelain -z` output stabilised there; below it,
worktree enumeration needs string parsing that breaks on paths with spaces or newlines.

`DeFlow doctor` checks both and refuses to schedule write nodes below 2.38.

### Optional, per platform

These are only needed once you point DeFlow at a **real** agent CLI. Everything in this document up
to §8 works without them.

**Linux** — Claude Code's sandbox uses **bubblewrap + socat**, and both must be present:

```bash
sudo apt install bubblewrap socat        # Debian/Ubuntu
sudo dnf install bubblewrap socat        # Fedora
```

On **Ubuntu 24.04 and later**, AppArmor blocks bubblewrap's unprivileged user namespaces by default
and the sandbox silently fails open. Check it:

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns    # 1 means bwrap is blocked
```

If it returns `1`, install the `/etc/apparmor.d/bwrap` profile documented by Claude Code. This is a
`DeFlow doctor` check, not a footnote: Claude Code's sandbox **silently falls back to running
unsandboxed** when its dependencies are missing, which would make the permission ladder (F5.4)
decorative.

**macOS** — Seatbelt is built in. Nothing to install.

**Windows** — not supported until M3 (NF5). Use WSL2 and follow the Linux row.

### Not prerequisites

- **No agent CLI.** The mock agent covers development (§6).
- **No Docker.** Container isolation is P1 (F5.8).
- **No database server.** The ledger is an embedded SQLite file (NF6).
- **No build toolchain.** Both native dependencies ship prebuilt binaries; nothing runs `node-gyp`.

---

## 2. Clone, install, run

```bash
git clone https://github.com/<you>/DeFlow.git
cd DeFlow
pnpm install
pnpm dev
```

Then open **http://127.0.0.1:7777**. That is the whole setup.

What each step actually does:

| Command        | What happens                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install` | Resolves from the committed lockfile. Links the seven `@DeFlow/*` workspace packages by symlink. Downloads two prebuilt native binaries (`better-sqlite3`, `@lydell/node-pty`) — **no compilation**. Runs `prepare`, which is `lefthook install` (§12) |
| `pnpm dev`     | Starts one Node process: `DeFlowd` with `DeFlow_DEV=1`, which mounts Vite in middleware mode on its own HTTP server, serves the UI and the API from the same origin, and restarts on every file save                                                   |

First `pnpm install` on a warm pnpm store takes seconds. Cold, it is dominated by the two native
tarballs (`better-sqlite3` is 11.4 MB; **verified 2026-08-02** to install in about 1 second with
zero compilation, and `@lydell/node-pty` in 514 ms).

There is no build step in the dev loop. `packages/core`'s `exports` field points at
`./src/index.ts`, so `node`, `vite`, `vitest` and `tsc` all resolve to live TypeScript source across
package boundaries. No watch-build chain, no stale `dist`, and goto-definition lands on real code.

---

## 3. The root scripts block

```jsonc
// package.json (root)
{
  "name": "DeFlow-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.18.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "DeFlow_DEV=1 node --watch --watch-path=packages --env-file-if-exists=.env packages/daemon/src/main.ts",
    "dev:pretty": "pnpm dev | pino-pretty",
    "dev:replay": "DeFlow_DEV=1 node --watch --watch-path=packages packages/cli/src/bin.ts replay fixtures/happy-path-12.jsonl --speed 20x",

    // The web build, the copy into packages/cli/dist/ui/ and tsdown, in that
    // order — see docs/16-repo-layout.md §2. It is a script because the order
    // is the load-bearing part and it has to be testable.
    "build": "node packages/cli/scripts/build.ts",
    "typecheck": "tsc -b && pnpm --filter @DeFlow/web exec vue-tsc --noEmit",

    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:web": "vitest run --project web",
    "test:e2e": "vitest run --project e2e",
    "test:record": "DeFlow_RECORD=1 vitest run --project integration --testNamePattern @live",

    "lint": "oxlint --type-aware && biome check .",
    "format": "biome check --write .",

    "doctor": "node packages/cli/src/bin.ts doctor",
    "pack:check": "pnpm build && pnpm --filter DeFlow exec publint && pnpm --filter DeFlow exec attw --pack",

    "prepare": "lefthook install",
  },
}
```

Note what is _not_ there: no `dev:web`, no `dev:api`, no `concurrently`, no `wait-on`. There is one
dev process.

---

## 4. The single-process dev loop

### 4.1 What runs

```
                  http://127.0.0.1:7777
                          │
              ┌───────────┴────────────┐
              │  node:http server      │
              │  (@hono/node-server)   │
              └───────────┬────────────┘
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   /api/*            /api/stream        everything else
   Hono routes       SSE from the       Vite middleware (dev)
   (typed via        ledger              or static dist/ui (prod)
    hc<AppType>)                         + HMR websocket on the SAME server
```

One origin. No CORS. No proxy. Dev and production routing are byte-identical apart from which
middleware serves the UI, which means "works in dev, broken in the built package" becomes almost
impossible.

### 4.2 The wiring

`middlewareMode?: boolean | { server: HttpServer }` was **verified 2026-08-02** in `vite@8.2.0`'s
bundled type declarations, where `server` is documented as _"Parent server instance to attach to.
This is needed to proxy WebSocket connections to the parent server"_ — i.e. Vite's HMR websocket
rides `DeFlowd`'s own HTTP server rather than opening a second one.

> **Correction, verified 2026-08-04 (KAR-01.3) against Vite's shipped code.** `middlewareMode.server`
> is consumed only when forwarding to a configured upstream; it has nothing to do with HMR. The
> option that attaches the HMR websocket to a parent server is **`server.ws.server`**, and without it
> Vite opens a second listening socket on port 24678. Pass both:
> `server: { middlewareMode: { server }, ws: { server } }`. The single-socket property is asserted by
> `e2e/dev-loop.test.ts`.

```ts
// packages/daemon/src/http/server.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { api } from "./api.ts";

export async function startHttp(port: number, hostname = "127.0.0.1") {
  const app = new Hono();

  // The API mounts first so it always wins over the SPA fallback.
  app.route("/api", api);

  // @hono/node-server hands us the real node:http server — this is the object
  // Vite needs in order to attach its HMR websocket.
  const server = serve({ fetch: app.fetch, port, hostname });

  if (process.env.DeFlow_DEV === "1") {
    // Dynamic import: vite is a devDependency and must not be in the published bundle.
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: fileURLToPath(new URL("../../../web", import.meta.url)),
      appType: "spa",
      server: {
        middlewareMode: { server },
        ws: { server }, // <- HMR ws rides the daemon's server
      },
    });
    // Vite's connect-style middleware, adapted onto Hono's fetch handler.
    app.use("*", honoAdapter(vite.middlewares));
  } else {
    const uiDir = fileURLToPath(new URL("./ui", import.meta.url));
    app.use("/assets/*", serveStatic({ root: uiDir }));
    app.get("*", (c) => c.html(indexHtml)); // SPA fallback
  }

  return { app, server };
}
```

Editing a `.vue` file hot-reloads in the browser. Editing anything under `packages/*/src` restarts
the daemon (§5).

### 4.3 Why not a Vite dev server with `server.proxy`

Because DeFlow's entire UI is an SSE projection of the ledger (F4.1, NF10), and **Vite's dev proxy
is documented-bad at SSE**. Three failure modes, all reported against Vite and none of them
theoretical:

| Failure mode                     | What you would see                                                    | Why it is fatal here                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Buffering**                    | Events arrive in one burst when the stream _ends_, not as they happen | The live plan graph (F10.1) and live agent streams (F10.6) would appear frozen for hours and then flood. You would spend an afternoon assuming your reducer was broken |
| **Proxy / socket timeouts**      | A stream dies silently after some minutes                             | Runs are measured in hours (F4.8). A dev loop that cannot hold a stream open cannot exercise the product's core use case                                               |
| **Close events not propagating** | Browser navigates away, backend never learns the client is gone       | Leaked subscriptions per reload, and the backpressure path never gets tested                                                                                           |

See vitejs/vite#12157 and vitejs/vite discussion #10851. **Measured against `vite@8.2.0` on
2026-08-04 ([S4](spikes/S4-one-port.md), rows 12–13): none of the three reproduced.** The rule below
stands anyway, and on firmer ground — it follows from one origin, not from a bug that may already be
fixed. Read the spike note before citing this table as current.

The workarounds (`timeout: 0`,
`proxyTimeout: 0`, `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`, no compression
middleware on that route) exist and are documented in the API contract for the benefit of anyone who
later puts a reverse proxy in front of `DeFlowd` — but as a _dev loop_ the tradeoff is absurd. You
would be debugging your transport instead of your product, in exchange for a slightly faster daemon
restart.

Middleware mode removes the proxy, removes CORS, removes the second port, and removes the entire
class of bug.

> **Rule:** if you ever find yourself adding `server.proxy` to `packages/web/vite.config.ts`, stop.
> The UI is served by the daemon. That is the design (D10).

---

## 5. `node --watch` restarts the daemon, and that is a feature

`pnpm dev` runs the daemon under `node --watch --watch-path=packages`. Every save kills and restarts
`DeFlowd`.

For most projects that is a mild nuisance. For DeFlow it is **free, continuous, adversarial testing
of F4.2 (resume after crash)**, which is the single property most competing tools lack and the one
hardest to be confident in.

On every save:

1. The process dies mid-flight, often with nodes running and effects in `pending`.
2. The new process reopens the ledger (`$XDG_DATA_HOME/DeFlow/ledger.db` — one global database, see
   [repo layout §7.2](./16-repo-layout.md)), reduces the event log for that run, and rebuilds
   `RunState`.
3. It bumps `daemon_epoch`, takes the `flock` on the lock file, and reaps orphaned children by
   matching `(pid, process_start_time)` — never by bare pid, because pids are recycled.
4. It reconciles every effect row left `pending` by the previous daemon life.
5. Completed nodes are never re-executed (F4.2). In-flight ones resume or escalate.

If resume breaks, you find out **in seconds**, in the normal course of writing code, rather than in
hour three of a real run. Do not "fix" this by switching to a hot-reload scheme that preserves
process state. The restart is the test.

Two practical notes:

- Keep a mock run going while you work on the scheduler. `pnpm dev` plus a mock run in another tab
  means every save is a crash-resume trial.
- If the daemon fails to come back up cleanly, that is a real bug, not a dev-loop annoyance. The
  ledger is the source of truth; a failed restart means the reducer, the migration or the reconcile
  probe is wrong.

`tsx watch` is the documented escape hatch if Node's "no TypeScript inside `node_modules`" rule ever
collides with pnpm's workspace symlinks — but confirm the problem before reaching for it; Node
normally resolves the symlink realpath and the source-linking pattern works.

---

## 6. Developing with zero credentials and zero cost

**This is the single biggest DX lever in the project.** Read this section twice.

DeFlow orchestrates other people's agents. If development required those agents, the inner loop
would cost money, take minutes per iteration, be non-reproducible, and be impossible on a train. It
does not, because of two mechanisms.

### 6.1 The mock agent binary

`@DeFlow/mock-agent` is a **shipped package with a real bin** (`DeFlow-mock-agent`), not a test
helper (D17). It implements the _agent_ side of `@agentclientprotocol/sdk@1.3.0` and is driven by a
declarative script file.

The critical property: it is a **real subprocess speaking real ACP over real stdio**. Mocking
`child_process.spawn` would test the mock. A fake binary tests the parser, the framing, the
backpressure, the timeout and the kill path — which is where the bugs actually are.

```bash
# Put the mock ahead of anything real on PATH, then run normally.
export PATH="$PWD/packages/mock-agent/bin:$PATH"
export DeFlow_MOCK_SCRIPT="$PWD/fixtures/scripts/happy-path.json"

pnpm dev
```

It reproduces, deterministically and on demand:

| #   | Scenario                                                                                                                                                                   | Exercises                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `plan` update then N `agent_message_chunk`s at a scripted cadence                                                                                                          | Streaming, projections, the live graph                                                                 |
| 2   | `tool_call` → `tool_call_update` through each status value                                                                                                                 | The node inspector (F10.3)                                                                             |
| 3   | `session/request_permission`, behaving differently per chosen option including `cancelled`                                                                                 | The permission ladder (F5.4)                                                                           |
| 4   | Calls back into the client: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | DeFlow's mediation boundary (D12)                                                                      |
| 5   | **Hangs forever mid-turn**                                                                                                                                                 | Cancellation, timeouts, laptop-sleep recovery                                                          |
| 6   | **`process.exit(1)` mid-turn**                                                                                                                                             | Crash recovery, orphan reaping                                                                         |
| 7   | A malformed JSON line, and a valid-JSON-but-schema-invalid frame                                                                                                           | Adapter robustness (F3.4)                                                                              |
| 8   | A single 10 MB line                                                                                                                                                        | The framing cap                                                                                        |
| 9   | A **configurable** `agentCapabilities` block                                                                                                                               | Simulating Gemini's no-resume profile and Claude's everything-on profile with neither installed (F3.5) |
| 10  | `--seed` for all ids and timestamps                                                                                                                                        | Byte-reproducible runs                                                                                 |

Item 9 is the one people skip and regret. It turns the uneven capability matrix from an
integration-test problem into a unit-test problem.

It also replays real captured sessions:

```bash
DeFlow-mock-agent --replay recordings/claude-code@2.1.220/permission-refusal.ndjson
```

Because ACP is NDJSON, a recording is just the byte stream plus direction. The recorder is a tee at
the transport level (`DeFlow_RECORD=1`), keyed on the exact agent version so a vendor bump produces
a visible new directory rather than silently invalidating old goldens. That same recorder is how
F4.9 (deterministic replay with providers stubbed) is implemented — one mechanism, two uses.

### 6.2 `DeFlow replay` — develop all nine views offline

```bash
DeFlow replay fixtures/happy-path-12.jsonl --speed 20x --port 7777
```

This is a daemon mode that serves the **normal** `/api/*` and `/api/stream` endpoints from a
recorded ledger instead of a live run. The UI cannot tell the difference, because there is no
difference: the browser is a projection of an event stream either way.

What it buys:

- **All nine P0 views (F10.1–F10.9) are developable with no provider, no credentials, no child
  processes, no cost, and no waiting.** Want to style the compaction markers on the context-budget
  chart? Load the compaction fixture and they are on screen in a second, instead of three hours into
  a real run.
- **Every state is reachable on demand.** A gate failure with a repair loop, a run with a crash gap
  in the `seq`, a 400-node stress graph — all one command away.
- **The fixture format is the production format.** There is no fixture-maintenance tax, no mock API
  layer to keep in sync, and no drift between "what dev shows" and "what production emits".
- **It is also the demo tool.** The PRD's strongest internal demo (§15.4) is a real task shown
  through the plan-evolution scrubber. That is `DeFlow replay` pointed at a recorded real run.

The fixture set to maintain, at minimum:

| Fixture                  | Drives                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| `happy-path-12.jsonl`    | Baseline: graph, timeline, node inspector                                     |
| `three-patches.jsonl`    | The plan-evolution scrubber (F10.2) — the marquee view                        |
| `gate-fail-repair.jsonl` | Gate verdicts, the surgical repair loop (F7.5), diff annotations (F7.7)       |
| `compaction.jsonl`       | Context-budget visualisation with before → after markers (F10.5)              |
| `crash-resume.jsonl`     | A gap in the `seq` sequence; proves the UI tolerates it                       |
| `stress-400.jsonl`       | Holds the graph renderer honest (Vue Flow is smooth to ~300–500 custom nodes) |

**Record these from real mock-agent runs. Never hand-write them.** Hand-written fixtures encode your
assumptions about the event stream rather than its actual shape, and they rot silently.

Sequence gaps in `crash-resume.jsonl` are expected and correct: rolled-back transactions burn
`AUTOINCREMENT` values. The stream contract is "resume from strictly greater than `seq`", never
"expect `seq + 1`".

### 6.3 What this does _not_ cover

Running against the mock agent forever will eventually let a real integration rot. The conformance
suite (F3.4) is the counterweight: `pnpm test:record` refreshes recordings against the CLIs actually
installed on your machine, manually, not in CI. CI replays them. That is the G7 flag-churn detector,
and it costs almost nothing.

---

## 7. Tests

```bash
pnpm test              # everything
pnpm test:watch        # everything, watching
pnpm test:unit         # ~1s   — the one you run constantly
pnpm test:int          # ~30s  — real subprocesses, real git, real SQLite files
pnpm test:web          # real Chromium
pnpm test:e2e          # a real DeFlowd on an ephemeral port, driven end to end
```

One root `vitest.config.ts` with `test.projects` (Vitest 4 **removed** `defineWorkspace` and
`vitest.workspace.ts` — any tutorial showing them will not run):

| Project       | Include                                    | Covers                                                                               | Notes                                                                                                                                |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `unit`        | `packages/*/src/**/*.test.ts`              | Reducers, `decide()`, projections, patch policy, context assembly                    | Pure functions, no I/O. Should be ~80% of the test count and run in about a second                                                   |
| `integration` | `packages/*/test/integration/**/*.test.ts` | Adapter ↔ mock binary, worktree lifecycle, merge-tree conflicts, ledger crash-resume | `pool: 'forks'`, 30 s timeout. Real `git`, real subprocesses, file-backed SQLite                                                     |
| `web`         | `packages/web/vitest.config.ts`            | Vue Flow custom nodes, the diff viewer, the stacked bar                              | Real Chromium via `@vitest/browser-playwright`. jsdom cannot do SVG measurement, canvas or WebGL and will lie to you about all three |
| `e2e`         | `e2e/**/*.test.ts`                         | Boot `DeFlowd`, run a mock plan to completion, scrub plan versions in a browser      | `singleFork`, `fileParallelism: false`, 180 s timeout                                                                                |

Four rules that make the integration slice meaningful rather than decorative:

1. **Real tmpdirs, not `memfs`.** The daemon shells out to `git` and to agent binaries. A real
   process cannot see a virtual filesystem, so `memfs` is worthless for anything downstream of a
   spawn. Use an `fs.mkdtemp(os.tmpdir())` fixture.
2. **Real `git`, hermetically.** Force-isolate config or the developer's own `~/.gitconfig`
   (`init.defaultBranch`, `commit.gpgsign`, aliases, hooks) silently changes test outcomes:
   `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` plus explicit author/committer identity.
   `isomorphic-git` is not a substitute — it cannot create worktrees the real `git` CLI will honour.
3. **File-backed SQLite, not `:memory:`.** `:memory:` cannot exercise WAL, cannot be reopened after
   a simulated crash, and hides fsync and ordering bugs — that is, it cannot test F4.2, the one
   property that matters most. Test resume by `db.close()` and constructing a fresh engine over the
   same file. `:memory:` is fine for pure projection unit tests.
4. **Inject a `Clock` port; do not reach for fake timers.** `vi.useFakeTimers()` while a child
   process is alive **deadlocks** — the process's real I/O never arrives because the event loop's
   timers are frozen. A `TestClock` you advance manually lets a six-hour human gate run in
   microseconds and satisfies NF9.

Snapshots need a normalising serializer registered _before_ the first one is written, or every
snapshot changes on every run and becomes worthless. Normalise `ts`, run and node ids, durations,
absolute paths, ports and worktree names.

---

## 8. `DeFlow doctor`

```bash
pnpm doctor
```

`doctor` is a first-class command (F3.4, and the PRD's §3.1 nod to ODW's `doctor`), run on install,
on demand, and in CI. It probes:

| Category           | Checks                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**        | Node >= 24; pnpm version; writable global state dir (`$XDG_DATA_HOME/DeFlow` or `~/.DeFlow`); writable repo-local `.DeFlow/`                                                                                        |
| **git**            | `git --version` >= 2.38 (hard requirement for `merge-tree --write-tree`), >= 2.45 preferred; `merge-tree --write-tree` actually runs                                                                                |
| **Sandboxing**     | Linux: `bwrap` and `socat` on PATH; `kernel.apparmor_restrict_unprivileged_userns` on Ubuntu 24.04+. macOS: Seatbelt available. Reports which permission levels (F5.4) are honourable on this machine               |
| **Agents**         | Which vendor binaries are installed, their absolute paths, `--version` output, and a sha256 of the entry file (F3.6). Records them so version drift between runs is a warning, not a silent failure                 |
| **Capabilities**   | Runs a real ACP `initialize` against each and persists the response. Capability manifests are **derived, never hardcoded** (F3.5) — a hardcoded matrix is wrong within a month                                      |
| **Conformance**    | The F3.4 battery against each installed adapter: structured output, streaming, permission refusal, timeout, cancellation, non-zero exit, malformed output, token accounting                                         |
| **Auth shadowing** | Warns loudly if `ANTHROPIC_API_KEY` or similar is set, because it silently shadows subscription auth and the failure mode is "you thought you were on your subscription and you were being billed" (F3.8, PRD §5.3) |
| **PTY**            | Whether `@lydell/node-pty` loaded. If not, says so: `terminal/*` degrades to a no-TTY spawn                                                                                                                         |
| **Memory layer**   | FTS5 availability, current tokenizer calibration factor per (provider, model), secretlint rule count                                                                                                                |

`doctor` never reads a credential file and never captures the output of an auth command (AR-1). Where
a vendor CLI reports a login command, DeFlow prints it for the user to run themselves.

---

## 9. `npx DeFlow up` — first run, step by step

This is what a colleague experiences at M2, and what you should re-verify every milestone.

```bash
npx DeFlow up
```

1. **Resolve directories.** Global state at `$XDG_DATA_HOME/DeFlow` (or `~/.DeFlow`); per-repo state
   at `.DeFlow/` in the current repo, per PRD §9.4. The split matters: `.DeFlow/` can be
   `.gitignore`d wholesale without losing the provider probe cache or cross-run memory.
2. **Open the ledger and migrate.** `PRAGMA user_version`-driven, append-only, no `down`
   migrations. Before any migration runs, `VACUUM INTO` takes a cheap backup — **measured at
   1007 ms for a 193 MB database**, an acceptable safety net. SQLite DDL is transactional, so a
   failed migration rolls back cleanly.
3. **Take the lock.** `flock` on `~/.DeFlow/DeFlow.lock`, bump `daemon_epoch`. This is what stops a
   double-launched daemon — very common, since people run `npx DeFlow up` in two terminals — from
   driving the same run twice.
4. **Probe providers.** The `doctor` path (§8): which binaries exist, their versions, their
   capabilities. DeFlow plans only against what is actually available (PRD §5.3, F5.4).
5. **Pick a port.** 7777, or the next free one via `get-port`.
6. **Generate a token.** 32 random bytes from `crypto.randomBytes`, base64url-encoded. Write
   `.DeFlow/daemon.json` as `{ pid, port, token, startedAt }` at mode `0600`, in the gitignored
   data directory — the first person to commit a `daemon.json` commits a bearer token.
7. **Bind `127.0.0.1` only — and still authenticate.** A localhost bind is _not_ a security
   boundary: any local process, and any web page via DNS rebinding, can reach 7777. Require
   `Authorization: Bearer`, reject requests whose `Origin` is not ours, and send `Vary: Origin`.
   Retrofitting auth after the UI exists is much worse than doing it now. Detail in
   [the security model](./15-security-model.md).
8. **Print the URL with the token in the fragment** — `http://127.0.0.1:7777/#token=<token>` — which
   the UI immediately exchanges into `sessionStorage`, strips from the address bar with
   `history.replaceState`, and sends as an `Authorization` header thereafter; then open the browser.

   > **Corrected by KAR-15.2.** This step used to describe a one-time token passed as a **query
   > parameter**, which contradicted [11 §8](./11-api-and-realtime.md) and
   > [15 §3.2](./15-security-model.md) — both of which specify the fragment and both of which list
   > "put the daemon token in a query string" under _what not to do_. The fragment wins because it
   > is the form supported by an argument: fragments are never sent to the server, so the token
   > cannot land in an access log, a `Referer` header, browser history or shell scrollback. A
   > repository-wide grep (`test/no-token-in-url.test.ts`) now fails the build if any source file
   > puts a credential in a query string, so the two documents cannot drift apart again.

Cold start budget is under 3 seconds (NF3). Steps 2 and 4 are the ones that can blow it; the
provider probe is cached and refreshed on a version change, not on every start.

---

## 10. Verifying the real published package

`pnpm build` producing a green local run proves nothing about the tarball. The classic failure is a
missing `files` entry that drops `dist/ui/`, so the daemon starts and serves a blank page. Test the
artefact:

```bash
pnpm build
pnpm pack:check                       # publint + attw against the built package

cd packages/cli && pnpm pack          # -> DeFlow-0.1.0.tgz
cd "$(mktemp -d)"
git init -b main demo && cd demo
npx /path/to/DeFlow-0.1.0.tgz up      # the exact bytes a user would get
```

What this catches that `pnpm dev` cannot:

- A missing or wrong `files` array in `packages/cli/package.json`.
- The shebang or exec bit being lost on `dist/bin.mjs`.
- A `@DeFlow/*` package that failed to inline and is now an unresolvable runtime import.
- A native dependency that was bundled instead of externalised.
- UI assets resolved from the wrong path — they ship as **plain files** in the tarball, never
  bundled into JS, and are resolved at runtime with
  `fileURLToPath(new URL('./ui', import.meta.url))`.

The build order is fixed and matters: `pnpm --filter @DeFlow/web build` → `packages/web/dist` →
copied into `packages/cli/dist/ui/` → `tsdown` bundles `bin.ts` with `@DeFlow/*` inlined and the two
natives external.

Run this on every release, and once per milestone even without a release. You are also the M2
"colleague installs it unaided" test subject, so `docs/CONTRIBUTING.md` should open with literally
`git clone && pnpm install && pnpm dev` and be re-verified on the same cadence.

---

## 11. Debugging recipes

### Keep a failed worktree

```bash
DeFlow_KEEP_TMP=1 pnpm test:int
```

The tmpdir fixture only removes the directory when `DeFlow_KEEP_TMP` is unset. With a failed
worktree preserved you can `cd` into it, run `git status`, `git log`, `git worktree list` and see
exactly what the node did. Without it, post-mortem on a worktree bug is guesswork. CI sets the same
variable on the e2e job and uploads the directory with `actions/upload-artifact` on failure.

### Snapshot a ledger for a bug report

```sql
VACUUM INTO '/tmp/DeFlow-bug-1234.db';
```

Or from the CLI:

```bash
DeFlow ledger snapshot <runId> --out /tmp/DeFlow-bug-1234.db
```

**Measured at 1007 ms for a 193 MB database.** It produces a single consistent file with no WAL
sidecar, safe to attach to an issue or hand to a future you. This is the "attach my ledger to this
bug report" command, and when you are the only engineer it is invaluable.

Then inspect it with anything:

```bash
sqlite3 /tmp/DeFlow-bug-1234.db \
  "SELECT seq, kind, node_id, attempt FROM event WHERE run_id='<id>' ORDER BY seq LIMIT 50;"
sqlite3 /tmp/DeFlow-bug-1234.db "PRAGMA integrity_check;"
```

NF8 says every artefact is inspectable on disk in an open format. A plain SQLite file is that.

### Readable logs

```bash
pnpm dev | pino-pretty
```

Never wire `pino-pretty` as a runtime transport — it is a dev-time pipe only. Logs are namespaced by
subsystem via `logger.child({ mod: 'orchestrator', runId })`, so filtering is easy:

```bash
pnpm dev | pino-pretty | grep '"mod":"scheduler"'
```

Redaction is configured from commit one (`*.authorization`, `*.token`, `env.ANTHROPIC_API_KEY`,
`env.OPENAI_API_KEY`, `*.headers.cookie`). Retrofitting it across six months of call sites is
miserable.

> **Pino logs are not the ledger.** Ledger events are domain facts written to SQLite in the same
> transaction as state (F4.1, NF10). Pino is operator diagnostics. Conflating them makes NF10
> unprovable and will tempt you into reconstructing state from log files. Two sinks, two purposes.

### Inspect a run on disk

Everything a run did is a file (NF8, PRD §9.4):

```
.DeFlow/runs/<runId>/       exports, written from the ledger — not the source of truth
  plan/v1.json … vN.json    every plan version (F2.6)
  nodes/<nodeId>/
    packet.json             the exact assembled context packet + per-segment token counts
    prompt.txt              the exact rendered prompt that was sent
    stdout.log              raw agent output (the browser terminal is a live tail of this)
    output.json             normalised, schema-validated output
    verdict.json            gate verdict with structured findings
  artifacts/<sha>/          per-run hardlinks into the global content-addressed blob store
.DeFlow/wt/<runId>__<nodeId>/   git worktrees, one per write-capable node (D13)
$XDG_DATA_HOME/DeFlow/ledger.db  the event log — the source of truth, one global database
```

When a view looks wrong, the question "is this a projection bug or a data bug?" is answered by
diffing what is on disk against what the UI shows. That is the whole point of the architecture.

### Reproduce a UI state instantly

Do not wait for a run to reach the state you want to style. Find the fixture, or record one once:

```bash
pnpm dev:replay                                             # the default happy path
DeFlow replay fixtures/gate-fail-repair.jsonl --speed 50x   # jump straight to a failed gate
DeFlow replay fixtures/stress-400.jsonl --speed max         # graph performance
```

### Watch for a client-side leak

A multi-hour run kills the tab through unbounded retention, not through CPU. Ship a dev-only
assertion that logs projection object counts every 60 seconds. You will catch the leak in week one
instead of hour four of a real run.

---

## 12. Git hooks

`lefthook@2.1.10` replaces husky **and** lint-staged with one Go binary shipped through
optionalDependencies. `"prepare": "lefthook install"` wires it up on `pnpm install`.

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  jobs:
    - name: format
      glob: "*.{ts,vue,json,jsonc,css,html}"
      run: pnpm biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true
    - name: lint
      glob: "*.ts"
      run: pnpm oxlint {staged_files} # no --type-aware here: too slow for a hook

pre-push:
  jobs:
    - name: typecheck
      run: pnpm typecheck
    - name: unit
      run: pnpm vitest run --project unit
```

> **Keep pre-commit under about 2 seconds.** Anything slower and you will start reaching for
> `--no-verify`, at which point the hooks are theatre and you are worse off than with none. Typecheck,
> type-aware lint and the full suite belong on pre-push and in CI.

Before enabling `stage_fixed: true` on `.vue` files, verify Biome's SFC formatting on a scratch
branch (see [tech stack §10.7](./02-tech-stack.md)) — a formatter that auto-stages a bad rewrite is
the worst possible combination.

---

## 13. Troubleshooting

| Symptom                                                       | Likely cause                                                                                                       | Fix                                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` fails on `node-gyp`                            | You have `node-pty` rather than `@lydell/node-pty` in a `package.json`                                             | Neither native dependency should ever invoke node-gyp. `@lydell/node-pty` uses per-platform optionalDependencies; `better-sqlite3` v13 ships prebuilds with `gypfile: false` |
| `corepack: command not found`, or corepack errors in CI       | Corepack was removed from Node 25+ distributions                                                                   | `npm i -g pnpm@11`, or `pnpm/action-setup@v6` in CI. Never `corepack enable`                                                                                                 |
| `biome check` reports nothing on `.vue` files                 | `html.experimentalFullSupportEnabled` is not set                                                                   | Add the `html` block to `biome.json`. Without it Biome silently no-ops on SFCs                                                                                               |
| Duplicate lint errors, or autofixes that undo each other      | Biome's linter and oxlint are both enabled over the same globs                                                     | `"linter": { "enabled": false }` in `biome.json`. Biome formats, oxlint lints                                                                                                |
| SSE events arrive in bursts, or the stream dies after minutes | Something is proxying or compressing the stream                                                                    | Do not proxy in dev (§4.3). In production, no compression middleware on the stream route; send `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`           |
| UI shows nothing after a reload following a daemon restart    | Browsers do **not** send `Last-Event-ID` when the initial connection never opened successfully                     | Hydrate explicitly via `GET /api/runs/:id/events?since=<seq>` first, then open the stream. This path is mandatory, not an optimisation                                       |
| Port 7777 is in use / two daemons                             | A second `DeFlow up` in another terminal                                                                           | The `flock` + `daemon_epoch` fence rejects stale-epoch writes. Check `.DeFlow/daemon.json` for the live pid                                                                  |
| Tests pass locally, fail in CI (or vice versa)                | Git fixtures inheriting your `~/.gitconfig`                                                                        | Set `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` plus explicit author/committer env in every fixture                                                            |
| An integration test hangs forever                             | `vi.useFakeTimers()` with a live child process                                                                     | Never fake timers around a subprocess. Use the injected `Clock` port                                                                                                         |
| Snapshots change on every run                                 | No normalising serializer                                                                                          | Register `expect.addSnapshotSerializer` for `ts`, ids, durations, paths and ports before writing the first snapshot                                                          |
| A vendor CLI worked yesterday and fails today                 | Flag or output churn (G7)                                                                                          | `pnpm doctor` runs the conformance battery and names the broken assertion. `pnpm test:record` refreshes the goldens                                                          |
| Claude Code appears sandboxed but writes outside the worktree | `bwrap`/`socat` missing, or AppArmor blocking user namespaces — the sandbox falls back to unsandboxed **silently** | `pnpm doctor`; install bubblewrap and socat; add the `/etc/apparmor.d/bwrap` profile. DeFlow sets `sandbox.failIfUnavailable: true` for every non-`full` level               |
| Agent CLIs keep running after `DeFlowd` is SIGKILLed          | Children reparented to init                                                                                        | They are spawned `detached: true` so the whole process group can be killed. On restart, orphans are reaped by matching `(pid, process_start_time)` — never by bare pid       |
| Browser tab becomes unusable during a long run                | Unbounded client-side retention, or xterm scrollback                                                               | Never keep the raw event array; keep a bounded ring of ~2,000 for the debug pane. `scrollback: 5000` in xterm and never raise it                                             |
| The published tarball serves a blank page                     | `dist/ui/` missing from `files`                                                                                    | `pnpm pack` and install into a temp dir (§10) as part of every release                                                                                                       |
| `pnpm install` warns "Failed to create bin at …/dist/bin.mjs" | A clean checkout has no `packages/cli/dist` yet, and `packages/cli` declares its three bins there                  | Expected, and harmless — the install still exits 0. `pnpm build` creates them; the next install links them. The alternative is not declaring the bins, which is what ships broken |

---

## Pitfalls

- **Do not add a Vite proxy.** Ever. See §4.3.
- **Do not "fix" `node --watch` restarts.** They are the crash-resume test (§5).
- **Do not hand-write replay fixtures.** Record them from mock-agent runs (§6.2).
- **Do not mock `child_process`.** A fake binary tests the parser and the kill path; a mocked spawn
  tests the mock.
- **Do not treat localhost as a security boundary.** Bearer token and `Origin` validation from the
  first commit.
- **Do not let pre-commit creep past ~2s.** The moment you type `--no-verify` the hooks stop
  existing.
- **Do not develop exclusively against the mock.** Refresh recordings against real CLIs manually
  each milestone, or the conformance suite tests a fiction.

---

**Related:** [Tech stack](./02-tech-stack.md) · [Testing strategy](./14-testing-strategy.md) ·
[Repo layout](./16-repo-layout.md) · [API and realtime](./11-api-and-realtime.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md)

[← Back to index](./README.md)
