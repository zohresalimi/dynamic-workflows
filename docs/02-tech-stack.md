# Tech stack

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

Every version in this document was checked against the npm registry on **2 August 2026**, and the
load-bearing ones were checked by installing the package, unpacking the tarball, or running the
binary. Where a claim is inferred rather than measured it is marked `**Unverified.**`

The stack exists to serve three hard constraints:

1. **AR-1** — DeFlow never holds a model credential, so execution is local and the runtime is
   whatever Node the user already has.
2. **NF6** — `npx DeFlow up`, no database server, no Docker, no build step at install time.
3. **One engineer.** Every dependency has to earn its maintenance cost. Where the answer is "less
   tooling", that is the answer.

## Pin policy

| Pin style   | Used for                                                                                                                                   | Written as                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **Exact**   | Anything `0.x`; anything whose _output_ must be byte-stable (formatters, bundlers); protocol SDKs where a wire change is a correctness bug | `"tsdown": "0.22.14"`      |
| **Tilde**   | A stable package where we deliberately refuse the next minor                                                                               | `"vue": "~3.5.40"`         |
| **Caret**   | Mature 1.0+ libraries with a real semver record                                                                                            | `"hono": "^4.12.33"`       |
| **Catalog** | Anything used by more than one workspace package                                                                                           | `"typescript": "catalog:"` |

Shared versions live once, in the `catalog:` block of `pnpm-workspace.yaml`, so no workspace package
can drift (D5). The lockfile is committed and CI installs with `--frozen-lockfile`.

---

## 1. Runtime and language

| Package       | Version   | Pin                        | Why                                                                                                                 |
| ------------- | --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Node.js       | `>=24`    | `engines` floor            | Active LTS to 2026-10-20. Type stripping is stable, `--env-file` is stable, pnpm 11 and tsdown both require it (D2) |
| `pnpm`        | `11.18.0` | exact via `packageManager` | Workspaces + `catalog:` + `workspace:*` are what make the source-linking dev loop work (D5)                         |
| `typescript`  | `6.0.3`   | exact, catalog             | TS 7 ships no `tsserver` and no programmatic API — `vue-tsc` and `typescript-eslint` cannot run on it (D3)          |
| `@types/node` | `26.1.2`  | `^`, catalog               | Types ahead of the runtime floor is fine and correct                                                                |
| `tsx`         | `4.23.4`  | `^`, devDep                | Documented escape hatch only, if Node's "no TS under `node_modules`" rule ever bites pnpm symlinks                  |

## 2. Monorepo, build and release

| Package                 | Version   | Pin               | Why                                                                                                  |
| ----------------------- | --------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `tsdown`                | `0.22.14` | exact             | Rolldown-based bundler for the one published package; inlines all `@DeFlow/*` into a single ESM file |
| `vite`                  | `8.2.0`   | `^`               | Builds the UI **and** runs in middleware mode inside `DeFlowd` (D10)                                 |
| `@vitejs/plugin-vue`    | `6.0.8`   | `^`               | Peers `vite ^8`                                                                                      |
| `publint`               | `0.3.22`  | exact             | Release gate: catches a broken `exports`/`files` map before npm does                                 |
| `@arethetypeswrong/cli` | `0.18.5`  | exact             | Release gate: catches type-resolution breakage in the tarball                                        |
| `turbo`                 | `2.10.8`  | **not installed** | Add only when `pnpm -r typecheck` exceeds ~20 s locally. Drop-in `turbo.json`, no code changes       |

No Nx, no moon, no changesets. With exactly one published package (`DeFlow`), release is
`npm version patch && pnpm publish` (D5).

## 3. Daemon core

| Package             | Version         | Pin                               | Why                                                                                                               |
| ------------------- | --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hono`              | `4.12.33`       | `^`                               | First-class `streamSSE`; `hc<AppType>` gives the UI end-to-end types with no codegen                              |
| `@hono/node-server` | `2.0.12`        | `^`                               | Adapts Hono's `fetch` handler onto `node:http`, which is what Vite middleware mode attaches to                    |
| `zod`               | `4.4.3`         | `^`, catalog                      | `z.toJSONSchema()` produces the handoff contracts (F6.9) and capability manifests (F3.5) for free                 |
| `pino`              | `10.3.1`        | `^`                               | Operator diagnostics. **Not** the ledger — see [durable execution](./05-durable-execution.md)                     |
| `pino-pretty`       | `13.1.3`        | `^`, devDep                       | Dev only, piped: `pnpm dev \| pino-pretty`. Never a runtime transport                                             |
| `execa`             | `10.0.1`        | `^`                               | Every `git` invocation and every CLI shim. Typed, promise-based, `AbortSignal`-aware                              |
| `@lydell/node-pty`  | `1.2.0-beta.14` | **exact, `optionalDependencies`** | One of the two native dependencies (with `better-sqlite3`), and the only optional one. See §10.9                  |
| `get-port`          | `7.2.0`         | `^`                               | Port 7777, or next free                                                                                           |
| `gpt-tokenizer`     | `3.4.0`         | `^`                               | Pre-flight token estimation via the `o200k_base` entrypoint. Pure JS, no wasm, no native build                    |
| `ohash`             | `2.0.11`        | `^`                               | Content hashes for plan nodes and context segments. Stable key ordering, which `JSON.stringify` does not give you |
| `rfc6902`           | `5.3.0`         | `^`                               | JSON Patch between two plan-node objects, for the scrubber's field-level "why did this change" panel              |

Deferred to M2, listed here so the choice is not relitigated later: `secretlint@13.0.4` +
`@secretlint/node@13.0.4` + `@secretlint/secretlint-rule-preset-recommend@13.0.4` for artifact
redaction (F5.9), and `@opentelemetry/sdk-node@0.221.0` +
`@opentelemetry/exporter-trace-otlp-http@0.221.0` + `@opentelemetry/semantic-conventions@1.43.0`
for `gen_ai.*` emission (F10.12, D16).

## 4. Persistence

| Package                 | Version  | Pin                           | Why                                                                                                              |
| ----------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3`        | `13.0.2` | `^`                           | The ledger. v13 is N-API with 8 prebuilt binaries in the tarball, `gypfile: false`, no install script (D6)       |
| `@types/better-sqlite3` | `9.6.0`  | `^`, devDep                   | Types are not bundled. Major lags the package — verify it types `db.explain()` and `stmt.toString()`             |
| SQLite                  | `3.53.4` | bundled, pinned by the driver | **Verified 2026-08-02:** compiled with `ENABLE_FTS5`, so D15's BM25 retrieval works with zero extra dependencies |

