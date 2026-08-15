# Verification gates

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This document answers one question: **how does DeFlow know the work is actually done?**

The spec-driven-development literature surveyed in PRD §4.5 converges on a small set of answers —
acceptance criteria defined before any code, the author cannot be the judge, surgical fix loops, hard
build gates — and on a matching set of failure modes: shallow specs, spec-then-drift, false precision
from EARS notation, and _gates that exist but are not treated as real gates_. Everything below is
either one of those answers made mechanical, or one of those failure modes designed against.

---

## 1. The gate ladder: cheapest and least arguable first

A gate is a `PlanGraph` node of type `gate` (F2.3) that emits a typed `Verdict` (§4). Gates come in
four classes and they are ordered deliberately.

| Class                         | Examples                                                                     | Cost                          | Verdict source                    |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | --------------------------------- |
| **Deterministic** (F7.1)      | typecheck, lint, unit, integration, build, custom scripts                    | seconds to minutes, $0        | process exit code + parsed output |
| **Structural**                | `git merge-tree` conflict probe, path-scope check, handoff schema validation | milliseconds, $0              | computed by DeFlowd               |
| **Adversarial review** (F7.2) | a critic agent on a different session and provider                           | minutes, real money           | agent, schema-enforced verdict    |
| **Human** (F8.1)              | approval, judgement calls, anything marked `needs-human`                     | unbounded, durable suspension | a person                          |

**Deterministic gates run first, and the sequence short-circuits.** The scheduler orders a milestone's
gate set `deterministic → structural → adversarial → human`, and the first `fail` stops the rest.
The reason is economics rather than purity: there is no point paying a model to review code that does
not typecheck, and the resulting review is actively harmful — a reviewer looking at broken code
spends its attention on the breakage and misses the design problem you needed it to find.

Deterministic gates are also the only gates that are **not subject to model opinion**. `tsc` returns
the same exit code today and next month. That property is worth more than it sounds: it means the
milestone-advance rule below can be enforced by the reducer rather than negotiated.

### The milestone rule

> **A milestone does not advance until every gate in its `requires` list has a `pass` verdict recorded
> at a ledger offset after the last write to the paths in its scope.**

Two halves, both load-bearing. The first half is F7.1's "no milestone advances until typecheck +
tests + build pass". The second half — _after the last write_ — is what stops a stale green from
carrying a milestone. A `pass` from before the last three commits proves nothing, and it is exactly
the shape a run drifts into when a repair loop touches files after the gate ran.

There is deliberately **no override flag in the data model.** The only path past a failing gate is a
`human` node whose response is itself a ledger event, attributed and timestamped. See §9.

---

## 2. Deterministic gates and custom gate definitions (F7.1, F7.6)

DeFlow ships built-in gate definitions derived from repo reconnaissance (the scripts that actually
exist in `package.json`), and discovers repo-specific ones from `.DeFlow/gates/*.{yaml,yml}` (F7.6).

A worked definition:

```yaml
# .DeFlow/gates/typecheck.yaml
id: typecheck
kind: deterministic
title: TypeScript project check
run: pnpm exec tsc -p tsconfig.json --noEmit
cwd: worktree # worktree | repo — 'repo' requires explicit opt-in
timeout: 300s
effect: pure # pure | mutating. A gate MUST be pure. See §8.
permission: worktree # gates obey the same ladder as any other node (F5.4)
expect:
  exitCode: 0
findings:
  parser: tsc # tsc | eslint-json | biome-json | vitest-json | junit-xml | jsonl | none
satisfies: [AC-3, AC-7] # acceptance criterion ids from the pinned TaskSpec
severityFloor: error # findings below this do not fail the gate
```

And one with a custom producer, for the cases the built-in parsers do not cover:

```yaml
# .DeFlow/gates/bundle-budget.yaml
id: bundle-budget
kind: deterministic
title: Bundle size budget
run: node scripts/bundle-budget.mjs --json
cwd: worktree
timeout: 120s
effect: pure
expect:
  exitCode: 0
findings:
  parser: jsonl # each line is a Finding-shaped object
  path: $.violations
satisfies: [AC-11]
```

**Definitions are hashed into the run manifest at run creation.** DeFlow emits a `gates.loaded` event
carrying the sha256 of every discovered file. A mid-run edit to a gate file therefore does not
silently change the contract — it is a visible divergence between the manifest hash and the file on
disk, reported at the next evaluation and surfaced as `needs-human`. This is the same anti-drift
principle as the pinned spec, applied to the checks.

