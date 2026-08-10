# `crash-resume-seq-gap`

A ledger whose sequence numbers jump, produced by `kill -9` on a real writer —
never by hand.

**Produced by `packages/daemon/scripts/build-crash-resume-fixture.ts`.**
Rebuild it with:

```
node packages/daemon/scripts/build-crash-resume-fixture.ts
```

- run under test: `run_20260810T101500Z_c4a5b1`, `seq` 4, 5, 7, 8, 11
- the other run: `run_20260810T101500Z_d17e02`, 10 events, and it is the
  owner of 1, 2, 3, 6, 9, 10 — the numbers a gap detector would
  call lost
- the child was still appending when it was killed, so the tail of the other run
  is whatever SQLite had committed at that instant. That is the point: the
  sequence under test is fixed, and what a crash leaves after it is not.

`seq` 4, 5, 7, 8, 11 is a **healthy** log. `event` is one global
`AUTOINCREMENT` sequence keyed by `run_id`, so a run's cursor walks a strided
subsequence of it, and `AUTOINCREMENT` never reissues a pruned number. The
cursor contract is *resume from strictly greater than `seq`*, never *expect
`seq` + 1* (docs/11-api-and-realtime.md §4.2). A client that treats the hole as
a dropped event reports false data loss and may refetch a multi-hour run over
nothing.

The build happens under `/tmp/deflow-crash-resume-seq-gap`, so every path this ledger
records is synthetic and portable.
