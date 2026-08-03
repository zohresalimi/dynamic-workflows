# ADR 0008: Build the durable engine rather than adopt one

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

[ADR 0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md) settles _what_ execution
model DeFlow uses. This record settles the separate question of whether to write it or to depend on
someone else's — the "build vs buy" call for the single most correctness-critical subsystem, made by
a solo author who should be buying wherever buying is honest.

DBOS was the strongest candidate by a distance. Its pitch is precisely DeFlow's shape: durable
workflows with **zero new infrastructure**, running in-process, backed by Postgres _or SQLite_. If
that were true for TypeScript it would be very hard to argue against.

**It is not true for TypeScript.** Verified against source at a named commit, not against docs:

- Cloned `dbos-inc/dbos-transact-ts` at commit `dfd600cc48537a69f3d57d28108a781bfb82c988`
  (2026-07-30). **Verified 2026-08-02.**
- `package.json` dependencies are exactly `commander, pg, serialize-error, superjson, ws, yaml`.
  **No SQLite driver. No optional or peer dependencies that would supply one.**
- `src/system_database.ts` line 666: `export class SystemDatabase { readonly pool: Pool; ... }` — a
  hard `pg.Pool`. The constructor takes a `systemDatabaseUrl` string and an optional `pg.Pool`.
- `src/sysdb_migrations/migration_runner.ts` imports `type { ClientBase } from 'pg'` and queries
  `information_schema.tables`. It declares `sqlite3?: ReadonlyArray<string>` on the `DBMigration`
  type — **and a repo-wide grep shows that field is referenced nowhere else in `src/`.** It is a
  dead placeholder, most likely copied from a polyglot spec.
- npm `@dbos-inc/dbos-sdk@4.25.14` (published 2026-07-30) carries the same pg-only dependency set.
- DBOS **Go** did gain a SQLite durability backend per the June 2026 release notes. TypeScript did
  not. (The blog page 403s to automated fetch, so treat the Go claim as medium confidence.)

That `sqlite3?` field is exactly the kind of artefact that produces a false positive in a
docs-and-search investigation. Source verification is the reason this record can be definite.

The other options were surveyed and are worse fits: Temporal and Restate need a server, violating
NF6; `reflow-ts@0.5.0` (2026-06-10, four published versions in total) is the only SQLite-backed
TypeScript durable engine found and is far too immature to carry a durability guarantee;
`@aws/durable-execution-sdk-js@2.2.0` is Lambda-only.

## Decision

**Build DeFlow's durable engine. Do not adopt DBOS, Temporal, Restate, Inngest or any of their
peers.** Borrow the patterns — step memoisation, idempotency keys derived from
`(workflow_id, step_id, attempt)`, write-ahead effect records — and own the code.

**Estimated size: ~800–1500 LOC of core**, excluding effect adapters. That covers the ledger, the
reducer, the effect journal and the scheduler. **This is an estimate, not a measurement** — treat it
as a scope signal, not a commitment. It is a small enough number that the argument holds even if it
is off by a factor of two, and the components in question are ones DeFlow must own regardless.

Even if TypeScript SQLite support lands in DBOS in 2027, it would still be the wrong shape here:

- Its model is decorator / `DBOS.runStep` imperative workflows with replay-ish semantics, which
  fights the data-driven DAG in [ADR 0005](./0005-plan-as-data-not-code.md).
- It owns a `dbos` schema, runs its own recovery executor, and drives a Postgres `LISTEN`/`NOTIFY`
  notification loop.
- It would put a second scheduler and a second notion of "step" next to DeFlow's, in the one
  subsystem where a second source of truth is least acceptable (NF10, AR-4).

The mechanism this decision commits us to writing is documented in
[05-durable-execution.md](../05-durable-execution.md).

## Consequences

### Positive

- **Zero new infrastructure, genuinely.** One SQLite file, no server, no Postgres, no Docker.
  NF6 (`npx DeFlow up`, no database server) is preserved as stated rather than approximately.
- The engine is shaped around DeFlow's actual effects — agent invocation, shell command, git
  operation, file write — each of which needs a different `reconcile()` story. A generic engine
  would give us a generic idempotency key and leave the four hard cases to us anyway.
- Pure `reduce()` and `decide()` make the whole scheduler testable with no I/O, which is what makes
  the durability properties provable in CI rather than hoped for.
- No dependency in the critical path that could change its persistence model under us.

### Negative

- We own every durability bug. No upstream fixes, no community battle-testing. Mitigated by the
  crash-fuzz suite: spawn DeFlowd as a child, `kill -9` at a random point in a scripted run,
  restart, and assert no effect executed twice without its key being reused, that reduced state
  matches the pre-crash projection, and that `PRAGMA integrity_check` is `ok`.
- ~800–1500 LOC of the most subtle code in the project, written by one person.
- No operator dashboard for free — though the durable-execution engines' dashboards are operator
  views, and DeFlow's whole visualisation surface (F10.1–F10.9) is the thing they cannot provide.

### Neutral

- The patterns are not novel and are well documented across the category; this is not research, it
  is careful implementation of a known design.

## Alternatives considered

- **DBOS Transact for TypeScript.** Rejected on the source-level finding above: `pg`-only, with a
  dead `sqlite3?` placeholder. Would require Postgres, violating NF6.
- **DBOS on Postgres anyway.** Rejected: adding a database server to a local-first laptop tool is a
  direct NF6 violation and would make `npx DeFlow up` a multi-step install.
- **Temporal / Restate.** Rejected in the PRD (§4.4) and again here: server-dependent, replay
  constraints, and reconsidered only if execution moves server-side — which AR-1 argues against.
- **Inngest.** Rejected: SaaS-oriented, and its step-hash machinery exists to solve the code-changed-
  mid-run problem that ADR 0005 removes.
- **`reflow-ts@0.5.0`.** Rejected: four total releases. Too immature for a durability guarantee.

## Revisit when

**DeFlow needs multi-machine orchestration** — runs distributed across CI workers or a team's
machines rather than executing entirely on one laptop. That is the scenario where a real durable
execution engine earns its dependency, and at that point DBOS-on-Postgres or Restate should be
re-evaluated properly.

Note that trigger cannot fire on its own: distributing execution means a machine other than the
user's spawns the vendor binary, which requires reopening
[ADR 0003](./0003-never-hold-provider-credentials.md) first.

Secondary, checkable trigger: **DBOS Transact for TypeScript ships a real SQLite system database**
(not a placeholder field — check that `src/system_database.ts` no longer hard-types `pg.Pool`).
Even then, re-read the "wrong shape" argument above before adopting; a SQLite backend removes the
infrastructure objection but not the architectural one.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
