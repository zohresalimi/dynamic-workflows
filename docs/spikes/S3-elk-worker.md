---
closes: [A3-4, A3-5]
---

# S3 — elkjs in a Vite 8 web worker

> Spike for [KAR-00.4](../delivery/epics/EPIC-00-foundation-spikes.md#kar-004--spike-elkjs-in-a-vite-8-web-worker).
> Scenarios: [EPIC-00-S14, EPIC-00-S15, EPIC-00-S16](../delivery/flows/EPIC-00-foundation-spikes-flows.md).
> Artefact: [`spikes/s3-elk-worker/`](../../spikes/s3-elk-worker/) with its
> [`check.mjs`](../../spikes/s3-elk-worker/check.mjs), executed by
> [`test/integration/spike-s3-elk-worker.test.ts`](../../test/integration/spike-s3-elk-worker.test.ts),
> [`e2e/spike-s3-elk-worker.test.ts`](../../e2e/spike-s3-elk-worker.test.ts) and
> [`test/spike-s3-plan-versions.test.ts`](../../test/spike-s3-plan-versions.test.ts).

**Date:** 2026-08-04. **Machine:** macOS 26.5.2 (darwin/arm64), Node v24.18.0, vite 8.2.0,
elkjs 0.12.0, @dagrejs/dagre 3.0.0, Chromium 151.0.7922.34 via playwright 1.62.1.

## The question

Does `elkjs@0.12.0` load in a Vite 8 worker **in a production build**, served from `dist/` over
plain HTTP? A3-4 is graded **High** and had never been build-tested. elkjs is GWT-transpiled Java;
its own README acknowledges bundler friction, and the `workerUrl` option it documents wants a path
that is publicly served under a name known at authoring time — which is precisely what
`vite build` destroys when it renames the file to `elk-worker.min-<hash>.js`.

The second question, while the harness is warm: can the plan-evolution scrubber (F10.2, the marquee
feature) hold node positions still across plan versions, and is the `layerChoiceConstraint` /
`positionChoiceConstraint` recipe that circulates online any use for it?

## Method

`spikes/s3-elk-worker/` is a throwaway pnpm workspace holding one Vite app:

- `src/engine/elk.ts` — the recipe under test, in six lines: `elkjs/lib/elk-worker.min.js?worker`
  plus `new ELK({ workerFactory })`. `?worker` is what teaches Vite the file is a worker entry, so
  it gets its own chunk, its own hash, and a URL the built bundle already knows. The `Worker`
  constructor is wrapped just long enough to record the URL the browser really fetched.
- `src/engine/absent.ts` — the same module surface with ELK removed, aliased in by
  `S3_VARIANT=no-elk`. Same entry, same fixtures, same rendering, same dynamic dagre import; ELK is
  the only variable, which is what makes the entry-chunk comparison a comparison.
- `src/graph.ts` — a 60-node DAG and a synthetic 5-version plan (v2 inserts a node, v3 splits a
  node, v4 replaces a node's provider, v5 abandons a branch), plus the union arithmetic. Import-free,
  so the unit slice can pin the fixture's shape without a browser.
- `check.mjs` — builds both variants, asserts on the built `dist/`, and writes
  `measurements/build-sizes.json`, which is where the byte counts below come from.

Everything browser-side runs against `vite build` output served by a plain `node:http` static
server. There is no Vite in that loop at all — deliberately, because the dev server resolves worker
URLs differently from the hashed assets the daemon will serve, so a `vite dev` pass would have
proved nothing about the thing at risk.

## Measurement

| #   | Check                                                                | Result                                                                                                                     |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `vite build` with `?worker` + `workerFactory`                        | **succeeds**, 380–920 ms                                                                                                   |
| 2   | Worker chunk emitted                                                 | exactly one, hashed: `assets/elk-worker.min-COjlAv4s.js`, **1425139 B** (1.36 MiB), carrying `elk.alg.layered`            |
| 3   | Entry chunk **with** ELK                                             | `assets/index-B6ttXx7b.js`, **13291 B**                                                                                   |
| 4   | Entry chunk **without** ELK (`S3_VARIANT=no-elk`)                     | **7736 B**                                                                                                                |
| 5   | The difference AC2 caps at 100 KB                                    | **5555 B** — the `elk-api.js` promise wrapper and the worker-URL reference, nothing else                                   |
| 6   | ELK fingerprints in the entry chunk                                  | **none** (`org.eclipse.elk.alg`, `elk.alg.layered`, `ELK Layered` all absent)                                               |
| 7   | The built app in Chromium, over plain HTTP                           | worker fetched from `/assets/elk-worker.min-COjlAv4s.js`, **200**, no 404 and no failed request anywhere on the page        |
| 8   | 60-node layout                                                       | coordinates for all 60, **95 ms** (re-measured on every e2e run)                                                                                        |
| 9   | Main-thread 10 ms heartbeat across that call                         | **9 ticks** (AC3 asks for ≥ 5) — the main thread was never blocked                                                          |
| 10  | Union graph laid out once, stepped v1 → v5                           | **30 surviving-node comparisons, all byte-identical**; no node moved on any step                                            |
| 11  | The same five versions laid out independently                        | **15 surviving nodes moved**, across three of the four steps                                                               |
| 12  | `layerChoiceConstraint` + `positionChoiceConstraint`, no interactive  | **ignored**, silently: identical coordinates, no error, no console warning                                                  |
| 13  | The same, plus `org.eclipse.elk.interactiveLayout: true`             | **still ignored** — identical coordinates again                                                                             |
| 14  | The same, plus `layering.strategy: INTERACTIVE`                      | drawing changes and the node lands in the requested layer — **but the control says the constraint had nothing to do with it** |
| 15  | `org.eclipse.elk.position` + `crossingMinimization.semiInteractive`  | **ignored**: identical to the baseline                                                                                     |
| 16  | `@dagrejs/dagre@3.0.0` on the same 60 nodes                          | lays them out, 60 distinct positions — the fallback is executable, not just documented                                      |

Rows 1–6 are asserted by `test/integration/spike-s3-elk-worker.test.ts` and re-derivable in one
command with `node spikes/s3-elk-worker/check.mjs`; rows 7–16 by `e2e/spike-s3-elk-worker.test.ts`
against a real Chromium, with the numbers written to `spikes/s3-elk-worker/measurements/`.

### Rows 3–5: ELK is not "kept out of" the entry chunk, it is never in it

The 1.6 MB figure everyone quotes is `elk-worker.min.js`. What the application imports is
`elk-api.js` — a ~10 KB promise wrapper — and a worker *reference*. Vite emits the worker as a
separate chunk because `?worker` says so, and the entry only ever contains its URL. So the
before/after difference is 5555 B rather than 1.6 MB, and NF3's "UI interactive < 1 s" is not at
risk from the layout engine. The measurement matters anyway, because the *failure* mode it rules
out is real: an ELK imported as a plain module, or a worker inlined by `?worker&inline`, would put
all 1.4 MB in the first paint's critical path.

### Rows 12–15: the constraint recipe does not work, and row 14 is the trap

The research (A3-5) predicted `layerChoiceConstraint` would be inert without
`org.eclipse.elk.interactiveLayout=true`. Executed on 0.12.0, it is worse than that: it is inert
**with** it too.

Two things make this a finding rather than a shrug. First, ELK's own
`knownLayoutOptions()` lists both `org.eclipse.elk.layered.layering.layerChoiceConstraint` and
`org.eclipse.elk.layered.crossingMinimization.positionChoiceConstraint`, so "ignored" here means
ignored, not misspelt — the spec asserts that before it asserts anything else. Second, and this is
the part to carry into W11: turning the **layering strategy** to `INTERACTIVE` does change the
drawing, and the target node does land in the layer the constraint asked for. That is exactly the
screenshot a blog post would call success. Laying the same graph out with the same `INTERACTIVE`
strategies and **no constraint at all** produces the byte-identical drawing: `INTERACTIVE` reads
node coordinates, a freshly-built graph has none, and the layer the node appeared to "obey" is
where it was going regardless. The control run is the whole reason this row can be trusted, and
`e2e/spike-s3-elk-worker.test.ts` keeps it.

`semiInteractive` reads `org.eclipse.elk.position` rather than `positionChoiceConstraint`, as the
research said — and setting `org.eclipse.elk.position` changed nothing here either.

**So: do not spend W11 time on interactive constraints.** They are not the mechanism, and the
failure is silent, which is the worst kind — it looks like your constraint *values* are wrong
rather than like the mechanism is inactive.

### Rows 10–11: the union graph is the mechanism for F10.2

Laying out the **union of all five versions once** and then showing and hiding nodes from that
single result makes position stability structural rather than best-effort: there is only one set of
coordinates, so a surviving node cannot move, and the assertion is byte-identity read back out of
the DOM rather than a tolerance. Thirty comparisons across four steps, zero movement.

The alternative is not hypothetical noise — laying each version out on its own moved 15 surviving
nodes, including every node in the plan when the abandoned branch disappeared at v5. A scrubber
that does that is not diagnostic, it is disorienting.

One caution for W11: the research's "about 200 lines" for the scrubber is an estimate and looks
optimistic given the pieces — stable node ids, `ohash` content hashes, set diffing, `rfc6902`
field-level patches, and this union layout. Budget a week.

## Decision

**Adopt elkjs 0.12.0 in a Vite `?worker` chunk.** The recipe builds, the hashed worker loads over
plain HTTP from `dist/`, the layout runs off the main thread, and the entry chunk pays 5555 B for
it. The fallback KAR-00.4 describes — `@dagrejs/dagre@3.0.0` for the live graph with ELK on the
main thread for the scrubber — is **not needed** and is not being taken.

- **EPIC-16's `GraphCanvas` facade (KAR-16.6) is built against `elkjs`.** The facade still exists
  for the reason the roadmap gives — one day of work against the largest single third-party risk in
  the frontend — and layout must stay behind it, so that swapping engines later is a change in one
  file. `@dagrejs/dagre@3.0.0` stays the named alternative, and this spike keeps it executable: the
  e2e spec lays the same 60 nodes out with dagre on every run, so the fallback cannot rot into a
  paragraph.
- **F10.2's scrubber uses one union-graph layout**, not one layout per version.
- **Interactive layout constraints are not a mechanism** for anything in W11.

### The guards this hands on

- **KAR-16.6** owns the facade: `elkjs` behind it, `@dagrejs/dagre` still buildable, no ELK type or
  option id leaking into view code.
- Whoever wires the worker must keep the `?worker` import. `workerUrl` cannot work under Vite's
  asset hashing, and `?worker&inline` would undo row 5 by putting 1.4 MB back into the entry.
- A note for anyone copying example code: **the Vue Flow docs' repl pins `@dagrejs/dagre@1.1.2`,
  two majors behind the `3.0.0` a fresh install gets**, so the API surface in copied snippets is
  older than the version you will have. This spike's dagre code is written against 3.0.0 and
  asserts `dagre.version` starts with `3.`, so the day that stops being true, a spec says so.

### What this spike does not answer

Whether it is **fast enough**. Vue Flow's rendering ceiling is still an estimate extrapolated from
React Flow guidance and remains **Unverified** (A3-2); it is measured in week one of W10 against a
400-node fixture, and it is that measurement — not this one — that decides whether the
memory/data-flow view (F10.4) survives to M1. What is measured here is one 60-node ELK layout at
~95 ms, in a worker, which says nothing about rendering.
