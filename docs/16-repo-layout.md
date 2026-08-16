# Repo layout

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

## 1. Shape

One pnpm 11 workspace, nine packages plus an `e2e` package, exactly **one** of which is published to npm (D5). No Nx, no Turborepo, no moon at M1 — `pnpm -r run build` and `pnpm --filter @DeFlow/daemon test` are enough for ten packages and roughly 15k lines. Add `turbo@2.10.8` only when `pnpm -r typecheck` exceeds about 20 seconds locally; it is a drop-in `turbo.json` with `dependsOn`/`outputs` and no code changes.

```
DeFlow/
  package.json               private, "type": "module", packageManager, engines >= 24
  pnpm-workspace.yaml        packages globs + the catalog: block
  pnpm-lock.yaml
  tsconfig.base.json         the compilerOptions every package extends
  tsconfig.json              solution file, "references" only
  biome.json                 formatter for everything; linter disabled globally
  .oxlintrc.json             the type-aware linter for the Node packages
  lefthook.yml               pre-commit (format + fast lint), pre-push (typecheck + unit)
  vitest.config.ts           single root config with test.projects
  .node-version              Node major, unambiguous for every tool and human
  .github/workflows/ci.yml   check | test matrix | browser-e2e
  docs/                      this document set
  packages/
    core/        @DeFlow/core        pure domain + engine logic, zero I/O
    ledger/      @DeFlow/ledger      SQLite event store, migrations, blob store
    adapters/    @DeFlow/adapters    ACP client, CLI shims, capability probes
    gates/       @DeFlow/gates       gate definitions, findings parsers, the deterministic runner
    daemon/      @DeFlow/daemon      DeFlowd: HTTP+SSE, orchestrator, worktrees, MCP host
    cli/         DeFlow              THE published package: bins + inlined daemon + built UI
    web/         @DeFlow/web         Vue 3 + Vite SPA
    testkit/     @DeFlow/testkit     fake binaries, git fixtures, TestClock, crash harness
    mock-agent/  @DeFlow/mock-agent  deterministic ACP agent binary (D17)
  e2e/                               cross-process specs; its own package
```

### Package responsibilities and dependencies

