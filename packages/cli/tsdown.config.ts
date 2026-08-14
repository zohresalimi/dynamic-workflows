import { defineConfig } from 'tsdown';

/**
 * The bundler half of "exactly one published package" (docs/16-repo-layout.md §2).
 *
 * Every `@DeFlow/*` package is `"private": true`, so a specifier that survives
 * into the output is not a slow import — it is a 404 from npm on someone else's
 * machine. Inlining them deletes the whole multi-package versioning problem:
 * no changesets, no inter-package semver, and a release that is
 * `npm version patch && pnpm publish`.
 *
 * **Option names.** docs/16 §2 writes this as `noExternal: [/^@DeFlow\//]` and
 * `external: ['@lydell/node-pty']`. Both spellings are deprecated in
 * tsdown@0.22.14 — it accepts them, warns on every build, and maps them onto
 * `deps.alwaysBundle` / `deps.neverBundle`, which is what is written here. The
 * semantics are identical; only the names moved.
 *
 * **What stays external, and why it is two and not one.** tsdown externalises a
 * package's own production dependencies by default, so this list and
 * `package.json`'s `dependencies` + `optionalDependencies` are the same
 * statement made twice — deliberately, because `deps.onlyImport` below turns the
 * second one into a build failure rather than a runtime one.
 *
 * - `better-sqlite3` finds its own prebuilt binary with
 *   `require(path.join(__dirname, '..', 'prebuilds', `${platform}-${arch}.node`))`.
 *   Inlined, `__dirname` becomes `dist/`, that lookup points at
 *   `packages/cli/prebuilds/`, and the first ledger a user opens throws. It
 *   ships prebuilds for every supported platform with `gypfile: false` and no
 *   install script, so it costs an install second and never reaches node-gyp
 *   (NF6).
 * - `@lydell/node-pty` is native for the same reason and `optional` on top of
 *   it: an unsupported platform must degrade to a plain `spawn` with no TTY
 *   rather than fail `npm install` (docs/16 §2, KAR-18.4).
 *
 * **Not here: `dist/ui/`.** The built SPA is copied in by
 * `scripts/build.ts` *before* this runs and is never touched by the bundler —
 * UI assets ship as plain hashed files and are resolved at runtime with
 * `fileURLToPath(new URL('./ui/', import.meta.url))`. That is also why `clean`
 * names the JavaScript rather than the directory: `clean: true` would delete
 * the UI that the previous build step just put there, and the symptom is a
 * daemon that starts and serves a blank page.
 */
export default defineConfig({
  entry: ['src/bin.ts', 'src/mcp.ts', 'src/mock-agent.ts', 'src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // `.mjs` rather than `.js`: the `bin` map, the docs and every error message
  // about this package name the files that way, and an extension that depends
  // on a `"type"` field two directories up is one indirection too many for the
  // three files a user's `npx` actually executes.
  outExtensions: () => ({ js: '.mjs' }),
  // docs/16 §2's `dts: false`, and it is a decision rather than a default: the
  // tarball's contract is three executables, so there is no `.d.ts` for anyone
  // to consume and `publishConfig` says so by exporting nothing. The workspace
  // still resolves `DeFlow` to `src/index.ts` for e2e and the CLI's own specs;
  // that is a workspace convenience, not a published API.
  dts: false,
  sourcemap: false,
  // Kept as the statement of intent, and **not** relied on: tsdown resolves
  // these globs against the project root rather than against `--out-dir`, so on
  // their own they match nothing and `dist/` accumulates every content-hashed
  // chunk of every build. `scripts/build.ts` removes exactly this set, in the
  // out directory, immediately before invoking tsdown.
  clean: ['*.mjs', '*.d.mts', '*.map'],
  /**
   * The third name on both lists is `vite`, and AC7 is the reason.
   *
   * `startHttp` reaches for Vite only under `DeFlow_DEV === '1'`, through a
   * *dynamic* import, so nothing in the tarball ever evaluates it. A bundler
   * does not know that: rolldown follows `import()` like any other edge, and
   * the first build without this line inlined Vite's entire CJS-interop tree —
   * `tsx/cjs/api` and all — into a shared chunk behind `bin.mjs`. Marking it
   * external leaves the specifier as an unreachable `import('vite')`: no bytes,
   * no dependency, and an honest MODULE_NOT_FOUND for anyone who sets
   * `DeFlow_DEV=1` against an installed package, where there is no source tree
   * for Vite to serve in the first place.
   *
   * `onlyImport` is AC2 enforced at build time rather than only in a spec: any
   * *other* bare specifier that reaches the output fails the build and names
   * the chunk that pulled it in.
   */
  deps: {
    alwaysBundle: [/^@DeFlow\//],
    neverBundle: ['better-sqlite3', '@lydell/node-pty', 'vite'],
    onlyImport: ['better-sqlite3', '@lydell/node-pty', 'vite'],
  },
});
