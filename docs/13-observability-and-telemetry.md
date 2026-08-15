# Observability and telemetry

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

## 1. Three surfaces, three jobs

A deflow run has to be legible to three different audiences, and the fastest way to ruin all three
is to let them share a substrate. Keep them separate and each one stays honest.

| Surface                   | Audience                                      | Substrate                                                     | Guarantee                                                           | PRD        |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| **The ledger**            | The product itself, and any audit             | SQLite, append-only, written in the same transaction as state | The **only** source of truth. Every UI pixel is a projection of it. | F4.1, NF10 |
| **pino structured logs**  | You, at 2am, with a broken daemon             | ndjson to stderr / a rotating file                            | Best-effort operator diagnostics. Losable.                          | —          |
| **OTel `gen_ai.*` spans** | External tooling (Phoenix, Langfuse, Datadog) | OTLP over HTTP to a collector the user configures             | Interop. A lossy, flattened export of the ledger.                   | F10.12     |

### The rule that keeps NF10 provable

> **pino logs are not a second event store.**

Ledger events are domain facts. They are written to SQLite inside the same transaction that advances
run state, and they carry a monotonic sequence number that the SSE stream, the UI store and the
`?since=<seq>` hydrate endpoint all key on (see [API and realtime](./11-api-and-realtime.md)). Pino
is a side channel for the operator: it may drop, it may be disabled, it may be piped through
`pino-pretty` and never touch disk at all.

The moment a `logger.info({ event })` call becomes the place where a fact is recorded, NF10
("any state in the UI is traceable to specific ledger events") stops being provable — you can no
longer point at a row and say _this_ is why the UI shows that. Worse, it creates a standing
temptation to reconstruct state by parsing log files after a crash, which is the exact failure the
event-sourced design exists to eliminate.

Enforce it in review with one question: _if this line vanished, would any state be wrong?_ If yes,
it belongs in the ledger, not in pino.

**Logger setup** (`pino@10.3.1`, `pino-pretty@13.1.3` — dev only, never as a runtime transport):

```ts
export const log = pino({
  level: process.env.DeFlow_LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "*.authorization",
      "*.token",
      "*.headers.cookie",
      "env.ANTHROPIC_API_KEY",
      "env.OPENAI_API_KEY",
      "env.GITHUB_TOKEN",
    ],
    censor: "[redacted]",
  },
});
// per-subsystem children carry correlation ids
const orch = log.child({ mod: "orchestrator", runId });
```

Set `redact` on commit one. Retrofitting it across six months of call sites is miserable, and it is
the cheapest half of F5.9.

Dev loop: `pnpm dev | pino-pretty`. Production: raw ndjson, let the user's own tooling deal with it.

---

## 2. The PRD is wrong about vendor telemetry — DeFlow must be the emitter

PRD §4.6 states: _"Copilot, Codex and Claude Code emit GenAI-convention telemetry natively, so their
runs are readable in any OTLP backend."_ The transport half is true. The **convention** half is
false, and the whole of F10.12 rests on it.

**Verified 2026-08-02.** The shipping Claude Code binary
(`@anthropic-ai/claude-code@2.1.220`, an 11.5 MB `cli.js`) was grepped for the string `gen_ai.`:
**zero occurrences**. What it actually registers is a vendor-private namespace on meter
`com.anthropic.claude_code`:

| Kind      | Name                                  | Unit   |
| --------- | ------------------------------------- | ------ |
| metric    | `claude_code.session.count`           | —      |
| metric    | `claude_code.lines_of_code.count`     | —      |
| metric    | `claude_code.pull_request.count`      | —      |
| metric    | `claude_code.commit.count`            | —      |
| metric    | `claude_code.cost.usage`              | USD    |
| metric    | `claude_code.token.usage`             | tokens |
| metric    | `claude_code.code_edit_tool.decision` | —      |
| metric    | `claude_code.active_time.total`       | s      |
| event/log | `claude_code.llm_request`             | —      |
| event/log | `claude_code.tool.execution`          | —      |
| event/log | `claude_code.tool.blocked_on_user`    | —      |

