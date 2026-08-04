# S5 — native prebuilds load on the target machines

> Spike for [KAR-00.5](../delivery/epics/EPIC-00-foundation-spikes.md#kar-005--spike-native-prebuilds-load-on-the-target-machines).
> Scenarios: [EPIC-00-S17, EPIC-00-S18, EPIC-00-S19](../delivery/flows/EPIC-00-foundation-spikes-flows.md).
> Artefact: [`spikes/s5-native/`](../../spikes/s5-native/), executed by
> [`test/integration/spike-s5-native.test.ts`](../../test/integration/spike-s5-native.test.ts) and
> [`test/spike-s5-fsync.test.ts`](../../test/spike-s5-fsync.test.ts).
> Closes open risks **A1-1**, **A1-2**, **A0-6** ([roadmap §6](../17-roadmap.md), struck through
> [below](#the-risks-this-closes)).

**Date:** 2026-08-04. **Machine:** MacBook (`Mac15,4`), darwin/arm64, macOS 26.5.2, APFS,
Node v24.18.0 and v26.6.0 via nvm, npm 11.16.0. **Containers:** `node:24-slim` (Debian bookworm,
glibc 2.36), `node:26-slim` (Debian trixie, glibc 2.41), `node:24-alpine` (musl), and
`node:24-trixie-slim` as a control — all `linux/arm64`, because the docker host is the same Apple
Silicon laptop.

## The question

Two questions with one harness.

1. **Do `better-sqlite3@13.0.2`'s darwin prebuilds actually execute?** On 2026-08-02 the eight
   prebuilt binaries were shown to be _inside the tarball_ and the install was timed at one second
   with no compilation — **on linux-x64 only** (A1-2). The author's laptop is a Mac, and a binary in
   a tarball is not a binary that has run.
2. **Does `@lydell/node-pty@1.2.0-beta.14` cover the platform matrix?** It is a beta of a community
   fork and the only native dependency in the published package, which makes it the last remaining
   install risk for `npx DeFlow up` (NF6, A0-6).

And one number that decides a product trade-off: every fsync-sensitive figure in
[05-durable-execution.md](../05-durable-execution.md) — **979 ev/s** at `synchronous = FULL` against
**22,982 ev/s** at `NORMAL` — was measured in a Linux container, likely over overlayfs. macOS uses
`F_FULLFSYNC` and is typically slower (A1-1).

## Method

`spikes/s5-native/` holds three runnable things and the measurements they wrote.

- **`probe.mjs`** — one environment, probed. It builds a sandbox `bin/` containing symlinks to
  `node`, `npm` and `sh` **and nothing else**, points `PATH` at it, and installs each dependency
  with a real `npm i` into a real empty directory. "No compiler was available" is therefore a
  property of the process rather than a hopeful reading of the log; the probe reports the lookup for
  `cc`, `c++`, `clang`, `clang++`, `gcc`, `g++`, `make` and `node-gyp` and every one is `null` in
  every cell. `sh` is present deliberately: without a shell every install script fails with
  `spawn sh ENOENT`, which would let the claim about upstream `node-pty` pass for the wrong reason.
  The SQLite half then opens a **file-backed** database, and the pty half runs `tty` inside a real
  pty to read the device path out of the kernel rather than inferring it.
- **`bench.mjs`** — the append benchmark, eight configurations, 10,000 events each, on a file in
  `/var/folders/…` (APFS, read off `mount` rather than assumed).
- **`matrix.mjs`** — runs `probe.mjs` unchanged in all five cells plus the control, and writes
  `measurements/pty-matrix.json`.

## Measurement 1 — better-sqlite3 on darwin (EPIC-00-S17)

| #   | Check                                                | Result                                                                        |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Compilers reachable during the install                | **none** — all eight names resolve to `null` under the sandbox `PATH`         |
| 2   | `npm i better-sqlite3@13.0.2`, warm npm cache        | **326–581 ms** across every cell; the 5 s budget is not close to being spent  |
| 3   | Install log                                          | no `gyp`, no `node-gyp`, no `prebuild-install`, no `cc1plus`, no `make:`      |
| 4   | Install/postinstall scripts in the manifest          | **none**; `gypfile: false`                                                    |
| 5   | `node_modules/better-sqlite3/prebuilds/`             | **all 8**: `{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`                  |
| 6   | Binary actually loaded (`process.report.sharedObjects`) | `better-sqlite3/prebuilds/darwin-arm64.node`                               |
| 7   | `select sqlite_version()`                            | **3.53.4**                                                                    |
| 8   | `db.loadExtension`                                   | present, a function                                                           |
| 9   | `journal_mode = WAL`                                 | `wal`                                                                         |

FTS5 with the tokenizer D15 needs — `unicode61 remove_diacritics 2 tokenchars '_-.'`:

| #   | Check                                                       | Result                                                                                  |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 10  | `create virtual table … using fts5(…)`                      | succeeds — FTS5 is compiled into the prebuild                                            |
| 11  | `"snake_case_name"`, `"kebab-case-name"`, `"file.ext"`      | each matches as **one token** (2, 1 and 1 rows of a 4-row corpus)                        |
| 12  | `"case"`, `"name"`, `"ext"`                                 | **0 rows each** — nothing fragmented, which is the whole point of the `tokenchars` list |
| 13  | `ORDER BY bm25(t)` over the two rows carrying the same term | `[4, 1]`; insertion order is `[1, 4]`, so bm25 is ranking rather than passing through   |

Row 12 is the one that cannot be fixed later: the tokenizer is fixed at table creation, and without
`tokenchars '_-.'` every identifier and stack-trace path in the retrieval corpus splits into pieces.

## Measurement 2 — the append benchmark on APFS (EPIC-00-S18)

`measurements/append-throughput.csv`, 10,000 events per row, WAL, batch size 100, payload ~180 B.

**darwin's default, `PRAGMA fullfsync = 0`:**

| `synchronous` | mode              | ev/s          | vs Linux baseline |
| ------------- | ----------------- | ------------- | ----------------- |
| `FULL`        | one txn per event | **41,246**    | 979 → 42x faster  |
| `FULL`        | batched (100)     | **788,076**   | —                 |
| `NORMAL`      | one txn per event | **137,549**   | 22,982 → 6x faster |
| `NORMAL`      | batched (100)     | **1,083,923** | —                 |

**With `PRAGMA fullfsync = 1`, i.e. a real `fcntl(F_FULLFSYNC)` per commit:**

| `synchronous` | mode              | ev/s        | vs Linux baseline    |
| ------------- | ----------------- | ----------- | -------------------- |
| `FULL`        | one txn per event | **335**     | 979 → **2.9x slower** |
| `FULL`        | batched (100)     | **28,605**  | —                    |
| `NORMAL`      | one txn per event | **48,143**  | 22,982 → 2x faster   |
| `NORMAL`      | batched (100)     | **661,412** | —                    |

Ratios, and whether the Linux shape held:

| Ratio                                     | `fullfsync = 0` | `fullfsync = 1` | Linux baseline | Held? |
| ----------------------------------------- | --------------- | --------------- | -------------- | ----- |
| `NORMAL` ÷ `FULL`, one txn per event      | **3.3x**        | **143.6x**      | 20–25x (23.5x) | **no, at either setting** |
| Batching gain at `FULL`                   | 19.1x           | 85.3x           | ~7x            | exceeded |
| Batching gain at `NORMAL`                 | **7.9x**        | 13.7x           | ~7x            | yes    |

### Why eight rows and not four

The story asks for four numbers. Four would have been misleading, and the reason is the single most
important thing this benchmark found: **macOS's `fsync(2)` does not flush the drive's write cache.**
Only `fcntl(F_FULLFSYNC)` does, and SQLite issues that only under `PRAGMA fullfsync = 1`, which is
**off by default on darwin** (measured: `fullfsync = 0` on a freshly opened database).

So the top table's `FULL` is not the same promise as the Linux baseline's `FULL`. It looks 42x
faster because it is doing materially less work — it hands the bytes to the drive and returns. The
bottom table is the like-for-like comparison, and there A1-1's prediction is confirmed exactly:
**a real barrier on APFS costs 335 ev/s against Linux's 979 — roughly 3x slower per commit.**

Recording only the top four would have produced the sentence "FULL is nearly free on macOS", which
is true and useless, because the thing `FULL` is for is the case the top table does not cover.

**Decision: `synchronous = NORMAL`** — at darwin's default `fullfsync = 0` the `FULL` setting costs
3.3x and buys nothing extra against power loss (neither setting flushes the drive cache), and buying
the guarantee it is supposed to buy requires `fullfsync = 1` at 335 ev/s, which is 144x the cost of
`NORMAL` and far below the ledger's write path budget; so the daemon runs `NORMAL` globally, exactly
as [05-durable-execution.md §9.7](../05-durable-execution.md) already says, and the escape hatch it
describes — `FULL` for the single transaction that records an irreversible external effect — must
also set `fullfsync = 1` on macOS or it is decoration, at a price of about **3 ms per such commit**.

That last clause is new work for EPIC-03: the durable-execution document's middle-ground recipe is
incomplete on darwin as written.

## Measurement 3 — the pty install matrix (EPIC-00-S19)

`measurements/pty-matrix.json`. No compiler is present in any cell. Both packages **install** in
every cell with zero compilation; the column that separates them is whether the installed binary
then **loads**.

| Cell                        | Image                | glibc | better-sqlite3          | `@lydell/node-pty`      | Outcome  |
| --------------------------- | -------------------- | ----- | ----------------------- | ----------------------- | -------- |
| `macos-arm64-node24`        | host, Node 24.18.0   | —     | loads, 3.53.4           | `/dev/ttys002`, echoes  | **pass** |
| `macos-arm64-node26`        | host, Node 26.6.0    | —     | loads, 3.53.4           | `/dev/ttys002`, echoes  | **pass** |
| `linux-glibc-node24`        | `node:24-slim`       | 2.36  | **installs, will not load** | `/dev/pts/0`, echoes | **fail** |
| `linux-glibc-node26`        | `node:26-slim`       | 2.41  | loads, 3.53.4           | `/dev/pts/0`, echoes    | **pass** |
| `linux-musl-node24`         | `node:24-alpine`     | —     | loads, 3.53.4 (`linuxmusl-arm64`) | **installs, will not load** | **fail** |
| `linux-glibc-trixie-node24` | `node:24-trixie-slim` | 2.41 | loads, 3.53.4           | `/dev/pts/0`, echoes    | control, pass |

Two failures, and they fail differently.

### `linux-glibc-node24` — the ledger prebuild needs glibc 2.38

```
/lib/aarch64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
  (required by …/better-sqlite3/prebuilds/linux-arm64.node)
```

The install is clean and fast; the `dlopen` is what fails. The obvious reading — "Node 24 is broken
on Linux" — is wrong, and the control cell is in the matrix to prove it: `node:24-trixie-slim` is
the **same Node major on glibc 2.41** and loads the same prebuild without complaint. The variable is
the distribution, not the runtime. `node:24-slim` is Debian **bookworm** (glibc 2.36);
`node:26-slim` is **trixie** (2.41).

**Fallback taken — a documented prerequisite, not a workaround.** DeFlow's Linux support statement
is **glibc ≥ 2.38**: Debian 13 (trixie), Ubuntu 24.04 and later, or any musl distribution. Debian 12
and Ubuntu 22.04 (glibc 2.35) are **not** supported by `better-sqlite3@13.0.2` as pinned, and
`npx DeFlow up` will fail there at first ledger open, **not** at install — which makes the error
arrive late and read as a DeFlow bug. This is a real NF6 exposure, and it is the one finding here
that costs someone work later:

- **EPIC-01** should add a startup preflight that turns the raw `dlopen` failure into a sentence
  naming glibc and the supported floor, because the raw one blames a `.node` file the user has never
  heard of.
- **EPIC-18 (packaging)** should state the floor in the published README and `engines`-adjacent
  documentation. This does not contradict NF6 — nothing compiles — but "no toolchain required" and
  "runs anywhere" are different claims, and only the first one survived.

### `linux-musl-node24` — there is no musl build of the pty

`@lydell/node-pty@1.2.0-beta.14` declares six per-platform `optionalDependencies`
(`darwin-{x64,arm64}`, `linux-{x64,arm64}`, `win32-{x64,arm64}`) and **no musl variant at all**. On
Alpine, npm installs `@lydell/node-pty-linux-arm64` — its manifest carries `os` and `cpu` but no
`libc` field, so nothing stops it — and the load then fails. The package's own loader reports:

```
Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-arm64:
Error: Cannot find module './prebuilds/linux-arm64/pty.node'
```

which is **misleading**: the file is present. Dlopening it directly gives the real reason, and the
probe records it rather than the loader's version:

```
Error loading shared library ld-linux-aarch64.so.1: No such file or directory
  (needed by …/@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node)
```

It is a glibc-linked binary on a musl system. Anyone debugging this on a user's machine would
otherwise spend an afternoon looking for a missing file.

**Fallback taken — the no-TTY path, which was designed for exactly this.** No agent process needs a
TTY: ACP and every headless mode are pure pipe protocols, verified across five agents. A pty is
needed only for DeFlow's **own** ACP `terminal/*` implementation. So:

- `@lydell/node-pty` stays an `optionalDependency` with a plain-`spawn` fallback, so an unsupported
  platform degrades to no-TTY instead of failing to install;
- on musl, DeFlow **does not advertise the `terminal/*` client capability** during `initialize`;
- the capability is decided at runtime by attempting a pty allocation, never by a compiled-in
  platform list.

Note that better-sqlite3 is the opposite way round on this cell: it ships `linuxmusl-arm64.node`,
loads cleanly, and returns 3.53.4. Alpine is a supported ledger platform without a terminal.

### Upstream `node-pty@1.1.0` — why it is not used (AC7)

Its install script is `node scripts/prebuild.js || node-gyp rebuild`, and `scripts/post-install.js`
runs after it. The `||` is the problem: it is a silent fallback to compiling, and what happens
depends entirely on the platform.

| Platform             | `prebuilds/` has this platform? | Result                                                  |
| -------------------- | ------------------------------- | ------------------------------------------------------- |
| darwin-arm64         | **yes** (`darwin-{arm64,x64}`, `win32-{arm64,x64}`) | installs, node-gyp never runs      |
| every Linux cell     | **no** — it ships no Linux prebuild at all | `node-gyp` runs and the install **fails** |

So the story's "it was verified to fail outright in a toolchain-less environment" is confirmed —
**on Linux**, in all three container cells, with `gyp ERR!` in the log and a non-zero exit. It does
_not_ fail on the author's Mac, and that is precisely why the `||` is dangerous: the platform where
the maintainer would notice is the platform where it works. `@lydell/node-pty` has no install script
at all and resolves a prebuilt binary through `optionalDependencies`, which is the only shape that
can honour NF6.

`node-pty` is banned by a guard: `test/spike-s5-fsync.test.ts` fails if the unscoped package appears
in any workspace manifest or in the catalog.

## The risks this closes

From [roadmap §6](../17-roadmap.md), struck through as this spike closes them:

- ~~**A1-1** — All ledger benchmarks ran on Linux, likely overlayfs; macOS APFS uses `F_FULLFSYNC`
  and is typically slower.~~ Measured. A real barrier on APFS is 335 ev/s against Linux's 979, ~3x
  slower, and the default `fullfsync = 0` means `FULL` is not a barrier at all unless the pragma is
  set. `synchronous = NORMAL` confirmed, with a correction owed to §9.7's middle-ground recipe.
- ~~**A1-2** — better-sqlite3's 8 prebuilds were inspected but only linux-x64 was executed.~~
  Executed on darwin-arm64, linux-arm64 (glibc 2.41) and linuxmusl-arm64. All three return 3.53.4
  with FTS5 and `loadExtension`. The eighth-of-a-tarball claim is now four executed binaries and one
  hard prerequisite (glibc ≥ 2.38).
- ~~**A0-6** — `@lydell/node-pty` is `1.2.0-beta.14`, a beta of a community fork, and the only
  native dependency.~~ Bounded. Four of five cells allocate a working pty with zero compilation; the
  musl cell has no build and takes the designed no-TTY fallback. The monthly re-check for a stable
  release stays open — this closes "is it survivable", not "is it finished".

## What this spike does not answer

- **x64.** Every container here is `linux/arm64`, because the docker host is Apple Silicon. The
  `linux-x64` prebuild was executed on 2026-08-02 and the `linuxmusl-x64` one has still never run.
  The glibc floor is a property of how the binary was linked, not of the architecture, so
  `linux-x64` on bookworm is expected to fail the same way — expected, not measured.
- **Windows.** NF5 puts it at M3.
- **Cold npm cache.** The install timings are with the machine's normal npm cache warm, which is
  what a developer has. A first-ever install additionally pays the download; that is a network
  measurement, not a toolchain one.
- **Whether the ledger is fast enough.** This measures appends in isolation. The scheduler, the
  projections and the SSE tail are EPIC-03's problem.