| Package              | Purpose                                                                                                                                                                                                  | Depends on (workspace)                               | Runtime deps of note                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@DeFlow/core`       | `TaskSpec`, `PlanGraph`, `PlanPatch`, `Fact`, `ContextPacket`, the `Event` union, `reduce`, `decide`, patch policy, permission ladder, `Clock`/`Db` port _interfaces_                                    | **nothing**                                          | `zod` only                                                                          |
| `@DeFlow/ledger`     | Event store, `effect` journal, `plan`/`run`/`node_wake` tables, `PRAGMA user_version` migrations, content-addressed blob store, SSE tail queries                                                         | `@DeFlow/core`                                       | `better-sqlite3@13.0.2`                                                             |
| `@DeFlow/adapters`   | ACP client, per-vendor CLI exec shims, capability probing and persistence, golden-recording tee                                                                                                          | `@DeFlow/core`                                       | `@agentclientprotocol/sdk@1.3.0`                                                    |
| `@DeFlow/gates`      | Gate definitions (`.DeFlow/gates/*.yaml`), the seven findings parsers, the severity floor, the deterministic gate runner and the milestone rule. The ladder itself lives in `@DeFlow/core`, because `decide()` is what withholds a tier                                                            | `@DeFlow/core`, `@DeFlow/ledger`, `@DeFlow/adapters` | `yaml`, `zod`                                                                       |
| `@DeFlow/daemon`     | DeFlowd itself: hono HTTP+SSE, orchestrator tick loop, Effect Runner, Planner, Context Builder, Blackboard, Workspace Manager, MCP host                                                     | `@DeFlow/core`, `@DeFlow/ledger`, `@DeFlow/adapters`, `@DeFlow/gates` | `hono`, `@modelcontextprotocol/sdk`, `execa`, `pino`, `@lydell/node-pty` (optional) |
| `deflow`             | The npm package. `deflow init/up/run/doctor`, plus the `deflow-mcp` and `deflow-mock-agent` bins. Bundles the daemon and ships the built UI as files                                                     | `@DeFlow/daemon`, `@DeFlow/mock-agent`               | `@lydell/node-pty` (external), everything else inlined                              |
| `@DeFlow/web`        | Vue 3 SPA, ledger-projection Pinia store, the nine P0 views, and the one `hc<ApiType>` client module `packages/cli` imports too                                                                          | `@DeFlow/core` (**types only**), `@DeFlow/daemon` (**types only**, dev) | `vue`, `pinia`, `@vue-flow/core`, `d3`, `xterm.js`, `shiki`                         |
| `@DeFlow/testkit`    | Fake agent binaries, hermetic git fixtures, tmpdir fixtures, `TestClock`, `FakeEffectRunner`, crash-fuzz harness                                                                                         | `@DeFlow/core`                                       | dev-only                                                                            |
| `@DeFlow/mock-agent` | A real ACP **agent** binary, seeded and deterministic: scripted chunks, permission requests, fs/terminal callbacks, hang, mid-turn crash, malformed frames, 10 MB line, configurable `agentCapabilities` | **nothing** (deliberately)                           | `@agentclientprotocol/sdk@1.3.0`                                                    |
| `e2e`                | ~5 full-stack specs that boot a real DeFlowd on an ephemeral port with fake agents on `PATH` and drive a real browser                                                                                    | `deflow`, `@DeFlow/testkit`                          | `@playwright/test`                                                                  |

`@DeFlow/mock-agent` deliberately does **not** depend on `@DeFlow/core`. If it did, a bug in the domain model could be mirrored on both sides of the wire and cancel itself out. It is an independent implementation of the _agent_ side of the same published schema, which is what makes it a useful oracle.

---

## 2. Why exactly one package is published

`packages/cli` is `"name": "deflowai"`. Every `@DeFlow/*` package is `"private": true` and is **inlined into the CLI bundle by tsdown** via `deps.alwaysBundle: [/^@DeFlow\//]`.

```ts
// packages/cli/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts", "src/mcp.ts", "src/mock-agent.ts", "src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
  // NOT clean: true — the UI is copied into dist/ui/ by the step before this
  // one, and cleaning the directory would delete it.
  clean: ["*.mjs", "*.d.mts", "*.map"],
  deps: {
    alwaysBundle: [/^@DeFlow\//], // inline every workspace package
    neverBundle: ["better-sqlite3", "@lydell/node-pty", "vite"],
    onlyImport: ["better-sqlite3", "@lydell/node-pty", "vite"], // fail the build on any other
  },
});
```

Three notes on that config, each of which cost a build to find (KAR-18.5):

- **`noExternal` / `external` are the pre-0.22 spelling.** tsdown@0.22.14 still accepts them, warns on
  every build, and maps them onto `deps.alwaysBundle` / `deps.neverBundle`. Same semantics, current
  names. `deps.onlyImport` has no old equivalent and is worth having: it turns "no unexpected runtime
  import survived" from a spec that runs later into a build that fails now, naming the chunk.
- **`vite` is on both lists.** `startHttp`'s dev branch reaches for it through `await import('vite')`
  under `DeFlow_DEV === '1'`, and a bundler follows `import()` like any other edge: without the entry
  it inlines a dev server, its CJS interop and `tsx/cjs/api` behind `bin.mjs`. External leaves it as an
  unreachable specifier — no bytes, no dependency.
- **`clean` names files, not the directory.** The UI arrives in `dist/ui/` between the two build
  steps; `clean: true` deletes it and the symptom is a daemon that starts and serves a blank page.

This deletes the entire multi-package versioning problem. There are no changesets, no release orchestration, no inter-package semver ranges to keep honest: the release is `npm version patch && pnpm release` — one script rather than a remembered command, for the reason in [03-local-development.md §10](./03-local-development.md). `@changesets/cli@2.31.1` is alive and fine, but it solves coordination you deliberately do not have. (pnpm 11.13+ also ships native release management — `pnpm change`, `pnpm version -r`, `pnpm lane`, configured under a `versioning:` key — which would be the thing to reach for if `@DeFlow/*` ever do get published separately. **Unverified**: confirm the exact command surface against pnpm's docs before adopting.)

D17 calls `@DeFlow/mock-agent` a first-class shipped package. "Shipped" means it ships **inside the `deflow` tarball as a second bin** (`deflow-mock-agent`), not that it is published separately. Users need it for `deflow doctor`, offline demos and reproducing bug reports; that does not require its own npm entry.

**Bundler: `tsdown@0.22.14`** (Rolldown-based, from the Vite/VoidZero org; peer-supports TypeScript ^5/^6/^7; engines `^22.18 || >=24.11`). Pin it exactly — it is still 0.x. `tsup@8.5.1` last published 2025-11-12 and its maintainers now direct new projects to tsdown; treat it as end-of-life. Plain `tsc` cannot inline `@DeFlow/*` into one file, which is the whole point.

**Exactly two dependencies** survive into the tarball, and both are native for the same reason: each locates a platform binary from its own module path at runtime, so inlining it points that lookup at a directory that is not in the package. Everything else — `hono`, `pino`, `execa`, `zod`, `ajv`, the ACP and MCP SDKs, `gpt-tokenizer`, `yaml`, `rfc6902` and every `@DeFlow/*` — is inlined (**verified 2026-08-11** against the real build; `deps.onlyImport` above is what keeps it that way). `better-sqlite3@13.0.2` ships prebuilt N-API binaries — `prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`, `gypfile: false`, **no install script**; `npm i better-sqlite3@13.0.2` completed in **1 second** with zero compilation (**Verified 2026-08-02**). `@lydell/node-pty@1.2.0-beta.14` installed in **514 ms** with zero compilation via npm-native per-platform `optionalDependencies` — unlike `node-pty@1.1.0`, whose `scripts.install` falls back to `node-gyp rebuild` and **failed outright** in the verification environment. Make it an `optionalDependency` with a plain-`spawn` fallback so an unsupported platform degrades to no-TTY rather than failing installation.

Build order and the UI:

```
pnpm --filter @DeFlow/web build        # -> packages/web/dist
copy packages/web/dist -> packages/cli/dist/ui/
pnpm --filter deflowai build             # tsdown, @DeFlow/* inlined
```

The three steps live in `packages/cli/scripts/build.ts`, which is the whole of `pnpm build`. One
script rather than three `&&`-joined commands, because the order is the load-bearing part and a
`--out-dir` flag lets `packages/cli/test/integration/build.test.ts` run the real thing rather than a
re-implementation of it.

UI assets ship as **plain files** in the tarball, never bundled into JS, and are resolved at runtime with `fileURLToPath(new URL('./ui', import.meta.url))`. `packages/cli/package.json` needs `"files": ["dist"]`; verify the real install with `pnpm pack && cd $(mktemp -d) && npx /path/deflowai-<version>.tgz up`, plus `publint@0.3.22` and `@arethetypeswrong/cli@0.18.5` in the release script. A missing `files` entry is the classic "works locally, broken on npm" failure.

---

## 3. The `publishConfig` exports-override trick

This is the single biggest day-to-day DX win in the layout. pnpm applies `publishConfig` fields at pack time, so the workspace can resolve `@DeFlow/core` to **live TypeScript source** while the published tarball resolves it to **built JavaScript**.

```jsonc
// packages/core/package.json
{
  "name": "@DeFlow/core",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts",
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js",
      },
    },
  },
  "dependencies": {
    "zod": "catalog:",
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:",
  },
}
```

With this in place, `node`, `vite`, `vitest` and `tsc` all see live source across package boundaries. There is no watch-build chain, no stale `dist/` to debug, and go-to-definition lands on the real implementation rather than a `.d.ts`. Combined with `node --watch packages/daemon/src/main.ts`, **there is no build step in development at all** — Node's type stripping runs the source directly.

`@DeFlow/*` never actually get published, so the `publishConfig` block is belt-and-braces: it exists so that the day one of them does need publishing, or the day someone runs `pnpm pack` on it to inspect the tarball, the result is correct rather than a package pointing at `.ts` files.

Consume workspace packages with the `workspace:` protocol:

```jsonc
// packages/daemon/package.json (excerpt)
"dependencies": {
  "@DeFlow/core":     "workspace:*",
  "@DeFlow/ledger":   "workspace:*",
  "@DeFlow/adapters": "workspace:*",
  "hono":             "catalog:",
  "zod":              "catalog:"
}
```

pnpm's symlinked store plus `workspace:*` is what makes the source-linking trick work cleanly; npm workspaces hoist unpredictably and have no catalogs.

---

## 4. Dependency direction

Two rules, both mechanically checkable:

> **R1. `@DeFlow/core` depends on nothing in the workspace, and on nothing that can perform I/O.**
> **R2. Nothing depends on `@DeFlow/daemon` except `packages/cli` — and `@DeFlow/web`, for its
> types only.**

```
──► reads "depends on"

  e2e ──► DeFlow ──┬──► @DeFlow/daemon ──┬──► @DeFlow/adapters ──► @DeFlow/core
                   │                     ├──► @DeFlow/ledger   ──► @DeFlow/core
                   │                     └──────────────────────►  @DeFlow/core
                   └──► @DeFlow/mock-agent   ──► (nothing in the workspace)

  @DeFlow/web      ──► @DeFlow/core      (type-only imports)
                   └──► @DeFlow/daemon    (type-only, devDependency: ApiType and nothing else)
  DeFlow           ──► @DeFlow/web        (the one typed API client, imported by the CLI)
  @DeFlow/testkit  ──► @DeFlow/core      (devDependency of every other package)

  @DeFlow/core     ──► (nothing in the workspace; zod is its only runtime dep)
```

R1 is what makes NF9 ("deterministic core") and the functional-core/imperative-shell split of the [architecture overview](./01-architecture-overview.md#8-functional-core-imperative-shell) structural rather than aspirational. `reduce`, `decide`, the patch policy engine and the permission ladder are pure because `@DeFlow/core` has no dependency capable of impurity. Time, randomness and ids enter through ports declared in `core` and implemented in `daemon` or `testkit`.

Enforce R1 with a test rather than a convention:

```ts
// packages/core/test/purity.test.ts
import pkg from "../package.json" with { type: "json" };

it("core has no I/O-capable dependencies", () => {
  expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
});

it("core imports no node: builtins", async () => {
  const files = await glob("packages/core/src/**/*.ts", {
    ignore: "**/*.test.ts",
  });
  for (const f of files) {
    expect(await readFile(f, "utf8")).not.toMatch(/from ['"]node:/);
  }
});
```

R2 keeps the daemon a leaf. If `@DeFlow/adapters` ever needs something from `daemon`, that something belongs in `core` (if pure) or is a port that `daemon` implements and injects (if not). The one place this is tested is `e2e`, which depends on the built `deflow` package rather than on `daemon` directly — so the specs exercise the same artefact users install.

**The UI's exception, added by KAR-15.1, is narrower than it sounds.** `packages/web/src/api/client.ts` does `import type { ApiType } from "@DeFlow/daemon"` — that import *is* the client contract ([API and realtime §9](./11-api-and-realtime.md#9-the-typed-client)), and it is what makes renaming a daemon field break the UI build in the same commit rather than a view at runtime three weeks later. It sits in `devDependencies` and is erased at compile time, so no daemon code can reach the browser bundle, which is the coupling R2 exists to prevent. Two guards hold that line: `checkDaemonIsLeaf` still rejects a *runtime* dependency from the UI, and `checkWebImportsDaemonTypesOnly` fails the build the day one of those imports loses its `type` keyword. `packages/cli` then depends on `@DeFlow/web` for that same client module, so `deflow run` and the browser are two callers of one typed surface rather than two implementations of one protocol.

---

## 5. The catalog

Shared versions are pinned in **one** place so ten packages cannot drift.

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - e2e

catalog:
  typescript: 6.0.3 # D3 — NOT 7.x; see below
  zod: 4.4.3
  vitest: 4.1.10
  vite: 8.2.0
  "@types/node": ^24.0.0
  hono: 4.12.33
  "@hono/node-server": 2.0.12
  better-sqlite3: 13.0.2
  "@agentclientprotocol/sdk": 1.3.0
  "@modelcontextprotocol/sdk": 1.30.0
  execa: 10.0.1
  pino: 10.3.1
  "@biomejs/biome": 2.5.6
  oxlint: 1.76.0
  tsdown: 0.22.14
```

