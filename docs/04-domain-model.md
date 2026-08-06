# Domain model

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the shared vocabulary. Every other document in this set refers back to the types defined
here, so this file is normative: if a type appears elsewhere with a different shape, this file wins
and the other document is a bug.

All types live in one private package, `@DeFlow/domain` (see [repo layout](./16-repo-layout.md)).
It has no runtime dependency on the daemon, the adapters, or the UI — it is imported by all three.

## 0. How these types are defined

**Zod is the single source of truth.** Every type below is authored as a Zod 4 schema; the
TypeScript type is derived with `z.infer`, and the JSON Schema is derived with `z.toJSONSchema()`.
There is no hand-written interface that a schema has to be kept in sync with, because that sync
never survives contact with a real codebase.

| Concern              | Mechanism                                              | Pin                |
| -------------------- | ------------------------------------------------------ | ------------------ |
| Schema authoring     | `zod`                                                  | `4.4.3`            |
| JSON Schema emission | `z.toJSONSchema()` (built in to Zod 4)                 | —                  |
| Runtime validation   | `ajv` + `ajv-formats`, JSON Schema **2020-12** dialect | `8.20.0` / `3.0.1` |
| On-disk schemas      | `.DeFlow/schemas/<schemaId>.json`                      | NF8                |

2020-12 is not an arbitrary choice: it is the dialect MCP tool `inputSchema` defaults to, so the
[MCP host](./07-provider-adapter-layer.md) and the handoff contracts (F6.9) speak one dialect and
one validator. Use `Ajv2020` from `ajv/dist/2020`, configured `{ strict: true, allErrors: true }`.
Ajv arrives transitively via `@modelcontextprotocol/sdk` anyway. **Verified 2026-08-02.**

Writing the generated schemas to `.DeFlow/schemas/` satisfies NF8 (every artifact inspectable on
disk in an open format) and gives agents something to be pointed at: `agent` nodes pass their
`returns.schemaId` schema to the vendor CLI natively where supported — Claude Code's `--json-schema`
and Codex's `--output-schema` both take a JSON Schema file. **Verified 2026-08-02.**

Two constraints from [the tech stack](./02-tech-stack.md) shape the code below:

- **`erasableSyntaxOnly: true`** (D4) — no `enum`, no runtime `namespace`, no parameter properties,
  no decorators. Every closed set is a string-literal union. In practice this is what you want
  anyway, because a string-literal union round-trips through JSON and an enum does not.
- **ESM only.** All examples are `.ts` modules with `"type": "module"`.

---

## 1. Identifiers

Identifiers are branded strings, not opaque objects. They must survive a JSON round trip, appear in
a SQLite `TEXT` column, be greppable in a log, and — for `RunId` and `NodeId` — be legal path
segments, because §9.4 of the PRD puts them in directory names.

```ts
// packages/domain/src/ids.ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type RunId = Brand<string, "RunId">;
export type NodeId = Brand<string, "NodeId">;
export type PlanHash = Brand<string, "PlanHash">;
export type FactId = Brand<string, "FactId">;
export type Handle = Brand<string, "Handle">;
export type EventSeq = Brand<number, "EventSeq">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type SchemaId = Brand<string, "SchemaId">;
export type ProviderId = Brand<string, "ProviderId">; // 'claude-code' | 'codex' | …, discovered
export type GateId = Brand<string, "GateId">;
export type CriterionId = Brand<string, "CriterionId">;
export type SegmentId = Brand<string, "SegmentId">;
```

| Type             | Format                                                                | Assigned by                                | Stability rule                                                                                               |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `RunId`          | `run_20260802T141133Z_9f2a1c`                                         | daemon at run creation                     | Immutable. Lexicographically sortable and filesystem-safe, because it is a directory name (`runs/<runId>/`). |
| `NodeId`         | `/^[a-z0-9][a-z0-9-]{0,62}$/`, e.g. `recon-auth-surface`              | **the planner**                            | **Stable for the entire life of the run. Never reused, never renamed, never recycled.** See below.           |
| `PlanHash`       | `sha256-<64 hex>`                                                     | derived                                    | Content address of a canonicalised `PlanGraph`. Primary key of the `plan` table.                             |
| `FactId`         | `fact_<26 lowercase base32>`                                          | blackboard writer                          | Immutable. A corrected fact is a _new_ `FactId` that `supersedes` the old one.                               |
| `Handle`         | `artifact://<64 hex sha256>` or `file://<repo-relative path>#L12-L40` | artifact store                             | Content-addressed, therefore immutable by construction.                                                      |
| `EventSeq`       | positive integer                                                      | SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` | Monotonic within a run's ledger. **Gaps are expected and legal.**                                            |
| `IdempotencyKey` | `<runId>/<nodeId>/<attempt>/<ordinal>`                                | reducer                                    | Deterministic function of reduced state, not of runtime call order.                                          |
| `SchemaId`       | `DeFlow.finding.v1`, `ext.migration.vue3-incompat.v1`                 | author                                     | Version suffix is part of the id. Schemas are append-only; you publish `.v2`, you never edit `.v1`.          |

### 1.1 `NodeId` stability is load-bearing

Two subsystems key off `NodeId` and both break silently if it moves:

1. **The effect journal.** The idempotency key is `(runId, nodeId, attempt, ordinal)`
   ([durable execution](./05-durable-execution.md), F4.3). If a node's id changes between the
   `pending` effect row being written and the daemon restarting, the memoised result is orphaned and
   the side effect runs twice. There is no way to detect this after the fact.
2. **The plan-evolution scrubber** (F2.6, F10.2 — the marquee view). The scrubber lays out the
   _union_ of every plan version once and animates nodes between positions; identity across versions
   is `NodeId` and nothing else. A renamed node renders as a delete plus an insert, which is exactly
   the wrong story to tell about a plan that was merely edited.

So the rule is:

> A `PlanPatch` may change **anything about a node except its id**. Changing the provider, the
> brief, the permission level, the budget, the retry policy, the declared reads/writes — all keep
> the id. Structural operations that genuinely destroy a node (`split`, `abandon`) **retire** the id
> instead: it stays in the graph with `lifecycle: 'superseded' | 'abandoned'`, and its successors
> get fresh ids carrying `derivedFrom: NodeId[]`.

A retired id is never reused, including across replans, including after the branch it belonged to
was abandoned. The planner allocates ids from a run-scoped registry held in the ledger, not from a
counter in memory.

### 1.2 `EventSeq` gaps are not a bug

`AUTOINCREMENT` (rather than a bare `INTEGER PRIMARY KEY`) is mandatory, and this was measured:
with a plain rowid, inserting rows 1,2,3, deleting row 3, then inserting again yields seq
`1,2,3` — **the sequence number is reused**. With `AUTOINCREMENT` you get `1,2,4`.
**Verified 2026-08-02.** The moment retention or pruning of old runs exists, plain rowid silently
corrupts every persisted SSE cursor and every checkpoint offset.

The consequence for consumers: rolled-back transactions burn sequence values, so the streaming
contract is always **"resume from strictly greater than `n`"**, never "expect `n+1`".
See [the API contract](./11-api-and-realtime.md) for how this maps onto `Last-Event-ID`.

---

## 2. `TaskSpec` (F1.2, F1.3, F1.5)

Produced by the framing interview, edited and explicitly approved by a human before anything
executes. It is the contract the whole run is judged against.

```ts
export type AcceptanceCriterion = {
  id: CriterionId;
  /** A single testable statement. EARS phrasing encouraged, not enforced. */
  statement: string;
  /** Where possible, the criterion maps to something that can actually be run. */
  check?:
    | {
        kind: "command";
        run: string;
        cwd?: string;
        expect: "exit-zero" | "exit-nonzero";
      }
    | { kind: "gate"; gate: GateId }
    | { kind: "manual"; rubric: string };
  /** Set by the planner during validation: F7.4 requires every criterion to reach a gate. */
  coveredByGates: NodeId[];
};