All of it is off unless `CLAUDE_CODE_ENABLE_TELEMETRY=1`, and it honours the standard
`OTEL_EXPORTER_OTLP_*` environment variables.

Codex is similar but worse. Its OTel configuration lives in `~/.codex/config.toml` under an `[otel]`
section with separate `exporter` (logs) and `trace_exporter` (traces) pipelines, and per
`openai/codex#12913`, **`codex exec` emits traces and logs but no metrics at all**, while
`codex mcp-server` emits nothing. `codex exec` is precisely the mode DeFlow's fallback shim uses.

### Consequence (D16)

> **DeFlow emits the `gen_ai.*` spans itself**, translating from each adapter's native output —
> the ACP `session/update` stream, Claude Code's `stream-json` result envelope, Codex's
> `turn.completed` usage block. It does not inherit them.

This is not a downgrade. DeFlow is already parsing every one of those streams for the ledger, so the
translation is a projection over events it already owns, and it means the span tree is consistent
across all six providers rather than reflecting whatever each vendor decided to instrument.

Two things that follow:

- **Do not enable vendor telemetry on the user's behalf.** Setting `CLAUDE_CODE_ENABLE_TELEMETRY=1`
  in a spawned child's environment redirects the vendor's own metrics to whatever
  `OTEL_EXPORTER_OTLP_ENDPOINT` happens to be set to, and mutating the user's vendor CLI
  configuration is out of bounds ([provider adapter layer](./07-provider-adapter-layer.md)). If the
  user has already configured it, that is their pipeline and DeFlow leaves it alone.
- **Telemetry is derived, never primary.** The OTel exporter is a subscriber to the ledger, so
  turning it off, pointing it at a dead collector, or having it throw cannot affect a run. F10.12 is
  M2 work; the ledger it reads from is M1 work.

---

## 3. Span mapping

Span name convention is OTel's `{operation} {target}`. All attribute names below were enumerated
locally from `@opentelemetry/semantic-conventions@1.43.0`'s `/incubating` subpath — 130 `GEN_AI`
symbols. **Verified 2026-08-02.**

| DeFlow concept            | Span name                 | `gen_ai.operation.name` | Key attributes                                                                                           |
| ------------------------- | ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| run (and `subgraph` node) | `invoke_workflow <runId>` | `invoke_workflow`       | `gen_ai.conversation.id` = runId                                                                         |
| `agent` node              | `invoke_agent <nodeId>`   | `invoke_agent`          | `gen_ai.provider.name`, `gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.*` |
| `tool` node / MCP call    | `execute_tool <name>`     | `execute_tool`          | `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`                                            |
| `gate` node               | `execute_tool <gateId>`   | `execute_tool`          | + `DeFlow.gate.verdict`                                                                                  |
| model turn inside a node  | `chat <model>`            | `chat`                  | `gen_ai.response.model`, `gen_ai.response.finish_reasons`, token attributes                              |

`invoke_workflow` is a real enum member — the full `gen_ai.operation.name` value set in 1.43.0 is
`chat | create_agent | embeddings | execute_tool | generate_content | invoke_agent |
invoke_workflow | retrieval | text_completion`.

### Token attributes map directly

Claude Code's `modelUsage[model]` block translates one-for-one, which is the single best argument
for emitting from DeFlow rather than inventing a shape:

| DeFlow / vendor field                    | OTel attribute                             |
| ---------------------------------------- | ------------------------------------------ |
| `modelUsage[m].inputTokens`              | `gen_ai.usage.input_tokens`                |
| `modelUsage[m].outputTokens`             | `gen_ai.usage.output_tokens`               |
| `modelUsage[m].cacheReadInputTokens`     | `gen_ai.usage.cache_read.input_tokens`     |
| `modelUsage[m].cacheCreationInputTokens` | `gen_ai.usage.cache_creation.input_tokens` |
| reasoning tokens (Codex `token_count`)   | `gen_ai.usage.reasoning.output_tokens`     |

