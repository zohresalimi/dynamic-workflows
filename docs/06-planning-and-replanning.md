# Planning and replanning

> Part of the [Karvan architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the document for Karvan's central claim. Every competitor in the category either has no plan
at all (session managers) or has a plan that is frozen the moment it is written (workflow runners).
Karvan's plan is **data**, it is **validated before a token is spent**, and it **mutates at runtime
through auditable patches**. PRD §3.2 G1 identifies static plans as the critical gap; this is the
mechanism that closes it.

Read [the domain model](./04-domain-model.md) for the exact shapes of `TaskSpec`, `PlanGraph` and
`PlanPatch`, and [durable execution](./05-durable-execution.md) for how plan versions are stored and
how `decide()` consumes them. This document covers how a plan is born, how it is checked, and how it
changes.

---

## 1. Intake and framing

### 1.1 Intake (F1.1)

A task arrives as free text, a file path, a git issue reference, or a spec document. Intake does
exactly one thing: normalise the input into a `task.submitted` event carrying the raw source plus its
provenance. No interpretation happens here. The raw text is pinned and survives every later
transformation, so "what did I actually ask for?" is always answerable from the ledger.

### 1.2 The framing interview (F1.2)

A framing agent then interrogates the task **and the repo** and produces a `TaskSpec`:

| Field | Notes |
|---|---|
| `goal` | One paragraph. Pinned, never compacted. |
| `scope` / `nonGoals` | Explicit boundaries. Non-goals are the field people skip and regret. |
| `constraints` | Safety constraints, protected paths, permission ceiling for the run. |
| `priorDecisions` | Facts from `.karvan/memory/` (F6.8) and from the repo's own docs. |
| `acceptanceCriteria` | `AC-1 … AC-n`, each with `verifiedBy: GateId[]` or an explicit `unverifiable` reason. |
| `knownFailureModes` | What "went wrong" looks like for this task archetype. |

The framing agent runs at `read` permission (F5.4) in a fresh session. It is the one place where a
model is allowed to be expansive, because everything downstream is judged against what it produces.

The acceptance-criteria contract is load-bearing and it is enforced structurally, not by exhortation:
**every criterion must either name at least one gate or be explicitly marked unverifiable with a
reason.** Plan validation (§3) rejects a plan where a criterion has an empty `verifiedBy` and no
`unverifiable` flag. See [verification gates](./10-verification-gates.md) §5 for the traceability
rules and for why EARS-style criteria create false precision if you skip this.

### 1.3 The approval gate is real (F1.3)

The `TaskSpec` is presented for human edit and explicit approval before any execution. This is
implemented as a blocking `human` node (F8.1), suspended durably — a row in `node_wake`, zero CPU,
survives laptop sleep and daemon restart (see [durable execution](./05-durable-execution.md) §
scheduler). A six-hour think about a spec costs one SQLite row.

It is not ceremony. PRD §4.5 surveys every major spec-driven-development framework and finds them
unanimous: **shallow specs are the primary documented failure mode**, ahead of bad models, bad
prompts and bad tooling. The failure is cheap to produce and expensive to discover — a plausible,
under-specified spec generates a plausible, under-specified plan, which generates forty nodes of
confidently wrong work. The second documented failure, *spec-then-drift*, is what §5 of this document
and F1.5 exist to prevent.

Two design consequences follow:

- **Approval mints the pinned spec.** On approval, Karvan computes `specHash = sha256(canonical(spec))`
  and writes `spec.pinned`. Every context packet re-injects the pinned segments verbatim, and every
  gate verdict carries the `specHash` it was judged against. A verdict whose `specHash` does not match
  the run's is void.
- **Editing the spec mid-run is a first-class operation, not a hack.** It produces a new `specHash`, a
  new `spec.pinned` event, and — because gates and plan validation both key on the spec — a mandatory
  plan revalidation. If revalidation fails, the run goes to `needs_human` rather than continuing
  against a spec it no longer satisfies.

---

## 2. Compiling the plan

### 2.1 Planner inputs (F2.2)

The planner agent receives exactly three things, and nothing else (F6.1, no implicit inheritance):

1. **The pinned `TaskSpec`.**
2. **Repo reconnaissance** — a structured survey produced by one or more `read`-permission recon
   nodes: language and toolchain detection, the scripts in `package.json`, test/lint/build commands
   that actually exist, directory shape, the size of the areas the spec names, and any
   `.karvan/gates/` definitions already present in the repo.
3. **The provider capability list** — see below. This is the input people get wrong.

### 2.2 Capabilities are probed, never hardcoded

**Verified 2026-08-02.** Karvan performs an ACP `initialize` handshake against each installed agent
binary and persists the full response:

```sql
CREATE TABLE provider_capabilities (
  provider      TEXT NOT NULL,
  version       TEXT NOT NULL,      -- from the binary's own --version
  binary_path   TEXT NOT NULL,      -- absolute, resolved once; karvand's PATH != the user's login shell
  binary_sha256 TEXT NOT NULL,
  caps_json     TEXT NOT NULL,      -- the verbatim initialize response
  probed_at     INTEGER NOT NULL,
  PRIMARY KEY (provider, version)
) STRICT;
```

Every routing decision — can this node resume? can it fork? does the adapter accept structured
output? what is its max context? — reads that row. **A hardcoded capability matrix will be wrong
within a month.** The matrix measured on 2026-08-02 already differs from what the vendor docs imply:

| Adapter | Version | `session.resume` | `session.fork` | `session.list` | `mcp.sse` |
|---|---|---|---|---|---|
| `claude-agent-acp` | 0.64.1 | yes | yes | yes | yes |
| `codex-acp` | 1.1.9 | yes | no | yes | `false` |
| `opencode acp` | 1.18.11 | yes | yes | yes | yes |
| `copilot --acp` | 1.0.77 | **no** | no | yes | yes |
| `gemini --acp` | 0.53.1 | **no** | no | **no** | yes |

Two of five providers cannot resume a session at all. Gemini returned no `sessionCapabilities` key
whatsoever. Any planner that assumes a uniform capability surface will schedule nodes that cannot
run. See [the provider adapter layer](./07-provider-adapter-layer.md) for the full probe protocol and
the conformance suite that keeps the table honest.

### 2.3 Output: `PlanGraph` v1

The planner emits a `PlanGraph` as **structured output enforced at the adapter boundary**, not as
prose we parse. Claude Code takes `--json-schema <schema>` and returns the parsed object in the
result envelope's `structured_output` field; Codex takes `--output-schema <FILE>`. **Verified
2026-08-02.** Schemas are authored in Zod 4.4.3 and emitted with `z.toJSONSchema()` into
`.karvan/schemas/` so they are inspectable on disk (NF8), then validated with Ajv 8.20.0
(`strict: true`, `allErrors: true`) against JSON Schema 2020-12.

Each node carries, at minimum: `id`, `type` (F2.3: `agent | tool | gate | human | map | loop |
subgraph`), `deps`, declared `reads` and `writes` (F6.2), `pathScope` for write nodes (F5.3),
`permission` (F5.4), `provider` requirements, `returns: { schemaId, maxTokens }` (F6.4), and
`maxAttempts`.

The plan document is immutable and content-addressed:

```ts
const doc = canonicalJson(plan);                       // sorted keys, no insignificant whitespace
const hash = createHash('sha256').update(doc).digest('hex');
```

Use `node:crypto` over a canonical serialiser you own. **Do not use `ohash` for this hash.** Its
stable-key-ordering behaviour is confirmed, but its README only promises "best efforts" at stable
serialisation — acceptable for change detection, not for a value that is a primary key in the `plan`
table and is referenced by `run.plan_hash` across karvand versions.

---

## 3. Plan validation, before a token is spent

This is the cheapest correctness gate in the system and it runs on **every** plan version — v1 and
every patched successor. ODW's `validate` and `doctor` commands are the right economics (PRD §3.1);
this is that idea taken further.

### 3.1 Reachability of declared reads (F6.2)

Walk the DAG in topological order and assert that every node's declared `reads` are satisfied by some
ancestor's declared `writes`, or by the pinned spec. It is pure graph reachability — roughly 60 lines:

```ts
export function validateReads(plan: PlanGraph, spec: PinnedSpec): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const order = topoSort(plan);                 // throws PlanCycleError if not a DAG
  const specKeys = new Set(spec.providedKeys);  // 'spec/goal', 'spec/ac/AC-3', 'spec/pathscope', ...

  for (const id of order) {
    const node = plan.nodes[id];
    const available = new Set(specKeys);
    for (const anc of transitiveAncestors(plan, id)) {
      for (const w of plan.nodes[anc].writes) available.add(w);
    }
    for (const r of node.reads) {
      if (!satisfies(available, r)) {           // exact key or a declared glob prefix
        diags.push({ severity: 'error', code: 'READ_UNREACHABLE', node: id, key: r,
          message: `node '${id}' reads '${r}' but no ancestor writes it and it is not in the pinned spec` });
      }
    }
  }
  return diags;
}
```

An undeclared read is a plan validation failure before a single token is spent. At 40 nodes the
transitive closure is free; do not optimise it.

The same walk produces two more checks for nothing:

- **Cycle detection.** `topoSort` throwing is the check.
- **Orphan writes.** A node that writes a key nothing reads is a `warning`, not an error — it is
  usually a leftover from a patch, occasionally deliberate.

### 3.2 Adapter capability checks (F3.5)

Do not schedule a node onto an adapter that cannot honour its requirements. Read the probed
capability row, never a constant:

```ts
for (const node of agentNodes(plan)) {
  const caps = capabilityRow(node.provider);                 // from provider_capabilities
  if (!caps) err('PROVIDER_NOT_PROBED', node);
  if (node.returns?.schemaId && !caps.structuredOutput) err('NO_STRUCTURED_OUTPUT', node);
  if (node.requiresResume && !caps.session.resume) err('NO_RESUME', node);
  if (!caps.permissionLevels.includes(node.permission)) err('PERMISSION_UNSUPPORTED', node);
  if (estimatePacketTokens(node) > caps.maxContext * 0.6) err('PACKET_EXCEEDS_BUDGET', node);
}
```

F5.4 is explicit that where a provider cannot express the requested permission level, Karvan
**refuses to schedule** rather than silently escalating. `PERMISSION_UNSUPPORTED` is that refusal,
moved to plan time where it costs nothing. `PACKET_EXCEEDS_BUDGET` uses the 60% ceiling from the
packet-assembly policy in [context and memory](./08-context-and-memory.md).

`NO_RESUME` is a soft error: a node that merely benefits from resume falls back to replay-from-ledger
(the `ResumeByReplay` strategy). It is a hard error only for nodes that declare `requiresResume`.

### 3.3 Identifier validation

Node ids become git branch names, worktree directory names and artifact paths. Branch naming is flat
(**D13**): `karvan/<runId>__<nodeId>`. The PRD's `karvan/<run-id>/<node-id>` is a verified bug — git
refs are files in a directory tree, so `karvan/r1/n1` and a run-level `karvan/r1` integration branch
cannot both exist.

Validate the resulting ref with git itself rather than reimplementing its rules:

```bash
git check-ref-format "refs/heads/karvan/${runId}__${nodeId}"   # exit 0 = valid
```

Then apply a stricter Karvan-side charset on top, because the id is also a directory name on
case-insensitive filesystems and a URL path segment in the API:

```ts
const ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
```

Reject duplicates case-insensitively. This catches the entire class of "the run died at node 31
because the id had a colon in it" three seconds after the planner returns.

### 3.4 Criteria coverage (F7.4)

Every acceptance criterion in the pinned spec must be named by at least one `gate` node's `satisfies`
list, or be marked `unverifiable`. A criterion nothing checks is a lie on the acceptance board
(F10.8). Details in [verification gates](./10-verification-gates.md) §5.

### 3.5 Failure handling

Validation diagnostics are events, not exceptions. A failing v1 goes back to the planner once with
the diagnostics as input; a second failure escalates to a `human` node with the diagnostics rendered.
A failing **patch** is rejected outright (§4.3) — never partially applied.

---

## 4. Runtime mutation: the `PlanPatch` lifecycle

### 4.1 Shape (F2.4)

```ts
type PlanPatch = {
  id: PatchId;
  basePlanHash: string;                  // optimistic concurrency; must equal run.plan_hash
  proposedBy: NodeId | 'planner' | 'scheduler' | 'human';
  reason: string;                        // rendered verbatim in the scrubber; required, non-empty
  ops: PatchOp[];
  estimate: { costUsdDelta: number; nodesAdded: number; blastRadiusFiles: number;
              maxPermission: Level; replanDepth: number };
};

type PatchOp =
  | { op: 'insert';  nodes: PlanNode[]; edges: Edge[] }
  | { op: 'split';   node: NodeId; into: PlanNode[] }
  | { op: 'reroute'; node: NodeId; provider: ProviderId; cause: 'quota' | 'capability' | 'quality' }
  | { op: 'extend';  node: NodeId; maxRounds: number }
  | { op: 'abandon'; node: NodeId; cascade: boolean };
```

Any node may propose one. `agent` nodes do so through an MCP tool
(`karvan.propose_plan_patch`) exposed by Karvan's own MCP stdio server, injected into the agent
session via ACP `session/new` (**D9**). The tool takes the patch as structured input validated
against the same schema, so a malformed proposal fails at the tool boundary rather than in the
policy engine.

### 4.2 Proposal → decision → new plan

```
node emits patch  ──▶  estimate  ──▶  policy engine  ──▶  auto | approve | reject
                                                            │        │         │
                                                            │        ▼         ▼
                                                            │   human node  plan.patched
                                                            │   (F8.3 queue) (decision:'rejected')
                                                            ▼
                                              apply ops to base plan
                                                     │
                                                     ▼
                                              revalidate (§3)  ──fail──▶ reject with diagnostics
                                                     │ pass
                                                     ▼
                        one SQLite transaction: INSERT INTO plan(hash, run_id, created_at, doc)
                                                UPDATE run SET plan_hash = ?
                                                INSERT INTO event  -- 'plan.patched'
```

Four properties fall out of this and all four matter:

- **Plans are never mutated.** A patch produces a *new* immutable row in the content-addressed `plan`
  table. The old version is still there, still addressable by hash, still renderable.
- **Application is atomic with the event append.** Same transaction, so a crash mid-apply leaves
  either the old plan and no event, or the new plan and its event. Never a torn state.
- **`basePlanHash` gives optimistic concurrency.** If another patch landed first, the proposal is
  stale: reject with `PATCH_STALE` and let the proposer re-derive. Do not attempt automatic rebasing
  — the proposer had a reason based on a graph that no longer exists.
- **Rejections are recorded too.** `plan.patched` with `decision: 'rejected'` and the reason. NF10
  requires every UI state to trace to ledger events; "the run wanted to do X and was not allowed to"
  is exactly the state a user asks about.

### 4.3 The patch policy engine (F2.5)

Declarative, ordered, first match wins. Lives in `.karvan/config.yaml` under `policy.patch` and is
hashed into the run manifest so mid-run edits do not silently change the rules.

**The five dimensions:**

| Dimension | Signal | Source |
|---|---|---|
| Cost delta | `estimate.costUsdDelta` | pre-flight estimate (F9.3), Tier-2 tokenizer + per-provider calibration |
| Blast radius | `estimate.blastRadiusFiles` — union of new nodes' `pathScope`, expanded against the worktree | plan-time prediction |
| Replan depth | `estimate.replanDepth` — length of the patch's provenance chain back to v1 | plan lineage |
| Elapsed budget | fraction of the run's currency and wall-clock ceilings consumed | `budget.consumed` events (F4.6) |
| Permission escalation | `estimate.maxPermission` > the run's ambient level, or the patch touches the execution boundary | permission ladder (F5.4), F5.6 deny list |

**Default rule table**, matching F2.5's stated defaults exactly:

```yaml
policy:
  patch:
    rules:
      - id: escalates-permission
        when: { permissionEscalation: true }
        decision: approve                       # queue for a human
      - id: touches-execution-boundary
        when: { touchesExecutionBoundary: true }
        decision: approve
      - id: replan-depth-exceeded
        when: { replanDepth: '> 3' }
        decision: reject
      - id: budget-exhausted
        when: { elapsedBudgetFraction: '>= 1.0' }
        decision: reject
      - id: expensive
        when: { costDeltaUsd: '> 5.00' }
        decision: approve
      - id: wide-blast-radius
        when: { blastRadiusFiles: '> 25' }
        decision: approve
      - id: read-only-analysis
        when: { maxPermission: read, costDeltaUsd: '<= 5.00' }
        decision: auto
      - id: default
        decision: approve
```

The default arm is `approve`, not `auto`. Anything the rules do not recognise goes to a human.

**Worked example — auto-applied.** A `read`-permission recon node discovers the migration touches
three packages the spec did not name. It proposes `insert` of three read-only analysis nodes.
Estimate: `costUsdDelta 0.40`, `blastRadiusFiles 0` (no writes), `maxPermission read`,
`replanDepth 1`. No permission escalation, no boundary, depth ≤ 3, budget at 12%, cost ≤ 5.00 →
matches `read-only-analysis` → `auto`. Ledger gets `plan.patched { decision: 'auto', reason: "recon
found @acme/ui, @acme/forms and @acme/charts also import the v2 API" }`. The scrubber shows three new
nodes appearing at v2 with that sentence attached.

**Worked example — queued for approval.** An adversarial review gate finds the migration needs a
codemod across the design-system package. The patch inserts one `agent` write node at `worktree`
permission over `packages/ui/**` (140 files) plus a follow-up gate. Estimate: `costUsdDelta 6.20`,
`blastRadiusFiles 140`, `maxPermission worktree`, run ambient permission `read`, `replanDepth 2`. The
first rule matches on `permissionEscalation` → `approve`. It lands in the approval queue (F8.3) with
the estimate, the diff of the plan graph, and the review findings that motivated it. The run does not
stall on it if other branches are runnable — the patch is pending, not the run.

**Worked example — rejected.** A bug-hunt loop has already replanned three times. Its fourth patch
proposes extending the loop budget and adding two more hypothesis nodes. `replanDepth 4` →
`replan-depth-exceeded` → `reject`. The ledger records `plan.patched { decision: 'rejected',
reason: ... , ruleId: 'replan-depth-exceeded' }` and the run transitions to `needs_human`. The
approval queue shows the rejected patch so the human can approve it explicitly — a rejection is a
"not without you", not a dead end.

### 4.4 Provider re-routing on quota exhaustion (F3.9)

**Verified 2026-08-02.** Claude Code's `stream-json` output emits a
`{"type":"rate_limit_event","rate_limit_info":{…}}` frame carrying a `resetsAt` value. That frame,
plus non-retryable rate-limit exits from other adapters, drives re-routing.

The scheduler does not silently swap providers. It proposes a `reroute` op, which goes through the
same policy engine and produces the same `plan.patched` event, so the swap **appears in the
visualisation** — which is the entire point of F3.9's wording:

```ts
{ op: 'reroute', node: 'impl-checkout', provider: 'codex', cause: 'quota' }
```

Add one rule to make the common case frictionless without weakening the model:

```yaml
      - id: quota-reroute-equivalent
        when: { onlyOps: [reroute], cause: quota, capabilitySuperset: true, permissionUnchanged: true }
        decision: auto
```

`capabilitySuperset` is computed from the probed rows: the target adapter's capability set must cover
everything the node requires. A reroute onto a weaker adapter is not equivalent and is not auto.

If no healthy provider satisfies the node's requirements, **do not reroute — suspend**. Write
`node_wake(run_id, node_id, wake_at = resetsAt, reason = 'quota')` and let the tick loop pick it up.
NF7 says one provider being unavailable degrades the plan rather than killing the run; a durable wake
row is how that is implemented. Never use `setTimeout` for this: Node's maximum timer delay is
`2^31-1 ms`, and passing `2**31` **fires the callback after 1 ms** with only a
`TimeoutOverflowWarning`. **Verified 2026-08-02.** Timers also do not fire during laptop sleep and do
not survive a restart.

---

## 5. Plan version retention (F2.6)

Every version is kept. Forever, for the life of the run.

- In SQLite: one immutable row per version in the content-addressed `plan` table.
- On disk: `.karvan/runs/<runId>/plan/v1.json … vN.json`, per PRD §9.4, so NF8 holds — every artifact
  inspectable on disk in an open format.

The storage argument is trivial and worth stating so nobody is tempted to prune: a 40-node plan
serialises to roughly 30 KB. A run with the target 1–4 replans (PRD §12) is under 200 KB of plan
history; a pathological 12-version run is still under half a megabyte, and content addressing
deduplicates identical documents for free.

Retention is what makes the **plan evolution scrubber** (F10.2, the marquee feature) possible at all.
The scrubber's mechanism is a union graph: collect the union of all node ids across all versions, lay
that union out **once** with elkjs, then per version show, hide and restyle nodes against the fixed
coordinates. Per-version layout produces nodes that jump around as you scrub, which destroys the
"watch the plan grow" effect entirely.

Two honest caveats carried from the research:

- The elkjs `layerChoiceConstraint` / `positionChoiceConstraint` recipe for pinning per-version layout
  does **not** work as commonly written: those options are only consumed when
  `org.eclipse.elk.interactiveLayout=true`, `semiInteractive` reads `org.eclipse.elk.position` rather
  than `positionChoiceConstraint`, and constraint enforcement is a known elkjs weak spot. Treat the
  interactive-constraint path as an experiment to spike; the union-graph approach is the load-bearing
  design. **Unverified** beyond that.
- "The scrubber is about 200 lines" is an estimate, not a measurement, and it looks optimistic given
  the pieces involved. **Unverified.**

Rendering details live in [frontend architecture](./12-frontend-architecture.md).

Because "why is there a step here that I didn't ask for?" must be answerable in one click, the
`reason` field on `PlanPatch` is required and non-empty, is rendered verbatim (never summarised), and
is joined in the UI to the `plan.patched` event's `decision` and `ruleId`. The full answer is
therefore: *who proposed it, why, what the estimate was, which policy rule fired, and whether a human
approved it.*

---

## 6. Which model plans? (PRD §15.1)

**Unverified — this is a proposal with a measurement plan attached, not a finding.**

Planning quality dominates run quality, but planning is also frequent. The proposal:

| Planning event | Model tier | Rationale |
|---|---|---|
| Initial `PlanGraph` v1 | strongest available, high reasoning effort | One call per run. The single highest-leverage inference in the system. |
| Patch with `permissionEscalation`, `blastRadiusFiles > 25`, or `replanDepth ≥ 2` | strongest available | These are the patches a human is being asked to approve; the proposal should be worth reading. |
| Routine patch — read-only inserts, quota reroutes, loop extensions | cheap model | High frequency, low blast radius, structurally constrained output. |
| Query expansion for retrieval | cheap model | 3–5 keyword variants; pennies. |

"Strongest available" resolves against the probed capability rows, not a constant. Where the adapter
exposes a reasoning-effort control, use it: Claude Code accepts `--effort low|medium|high|xhigh|max`.
**Verified 2026-08-02.**

**How to measure it.** Record `planner.model`, `planner.effort` and `planner.tier` on every
`plan.proposed` and `plan.patched` event. Then join against the cross-run dashboard (F10.11) on the
metrics PRD §12 already defines:

| Metric | PRD M1 target | What a bad planner tier looks like |
|---|---|---|
| Gate first-pass rate | > 40% | Drops. The plan asked for the wrong work. |
| Replans per run | 1–4 | Rises above 4. The plan was wrong and kept being wrong. |
| Task completion without human rescue | > 50% | Drops. |
| Cost per completed task vs manual | ≤ 1.5× | Rises — cheap planning that causes rework is not cheap. |

Alternate the routine-patch tier per run for ~20 runs and compare. Twenty runs is not a controlled
study and should not be reported as one, but it is enough to detect a large effect, and a large
effect is the only thing worth acting on here.

---

## 7. Interaction with no-progress detection (F4.7)

This is the sharpest edge in the whole design, and getting it backwards is expensive.

The scheduler runs two cheap detectors over a `progress_watermark` — the `seq` of the last event that
actually **changed the reduced state**. Agent stdout does not count: it lives in the `io_chunk` table
and never reaches the reducer, so the metric is meaningful for free. See
[durable execution](./05-durable-execution.md) for the full detector implementation.

- **Stall detector** — `now - watermarkTs > 10 min` while at least one node is `running` → emit
  `run.stalled`, surface it, notify. **Do not auto-kill.** A legitimately long build looks identical.
- **Churn detector (circuit breaker)** — a sliding window of the last 20 completed node attempts,
  tripping if either (a) the same `(node_id, request_hash)` appears more than 5 times, or (b) **the
  count of completed nodes has not increased across 3 consecutive planner replans**.

Detector (b) is the one that ties back here, and the rule it implies is:

> **When the churn circuit-breaker trips, the run transitions to `needs_human` and the patch policy
> engine short-circuits every non-human-authored patch to `reject` until a human responds.**

A churning run's instinct is to replan. That is exactly the behaviour to stop. Three consecutive
replans with no completed nodes is not a plan that needs a fourth revision; it is a plan built on a
false premise, and the only thing that can supply the missing premise is the person who wrote the
spec. Allowing the policy engine to keep auto-applying read-only analysis patches during a churn trip
is the failure mode PRD §12 measures as "runs abandoned due to runaway loop" (target < 5%).

Concretely:

```ts
function decidePatch(p: PlanPatch, s: RunState): Decision {
  if (s.circuitBreaker === 'tripped' && p.proposedBy !== 'human') {
    return { decision: 'reject', ruleId: 'circuit-breaker-tripped' };
  }
  return evaluateRules(p, s);
}
```

Human-authored patches still apply — that is how the run is rescued. The human's patch also resets
the breaker, because a human-supplied insight is exactly the kind of change that invalidates the
sliding window.

Related: on `fact.invalidated`, downstream nodes that read the fact before the invalidation are
marked `taint: 'stale-input'`. **Do not auto-re-run them.** Flag them, surface them in the approval
queue, and let the patch policy engine decide. Automatic re-running on invalidation is a very
efficient way to build a loop that never terminates.

---

## 8. Pitfalls

- **Do not hardcode a provider capability matrix.** It will be wrong within a month. The one measured
  on 2026-08-02 already contradicts the vendor docs in two places. Probe, persist, read the row.
- **Do not skip validation on patched plans.** v1 validation is the obvious case; the patch that adds
  a node reading a key nothing writes is the one that actually bites, because it happens at node 27
  of 40.
- **Do not let a rejected patch be silent.** No event means no UI, and "the run silently decided not
  to do the thing it decided to do" is unanswerable.
- **Do not use the PRD's `karvan/<run-id>/<node-id>` branch naming.** It is a verified bug (D13). Flat
  `karvan/<runId>__<nodeId>`, validated with `git check-ref-format`.
- **Do not use `ohash` for the plan content hash.** Best-effort stable serialisation is fine for
  change detection, not for a primary key. `sha256` over your own canonical JSON.
- **Do not use `setTimeout` for a quota wait.** `2**31` ms silently fires after 1 ms, and timers do
  not survive sleep or restart. Durable `node_wake` rows only.
- **Do not accept a prose plan.** Enforce the schema at the adapter boundary with `--json-schema` /
  `--output-schema`. A regex over prose is how the planner layer starts breaking on every CLI update.
- **Do not mutate a plan row in place.** Ever. The scrubber, replay, and every "why" question depend
  on old versions being byte-identical to what actually ran.
- **Do not treat replans as a defect to minimise to zero.** PRD §12 targets 1–4 per run. Zero replans
  means the plan was static, which is the thing Karvan exists not to be. Above four means the framing
  interview under-delivered.
- **Do not let the planner see another node's transcript.** It gets the spec, the recon output and the
  capability list. F6.1 exists so that the edges in the plan graph mean something.

---

**Related:** [Domain model](./04-domain-model.md) · [Durable execution](./05-durable-execution.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) ·
[Verification gates](./10-verification-gates.md) ·
[Frontend architecture](./12-frontend-architecture.md)

[← Back to index](./README.md)
