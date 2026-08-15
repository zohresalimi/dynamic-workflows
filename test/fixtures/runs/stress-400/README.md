# `stress-400`

A wide `map` fan-out: 400 materialised child nodes, each with real
`<mapNodeId>--<itemId>` ids minted by `mapChildId`, each moving through
`pending` → `running` → `passed`. This is the fixture
[KAR-16.6](../../../docs/delivery/epics/EPIC-16-ui-foundation.md)’s render
budget, ELK layout time and scrubber responsiveness are measured against, and
the one KAR-16.4’s bounded-memory ring is exercised by.

**Assembled by `packages/core/scripts/build-ui-run-fixtures.ts`, never edited by
hand.** Rebuild it with:

```
node packages/core/scripts/build-ui-run-fixtures.ts
```

- run: `run_20260811T120000Z_e3f4a5`
- every envelope is written through `parseEvent` before it is serialised, so a
  fixture this build cannot read is a failed build rather than a puzzle inside a
  projection
- `seq` has holes, because it is one global `AUTOINCREMENT` shared with every
  other run in a data directory (docs/11-api-and-realtime.md §4.2)

**This fixture is assembled, not recorded**, and the two are not the same thing.
`compaction/` and `gate-failure-repair/` are recordings of real runs;
[KAR-16.5](../../../docs/delivery/epics/EPIC-16-ui-foundation.md) owns replacing
this one with a recording too, and cannot start until `deflow run` (EPIC-18
KAR-18.3) exists. Until then the payload *shapes* here are the production ones —
`buildPacket`, `planHash`, `FactSchema`, `parseEvent` — and only the
scenario is authored.

Everything in here is synthetic: a fabricated run id, fabricated node ids, and
paths under `/tmp`.