No migration library. Migrations are ~40 lines over `PRAGMA user_version` — see
[durable execution](./05-durable-execution.md). Rejected: `umzug@3.8.3` (DB-agnostic, heavyweight),
`drizzle-kit@0.31.10` (drags in an ORM mid-1.0-transition), `sqlite@5.1.1` (unpublished since 2023).

## 5. Adapter layer

| Package                     | Version  | Pin       | Why                                                                                                |
| --------------------------- | -------- | --------- | -------------------------------------------------------------------------------------------------- |
| `@agentclientprotocol/sdk`  | `1.3.0`  | **exact** | ACP client. Target wire `protocolVersion: 1` (D8). A wire change is a correctness bug, so no caret |
| `@modelcontextprotocol/sdk` | `1.30.0` | **exact** | DeFlow hosts an MCP stdio server injected via ACP `session/new` (D9)                               |

These are **spawned, not depended on** — they are the user's own installs and DeFlow probes them at
runtime (F3.6). Versions below are what `DeFlow doctor` saw on 2026-08-02; record them per run, warn
on drift.

| Binary      | Package probed                      | How DeFlow speaks to it                                                                    |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `@anthropic-ai/claude-code@2.1.220` | via adapter `@agentclientprotocol/claude-agent-acp@0.64.1` (bin `claude-agent-acp`)        |
| Codex       | `@openai/codex@0.146.0`             | via adapter `@agentclientprotocol/codex-acp@1.1.9` (bin `codex-acp`, honours `CODEX_PATH`) |
| Gemini CLI  | `@google/gemini-cli@0.53.1`         | native: `gemini --acp`                                                                     |
| Copilot CLI | `@github/copilot@1.0.77`            | native: `copilot --acp`                                                                    |
| OpenCode    | `opencode-ai@1.18.11`               | native: `opencode acp`                                                                     |

**Verified 2026-08-02** by running a real `initialize` handshake against each binary. Note the
non-obvious result: the two most important agents do _not_ speak ACP themselves. Detail in
[the provider adapter layer](./07-provider-adapter-layer.md).

## 6. Frontend

