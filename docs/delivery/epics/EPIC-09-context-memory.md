# EPIC-09: Context assembly and memory

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-09-context-memory-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-09                                                                                                                                                                                                                                                                                                                                                                                            |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                                                        |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Workstream**       | W6 (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                                                       |
| **Size**             | ~21 days across 10 stories — **over the ~15-day guidance, see Risks**                                                                                                                                                                                                                                                                                                                              |
| **Depends on**       | EPIC-06 (the node runner, the effect journal and the attempt lifecycle a packet is built for), EPIC-05 KAR-05.2 (the capability manifest's `tokenAccounting` tier, which decides how KAR-09.7 measures), EPIC-03 (the `Db` port, `PRAGMA user_version` migrations, the content-addressed blob store), EPIC-02 (`ContextPacket`, `Segment`, `Fact`, `Constraint`, `TaskSpec` and the `Event` union) |
| **Blocks**           | EPIC-10 (the framing interview produces the pinned spec this epic consumes), EPIC-11 (plan validation calls `validateDeclaredReads`), EPIC-12 (gates read the pinned `TaskSpec` from the ledger), EPIC-14 (all cost governance reads this epic's token accounting), EPIC-17 (F10.3 and F10.5 are projections of `context.built` and `context.compacted`)                                           |
| **PRD requirements** | F6.1, F6.2, F6.3, F6.4, F6.5, F6.6 (all P0) · F6.7, F6.9 (P1) · F9.1, F9.3 · F10.3, F10.5 · NF8, NF9, NF10                                                                                                                                                                                                                                                                                         |
| **Architecture**     | [08-context-and-memory.md](../../08-context-and-memory.md) (whole document) · [04-domain-model.md](../../04-domain-model.md) §5, §6, §9.1                                                                                                                                                                                                                                                          |

## Goal

At the end of this epic every agent invocation in DeFlow receives a packet that the engine built
from an explicit, typed, declared list — and that packet is a record, not a side effect. For any
node in any run you can answer, from the ledger alone: what bytes went in, which event put each
one there, how many tokens each segment cost and by which measurement method, what was demoted to
a handle when the budget ran out, and whether the safety constraints that were pinned at the start
were still byte-identical in the prompt that was actually sent. The pinned set is never compacted,
never paraphrased and never merely _assumed_ present — its sha256 is checked after rendering, and a
node that would have gone out without it fails instead.

## Why this matters

The PRD's risk register rates **"compaction silently deletes constraints → unsafe actions"** as
**High**, and it is the one high-severity risk in the whole document with a measured mechanism
behind it. The finding ([§4](../../08-context-and-memory.md), arXiv 2606.22528, _Governance Decay_,
1,323 episodes across seven model families) is that the constraint-violation rate is **0% with the
policy fully in context and 30% after compaction, reaching 59% for the worst model** — and that a
pinned buffer exempt from compaction, re-injected verbatim with integrity checking, **restores it
to 0% across all seven models at negligible cost**. That mitigation is about fifteen lines of code.
It is the single highest-value-per-line story in this backlog and it is `KAR-09.3`.

The companion result ([§4.2](../../08-context-and-memory.md), arXiv 2604.20911, 4,416 trials, 12
models, 8 providers) is worse in a subtler way: prohibitions decay while requirements do not.
Omission compliance — following a _don't_ — falls from **73% at turn 5 to 33% at turn 16**, while
commission compliance holds at **100%**. They call it _Security-Recall Divergence_ and note it is
invisible to standard monitoring, because the commission-type audit signals stay healthy while the
prohibitions rot. That is why `KAR-09.4` exists as a separate story: a system that only implements
pinning has fixed the compaction half and left the turn-depth half untouched, and it will pass its
own gates the whole way down.

Underneath the safety argument sits the product argument. PRD §2.1's third broken thing is
_"nobody knows why it went wrong — tools log stdout, they don't show the assembled context packet,
the memory that was shared, or what compaction deleted."_ Three of the nine P0 views (F10.3 node
inspector, F10.4 memory graph, F10.5 context budget) are projections of exactly four event kinds
this epic emits: `context.built`, `context.compacted`, `fact.written` and `fact.read`. PRD §9.3
says it outright — those events _"exist specifically to make memory sharing renderable; they are
product requirements, not logging."_ Skip this epic and the marquee inspection surfaces have no
data to render, the planner has no budget to plan against, and the highest-severity risk in the PRD
has no control against it.

The layer is also, per [§12](../../08-context-and-memory.md), _"roughly 100% mockable, which means
there is no excuse for it not to be tested."_ `render(segments) -> string` is pure. The blackboard
is a projection. The compaction pipeline can be driven end to end from a committed `stream-json`
fixture with no credentials, no network and no cost. This is the epic where the testing strategy
costs the least and buys the most.

## Scope

**In scope:**

- `validateDeclaredReads(g: PlanGraph): ValidationError[]` — pure DAG reachability over declared
  `reads`/`writes` plus `PINNED_KEYS`, emitting `code: 'undeclared-read'`, run on every
  `plan.proposed` and every `plan.patched`.
- The packet builder: fill order (pinned → task brief → declared reads → retrieved → artifact
  handles), budget as a fraction of the target adapter's declared `maxContext` (**default 0.5,
  never above 0.6**), and the demotion ladder when over budget — largest `tool.output` first, then
  `retrieved`, then `fact` bodies, then inlined `artifact.handle` bodies.
- `render(segments) -> string` as a pure function in `@DeFlow/core`: no clock, no I/O, no
  randomness, pinned segments always first, `history.summary` interleaved in the chronological
  position of what it replaced.
- Constraint pinning: the five pinned content types, `pinned ⇒ !compactable`, verbatim
  re-injection, and `assertPinIntegrity(packet, rendered)` with `pin.integrity_violated` and node
  failure `reason: 'pin-integrity'` — no silent retry.
- The **ConstraintRot regression suite**: ~20 scenarios where a node carries a pinned prohibition
  and a plausible reason to violate it, run against `@DeFlow/mock-agent` with pinning enabled and
  disabled, asserting zero violations with pinning enabled.
- The `Constraint` union (`allow-only` | `require` | `forbid`), the mechanical prohibition →
  positive-requirement restatement applied at packet-build time, `forbid` rendered last among
  pinned constraints and counted, and the `forbid`-to-`allow-only` ratio in `deflow doctor`.
- Interval re-injection at `pinReinjectTurns` (default **8**), delivered as an appended turn where
  the adapter supports mid-session steering, and a packet-builder warning where it does not.
- Artifact offloading: bodies to the content-addressed store under
  `runs/<runId>/artifacts/<sha256>/`, `artifact://<64 hex sha256>` and `file://<path>#L12-L40`
  handles, the rendered handle line with description, line count and byte size, and the
  `DeFlow_read_artifact` MCP tool that resolves one on demand.
- `context.compacted` with the `fidelity: 'exact' | 'partial'` discriminator, both scopes
  (`DeFlow.packet`, `vendor.session`), the `compact_boundary` frame parser, the §6.2 inferred
  `after` figure permanently labelled _inferred_, and the §6.3 transcript-snapshot copy from
  `~/.claude/projects/<project>/<session_id>.jsonl`.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set deliberately per node class (default **70** for
  write-capable nodes), with the `Math.min` clamp asserted so nobody designs against a lever that
  does not exist.
- Three-tier token accounting: Tier 1 from `modelUsage` (never the `usage` passthrough), Tier 2
  from `gpt-tokenizer@3.4.0`'s `o200k_base` encoding-specific entrypoint behind a `Tokenizer` port,
  Tier 3 (`POST /v1/messages/count_tokens`) available **only** on the explicit API-key adapter path.
- The self-calibrating `tokenEstimateFactor`: EWMA with `ALPHA = 0.2`, seeds
  `{ anthropic: 1.2, openai: 1.0, default: 1.05 }` used until `n >= 5`, persisted per
  (provider, model) and surfaced in `deflow doctor`.
- The blackboard as a projection: `fact` and `fact_edges` tables rebuildable from `fact.written` /
  `fact.read` / `fact.invalidated`, the six-kind fixed core plus the `ext:` namespace with
  registered `schemaId`, provenance on every fact, and invalidation that marks downstream readers
  `taint: 'stale-input'` without re-running them.
- Handoff contracts: `returns: { schemaId, maxTokens }` per `agent` node, native `--json-schema`
  where supported, Ajv 8.20.0 validation, the `handoff.oversize` event, exactly one bounded repair,
  and hard failure rather than truncation.
- FTS5 retrieval: `artifact_fts` created with
  `tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"`, `bm25(artifact_fts, 2.0, 1.0)`,
  `ORDER BY rank`, `snippet(…)` and `LIMIT 20`, feeding `retrieved` segments only for nodes that
  declare retrieval.
- The committed fixture corpora both halves of the epic depend on: `test/fixtures/streams/` for
  `stream-json` with at least one `compact_boundary` and one populated `modelUsage`, and
  `test/fixtures/runs/compaction/ledger.db` carrying **both** fidelities.

**Out of scope:**

- A DeFlow-side compactor that rewrites a CLI's transcript between turns —
  [§5.3](../../08-context-and-memory.md) rejects it for M1 outright: per-vendor, requires
  transcript round-tripping through `--resume`, duplicates work the vendor does better.
- Cross-run project memory (F6.8) in `.DeFlow/memory/project.db`, and the background curator that
  proposes promotions — **M3**. Deliberately a separate SQLite file with a separate lifecycle.
- Embeddings, `sqlite-vec`, RRF hybrid search and query expansion — the upgrade path is written in
  [§10.2](../../08-context-and-memory.md) in cost order; none of it is M1, and
  [§10](../../08-context-and-memory.md) is explicit that nothing is added _until a semantic-recall
  miss is actually measured_.
- The rendering of any of this: F10.3's node inspector, F10.4's memory graph and F10.5's stacked
  context-budget bar are [EPIC-17](./EPIC-17-p0-views.md). This epic produces the events those
  views project, and owns the one UI-facing _contract_ they must honour (never fabricate an `after`
  number) — but not the components.
- Budget ceilings, pre-flight estimation and rate-limit backoff — [EPIC-14](./EPIC-14-cost-governance.md).
  This epic supplies `budget.consumed`'s inputs and the calibrated estimator; EPIC-14 decides what
  to do when a ceiling is hit.
- The `TaskSpec` itself — how it is elicited, edited and approved is
  [EPIC-10](./EPIC-10-task-intake.md). This epic consumes an approved spec and pins it.
- Gate execution against the pinned spec — [EPIC-12](./EPIC-12-verification-gates.md). This epic
  guarantees the spec is readable from the ledger rather than from an agent's belief about it.
- The patch policy engine that rejects a patch carrying an undeclared read —
  [EPIC-11](./EPIC-11-dynamic-planning.md). This epic supplies the validator and the error code;
  EPIC-11 wires it into the policy decision.
- Secret redaction of the transcript snapshots and packet blobs before export or hub sync (F5.9) —
  **M2**, [13-observability-and-telemetry](../../13-observability-and-telemetry.md). The snapshot
  in KAR-09.6 is a raw transcript and is explicitly in scope for that later work; it must not be
  exported by anything built here.

## Definition of Ready (epic level)

- [ ] **EPIC-02 Done.** `Segment`, `SegmentKind`, `ContextPacket`, `Fact`, `Provenance`,
      `Constraint`, `TaskSpec` and the `context.*` / `fact.*` / `pin.*` / `handoff.*` members of the
      `Event` union exist as types with emitted JSON Schemas in `.DeFlow/schemas/`.
- [ ] **EPIC-03 Done.** The append-only event table, `PRAGMA user_version` migrations and the
      content-addressed blob store exist, so `fact`, `fact_edges` and `artifact_fts` are one more
      migration rather than new infrastructure.
- [ ] **EPIC-06 Done through KAR-06.3.** There is a node runner with an attempt lifecycle that a
      packet is built _for_, and a place for `pin.integrity_violated` to fail a node from.
- [ ] `@DeFlow/mock-agent` can replay a recorded `stream-json` stream (`--replay`) and honours
      `--seed`, so the compaction pipeline and the ConstraintRot suite are runnable offline.
- [ ] A `stream-json` recording containing at least one `compact_boundary` frame and at least one
      `result` envelope with populated `modelUsage` is committed under `test/fixtures/streams/`.
      **This is the gating fixture for KAR-09.6 and KAR-09.7 and it costs real quota to capture** —
      record it during W3 while the adapter work is already spending credits, not in W6.
- [ ] The normalising snapshot serialiser from
      [testing strategy §9](../../14-testing-strategy.md) is registered, since half this epic's
      assertions are golden-file packet snapshots and every one of them contains a timestamp, a
      ULID and an absolute path.

## Definition of Done (epic level)

- [ ] All ten stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-09-context-memory-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04` and
      `macos-26` under Node 24 and 26.
- [ ] **The ConstraintRot suite is green and runs on every push.** Zero constraint violations across
      all ~20 scenarios with pinning enabled; the same suite with pinning disabled produces a
      non-zero violation count, so the test proves the mechanism rather than proving the mock agent
      is well behaved.
- [ ] A golden-file packet snapshot exists for each of the five node archetypes (recon, implement,
      gate, human, map-child) and asserts that the pinned segments come first and are byte-identical
      to the approved `TaskSpec`.
- [ ] `test/fixtures/runs/compaction/ledger.db` contains a `DeFlow.packet` compaction with exact
      before/after and a `vendor.session` compaction with `after: null`, and both render correctly
      in the replay harness.
- [ ] `deflow doctor` reports, for the loaded workspace: the calibration factor and sample count per
      (provider, model), FTS5 availability _and the tokenizer string actually set on
      `artifact_fts`_, whether `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is in effect and at what value, and
      the current `forbid`-to-`allow-only` ratio in the loaded spec.
- [ ] A CI grep proves no source file imports `@anthropic-ai/tokenizer`, reads the result envelope's
      `usage` field, or creates an FTS5 table without `tokenchars '_-.'`.
- [ ] Every `Unverified` claim in [08-context-and-memory.md](../../08-context-and-memory.md) that
      this epic depends on is resolved with a recorded result or carried forward as a named risk:
      the arXiv figures (§4 citation caveat), the `~/.claude/projects/…` transcript path (§6.3),
      whether `structured_output` is populated in every success case (§9.1), whether ACP surfaces
      usage or compaction state at all (§7, roadmap A0-3), and token accounting for Copilot, Gemini,
      Cursor and OpenCode (roadmap A4-3).

## User stories

### KAR-09.1 — Declared reads and writes enforced at plan time

|                 |                                                            |
| --------------- | ---------------------------------------------------------- |
| **Status**      | Ready                                                      |
| **Priority**    | P0                                                         |
| **Size**        | S                                                          |
| **Depends on**  | — (needs only the `PlanGraph` type from EPIC-02)           |
| **PRD**         | F6.1, F6.2                                                 |
| **Verified by** | EPIC-09-S1, EPIC-09-S2, EPIC-09-S3, EPIC-09-S4, EPIC-09-S5 |

**As** the planner, **I want** a node's declared `reads` to be proven satisfiable from its
ancestors' declared `writes` before the run starts, **so that** a plan that would have wedged three
hours in on an unresolvable read fails in milliseconds and costs nothing.

This is [§2.1](../../08-context-and-memory.md) implemented literally: pure DAG reachability, about
sixty lines, and _"the cheapest correctness gate in the system."_ For each node, the reachable key
set starts as `PINNED_KEYS` (spec, criteria, scopes — always available) and accumulates every
**ancestor's** declared `writes`; each declared read must be satisfied by that set or it becomes
`{ code: 'undeclared-read', node, key }`. `satisfies()` handles exact keys, `finding/*`-style prefix
globs and `ext:<namespace>/` prefixes. Two things make this a story rather than a utility function:
it runs on every `plan.proposed` **and** every `plan.patched`, so a runtime `PlanPatch` that
introduces an undeclared read is rejected by the [EPIC-11](./EPIC-11-dynamic-planning.md) policy
engine with the same error code; and _ancestors, not siblings_ is the load-bearing distinction —
two parallel nodes have no ordering guarantee, so a sibling's write is not a satisfied read even
when it happens to land first.

**Acceptance criteria**

1. `validateDeclaredReads(g)` is pure: no clock, no I/O, no mutation of `g`, and it lives in
   `@DeFlow/core`, which per [repo layout R1](../../16-repo-layout.md) depends on nothing capable of
   impurity.
2. A read satisfied by a **direct or transitive ancestor's** `writes` produces no error; the same
   read satisfied only by a **sibling's** `writes` produces `code: 'undeclared-read'`.
3. `PINNED_KEYS` — the spec sections `goal`, `criteria`, `constraints`, `nonGoals` and the node's
   own path scopes — always satisfy a `{ kind: 'spec', section }` read, with no ancestor required.
4. `satisfies()` resolves an exact key (`finding/auth-uses-jwt`), a prefix glob (`finding/*`) and an
   `ext:` namespace (`ext:migration/…`), and does **not** treat `finding/auth` as satisfying
   `finding/authz`.
5. Validation returns **all** errors, not the first — a plan with four undeclared reads is fixed in
   one pass, not four.
6. The same function is invoked from the `plan.proposed` path and the `plan.patched` path, and a
   patch failing it is rejected with `code: 'undeclared-read'` naming the offending node and key.
7. A 400-node fan-out plan validates in under 50 ms, so the check is affordable on every patch.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                  | Red when                                                  |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | unit        | Linear `recon → implement`: `implement` reads `finding/*`, `recon` writes `finding/auth-uses-jwt` → `[]`                              | The function does not exist                               |
| 2   | unit        | Same graph with the edge removed → one error `{ code: 'undeclared-read', node: 'implement', key: 'finding/*' }`                       | Reachability ignores edges                                |
| 3   | unit        | Two siblings `a` and `b` under one parent; `b` reads a key only `a` writes → one error                                                | Reachability walks the whole graph instead of ancestors   |
| 4   | unit        | Table-driven `satisfies()` over exact / prefix-glob / `ext:` / near-miss (`finding/auth` vs `finding/authz`)                          | Prefix matching is `startsWith` without a separator check |
| 5   | unit        | A node declaring `{ kind: 'spec', section: 'criteria' }` with no ancestors → `[]`                                                     | `PINNED_KEYS` not seeded                                  |
| 6   | unit        | A plan with four independent undeclared reads returns four errors                                                                     | The function returns early                                |
| 7   | integration | A `PlanPatch` inserting a node whose read no ancestor writes is rejected, and `plan.patch.rejected` carries `rule: 'undeclared-read'` | The validator runs only at plan compile time              |
| 8   | unit        | A generated 400-node `map` fan-out validates in < 50 ms                                                                               | Ancestor sets are recomputed per read instead of per node |

**Notes / risks** — the ancestor set is the only thing here with a performance trap: computing it
per _read_ rather than per _node_ turns an O(V+E) walk into an O(V·E) one, which is invisible at
ten nodes and painful at four hundred. Memoise per node.

---

### KAR-09.2 — Packet assembly under a token budget

|                 |                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                                                                              |
| **Priority**    | P0                                                                                                                                                                       |
| **Size**        | L                                                                                                                                                                        |
| **Depends on**  | KAR-09.1, KAR-09.3 (the pinned set is fill-order position 1 and cannot be added afterwards), KAR-09.7 (the Tier-2 estimator only — calibration can land later), KAR-06.3 |
| **PRD**         | F6.1, F6.2, F6.5, F10.3, F10.5, NF8, NF9                                                                                                                                 |
| **Verified by** | EPIC-09-S6, EPIC-09-S7, EPIC-09-S8, EPIC-09-S9, EPIC-09-S10, EPIC-09-S11, EPIC-09-S12, EPIC-09-S13, EPIC-09-S28                                                          |

**As** the orchestrator, **I want** each node's context assembled from its declarations into an
addressable segment array under an explicit token budget, **so that** what the agent received is a
record I can render, diff and audit rather than a string I have to guess about afterwards.

The mechanics are [§3](../../08-context-and-memory.md) and
[§5.2](../../08-context-and-memory.md). The packet is a `Segment[]`, never a string — four P0
requirements are literally unsatisfiable against a flat blob, and the argument is in
[04-domain-model §6.1](../../04-domain-model.md). The budget is a fraction of the target adapter's
declared `maxContext` from its F3.5 capability manifest: **default 0.5, never above 0.6**, because
[§5.1](../../08-context-and-memory.md) shows the vendor's own summariser can consume up to 40k
tokens on its own, so a post-compaction floor is _your packet plus up to 40k_. Fill order is fixed:
pinned segments, task brief, declared reads resolved from the blackboard, retrieved facts, artifact
handles. When the budget is exceeded the rule is absolute — **offload, don't summarise**: demote a
body to `artifact://<sha256>` in the largest-`tool.output`-first order, never compress it. Handles
are lossless and cheap; summaries are lossy and unauditable. `render(segments) -> string` is pure,
which is what makes golden-file packet tests free, and the one refinement worth taking from the
OpenAI Agents SDK is _ordered interleaving_: a `history.summary` sits in the chronological position
of what it replaced rather than being lumped into a preamble.

**Acceptance criteria**

1. `buildPacket()` produces a `ContextPacket` whose `segments` are ordered pinned-first, then task
   brief, declared reads, retrieved, artifact handles; `totals.byKind` sums to `totals.tokens`.
2. Every `Segment` carries `sourceEvent` (the `EventSeq` that put it there), `contentHash` (sha256
   of `text`), `tokens: { estimated, method }` and the `pinned` / `compactable` flags, with
   `pinned ⇒ !compactable` enforced by construction.
3. `budget.fraction` defaults to `0.5`; a configured value above `0.6` is clamped to `0.6` and
   emits a warning naming the configured value.
4. When the assembled total exceeds `budget.limitTokens`, bodies are demoted to handles in the order
   largest `tool.output` → `retrieved` → `fact` bodies → inlined `artifact.handle` bodies, and the
   demotion stops as soon as the packet fits.
5. **No segment is ever LLM-summarised during demotion.** Only a `history.summary` segment for an
   explicit continuation node may be produced by a summariser, and building one is a separate,
   declared step — observable because a demotion-only build makes zero provider calls.
6. If the pinned segments alone exceed `budget.limitTokens`, the build **fails loudly** with a plan
   error naming the node and the pinned total; it does not demote, drop or truncate a pinned
   segment.
7. `render(segments)` is deterministic and pure: 50 calls over the same input are byte-identical, it
   reads no clock, and it produces the same bytes in `@DeFlow/core`'s unit slice as in the daemon.
8. A `history.summary` segment renders at the chronological position of the segments it replaced,
   not appended at the top or bottom.
9. **No implicit inheritance:** given a parent node whose full transcript exists in the ledger, the
   child's packet contains no byte of it unless a declared read names it. Verified by content-hash
   set intersection, not by eyeballing.
10. `context.built` is appended carrying the full `ContextPacket` **minus every segment's `text`**;
    the texts live in the content-addressed store, and `prompt.txt` is written to
    `runs/<runId>/nodes/<nodeId>/` as a derived, non-authoritative artifact (NF8).

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                 | Red when                                         |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | unit        | Golden-file snapshot of a recon-archetype packet; assert `segments[0].pinned === true`                               | The builder appends pinned segments last         |
| 2   | unit        | Golden-file snapshots for implement / gate / human / map-child archetypes                                            | Archetype-specific fill differs from the spec    |
| 3   | unit        | `render()` called 50 times over shuffled-key inputs returns one distinct string                                      | Render iterates an unordered map                 |
| 4   | unit        | A packet with `fraction: 0.75` configured yields `budget.fraction === 0.6` plus a warning                            | The clamp is missing                             |
| 5   | unit        | Over-budget packet with one 40k `tool.output`, one 8k `retrieved`, one 2k `fact` → only the `tool.output` is demoted | Demotion order wrong or over-eager               |
| 6   | unit        | Pinned-only packet exceeding the budget throws `PinnedSetExceedsBudget` naming the node                              | The builder demotes a pinned segment             |
| 7   | unit        | A demotion-only build with a `FakeProvider` that throws on any call completes successfully                           | A summariser is on the demotion path             |
| 8   | unit        | `history.summary` replacing segments 3–5 renders between segments 2 and 6                                            | Summaries are hoisted to a preamble              |
| 9   | integration | Parent node with a 100k transcript in the ledger; child packet's `contentHash` set is disjoint from it               | Any inheritance path exists                      |
| 10  | integration | After a build, `context.built`'s payload has no `text` key at any depth, and every `contentHash` resolves in the CAS | Texts are inlined into the event                 |
| 11  | integration | `prompt.txt` on disk is byte-identical to `render(segments)` recomputed from the manifest                            | The render is not reproducible from the manifest |

**Notes / risks** — this is the largest story in the epic and the one most likely to grow. The
discipline that keeps it bounded: the builder does _selection and ordering_; it does not
tokenise (that is the `Tokenizer` port), it does not fetch (that is the blackboard and the CAS), and
it does not summarise (nothing does, except the explicit continuation path). If a change makes
`buildPacket` need a network call, the change is wrong.

---

### KAR-09.3 — Constraint pinning and the integrity check

|                 |                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                           |
| **Priority**    | P0                                                                                                    |
| **Size**        | M                                                                                                     |
| **Depends on**  | KAR-06.5 (the node runner must be able to fail a node with a typed reason)                            |
| **PRD**         | F6.6, F1.5, F5.3, F5.4                                                                                |
| **Verified by** | EPIC-09-S8, EPIC-09-S14, EPIC-09-S15, EPIC-09-S16, EPIC-09-S17, EPIC-09-S18, EPIC-09-S19, EPIC-09-S20 |

**As** the operator, **I want** the safety constraints, spec and path scopes to be uncompactable,
rendered first, re-injected as identical bytes and verified by hash after rendering, **so that** the
30% post-compaction constraint-violation rate measured in the literature is 0% in my runs, and so
that the one case where the mechanism fails fails _loudly_.

**This is the single highest-value story in the backlog.** The mechanism is
[§4.1](../../08-context-and-memory.md) and it is about fifteen lines — `assertPinIntegrity` is
printed in full in the architecture doc. The value is in the three properties being enforced
together and in the regression suite that keeps them enforced. The pinned set is exactly five
things: the `TaskSpec` goal and non-goals (`pinned.spec`), the acceptance criteria (`pinned.spec`),
the safety constraints from run config and the F5.6 execution-boundary rules
(`pinned.constraints`), the declared path scopes (`pinned.pathscope`) and the node's permission
level (`pinned.constraints`). Re-injection is **verbatim** — _"do not let a summariser paraphrase
them, do not reformat them, do not renumber a list. The paper's result is specifically about
verbatim re-injection; a paraphrase is an untested intervention."_ And the check runs against the
**rendered output**, not against the manifest, because the failure this catches is a rendering path
nobody expected. On mismatch the node fails with `reason: 'pin-integrity'` and **does not retry
silently** — _"a pin that vanished is either a bug in the packet builder or a rendering path nobody
expected, and both want a human."_

The regression suite is not optional polish. [§12](../../08-context-and-memory.md) specifies it:
roughly **20 scenarios where a node carries a pinned prohibition and a plausible reason to violate
it**, run against the mock agent with pinning enabled and disabled, asserting **zero violations with
pinning enabled**. It _"turns the paper's finding into a standing guard rather than a one-time
implementation, and it is the test that protects the highest-severity risk in PRD §13."_

**Acceptance criteria**

1. Exactly the five content types in [§4.1](../../08-context-and-memory.md) are built with
   `pinned: true`; no other segment kind may set the flag, enforced by a type-level constraint on
   the builder rather than a review convention.
2. **A pinned segment is never eligible for compaction or demotion.** With the packet 3× over
   budget and the pinned set the largest contributor, the demotion pass still returns every pinned
   segment intact — and the build fails rather than shrinking one (KAR-09.2 AC 6).
3. **Pinned segments are always rendered first**, before the task brief, in every archetype and
   regardless of the order they were added to the packet.
4. **Re-injection after any compaction is byte-identical.** The re-injected text's sha256 equals
   `Segment.contentHash` from the original build; a whitespace change, a reflowed line or a
   renumbered list is a failure, not a tolerance.
5. `assertPinIntegrity(packet, rendered)` fails when _either_ `sha256(seg.text) !== seg.contentHash`
   _or_ `!rendered.includes(seg.text)`, and it collects **all** violating segments before throwing —
   the error carries `missingDigests: string[]` and `segmentIds: SegmentId[]`.
6. On violation the node runner appends `pin.integrity_violated` with
   `{ node, attempt, missingDigests, segmentIds }` and fails the node with `reason: 'pin-integrity'`.
   **No retry is scheduled**, and no `node.retry.scheduled` event appears for that attempt.
7. On success `context.compacted.pinnedKept` carries the sha256 list — the positive evidence that
   the check ran and passed — and `ContextPacket.pinnedDigests` matches it.
8. **The ConstraintRot suite exists**: ~20 scenarios, each a node with a pinned prohibition and a
   plausible in-scenario reason to violate it, graded deterministically on the mock agent's
   _tool calls_ (not on its prose). With pinning enabled the violation count is **0** across all
   scenarios. With pinning disabled via the suite's own flag, the count is **greater than zero** —
   otherwise the suite proves nothing about the mechanism.
9. At least three of the ~20 scenarios exercise the `forbid` → `allow-only` restatement from
   KAR-09.4, so the two mitigations are tested together rather than in isolation.
10. The suite runs offline against `@DeFlow/mock-agent` with `--seed`, in the `integration` project,
    on every push.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                     | Red when                                                                                       |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | unit        | `assertPinIntegrity` over a packet whose rendered string contains every pinned text → returns void                                                                                       | The function does not exist                                                                    |
| 2   | unit        | A rendered string missing one pinned segment → throws `PinIntegrityViolation` with that one digest                                                                                       | The check passes on partial presence                                                           |
| 3   | unit        | Two pinned segments missing → the error carries **both** digests and both `SegmentId`s                                                                                                   | The loop returns on the first miss                                                             |
| 4   | unit        | A segment whose `text` was mutated after build (`contentHash` stale) → throws even though the text is present in the render                                                              | Only `rendered.includes` is checked                                                            |
| 5   | unit        | A pinned segment paraphrased by a summariser stub → throws                                                                                                                               | Paraphrase tolerated                                                                           |
| 6   | unit        | Demotion pass over a 3×-over-budget packet returns all pinned segments unchanged                                                                                                         | Pinned segments are demotable                                                                  |
| 7   | unit        | Golden render across all five archetypes: `pinned.*` kinds occupy the leading positions                                                                                                  | Ordering is insertion-order dependent                                                          |
| 8   | integration | Mock agent run where the builder is patched to drop a pin → ledger contains `pin.integrity_violated` then `node.failed` with `reason: 'pin-integrity'` and **no** `node.retry.scheduled` | The runner retries a pin failure                                                               |
| 9   | integration | Successful run → `context.compacted.pinnedKept` equals `packet.pinnedDigests`                                                                                                            | The positive evidence is never recorded                                                        |
| 10  | integration | **ConstraintRot suite, pinning enabled**: 20 scenarios, `violations === 0`                                                                                                               | Any mechanism above is incomplete                                                              |
| 11  | integration | **ConstraintRot suite, pinning disabled**: `violations > 0`                                                                                                                              | The suite's scenarios are too weak to tempt a violation — fix the scenarios, not the assertion |

**Notes / risks** — the arXiv figures carry an explicit citation caveat
([§4](../../08-context-and-memory.md)): they were obtained by search-engine indexing of the abstract
and HTML pages, not by reading the PDF, because `arxiv.org` and `export.arxiv.org` are both
unreachable from the verification environment. **Re-verify before quoting them publicly.** Note what
this does and does not affect: the _mechanism_ is cheap and obviously sound regardless of the exact
percentages, and the ConstraintRot suite measures DeFlow's own violation rate directly, so the story
does not depend on the paper's numbers being right — only its motivation does.

The second risk is suite quality. A scenario where the agent has no real incentive to violate the
prohibition passes trivially and teaches nothing; AC 11 exists precisely to catch that, and a failing
"pinning disabled" run is a signal to strengthen the _scenarios_.

---

### KAR-09.4 — Prohibition-to-requirement rewriting and interval re-injection

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| **Status**      | Not started                                                                  |
| **Priority**    | P0                                                                           |
| **Size**        | M                                                                            |
| **Depends on**  | KAR-09.3, KAR-05.1 (mid-session continuation on the ACP path)                |
| **PRD**         | F6.6, F1.5, F8.5                                                             |
| **Verified by** | EPIC-09-S20, EPIC-09-S21, EPIC-09-S22, EPIC-09-S23, EPIC-09-S24, EPIC-09-S25 |

**As** the operator, **I want** every prohibition mechanically restated as a positive requirement
and the pinned set re-injected on a turn interval rather than only on compaction, **so that** the
half of the decay problem that pinning does not touch — prohibitions rotting with turn depth — is
also covered.

[§4.2](../../08-context-and-memory.md) is a _distinct_ failure mode from compaction deletion, which
is why the PRD's phrase in F6.6, _"distinct from ordinary long-context attention dilution"_, is
correct: you need both mitigations, not one. Omission compliance falls from **73% at turn 5 to 33%
at turn 16**; commission compliance holds at **100%**. Two mechanisms follow. **(a)** Re-inject the
pinned set every `pinReinjectTurns` turns (default **8**, configurable per provider in
`.DeFlow/config.yaml`), delivered as an appended turn carrying the pinned segments verbatim where
the adapter supports mid-session steering, and enforced by keeping nodes short where it does not —
_"a node that runs 30 turns without a re-injection point is a planning smell, and the packet builder
should warn."_ **(b)** Restate prohibitions positively **at build time**, as a transformation, _"not
as a style guideline for whoever writes the spec … so it happens even when a human wrote the
constraint carelessly."_ Constraints are therefore authored as structured objects
(`allow-only` | `require` | `forbid`), which makes the transformation a render choice rather than
NLP. `forbid` survives as a last resort for constraints with no closed positive form ("do not
exfiltrate credentials"); those render **last** among the pinned constraints and are **counted**,
because a rising `forbid` ratio is a leading indicator of exactly the decay this story prevents.

**Acceptance criteria**

1. The `Constraint` union is
   `{ form: 'allow-only'; subject: 'write-path' | 'command' | 'branch'; allowed: string[] }` |
   `{ form: 'require'; statement: string }` | `{ form: 'forbid'; subject: string; forbidden: string[] }`,
   and the packet builder renders each form through a fixed template — there is no free-prose path
   into a `pinned.constraints` segment.
2. The four documented restatements render exactly as specified: a write-path scope renders as
   _"**only** write files under `src/checkout/**`"_, a command restriction as _"run **only** the
   commands listed in the allowed-commands set"_, a branch restriction as _"commit **only** to
   `DeFlow/<runId>__<nodeId>`"_, and an attempt cap as _"stop after at most 3 fix attempts and
   escalate to a human"_.
3. A `forbid` constraint renders after every `allow-only` and `require` constraint within the pinned
   block, in every archetype.
4. The packet builder records the `forbid` count and the `allow-only` count per build; `deflow
doctor` reports the ratio for the loaded spec.
5. `pinReinjectTurns` is read per provider from `.DeFlow/config.yaml`, defaults to `8`, and where
   the adapter advertises mid-session steering the re-injection is an appended turn whose text is
   byte-identical to the original pinned segments (KAR-09.3 AC 4 applies to it).
6. Where the adapter does **not** support mid-session steering, no re-injection turn is attempted;
   instead the builder emits a planning warning naming the node and its expected turn count once
   that count exceeds `pinReinjectTurns`.
7. Re-injection is idempotent with respect to compaction: a compaction at turn 7 followed by the
   interval at turn 8 does not produce two consecutive identical injections — the interval counter
   resets on any verbatim re-injection.
8. Verification gates read the `TaskSpec` from the ledger, not from the agent's context — asserted
   by a test in which the agent's context is deliberately stripped of the spec and the gate still
   evaluates against the correct criteria ([§4.3](../../08-context-and-memory.md), F1.5).

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                           | Red when                                     |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | unit        | Table-driven over the four documented rows: `restate(constraint)` returns the exact positive string                                            | The transformation does not exist            |
| 2   | unit        | A `forbid` constraint with two `allow-only` siblings renders third                                                                             | Ordering is authoring order                  |
| 3   | unit        | `render()` refuses a `pinned.constraints` segment built from a raw string                                                                      | A prose escape hatch exists                  |
| 4   | unit        | Build counts `{ forbid: 1, allowOnly: 3 }` and exposes them on the build result                                                                | Counting is absent                           |
| 5   | integration | `deflow doctor` output contains the forbid ratio for a fixture spec                                                                            | Doctor does not report it                    |
| 6   | integration | Mock agent advertising steering, node scripted for 20 turns → re-injection turns appear at turns 8 and 16, each byte-identical to the original | The interval is not implemented              |
| 7   | integration | Mock agent with steering **not** advertised, 20-turn node → zero injection turns and exactly one planning warning                              | The client attempts an unsupported call      |
| 8   | unit        | Compaction re-injection at turn 7 then interval tick at turn 8 → one injection, counter reset                                                  | The two paths double-inject                  |
| 9   | integration | Gate node whose agent context omits the spec still evaluates against the ledger's criteria                                                     | The gate reads context instead of the ledger |

**Notes / risks** — the turn counter is the subtle part. On the ACP path a "turn" is a
`session/prompt` continuation; on the exec-shim path there may be no observable turn boundary at all.
Where the count is unobservable, the honest behaviour is the AC 6 warning, not a fabricated counter.
Carry `pinReinjectTurns` in the capability-manifest-derived config so an adapter that cannot honour
it says so rather than silently no-oping.

---

### KAR-09.5 — Artifact offloading and handle resolution

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                               |
| **Priority**    | P0                                                                                                        |
| **Size**        | M                                                                                                         |
| **Depends on**  | KAR-09.2, KAR-03.4 (the blob store and the io_chunk split), KAR-05.6 (the MCP host that exposes the tool) |
| **PRD**         | F6.5, NF8                                                                                                 |
| **Verified by** | EPIC-09-S26, EPIC-09-S27, EPIC-09-S28, EPIC-09-S29                                                        |

**As** an agent, **I want** large bodies replaced by a described handle I can pull on demand,
**so that** a 38 KB build log costs me one line of context instead of a third of my window, and
nothing is lost when I need the whole thing.

[§5.2](../../08-context-and-memory.md) again: _"handles are lossless and cheap; summaries are lossy
and unauditable."_ The store is content-addressed under `runs/<runId>/artifacts/<sha256>/`; the
handle grammar is [04-domain-model §1](../../04-domain-model.md)'s `Handle` —
`artifact://<64 hex sha256>` or `file://<repo-relative path>#L12-L40` — and is immutable by
construction. The rendered form carries enough for the agent to decide whether to pull it:

```
artifact://3f2a…c91  build-log for `pnpm -r build` (fail)  · 412 lines · 38.4 KB
  → pull with the `DeFlow_read_artifact` MCP tool
```

The resolution path is the MCP host DeFlow already runs (D9), injected over stdio via `mcpServers`
in `session/new` — which is the variant [07 §7.1](../../07-provider-adapter-layer.md) picked
precisely because all five probed agents accept it and not one advertised `mcpCapabilities.acp`.

**Acceptance criteria**

1. Any segment body above the configured inline threshold is written to the CAS and represented in
   the packet as an `artifact.handle` segment; the body itself never enters `render()`'s output.
2. Two identical bodies produce one CAS entry and one `artifact://` handle — content addressing is
   real deduplication, not a naming convention.
3. The rendered handle line contains the truncated digest, the description, the line count and the
   byte size, and names `DeFlow_read_artifact` as the retrieval route.
4. `DeFlow_read_artifact` resolves an `artifact://` handle to the full body, and a
   `file://path#L12-L40` handle to exactly that line range of the worktree file, honouring the
   node's permission level — a `read`-level node cannot use it to reach outside its scope.
5. An unresolvable handle returns a typed MCP error naming the digest; it never returns an empty
   body, and never silently succeeds.
6. Offloading a body is never accompanied by a summarisation call: a build where every oversized
   body is offloaded makes zero provider invocations beyond the node's own.
7. `artifact.handle` segments are counted in `totals.byKind` under their own kind so F10.5's stacked
   bar can show handle overhead separately from fact bodies.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                   | Red when                                 |
| --- | ----------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | unit        | A 40 KB `tool.output` becomes an `artifact.handle` segment whose `text` is the handle line only        | Bodies are inlined                       |
| 2   | integration | Two nodes writing identical 1 MB logs produce one directory under `runs/<runId>/artifacts/`            | Hashing is per-node or salted            |
| 3   | unit        | Snapshot of the rendered handle line against the documented format                                     | Format drift                             |
| 4   | integration | Mock agent calls `DeFlow_read_artifact` over stdio MCP and receives the full 412-line body             | The tool is not wired into `session/new` |
| 5   | integration | A `read`-level node calling the tool with a `file://` handle outside its scope gets a permission error | Handle resolution bypasses the ladder    |
| 6   | integration | Unknown digest → typed MCP error containing the digest                                                 | Empty body returned                      |
| 7   | unit        | Offload-heavy build with a provider stub that throws on call → completes                               | A summariser is on the path              |

**Notes / risks** — the permission interaction in AC 4 is the one place this story reaches into
[EPIC-08](./EPIC-08-safety-model.md). `DeFlow_read_artifact` is a DeFlow-hosted tool, so it is
_outside_ the ACP `fs/*` mediation path and needs its own check. That is easy to forget and would
be a genuine scope escape: a `read` node that cannot open a file with `fs/read_text_file` must not
be able to open it by asking DeFlow nicely.

---

### KAR-09.6 — Compaction events with fidelity discrimination

|                 |                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                           |
| **Priority**    | P0                                                                                                                                    |
| **Size**        | M                                                                                                                                     |
| **Depends on**  | KAR-09.2, KAR-05.1 / KAR-05.8 (the stream parsers that surface `compact_boundary` and the result envelope), KAR-04.5 (fixture replay) |
| **PRD**         | F6.6, F10.5, NF10                                                                                                                     |
| **Verified by** | EPIC-09-S30, EPIC-09-S31, EPIC-09-S32, EPIC-09-S33, EPIC-09-S34, EPIC-09-S35                                                          |

**As** the operator, **I want** compaction recorded as an event that says honestly how much it
knows, **so that** I can tell the difference between a number DeFlow measured and a number DeFlow
guessed — and so that the UI never draws a bar it made up.

Because of AR-1 DeFlow owns exactly half this problem, and
[§6](../../08-context-and-memory.md) is unusually blunt about the other half. Claude Code does
surface compaction in `--output-format stream-json` as
`{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' | 'auto',
pre_tokens: number }, uuid, session_id }` — **verified 2026-08-02 from the binary's zod schemas** —
but **`compact_metadata` carries `pre_tokens` only**. There is no `post_tokens`, no list of what was
dropped, and no handle to the pre-compaction transcript. So F6.6's wording is _fully achievable only
for DeFlow's own packet-level compaction_, and the honest response is a discriminator in the type:
`fidelity: 'exact' | 'partial'`, with `after: number | null`, `droppedSegments: []` and
`demotedToHandles: []` on the vendor path. **A chart with a fabricated "after" number is worse than
an honest gap.** §6.2's partial recovery — take the next assistant turn's
`modelUsage[model].inputTokens` as an approximate post-compaction figure — is allowed, but it is
stored as `after` with `fidelity: 'partial'` and labelled _inferred_ everywhere it is displayed, and
**never promoted to `'exact'`**. §6.3's transcript snapshot (copy
`~/.claude/projects/<project>/<session_id>.jsonl` into the run's artifact store on receiving the
boundary frame) gives F6.6's `originalHandle` for the cost of one file copy — and is **Unverified**,
so a missing file is `originalHandle: null`, not an error.

**Acceptance criteria**

1. A DeFlow packet-level compaction appends `context.compacted` with `scope: 'DeFlow.packet'`,
   `fidelity: 'exact'`, a measured `before` and `after`, the full `droppedSegments: SegmentId[]`,
   the full `demotedToHandles: Handle[]`, `pinnedKept` and an `originalHandle` pointing at the
   pre-compaction manifest blob.
2. A vendor `compact_boundary` frame appends `context.compacted` with `scope: 'vendor.session'`,
   `fidelity: 'partial'`, `before: compact_metadata.pre_tokens`, `after: null`,
   `droppedSegments: []` and `demotedToHandles: []`. **The event never carries a fabricated `after`
   or an invented dropped list.**
3. `trigger` maps `compact_metadata.trigger: 'auto'` to `'vendor.auto'` and `'manual'` to
   `'manual'`; DeFlow's own threshold-driven compaction is `'threshold'`.
4. When the next result envelope arrives, `after` may be filled from
   `modelUsage[model].inputTokens`, and the event stays `fidelity: 'partial'`. **There is no code
   path that sets `fidelity: 'exact'` on a `vendor.session` event** — enforced by a type-level
   discriminated union, not by discipline.
5. The UI contract this epic owns: for `fidelity: 'partial'` the consumer must render the `before`
   bar solid and the `after` bar hatched and labelled _inferred_, plus a plain sentence stating the
   vendor does not report what it dropped. A `partial` event that renders as a solid two-bar chart
   is a defect in [EPIC-17](./EPIC-17-p0-views.md), and the fixture that proves it lives here.
6. On `compact_boundary`, the JSONL transcript is copied into the run's artifact store and its
   handle stored as `originalHandle`; if the file is absent, `originalHandle` is `null` and the run
   continues — a missing snapshot is never an error.
7. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set from `providers.<id>.autocompactPct` (default **70** for
   write-capable nodes), and a conformance assertion records that the override can only move the
   threshold **earlier** — the CLI applies `Math.min(pct * effectiveWindow, defaultThreshold)`.
8. `read`-level nodes may opt into `DISABLE_AUTO_COMPACT=1`, and the opt-in is recorded on the node's
   scheduling event so a hard mid-node context-exhaustion failure is attributable afterwards.
9. `test/fixtures/runs/compaction/ledger.db` contains one event of each fidelity and is the fixture
   the replay harness and the EPIC-17 view are both developed against.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                  | Red when                                           |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | unit        | Parse a committed `compact_boundary` frame → `{ scope: 'vendor.session', fidelity: 'partial', before: <pre_tokens>, after: null }`                                    | The parser does not exist                          |
| 2   | unit        | Type test: constructing `{ scope: 'vendor.session', fidelity: 'exact' }` does not compile                                                                             | The union is not discriminated                     |
| 3   | unit        | DeFlow-side compaction over a known packet → exact before/after and the precise `SegmentId` list                                                                      | `droppedSegments` derived by diffing strings       |
| 4   | integration | Replay the fixture stream through the mock agent → ledger has the partial event; then the following result envelope fills `after` and `fidelity` is still `'partial'` | Inference promotes fidelity                        |
| 5   | integration | Snapshot the projected F10.5 payload for a partial event: the `after` field is flagged `inferred: true`                                                               | The flag is lost in projection                     |
| 6   | browser     | Render the compaction fixture: the partial case shows a hatched, labelled bar and the explanatory sentence; no solid `after` bar exists in the DOM                    | The view fabricates a number                       |
| 7   | integration | `compact_boundary` with the transcript file deliberately absent → `originalHandle: null`, run continues, no error event                                               | A missing snapshot fails the node                  |
| 8   | contract    | Adapter conformance assertion over the decoded constants: setting `autocompactPct: 95` does not move the threshold later than the default                             | A policy assumes the override can extend a session |
| 9   | integration | `read` node with `DISABLE_AUTO_COMPACT=1` → the flag appears in the node's scheduling record                                                                          | The opt-in is invisible after the fact             |

**Notes / risks** — every constant here came from **one** shipping bundle (Claude Code 2.1.220),
they are private implementation details with no compatibility guarantee, and they **will** change.
Nothing in the implementation may hardcode a window size: read `modelUsage[m].contextWindow` and
`maxOutputTokens` from the envelope at runtime and assert the rest in the F3.4 conformance suite so
drift is caught by `deflow doctor` and not by a failed three-hour run. The `~/.claude/projects/…`
path in AC 6 is explicitly **Unverified** — confirm it in the M0 spike and treat absence as normal.

---

### KAR-09.7 — Token accounting in three tiers with self-calibration

|                 |                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                          |
| **Priority**    | P0                                                                                                   |
| **Size**        | M                                                                                                    |
| **Depends on**  | KAR-05.2 (the persisted capability manifest that stores `tokenAccounting` and `tokenEstimateFactor`) |
| **PRD**         | F9.1, F9.3, F10.5, NF1, NF6                                                                          |
| **Verified by** | EPIC-09-S36, EPIC-09-S37, EPIC-09-S38, EPIC-09-S39, EPIC-09-S40, EPIC-09-S41                         |

**As** the planner and the cost view, **I want** three clearly-labelled measurement tiers and an
estimator that teaches itself the per-model correction factor, **so that** a pre-flight budget stops
systematically overfilling Anthropic contexts and every displayed number says how it was obtained.

[§7](../../08-context-and-memory.md): you do not own the model call, so exact tokenisation is
impossible for planning and available only post-hoc — _"build the accounting around that fact, and
never silently mix the tiers."_ **Tier 1** is billing truth from the CLI result envelope, and the
trap is that `usage` is typed `z.unknown()` in the CLI's own schema — a raw passthrough with no
shape guarantee — while `modelUsage` **is** typed and carries `contextWindow` and `maxOutputTokens`,
_"which means you never hardcode a window-size table."_ Codex's equivalent is `turn.completed`'s
`usage: { input_tokens, cached_input_tokens, output_tokens }` plus cumulative `token_count` events.
**Tier 2** is `gpt-tokenizer@3.4.0`'s `o200k_base` via the **encoding-specific entrypoint**
(`import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'`) so the daemon does not pull every
BPE table — labelled `method: 'gpt-tokenizer/o200k_base'`. Its error bar is stated honestly:
tiktoken-family tokenizers **undercount Claude tokens by roughly 15–20% on prose, and considerably
more on code**, so an uncalibrated budget overfills — the dangerous direction. **The fix is free**:
an EWMA of `actual / estimated` per (provider, model) with `ALPHA = 0.2`, seeded at
`{ anthropic: 1.2, openai: 1.0, default: 1.05 }` until `n >= 5`, converging within a few percent
after roughly 20 nodes. **Tier 3** is Anthropic's exact `POST /v1/messages/count_tokens`, and it is
available **only** on the explicit API-key adapter path — under AR-1 there is no code path in
`DeFlowd` that reads a token file or sets an auth env var to make this call work.

**Acceptance criteria**

1. Every token figure anywhere in the system carries its `method`
   (`'gpt-tokenizer/o200k_base' | 'heuristic' | 'vendor-reported'`); a figure without one cannot be
   constructed.
2. Tier 1 reads `modelUsage` only. A CI grep proves no source file reads the result envelope's
   `usage` field, and the parser ignores it even when populated.
3. Tier 2 imports the encoding-specific entrypoint; a bundle-size assertion catches a regression to
   the barrel import.
4. `update(c, estimated, actual)` implements the documented EWMA exactly: `observed = actual /
estimated`, first sample seeds the ratio, subsequent samples blend at `ALPHA = 0.2`, and
   `estimated <= 0` returns the calibration unchanged.
5. Until `n >= 5` the seed for the provider family is used (`anthropic: 1.2`, `openai: 1.0`,
   `default: 1.05`); from `n >= 5` the learned ratio is used.
6. The factor is persisted per (provider, model) in the capability manifest as
   `tokenEstimateFactor` and survives a daemon restart.
7. **Convergence is demonstrable**: feeding a sequence of nodes whose true ratio is 1.18 while
   starting from the 1.2 seed moves the stored factor monotonically toward 1.18 and lands within
   ±0.02 by the 20th sample.
8. Tier 3 is reachable **only** when the user supplied their own key through the F3.3 direct-API
   adapter. On the subscription path the call site is unreachable, and a test asserts that no HTTP
   request to `/v1/messages/count_tokens` is made during a full subscription-path run.
   **Note, 2026-08-06:** F3.3 moved to M2, so at M1 there is no adapter that can reach tier 3 at all.
   Build the tier-3 call site and its selection logic anyway — it is what makes the three-tier design
   honest — but only the negative assertion above is exercisable at M1, and the positive path stays
   unverified until the M2 adapter lands. Record that rather than letting a green suite imply tier 3 works.
9. `tokenAccounting: 'none'` in a capability manifest produces a **blank** cost cell in the
   projected payload, not a zero — the honest degradation from
   [§7](../../08-context-and-memory.md).
10. `deflow doctor` prints the current factor and sample count per (provider, model).

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                          | Red when                                |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | unit        | `countTokens` over a fixture string returns a stable number tagged `method: 'gpt-tokenizer/o200k_base'`                                                       | The port does not exist                 |
| 2   | unit        | Parse a committed `result` envelope → `inputTokens`, `contextWindow`, `maxOutputTokens` from `modelUsage`; `usage` untouched                                  | The parser reads `usage`                |
| 3   | unit        | Parse a Codex `turn.completed` → `{ input_tokens, cached_input_tokens, output_tokens }` normalised to the same shape                                          | Codex path unimplemented                |
| 4   | unit        | `update()` table-driven: first sample, blended sample, `estimated = 0` no-op                                                                                  | The EWMA is wrong or divides by zero    |
| 5   | unit        | **Convergence**: 25 samples at true ratio 1.18 from seed 1.2 → factor within ±0.02 of 1.18 by sample 20, and never oscillates outside the interval afterwards | `ALPHA` wrong or the seed is sticky     |
| 6   | unit        | With `n = 3`, the seed is used; with `n = 5`, the learned ratio is used                                                                                       | The threshold is off by one             |
| 7   | integration | Restart the daemon; the factor for `(claude, <model>)` is unchanged                                                                                           | The factor lives in memory              |
| 8   | integration | Full mock-agent run on the subscription path with an HTTP spy → zero requests to any Anthropic endpoint                                                       | Tier 3 leaks onto the subscription path |
| 9   | unit        | A manifest with `tokenAccounting: 'none'` projects a `null` cost, and the projection type forbids `0`                                                         | Zero is used as "unknown"               |
| 10  | integration | `deflow doctor` output contains the factor and sample count                                                                                                   | Doctor does not report it               |

**Notes / risks** — the dead ends are worth restating because two of them look authoritative:
`@anthropic-ai/tokenizer` is still **0.0.4** and implements only the Claude 1/2-era BPE — the package
name is a trap; `js-tiktoken@1.0.21` works but is slower with no accuracy gain; `tiktoken` /
`@dqbd/tiktoken@1.0.22` add a wasm binary for no accuracy gain; shelling out to Python adds a Python
dependency to `npx deflowai up` and _still_ is not exact for Claude. There is no public exact tokenizer
for Claude 3+. Accept it and calibrate.

Token accounting for Copilot, Gemini/Antigravity, Cursor and OpenCode is **Unverified** (roadmap
A4-3) — only Claude Code and Codex were checked. Whether ACP surfaces usage at all is likewise
**Unverified** and rated **High** (roadmap A0-3): if it does not, ACP-first silently costs F9.1 and
F10.5, and the fallback is `tokenAccounting: 'estimated'` with honest UI degradation. Both are
manifest fields, not code branches, so the degradation is data-driven.

---

### KAR-09.8 — The blackboard as a ledger projection, with invalidation

|                 |                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                         |
| **Priority**    | P0                                                                                                  |
| **Size**        | M                                                                                                   |
| **Depends on**  | KAR-03.5 (the pure reducer), KAR-03.2 (migrations), KAR-02.5 (`Fact` and the blackboard vocabulary) |
| **PRD**         | F6.3, F10.4, NF9, NF10                                                                              |
| **Verified by** | EPIC-09-S42, EPIC-09-S43, EPIC-09-S44, EPIC-09-S45                                                  |

**As** the memory graph and the packet builder, **I want** facts to live in the ledger with the
`fact` and `fact_edges` tables as a droppable materialised view, **so that** every read and write is
an auditable edge and F10.4's graph is one query rather than a separate instrumentation project.

[§8](../../08-context-and-memory.md) and [04-domain-model §5](../../04-domain-model.md). The
vocabulary is six fixed kinds — `finding`, `decision`, `artifact`, `scope`, `risk`, `verdict` — plus
one `ext:<namespace>/<key>` free space that is **schema-validated but not enumerated** against a
registered `schemaId` in `.DeFlow/schemas/`. Every fact carries `Provenance`: `byNode`, `byProvider`,
`byModel` (verbatim as the adapter reported it), `fromEvidence: Handle[]`, `atEvent`, and a
`confidence` of `asserted | verified | speculative`. The absolute rule is that the tables are a
projection: _"if the blackboard ever becomes independently mutable, NF9 and NF10 are both gone —
this is the constraint, not a preference."_ Invalidation is where judgement enters: because every
read is an event, the consumer set is one indexed query over `fact_edges`, and every node in it is
marked `taint: 'stale-input'` — but **not re-run**. _"Auto-re-running on invalidation is how you
build a system that loops forever for reasons no human can reconstruct — and it interacts badly with
F4.6 budget ceilings."_ Flag, surface in the F8.3 approval queue, let the patch policy decide.

**Acceptance criteria**

1. Migration `000N` creates `fact` and `fact_edges` with the documented shape, including
   `direction TEXT NOT NULL CHECK (direction IN ('read','write'))` and both indexes
   (`fact_edges_by_fact`, `fact_edges_by_node`).
2. `DROP` both tables and rebuild them by replaying `fact.*` events from seq 0 → the rebuilt content
   is byte-identical to the pre-drop content. This is the test that proves it is a projection.
3. There is no write path to `fact` or `fact_edges` that is not a reducer applying a `fact.*` event —
   asserted by a CI grep for `INSERT INTO fact` outside the projection module.
4. A `finding`/`decision`/`artifact`/`scope`/`risk`/`verdict` fact is accepted when its `value`
   validates against its `schemaId`; a mismatched value is rejected before the event is appended.
5. An `ext:` fact whose `schemaId` is not registered in `.DeFlow/schemas/` is rejected with a typed
   error naming the missing schema; a registered one is accepted without DeFlow knowing what the
   namespace means.
6. Resolving a declared read during packet assembly appends `fact.read` with the reading node — so
   the memory graph's edges exist because the packet was built, not because someone remembered to
   log.
7. `fact.invalidated` marks every node with a `fact.read` for that fact at a `seq` **strictly
   earlier** than the invalidation as `taint: 'stale-input'`; nodes that read it later are untouched.
8. **No tainted node is automatically re-run.** After invalidation the scheduler produces no
   `StartNode` command for a tainted completed node, and the taint appears in the approval queue
   projection.
9. A superseded fact (`supersedes: FactId`) leaves the original readable — history is never
   rewritten.

**Test plan (TDD)**

| #   | Level                                         | Test                                                                                                              | Red when                             |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | unit (`:memory:` permitted — pure projection) | Reduce five `fact.written` and three `fact.read` events → expected `fact` / `fact_edges` rows                     | The projection does not exist        |
| 2   | integration (file-backed)                     | Drop both tables, replay from seq 0, compare full table dumps                                                     | Any state is held outside the ledger |
| 3   | unit                                          | `ext:migration/x` with an unregistered `schemaId` → typed rejection                                               | Ext facts bypass validation          |
| 4   | unit                                          | A `verdict` fact whose value violates its schema → rejected before append                                         | Validation happens after the append  |
| 5   | integration                                   | Build a packet resolving `finding/*` → a `fact.read` per resolved fact, with the correct `by`                     | Reads are not evented                |
| 6   | integration                                   | Invalidate a fact read by nodes A (seq 10) and B (seq 40), invalidation at seq 30 → only A is tainted             | The `< seq` comparison is wrong      |
| 7   | integration                                   | After invalidation, `decide()` returns no command for the tainted node and the approval-queue projection lists it | Auto-re-run implemented              |
| 8   | unit                                          | `supersedes` chain: both facts remain readable, ordering by `atEvent`                                             | Supersede deletes                    |

**Notes / risks** — the one design smell to watch for is a helper that "just updates the fact table
directly" for performance during a large fan-out. AC 3's grep exists because that helper is the
single change that would silently destroy NF9 and NF10, and it would look like an optimisation in
review.

---

### KAR-09.9 — Handoff contract validation and the bounded repair loop

|                 |                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                         |
| **Priority**    | P0                                                                                                                                                  |
| **Size**        | M                                                                                                                                                   |
| **Depends on**  | KAR-09.7 (the Tier-2 counter measures the return), KAR-05.1 / KAR-05.8 (native structured output), KAR-02.8 (schema emission to `.DeFlow/schemas/`) |
| **PRD**         | F6.4 (P0), F6.9 (P1)                                                                                                                                |
| **Verified by** | EPIC-09-S46, EPIC-09-S47, EPIC-09-S48, EPIC-09-S49, EPIC-09-S50                                                                                     |

**As** a downstream node, **I want** the previous node's return validated against a schema and
bounded to a token budget, with exactly one repair attempt and a hard failure after it, **so that**
I never receive silently-truncated JSON or a 40k-token "summary" that eats my window.

[§9](../../08-context-and-memory.md): F6.4's _"default return budget: 500–2,000 tokens, enforced"_
needs a mechanism or it is a comment. Every `agent` node carries
`returns: { schemaId: SchemaId; maxTokens: number }`, and the schema is passed to the CLI
**natively** where supported — Claude Code's `--json-schema <schema>` with the parsed object arriving
in the result envelope's `structured_output` field (**verified 2026-08-02** from the bundle's flag
table and zod schema), Codex's `codex exec` structured output, and prompt-level schema plus Ajv
validation elsewhere with `structuredOutput: 'prompt-only'` recorded in the manifest so the planner
knows the contract is softer. Claude Code runs its **own** bounded schema-repair loop and surfaces
exhaustion as `error_max_structured_output_retries`; map that straight onto a node failure with
`reason: 'schema-repair-exhausted'` — _"do not retry on top of a retry."_ Over budget: emit
`handoff.oversize`, run **one** bounded repair, hard-fail if still over. **Never silently truncate**
— truncating a JSON payload produces invalid JSON downstream, which is exactly the silent
propagation of garbage F6.9 exists to forbid.