Metrics worth emitting: `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`,
`gen_ai.client.operation.time_to_first_chunk`.

### Everything DeFlow-specific goes under `DeFlow.*`

> **Never invent a `gen_ai.*` attribute name.** That is precisely how you get silently broken by an
> upstream rename — your invented name either collides with a future real one or is quietly ignored
> by every backend.

Reserved namespace, non-exhaustive:

| Attribute                                                                      | On                                |
| ------------------------------------------------------------------------------ | --------------------------------- |
| `DeFlow.run.id`, `DeFlow.node.id`, `DeFlow.node.type`                          | every span                        |
| `DeFlow.plan.version`                                                          | `invoke_workflow`, `invoke_agent` |
| `DeFlow.patch.reason`, `DeFlow.patch.decision`                                 | replan spans                      |
| `DeFlow.permission.level`                                                      | `invoke_agent`, `execute_tool`    |
| `DeFlow.gate.verdict` (`pass`\|`fail`\|`needs-human`)                          | gate spans                        |
| `DeFlow.compaction.scope`, `DeFlow.compaction.fidelity`                        | compaction span events            |
| `DeFlow.adapter.kind` (`acp`\|`shim`\|`api`\|`mock`), `DeFlow.adapter.version` | `invoke_agent`                    |
| `DeFlow.worktree.branch`                                                       | write nodes                       |

The compaction and blackboard read/write facts are the things OTel structurally cannot express as
first-class concepts — a trace viewer renders a tree of spans and stops there. That is why PRD §4.6's
conclusion still holds: emit the standard namespace for free interop, and build the nine P0 views
([frontend architecture](./12-frontend-architecture.md)) for everything a span tree cannot say.

---

## 4. The semconv stability situation, stated plainly

This is the most volatile dependency in the entire project and it deserves an unvarnished paragraph.

- **Every** `gen_ai.*` attribute is **Development** stability. There is no 1.0. They live under the
  `/incubating` import subpath _precisely so_ they can break without a major version bump.
- Names do change in practice: `gen_ai.system` was renamed to `gen_ai.provider.name` in **v1.37.0**,
  and both still ship side by side in the JS package. **Verified 2026-08-02.**
- In **v1.42.0** (12 June 2026), every `gen_ai.*`, `openai.*` and `mcp.*` convention was **deprecated
  out of the main `open-telemetry/semantic-conventions` repo** and moved to a new dedicated
  repository, `open-telemetry/semantic-conventions-genai`.
- That new repository had **zero releases and zero tags as of 2026-08-02**. **Verified.**

The direct consequence: **F10.12's instruction to "pin the semconv version" is not currently
satisfiable for `gen_ai.*` specifically.** There is no versioned GenAI-conventions release and no
stable GenAI schema URL to pin against.

### Mitigation

Three moves, all cheap:

1. **Pin exactly, not with a caret.**
   ```jsonc
   "@opentelemetry/semantic-conventions": "1.43.0",   // exact — no ^
   "@opentelemetry/sdk-node": "0.221.0",
   "@opentelemetry/exporter-trace-otlp-http": "0.221.0"
   ```
2. **Opt in explicitly** so the SDK emits the current experimental shape rather than a legacy one:
   ```
   OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
   ```
3. **Isolate the whole surface behind one file.** `src/telemetry/semconv.ts` re-exports DeFlow's own
   constants, which happen to be defined in terms of OTel's. Nothing else in the codebase imports
   `@opentelemetry/semantic-conventions/incubating`. A rename upstream is then a one-file change and
   a dual-emit window is three lines.

