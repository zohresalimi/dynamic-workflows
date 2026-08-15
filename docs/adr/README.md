# Architecture decision records

> Part of the [DeFlow architecture documentation](../README.md). See also: [PRD](../prd.md) ·
> [Architecture overview](../01-architecture-overview.md) · [Research findings](../research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

Every significant architectural choice in DeFlow is recorded here with the forces that produced it,
the alternatives that were rejected, and — the part that matters most in an area moving this fast —
**a concrete trigger that reopens the decision**.

The architecture documents in [`../`](../README.md) describe how the system works _now_; they are
rewritten as it changes. These records hold the reasoning that produced them, which is the thing
that otherwise decays into folklore. See [ADR 0001](./0001-record-architecture-decisions.md) for why
we keep them at all.

---

## The index

| #                                                                      | Title                                                 | Status   | In one line                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [0001](./0001-record-architecture-decisions.md)                        | Record architecture decisions                         | Accepted | Keep ADRs, each with a checkable "Revisit when"; supersede, never edit.                                                       |
| [0002](./0002-headless-daemon-with-localhost-web-ui.md)                | Headless daemon with a localhost web UI               | Accepted | `DeFlowd` owns execution and serves the UI on one port, 7777; the browser is just a client.                                   |
| [0003](./0003-never-hold-provider-credentials.md)                      | DeFlow never holds a provider credential              | Accepted | AR-1. Spawn the vendor's own binary under the user's account; make "no credentials" a testable property.                      |
| [0004](./0004-acp-first-adapter-layer.md)                              | ACP-first adapter layer                               | Accepted | One ACP client covers five of six vendors — but Claude Code and Codex need first-party adapters.                              |
| [0005](./0005-plan-as-data-not-code.md)                                | The plan is data, not code                            | Accepted | A versioned JSON `PlanGraph`, mutated by typed patches. The central departure from Open Dynamic Workflow.                     |
| [0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md) | Journaled DAG state machine, not deterministic replay | Accepted | Checkpoint-and-memoise over an event ledger. Buys a DeFlowd that is upgradeable mid-run.                                      |
| [0007](./0007-better-sqlite3-over-node-sqlite.md)                      | `better-sqlite3` over `node:sqlite`                   | Accepted | v13 ships prebuilds and installs in 1s; `node:sqlite` still changes API inside an LTS line. Behind a `Db` port.               |
| [0008](./0008-build-the-durable-engine-rather-than-adopt-one.md)       | Build the durable engine rather than adopt one        | Accepted | DBOS for TypeScript is `pg`-only at source level. ~800–1500 LOC we must own anyway.                                           |
| [0009](./0009-pnpm-workspaces-single-published-package.md)             | pnpm workspaces, one published package                | Accepted | Seven private `@DeFlow/*` packages inlined into a single `deflow` tarball. No task runner at M1.                              |
| [0010](./0010-typescript-6-pin-esm-only-erasable-syntax.md)            | Pin TypeScript 6, ESM-only, erasable syntax           | Accepted | TS 7 ships no tsserver, so `vue-tsc` and type-aware lint cannot run on it. No enums, no decorators, ever.                     |
| [0011](./0011-vite-middleware-mode-inside-the-daemon.md)               | Vite in middleware mode inside DeFlowd                | Accepted | One process, one port, no proxy. Vite's dev proxy is documented-bad at SSE, and the UI _is_ SSE.                              |
| [0012](./0012-ledger-projection-store-not-a-query-cache.md)            | A ledger-projection store, not a query cache          | Accepted | A fetch cache is the wrong shape for an append-only totally-ordered log. Gives replay and the scrubber for free.              |
| [0013](./0013-delegate-sandboxing-to-vendor-clis.md)                   | Delegate sandboxing to the vendor CLIs                | Accepted | Four layers; DeFlow owns policy and mediation. Nesting your own bwrap profile breaks a working sandbox.                       |
| [0014](./0014-flat-branch-naming-and-merge-tree-as-ground-truth.md)    | Flat branch naming; merge-tree as ground truth        | Accepted | The PRD's nested scheme hits git's refs D/F conflict. `merge-tree` demotes path scopes to a prediction.                       |
| [0015](./0015-fts5-only-retrieval-at-m1.md)                            | FTS5 and BM25 only for retrieval at M1                | Accepted | BM25 beats embeddings on a corpus of identifiers and stack traces. `tokenchars` is the load-bearing detail.                   |
| [0016](./0016-DeFlow-emits-genai-telemetry-itself.md)                  | DeFlow emits `gen_ai.*` telemetry itself              | Accepted | The PRD's assumption is contradicted — Claude Code emits a private `claude_code.*` namespace. Phoenix, not Langfuse, locally. |
| [0017](./0017-mock-agent-binary-as-a-shipped-package.md)               | The mock agent is a real binary, and shipped          | Accepted | A fake binary tests the parser, the framing and the kill path. A mocked module tests the mock.                                |

Nothing is superseded yet. When something is, its row keeps its number, its status becomes
`Superseded by NNNN`, and the file body is left alone.

---

## The format

Each record follows the same lightweight structure:

```markdown
# ADR NNNN: <Title>

**Status:** Accepted · **Date:** <date> · **Deciders:** <who>

## Context — the forces at play, with the evidence

## Decision — what we will do, in the active voice

## Consequences — Positive / Negative / Neutral

## Alternatives considered — each with why it was rejected

## Revisit when — the concrete, checkable trigger
```

Two conventions carried from the wider document set:

- **`(F4.2)`, `(NF6)`, `(AR-1)`** cite the requirement in [prd.md](../prd.md) a decision serves.
- **`**Verified 2026-08-02.**`** marks something empirically checked during the research pass —
  installed, probed, benchmarked, or read from source at a named commit.
  **`**Unverified.**`** marks something reasoned about but not executed. Never state an unverified
  thing as fact (AR-6).

### The rules

1. **Every ADR has a "Revisit when" section with a concrete, checkable trigger.** Not "when the
   ecosystem matures" — "when `node:sqlite` reaches Stability 2 _and_ Node 26 is our floor". A
   trigger you cannot check is not a trigger, and in an area this volatile the real failure mode is
   not making a wrong call but never noticing the call expired.
2. **Accepted ADRs are immutable.** Overturning one means writing a **new** ADR that supersedes it.
   The old file stays, its status changes, its body is untouched. Editing a record to match current
   reality destroys the only thing it was for.
3. **Detail belongs in the architecture docs.** An ADR states the forces, the call and the trigger,
   then links to [05-durable-execution.md](../05-durable-execution.md) or wherever the mechanism
   actually lives. Roughly 90–150 lines, the range this set actually occupies. ADRs that grow into
   design documents stop being read; if one passes ~150 lines, the excess is design detail that
   belongs in an architecture doc.
4. **Cite evidence with its confidence.** The research pass on 2 August 2026 installed packages,
   probed live agent binaries and ran benchmarks. Where a decision rests on that, say so and say
   what was measured.

---

## Adding a new one

1. Take the next free number. Numbers are sequential and never reused, including for superseded
   records.
2. Name the file `NNNN-kebab-case-title.md`, phrased as the decision rather than the topic —
   `0007-better-sqlite3-over-node-sqlite.md`, not `0007-database.md`.
3. Copy the template above. Write **Context** before **Decision**; if the context does not make the
   decision feel close to forced, the context is incomplete.
4. Fill in **Revisit when** with something you could put in a calendar reminder and actually check.
   If you cannot write one, the decision is probably not settled yet.
5. Add a row to the index table above.
6. If the decision overturns an earlier one, set the old record's status to
   `Superseded by ADR NNNN`, link forward from it, and **leave its body alone**.
7. If the decision is one of the rules everything else follows, add it to the rules table in
   [../README.md](../README.md) too.

---

**Related:** [Architecture overview](../01-architecture-overview.md) ·
[Research findings](../research-findings.md) · [Tech stack](../02-tech-stack.md) ·
[PRD](../prd.md) · [Roadmap](../17-roadmap.md)

[← Back to index](../README.md)
