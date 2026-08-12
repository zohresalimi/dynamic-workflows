# `gate-failure-repair`

A real run of the surgical repair loop (docs/10-verification-gates.md §7): a
deterministic gate fails, the failure earns one fix node, the fix node writes a
failing regression test and then the fix, and the gate set re-runs from the
deterministic tier and passes.

**Produced by `packages/daemon/scripts/build-gate-repair-fixture.ts`, never by
hand.** Rebuild it with:

```
node packages/daemon/scripts/build-gate-repair-fixture.ts
```

- run: `run_20260810T090000Z_9f31ab`, final status `completed`
- the fix node is a **mock agent** (`@DeFlow/mock-agent`), driven with
  `--seed 42 --scenario <workDir>/scenarios/<node>.json`, so the same
  seed reproduces the same events
- finding `65207341fbd9` → fix node `fix-65207341fbd9` → re-run gate
  `gate-typecheck-r2`
- verdicts, in ledger order: `typecheck` fail @ 12, `typecheck` pass @ 29

`repair.json` is the same story as JSON, for a consumer that cannot open
SQLite — a browser spec, above all. The run was built under
`/tmp/deflow-gate-failure-repair`, so every absolute path recorded in the ledger is
synthetic and portable; a fixture carrying a developer's home directory is a
privacy leak with a long half-life.
