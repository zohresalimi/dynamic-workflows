# Karvan — architecture documentation

> **Karvan** (کاروان) is a local-first, provider-neutral orchestrator for long-running,
> dynamically-planned AI engineering work. A caravan of agents on a long route, with visible
> stages and caravanserais — checkpoints you can resume from.

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

This directory holds the product requirements and the architecture that follows from them. The
architecture was derived from a research pass conducted on **2 August 2026** in which packages were
installed and unpacked, agent binaries were probed with live protocol handshakes, SQLite was
benchmarked, and git behaviours were executed rather than assumed. Where that research contradicted
the PRD — and it did, in several load-bearing places — the correction is recorded in
[research-findings.md](./research-findings.md) and carried through the design.

---

## Start here

| If you want to… | Read |
|---|---|
| Understand what Karvan is and why | [prd.md](./prd.md) |
| Understand how it is built | [01-architecture-overview.md](./01-architecture-overview.md) |
| **Run and test it on your machine** | [03-local-development.md](./03-local-development.md) |
| Know what to `pnpm add` and why | [02-tech-stack.md](./02-tech-stack.md) |
| Know what was verified vs assumed | [research-findings.md](./research-findings.md) |
| Know what to build first | [17-roadmap.md](./17-roadmap.md) |
| Know why a decision was made | [adr/README.md](./adr/README.md) |

---

## The document set

### Foundations

| Doc | What it covers |
|---|---|
| [prd.md](./prd.md) | Product requirements. The source of every `F`, `NF` and `AR-1` reference in these docs. |
| [research-findings.md](./research-findings.md) | The evidence base. Verified version manifest, measured numbers, corrections to the PRD, and an honest register of what remains unverified. |
| [01-architecture-overview.md](./01-architecture-overview.md) | System context, components, the inviolable rules, and the three key runtime flows. |
| [02-tech-stack.md](./02-tech-stack.md) | Every dependency, pinned, with rationale and revisit triggers. |
| [03-local-development.md](./03-local-development.md) | Clone → install → run → test. The single-process dev loop, and developing with zero credentials and zero cost. |
| [16-repo-layout.md](./16-repo-layout.md) | Monorepo structure, package boundaries, dependency direction, on-disk state. |

### The engine

| Doc | What it covers |
|---|---|
| [04-domain-model.md](./04-domain-model.md) | `TaskSpec`, `PlanGraph`, `PlanPatch`, `Fact`, `ContextPacket`, and the full `Event` union. The shared vocabulary. |
| [05-durable-execution.md](./05-durable-execution.md) | The ledger, the reducer, the effect journal, idempotency, the scheduler, and resume after crash. |
| [06-planning-and-replanning.md](./06-planning-and-replanning.md) | Planning, runtime plan mutation, and the patch policy engine. Karvan's core differentiator. |
| [07-provider-adapter-layer.md](./07-provider-adapter-layer.md) | ACP client, MCP host, CLI exec shims, capability probing, the conformance suite, and the mock agent. |
| [08-context-and-memory.md](./08-context-and-memory.md) | Four memory tiers, packet assembly, constraint pinning, compaction, token accounting, retrieval. |
| [09-workspace-and-safety.md](./09-workspace-and-safety.md) | Git worktrees, conflict detection, the permission ladder, the execution boundary, the kill switch. |
| [10-verification-gates.md](./10-verification-gates.md) | Deterministic gates, adversarial review, typed verdicts, and the surgical repair loop. |

### Surfaces

| Doc | What it covers |
|---|---|
| [11-api-and-realtime.md](./11-api-and-realtime.md) | The HTTP + SSE contract, resumable streams from ledger offsets, and daemon auth. |
| [12-frontend-architecture.md](./12-frontend-architecture.md) | The Vue 3 app, the ledger-projection store, and the nine P0 visualisation views. |
| [13-observability-and-telemetry.md](./13-observability-and-telemetry.md) | OTel GenAI emission, the artifact store, and secret redaction. |

### Practice

| Doc | What it covers |
|---|---|
| [14-testing-strategy.md](./14-testing-strategy.md) | Fake binaries over mocked modules, real git fixtures, crash-fuzz, and the replay harness. |
| [15-security-model.md](./15-security-model.md) | AR-1 as a verifiable property, credential scrubbing, daemon auth, and the threat model. |
| [17-roadmap.md](./17-roadmap.md) | M0 spikes, M1 workstreams, the scope-cut discussion, and the open-risks register. |
| [adr/README.md](./adr/README.md) | Architecture decision records — every significant choice with its trigger to revisit. |

---

## The rules everything else follows

These are settled. Anything that contradicts them is a bug in the document, not a design option.
Only **AR-1** is a PRD requirement id; AR-2 – AR-6 are this document set's own numbering for rules
the PRD implies but does not name. The five *inviolable* rules, with their costs stated, are in
[01-architecture-overview.md §2](./01-architecture-overview.md#2-the-inviolable-rules).

| # | Rule | Where it comes from |
|---|---|---|
| **AR-1** | Karvan never possesses a model credential. It spawns the vendor's own binary, under the user's own OS account, using the credentials that binary already stored for itself. | [PRD §5.3](./prd.md), [ADR 0003](./adr/0003-never-hold-provider-credentials.md) |
| **AR-2** | Execution is local. The engine lives in a headless daemon, not in the UI process and not in a cloud backend. | [PRD §6.3](./prd.md), [ADR 0002](./adr/0002-headless-daemon-with-localhost-web-ui.md) |
| **AR-3** | The plan is data, not code. A versioned, diffable, patchable graph document. | [ADR 0005](./adr/0005-plan-as-data-not-code.md) |
| **AR-4** | There is exactly one source of truth: the append-only event ledger. Engine state, the blackboard, the plan history and every UI view are projections of it. | [PRD NF10](./prd.md), [ADR 0006](./adr/0006-journaled-dag-state-machine-not-deterministic-replay.md) |
| **AR-5** | Provider capability is probed at runtime and persisted, never hardcoded. A hardcoded matrix is wrong within a month. | [07-provider-adapter-layer.md](./07-provider-adapter-layer.md) |
| **AR-6** | Nothing is stated as fact that was not verified. Unverified claims are marked as such and carry a spike that would close them. | [research-findings.md](./research-findings.md) |

---

## Conventions used in these documents

- **`(F4.2)`, `(NF6)`, `(AR-1)`** — a citation to the requirement in [prd.md](./prd.md) that a
  section implements. This is how the architecture stays auditable against the product intent.
- **`**Verified 2026-08-02.**`** — empirically checked during the research pass: installed,
  probed, benchmarked, or read from source at a named commit.
- **`**Unverified.**`** — reasoned about but not executed. Needs a spike before being relied on.
  Every one of these appears in the open-risks register in [17-roadmap.md](./17-roadmap.md).

Versions cited in these documents were current on 2 August 2026. This is a fast-moving area; the
[research findings](./research-findings.md) list what to re-check and the
[roadmap](./17-roadmap.md) says how often.
