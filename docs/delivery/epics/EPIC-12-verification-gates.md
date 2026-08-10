# EPIC-12: Verification gates and the repair loop

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-12-verification-gates-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Workstream**       | W8a (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Size**             | ~15 days across 6 stories — **at the ceiling of the solo-build guidance, see Risks**                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Depends on**       | EPIC-02 (`NodeResult`, the verdict and finding types — [04-domain-model §7](../../04-domain-model.md)), EPIC-07 (worktrees, branches, `merge-tree` conflict probe), EPIC-08 (path-scope violations are gate input), EPIC-09 (packet assembly, pinning, the pin-integrity check, handoff validation), EPIC-10 (every gate is judged against the `specHash` minted there), EPIC-11 (plan validation is where criteria coverage is enforced), EPIC-06 (node attempts, retry caps, the churn breaker) |
| **Blocks**           | EPIC-15 (the gate and verdict service functions its read endpoints mount), EPIC-17 (KAR-17.6 diff surface with inline verdicts, KAR-17.7 acceptance criteria board)                                                                                                                                                                                                                                                                                                                               |
| **PRD requirements** | F7.1, F7.2, F7.3, F7.4, F7.5, F7.6 (P1), F7.7 (P1), F1.5, F6.9, F5.3 (violation reporting consumed here), NF8, NF10                                                                                                                                                                                                                                                                                                                                                                               |
| **Architecture**     | [10-verification-gates.md](../../10-verification-gates.md) (all sections), [06-planning-and-replanning.md §3.4, §4.3, §7](../../06-planning-and-replanning.md), [04-domain-model.md §7](../../04-domain-model.md)                                                                                                                                                                                                                                                                                 |

## Goal

At the end of this epic DeFlow can answer _"has the requested outcome been achieved?"_ mechanically
rather than rhetorically. Every acceptance criterion in the pinned `TaskSpec` is provably reachable
from at least one gate or is explicitly marked unverifiable; gates run cheapest-first and
short-circuit, so no money is spent reviewing code that does not typecheck; a review gate is
structurally incapable of being the agent that wrote the work, because the scheduler refuses to
admit it otherwise; every verdict is a validated `Verdict` object with stable, blob-anchored
findings rather than prose; and a failing gate produces a narrow fix node — one finding, regression
test first — that is capped at three attempts and then escalates to a human with all three diffs and
all three verdicts attached.

## Why this matters

PRD §3.2 rates _"no verification concept"_ (G9) as **High**: in ODW, "did this actually work?" has
to be hand-coded inside a loop callback, and there is no independent-validator pattern at all. The
SDD literature surveyed in PRD §4.5 converges on exactly four answers — criteria before code, the
author cannot be the judge, surgical fix loops, hard build gates — and this epic is all four made
mechanical.

The failure mode this epic exists to prevent is not a red gate. It is a **green** one that means
nothing. Four ways that happens, all designed against here:

- **Spec-then-drift.** The reviewer reads the code, forms a model of what the code is trying to do,
  and judges the code against that model. It always passes. The `specHash` on every verdict, the
  pinned segments first and verbatim in the reviewer's packet, and the pin-integrity check are the
  three mechanisms that stop it ([§5.2](../../10-verification-gates.md)).
- **Self-review.** `claude-agent-acp` and `opencode acp` both advertise `session.fork`
  (**verified 2026-08-02**), and forking is the obvious-looking way to give the reviewer "context".
  A fork inherits the producer's reasoning wholesale and voids F7.2 entirely. §3.2's scheduling
  precondition exists to make it impossible rather than discouraged.
- **False precision.** _"THE system SHALL display an error within 200ms"_ has the grammar of a test
  and none of the machinery, and a reviewer that read a `setError` call will mark it satisfied.
  Forcing every criterion to name a gate or write the word `unverifiable` and a reason removes an
  entire class of false confidence for ten seconds of authoring cost.
- **The agent fixing the check instead of the code.** `.DeFlow/gates/**` is in the protected path
  set, so a repair node that edits an assertion fails on path scope _before_ its verdict is
  considered. [§9.1](../../10-verification-gates.md) is explicit that this — not a human clicking
  past a red gate — is the classic way a verification system dies.

Skipping this epic does not mean "less verification". It means the acceptance criteria board
(F10.8) renders green from a review that a model gave itself, which is a worse product than having
no board at all.

## Scope

**In scope:**

- The gate ladder and its scheduling order: `deterministic → structural → adversarial → human`,
  with first-`fail` short-circuit, implemented as a derivation inside `decide()` so it is testable
  with no I/O.
- The **milestone rule** in the reducer: a milestone advances only when every gate in its `requires`
  list has a `pass` verdict recorded at a ledger `seq` **after the last write to the paths in its
  scope**. No override flag exists in the data model.
- The deterministic gate runner: `run`, `cwd: worktree | repo`, `timeout`, `effect: pure`,
  `permission`, `expect.exitCode`, `severityFloor`, and the seven `findings.parser` values
  (`tsc`, `eslint-json`, `biome-json`, `vitest-json`, `junit-xml`, `jsonl`, `none`).
- The structural tier's _wiring_: consuming EPIC-07's `merge-tree --write-tree` probe as
  `rule: 'merge/conflict'` findings and EPIC-08's path-scope diff as
  `rule: 'scope/undeclared-write'` warnings, plus the three promotion-to-`error` cases.
- Independent adversarial review: reviewer provider routing, the total fallback rule when only one
  provider is installed, `assertIndependentReview` and its two `SchedulingRefused` codes, and the
  reviewer's packet contract (pinned spec + diff + deterministic and structural output, and
  explicitly **not** the producer's transcript).
- `Verdict` and `Finding` authored in Zod 4.4.3, emitted to `.DeFlow/schemas/verdict.schema.json`
  via `z.toJSONSchema()`, passed natively with `--json-schema` / `--output-schema`, validated with
  Ajv 8.20.0 (`strict: true`, `allErrors: true`) plus `ajv-formats@3.0.1` against JSON Schema
  2020-12.
- The stable `Finding.id = sha256(gate|file|rule|normalisedMessage).slice(0,12)` and the `blobSha`
  anchor on every range.
- Gate return budget: `returns.maxTokens: 600` for gate nodes, `handoff.oversize`, one bounded
  compression re-prompt, then hard fail. Never truncate.
- Acceptance-criteria traceability: the total-mapping validation rule, the `unverifiable` + `reason`
  escape hatch, the reconciliation of the four names this one relation currently has, verdict
  voiding on `specHash` mismatch, and the criteria projection the board reads.
- The surgical repair loop: one `Finding` per fix node, regression-test-first ordering, the cap of
  3 matching `maxAttemptsPerNode`, attempt N+1 receiving previous **verdicts** and not transcripts,
  and the escalation to `human.requested` with all three diffs and all three verdicts.
- Custom gate discovery from `.DeFlow/gates/*.{yaml,yml}`, the `gates.loaded` event carrying the
  sha256 of every discovered file, and the mid-run divergence path.
- Evidence spilling: any payload over ~256 KiB to the content-addressed blob store, with
  `{ sha256, bytes, mime, head, tail }` and ~2 KiB head/tail previews.

**Out of scope:**

- `git merge-tree --write-tree` itself, the `conflict_probe` table and branch/worktree lifecycle —
  [EPIC-07](./EPIC-07-workspace-isolation.md) KAR-07.6. This epic consumes the probe's result and
  turns it into findings.
- Path-scope computation, the protected path set's enforcement, the command allowlist and the
  execution boundary — [EPIC-08](./EPIC-08-safety-model.md) KAR-08.3 and KAR-08.7. Gate commands
  run under that boundary unchanged; this epic does not implement it.
- Packet assembly, pinned segments, the `pin.integrity_violated` mechanism and prohibition
  rewriting — [EPIC-09](./EPIC-09-context-memory.md). This epic _asserts on_ them for the reviewer
  packet; it does not build them.
- Plan validation's plumbing (diagnostics-as-events, the one-retry-then-escalate loop) —
  [EPIC-11](./EPIC-11-dynamic-planning.md) KAR-11.2. This epic contributes one rule to it.
- The patch policy engine — [EPIC-11](./EPIC-11-dynamic-planning.md) KAR-11.4. The repair loop
  _proposes_ patches through it; the rule table lives there.
- The churn circuit breaker and `maxAttemptsPerNode` — [EPIC-06](./EPIC-06-orchestrator.md)
  KAR-06.8. This epic asserts the interaction, and owns the repair loop's own cap.
- `human` gates, the approval queue and escalation — [EPIC-13](./EPIC-13-human-in-the-loop.md).
  A `needs-human` verdict _opens_ a human node; EPIC-13 owns what happens next.
- `GET /api/runs/:id/gates`, `/findings?file=`, `/criteria` and `/diff` —
  [EPIC-15](./EPIC-15-daemon-api.md) KAR-15.6. This epic defines the projections those endpoints
  serve.
- Rendering: inline verdicts on the diff, stale-finding margins, the criteria board —
  [EPIC-17](./EPIC-17-p0-views.md) KAR-17.6 and KAR-17.7.
- `DeFlow doctor`'s gate-hygiene report is _specified_ in KAR-12.6 and _shipped_ by
  [EPIC-18](./EPIC-18-cli-packaging.md) KAR-18.4, which owns the `doctor` command.
- OTel `execute_tool <gateId>` spans and the `DeFlow.gate.verdict` attribute — F10.12 is P1/M2.
  The attribute name is fixed here so M2 does not have to rename it.

## Definition of Ready (epic level)

- [ ] **EPIC-07 Done through KAR-07.6.** `mergeTree()` returns `{ exitCode: 0 | 1, conflictedPaths }`
      as a value, and the `conflict_probe` table exists, so the structural tier has something to
      read.
- [ ] **EPIC-09 Done through KAR-09.3.** Pinned segments are re-injected verbatim and the
      sha256 pin-integrity assertion fires, because a review gate whose acceptance criteria were
      compacted away is silently a code-reads-well check.
- [ ] **EPIC-05 Done through KAR-05.2.** The probed capability manifest exists per adapter, with
      `structuredOutput`, `permissionLevels` and `maxContext` populated from
      `provider.probed` events rather than from a constant — reviewer routing reads those rows.
- [ ] **EPIC-04 KAR-04.4 Done.** The mock agent's `--capabilities` flag can advertise a
      Gemini-shaped profile (no `session.resume`, no `session.list`), so "only one provider is
      capable" is a 40 ms unit test rather than an uninstall.
- [ ] The `Verdict` and `Finding` types from
      [04-domain-model.md §7](../../04-domain-model.md) are landed in `@DeFlow/core` (EPIC-02
      KAR-02.7) with `outcome`, `weakened`, `criteria[]` and `evidence: Handle[]` present.
- [ ] A decision is recorded on the four-names reconciliation in KAR-12.4 — spec-side `verifiedBy`,
      spec-side computed `coveredByGates`, plan-side `GateNode.criteria`, gate-file-side
      `satisfies:` — before any of the four is written to disk in a shipped schema.

## Definition of Done (epic level)

- [ ] All six stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-12-verification-gates-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04` and
      `macos-26`, Node 24 and Node 26.
- [ ] No test in this epic mocks `spawn`, uses `memfs` for anything a gate command touches, or uses
      `:memory:` SQLite for a milestone-advance test.
- [ ] The `gate-failure-repair` ledger fixture named in
      [testing strategy §12](../../14-testing-strategy.md) exists at
      `test/fixtures/runs/gate-failure-repair/ledger.db` and contains a failing gate, a surgical fix
      node, a second attempt and a pass — because EPIC-16 and EPIC-17 build against it, not against
      a live run.
- [ ] A run in which a criterion has an empty gate mapping **cannot start**: plan validation fails
      with `CRITERION_UNCOVERED` naming the criterion id, and no agent process is spawned.
- [ ] A run in which the only installed provider is the producer's produces a `pass` verdict carrying
      `weakened: 'same-provider'`, and that marker is present in the projection EPIC-17 reads. A
      weakened review is never indistinguishable from an unweakened one.
- [ ] The gate first-pass rate (PRD §12 target > 40%) is computed as a projection over
      `gate.evaluated` events and is queryable, so both tails are observable from the first real run.
- [ ] Every `Unverified` claim in [10-verification-gates.md](../../10-verification-gates.md) this
      epic rests on is resolved with a recorded result or carried forward as a named risk: A4-2
      (`structured_output` populated on every success), A0-3 (whether ACP surfaces token usage at
      all, which the verdict's `cost` field needs), A4-1 (the `error_max_structured_output_retries`
      subtype decoded from one bundle).

## User stories

### KAR-12.1 — Deterministic gate runner

|                 |                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                             |
| **Priority**    | P0                                                                                                                      |
| **Size**        | M                                                                                                                       |
| **Depends on**  | EPIC-06 KAR-06.4 (effect reconciliation), EPIC-07 KAR-07.2, EPIC-08 KAR-08.3                                            |
| **PRD**         | F7.1, F5.3, NF8                                                                                                         |
| **Verified by** | EPIC-12-S1, EPIC-12-S2, EPIC-12-S3, EPIC-12-S4, EPIC-12-S5, EPIC-12-S6, EPIC-12-S7, EPIC-12-S8, EPIC-12-S9, EPIC-12-S10 |

**As** the orchestrator, **I want** the cheap, unarguable checks to run first and stop the sequence
on the first failure, **so that** no money is ever spent on a model reviewing code that does not
typecheck, and a milestone can only advance on evidence the reducer can verify.

This is [§1](../../10-verification-gates.md) and [§2](../../10-verification-gates.md) implemented
literally. A gate is a `PlanGraph` node of type `gate` that emits a typed `Verdict`; the four
classes are ordered `deterministic → structural → adversarial → human` and the first `fail` stops
the rest. The economics argument is the design argument: there is no point paying a model to review
code that does not compile, and the resulting review is _actively worse_ — a reviewer looking at
broken code spends its attention on the breakage and misses the design problem you needed it to
find.

Two properties are load-bearing beyond ordering. **Gates are `effect: pure`** — a gate that mutates
the repository cannot be re-run to confirm a fix, which is its entire job, so `mutating` is a
definition-load error rather than a runtime surprise. And **the milestone rule has two halves**: a
`pass` verdict must exist, _and_ it must be recorded at a `seq` after the last write to the paths in
its scope. The second half is what stops a stale green carrying a milestone, and it is exactly the
shape a run drifts into when a repair loop touches files after the gate ran.

Gate commands are code from the repository and get no special treatment: `worktree` permission by
default, the F5.6 deny list unchanged, and the same `terminal/create` mediation as any other node.

**Acceptance criteria**

1. For a milestone whose `requires` list contains a deterministic, a structural and an adversarial
   gate, `decide()` admits them in exactly that order, and admits the structural gate only after the
   deterministic one has a `pass`.
2. When the deterministic gate returns `fail`, no `node.scheduled` event is ever emitted for the
   structural or adversarial gates in the same milestone, and the run's `budget.consumed` total is
   unchanged by the adversarial gate — observable as a zero-delta assertion, not as an absence of
   log lines.
3. A gate definition carrying `effect: mutating` is rejected at gate load with
   `GATE_MUST_BE_PURE`, naming the file path. The `effect` field has no default: an omitted
   `effect` is the same error.
4. The reducer advances a milestone if and only if every gate in `requires` has a `pass` verdict
   whose `gate.evaluated` `seq` is greater than the `seq` of the last event that wrote to any path
   in the milestone's scope. A `pass` recorded before that write leaves the milestone unadvanced,
   and the reason is exposed as `stale-green` on the milestone projection.
5. There is no field, flag, config key or environment variable anywhere in the codebase that
   advances a milestone past a non-`pass` verdict. A grep for `override`, `force`, `skipGate` in
   `packages/gates` returns zero hits, and the only path past a failing gate is a `human` node whose
   response is a `human.responded` event.
6. `expect.exitCode` is compared as a value: a gate whose command exits 3 against
   `expect: { exitCode: 0 }` produces `outcome: 'fail'`, and a gate declaring
   `expect: { exitCode: 1 }` treats exit 1 as `pass`.
7. A gate whose command cannot be executed at all — binary not found, non-zero exit _before_ any
   parseable output, or the `timeout` elapsing — produces `outcome: 'needs-human'`, not `'fail'`.
   Its own tooling failing is not the work being wrong, and conflating the two sends work into a
   repair loop no amount of repair will fix.
8. Each of the seven `findings.parser` values produces `Finding[]` from a real tool's real output
   with `file` repo-relative and POSIX-separated, `range.startLine` 1-based, and `rule` populated
   (`ts2345`, `no-floating-promises`, `merge/conflict`).
9. `severityFloor: error` causes `warning` and `info` findings to be recorded on the verdict but not
   to change `outcome`; `severityFloor: warning` makes a `warning` fail the gate.
10. Any single evidence payload over 256 KiB is written to the content-addressed blob store and the
    finding carries `{ sha256, bytes, mime, head, tail }` with head and tail each ~2 KiB. The
    `gate.evaluated` event body stays under that bound, and the identical failing test log across
    three repair attempts occupies one blob.
11. A gate command that trips the F5.6 deny list is refused before spawn with
    `safety.execution-boundary`, and the refusal is a node failure — a gate is not a licence to run
    a migration.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                 | Red when                                                        |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | unit        | `decide()` over a hand-built `RunState` with three gate nodes returns commands in ladder order                                                       | Ordering is incidental to insertion order                       |
| 2   | unit        | With a `fail` verdict recorded for the deterministic gate, `decide()` returns **no** command for the adversarial gate                                | Short-circuit is not implemented                                |
| 3   | unit        | `reduce()` leaves the milestone unadvanced when the `pass` verdict's `seq` precedes the last write event's `seq`                                     | The milestone rule checks only for a `pass`                     |
| 4   | unit        | Table-driven `expect.exitCode` matrix over `{0,1,3} × {expect 0, expect 1}`                                                                          | Exit codes are compared with truthiness                         |
| 5   | unit        | Each parser against a captured fixture of real `tsc`, `oxlint --format=json`, `biome --reporter=json`, `vitest --reporter=json` and JUnit XML output | Parsers are written against invented shapes                     |
| 6   | unit        | `severityFloor` matrix: `{error, warning, info} findings × {error, warning} floor` → expected `outcome`                                              | The floor is applied at render time rather than at verdict time |
| 7   | integration | Real gate definition, real `pnpm exec tsc --noEmit` in a real worktree with a real type error: `outcome: 'fail'`, findings anchored to the real file | The runner shells out through a mock                            |
| 8   | integration | A gate whose `run` names a binary that does not exist → `outcome: 'needs-human'`, not `'fail'`                                                       | Tooling failure is conflated with work failure                  |
| 9   | integration | A gate whose command sleeps past `timeout: 5s` → `needs-human`, process group killed, `Z`-state processes excluded from the kill assertion           | The timeout kills the direct child only                         |
| 10  | integration | A 5 MB test log spills to `artifacts/<sha>/`; the `gate.evaluated` payload is < 256 KiB; three attempts produce one blob                             | Evidence is inlined into the event                              |
| 11  | integration | `effect: mutating` in a discovered gate file → `GATE_MUST_BE_PURE` at load, before any node is scheduled                                             | The check is at run time, or absent                             |
| 12  | e2e         | A two-node run where the deterministic gate fails: the ledger contains no `node.scheduled` for the review gate and the total `costUsd` is unchanged  | The ladder is advisory                                          |

**Notes / risks** — the structural tier's two producers live in other epics; this story owns only
the ordering, the verdict construction and the promotion rules from
[§6.2](../../10-verification-gates.md). Keep the promotion rules here rather than in EPIC-08, because
"a `warning` becomes an `error` when `merge-tree` also reports a conflict at that path" is a
cross-reference between two producers and belongs where both are already in hand.

---

### KAR-12.2 — Independent adversarial review gate

|                 |                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                               |
| **Priority**    | P0                                                                                        |
| **Size**        | M                                                                                         |
| **Depends on**  | KAR-12.1, KAR-12.3, EPIC-05 KAR-05.1, EPIC-05 KAR-05.2, EPIC-09 KAR-09.2                  |
| **PRD**         | F7.2, F6.1, NF7                                                                           |
| **Verified by** | EPIC-12-S11, EPIC-12-S12, EPIC-12-S13, EPIC-12-S14, EPIC-12-S15, EPIC-12-S16, EPIC-12-S17 |

**As** the operator, **I want** a review gate that cannot be the agent that wrote the work and is
mechanically prevented from inheriting its reasoning, **so that** a green review is evidence rather
than a self-assessment, and I can tell at a glance when it was weakened.

[§3](../../10-verification-gates.md) draws a sharp line the implementation must keep: **"a different
session" is a hard scheduling precondition; "preferably a different provider" is a routing
decision.** Both are checked, neither is assumed. `assertIndependentReview` runs before the node is
admitted and throws `SchedulingRefused` with one of two codes —
`REVIEW_SESSION_NOT_INDEPENDENT` when the reviewer's resolved session id equals the producer's, and
`REVIEW_INHERITS_PRODUCER_CONTEXT` when the reviewer's `resume` is a `fork` or resumes the
producer's node. The second check matters as much as the first: `claude-agent-acp` and
`opencode acp` both advertise `session.fork` (**verified 2026-08-02**), and forking is legitimate
for continuation work and forbidden for review.

The routing side needs a rule that is total, because "preferably" is not implementable. The rule
this story ships, evaluated over the probed capability rows at `decide()` time:

1. **Candidate set `C`** = probed providers that are healthy and satisfy the gate node's
   `AdapterRequirement[]` — `structuredOutput`, the node's `permission` level present in
   `caps.permissionLevels`, and `estimatePacketTokens(node) <= caps.maxContext * 0.6`.
2. **Preferred.** If `C \ {producer.provider}` is non-empty, route to its highest-ranked member by
   `policy.review.providerOrder` in `.DeFlow/config.yaml`, falling back to probe order. No
   `weakened` marker.
3. **Fallback — the single-provider case.** If `C \ {producer.provider}` is empty **and**
   `producer.provider ∈ C`, route to the producer's provider on a **new session**
   (`session/new`, never `fork`, never `resume`) and stamp `weakened: 'same-provider'` on the
   verdict. The session precondition is checked in this branch exactly as in the others — the
   fallback weakens the _provider_ dimension only, never the session one.
4. **Refusal.** If `C` is empty, the gate does not run and does not silently pass: it emits
   `gate.evaluated` with `outcome: 'needs-human'` and opens a human node. NF7 says one provider
   being unavailable degrades the plan; it does not say a degraded plan may fabricate a verdict.

The reviewer's packet contains the pinned spec, the diff, the deterministic and structural gate
output, and nothing else — specifically **not** the producer's transcript. F6.1's "no implicit
context inheritance" is doing real work here: a reviewer that has read the producer's rationale is
primed to accept it.

**Acceptance criteria**

1. Independence is checkable from ledger data alone: the review node's `node.started` payload and
   the producer's `node.started` payload both carry the resolved session id, and a test asserting
   `review.resolvedSessionId !== producer.resolvedSessionId` needs nothing but the two events.
2. `assertIndependentReview` throws `SchedulingRefused('REVIEW_SESSION_NOT_INDEPENDENT', review.id)`
   when the ids match, and the node is never admitted — observable as the absence of any
   `session/prompt` frame in the recorded transport log.
3. `assertIndependentReview` throws
   `SchedulingRefused('REVIEW_INHERITS_PRODUCER_CONTEXT', review.id)` when
   `review.resume?.kind === 'fork'` or `review.resume?.of === producer.id`, **including** when the
   producer's provider is the only one installed. Forking is never the fallback.
4. The assertion runs at the last point before the reviewer receives any input, on both adapter
   paths, and the story states which point that is: on the **CLI shim path** DeFlow mints the uuid
   and passes `--session-id <uuid>`, so the check runs before spawn; on the **ACP path** the id is
   only known when `session/new` returns, so the check runs after `session/new` and before
   `session/prompt`. In neither case does the reviewer see a prompt before the check has passed.
5. Claude Code and Gemini CLI honour a client-chosen `--session-id <uuid>` verbatim in every emitted
   frame (**verified 2026-08-02**), so DeFlow asserts on the uuid it minted rather than parsing one
   back out; a frame carrying a different session id fails the node with a typed error.
6. With two capable providers probed, the reviewer's `node.scheduled` event carries a `provider`
   different from the producer's, and the verdict has no `weakened` field.
7. With exactly one capable provider — the producer's — the reviewer runs on it in a fresh session
   and the verdict carries `weakened: 'same-provider'`. The value is present in the `gate.evaluated`
   payload and in the criteria projection, so the board and diff view can render it without a join.
8. With zero capable providers, the outcome is `needs-human` with a machine-readable reason
   `no-capable-reviewer` listing which requirement each probed provider failed. No verdict of
   `pass` is ever produced in this branch.
9. Capability filtering reads the persisted `provider.probed` capability row, never a constant: a
   test that rewrites the row to a Gemini-shaped profile (`session.resume: false`,
   `session.list: false`) changes the routing decision with no code change.
10. The reviewer's `context.built` packet manifest contains segments for the pinned spec, the diff
    and the gate output, and contains **no** segment whose provenance is the producer node's
    transcript. The assertion is on the manifest, which is a ledger event, not on a debug log.
11. An adversarial gate is never admitted while any deterministic or structural gate in the same
    milestone lacks a `pass` — the same short-circuit as KAR-12.1, asserted from the review side.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                                              | Red when                                                      |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | unit        | `assertIndependentReview` throws `REVIEW_SESSION_NOT_INDEPENDENT` on equal ids and returns void on differing ids                                                                                                  | The function does not exist                                   |
| 2   | unit        | Table over `resume: {kind:'fork'}`, `{of: producerId}`, `{kind:'native-if-available'}` → refuse, refuse, admit                                                                                                    | Only the session-id half is checked                           |
| 3   | unit        | `pickReviewer()` over a synthetic capability table: two providers → other provider, no `weakened`; one → same provider + `weakened:'same-provider'`; zero → `needs-human`                                         | The routing rule is a preference expressed in prose           |
| 4   | unit        | `pickReviewer()` with a capable-but-unhealthy second provider excludes it and takes the fallback branch                                                                                                           | Health is not part of the candidate set                       |
| 5   | integration | Two `DeFlow-mock-agent` binaries on PATH under different names, `--capabilities` differing: reviewer's `node.scheduled.provider` differs from producer's                                                          | Provider preference is not applied                            |
| 6   | integration | One mock agent on PATH: the run completes, the verdict carries `weakened: 'same-provider'`, and the two `node.started` events carry different session ids                                                         | The fallback silently drops the marker, or reuses the session |
| 7   | integration | A plan hand-patched to give the reviewer the producer's session id: the ledger contains `node.failed` with the `SchedulingRefused` code and the transport log contains zero `session/prompt` frames for that node | The refusal happens after the prompt is sent                  |
| 8   | integration | Mock agent scripted to emit a _different_ `--session-id` than the one supplied → node fails with a typed error                                                                                                    | DeFlow trusts the frames                                      |
| 9   | integration | The reviewer's `context.built` manifest asserted against a golden file snapshot with the normalising serializer                                                                                                   | The producer's transcript leaks in through a default          |
| 10  | e2e         | Full run: implement node fails typecheck → repair → typecheck passes → review runs on the other provider → `pass`                                                                                                 | The ladder and the routing do not compose                     |

**Notes / risks** — A0-9 is live here: the capability matrix is a snapshot against five specific
versions, two of which were published the same day they were probed. The mitigation is already the
design — routing reads `provider.probed` rows regenerated on every `doctor` run — but a test that
hardcodes "codex supports structured output" reintroduces the risk inside the test suite. Assert on
the fixture row, never on the vendor name.

---

### KAR-12.3 — Typed verdicts with evidence

|                 |                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                        |
| **Priority**    | P0                                                                                                                 |
| **Size**        | M                                                                                                                  |
| **Depends on**  | EPIC-02 KAR-02.8 (schema emission), EPIC-05 KAR-05.1, EPIC-09 KAR-09.9 (handoff validation and the bounded repair) |
| **PRD**         | F7.3, F6.9, F6.4, F7.7                                                                                             |
| **Verified by** | EPIC-12-S18, EPIC-12-S19, EPIC-12-S20, EPIC-12-S21, EPIC-12-S22, EPIC-12-S23                                       |

**As** the diff surface and the repair loop, **I want** every verdict to be a validated object with
stable, blob-anchored findings, **so that** a finding can be attached to a line, deduplicated across
attempts, counted, and traced to an acceptance criterion.

[§4](../../10-verification-gates.md) is emphatic and the reasons are all mechanical: a prose verdict
cannot be attached to a diff line (F7.7), cannot be deduplicated across repair attempts, cannot be
counted for the gate first-pass rate, and cannot drive the surgical repair loop. The schema is
enforced **at the adapter boundary, not by prompt**: authored in Zod 4.4.3, emitted with
`z.toJSONSchema()` to `.DeFlow/schemas/verdict.schema.json` so it is inspectable on disk (NF8),
passed natively — Claude Code takes `--json-schema <schema>` and returns the parsed object in the
result envelope's `structured_output`; Codex takes `--output-schema <FILE>` (**verified
2026-08-02**) — and validated with Ajv 8.20.0 (`strict: true`, `allErrors: true`) plus
`ajv-formats@3.0.1` against JSON Schema 2020-12, the same dialect MCP tool `inputSchema` defaults
to.

Two details carry more weight than their size. **The stable `Finding.id`** —
`sha256(gate|file|rule|normalisedMessage).slice(0,12)` — is how attempt 2 is known to have fixed
`a13f…` and introduced `9c02…`, how the diff view deduplicates the same lint error across four
attempts, and how the churn detector recognises a recurring failure. **The `blobSha`** anchors every
range to the exact revision it refers to: without it, the second repair attempt silently attaches
every earlier finding to whatever line now happens to occupy that number, and the reviewer stops
trusting the annotations within about ten minutes.

**Acceptance criteria**

1. `.DeFlow/schemas/verdict.schema.json` is written on run creation from `z.toJSONSchema()` and
   declares `$schema: "https://json-schema.org/draft/2020-12/schema"`. The file on disk is what is
   passed to `--json-schema` / `--output-schema`; there is no second in-memory copy.
2. An agent-produced verdict that fails Ajv validation fails the node with
   `contract.schema-invalid`, and the failure's `detail` carries the full `allErrors` list, not the
   first error.
3. A result envelope whose subtype is `error_max_structured_output_retries` maps to
   `agent.schema-repair-exhausted` and DeFlow performs **no** further repair attempt of its own —
   retrying over the top of the vendor's own retry is explicitly forbidden.
4. `returns.maxTokens` for gate nodes is 600. A serialised `structured_output` exceeding it emits
   `handoff.oversize { budget: 600, actual, repairAttempted: false }`, then exactly one bounded
   compression re-prompt, then — on a second overrun — `contract.handoff-oversize`. The payload is
   never truncated, at any point, in any branch.
5. `Finding.id` is `sha256(gate|file|rule|normalisedMessage).slice(0,12)` and is stable across
   attempts: the same lint error in the same file after an unrelated edit produces the same id;
   changing the message's variable part (a line number embedded in text) does not change it, because
   normalisation strips it.
6. Every `Finding` carries `blobSha` for the revision its `range` refers to. Rendering a later
   revision, findings whose `blobSha` differs from the rendered blob are marked stale with the
   attempt number that produced them — the projection exposes `stale: true` and
   `fromAttempt: <n>`; the margin text is EPIC-17's.
7. `Verdict.criteria[]` is required and non-empty for any gate declaring `criteria`. A criterion the
   reviewer omitted is materialised as `{ status: 'unverifiable' }`, never as `satisfied`.
8. `Verdict.cost` records `durationMs` always, and `tokens`/`usd` when the adapter's
   `tokenAccounting` is `'exact'` or `'estimated'`, with `TokenUsage.source` set accordingly and
   never silently mixed. On an adapter reporting `'none'` the fields are absent, not zero.
9. Deterministic gates produce the same `Verdict` shape as adversarial ones — the diff surface,
   the criteria board and the repair loop each have exactly one shape to read.
10. Every recorded verdict validates against the emitted schema in a CI check that reads
    `.DeFlow/schemas/verdict.schema.json` from disk, so a Zod edit that changes the wire shape fails
    the build rather than the next run.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                          | Red when                                                                   |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | unit        | `z.toJSONSchema(Verdict)` snapshot to `__snapshots__/verdict.schema.json` with the normalising serializer                                                                                     | The schema is hand-written and drifts from the type                        |
| 2   | unit        | Ajv `strict: true` compiles the emitted schema without warnings                                                                                                                               | The Zod output uses a keyword `strict` rejects                             |
| 3   | unit        | `findingId()` stability table: same inputs → same id; changed `rule` → different id; message with an embedded line number normalises to the same id                                           | The id includes the raw message                                            |
| 4   | unit        | Validation of six malformed verdicts (missing `criteria`, prose in `findings`, bad `severity`, absent `blobSha`, `outcome: 'ok'`, extra property) each produce the expected Ajv error path    | Validation is `try { JSON.parse }`                                         |
| 5   | unit        | A verdict with a criterion missing from `criteria[]` materialises it as `unverifiable`                                                                                                        | Omission defaults to satisfied, or throws                                  |
| 6   | integration | Mock agent scripted to return a 900-token verdict: `handoff.oversize` then one re-prompt then `contract.handoff-oversize`; assert the stored payload is byte-identical to what the agent sent | DeFlow truncates to fit                                                    |
| 7   | integration | Mock agent scripted to emit the `error_max_structured_output_retries` subtype → `agent.schema-repair-exhausted`, and exactly one `node.started` for that attempt                              | DeFlow retries the vendor's retry                                          |
| 8   | integration | Real `--json-schema` argv construction asserted against the fake exec-shim agent's recorded argv, including the absolute schema path                                                          | The flag is built from a relative path that breaks under a different `cwd` |
| 9   | integration | Two attempts against a file edited between them: attempt-1 findings carry the old `blobSha` and project as `stale: true`                                                                      | Findings are anchored to line numbers only                                 |
| 10  | contract    | Every `gate.evaluated` payload in the `gate-failure-repair` fixture validates against the on-disk schema                                                                                      | The fixture predates a schema change and nobody noticed                    |

**Notes / risks** — A4-2 is open: `structured_output`'s presence on **every** success case is
unconfirmed empirically, and F6.9 depends on it. Plan for the honest degradation now — if the field
is absent on an otherwise-successful result, the node fails with `contract.schema-invalid` and the
adapter's capability row records `structuredOutput: false` so the planner stops routing gates there.
Do not build a prose fallback parser; that is the thing [§10](../../10-verification-gates.md)
explicitly forbids, and it breaks on the next CLI release.

---

### KAR-12.4 — Acceptance-criteria traceability

|                 |                                                                               |
| --------------- | ----------------------------------------------------------------------------- |
| **Status**      | Not started                                                                   |
| **Priority**    | P0                                                                            |
| **Size**        | S                                                                             |
| **Depends on**  | KAR-12.3, EPIC-10 KAR-10.4 (spec pinning), EPIC-11 KAR-11.2 (plan validation) |
| **PRD**         | F7.4, F1.5, F10.8                                                             |
| **Verified by** | EPIC-12-S24, EPIC-12-S25, EPIC-12-S26, EPIC-12-S27, EPIC-12-S28               |

**As** the operator, **I want** every acceptance criterion in the pinned spec to reach at least one
gate — or be explicitly marked unverifiable with a reason — **so that** the criteria board is the
literal answer to _"has the requested outcome been achieved?"_ rather than a list of things nobody
checked.

This story is about **totality**. The mapping criterion → gate must be total across the criteria
set, and a criterion with an empty mapping is a **plan validation failure**, not a warning, not a
lint, not a nightly report. [§5.1](../../10-verification-gates.md) and
[06 §3.4](../../06-planning-and-replanning.md) both say so, and the rule is cheap: it runs on v1 and
on every patched successor, before a single token is spent.

The relation currently has **four names across three documents**, and shipping four names for one
relation is how it goes out of sync in month two. This story reconciles them and the reconciliation
is part of the deliverable:

| Name                                           | Where                  | Direction                   | Authority                                                          |
| ---------------------------------------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| `AcceptanceCriterion.verifiedBy: GateId[]`     | `TaskSpec`, authored   | criterion → gate            | **Author's declaration.** The thing the framing interview asks for |
| `AcceptanceCriterion.coveredByGates: NodeId[]` | `TaskSpec`, computed   | criterion → plan node       | **Derived by plan validation.** Never authored by hand             |
| `GateNode.criteria: CriterionId[]`             | `PlanGraph`            | gate node → criterion       | Planner's declaration; what the reviewer is told to judge          |
| `satisfies: [AC-3, AC-7]`                      | `.DeFlow/gates/*.yaml` | gate definition → criterion | Repo author's declaration for a reusable gate                      |

The validation rule over them: for every criterion `c` in the pinned spec, either `c.unverifiable`
is `true` **with a non-empty `reason`**, or there exists an active `gate` node `g` in the plan with
`c.id ∈ g.criteria`. `coveredByGates` is written from that walk. A `satisfies:` entry naming a
criterion the spec does not contain is `GATE_UNKNOWN_CRITERION` — a typo in a gate file must not
quietly cover nothing.

The anti-drift half is the `specHash`: every verdict records the sha256 of the pinned spec it was
judged against, and a verdict whose `specHash` differs from the run's current one is **void** and
the gate is re-run. That is what catches a spec edited mid-run, which
[06 §1.3](../../06-planning-and-replanning.md) treats as a first-class operation rather than a hack.

**Acceptance criteria**

1. Plan validation emits `{ severity: 'error', code: 'CRITERION_UNCOVERED', criterion: 'AC-9' }` for
   every criterion that is neither `unverifiable` nor named by an active gate node's `criteria`, and
   the run does not start. No agent process is spawned.
2. `unverifiable: true` with an empty or absent `reason` is `CRITERION_UNVERIFIABLE_NO_REASON` — the
   escape hatch costs one sentence, and a blank one is not the hatch.
3. `coveredByGates` is written by validation, not by the planner: a plan whose spec arrives with
   `coveredByGates` pre-populated has it recomputed and overwritten, and a mismatch between supplied
   and computed values is recorded as a warning so a hand-edited spec is visible.
4. A `satisfies:` entry in a discovered gate file naming a criterion id absent from the pinned spec
   fails gate load with `GATE_UNKNOWN_CRITERION` naming both the file and the id.
5. Validation runs on **every** plan version. A `PlanPatch` that abandons the only gate covering
   `AC-3` is rejected with `CRITERION_UNCOVERED`, and the rejection is recorded as
   `plan.patched { decision: 'rejected' }` with the diagnostic — never partially applied.
6. A verdict whose `specHash` differs from the run's current pinned `specHash` is void: it does not
   satisfy a criterion, does not advance a milestone, and the gate is re-scheduled. The void verdict
   stays in the ledger and is visible as void rather than being deleted.
7. The criteria projection groups `Verdict.criteria` across all gates by criterion id, takes the
   latest non-void verdict per gate, and renders exactly three states —
   `satisfied` / `unsatisfied` / `unverifiable` — with the evidence handles behind each. An
   `unverifiable` criterion is never counted toward a satisfied total.
8. A criterion whose only covering gate produced `weakened: 'same-provider'` is `satisfied` **with
   the weakened marker carried through to the projection**, so the board can distinguish it.
9. `run.completed` carries `criteriaSatisfied: CriterionId[]` computed from the same projection, so
   the run summary and the board can never disagree.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                             | Red when                                         |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | unit        | `validateCriteriaCoverage(plan, spec)` returns `CRITERION_UNCOVERED` for an uncovered criterion and `[]` for a fully covered one | The rule does not exist                          |
| 2   | unit        | `unverifiable: true, reason: ''` → `CRITERION_UNVERIFIABLE_NO_REASON`                                                            | The flag alone is accepted                       |
| 3   | unit        | The same walk populates `coveredByGates` with plan node ids, not gate definition ids                                             | The two id spaces are conflated                  |
| 4   | unit        | `satisfies: [AC-99]` against a spec with AC-1..AC-8 → `GATE_UNKNOWN_CRITERION`                                                   | Unknown ids are ignored                          |
| 5   | unit        | Criteria projection over a hand-built verdict list: one satisfied, one unsatisfied, one unverifiable, one void by `specHash`     | Void verdicts count                              |
| 6   | unit        | A patch abandoning the last covering gate → validation error, patch rejected                                                     | Validation runs on v1 only                       |
| 7   | integration | File-backed ledger: edit the spec mid-run → new `specHash` → the prior `pass` verdict is void and the gate re-runs               | Verdicts are trusted regardless of `specHash`    |
| 8   | integration | `run.completed.criteriaSatisfied` equals the projection's satisfied set for the `gate-failure-repair` fixture                    | The summary is computed independently and drifts |
| 9   | e2e         | A run whose spec contains one uncovered criterion refuses to start; `POST /api/runs/:id/spec/approve` returns the diagnostic     | The failure surfaces only in logs                |

**Notes / risks** — this is the smallest story in the epic and the one the whole PRD claim rests on.
Resist making it a report. The value is entirely in it being a **hard validation failure before
execution**; a warning here reproduces exactly the "gates that exist but are not treated as real
gates" failure mode one layer up.

---

### KAR-12.5 — The surgical repair loop

|                 |                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                |
| **Priority**    | P0                                                                                         |
| **Size**        | L                                                                                          |
| **Depends on**  | KAR-12.1, KAR-12.3, EPIC-11 KAR-11.3, EPIC-11 KAR-11.4, EPIC-06 KAR-06.5, EPIC-06 KAR-06.8 |
| **PRD**         | F7.5, F4.5, F4.7, F2.4, F2.5                                                               |
| **Verified by** | EPIC-12-S29, EPIC-12-S30, EPIC-12-S31, EPIC-12-S32, EPIC-12-S33, EPIC-12-S34, EPIC-12-S35  |

**As** the operator, **I want** a gate failure to produce one narrow fix node per finding that
writes a failing regression test before it writes a fix, capped at three attempts and then escalated
to me, **so that** repair converges or stops, and never quietly becomes an expensive loop.

[§7](../../10-verification-gates.md) is the specification and the ordering inside it is the design.
A gate failure produces a `PlanPatch { op: 'insert', nodes: [fix-<findingId>], reason: "<gate>
failed: <F1.message>" }`, which goes through the **patch policy engine** — a fix needing more
permission than the run's ambient level is queued for approval, not auto-applied. Each fix node
performs three steps in order: write a failing test that reproduces the finding, make it pass, then
re-run the gate set **from the deterministic tier**. Re-running from the top is not belt-and-braces:
the new test is part of the deterministic tier, so "fixed" is demonstrated rather than asserted, and
a repair that cannot be expressed as a failing test becomes visible as such — which usually means
the finding belongs in front of a human.

**One finding per fix node**, because a fix node given five findings will fix two, half-fix two and
introduce a sixth. The stable `Finding.id` from KAR-12.3 is what makes the split mechanical.

**Fresh context is not optional**, and the reasons are measured rather than aesthetic: the producing
session has already committed to the reasoning that produced the bug; it is the session most likely
to have compacted away the constraint the bug violates — omission compliance in the surveyed models
fell from **73% at turn 5 to 33% at turn 16** while commission compliance held at 100%, an asymmetry
invisible to ordinary monitoring; and its context is large and mostly irrelevant to a one-line null
check. Attempt N+1 receives the previous attempts' **verdicts** as findings — so it does not repeat
a fix already shown not to work — and **not** their transcripts.

The cap is **3**, matching the scheduler's default `maxAttemptsPerNode`. The third failure emits
`human.requested` carrying all three diffs and all three verdicts. And the loop is subject to the
churn breaker: repair attempts are node attempts, so they land in the scheduler's sliding window of
the last 20 completed attempts, and the same `(node_id, request_hash)` appearing more than 5 times
trips the breaker, transitions the run to `needs_human`, and stops the patch policy engine
auto-applying patches — **including further repair patches**. A repair loop that has become a churn
loop must stop, not accelerate.

**Acceptance criteria**

1. A gate returning `fail` with `n` findings at or above `severityFloor` produces exactly `n` fix
   nodes, one per `Finding.id`, each with the finding id in its node id and the finding's message in
   the patch's `reason`.
2. Findings below `severityFloor` produce **no** fix node, and a `needs-human` verdict produces no
   fix node at all — it opens a human node.
3. Each fix node's packet contains the pinned spec, exactly one `Finding`, the files that finding
   names, and a handle to the failing command's output artifact. It contains no other finding and
   no producer transcript — asserted on the `context.built` manifest.
4. The fix node's ordering is observable, not merely instructed: the node's first commit on
   `DeFlow/<runId>__<nodeId>` adds or modifies a test file and the gate re-run at that commit
   **fails**; the second commit makes it pass. A fix node whose first commit already passes the gate
   is recorded with `repair.no_failing_test` and routed to a human, because a repair that cannot be
   expressed as a failing test is a signal, not a shortcut.
5. After a fix node completes, the gate set re-runs **from the deterministic tier**, not from the
   gate that failed — so a fix that breaks typecheck is caught before the review is paid for again.
6. Attempt 2's packet contains attempt 1's `Verdict` (as findings) and does not contain attempt 1's
   transcript or session. The fix node's `resume` is never `fork` and never resumes the producer.
7. The third consecutive failure emits `human.requested` whose payload carries three diff handles
   and three verdict handles; no fourth attempt is scheduled, and `maxAttemptsPerNode` is not
   consulted as a coincidence — the cap is asserted at 3 with a test that would fail at 4.
8. A repair patch whose `estimate.maxPermission` exceeds the run's ambient level matches the
   `escalates-permission` rule and is **queued for approval**, never auto-applied. The run does not
   stall on it if other branches are runnable.
9. Five occurrences of the same `(node_id, request_hash)` inside the sliding window trip the churn
   breaker: `run.needs_human { reason: 'churn' }` is appended, and the next repair patch is neither
   auto-applied nor silently dropped — it appears in the approval queue.
10. A fix node that writes to `.DeFlow/gates/**` or to a test file the plan marked as a contract
    fails on path scope with `severity: 'error'` **before** its verdict is considered — the
    classic failure is not a human overriding a gate, it is an agent "fixing" the check.
11. Every repair attempt's diff, verdict and finding-id delta (`fixed`, `introduced`, `remaining`)
    are available as a projection, so the diff view can show "attempt 2 fixed `a13f…` and introduced
    `9c02…`" without recomputation.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                        | Red when                                                |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | unit        | `repairPatchesFor(verdict)` returns one patch node per finding at/above the floor, zero for `needs-human`                                                                   | Findings are batched into one node                      |
| 2   | unit        | Attempt-3 exhaustion returns a `human.requested` command, not a fourth fix command                                                                                          | The cap is off by one                                   |
| 3   | unit        | `findingDelta(v1, v2)` over stable ids returns `{ fixed, introduced, remaining }`                                                                                           | Deltas are computed by message equality                 |
| 4   | unit        | Churn window: the same `(node_id, request_hash)` six times → breaker trips, `decide()` returns no auto-apply command                                                        | The breaker counts attempts rather than request hashes  |
| 5   | integration | Real repo, real failing `tsc`: one fix node per error, node ids contain the finding ids                                                                                     | Node identity is positional                             |
| 6   | integration | Mock agent scripted to commit a test then a fix: the gate re-run at HEAD~1 fails and at HEAD passes                                                                         | The ordering is prompt-only                             |
| 7   | integration | Mock agent scripted to commit only a fix: `repair.no_failing_test` and a human node                                                                                         | The shortcut is accepted                                |
| 8   | integration | The gate set re-runs from the deterministic tier — assert the order of `node.scheduled` events after the fix completes                                                      | Only the failed gate re-runs                            |
| 9   | integration | Attempt-2 packet golden snapshot contains verdict-derived findings and no transcript segment                                                                                | Context leaks through the resume strategy               |
| 10  | integration | A repair patch at `full` permission in a `worktree` run lands in the approval queue; the ledger shows `plan.patch.proposed` and no `plan.patched { decision: 'auto' }`      | The repair path bypasses the policy engine              |
| 11  | integration | A fix node attempting to write `.DeFlow/gates/typecheck.yaml` produces a `scope/undeclared-write` finding at `severity: 'error'` and the node fails before `gate.evaluated` | The protected set is advisory                           |
| 12  | e2e         | The `gate-failure-repair` fixture is produced end to end by a real run: fail → fix → pass, and is exported to `test/fixtures/runs/gate-failure-repair/ledger.db`            | The fixture is hand-authored and drifts from the engine |

**Notes / risks** — this is the largest story in the epic and the one most likely to grow. The
temptation is to make the fix node smarter. Resist it: every capability added to the fix node is a
capability that also lets it edit the check. The three-step ordering and the one-finding rule are
the whole design, and both are enforceable from ledger data.

---

### KAR-12.6 — Custom gate discovery from `.DeFlow/gates/`

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P1                                                 |
| **Size**        | S                                                  |
| **Depends on**  | KAR-12.1, KAR-12.4                                 |
| **PRD**         | F7.6                                               |
| **Verified by** | EPIC-12-S36, EPIC-12-S37, EPIC-12-S38, EPIC-12-S39 |

**As** an engineer with a repo that already knows how to check itself, **I want** DeFlow to discover
gate definitions from `.DeFlow/gates/*.{yaml,yml}` and hash them into the run manifest, **so that**
my project's real checks become real gates and nobody can weaken one mid-run without it showing.

F7.6 is P1, but this story is in M1 scope for a reason that is not scope creep: the anti-drift
mechanism it carries — **definitions are hashed into the run manifest at run creation** — is the
same principle as the pinned spec, applied to the checks, and retrofitting a hash after the built-in
gates ship means re-deriving the manifest shape. `gates.loaded` carries the sha256 of every
discovered file; a mid-run edit is a visible divergence between the manifest hash and the file on
disk, reported at the next evaluation and surfaced as `needs-human` rather than silently changing
the contract.

Built-in definitions derived from repo reconnaissance (the scripts that actually exist in
`package.json`) go through the same load path, so there is one parser, one validator and one hash
mechanism rather than two.

**Acceptance criteria**

1. Every `.DeFlow/gates/*.yaml` and `*.yml` file is discovered at run creation, parsed, validated
   against the gate-definition schema, and a `gates.loaded` event is appended carrying
   `{ id, path, sha256 }` for each — including the built-ins, whose `path` names the recon source.
2. A definition failing schema validation names the file, the field and the line, and prevents the
   run from starting. A syntactically invalid YAML file is the same failure, not a skipped file.
3. Editing a gate file after `gates.loaded` produces, at the next evaluation of that gate, a
   `needs-human` verdict with reason `gate-definition-diverged` carrying both hashes. The gate does
   **not** run against the new definition and does not run against the cached one either.
4. `cwd: repo` requires an explicit opt-in in `.DeFlow/config.yaml`; without it a definition
   declaring `cwd: repo` fails load with `GATE_REPO_CWD_NOT_PERMITTED`. `worktree` is the default
   and needs no opt-in.
5. `findings.parser: jsonl` with `path: $.violations` extracts Finding-shaped objects from a custom
   producer's output and produces the same `Finding` shape as a built-in parser, including a
   computed stable `id`.
6. A gate that is defined but was never evaluated in the last N runs is reported by
   `DeFlow doctor` — a gate nothing schedules is decoration. This story specifies the projection and
   its threshold; EPIC-18 mounts the command.
7. Gate first-pass rate is exposed per gate id as a projection over `gate.evaluated`, so both tails
   are visible: below 40% the plan or the spec is wrong; at 100% the gate is either testing nothing
   or being written to.
8. `.DeFlow/gates/**` is asserted to be in the protected path set — a test in this story fails if
   EPIC-08's protected set ever stops containing it, because everything in
   [§9.1](../../10-verification-gates.md) rests on that one rule.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                      | Red when                                                        |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | unit        | Gate-definition schema round-trip over the two worked examples from §2 (`typecheck.yaml`, `bundle-budget.yaml`)           | The schema is looser than the documented examples               |
| 2   | unit        | `cwd: repo` without the config opt-in → `GATE_REPO_CWD_NOT_PERMITTED`                                                     | `cwd` is unvalidated                                            |
| 3   | unit        | `jsonl` parser with `path: $.violations` over a captured custom-producer output                                           | The path expression is ignored                                  |
| 4   | integration | Real `.DeFlow/gates/` directory with three files: `gates.loaded` carries three sha256 values matching `sha256sum` on disk | The hash is computed over parsed YAML rather than bytes         |
| 5   | integration | Edit a gate file mid-run, evaluate: `needs-human` with `gate-definition-diverged` and both hashes                         | Divergence is a warning, or the gate silently uses the new file |
| 6   | integration | Malformed YAML in one of three files → run refuses to start naming that file                                              | Bad files are skipped                                           |
| 7   | unit        | The protected-path assertion: `isProtected('.DeFlow/gates/typecheck.yaml') === true`                                      | EPIC-08's set drifted                                           |
| 8   | unit        | First-pass-rate arithmetic: 3 passes and 4 fails for one gate is 0.43, 1/10 is below the floor, 10/10 is the upper tail    | The metric is computed over all gates jointly                   |
| 9   | integration | The same three rates sampled off a real ledger of 11 runs; widening the window to 11 flips a never-evaluated gate to rated | "The last N runs" is a window over events, or over the wrong order |

**Notes / risks** — the hash must be over **file bytes**, not over the parsed object. A parsed-object
hash normalises away comments, key order and whitespace, which means a reviewer's "temporarily
loosen this" comment edit is invisible — and the whole point is that a mid-run edit is visible.

---

## Risks

| Risk                                                                                                                                                                                | Severity | Mitigation                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **~15 days is at the ceiling of the solo-build guidance**, and KAR-12.5 is the story most likely to grow past its L.                                                                | High     | KAR-12.6 is P1 and is the designated slip: its only M1-critical element is the manifest hash shape, which is one field on `gates.loaded`. Ship that field in KAR-12.1 if the epic runs long, and defer discovery, the divergence path and the doctor report to M2.                                                     |
| **A4-2 — `structured_output` presence on every success is unconfirmed.** F7.3 and F6.9 both rest on it.                                                                             | High     | Answered by M0-S1. The fallback is honest degradation: absent field → `contract.schema-invalid` and `structuredOutput: false` on the capability row. **Never** a prose fallback parser.                                                                                                                                |
| **A0-3 — whether ACP surfaces token usage at all is unverified.** `Verdict.cost.tokens` degrades to absent on the ACP path if it does not.                                          | Medium   | `tokenAccounting: 'exact' \| 'estimated' \| 'none'` on the capability row (EPIC-05), and KAR-12.3 AC-8 requires absence rather than zero. A fabricated cost on a verdict is worse than a gap.                                                                                                                          |
| **A4-1 — Claude Code's result subtypes were decoded from one shipping bundle** (2.1.220) with no compatibility guarantee, and `error_max_structured_output_retries` is one of them. | Medium   | The mapping lives in the adapter conformance suite (EPIC-05 KAR-05.7), so drift is caught by `doctor` rather than by a failed three-hour run.                                                                                                                                                                          |
| **The four-name reconciliation in KAR-12.4 could be deferred and then shipped wrong.** Four names for one relation in three documents is how a schema goes out of sync.             | Medium   | It is a Definition-of-Ready item, not a story task. Decide before anything writes `coveredByGates` to disk.                                                                                                                                                                                                            |
| **Gates that exist but are not treated as real gates** — the social failure mode, which no code change fixes.                                                                       | Medium   | The five mechanisms in [§9.1](../../10-verification-gates.md) are distributed across KAR-12.1 (no override in the data model), KAR-12.5 (agent cannot edit the check), KAR-12.6 (manifest hash, doctor report, first-pass rate). Track the first-pass-rate metric from the first real run; both tails are informative. |
| **The structural tier depends on two other epics' producers** (EPIC-07's `merge-tree`, EPIC-08's path-scope diff), so EPIC-12 can be blocked by either.                             | Medium   | The ladder is testable with stubbed structural producers at unit level, so KAR-12.1 and KAR-12.2 can proceed while EPIC-07 KAR-07.6 lands. Only the integration tests block.                                                                                                                                           |

---

**Related:** [Flows](../flows/EPIC-12-verification-gates-flows.md) · [Board](../board.md) ·
[Verification gates](../../10-verification-gates.md) ·
[Planning and replanning](../../06-planning-and-replanning.md) ·
[Human in the loop](./EPIC-13-human-in-the-loop.md) ·
[Testing strategy](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