**Gate commands are code from the repository and are treated as such.** They run under the same
execution boundary as any other node (F5.6): `worktree` permission by default, `worktree+net` or
`full` requiring the same explicit per-run opt-in, and the F5.6 deny list applying unchanged. A gate
that wants to run a migration against a database is not a gate; it is an infrastructure action
wearing a gate's clothing. See [workspace and safety](./09-workspace-and-safety.md) and
[the security model](./15-security-model.md).

---

## 3. Independent adversarial review (F7.2)

> The producing agent cannot judge its own output. PRD §4.5 identifies this as the strongest single
> quality lever in the SDD literature.

"Preferably a different provider" is a routing decision. "A different session" is a hard scheduling
precondition. Both are checked, not assumed.

### 3.1 Routing by provider

The reviewer's provider is selected from the probed capability rows (see
[the provider adapter layer](./07-provider-adapter-layer.md)) with a preference for
`provider ≠ producer.provider`, subject to the same F3.5 capability check every node gets — the
reviewer must support structured output, must support the requested permission level, and must have
enough context for the packet.

If only one provider is healthy (NF7 degradation), fall back to same-provider-different-session and
record `weakened: 'same-provider'` on the verdict. The acceptance board and the diff view render that
marker. **Do not silently accept a weakened review** — the whole value of F7.2 is that you can trust
a green review, and a review you cannot distinguish from a self-assessment does not carry that trust.

### 3.2 Guaranteeing a different session

```ts
// checked in decide(), before the node is admitted — not a convention, a precondition
function assertIndependentReview(review: PlanNode, s: RunState): void {
  const producer = s.nodes[review.reviews];
  if (review.resolvedSessionId === producer.resolvedSessionId) {
    throw new SchedulingRefused("REVIEW_SESSION_NOT_INDEPENDENT", review.id);
  }
  if (review.resume?.kind === "fork" || review.resume?.of === producer.id) {
    throw new SchedulingRefused("REVIEW_INHERITS_PRODUCER_CONTEXT", review.id);
  }
}
```

Session ids are knowable on both adapter paths:

- **ACP path.** `session/new` returns a fresh `sessionId` per session. DeFlow records it on
  `node.started`.
- **CLI shim path.** Claude Code accepts a client-chosen `--session-id <uuid>`, and it is **verified
  2026-08-02** that the supplied uuid is honoured verbatim in every emitted frame. Gemini CLI
  likewise takes `--session-id <uuid>`. So DeFlow mints the uuid and can assert on it rather than
  parsing it back out and hoping.

The second check matters as much as the first. `claude-agent-acp` and `opencode acp` both advertise
`session.fork` (**verified 2026-08-02**), and forking is a tempting way to give the reviewer
"context". A fork inherits the producer's reasoning wholesale and defeats the entire mechanism.
Forking is legitimate for continuation work; it is forbidden for review.

### 3.3 What the reviewer gets

The reviewer's context packet contains the pinned spec, the diff, the deterministic and structural
gate output, and nothing else. Specifically **not** the producer's transcript. F6.1's "no implicit
context inheritance" is doing real work here: a reviewer that has read the producer's rationale is
primed to accept it.

---

## 4. Typed verdicts with structured findings (F7.3)

Never a prose blob. A prose verdict cannot be attached to a line in a diff, cannot be deduplicated
across repair attempts, cannot be counted, and cannot be traced to an acceptance criterion.

```ts
type Verdict = {
  gate: GateId;
  node: NodeId; // the node under test
  verdict: "pass" | "fail" | "needs-human";
  specHash: string; // sha256 of the pinned TaskSpec this was judged against
  criteria: Array<{
    id: string; // 'AC-3'
    status: "satisfied" | "unsatisfied" | "unverifiable";
    evidence: Handle[];
  }>;
  findings: Finding[];
  weakened?: "same-provider" | "single-attempt";
  cost: { tokens?: TokenUsage; usd?: number; durationMs: number };
};

type Finding = {
  id: string; // stable: sha256(gate|file|rule|normalisedMessage).slice(0,12)
  severity: "error" | "warning" | "info";
  file: string; // repo-relative, POSIX separators
  blobSha: string; // the exact blob the range refers to — see §7
  range: {
    startLine: number;
    startCol?: number;
    endLine?: number;
    endCol?: number;
  };
  rule: string; // 'ts2345' | 'no-floating-promises' | 'merge/conflict'
  message: string;
  criterion?: string; // the AC id this bears on
  suggestedFix?: { patch: string };
  artifact?: Handle; // handle to the full log
};
```