The numbers are honest about their provenance: 500–2,000 is _practitioner consensus, not a
controlled study_. The defaults are `gate` 300, `human` 500, `agent` (implementation) 1,500, `agent`
(recon/survey) 4,000, global default **1,500**, overridable per node type and per node — and the
oversize rate per node type is recorded so the numbers can later be tuned from DeFlow's own data.

**Acceptance criteria**

1. `returns: { schemaId, maxTokens }` is required on every `agent` node at plan validation time;
   the per-node-type defaults above apply when unset.
2. Where the adapter advertises native structured output, the schema is passed via the adapter's own
   mechanism (`--json-schema` on Claude Code) and the parsed object is read from `structured_output`;
   elsewhere the schema is prompt-injected and the capability manifest records
   `structuredOutput: 'prompt-only'`.
3. Returns are validated with Ajv **8.20.0** (`strict: true`, `allErrors: true`) plus
   `ajv-formats@3.0.1` against JSON Schema **2020-12** — the same dialect MCP tool `inputSchema`
   defaults to. Schemas are authored in TypeScript with Zod 4.4.3 and emitted via `z.toJSONSchema()`
   into `.DeFlow/schemas/` (NF8).
4. The serialised `structured_output` is counted with the Tier-2 tokenizer; over `maxTokens` appends
   `handoff.oversize` with `{ node, attempt, budget, actual, repairAttempted }`.
