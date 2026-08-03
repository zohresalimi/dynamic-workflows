# Architecture overview

> Part of the [Karvan architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

## 1. The problem, in three sentences

Complex engineering work needs hours of agent time, dozens of steps and repeated verification, and today it breaks in four places: the plan is frozen before the agent has seen the codebase, the run does not survive a crash, nobody can tell which step poisoned the output or what context it actually received, and every framework that gives you structure bills you per token instead of using the subscription you already pay for. Karvan is the layer *above* the vendors' coding harnesses — planning, coordination, memory, verification and visibility — and explicitly not a better coding agent. The full statement is [PRD §2](./prd.md#2-problem-statement); the competitive gap analysis is [PRD §4.8](./prd.md#48-competitive-positioning).

---

## 2. The inviolable rules

These five rules are settled. Everything downstream in this document set is a consequence of them, and every one of them costs something — the cost is stated so you can recognise when you are being tempted to pay it back.

### Rule 1 — Karvan never possesses a model credential (AR-1)

Karvan launches the vendor's own official binary as a child process, on the user's machine, under the user's OS account, using credentials that binary already stored for itself. Karvan reads no token file, sets no auth environment variable, and transmits no credential anywhere ([PRD §5.3](./prd.md#53-the-architectural-rule-this-produces), NF2).

**Verified 2026-08-02.** `@agentclientprotocol/claude-agent-acp@0.64.1` returns `"authMethods": []` in its `initialize` response — it is already authenticated from the user's own Claude Code credential store and needs nothing from Karvan. That is AR-1 working as designed. Copilot returns an `authMethods` entry whose `_meta["terminal-auth"]` block contains the literal `{command, args}` for login; surface that to the user as a command *they* run, and never capture its output.

**Consequences.** (a) Execution is local — no SaaS backend, which forces Rule 2. (b) Provider access is a capability *discovered at runtime*, never a configuration: Karvan probes which binaries are installed and authenticated and plans only against those. (c) API keys stay a first-class alternative, not the default — and because `ANTHROPIC_API_KEY` in the environment silently shadows subscription auth in Claude Code, Karvan must detect and surface it loudly (F3.8). (d) When this goes to a team, runs still execute on each engineer's machine; the hub aggregates redacted events, never credentials ([PRD §5.4](./prd.md#54-team-phase-consequence)).

### Rule 2 (D1) — One headless daemon, one process, one port

`karvand` is a Node ≥ 24 process serving a browser UI on `127.0.0.1:7777`. The engine cannot live in the UI process, because runs last hours and must survive the browser closing (I2). In development, Vite runs in **middleware mode inside karvand** (D10) rather than as a second server behind a proxy — Vite's dev proxy is documented-bad at SSE (buffering, socket timeouts, close events not propagating) and the entire UI is an SSE projection of the ledger.

**Consequences.** Dev and production routing are byte-identical, there is no CORS surface, and there is exactly one URL to remember. The cost is that a UI-only change restarts the daemon; that is acceptable because the daemon's own restart path is the crash-resume path (F4.2), so the dev loop exercises the most important property in the system continuously. Binding to loopback is *not* a security boundary — the daemon still authenticates every request with a bearer token generated at first run ([security model](./15-security-model.md)).

### Rule 3 (D7) — The plan is data; the engine is a journaled DAG state machine, not a replay engine

The `PlanGraph` is an immutable, content-hashed JSON document in SQLite. Node identity comes from `node_id` in the plan, never from code position or execution order. Karvan adopts the Inngest/DBOS **checkpoint-and-memoize** model: the *result* of every non-deterministic operation is journaled, and restart short-circuits on a `done` record. Karvan does **not** adopt Temporal/Restate-style deterministic workflow replay, and does not adopt DBOS, Temporal or Restate as a dependency ([durable execution](./05-durable-execution.md)).

**Verified 2026-08-02.** DBOS Transact for TypeScript is not viable here regardless: the repo at commit `dfd600cc` and `@dbos-inc/dbos-sdk@4.25.14` depend on `pg` only, `SystemDatabase` holds a hard `pg.Pool`, and the `sqlite3?` field on its migration type is referenced nowhere in `src/`. It is a dead placeholder.

**Consequences.** Because control flow is data rather than code, karvand can be **upgraded mid-run** with zero determinism risk — the only compatibility surface is the event schema, which is versioned explicitly with an upcaster chain. You avoid Temporal's `patched()` and Inngest's step-hash `:n` counters entirely. The cost is roughly 800–1500 LOC of ledger, reducer, effect journal and scheduler that you write and own.

### Rule 4 (D8) — ACP-first, CLI shims as the documented fallback

Karvan is an ACP *client*, playing the role an editor plays, via `@agentclientprotocol/sdk@1.3.0` (exact pin) targeting wire `protocolVersion: 1`. This turns N×M agent integrations into N+M and gives Karvan sessions, streaming updates, permission negotiation and client-provided fs/terminal access through one code path ([provider adapter layer](./07-provider-adapter-layer.md)).

**Verified 2026-08-02** by running real `initialize` handshakes against installed binaries. Three agents speak ACP natively — `gemini --acp` (0.53.1), `copilot --acp` (1.0.77), `opencode acp` (1.18.11). The two most important agents do **not**, and need first-party adapters: Claude Code via `@agentclientprotocol/claude-agent-acp@0.64.1`, Codex via `@agentclientprotocol/codex-acp@1.1.9`. Getting this backwards means building the wrong spawn logic for your two primary providers.

**Consequences.** Capability is uneven and must be probed, not hardcoded — `session.resume` is advertised by Claude, Codex and OpenCode but **not** by Copilot or Gemini, so resume is an optimisation and never a durability mechanism. Karvan's own ledger is the sole source of truth for a run, and every prompt must be reconstructible from it alone. CLI exec shims are retained *permanently* as a parallel path, not as a temporary bridge, because ACP may fragment if Microsoft ships a competitor ([PRD §13](./prd.md#13-risks)).

### Rule 5 (D12) — Karvan owns policy and mediation; it does not build a sandbox

Sandboxing is delegated to the vendor CLI's own mechanism — Seatbelt on macOS, bubblewrap+socat or Landlock+seccomp on Linux. Karvan's leverage is that as the ACP client it sits **in the path of every file access and every command execution**: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/kill`, `session/request_permission` all arrive at Karvan's handlers before anything happens ([workspace and safety](./09-workspace-and-safety.md)).

**Consequences.** The graduated permission ladder (F5.4) collapses from an N-vendors × M-levels mapping matrix into **one pure policy function**, evaluated identically for every vendor and unit-testable with no vendor CLI installed. "Refuse to schedule" survives only for the genuine case — an adapter that cannot offer mediated execution at all — expressed as a single `mediatedExecution: boolean` on the capability manifest rather than a per-flag matrix. Do **not** wrap a vendor CLI in your own bwrap profile by default: nesting sandboxes breaks the working one, and Claude Code's own docs warn that the `enableWeakerNestedSandbox` escape hatch considerably weakens security.

---

## 3. Component diagram

Expanded from [PRD §9.1](./prd.md#91-shape) with the components the research actually established.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                                  │
│   Browser UI (Vue 3)     karvan CLI        Desktop shell (M3, Tauri 2)   │
│   @karvan/web            packages/cli      — same HTTP + SSE client      │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ HTTP + SSE on 127.0.0.1:7777 only,
                                     │ bearer token, SSE id = ledger seq,
                                     │ Last-Event-ID resumes from offset
┌────────────────────────────────────┴─────────────────────────────────────┐
│ karvand — one Node >= 24 process, one port                               │
│                                                                          │
│  API + EVENT STREAM   hono + @hono/node-server; Vite in middleware mode  │
│                       when KARVAN_DEV=1 (no proxy, no CORS)              │
│ ──────────────────────────────────────────────────────────────────────── │
│  FUNCTIONAL CORE   @karvan/core — pure, total, zero I/O                  │
│    reduce(state, event) -> state      decide(state, now) -> Command[]    │
│    PlanGraph · PlanPatch · patch policy · permission ladder · Clock port │
│ ──────────────────────────────────────────────────────────────────────── │
│  IMPERATIVE SHELL   @karvan/daemon                                       │
│    Orchestrator      ~1 Hz tick: replay -> decide -> dispatch -> append  │
│    Effect Runner     write-ahead effect journal, ikey dedup, reconcile() │
│    Planner           TaskSpec + recon + capabilities -> PlanGraph vN     │
│    Context Builder   packet assembly, pinning, compaction, token budget  │
│    Blackboard        typed facts + provenance (a ledger projection)      │
│    Gate Runner       deterministic checks, adversarial review, verdicts  │
│    Workspace Mgr     worktrees, branches, merge-tree conflict matrix     │
│    MCP Host          workflow-level tools, injected per ACP session      │
│ ──────────────────────────────────────────────────────────────────────── │
│  PERSISTENCE   @karvan/ledger                                            │
│    Ledger      event | io_chunk | effect | plan | run | node_wake        │
│                better-sqlite3@13.0.2 behind a ~60-line `Db` port         │
│    Blob store  content-addressed: <dataDir>/blobs/<ab>/<sha256>          │
│ ──────────────────────────────────────────────────────────────────────── │
│  ADAPTERS   @karvan/adapters                                             │
│    ACP client (primary)  │  CLI exec shims (fallback)  │  API SDKs (BYO) │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ spawn(bin, args, { detached: true })
                                     │ ndjson JSON-RPC 2.0, protocolVersion 1
                                     │ NO CREDENTIAL EVER CROSSES THIS LINE
        ┌────────────────────────────┴──────────────────────────────┐
        │ VENDOR AGENT PROCESSES — user's OS account, own auth      │
        │   claude-agent-acp -> claude      codex-acp -> codex      │
        │   gemini --acp     copilot --acp     opencode acp         │
        │   karvan-mock-agent (deterministic, offline, free)        │
        └───────────────────────────────────────────────────────────┘
```

Two arrows are missing from the picture because they run the other way. First, the MCP host: each ACP `session/new` injects `mcpServers: [{ name: "karvan", command: process.execPath, args: [karvanMcpEntry, "--socket", …] }]`, so the agent spawns a `karvan-mcp` shim that talks back to karvand over a Unix domain socket (D9). Second, `fs/*` and `terminal/*`: the agent calls *Karvan* for file and command access, which is exactly why Rule 5 works.

---

## 4. Components and owners

| Component | Package | Responsibility |
|---|---|---|
| Domain model | `@karvan/core` | `TaskSpec`, `PlanGraph`, `PlanPatch`, `Fact`, `ContextPacket`, the `Event` union, Zod schemas |
| Reducer (`reduce`) | `@karvan/core` | Pure, total `(state, event) -> state`; ignores unknown `kind` for forward compatibility |
| Scheduler policy (`decide`) | `@karvan/core` | Pure `(state, now) -> Command[]`: ready set, admission, backoff, stall detection |
| Patch policy engine | `@karvan/core` | Classifies each `PlanPatch` auto / approve / reject by cost delta, blast radius, replan depth (F2.5) |
| Permission ladder | `@karvan/core` | One pure function mapping `(level, request)` to allow/deny for `fs/*` and `terminal/*` (F5.4) |
| Clock port | `@karvan/core` | `now()`, `sleep()`, `setTimer()` — injected so the scheduler is testable with zero I/O (NF9) |
| Ledger | `@karvan/ledger` | Append-only `event` table, `io_chunk` data plane, `effect` journal, `plan`, `run`, `node_wake`; migrations on `PRAGMA user_version` |
| `Db` port | `@karvan/core` (interface) / `@karvan/ledger` (impl) | ~60-line synchronous interface over `better-sqlite3@13.0.2` (D6), making a future driver swap a one-file change |
| Blob store | `@karvan/ledger` | Content-addressed spill for payloads > ~256 KiB; stores `{sha256, bytes, mime, head, tail}` in the event (F6.5, NF8) |
| ACP client | `@karvan/adapters` | `@agentclientprotocol/sdk@1.3.0`, `protocolVersion: 1`, `session.nextUpdate()` pull loop |
| CLI exec shims | `@karvan/adapters` | Per-vendor headless invocation and output parsing, for agents with no ACP path (F3.2) |
| Capability probe | `@karvan/adapters` | Persists each agent's full `initialize` response; every routing decision reads that row, never a hardcoded table (F3.5, F3.6) |
| Orchestrator | `@karvan/daemon` | ~1 Hz tick loop; owns concurrency semaphores, the repo write lock, the daemon epoch/`flock` lease |
| Effect Runner | `@karvan/daemon` | `durable(effect)`: write-ahead intent, memoise on `done`, per-type `reconcile()` probe (F4.3) |
| Planner | `@karvan/daemon` | Drives the planner agent, validates and hashes the resulting `PlanGraph`, applies patches (F2.2, F2.4) |
| Context Builder | `@karvan/daemon` | Assembles packets from declared reads only; pinning, compaction, token accounting (F6.1–F6.6) |
| Blackboard | `@karvan/daemon` | Typed facts with provenance; a projection over `fact.written` / `fact.read` events (F6.3) |
| Gate Runner | `@karvan/daemon` | Deterministic gates, adversarial review on a different session/provider, typed verdicts (F7.1–F7.5) |
| Workspace Manager | `@karvan/daemon` | Worktrees, branch naming, `.worktreeinclude` copy, dependency setup, `merge-tree` conflict matrix |
| MCP host | `@karvan/daemon` | Workflow-level tools over `@modelcontextprotocol/sdk@1.30.0`, exposed via the `karvan-mcp` stdio shim |
| HTTP + SSE API | `@karvan/daemon` | `hono` routes, resumable SSE from ledger offsets, bearer auth, Vite middleware in dev |
| Web UI | `@karvan/web` | Vue 3 SPA; a ledger-projection Pinia store feeding the nine P0 views (D11) |
| CLI + bins | `karvan` (`packages/cli`) | `karvan init/up/run/doctor`; ships `karvan`, `karvan-mcp`, `karvan-mock-agent` |
| Mock ACP agent | `@karvan/mock-agent` | Deterministic, seeded, offline agent that can hang, crash, emit malformed frames and fake any capability profile (D17) |
| Testkit | `@karvan/testkit` | Fake binaries, hermetic git fixtures, tmpdir fixtures, `TestClock`, crash-fuzz harness |

---

## 5. Runtime flow A — intake to approved TaskSpec to PlanGraph v1

1. **Intake.** `karvan run "…"` or `POST /api/runs` accepts free text, a file, a git issue reference or a spec document (F1.1). The daemon appends `run.created` and allocates a run id.
2. **Capability probe.** Before anything is planned, karvand resolves the **absolute** path of each vendor binary (karvand's `PATH` at daemon-start differs from the user's login shell), runs `initialize`, and persists the full response plus `--version` and a sha256 of the entry file (F3.6). Planning happens against what is actually installed and authenticated — AR-1 consequence (b).
3. **Framing.** A framing agent node runs at `read` permission against a detached worktree and interrogates the task and the repo, producing a `TaskSpec`: goal, scope boundaries, non-goals, constraints, prior decisions, **acceptance criteria** and **known failure modes** (F1.2). The result is Zod-validated; a schema violation is a node failure with one repair attempt, never silent propagation.
4. **Human approval.** The run suspends on a blocking `human` node (F1.3, F8.1). Suspension costs one `node_wake` row and zero CPU, so a six-hour gate and a six-second one are the same code path. Edits append `spec.amended`; approval appends `spec.approved`. This is a real gate — shallow specs are the primary documented failure mode of spec-driven development ([PRD §4.5](./prd.md#45-category-e--spec-driven-development)).
5. **Planning.** The planner compiles `TaskSpec` + repo reconnaissance facts + the capability manifest list into `PlanGraph` v1 (F2.2). Where the adapter supports constrained output (Codex `--output-schema`, Claude Code `--json-schema`) use it; otherwise validate and repair.
6. **Plan validation**, entirely in `@karvan/core` with no I/O: the graph is acyclic; every node's declared `reads` resolve to a blackboard key, artifact handle or spec section (F6.2); every acceptance criterion maps to at least one gate (F7.4); no node is scheduled onto an adapter that cannot honour its required capabilities (F3.5); declared path scopes are computed into an overlap matrix for admission control (F5.3 — a *prediction*, per D14).
7. **Commit and estimate.** The plan document is stored content-addressed in `plan(hash, run_id, doc)`; `plan.proposed` references the hash. A pre-flight cost estimate is produced (F9.3) and the run becomes schedulable.

Every later replan repeats steps 5–7 and writes a **new** plan row plus a `plan.patched` event. Plan versioning is free because plans are immutable documents referenced by hash — which is what makes the plan-evolution scrubber (F10.2) possible at all.

---

## 6. Runtime flow B — one agent node, end to end

1. **Admission.** `decide()` selects nodes where dependencies are `completed`, `attempt < maxAttempts`, `wakeAt <= now`, and a slot exists in every relevant semaphore: global agent slots (default 3 — the real limit is laptop RAM and vendor rate limits), the per-repository write lock, the per-worktree exclusive lock. Locks are held as ledger events (`node.lock.acquired`), not in memory, so they survive restart. Output: `Command[]`.
2. **Worktree.** `git -C <main> worktree add --lock --reason "karvan run=<runId> node=<nodeId>" -b karvan/<runId>__<nodeId> <path> <baseRef>` for write nodes; `--detach` for read nodes. Branch naming is **flat** (D13): the PRD's `karvan/<run-id>/<node-id>` is a verified bug — git cannot have `refs/heads/karvan/r1` be both a file and a directory, so a run-level integration branch is impossible under it. `--lock` is applied atomically at creation, never create-then-lock, and it is what makes the worktree immune to Karvan's own background pruner. **Never pass `--force` to `worktree add`** — verified, it happily creates a second worktree on the same branch, which is the real index-corruption footgun. Setup runs `.worktreeinclude` copying plus `pnpm install --frozen-lockfile`, cached on the lockfile hash.
3. **Context packet.** The Context Builder assembles the packet from the node's declared reads *and nothing else* (F6.1). The pinned set — `TaskSpec`, acceptance criteria, safety constraints, path scopes, permission level — is re-injected verbatim and never compacted (F6.6, F1.5). Large evidence enters as artifact handles with head/tail previews rather than inline text (F6.5). A `context.built` event records per-segment token counts, which is what the context-budget view renders (F10.5).
4. **Effect intent.** The Effect Runner inserts an `effect` row `state='pending'` keyed by `ikey = <runId>/<nodeId>/<attempt>/<ordinal>` with a `request_hash`, **before** the side effect. That pre-effect record is the only thing that makes at-least-once recovery possible.
5. **Session.** `spawn(bin, args, { detached: true, stdio: ['pipe','pipe','pipe'], cwd: worktree, env: scrubbed })`. A `TransformStream` enforcing an 8 MiB frame cap sits upstream of `acp.ndJsonStream()`, because the SDK's `LineBuffer` has **no maximum line length** and a wedged agent would grow it until karvand OOMs. `initialize` → `session/new` with Karvan's MCP stdio server injected.
6. **Streaming with backpressure.** The `session.nextUpdate()` **pull** loop is the load-bearing API detail: it lets Karvan `await` the SQLite append before requesting the next frame. Never `await` a database write inside an `on('data')` handler — flowing mode gives you an unbounded in-memory queue. Raw stdout goes to `io_chunk` and is never read by the reducer; payloads over ~256 KiB spill to content-addressed blobs.
7. **Mediation.** Every `fs/write_text_file`, `terminal/create` and `session/request_permission` is evaluated by the pure ladder function (Rule 5). `terminal/create` uses a **default-deny allowlist** of the project's actual verbs (`git`, `pnpm`, `node`, `pytest`, `make`, `cargo`, `tsc`…), not a deny-list — `rm -rf /` has infinite spellings. The child environment is scrubbed of `AWS_*`, `KUBECONFIG`, `DATABASE_URL`, `*_TOKEN`, `*_API_KEY`, `TF_*`, `VAULT_*` unless the node's level explicitly requests them. That ambient-authority control, not another approval step, is what would actually have prevented the Kiro incident (F5.6).
8. **Live projection.** Each appended event is pushed to subscribed SSE streams with `id: <seq>`, so the plan graph, terminal panes, Gantt and cost counters update while the node runs (F10.1, F10.6, F10.9).
9. **Structured return.** The node returns a bounded structured summary — default budget 500–2000 tokens, enforced — not a raw transcript (F6.4). It is validated against the node's JSON Schema handoff contract; violation is a node failure with a repair attempt (F6.9).
10. **Commit and blackboard write.** `git commit -m "…" -m "Karvan-Effect-Id: <ikey>"`. That trailer turns the one genuinely non-idempotent git operation into an idempotent one, because reconciliation is `git log --grep="Karvan-Effect-Id: <ikey>" --format=%H -1`. Facts land as `fact.written` events carrying provenance: which node, from what evidence, when, at what confidence (F6.3). The `effect` row flips to `done`.
11. **Conflict detection.** `git merge-tree --write-tree` runs the node's branch against the integration branch and against every other in-flight branch. Exit 0 means clean, exit 1 means conflict; it touches neither the index nor a working tree, so it is safe against live worktrees and costs milliseconds. This is **ground truth** and declared path scopes are demoted to a plan-time prediction (D14): a scope violation is a warning, a merge-tree conflict is a gate.
12. **Gates.** Deterministic gates first — typecheck, lint, tests, build (F7.1). Then, if the plan has one, an adversarial review node on a **different session and preferably a different provider** than the producer (F7.2). Verdicts are typed `pass | fail | needs-human` with structured findings carrying file/line references, never a prose blob (F7.3). A failure spawns a fresh, narrowly-scoped repair node — one issue, regression test first, capped at 3 attempts, then escalate (F7.5).
13. **Completion.** `node.completed` advances the progress watermark (the `seq` of the last event that actually changed reduced state — stdout chunks do not count, for free, because they never reach the reducer). The tick loop re-runs `decide()`.

Cancellation at any point is three-stage: protocol-level `session/cancel` first so the agent flushes pending updates and answers with `stopReason: "cancelled"`, then `process.kill(-child.pid, 'SIGTERM')` on the whole process group, then `SIGKILL` after a grace period (F5.7).

---

## 7. Runtime flow C — crash and resume

1. **The crash.** SIGKILL, an OS update, a closed lid, a panic. Because agents are spawned `detached: true`, **they survive karvand's death** — reparented to init, still running, still burning tokens. That is a consequence you must handle, not a bug: `detached` is mandatory, since with `detached: false` the grandchildren's process group is *karvand's own*, so there is no group you can safely signal.
2. **Single-instance lease.** On boot, karvand takes an `flock` on `<dataDir>/karvan.lock` and bumps a `daemon_epoch` counter. Every write carries the epoch; stale-epoch writes are rejected. This stops the very common "user ran `npx karvan up` in two terminals" case from driving one run twice.
3. **Orphan reaping.** For each non-terminal spawn row, compare **both** the pid and the recorded process start time (`/proc/<pid>/stat` field 22 on Linux, `ps -o lstart= -p <pid>` on macOS) before killing the group. Never kill by bare pid after a restart — pids are recycled and you will eventually kill the user's editor. When verifying a kill worked, exclude `Z`-state processes: a successfully group-killed subtree still appears in `ps` as zombies awaiting reaping, which reads as a false negative.
4. **Replay.** `state = checkpointValid ? decode(run.state_json) : initial`, then `reduce()` over `event WHERE run_id = ? AND seq > last_seq`. **Verified 2026-08-02:** a control-plane-only replay of 10,000 rows takes **29 ms**, and a full scan of 500,000 rows takes **416 ms**. That is why the control plane and the agent I/O stream live in **separate tables** and why there is **no snapshotting subsystem** — the perceived need for one comes entirely from mixing agent stdout into the ledger. The checkpoint carries a `checkpoint_version`; a mismatch means "ignore the cache, full replay", so checkpoints are a pure optimisation that can never cause a correctness bug.
5. **Effect reconciliation.** Rows still `pending` whose `started_at` precedes this daemon's start were in flight when the process died. Each effect type ships a `reconcile()` probe. *Agent invocation:* if a `session_id` was journaled from the first init frame, and the adapter advertises `session.resume`, resume; otherwise replay from Karvan's own log into a fresh `session/new`. *Pure shell* (test, lint, build): just re-run. *Mutating shell:* compare hashed `git status --porcelain` against the before/after journal. *Git:* grep the effect-id trailer. *File write:* an orphaned `<path>.karvan-<ikey>.tmp` means the crash preceded the atomic rename.
6. **The irreducible gap, stated honestly.** The window between an effect landing in the world and its `state='done'` row committing cannot be closed — there is no two-phase commit with git or a shell. `reconcile()` can return `unknown`, and there is **no correct automatic action**. The human review gate for that case is designed in from day one rather than bolted on. Note also that `attempt` is part of the ikey, so a *retry* deliberately mints a new key and re-executes — crash-resume (memoise) and failure-retry (re-execute) are genuinely different operations and the reducer must distinguish them.
7. **Workspace recovery.** `git worktree prune -v --expire 2.weeks.ago`, then unlock any worktree whose owning process is gone. A worktree the agent left dirty is never blind-forced: capture `git status --porcelain=v2 -z` into the ledger, auto-commit a `karvan: WIP salvage` commit to the node branch so the work is recoverable, *then* `worktree remove --force`.
8. **Continue.** Completed nodes are never re-executed (F4.2). Durable wake times live in the `node_wake` table, never in `setTimeout` — verified, Node's max timer delay is `2^31-1 ms` and passing `2**31` fires the callback after **1 ms** with only a warning, which silently turns a 30-day wait into an instant one. Timers also do not fire during laptop sleep and do not survive restart.

---

## 8. Functional core, imperative shell

The engine is three declarations:

```ts
// @karvan/core — pure, total, forward-compatible. Zero I/O.
export function reduce(state: RunState, event: Event): RunState;
export function decide(state: RunState, now: number): Command[];

// @karvan/daemon — the only place effects happen.
export interface EffectRunner {
  run(command: Command, ctx: EffectCtx): Promise<Event[]>;
}
```

`reduce` must be total and must **ignore unknown `kind` values**, so a user who downgrades karvand does not corrupt a run. `decide` answers "given this state and this instant, what should happen next?" and returns commands — it never performs them. `EffectRunner` performs commands and returns the events they produced, which are appended and fed back through `reduce`.

Why this split is worth the discipline:

- **The whole scheduler is unit-testable with zero I/O.** Ready-set derivation, backoff jitter, semaphore admission, stall and churn detection, budget ceilings and patch policy are all pure functions over a plain object. No SQLite, no spawn, no clock.
- **Six hours costs microseconds.** With the `Clock` port injected, `harness.clock.advance(hours(6))` exercises a long human gate instantly. Contrast `vi.useFakeTimers()`, which must **never** be used while a child process is alive — the process's real I/O never arrives and you deadlock.
- **Crash tests become cheap.** `harness.crashAndRestart()` reopens the database, rebuilds state and asserts invariants. A real crash-fuzz job in CI SIGKILLs karvand at a random point and asserts no effect ran twice without its ikey being reused, that reduced state matches the pre-crash projection, and that `PRAGMA integrity_check` returns `ok`.
- **It satisfies NF9 by construction.** "Engine logic contains no nondeterminism outside adapter boundaries" is not a code-review convention here; it is enforced by the package boundary, because `@karvan/core` has no dependency that could perform I/O ([repo layout](./16-repo-layout.md#4-dependency-direction)).

The corollary is a hard rule: **anything nondeterministic goes through a port.** Time via `Clock`. Randomness via a seeded generator. Ids via an injected factory. If you find yourself importing `node:fs` into `@karvan/core`, the design has already broken.

---

## 9. Everything is a projection of the ledger

There is exactly one source of truth: an append-only event log in SQLite with a single global monotonic `seq` (F4.1, NF10).

| Surface | How it is derived |
|---|---|
| Backend run state | `reduce()` over `event WHERE run_id = ?`, optionally short-circuited by a checkpoint cache |
| The `PlanGraph`'s live state | Node states are reduced state; the plan *document* is an immutable content-hashed row referenced by `plan.proposed` / `plan.patched` |
| Plan history / the scrubber (F10.2) | Every plan version is a retained row; the scrubber walks `plan.*` events and diffs consecutive documents |
| Blackboard | Reduced from `fact.written` / `fact.read`; the memory graph (F10.4) is those events rendered as nodes and edges |
| Context budget view (F10.5) | `context.built` segment token counts plus `context.compacted` before/after and dropped handles |
| Acceptance-criteria board (F10.8) | `gate.evaluated` verdicts joined to criteria ids from the approved `TaskSpec` |
| Frontend store | A hand-rolled ledger-projection store on Pinia 4 (D11) applying the *same* event vocabulary the backend reducer applies |
| SSE transport | Frame `id` **is** the ledger `seq`; `Last-Event-ID` on reconnect replays from that offset, plus an explicit `GET /api/runs/:id/events?since=<seq>` hydrate path because browsers do not send `Last-Event-ID` if the connection never opened |
| Cost, quota, timeline | Reduced from `budget.consumed`, `node.started` / `node.completed` timestamps |

Three consequences worth stating explicitly:

- **`context.built`, `context.compacted`, `fact.written` and `fact.read` are product requirements, not logging.** They exist so that memory sharing is *renderable* — so you can draw an edge between two nodes and label it with precisely the facts that crossed it.
- **Pino logs are not the ledger.** Operator diagnostics go to `pino@10.3.1` with redaction configured from commit one; domain facts go to SQLite in the same transaction as the state they describe. Conflating them makes NF10 unprovable and tempts you to reconstruct state from log files.
- **Sequence gaps are expected.** Rolled-back transactions burn `AUTOINCREMENT` values, so the cursor contract is "resume from strictly greater than", never "expect `seq + 1`". `AUTOINCREMENT` itself is mandatory: with a plain `INTEGER PRIMARY KEY`, deleting the highest row causes the next insert to **reuse** its rowid, which would silently corrupt every persisted SSE cursor the moment you add run retention.

---

## 10. What Karvan deliberately does not do

From [PRD §14](./prd.md#14-explicitly-out-of-scope), with the architectural reason each exclusion holds:

| Not doing | Why |
|---|---|
| Building a coding agent | The vendors' harnesses improve faster than a solo project can match. Karvan is the layer above: planning, coordination, memory, verification, visibility ([PRD §2.2](./prd.md#22-non-problems-explicitly)). |
| Hosting or reselling model access | AR-1. Every request is made by the vendor's own first-party client. |
| Being an IDE or editor | Rejected in [PRD §6.2](./prd.md#62-options-considered): ties Karvan to one IDE and puts hours-long processes in an extension host. |
| Multi-tenant SaaS | AR-1 forces local execution. The team topology is per-engineer daemons plus a hub that sees only redacted events. |
| Holding, proxying or transporting a credential | AR-1, inviolable. Verifiable by inspection (NF2). |
| Auto-merging to protected branches | F5.5 — never write to the default branch, enforced mechanically in the git wrapper, which hard-refuses any `push`/`merge`/`branch -f` resolving to the default branch. |
| Building a sandbox | D12. The vendors already implement per-platform enforcement correctly; nesting sandboxes breaks the working one. |
| Deterministic workflow replay | D7. Karvan's control flow is data, so the one thing replay buys — reconstructing implicit control flow from code — is something Karvan does not need. |
| A general-purpose task runner or CI system | Gates shell out to the repo's own scripts. Karvan schedules and verifies; it does not reimplement `make`. |
| Embedding-based retrieval at M1 | D15 — SQLite FTS5 + BM25 only, until a semantic-recall miss is actually measured. |

---

## 11. Pitfalls

Verified footguns that touch the architecture as a whole. Area-specific ones live in their own documents.

- **Do not put agent stdout in the control-plane event table.** It is the single decision that would force you to build a snapshotting subsystem, which would then be the most bug-prone part of the system. Two tables: `event` (small, reduced) and `io_chunk` (huge, never read by the reducer).
- **Do not rely on vendor session resume for durability.** Copilot and Gemini do not advertise `session.resume` at all. Resume is a token-cost optimisation; the ledger is the durability mechanism.
- **Do not hardcode a capability matrix.** The probed matrix already differs from what the vendor docs imply, and it changes month to month. Persist `initialize` responses and read them.
- **Do not use `setTimeout` for waits longer than seconds.** Durable deadlines in `node_wake` collapse long gates, laptop sleep, restart and retry backoff into one mechanism.
- **Do not spawn agents without `detached: true`,** and do not then forget that they outlive karvand. Persist `{pid, pgid, startTime, binarySha256}` and reap on boot.
- **Do not trust `Last-Event-ID` alone.** Provide the explicit `?since=<seq>` hydrate endpoint; the header is only sent on automatic reconnect.
- **Do not let a domain failure be a thrown `Error`.** Failures are values in a closed discriminated union (`timeout`, `nonzero-exit`, `malformed-output`, `schema-violation`, `permission-refused`, `path-scope-violation`, `cancelled`, `budget-exceeded`, `provider-unavailable`) so every one is serialisable into the ledger and renderable in the node inspector (F10.3). Reserve `throw` for programmer bugs — and install a global `unhandledRejection` handler that writes `run.aborted` before exiting.
- **Do not add a second cancellation primitive.** `AbortSignal` is the only one: one signal per run, composed with `AbortSignal.any([runSignal, nodeTimeoutSignal])`, threaded into every spawn and every await point.
- **Do not assume vendor CLIs emit GenAI telemetry.** They do not — Claude Code emits a private `claude_code.*` namespace. Karvan emits `gen_ai.*` spans itself (D16), which corrects an assumption in [PRD §4.6](./prd.md#46-category-f--agent-observability).

---

**Related:** [Domain model](./04-domain-model.md) · [Durable execution](./05-durable-execution.md) · [Provider adapter layer](./07-provider-adapter-layer.md) · [Workspace and safety](./09-workspace-and-safety.md) · [Repo layout](./16-repo-layout.md)

[← Back to index](./README.md)