export type FailureMode = {
  id: string;
  description: string; // 'the migration codemod silently drops v-model modifiers'
  detection: string; // how we would notice
  mitigation?: string;
};

export type TaskSpec = {
  schemaId: SchemaId; // 'DeFlow.taskspec.v1'
  goal: string;
  scope: { included: string[]; paths?: string[] };
  nonGoals: string[];
  constraints: string[]; // 'must not change the public API of @voyado/ui'
  priorDecisions: Array<{
    decision: string;
    rationale?: string;
    source?: Handle;
  }>;
  acceptanceCriteria: AcceptanceCriterion[];
  knownFailureModes: FailureMode[];
  approvedBy: { at: string; via: "ui" | "cli" } | null;
  specHash: string; // sha256 of the canonicalised spec, excluding `approvedBy`
};
```

**The pinning contract (F1.5).** `goal`, `nonGoals`, `constraints`, `acceptanceCriteria` and the
active node's `pathScopes` and `permission` are compiled into `pinned: true` segments and re-injected
**verbatim** into every context packet. Verbatim means identical bytes — the summariser is never
allowed near them. After rendering, the packet builder asserts that the sha256 of each pinned
segment's text still appears in the outgoing prompt; a mismatch emits `pin.integrity_violated` and
fails the node rather than proceeding. Mechanism and evidence in
[context and memory](./08-context-and-memory.md).

`specHash` excludes `approvedBy` deliberately: re-approving an unchanged spec must not change its
identity, but editing one word must.

---

## 3. `PlanGraph` (F2.1, F2.3)

The plan is **data, not code** (D7). It is an immutable, content-addressed JSON document; a replan
writes a new document and a new row, it does not mutate the old one.

```ts
export type PlanGraph = {
  schemaId: SchemaId; // 'DeFlow.plangraph.v1'
  runId: RunId;
  version: number; // 1, 2, 3 … monotonic per run
  planHash: PlanHash; // sha256 of the canonicalised doc, excluding planHash itself
  parent: PlanHash | null; // the version this was patched from
  taskSpecHash: string;
  createdBy: NodeId | "planner" | "human";
  createdAt: string; // ISO 8601
  nodes: PlanNode[];
  edges: PlanEdge[];
};

export type PlanEdge = {
  from: NodeId;
  to: NodeId;
  kind: "control" | "data";
  /** F10.1: edges are labelled with what flows across them. Populated for kind:'data'. */
  carries?: string[]; // fact keys, e.g. ['finding/auth-uses-jwt']
};
```

**On the content hash.** Compute `planHash` as sha256 over a canonical JSON encoding you own
(recursively sorted keys, no insignificant whitespace, `undefined` omitted). `ohash`'s stable
key-ordering claim is confirmed, but its README promises only "best efforts" at stable
serialisation — fine for cheap change detection in the UI, **not** fine for a value that is a
primary key and an identity across daemon versions. Use `ohash` for "did this object change since
last render", use your own canonical encoder for `planHash`.

### 3.1 Node common fields

```ts
export type PermissionLevel = "read" | "worktree" | "worktree+net" | "full"; // F5.4

export type PathScope = {
  /** Globs the node may write. Rendered into the packet as a POSITIVE requirement. */
  write: string[];
  read?: string[];
};

export type RetryPolicy = {
  maxAttempts: number; // default 3
  backoff: { base: number; cap: number; jitter: "full" }; // ms; full jitter, see §7 of 05-
  /** F4.5: 'retry with a different provider'. */
  onFailure?: Array<{
    when: NodeFailureReason;
    action: "retry" | "reroute" | "escalate";
  }>;
};

export type NodeBudget = {
  maxCostUsd?: number;
  maxWallClockMs?: number;
  maxTokens?: number;
};

export type ReadDecl =
  | { kind: "fact"; key: string } // exact key or 'finding/*' prefix
  | { kind: "artifact"; handle: Handle }
  | { kind: "spec"; section: "goal" | "criteria" | "constraints" | "nonGoals" };

export type WriteDecl = { kind: "fact"; key: string; schemaId: SchemaId };

export type NodeLifecycle = "active" | "superseded" | "abandoned";