Consume with `"typescript": "catalog:"`. Exact pins (no caret) for `@agentclientprotocol/sdk` — it went `0.4.5 → 1.3.0` _and_ changed npm scope and GitHub org inside about ten months — and for `tsdown`, which is still 0.x.

**TypeScript is pinned to 6.0.3, not 7.x, and this is deliberate (D3).** `typescript@7.0.2` is stable and 8–12× faster, but its npm package ships **only** `bin/tsc` — no `tsserver`, no public compiler API. `vue-tsc@3.3.9`/Volar embed the compiler API and cannot run on it, and `typescript-eslint@8.65.0`'s peer range is literally `typescript >=4.8.4 <6.1.0`. Adopting TS 7 would force a split-version workspace with two lint configs and two typecheck paths. Revisit when 7.1 ships the stable programmatic API and `vue-tsc` follows, then flip everything at once.

`tsconfig.base.json` carries the settings that shape the layout:

```jsonc
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "types": ["node"],
  },
}
```

The root `tsconfig.json` is a solution file containing only `"references"` to each package, so `tsc -b` typechecks the graph in dependency order.

---

## 6. Import conventions

**Relative imports carry explicit `.ts` extensions.**

```ts
import { applyPatch } from "./patch.ts";
import type { PlanGraph } from "./plan.ts";
```