```ts
// packages/daemon/src/telemetry/semconv.ts — the ONLY file allowed to import /incubating
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";

export const GEN_AI = {
  operationName: ATTR_GEN_AI_OPERATION_NAME,
  providerName: ATTR_GEN_AI_PROVIDER_NAME,
  requestModel: ATTR_GEN_AI_REQUEST_MODEL,
  usageInputTokens: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  usageOutputTokens: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} as const;

/** DeFlow's own namespace. Never collides with a gen_ai rename. */
export const DeFlow = {
  runId: "DeFlow.run.id",
  nodeId: "DeFlow.node.id",
  planVersion: "DeFlow.plan.version",
  gateVerdict: "DeFlow.gate.verdict",
  permissionLevel: "DeFlow.permission.level",
} as const;

/** Dual-emit window: set when upstream renames an attribute mid-migration. */
export const DUAL_EMIT: ReadonlyArray<readonly [string, string]> = [
  // ['gen_ai.provider.name', 'gen_ai.system'],  // enable if a backend still wants the old name
];
```

Re-check `open-telemetry/semantic-conventions-genai`'s releases page at the **start of M2** rather
than assuming this snapshot holds. The moment it cuts a first tagged release, the attribute set may
shift and the pinning strategy changes.

---

## 5. Backend: Arize Phoenix locally, Langfuse for the M3 hub

**Phoenix for local development.** It runs as a **single process backed by SQLite by default**
(`pip install arize-phoenix && phoenix serve`, or one container if you prefer), is OTel-native, and
imposes no event caps. Point the OTLP exporter at it and the gen_ai spans render immediately.

**Langfuse is rejected for local dev on NF6 grounds, not feature grounds.** Its self-hosted shape
needs Postgres + ClickHouse + Redis/Valkey + object storage + a web app + an async worker: **six
services and a hard Docker dependency**. NF6 says "no database server, no Docker requirement for the
core", and the whole install pitch is `npx deflowai up`. A local observability backend that requires a
six-service compose file directly contradicts that.

|                 | Phoenix            | Langfuse (self-hosted)                         |
| --------------- | ------------------ | ---------------------------------------------- |
| Processes       | 1                  | 6                                              |
| Datastore       | SQLite by default  | Postgres + ClickHouse + Redis + object storage |
| Docker required | no                 | yes                                            |
| OTLP ingest     | native             | `POST /api/public/otel`                        |
| Fit             | **local dev (M2)** | **team hub (M3)**                              |

Keep Langfuse **documented** for the M3 DeFlow Hub (PRD §9.5), where Docker is already assumed. Its
OTLP endpoint is `POST /api/public/otel` with HTTP Basic auth carrying base64 `public_key:secret_key`.
Nothing about the emitter changes — same spans, different `OTEL_EXPORTER_OTLP_ENDPOINT`.

**One honest caveat:** Phoenix is a Python package. It is a _developer-machine_ dependency for
inspecting traces, never a runtime dependency of `DeFlowd`, and `npx deflowai up` must work with no
collector configured at all. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the telemetry subscriber
does not start.