5. Exactly **one** repair is attempted — re-prompting the same session to compress to budget — and
   the second `handoff.oversize` for the same attempt carries `repairAttempted: true`.
6. Still over budget after the repair → the node **fails**. There is no truncation path anywhere; a
   CI grep proves no `slice(0, maxTokens)` or equivalent exists on the handoff path.
7. `error_max_structured_output_retries` from the result envelope maps to node failure with
   `reason: 'schema-repair-exhausted'` and **no** additional DeFlow-side repair.
8. A schema-invalid return is a node failure with a repair attempt, never an accepted fact — nothing
   invalid reaches the blackboard.
9. Oversize rate per node type is recorded in a form the F10.11 cross-run dashboard can read later.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                 | Red when                                 |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | unit        | Plan validation rejects an `agent` node with no `returns` and no applicable default                                                  | The contract is optional                 |
| 2   | unit        | Defaults table: gate 300, human 500, agent 1500, recon 4000, global 1500                                                             | Defaults drift from the doc              |
| 3   | integration | Mock agent advertising native structured output → the schema reaches it and the parsed object is read from `structured_output`       | The native path is not used              |
| 4   | integration | Mock agent without the capability → prompt-injected schema, manifest records `'prompt-only'`                                         | The fallback is silent                   |
| 5   | integration | A 3,000-token return against a 1,500 budget → `handoff.oversize` with `repairAttempted: false`, then a compressed return that passes | The repair is not attempted              |
| 6   | integration | Still oversize after repair → `node.failed`; the stored return is the full original, never a prefix                                  | Truncation exists                        |
| 7   | integration | Scripted `error_max_structured_output_retries` → `reason: 'schema-repair-exhausted'`, exactly one attempt in the ledger              | DeFlow retries on top of the CLI's retry |
| 8   | unit        | Ajv rejects a return missing a required field; the error list contains all violations (`allErrors: true`)                            | Ajv configured with defaults             |
| 9   | integration | A schema-invalid return leaves the `fact` table unchanged                                                                            | Invalid output reaches the blackboard    |

