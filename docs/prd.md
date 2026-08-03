# Karvan — Product Requirements Document

**A local-first, provider-neutral orchestrator for long-running, dynamically-planned AI engineering work.**

| | |
|---|---|
| **Working name** | Karvan (کاروان) — a caravan of agents on a long route, with visible stages and caravanserais (checkpoints). Alternatives: *Rahnema*, *Loom*, *Atelier*. |
| **Document status** | Draft v1.0 — for author's own build validation |
| **Date** | 2 August 2026 |
| **Author** | Meg |
| **Deliverable stage** | Personal tool → internal team tool |

---

## 1. TL;DR

Existing tools split into two camps that don't meet. **Session managers** (Conductor, Vibe Kanban, Nimbalyst, Claude Squad) give you a nice UI over many agents in git worktrees, but no real coordination — alignment, conflict resolution and merge decisions all fall back on you. **Workflow runners** (Open Dynamic Workflow, LangGraph, Temporal) give you structure, but no UI, no memory model, and — in ODW's case — a graph that is fixed at authoring time and a run that cannot survive a crash.

Karvan sits at the intersection of four properties that no current tool combines:

1. **Genuinely dynamic plans** — the execution graph is data, and it mutates at runtime through auditable patches, not a TypeScript file compiled once by an LLM up front.
2. **Durable long-horizon execution** — runs measured in hours or days, resumable after crash, restart, laptop sleep, or a provider outage.
3. **Provider neutrality via the user's own subscription** — Karvan never holds a model credential. It drives the vendor's own local binary (Claude Code, Codex, Gemini, Copilot, Cursor, OpenCode) which authenticates itself, as the user, on the user's machine.
4. **Visualization as a first-class product surface** — the plan graph, its evolution, every agent's exact input context, what flowed between agents, and how memory was compacted are all inspectable and replayable. This is treated as equal in weight to execution, not as a debug afterthought.

**Recommended interface:** a headless local daemon plus a browser UI served on localhost, with a thin desktop shell added later. Rationale in §6 — this is forced largely by the credential constraint in §5, not chosen for taste.

**Recommended integration protocol:** ACP-first (Agent Client Protocol), with per-CLI shim adapters as fallback. Rationale in §4.7.

---

## 2. Problem statement

### 2.1 What actually breaks today

Complex engineering tasks — a framework migration, a cross-cutting refactor, a spec-to-PR feature — need hours of agent work, dozens of steps, several models, and repeated verification. Four things break:

**The plan is fixed too early.** You write (or have an AI write) a workflow before the agent has seen the codebase. Step 3 discovers the codebase isn't what step 1 assumed. A static graph has no way to respond except fail.

**The run doesn't survive.** Long agent runs die from timeouts, rate limits, crashes, an OS update, a closed laptop lid. Most tools restart from zero, throwing away hours of work and money. Session memory is not durable execution — saving chat history doesn't prove which shell command ran or whether a retry duplicates a side effect.

**Nobody knows why it went wrong.** When a 40-step run produces a bad diff, the question is *which* step poisoned it and *what context* that step actually received. Tools log stdout. They don't show the assembled context packet, the memory that was shared, or what compaction deleted.

**You're locked to one vendor's plan.** Frameworks that call raw model APIs bill you per token even though you already pay for Claude Max, ChatGPT Plus, and a Copilot seat. Tools that use your subscription are locked to one vendor's harness.

### 2.2 Non-problems (explicitly)

Karvan is not trying to be a better coding agent. The vendors' harnesses are excellent and improving faster than any solo project can match. Karvan is the layer *above* them: planning, coordination, memory, verification, and visibility.

---

## 3. Research: Open Dynamic Workflow

Source: `github.com/travisliu/open-dynamic-workflow` (MIT, TypeScript, ~29 stars, 3 contributors, recently renamed from `@prmflow/openflow`).

### 3.1 What it gets right

| Strength | Why it matters |
|---|---|
| **Orchestrates vendor CLIs rather than reimplementing an agent** | The single most important architectural decision in the whole space. It sidesteps credential handling, inherits every harness improvement for free, and keeps the project's scope survivable. Karvan adopts this wholesale. |
| **Workflow-as-artifact** | Version-controlled, reviewable, reproducible. A named, diffable workflow beats ad-hoc prompting for repeated engineering work. |
| **Good primitive vocabulary** | `agent`, `parallel`, `pipeline`, `loop`, `tool`, child `workflow` — a well-chosen minimal set that covers single/parallel-review/pipeline/fan-out-fan-in/loop patterns. |
| **Artifacts always on** | Per-run directory with `manifest.json`, `calls.jsonl`, `events.jsonl`, per-agent `prompt.txt`/`stdout.log`/`raw-result.json`/`normalized-result.json`. Failed and partial runs stay debuggable. Excellent instinct. |
| **Structured output with schema validation** | `validation-error.json` per agent means downstream steps get machine-readable input or a clear failure. |
| **`validate` and `doctor` commands** | Catching a bad workflow before spending provider quota is the right economics. |
| **Honest about its permission model** | The docs state plainly that `dangerously-full-access` is *not* a sandbox and bypasses provider safety boundaries. Rare and commendable. |
| **Deterministic mock provider** | Makes CI runs and structural testing free. Karvan must have this too. |

### 3.2 Gaps and issues

| # | Gap | Detail | Severity for our use case |
|---|---|---|---|
| G1 | **"Dynamic" is a misnomer** | Dynamism is entirely at *authoring* time — an AI writes a TS file. Once written, the graph is frozen. There is no mechanism for a running workflow to add a step, split a task, or change provider based on what it learned. `loop()` with a `maxRounds` cap is the only runtime adaptivity. | **Critical** — this is the core of what we want |
| G2 | **No durable execution** | Artifacts are write-only debug output. There is no resume, no checkpoint replay, no idempotency keys, no exactly-once semantics for side effects. A crash at step 38 of 40 means re-running all 40 — and re-paying. | **Critical** |
| G3 | **No UI whatsoever** | CLI + JSONL. Our top-priority requirement is entirely absent. | **Critical** |
| G4 | **No memory model** | Context flows only as JSON return values between steps. No shared store, no provenance, no retrieval, no compaction, no context budget accounting. Long-horizon runs will hit context exhaustion with no strategy. | **Critical** |
| G5 | **No workspace isolation** | All providers run against the same working directory. Two `parallel()` write-capable agents will race on the same files and lockfiles. No git worktrees, no containers. | **High** |
| G6 | **Binary permission model** | `default` or `dangerously-full-access`. No middle tier (read-only / worktree-write / network / full). Because the mapping differs per provider, "default" means different things on `codex` vs `cursor` vs `pi`. | **High** |
| G7 | **Adapter brittleness** | Adapters are shell-argument shims (`codex exec --json --ephemeral`, `gemini --output-format json`). Codex CLI shipped 0.107→0.146 in roughly the span of a year with flag and output changes; Gemini's unpaid tier was migrated to a different CLI in June 2026. This layer will break constantly with no conformance testing. | **High** |
| G8 | **No cost or quota awareness** | No token accounting, no budget ceiling, no rate-limit backoff, no per-provider quota tracking. Nothing stops a `loop()` from burning a monthly allowance. | **High** |
| G9 | **No verification concept** | There is no `gate` primitive. "Did this actually work?" must be hand-coded inside a loop callback. No independent-validator pattern, no deterministic checks. | **High** |
| G10 | **No Claude Code adapter** | The provider table lists mock, codex, gemini, copilot, opencode, antigravity, pi, cursor — Claude Code is absent. | Medium |
| G11 | **No human-in-the-loop** | No pause/approve/inject primitive. A run is fire-and-forget. | Medium |
| G12 | **Structural constraints on composition** | Documented restriction that `tool()` may not be called inside `parallel()` or `pipeline()` stages — a leaky abstraction that pushes complexity onto the workflow author. | Medium |
| G13 | **Bus factor** | ~29 stars, 3 contributors, one rename already. Building a company workflow on it is a risk. | Medium |
| G14 | **Artifact leakage** | Docs warn that run directories may contain prompts, source snippets, stdout/stderr and model output. `security.redactEnv` covers env vars only — not the artifacts themselves. | Medium (blocks team sharing) |