type NodeBase = {
  id: NodeId;
  title: string;
  deps: NodeId[];
  lifecycle: NodeLifecycle;
  derivedFrom?: NodeId[];

  reads: ReadDecl[]; // F6.2 — undeclared reads fail plan validation
  writes: WriteDecl[];
  permission: PermissionLevel; // F5.4
  pathScopes: PathScope; // F5.3
  returns: { schemaId: SchemaId; maxTokens: number }; // F6.4, F6.9
  retry: RetryPolicy;
  budget: NodeBudget;
};
```

`reads`/`writes` are validated at plan time, not at run time: graph validation asserts that every
declared read is satisfied by some ancestor's declared write, or by the pinned spec. An undeclared
read is a plan validation failure before a single token is spent — pure reachability over the DAG,
roughly 60 lines, and the cheapest correctness gate in the system.

`returns.maxTokens` defaults to **1500** and is set per node _type_, not globally: a `gate` verdict
needs a few hundred, a recon node summarising a 200-file survey plausibly needs 4000. **Unverified:**
the 500–2000 token band from F6.4 traces to Anthropic's multi-agent research system and 2026
practitioner consensus; no controlled study establishes an optimum. Record oversize rate per node
type and tune from your own data rather than treating the number as settled.

### 3.2 The seven node types (F2.3)

```ts
export type PlanNode =
  | AgentNode
  | ToolNode
  | GateNode
  | HumanNode
  | MapNode
  | LoopNode
  | SubgraphNode;

export type AgentNode = NodeBase & {
  type: "agent";
  brief: string; // the scoped instruction, not a full prompt
  /** Planner intent. The scheduler resolves it against probed capabilities (F3.5, F2.7). */
  provider: { prefer: ProviderId[]; requires: AdapterRequirement[] };
  model?: string;
  /** Vendor session reuse is an optimisation, never the durability mechanism. */
  resume: "native-if-available" | "always-replay";
};

export type AdapterRequirement =
  | "structuredOutput"
  | "streaming"
  | "imageInput"
  | "mcp"
  | "resumableSessions"
  | { minContext: number }
  | { permission: PermissionLevel };

export type ToolNode = NodeBase & {
  type: "tool";
  tool:
    | { kind: "script"; run: string; cwd?: string }
    | { kind: "mcp"; server: string; tool: string; args: unknown }
    | { kind: "http"; method: string; url: string };
  /** Decides the reconcile strategy in the effect journal. Classified at plan time. */
  effectClass: "pure" | "mutating";
};

export type GateNode = NodeBase & {
  type: "gate";
  gate:
    | { kind: "deterministic"; gateId: GateId }
    | { kind: "adversarial"; brief: string };
  criteria: CriterionId[]; // F7.4 traceability
  /** F7.2: the producer cannot judge its own output. */
  independence: { notSessionOf: NodeId[]; preferDifferentProvider: boolean };
};

export type HumanNode = NodeBase & {
  type: "human";
  prompt: string;
  options: Array<{
    id: string;
    label: string;
    effect: "approve" | "reject" | "edit" | "inject";
  }>;
  /** Suspension is durable (node_wake), so a deadline of hours costs one SQLite row. */
  deadline?: {
    wakeAt: string;
    onTimeout: "fail" | "escalate" | "default";
    default?: string;
  };
};

export type MapNode = NodeBase & {
  type: "map";
  over: { kind: "fact"; key: string } | { kind: "glob"; pattern: string };
  concurrency: number;
  body: NodeId; // a subgraph node, instantiated once per item
  /** Item ids are derived deterministically so map children get stable NodeIds. */
  itemIdFrom: "index" | "value-hash";
};

export type LoopNode = NodeBase & {
  type: "loop";
  body: NodeId;
  maxRounds: number;
  goal: { kind: "gate"; gate: NodeId };
  /** F4.7 — the most expensive failure mode in autonomous loops. */
  noProgress: {
    sameFailureSignatureLimit: number;
    diffSimilarityThreshold: number;
  };
};

export type SubgraphNode = NodeBase & {
  type: "subgraph";
  graph:
    | { kind: "inline"; nodes: PlanNode[]; edges: PlanEdge[] }
    | { kind: "template"; templateId: string; params: Record<string, unknown> };
};
```

`map` deserves a note: children are materialised into the graph as real nodes with real `NodeId`s
(`<mapNodeId>--<itemId>`), because the scheduler, the effect journal and the scrubber all need them
to exist. `itemIdFrom: 'value-hash'` is the safe default — index-derived ids move if the collection
is re-derived after a replan, and moving ids is exactly what §1.1 forbids.

---

## 4. `PlanPatch` (F2.4, F2.5)

A patch is the _only_ way the graph changes at runtime. It is proposed as data, evaluated by the
policy engine, and then either applied, queued, or rejected — and all three outcomes are recorded.

```ts
export type PatchOp =
  | { op: "insert-nodes"; nodes: PlanNode[]; edges: PlanEdge[] }
  | { op: "split-node"; node: NodeId; into: PlanNode[]; edges: PlanEdge[] }
  | {
      op: "replace-provider";
      node: NodeId;
      provider: ProviderId;
      model?: string;
    }
  | { op: "extend-loop"; node: NodeId; maxRounds: number }
  | { op: "abandon-branch"; root: NodeId; reason: string };

export type PlanPatch = {
  schemaId: SchemaId; // 'DeFlow.planpatch.v1'
  id: string;
  proposedBy: NodeId | "planner" | "human" | "scheduler";
  reason: string; // rendered verbatim in the scrubber (F10.2)
  ops: PatchOp[];

  /** Everything below is what the policy engine reads. All of it is required. */
  policy: {
    estimatedCostDeltaUsd: number; // from the F9.3 pre-flight estimator
    estimatedWallClockDeltaMs: number;
    blastRadius: { paths: string[]; nodeCount: number };
    replanDepth: number; // distance from PlanGraph v1
    escalatesPermission: null | { from: PermissionLevel; to: PermissionLevel };
    addsWriteCapability: boolean;
  };
};

