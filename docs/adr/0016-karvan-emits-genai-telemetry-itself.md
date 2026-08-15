# ADR 0016: DeFlow emits `gen_ai.*` telemetry itself

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

**The PRD contains a factual error that changes who does the work.** PRD §4.6 states that "Copilot,
Codex and Claude Code emit GenAI-convention telemetry natively, so their runs are readable in any
OTLP backend". F10.12 then promises OTel export as though it were mostly inherited.

**That is contradicted.** Claude Code emits telemetry under a **private `claude_code.*` namespace**,
not the OpenTelemetry `gen_ai.*` semantic conventions. So a Langfuse or Phoenix backend pointed at
the vendor CLIs does not get standard GenAI spans, and F10.12's "readable in Langfuse/Phoenix/Datadog
for free" is only true if **DeFlow** emits the standard namespace.

That is fortunate rather than unfortunate, because DeFlow is better positioned to emit it anyway.
DeFlow knows the plan, the node, the provider, the permission level, the patch reason and the
compaction event; the CLI knows only its own turn. And the token data needed for the spans arrives
in DeFlow's hands regardless: Claude Code's result envelope carries
`modelUsage[model].{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
costUSD, contextWindow, maxOutputTokens}`, and Codex's `codex exec --json` emits `turn.completed`
with `usage: {input_tokens, cached_input_tokens, output_tokens}`.

The second relevant fact is stability. **Verified 2026-08-02** by inspecting
`@opentelemetry/semantic-conventions@1.43.0` locally: the GenAI constants are exported from the
**`/incubating` subpath only** — 130 `GEN_AI` symbols. `gen_ai.provider.name` is current;
`gen_ai.system` still ships but is the **deprecated** predecessor, renamed in v1.37.0. Every one of
these attributes carries Development stability, living in `/incubating` precisely so it can change
without a major bump. And as of v1.42.0 (12 June 2026) they were deprecated out of the main semconv
repo into `open-telemetry/semantic-conventions-genai`, **which has zero releases and zero tags
today**.

So there is currently **no stable GenAI schema URL to pin to**.

## Decision

**DeFlow is the emitter. It produces `gen_ai.*` OTel spans itself, over OTLP.**

Packages, versions checked live on 2026-08-02: `@opentelemetry/sdk-node@0.221.0`,
`@opentelemetry/exporter-trace-otlp-http@0.221.0`, `@opentelemetry/semantic-conventions@1.43.0`
**pinned exactly, not with a caret**, with `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`.

Span mapping (name convention `{operation} {target}`):