### 3.3 Verdict

ODW is the right *shape* and the wrong *depth*. Its provider-adapter model and artifact discipline are worth adopting outright. Its execution model is a script runner where we need a durable, adaptive, observable engine.

---

## 4. Research: the wider landscape

### 4.1 Category A — Session managers over git worktrees

*Conductor, Vibe Kanban, Nimbalyst, Claude Squad, Crystal, Emdash, Baton, Composio Agent Orchestrator, Superset, Parallel Code, Sculptor, agentbox, amux, Paneflow.*

Git worktrees became load-bearing for AI coding in early 2026 — as soon as two agents edit one repo for more than a few minutes, a single working directory stops working. By April 2026 nearly every major tool shipped worktree support, and a category of GUI managers grew around them.

**Strengths:** excellent parallel-session UX, strong diff/review surfaces, PR flows, kanban boards, some with container isolation (Sculptor) or remote execution (Mux, Superset).

**Gaps:** they are session managers, not workflow engines. Reviews of the category converge on the same finding — every tool solves parallel execution through worktrees, but coordination depth varies sharply and most leave task alignment, conflict resolution and merge decisions to the human. None of them plan. None share memory between sessions. None visualize a graph, because there is no graph.

**Notable specifics for us:**
- Conductor is macOS-only.
- Vibe Kanban's parent company (Bloop) shut down in April 2026; it continues as community-maintained Apache-2.0. Evaluate as a local OSS tool, not a supported SaaS.
- Its architecture — CLI + web UI, cross-platform, agent-agnostic, self-hostable — is the closest existing validation of our recommended interface shape.
- A hard practical lesson from this category: git refuses to check out the same branch twice, so unique per-session branch names (`session/<sha>`) or detached HEAD are mandatory. Hand-rolled worktree scripts routinely fail silently on this.

### 4.2 Category B — Workflow/DSL runners

*Open Dynamic Workflow (§3), plus lightweight loop runners (wreckit / "Ralph Wiggum loop"), swarm-protocol (MCP-based claim/conflict/handoff coordination), subtask.*

**Strengths:** explicit, reproducible, version-controlled. **Gaps:** no UI, static graphs, no durability, no memory model.

### 4.3 Category C — General agent frameworks

*LangGraph 1.0, CrewAI, AutoGen/AG2, Mastra, OpenAI Agents SDK, Dapr Agents, Microsoft Agent Framework, Letta.*

**Strengths:** mature graph primitives; LangGraph has real checkpointer backends (Postgres, Redis, DynamoDB) for step-level recovery. The OpenAI Agents SDK has `nest_handoff_history` (collapse prior transcripts into summaries rather than passing raw history) and agents-as-tools. Letta gives each agent its own memory blocks with explicit message passing rather than shared context. These are good design references for §7.6.

**Gaps, and they are disqualifying for our brief:**
- They are libraries for building agents **from raw model APIs**. That means per-token API billing, which directly contradicts "use whatever the user is subscribed to."
- They don't own a repo-aware coding harness — you'd be reimplementing file editing, sandboxing, and tool loops that Claude Code and Codex already do better.
- Their persistence guarantees vary widely: some persist conversation state, some graph state, few provide full durable execution across side effects.

### 4.4 Category D — Durable execution engines

*Temporal, Restate, Inngest, DBOS, Hatchet, Cloudflare Workflows, AWS Lambda Durable Functions, Azure Durable Task.*

**Strengths:** this is the state of the art for the resume problem. The shared idea is to persist completed execution boundaries and recover after crashes without repeating tool calls, external mutations, human approvals or outbound messages. Idempotency keys derived from `(workflow_id, step_id, attempt)` are the standard pattern. DBOS is notable for requiring zero new infrastructure — Postgres or SQLite, in-process.

**Gaps:** heavy for a single-user local tool; replay-safety imposes real constraints on workflow code (no nondeterminism, explicit versioning); no LLM or coding semantics; and their UIs are operator dashboards, not agent-work surfaces.

**Decision:** borrow the *pattern*, not the *dependency*. Karvan implements event-sourced durability over embedded SQLite (§9.3). Reconsider Temporal/Restate only if we move execution server-side, which §5 argues against.

### 4.5 Category E — Spec-driven development

*Kiro, GitHub Spec Kit, OpenSpec, BMAD-METHOD, SpecShip, CodeMySpec.*

Every major SDD framework converges on the same four-phase loop: spec → design → tasks → implementation, with EARS-notation acceptance criteria as the testable contract. This is the answer to "how do we know the requested outcome was achieved."

**Best ideas to steal:**
- **Acceptance criteria + failure modes defined before any code**, stored as artifacts; validators judge against the contract rather than vibes.
- **The author cannot be the judge.** Independent validators with their own methodology produce typed verdicts with evidence.
- **Surgical fix loops** — a fresh agent fixes one issue at a time, regression test first, capped at ~3 cycles.
- **Hard build gates** — no milestone advances until typecheck + tests + build pass.

**Documented failure modes to design against:** shallow specs; false precision from EARS notation; spec-then-drift, where the spec launches the session and the code silently becomes the source of truth again the moment generation starts; and gates that exist but aren't treated as real gates.

**Cautionary tale:** in December 2025 a Kiro agent deleted a live AWS production environment, causing a 13-hour outage. The reviewed-specs-and-approved-designs governance model covered the design phase but not the *execution boundary* — the moment an agent acts on real infrastructure with real permissions. This directly motivates §7.9.

### 4.6 Category F — Agent observability

*OpenTelemetry GenAI semantic conventions, Langfuse, Arize Phoenix, LangSmith, Braintrust, Helicone.*