export type PatchDecision = {
  decision: "auto" | "approved" | "rejected" | "queued";
  by: "policy" | "human";
  rule?: string; // which declarative rule fired
  at: string;
};
```

The `policy` block is not advisory metadata. The default policy in F2.5 — auto-apply read-only
analysis, require approval for anything adding write capability, adding cost above a threshold, or
exceeding replan depth 3 — is expressible purely as predicates over these five fields, which is why
they are mandatory rather than optional. A patch that cannot fill them in is rejected at
validation. Rules and evaluation order live in
[planning and replanning](./06-planning-and-replanning.md).

`replan-because-a-provider-ran-out-of-quota` (F3.9) is a `replace-provider` patch proposed by
`scheduler`, not a special case — so provider rerouting shows up in the scrubber like everything
else.

---

## 5. `Fact` and the blackboard (F6.3)

> **This section answers PRD open question §15.2 ("Blackboard schema — fixed vocabulary or
> free-form typed facts?"). The answer is: a small fixed core plus one schema-validated free-form
> namespace.** The PRD's proposal was right; what follows is the concrete shape.

```ts
export type FactKind =
  | "finding"
  | "decision"
  | "artifact"
  | "scope"
  | "risk"
  | "verdict"
  | "ext";

export type Provenance = {
  byNode: NodeId;
  byProvider: ProviderId;
  byModel: string; // as reported by the adapter, verbatim
  fromEvidence: Handle[]; // artifact handles, file:line refs
  atEvent: EventSeq;
  at: string; // ISO 8601, display only — ordering is by atEvent
  confidence: "asserted" | "verified" | "speculative";
};

export type Fact = {
  id: FactId;
  /** 'finding/auth-uses-jwt' for core kinds; 'ext:migration/vue3-incompat-list' for the free space. */
  key: string;
  kind: FactKind;
  schemaId: SchemaId; // resolves to .DeFlow/schemas/<schemaId>.json
  value: unknown; // validated against schemaId by Ajv before acceptance
  provenance: Provenance;
  supersedes?: FactId;
  invalidatedBy?: EventSeq;
};
```

Six kinds, fixed, and they are the whole enumerated vocabulary:

| Kind       | Written by               | Typical shape                                           |
| ---------- | ------------------------ | ------------------------------------------------------- |
| `finding`  | recon and analysis nodes | an observation about the codebase, with evidence        |
| `decision` | planner, human nodes     | a choice made and the rationale for it                  |
| `artifact` | any node                 | a `Handle` plus a one-line description and size         |
| `scope`    | recon, planner           | a discovered path set, feeding F5.2 write serialisation |
| `risk`     | analysis and gate nodes  | something that might break, with a detection story      |
| `verdict`  | gate nodes only          | a `Verdict` (§7)                                        |

Anything else goes to `ext:<namespace>/<key>`. Ext facts are **schema-validated but not
enumerated**: you must register a `schemaId` in `.DeFlow/schemas/`, and after that DeFlow does not
care what the namespace means. Fixed core gives the marquee visualisations something renderable,
diffable and validatable; the ext space stops the vocabulary becoming a straitjacket the first time
you hit an unanticipated task archetype.

### 5.1 The blackboard is a projection, never a store

`fact.written` / `fact.read` / `fact.invalidated` events are the truth. The `fact` and `fact_edges`
tables are a materialised view you can `DROP` and rebuild from the ledger at any time. This is not
an implementation detail — it is what makes F10.4's memory graph and NF10's auditability fall out
for free instead of needing separate instrumentation. If the blackboard ever becomes independently
mutable, NF9 and NF10 are both gone.

### 5.2 Invalidation and taint

Because every read is an event, the consumer set of any fact is one indexed query. On
`fact.invalidated`, every node with a `fact.read` for that fact at a `seq` **earlier than** the
invalidation is marked `taint: 'stale-input'`.

Do not auto-re-run tainted nodes. Flag them, surface them in the approval queue, and let the F2.5
patch policy decide. Auto-re-running on invalidation is how you build a system that loops forever
for reasons no human can reconstruct.

---

## 6. `ContextPacket` and `Segment` (F6.1, F6.2, F10.3, F10.5)

```ts
export type SegmentKind =
  | "pinned.constraints"
  | "pinned.spec"
  | "pinned.pathscope"
  | "task.brief"
  | "fact"
  | "artifact.handle"
  | "retrieved"
  | "history.summary"
  | "tool.output";

export type TokenCount = {
  estimated: number;
  method: "gpt-tokenizer/o200k_base" | "heuristic" | "vendor-reported";
};

export type Segment = {
  id: SegmentId;
  kind: SegmentKind;
  sourceEvent: EventSeq; // which event put this here — click-through in the inspector
  contentHash: string; // sha256 of `text`
  text: string;
  tokens: TokenCount;
  pinned: boolean; // never eligible for compaction, always rendered first
  compactable: boolean; // pinned ⇒ !compactable, but not conversely
};