| Package                                                                                 | Version                                                        | Pin              | Why                                                                                                               |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `vue`                                                                                   | `3.5.40`                                                       | **`~`**          | Latest stable. 3.6.0-rc.2 is a reactivity-system rewrite and `@vue-flow/core` 3.6 support is unverified           |
| `vue-router`                                                                            | `5.2.0`                                                        | `^`              | v5 is a non-breaking transition release (it absorbed file-based routing into core). Use plain object routes       |
| `pinia`                                                                                 | `4.0.2`                                                        | `^`              | Host for the hand-rolled ledger-projection store (D11)                                                            |
| `@pinia/colada`                                                                         | `1.4.2`                                                        | `^`              | Only for the handful of flat REST endpoints. Never for run state                                                  |
| `@vue-flow/core`                                                                        | `1.48.2`                                                       | `^`              | The plan DAG (F10.1). Always behind our own `<GraphCanvas>` facade                                                |
| `@vue-flow/background` `/controls` `/minimap`                                           | `1.3.2` / `1.1.3` / `1.5.4`                                    | `^`              | Companion packages                                                                                                |
| `elkjs`                                                                                 | `0.12.0`                                                       | exact            | Layout with stability knobs, in a Web Worker. Required by the plan scrubber (F10.2)                               |
| `@dagrejs/dagre`                                                                        | `3.0.0`                                                        | `^`              | Fast path for previews and streaming relayout. Never the unscoped `dagre` — it has not shipped since 2019-12-03   |
| `@xterm/xterm`                                                                          | `6.0.0`                                                        | `^`              | Live agent streams (F10.6). Scoped package only; `xterm@5.3.0` is dead                                            |
| `@xterm/addon-fit` `/webgl` `/serialize` `/search` `/unicode11` `/web-links`            | `0.11.0` / `0.19.0` / `0.14.0` / `0.16.0` / `0.9.0` / `0.12.0` | `^`              | v6 removed the canvas renderer — DOM or WebGL only                                                                |
| `shiki` family                                                                          | `4.4.1`                                                        | `^`              | Version-locked across `@shikijs/core`, `/langs`, `/themes`, `/engine-javascript`, `/transformers`                 |
| `@shikijs/stream`                                                                       | `4.4.1`                                                        | `^`              | Incremental highlighting of streaming agent output without re-tokenizing the buffer                               |
| `@shikijs/magic-move`                                                                   | `4.4.1`                                                        | `^`              | Token-level before/after animation for the surgical repair loop (F7.5)                                            |
| `@git-diff-view/vue` `/core` `/shiki`                                                   | `0.1.7`                                                        | **exact**        | Pre-1.0. Chosen for per-line widget slots, which is how gate verdicts attach to the diff (F7.7)                   |
| `diff`                                                                                  | `9.0.0`                                                        | `^`              | Client-side text diffs (plan JSON, TaskSpec edits) only. Real code diffs come from `git diff`                     |
| `d3-scale` `d3-array` `d3-shape` `d3-axis` `d3-time-format` `d3-interpolate` `d3-color` | `4.0.2` `3.2.4` `3.2.0` `3.0.0` `4.1.0` `3.0.1` `3.1.0`        | `^`              | Maths only. Render with Vue SVG templates. **Do not install the `d3` metapackage**                                |
| `tailwindcss` + `@tailwindcss/vite`                                                     | `4.3.3`                                                        | `^`              | CSS-first, no `tailwind.config.js`, no PostCSS step                                                               |
| `reka-ui`                                                                               | `2.10.1`                                                       | `^`              | Headless primitives under shadcn-vue. `radix-vue` is the dead name — never install it                             |
| `shadcn-vue`                                                                            | `2.8.1`                                                        | devDep, CLI only | Copies component _source_ into `src/components/ui/`. ~16 files we own                                             |
| `tailwind-merge` `clsx` `class-variance-authority` `lucide-vue-next`                    | `3.6.0` `2.1.1` `0.7.1` `1.0.0`                                | `^`              | What shadcn-vue expects                                                                                           |
| `@vueuse/core`                                                                          | `14.4.0`                                                       | `^`              | `useDark()` and friends                                                                                           |
| `eventsource-client`                                                                    | `1.2.0`                                                        | `^`              | Native `EventSource` cannot send headers, so the bearer token would land in the query string, in logs and history |
| `@tanstack/vue-virtual`                                                                 | `3.13.35`                                                      | `^`              | Virtualized full-log viewer. xterm's scrollback is capped at 5000 lines and is a live tail, not the archive       |
| `vue-tsc`                                                                               | `3.3.9`                                                        | `^`, devDep      | Template type-checking. This is the package that pins the workspace to TypeScript 6                               |
| `vite-plugin-vue-devtools`                                                              | `8.2.1`                                                        | `^`, devDep      |                                                                                                                   |

## 7. Testing

| Package                           | Version   | Pin          | Why                                                                           |
| --------------------------------- | --------- | ------------ | ----------------------------------------------------------------------------- |
| `vitest`                          | `4.1.10`  | `^`, catalog | One root config with `test.projects`. `defineWorkspace` was **removed** in v4 |
| `@vitest/browser`                 | `4.1.10`  | `^`          | Browser mode is stable in v4                                                  |
| `@vitest/browser-playwright`      | `4.1.10`  | `^`          | The provider is now an object from its own package                            |
| `vitest-browser-vue`              | `2.1.0`   | `^`          | Mount Vue components in real Chromium                                         |
| `playwright` / `@playwright/test` | `1.62.1`  | `^`          | ~5 full-stack E2E specs booting a real `DeFlowd`                              |
| `@vue/test-utils`                 | `2.4.11`  | `^`          | Pure-logic components only                                                    |
| `happy-dom`                       | `20.11.1` | `^`          | Same. Never for Vue Flow, d3 or xterm — they need real layout and measurement |

Explicitly **not** used: `memfs` (invisible to a spawned `git`), `isomorphic-git` (cannot create
worktrees the real `git` will honour), `:memory:` SQLite for ledger tests (cannot exercise WAL or
reopen-after-crash), Storybook, Cypress, Playwright component testing. Rationale in
[the testing strategy](./14-testing-strategy.md).

## 8. Lint, format, hooks

| Package           | Version    | Pin       | Why                                                                                                      |
| ----------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `@biomejs/biome`  | `2.5.6`    | **exact** | The formatter for everything, including `.vue`. Exact because formatter output must not change under you |
| `oxlint`          | `1.76.0`   | `^`       | The linter for the Node packages. Type-aware mode went stable in **1.75.0**                              |
| `oxlint-tsgolint` | `7.0.2001` | `^`       | The type-aware engine; tracks TypeScript 7.0.2                                                           |
| `lefthook`        | `2.1.10`   | `^`       | Replaces husky **and** lint-staged with one Go binary shipped via optionalDependencies                   |