The `gen_ai.*` namespace is now the default substrate for LLM observability, covering LLM client spans, agent spans, workflow and tool spans, events for prompt/completion content, and token/latency metrics. As of v1.41 the spec defines agent, workflow, tool and model spans plus required latency and token-usage metrics. Copilot, Codex and Claude Code emit GenAI-convention telemetry natively, so their runs are readable in any OTLP backend. Langfuse and Phoenix can be self-hosted and ingest OTLP directly.

**Caveat:** most `gen_ai.*` attributes still carry Development stability badges — names can change without a major version bump.

**Gaps for us:** these are *trace viewers*. They render a tree of spans after the fact. They cannot show a plan graph, cannot show plan evolution, cannot show what a context packet contained versus what was compacted away, and you cannot intervene in a run from them.

**Decision:** emit OTel GenAI-compliant spans so Karvan runs are readable in Langfuse/Phoenix/Datadog for free, but build our own purpose-built visualization for the things OTel structurally cannot express (§7.10).

### 4.7 Category G — Interop protocols

- **MCP** — tools. Already universal. Karvan should be an MCP host so workflow-level tools are available to every agent regardless of vendor.
- **ACP (Agent Client Protocol)** — the important one. Zed + JetBrains open standard, Apache-2.0, JSON-RPC 2.0 over stdin/stdout. An editor launches an agent as a subprocess and gets **sessions, streaming progress updates, permission-gated tool execution, and client-provided filesystem and terminal access**. Explicitly modeled on LSP: turns N×M agent-editor integrations into N+M. 25+ agents supported as of March 2026; public agent registry live in JetBrains IDEs and Zed since January 2026, listing Codex CLI alongside Claude Code, Gemini CLI and Copilot CLI. Cursor joined the registry in March 2026.
- **A2A** — agent-to-agent. Governed alongside MCP by the Linux Foundation's Agentic AI Foundation. Not needed for v1; relevant if Karvan ever exposes itself as a callable agent.

**This is the single most valuable finding of the research.** ODW's weakest layer (G7: bespoke shell shims per CLI) has a standard solution. If Karvan implements ACP *as a client* — playing the role an editor plays — it gets streaming, permission negotiation, and session semantics from every ACP-speaking agent through one integration, and it stops chasing per-CLI flag churn.

Risk to track: no first-party VS Code/Microsoft adoption yet. Microsoft adopting ACP would settle the standard; Microsoft shipping a competitor would fragment it. Hence ACP-first but not ACP-only.

### 4.8 Competitive positioning

| | Dynamic re-plan | Durable resume | Provider-neutral via subscription | Memory model | Graph & context visualization |
|---|---|---|---|---|---|
| Claude Code / Codex alone | Partial (in-context) | No | No (single vendor) | Compaction only | No |
| Open Dynamic Workflow | No | No | Yes | No | No |
| Conductor / Vibe Kanban / Nimbalyst | No | Partial (session) | Partial | No | No (board, not graph) |
| LangGraph / CrewAI / Mastra | Partial | Yes | No (API keys) | Partial | No |
| Temporal / Restate / DBOS | No | Yes | N/A | No | Operator view only |
| Kiro / Spec Kit / SpecShip | No | No | No | No | No |
| Langfuse / Phoenix | N/A | N/A | N/A | N/A | Trace tree only |
| **Karvan** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

Every cell in the Karvan row exists somewhere. No row combines them.

---

## 5. The provider-neutrality constraint (read this before anything else)

Your requirement — *"support whatever AI provider the user is subscribed to"* — is the hardest constraint in this document, and it is a **legal and policy** constraint before it is a technical one. It determines the architecture and the interface.

### 5.1 What the research found

**Anthropic.** On 19 February 2026 Anthropic published updated Legal and Compliance documentation adding an explicit Authentication and Credential Use policy: OAuth credentials from Free, Pro and Max plans are intended exclusively for Claude Code and claude.ai, and using them in any other product, tool or service violates the Consumer Terms. Third-party developers may not offer Claude.ai login or route requests on behalf of users using Free/Pro/Max credentials. The Agent SDK was stated to require API-key authentication.

Then it moved again. A monthly Agent SDK credit for Pro/Max/Team/Enterprise was announced for 15 June 2026, explicitly covering *third-party apps that authenticate with your Claude subscription through the Agent SDK*. On 15 June, Anthropic **paused** that change. The current published position: Agent SDK, `claude -p`, and third-party app usage still draw from subscription usage limits, the announced credit is not available, and they are "working to update the plan to better support how users build with Claude subscriptions."

Meanwhile there are credible reports of client fingerprinting and account actions against third-party harnesses bridging subscription auth.

**Other vendors.** Codex CLI requires an eligible Plus/Pro/Business/Enterprise/Edu/Go subscription or API key, and supports browser OAuth, device-code flow for headless environments, and API keys. Gemini CLI moved unpaid-tier and Google One users to Antigravity CLI on 18 June 2026, and individual Google accounts no longer authenticate against the paid Code Assist path. Copilot CLI requires a Copilot subscription.

### 5.2 What this means

**The policy surface is volatile and vendor-specific, and it will change again during this project's lifetime.** Any design that has Karvan hold, transport, refresh, or proxy a provider credential is legally exposed, operationally fragile, and will get you and your colleagues' accounts flagged.

### 5.3 The architectural rule this produces

> **AR-1 (inviolable): Karvan never possesses a model credential.**
>
> Karvan launches the vendor's own official binary as a child process, on the user's own machine, under the user's own OS account, using the credentials that binary already stored for itself. Karvan reads no token file, sets no auth environment variable, and transmits no credential anywhere. Every request is made by the vendor's own first-party client, which is exactly the usage each vendor's terms contemplate.

Three consequences follow directly, and they are not negotiable:

1. **Execution must be local.** Not a SaaS backend. This forces the interface decision in §6.
2. **Provider access is a capability discovered at runtime, not a configuration.** Karvan probes which agent binaries are installed and authenticated (`doctor`-style) and plans only against what's actually available.
3. **API keys stay a first-class alternative, not the default.** If a user chooses to supply a key (their own, or a company key at Voyado), Karvan uses it for that provider. `ANTHROPIC_API_KEY` present in the environment silently shadows subscription auth in Claude Code — Karvan must detect and surface this explicitly, because the failure mode is "you thought you were on your subscription and you were being billed."

### 5.4 Team-phase consequence

When this goes to Voyado, **runs still execute on each engineer's machine with their own seat credentials.** The team server (§9.5) aggregates events, artifacts and shared workflows — never credentials, never model traffic. This is both the compliant design and by far the cheaper one.

---

## 6. Interface decision

### 6.1 Requirements that constrain the choice

