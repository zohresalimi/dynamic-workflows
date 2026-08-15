# ADR 0007: `better-sqlite3` over `node:sqlite`, behind a thin `Db` port

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

The ledger is the durability guarantee ([ADR 0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md)),
so its driver is one of the few genuinely load-bearing dependency choices. **The research pass
produced two contradictory recommendations, and resolving the conflict is the substance of this
record.**

- **Area 2 (tooling) recommended `node:sqlite`.** Its entire rationale was install ergonomics: zero
  native compilation means `npx deflowai up` never runs node-gyp, which is the number-one install
  failure class for a solo-maintained tool (NF6).
- **Area 1 (durability) recommended `better-sqlite3@13.0.2`** and **disproved area 2's premise by
  measurement**.

The premise is what broke. **Verified 2026-08-02**, by installing and unpacking the package:

- better-sqlite3 **v13.0.0 was the N-API migration**. The npm tarball (11.4 MB) now ships prebuilt
  binaries directly — eight files, `prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`.
  `package.json` has `gypfile: false` and **no install script**.
- `npm i better-sqlite3@13.0.2` completed in **1 second**, 27 MB `node_modules`, zero compilation,
  zero node-gyp, zero prebuild-install network fetch.
- N-API means one binary per platform works across all Node versions. **No rebuild per Node upgrade.**

So the historical "native module install pain" objection no longer applies, and with it area 2's
only argument.

The case _against_ `node:sqlite` is separately decisive for software distributed by `npx`:

- It is still **Stability 1.2 (Release Candidate)** on Node 24 and Node 26 — not Stable (2).
- **Its API changed inside the 24.x LTS line.** `createTagStore` in 24.9.0, `setAuthorizer` in
  24.10.0, `defensive` in 24.12/24.14, the `limits` property in 24.15.0, `serialize`/`deserialize`
  in 24.16.0. **Verified 2026-08-02** on Node 22.22.2 that `setAuthorizer`, `createTagStore` and
  `serialize` are all `undefined` there.
- It prints `ExperimentalWarning: SQLite is an experimental feature` on import (verified).
  Suppressible with `NODE_NO_WARNINGS=1`, but globally suppressing warnings in a daemon is a bad
  trade.

For a tool that runs on whatever Node the user happens to have, **behaviour varying with the user's
patch level is disqualifying.**

Performance is not a differentiator: `node:sqlite` measured **5–15% faster** in the benchmark. That
is irrelevant at these volumes and is not a reason to choose either way.

## Decision

**Use `better-sqlite3@13.0.2` (caret-pinned, per the pin policy in
[02-tech-stack.md](../02-tech-stack.md)) with `@types/better-sqlite3@^9.6.0`, behind a ~60-line
`Db` port interface in `@DeFlow/core`, implemented in `@DeFlow/ledger`.**

```ts
export interface Stmt<R = unknown> {
  run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...p: unknown[]): R | undefined;
  all(...p: unknown[]): R[];
  iterate(...p: unknown[]): IterableIterator<R>;
}
export interface Db {
  prepare<R>(sql: string): Stmt<R>;
  exec(sql: string): void;
  close(): void;
}
```

**The port is the point.** Both drivers are synchronous with near-identical shapes, so the future
swap is a one-file change. Nothing outside `@DeFlow/ledger`'s driver module imports `better-sqlite3`
directly, and a lint rule enforces it. This is what makes the decision reversible rather than
permanent, which is the only honest posture toward a package that is one Node release away from
being the obvious choice.

A useful side effect: better-sqlite3 13.0.2 bundles **SQLite 3.53.4, pinned, with FTS5 compiled in**
(**verified 2026-08-02**). So the M1 retrieval story
([ADR 0015](./0015-fts5-only-retrieval-at-m1.md)) works out of the box and does not drift with the
user's Node install — which is the same stability argument applied to SQL behaviour rather than to
the JavaScript API.

Connection setup, migrations on `PRAGMA user_version`, and the measured schema decisions are in
[05-durable-execution.md](../05-durable-execution.md).

## Consequences

### Positive

- One prebuilt native dependency that installs in a second and never rebuilds. NF6 preserved.
- SQL behaviour is pinned to SQLite 3.53.4 rather than inherited from the user's Node build.
- FTS5 is available with no extension loading, no build flag, no extra dependency.
- Tauri 2 (the M3 shell) sidecars a normal Node process, so the same prebuilds apply.

### Negative

- A 27 MB native dependency in `node_modules`, versus zero for `node:sqlite`.
- Types are not bundled (`types` field absent). `@types/better-sqlite3@9.6.0` is actively maintained
  but its major lags the package major — verify it types `db.explain()` and `stmt.toString()`, both
  new in v13. **Unverified.**
- If you ever consider Electron rather than Tauri: v13 prebuilds for Electron v39+ were reported
  broken, and Electron v43+ on Linux needs glibc ≥ 2.41.

### Neutral

- We give up a 5–15% throughput advantage that does not matter at DeFlow's write volumes.

## Alternatives considered

- **`node:sqlite`.** The area-2 recommendation. Rejected on RC status and intra-LTS API drift, as
  above. It is the presumptive future winner; hence the port and the explicit revisit trigger.
- **`@libsql/client@0.17.4`.** Rejected: async API, and it drags in the `libsql` native module plus
  `@libsql/hrana-client` network machinery for a Turso sync story DeFlow does not need.
- **`@tursodatabase/database@0.7.2`** (the Rust rewrite, ex-Limbo). Rejected: 0.x with six releases
  in eight days. Far too volatile for the component that holds the durability guarantee.
- **`bun:sqlite`.** Rejected: requires the Bun runtime, incompatible with `npx deflowai up` on Node,
  and AR-1 already forces us onto the user's Node install.
- **`node-sqlite3-wasm@0.8.60`.** Documented as a pure-JS escape hatch for exotic platforms only.
  WAL over a WASM VFS is not something to bet durability on.

## Revisit when

**Both** conditions hold — not either:

1. **`node:sqlite` reaches Stability 2 (Stable)**, and
2. **Node 26 is DeFlow's minimum supported version** (i.e. Node 24 has left Active LTS and we have
   dropped it from `engines`).

At that point the intra-LTS API drift argument expires, the `Db` port makes the switch a one-file
change, and we drop a 27 MB native dependency. Check at each Node LTS transition; Node 24's Active
LTS window ends 2026-10-20.

Independent secondary trigger: if better-sqlite3 ever reintroduces an install script or drops a
platform from `prebuilds/`, that removes the reason it won and forces this record open early.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
