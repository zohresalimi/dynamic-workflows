# ADR 0010: Pin TypeScript 6, ESM-only, erasable syntax only

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

**TypeScript 7 is out, it is 8–12× faster at type-checking, and adopting it would break the build.**
That inversion of the obvious "use the newest" instinct is the highest-impact tooling fact in the
project.

**Verified 2026-08-02** against the npm registry and primary sources:

- `typescript@7.0.2` is stable (GA 8 July 2026), Go-native. Its npm package ships **only `bin/tsc`**
  — a per-platform Go binary via optionalDependencies. **No `tsserver`, no public compiler API.**
- `vue-tsc@3.3.9` / Volar embed the TypeScript compiler API, so they cannot run on TS 7.
- `typescript-eslint@8.65.0` declares `peerDependencies: typescript ">=4.8.4 <6.1.0"` — verbatim.
  The 8.65.1 canary carries the identical range, and the TS 7 support request
  (typescript-eslint#10940) was **closed as not planned**, because TS 7.0 ships no stable
  programmatic API.
- Microsoft has indicated the stable programmatic API lands in TS 7.1, around October 2026.
  **Unverified** date.

So TS 7 would force a split-version workspace — Node packages on 7, `packages/web` on 6 — with two
lint configs and two typecheck paths. Real ceremony for one developer.

Separately, Node's type-stripping story has closed a door. Type stripping is **stable** (Stability 2
as of v24.12.0 / v25.2.0, enabled by default since v23.6.0 and v22.18.0) — but
`--experimental-transform-types` was **removed in Node 26.0.0**. There is no longer any escape hatch
for syntax that requires a transform.

## Decision

**Pin `typescript@6.0.3` for the whole workspace via the pnpm catalog. ESM-only. `erasableSyntaxOnly`
on, permanently.**

**The pin is workspace-wide and exact**, through the `catalog:` block in `pnpm-workspace.yaml`
([ADR 0009](./0009-pnpm-workspaces-single-published-package.md)), so `vue-tsc` and the linter cannot
drift out from under the compiler.

**ESM-only.** `"type": "module"` in every `package.json`. No dual CJS build, ever. Node 24 is the
floor (Active LTS to 2026-10-20); develop and CI on 24 and 26. Node 22 is maintenance-only and is
deliberately _not_ listed in `engines` — if you list it, you must test it.

**Banned syntax, and this is permanent rather than a stylistic preference.** With
`--experimental-transform-types` gone from Node 26, `erasableSyntaxOnly: true` is the only
configuration whose output Node can execute directly. Banned:

| Banned                                       | Use instead                                 |
| -------------------------------------------- | ------------------------------------------- |
| `enum`                                       | `const X = { ... } as const` + a union type |
| runtime `namespace`                          | a module                                    |
| constructor parameter properties             | assign fields explicitly                    |
| decorators                                   | plain higher-order functions                |
| `import` aliases (`import X = require(...)`) | ESM `import`                                |

Ban them now, not after 5k lines are written.

The `tsconfig.base.json` settings that carry weight: `module`/`moduleResolution: "nodenext"`,
`verbatimModuleSyntax: true` (forces `import type`, required for type-stripping correctness),
`isolatedModules`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, `noEmit: true`
(tsc is a checker; tsdown emits), `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`.

**Relative imports carry explicit `.ts` extensions** (`import { applyPatch } from './patch.ts'`),
rewritten to `.js` on emit — so `node packages/daemon/src/main.ts` runs the source directly with
zero tooling. **Do not use `paths` aliases**: `rewriteRelativeImportExtensions` does not rewrite
through them (microsoft/TypeScript#61991). Cross-package imports use workspace package names.

Full config, the tsdown build and the dev runner are in
[02-tech-stack.md](../02-tech-stack.md) and [03-local-development.md](../03-local-development.md).

## Consequences

### Positive

- `vue-tsc` runs, and type-aware linting has a working path.
- `node file.ts` works with no build step in development, which is the stated first-class dev-loop
  requirement. Every save restarts the daemon and therefore continuously exercises F4.2.
- Erasable-only syntax means the source Node executes is the source you wrote — no transform, no
  sourcemap gap when debugging a 3-hour run.
- One toolchain, one lint config, one typecheck path.

### Negative

- We forgo an 8–12× typecheck speedup for some months. At eight packages that is seconds, not
  minutes, so the trade is comfortable today and will get less comfortable as the repo grows.
- `enum` is genuinely convenient and its absence shows up constantly in a codebase full of
  discriminated unions. `as const` objects plus union types are the standard replacement and are
  arguably better for a system whose event kinds must be serialisable.
- No decorators means no decorator-based DI or ORM, which rules out a family of libraries. Not a
  loss here — DeFlow has no ORM and no DI container.

### Neutral

- The linter choice inherits this constraint. `oxlint` with `oxlint-tsgolint` is currently the only
  type-aware JS/TS linter with a TS 7 path (type-aware mode went stable in **oxlint 1.75.0**; 1.76.0
  is merely the current latest). ESLint plus `eslint-plugin-vue` is deferred, and note it would
  transitively re-import the `typescript <6.1.0` constraint through
  `@typescript-eslint/parser`.
- Biome is the formatter. Its `.vue` support is **off by default**, gated behind
  `"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }` in
  `biome.json` — without that flag `biome check` silently no-ops on `.vue` files.

## Alternatives considered

- **Adopt `typescript@7.0.2` everywhere.** Rejected: breaks `vue-tsc` and every type-aware lint rule.
- **Split-version workspace (TS 7 for Node packages, TS 6 for `packages/web`).** Rejected for now:
  two toolchains, two lint configs, two typecheck paths, for a speedup measured in seconds at this
  size. It is the fallback if typechecking becomes painful before 7.1 lands.
- **Dual CJS + ESM build.** Rejected outright: DeFlow is an application, not a library. There is no
  consumer to be compatible with, and dual builds are the largest single source of packaging bugs.
- **Allow enums and use a bundler transform in dev.** Rejected: `--experimental-transform-types` was
  removed in Node 26, so this would permanently require a build step in development and give up the
  `node file.ts` property.
- **`tsx` as the dev runner instead of `node --watch`.** Kept as a documented escape hatch — if
  Node's "no TypeScript inside `node_modules`" rule bites pnpm's symlinks, `tsx watch` has no such
  restriction — but not the default, because `node --watch` runs the exact production code path.

## Revisit when

**TypeScript 7.1 ships a stable programmatic compiler API, `vue-tsc` supports it, and
`typescript-eslint` (or whichever type-aware linter we are on) widens its peer range past 6.1.0.**
All three, checkable individually:

- `typescript@7.1.x` release notes announce the stable API;
- `vue-tsc`'s peer range accepts `^7`;
- `typescript-eslint`'s `peerDependencies.typescript` no longer reads `<6.1.0`.

When all three hold, flip the entire workspace at once via the catalog — one line — rather than
migrating package by package. Expected around October 2026, **unverified**.

The ESM-only and `erasableSyntaxOnly` halves of this decision are **not** subject to that trigger.
With `--experimental-transform-types` removed in Node 26 they are permanent, and a superseding ADR
would need to explain what changed in Node, not in TypeScript.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
