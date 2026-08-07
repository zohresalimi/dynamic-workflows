# EPIC-10: Task intake and framing

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-10-task-intake-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-10                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Workstream**       | W7a (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                                                                  |
| **Size**             | ~13 days across 5 stories                                                                                                                                                                                                                                                                                                                                                                                      |
| **Depends on**       | EPIC-09 (the pinned segment set, `render(segments)`, `assertPinIntegrity` and the blackboard the recon facts land in), EPIC-06 (the node runner, blocking `human` nodes and durable `node_wake` suspension), EPIC-05 (an ACP session at `read` permission with structured output), EPIC-02 (`TaskSpec`, `AcceptanceCriterion`, `FailureMode`, `Fact` and the `run.*` / `human.*` members of the `Event` union) |
| **Blocks**           | EPIC-11 (the planner's first two of three inputs are the pinned spec and the recon facts), EPIC-12 (every gate is judged against the `specHash` minted here), EPIC-17 (F10.8's acceptance-criteria board renders this epic's criteria)                                                                                                                                                                         |
| **PRD requirements** | F1.1, F1.2, F1.3 (all P0) · F1.5 (P1, **pulled into M1** — see Scope) · F5.4, F6.1, F6.2, F6.4, F7.4, F8.1 · NF8, NF10                                                                                                                                                                                                                                                                                         |
| **Architecture**     | [06-planning-and-replanning.md §1](../../06-planning-and-replanning.md) (whole section) · [04-domain-model.md §2](../../04-domain-model.md) · [08-context-and-memory.md §4](../../08-context-and-memory.md) · [10-verification-gates.md §5](../../10-verification-gates.md)                                                                                                                                    |

## Goal

At the end of this epic a task can enter DeFlow four ways, is interrogated by a framing agent that
has read the repository and is allowed to ask the operator questions, and comes out the other side
as a `TaskSpec` the operator has actually read, edited and explicitly approved. Approval mints
`specHash` and the pinned segment set; from that moment every packet carries the spec verbatim and
every gate verdict carries the hash it was judged against. Nothing executes before that approval —
not one `node.scheduled`, not one token — and the run waits for it on a durable suspension that
costs one SQLite row whether the operator answers in six seconds or six hours.

## Why this matters

This epic is where the **Operator** stops being a spectator. Everything before it is machinery;
this is the first surface a human touches, and it is the one gate whose absence the SDD literature
is unanimous about. [PRD §4.5](../../prd.md) surveys every major spec-driven-development framework
and finds them agreeing on one thing: **shallow specs are the primary documented failure mode**,
ahead of bad models, bad prompts and bad tooling.
[06 §1.3](../../06-planning-and-replanning.md) puts the economics plainly — the failure is _"cheap
to produce and expensive to discover: a plausible, under-specified spec generates a plausible,
under-specified plan, which generates forty nodes of confidently wrong work."_

The second documented failure is worse because it is invisible. _Spec-then-drift_ is what
[10-verification-gates §5.2](../../10-verification-gates.md) describes as _"the spec launches the
session and the code silently becomes the source of truth again the moment generation starts"_ —
the reviewer reads the code, forms a model of what the code is trying to do, and judges the code
against that model. **It always passes.** `KAR-10.4` is the mechanical answer: the spec is pinned,
re-injected verbatim, its sha256 is checked after rendering, and a verdict whose `specHash` does not
match the run's is void. That is the difference between a gate and a formality.

There is a measured mechanism underneath. [08 §4](../../08-context-and-memory.md) records a
constraint-violation rate of **0% with the policy fully in context and 30% after compaction,
reaching 59% for the worst model**, restored to **0%** by a pinned buffer exempt from compaction and
re-injected verbatim with integrity checking. And the companion result — omission compliance falling
from **73% at turn 5 to 33% at turn 16** while commission compliance holds at 100% — is why the spec
that governs a run has to be re-asserted rather than merely stated once. EPIC-09 built that
machinery. This epic is what fills it with something worth pinning.

Skip this epic and the planner has no contract to compile, the gates have nothing to judge against,
F10.8's acceptance-criteria board has no rows, and the honest answer to _"has the requested outcome
been achieved?"_ becomes _"the agent said so."_

## Scope

**In scope:**

- Intake of all four F1.1 sources — free text, a file path, a git issue reference, a spec document —
  normalised into a single `task.submitted` event carrying the **raw source plus its provenance**
  and nothing interpreted. `POST /api/runs` with `input: { kind: 'text' | 'file' | 'issue' }` and
  the `DeFlow run "…"` CLI entry over the identical daemon path, honouring `Idempotency-Key`.
- The raw text pinned and surviving every later transformation, so _"what did I actually ask for?"_
  is answerable from the ledger at any point in a multi-hour run.
- The framing interview: a fresh-session framing agent at **`read` permission** producing a
  `TaskSpec` (`DeFlow.taskspec.v1`) with `goal`, `scope`, `nonGoals`, `constraints`,
  `priorDecisions`, `acceptanceCriteria` and `knownFailureModes` — as **structured output enforced
  at the adapter boundary** (`--json-schema` / `--output-schema`), never prose that DeFlow parses.
- Clarifying questions: the framing agent may block for operator input mid-interview, and the
  question-and-answer pairs are recorded and land in the spec as `priorDecisions`.
- The acceptance-criteria contract enforced structurally: every criterion either names at least one
  gate in `verifiedBy` or is explicitly marked `unverifiable: true` with a `reason`.
- The approval gate as a real blocking `human` node — durable suspension via a `node_wake` row with
  `reason = 'human_gate'`, survives laptop sleep and daemon restart, and **no node other than
  framing and recon is ever scheduled before `run.spec.approved`**.
- Operator edit (`spec.amended`), operator rejection and re-framing, and mid-run spec editing as a
  first-class operation that mints a new `specHash`, re-pins, and forces plan revalidation.
- `specHash = sha256(canonical(spec))` **excluding `approvedBy`**, so re-approving an unchanged spec
  is identity-preserving and editing one word is not.
- Spec pinning (F1.5, pulled into M1): compiling the approved spec into `pinned.spec`,
  `pinned.constraints` and `pinned.pathscope` segments, verbatim re-injection, the post-render
  sha256 integrity assertion, and the rule that **gates read the spec from the ledger, not from
  whatever the agent believes the spec was**.
- Repository reconnaissance: one or more `read`-permission recon nodes in `--detach --lock`
  worktrees producing the structured survey [06 §2.1](../../06-planning-and-replanning.md)
  specifies — language and toolchain detection, the scripts in `package.json` **that actually
  exist**, test/lint/build commands, directory shape, the size of the areas the spec names, and any
  `.DeFlow/gates/` definitions already present in the repo — landing as `finding/*` and `scope/*`
  facts with provenance and a `confidence` value.

**Out of scope:**

- Spec templates per task archetype (F1.4) — **P1, M2**. The archetype list (migration, feature, bug
  hunt, refactor, dependency upgrade, test backfill, incident postmortem) is in
  [PRD §7.1](../../prd.md); nothing here forecloses it, because a template is a seeded `TaskSpec`.
- Compiling the spec into `PlanGraph` v1 and validating it — [EPIC-11](./EPIC-11-dynamic-planning.md).
  This epic hands EPIC-11 two of its three inputs and stops.
- Running the gates that the criteria name — [EPIC-12](./EPIC-12-verification-gates.md). This epic
  guarantees each criterion names one; EPIC-12 makes it produce a verdict.
- The `human` node primitive itself, the cross-run approval queue and interjection —
  [EPIC-13](./EPIC-13-human-in-the-loop.md). This epic is the first _consumer_ of a blocking human
  node and depends on EPIC-06's suspension mechanics, not on EPIC-13's queue surface.
- The packet builder, `render(segments)`, `assertPinIntegrity`, the prohibition-to-requirement
  restatement and the ConstraintRot harness — [EPIC-09](./EPIC-09-context-memory.md). This epic
  supplies the _content_ of the pinned set and the rule that gates key on `specHash`.
- Rendering: F10.8's acceptance-criteria board and the spec editor UI are
  [EPIC-17](./EPIC-17-p0-views.md) and [EPIC-16](./EPIC-16-ui-foundation.md). Approval must be
  reachable from the CLI in M1 (`by: 'cli'`) so this epic is not blocked on the UI.
- Cross-run project memory as a `priorDecisions` source (F6.8) — **M3**. `.DeFlow/memory/` may be
  read if present, but nothing in this epic writes or curates it.

## Definition of Ready (epic level)

- [ ] **EPIC-02 Done.** `TaskSpec`, `AcceptanceCriterion`, `FailureMode`, `Fact`, `Provenance` and
      the `run.created` / `run.spec.approved` / `human.requested` / `human.responded` /
      `fact.written` members of the `Event` union exist, with JSON Schemas emitted to
      `.DeFlow/schemas/`.
- [ ] **The three intake/approval event kinds named in [06 §1](../../06-planning-and-replanning.md)
      but absent from [04 §9's](../../04-domain-model.md) Event union table — `task.submitted`,
      `spec.pinned`, `spec.amended` — have been reconciled into `KAR-02.7`.** This is a real gap
      between two architecture documents and it must be closed as a schema change in EPIC-02, not
      invented here. See Risks.
- [ ] **EPIC-06 Done through KAR-06.6.** Blocking `human` nodes suspend on a `node_wake` row and
      wake from the 1 Hz tick, so a six-hour approval gate is the same code path as a six-second one.
- [ ] **EPIC-09 Done through KAR-09.4.** The pinned segment kinds, `render()`, `assertPinIntegrity`
      and the prohibition-restatement pass exist, so this epic pins content rather than building the
      pinning mechanism.
- [ ] **EPIC-05 KAR-05.1 and KAR-05.2 Done.** An ACP session can be opened at `read` permission with
      structured output enforced at the adapter boundary, and the `provider_capabilities` row says
      whether the chosen adapter supports it.
- [ ] `@DeFlow/mock-agent` can be scripted to return a valid `DeFlow.taskspec.v1` document, an
      invalid one, and a mid-turn `session/request_permission` for a write — so the entire framing
      interview is testable offline with no credentials.
- [ ] A decision is recorded on **how a git issue reference is fetched** (`gh` CLI subprocess vs
      plain HTTPS) and how that squares with NF1. Intake is the only place in M1 where DeFlow itself
      touches the network.

## Definition of Done (epic level)

- [ ] All five stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-10-task-intake-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04` and
      `macos-26` under Node 24 and 26.
- [ ] **A test proves the gate is real:** with a run at `awaiting-spec-approval`, no `node.scheduled`
      event exists for any node other than the framing and recon nodes, and none appears until
      `run.spec.approved` is appended. This is asserted over the ledger, not over an in-memory flag.
- [ ] **A test proves the anti-drift claim:** a gate verdict produced against `specHash` A is voided
      and the gate re-run after the operator edits the spec to `specHash` B — and the gate's packet
      contains the spec bytes from the ledger, not from the worktree's code.
- [ ] An e2e spec drives `DeFlow run "…"` end to end: intake → framing → clarifying question →
      operator edit → approval → recon facts on the blackboard → the run becomes schedulable, with
      the daemon killed with `SIGKILL` while suspended at the approval gate and restarted.
- [ ] `test/fixtures/runs/spec-approval/ledger.db` is committed, containing `task.submitted`, a
      clarifying `human.requested` / `human.responded` pair, a `spec.amended`, a `run.spec.approved`
      and the recon `fact.written` events — so EPIC-16 and EPIC-17 have a real fixture for F10.8.
- [ ] Every `Unverified` claim in [06 §1](../../06-planning-and-replanning.md) that this epic
      depends on is resolved with a recorded result or carried forward as a named risk — chiefly
      whether `structured_output` is populated on every success case (roadmap A4-2), which the
      framing interview depends on completely.

## User stories

### KAR-10.1 — Task intake from text, file, issue reference or spec

|                 |                                                                    |
| --------------- | ------------------------------------------------------------------ |
| **Status**      | Ready                                                              |
| **Priority**    | P0                                                                 |
| **Size**        | S                                                                  |
| **Depends on**  | EPIC-02 (`TaskSpec` and the run events), EPIC-03 (the append path) |
| **PRD**         | F1.1, NF8, NF10                                                    |
| **Verified by** | EPIC-10-S1, EPIC-10-S2, EPIC-10-S3, EPIC-10-S4, EPIC-10-S5         |

**As** the operator, **I want** to hand DeFlow a task as text, a file, an issue URL or a spec
document and get back a run id, **so that** the way I happened to have the task written down is not
a reason to retype it.

[06 §1.1](../../06-planning-and-replanning.md) is unusually strict about what this story may do:
_"Intake does exactly one thing: normalise the input into a `task.submitted` event carrying the raw
source plus its provenance. **No interpretation happens here.**"_ The raw text is pinned and
survives every later transformation, which is what makes _"what did I actually ask for?"_ answerable
from the ledger three hours in, after two replans and a compaction. Both entry points —
`POST /api/runs` ([11 §7.1](../../11-api-and-realtime.md)) and `DeFlow run "…"` — go through the
same daemon code path; the CLI is a client of the HTTP API, not a second implementation. Creating a
run explicitly **does not start execution**: the 201 response carries
`status: "awaiting-spec-approval"`.

**Acceptance criteria**

1. `POST /api/runs` accepts `input` as `{ kind: 'text', text }`, `{ kind: 'file', path }` or
   `{ kind: 'issue', url }`, plus `cwd`, `budget` and `permission`, and returns
   `201 { runId, seq, status: "awaiting-spec-approval" }`. A spec document is the `file` kind with
   its own content type recorded in provenance — there is no fourth wire shape.
2. `task.submitted` carries the **raw** source bytes (or a content-addressed handle to them for a
   file over 64 KiB), the sha256 of those bytes, and provenance: kind, resolved absolute path or
   URL, fetch timestamp, and for `issue` the HTTP status and the resolver used.
3. Nothing in the intake path summarises, rewrites, truncates or "cleans up" the raw source. A test
   asserts byte equality between the submitted text and what a later read from the ledger returns.
4. A `file` path is resolved against `cwd` and **rejected if it escapes the repository root** after
   `realpath` — same rule as the fs mediation boundary, applied here because intake runs before any
   permission level exists.
5. A missing file, an unreadable file, or an unreachable issue URL fails with a typed error and
   **no event and no run row at all** — not even the `task.submitted` this story appends on success
   — so a failed intake never leaves a half-born run in the list.
6. `POST /api/runs` honours an `Idempotency-Key` header: a repeat with the same key returns the
   original `runId` and creates no second run.
7. `DeFlow run "…"` produces a ledger byte-identical (modulo ids and timestamps) to the same task
   submitted over HTTP, and records `by: 'cli'` in provenance.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                               | Red when                                                         |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | unit        | `normaliseInput({kind:'text'})` returns a `task.submitted` payload whose `raw` is byte-identical to the input and whose `sha256` matches           | The normaliser does not exist                                    |
| 2   | integration | Real tmpdir + real `git init` with `GIT_CONFIG_GLOBAL=/dev/null`; `{kind:'file', path:'docs/spec.md'}` → the file's exact bytes land in the ledger | The reader trims or re-encodes                                   |
| 3   | integration | `{kind:'file', path:'../../../etc/passwd'}` → typed rejection, and `SELECT count(*) FROM run` is 0                                                 | Path resolution happens after run creation                       |
| 4   | integration | A 200 KiB spec file → the payload holds an `artifact://<sha256>` handle and the CAS holds the bytes                                                | The payload inlines an arbitrarily large blob into the event row |
| 5   | integration | Two `POST /api/runs` with the same `Idempotency-Key` → same `runId`, and the whole ledger holds exactly one `task.submitted` and no `run.created`  | The key is accepted and ignored                                  |
| 6   | e2e         | `DeFlow run "…"` against a booted daemon → `status: "awaiting-spec-approval"` and **zero** `node.scheduled` events                                 | The CLI starts execution itself                                  |
| 7   | integration | An `issue` URL whose resolver returns 404 → typed failure, no run row, and the error names the URL                                                 | Failure is swallowed and an empty task is framed                 |

**Notes / risks** — **`run.created` moved to `KAR-10.2` (recorded 7 August 2026).** This story
originally appended it alongside `task.submitted`. It cannot: `run.created`'s payload is
`{ spec: TaskSpec; cwd; repo: { head, branch } }` ([04 §9](../../04-domain-model.md)), and intake
has no `TaskSpec` — producing one here would be exactly the interpretation
[06 §1.1](../../06-planning-and-replanning.md) forbids, and `reduce()`'s `run.created` case is the
only writer of `RunState.repoRoot`, whose doc comment already treats `null` as correct until that
event is folded. So intake appends **one** event, `task.submitted`, and the framing interview
appends `run.created` once it has a spec to put in it (`KAR-10.2` AC11) — including the
`repo.head` / `repo.branch` capture this story's flow scenario used to assert.
[11 §7.1](../../11-api-and-realtime.md) and [04 §9](../../04-domain-model.md) were updated with the
implementation; nothing is dropped, and the run is still un-startable until `run.spec.approved`.

The `issue` kind is the only place in M1 where DeFlowd itself makes an outbound
request, which sits awkwardly against NF1's _"full functionality with no network beyond what the
provider CLIs themselves need."_ Shelling out to an already-authenticated `gh issue view --json` is
the shape most consistent with AR-1's logic (the vendor's own tool, the user's own credentials) and
should be the default, with a plain HTTPS fetch as the fallback for non-GitHub hosts.

---

### KAR-10.2 — The framing interview producing a TaskSpec

|                 |                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                               |
| **Priority**    | P0                                                                                                                                        |
| **Size**        | L                                                                                                                                         |
| **Depends on**  | KAR-10.1, KAR-05.1, KAR-05.2, KAR-08.1 (`read` is a policy level the fs boundary actually enforces), KAR-09.9 (handoff schema validation) |
| **PRD**         | F1.2, F5.4, F6.1, F6.4, F7.4                                                                                                              |
| **Verified by** | EPIC-10-S6, EPIC-10-S7, EPIC-10-S8, EPIC-10-S9, EPIC-10-S10, EPIC-10-S11, EPIC-10-S12                                                     |

**As** the operator, **I want** a framing agent to interrogate my task _and the repository_ and hand
me a structured `TaskSpec` — including the acceptance criteria and the ways this could go wrong —
**so that** the thing the whole run is judged against was written before any code was generated.

[06 §1.2](../../06-planning-and-replanning.md) is specific about the shape and about the posture.
The framing agent runs at **`read` permission in a fresh session**, and it is _"the one place where a
model is allowed to be expansive, because everything downstream is judged against what it
produces."_ Its output is a `DeFlow.taskspec.v1` document with eight fields, produced as **structured
output enforced at the adapter boundary** — Claude Code's `--json-schema <schema>` returning the
parsed object in the result envelope's `structured_output` field, Codex's `--output-schema <FILE>`
— never prose DeFlow regexes. The one contract enforced structurally rather than by exhortation is
the criteria contract: **every criterion must either name at least one gate in `verifiedBy` or be
explicitly marked `unverifiable: true` with a `reason`.** A criterion nothing checks is a lie on the
acceptance board.

The interview is genuinely an interview. Where the framing agent cannot resolve an ambiguity from
the repository, it may ask the operator, and the run suspends on the same durable mechanism the
approval gate uses. The answers are recorded and land in the spec's `priorDecisions` with a
`source`, so six weeks later the spec explains itself.

**Acceptance criteria**

1. The framing node is scheduled with `permission: 'read'` and a fresh ACP session; a
   `fs/write_text_file` or a non-read-only `terminal/create` from that session is rejected at the
   boundary and recorded, and the interview continues rather than crashing.
2. The produced document validates against `.DeFlow/schemas/DeFlow.taskspec.v1.json` with Ajv
   (`strict: true`, `allErrors: true`); a document that fails validation gets **exactly one** bounded
   repair attempt and then fails the node with `contract.schema-invalid` — never a partial spec
   written to the ledger.
3. Where the resolved adapter's probed `provider_capabilities` row advertises structured output, the
   schema is passed at the adapter boundary. Where it does not, the node is refused with
   `adapter.capability-missing` rather than falling back to parsing prose.
4. Every `acceptanceCriteria[]` entry carries a `CriterionId` (`AC-1 … AC-n`), a single testable
   `statement`, and either a non-empty `verifiedBy` or `unverifiable: true` with a non-empty
   `reason`. A document violating this is a validation failure, not a warning.
   _(Spelled `ac-1 … ac-n` as shipped, recorded 7 August 2026: the `CriterionId` KAR-02.2 shipped is
   a lowercase slug (`^[a-z0-9][a-z0-9-]{0,62}$`), so the sequence is written in the case the domain
   type actually accepts. The ordering is still numeric — `ac-10` sorts after `ac-9`.)_
5. `knownFailureModes[]` entries each carry a `description` and a `detection` — "what going wrong
   looks like" and "how we would notice". An entry with a description and no detection is invalid.
6. `nonGoals` is required and may not be empty. It is the field
   [06 §1.2](../../06-planning-and-replanning.md) singles out as _"the field people skip and
   regret"_, and an empty array is an invitation to scope creep the planner will accept.
7. The framing agent may emit a clarifying question; the run suspends on a `node_wake` row, the
   question appears as `human.requested`, and the operator's answer appears as `human.responded` and
   is delivered into the same session where the adapter supports it, or into a fresh session with
   the question and answer replayed where it does not.
8. Question-and-answer pairs land in the spec as `priorDecisions` entries with
   `source: 'operator'`, and are visible in the ledger independently of the spec.
9. The framing agent receives the raw task, the repository at `read`, and nothing else — **no other
   node's transcript** (F6.1). A test asserts the assembled packet contains no `history.summary`
   segment sourced from a foreign node.
10. `returns.maxTokens` for the framing node is set explicitly (**4000**, not the 1500 default) and
    an oversize return is handled by EPIC-09's bounded repair, never by truncation.
11. **`run.created` is appended here _(added 7 August 2026, moved from `KAR-10.1`)_**, when the
    interview has produced a valid `TaskSpec` and not before, carrying
    `{ spec, cwd, repo: { head, branch } }` with `head` and `branch` read from the real repository
    at that moment. A framing node that fails validation appends no `run.created` — the failure
    modes in AC2 leave no half-born run, exactly as `KAR-10.1` AC5 does for intake.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                              | Red when                                                       |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | unit        | Ajv validates a hand-written good `DeFlow.taskspec.v1`; a copy with `nonGoals: []` fails with a pointer to `/nonGoals`                                                            | The schema does not require `nonGoals`                         |
| 2   | unit        | Criteria contract: `{ verifiedBy: [] }` with no `unverifiable` → one error naming the criterion id; `{ unverifiable: true, reason: '' }` → one error                              | Only `verifiedBy` is checked                                   |
| 3   | integration | `DeFlow-mock-agent --seed` scripted to return a valid spec over ACP → `TaskSpec` in the ledger, `structured_output` read from the result envelope, not from stdout text           | The adapter parses prose                                       |
| 4   | integration | Mock agent returns a schema-invalid document → exactly one repair prompt is sent, then `node.failed` with `reason: 'contract.schema-invalid'`                                     | The repair loop is unbounded, or the partial spec is persisted |
| 5   | integration | Mock agent scripted (testkit scenario 4) to call `fs/write_text_file` mid-interview → the call is rejected, a policy event is recorded, the turn continues                        | `read` is decorative on the framing path                       |
| 6   | integration | Mock agent emits `session/request_permission` then a clarifying question → `human.requested`, a `node_wake` row with `reason = 'human_gate'`, and **zero CPU** between tick polls | The question blocks a thread                                   |
| 7   | integration | Answer the question → `human.responded`, the answer appears in `priorDecisions` with `source: 'operator'`                                                                         | The answer is delivered to the agent but never recorded        |
| 8   | unit        | Capability gate: a `provider_capabilities` row with `structuredOutput: false` → the framing node is refused with `adapter.capability-missing`                                     | The code reads a hardcoded matrix                              |
| 9   | integration | Assembled framing packet golden-file snapshot with the normalising serializer → contains the raw task, pinned safety constraints and no foreign `history.summary`                 | Context is inherited implicitly                                |
| 10  | integration | A valid spec → exactly one `run.created` follows `task.submitted`, carrying the spec and the real `repo.head` / `repo.branch`; the schema-invalid run of test 4 appends none      | `run.created` is appended when the node starts, not when it succeeds |

**Notes / risks** — this story is entirely dependent on `structured_output` being populated on every
success case, which [roadmap A4-2](../../17-roadmap.md) still lists as **Unverified**. If the M0-S1
spike shows it is not reliable, the fallback is not prose parsing — it is routing the framing node
onto the adapter that does support it and refusing the others, which is exactly what AC 3 already
specifies. Note also that `--permission-prompt-tool` has already vanished from Claude Code's
`--help`; do not build the read-permission enforcement on a vendor flag when DeFlow is the ACP
client and owns the boundary itself.

**Shipped shape, recorded 7 August 2026.** `runFramingInterview` drives the turn through a
`FramingAgent` **port**, so the interview owns admission, the return contract, the clarifying-question
suspension and `run.created`, and the *transport* stays the caller's choice. That is not a hedge —
it is what the two halves of this story can each be proven with today. AC3's `structured_output`
lives on a **vendor CLI flag** (`--json-schema` / `--output-schema`, `ShimSpec.structuredOutputFlag`),
which is the exec-shim path and is exercised against a real spawned process in
`packages/adapters/test/integration/structured-output.test.ts`; AC1's *"rejected at the boundary"*
only means anything where DeFlow **is** the client, which is the ACP path and is exercised against a
real agent in `packages/daemon/test/integration/framing-read-only.test.ts`. Whether an ACP session
can carry a schema and return `structured_output` at all is precisely what roadmap A4-2 still lists
as Unverified, and nothing here pretends otherwise: no ACP structured-output channel was invented to
make one test file look tidier.

---

### KAR-10.3 — Human review and approval of the TaskSpec

|                 |                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                               |
| **Priority**    | P0                                                                                        |
| **Size**        | M                                                                                         |
| **Depends on**  | KAR-10.2, KAR-06.6 (durable wake times), KAR-06.7 (pause/resume as events)                |
| **PRD**         | F1.3, F8.1, NF4, NF10                                                                     |
| **Verified by** | EPIC-10-S13, EPIC-10-S14, EPIC-10-S15, EPIC-10-S16, EPIC-10-S17, EPIC-10-S18, EPIC-10-S29 |

**As** the operator, **I want** to read, edit, reject or approve the `TaskSpec` before anything
executes, **so that** forty nodes of confidently wrong work never get started on a spec I would have
caught in ninety seconds.

[06 §1.3](../../06-planning-and-replanning.md) — _"The approval gate is real"_ — implements this as
a blocking `human` node suspended durably: _"a row in `node_wake`, zero CPU, survives laptop sleep
and daemon restart. A six-hour think about a spec costs one SQLite row."_ Four operator actions are
supported: **approve**, **edit-then-approve**, **reject-and-reframe**, and **abandon**. An edit
appends `spec.amended` and recomputes `specHash`; approval appends `run.spec.approved` and
`spec.pinned`. A rejection carries a reason and re-runs the framing interview with that reason as
input rather than discarding the run.

The property this story must prove is negative and it is the whole point of the epic: **before
`run.spec.approved` exists in the ledger, no node other than framing and recon is ever scheduled.**
That is asserted over events, not over a boolean, because [05 §](../../05-durable-execution.md) is
explicit that pause is an event and never an in-memory flag.

**Acceptance criteria**

1. After the framing node completes, the run's status is `awaiting-spec-approval` and a blocking
   `human` node exists with `human.requested` carrying the rendered spec and the four options.
2. Suspension is durable: exactly one `node_wake` row with `reason = 'human_gate'`, no timer, no
   held connection. `SIGKILL` the daemon and restart it over the same `.DeFlow/` directory and the
   run is still waiting, with the same node and the same prompt.
3. **No `node.scheduled` event exists for any node other than the framing and recon nodes until
   `run.spec.approved` is appended.** A test drives the scheduler's tick loop for 30 simulated
   minutes against a plan-less run and asserts the ready set stays empty.
4. Approval appends `run.spec.approved { specHash, by: 'ui' | 'cli' }` and mints the pinned segment
   set (KAR-10.4). Approving from the CLI and approving from the API produce identical ledgers apart
   from the `by` field.
5. An edit appends `spec.amended` carrying an RFC 6902 patch of the change plus the new `specHash`,
   and the previous spec remains readable from the ledger — nothing is overwritten.
6. `specHash` **excludes `approvedBy`**: re-approving an unchanged spec produces the same hash;
   changing one character of `goal` produces a different one. Both directions are asserted.
7. A rejection appends the operator's reason and re-runs the framing interview with the raw task,
   the rejected spec and the reason as inputs. The rejected spec stays in the ledger and is
   addressable.
8. Editing the spec **after** the run has started is the same operation: new `specHash`, new
   `spec.pinned`, and a **mandatory plan revalidation**. If revalidation fails the run transitions
   to `needs_human` rather than continuing against a spec it no longer satisfies.
9. A run may be abandoned from the gate; that appends `run.aborted` and leaves every artifact
   inspectable on disk (NF8).

**Shipped shape, recorded 7 August 2026.** Four decisions this story had to make, each with a
tempting alternative:

- **The operator edits the framed document, not the sealed `TaskSpec`.** EPIC-10-S14's third
  scenario is an edit that removes a criterion's `verifiedBy` — and `verifiedBy` is
  `DeFlow.taskspecdraft.v1`'s vocabulary, not `DeFlow.taskspec.v1`'s. So `POST
  /runs/:id/spec/edit` takes a whole replacement framed document, `validateTaskSpecDraft` refuses it
  with the *same function's* message text as the framing node's, and `sealTaskSpec` re-mints the v1
  spec. Editing the sealed spec cannot express the scenario at all, and would launder a criterion
  naming two gates into one naming none, because v1's `check` has no way to hold two.
- **`spec.amended` carries the amended document *and* an RFC 6902 patch of the two sealed specs.**
  The patch is over the hashable form — `specHash` and `approvedBy` excluded, for the same reason
  the hash excludes them — so a diff panel never opens on an operation that replaced the digest of
  the document it is a patch for. `rfc6902@5.3.0` lives in `@DeFlow/daemon`, not `@DeFlow/core`: R1
  keeps `zod` core's single dependency, so core owns *what a patch is* (`JsonPatchOperationSchema`)
  and *what is diffed* (`hashableSpec`), and the daemon owns computing one.
- **`abandon` rides on `effect: 'reject'`, told apart by its option id.** The four-value `effect`
  vocabulary lives in `DeFlow.plangraph.v1`, which is content-hash-pinned and append-only; a fifth
  member would mean publishing `plangraph.v2` to record a distinction `human.responded.optionId`
  already carries losslessly. Both options are refusals of the draft — what differs is what DeFlow
  does next, which is a decision and not a node-level effect.
- **A gate with no deadline is still one row.** `node_wake.wake_at` is `INTEGER NOT NULL` in a
  shipped migration and AC2 requires the row, so a deadline-less wait uses
  `NO_DEADLINE_WAKE_AT` (8.64e15, the largest instant a `Date` holds): the row is real, no `now`
  makes it due, and `sleepHint`'s one-second cap keeps it from becoming a timer. A nullable column
  is migration 0002 and a different `WHERE` for every reader.

A mid-run edit (AC8) appends `run.spec.approved` at the new hash **in the same transaction** as
`spec.amended` and `spec.pinned`. Without it the run would execute against `B` while every gate
resolved `A`, and `gateSpecFromLedger` would refuse every verdict rather than judge it. Revalidation
failure appends `run.needs_human` at a fourth reason, `spec-revalidation`, which is why
`run.needs_human` is at **v2** (`schemas/CHANGELOG.md`).

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                   | Red when                                                                         |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | unit        | `reduce()` over `[task.submitted, node.completed(frame), human.requested]` → status `awaiting-spec-approval` and a ready set of `[]`                                   | Status is derived from a flag, not the log                                       |
| 2   | integration | File-backed ledger; tick the `TestClock` forward 30 minutes → no `node.scheduled`, one `node_wake` row, and CPU-free (the tick performs one indexed `node_wake` query) | The gate polls the agent or holds a promise                                      |
| 3   | integration | `SIGKILL` the daemon while suspended, reopen the **same file** with a fresh engine → the run is still at the gate with the same `human.requested` payload              | The gate lives in memory (`:memory:` would have hidden this)                     |
| 4   | integration | Approve → `run.spec.approved` + `spec.pinned` appended in one transaction; then and only then does the ready set become non-empty                                      | Approval and pinning are two transactions, so a crash between them loses the pin |
| 5   | unit        | `specHash` stability: canonicalise, hash, mutate `approvedBy` only → same hash; mutate one char of `goal` → different hash                                             | `approvedBy` is inside the canonical form                                        |
| 6   | integration | Edit → `spec.amended` with an rfc6902 patch; the pre-edit spec is still readable at its old hash                                                                       | The spec row is mutated in place                                                 |
| 7   | integration | Reject with reason "acceptance criteria are untestable" → a second framing attempt is scheduled whose packet contains the rejected spec and the reason                 | Rejection discards the run                                                       |
| 8   | integration | Mid-run edit → `spec.pinned` v2, plan revalidation runs, and a deliberately-broken edit drives `run.needs_human`                                                       | Revalidation is skipped for edits after start                                    |
| 9   | e2e         | `DeFlow run` → suspend → `DeFlow` approve from a second terminal → the run advances, with `by: 'cli'`                                                                  | Approval only exists in the UI                                                   |

**Notes / risks** — the temptation here is to make approval a fast path that skips the human node
and just flips a status. Do not: the suspension mechanics are the same ones every later gate uses,
and this is the cheapest possible place to prove they work. Note also that the F1.3 gate and the
F8.3 approval queue ([EPIC-13](./EPIC-13-human-in-the-loop.md)) are different things — this story
must not wait for the queue surface, only for a blocking node.

---

### KAR-10.4 — Spec pinning and anti-drift re-injection

|                 |                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                                          |
| **Priority**    | P0                                                                                                                                   |
| **Size**        | M                                                                                                                                    |
| **Depends on**  | KAR-10.3, KAR-09.3 (`assertPinIntegrity` and the pinned segment kinds), KAR-09.4 (prohibition restatement and interval re-injection) |
| **PRD**         | F1.5, F6.6, F7.4, NF10                                                                                                               |
| **Verified by** | EPIC-10-S19, EPIC-10-S20, EPIC-10-S21, EPIC-10-S22, EPIC-10-S23, EPIC-10-S29                                                         |

**As** the operator, **I want** the approved spec re-injected verbatim into every agent and every
gate to be judged against _that_ rather than against the code as it currently stands, **so that** a
run cannot quietly redefine success halfway through and then pass its own review.

This is F1.5 and it is the mechanical answer to _spec-then-drift_.
[10 §5.2](../../10-verification-gates.md) names four mechanisms and this story owns three of them:
**the verdict carries `specHash` and a mismatch voids it**; **the reviewer's packet contains the
pinned segments first and verbatim**; and **prohibitions are restated as positive requirements** so
the reviewer is told _"judge each finding against AC-3 as written above"_ rather than _"do not judge
against the code"_. The fourth — the post-render sha256 assertion — is EPIC-09's
`assertPinIntegrity`, and this story is the caller that gives it something to check.

The pinned set is exactly what [08 §4.1](../../08-context-and-memory.md) enumerates: `TaskSpec` goal
and non-goals, acceptance criteria, safety constraints, declared path scopes, and the node's
permission level — compiled to `pinned.spec`, `pinned.constraints` and `pinned.pathscope` segments
with `pinned: true` and therefore `compactable: false`. The subtle part is the last clause of F1.5:
_"gates evaluate against the spec, not against the current state of the code."_
[08 §4.3](../../08-context-and-memory.md) explains why that is not merely good hygiene — passing
gates are **not** evidence that prohibitions are being honoured, because Security-Recall Divergence
is invisible to exactly the monitoring a green board provides.

**Acceptance criteria**

1. `run.spec.approved` mints `spec.pinned` carrying the sha256 of each pinned segment's text and the
   `specHash` they derive from, in the **same transaction** as the approval.
2. `compilePinnedSegments(spec, node)` is pure and total, lives in `@DeFlow/core`, and produces
   segments whose `text` is byte-identical to the corresponding slice of the approved spec — no
   reflow, no re-wrapping, no bullet normalisation.
3. Every packet built for every node in the run — agent, gate, human and recon alike — contains the
   pinned segments first, and `assertPinIntegrity` runs after render. A missing digest emits
   `pin.integrity_violated` and fails the node with `safety.pin-integrity-violated`, with **no
   silent retry**.
4. **A gate reads the `TaskSpec` from the ledger at the run's current `specHash`, never from the
   node's context and never from the worktree.** A test constructs a worktree whose code contradicts
   AC-3 and asserts the verdict cites AC-3 as written in the spec.
5. Every `Verdict` carries the `specHash` it was judged against. A verdict whose `specHash` does not
   equal the run's current one is **void**: it is not counted on the acceptance board, and the gate
   is re-run.
6. Constraints reaching the pinned set have been through KAR-09.4's restatement pass, so a
   prohibition in the spec renders as a positive requirement where a closed positive form exists,
   and residual `forbid` constraints render last among the pinned constraints and are counted.
7. Interval re-injection applies to long-running nodes at the configured turn interval, delivered as
   an appended turn where the adapter supports steering and surfaced as a builder warning where it
   does not.
8. `context.compacted.pinnedKept` carries the sha256 list on every compaction in the run, which is
   the positive evidence that the check ran rather than the absence of a failure.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                                           | Red when                                                                 |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | unit        | `compilePinnedSegments` over a fixture spec → golden-file snapshot; each segment's `text` is a byte-exact substring of the approved spec's canonical form                                                      | The compiler reformats                                                   |
| 2   | unit        | Purity: deep-frozen spec, two calls, deeply equal results, no port constructed                                                                                                                                 | It reads a clock or the filesystem                                       |
| 3   | integration | Approve → `run.spec.approved` and `spec.pinned` share one transaction; kill between them is impossible by construction                                                                                         | Two separate appends                                                     |
| 4   | integration | Build packets for all five node archetypes → every one contains the pinned segments first and byte-identical                                                                                                   | Pinning applies only to `agent` nodes                                    |
| 5   | integration | Strip one pinned segment from the rendered prompt in a test double → `pin.integrity_violated` with the missing digest, node failed, **zero** retry attempts                                                    | The runner retries a pin failure                                         |
| 6   | integration | **Anti-drift:** a worktree whose code contradicts AC-3, a review gate run against it → the verdict's `criteria[]` marks AC-3 `unsatisfied` and its packet's pinned bytes match the ledger's spec, not the code | The gate builds its own idea of the spec from the diff                   |
| 7   | integration | **Void verdict:** gate passes at `specHash` A → operator edits → `specHash` B → the verdict is excluded from the acceptance board and the gate is re-scheduled                                                 | Verdicts are trusted regardless of hash                                  |
| 8   | unit        | A spec constraint phrased as a prohibition renders as a positive requirement; a `forbid` with no positive form renders last and increments the counter                                                         | The restatement pass is skipped for spec-sourced constraints             |
| 9   | integration | A compaction in a live run → `context.compacted.pinnedKept` equals the pinned digest list                                                                                                                      | `pinnedKept` is populated only on the success path of the packet builder |

**Notes / risks** — AC 5 has a sharp interaction with [EPIC-12](./EPIC-12-verification-gates.md):
voiding verdicts on a spec edit means a mid-run edit can invalidate an hour of gate work. That is
correct and it should be _visible_ — the acceptance board must show "re-running against the amended
spec", not silently blank. Do not soften the rule by comparing only the criteria that changed; the
whole point is that the reviewer's judgement was formed against a different contract.

---

### KAR-10.5 — Repository reconnaissance as planner input

|                 |                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                               |
| **Priority**    | P0                                                                                                                        |
| **Size**        | M                                                                                                                         |
| **Depends on**  | KAR-10.3, KAR-07.2 (worktree lifecycle — recon runs in a `--detach --lock` worktree), KAR-09.8 (the blackboard), KAR-08.1 |
| **PRD**         | F1.2, F2.2, F6.2, F6.3, F5.4                                                                                              |
| **Verified by** | EPIC-10-S24, EPIC-10-S25, EPIC-10-S26, EPIC-10-S27, EPIC-10-S28                                                           |

**As** the planner, **I want** a structured survey of the repository as typed facts with provenance,
**so that** I plan against the toolchain that is actually installed and the scripts that actually
exist rather than the ones a model assumed.

[06 §2.1](../../06-planning-and-replanning.md) makes recon the planner's second input and lists what
it must produce: _"language and toolchain detection, the scripts in `package.json`, test/lint/build
commands **that actually exist**, directory shape, the size of the areas the spec names, and any
`.DeFlow/gates/` definitions already present in the repo."_ The italicised part is the whole value —
a plan whose gate node runs `pnpm test:unit` in a repo with no such script fails at node 27 of 40,
which is exactly the failure mode dynamic planning is supposed to make unnecessary.

Recon nodes run at `read` permission in a detached, locked worktree, and their output is not a
report: it is `finding/*` and `scope/*` facts on the blackboard, each with full `Provenance`
(`byNode`, `byProvider`, `byModel`, `fromEvidence` handles, `atEvent`, `confidence`). The
`confidence` field is load-bearing — _"the repo probably uses Pinia"_ and _"`package.json` lists
`pinia@3.0.4`"_ are both useful and must not be indistinguishable.

**Acceptance criteria**

1. Recon nodes are scheduled with `permission: 'read'` into a worktree created with
   `git worktree add --detach --lock --reason "DeFlow run=<runId> node=<nodeId>"` — detached, because
   a read node needs no branch and git will not check the same branch out twice.
2. Toolchain findings are **verified by execution or by file read, not asserted**: a claimed test
   command is recorded as `confidence: 'verified'` only if the script key exists in `package.json`
   (or the equivalent manifest); otherwise it is `'speculative'` and says so.
3. `scope/*` facts carry a discovered path set with a file count, which feeds F5.2 write
   serialisation and the patch policy's `blastRadiusFiles` estimate.
4. `.DeFlow/gates/` definitions present in the repo are discovered and recorded as facts, so
   criteria coverage (KAR-11.2) can bind an `AC-n` to a gate that already exists.
5. Every fact carries `fromEvidence` handles pointing at the artifact or `file://<path>#L12-L40`
   range it was derived from, so the node inspector's provenance table can click through.
6. Recon output is bounded by `returns.maxTokens` (**4000** for this node type per
   [04 §3.1](../../04-domain-model.md)); a 200-file survey that exceeds it is offloaded to a handle,
   never truncated.
7. Recon results are **not** given to the planner as a transcript. The planner reads facts, and a
   test asserts no `history.summary` segment sourced from a recon node appears in the planner's
   packet (F6.1, and [06 §8](../../06-planning-and-replanning.md)'s _"do not let the planner see
   another node's transcript"_).
8. A repository where detection genuinely fails — no recognised manifest, no test command —
   produces facts saying so with `confidence: 'asserted'`, and the planner is expected to plan a
   discovery step. It does not produce a fabricated toolchain.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                   | Red when                                 |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | integration | `makeRepo({ files: { 'package.json': {scripts:{test:'vitest run'}} } })`, recon node → `finding/test-command` fact with `confidence: 'verified'` and evidence `file://package.json#L…` | Findings carry no evidence               |
| 2   | integration | Same repo with the `test` script removed, mock agent still claims `pnpm test` → the fact is recorded `confidence: 'speculative'`, not `'verified'`                                     | The verifier trusts the model            |
| 3   | integration | Recon worktree is created `--detach --lock`; `git worktree list --porcelain -z` shows `detached` and `locked`                                                                          | Recon reuses the main working copy       |
| 4   | integration | Mock agent attempts `fs/write_text_file` inside the recon worktree → rejected at the boundary, recorded, node continues                                                                | `read` is not enforced for recon         |
| 5   | integration | A repo with `.DeFlow/gates/typecheck.yaml` → a fact naming the gate id, retrievable by the criteria-coverage check                                                                     | Custom gates are invisible until EPIC-12 |
| 6   | integration | A 200-file survey exceeding 4000 tokens → `handoff.oversize`, one repair, then an `artifact://` handle; the ledger never holds a truncated survey                                      | The return is truncated                  |
| 7   | integration | Planner packet golden snapshot → contains `finding/*` and `scope/*` facts, contains **no** recon transcript                                                                            | The planner is handed the recon session  |
| 8   | integration | An empty repo with no manifest → facts with `confidence: 'asserted'` stating detection failed; no fabricated commands                                                                  | Detection invents a default              |

**Notes / risks** — the sizing here assumes recon is one or two nodes, not a configurable recon
subgraph. Resist that: the planner can insert more read-only analysis nodes at runtime via a patch
that auto-applies under `read-only-analysis` ([EPIC-11](./EPIC-11-dynamic-planning.md)), which is a
better mechanism than a recon DSL and costs nothing extra. The `.DeFlow/gates/` discovery here is
read-only cataloguing; F7.6's full custom-gate execution is P1 and belongs to EPIC-12.

## Risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                     | Severity          | Mitigation                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Three event kinds this epic emits are named in [06 §1](../../06-planning-and-replanning.md) but are absent from [04 §9's](../../04-domain-model.md) Event union table: `task.submitted`, `spec.pinned`, `spec.amended`.** [01 §](../../01-architecture-overview.md) uses `spec.amended` and `spec.approved`; 04 defines `run.spec.approved`. These are the same concepts under three spellings across three documents. | **High** (silent) | Close it in `KAR-02.7` as a Definition-of-Ready item **before** this epic starts, and pick one spelling. Recommendation: keep 04's `run.spec.approved` as canonical and add `task.submitted`, `spec.pinned` and `spec.amended` to the union with schemas. Do not let two spellings both ship — the reducer ignores unknown kinds by design, so the wrong one fails _silently_. |
| **The framing interview depends completely on `structured_output` being populated on every success case, which is Unverified** (roadmap A4-2).                                                                                                                                                                                                                                                                           | **High**          | Answer it in **M0-S1**, which is already scheduled. The fallback is AC 3 of KAR-10.2 — refuse to schedule framing onto an adapter whose probed row does not advertise structured output — not prose parsing, which is how the planner layer starts breaking on every CLI update.                                                                                               |
| **The gate can become ceremony.** An operator who approves every spec unread has re-created the failure the epic exists to prevent, and no code can stop that.                                                                                                                                                                                                                                                           | Medium            | Make the cost of reading low rather than the cost of approving high: render the spec as the diff of what the framing agent changed from the raw task, put the criteria contract violations in front of the operator before the approve button, and record `by` and timestamps so a pattern of instant approvals is at least visible. This is a product risk, not a bug.        |
| **Voiding verdicts on a mid-run spec edit can discard an hour of gate work** (KAR-10.4 AC 5).                                                                                                                                                                                                                                                                                                                            | Medium            | Correct behaviour, but it must be visible: the acceptance board shows "re-running against the amended spec" and the ledger shows the void. Consider surfacing the cost of an edit _before_ it is committed — a count of verdicts that will be voided — in EPIC-17. Do not soften the rule.                                                                                     |
| **Intake is the only place DeFlowd itself touches the network** (`{kind: 'issue'}`), which sits awkwardly against NF1.                                                                                                                                                                                                                                                                                                   | Low               | Default to shelling out to the user's already-authenticated `gh` — the vendor's own tool, the user's own credentials, exactly AR-1's shape. Plain HTTPS is the fallback for other hosts, and both are recorded in provenance including the HTTP status. Offline, the failure is typed and the operator pastes the text.                                                        |
| **`priorDecisions` sourced from `.DeFlow/memory/` (F6.8) is M3**, so the spec's "prior decisions" field will be thin in M1 and may look like dead weight.                                                                                                                                                                                                                                                                | Low               | Keep the field and populate it from the operator's clarifying answers, which is the highest-value source anyway. The M3 curator writes into the same shape rather than a new one.                                                                                                                                                                                              |
| **This epic's e2e coverage needs a booted daemon and a real approval round trip**, which is the slowest test shape DeFlow owns.                                                                                                                                                                                                                                                                                          | Low               | Exactly one e2e spec (the DoD's intake-to-schedulable walk). Everything else is integration against a file-backed ledger with `DeFlow-mock-agent` on a temp `PATH` — [14 §13](../../14-testing-strategy.md) is explicit that five e2e specs is a ceiling, not a target.                                                                                                        |

---

**Related:** [Flows](../flows/EPIC-10-task-intake-flows.md) · [Board](../board.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[08-context-and-memory.md](../../08-context-and-memory.md) ·
[10-verification-gates.md](../../10-verification-gates.md) ·
[EPIC-09 context and memory](./EPIC-09-context-memory.md) ·
[EPIC-11 dynamic planning](./EPIC-11-dynamic-planning.md) ·
[EPIC-13 human in the loop](./EPIC-13-human-in-the-loop.md)

[← Back to the delivery plan](../README.md)