Deferred to M2, when a colleague first touches the UI: `eslint@10.8.0` +
`eslint-plugin-vue@10.10.0` + `vue-eslint-parser@10` + `eslint-plugin-oxlint@1.76.0`, scoped to
`packages/web/**/*.vue` only. oxlint lints the `<script>` block of an SFC and has explicitly declined
to target `eslint-plugin-vue` template-rule compatibility.

## 9. CI

| Thing                | Pin                        | Why                                                                                                              |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`   | `v5`                       |                                                                                                                  |
| `pnpm/action-setup`  | `v6`                       | Added pnpm 11 support. **Unverified** that v6 is the newest tag — check before pinning                           |
| `actions/setup-node` | `v6`                       |                                                                                                                  |
| Runner images        | `ubuntu-26.04`, `macos-26` | Never `-latest`. `macos-latest` silently migrated to macOS 26 on Apple Silicon between 8–15 June 2026            |
| Node matrix          | `24`, `26`                 | Floor and Current. Node 22 is maintenance-only — if you list it in `engines` you must test it, so do not list it |

**Do not use `corepack enable`.** Corepack was removed from Node 25+ distributions (TSC vote, March
2025). It only exists through Node 24, so a `corepack enable` line in CI or in the setup docs breaks
on the exact Node versions you most want to test. Keep `"packageManager": "pnpm@11.18.0"` in
`package.json` — pnpm still reads it as a version assertion.

---

## 10. The choices that carry real risk

### 10.1 Node 24 is the floor, not Node 22

The PRD says "Node 22+" (§9.2). That is looser than it should be and is corrected here (D2).

Node 22 entered maintenance on 2025-10-21. Node 24 became Active LTS on 2025-10-28 and stays there
until 2026-10-20; Node 26 started 2026-05-05 and becomes LTS 2026-10-28. Four independent things
push the floor to 24:

- **Type stripping is Stability 2 (stable)** as of v24.12.0 / v25.2.0. The zero-build dev loop
  (`node packages/daemon/src/main.ts`) depends on it.
- **`--env-file` / `--env-file-if-exists` is stable** as of v24.10.0 / v22.21.0.
- **pnpm 11 requires Node >= 22.13**; **tsdown requires `^22.18 || >=24.11`**.
- Node 22 support means a CI matrix entry that costs minutes and buys nothing, since no user of a
  tool that orchestrates 2026 coding agents is on a maintenance-line runtime.

Develop on 24, run CI on 24 **and** 26. Ship a `.node-version` file so the major is unambiguous.

### 10.2 TypeScript 6.0.3, and the whole TypeScript 7 story

This is the single highest-impact fact in the tooling area, and it inverts the obvious
"use the newest" instinct.

`typescript@7.0.2` is stable, GA on 8 July 2026, Go-native, 8–12× faster at type-checking. It is
also, right now, a trap for this project. **Verified 2026-08-02 by unpacking both tarballs:**

|                     | `typescript@6.0.3` | `typescript@7.0.2`                                          |
| ------------------- | ------------------ | ----------------------------------------------------------- |
| `bin`               | `tsc`, `tsserver`  | `tsc` only                                                  |
| Implementation      | JavaScript         | Go binary, delivered as per-platform `optionalDependencies` |
| Public compiler API | yes                | **none**                                                    |

Two consequences follow, and both are load-bearing for DeFlow:

- **`vue-tsc@3.3.9` / Volar embed the TypeScript compiler API.** No API means no `vue-tsc`, which
  means no template type-checking across nine Vue views. See vuejs/language-tools#5381.
- **`typescript-eslint@8.65.0`'s peer range is literally `typescript >=4.8.4 <6.1.0`.** It does not
  merely lack TS 7 support; it excludes it by declaration.

Adopting TS 7 today therefore means a split-version workspace — Node packages on 7,
`packages/web` on 6 — with two lint configs and two typecheck paths. For a solo developer that is
real ceremony purchased with a typecheck speedup that is not currently painful.

Microsoft has said the stable programmatic API lands in **TypeScript 7.1**. Secondary sources put
that around October 2026; **Unverified** — no Microsoft primary source confirms a date.

> **Trigger to revisit:** TS 7.1 is published **and** `vue-tsc` announces support **and**
> `typescript-eslint` (or an oxlint-tsgolint successor covering the same rules) publishes a peer
> range admitting 7.x. When all three are true, flip the entire catalog in one commit and re-verify
> all three together. Do not flip them one at a time.

Note the compensating design: `oxlint` with `oxlint-tsgolint@7.0.2001` already runs type-aware rules
on a TypeScript 7 engine internally, so the correctness rules that matter most for an orchestrator
are not blocked by the TS 6 pin. Only `vue-tsc` genuinely is.

### 10.3 `erasableSyntaxOnly: true` is permanent

Node's type stripping is stable, but `--experimental-transform-types` was **REMOVED in Node
26.0.0**. There is no flag left. Any TypeScript syntax that needs a runtime emit is now permanently
unrunnable by `node file.ts` on a supported runtime, so it must be banned on day one rather than
after 5,000 lines (D4).

`tsconfig.base.json` sets it, and this is not negotiable:

```jsonc
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true, // forces `import type`; required for stripping correctness
    "isolatedModules": true,
    "erasableSyntaxOnly": true, // LOAD-BEARING, permanent
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": true, // tsc checks; tsdown emits
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "types": ["node"],
  },
}
```

| Banned                                           | Replacement idiom                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `enum Status { Ok, Fail }`                       | `const Status = { Ok: 'ok', Fail: 'fail' } as const` + `type Status = typeof Status[keyof typeof Status]` |
| `const enum`                                     | Same as above. `const enum` is worse: it also breaks `isolatedModules`                                    |
| `namespace X { ... }` with runtime members       | A module. `export` from a `.ts` file and import it                                                        |
| `constructor(private readonly db: Db) {}`        | Declare the field and assign it: `readonly db: Db; constructor(db: Db) { this.db = db }`                  |
| `@decorator` on classes/members                  | A plain higher-order function, or an explicit registration call                                           |
| `import Foo = require('foo')` / `import A = B.C` | `import Foo from 'foo'` / a `const` alias                                                                 |
| `export =`                                       | `export default`                                                                                          |

Two related rules that fall out of the same design:

- **Relative imports carry explicit `.ts` extensions.** `import { applyPatch } from './patch.ts'`.
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` make `tsc` and `tsdown` rewrite
  them to `.js` on emit, while `node src/main.ts` runs the source directly with zero tooling.