| # | Requirement | Implication |
|---|---|---|
| I1 | Must launch vendor CLIs with local credentials (AR-1) | Local execution. Rules out pure web SaaS. |
| I2 | Runs last hours; must survive closing the window | The engine cannot live in the UI process. Headless daemon required. |
| I3 | Rich visualization: graph, timeline, diffs, context inspector, memory graph | Web technologies. Rules out TUI-only. |
| I4 | Must be observable while away from the machine | Network-addressable UI, mobile-viewable. |
| I5 | Must go to colleagues later without a distribution pipeline | Something installable in one command; self-hostable. |
| I6 | Built solo, alongside a job and a degree | Minimize packaging, signing, and platform surface. |
| I7 | Author's stack: TypeScript, Vue 3, React, Node | Node engine + web frontend. No Rust/Swift requirement on the critical path. |

### 6.2 Options considered

| Option | Verdict |
|---|---|
| **VS Code / JetBrains extension** | Rejected. Ties us to one IDE — directly against the brief. Extension host is a bad place for hours-long processes. Constrained visualization surface. |
| **TUI** | Rejected as primary. Fails I3 and I4 hard. Worth a thin `karvan` CLI for scripting and CI (I5), not as the main surface. |
| **Native desktop app (Electron/Tauri) as primary** | Rejected *for v1*. Packaging, signing, notarization, and auto-update cost weeks that buy nothing during solo use. Also naturally tempts you to put the engine in the app process, violating I2. |
| **Cloud web app** | Rejected. Violates AR-1 and I1 outright. |
| **Headless local daemon + localhost web UI** | **Selected.** |

### 6.3 The decision

> **Ship a headless local daemon (`karvand`) that serves a web UI on localhost. Add a desktop shell in M3, not before.**

```
npx karvan init          # detect providers, create .karvan/
npx karvan up            # start daemon → http://localhost:7777
npx karvan run "…"       # CLI entry, same engine
```

**Why this wins:**

- The daemon owns execution. Close the browser, close the laptop lid, reboot — the run resumes (§7.4). This is the property most tools lack.
- The UI is a client, so *many* clients are possible: browser tab, phone on the same Wi-Fi, later a desktop shell, later a Slack notifier. All the same event stream.
- Zero packaging cost in the phase where you're the only user.
- Team rollout is `npx karvan up` per engineer plus an optional shared hub. No app store, no MDM, no signing.
- Vibe Kanban's CLI-plus-web-UI shape is the closest existing precedent and it is cross-platform and self-hostable — evidence the shape works.

**Desktop shell (M3, optional):** wrap the same localhost UI. Buys native notifications ("gate failed, needs approval"), a menu-bar/tray run indicator, deep links, OS file dialogs, and a login item so the daemon starts automatically. **Tauri 2** over Electron — a smaller binary, and since all the Node work lives in the daemon sidecar, the Rust surface stays thin. Frontend stays Vue 3 either way.

**Frontend framework:** Vue 3 + TypeScript + Vite. Your strongest stack, and the visualization work (§7.10) is where the hard effort should go, not on framework ramp-up. Graph rendering: `@vue-flow/core` for the interactive plan graph; `d3` for timeline/Gantt and context-budget charts; `xterm.js` for live agent terminal streams; `shiki` + a diff view for code review.

---

## 7. Functional requirements

Priority: **P0** = required for personal use (M1). **P1** = required before showing colleagues (M2). **P2** = team scale (M3+).

### 7.1 Task intake and framing

- **F1.1 (P0)** Accept a task as free text, a file, a git issue reference, or a spec document.
- **F1.2 (P0)** **Framing interview.** Before planning, a framing agent interrogates the task and the repo and produces a `TaskSpec`: goal, scope boundaries, non-goals, constraints, prior decisions, **acceptance criteria**, and **known failure modes**. Acceptance criteria are written as testable statements; where possible each maps to an executable check.
- **F1.3 (P0)** The `TaskSpec` is presented for human edit and explicit approval before any execution. This is a real gate, not a formality — the SDD literature is unambiguous that shallow specs are the primary failure mode.
- **F1.4 (P1)** Spec templates per task archetype (migration, feature, bug hunt, refactor, dependency upgrade, test backfill, incident postmortem).
- **F1.5 (P1)** **Anti-drift**: the `TaskSpec` is pinned (§7.6) and re-injected verbatim into every agent's context. Gates evaluate against the spec, not against the current state of the code.

### 7.2 Dynamic planning

- **F2.1 (P0)** **The plan is data, not code.** A versioned JSON graph (`PlanGraph`), not a TypeScript file. Diffable, patchable, serializable, renderable. This is the central departure from ODW.
- **F2.2 (P0)** A **planner agent** compiles `TaskSpec` + repo reconnaissance + available-provider capability list into a `PlanGraph` v1.
- **F2.3 (P0)** Node types:
  | Type | Purpose |
  |---|---|
  | `agent` | Delegate to a provider agent session with a scoped brief |
  | `tool` | Deterministic local execution (script, MCP tool, HTTP) |
  | `gate` | Verification; emits pass/fail with evidence (§7.7) |
  | `human` | Blocks for review, approval, or input |
  | `map` | Fan out over a collection with bounded concurrency |
  | `loop` | Bounded iteration with a goal predicate |
  | `subgraph` | Reusable composed plan |
- **F2.4 (P0)** **Runtime plan mutation.** Any node may emit a `PlanPatch` proposing: insert nodes, split a node, replace a node's provider, extend a loop's budget, or mark a branch abandoned. This is what makes the workflow genuinely dynamic.
- **F2.5 (P0)** **Patch policy engine.** Each patch is auto-applied, queued for approval, or rejected, based on declarative rules: cost delta, blast radius (files/paths touched), depth from original plan, elapsed budget, and whether it escalates permissions. Default: auto-apply patches that add read-only analysis; require approval for anything that adds write capability, adds cost above a threshold, or exceeds replan depth 3.
- **F2.6 (P0)** **Every plan version is retained.** The UI can scrub plan evolution over time (§7.10). "Why is there a step here that I didn't ask for?" must be answerable in one click.
- **F2.7 (P1)** Planner selects providers per node by declared strengths, cost, current quota headroom, and past measured success on similar node types — not by a hardcoded default.
- **F2.8 (P1)** Plan templates: promote a successful run's plan into a reusable parameterized template.
- **F2.9 (P2)** Learned planning: nudge planner priors from the run history in the local store.

### 7.3 Provider and agent adapter layer

