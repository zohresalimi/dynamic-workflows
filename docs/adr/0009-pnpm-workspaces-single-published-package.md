# ADR 0009: pnpm workspaces with exactly one published package

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

DeFlow is eight packages and an estimated ~15k LOC, built by one person. It has a clean
internal boundary structure that is worth enforcing — a pure core with zero I/O, a ledger, an
adapter layer, a daemon, a CLI, a web app, a testkit — but it has exactly one artefact anyone
outside the repo will ever install: `npx deflow up` (NF6).

Those two facts pull in opposite directions if you are not careful. Monorepo tooling is designed
around the assumption that packages are published independently, which brings version coordination,
changelogs, release orchestration and a task runner's cache graph. None of that is load-bearing when
the answer to "what do users install" is a single name.

The dev-loop requirement adds a third pressure: `node packages/daemon/src/main.ts` must just work,
across package boundaries, with no watch-build chain and no stale `dist`. That is achievable, but
only with a package manager whose linking model supports it.

## Decision

**pnpm 11 workspaces with a `catalog:` block. Exactly one published package (`deflow`). No task
runner at M1.**

- Root `package.json` sets `"packageManager": "pnpm@11.18.0"`, `"type": "module"`,
  `"private": true`, `"engines": { "node": ">=24" }`.
- `pnpm-workspace.yaml` lists `packages/*` and `e2e`, plus a **`catalog:`** block pinning shared
  versions (typescript, vitest, vite, zod, `@types/node`) in **one** place. Packages consume them as
  `"typescript": "catalog:"`, so no package can drift.
- **`@DeFlow/*` are all `private: true`** — `core`, `ledger`, `adapters`, `daemon`, `web`,
  `testkit`, `mock-agent`. Only `packages/cli` publishes, as `deflow`, and tsdown inlines the
  workspace packages into its bundle with `noExternal: [/^@DeFlow\//]`.
- **Cross-package dev resolution uses pnpm's `publishConfig` override**: `exports` points at
  `./src/index.ts` in the workspace and at `./dist/index.js` in the published tarball. Node, Vite,
  Vitest and `tsc` then all see live TypeScript source across packages — no watch-build chain, no
  stale `dist`, and goto-definition lands on real code. This trick is the single biggest DX win in
  the repo and it works cleanly on pnpm's symlinked store in a way npm's hoisting does not.

**No Nx, no Turborepo, no moon at M1.** `pnpm -r run build` and `pnpm --filter @DeFlow/daemon test`
are sufficient for eight packages. A task runner solves cache and graph problems that do not exist
at this size: Nx 23 wants plugins, a daemon and generators; moon 2.4 introduces a whole toolchain
concept. Both are negative value for one developer today.

**No changesets.** With one published package the entire release process is
`npm version patch && pnpm publish`. `@changesets/cli@2.31.1` is alive and fine — it just solves
multi-package coordination we deliberately do not have.

Layout, package boundaries and the dependency direction rules are in
[16-repo-layout.md](../16-repo-layout.md); the commands are in
[03-local-development.md](../03-local-development.md).

## Consequences

### Positive

- **The multi-package versioning problem is deleted, not managed.** No changesets, no release
  orchestration, no inter-package version matrix.
- The published tarball has exactly one native runtime dependency; everything `@DeFlow/*` is inlined.
- Catalogs mean a TypeScript or Vitest bump is a one-line change, which matters because TypeScript
  is pinned hard ([ADR 0010](./0010-typescript-6-pin-esm-only-erasable-syntax.md)).
- Package boundaries still do their real job — `@DeFlow/core` is pure and importable by the web app,
  the daemon cannot be imported by core — without paying for independent publishing.

### Negative

- Nobody else can depend on `@DeFlow/core`. If a colleague ever wants to build on the domain model,
  that requires publishing it, which reintroduces versioning. Accepted: that is an M3+ problem and
  the trigger is written below.
- `pnpm -r typecheck` runs everything every time, with no cache. Fine at eight packages; the
  threshold for changing that is stated below.
- Contributors must have pnpm 11. **Do not use `corepack enable`** — Corepack was removed from Node
  25+ distributions (TSC vote, March 2025) and is only bundled through Node 24. CI uses
  `pnpm/action-setup@v6`; `packageManager` is still read as a version assertion.

### Neutral

- Not Bun. `node-pty` compatibility is unverified there, and AR-1 already forces us onto the user's
  Node install for `npx deflow up`.

## Alternatives considered

- **npm workspaces.** Rejected: no catalogs, slower installs, and hoisting is unpredictable enough
  that the `publishConfig` source-linking trick does not work cleanly.
- **Turborepo 2.10.8 from the start.** Rejected for now, not forever — it is a drop-in `turbo.json`
  with `dependsOn`/`outputs` and no code changes, so adopting it later costs about ten lines. There
  is no reason to pay for it before it is needed.
- **Nx 23.1.1 / moon 2.4.6.** Rejected: substantially more ceremony (plugins, daemons, generators,
  a toolchain concept) for an eight-package repo with one developer.
- **A single flat package with directories instead of workspaces.** Rejected: the boundary between
  the pure core and the I/O shell is what makes `reduce()`/`decide()` testable with no I/O
  ([ADR 0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md)), and a directory
  convention does not enforce it.
- **Publishing `@DeFlow/*` alongside `deflow`.** Rejected: buys nothing today and costs a release
  process. If it ever becomes necessary, note that **pnpm 11.13+ has native release management**
  (`pnpm change`, `pnpm version -r`, `pnpm lane`, configured under `versioning:` in
  `pnpm-workspace.yaml`) — strictly less machinery than changesets and one fewer dependency.
  **Unverified**: check the exact command surface against pnpm's docs before adopting.

## Revisit when

Two independent, checkable triggers:

1. **`pnpm -r typecheck` exceeds about 20 seconds locally.** That is the point at which a build
   cache starts paying for itself. Add `turbo@2.10.8` — a `turbo.json` with `dependsOn` and
   `outputs`, no code changes. Do not reach for Nx or moon at that point either; the problem being
   solved is caching, not orchestration.
2. **Someone outside this repo needs to depend on a `@DeFlow/*` package.** Then, and only then,
   publish it and adopt a release tool — evaluating pnpm's native release management before
   changesets.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
