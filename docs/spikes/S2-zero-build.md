# S2 — zero-build dev loop through pnpm workspace symlinks

> Spike for [KAR-00.2](../delivery/epics/EPIC-00-foundation-spikes.md#kar-002--spike-zero-build-dev-loop-through-pnpm-workspace-symlinks).
> Scenarios: [EPIC-00-S1, EPIC-00-S3](../delivery/flows/EPIC-00-foundation-spikes-flows.md)
> (EPIC-00-S2 is **not applicable** — see [below](#epic-00-s2-is-not-applicable-and-that-is-a-result-not-an-omission)).
> Artefact: [`spikes/s2-zero-build/`](../../spikes/s2-zero-build/), executed by
> [`test/integration/spike-s2-zero-build.test.ts`](../../test/integration/spike-s2-zero-build.test.ts).

**Date:** 2026-08-04. **Machines:** macOS (darwin/arm64), pnpm 11.13.0/11.18.0.

## The question

Does `node` type-strip a `.ts` file that is resolved through a pnpm workspace symlink inside
`node_modules`? Node refuses to type-strip `.ts` files resolved inside `node_modules` in general —
but pnpm workspace links are symlinks, and Node normally resolves the realpath first, which should
make the source-linking trick work. That chain of reasoning was never executed before this spike
(A2-1, graded High). It is the one load-bearing assumption behind
[03-local-development.md](../03-local-development.md), and it is why this spike runs before every
other one in EPIC-00.

## Method

A throwaway pnpm workspace at `spikes/s2-zero-build/` with two packages, wired exactly as
`packages/daemon` → `packages/core` will be:

- `b` declares `"exports": { ".": "./src/index.ts" }` plus the `publishConfig` exports-override
  from [16-repo-layout.md §3](../16-repo-layout.md).
- `a` depends on `"@spike/b": "workspace:*"`.
- `pnpm install` links `@spike/b` as a symlink inside `a/node_modules/@spike/`.

## Measurement

| # | Check | Node 24 (v24.18.0) | Node 26 (v26.6.0) |
| - | ----- | ------------------- | ------------------- |
| 1 | `node a/src/main.ts` | exit 0, stdout `hello from @spike/b` | exit 0, stdout `hello from @spike/b` |
| 2 | No build artefact at `b/dist/` before or after | confirmed absent | confirmed absent |
| 3 | `pnpm exec vitest run` in `a` (imports `@spike/b`) | 1 test passed | not re-run per major; resolution is compile/bundle-time, not runtime-version-dependent |
| 4 | `pnpm exec tsc -b` over the two-project graph | exit 0 | n/a (typecheck is version-independent) |
| 5 | `pnpm exec vite build` against `a/scratch-entry.ts` | exit 0, `dist/scratch.js` written | n/a |
| 6 | `enum Status2 { Ok, Fail }` appended to `b/src/index.ts`, then `node a/src/main.ts` | **non-zero exit**, stderr: `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` | same error, same code |
| 7 | `namespace X { export const y = 1; }` appended | non-zero exit, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript namespace declaration is not supported in strip-only mode` | same |
| 8 | `constructor(private readonly db: string) {}` appended | non-zero exit, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode` | same |
| 9 | `pnpm pack` on `b`, tarball's `package.json` inspected | `exports` = `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` — not `./src/index.ts` | n/a |
| 10 | Same two packages, but `@spike/b` materialised as a **real directory** under `a/node_modules/@spike/` instead of a symlink, then `node a/src/main.ts` | **non-zero exit**, stderr: `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "…/a/node_modules/@spike/b/src/index.ts"` | same error, same code |

Every row is asserted by `test/integration/spike-s2-zero-build.test.ts`, run against real `node`
binaries for both majors (resolved via `nvm`, never hand-waved).

### Row 10: why the happy path is a fact about symlinks, not about Node being lenient

Row 1 passing could mean either "Node no longer refuses type stripping under `node_modules`" or
"Node refuses it, and the pnpm symlink's realpath is what puts the file outside `node_modules`
before the rule is applied". Those have very different consequences — the first would survive a
`--node-linker=hoisted` install or a copied dependency, the second would not — so row 10 runs the
same two packages with the single variable flipped: `a/node_modules/@spike/b` as a real directory
rather than a symlink. It fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on both majors.
The refusal is real; the symlink is what avoids it. That makes pnpm's default symlinked node-linker
load-bearing for the dev loop, and it is why the spike test also asserts that
`a/node_modules/@spike/b` is an `lstat`-symlink whose realpath sits outside any `node_modules`
segment.

### A refinement `--experimental-transform-types` surfaced

Row 6–8's rejection is **not** specific to Node 26. Node 24.18.0 rejects the same syntax by
default too — plain type-stripping ("strip-only mode") never supported `enum`, `namespace` or
parameter properties on either major. The difference D4 actually rests on is the escape hatch:
`node --experimental-transform-types` on Node 24.18.0 *does* transform the `enum` and run
successfully (with an `ExperimentalWarning`), while the same flag on Node 26.6.0 is rejected
outright — `node: bad option: --experimental-transform-types` — because it was removed in
Node 26.0.0. So the practical claim for D4 is sharper than "Node rejects these forms": it is
*"there is no escape hatch left as of Node 26"*, which is what makes the ban permanent rather than
a style preference enforced only by `tsc`.

### The replacement idiom

`b/src/index.ts` also exports `Status` as `{ Ok: 'ok', Fail: 'fail' } as const` with a derived
`type StatusValue = (typeof Status)[keyof typeof Status]` — D4's replacement for `enum`. Every
passing run of `node a/src/main.ts` above already proves this parses and executes cleanly on both
majors; there is no failure case to record for it.

## Decision

**adopt `node --watch`.** The realpath-resolution assumption holds on both Node 24 and Node 26,
for `node`, `vitest`, `tsc -b` and `vite build` alike — the `tsx@4.23.4` fallback described in
[03-local-development.md §5](../03-local-development.md) is **not** needed. `docs/03-local-development.md`
and [KAR-01.3](../delivery/epics/EPIC-01-dev-environment.md) already describe and implement
`node --watch --watch-path=packages packages/daemon/src/main.ts` as the dev loop, and this spike
confirms that description rests on an executed fact rather than a plausible chain of reasoning.
KAR-01.3's acceptance criteria 2 and 5 (which name `node --watch` and the crash-resume behaviour)
are **unchanged** — the fallback branch of AC6, and the "if it fails" section of KAR-00.2, do not
apply here.

### EPIC-00-S2 is **not applicable**, and that is a result, not an omission

[EPIC-00-S2](../delivery/flows/EPIC-00-foundation-spikes-flows.md#epic-00-s2--type-stripping-is-refused-inside-node_modules-and-the-tsx-fallback-is-adopted)
was written as the failure branch: *given* `node a/src/main.ts` fails with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` through the workspace link, *then* `tsx@4.23.4` is
adopted, KAR-01.3 acceptance criteria 2 and 5 change, `node --watch`'s free crash-resume test is
lost, and KAR-01.6's pre-push budget is re-measured. **Its precondition did not hold** (row 1), so
none of its Thens are automated — there is nothing to adopt, rename or re-measure. `tsx@4.23.4`
appears nowhere in this repo's dependencies, and it should not be added to satisfy a scenario whose
Given never happened.

What *is* automated in its place is the counterfactual (row 10): the refusal S2 predicted is real,
reproducible on both majors, and is avoided specifically by the symlink. That is the strongest
statement available once the happy path wins — it proves the fallback was not needed rather than
merely not reached. Should the layout ever change (a hoisted node-linker, a vendored copy, a
published-then-reinstalled `@DeFlow/*`), row 10's test is the one that will go red first, and S2's
Then-clauses become live again at that point.

`erasableSyntaxOnly: true` (D4) stays permanent: `enum`, `namespace` declarations and parameter
properties all fail at runtime with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, confirmed on both majors,
and Node 26.0.0 removed the one flag (`--experimental-transform-types`) that could ever have
turned that runtime rejection into a transform. There is no escape hatch left to reach for later.