- **F3.1 (P0)** **ACP-first.** Karvan is an ACP *client*. Any ACP-speaking agent works through one integration path with sessions, streaming updates, and permission negotiation.
- **F3.2 (P0)** **CLI shim fallback** for non-ACP agents, in ODW's style (`claude -p`, `codex exec`, `gemini -p`, `copilot -p`, `opencode run`, `aider --message`, `goose run`, `cursor-agent`, `qwen -p`).
- **F3.3 (P0)** **Direct API adapter** when the user supplies their own key (Anthropic, OpenAI, Google, OpenRouter, Bedrock, Vertex, and local Ollama/vLLM for offline work).
- **F3.4 (P0)** **Adapter conformance suite.** Every adapter must pass a fixed battery: structured output, streaming, permission refusal, timeout, cancellation, non-zero exit, malformed output, token accounting. Run against installed CLI versions on `karvan doctor`. This is the antidote to G7 — flag churn is detected by us, not by a user's failed 3-hour run.
- **F3.5 (P0)** **Capability manifest per adapter**, declaring what it does and does not support: structured output, streaming, image input, MCP, resumable sessions, permission granularity, max context. Planner must not schedule a node onto an adapter that can't honour its requirements.
- **F3.6 (P0)** Pin and record the exact CLI version per run in the manifest. Warn on drift between runs.
- **F3.7 (P0)** **Mock provider** — deterministic, free, for structural testing and CI.
- **F3.8 (P1)** Explicit auth-shadowing detection: warn loudly when `ANTHROPIC_API_KEY` or similar is present and will override subscription auth (§5.3).
- **F3.9 (P1)** Per-provider quota/rate-limit tracking with backoff, and automatic node re-routing to a healthy provider when one is exhausted — recorded as a `PlanPatch` so it shows in the visualization.

### 7.4 Durable execution

- **F4.1 (P0)** **Event-sourced ledger.** Every state transition is an immutable appended event. The `PlanGraph` state, the blackboard, and the UI are all projections of the ledger. There is exactly one source of truth.
- **F4.2 (P0)** **Resume after crash.** Restarting the daemon replays the ledger and continues from the last completed boundary. Completed nodes are never re-executed.
- **F4.3 (P0)** **Idempotency keys** derived from `(run_id, node_id, attempt)` for every side-effecting operation. Agent invocations, shell commands, git operations and file writes carry them.
- **F4.4 (P0)** **Pause / resume / cancel** at any point, from UI or CLI, without losing state.
- **F4.5 (P0)** **Node-level retry policy**: max attempts, backoff, and optional "retry with a different provider."
- **F4.6 (P0)** **Budget ceilings** — per run and per node, in both currency and wall-clock. Hitting a ceiling pauses the run for human decision rather than failing it.
- **F4.7 (P0)** **No-progress detection.** Halt a loop when successive rounds produce near-identical diffs, or the same failing test signature repeats N times, even if `maxRounds` is not exhausted. This is the single most expensive failure mode in autonomous loops.
- **F4.8 (P1)** **Long suspension**: a run may sleep for hours waiting on a human gate or a CI result without consuming resources.
- **F4.9 (P1)** **Deterministic replay** of a completed run from the ledger for debugging, with providers stubbed from recorded outputs.

### 7.5 Workspace isolation and safety

- **F5.1 (P0)** **Git worktree per write-capable branch of the plan.** Unique branch naming (`karvan/<run-id>/<node-id>`) — never reuse a branch name, because git will not check the same branch out twice.
- **F5.2 (P0)** **Serialize writes, parallelize reads.** Default policy: analysis, review and planning nodes run in parallel; write nodes touching overlapping path sets are serialized. Parallelizing write-heavy code generation produces conflicting decisions and incompatible outputs — the coordination cost exceeds the speedup.
- **F5.3 (P0)** **Path-scope declarations.** A write node declares the paths it may modify. Violations are detected on completion and surfaced as a gate failure.
- **F5.4 (P0)** **Graduated permission ladder**, not a binary:
  | Level | Meaning |
  |---|---|
  | `read` | No writes, no network, no shell mutations |
  | `worktree` | Writes confined to its own worktree |
  | `worktree+net` | Adds network (package installs, doc fetches) |
  | `full` | Everything the provider allows — explicit per-run opt-in, never a default |
  Where a provider cannot express the requested level, Karvan **refuses to schedule** rather than silently escalating. ODW's binary model is a documented hazard; we should not repeat it.
- **F5.5 (P0)** **Never write to the default branch.** All output lands as a branch or PR. Always.
- **F5.6 (P0)** **The execution boundary is guarded.** No node may touch infrastructure, deploy, run migrations against non-local databases, or execute destructive commands without an explicit human gate. The Kiro/AWS incident (§4.5) is the reference failure: approved specs and reviewed designs did not prevent an agent from deleting a production environment, because nothing reviewed the moment of action.
- **F5.7 (P0)** **Kill switch.** One control stops every child process in a run immediately.
- **F5.8 (P1)** **Container isolation** (Docker/devcontainer) as an opt-in per run for higher-risk work.
- **F5.9 (P1)** **Secret redaction on artifacts**, not just env vars — scan prompts, stdout, stderr and model output before anything is exported, shared, or synced to a team hub. ODW's docs warn about this exposure; we should solve it.

### 7.6 Memory and context architecture

This is the layer that makes long-horizon work possible, and — because you want it visible — it must be *designed to be rendered*, not just to function.

**Four tiers, explicit and separate:**

| Tier | Contents | Persistence |
|---|---|---|
| **T1 Run Ledger** | Every event, immutable, ordered | Forever (per run) |
| **T2 Blackboard** | Typed shared facts and artifact handles with provenance | Run lifetime |
| **T3 Context Packet** | Exactly what a single node's agent received | Per node invocation |
| **T4 Workspace** | Git worktree, files, build outputs | Per branch |

- **F6.1 (P0)** **No implicit context inheritance.** A node receives what the engine constructs for it and nothing else. This is the design that makes sharing auditable — you can render an edge and label it with precisely the facts that crossed it.
- **F6.2 (P0)** **Declared reads and writes.** Each node declares typed `reads` (blackboard keys, artifact handles, spec sections) and `writes`. The engine assembles the packet from the declarations. Undeclared reads fail validation at plan time.
- **F6.3 (P0)** **Provenance on every fact.** Which node wrote it, from which evidence, at which time, at what confidence. Facts that later prove wrong can be invalidated and every downstream consumer flagged.
- **F6.4 (P0)** **Subagent isolation with condensed returns.** Delegated work runs in a fresh context and returns a bounded structured summary rather than a raw transcript. Anthropic's multi-agent research system uses isolated subagent contexts returning 1,000–2,000 token summaries; token usage explains most of the performance variance in these architectures. Our default return budget: 500–2,000 tokens, enforced.
- **F6.5 (P0)** **Artifact offloading.** Build logs, full diffs, test output and large files are written to disk and referenced by handle. Only summaries plus handles enter context. Any agent can pull the full artifact on demand through a tool.
- **F6.6 (P0)** **Compaction with constraint pinning.** Compaction is the primary lever for long-horizon runs and it is also dangerous: recent work shows that compaction *actively deletes* governance constraints from context, causing unsafe tool calls — distinct from ordinary long-context attention dilution. Therefore:
  - A **pinned set** — `TaskSpec`, acceptance criteria, safety constraints, path scopes, permission level — is **never compacted** and is re-injected verbatim on every packet.
  - Compaction triggers proactively at a configured budget fraction, not at exhaustion.
  - **Every compaction is an event**: before/after token counts, what was summarized, what was dropped, with handles to the full original. Rendered in the UI (§7.10).