export type ContextPacket = {
  schemaId: SchemaId; // 'DeFlow.contextpacket.v1'
  runId: RunId;
  nodeId: NodeId;
  attempt: number;
  builtAtEvent: EventSeq;
  target: { provider: ProviderId; model: string; maxContext: number };
  budget: { fraction: number; limitTokens: number }; // default 0.5, never above 0.6
  segments: Segment[];
  totals: { tokens: number; byKind: Record<SegmentKind, number> };
  /** The rendered prompt is stored too — but derived, not authoritative. */
  renderedPromptHandle: Handle;
  pinnedDigests: string[]; // sha256 per pinned segment; the integrity check's input
};
```

### 6.1 Why the packet is a segment array and not a string

Four P0 requirements are literally unsatisfiable against a flat string:

- **F6.1 (no implicit context inheritance)** — you cannot prove a node received only what the engine
  gave it if the record of what it received is one blob.
- **F6.2 (declared reads/writes)** — a segment carries `sourceEvent`, so "this fact entered this
  packet because node X wrote it at seq N" is a field, not an inference.
- **F10.3 (node inspector)** and **F10.5 (context budget stacked bar)** — both need a per-segment
  token breakdown. You cannot recover one from a rendered prompt after the fact, and re-deriving
  segments by regex breaks the first time a segment's text contains your delimiter.
- **F6.6 (compaction audit)** — with addressable segments, compaction is a set operation over
  `SegmentId`s, so "what was dropped" is a list rather than a diff of two large strings.

`render(segments) -> string` is a pure function, which makes golden-file packet tests trivial and
zero-cost in CI. Store **both** the manifest (as the `context.built` payload) and the rendered
`prompt.txt` (as an artifact); the manifest is authoritative, the render is reproducible from it.

The segment vocabulary is not invented — it mirrors the categories Claude Code itself uses for its
own `/context` breakdown (system prompt, tools, MCP tools, agents, skills, memory files, then
messages split into user/assistant/tool-call/tool-result/attachment tokens, plus free space and an
autocompact buffer). **Verified 2026-08-02** by decompiling the shipping bundle. Reusing that
taxonomy means F10.5's chart lines up visually with what the user already sees inside the vendor CLI.

Ordering rule: pinned segments always render first, and `history.summary` segments render in the
chronological position of what they replaced rather than being lumped into a preamble. Details and
the fill order under budget pressure are in [context and memory](./08-context-and-memory.md).

---

## 7. `Verdict` and `Finding` (F7.3)

A gate returns a typed verdict with structured findings. Never a prose blob — a prose blob cannot be
attached to a diff line (F7.7), cannot be counted for gate first-pass rate, and cannot drive the
surgical repair loop (F7.5).

```ts
export type Verdict = {
  schemaId: SchemaId; // 'DeFlow.verdict.v1'
  outcome: "pass" | "fail" | "needs-human";
  gate: GateId;
  evaluatedNode: NodeId; // whose work was judged
  by: { node: NodeId; provider: ProviderId; model: string };
  /** F7.4: which criteria this gate speaks to, and what it concluded about each. */
  criteria: Array<{
    id: CriterionId;
    status: "satisfied" | "unsatisfied" | "unverifiable";
  }>;
  findings: Finding[];
  summary: string; // one line, for the board. Not the evidence.
};

export type Finding = {
  id: string;
  severity: "blocker" | "major" | "minor" | "info";
  criterion?: CriterionId;
  location?: { file: string; line: number; endLine?: number };
  message: string;
  evidence: Handle[]; // test output, build log, diff — always a handle, never inline
  suggestedFix?: string;
};
```

`needs-human` is a first-class outcome, not a failure mode. It is what an adversarial reviewer
returns when the question is genuinely a judgement call, and what a deterministic gate returns when
its own tooling failed (a flaky test runner, a missing binary) rather than the work being wrong.
Conflating it with `fail` sends work into the repair loop that no amount of repair will fix.

---

## 8. `NodeResult` and `NodeFailure`

**Every failure must be serialisable into the ledger and renderable in the node inspector. A thrown
`Error` with a V8 stack is neither.** It does not survive `JSON.stringify`, it does not survive a
daemon restart, its `message` is unstructured, and the inspector cannot do anything with it except
print it in a monospace box. So `NodeFailure` is a closed discriminated union, and the boundary
between "code that throws" and "the ledger" is exactly one function that maps thrown values onto it
(unmapped throws become `{ reason: 'internal' }` with the stack captured as a handle, and that is a
bug to be fixed, not a design).

```ts
export type NodeResult =
  | {
      status: "completed";
      output: unknown;
      outputSchemaId: SchemaId;
      usage: TokenUsage;
      costUsd: number;
      producedFacts: FactId[];
      artifacts: Handle[];
    }
  | { status: "failed"; failure: NodeFailure }
  | {
      status: "suspended";
      until: { kind: "human" | "wake" | "external"; wakeAt?: string };
    }
  | { status: "cancelled"; by: "user" | "policy" | "parent" };

export type NodeFailureReason =
  // adapter / transport
  | "adapter.spawn-failed" // binary missing, wrong path, non-executable
  | "adapter.handshake-failed" // ACP initialize failed or negotiated an unsupported version
  | "adapter.frame-too-large" // exceeded the 8 MiB line cap
  | "adapter.protocol-error" // valid JSON, invalid against the ACP schema
  | "adapter.malformed-output" // not JSON at all
  | "adapter.capability-missing" // node required something the adapter never advertised
  // agent-reported
  | "agent.nonzero-exit"
  | "agent.refused" // stopReason indicated refusal
  | "agent.max-turns"
  | "agent.schema-repair-exhausted" // maps Claude Code's error_max_structured_output_retries
  // contract
  | "contract.schema-invalid" // output failed Ajv validation (F6.9)
  | "contract.handoff-oversize" // over returns.maxTokens after a bounded repair (F6.4)
  // safety
  | "safety.pin-integrity-violated" // a pinned segment did not survive into the prompt (F6.6)
  | "safety.pathscope-violation" // wrote outside its declared scope (F5.3)
  | "safety.permission-unschedulable" // provider cannot express the requested level (F5.4)
  | "safety.execution-boundary" // hit a guarded operation without a human gate (F5.6)
  // resource
  | "budget.cost-exceeded"
  | "budget.wallclock-exceeded"
  | "timeout"
  | "provider.rate-limited"
  | "provider.unavailable"
  // orchestration
  | "effect.reconcile-unknown" // crash mid-effect, probe could not determine what happened
  | "effect.request-hash-mismatch" // the plan changed under a journaled effect
  | "dependency.failed" // a dep failed permanently; propagated
  | "gate.failed"
  | "internal";