**Notes / risks** — **Unverified** ([§9.1](../../08-context-and-memory.md)): whether
`structured_output` is populated in _every_ Claude Code success case. Confirm empirically in the M0
spike; until then the parser must treat an absent `structured_output` on an otherwise-successful
result as a contract failure with a clear message, not as an empty object.

The F6.9 half of this story is P1 in the PRD. If the epic needs to shed days, the schema-validation
path can degrade to "validate, log, do not gate" for M1 while the **token-budget enforcement and the
no-truncation rule stay P0** — those are the parts that protect downstream windows.

---

### KAR-09.10 — FTS5 retrieval over run artifacts

|                 |                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                   |
| **Priority**    | P1                                                                                                                            |
| **Size**        | S                                                                                                                             |
| **Depends on**  | KAR-03.2 (migrations), KAR-09.5 (there must be artifacts to index), KAR-09.2 (`retrieved` segments are a fill-order position) |
| **PRD**         | F6.7                                                                                                                          |
| **Verified by** | EPIC-09-S51, EPIC-09-S52, EPIC-09-S53, EPIC-09-S54                                                                            |

**As** a node that needs prior context, **I want** to pull relevant artifacts from this run and
earlier ones by keyword, **so that** I do not have to carry the history in my window to benefit from
it.

**M1 is SQLite FTS5 + BM25 and nothing else** (D15). **Verified 2026-08-02**:
`better-sqlite3@13.0.2` bundles SQLite **3.53.4** compiled with `ENABLE_FTS5`,
`CREATE VIRTUAL TABLE … USING fts5(…)` works, and `bm25()` ranking with `ORDER BY rank` returns
sensible results — zero extra dependencies, zero build step, no model download, no Docker, NF6
satisfied outright. The table is created exactly as
[§10](../../08-context-and-memory.md) specifies, and **the `tokenchars '_-.'` setting is the one
non-obvious detail and it is load-bearing**: without it FTS5's default tokenizer splits
`snake_case`, `kebab-case` and `file.ext` into fragments and recall on code collapses — and **it
cannot be changed later without rebuilding the index**. Get it right at table creation. The
justification for not starting with embeddings is in [§10.1](../../08-context-and-memory.md): the
corpus is stack traces, test output, diffs, file paths, symbol names and error codes — overwhelmingly
exact-match territory, BM25's strongest suit and dense retrieval's weakest, where embeddings conflate
`getUserById` with `getUsersById`.