- **F6.7 (P1)** **Semantic retrieval** over the run's own artifacts and prior runs, so a node can pull relevant history without carrying it.
- **F6.8 (P1)** **Cross-run project memory** — durable, curated facts about a repository (architecture decisions, conventions, known traps) that survive between runs, with explicit human curation. Never auto-promoted without review.
- **F6.9 (P1)** **Handoff contracts as schemas.** Node output is validated against a JSON Schema before it enters the blackboard. Validation failure is a node failure with a repair attempt, not silent propagation of garbage.

### 7.7 Verification gates

- **F7.1 (P0)** **Deterministic gates first.** Typecheck, lint, unit tests, integration tests, build, custom scripts. Cheap, unambiguous, and not subject to model opinion. A milestone does not advance until they pass.
- **F7.2 (P0)** **Independent adversarial review.** A review gate must run on a *different session, and preferably a different provider*, than the node that produced the work. The producing agent cannot judge its own output — this is the strongest single quality lever in the SDD literature.
- **F7.3 (P0)** **Typed verdicts with evidence.** A gate returns `pass | fail | needs-human` plus structured findings with file/line references. Never a prose blob.
- **F7.4 (P0)** **Acceptance-criteria traceability.** Every criterion in the `TaskSpec` maps to at least one gate. The UI shows the criteria checklist and which are currently satisfied — this is the literal answer to "has the requested outcome been achieved."
- **F7.5 (P0)** **Surgical repair loop.** A gate failure spawns a fresh, narrowly-scoped fix node: one issue, regression test first, capped attempts (default 3), then escalate to human.
- **F7.6 (P1)** Custom gate definitions per repo, discovered from `.karvan/gates/`.
- **F7.7 (P1)** Gate results attached to the diff view, so review shows code and verdict together.

### 7.8 Human-in-the-loop

- **F8.1 (P0)** **Blocking `human` nodes** — approve, reject, edit, or inject guidance. Runs suspend cheaply while waiting (F4.8).
- **F8.2 (P0)** **Interject at any time.** A running node can be paused and given a correction without discarding the run.
- **F8.3 (P0)** **Approval queue** — one surface listing everything waiting on you across all runs.
- **F8.4 (P1)** Notifications: desktop, and optionally Slack/email, when a run needs you or completes.
- **F8.5 (P1)** **Steering without stopping** — append guidance to a running node's next turn where the adapter supports it.

### 7.9 Cost and quota governance

- **F9.1 (P0)** Per-node, per-provider, per-run token and cost accounting, live.
- **F9.2 (P0)** Hard ceilings that pause rather than fail (F4.6).
- **F9.3 (P0)** Pre-flight estimate before a run starts, and before an expensive `PlanPatch` is applied.
- **F9.4 (P1)** Subscription quota headroom tracking per provider, feeding the planner's routing decisions.
- **F9.5 (P1)** Cost-per-completed-task reporting across runs — the metric that tells you whether this whole thing is worth it.

### 7.10 Visualization and observability

**Treated as a primary product surface with equal weight to execution.** These are the screens that make the difference between "an agent did something" and "I understand what happened."

- **F10.1 (P0) Live plan graph.** Interactive DAG. Node states (pending / running / blocked / passed / failed / abandoned / awaiting-human) by colour and shape. Live streaming status per node. Edges labelled with what flows across them.
- **F10.2 (P0) Plan evolution scrubber.** A timeline of `PlanGraph` versions. Drag back to see the original plan; step forward through every patch with a rendered diff and the reason the patch was proposed. **This is the marquee feature.** No competing tool has it, and it is the direct visual expression of "dynamic workflow."
- **F10.3 (P0) Node inspector.** For any node: the exact assembled context packet (with a token breakdown by segment), the exact prompt, the raw output, the normalized/validated output, provider + model + CLI version, permission level, duration, cost, retries, and the worktree path.
- **F10.4 (P0) Memory & data-flow view.** A second graph over the blackboard: facts as nodes, reads and writes as edges. Click a fact to see provenance and every consumer. This is the direct answer to *"how memory and context is shared."*
- **F10.5 (P0) Context budget visualization.** Per node invocation, a stacked bar: pinned constraints / spec / retrieved facts / tool output / history. Compaction events marked inline showing tokens before → after and what was dropped, with a link to the full original.
- **F10.6 (P0) Live agent streams.** Per-node terminal output (`xterm.js`), tailable while running.
- **F10.7 (P0) Diff & review surface.** Per-node diff, per-worktree diff, cumulative run diff, with gate verdicts attached inline.
- **F10.8 (P0) Acceptance criteria board.** The checklist from `TaskSpec` with live satisfied/unsatisfied/unverifiable status and the gate evidence behind each.
- **F10.9 (P0) Run timeline.** Gantt of parallel agents against wall-clock, with cost overlaid. Makes parallelism, stalls and cost concentration obvious at a glance.
- **F10.10 (P1) Run replay.** Scrub any completed run from the ledger and watch it unfold.
- **F10.11 (P1) Cross-run dashboard.** Success rate, cost per task, gate first-pass rate, replan frequency, provider reliability.
- **F10.12 (P1) OTel export.** Emit `gen_ai.*`-compliant spans over OTLP so runs are also readable in Langfuse, Phoenix or Datadog. Pin the semconv version and dual-emit during transitions, since the attributes remain unstable.
- **F10.13 (P2) Shareable run report** — a single static HTML export of a run for a PR description or a colleague, with secrets redacted (F5.9).

---

## 8. Non-functional requirements

| # | Requirement |
|---|---|
| NF1 | **Local-first.** Full functionality with no network beyond what the provider CLIs themselves need. |
| NF2 | **Zero credential handling** (AR-1). Verifiable by inspection. |
| NF3 | **Cold start < 3s** for the daemon; UI interactive < 1s on localhost. |
| NF4 | **Run state survives** daemon restart, OS restart, and laptop sleep. |
| NF5 | **Cross-platform**: macOS and Linux at M1; Windows (incl. WSL) by M3. Not Mac-only — that is Conductor's main limitation. |
| NF6 | **Single-binary-ish install**: `npx karvan up`. No database server, no Docker requirement for the core. |
| NF7 | **Graceful provider degradation.** One provider unavailable degrades the plan; it does not kill the run. |
| NF8 | **Every artifact inspectable on disk** in an open format. No lock-in; ODW's artifact discipline as a floor, not a ceiling. |
| NF9 | **Deterministic core.** Engine logic contains no nondeterminism outside adapter boundaries — required for replay. |
| NF10 | **Auditable.** Any state in the UI is traceable to specific ledger events. |

---

## 9. Architecture

### 9.1 Shape