**Rejected alternative: OpenInference** (Phoenix's own native format). Better-typed for retriever and
embedding spans, but Arize-specific — it loses the Datadog and Langfuse portability that is the
entire point of F10.12. Emit `gen_ai.*` and let Phoenix map it.

---

## 6. The artifact and blob store

Large payloads must not live in the ledger. This is an observability concern _and_ a durability
concern: **replay time on restart is a function of event-log size**, and un-spilled tool output is
what makes it explode. Keeping the ledger small is what keeps F4.2 fast.

### Layout

```
$XDG_DATA_HOME/DeFlow/ (falls back to ~/.DeFlow)
  ledger.db                                    # events only; no payloads over the spill threshold
  blobs/<sha256[0:2]>/<sha256>                 # global, content-addressed, immutable
.DeFlow/runs/<runId>/
  artifacts/<sha256>                           # per-run view: hardlink to the blob (copy fallback)
  nodes/<nodeId>/{packet.json, prompt.txt, stdout.log, output.json, verdict.json}
```

The global store is where deduplication happens; the per-run `artifacts/` directory is what keeps a
run self-contained and inspectable in an open format on disk (NF8). Hardlink into it where the
filesystem allows and fall back to a copy where it does not — `rm -rf` on one run directory must
never corrupt another run's view.

### Spill rule

Any single event payload over **~256 KiB** — in practice `tool_call_update` content and
`terminal/output` — is written to the blob store and the event carries only a handle:

```ts
type BlobRef = {
  sha256: string;
  bytes: number;
  mime: string;
  head: string; // first ~2 KiB
  tail: string; // last ~2 KiB
  truncated: true;
};
```

`head` and `tail` are the reason the UI can render a preview of a 40 MB build log in a list of two
hundred nodes without touching the disk once. The full body is fetched on demand, and any agent can
pull it through an MCP tool ([context and memory](./08-context-and-memory.md), F6.5).

### Deduplication is not a micro-optimisation here

Content-addressing means **repeated identical outputs across retry attempts store once**. That is not
a hypothetical: the single most common large artifact in DeFlow is _the same failing test log,
emitted again on attempt 2 and attempt 3 of a repair loop_ (F7.5). A three-attempt loop over a 20 MB
Jest log costs 20 MB, not 60 MB, and the ledger carries three 4 KiB handles instead of 60 MB of text.

### Related caps

Two limits belong here because they are the same problem seen from the ingest side
([provider adapter layer](./07-provider-adapter-layer.md)):

- **Frame cap, 8 MiB.** The ACP SDK's `LineBuffer` has **no maximum line length** — `push()`
  accumulates chunks until it finds a `0x0a` byte. **Verified 2026-08-02** by reading
  `@agentclientprotocol/sdk@1.3.0`'s `dist/line-buffer.js`. An agent that wedges without emitting a
  newline grows that buffer until DeFlowd OOMs. Interpose a `TransformStream` upstream of
  `ndJsonStream()` that counts bytes since the last newline, and on breach emit a structured
  `FrameTooLarge` failure, log the first 4 KiB, and `killTree()` the agent. Do not attempt recovery.
- **Terminal ring buffer, 1 MiB per terminal.** A `pnpm build` with a progress bar emits tens of MB
  through ACP `terminal/output`. Keep a ring buffer and report truncation honestly.

For scale calibration: a _trivial_ `claude -p "say ok"` turn emitted a single **16,024-byte** JSON
line (the `system/commands_changed` frame). **Verified 2026-08-02.** Real turns are far larger.

---

## 7. Secret redaction (F5.9)

F5.9 is the M2 blocker for showing colleagues, and PRD §3.2's G14 names artifact leakage as the thing
that blocks team sharing outright. ODW's own docs warn that run directories contain prompts, source
snippets, stdout/stderr and model output, and its `security.redactEnv` covers env vars in the
manifest only — not the artifacts.

### Tool choice: secretlint's Node API, in-process

Use **`secretlint@13.0.4`** with **`@secretlint/node`** and
**`@secretlint/secretlint-rule-preset-recommend@13.0.4`** (published 22 July 2026, actively
maintained). **Verified on npm 2026-08-02.** It is the only credible option that is a real Node
library with a programmatic API, rather than a foreign-language binary to vendor per platform.

Why each alternative is rejected:

| Tool               | Why not                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **gitleaks**       | Go binary, and its value is git-_history_ scanning. DeFlow's artifacts are loose text blobs (`prompt.txt`, `stdout.log`, `output.json`), not commits. The `gitleaks` npm package is a stale, unrelated 1.0.0 from 2022. Shipping a Go binary breaks single-command install across three platforms (NF6). **But harvest its ruleset** — see below.   |
| **trufflehog**     | Its differentiator is **live verification**: read-only API calls to the provider to check whether a candidate secret is valid, across 700+ types. That is an **outbound network call carrying a candidate secret**. Flatly wrong for a local-first tool and a direct violation of NF1. Do not use it in the redaction path under any configuration. |
| **detect-secrets** | Python, plus a baseline-file workflow designed for legacy repos with pre-existing secrets to grandfather in. Wrong shape: DeFlow generates fresh artifacts every run and wants zero findings, not a maintained baseline.                                                                                                                            |

**Harvest gitleaks' ruleset as a corpus.** `config/gitleaks.toml` carries 150+ well-maintained
provider regexes and is the best free corpus available. Port what you need into custom secretlint
rules under `.DeFlow/redaction/rules/`, and record the provenance of each ported rule in a comment.
That is a one-time transcription, not a runtime dependency.

### Four design points

**1. Redact at EXPORT, not at write.**

NF8 requires every artifact to be inspectable on disk in an open format, and the local artifact store
sits **inside the user's own trust boundary** — the secrets in it are the user's own, on the user's
own machine, under the user's own OS account. Redacting on write would destroy debuggability (the
stack trace you need is the one with the connection string in it) and would put a scanner in the hot
path of every node.