**Acceptance criteria**

1. `artifact_fts` is created by migration as
   `USING fts5(title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED, tokenize =
"unicode61 remove_diacritics 2 tokenchars '_-.'")` — the tokenize string asserted character for
   character by a test reading `sqlite_master`.
2. **Searching for a `snake_case` identifier finds the artifact containing it**, as does a
   `kebab-case` name and a `file.ext` name; the same searches against a table built without
   `tokenchars` fail, so the test demonstrates the setting is doing the work.
3. The query is exactly the documented shape:
   `bm25(artifact_fts, 2.0, 1.0)` (title weighted 2×), `ORDER BY rank`,
   `snippet(artifact_fts, 1, '[', ']', '…', 24)`, `LIMIT 20`.
4. Retrieval runs **only** for nodes that declare it; a node with no retrieval declaration produces
   no `retrieved` segments and issues no query.
5. `retrieved` segments carry `sourceEvent` and the artifact handle they came from, so the node
   inspector can click through to the original.
6. A migration that needs to change the tokenizer **drops and rebuilds** `artifact_fts` from the
   artifact store rather than issuing an `ALTER` — and the migration test asserts the rebuild path,
   because the setting genuinely cannot be changed in place.
7. `deflow doctor` reports FTS5 availability **and the tokenizer string currently set on
   `artifact_fts`**, so a table created before this rule was enforced is visible rather than merely
   underperforming.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                            | Red when                                        |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | integration | Read `sql` from `sqlite_master` for `artifact_fts` and assert the exact tokenize string                         | The setting is absent or reworded               |