export type NodeFailure = {
  reason: NodeFailureReason;
  /** Drives the scheduler: retry, fail the node, or suspend for a human. */
  class: "transient" | "permanent" | "gate";
  message: string; // human-readable, one line, safe to render
  detail?: Record<string, unknown>; // reason-specific, JSON only
  evidence: Handle[]; // stdout tail, the offending frame's first 4 KiB, the diff
  occurredAtEvent: EventSeq;
  attempt: number;
};
```

Two rules that matter more than they look:

1. **`class` is not derived from `reason` at render time.** The classifier assigns it when the
   failure is constructed, because the same reason can be transient or permanent depending on
   context (`provider.unavailable` is transient for a rate-limited vendor, permanent for a binary
   the user uninstalled mid-run). The scheduler reads `class` and nothing else.
2. **`effect.reconcile-unknown` always escalates to a human.** There is no correct automatic action
   when the reconcile probe cannot determine whether a mutating effect landed. Design that gate on
   day one rather than bolting it on — see [durable execution](./05-durable-execution.md).

```ts
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  source: "vendor-reported" | "estimated";
};
```

`source` is mandatory and must never be silently mixed. Vendor-reported figures come from the CLI's
result envelope (Claude Code's `modelUsage[model]`, Codex's `turn.completed.usage`) and are the
billing truth; estimated figures come from `gpt-tokenizer`'s `o200k_base` encoding and carry a known
15–20% undercount on Claude prose and worse on code. A budget ceiling (F4.6) computed from a
silently-mixed number fires at the wrong time. **Verified 2026-08-02** for the envelope shapes.

---

## 9. The Event union

This expands PRD §9.3 into the full set. Every event carries the same envelope; `kind` and `v` are
the only fields the reducer is allowed to branch on before upcasting.

```ts
export type EventEnvelope<K extends string, P> = {
  seq: EventSeq;
  runId: RunId;
  ts: number; // ms epoch, informational only — ORDER IS seq
  kind: K;
  v: number; // payload schema version, for upcasting
  epoch: number; // daemon epoch; stale-epoch writes are rejected
  nodeId?: NodeId;
  attempt?: number;
  ikey?: IdempotencyKey;
  payload: P;
};
```

| `kind`                                      | Payload (abridged)                                                                       | Why it exists                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `run.created`                               | `{ spec: TaskSpec; cwd: string; repo: { head: string; branch: string } }`                | F1.1                                                                                                 |
| `run.spec.approved`                         | `{ specHash: string; by: 'ui' \| 'cli' }`                                                | F1.3 — the gate, recorded                                                                            |
| `run.started`                               | `{ planHash: PlanHash }`                                                                 |                                                                                                      |
| `run.paused` / `run.resumed`                | `{ by: 'user' \| 'policy'; reason?: string }`                                            | F4.4 — pause is an **event**, never an in-memory flag                                                |
| `run.cancel.requested`                      | `{ mode: 'cooperative' \| 'forceful' }`                                                  | F5.7 kill switch                                                                                     |
| `run.completed` / `run.aborted`             | `{ outcome; criteriaSatisfied: CriterionId[] }`                                          |                                                                                                      |
| `run.stalled`                               | `{ watermarkSeq: EventSeq; idleMs: number; runningNodes: NodeId[] }`                     | F4.7 stall detector. Surfaced, **never auto-killed** — a long build looks identical                  |
| `run.needs_human`                           | `{ reason: 'churn' \| 'budget' \| 'reconcile-unknown'; detail }`                         | circuit breaker trip                                                                                 |
| `plan.proposed`                             | `{ version: number; planHash: PlanHash; graph: PlanGraph; by }`                          | F2.2                                                                                                 |
| `plan.patch.proposed`                       | `{ patch: PlanPatch }`                                                                   | F2.4 — **the proposal is recorded even if rejected**                                                 |
| `plan.patched`                              | `{ version; fromHash; toHash; patchId; decision: PatchDecision }`                        | F2.5                                                                                                 |
| `plan.patch.rejected`                       | `{ patchId; rule: string; by: 'policy' \| 'human' }`                                     |                                                                                                      |
| `node.scheduled`                            | `{ node: NodeId; provider: ProviderId; model?; permission: PermissionLevel; worktree? }` | `worktree` is the assignment F5.2's per-worktree lock is keyed on                                     |
| `node.lock.acquired` / `node.lock.released` | `{ node: NodeId; lock: 'repo' \| 'worktree'; key: string }`, released also `{ reason? }` | F5.2 — locks live in the ledger so they survive restart. `reason: 'reclaimed'` is the scheduler taking one back from a node that stopped running |
| `node.started`                              | `{ node; attempt; ikey; binary: { path; version; sha256 } }`                             | **Written before the side effect.** This record is what makes at-least-once recovery possible at all |
| `node.progress`                             | `{ node; attempt; phase: string; message?: string; ioChunkSeq?: number }`                | F10.1/F10.6 live status. Cheap, frequent, and it does **not** advance the progress watermark         |
| `node.completed`                            | `{ node; attempt; result: Extract<NodeResult, {status:'completed'}> }`                   |                                                                                                      |
| `node.failed`                               | `{ node; attempt; failure: NodeFailure }`                                                |                                                                                                      |
| `node.retry.scheduled`                      | `{ node; nextAttempt; wakeAt: number }`                                                  | written in the **same transaction** as `node.failed`                                                 |
| `node.suspended`                            | `{ node; until }`                                                                        | F4.8 long suspension                                                                                 |
| `node.blocked`                              | `{ node; conflictsWith; branch; otherBranch; paths: string[] }`                           | F5.2 / D14 — `git merge-tree` found two in-flight branches conflicting, so the later-*starting* node is demoted (09-workspace-and-safety §6.2, §7.3). `paths` is what `--name-only` reported, which is the difference between "these conflict" and a diagnosis |
| `node.unschedulable`                        | `{ node; provider; version; permission: PermissionLevel; reason: string }`                | F5.4 — the adapter cannot mediate execution, so DeFlow can enforce nothing above `read` and refuses to schedule (09-workspace-and-safety §8.3). Its own kind rather than only the `node.failed` that follows: a failure is where a node *ended*, and this is why it never began. `reason` is a code (`mediatedExecution:false`), never prose |
| `permission.denied`                         | `{ node; attempt; permission: PermissionLevel; method; requested: string; reason: { code; detail? } }` | F5.3/F5.4 — a mediated `fs/*`, `terminal/create` or network request DeFlow refused at the ACP boundary (09-workspace-and-safety §8.2). `requested` is the agent's own string, kept verbatim beside the resolution it was decided on; `reason` is a structured code (`path-escape` + `traversal`\|`symlink`\|`absolute`\|`invalid`), never a message, because the node inspector renders it and KAR-08.3's gate budget counts by it |
| `node.cancelled`                            | `{ node; attempt; result: Extract<NodeResult, {status:'cancelled'}> }`                   | F5.7 — the terminal record of a stopped attempt. Not a `node.completed` (whose payload cannot carry it) and not a `node.failed` (a stopped node did not fail) |
| `node.cancel.stage`                         | `{ node; attempt; stage: 'protocol' \| 'sigterm' \| 'sigkill' \| 'verified'; mode; pid; pgid }` | F5.7 — one per rung of §11.1's ladder. **`pgid` as well as `pid`**: the group is what was signalled |
| `node.cancel.failed`                        | `{ node; attempt; pid; pgid; survivors: number[] }`                                      | F5.7 — a kill that did not take is an event, not a silent condition. `survivors` excludes `Z`-state pids |
| `workspace.worktree_created`                | `{ node; path; branch: string \| null; baseRef; detached: boolean; lockReason }`          | F5.1 — created *and locked* in one `git worktree add` (§4.1 of 09-workspace-and-safety). `branch` is `null` for a read node's detached checkout |
| `workspace.branch_occupied`                 | `{ node; branch; occupiedBy: string; occupantKind: 'worktree' \| 'main-checkout' }`       | F5.1 — refused **before** `worktree add` runs, from the porcelain list rather than from git's error text. `main-checkout` is the operator's own current branch, which is the common real-world hit |
| `workspace.included_file`                   | `{ node; path; mode: string }`                                                            | F5.1 — one per `.worktreeinclude` file copied into a new worktree (§5.1 Layer 1). The **path only**: these files are `.env`-shaped and their contents never enter the ledger. `mode` is the source's octal, preserved by the copy |
| `workspace.setup_cache_hit`                 | `{ node; key: string; files: string[] }`                                                  | NF6 — `workspace.setup` was skipped because the sha256 of its `setupCacheKey` files already has a success marker (§5.1 Layer 3). Keyed on content, so a lockfile that changes and changes back is still a hit |
| `workspace.dirty_on_remove`                 | `{ node; path; entries: StatusEntry[] }`                                                 | F5.1 — the parsed `status --porcelain=v2 -z` of a worktree an agent left dirty, appended **before** anything is committed or removed (§4.4). A worktree holding only gitignored files never produces one |
| `workspace.wip_salvaged`                    | `{ node; path; branch; detached: boolean; oid; files: number }`                          | NF8 — the `DeFlow: WIP salvage` commit. `--force` becomes acceptable only once this is durable; `branch` is the throwaway `DeFlow/salvage/<runId>__<nodeId>` when the checkout was detached |
| `workspace.worktree_removed`                | `{ node; path; branch: string \| null; tipOid: string \| null }`                          | F5.5 — the branch outlives the worktree, because the branch is the deliverable; `tipOid` is what the integration loop later merges |
| `workspace.reconciled`                      | `{ added: string[]; removed: string[]; prunable: string[] }`                              | F5.1 — git is the authority. The `worktrees` table is a projection refreshed from `worktree list --porcelain -z`, so an operator's own `git worktree remove` reconciles rather than erroring |
| `workspace.pid_recycled`                    | `{ node; pid: number; recorded: string \| null; observed: string \| null }`               | F4.2 — the boot reaper refused to signal a live pid because the OS reports a different start time for it than the one recorded at spawn (§11.3 step 1). Both values travel so the refusal is auditable; they are opaque platform strings, only ever compared for equality |
| `workspace.orphan_reaped`                   | `{ node; path; pid: number \| null }`                                                     | F4.2 — a worktree whose owning process did not survive the restart was unlocked and removed with `remove -f -f` (§4.5). Only reachable once the owner is provably gone; the branch is untouched, because the branch is the deliverable |
| `workspace.merge_queue_reordered`           | `{ branch; mergedNode: NodeId; before: NodeId[]; after: NodeId[] }`                       | F5.2 — a merge changes every remaining branch's conflict count, so the integration queue is re-probed and re-sorted after each one (§7.1 of 09-workspace-and-safety). Both orders are recorded, because a reordering nobody can see is indistinguishable from an order that never changed |
| `effect.started`                            | `{ ikey; kind: EffectKind; requestHash: string }`                                        | the write-ahead intent record                                                                        |
| `effect.completed`                          | `{ ikey; result: unknown; reconciled: boolean }`                                         | memoised on restart                                                                                  |
| `effect.cancelled`                          | `{ ikey; result: Extract<NodeResult, {status:'cancelled'}> }`                            | F5.7 — the attempt was stopped, so the row goes terminal rather than waiting to be reconciled. Not an `effect.failed`: a `NodeFailure` reason describes work going wrong, and a kill switch is not one |
| `effect.failed`                             | `{ ikey; failure: NodeFailure }`                                                         |                                                                                                      |
| `context.built`                             | `{ node; attempt; packet: ContextPacket }` (minus segment `text`)                        | F10.3, F10.5                                                                                         |
| `context.compacted`                         | see below                                                                                | F6.6                                                                                                 |
| `pin.integrity_violated`                    | `{ node; attempt; missingDigests: string[]; segmentIds: SegmentId[] }`                   | F6.6 — fails the node                                                                                |
| `fact.written`                              | `{ fact: Fact }`                                                                         | F6.3                                                                                                 |
| `fact.read`                                 | `{ factId; key; by: NodeId }`                                                            | makes the consumer set one query                                                                     |
| `fact.invalidated`                          | `{ factId; by: NodeId; reason: string; taints: NodeId[] }`                               | §5.2                                                                                                 |
| `handoff.oversize`                          | `{ node; attempt; budget: number; actual: number; repairAttempted: boolean }`            | F6.4 enforcement                                                                                     |
| `gate.evaluated`                            | `{ gate: GateId; node: NodeId; verdict: Verdict }`                                       | F7.3                                                                                                 |
| `human.requested`                           | `{ node; prompt; options; deadline?; reason? }`                                          | F8.1 — `reason` is the `PermissionReason` when the safety layer escalated (KAR-08.3)                  |
| `human.responded`                           | `{ node; optionId; text?; at }`                                                          |                                                                                                      |
| `budget.consumed`                           | `{ node?; provider; usage: TokenUsage; costUsd: number }`                                | F9.1                                                                                                 |
| `budget.exceeded`                           | `{ scope: 'node' \| 'run'; dimension: 'cost' \| 'wallclock'; limit; actual }`            | F4.6 — **pauses, does not fail**                                                                     |
| `provider.probed`                           | `{ provider; version; capsJson: unknown; binarySha256: string }`                         | F3.4/F3.5 — capabilities are derived, never hardcoded                                                |
| `provider.rate_limited`                     | `{ provider; resetsAt?: number; raw: unknown }`                                          | parsed from Claude Code's `rate_limit_event` frame                                                   |
| `export.blocked`                            | `{ target: 'report' \| 'hub'; reason: 'redaction-failed' \| 'findings'; count: number }` | F5.9 — redaction **fails closed**                                                                    |

### 9.1 `context.compacted` carries a fidelity discriminator

```ts
type ContextCompacted = {
  node: NodeId;
  scope: "DeFlow.packet" | "vendor.session";
  fidelity: "exact" | "partial"; // 'partial' ⇒ vendor-reported, numbers are incomplete
  trigger: "threshold" | "manual" | "vendor.auto";
  before: number;
  after: number | null; // null when vendor-reported
  droppedSegments: SegmentId[]; // [] when vendor-reported
  demotedToHandles: Handle[];
  pinnedKept: string[]; // sha256 list — proves the integrity check passed
  originalHandle: Handle | null;
};
```

This shape exists because half the data F6.6 asks for is genuinely unavailable for in-CLI
compaction. Claude Code's `stream-json` emits
`{ type:'system', subtype:'compact_boundary', compact_metadata: { trigger, pre_tokens } }` —
`pre_tokens` only, no post count, no dropped list, no handle to the original. **Verified 2026-08-02.**
Encoding that uncertainty in the type is the difference between an auditable system and one that
quietly lies: a chart with a fabricated "after" number is worse than an honest gap.

### 9.2 The envelope and versioning rule

Three rules, and they are not negotiable because they are what lets a user downgrade `DeFlowd`
without corrupting a run:

1. **The reducer is pure and total.** `reduce(state: RunState, e: Event): RunState` performs no I/O,
   reads no clock, and returns a value for every input. It is unit-testable with zero setup, which
   is what makes the whole scheduler testable with a fake clock.
2. **The reducer MUST ignore unknown `kind` values.** Not throw, not log-and-throw, not
   `assertNever`. Return `state` unchanged. A user who installs a newer `DeFlowd`, starts a run, then
   downgrades, must get a daemon that skips the events it does not understand rather than one that
   refuses to open the ledger. This is the single forward-compatibility mechanism in the system.
3. **Payload evolution goes through an upcaster chain applied at read time.**

```ts
export type Upcaster = (payload: unknown) => unknown;

/** Registered per (kind, fromVersion). Chained until the payload reaches the current version. */
export function upcast(kind: string, v: number, payload: unknown): unknown;
```

Events are never rewritten on disk — the ledger is append-only and immutable, so a v1 payload
written in March is still a v1 payload in December. `upcast` runs on the way into the reducer.
Upcasters are pure, append-only, and never deleted: the chain from v1 to v4 must still exist when
v5 ships. If an upcaster cannot be written (a genuinely lossy schema change), that is a new `kind`,
not a new `v`.

Plan versioning needs no equivalent machinery: plans are immutable content-addressed documents, so a
replan writes a new row and a `plan.patched` event. That is the second half of the two-layer
versioning story, and it is free.

---

## 10. Pitfalls

- **Do not put a thrown `Error` anywhere near the ledger.** Map it to `NodeFailure` at the boundary.
  A stack trace goes in an artifact behind a `Handle`, never in a payload.
- **Do not reuse a `NodeId`,** including after a branch is abandoned, including for map children
  after a collection is re-derived. The effect journal will hand you a memoised result belonging to a
  different node and there is no way to detect it.
- **Do not assume `seq` is contiguous.** Rolled-back transactions burn values. Every cursor contract
  is "strictly greater than".
- **Do not derive `NodeId` from index position** in `map` nodes. Use `value-hash`.
- **Do not use `ohash` for `planHash`.** Its stable-serialisation promise is "best efforts"; that is
  fine for UI change detection and wrong for a primary key.
- **Do not mix estimated and vendor-reported token counts** in a single number. Keep `source` and
  keep them separate all the way to the chart.
- **Do not treat `needs-human` as a `fail`.** Repair loops cannot fix judgement calls, and you will
  burn three attempts discovering that.
- **Do not let the blackboard become independently writable.** It is a projection. The moment it has
  its own mutation path, NF9 and NF10 are gone and the memory graph starts lying.
- **Do not make the reducer throw on an unknown `kind`.** It is the only thing standing between a
  version downgrade and a corrupted run.
- **Do not inline large payloads into event payloads.** Anything over ~256 KiB spills to the
  content-addressed blob store and the event keeps `{ sha256, bytes, mime, head, tail }`. Replay time
  is a function of ledger size, and un-spilled tool output is what makes it explode.
- **Do not add an `enum`.** `erasableSyntaxOnly: true` (D4) forbids it, and a string-literal union
  round-trips through JSON while an enum does not.

---

**Related:** [Durable execution](./05-durable-execution.md) ·
[Planning and replanning](./06-planning-and-replanning.md) ·
[Context and memory](./08-context-and-memory.md) ·
[Verification gates](./10-verification-gates.md) ·
[API and realtime](./11-api-and-realtime.md)

[← Back to index](./README.md)