```
┌──────────────────────────────────────────────────────────┐
│  Clients                                                 │
│  Browser UI (Vue 3)  ·  CLI  ·  Desktop shell (M3)       │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP + SSE/WebSocket (localhost)
┌────────────────────────┴─────────────────────────────────┐
│  karvand — local daemon (Node/TS)                        │
│                                                          │
│  API + event stream                                      │
│  ├─ Orchestrator     scheduling, concurrency, retries    │
│  ├─ Planner          TaskSpec → PlanGraph, patch policy  │
│  ├─ Context Builder  packet assembly, compaction, pins   │
│  ├─ Blackboard       typed facts + provenance            │
│  ├─ Gate Runner      deterministic checks + reviewers    │
│  ├─ Workspace Mgr    worktrees, branches, path scopes    │
│  ├─ Ledger           event store (SQLite, append-only)   │
│  ├─ Artifact Store   filesystem, content-addressed       │
│  ├─ MCP Host         workflow-level tools                │
│  └─ Adapter Layer    ACP client │ CLI shims │ API SDKs   │
└────────────────────────┬─────────────────────────────────┘
                         │ child processes, user's own auth
        ┌────────────────┴─────────────────┐
        │  Claude Code · Codex · Gemini    │
        │  Copilot · Cursor · OpenCode …   │
        └──────────────────────────────────┘
```

### 9.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Daemon | Node 22+ / TypeScript | Author's stack; best child-process, PTY and CLI-ecosystem story |
| Store | SQLite (better-sqlite3 or libSQL) | Zero infra (NF6); WAL gives durability; DBOS demonstrates the pattern |
| Transport | HTTP + SSE (WebSocket only if bidirectional need emerges) | SSE with `Last-Event-ID` gives free resumable streams against ledger offsets |
| Process control | `node-pty` | Real TTY for CLIs that need one; clean cancellation |
| Frontend | Vue 3 + Vite + TS | Author's strongest stack |
| Graph | `@vue-flow/core` | Interactive DAG with custom node components |
| Charts | `d3` | Timeline, Gantt, context-budget stacks |
| Terminal | `xterm.js` | Live agent streams |
| Diff | `shiki` + diff view | Review surface |
| Telemetry | OpenTelemetry SDK, `gen_ai.*` semconv | Interop with Langfuse/Phoenix/Datadog |

### 9.3 Ledger event model (sketch)

```ts
type Event =
  | { t: 'run.created';     spec: TaskSpec }
  | { t: 'plan.proposed';   version: number; graph: PlanGraph; by: NodeId | 'planner' }
  | { t: 'plan.patched';    version: number; patch: PlanPatch; reason: string;
                            decision: 'auto' | 'approved' | 'rejected' }
  | { t: 'node.scheduled';  node: NodeId; provider: ProviderId; permission: Level }
  | { t: 'context.built';   node: NodeId; packet: PacketManifest }  // segments + tokens
  | { t: 'context.compacted'; node: NodeId; before: number; after: number;
                            droppedHandles: Handle[]; pinnedKept: string[] }
  | { t: 'node.started' | 'node.output' | 'node.completed' | 'node.failed'; … }
  | { t: 'fact.written';    key: string; by: NodeId; provenance: Provenance }
  | { t: 'fact.read';       key: string; by: NodeId }
  | { t: 'gate.evaluated';  gate: GateId; verdict: Verdict; evidence: Finding[] }
  | { t: 'human.requested' | 'human.responded'; … }
  | { t: 'budget.consumed'; provider: ProviderId; tokens: TokenUsage; cost: number }
  | { t: 'run.paused' | 'run.resumed' | 'run.completed' | 'run.aborted'; … }
```

Every UI view in §7.10 is a projection of this stream. `context.built`, `context.compacted`, `fact.written` and `fact.read` exist specifically to make memory sharing *renderable* — they are product requirements, not logging.

### 9.4 Repo layout

```
.karvan/
  config.yaml            providers, budgets, gates, policy
  gates/                 custom gate definitions
  templates/             reusable plans
  memory/                curated cross-run project memory
  runs/<runId>/
    ledger.db
    plan/v1.json … vN.json
    nodes/<nodeId>/{packet.json, prompt.txt, stdout.log, output.json, verdict.json}
    artifacts/<sha>/
    worktrees/
    report.html
```

### 9.5 Team topology (M3+)

```
Engineer A: karvand (local, local creds) ──┐
Engineer B: karvand (local, local creds) ──┼──> Karvan Hub (self-hosted, Docker)
Engineer C: karvand (local, local creds) ──┘     · shared workflow/gate/template registry
                                                 · run event aggregation + dashboards
                                                 · approval queue + notifications
                                                 · redacted artifact archive
```

**Credentials and model traffic never reach the hub.** Only redacted events and artifacts sync. This is what makes team rollout viable under §5.

---

## 10. Users and use cases

**Primary (M1): you.** Senior fullstack engineer, multiple provider subscriptions, hours-long tasks, high tolerance for rough edges, zero tolerance for opaque failure.

**Secondary (M2–M3): Voyado colleagues.** Varying provider subscriptions, low setup patience, need to trust the output and understand what happened before they'll adopt. For them, the visualization *is* the adoption argument — it's what converts "the AI did something" into a reviewable engineering artifact.

**Anchor use cases:**

1. **Framework migration** — Vue 2→3, or a design-system swap across 200 components. Map over components, parallel analysis, serialized writes by path scope, gate on typecheck + visual regression, loop until criteria pass.
2. **Spec-to-PR feature** — framing interview, plan, implement, adversarial review by a different provider, repair loop, branch + PR.
3. **Cross-cutting refactor with unknown blast radius** — recon phase discovers scope, planner replans mid-run as the true scope emerges. The dynamic-plan case.
4. **Test backfill** — map over uncovered modules, parallel generation, coverage gate.
5. **Dependency upgrade with breakage triage** — upgrade, run tests, fan out fixes by failure cluster, converge.
6. **Long bug hunt** — hypothesis loop with no-progress detection and budget ceiling.

---

## 11. Roadmap

### M0 — Spike (1–2 weeks)
Prove the two riskiest assumptions before building anything else.
- ACP client talking to at least two agents end to end.
- CLI shim adapter for Claude Code and Codex with structured output.
- Confirm what each installed CLI *actually* supports today vs its docs.
- **Kill criterion:** if ACP integration proves impractical and shim adapters are hopelessly unstable across two vendors, the whole provider-neutrality thesis needs rethinking.

### M1 — Personal tool (target: usable daily)
F1.1–F1.3, F2.1–F2.6, F3.1–F3.7, F4.1–F4.7, F5.1–F5.7, F6.1–F6.6, F7.1–F7.5, F8.1–F8.3, F9.1–F9.3, F10.1–F10.9.
Daemon + browser UI. macOS + Linux. **Definition of done: you complete a real multi-hour task at work with it, from spec to merged PR, and the visualization tells you why every step happened.**

### M2 — Shareable (before showing colleagues)
Secret redaction (F5.9), container isolation (F5.8), run replay (F10.10), OTel export (F10.12), notifications (F8.4), plan templates (F2.8), custom gates (F7.6), Windows support, install docs, and 3–5 packaged workflow templates for real Voyado tasks.
**Definition of done: a colleague installs it unaided and finishes a real task.**

### M3 — Team
Karvan Hub (§9.5), shared registry, team dashboards, desktop shell (Tauri), cross-run memory (F6.8), cost reporting (F9.5), shareable run reports (F10.13).

