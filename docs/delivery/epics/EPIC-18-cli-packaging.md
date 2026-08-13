# EPIC-18: CLI, doctor and packaging

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-18-cli-packaging-flows.md)

|                      |                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-18                                                                                                                                                                                                                                                                                |
| **Status**           | Not started                                                                                                                                                                                                                                                                            |
| **Priority**         | P0                                                                                                                                                                                                                                                                                     |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                     |
| **Workstream**       | W12 (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                          |
| **Size**             | ~22 days across 9 stories — over the ~15-day guidance; see Risks                                                                                                                                                                                                                       |
| **Depends on**       | EPIC-15 (the HTTP server, `hc<ApiType>` and the stream module the CLI imports unchanged), EPIC-03 (migrations, the `flock` lease, `daemon_epoch`), EPIC-05 (the capability probe and the conformance battery `doctor` runs), EPIC-01 (the workspace, the build scripts, the CI matrix) |
| **Blocks**           | Formally nothing. In practice **KAR-18.3 gates EPIC-17**: [roadmap §2.3](../../17-roadmap.md) says do not start W11 until at least one full run completes headlessly through W12's CLI, because a run you can drive from a terminal is a run you can record a fixture from             |
| **PRD requirements** | F1.1, F3.4, F3.5, F3.6, F3.8, F4.4, F5.4, F5.7, NF1, NF3, NF5, NF6, NF8, AR-1                                                                                                                                                                                                          |
| **Architecture**     | [03-local-development.md §1, §8, §9, §10](../../03-local-development.md), [16-repo-layout.md §2, §6, §7](../../16-repo-layout.md); consumes [11-api-and-realtime.md §8, §9](../../11-api-and-realtime.md) and [15-security-model.md §2.3, §3.2](../../15-security-model.md)            |

## Goal

At the end of this epic DeFlow is a thing a person installs and runs, rather than a repository they
clone. `npx DeFlow init` bootstraps a target repo, `npx DeFlow up` brings the daemon to a browser in
under three seconds, `npx DeFlow run "…"` drives a complete run to a terminal without a browser at
all, and `npx DeFlow doctor` tells the truth about what this specific machine can and cannot do
before any quota is spent on finding out. The published artefact is **one** npm tarball with one
native dependency, and its correctness is proved by installing the real bytes into an empty
directory and running them — not by a green `pnpm dev`.

## Why this matters

Three separate things converge here, and each one fails silently if it is skipped.

**NF6 is the adoption argument.** "Single-binary-ish install: `npx DeFlow up`. No database server,
no Docker requirement for the core." M2's definition of done is _a colleague installs it unaided and
finishes a real task_ — and the author is the first test subject. Everything in the repo layout that
looks like fussiness (exactly one published package, `noExternal: [/^@DeFlow\//]`, UI assets as
plain files, `@lydell/node-pty` as the only native survivor) exists to make that one command work on
a machine with no compiler.

**`doctor` is where AR-5 becomes real.** Provider capability is probed at runtime and persisted,
never hardcoded — _"a hardcoded matrix is wrong within a month"_, and the research's own snapshot
had two of five agent versions published the same day they were probed. `doctor` is the command
that regenerates it. It is also the only place the environment's silent failures are made loud:
Claude Code's sandbox **falls back to running unsandboxed** when bubblewrap or socat are missing,
which makes the F5.4 permission ladder decorative; and `ANTHROPIC_API_KEY` **silently shadows
subscription auth**, whose failure mode is _"you thought you were on your subscription and you were
being billed"_. Neither condition raises an error anywhere else in the system. If `doctor` does not
catch them, nothing does.

**The tarball is a different program from the workspace.** In development `@DeFlow/core` resolves to
`./src/index.ts` through a pnpm symlink; in the tarball it resolves to inlined bundle output. A
`paths` alias, a deep cross-package import, or a missing `files` entry is invisible from inside the
monorepo and fatal outside it — _"a missing `files` entry that drops `dist/ui/`, so the daemon starts
and serves a blank page"_ is the named classic. KAR-18.6 exists because that class of bug is only
observable from a clean temp directory.

## Scope

**In scope:**

- `DeFlow init`: the committed half of `.DeFlow/` (`config.yaml`, `gates/`, `templates/`, `memory/`,
  `.worktreeinclude`), the gitignored half (`daemon.json`, `wt/`, `runs/`), the `.gitignore` append,
  and a first provider detection pass whose result lands in the **global** probe cache, never in the
  committed config.
- `DeFlow up`: the eight-step boot sequence of [03 §9](../../03-local-development.md) — resolve
  directories, open and migrate the ledger behind a `VACUUM INTO` backup, take the `flock` on
  `<dataDir>/DeFlow.lock` and bump `daemon_epoch`, probe providers from cache, pick port 7777 or the
  next free one, generate the 32-byte token, write `.DeFlow/daemon.json` at mode `0600`, bind
  `127.0.0.1` and print `http://127.0.0.1:<port>/#token=<token>` — plus graceful shutdown, orphan
  reaping and the NF3 cold-start budget.
- `DeFlow run`: headless execution against the same daemon, consuming `hc<ApiType>` and
  `eventsource-client` through the **identical** modules the browser imports; detached daemon
  autostart; detach-vs-cancel on Ctrl-C; `?since=<seq>` resume, because a Node client has no
  `Last-Event-ID` mechanism at all; a documented exit-code table; `--json` NDJSON for CI.
- `DeFlow doctor`: runtime, git, sandbox prerequisites, installed agents and versions, the
  regenerated capability matrix, the F3.4 conformance battery, auth shadowing, PTY availability,
  writable state directories and the memory-layer report. `--json` and a stable exit-code contract.
- Packaging: the fixed build order, `tsdown@0.22.14` with `@DeFlow/*` inlined and
  `@lydell/node-pty` external, `dist/ui/` as plain files resolved through
  `fileURLToPath(new URL('./ui', import.meta.url))`, `files: ["dist"]`, and `publint@0.3.22` +
  `@arethetypeswrong/cli@0.18.5` as `pnpm pack:check`.
- Clean-room install verification: `pnpm pack`, `mktemp -d`, `git init -b main`,
  `npx /path/DeFlow-0.1.0.tgz up`, a real mock-agent run through the installed bytes, on macOS and
  Linux.
- `DeFlow ledger snapshot` and `DeFlow status` — the two diagnostics that make a solo builder's
  post-mortems possible (added story, see KAR-18.7).
- Distinguishing an absent **vendor CLI** from an absent **ACP adapter** in `doctor`'s Agents
  section, and offering — on confirmation, or under `--fix` — to install the adapter for a vendor CLI
  that is actually on the machine (added story, see KAR-18.8).
- One presentation layer — glyphs, colour, section headings, column alignment, wrapping and a summary
  block — shared by every command that prints a report, with the `--json` documents unchanged (added
  story, see KAR-18.9).

**Out of scope:**

- **`DeFlow replay`.** The replay daemon mode is [EPIC-16](./EPIC-16-ui-foundation.md) KAR-16.5; this
  epic only registers the subcommand and its argv, and asserts it reaches the same HTTP contract.
- **The HTTP surface itself** — routes, the SSE frame contract, bearer auth and origin validation are
  [EPIC-15](./EPIC-15-daemon-api.md). This epic is a _client_ of them, and the producer of the token
  file EPIC-15 reads and the `/api/health` endpoint it polls.
- **The capability probe and the conformance battery implementations** —
  [EPIC-05](./EPIC-05-provider-adapters.md) KAR-05.2 and KAR-05.7. `doctor` invokes them and renders
  their output; it does not define them.
- **The lease, `daemon_epoch` and migrations** — [EPIC-03](./EPIC-03-event-ledger.md) KAR-03.2 and
  KAR-03.7. This epic drives them from a CLI and owns the operator-facing behaviour when they refuse.
- **Windows.** NF5 puts it at M3. `DeFlow doctor` must _say so_ rather than fail obscurely, and
  `killTree()` stays behind a port (roadmap A0-10), but no Windows code path is built here.
- **Secret redaction on exports** (F5.9) — M2. `doctor` reports the secretlint rule count, which is
  legitimately `0` at M1, and no command in this epic exports anything shareable.
- **Installing a vendor CLI itself, and installing anything without consent.** KAR-18.8 installs one
  thing — the ACP adapter package of a vendor CLI already present on the machine — and only after a
  confirmation or an explicit `--fix`. Acquiring `claude`, `codex` or `gemini` on the operator's
  behalf, choosing their package manager for them, or repairing anything else under a general "fix
  my machine" flag is not in this epic and needs its own argument.
- **A TUI.** KAR-18.9 is line-oriented output that survives a pipe, `NO_COLOR` and a dumb terminal.
  Full-screen rendering, progress spinners and alternate-screen redraw are neither needed by NF6 nor
  compatible with the `--json`/CI path, and are not proposed anywhere.
- **A desktop shell, a login item, an installer, code signing or auto-update.** M3 at the earliest
  (PRD §6.3); the whole point of the daemon shape is that M1 pays none of that cost.
- **Publishing to npm.** `npm version patch && pnpm publish` is two commands precisely because
  [16 §2](../../16-repo-layout.md) deleted the multi-package release problem. It needs no story.
- **Driving a submitted run to completion** — and therefore the completion half of **KAR-18.6 AC2**
  (_"a scripted multi-node run completes … and exits 0"_) and of KAR-18.3's EPIC-18-S18. It lives in
  [EPIC-19](./EPIC-19-live-run-pipeline.md), over the intake→spec→plan path of
  [EPIC-10](./EPIC-10-task-intake.md) KAR-10.2 and
  [EPIC-11](./EPIC-11-dynamic-planning.md). This epic is a _client_ of the daemon; it submits runs and
  reports what the daemon says about them, and every criterion here that assumed a run reaching a
  terminal state is amended in place rather than asserted away (see KAR-18.6 AC2's amendment, the
  epic's Definition of Done, and `test/run-completion-deferral.test.ts`, which fails the day a
  shipped source compiles a plan or executes a run — so the cut cannot outlive its reason).

  **Narrowed 2026-08-12 by KAR-19.1**, and recorded here rather than absorbed
  ([README §9](../README.md#9-changing-the-plan)). `RECOVERY_STEPS`' eighth step, `start-ticker`, is
  now performed: `boot()` starts the ticker, intake writes a framing `node_wake` in the same
  transaction as `task.submitted`, and the driver consumes it.

  **Closed 2026-08-13 by [EPIC-19](./EPIC-19-live-run-pipeline.md) KAR-19.3, KAR-19.4 and
  KAR-19.5.** A shipped path now carries a submitted run all the way: `run-chain.ts` frames, gates,
  pins, surveys and compiles; `run-execution.ts` and `live-nodes.ts` execute; and both composition
  roots — `packages/cli/src/up.ts` and `packages/daemon/src/main.ts` — bind `runFraming`,
  `advanceRun` and `executeNodes`. `e2e/smoke/live-run.test.ts` drives `DeFlow init` then
  `DeFlow run --file` against the **built binary** on a `PATH` holding only `DeFlow-mock-agent` and
  asserts `task.submitted → run.created → plan.proposed → node.started → node.completed →
  run.completed` with exit 0. `test/run-completion-deferral.test.ts` was deleted by KAR-19.4 when it
  went red, exactly as its own instructions said it should be, and the deferral it guarded is
  therefore spent rather than merely narrowed.

## Definition of Ready (epic level)

- [ ] EPIC-15 is Done: `/api/health` answers unauthenticated, `hc<ApiType>` and
      `packages/web/src/api/stream.ts` exist and are importable from `packages/cli`.
- [ ] EPIC-03 KAR-03.2 and KAR-03.7 are Done: `PRAGMA user_version` migrations with the
      pre-migration backup, and the `flock` + `daemon_epoch` lease.
- [ ] EPIC-05 KAR-05.2 and KAR-05.7 are Done: the capability probe writes a manifest, and the
      conformance battery is invocable as a function rather than only as a test.
- [ ] EPIC-04 is Done: `DeFlow-mock-agent` is a real bin, so every scenario in the flow file can run
      with no vendor CLI installed.
- [ ] M0-S6 has produced a `@lydell/node-pty` install matrix, so KAR-18.4's PTY check and KAR-18.6's
      no-compiler assertion have a known-good baseline to assert against.
- [ ] A `DeFlow-0.0.0` version number and an npm package name are settled well enough to pack. (The
      name is PRD §15.6, still open — packing does not require publishing.)

## Definition of Done (epic level)

- [ ] All nine stories are Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-18-cli-packaging-flows.md) is automated at the
      level it declares and passes on `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] `npx <packed tarball> up` in a `mktemp -d` clean room serves the UI and completes a mock run,
      and this is wired as a CI job — not a checklist item someone remembers.
      _(2026-08-12: the CI job exists — `verify-install` in `.github/workflows/ci.yml`, both runner
      images, on every tag and on demand — and the clean room serves the UI and drives real ACP
      turns against the installed mock agent. 2026-08-13, EPIC-19 KAR-19.5: **a run now completes**
      — `executeNodes` is bound in both composition roots, and `DeFlow run --file` against the built
      binary on a `PATH` holding only `DeFlow-mock-agent` reaches `run.completed` and exits 0
      (`e2e/smoke/live-run.test.ts`, and performed by hand against the packed `dist/bin.mjs`). What
      this item still asks for and does not yet have is that run **inside the clean room**: the
      smoke test runs `packages/cli/dist`, not the installed tarball. See KAR-18.6 AC2's
      amendment.)_
- [ ] `DeFlow doctor` on a machine with **no agent CLI installed** exits 0, names what to install,
      and reports which permission levels are honourable — with no stack trace and no empty section.
- [ ] `DeFlow doctor` never reports a provider as _not installed_ while that vendor's own CLI
      resolves on `PATH`: the three states of KAR-18.8 AC1 are what the Agents section reports, and
      an operator with `claude` installed and no bridge is told the bridge is what is missing.
- [ ] Every command that prints a report prints it through the one presentation layer (KAR-18.9
      AC1), a piped run of each contains no ANSI byte, and every `--json` document is byte-identical
      to the golden captured before that story.
- [ ] The capability matrix is a generated fixture file in the repository with a probe timestamp;
      `grep` finds no hardcoded capability constant in `packages/cli` or `packages/adapters`.
- [ ] Cold start measured on the author's own laptop is under 3 s (NF3), reported by `DeFlow up
    --timings`, and the number is written into the epic's Notes rather than assumed.
- [ ] No `Unverified` claim in [03 §9–§10](../../03-local-development.md) or
      [16 §2](../../16-repo-layout.md) that this area depends on is still unverified — specifically
      roadmap **A0-6** (`@lydell/node-pty` beta coverage) is either closed by M0-S6's matrix or
      carries an explicit no-TTY fallback that KAR-18.4 reports and KAR-18.6 exercises.

## User stories

### KAR-18.1 — `DeFlow init` workspace bootstrap

|                 |                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                               |
| **Priority**    | P0                                                                                                                        |
| **Size**        | S                                                                                                                         |
| **Depends on**  | EPIC-02 KAR-02.8 (the config schema `config.yaml` validates against), EPIC-05 KAR-05.2 (the probe whose cache init warms) |
| **PRD**         | F1.1, NF6, NF8                                                                                                            |
| **Verified by** | EPIC-18-S1, EPIC-18-S2, EPIC-18-S3, EPIC-18-S4, EPIC-18-S5, EPIC-18-S6                                                    |

**As** an engineer adopting DeFlow on a repository, **I want** one command that makes the repo
DeFlow-aware without polluting it, **so that** the committed half of the configuration is reviewable
in a pull request and the machine-local half never lands in git.

`.DeFlow/` has two halves and [16 §7.1](../../16-repo-layout.md) is explicit that they are not
interchangeable. `config.yaml`, `gates/`, `templates/`, `memory/` and `.worktreeinclude` are **team
artefacts**: they travel with the repo and they are how a colleague's DeFlow behaves the same as
yours. `daemon.json`, `wt/` and `runs/` are per-machine and must be appended to `.gitignore` by
`init` itself, because the first person to commit a `daemon.json` commits a bearer token. Provider
detection runs here (PRD §6.3: _"detect providers, create `.DeFlow/`"_) but its result belongs in the
**global** probe cache under `$XDG_DATA_HOME/DeFlow`, not in the committed config — a committed
capability list is exactly the hardcoded matrix AR-5 forbids.

**Acceptance criteria**

1. In a git repository with no `.DeFlow/`, `DeFlow init` creates `config.yaml`, `gates/`,
   `templates/`, `memory/` and `.worktreeinclude`, and appends `.DeFlow/daemon.json`,
   `.DeFlow/wt/` and `.DeFlow/runs/` to the repository's `.gitignore`.
2. The generated `config.yaml` validates against the emitted JSON Schema in `.DeFlow/schemas/`
   (EPIC-02 KAR-02.8) and contains no provider capability claims — only provider _selection_ and
   policy.
3. Re-running `init` is idempotent: an edited `config.yaml` is never overwritten, `.gitignore`
   entries are never duplicated, and the command reports per-path `created` / `unchanged` /
   `kept (edited)` and exits 0.
4. Outside a git working tree the command refuses with
   `DeFlow init: not inside a git working tree (run 'git init' first)` and exits 5. It does not
   create a partial `.DeFlow/`.
5. `init` resolves and creates the global state directory (`$XDG_DATA_HOME/DeFlow`, else
   `~/.DeFlow`) and reports its absolute path. If it is not writable, the failure names the exact
   path and the errno, and exits 5.
6. `init` runs a provider detection pass and prints what it found — or, on a machine with no agent
   CLI at all, prints the install hints and still exits 0. The result is written only under the
   global state directory.

**Test plan (TDD)** — write these tests first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                                                  | Red when                                                                                                                   |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | The `.gitignore` merge function appends only missing lines, preserves a file with no trailing newline, and is a fixpoint on second application                                                                        | The function appends unconditionally, so a second `init` duplicates three lines                                            |
| 2   | integration | `init` into an `fs.mkdtemp` repo created by real `git init -b main` with `GIT_CONFIG_GLOBAL=/dev/null` and forced identity env; assert the created tree with `toMatchFileSnapshot` through the normalising serializer | Nothing writes `.worktreeinclude`; the snapshot has an absolute tmpdir path in it because the serializer is not registered |
| 3   | integration | `init` twice, editing `config.yaml` between runs; assert the edit survives and stdout says `kept (edited)`                                                                                                            | The writer is unconditional and clobbers the edit                                                                          |
| 4   | integration | `init` in a plain `mkdtemp` directory with no `.git`                                                                                                                                                                  | It creates `.DeFlow/` anyway and exits 0                                                                                   |
| 5   | integration | `init` with `XDG_DATA_HOME` pointed at a `chmod 0500` directory                                                                                                                                                       | The EACCES escapes as a stack trace instead of a typed failure naming the path                                             |
| 6   | integration | `init` with an empty temp `PATH` (no mock agent linked in)                                                                                                                                                            | It throws, or reports an empty section, instead of printing install hints and exiting 0                                    |

---

### KAR-18.2 — `DeFlow up` daemon lifecycle

|                 |                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                                                |
| **Priority**    | P0                                                                                                                                         |
| **Size**        | L                                                                                                                                          |
| **Depends on**  | KAR-18.1, EPIC-03 KAR-03.2 and KAR-03.7, EPIC-15 KAR-15.1 and KAR-15.2                                                                     |
| **PRD**         | NF3, NF6, F4.4, AR-1                                                                                                                       |
| **Verified by** | EPIC-18-S7, EPIC-18-S8, EPIC-18-S9, EPIC-18-S10, EPIC-18-S11, EPIC-18-S12, EPIC-18-S13, EPIC-18-S14, EPIC-18-S15, EPIC-18-S16, EPIC-18-S17 |

**As** an engineer, **I want** `DeFlow up` to bring the daemon to a browser tab in one step and to
refuse clearly when it cannot, **so that** the two things people actually do wrong — launching twice
and colliding on a port — produce a sentence rather than a corrupted run.

This story implements the eight numbered steps in [03 §9](../../03-local-development.md) as one
sequenced boot, and owns the operator-facing behaviour of each refusal. The lease is the interesting
one: a second `npx DeFlow up` in another terminal is described in the architecture as _"very
common"_, and two schedulers over one SQLite file will interleave effect execution even though
SQLite itself enforces one writer. The `flock` on `<dataDir>/DeFlow.lock` plus the `daemon_epoch`
bump is what stops it, and this story is where a human first meets that mechanism. The migration
backup — `VACUUM INTO`, **measured at 1007 ms for a 193 MB database** — runs before `user_version`
moves, and SQLite's transactional DDL means a failed migration rolls back cleanly, so the correct
behaviour on migration failure is to refuse to serve rather than to serve a half-migrated ledger.

**Acceptance criteria**

1. `DeFlow up` in an initialised repo binds `127.0.0.1`, prints
   `http://127.0.0.1:<port>/#token=<token>`, writes `.DeFlow/daemon.json` as
   `{ pid, port, token, startedAt }` at mode `0600`, and opens the browser. The token is 32 bytes
   from `crypto.randomBytes`, base64url.
2. Cold start is under 3 s (NF3) on the author's machine with a warm probe cache;
   `DeFlow up --timings` prints per-step milliseconds for the eight steps so the budget is
   measurable rather than asserted.
3. A second `DeFlow up` while a live daemon holds the lease exits 2 with
   `DeFlow up: another DeFlowd is already running (pid <pid>, port <port>) — open <url> or run 'DeFlow status'`.
   It does not bump `daemon_epoch` and it does not touch `daemon.json`.
4. If port 7777 is occupied, the daemon binds the next free port via `get-port`, and the printed
   URL, `daemon.json` and `DeFlow status` all agree on it. With an explicit `--port` that is
   occupied, the command exits 2 and names the port rather than silently choosing another.
5. Before any migration runs, a `pre-migrate-<user_version>.db` backup exists in the global state
   directory. If a migration fails, the ledger is left at the old `user_version`, the daemon exits
   non-zero, and no HTTP listener was ever bound.
6. A `daemon.json` left behind by a SIGKILLed daemon does not block startup: the lease is acquired,
   orphaned children are reaped by matching `(pid, process_start_time)` — never a bare pid, because
   pids are recycled — and `git worktree unlock` runs for any worktree whose owning process is gone.
7. On SIGINT/SIGTERM the daemon releases the `flock`, removes `.DeFlow/daemon.json`, and terminates
   its child process group; a subsequent `DeFlow up` starts cleanly with no manual intervention.
8. On a machine with no agent CLI installed, `DeFlow up` still starts, reports zero available
   providers with install hints, and the daemon refuses to _schedule_ agent nodes rather than
   failing at boot (NF7).
9. `DeFlow up` reads no credential file and captures no auth-command output (AR-1); the assertion is
   a test, not a promise.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                            | Red when                                                                                               |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | e2e         | Boot a real `DeFlowd` on an ephemeral port in a `mkdtemp` repo with the mock agent on a temp `PATH`; `GET /api/health` answers unauthenticated and every other route 401s                       | Boot completes before the token file is written, so the CLI's own first authenticated request races it |
| 2   | e2e         | Boot twice against the same data dir from two child processes; assert the second exits 2 with the pid/port sentence and `daemon_epoch` is unchanged                                             | The lease is advisory-only or is taken after the first ledger write, so both daemons bump the epoch    |
| 3   | integration | Bind a socket to 7777 first, then boot; assert the URL, `daemon.json` and `/api/health` all report the same non-7777 port                                                                       | The port is chosen once and re-derived elsewhere from the constant                                     |
| 4   | integration | Seed a file-backed ledger at `user_version = N-1` with a deliberately failing migration; assert `pre-migrate-<N-1>.db` exists, `user_version` is unchanged, and no listener bound               | A `:memory:` database was used, so the backup and the reopen-after-failure path are untestable         |
| 5   | integration | Write a `daemon.json` whose pid is a live unrelated process with a different start time; assert boot proceeds and does not kill it                                                              | Reaping matches on bare pid and kills an innocent process                                              |
| 6   | e2e         | Send SIGINT to a booted daemon that has a mock agent child alive; assert the lease file is unlocked, `daemon.json` is gone, and no process remains in the group **excluding `Z`-state entries** | The kill-verification assertion counts zombies and reports a false negative                            |
| 7   | integration | Boot with an empty temp `PATH`; assert exit 0, zero providers, install hints on stdout                                                                                                          | Provider probing throws on a missing binary instead of recording absence                               |
| 8   | unit        | An AR-1 guard: the boot module's import graph and source contain no read of `~/.claude`, `~/.codex`, `ANTHROPIC_API_KEY` or any `*_TOKEN` env var                                               | Someone "helpfully" forwards an env var into the daemon's own environment                              |

**Notes / risks** — steps 2 (migrate) and 4 (probe) are the two that can blow the NF3 budget; the
probe cache is refreshed on a version change, not on every start. `--timings` exists so that the
first time cold start regresses, the cause is one line of output rather than an afternoon.

> **Cold start measured 2026-08-11 while implementing this story** (author's machine, macOS 26,
> Node 26, one agent binary on `PATH`, empty data directory, `DeFlow up --timings --no-open`),
> in milliseconds:
>
> | step             | first start (cold probe cache) | second start (warm) |
> | ---------------- | ------------------------------ | ------------------- |
> | pick-port        | 8                              | 8                   |
> | resolve-data-dir | 1                              | 0                   |
> | lease            | 2                              | 1                   |
> | migrate          | 7                              | 6                   |
> | reap-orphans     | 1                              | 1                   |
> | probe-providers  | **441**                        | **8**               |
> | bind-port        | 1                              | 2                   |
> | open-browser     | 0                              | 0                   |
> | **total**        | **461**                        | **26**              |
>
> NF3's budget is 3000 ms and the warm number is 26. The prediction in this section held exactly:
> the probe is 96% of a cold start and 31% of a warm one, and everything else together is under
> 20 ms. The numbers are from the source tree (`node packages/cli/src/bin.ts up`), so they exclude
> Node's own startup and the difference between running `src/` and the bundled `dist/bin.mjs`;
> KAR-18.6 measures the tarball.
>
> Two amendments this story made to code it did not own, both recorded where they were made:
> `migrate()` now removes an existing `pre-migrate-<v>.db` before `VACUUM INTO` (SQLite refuses an
> existing output file, which made the "fix the migration and boot again" half of EPIC-18-S12
> impossible), and `packages/cli/test/integration/build.test.ts` now distinguishes static from
> dynamic specifiers, because `DeFlow up` reaches `startHttp` and its unevaluated
> `import('vite')` — the shape `tsdown.config.ts` deliberately produces — now survives into a chunk.

---

### KAR-18.3 — `DeFlow run` headless execution

|                 |                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Done — see the amendment under the acceptance criteria                                                                    |
| **Priority**    | P0                                                                                                                        |
| **Size**        | M                                                                                                                         |
| **Depends on**  | KAR-18.2, EPIC-15 KAR-15.3/KAR-15.4/KAR-15.5, EPIC-10 KAR-10.1 (intake), EPIC-06 KAR-06.7 (pause/resume/cancel as events) |
| **PRD**         | F1.1, F4.4, F5.7, NF6                                                                                                     |
| **Verified by** | EPIC-18-S18, EPIC-18-S19, EPIC-18-S20, EPIC-18-S21, EPIC-18-S22, EPIC-18-S23, EPIC-18-S24, EPIC-18-S25                    |

**As** an engineer, **I want** to start and watch a whole run from the terminal, **so that** a run
exists to record a fixture from before any view is built, and so that DeFlow is usable over SSH and
in CI without a browser.

The design constraint is that there is **no second protocol implementation**.
[11 §9](../../11-api-and-realtime.md) is explicit: `eventsource-client` runs in Node, so
`DeFlow run "…"` consumes the identical stream through the identical
`packages/web/src/api/stream.ts` module, rendering to a terminal instead of to Vue Flow. That also
means the CLI has **no `Last-Event-ID` mechanism at all** — a Node client's reconnect is its own
code — so `?since=<seq>` is its only resume path, which is the same mandatory path the browser needs
after a page reload. The second design decision is process shape: the autostarted daemon is spawned
**detached**, so Ctrl-C at the CLI detaches the viewer and never kills an hours-long run. Because
that is surprising, the first Ctrl-C must say what it did and how to cancel.

**Acceptance criteria**

1. `DeFlow run "<task>"` with no daemon running autostarts `DeFlowd` detached, waits on
   `GET /api/health`, creates the run, and streams node lifecycle to the terminal until a terminal
   state.
2. With a daemon already up, `DeFlow run` attaches to it — it never starts a second daemon and never
   trips the lease.
3. The first Ctrl-C **detaches**: it prints
   `detached — run <runId> continues; 'DeFlow run --attach <runId>' to watch, 'DeFlow cancel <runId>' to stop`
   and exits 130. A second Ctrl-C within 3 s cancels the run, which appends `run.aborted` and
   triggers the F5.7 kill switch.
4. Killing the CLI does not kill the daemon or any agent child, because the daemon was spawned
   detached and is not in the CLI's process group.
5. If the stream drops mid-run, the CLI reconnects with `?since=<lastSeq>` and the rendered
   transcript contains every event exactly once — no gap and no duplicate — including across a
   deliberate sequence gap (rolled-back transactions burn `AUTOINCREMENT` values; the contract is
   _strictly greater than `seq`_, never `seq + 1`).
6. Exit codes are a documented closed set: `0` completed with all gates passed, `1` completed with a
   failed gate or a failed node, `2` daemon lifecycle refusal, `3` paused on a budget ceiling, `4`
   waiting on a human gate under `--no-wait`, `5` environment unusable, `130` interrupted.
7. `--json` (and any non-TTY stdout) emits one JSON object per line with no ANSI escapes, suitable
   for piping; `--json` and the human renderer are two renderers over one event stream, not two
   clients.
8. Intake accepts free text, `--file <path>`, `--issue <ref>` and `--spec <path>` (F1.1), and each
   is recorded in `task.submitted`'s provenance so the run's source is inspectable on disk (NF8).
   (`run.created` carried this until 7 August 2026; the locator lives on the intake event now —
   `KAR-10.1` AC2.)

> **Amended 2026-08-11 while implementing KAR-18.3.** Two clauses above describe a run that
> executes, and this repository has no code path that executes one: nothing calls `compilePlanV1`
> or `executeRun`, `boot()` starts no ticker, and `POST /api/runs` stops at `task.submitted` by
> design (KAR-10.1: _"No interpretation happens here"_). Every submitted run therefore parks after
> intake. (**Narrowed 2026-08-12 by KAR-19.1**, which started the ticker and scheduled framing, and
> again **2026-08-13 by KAR-19.3**, whose run chain frames, pins, surveys and compiles a
> `PlanGraph`. One call is still missing — `executeRun` — and it is the whole of why a run still
> reaches no terminal state.) What that changes here:
>
> - **AC1's "streams node lifecycle … until a terminal state"** is implemented and asserted for
>   every terminal state the ledger can currently reach (an open human gate under `--no-wait`, an
>   abort, a completion appended by a spec through the daemon's own functions). The four-node
>   plan running to `run.completed` is not reachable and is **not** faked; `e2e/run.test.ts`
>   carries the deferral and the epic's DoD keeps it open.
> - **AC3's second Ctrl-C** cancels through the daemon's own routes — `POST /runs/:id/cancel`,
>   falling back to `POST /runs/:id/spec/abandon` when the daemon answers `spec_not_approved`,
>   because KAR-15.5 AC6 forbids controlling a run whose spec is not approved. A run that has not
>   been framed at all can be stopped by **neither** route (the gate is not open either), which is a
>   real hole in the daemon's write surface rather than in this command; it is recorded as a
>   follow-up on `MET-418` rather than patched from the CLI. **That follow-up is now
>   [KAR-19.6](./EPIC-19-live-run-pipeline.md), added 2026-08-12** — which also builds
>   `DeFlow cancel <runId>`, the command AC3's own detach sentence has printed since this story
>   shipped and which has never existed.
> - **AC8's `--spec`** produces the `file` wire kind, not a fourth one. KAR-10.1 settled that
>   (`@DeFlow/core`'s `task-intake.ts`: _"a spec document is the `file` kind with its own
>   `mediaType` in provenance — there is no fourth shape"_), and the locator — which is what makes
>   the source inspectable six weeks later — is recorded either way.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                     | Red when                                                                                        |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | e2e         | With no daemon, run a scripted 4-node mock plan to completion through `DeFlow run`; assert exit 0 and the rendered transcript against a file snapshot through the normalising serializer | The CLI polls `/api/health` with the bearer header before the token file exists and 401s itself |
| 2   | e2e         | Start a daemon, then `DeFlow run`; assert `daemon_epoch` did not change and only one pid holds the lease                                                                                 | Autostart is unconditional                                                                      |
| 3   | integration | Send SIGINT to the CLI child while the mock agent is mid-turn; assert exit 130, the detach sentence on stdout, and that the run reaches `run.completed` afterwards                       | The daemon was spawned in the CLI's process group and dies with it                              |
| 4   | integration | Send SIGINT twice within 3 s; assert `run.aborted` in the ledger and no non-`Z` process left in the agent's process group                                                                | The kill check counts zombie grandchildren and reports failure                                  |
| 5   | integration | Drop the SSE socket at a scripted point using the `crash-resume-seq-gap` fixture; assert the reconnect used `?since=` and the event set is exactly equal, gap included                   | The client assumes `seq + 1` and reports data loss on a healthy gap                             |
| 6   | unit        | `Scenario Outline` over terminal states → exit codes, driven by a table of reduced `RunState` values                                                                                     | Exit code is derived at three call sites and they disagree on `paused`                          |
| 7   | integration | `DeFlow run --json` with stdout piped to a file; assert every line parses and no line contains `[`                                                                                       | The renderer detects TTY once at import and colours the JSON path                               |
| 8   | integration | Intake outline over text / `--file` / `--issue` / `--spec`; assert the `task.submitted` payload's provenance records source kind and locator                                             | `--file` inlines the content and loses which file it came from                                  |

**Notes / risks** — [roadmap §2.3](../../17-roadmap.md) makes this story a prerequisite for the view
work: _"Do not start W11 until at least one full run completes headlessly."_ The fixtures in
[03 §6.2](../../03-local-development.md) — `happy-path-12.jsonl`, `three-patches.jsonl`,
`gate-fail-repair.jsonl`, `compaction.jsonl`, `crash-resume.jsonl`, `stress-400.jsonl` — are
**recorded from real mock-agent runs driven through this command**, never hand-written.

---

### KAR-18.4 — `DeFlow doctor` environment and capability probe

|                 |                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                             |
| **Priority**    | P0                                                                                                                                                                                      |
| **Size**        | L                                                                                                                                                                                       |
| **Depends on**  | KAR-18.1, EPIC-05 KAR-05.2 (probe) and KAR-05.7 (conformance battery), EPIC-08 KAR-08.5 (vendor sandbox policy) and KAR-08.8 (auth shadowing), EPIC-09 KAR-09.7 (tokenizer calibration) |
| **PRD**         | F3.4, F3.5, F3.6, F3.8, F5.4, NF1, NF5, AR-1, AR-5                                                                                                                                      |
| **Verified by** | EPIC-18-S15, EPIC-18-S26, EPIC-18-S27, EPIC-18-S28, EPIC-18-S29, EPIC-18-S30, EPIC-18-S31, EPIC-18-S32, EPIC-18-S33, EPIC-18-S34, EPIC-18-S35, EPIC-18-S36                              |

**As** an engineer, **I want** one command that reports exactly what this machine can do, **so that**
an environment problem costs thirty seconds at the start rather than three hours into a real run.

`doctor` is the project's health check and the single place several silent failures become loud. It
covers eight categories, taken from [03 §8](../../03-local-development.md):

- **Runtime** — Node `>= 24`, pnpm version, a writable global state dir
  (`$XDG_DATA_HOME/DeFlow` or `~/.DeFlow`) and a writable repo-local `.DeFlow/`.
- **git** — `git --version` `>= 2.38` (hard: `merge-tree --write-tree` is the D14 conflict ground
  truth), `>= 2.45` preferred (`worktree list --porcelain -z` output stabilised there), and
  `merge-tree --write-tree` actually executed rather than inferred from the version string.
- **Sandboxing** — Linux: `bwrap` and `socat` on PATH, and
  `sysctl kernel.apparmor_restrict_unprivileged_userns` (a `1` means bubblewrap is blocked on Ubuntu
  24.04+ and the sandbox **silently fails open**). macOS: Seatbelt. Output is the list of F5.4
  permission levels that are _honourable on this machine_.
- **Agents** — which vendor binaries are installed, their **absolute resolved paths** (DeFlowd's
  `PATH` at daemon start differs from the login shell's), `--version` output, and a sha256 of the
  entry file (F3.6), recorded so drift between runs is a warning rather than a silent failure.
- **Capabilities** — a real ACP `initialize` against each, persisted. The matrix is **derived, never
  hardcoded** (AR-5); the 2026-08-02 snapshot — `claude-agent-acp@0.64.1`, `codex-acp@1.1.9`,
  `opencode@1.18.11`, `copilot@1.0.77`, `gemini@0.53.1`, of which copilot and gemini advertise **no
  `session.resume`** and gemini advertises no `list` — is a test fixture, not a constant.
- **Conformance** — the F3.4 battery per installed adapter: structured output, streaming, permission
  refusal, timeout, cancellation, non-zero exit, malformed output, token accounting.
- **Auth shadowing** — a loud warning when `ANTHROPIC_API_KEY` or a sibling is set, naming the
  variable and stating which credential will actually be used (F3.8, PRD §5.3).
- **PTY and memory layer** — whether `@lydell/node-pty` loaded (if not, `terminal/*` degrades to a
  no-TTY spawn and the capability is not advertised); FTS5 availability and the `artifact_fts`
  tokenizer setting; the current `tokenEstimateFactor` per (provider, model) with its sample count;
  the secretlint rule count.

**Acceptance criteria**

1. On a fully provisioned machine `doctor` prints all eight categories and exits 0. Every check
   reports one of `ok` / `warn` / `fail` with a reason; there is no silent or empty section.
2. On a machine with **no agent CLI installed at all**, `doctor` exits 0, reports zero agents, and
   prints the concrete install hint per supported vendor plus the sentence that mock-agent
   development and `DeFlow replay` work regardless. It never throws and never prints a stack trace.
3. git `< 2.38` is a `fail`: the report states that write nodes cannot be scheduled because
   `merge-tree --write-tree` is unavailable, and `doctor` exits 5. git `>= 2.38` but `< 2.45` is a
   `warn` naming `worktree list --porcelain -z`.
4. On Linux, a missing `bwrap` or `socat`, or
   `kernel.apparmor_restrict_unprivileged_userns = 1`, downgrades the reported honourable levels to
   `read` only, names `/etc/apparmor.d/bwrap` as the fix, and states that DeFlow sets
   `sandbox.failIfUnavailable: true` and `allowUnsandboxedCommands: false` for every non-`full`
   level so the ladder fails closed rather than silently running unsandboxed.
5. With `ANTHROPIC_API_KEY` present, the auth-shadowing section names the variable, names the
   provider it shadows, and states the effective auth mode. `doctor` opens no credential file and
   captures no auth-command output (AR-1); where a vendor CLI reports a login command, `doctor`
   prints it for the user to run.
6. The capability matrix is regenerated from live `initialize` responses and written to its fixture
   file with a probe timestamp; a diff against the recorded baseline is reported as a
   conformance-relevant change with the adapter and field named.
7. A recorded agent version or entry-file sha256 that differs from the installed one produces a
   `warn` naming both values and pointing at `pnpm test:record` for refreshing the goldens.
8. An unwritable global state dir or repo-local `.DeFlow/` is a `fail` naming the absolute path and
   the errno, exit 5.
9. The memory-layer section reports FTS5 availability, the `artifact_fts` tokenizer string, and the
   calibration factor per (provider, model) with `n`; below `n = 5` it says the seed value is in use
   (`anthropic 1.2`, `openai 1.0`, default `1.05`).
10. `doctor --json` emits one machine-readable document with the same information and the same exit
    code; CI consumes the exit code, humans consume the text.
11. Exit-code contract: `0` all checks ok or warn only; `5` at least one `fail`. Nothing else.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                                      | Red when                                                                                                           |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | unit        | The report reducer maps a fixture of raw probe results to a rendered report and an exit code; `Scenario Outline`-style table over ok/warn/fail combinations                                               | Exit code is computed by the renderer, so `--json` and the text path disagree                                      |
| 2   | integration | Run `doctor` with an **empty** temp `PATH`; assert exit 0, `agents: 0`, install hints present, and no `Error:` on stderr                                                                                  | A missing binary rejects rather than resolving to "absent"                                                         |
| 3   | integration | Put a fake `git` shim on the temp `PATH` that prints `git version 2.37.0`, then `2.44.0`, then a real git; assert fail / warn / ok and that the real-git case actually executes `merge-tree --write-tree` | The check parses `--version` only, and passes on a git whose `merge-tree` is broken                                |
| 4   | integration | Linux only: a temp `PATH` without `bwrap`; and a stubbed sysctl reader returning `1`; assert honourable levels collapse to `read` and `/etc/apparmor.d/bwrap` is named                                    | The sandbox section reports "ok" from platform alone                                                               |
| 5   | integration | `doctor` with `ANTHROPIC_API_KEY=sk-test` in the child env; assert the warning text names the variable and the provider                                                                                   | Detection matches an exact list and misses `ANTHROPIC_AUTH_TOKEN`                                                  |
| 6   | unit        | An AR-1 guard over the `doctor` source tree: no read of `~/.claude`, `~/.codex`, `~/.config/gcloud`, and no capture of a login subcommand's stdout                                                        | Someone adds an "is it authenticated?" check that shells out to a login command                                    |
| 7   | integration | `DeFlow-mock-agent --agent-capabilities <gemini-profile>` on the temp `PATH`; assert the regenerated matrix records `session.resume: false` and the report says resume is unavailable for that adapter    | The matrix is read from a constant, so the mock's profile has no effect — the exact failure AR-5 exists to prevent |
| 8   | integration | Record a manifest with a stale sha256, then re-run; assert a `warn` naming both hashes                                                                                                                    | Drift detection compares versions only, and misses a rebuilt binary at the same version                            |
| 9   | integration | `chmod 0500` the resolved data dir; assert `fail`, the absolute path in the message, and exit 5                                                                                                           | The writability check tests `existsSync` rather than attempting a write                                            |
| 10  | integration | File-backed SQLite with `artifact_fts` created; assert the reported tokenizer string is exactly `unicode61 remove_diacritics 2 tokenchars '_-.'`                                                          | The value is re-derived from a default instead of read from the table definition                                   |
| 11  | integration | `doctor --json` against the same fixtures as test 1; assert both renderers agree on every status and on the exit code                                                                                     | Two code paths compute status independently                                                                        |

**Notes / risks** — the conformance battery (criterion 6, 7) is the expensive half and it belongs to
EPIC-05. If this story runs long, ship categories 1–5 and 8 first — they are what gate a first real
run — and land the battery integration second. That split is the deliberate mitigation for the size
risk below; it is a sequencing decision, not a scope cut, and it must be recorded on the board if
taken.

> **The split was not taken** (implemented 2026-08-11). All eight categories, the battery included,
> landed together, because the battery already existed: `runProviderDoctor` was built by KAR-15.6
> for `GET /api/providers/doctor`, and `doctor`'s Conformance section is a second caller of it
> rather than a second implementation. `agents.ts` runs one pass over the machine — detect, probe,
> regenerate the matrix, then the battery — because probing twice would mean spawning every
> installed vendor CLI twice.
>
> Two decisions worth recording, both of which the acceptance criteria imply but do not state.
>
> **Only two things produce a `fail`**, and they are exactly the two the criteria enumerate: a git
> below the 2.38 floor (AC3) and an unwritable state directory (AC8), plus a Node below 24 and a
> bug inside `doctor` itself. Everything else — a degraded sandbox ladder, capability drift, a
> failed conformance assertion, a missing pty — is a `warn`. The rule is that exit `5` means
> *DeFlow cannot run here*, not *something here is imperfect*, which is what keeps the exit code
> worth branching on in CI (AC11).
>
> **A capability the agent never mentioned reads as `false` in the matrix**, matching
> `canResume`/`canFork`/`canList` in `@DeFlow/adapters`, because a capability nobody advertised is
> one DeFlow must not route through. The distinction between "never mentioned it" and "told us no"
> is not lost: `capability()`'s reason is carried alongside the matrix in the regenerated fixture
> and in `--json`.
>
> The regenerated fixture is written to `<dataDir>/capabilities/<agent>@<version>.json` by default
> rather than into the operator's repository, and the baseline it diffs against is the most
> recently probed fixture for the same agent — so a version bump is a new file *and* a reported
> diff, not a silent replacement.

---

### KAR-18.5 — Single-package build and asset bundling

|                 |                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                     |
| **Priority**    | P0                                                                                                                              |
| **Size**        | M                                                                                                                               |
| **Depends on**  | EPIC-01 KAR-01.1 and KAR-01.2 (the workspace, `erasableSyntaxOnly`, no `paths`), EPIC-16 KAR-16.1 (there must be a UI to build) |
| **PRD**         | NF6, NF5                                                                                                                        |
| **Verified by** | EPIC-18-S37, EPIC-18-S38, EPIC-18-S39, EPIC-18-S40, EPIC-18-S41                                                                 |

**As** the maintainer, **I want** the workspace to collapse into exactly one publishable tarball,
**so that** releasing is `npm version patch && pnpm publish` and there is no inter-package semver to
keep honest.

[16 §2](../../16-repo-layout.md) settles the mechanism. `packages/cli` is `"name": "DeFlow"`; every
`@DeFlow/*` package is private and inlined by `tsdown@0.22.14` through `noExternal: [/^@DeFlow\//]`,
with `external: ['@lydell/node-pty']` because it is native and must stay a real runtime dependency.
The build order is fixed and load-bearing: `pnpm --filter @DeFlow/web build` → `packages/web/dist` →
copied to `packages/cli/dist/ui/` → `pnpm --filter DeFlow build`. UI assets ship as **plain files**,
never bundled into JavaScript, and are resolved at runtime with
`fileURLToPath(new URL('./ui', import.meta.url))`. Two failure modes are invisible in development and
fatal in the tarball, and both get a regression test here rather than a paragraph: a `paths` alias
(which `rewriteRelativeImportExtensions` **does not rewrite through** —
microsoft/TypeScript#61991) and a deep cross-package import (which breaks the `publishConfig`
source→dist swap).

**Acceptance criteria**

1. `pnpm build` runs the fixed order and produces `packages/cli/dist/` containing `bin.mjs`,
   `mcp.mjs`, `mock-agent.mjs` and `ui/` with the Vite output as plain hashed files.
2. The bundle contains no `@DeFlow/` import specifier and no `.ts` import specifier. Exactly two
   runtime imports stay external, and both are native: `better-sqlite3` as a `dependency`, and
   `@lydell/node-pty` as an `optionalDependency` with a plain-`spawn` fallback.

   > **Amended 2026-08-11 while implementing KAR-18.5.** This criterion originally read "the only
   > external runtime import is `@lydell/node-pty`". `better-sqlite3` cannot be inlined: it locates
   > its own prebuilt binary with
   > `require(path.join(__dirname, '..', 'prebuilds', '<platform>-<arch>.node'))`, so bundling it
   > points that lookup at `packages/cli/prebuilds/`, which is nowhere — and the failure arrives
   > when a user opens a ledger, not when the build runs. [16 §2](../../16-repo-layout.md) already
   > assumed the tarball asks npm for it when it measured `npm i better-sqlite3@13.0.2` at one
   > second with zero compilation. The criterion the build now enforces (through tsdown's
   > `deps.onlyImport`) is the stronger one: those two and *nothing else*.
3. `packages/cli/package.json` declares `"files": ["dist"]`, `"type": "module"`,
   `engines.node >= 24`, and bins for `DeFlow`, `DeFlow-mcp` and `DeFlow-mock-agent`. There is no
   dual CJS build.
4. `pnpm pack:check` runs `publint@0.3.22` and `@arethetypeswrong/cli@0.18.5 --pack` and both pass
   clean; a failure fails CI.
5. A test asserts `tsconfig.base.json` declares no `paths` key anywhere in the workspace, and a
   second asserts no source file imports another workspace package by a deep path — both with the
   failure message explaining why (the published bundle breaks at runtime with no warning in dev).
6. `dist/bin.mjs` begins with a `#!/usr/bin/env node` shebang and is emitted with the exec bit set.
7. `vite` never appears in the published dependency graph — it is imported dynamically only under
   `DeFlow_DEV === '1'`.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                   | Red when                                                                             |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | integration | Run the real build into a temp `outDir`; assert the file tree with a normalised file snapshot (hashes stripped by the serializer)      | `dist/ui/` is empty because the copy step runs before the web build                  |
| 2   | integration | Static scan of `dist/*.mjs` for `@DeFlow/` and `.ts` specifiers, and for exactly one external `require`/`import` of `@lydell/node-pty` | `noExternal` was written as a string rather than a regexp and matches nothing        |
| 3   | unit        | Parse `packages/cli/package.json`; assert `files`, `bin`, `type`, `engines`, and that no `@DeFlow/*` appears in `dependencies`         | A workspace package leaks into `dependencies` and npm tries to fetch a private name  |
| 4   | integration | `publint` and `attw --pack` executed against the packed tarball as part of `pack:check`                                                | `attw` reports a masked entry point that `pnpm dev` never exercises                  |
| 5   | unit        | Config guard: no `paths` key in any `tsconfig*.json`; no import matching `@DeFlow/[^'"]+/`                                             | Someone adds `@/` for convenience; dev is green and the tarball is broken            |
| 6   | integration | `fs.stat` the emitted `bin.mjs`: mode has `0o111` bits and byte 0 is `#`                                                               | The bundler drops the shebang on a config change and `npx` fails with a syntax error |

---

### KAR-18.6 — Install verification in a clean environment

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | S                                                               |
| **Depends on**  | KAR-18.5, KAR-18.2, KAR-18.4                                    |
| **PRD**         | NF6, NF5, NF1                                                   |
| **Verified by** | EPIC-18-S42, EPIC-18-S43, EPIC-18-S44, EPIC-18-S45, EPIC-18-S46 |

**As** the maintainer, **I want** the release gate to install the **real published tarball** into an
empty directory and run it, **so that** the "works locally, broken on npm" class of failure is caught
by a job rather than by the first colleague who tries.

This story exists because `pnpm build` producing a green local run **proves nothing about the
tarball** — the exact words of [03 §10](../../03-local-development.md). The procedure is fixed:
`pnpm build`, `pnpm pack:check`, then `cd packages/cli && pnpm pack` to produce
`DeFlow-0.1.0.tgz`, then `cd "$(mktemp -d)"`, `git init -b main demo && cd demo`, and
`npx /path/to/DeFlow-0.1.0.tgz up` — _the exact bytes a user would get_. What it catches that
`pnpm dev` cannot: a missing or wrong `files` array; a lost shebang or exec bit; an `@DeFlow/*`
package that failed to inline and is now an unresolvable runtime import; a native dependency bundled
instead of externalised; and UI assets resolved from the wrong path. The clean room must be a real
temp directory with no `node_modules` above it and no compiler assumed on the box.

**Acceptance criteria**

1. A `pnpm verify:install` script performs the whole sequence unattended: build, `pack:check`,
   `pnpm pack`, `mktemp -d`, `git init -b main`, `npx <tgz> init`, `npx <tgz> up`, poll
   `GET /api/health`, fetch `/` and assert the served HTML references a real asset under `/assets/`
   that returns 200 — not merely that the daemon answered.
2. In the same clean room, with `DeFlow-mock-agent` from the installed tarball on `PATH`, a scripted
   multi-node run completes through `npx <tgz> run` and exits 0. This proves the inlined daemon, the
   inlined mock agent and the shipped UI are all present in one artefact.
3. `npx <tgz> doctor` in the clean room exits 0 with zero agents and honest warnings — the same
   output a colleague sees on day one.
4. The installation performs **no compilation**: no `node-gyp` process is spawned, and the run
   completes on a box with no compiler. `better-sqlite3@13.0.2` resolves a prebuild
   (`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`, `gypfile: false`, no install
   script) and `@lydell/node-pty` resolves a per-platform `optionalDependency` — or degrades to the
   no-TTY path without failing the install.
5. A deliberately broken tarball (a `files` array that omits `dist/ui`) makes the verification job
   **fail with the blank-page assertion**, not pass. This is asserted by a test that builds the
   broken variant on purpose.
6. The job runs in CI on `ubuntu-26.04` and `macos-26` for every release tag, and is runnable
   locally with one command; per [03 §10](../../03-local-development.md) it is also run once per
   milestone even without a release.
7. The clean room is removed on success and preserved under `DeFlow_KEEP_TMP=1` on failure, with the
   directory uploaded by `actions/upload-artifact` in CI.

> **Amended 2026-08-12 while implementing KAR-18.6.** AC2 asks for _"a scripted multi-node run
> completes through `npx <tgz> run` and exits 0"_. The completion half is **not reachable in this
> repository and is not faked** — the same deferral [KAR-18.3](#kar-183--DeFlow-run-headless-execution)
> already carries, recorded here rather than left in a commit message, because
> [README §9](../README.md#9-changing-the-plan) is explicit that a cut is recorded and never
> silently absorbed. Nothing calls `compilePlanV1` or `executeRun`, and
> `POST /api/runs` stops at `task.submitted` by design (KAR-10.1: _"No interpretation happens
> here"_), so every submitted run parks after intake. (**Narrowed 2026-08-12 by KAR-19.1**: `boot()`
> now does start the ticker, and intake now does schedule framing. **Narrowed again 2026-08-13 by
> KAR-19.3**: an approved spec is now pinned, surveyed and compiled into a validated `PlanGraph` by
> `packages/daemon/src/pipeline/run-chain.ts`. The one call that remains missing — `executeRun` — is
> what still makes the completion half unreachable.) That wiring is EPIC-06/EPIC-10/EPIC-11 and is
> in this epic's **Out of scope**; this epic is a _client_ of the daemon.
>
> What ships instead is the criterion's own stated reason — _"this proves the inlined daemon, the
> inlined mock agent and the shipped UI are all present in one artefact"_ — asserted directly, and
> more strongly than a green exit code would have:
>
> - the installed daemon **spawns the installed `DeFlow-mock-agent` and drives real ACP turns
>   against it**: an `initialize` whose response is what the capability matrix is regenerated from,
>   then the F3.4 conformance battery, which is a turn per assertion. Both processes are tarball
>   bytes, and the assertion refuses an agent that is on `PATH` but holds no turn
>   (`e2e/install-verification-broken.test.ts` proves it goes red);
> - a run submitted through the installed `DeFlow run` reaches the installed daemon and is reported
>   as `task.submitted`, never as a run that completed.
>
> **Closed 2026-08-13 by [EPIC-19](./EPIC-19-live-run-pipeline.md) KAR-19.5.** `executeRun`'s
> missing call now exists in both composition roots, and a run submitted on a machine with only the
> bundled agent reaches `run.completed` and exit 0 — asserted against the built binary by
> `e2e/smoke/live-run.test.ts`, and performed by hand in a scratch repository against the packed
> `dist/bin.mjs`. AC2 is now met in letter as well as in reason.
>
> **One thing this amendment promised and this closure does not deliver**, so it is left standing
> rather than quietly dropped: the completion is asserted against `packages/cli/dist`, not against
> an installed tarball in the `verify-install` clean room. Test plan #2 above is still the room's
> own scripted run, and raising it to a completed run there is a real change to
> `packages/cli/scripts/verify-install/`, not a line in this note.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                              | Red when                                                                                                      |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | e2e         | The full sequence against a real `mktemp -d` clean room; assert `/` returns HTML **and** the referenced `/assets/*.js` returns 200 with a JavaScript content type | The assertion stops at HTTP 200 on `/` and passes against the blank page the SPA fallback happily serves      |
| 2   | e2e         | A scripted mock run through the installed `npx <tgz> run`, with the tarball's own `DeFlow-mock-agent` symlinked onto the temp `PATH`                              | `mock-agent.mjs` was never added to the tsdown `entry` array, so the second bin does not exist in the tarball |
| 3   | e2e         | Build a variant tarball with `files: ["dist/bin.mjs"]`; assert the verification job fails with the asset assertion                                                | The test asserts only that the command exits 0, so the classic failure passes                                 |
| 4   | integration | Spawn the install with a `PATH` containing no `cc`/`make`/`python3`, and assert no `node-gyp` string appears in the install log                                   | A transitive dependency acquires an install script and nobody notices until a colleague's machine             |
| 5   | e2e         | `npx <tgz> doctor` in the clean room; snapshot the report through the normalising serializer                                                                      | `doctor` resolves a fixture path relative to the workspace root, which does not exist in the tarball          |

**Notes / risks** — the author is also the M2 "colleague installs it unaided" test subject, so
`docs/CONTRIBUTING.md` should open with literally `git clone && pnpm install && pnpm dev` and be
re-verified on the same cadence as this job.

---

### KAR-18.7 — Diagnostics: `DeFlow status` and `DeFlow ledger snapshot` _(added)_

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P1                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-18.2, EPIC-03 KAR-03.1            |
| **PRD**         | NF8, NF10                             |
| **Verified by** | EPIC-18-S47, EPIC-18-S48, EPIC-18-S49 |

**As** the only engineer on this project, **I want** two commands that answer "what is running?" and
"give me the evidence", **so that** a post-mortem on a run that went wrong is a file rather than a
reconstruction.

Added because [03 §11](../../03-local-development.md) specifies both and neither has a home in the
skeleton's six stories. `DeFlow ledger snapshot <runId> --out <path>` is `VACUUM INTO` behind a
flag — **measured at 1007 ms for a 193 MB database** — producing one consistent file with no WAL
sidecar, safe to attach to an issue or hand to a future self, and inspectable with plain `sqlite3`.
That is NF8 made operational. `DeFlow status` answers the question the troubleshooting table in
[03 §13](../../03-local-development.md) sends people to `.DeFlow/daemon.json` for, and it is the
command the lease-refusal message in KAR-18.2 points at.

**Acceptance criteria**

1. `DeFlow ledger snapshot <runId> --out <path>` writes a single SQLite file; `PRAGMA
integrity_check` on the copy returns `ok`, and the copy has no `-wal` or `-shm` sidecar.
2. The snapshot is queryable with the documented one-liners — `SELECT seq, kind, node_id, attempt
FROM event WHERE run_id='<id>' ORDER BY seq LIMIT 50` returns rows — without DeFlow installed.
3. `DeFlow status` reports the live daemon's pid, port, `daemon_epoch`, uptime, and a one-line
   summary per active run. `--json` emits the same.
4. When `daemon.json` exists but its pid is dead or its start time does not match, `status` says
   `stale` and names the file, rather than reporting a running daemon.
5. With no `daemon.json` at all, `status` exits 0 and says no daemon is running.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                         | Red when                                                                                          |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | integration | Snapshot a file-backed ledger with an open WAL and pending writes; assert `integrity_check = 'ok'`, no sidecars, and the event count matches | The implementation copies the `.db` file, so WAL contents are lost                                |
| 2   | integration | `SIGKILL` a booted daemon, then `DeFlow status`; assert `stale` and the path, and that no process was signalled                              | `status` trusts the pid and reports a live daemon that is gone — or worse, matches a recycled pid |
| 3   | integration | `DeFlow status` in a repo with no `daemon.json`; assert exit 0 and the message                                                               | It exits non-zero, so a shell script wrapping it breaks on the normal case                        |

---

### KAR-18.8 — `doctor` detects installed agent CLIs and offers to install their ACP adapters _(added)_

|                 |                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                 |
| **Priority**    | P1                                                                                                                                                                          |
| **Size**        | M                                                                                                                                                                           |
| **Depends on**  | KAR-18.4 (the Agents/Capabilities/Conformance pass and the `ok`/`warn`/`fail` reducer this extends), KAR-18.1 (the global state directory the probe cache and fixtures live in), EPIC-05 KAR-05.2 (`detectProviders`, and the registry's `bin` / `package` / `shim.bin` / `kind` fields this reads) |
| **PRD**         | F3.1, F3.2, NF1, NF6, NF7                                                                                                                                                   |
| **Verified by** | EPIC-18-S50, EPIC-18-S51, EPIC-18-S52, EPIC-18-S53, EPIC-18-S54, EPIC-18-S55, EPIC-18-S56                                                                                    |

**As** an operator who already has a vendor agent CLI installed and authenticated, **I want** `doctor`
to say what is actually missing and offer to put it in place, **so that** a working `claude` on my
`PATH` is never reported as _"claude is not installed"_ and the fix is a keystroke rather than a
package name read out of a paragraph.

Today the Agents section resolves exactly one binary per provider — `spec.bin`, which for the two
`kind: 'adapter'` providers is the **ACP bridge** (`claude-agent-acp`, `codex-acp`) and not the
vendor CLI. When the bridge is absent, `detectProviders` returns `not-installed` and prints
_"claude is not installed here: no executable `claude-agent-acp` was found on PATH — install it with
`npm install -g @agentclientprotocol/claude-agent-acp`"_. Every fact in that sentence is true and
the first four words are wrong: the operator can run `claude`, so the report reads as a bug and the
rest of it stops being trusted. The registry already carries what distinguishes the two — `spec.bin`
is what DeFlow spawns, `spec.shim.bin` is the vendor CLI, and `spec.kind` says whether they can
differ at all — so this is a resolution the report declines to make rather than information it lacks.

**Detect-then-offer, never silent installation**, and the reason is worth stating because the
shortcut is tempting. Installing a global npm package onto someone's machine without asking is a
trust problem before it is anything else; it cannot work offline, behind a proxy, or on a box with no
network egress — all three of which NF1 says DeFlow must survive; and it fails in ways strictly worse
than the message it replaces, because a half-installed global package is harder to diagnose than a
missing one. So `doctor` resolves both binaries, says which of the three states each provider is in,
and asks before it spawns `npm`.

**Acceptance criteria**

1. The Agents section reports one of exactly three states per registry provider, derived from
   resolving **two** binaries rather than one: `installed` (both the vendor CLI `spec.shim.bin` and
   the binary DeFlow spawns `spec.bin` resolve on the operator's `PATH`), `adapter-missing` (the
   vendor CLI resolves and its ACP adapter does not), `not-installed` (the vendor CLI does not
   resolve). For a `kind: 'native'` provider the two are the same executable, so `adapter-missing` is
   unreachable there and is never claimed.
2. The words "not installed" are printed for a provider **only** when its vendor CLI did not resolve.
   With `claude` on `PATH` and `claude-agent-acp` absent, the check names the vendor CLI's absolute
   resolved path, states that the ACP adapter `@agentclientprotocol/claude-agent-acp` is what is
   missing, and the string `claude is not installed` appears in no stream — stdout, stderr or
   `--json`.
3. `adapter-missing` is a `warn`. KAR-18.4 AC11's exit-code contract is unchanged by this story:
   `0` when everything is `ok` or `warn`, `5` when anything is `fail`, and nothing else — including
   after a declined offer, a successful install and a failed install.
4. When stdout is a TTY and at least one provider is `adapter-missing`, `doctor` prompts once per
   such provider, naming the exact command it will run (`npm install -g <spec.package>`), and spawns
   nothing until an affirmative answer. The default on a bare Enter is **no**.
5. Declining installs nothing, spawns no child process, and leaves the provider at `warn` with the
   command printed for the operator to run themselves.
6. `--fix` installs the adapter for every `adapter-missing` provider without prompting, and is the
   only way an install happens when stdout is not a TTY. `--json` never prompts and never reads
   stdin; `--json --fix` installs and reports each result inside the document.
7. Nothing is installed for a provider whose vendor CLI did not resolve, under any flag combination:
   no prompt, no `--fix` action, and the existing install hint for that vendor is kept as it is.
8. Every install attempt is reported with the command run, its exit code, its elapsed wall-clock in
   milliseconds, and — on failure — the child's own stderr, trimmed but not paraphrased. A failed
   install is a `warn` at minimum and is never rendered as a success; the provider's state afterwards
   is **re-resolved**, not assumed from the exit code.
9. After a successful install the provider is re-resolved and probed in the same `doctor` run, so the
   Capabilities and Conformance sections describe the adapter that now exists rather than the machine
   as it was at start, and the regenerated capability fixture carries the newly installed version.
10. With no network egress the offer is still made, the install fails, and the failure names the
    underlying `npm` error. `doctor` retries an install at most zero times — one attempt, one report
    — so an offline machine costs one timeout and not several.
11. `doctor` installs only `spec.package`, only for a provider whose vendor CLI resolved. It runs no
    global update, writes no lockfile into the operator's repository, and the AR-1 guard still holds
    before and after an install: no credential file is read and no auth command's output is captured.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                          | Red when                                                                                                                             |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | The provider-state reducer over a table of (vendor CLI resolved?, adapter resolved?, `kind`) → state, status and sentence                                                     | The state is derived from the single `spec.bin` resolution, so a machine with `claude` and no bridge still reduces to `not-installed` |
| 2   | unit        | A wording guard over every rendered check: the substring `is not installed` never co-occurs with a resolved vendor-CLI path in the same check                                  | The message is left as `installHint()` writes it and the report contradicts itself                                                   |
| 3   | integration | `doctor` with a fake `claude` shim on the temp `PATH` and no `claude-agent-acp`; assert `warn`, the adapter package named, the vendor path named, exit 0                       | The missing bridge is a `fail` and the exit code becomes 5 for a machine DeFlow can still partly use                                  |
| 4   | integration | A scripted TTY answering `n`, and one answering bare Enter; assert no child process was spawned in either case and the command was printed                                     | The prompt defaults to yes on Enter, so an operator installs a package by pressing return                                             |
| 5   | integration | `--fix` with a fake `npm` shim on the temp `PATH` recording its argv; assert exactly one call, `install -g @agentclientprotocol/claude-agent-acp`, and none for an absent vendor | `--fix` installs every package the registry knows, including for vendors that are not on the machine                                  |
| 6   | integration | The same fake `npm` shim exiting 1 with `E401` on stderr; assert `warn`, that stderr text present in the report, and that the section does not claim the adapter is installed  | A non-zero exit is treated as done because the spawn promise resolved                                                                 |
| 7   | integration | `doctor --json --fix` with stdout piped and **stdin closed**; assert the document parses, carries a per-provider install result, contains no ANSI, and the process never blocks | Prompting is gated on `process.stdout.isTTY` alone, so a CI job hangs on a read that can never be answered                            |
| 8   | integration | After a successful fake install, assert the Capabilities section and the regenerated fixture describe the now-present bridge                                                   | The report is rendered from the detection snapshot taken before the install, so the fix is invisible until the next run               |
| 9   | unit        | An AR-1 guard over the new install module: no read of `~/.claude`, `~/.codex` or `~/.config/gcloud`, and no capture of a login subcommand's stdout                             | Someone adds an "is it authenticated now?" check after the install and captures a login command's output                             |

**Notes / risks** — the install is a spawn of the operator's own `npm`, resolved on `PATH` like any
other binary; DeFlow does not embed a package manager and does not choose one for the operator. If
`npm` itself is absent the state is a `warn` naming that, not a crash. `--fix` is deliberately
per-adapter and not a general repair flag: a flag that fixes everything is a flag nobody can predict.

---

### KAR-18.9 — Readable terminal output across every CLI command _(added)_

|                 |                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                        |
| **Priority**    | P1                                                                                                                                                 |
| **Size**        | M                                                                                                                                                  |
| **Depends on**  | KAR-18.4 (the `DoctorCheck` / section model this renders), KAR-18.1, KAR-18.3 and KAR-18.7 (the other commands whose reports move onto the layer)  |
| **PRD**         | NF6, NF8, and the never-colour-alone accessibility floor of [12 §9.2](../../12-frontend-architecture.md), applied to the terminal rather than the UI |
| **Verified by** | EPIC-18-S57, EPIC-18-S58, EPIC-18-S59, EPIC-18-S60, EPIC-18-S61, EPIC-18-S62, EPIC-18-S63, EPIC-18-S64                                              |

**As** an operator reading `DeFlow doctor` or `DeFlow init` for the first time, **I want** output
structured the way the vendor CLIs structure theirs, **so that** the answer to "what is wrong and
what do I do" is visible without reading every line.

The information is already right and the presentation is not. `renderText` prints
`  [warn] agents.claude: <a paragraph>` per check, one flat list under a bare heading, with no
wrapping, no alignment and no summary — so a long detail runs off the edge, the statuses do not line
up into a column the eye can scan, and the one line an operator needs ("here is what to do next") is
somewhere in the middle. `init`, `status`, `run` and `ledger snapshot` each format their own output
separately, which is why the five commands do not look like one tool.

This story establishes **one presentation layer that every command prints through** rather than
improving five renderers. Three constraints shape it. **Colour is never the carrier of meaning** —
12 §9.2's rule is a WCAG 1.4.1 requirement in the UI and it is exactly as true in a terminal, where
`NO_COLOR`, a dumb `TERM` and a pipe all strip it anyway; glyph and text label carry the state and
colour only reinforces it. **Styling is a property of the stream, decided once** — piping into a file
must produce clean text, and a per-call-site check is how one forgotten branch writes an escape
sequence into somebody's log. And **`--json` is a contract, not a view**: CI branches on those
documents, so this story must leave them byte-identical, which is the difference between a
presentation change and a breaking one.

**Acceptance criteria**

1. One module owns glyph, colour, section heading, column alignment, wrapping and the summary block,
   and `doctor`, `init`, `status`, `run` and `ledger snapshot` all print through it. A source guard
   asserts no command module outside it emits an ANSI escape or a status glyph of its own.
2. Four states — `ok` / `warn` / `fail` / `skipped` — each render as glyph **and** text label **and**
   colour, in that fixed order. Stripping every ANSI sequence from a report loses no information:
   each state is still identifiable from the glyph and the label alone. (`skipped` is promoted to a
   first-class state; `doctor` already prints it in prose, e.g. _"skipped — no adapter installed"_.)
3. Section headings are visually distinct from their contents — a blank line before, the heading
   styled, the checks indented — and within a section the check ids and statuses align into columns
   whose width is computed from the longest id **in that section**, never a constant.
4. Detail text is wrapped to `min(stdout.columns, 100)` columns, and continuation lines are indented
   under the first line of the detail rather than back at the left margin. No line exceeds the width;
   a single token longer than the width (an absolute path, a URL) is emitted whole on its own line
   rather than broken across two.
5. Every report ends with a summary block: the overall status, a count per state, and — whenever the
   overall status is not `ok` — **one next action naming a command to run, printed as the first line
   of that block**, before any restatement of detail. (The owner asked for the summary "at the end,
   ahead of the detail"; settled here as _last in the report, first within the block_, which is where
   a terminal leaves the cursor and what the vendor CLIs do.)
6. Every `--json` document is byte-identical to what the same command produced before this story:
   same keys, same order, same values, no ANSI, no summary block, no wrapping. A committed golden
   asserts it, so the shape CI branches on cannot drift as a side effect of a presentation change.
7. No ANSI byte is written when any of the following holds: stdout is not a TTY, `NO_COLOR` is set to
   any value including the empty string, `TERM` is `dumb`, `--json` is passed, or `--no-color` is
   passed. `FORCE_COLOR` overrides the TTY test only, and never overrides `--json`. The decision is
   computed once per process from an injected environment and never re-derived at a call site.
8. No command's behaviour changes: same exit codes, same ledger events, same files written, same
   JSON. The behavioural tests of KAR-18.1, KAR-18.3, KAR-18.4 and KAR-18.7 pass unmodified.
9. An unknown terminal width (`stdout.columns` is `undefined` under a pipe or on a CI runner)
   resolves to 80 columns and never throws or produces a `NaN`-width layout.
10. When the terminal's encoding cannot be established as UTF-8 (`LC_ALL`/`LANG` naming a non-UTF-8
    charset), the glyph set degrades to ASCII rather than emitting replacement characters, and AC2
    still holds — the ASCII glyphs are distinct from each other.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                       | Red when                                                                                                              |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | The styling decision over a table of (`isTTY`, `NO_COLOR`, `TERM`, `--json`, `--no-color`, `FORCE_COLOR`) → enabled / disabled                                              | Colour is decided by a library's own detection at import time, so `--json` still emits escapes                        |
| 2   | unit        | Render a report with styling on, strip every ANSI sequence, and assert all four states are still distinguishable by glyph and label                                         | `warn` and `fail` differ only in colour, which is the exact failure 12 §9.2 exists to prevent                          |
| 3   | unit        | Wrapping at width 60 over a 400-character detail and a 120-character absolute path                                                                                          | The wrapper breaks on character count and splits a path in half, so the path cannot be copied out of the terminal      |
| 4   | unit        | Column alignment over a section whose check ids differ in length; assert statuses start at the same column and the width came from the longest id                           | The column width is a constant, and one long id pushes its status out of alignment for the whole section              |
| 5   | integration | `doctor --json` over KAR-18.4's own fixtures, compared byte-for-byte against a golden captured before the change                                                            | The summary block is appended to the JSON document too, and every CI consumer's parse breaks                          |
| 6   | integration | Each of `doctor`, `init`, `status`, `run`, `ledger snapshot` with stdout piped to a file; assert no `0x1b` byte in the file and the exit codes their own stories assert     | One command was missed and still writes its own colour, so a log file is full of escapes                              |
| 7   | unit        | A source guard: no file under `packages/cli/src` outside the render module contains an ANSI escape literal or a status-glyph literal                                        | A new command is added later and formats its own output, and the tool goes back to looking like five tools            |
| 8   | integration | Spawn with `stdout.columns` unavailable and with `COLUMNS` unset; assert an 80-column layout and no throw                                                                   | The width is read directly and `undefined` reaches the wrapper as `NaN`, producing one line per character             |
| 9   | unit        | `LC_ALL=C` and `LANG=C`; assert the ASCII glyph set and that the four glyphs are pairwise distinct                                                                          | The glyphs are literals in the template, so a non-UTF-8 terminal prints replacement characters where the status was   |

**Notes / risks** — this is a presentation change and the temptation is to improve a decision while
in the file. Do not: AC8 is enforced by leaving the other stories' tests untouched, and any behaviour
that needs to change belongs in its own story. The summary block's "next action" is chosen from the
worst check, which means every check that can be worst needs an action worth printing — writing one
per check is most of the work here, and it is the half that actually shortens a diagnosis.

---

## Risks

| #   | Risk                                                                                                                                                                                                                                      | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **~22 days is well over the ~15-day guidance** (it was ~16 before KAR-18.8 and KAR-18.9 were added on 2026-08-12), and this epic sits last on the critical path where schedule pressure lands.                                            | KAR-18.4 is the split point: categories 1–5 and 8 (`runtime`, `git`, `sandboxing`, `agents`, `capabilities`, `PTY`/`memory`) gate a first real run; the F3.4 conformance battery integration can follow a week later. The three `P1` stories — KAR-18.7, KAR-18.8 and KAR-18.9, ~7 days together — sit outside M1's definition of done and can slip to M2 whole, which is where their argument (a colleague installing this unaided) actually lands. Nothing else here is optional — NF6 _is_ the install. |
| R2  | **A0-6: `@lydell/node-pty@1.2.0-beta.14` is a beta of a community fork and the only native dependency in the published package.**                                                                                                         | M0-S6's install matrix is a DoR item. `optionalDependencies` + a plain-`spawn` no-TTY fallback means an uncovered platform degrades rather than failing installation, and KAR-18.4 criterion 9 makes the degradation visible instead of mysterious. **No agent process needs a TTY** — ACP and every headless mode is a pure pipe protocol across all five agents probed — so the fallback is survivable. |
| R3  | **A5-2 / A5-3: sandbox prerequisites are platform-specific and fail open.** macOS 26 Tahoe broke Seatbelt profiles in practice and whether Claude Code 2.1.220 fixes it is unverified; Ubuntu 24.04+ AppArmor blocks bubblewrap silently. | `doctor` reports _honourable levels_, not "sandbox: ok". EPIC-08 sets `failIfUnavailable: true` and `allowUnsandboxedCommands: false` for every non-`full` level so the ladder fails closed; this epic's job is to say so before a run starts.                                                                                                                                                            |
| R4  | **A0-9: the capability matrix is a snapshot against five specific versions**, two published the day they were probed.                                                                                                                     | The matrix is a generated fixture with a probe timestamp, regenerated on every `doctor` run and diffed in CI weekly ([roadmap §5](../../17-roadmap.md)). The DoD forbids a hardcoded capability constant in this epic's packages.                                                                                                                                                                         |
| R5  | **The tarball can regress between releases in ways only a clean room sees.**                                                                                                                                                              | KAR-18.6 is a CI job on every release tag plus a per-milestone manual run, and criterion 5 asserts the _verifier itself fails_ on a deliberately broken tarball — a green verifier that cannot go red is worse than none.                                                                                                                                                                                 |
| R6  | **`npx DeFlow up` in two terminals is described in the architecture as "very common"**, and the refusal path is the first thing an operator meets when something is wrong.                                                                | KAR-18.2 criterion 3 fixes the exact sentence, including the live pid and port, and points at `DeFlow status`. The lease is EPIC-03's; the sentence is this epic's.                                                                                                                                                                                                                                       |
| R7  | **Windows users will try this** despite NF5 putting it at M3.                                                                                                                                                                             | `doctor` names the platform as unsupported with the WSL2 instruction from [03 §1](../../03-local-development.md), rather than failing at the first `process.kill(-pid)`.                                                                                                                                                                                                                                  |
| R8  | **A command that installs software onto someone's machine is a new kind of thing for DeFlow to be**, and the failure modes (no egress, a proxy, a read-only global prefix, a half-written package) are worse than the message it replaces. | KAR-18.8 is detect-then-offer: nothing is installed without a confirmation or an explicit `--fix`, only the ACP adapter of a vendor CLI that is already present, one attempt, and the result re-resolved rather than inferred. AC10 and EPIC-18-S56 make the no-egress path a first-class scenario rather than a surprise.                                                                                |
| R9  | **A presentation rewrite silently changing a contract.** The `--json` documents are what CI branches on, and they are produced by the same code paths KAR-18.9 touches.                                                                   | KAR-18.9 AC6 pins every `--json` document to a golden captured before the change, AC8 forbids modifying the other stories' behavioural tests, and EPIC-18-S62 is the scenario that goes red the day a summary block leaks into a document.                                                                                                                                                                |

---

**Related:** [Flows](../flows/EPIC-18-cli-packaging-flows.md) · [Board](../board.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md)

[← Back to the delivery plan](../README.md)