| 2   | integration | Index a body containing `get_user_by_id`; `MATCH 'get_user_by_id'` returns it as rank 1                         | `tokenchars` missing — the identifier was split |
| 3   | integration | Same for `vue-flow-core` and `pnpm-lock.yaml`                                                                   | Only underscore handled                         |
| 4   | integration | Control: the same corpus in a table built without `tokenchars` fails the same queries                           | The test does not prove the setting matters     |
| 5   | integration | Title match outranks an equal body match, given `bm25(…, 2.0, 1.0)`                                             | Weights not applied                             |
| 6   | integration | A node with no retrieval declaration produces zero `retrieved` segments and zero queries (spy on the `Db` port) | Retrieval runs unconditionally                  |
| 7   | integration | Migration changing the tokenizer drops and rebuilds the table; row count and search results match afterwards    | An in-place `ALTER` was attempted               |
| 8   | integration | `deflow doctor` prints the live tokenize string                                                                 | Doctor reports availability only                |

**Notes / risks** — F6.7 is **P1**, so this is the first story to cut if the epic runs long; the
`retrieved` fill-order slot in KAR-09.2 simply stays empty and nothing else changes. Do not add
embeddings: [§10.2](../../08-context-and-memory.md) puts query expansion first (cheap planner-model
keyword variants OR'd into the FTS5 query), notes that `sqlite-vss` is **explicitly deprecated by its
own author** in favour of `sqlite-vec`, and that `sqlite-vec` is **pre-1.0 after two years** (stable
v0.1.9, 31 Mar 2026; pre-release v0.1.10-alpha.4, 18 May 2026; no commits since) with a known
extension/SQLite-version mismatch failure class on Windows with better-sqlite3 — which lands squarely
on the M3 Windows target. _"Do not add embeddings until a semantic-recall miss is actually
measured."_

---

## Risks

| Risk                                                                                                                                                                                                                                                                                                                               | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The epic totals ~21 days, well over the ~15-day solo-builder guidance.** KAR-09.2 alone is L and KAR-09.3's regression suite is a day of scenario authoring on its own.                                                                                                                                                          | High     | Explicit cut order, in this sequence: **KAR-09.10** (F6.7 is P1; the `retrieved` slot stays empty), the **F6.9 schema-gating half of KAR-09.9** (keep the token budget and the no-truncation rule, downgrade validation to log-only), **KAR-09.6's §6.3 transcript snapshot** (it is Unverified anyway; `originalHandle: null` is the documented degradation), and **KAR-09.4's interval re-injection on non-steering adapters** (the AC 6 warning alone is a legitimate M1 posture). That reclaims ~5 days. **KAR-09.1 and KAR-09.3 are never cut** — they are the two cheapest and the two highest-value stories here. |
| **The arXiv figures behind the whole epic are search-indexed, not read.** `arxiv.org` and `export.arxiv.org` are unreachable from the verification environment (403 via the agent proxy). The paper's existence, ID, title, authors and abstract were confirmed consistently; the specific percentages were not read from the PDF. | Medium   | The mechanism costs fifteen lines and is sound independent of the exact numbers, and KAR-09.3's ConstraintRot suite measures **DeFlow's own** violation rate rather than trusting the paper's. Do not quote 30% / 59% / 73% / 33% publicly without re-verifying against the PDFs.                                                                                                                                                                                                                                                                                                                                        |
| **The decoded Claude Code constants (2.1.220) are private implementation details with no compatibility guarantee and will change.** `effectiveWindow`, the 13k auto-compact offset, the 20k/3k buffers, the 10k–40k summariser bounds.                                                                                             | Medium   | Nothing hardcodes a window: read `modelUsage[m].contextWindow` and `maxOutputTokens` from the envelope at runtime. Assert the rest in the F3.4 conformance suite so `deflow doctor` catches drift instead of a failed three-hour run.                                                                                                                                                                                                                                                                                                                                                                                    |
| **The gating fixture (`stream-json` with a real `compact_boundary` and a populated `modelUsage`) costs real quota and cannot be recorded in CI.** KAR-09.6 and KAR-09.7 are both blocked on it.                                                                                                                                    | Medium   | Record it during **W3**, while adapter work is already spending credits, and commit it under `test/fixtures/streams/`. `pnpm test:record` is manual, never CI. Treat "the fixture exists" as a Definition-of-Ready item, which it is.                                                                                                                                                                                                                                                                                                                                                                                    |
| **Whether ACP surfaces token usage or compaction state at all is Unverified** (roadmap A0-3, rated High). If it does not, ACP-first silently costs F9.1 and F10.5 for every ACP-path provider.                                                                                                                                     | High     | Answer it explicitly in the M0 spike. The fallback is data, not code: `tokenAccounting: 'estimated'` in the capability manifest and honest UI degradation (blank cells, not zeros). KAR-09.7 AC 9 makes that degradation a tested behaviour rather than an aspiration.                                                                                                                                                                                                                                                                                                                                                   |
| **The architecture doc sketches `packages/context/src/…`, which is not one of the eight packages in the repo layout.**                                                                                                                                                                                                             | Low      | Reconcile at implementation time, not by inventing a package: the pure parts (`render`, `assertPinIntegrity`, `restate`, the calibration EWMA, `validateDeclaredReads`) belong in **`@DeFlow/core`**, whose only runtime dependency is `zod`; the Context Builder, the blackboard projection and the FTS5 queries belong in **`@DeFlow/daemon`**. Tokenisation therefore enters `core` through a **`Tokenizer` port** in the same style as `Clock` and `Db`, because `gpt-tokenizer` cannot be a `core` dependency under repo-layout R1.                                                                                 |
| **The ConstraintRot suite can pass vacuously** if its scenarios do not give the agent a real reason to violate the prohibition.                                                                                                                                                                                                    | Medium   | KAR-09.3 AC 11 asserts the suite produces violations **with pinning disabled**. A green "disabled" run means the scenarios are too weak — fix the scenarios, never the assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`DeFlow_read_artifact` is a DeFlow-hosted MCP tool and therefore sits outside the ACP `fs/*` mediation path**, so it could become a permission bypass for `read`-level nodes.                                                                                                                                                    | Medium   | KAR-09.5 AC 4 and its test 5. Worth re-checking during [EPIC-08](./EPIC-08-safety-model.md) as well — this is the kind of hole that is obvious once named and invisible otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Transcript snapshots are raw transcripts** and are in scope for F5.9 redaction before any export or hub sync.                                                                                                                                                                                                                    | Medium   | M2 work, but the constraint lands now: nothing built in this epic may export or sync an artifact, and the snapshot's handle must be tagged so [13-observability-and-telemetry](../../13-observability-and-telemetry.md)'s redaction pass can find it later.                                                                                                                                                                                                                                                                                                                                                              |

---

**Related:** [Flows](../flows/EPIC-09-context-memory-flows.md) · [Board](../board.md) ·
[08-context-and-memory.md](../../08-context-and-memory.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[EPIC-06 orchestrator](./EPIC-06-orchestrator.md) · [EPIC-10 task intake](./EPIC-10-task-intake.md) ·
[EPIC-12 verification gates](./EPIC-12-verification-gates.md) ·
[EPIC-14 cost governance](./EPIC-14-cost-governance.md)

[← Back to the delivery plan](../README.md)
