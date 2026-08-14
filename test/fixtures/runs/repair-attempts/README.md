# `repair-attempts`

One node, three attempts, and **a context packet per attempt** — the only
fixture in the corpus with two packets for the same node. Attempt 2’s packet
gains the history summary and tool output attempt 1 could not have had;
attempt 3’s is identical to attempt 2’s, which is what a repair that changed
nothing looks like from the inside. The ladder ends on
`contract.schema-invalid` carrying its Ajv errors, and a second node fails at
`adapter.spawn-failed` before any packet was ever built.

**Assembled by `packages/core/scripts/build-ui-run-fixtures.ts`, never edited by
hand.** Rebuild it with:

```
node packages/core/scripts/build-ui-run-fixtures.ts
```

- run: `run_20260811T140000Z_c4d5e6`
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