### M4+ — Speculative
Learned planning (F2.9), remote/CI execution workers, A2A exposure, marketplace of gates and templates.

---

## 12. Success metrics

| Metric | Why | M1 target |
|---|---|---|
| **Task completion rate without human rescue** | The core promise | > 50% on anchor use cases |
| **Gate first-pass rate** | Plan and spec quality | > 40% |
| **Median time-to-diagnose a failed run** | The value of visualization; measure it honestly | < 5 min |
| **Successful resume rate after interruption** | Durability actually working | > 95% |
| **Cost per completed task vs manual agent driving** | Whether the orchestration overhead pays | ≤ 1.5× |
| **Replans per run** | Too few = static plan; too many = bad planning | 1–4 |
| **Runs abandoned due to runaway loop** | No-progress detection working | < 5% |
| **Personal weekly active use** | The only M1 metric that really matters | ≥ 3 real tasks/week |

---

## 13. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Provider ToS shifts again** and subscription-backed agent use is restricted | **Critical** | AR-1 (never hold credentials) is the primary defence. Also: API-key path as a first-class alternative; local-model adapter (Ollama/vLLM) as a floor; adapter abstraction means losing one provider degrades rather than kills. Track vendor policy pages as a standing task. |
| **CLI flag/output churn breaks adapters** | High | ACP-first; conformance suite (F3.4) run on `doctor`; version pinning and recording; graceful degradation. |
| **Parallel write agents produce incompatible work** | High | Serialize writes by path scope (F5.2), worktree isolation, path-scope violation as a gate failure. Do not parallelize write-heavy generation by default. |
| **Compaction silently deletes constraints** → unsafe actions | High | Constraint pinning (F6.6), compaction events surfaced in UI, gates evaluated against the pinned spec rather than context. |
| **Runaway cost** | High | Ceilings that pause (F4.6), pre-flight estimates, no-progress detection (F4.7), patch policy cost gating (F2.5). |
| **Destructive action at the execution boundary** (the Kiro/AWS failure mode) | High | Permission ladder (F5.4), human gate on infra/deploy/destructive ops (F5.6), never write to default branch (F5.5), kill switch (F5.7). |
| **Scope explosion — solo build, alongside a job and a degree** | High | M0 kill criterion; M1 is deliberately the smallest thing that is genuinely useful to one person; visualization scoped to nine P0 views, not a design system. |
| **The visualization is pretty but not diagnostic** | Medium | Metric: median time-to-diagnose. If it doesn't drop, the views are wrong. |
| **Artifact leakage when sharing** | Medium | Redaction before any export or sync (F5.9); never sync raw artifacts by default. |
| **ACP fragments** (no Microsoft adoption) | Medium | Shim adapters retained permanently as a parallel path, not a temporary bridge. |
| **Company-policy blockers at Voyado** (data residency, approved vendors) | Medium | Local-first + self-hosted hub is the strongest possible posture. Prepare an architecture one-pager for security review before the internal demo. |

---

## 14. Explicitly out of scope

- Building a coding agent. Karvan orchestrates; it does not edit code itself.
- Hosting models or reselling model access.
- Being an IDE or an editor.
- Multi-tenant SaaS.
- Any feature requiring Karvan to hold, proxy, or transport a provider credential (AR-1).
- Auto-merging to protected branches.

---

## 15. Open questions

1. **Does the planner run on the best available model or a cheap one?** Planning quality dominates run quality, but planning is also frequent. Proposal: strongest available model for initial plan and for patches above a blast-radius threshold; cheap model for routine patches. Needs measurement.
2. **Blackboard schema — fixed vocabulary or free-form typed facts?** Fixed is renderable and validatable; free-form is flexible. Proposal: a small fixed core (findings, decisions, artifacts, scopes, risks) plus a free-form namespace.
3. **How much does the graph need to be user-editable?** Read + approve is clearly required. Direct hand-editing of a running plan is powerful and a large UI surface. Defer past M1.
4. **How do you present this internally?** The strongest demo is probably a real Voyado task shown *through the plan-evolution scrubber* — the artefact colleagues can't get anywhere else. Worth designing M1 with that demo in mind.
5. **Licence and openness.** Open-sourcing the core would help adapter maintenance (the highest-churn layer) and would ease internal security review. Decide before M2.
6. **Naming.** Karvan is proposed, not decided.

---

## Appendix A — Sources

Primary artifact
- `github.com/travisliu/open-dynamic-workflow`

Provider policy and authentication
- `support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` (June 15 2026 pause notice)
- `support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan`
- `autonomee.ai/blog/claude-code-terms-of-service-explained`
- `alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use`
- `codex.danielvaughan.com/2026/04/01/codex-cli-authentication-flows-credential-management/`
- `blakecrosley.com/guides/codex`
- `kilo.ai/articles/claude-code-alternatives-for-terminal` (Gemini CLI → Antigravity CLI migration)

Orchestrator landscape
- `augmentcode.com/tools/open-source-agent-orchestrators`
- `nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/`
- `nimbalyst.com/blog/best-agent-management-tools-2026/`
- `tembo.io/blog/ai-agent-orchestration-tools`
- `github.com/andyrewlee/awesome-agent-orchestrators`

Headless CLI capabilities
- `hidekazu-konishi.com/entry/cli_coding_agents_comparison.html`
- `geminicli.com/docs/cli/headless/`
- `toolsbase.dev/en/reference/codex-commands`

Durable execution
- `zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/`
- `inngest.com/blog/durable-execution-key-to-harnessing-ai-agents`
- `appscale.blog/en/blog/durable-execution-llm-agents-temporal-langgraph-checkpointing-2026`

Context engineering and memory
- `digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026`
- `jeremydaly.com/context-engineering-for-commercial-agent-systems/`
- `mastra.ai/articles/agent-systems`
- arXiv 2606.22528 — governance decay under context compaction
- arXiv 2605.08580 — trajectory-grounded compaction validation
- arXiv 2605.18747 — code as agent harness

Spec-driven development
- `thebcms.com/blog/spec-driven-development/`
- `github.com/aws-samples/sample-specship`
- `doit.com/blog/spec-driven-development-with-kiro-ai-code-ownership`
- `augmentcode.com/guides/what-is-spec-driven-development`
- `codemyspec.com/blog/spec-driven-development`

Observability and interop
- `agentclientprotocol.com/get-started/introduction` · `zed.dev/acp`
- `rywalker.com/research/zed-agent-client-protocol`
- `morphllm.com/agent-client-protocol`
- `codex.danielvaughan.com/2026/05/01/codex-cli-agent-interoperability-protocols-mcp-acp-a2a/`
- `digitalapplied.com/blog/ai-agent-observability-2026-tracing-monitoring-stack-guide`
- `langfuse.com/integrations/native/opentelemetry`
- `zylos.ai/research/2026-02-28-opentelemetry-ai-agent-observability/`
