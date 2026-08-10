# `@DeFlow/core`

The pure domain and engine logic: `TaskSpec`, `PlanGraph`, `PlanPatch`, `Fact`, `ContextPacket`, the
`Event` union, the failure taxonomy, the canonical JSON encoder and the hashes built on it. Zero
I/O — `zod` is the only runtime dependency, and time, randomness and ids arrive through ports
declared here and implemented in `@DeFlow/daemon` or `@DeFlow/testkit` (R1).

The engine half is two functions and one union: `reduce(state, event)` folds the log into
`RunState`, `decide(state, now)` turns that state into `Command[]`, and the `EffectRunner` in
`@DeFlow/daemon` is the only thing that performs one. `now` is a parameter rather than a call, and
`packages/core/test/purity.test.ts` fails the build if `Date.now`, `setTimeout`, `setInterval`,
`setImmediate`, `Math.random`, `process.hrtime` or `performance.now` appears under `src/` — the
lint rules in `.oxlintrc.json` refuse each of them by name in the editor as well.

`src/index.ts` is the whole contract. Deep imports across packages are banned, so anything meant to
be shared is exported there or it is internal.

## Published schemas (v1)

Zod is the source of truth. `schemas/<schemaId>.json` at the repository root is **generated** from
it as JSON Schema 2020-12 and copied into a run directory as `.DeFlow/schemas/` — it is what an
`agent` node hands a vendor CLI (`--json-schema`, `--output-schema`) and what `makeValidator` in
`@DeFlow/daemon` compiles.

| `schemaId`                | Zod source                | What it describes                                                     |
| ------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `DeFlow.contextpacket.v1` | `src/context-packet.ts`   | The addressable, typed context a node actually received (F6.1, F6.2)  |
| `DeFlow.fact.v1`          | `src/fact.ts`             | A blackboard fact envelope: key, kind, provenance, value schema id     |
| `DeFlow.finding.v1`       | `src/verdict.ts`          | A structured gate finding, attachable to a diff line (F7.7)            |
| `DeFlow.finding.v2`       | `src/verdict.ts`          | The same, with its line anchored to the blob it was read from (F7.7)   |
| `DeFlow.humandecision.v1` | `src/human-gate.ts`       | What a `human` node returns when the operator chose rather than supplied: the option, its effect, its words (F8.1) |
| `DeFlow.plangraph.v1`     | `src/plan-graph.ts`       | A whole plan: seven node types, edges, budgets, declared reads (F2.1)  |
| `DeFlow.planpatch.v1`     | `src/plan-patch.ts`       | A proposed plan evolution: five ops, blast radius, rationale (F2.3)    |
| `DeFlow.reconfact.v1`     | `src/recon.ts`            | The value of a recon fact: toolchain, command, path set, gates or a stated detection failure (F2.2) |
| `DeFlow.reconsurvey.v1`   | `src/recon.ts`            | What a recon session claims about the repository — claims only (F2.2)  |
| `DeFlow.taskspec.v1`      | `src/task-spec.ts`        | The approved intent a run is measured against (F1.1)                   |
| `DeFlow.taskspecdraft.v1` | `src/framing.ts`          | What the framing interview returns, before DeFlow seals it (F1.2)      |
| `DeFlow.verdict.v1`       | `src/verdict.ts`          | A gate verdict: outcome, per-criterion status, findings (F7.4)         |
| `DeFlow.verdict.v2`       | `src/verdict.ts`          | The same, naming the `specHash` it judged, so a spec edit voids it (F1.5) |
| `DeFlow.verdict.v3`       | `src/verdict.ts`          | The gate contract: blob-anchored findings and what the verdict cost (F7.3, F6.9) |
| `DeFlow.verdict.v4`       | `src/verdict.ts`          | The sealed verdict, naming what was given up to produce it — a same-provider review is marked, never silent (F7.2, NF7) |

The registry those rows come from is `SCHEMA_REGISTRY` in `src/json-schema.ts`. Adding a row is how
a new document ships.

```
pnpm schemas:emit     # regenerate schemas/ from the Zod source
pnpm schemas:check    # CI: fail on any divergence, or on a document Ajv2020 strict refuses
```

`pnpm schemas:check` runs in the CI `check` job, next to `biome ci` and `typecheck` — never in a git
hook, which docs/14-testing-strategy.md §14.1 keeps under about two seconds.

## The append-only rule

**A published `schemaId` is never edited. `.v2` is published; `.v1` is left exactly as it was.**

A run directory written last month is still being read this month, possibly by an older daemon, and
an in-place edit silently reinterprets every document already on disk. `schemas/CHANGELOG.md`
records what changed and why it was safe;
`packages/core/test/schemas-append-only.test.ts` pins a content hash per shipped file, so an
in-place edit is a red test naming the file rather than a discovery months later. A red row there is
not a licence to update the hash — the fix is a new `.v2`.

## The emitted schema is weaker than its Zod source

JSON Schema cannot express a cross-field refinement, so the following are enforced by Zod (and by
`acceptFact`) and **not** by the emitted document:

- a `Fact`'s `kind` and `key` prefix must agree, and a fact may not supersede itself;
- a pinned `Segment` may not be `compactable`, and `pinnedDigests` must match the pinned segments;
- `Handle` accepts `artifact://<64 hex>` or `file://<repo-relative>#L12-L40` — the emitted schema
  only says "string", because the constraint is a `.refine()`.

The emitted file is the wire-level contract a vendor CLI validates against. Zod stays the gate on
the way in.