**The stable `id` is the detail everything else hangs off.** It is how attempt 2 of a repair loop is
known to have fixed finding `a13f…` and introduced `9c02…`; how the diff view deduplicates the same
lint error across four attempts; and how the churn detector recognises that the same failure keeps
recurring.

### Enforcing the shape

For agent-produced verdicts, the schema is enforced at the adapter boundary, not by prompt:

1. Author `Verdict` in Zod 4.4.3, emit with `z.toJSONSchema()` to
   `.DeFlow/schemas/verdict.schema.json` so it is inspectable on disk (NF8).
2. Pass it natively: Claude Code takes `--json-schema <schema>` and returns the parsed object in the
   result envelope's `structured_output` field; Codex takes `--output-schema <FILE>`. **Verified
   2026-08-02.**
3. Validate with Ajv 8.20.0 (`strict: true`, `allErrors: true`) plus `ajv-formats@3.0.1` against JSON
   Schema 2020-12 — the same dialect MCP tool `inputSchema` defaults to, so one dialect covers the
   MCP host and the handoff contracts alike.
4. Claude Code runs its own internal schema-repair loop and surfaces exhaustion as the result subtype
   `error_max_structured_output_retries`. Map it straight onto a node failure with
   `reason: 'schema-repair-exhausted'` — do not retry over the top of a retry.

### Return budget

A gate verdict is small. Set `returns.maxTokens: 600` for gate nodes (typical verdicts land around
300; the headroom is for findings-heavy failures) against the 500–2,000 default band in F6.4. Count
the serialised `structured_output` with the Tier-2 tokenizer, and on overrun emit `handoff.oversize`
and run **one** bounded re-prompt asking for compression, then hard-fail. **Never truncate.**
Truncating a JSON payload produces invalid JSON downstream, which is precisely the silent propagation
of garbage F6.9 forbids.

Telemetry: a `gate` node emits an OTel span `execute_tool <gateId>` with the standard
`gen_ai.*` attributes plus a DeFlow-namespaced `DeFlow.gate.verdict`. Do not invent `gen_ai.*` names
for DeFlow concepts. See [observability](./13-observability-and-telemetry.md).

---

## 5. Acceptance-criteria traceability and the anti-drift mechanism (F7.4, F1.5)

### 5.1 Every criterion maps to at least one gate

Each criterion in the `TaskSpec` carries an id and a `verifiedBy: GateId[]`. Plan validation (see
[planning and replanning](./06-planning-and-replanning.md) §3.4) **fails** if a criterion has an
empty `verifiedBy` and is not explicitly marked:

```yaml
acceptanceCriteria:
  - id: AC-3
    text: "All 47 components under packages/ui/src/** compile under Vue 3 with no type errors."
    verifiedBy: [typecheck, build]
  - id: AC-9
    text: "The migrated date picker feels as responsive as the old one."
    unverifiable: true
    reason: "Subjective. No harness exists. Route to a human node at the end of the milestone."
    verifiedBy: [human-review-ui]
```

A criterion nothing checks is a lie on the acceptance board (F10.8). Forcing the author to either
name a gate or write the word `unverifiable` and a reason is a ten-second cost that removes an entire
class of false confidence. The board renders `satisfied`/`unsatisfied`/`unverifiable` in three
distinct states — F10.8 already specifies exactly this — so unverifiable criteria are visible rather
than quietly counted as green.

### 5.2 Gates evaluate against the pinned spec, not the current code

This is the anti-drift mechanism, and drift is the failure mode PRD §4.5 describes as _"the spec
launches the session and the code silently becomes the source of truth again the moment generation
starts."_ It is subtle because nothing visibly breaks — the reviewer reads the code, forms a model of
what the code is trying to do, and judges the code against that model. It always passes.

Four concrete mechanisms:

1. **The verdict carries `specHash`.** If it does not equal the run's current pinned `specHash`, the
   verdict is **void** and the gate is re-run. This catches a spec edited mid-run.
2. **The reviewer's packet contains the pinned segments first and verbatim.** Pinned segments are
   `TaskSpec` goal and non-goals, acceptance criteria, safety constraints, declared path scopes and
   the node's permission level. They are never eligible for compaction. See
   [context and memory](./08-context-and-memory.md).