- **No `paths` aliases.** `rewriteRelativeImportExtensions` does not rewrite through them
  (microsoft/TypeScript#61991). Cross-package imports use workspace package names.

### 10.4 The SQLite driver: `better-sqlite3`, not `node:sqlite`

Two research areas reached opposite conclusions here, so the resolution is worth stating in full
(D6). Area 2 recommended `node:sqlite`; area 1 recommended `better-sqlite3@13.0.2`. **Area 1 wins,
because area 2's entire rationale was disproved by measurement.**

Area 2's argument was install ergonomics: zero native compilation means `npx DeFlow up` never runs
node-gyp, which is the number-one install-failure class for a solo-maintained tool. That was true of
better-sqlite3 v12 and is no longer true of v13.

**Verified 2026-08-02 by installing the package:**

- v13.0.0 was the **N-API migration**. The npm tarball (11.4 MB) ships prebuilt binaries directly:
  `prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node` — 8 files. `package.json` has
  `gypfile: false` and **no install script**.
- `npm i better-sqlite3@13.0.2` completed in **1 second**. Zero compilation, zero node-gyp, zero
  `prebuild-install` network fetch, 27 MB of `node_modules`.
- N-API means one binary per platform works across Node versions. **No rebuild per Node upgrade** —
  which matters enormously for software distributed by `npx` onto an unknown runtime.
- It bundles **SQLite 3.53.4, pinned, with FTS5 compiled in**. Retrieval (D15) works out of the box
  and SQL behaviour does not drift with the user's Node install.
- Its only runtime dependency is `node-addon-api@^8`.

Against `node:sqlite`:

- It is still **Stability 1.2 (Release Candidate)** on Node 24 and Node 26. Not Stable(2).
- Its API changed _inside_ the 24.x LTS line: `createTagStore` in 24.9, `setAuthorizer` in 24.10,
  `defensive` in 24.12/24.14, `limits` in 24.15, `serialize`/`deserialize` in 24.16. For software
  distributed by `npx` onto whatever Node the user happens to have, **behaviour varying with the
  user's patch level is disqualifying.**
- It prints `ExperimentalWarning: SQLite is an experimental feature` on import (verified).
  Suppressible with `NODE_NO_WARNINGS=1`, but globally suppressing warnings in a daemon is a bad
  trade.
- Performance is not a differentiator: `node:sqlite` measured **5–15% faster**, which is irrelevant
  at a control plane of ~2,000 events per multi-hour run.

Both are synchronous with near-identical shapes, so the decision is cheap to reverse. Everything
touches this port and nothing imports the driver directly:

```ts
// packages/core/src/db/port.ts
//
// The entire surface DeFlow is allowed to use. Swapping better-sqlite3 for node:sqlite
// (or node-sqlite3-wasm on an exotic platform) is a one-file change against this.

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface Stmt<R = unknown> {
  /** Execute; returns row counts. Use for INSERT/UPDATE/DELETE. */
  run(...params: SqlValue[]): RunResult;
  /** First row, or undefined. */
  get(...params: SqlValue[]): R | undefined;
  /** All rows. Beware unbounded scans — prefer iterate() past a few thousand rows. */
  all(...params: SqlValue[]): R[];
  /** Streaming cursor; the ledger replay path uses this. */
  iterate(...params: SqlValue[]): IterableIterator<R>;
}

export interface Db {
  /**
   * Prepare a statement. Implementations MUST cache by SQL text — the hot path
   * (SSE tail, ~0.2 ms/query) re-prepares the same three statements forever.
   */
  prepare<R = unknown>(sql: string): Stmt<R>;

  /** Multi-statement DDL and PRAGMA. No parameters — PRAGMA cannot be parameterised. */
  exec(sql: string): void;

  /**
   * Wrap fn in BEGIN IMMEDIATE / COMMIT, ROLLBACK on throw. IMMEDIATE (not DEFERRED)
   * because the writer must take the write lock up front: a deferred upgrade under WAL
   * can fail with SQLITE_BUSY after the transaction has already read.
   */
  transaction<T>(fn: () => T): () => T;

  /** Read PRAGMA user_version. The migration runner's only state. */
  userVersion(): number;

  /** Set PRAGMA user_version. Interpolated, not bound — PRAGMA forbids parameters. */
  setUserVersion(v: number): void;

  /**
   * VACUUM INTO <path>. Measured at 1007 ms for a 193 MB database, which makes it a
   * viable pre-migration backup and the "attach my ledger to this bug report" command.
   */
  backupTo(path: string): void;

  close(): void;
}

export interface OpenOptions {
  readonly path: string;
  readonly readonly?: boolean;
}

/**
 * Opens the database and applies the connection pragmas, in this order, on every open:
 *
 *   PRAGMA journal_mode = WAL;            -- persistent, survives reopen
 *   PRAGMA synchronous = NORMAL;          -- survives process crash, not power loss
 *   PRAGMA busy_timeout = 5000;
 *   PRAGMA foreign_keys = ON;
 *   PRAGMA wal_autocheckpoint = 1000;     -- pages
 *   PRAGMA journal_size_limit = 67108864; -- 64 MB cap after checkpoint
 *   PRAGMA cache_size = -32000;           -- 32 MB
 */
export type OpenDb = (opts: OpenOptions) => Db;
```

> **Revisit when** `node:sqlite` reaches Stability 2 **and** Node 26 is the floor. At that point the
> port makes the swap trivial and drops a 27 MB native dependency. Not before.

### 10.5 `tsdown`, not `tsup`

`tsup@8.5.1` last published **2025-11-12** and its maintainers now direct new projects to tsdown.
`unbuild@3.6.1` last published 2025-08-15 and is UnJS-ecosystem-shaped. Both still work; both are
dead ends.

`tsdown@0.22.14` is Rolldown-based, from the Vite/VoidZero org, peer-supports `typescript ^5 || ^6
|| ^7`, and declares `engines: ^22.18.0 || >=24.11.0` (**verified 2026-08-02** by unpacking the
tarball). Plain `tsc` is not an alternative: it cannot inline `@DeFlow/*` into one file, and that
inlining is exactly what lets the published package have a single native dependency.

```ts
// packages/cli/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false, // nothing imports DeFlow as a library
  clean: true,
  outDir: "dist",
  noExternal: [/^@DeFlow\//], // inline every workspace package
  external: ["better-sqlite3", "@lydell/node-pty"], // natives stay real runtime deps
});
```

It is still `0.x`, so pin exactly and expect config churn on minor bumps.

### 10.6 Hono, and the typed client that removes a whole layer

`hono@4.12.33` + `@hono/node-server@2.0.12`. `fastify@5.11.0` is the conservative alternative and is
rejected for one specific reason: it has no typed-client story.

Hono's `hc<AppType>` derives a fully-typed client from the route definitions themselves. No OpenAPI
document, no codegen step, no generated SDK to keep in sync:

```ts
// packages/daemon/src/http/api.ts
export const api = new Hono()
  .get("/runs", (c) => c.json(listRuns()))
  .get("/runs/:id", (c) => c.json(getRun(c.req.param("id"))))
  .post("/runs/:id/pause", (c) => c.json(pauseRun(c.req.param("id"))));

export type ApiType = typeof api; // this is the whole contract
```

```ts
// packages/web/src/api/client.ts
import { hc } from "hono/client";
import type { ApiType } from "@DeFlow/daemon/http/api.ts";

export const api = hc<ApiType>("/api", {
  headers: () => ({ Authorization: `Bearer ${token.value}` }),
});

const res = await api.runs[":id"].$get({ param: { id: runId } });
const run = await res.json(); // typed. Rename a field in the daemon, the UI fails to compile.
```

Because `@DeFlow/daemon`'s `exports` points at `./src/index.ts` in the workspace (see
[repo layout](./16-repo-layout.md)), the UI typechecks against live daemon source. A route change
breaks the build in the same commit. For a solo developer that is the single biggest cross-boundary
ergonomic available, and it costs nothing.

