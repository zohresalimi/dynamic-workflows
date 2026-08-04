# S0 — go/no-go against the kill criterion

> Spike for [KAR-00.7](../delivery/epics/EPIC-00-foundation-spikes.md#kar-007--record-spike-outcomes-and-take-the-gono-go-decision-against-the-kill-criterion).
> Scenarios: [EPIC-00-S21, EPIC-00-S22, EPIC-00-S23](../delivery/flows/EPIC-00-foundation-spikes-flows.md)
> (EPIC-00-S10 is verified jointly by KAR-00.1 and this note — see
> [S1-acp-round-trip.md](./S1-acp-round-trip.md#cancellation-graded-epic-00-s10)).
> Consolidates: [S1](./S1-acp-round-trip.md), [S2](./S2-zero-build.md),
> [S3](./S3-elk-worker.md), [S4](./S4-one-port.md), [S5](./S5-native-prebuilds.md),
> [S7](./S7-biome-vue.md). Executed by
> [`test/spike-notes-completeness.test.ts`](../../test/spike-notes-completeness.test.ts).

**Date:** 2026-08-04.

## Why six note files for seven spikes

`docs/spikes/` holds six decision-note files, not seven: the epic's own scope section
([EPIC-00-foundation-spikes.md](../delivery/epics/EPIC-00-foundation-spikes.md#scope)) states "S5
and S6 are combined into KAR-00.5 — both are 'does the native prebuild load on the machines we ship
to'", and [S5-native-prebuilds.md](./S5-native-prebuilds.md) carries both outcomes as its
"Measurement 1/2" (better-sqlite3, roadmap S5) and "Measurement 3" (`@lydell/node-pty`, roadmap S6).
All seven roadmap spike outcomes are recorded; one file records two of them. This note plus the six
spike notes is seven files under `docs/spikes/` in total.

## The kill criterion, restated verbatim

> **Kill criterion (PRD §11, restated and sharpened in [roadmap §1](../../17-roadmap.md)).** If S1
> shows that ACP integration is impractical — the adapters cannot complete a prompt cycle reliably,
> permission mediation does not actually reach the client, or cancellation deadlocks — **and** CLI
> exec shims prove hopelessly unstable across two vendors, then the provider-neutrality thesis
> needs rethinking before anything else is built. That is the point at which to stop.

The three-way menu the decision is chosen from (epic file, KAR-00.7):

| Decision          | Condition                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| GO                 | KAR-00.1's six steps completed on at least one agent, with permission mediation reaching the client and cancellation not deadlocking |
| GO, re-weighted    | The ACP cycle works on the native agent but the community adapter is unreliable                                                      |
| NO-GO              | The ACP cycle is unreliable across both agents **and** a shim spike over two vendors is equally unstable                             |

## Measurement — the evidence the decision rests on

All eight of KAR-00.1's steps were driven against a real vendor binary
(`claude-agent-acp@0.64.1`), not a mock, with every frame validated against the ACP schema
([S1, "The six steps"](./S1-acp-round-trip.md#the-six-steps-claude-agent-acp0641)):

| Step                         | Result | Evidence                                                                 |
| ----------------------------- | ------ | -------------------------------------------------------------------------- |
| `initialize`                  | ok     | `protocolVersion: 1`                                                     |
| `session/new`                 | ok     | session id issued; DeFlow's stdio MCP server accepted without error       |
| `session/prompt` → streaming  | ok     | 17 `session/update` notifications, first-to-last spread **6699 ms** (> 500 ms threshold) |
| `session/request_permission`  | ok     | `reject_once` honoured; the forbidden write never happened               |
| `session/cancel`               | ok     | `stopReason: cancelled` **6 ms** after the cancel; 1 trailing update accepted afterwards; a subsequent `session/new` round-tripped, proving the read loop had not wedged |

That is every element the kill criterion's first clause names, and none of them failed. The second
clause ("**and** CLI exec shims prove hopelessly unstable") is a conjunction: since the first clause
is already false, the whole criterion is false regardless of the shim path, so no CLI-exec-shim
spike was run to reach this decision — consistent with the GO row of the menu above, which asks only
for the ACP cycle succeeding on at least one agent.

`gemini-cli@0.53.1` (the second, natively-ACP agent) negotiated `initialize` correctly but could not
proceed past `session/new` for a **credentials** reason (`GEMINI_API_KEY` unset, no OAuth session on
this machine — AR-1 forbids the harness from supplying one), not a protocol reason. That is not the
community-adapter-unreliable condition "GO, re-weighted" asks about, since the surface that failed
was the *native* agent, not the community adapter — full detail in
[S1, "which step failed, and why"](./S1-acp-round-trip.md#gemini-cli0531-which-step-failed-and-why).

## Decision: **GO.**

EPIC-01 starts. Every one of the other six spikes' fallbacks, where taken, is named below with its
affected downstream story.

### Fallbacks: which were taken

| Spike | Fallback prepared                                     | Taken? | Downstream story                                                                 |
| ----- | ------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------- |
| S1    | Promote KAR-05.8 (CLI exec shim) to a parallel path    | **No** — the adapter completed all six steps            | —                                                                  |
| S2    | `tsx@4.23.4` watch, replacing `node --watch`            | **No** — the symlink/realpath mechanism held on both Node majors | —                                                                  |
| S3    | `@dagrejs/dagre@3.0.0` for the live graph, ELK main-thread for the scrubber | **No** — elkjs loads in a `?worker` chunk at 5555 B entry cost | —                                                                  |
| S4    | Two ports with a documented Vite dev-proxy configuration | **No** — one port, middleware mode, ten minutes with no buffering or drop | —                                                                  |
| S5    | A documented glibc floor, instead of "just works" everywhere | **Yes** — `linux-glibc-node24` (Debian bookworm, glibc 2.36) cannot `dlopen` the ledger prebuild | **KAR-18.4** (`doctor` reports the glibc ≥ 2.38 floor by name); **KAR-18.6** (install verification / README states the floor) |
| S6 (part of S5) | `@lydell/node-pty` optional, no-TTY spawn fallback on an unsupported platform | **Yes** — no musl build of the pty exists | **KAR-01.1** (`@lydell/node-pty` stays `optionalDependency`, already implemented this way); **KAR-05.1** (`terminal/*` client capability advertised only when a pty allocation actually succeeds at runtime) — confirms the design already in place, no plan change |
| S7    | Leave `.vue` out of the pre-commit `format` glob (do not auto-stage) | **No** — Verdict: safe; `stage_fixed: true` covers `.vue` (KAR-01.5, KAR-01.6, already implemented) | —                                                                  |

Only S5/S6 triggered a real fallback; both are the kind the epic exists to catch a day early rather
than a fortnight late (docs/delivery/epics/EPIC-00-foundation-spikes.md, "Why this matters").

## Open-risk register — every id this epic owned

| Id   | Status                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| A0-1 | closed — [S1](./S1-acp-round-trip.md#decision), full six-step cycle completed against a real adapter              |
| A0-3 | closed — [S1](./S1-acp-round-trip.md#decision), ACP surfaces exact token usage and cost; compaction genuinely absent |
| A0-6 | closed — [S5](./S5-native-prebuilds.md#decision), `@lydell/node-pty` works on 4 of 5 cells, no-TTY fallback engineered for the fifth |
| A1-1 | closed — [S5](./S5-native-prebuilds.md#measurement-2--the-append-benchmark-on-apfs-epic-00-s18), APFS `F_FULLFSYNC` measured at 335 ev/s vs Linux's 979 |
| A1-2 | closed — [S5](./S5-native-prebuilds.md#measurement-1--better-sqlite3-on-darwin-epic-00-s17), darwin-arm64, linux-arm64 and linuxmusl-arm64 prebuilds executed |
| A2-1 | closed — [S2](./S2-zero-build.md#decision), the symlink-realpath mechanism confirmed on Node 24 and 26     |
| A2-3 | closed — [S7](./S7-biome-vue.md#the-risk-this-closes), the markup formatter genuinely gates on the `html` block; the opt-in diff is small and semantics-preserving |
| A3-4 | closed — [S3](./S3-elk-worker.md#decision), elkjs loads in a Vite `?worker` chunk in a production build over plain HTTP |
| A3-5 | closed — [S3](./S3-elk-worker.md#rows-1215-the-constraint-recipe-does-not-work-and-row-14-is-the-trap), `layerChoiceConstraint`/`positionChoiceConstraint` confirmed inert; union-graph-laid-out-once is F10.2's real mechanism |
| A4-2 | closed — [S1](./S1-acp-round-trip.md#decision), `structured_output` confirmed absent from the protocol entirely |

Every id this epic was scoped to close is closed; none is still open. (Machine-checked: each note's
`closes:` front matter is parsed and the union asserted to cover this exact list —
`test/spike-notes-completeness.test.ts`.)

## No hardcoded capability matrix

`fixtures/capabilities/claude-agent-acp@0.64.1.json` and `fixtures/capabilities/gemini-cli@0.53.1.json`
are generated from the observed `initialize` response, not hand-written — each carries a `probedAt`
timestamp and the verbatim `agentCapabilities` block alongside the derived matrix. A grep of
`packages/` and `spikes/` for a source file that assigns literal `true`/`false` to every one of the
capability matrix's nine keys finds none: `spikes/s1-acp/src/report.ts` declares the shape as a
*type* (`resume: boolean`, never a literal), and `spikes/s1-acp/src/capabilities.ts`'s
`SNAPSHOT_2026_08_02` is a two-key comparison input used only to report a divergence, never written
to the fixture in place of what was observed (A0-9 — see
[S1, "The capability matrix, generated per agent"](./S1-acp-round-trip.md#the-capability-matrix-generated-per-agent-epic-00-s5)).

## Committed

This note is dated 2026-08-04 and is committed alongside KAR-00.7's other changes. The decision is
**GO**, so no board row moves to `Blocked`; EPIC-01 already reflects its completed status in Linear
(the SSOT — `docs/delivery/board.md`'s status column is a point-in-time snapshot, per
[CLAUDE.md](../../CLAUDE.md)).