| DeFlow concept           | Span                      | Key attributes                                                                        |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| run                      | `invoke_workflow <runId>` | `gen_ai.conversation.id` = runId                                                      |
| `agent` node             | `invoke_agent <nodeId>`   | `gen_ai.provider.name`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.usage.*` |
| `tool` node / MCP call   | `execute_tool <name>`     | `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`                         |
| `gate` node              | `execute_tool <gateId>`   | plus `DeFlow.gate.verdict`                                                            |
| model turn inside a node | `chat <model>`            | `gen_ai.response.finish_reasons`, token attributes                                    |

`invoke_workflow` genuinely exists in the 1.43.0 enum (alongside `chat`, `create_agent`,
`embeddings`, `execute_tool`, `generate_content`, `invoke_agent`, `retrieval`, `text_completion`), so
DeFlow's run and subgraph spans have a standard operation name. And
`gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` map **exactly**
onto Claude Code's `cacheReadInputTokens` / `cacheCreationInputTokens`, so translation is direct.

Two rules that keep this from breaking us:

- **Everything DeFlow-specific goes under a `DeFlow.*` namespace** — plan version, patch reason,
  compaction events, blackboard reads and writes, permission level. **Never invent a `gen_ai.*`
  name.** That is how you get silently broken by an upstream rename.
- **All of it is isolated behind one module**, `src/telemetry/semconv.ts`, exporting DeFlow's own
  constants that re-export OTel's. A rename upstream becomes a one-file change.

**Local backend: Arize Phoenix, not Langfuse.** Phoenix runs as a **single process backed by SQLite
by default** (`pip install arize-phoenix && phoenix serve`, or one container), is OTel-native, and
has no event caps. Langfuse's self-host shape needs Postgres, ClickHouse, Redis/Valkey, object
storage, a web app and an async worker — six services and a hard Docker dependency, which
contradicts NF6 and the local-first requirement directly. Langfuse stays documented as an option for
the M3 team hub (OTLP endpoint `POST /api/public/otel`, HTTP Basic auth), where Docker is already
assumed per PRD §9.5.

F10.12 is **M2**, which is the right milestone for something this unstable. Detail in
[13-observability-and-telemetry.md](../13-observability-and-telemetry.md).

## Consequences

### Positive

- F10.12's promise becomes true: a deflow run is readable in Phoenix, Langfuse or Datadog with no
  vendor cooperation.
- DeFlow's spans are _richer_ than anything the CLIs could emit, because they carry plan and node
  structure the CLI does not have.
- Phoenix-over-Langfuse keeps the local observability story to one process and one SQLite file,
  consistent with the rest of the system.
- The `gen_ai.usage.cache_*` mapping means cache-hit economics are visible in a standard backend,
  which is directly useful for the cost-per-completed-task metric (F9.5).

### Negative

- **We own the emission code**, including the translation from each adapter's usage shape into
  `gen_ai.usage.*`. That is per-adapter work and it churns with the adapters.
- **The attributes will break.** There is no stable GenAI schema URL, the constants live in
  `/incubating`, and the conventions have been moved to a repository with zero releases. Pinning
  exactly plus the `semconv.ts` indirection is the mitigation, and F10.12 explicitly calls for
  dual-emitting during transitions.
- Trace viewers are still trace viewers. They cannot show a plan graph, plan evolution, or what a
  context packet contained versus what compaction removed — which is why DeFlow builds its own
  visualisation surface (PRD §4.6) and treats OTel as an export, not a substitute.

### Neutral

- The PRD's §4.6 text is now known to be wrong on this point and must be read alongside this record.
  Noted in [research-findings.md](../research-findings.md).

## Alternatives considered

- **Rely on the vendor CLIs to emit `gen_ai.*`** (the PRD's assumption). Rejected: contradicted —
  Claude Code emits a private `claude_code.*` namespace.
- **Emit OpenInference, Phoenix's native format.** Better-typed for retriever and embedding spans,
  but Arize-specific — it would lose the Datadog and Langfuse portability F10.12 exists for. Emit
  `gen_ai.*` and let Phoenix map it.
- **Langfuse as the local backend.** Rejected on NF6: six services and a hard Docker dependency for
  a tool whose install story is `npx deflowai up`. Kept for the M3 hub.
- **Skip OTel entirely and rely on DeFlow's own UI.** Tempting given the instability, and it is why
  this is M2 rather than M1. Rejected long-term because interoperability is cheap once the emission
  module exists, and a colleague's existing Datadog is a real adoption argument.
- **Wait for the conventions to stabilise.** Rejected: `open-telemetry/semantic-conventions-genai`
  has zero releases, so "wait" has no end date. Emit now, isolate, and re-pin.

## Revisit when

Any of these, each individually checkable:

1. **`open-telemetry/semantic-conventions-genai` publishes its first tagged release.** That is the
   moment a real GenAI schema URL exists; re-pin to it, and re-read the attribute list for renames
   against `src/telemetry/semconv.ts`.
2. **`gen_ai.*` attributes graduate out of `/incubating`** in `@opentelemetry/semantic-conventions`
   — i.e. they appear on the stable export path. At that point the `OTEL_SEMCONV_STABILITY_OPT_IN`
   flag and the dual-emit machinery can be retired.
3. **A vendor CLI starts emitting genuine `gen_ai.*` spans.** Then DeFlow's spans and the CLI's would
   be siblings rather than the only source, and the emission code could narrow to workflow-level
   spans only. Check each adapter's telemetry documentation at the quarterly review.

Given the June 2026 repository move and the zero-release state, treat re-checking the constant list
as a standing item at every `@opentelemetry/semantic-conventions` minor bump, not only at these
triggers.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