Redaction runs in exactly two places:

- the F10.13 shareable-report pipeline, and
- the M3 hub sync (PRD §9.5).

Never on write. See [the security model](./15-security-model.md) for where this sits in the wider
threat model.

**2. Redact structurally first, by regex second.**

This is the point that matters most and it is the one everyone skips.

You _know_ where secrets come from: `process.env` at child-spawn time. DeFlow is the process that
constructs the child environment ([workspace and safety](./09-workspace-and-safety.md)), so at spawn
it can snapshot the exact values it handed over. Build the deny-list from **actual env values** whose
keys match `/(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|AUTH)/i`, plus anything over ~20 characters
with high entropy, and do **exact-string replacement** of those values across every artifact.

```ts
// packages/daemon/src/redact/structural.ts
const SENSITIVE_KEY = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|AUTH)/i;

export function buildDenyList(env: NodeJS.ProcessEnv): Map<string, string> {
  const deny = new Map<string, string>(); // value -> replacement token
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8) continue;
    if (SENSITIVE_KEY.test(k) || looksHighEntropy(v)) {
      deny.set(v, `[REDACTED:env:${sha256(v).slice(0, 8)}]`);
    }
  }
  return deny;
}
```

This catches company-internal token formats that no published rule covers — a Voyado-shaped bearer
token, an internal registry credential, a service account string with a bespoke prefix — and it is an
O(n) string search. **This is the highest-value 30 lines in the feature.** ODW's `security.redactEnv`
covers env vars in the manifest; this covers env values that _leaked into output_, which is G14's
actual failure mode.

**3. Then secretlint, with stable replacement tokens.**

Run secretlint over the remaining text for known provider formats (AWS keys, GitHub PATs, Slack
tokens, Google API keys, Stripe keys, PEM private-key blocks). Replace each finding with a stable
token:

```
[REDACTED:<kind>:<sha256(secret)[0:8]>]
e.g. [REDACTED:aws-access-key-id:3f9a1c40]
```

The `sha8` suffix means **the same secret is recognisably the same across artifacts** without ever
revealing it — so a reviewer reading a report can tell "the token in the build log is the token the
agent read from `.env`", which is exactly the question you ask when reviewing a leak.

**4. Fail closed.**

If redaction throws, times out, or the rule set fails to load, **block the export** and append an
`export.blocked` ledger event carrying the reason. Never ship an unredacted artifact because the
scanner crashed.

```ts
type Event =
  | { t: "export.started"; runId: RunId; target: "report" | "hub" }
  | {
      t: "export.blocked";
      runId: RunId;
      reason: "scanner-error" | "scanner-timeout" | "rules-unavailable";
      detail: string;
    }
  | {
      t: "export.completed";
      runId: RunId;
      findings: number;
      artifacts: number;
    };
```

Ship `DeFlow redact --dry-run <runId>` so the user can preview findings before sharing, and put the
finding count into M2's "shareable" definition of done.

---

## 8. The shareable run report (F10.13)

A single static HTML file, self-contained, for pasting into a PR description or handing to a
colleague. It is P2 / M3 in the roadmap, and it is **gated on redaction being real**, not on
rendering being pretty.

What goes in:

- the `TaskSpec` and the acceptance-criteria board with final satisfied/unsatisfied status (F10.8)
- the final `PlanGraph` plus the version history and every patch's stated reason (F10.2)
- per-node: provider, model, CLI version, permission level, duration, cost, retry count
- gate verdicts with their structured findings (F7.3)
- the cumulative run diff
- the run timeline

