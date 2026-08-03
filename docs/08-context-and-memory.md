# Context and memory

> Part of the [Karvan architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This is the layer that makes long-horizon work possible. Because the PRD wants it *visible*
(F10.3, F10.4, F10.5), it must be designed to be rendered, not merely to function. Every decision
below is taken twice: once for what the agent receives, and once for what the UI can honestly draw
afterwards.

Type definitions for `ContextPacket`, `Segment`, `Fact`, `Provenance` and the event union live in
[the domain model](./04-domain-model.md). This document is the *behaviour*: how a packet gets
assembled, what is pinned and how that is enforced, who owns compaction, how tokens are counted,
and what retrieval does at M1.

**One rule governs the whole layer, and it follows from [AR-1](./15-security-model.md):** Karvan
does not own the model call. It owns the *boundary* around the model call. Everything below is
either something Karvan fully controls (the packet), something it can only steer (in-CLI
compaction), or something it can only observe partially (vendor token counts). Conflating those
three is how you end up with a dashboard that lies.

---

## 1. Four tiers, explicit and separate (F6.6)

| Tier | Contents | Lifetime | Storage | Source of truth? |
|---|---|---|---|---|
| **T1 Run Ledger** | Every event, immutable, ordered by `seq` | Forever, per run | `$XDG_DATA_HOME/karvan/ledger.db` (one global SQLite database, append-only, every table keyed by `run_id`) | **Yes.** Everything else is a projection |
| **T2 Blackboard** | Typed facts and artifact handles with provenance | Run lifetime | materialised view in the same DB, rebuildable | No — projection of `fact.*` events |
| **T3 Context Packet** | Exactly what one node's agent received, per attempt | Per node invocation | `context.built` manifest + blobs in the CAS | No — manifest is a ledger payload |
| **T4 Workspace** | Git worktree, files, build outputs | Per branch | `.karvan/wt/<runId>__<nodeId>/`, branch `karvan/<runId>__<nodeId>` | No — git is authoritative for its own contents |

A fifth store exists but is deliberately **not** a tier of run memory: cross-run project memory
(F6.8, M3) lives in `.karvan/memory/project.db`, a separate SQLite file with a separate lifecycle.
This is the LangGraph checkpointer/store split, and keeping the files apart is what lets run
retention and GC differ from curated long-term memory. See §10.

The tiers exist to make one question answerable: *which tier was this byte in when it reached the
model?* If a fact is in T2 but not in any T3 packet, no agent saw it. If it is in a T3 packet, the
segment's `sourceEvent` says exactly which T1 event put it there.

### 1.1 Everything is a ledger projection

The blackboard is **never** a second mutable store. `fact.written`, `fact.read` and
`fact.invalidated` are the truth; the `fact` and `fact_edges` tables can be dropped and rebuilt
from the ledger at any time. This is already the durability contract in
[05-durable-execution](./05-durable-execution.md), and it is what makes F10.4's memory graph and
NF10's auditability fall out for free rather than needing separate instrumentation.

---

## 2. No implicit inheritance, declared reads and writes (F6.1, F6.2)

> **F6.1:** a node receives what the engine constructs for it and nothing else.
> **F6.2:** each node declares typed `reads` and `writes`; undeclared reads fail plan validation.

These two are one mechanism seen from two sides. The engine assembles the packet *from the
declarations* — there is no code path by which a parent node's transcript, a sibling's output, or
a previous attempt's history leaks into a packet without a declaration naming it.

That is what makes an edge in the memory graph labelable. F10.1 wants edges labelled with what
flows across them, and F10.4 wants facts as nodes with reads and writes as edges. Both are trivial
queries *because* the set of things that crossed the edge is a declared, finite, typed list —
and impossible if context is inherited implicitly, because then the honest label on every edge is
"everything, probably".

### 2.1 Plan-time validation

`PlanGraph` validation walks the DAG and asserts that every node's declared `reads` are satisfied
either by some **ancestor's** declared `writes` or by the pinned spec. An unsatisfiable read is a
plan validation failure before a single token is spent. This is pure graph reachability — roughly
60 lines — and it is the cheapest correctness gate in the system.

```ts
// packages/planner/src/validate-reads.ts (sketch)
export function validateDeclaredReads(g: PlanGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const writesByNode = new Map(g.nodes.map(n => [n.id, new Set(n.writes)]));
  for (const node of g.nodes) {
    const reachable = new Set<string>(PINNED_KEYS);            // spec, criteria, scopes
    for (const anc of ancestorsOf(g, node.id)) {
      for (const k of writesByNode.get(anc) ?? []) reachable.add(k);
    }
    for (const key of node.reads) {
      if (!satisfies(reachable, key)) {
        errors.push({ code: 'undeclared-read', node: node.id, key });
      }
    }
  }
  return errors;
}
```

`satisfies` handles prefix matches for `ext:` namespaces and glob keys. Run it on every
`plan.proposed` and every `plan.patched` — a `PlanPatch` that introduces an undeclared read is
rejected by the patch policy engine ([06-planning-and-replanning](./06-planning-and-replanning.md))
with the same error code.

### 2.2 What "nothing else" does not mean

It does not mean the agent cannot discover things. A node with `read` permission can still grep the
repo, and the vendor CLI will still load its own `CLAUDE.md`. F6.1 governs *what Karvan puts in the
packet*, not what the harness does with its own filesystem access. Two consequences:

- The `/context` categories Karvan does not control (system prompt, system tools, MCP tools,
  agents, slash commands, skills, memory files) are still a real slice of the window. Budget for
  them — see §6.2.
- Repo-derived discovery is not provenanced. If a node's finding matters downstream, it must be
  written as a `Fact` with evidence handles, which is where provenance (F6.3) attaches.

---

## 3. The ContextPacket is a segment array

Not a string. Four P0 requirements are literally unsatisfiable against a flat blob — the argument
is in [04-domain-model §6.1](./04-domain-model.md). The mechanics:

```ts
type SegmentKind =
  | 'pinned.constraints' | 'pinned.spec' | 'pinned.pathscope'
  | 'task.brief' | 'fact' | 'artifact.handle' | 'retrieved'
  | 'history.summary' | 'tool.output';
```

- Each `Segment` carries `sourceEvent` (click-through in the node inspector), `contentHash`
  (sha256 of `text`), a `tokens: { estimated, method }` pair, and the `pinned` / `compactable`
  flags.
- **Persist the manifest as the `context.built` event payload** — everything except the segment
  `text`. Persist the `text` blobs in the content-addressed artifact store under
  `runs/<runId>/artifacts/<sha256>/`.
- **`render(segments) -> string` is a pure function.** No clock, no I/O, no randomness. That is
  what makes golden-file packet tests free (§11) and NF9's deterministic-core requirement hold at
  this layer.
- **Store both** the manifest and the rendered `prompt.txt`. The manifest is authoritative; the
  render is reproducible from it. `prompt.txt` exists because NF8 wants every artifact inspectable
  on disk in an open format, and because when something goes wrong you want the literal bytes.

### 3.1 The taxonomy mirrors Claude Code's own `/context` breakdown

**Verified 2026-08-02** by decompiling the category list from Claude Code 2.1.220's shipping bundle
(`/opt/node22/lib/node_modules/@anthropic-ai/claude-code/cli.js`). It splits the window into:

| Claude Code `/context` band | Karvan analogue |
|---|---|
| System prompt | not Karvan's (harness-owned) — reserve, do not model |
| System tools | harness-owned |
| MCP tools | Karvan's MCP host contributes here (see [07](./07-provider-adapter-layer.md)) |
| Agents | harness-owned |
| Slash commands | harness-owned |
| Skills | harness-owned |
| Memory files (`CLAUDE.md`) | harness-owned, repo-derived |
| `userMessageTokens` | `task.brief`, `pinned.*`, `fact`, `retrieved`, `artifact.handle` |
| `assistantMessageTokens` | in-session, observed post-hoc only |
| `toolCallTokens` / `toolResultTokens` | `tool.output` |
| `attachmentTokens` | `artifact.handle` bodies when inlined |
| Free space | `limitTokens - totals.tokens` |
| Autocompact buffer | the vendor's reserve — see §5.1 |

This is not cosmetic. F10.5's stacked bar should use these bands so that a user who runs `/context`
inside Claude Code and then opens Karvan's node inspector sees the *same* decomposition of the same
window. Inventing a parallel vocabulary would mean the two never reconcile, and the first time they
disagree the user will believe the tool they can see with their own eyes.

Karvan-owned bands are measured (§6). Harness-owned bands are unknown until the first result
envelope arrives, at which point `modelUsage[m].inputTokens` minus the packet estimate gives you the
harness overhead for that (provider, model) — worth recording and reusing as a reserve.

---

## 4. Constraint pinning (F6.6)

This is the single highest-value safety mechanism in the memory layer, and it is about fifteen
lines of code.

The motivating result is arXiv **2606.22528**, *Governance Decay: How Context Compaction Silently
Erases Safety Constraints in Long-Horizon LLM Agents* (Shiyang Chen, Beijing Institute of
Technology; submitted 21 June 2026, currently v2). It introduces the **ConstraintRot** benchmark
with deterministic tool-call violation grading. Reported: across 1,323 episodes over seven model
families, the constraint-violation rate is 0% with the policy fully in context and rises to **30%
after compaction, reaching 59% for the worst model**; the paper's mitigation — a pinned buffer
exempt from compaction, re-injected verbatim with integrity checking — restores the rate to 0%
across all seven models at negligible cost.

> **Citation confidence.** These numbers were obtained by search-engine indexing of the arXiv
> abstract and HTML pages, not by reading the PDF — `arxiv.org` and `export.arxiv.org` are both
> unreachable from the verification environment (403 via the agent proxy, blocked by egress
> allowlist). The paper's existence, ID, title, authors and abstract text were confirmed
> consistently across independent queries. **Re-verify the specific figures against the PDF before
> quoting them publicly.** The same caveat applies to every arXiv number in this document.

### 4.1 The three mechanisms from the paper

**(1) The pinned set.** Segments with `pinned: true` are, exactly:

| Pinned content | Segment kind | Source |
|---|---|---|
| `TaskSpec` goal and non-goals | `pinned.spec` | F1.2, approved at F1.3 |
| Acceptance criteria | `pinned.spec` | F1.2 / F7.4 |
| Safety constraints | `pinned.constraints` | run config + F5.6 execution-boundary rules |
| Declared path scopes | `pinned.pathscope` | F5.3 |
| The node's permission level | `pinned.constraints` | F5.4 |

They are never eligible for compaction and are **always rendered first** in the packet.

**(2) Verbatim re-injection.** After any compaction, re-emit the *identical bytes*. Do not let a
summariser paraphrase them, do not reformat them, do not renumber a list. The paper's result is
specifically about verbatim re-injection; a paraphrase is an untested intervention.

**(3) The integrity check.** After rendering, assert that each pinned segment's sha256 still
corresponds to text present in the outgoing prompt. On mismatch, **fail the node** with
`pin.integrity_violated` rather than proceeding.

```ts
// packages/context/src/pin-integrity.ts — the whole mechanism
import { createHash } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function assertPinIntegrity(packet: ContextPacket, rendered: string): void {
  const missing: string[] = [];
  const ids: SegmentId[] = [];
  for (const seg of packet.segments) {
    if (!seg.pinned) continue;
    if (sha256(seg.text) !== seg.contentHash || !rendered.includes(seg.text)) {
      missing.push(seg.contentHash);
      ids.push(seg.id);
    }
  }
  if (missing.length > 0) {
    throw new PinIntegrityViolation({ missingDigests: missing, segmentIds: ids });
  }
}
```

The thrown error is caught by the node runner, which appends `pin.integrity_violated`
(`{ node, attempt, missingDigests, segmentIds }`) and fails the node with
`reason: 'pin-integrity'`. **It does not retry silently.** A pin that vanished is either a bug in
the packet builder or a rendering path nobody expected, and both want a human.

The successful case is recorded too: `context.compacted.pinnedKept` carries the sha256 list, which
is the positive evidence that the check ran and passed.

### 4.2 The fourth mechanism: prohibitions decay, requirements persist

From the companion paper, arXiv **2604.20911**, *Omission Constraints Decay While Commission
Constraints Persist in Long-Context LLM Agents* (4,416 trials, 12 models, 8 providers). Reported:
omission compliance — following a *don't* — falls from **73% at turn 5 to 33% at turn 16**, while
commission compliance — following a *do* — holds at **100%**. They call the asymmetry
**Security-Recall Divergence**, and note it is invisible to standard monitoring, because the
commission-type audit signals stay healthy while the prohibitions rot. Same search-indexed
citation caveat as §4.

This is a *distinct* failure mode from compaction deletion — which is why the PRD's phrase in F6.6,
"distinct from ordinary long-context attention dilution", is correct. You need both mitigations,
not one. Two additions:

**(a) Re-inject on a turn interval, not only on compaction.** The paper calls the per-model
interval the *Safe Turn Depth*. Start at every **8 turns**, make it configurable per adapter:

```yaml
# .karvan/config.yaml
providers:
  claude:
    pinReinjectTurns: 8
  codex:
    pinReinjectTurns: 8
```

Where the adapter supports mid-session steering (F8.5 / ACP `session/prompt` continuation), the
re-injection is an appended turn carrying the pinned segments verbatim. Where it does not, the
interval is enforced by keeping nodes short — a node that runs 30 turns without a re-injection
point is a planning smell, and the packet builder should warn.

**(b) Restate every prohibition as a positive requirement, mechanically, in the packet builder.**
Not as a style guideline for whoever writes the spec — as a transformation applied at build time,
so it happens even when a human wrote the constraint carelessly.

| Written as | Emitted into the packet as |
|---|---|
| do not write outside `src/checkout/**` | **only** write files under `src/checkout/**` |
| never run migrations | run **only** the commands listed in the allowed-commands set |
| do not touch the default branch | commit **only** to `karvan/<runId>__<nodeId>` |
| do not exceed 3 fix attempts | stop after at most 3 fix attempts and escalate to a human |

Implementation: constraints are authored as structured objects, not prose, so the transformation is
a render choice rather than NLP.

```ts
type Constraint =
  | { form: 'allow-only'; subject: 'write-path' | 'command' | 'branch'; allowed: string[] }
  | { form: 'require';    statement: string }
  | { form: 'forbid';     subject: string; forbidden: string[] };  // last resort
```

`forbid` exists because some constraints genuinely have no closed positive form ("do not exfiltrate
credentials"). Render those *last* among the pinned constraints and count them: a rising `forbid`
ratio in a run's spec is a leading indicator of the decay this section exists to prevent, and it is
worth a line in `karvan doctor`.

### 4.3 Gates evaluate against the pinned spec, not against context

Follows directly from Security-Recall Divergence being invisible to ordinary monitoring: do not
treat "the gates are passing" as evidence that prohibitions are being honoured. Verification gates
([10-verification-gates](./10-verification-gates.md)) read the `TaskSpec` from the ledger, not from
whatever the agent believes the spec was. F1.5 already requires this; §4.2 is the reason it is not
optional.

---

## 5. Compaction, split in two

Because of AR-1 you own exactly half of this problem. Treat the halves as different subsystems with
different guarantees.

### 5.1 Inside a CLI invocation: you steer, you do not own

**Verified 2026-08-02**, by reading the shipping bundle of Claude Code 2.1.220. These are real
constants from the binary, not documentation:

```
effectiveWindow   = contextWindow - min(maxOutputTokens, 20_000)   // WUY = 20000
autoCompactThresh = effectiveWindow - 13_000                       // fhA = 13000
warningBuffer     = 20_000 (GUY)   errorBuffer = 20_000 (ZUY)   blockingBuffer = 3_000 (VhA)
```

For a 200k window with 32k max output: effective = 180k, auto-compaction fires at **167k**, i.e.
about **83.5%** of the raw window. Env controls: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (a float 0–100,
a percentage *of the effective window*), `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`.

> **The gotcha, verified in the code.** The override is applied as
> `Math.min(pct * effectiveWindow, defaultThreshold)`. It can therefore only ever move the threshold
> **earlier**, never later. Do not design a policy that assumes you can extend a session past the
> vendor's threshold — that lever does not exist.

Which happens to be exactly the direction F6.6 wants: *"compaction triggers proactively at a
configured budget fraction, not at exhaustion."* So set it, deliberately:

```yaml
providers:
  claude:
    autocompactPct: 70        # → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70, write-capable nodes
```

Default 70 for write-capable nodes. `read`-level nodes may opt into `DISABLE_AUTO_COMPACT=1` for
exact numbers (§5.3), accepting that this converts graceful degradation into a hard
context-exhaustion failure mid-node.

**Budget for the summariser itself.** The internal summariser is bounded at
`{ minTokens: 10_000, maxTokens: 40_000, minTextBlockMessages: 5 }`. A compaction summary can
therefore consume up to 40k tokens on its own, which means a "compacted" context can still be
large. If your packet occupies 50% of the window and the vendor then compacts, the post-compaction
floor is your packet plus up to 40k — plan the fill fraction accordingly.

**These constants are private implementation details of one version with no compatibility
guarantee, and they will change.** Assert them in the adapter conformance suite (F3.4) so drift is
caught by `karvan doctor` and not by a failed three-hour run. Prefer reading
`modelUsage[m].contextWindow` and `maxOutputTokens` from the result envelope at runtime over
hardcoding anything.

### 5.2 At the packet boundary: offload, don't summarise

Between nodes, Karvan owns everything, and the rule is absolute: **offload, don't summarise.**

Budget is a fraction of the target adapter's declared `maxContext` from its F3.5 capability
manifest. **Default 0.5, never above 0.6.** Fill order:

1. **Pinned segments** — always, uncompressible, rendered first.
2. **Task brief** — the node's scoped instruction.
3. **Declared reads** — the F6.2 `reads` list, resolved from the blackboard.
4. **Retrieved facts** — §9, only if the node declares retrieval.
5. **Artifact handles** — descriptions plus `artifact://<sha256>`.

When the budget is exceeded, **never** summarise a fact or an artifact. Demote its body to a handle:

```
artifact://3f2a…c91  build-log for `pnpm -r build` (fail)  · 412 lines · 38.4 KB
  → pull with the `karvan_read_artifact` MCP tool
```

The agent retrieves the full body on demand through the MCP tool Karvan already hosts (D9). Handles
are lossless and cheap; summaries are lossy and unauditable. Anthropic's own reported result for
multi-agent systems is that isolated subagents returning 1–2k token summaries beat monolithic
context — and the mechanism there is *offloading*, not compression.

Demotion order when over budget: largest `tool.output` first, then `retrieved`, then `fact` bodies,
then `artifact.handle` inlined bodies. Pinned segments are never demoted; if the pinned set alone
exceeds the budget, that is a plan error, not a compaction problem — fail loudly.

**Only `history.summary` segments are ever LLM-summarised**, and only when a node is an explicit
continuation of a previous node. Everything else is offloaded or dropped-with-a-handle.

### 5.3 What Karvan deliberately does not build

A Karvan-side compactor that rewrites the CLI's transcript between turns. It requires transcript
round-tripping through `--resume`, is per-vendor, and duplicates work the vendor does better.
Rejected for M1; revisit only if a vendor exposes a supported transcript-mutation path.

---

## 6. Compaction auditability, honestly (F6.6, F10.5)

Claude Code *does* surface compaction in `--output-format stream-json`. **Verified 2026-08-02** from
the binary's zod schemas:

```ts
{ type: 'system', subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual' | 'auto', pre_tokens: number },
  uuid: string, session_id: string }
```

plus `{ type: 'system', subtype: 'status', status: 'compacting' | null }` for a live spinner.

**The honest limitation: `compact_metadata` carries `pre_tokens` only.** There is no `post_tokens`,
no list of what was dropped, and no handle to the pre-compaction transcript. So F6.6's wording —
*"before/after token counts, what was summarized, what was dropped, with handles to the full
original"* — is **fully achievable only for Karvan's own packet-level compaction.**

Do not ship a UI that implies otherwise. **A chart with a fabricated "after" number is worse than an
honest gap.**

### 6.1 The event shape encodes the uncertainty

```ts
type ContextCompacted = {
  node: NodeId;
  scope: 'karvan.packet' | 'vendor.session';
  fidelity: 'exact' | 'partial';        // 'partial' ⇒ vendor-reported
  trigger: 'threshold' | 'manual' | 'vendor.auto';
  before: number;
  after: number | null;                 // null when vendor-reported
  droppedSegments: SegmentId[];         // [] when vendor-reported
  demotedToHandles: Handle[];
  pinnedKept: string[];                 // sha256 list — proves the integrity check passed
  originalHandle: Handle | null;
};
```

| Field | `karvan.packet` | `vendor.session` |
|---|---|---|
| `fidelity` | `'exact'` | `'partial'` |
| `before` | measured (Tier 2) | `compact_metadata.pre_tokens` |
| `after` | measured (Tier 2) | `null`, or an **inferred** figure (§6.2) |
| `droppedSegments` | full list of `SegmentId` | `[]` |
| `demotedToHandles` | full list | `[]` |
| `originalHandle` | the pre-compaction manifest blob | transcript snapshot, if taken (§6.3) |

[The frontend](./12-frontend-architecture.md) branches on `fidelity`: `exact` renders a solid
before→after bar with a clickable dropped-segment list; `partial` renders the `before` bar solid,
the `after` bar hatched and labelled *inferred*, and a plain sentence saying the vendor does not
report what it dropped. The label is a feature, not an apology — it tells the user the difference
between a number Karvan measured and a number Karvan guessed.

### 6.2 Partial recovery of the "after" figure

Take `pre_tokens` from `compact_boundary`, then read the **next** assistant turn's
`modelUsage[model].inputTokens` from the result envelope and use it as an approximate
post-compaction figure. It is approximate because the next turn also includes whatever the agent
did after compaction. Store it as `after` with `fidelity: 'partial'` and label it *inferred*
everywhere it is displayed. Never promote an inferred number to `fidelity: 'exact'`.

### 6.3 The transcript-snapshot trick

On receiving `compact_boundary`, immediately copy the JSONL transcript from
`~/.claude/projects/<project>/<session_id>.jsonl` into the run's artifact store. That gives you the
`originalHandle` F6.6 wants, at the cost of one file copy. **Unverified** in the sense that the path
convention was read from the bundle and not exercised against a live authenticated session; confirm
in the M0 spike and treat a missing file as `originalHandle: null` rather than an error.

The snapshot is a raw transcript and therefore in scope for redaction before any export or hub sync
(F5.9 — see [13-observability-and-telemetry](./13-observability-and-telemetry.md)).

---

## 7. Token accounting in three tiers (F9.1, F9.3)

You do not own the model call, so exact tokenisation is impossible for planning and available only
post-hoc. Build the accounting around that fact, and **never silently mix the tiers** — every count
carries its `method`.

### Tier 1 — authoritative, post-hoc, from the CLI result envelope

This is billing and budget truth. Claude Code's result envelope, **verified 2026-08-02** from the
binary's zod schema:

```ts
{ type: 'result', subtype: 'success',
  duration_ms, duration_api_ms, is_error, num_turns, result, stop_reason,
  total_cost_usd: number,
  usage: unknown,                       // raw Anthropic usage object, passed through — DO NOT USE
  modelUsage: Record<string, {          // ← use THIS
    inputTokens, outputTokens,
    cacheReadInputTokens, cacheCreationInputTokens,
    webSearchRequests, costUSD,
    contextWindow, maxOutputTokens }>,
  permission_denials, structured_output?, uuid, session_id }
```

Error subtypes: `error_during_execution | error_max_turns | error_max_budget_usd |
error_max_structured_output_retries`.

`usage` is typed `z.unknown()` in the CLI's own schema — a raw passthrough whose shape the CLI does
not guarantee. `modelUsage` **is** typed. Use it.

`modelUsage[m].contextWindow` means **you never hardcode a window-size table**: the CLI hands you
the window, so true fill percentage per model is computable at runtime. That is the number F10.5
should plot against.

Codex: `codex exec --json` emits JSONL with `turn.completed` carrying
`usage: { input_tokens, cached_input_tokens, output_tokens }`, plus `token_count` events with
cumulative totals including reasoning tokens.

**Only Claude Code and Codex were verified.** Whether Copilot CLI, Gemini/Antigravity CLI, Cursor
CLI or OpenCode report machine-readable usage at all is **unverified**. Make
`tokenAccounting: 'exact' | 'estimated' | 'none'` an explicit field in the F3.5 capability manifest
and have the UI degrade honestly when it is `'none'` — a blank cost cell, not a zero.

Whether ACP surfaces usage or compaction state at all is likewise **unverified**, and it matters:
if it does not, ACP-first silently costs F9.1 and F10.5. Check it explicitly in the M0 spike.

### Tier 2 — approximate, pre-flight, for budgeting the packet

`gpt-tokenizer@3.4.0` with `o200k_base`, as a single universal estimator for *all* providers,
labelled `method: 'gpt-tokenizer/o200k_base'`. Import the **encoding-specific entrypoint** so you do
not pull every BPE table into the daemon:

```ts
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
```

Fastest pure-JS tokenizer on npm, no native or wasm build step — which matters for
`npx karvan up` (NF6).

**The error bar, stated honestly.** Anthropic's own documentation warns that tiktoken-family
tokenizers **undercount Claude tokens by roughly 15–20% on prose, and considerably more on code and
non-English text**. An uncalibrated pre-flight budget will therefore systematically *overfill*
Anthropic contexts — which is the dangerous direction.

**The fix is a self-calibrating rolling ratio per (provider, model), and it is free.** After every
node, compare the Tier-2 estimate of the rendered prompt against Tier-1 `inputTokens`:

```ts
// packages/context/src/calibration.ts (sketch)
type Calibration = { n: number; ratio: number };  // ratio = actual / estimated

const ALPHA = 0.2;                                 // EWMA, converges in ~20 samples
export function update(c: Calibration, estimated: number, actual: number): Calibration {
  if (estimated <= 0) return c;
  const observed = actual / estimated;
  return { n: c.n + 1, ratio: c.n === 0 ? observed : c.ratio * (1 - ALPHA) + observed * ALPHA };
}

// seeds, used until n >= 5
const SEED: Record<string, number> = { anthropic: 1.2, openai: 1.0, default: 1.05 };
```

Store it in the adapter capability manifest as `tokenEstimateFactor` and persist per
(provider, model). After roughly 20 nodes the estimates land within a few percent. Surface the
current factor in `karvan doctor`. This turns an unfixable systematic bias into a solved problem at
zero cost, and nobody else in the category does it.

### Tier 3 — exact, opt-in, API-key path only

Anthropic's `POST /v1/messages/count_tokens` is exact and free of charge, but it requires a
credential. Under AR-1 it is available **only** when the user has explicitly supplied their own key
via the F3.3 direct-API adapter. **Never call it on the subscription path.** There is no code path
in `karvand` that reads a token file or sets an auth env var to make this call work.

### Dead ends

| Package | Why not |
|---|---|
| `@anthropic-ai/tokenizer` | Still **0.0.4**, implements only the Claude 1/2-era BPE. Wrong for every current model. The package name makes it look authoritative — it is a trap. |
| `js-tiktoken@1.0.21` | Works, slower than `gpt-tokenizer`, no accuracy gain. |
| `tiktoken` / `@dqbd/tiktoken@1.0.22` | wasm; adds a binary artifact for no accuracy gain. |
| Shelling out to Python `tiktoken`/`transformers` | Adds a Python dependency to `npx karvan up`, and *still* isn't exact for Claude. |

There is no public exact tokenizer for Claude 3+. Accept it and calibrate.

---

## 8. The blackboard (answers PRD open question §15.2)

**Six-kind fixed core plus one `ext:` namespace.** The kinds are `finding`, `decision`, `artifact`,
`scope`, `risk`, `verdict`; anything else goes to `ext:<namespace>/<key>`, schema-validated against
a registered `schemaId` in `.karvan/schemas/` but not enumerated. Full type in
[04-domain-model §5](./04-domain-model.md).

Fixed core gives the marquee visualisations something renderable, diffable and validatable. The ext
space stops the vocabulary becoming a straitjacket the first time you hit an unanticipated task
archetype.

### 8.1 Projection, not a second store

Facts live in the ledger as `fact.written` / `fact.read` / `fact.invalidated`. The `fact` and
`fact_edges` tables are a materialised view:

```sql
CREATE TABLE fact_edges (
  fact_id   TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('read','write')),
  event_seq INTEGER NOT NULL
);
CREATE INDEX fact_edges_by_fact ON fact_edges(fact_id, event_seq);
CREATE INDEX fact_edges_by_node ON fact_edges(node_id, event_seq);
```

F10.4's memory graph is one query over this table. If the blackboard ever becomes independently
mutable, NF9 and NF10 are both gone — this is the constraint, not a preference.

### 8.2 Invalidation and downstream flagging

Because every read is an event, the consumer set of any fact is a single indexed query:

```sql
SELECT DISTINCT node_id FROM fact_edges
WHERE fact_id = ?1 AND direction = 'read' AND event_seq < ?2;   -- ?2 = invalidation seq
```

Every node in that set is marked `taint: 'stale-input'`. **Do not auto-re-run.** Flag it, surface it
in the F8.3 approval queue, and let the F2.5 patch policy decide whether a re-run is warranted.
Auto-re-running on invalidation is how you build a system that loops forever for reasons no human
can reconstruct — and it interacts badly with F4.6 budget ceilings.

---

## 9. Handoff contracts and the enforced return budget (F6.4, F6.9)

F6.4's *"default return budget: 500–2,000 tokens, enforced"* needs a mechanism or it is a comment.
Three layers, all already available.

### 9.1 Declare the contract

Every `agent` node carries `returns: { schemaId: SchemaId; maxTokens: number }`. Pass the schema to
the CLI **natively** where supported — far more reliable than prompt-only instructions:

- **Claude Code**: `--json-schema <schema>`; the parsed object arrives in the result envelope's
  `structured_output` field. **Verified 2026-08-02** from the bundle's flag table and zod schema.
  Whether `structured_output` is populated in *every* success case is **unverified** — confirm
  empirically in the M0 spike.
- **Codex**: structured-output support in `codex exec`.
- Anything else: prompt-level schema plus Ajv validation, and mark
  `structuredOutput: 'prompt-only'` in the capability manifest so the planner knows the contract is
  softer.

Claude Code already runs its own bounded internal schema-repair loop and surfaces exhaustion as
`error_max_structured_output_retries`. Map that subtype straight onto a node failure with
`reason: 'schema-repair-exhausted'` — do not retry on top of a retry.

### 9.2 Measure, then repair — never truncate

After the node returns, count the serialised `structured_output` with the Tier-2 tokenizer. Over
budget:

1. Emit `handoff.oversize` (`{ node, attempt, budget, actual, repairAttempted }`).
2. Run **one** bounded repair: re-prompt the same session asking it to compress to budget.
3. Still over? Hard-fail the node.

**Never silently truncate.** Truncating a JSON payload produces invalid JSON downstream, which is
exactly the "silent propagation of garbage" F6.9 exists to forbid. Repair-or-fail, always.

Validation is Ajv 8.20.0 (`strict: true`, `allErrors: true`) plus `ajv-formats@3.0.1` against JSON
Schema 2020-12 — the same draft MCP tool `inputSchema` defaults to, which keeps one dialect across
Karvan's MCP host and its handoff contracts. Author schemas in TypeScript with Zod 4.4.3 and emit
via `z.toJSONSchema()` into `.karvan/schemas/`, so the TS type and the runtime contract cannot
drift and the schemas remain inspectable on disk (NF8).

### 9.3 About the number itself — be honest

The 500–2,000 figure is **practitioner consensus, not a controlled study.** It traces to Anthropic's
multi-agent research system and the 2026 convergence of Anthropic, Cognition and OpenAI on
orchestrator-plus-isolated-subagents returning compressed summaries. No experiment establishes an
optimum, and the surrounding guidance is expressed as *ratios of the window* rather than absolutes
(the recurring rules being "system prompts under ~2,000 tokens" and "compact proactively past
~60% fill").

The related figure that *is* measured: on Anthropic's BrowseComp evaluation, token usage alone
explains about **80%** of performance variance, and the lead-Opus / subagent-Sonnet configuration
outperformed single-agent Opus by 90.2% at roughly 15× the token cost of a normal chat turn. That
is a browsing/research workload — do not generalise it to coding without saying so.

Therefore:

| Node type | `maxTokens` default |
|---|---|
| `gate` | 300 |
| `human` (structured response) | 500 |
| `agent` (implementation) | 1,500 |
| `agent` (recon / survey) | 4,000 |
| `tool` | n/a (deterministic output, handled by handles) |

Global default **1,500**, overridable per node type and per node. Record **oversize rate per node
type** and feed it into F10.11's cross-run dashboard, then tune from your own data. That
measurement is a genuine differentiator; nobody else in the category has it.

---

## 10. Retrieval (F6.7)

**M1 is SQLite FTS5 + BM25 and nothing else** (D15). **Verified 2026-08-02**: `better-sqlite3@13.0.2`
bundles SQLite **3.53.4** compiled with `ENABLE_FTS5`, `CREATE VIRTUAL TABLE … USING fts5(…)` works,
and `bm25()` ranking with `ORDER BY rank` returns sensible results. Zero extra dependencies, zero
build step, no model download, no Docker — NF6 satisfied outright.

```sql
CREATE VIRTUAL TABLE artifact_fts USING fts5(
  title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
);

SELECT node_id,
       snippet(artifact_fts, 1, '[', ']', '…', 24) AS s,
       bm25(artifact_fts, 2.0, 1.0) AS score
FROM artifact_fts
WHERE artifact_fts MATCH ?1
ORDER BY rank
LIMIT 20;
```

> **`tokenchars '_-.'` is the one non-obvious detail and it is load-bearing.** Without it, FTS5's
> default tokenizer splits `snake_case`, `kebab-case` and `file.ext` into fragments and recall on
> code collapses. It **cannot be changed later without rebuilding the index** — get it right at
> table creation.

### 10.1 Why embeddings are the wrong first move

Karvan's corpus is a run's own artifacts and prior runs: stack traces, test output, diffs, file
paths, symbol names, error codes. That is overwhelmingly **exact-match territory** — BM25's
strongest suit and dense retrieval's weakest. The 2026 hybrid-search literature is consistent that
embeddings conflate identifiers differing by a few characters, which is catastrophic for
`getUserById` vs `getUsersById`.

You also already have git, ripgrep, the file tree, and vendor CLIs that ship excellent repo search.
F6.7 is P1, and P1 is the right place for it.

### 10.2 The upgrade path, in cost order

1. **Query expansion — do this before embeddings.** Have the cheap planner model emit 3–5 keyword
   variants and OR them into the FTS5 query. Costs pennies, adds no dependency, and recovers most
   of the "I described it differently" gap.
2. **`sqlite-vec`, never `sqlite-vss`.** sqlite-vss is **explicitly deprecated by its own author** in
   favour of sqlite-vec — do not start there. sqlite-vec is alive but **pre-1.0 after two years**:
   stable v0.1.9 (31 Mar 2026), pre-release v0.1.10-alpha.4 (18 May 2026, adding a DiskANN index for
   `vec0` tables), no commits since. There is a known **extension/SQLite-version mismatch class of
   failure on Windows with better-sqlite3**, which lands squarely on the M3 Windows target. Combine
   with FTS5 via Reciprocal Rank Fusion (`sum of 1/(60 + rank)`) rather than normalising BM25
   against cosine. Re-check the project's activity before committing to it.
3. **A local embedding model:** `@huggingface/transformers@4.2.0` (the renamed, actively maintained
   transformers.js; v4 rewrote the WebGPU runtime in C++ and reports BERT-family embedding models up
   to 4× faster, running server-side in Node) with a 768-dim model. Prefer it over `fastembed@2.1.0`,
   which pulls native `@anush008/tokenizers` bindings — a cross-platform install hazard for
   `npx karvan up`. Ollama embeddings (`nomic-embed-text`, `embeddinggemma`, both 768-dim) only as an
   optional accelerator when the user already runs Ollama; never as a required dependency.

Bottom line: the cheapest thing that works is FTS5 with correct `tokenchars`, and there is a decent
chance you never need more. **Do not add embeddings until a semantic-recall miss is actually
measured.**

---

## 11. What to take, and what to leave, from the three named references

The PRD names these in §4.3. Each contributes exactly one idea worth keeping, and each has a part
that is actively wrong for a provenance-first system. Being explicit about the boundary is what
prevents cargo-culting.

| Reference | **Take** | **Leave** |
|---|---|---|
| **Letta** (memory blocks) | The *rendering* idea: a memory block is a labelled section of the window with an explicit character/token limit, prepended in XML-ish form. Maps 1:1 onto Karvan's segment list and gives a natural per-segment cap. | The **shared-mutable-block model**. Letta's shared blocks propagate updates to all agents immediately and the agent itself mutates them. F6.1 wants no implicit sharing and F6.3 wants full provenance — an agent silently editing a block that another agent reads is precisely the failure both requirements exist to prevent. |
| **LangGraph** (checkpointer/store split) | The split itself, which maps 1:1 and validates the PRD's tiering: checkpointer = thread-scoped short-term state (T1 ledger + T2 blackboard, run-scoped); store = cross-thread long-term memory (F6.8). Keep them in **separate SQLite files** — the global run ledger (`$XDG_DATA_HOME/karvan/ledger.db`) vs `.karvan/memory/project.db` — so retention/GC and curation have different lifecycles. | The **dependency**. §4.3's disqualification stands: LangGraph is a library for building agents from raw model APIs, which means per-token API billing and reimplementing the coding harness. Both contradict AR-1 and the whole premise. |
| **OpenAI Agents SDK** (`nest_handoff_history`) | The **ordered interleaving**: summaries sit in the chronological position of what they replaced rather than being lumped into one preamble. That preserves causal ordering and is a small change to `render(segments)` — do it. | Enabling transcript collapsing by default. `nest_handoff_history` is still an **opt-in beta, disabled by default** "while we stabilize nested handoffs". That even OpenAI does not consider transcript collapsing safe by default is a strong signal supporting §5.2's offload-don't-summarise stance. |

Two June 2026 preprints found during the research converge independently on Karvan's architecture
and are worth knowing as prior art — **not** as validated results, since both are
single-author/small-team with no independent replication:

- **arXiv 2606.23752** (*ESAA-Conversational*) treats the visible conversation as a local event
  store, normalising turns into an append-only `activity.jsonl` and deterministically projecting
  read models so a cold agent starts from projections plus a selective window rather than the whole
  log. That is Karvan's ledger-plus-projection design, arrived at separately.
- **arXiv 2606.12329** (*PROJECTMEM*, University of Utah) is a local-first append-only typed event
  log projected into compact summaries served over MCP, plus a deterministic **pre-action gate**
  that warns an agent before it repeats a previously-failed fix or edits a known-fragile file —
  "Memory-as-Governance". That gate is a genuinely good idea Karvan currently lacks: it is F4.7
  no-progress detection generalised from within-loop to across-runs, and it fits the F6.8 / M3 slot.

Also relevant to F6.8: Letta's **sleep-time agents** (background curators that asynchronously edit a
primary agent's blocks) are a good shape for a background curator proposing promotions to
`.karvan/memory/` — gated by human review, exactly as F6.8 requires. Never auto-promoted.

---

## 12. Local testability

The memory layer is roughly 100% mockable, which means there is no excuse for it not to be tested.
Details in [14-testing-strategy](./14-testing-strategy.md); the three that belong to this layer:

**Golden-file packet tests over the pure `render()`.** `render(segments) -> string` has no I/O and
no clock, so snapshot-test the assembled packet per node archetype (recon, implement, gate, human,
map-child). A context regression becomes a diff in CI and costs nothing to run. Assert the pinned
segments come first and are byte-identical to the spec.

**A committed compaction fixture corpus.** Record real `stream-json` transcripts from Claude Code
once, including at least one `compact_boundary` and at least one `result` envelope with populated
`modelUsage`, and commit them under `test/fixtures/streams/`. The `@karvan/mock-agent` binary (D17)
replays them. This lets you develop and test the compaction event pipeline, the three-tier token
accounting, the calibration ratio and the F10.5 visualisation with no credentials, no network and
no cost — the difference between this being testable on a train and not.

**A ConstraintRot-style regression suite.** Build roughly 20 scenarios where a node carries a pinned
prohibition and a plausible reason to violate it. Run them against the mock agent with pinning
enabled and disabled, and assert **zero violations with pinning enabled**. This turns the paper's
finding into a standing guard rather than a one-time implementation, and it is the test that
protects the highest-severity risk in PRD §13. Include at least three scenarios that exercise the
`forbid` → `allow-only` restatement from §4.2.

**`karvan doctor` reports the memory layer too**: current tokenizer calibration factor per
(provider, model) with sample count, FTS5 availability and the tokenizer setting on
`artifact_fts`, whether `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is in effect and at what value, and the
current `forbid`-to-`allow-only` ratio in the loaded spec. Cheap, and it makes the invisible parts
of the system legible when something goes wrong.

---

## 13. Pitfalls

- **Do not fabricate the compaction "after" number.** `compact_metadata` gives you `pre_tokens` and
  nothing else. Use `fidelity: 'partial'` and label inferred figures as inferred (§6).
- **Do not use the result envelope's `usage` field.** It is `z.unknown()` — a raw passthrough with
  no shape guarantee from the CLI's own schema. Use `modelUsage`, which is typed and carries
  `contextWindow`.
- **Do not assume `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can delay compaction.** `Math.min` clamps it to
  the default threshold; it moves compaction earlier only.
- **Do not budget a packet with an uncalibrated `gpt-tokenizer` count.** The 15–20% undercount on
  Claude prose (worse on code) systematically *overfills* the context. Ship the rolling ratio.
- **Do not use `@anthropic-ai/tokenizer`.** Version 0.0.4, Claude 1/2-era BPE, authoritative-looking
  name, wrong answer.
- **Do not create `artifact_fts` without `tokenchars '_-.'`.** Recall on code collapses, and you
  cannot change it without rebuilding the index.
- **Do not start on `sqlite-vss`.** Deprecated by its own author. And do not adopt `sqlite-vec`
  without re-checking its maintenance status and the Windows extension-loading hazard.
- **Do not truncate an oversized structured return.** Invalid JSON downstream is exactly what F6.9
  forbids. Repair once, then fail.
- **Do not let a summariser paraphrase a pinned constraint.** Verbatim bytes, or the integrity
  check is meaningless.
- **Do not phrase safety constraints as prohibitions** where a positive form exists, and do not
  treat passing gates as evidence prohibitions are being honoured — Security-Recall Divergence is
  invisible to commission-type audit signals (§4.2).
- **Do not let the blackboard become independently mutable.** It is a projection. The moment it is
  not, NF9 and NF10 are both gone.
- **Do not auto-re-run tainted nodes** on `fact.invalidated`. Flag, surface, let the patch policy
  decide.
- **Do not hardcode the decoded Claude Code constants.** They came from one version (2.1.220) with
  no compatibility guarantee. Read `contextWindow` and `maxOutputTokens` from the envelope at
  runtime and assert the rest in the conformance suite.
- **Do not quote the arXiv figures publicly without re-verifying them against the PDFs.** They were
  search-indexed, not read directly (§4).

---

**Related:** [Domain model](./04-domain-model.md) · [Durable execution](./05-durable-execution.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) ·
[Observability and telemetry](./13-observability-and-telemetry.md) ·
[Frontend architecture](./12-frontend-architecture.md)

[← Back to index](./README.md)