3. **Pin integrity check.** After rendering, assert that the sha256 of every pinned segment's text
   still appears in the outgoing prompt. On mismatch, fail the node with `pin.integrity_violated`
   rather than proceeding. It is about fifteen lines and it matters most here, because a review gate
   whose acceptance criteria were compacted away is a review gate that has silently become a
   code-reads-well check.
4. **Prohibitions restated as requirements, mechanically, in the packet builder.** The measured
   asymmetry is that prohibitions decay under context pressure while requirements persist. So the
   reviewer is told _"judge each finding against AC-3 as written above"_, not _"do not judge against
   the code"_.

The reviewer is also given the criteria as its output obligation: the `criteria[]` array in the
verdict is required, and a criterion the reviewer omits is treated as `unverifiable`, not as
satisfied.

---

## 6. Structural gates: merge conflicts and path scope

### 6.1 `git merge-tree` is ground truth (D14)

DeFlow runs `git merge-tree --write-tree` between the run's integration branch and each node's branch
(`DeFlow/<runId>__<nodeId>`, flat naming per **D13**). A conflicted result is a gate failure with
findings at the conflicting paths and `rule: 'merge/conflict'`.

This runs **before** the adversarial review, in the structural tier. Paying a model to review work
that cannot land is pure waste, and the finding you want ("this conflicts with the auth refactor on
the other branch") is not one a reviewer looking at a single diff can produce.

Exact invocation, exit-code interpretation and the branch/worktree lifecycle are in
[workspace and safety](./09-workspace-and-safety.md).

### 6.2 Path-scope violations are warnings, relative to merge-tree

F5.3 says a write node declares the paths it may modify and violations surface as a gate failure.
D14 refines this: **declared path scopes are a plan-time prediction, not ground truth.** The
violation set is `changedFiles(nodeBranch) \ declaredScope`, and it is emitted as
`severity: 'warning'`, `rule: 'scope/undeclared-write'`. A warning does not fail the gate on its own.

It is promoted to `severity: 'error'` in exactly three cases:

1. `git merge-tree` reports a conflict at that path — the prediction was wrong _and_ it cost something.
2. The path is outside the node's worktree, or outside the repository.
3. The path is in the run's protected set: `.DeFlow/**` (including gate definitions — see §9),
   lockfiles the node did not declare, CI configuration, and anything matching the F5.6 execution
   boundary deny list.

The rationale is behavioural. A write node that touched one extra import site is normal and often
correct. Hard-failing there teaches you to declare `src/**` on every node, at which point path scopes
mean nothing and you have lost both the prediction and the ground truth. Conflicts are what actually
break a run, so conflicts are what fail a gate.

Violations are never free, though: they always appear in the diff view, and they always feed the
blast-radius estimate the patch policy engine uses for the next `PlanPatch`
([planning and replanning](./06-planning-and-replanning.md) §4.3).

---

## 7. The surgical repair loop (F7.5)

A gate failure spawns a fresh, narrowly-scoped fix node. One issue. Regression test first. Capped at
3 attempts. Then escalate.

```
gate fail (findings F1..Fn)
   └─▶ PlanPatch { op:'insert', nodes:[fix-<findingId>], reason: "<gate> failed: <F1.message>" }
          └─▶ patch policy engine        # a fix needing more permission is NOT auto-applied
                 └─▶ fix node, attempt 1
                        1. write a failing test reproducing F1
                        2. make it pass
                        3. re-run the gate set from the deterministic tier
                 └─▶ attempt 2, attempt 3 …
                        └─▶ 3rd failure → human.requested (F8.1) with all 3 diffs + all 3 verdicts
```

**One finding per fix node.** A fix node given five findings will fix two, half-fix two, and
introduce a sixth. The stable `Finding.id` is what makes the split mechanical.

**Step 3 is a second `PlanPatch`, not a re-admission.** The ladder records an outcome per *gate
node* (`admitGates`), so a node that answered `fail` is answered for ever and re-admitting it is not
available. The re-run is therefore a **fresh gate node** — `<gate-node>-r<round>`, carrying the same
definition and the same `criteria` — whose `deps` are the fix nodes, proposed alongside an
`abandon-branch` that retires the answered one. Two consequences are the point: the re-run cannot
run against the tree the producer left (which is §5.2's
stale green), and the change reaches the plan through the policy engine and the single plan-write
seam like every other patch, so it is visible in the plan scrubber with a reason beside it. This is
also why the milestone rule is stated over gate **ids** rather than node ids: the same definition is
scheduled more than once across a repair loop.

**Regression test first, always.** The gate re-run after the fix includes the new test, so "fixed" is
demonstrated rather than asserted. This also means a repair that cannot be expressed as a failing
test is visible as such, and usually indicates the finding belongs in front of a human.

**Cap of 3**, matching the scheduler's default `maxAttemptsPerNode`. Attempt N+1 receives the
previous attempts' **verdicts** as findings — so it does not repeat a fix already shown not to
work — but **not** their transcripts.

**Why fresh context is not optional.** Three independent reasons:

- The producing session has already committed to the reasoning that produced the bug. Asking it to
  find the bug is asking it to disagree with itself, which is the same asymmetry F7.2 exists to break.
- The producing session is the one most likely to have compacted away the constraint the bug violates.
  The measured shape of the problem is severe: omission compliance in the surveyed models fell from
  73% at turn 5 to 33% at turn 16, while commission compliance held at 100% — an asymmetry invisible
  to ordinary monitoring, because the healthy-looking signals stay healthy. A fresh node is at turn 0.
- The producing session's context is large and mostly irrelevant to a one-line null check. A narrow
  packet — pinned spec, one `Finding`, the files it names, the failing command's output artifact — is
  both cheaper and measurably more reliable.

**Interaction with the churn detector.** Repair attempts are node attempts, so they land in the
scheduler's sliding window of the last 20 completed attempts. The same `(node_id, request_hash)`
appearing more than 5 times trips the circuit breaker, the run goes to `needs_human`, and the patch
policy engine stops auto-applying patches — including further repair patches. A repair loop that has
become a churn loop must stop, not accelerate. See
[planning and replanning](./06-planning-and-replanning.md) §7.

---

## 8. Gate results in the diff view (F7.7) and what the API must provide

F7.7 wants review to show code and verdict together. That imposes three concrete requirements.

**1. Findings must be addressable and queryable by file.** Verdicts arrive as `gate.evaluated` ledger
events, so the diff view is a projection like every other view (NF10) and needs no polling. The flat
read endpoints, per [the API and realtime contract](./11-api-and-realtime.md):

```
GET /api/runs/:id/gates?node=<nodeId>              → Verdict[] with typed findings
GET /api/runs/:id/findings?file=<repoPath>         → Finding[] grouped by file, ordered by line
GET /api/runs/:id/diff?node=<nodeId>               → unified diff + per-hunk line map + blobShas
```

**2. Line numbers must be anchored to a blob, not to "the current file".** This is the field that
makes the feature work and it costs one string: every `Finding` carries `blobSha` for the exact
revision its `range` refers to. When the diff view renders a later revision, findings whose `blobSha`
no longer matches the rendered blob are shown as _"stale — from attempt 2"_ in the margin rather than
being drawn against whatever line now happens to occupy that number. Without it, the second repair
attempt silently attaches every earlier finding to the wrong lines, and the reviewer stops trusting
the annotations within about ten minutes.

**3. Large evidence lives behind handles, not in the event.** Any payload over ~256 KiB — full test
logs, whole-file dumps, terminal captures — is written to the content-addressed blob store and the
finding carries `{ sha256, bytes, mime, head, tail }`, head and tail being the first and last ~2 KiB
so the UI renders a preview without touching disk. Content addressing deduplicates the identical
failing test log across three repair attempts, which is the common case. This also keeps the ledger
small enough that crash-restart replay stays fast — replay time is a function of event-log size, and
un-spilled tool output is what makes it explode.

The acceptance criteria board (F10.8) is the same data pivoted: group `Verdict.criteria` across all
gates by criterion id, take the latest non-void verdict per gate, and render satisfied / unsatisfied /
unverifiable with the evidence handles behind each. See
[frontend architecture](./12-frontend-architecture.md).

---

## 9. Designing against PRD §4.5's failure modes

### 9.1 Gates that exist but are not treated as real gates

The most common way a verification system fails is socially, not technically. The gate is defined,
runs, goes red, and everybody learns to click past it.

Five mechanisms, in order of how much they actually help:

1. **The agent may not edit gate definitions or tests-as-contract.** `.DeFlow/gates/**` is in the
   protected path set (§6.2), so a write there is a hard `error`, not a warning. This is the real
   defence: the classic failure is not a human overriding a gate, it is an agent "fixing" the check.
   A repair node that modifies the assertion instead of the code fails on path scope before its
   verdict is even considered.
2. **There is no override flag.** The reducer advances a milestone on `pass` verdicts and on nothing
   else. Passing a red gate requires a `human` node, whose response is a ledger event with an
   identity and a timestamp attached. Overriding is possible — it must be, or the tool is unusable —
   but it is never invisible.
3. **Gate definitions are hashed into the run manifest** (§2), so weakening a gate mid-run is a
   visible divergence rather than a quiet edit.
4. **`deflow doctor` reports gates that are defined but were never evaluated** in the last N runs.
   A gate nothing schedules is decoration.
5. **Track gate first-pass rate as a first-class metric** (PRD §12 target: > 40%). Both tails are
   informative. Below 40% and the plan or the spec is wrong. At 100%, the gate is either testing
   nothing or being written to — investigate rather than celebrate.

### 9.2 False precision from EARS notation

EARS-style criteria read as testable and frequently are not:

> _WHEN the user submits an invalid form, THE system SHALL display an error within 200ms._

That sentence has the grammar of a test and none of the machinery. There is no harness that measures
it, no definition of which 200ms, and no agreement on what "display an error" means. It will be
marked satisfied by a reviewer who read the code and found a `setError` call.

Four mitigations, all cheap:

- **Every criterion names its gate or is marked `unverifiable`** (§5.1), enforced at plan validation.
  A timing claim with no harness cannot name a gate, so it must be marked — and once marked, it
  renders in its own column instead of counting as green.
- **The framing interview asks, per criterion: "what command would prove this?"** The answer becomes
  the gate's `run` line, or the criterion is downgraded on the spot. This is the single highest-value
  question in the interview.
- **Prefer criteria that name a command over criteria that name a quality.** "`pnpm test:a11y` exits
  0" is worth more than "the component is accessible", even though it covers less — because it covers
  what it claims to cover.
- **A reviewer may return `unverifiable` for a criterion, and that is a first-class outcome.** A
  gate forced to choose between `satisfied` and `unsatisfied` for an unmeasurable claim will pick
  one, and the one it picks tells you nothing.

---

## 10. Pitfalls

- **Do not run an adversarial review before the deterministic tier is green.** It costs money and
  produces a worse review.
- **Do not fork or resume the producer's session for the reviewer.** Two adapters advertise
  `session.fork` and it is the obvious-looking way to give the reviewer context. It inherits the
  producer's reasoning and voids F7.2 entirely. The scheduling precondition in §3.2 is there to make
  this impossible rather than discouraged.
- **Do not let a gate mutate the repository.** Gates are classified `effect: pure` — safe to re-run,
  cost is time only. A gate that writes cannot be re-run to confirm a fix, which is its whole job.
- **Do not accept a prose verdict.** Enforce the schema natively with `--json-schema` /
  `--output-schema` and validate with Ajv. Parsing findings out of prose breaks on the next CLI
  release.
- **Do not truncate an oversize verdict.** Truncated JSON is invalid JSON, and F6.9 exists to stop
  invalid output entering the blackboard. One bounded compression re-prompt, then fail.
- **Do not treat declared path scope as ground truth.** `git merge-tree --write-tree` is ground truth
  (**D14**); scope is a prediction. Hard-failing on scope alone trains you to declare `src/**`.
- **Do not evaluate a gate against the current code.** Against the pinned spec, with the `specHash`
  recorded on the verdict, or you have built an elaborate machine for confirming that the code does
  what the code does.
- **Do not attach findings to line numbers without a `blobSha`.** They will silently point at the
  wrong lines after the first repair attempt.
- **Do not invent `gen_ai.*` attribute names for gate concepts.** `DeFlow.gate.verdict` and the rest
  of the `DeFlow.*` namespace. The GenAI conventions are all Development-stability and rename without
  a major bump; owning your own namespace is how you avoid being broken by that.
- **Do not let an agent write to `.DeFlow/gates/`.** Everything in §9.1 rests on this one rule.

---

**Related:** [Planning and replanning](./06-planning-and-replanning.md) ·
[Context and memory](./08-context-and-memory.md) ·
[Workspace and safety](./09-workspace-and-safety.md) ·
[API and realtime](./11-api-and-realtime.md) · [Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