What must be redacted before it can ship, in order:

1. **Structural pass** over every included artifact using the spawn-time deny-list (§7, point 2).
2. **secretlint pass** for known provider formats, with `[REDACTED:kind:sha8]` tokens.
3. **Blob bodies are excluded by default.** The report embeds `head`/`tail` previews and a handle,
   not the full artifact. A 40 MB test log is not a PR attachment, and each unredacted byte you do
   not embed is a byte that cannot leak.
4. **Absolute paths are rewritten** to repo-relative form. `/Users/meg/work/...` is not a secret but
   it is gratuitous, and it also breaks snapshot determinism if the report is ever diffed.
5. **`export.blocked` on any failure** — the report is not written at all.

The report is a projection of the ledger like everything else, which means it can be regenerated from
the ledger at any time, with a newer rule set, long after the run finished.

---

## 9. Wiring it together

```ts
// packages/daemon/src/telemetry/index.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export function startTelemetry(cfg: Config) {
  if (!cfg.otel.endpoint) return null; // no collector configured -> no subscriber, no cost
  const sdk = new NodeSDK({
    serviceName: "DeFlow",
    traceExporter: new OTLPTraceExporter({
      url: `${cfg.otel.endpoint}/v1/traces`,
    }),
  });
  sdk.start();
  return sdk;
}
```

The emitter itself is a **ledger subscriber**, not an instrumentation layer sprinkled through the
orchestrator:

```
ledger append ──► SSE stream (UI)
              ├─► projections (blackboard, plan state)
              └─► telemetry subscriber ──► gen_ai spans ──► OTLP
```

That ordering is deliberate. A span is emitted _because_ an event was durably written, so a span can
never describe something the ledger does not contain — which keeps NF10 intact and makes the exporter
trivially testable ([testing strategy](./14-testing-strategy.md)): feed it a recorded ledger, assert
on the span tree, no network, no collector, no vendor CLI.

---

## 10. Pitfalls

- **Do not treat pino as an event store.** It destroys NF10 and tempts you into reconstructing state
  from log files after a crash.
- **Do not assume vendor CLIs give you `gen_ai.*` for free.** Claude Code 2.1.220 contains zero
  `gen_ai.` strings; `codex exec` emits no metrics at all. The PRD §4.6 claim is contradicted.
- **Do not invent `gen_ai.*` attribute names.** Use `DeFlow.*` for anything the convention does not
  define. An invented name is a future collision.
- **Do not pin `@opentelemetry/semantic-conventions` with a caret.** Development-stability attributes
  under `/incubating` can and do rename between minors. Exact pin, one isolation file.
- **Do not assume there is a GenAI schema URL to pin.** `semantic-conventions-genai` had zero
  releases and zero tags on 2026-08-02.
- **Do not put large payloads in the ledger.** Replay time is a function of event-log size; a single
  un-spilled 40 MB build log turns a fast restart into a slow one.
- **Do not use trufflehog.** Its verification feature makes outbound API calls carrying candidate
  secrets. That is an NF1 violation and an unacceptable data-exfiltration shape for a tool whose
  entire pitch is that nothing leaves the machine.
- **Do not redact at write time.** It breaks NF8, destroys debuggability, and puts a scanner on the
  hot path for zero security gain inside the user's own trust boundary.
- **Do not fail open on a redaction error.** Block the export, emit `export.blocked`, say why.
- **Do not treat the Claude Code internals in this document as stable.** The `claude_code.*` names,
  the `compact_boundary` shape and the `modelUsage` fields were read from the shipping bundle of
  **one** version (2.1.220). They are private implementation details with no compatibility guarantee
  and they will change — this is exactly PRD risk G7. Assert on them in the adapter conformance suite
  (F3.4) so drift is caught by `deflow doctor`, not by a failed three-hour run.

---

**Related:** [Durable execution](./05-durable-execution.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) ·
[Context and memory](./08-context-and-memory.md) ·
[Security model](./15-security-model.md) ·
[Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