`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` make `tsc` and `tsdown` rewrite them to `.js` on emit, while `node packages/daemon/src/main.ts` runs the source directly with zero tooling.

**Do not use `paths` aliases. Ever.** `rewriteRelativeImportExtensions` **does not rewrite through them** (microsoft/TypeScript#61991), so an aliased `@/patch.ts` survives into the emitted JavaScript and the published bundle fails at runtime with a module-not-found. The failure is invisible in development, because in development the `.ts` file genuinely exists. This is the single most expensive mistake available in this layout.

**Cross-package imports use workspace package names, and only the package root.**

```ts
import { reduce, decide } from "@DeFlow/core"; // yes
import { reduce } from "@DeFlow/core/src/reduce.ts"; // no — deep import
```

Each package's `exports` map exposes `.` and nothing else. Deep imports break the `publishConfig` source→dist swap (the deep path exists in the workspace and not in the tarball) and turn every internal file into public API. `index.ts` is the package's contract; if something needs to be shared, export it there.

**Type-only imports are explicit.** `verbatimModuleSyntax: true` requires `import type`, and it is required for type-stripping correctness — Node erases types syntactically and cannot know that a value import was only ever used as a type.

**Banned syntax, permanently (D4).** `erasableSyntaxOnly: true` bans `enum`, runtime `namespace`, constructor parameter properties, import aliases and decorators. This is not a preference that can be revisited: Node's type stripping is stable (Stability 2 as of v24.12.0/v25.2.0), but `--experimental-transform-types` was **removed in Node 26.0.0**, so there is no longer any escape hatch. Use `const Level = { read: 'read', worktree: 'worktree' } as const` plus a union type instead of an enum, and assign fields explicitly instead of using parameter properties. Ban them now, not after 5k lines.

**ESM only.** `"type": "module"` in every package.json. No dual CJS build, ever.

---

## 7. On-disk state: two locations, different jobs

There are two state directories and they are not interchangeable.

### 7.1 Repo-local `.DeFlow/` — repo-scoped configuration and human-inspectable exports

Lives inside the target repository being worked on (not inside the DeFlow source tree). Follows [PRD §9.4](./prd.md#94-repo-layout).

```
<target-repo>/.DeFlow/
  config.yaml            providers, budgets, gates, policy          COMMITTED
  gates/                 custom gate definitions (F7.6)             COMMITTED
  templates/             reusable parameterised plans (F2.8)        COMMITTED
  memory/                curated cross-run project memory (F6.8)    COMMITTED
  .worktreeinclude       gitignored files to copy into worktrees    COMMITTED
  daemon.json            {pid, port, token, startedAt}              gitignored
  wt/<runId>__<nodeId>/  worktrees                                  gitignored
  runs/<runId>/                                                     gitignored
    plan/v1.json … vN.json
    nodes/<nodeId>/{packet.json, prompt.txt, stdout.log,
                    output.json, verdict.json}
    report.html
```

Everything in the committed half is a **team artefact**: it is reviewed in pull requests, it travels with the repo, and it is how a colleague's DeFlow behaves the same as yours. Everything in the gitignored half is **per-machine**. `deflow init` writes both halves and appends the gitignored paths to `.gitignore`.

Worktrees live here rather than in a global directory for two reasons: they must sit on the **same filesystem** as the repo (atomic `rename` is only atomic within one filesystem, and the file-write effect depends on it), and a user who wants to `cd` into an agent's worktree and look around should be able to find it next to their code.

The per-run files under `runs/<runId>/` satisfy NF8 — "every artifact inspectable on disk in an open format" — but they are **exports, not the source of truth**. They are written from the ledger; the ledger is never reconstructed from them.

### 7.2 Global daemon state — `$XDG_DATA_HOME/DeFlow`, else `~/.DeFlow`

```
$XDG_DATA_HOME/DeFlow/         (falls back to ~/.DeFlow)
  DeFlow.lock                  flock target (single-instance lease); always 0 bytes
  DeFlow.lock.pid              the holder's pid, for the message a refused daemon prints
  ledger.db  ledger.db-wal  ledger.db-shm
  blobs/<ab>/<sha256>          content-addressed spill for payloads > ~256 KiB
  recordings/<provider>@<version>/<case>.ndjson
  pre-migrate-<user_version>.db   VACUUM INTO backup, taken before each migration
  logs/
```

The **ledger is a single global database**, not one per run. Three reasons: the schema is keyed by `run_id` throughout (`event`, `io_chunk`, `effect`, `plan`, `run`, `node_wake`), so per-run files would buy nothing; cross-run features need one queryable store (project memory F6.8, plan templates F2.8, the cross-run dashboard F10.11, and D15's FTS5 + BM25 retrieval over prior runs); and the daemon holds exactly one connection with one WAL and one `busy_timeout`, which is far easier to reason about than N attached files.

**This deviates from the sketch in [PRD §9.4](./prd.md#94-repo-layout)**, which shows `ledger.db` under `.DeFlow/runs/<runId>/`. The deviation is deliberate and is recorded here rather than silently. A per-run database would also put a binary, WAL-journalled SQLite file inside a git repository, which is a bad place for it.

Blobs are global for the same reason content-addressing exists: the identical failing test log across three retry attempts, or across two runs of the same task, deduplicates to one object.

`DeFlow.lock` and the `daemon_epoch` counter are global because the thing they protect against is global — a user running `npx deflowai up` in two terminals. Every ledger write carries the epoch and stale-epoch writes are rejected. The `daemon_epoch` counter lives in `ledger.db`, not in `DeFlow.lock`: nothing is ever written into the lock file, because committing is precisely the moment SQLite releases the file lock, and an acquisition that lets go of the lock halfway through is not exclusive against a second daemon started microseconds rather than seconds later (see `packages/ledger/README.md` §single-instance lease). The lock file is therefore always 0 bytes, and the holder's pid — needed only for the sentence a *refused* daemon prints, never for a liveness check — goes in `DeFlow.lock.pid` beside it.

On first run, `deflow up` resolves the data dir, runs migrations, probes for installed agent CLIs and records their versions (F3.6), binds port 7777 or the next free one, writes `.DeFlow/daemon.json` with a freshly generated 32-byte bearer token, and prints the URL.

---

## 8. File and naming conventions

| Thing                      | Convention                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Source files               | `kebab-case.ts`, one exported concept per file where practical                                                 |
| Package entry              | `src/index.ts` — the only public surface; re-exports, no logic                                                 |
| Unit tests                 | `src/**/*.test.ts`, colocated with the code they test                                                          |
| Integration tests          | `packages/*/test/integration/**/*.test.ts` (30 s timeout, `pool: 'forks'`)                                     |
| Cross-process tests        | `e2e/**/*.test.ts` (180 s timeout, `singleFork`, no file parallelism)                                          |
| File snapshots             | `__snapshots__/*.json` next to the spec; real files that diff readably in a PR                                 |
| Migrations                 | `packages/ledger/src/migrations/NNNN-name.ts`, numbered, **append-only, never edited once shipped**, no `down` |
| Event kinds                | dotted lowercase: `run.created`, `node.started`, `context.compacted`, `gate.evaluated`                         |
| Branches created by DeFlow | `DeFlow/<runId>__<nodeId>` (flat, D13); integration branches `DeFlow/int/<runId>`                              |
| Effect ids                 | `<runId>/<nodeId>/<attempt>/<ordinal>`, hashed to short hex when embedded in a filename                        |
| Ports and their fakes      | Interface in `@DeFlow/core` (`Clock`, `Db`), production impl in `daemon`/`ledger`, fake in `testkit`           |
| Domain failures            | Values in a closed union, never thrown; `throw` is reserved for programmer bugs                                |
| Env vars                   | `DeFlow_*` prefix. `DeFlow_DEV`, `DeFlow_KEEP_TMP`, `DeFlow_RECORD`, `DeFlow_FAKE_SCENARIO`                    |

Root scripts:

```jsonc
"scripts": {
  "dev": "DeFlow_DEV=1 node --watch --watch-path=packages --env-file-if-exists=.env packages/daemon/src/main.ts",
  "build": "pnpm --filter @DeFlow/web build && pnpm --filter deflowai build",
  "typecheck": "tsc -b && pnpm --filter @DeFlow/web exec vue-tsc --noEmit",
  "test": "vitest run",
  "lint": "oxlint --type-aware && biome check .",
  "format": "biome check --write .",
  "prepare": "lefthook install"
}
```

---

## 9. Pitfalls

- **Never add `paths` aliases to `tsconfig.base.json`.** `rewriteRelativeImportExtensions` does not rewrite through them (microsoft/TypeScript#61991). Development works; the published package breaks. There is no warning.
- **Never deep-import across packages.** It breaks the `publishConfig` source→dist swap and makes every internal file public API.
- **Do not publish `@DeFlow/*`.** The moment a second package is published you have inter-package semver, a release order, and a reason for changesets — all of which the single-package design exists to avoid.
- **Do not let `@DeFlow/core` acquire an I/O dependency.** The purity test in §4 is cheap; add it before the first temptation, not after.
- **Do not use `corepack enable` in CI.** Corepack was removed from Node 25+ distributions (TSC vote, March 2025) and is only bundled through Node 24. Use `pnpm/action-setup@v6` (which added pnpm 11 support) or `npm i -g pnpm@11`. Keep `"packageManager": "pnpm@11.18.0"` in `package.json` — pnpm still reads it as a version assertion.
- **Pin CI runner images.** `macos-latest` migrated to macOS 26 on Apple Silicon between 8 and 15 June 2026. Use `macos-26` and `ubuntu-26.04` explicitly. Node matrix is `24` (Active LTS, the floor) and `26` (Current) — Node 22 is maintenance-only, and if you list it in `engines` you are obliged to test it, so do not list it.
- **Do not run Biome's linter and oxlint over the same globs.** You get duplicate diagnostics and conflicting autofixes. Set `"linter": { "enabled": false }` in `biome.json` and let oxlint own TS/JS linting; the formatter stays on everywhere. Note that type-aware linting went stable in **oxlint 1.75.0** (1.76.0 is merely the current latest).
- **Biome's `.vue` support is off by default,** not merely experimental. It is gated behind `"html": { "experimentalFullSupportEnabled": true, "formatter": { "enabled": true } }` in `biome.json`. Without that flag `biome check` silently no-ops on every `.vue` file in `packages/web` — you get a green run and zero formatting.
- **Do not put the ledger database in the target repo.** It is a binary WAL-journalled file; git is the wrong home for it, and the cross-run features need one global store anyway.
- **Do not bundle UI assets into JavaScript.** They ship as plain files under `dist/ui/` and are resolved with `import.meta.url` at runtime.
- **Test the real tarball, not the workspace.** `pnpm pack` then install from the `.tgz` in a clean temp directory, on every release. A missing `files` entry is invisible from inside the monorepo.

---

**Related:** [Architecture overview](./01-architecture-overview.md) · [Tech stack](./02-tech-stack.md) · [Local development](./03-local-development.md) · [Testing strategy](./14-testing-strategy.md) · [Durable execution](./05-durable-execution.md)

[← Back to index](./README.md)