The other reason for Hono is `hono/streaming`'s `streamSSE`, which supports a per-event `id`. Set it
to the ledger sequence number and `Last-Event-ID` resume becomes
`SELECT * FROM event WHERE seq > ?`. Details in [the API contract](./11-api-and-realtime.md).

### 10.7 Two linting tools, one owner per concern

The pairing is unusual, so the reasoning matters.

**Biome 2.5.6 is the formatter for everything** — `.ts`, `.js`, `.json`, `.jsonc`, `.css`, `.html`
and `.vue`. It replaces Prettier entirely (~97% compatible), as one binary with no plugin
resolution.

**Biome's `.vue` support is off by default.** This is not merely "experimental" — without the opt-in
below, `biome check` **silently no-ops on `.vue` files** and you will believe your SFCs are
formatted when nothing has touched them:

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "html": {
    "experimentalFullSupportEnabled": true, // REQUIRED for .vue to be processed at all
    "formatter": { "enabled": true },
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": false }, // oxlint owns linting — see below
}
```

Verify this on a scratch branch before wiring it into a `stage_fixed: true` pre-commit hook: run
`biome check --write packages/web` and read the whole diff. `<script setup>` with complex generics
and templates with long attribute lists are the cases to look at.

**oxlint 1.76.0 with `--type-aware` is the linter for `packages/{core,ledger,adapters,daemon,cli}`.**
Type-aware linting went stable in **oxlint 1.75.0** (1.76.0 is simply the current latest), covering
59 of typescript-eslint's 61 type-aware rules at 12–18× the speed. These are exactly the rules that
catch orchestrator correctness bugs — a floating promise in a three-hour run is a silent data-loss
bug:

```jsonc
// .oxlintrc.json
{
  "plugins": ["typescript", "unicorn", "promise", "import"],
  "categories": { "correctness": "error", "suspicious": "warn" },
  "rules": {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/require-await": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/no-unsafe-argument": "error",
  },
}
```

> **The rule that keeps this workable: Biome's linter and oxlint must never lint the same globs.**
> Two linters over one file gives duplicate diagnostics and autofixes that fight each other across
> runs. `"linter": { "enabled": false }` in `biome.json` is the enforcement. Biome formats; oxlint
> lints. One owner per concern.

### 10.8 `zod@4.4.3`, chosen for one method

`valibot@1.4.2` is far smaller (~1.4 kB gzipped). `arktype@2.2.3` is faster. Neither matters in a
daemon, and Zod wins on a specific capability:

**`z.toJSONSchema()`.** DeFlow needs JSON Schema in two places regardless of its validation library:
handoff contracts handed to agents so node output can be validated before it enters the blackboard
(F6.9), and adapter capability manifests (F3.5). With Zod that is one call on a schema you already
wrote. With valibot or arktype it is an extra conversion package to install, track and debug.

```ts
const HandoffContract = z.object({
  findings: z.array(
    z.object({ file: z.string(), line: z.number().int(), issue: z.string() }),
  ),
  confidence: z.enum(["high", "medium", "low"]),
});

