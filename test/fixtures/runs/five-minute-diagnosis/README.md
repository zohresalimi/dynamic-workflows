# `five-minute-diagnosis`

The run [EPIC-17-S35](../../../docs/delivery/flows/EPIC-17-p0-views-flows.md)
is timed over: a design-system migration whose 22 nodes end 18 passed, 1
failed, 2 abandoned and 1 awaiting-human, and whose failure is only
explicable by walking six views in sequence. `n-recon` writes
`decision/import-policy`; `n-impl-3`’s first packet carries it; a
`context.compacted` at `exact` fidelity drops that one segment while keeping
every pin; the two later attempts are built without it; the
`import-boundary` gate then refuses `AC-3` with a blocker at
`packages/ui/src/Button.vue:42`. The plan versions carry the split that
created the node (v2) and the provider re-route that followed it (v3).
This is the only fixture in the corpus that answers all six of the
scenario’s questions from one run.

**Assembled by `packages/core/scripts/build-ui-run-fixtures.ts`, never edited by
hand.** Rebuild it with:

```
node packages/core/scripts/build-ui-run-fixtures.ts
```

- run: `run_20260811T160000Z_d7e8f9`
- every envelope is written through `parseEvent` before it is serialised, so a
  fixture this build cannot read is a failed build rather than a puzzle inside a
  projection
- `seq` has holes, because it is one global `AUTOINCREMENT` shared with every
  other run in a data directory (docs/11-api-and-realtime.md §4.2)

**This fixture is assembled, not recorded**, and the two are not the same thing.
`compaction/` and `gate-failure-repair/` are recordings of real runs;
[KAR-16.5](../../../docs/delivery/epics/EPIC-16-ui-foundation.md) owns replacing
this one with a recording too, and cannot start until `DeFlow run` (EPIC-18
KAR-18.3) exists. Until then the payload *shapes* here are the production ones —
`buildPacket`, `planHash`, `FactSchema`, `parseEvent` — and only the
scenario is authored.

Everything in here is synthetic: a fabricated run id, fabricated node ids, and
paths under `/tmp`.