const schemaForAgent = z.toJSONSchema(HandoffContract); // hand this straight to the agent
```

Secondary reasons: Zod is the ecosystem default, so every AI-adjacent library accepts it, and
`z.prettifyError()` gives readable startup failures for env parsing. All three implement **Standard
Schema**, so the port stays cheap if this changes. Use `valibot` inside `packages/web` only if the
UI bundle ever becomes a real constraint.

No config library either: `node --env-file-if-exists=.env` plus one
`packages/core/src/config.ts` exporting `parseEnv(env: NodeJS.ProcessEnv): Config` built on the same
Zod. Adding `dotenv` or `zod-config` here is pure ceremony.

### 10.9 The PTY dependency: `@lydell/node-pty`, not `node-pty`

The PRD names `node-pty` (§9.2). That is corrected here, and the correction is measured, not
inferred.

First, the scope shrank. **Verified 2026-08-02:** no agent process needs a TTY. ACP mode and every
headless mode (`claude -p`, `codex exec`, `gemini -p`, `copilot -p`, `opencode run`) are pure stdio
pipe protocols — all five ACP handshakes ran over plain
`spawn(cmd, args, { stdio: ['pipe','pipe','pipe'] })` with no pty. Agents get `child_process.spawn`
with `detached: true`.

A pty is needed for exactly one thing: **DeFlow's own implementation of the ACP `terminal/*` client
methods**, where the agent asks DeFlow to run a shell command and build tools change behaviour
without a TTY (colour, progress bars, `isatty` gating).

For that, `node-pty@1.1.0` is the wrong package:

|                  | `node-pty@1.1.0`                                                                                        | `@lydell/node-pty@1.2.0-beta.14`                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Install script   | `node scripts/prebuild.js \|\| node-gyp rebuild`                                                        | none                                                                                                           |
| Measured install | prebuild fetch failed → fell through to `node-gyp rebuild` → **failed outright, package uninstallable** | **514 ms, zero compilation**                                                                                   |
| Binary delivery  | download-then-compile fallback                                                                          | npm-native per-platform `optionalDependencies`: `@lydell/node-pty-{darwin,linux,win32}-{arm64,x64}`            |
| Runtime check    | —                                                                                                       | spawned bash in a real pty; `tty` returned `/dev/pts/0`, `$COLUMNS` was 80, clean `{ exitCode: 0, signal: 0 }` |

A silent fallback to `node-gyp rebuild` is a direct threat to `npx DeFlow up` (NF6) on any user
machine without build tools, which is most of them.

The caveat is real and the mitigation is three rules:

1. **Pin exactly.** It is on a `-beta.14` tag. `"@lydell/node-pty": "1.2.0-beta.14"`, no caret.
2. **Make it an `optionalDependency`.** A platform with no prebuilt binary must degrade, not fail
   installation.
3. **Degrade to a no-TTY spawn if absent.** Wrap the import; if it throws, `terminal/*` runs the
   command through plain `spawn` with no pty, sets `TERM=dumb`, and the capability manifest reports
   `terminal.pty: false`. `DeFlow doctor` says so out loud.

```ts
// packages/daemon/src/terminal/pty.ts
let pty: typeof import("@lydell/node-pty") | undefined;
try {
  pty = await import("@lydell/node-pty");
} catch {
  pty = undefined; // no prebuild for this platform: terminal/* degrades to piped spawn
}
export const hasPty = pty !== undefined;
```

Re-check for a stable (non-beta) release before M2.

---

## Pitfalls

Verified footguns in this area. Each one costs an afternoon at minimum.

- **`corepack enable` fails on Node 25+.** Removed from those distributions. Use
  `pnpm/action-setup@v6` or `npm i -g pnpm@11`.
- **`macos-latest` is not a pin.** It became macOS 26 on Apple Silicon between 8–15 June 2026. An
  implicit architecture change under you is exactly the class of thing that eats a weekend.
- **`biome check` silently does nothing on `.vue` without `html.experimentalFullSupportEnabled`.**
- **Running Biome's linter and oxlint over the same globs** gives duplicate diagnostics and
  autofixes that undo each other.
- **`defineWorkspace` and `vitest.workspace.ts` were removed in Vitest 4.** Any tutorial showing
  them predates 3.2 and will not run.
- **`rewriteRelativeImportExtensions` does not rewrite through `paths` aliases**
  (microsoft/TypeScript#61991). Do not use path aliases.
- **Node refuses to load `.ts` files resolved inside `node_modules`.** pnpm workspace links are
  symlinks in `node_modules`; Node normally resolves the realpath, so the source-linking pattern
  should work — but this is the one load-bearing assumption in the zero-build dev loop that was
  reasoned about rather than executed. **Unverified.** Spike it in ten minutes before committing to
  it; the fallback is `tsx watch`.
- **Do not install the `d3` metapackage.** It drags in ~30 modules for the seven you need.
- **Never install unscoped `dagre` or unscoped `xterm`.** `dagre@0.8.5` last shipped 2019-12-03;
  `xterm@5.3.0` last shipped 2023-09-07. Both were renamed, not abandoned in place.
- **Never install `radix-vue`.** It is the dead name for `reka-ui`.
- **Never install `@microsoft/fetch-event-source`.** Last published 2021-04-25 despite its
  popularity. Use `eventsource-client`.
- **Do not use `@xterm/addon-canvas`.** v6.0.0 removed the canvas renderer.
- **`@anthropic-ai/tokenizer` is wrong despite the name** — it is 0.0.4 and implements the
  Claude 1/2-era BPE. There is no public exact tokenizer for Claude 3+.
- **Publishing without testing the tarball** will eventually ship a package missing the bundled UI
  because of a `files` entry. `pnpm pack` + install into a temp dir, every release. See
  [local development](./03-local-development.md#10-verifying-the-real-published-package).

---

## Versions to re-check before starting

Drawn from the open risks in the research. Each is a thing that was true on 2026-08-02 and may have
moved.

| #   | What to check                                                                        | Why it matters                                                                                                                                                    | Action if it moved                                                                      |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | **TypeScript 7.1** published? `vue-tsc` and `typescript-eslint` peer ranges updated? | The date is **Unverified** (secondary sources say ~Oct 2026)                                                                                                      | If all three align, flip the whole catalog in one commit and re-verify together (§10.2) |
| 2   | **`@lydell/node-pty`** — is there a stable release past `1.2.0-beta.14`?             | It is the only native dependency and it is on a beta tag                                                                                                          | Move the pin to the stable version; keep it optional                                    |
| 3   | **`node:sqlite`** — Stability 2 yet?                                                 | The `Db` port exists to make this swap cheap                                                                                                                      | Only swap when Node 26 is also the floor (§10.4)                                        |
| 4   | **`tsdown`** — still `0.x`? Config shape changed?                                    | Pinned exactly precisely because it churns                                                                                                                        | Read the changelog before bumping; the config is 10 lines                               |
| 5   | **Vitest 5** stable?                                                                 | 5.0.0-beta.7 existed on 2026-08-02. Expect another `projects`/browser-mode migration                                                                              | Budget an afternoon. Do not chase the beta                                              |
| 6   | **Vue 3.6** stable, and does `@vue-flow/core` declare support?                       | The Vue pin is a tilde specifically to block this                                                                                                                 | Stay on 3.5.x until Vue Flow says otherwise                                             |
| 7   | **`@vue-flow/core`** — last release was 2026-01-28, effectively one maintainer       | Bus factor on the marquee view (F10.1)                                                                                                                            | The `<GraphCanvas>` facade means a swap is one file                                     |
| 8   | **`pnpm/action-setup@v6`** and **`actions/setup-node@v6`** — newest tags?            | Reported from search summaries, **Unverified** against GitHub                                                                                                     | A newer combined `pnpm/setup` action may exist; evaluate                                |
| 9   | **Biome / oxlint / Vitest / tsdown / pnpm official docs**                            | Their sites returned 403 to the research proxy; versions came from the registry and unpacked tarballs, but _feature and status claims_ came from search summaries | Re-read the official docs before committing config                                      |
| 10  | **pnpm native release management** (`pnpm change`, `pnpm lane`, `versioning:` key)   | Shipped 11.13, July 2026, verified only from release notes                                                                                                        | Irrelevant while there is one published package. Check only if that changes             |
| 11  | **Vendor CLI versions** (§5 table)                                                   | Adapters break on flag churn (G7). Codex went 0.107 → 0.146 in roughly a year                                                                                     | `DeFlow doctor` runs the conformance suite (F3.4) and tells you                         |

---

**Related:** [Local development](./03-local-development.md) · [Repo layout](./16-repo-layout.md) ·
[Durable execution](./05-durable-execution.md) · [Provider adapter layer](./07-provider-adapter-layer.md) ·
[Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
