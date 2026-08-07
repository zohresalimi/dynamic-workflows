# EPIC-18 flows — CLI, doctor and packaging

> Behavioural specification for [EPIC-18](../epics/EPIC-18-cli-packaging.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                | Description                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**         | The engineer at a terminal. At M1 this is the author; at M2 it is a colleague on a machine nobody has ever debugged                                         |
| **`DeFlow` CLI**     | `packages/cli`, the one published package. Bins: `DeFlow`, `DeFlow-mcp`, `DeFlow-mock-agent`                                                                |
| **DeFlowd**          | The local daemon the CLI starts, attaches to, or refuses to start twice. Spawned **detached**, so it outlives its launcher                                  |
| **Repository**       | A real git working copy created by `git init -b main` in an `fs.mkdtemp` directory with `GIT_CONFIG_GLOBAL=/dev/null`                                       |
| **Global state dir** | `$XDG_DATA_HOME/DeFlow`, else `~/.DeFlow`: `DeFlow.lock`, `ledger.db` (+ `-wal`, `-shm`), `blobs/`, `recordings/`, `pre-migrate-<user_version>.db`, `logs/` |
| **Provider agent**   | A vendor CLI. In every scenario here it is `DeFlow-mock-agent` symlinked onto a temp `PATH` under a vendor name, or deliberately absent                     |
| **Platform**         | macOS (Seatbelt, built in) or Linux (bubblewrap + socat, plus the AppArmor namespace restriction). Windows is out of scope until M3                         |
| **The tarball**      | `DeFlow-0.1.0.tgz` produced by `pnpm pack` — the exact bytes a user would get, and a different program from the workspace                                   |

## Preconditions common to all flows

```gherkin
Background:
  Given a real git repository created with "git init -b main" in an fs.mkdtemp directory
  And GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced author/committer identity
  And XDG_DATA_HOME points at a directory inside that same tmpdir, so no test touches ~/.DeFlow
  And the mock agent binary is symlinked onto a temp PATH ahead of anything real, unless a
      scenario says the PATH is empty
  And the ledger is a file-backed SQLite database — never ":memory:", which cannot be reopened
      after a simulated crash
  And time enters the engine through the injected Clock port, never Date.now()
  And no scenario calls vi.useFakeTimers() while DeFlowd or an agent child process is alive
  And the normalising snapshot serializer is registered before any snapshot is written, covering
      timestamps, run and node ids, durations, absolute paths, ports and worktree directory names
  And DeFlowd binds an ephemeral port in tests and 127.0.0.1:7777 in the documented flows
  And every kill-verification assertion excludes processes in state "Z"
```

> Four of these carry weight in this epic specifically. **`XDG_DATA_HOME` inside the tmpdir** is what
> makes the lease and migration scenarios safe to run in parallel with the developer's own daemon.
> **A file-backed ledger** is the only way to test the pre-migration backup and the reopen-after-
> failed-migration path. **The normalising serializer** matters more here than anywhere else,
> because CLI output is full of absolute paths and ports. And **the `Z`-state exclusion** is the
> verified false-negative trap: after a _successful_ group SIGKILL, `ps` still lists the
> grandchildren as zombies with `ppid=1`, and a naive assertion concludes the kill failed when it
> did not.

## Flow index

| Scenario    | Title                                                                                  | Verifies           | Type        |
| ----------- | -------------------------------------------------------------------------------------- | ------------------ | ----------- |
| EPIC-18-S1  | Happy path: `DeFlow init` bootstraps a repository                                      | KAR-18.1           | Happy path  |
| EPIC-18-S2  | Re-running `init` never clobbers an edited config                                      | KAR-18.1           | Edge case   |
| EPIC-18-S3  | `init` outside a git working tree refuses and writes nothing                           | KAR-18.1           | Failure     |
| EPIC-18-S4  | `.gitignore` entries are appended once, and the token file is never committable        | KAR-18.1           | Edge case   |
| EPIC-18-S5  | `init` when the global state directory is not writable                                 | KAR-18.1           | Failure     |
| EPIC-18-S6  | Provider detection at `init` writes to the global cache, never to the committed config | KAR-18.1           | Edge case   |
| EPIC-18-S7  | Happy path: `DeFlow up` to a browser in under three seconds                            | KAR-18.2           | Happy path  |
| EPIC-18-S8  | **A second `DeFlow up` is refused by the single-instance lease**                       | KAR-18.2           | Concurrency |
| EPIC-18-S9  | **Port 7777 is occupied: the next free port, reported consistently everywhere**        | KAR-18.2           | Edge case   |
| EPIC-18-S10 | An explicitly pinned `--port` that is occupied fails instead of drifting               | KAR-18.2           | Failure     |
| EPIC-18-S11 | A pre-migration backup exists before `user_version` moves                              | KAR-18.2           | Happy path  |
| EPIC-18-S12 | A failed migration rolls back and no listener is ever bound                            | KAR-18.2           | Failure     |
| EPIC-18-S13 | A stale `daemon.json` from a SIGKILLed daemon does not block startup                   | KAR-18.2           | Recovery    |
| EPIC-18-S14 | Orphan reaping matches `(pid, process_start_time)`, never a bare pid                   | KAR-18.2           | Recovery    |
| EPIC-18-S15 | **First run on a machine with no agent CLI installed at all**                          | KAR-18.2, KAR-18.4 | Edge case   |
| EPIC-18-S16 | Graceful shutdown releases the lease and leaves nothing behind                         | KAR-18.2           | Happy path  |
| EPIC-18-S17 | The probe cache is what keeps the second cold start inside NF3                         | KAR-18.2           | Edge case   |
| EPIC-18-S18 | Happy path: `DeFlow run` with no daemon running                                        | KAR-18.3           | Happy path  |
| EPIC-18-S19 | `DeFlow run` attaches to a daemon that is already up                                   | KAR-18.3           | Happy path  |
| EPIC-18-S20 | The first Ctrl-C detaches; the second cancels                                          | KAR-18.3           | Edge case   |
| EPIC-18-S21 | Killing the CLI does not kill the run                                                  | KAR-18.3           | Failure     |
| EPIC-18-S22 | The stream drops mid-run: a Node client has no `Last-Event-ID`                         | KAR-18.3           | Recovery    |
| EPIC-18-S23 | Exit codes for every terminal state                                                    | KAR-18.3           | Edge case   |
| EPIC-18-S24 | Intake from text, file, issue and spec                                                 | KAR-18.3           | Happy path  |
| EPIC-18-S25 | `--json` in a pipe: NDJSON, no ANSI, one renderer per stream                           | KAR-18.3           | Edge case   |
| EPIC-18-S26 | Happy path: `doctor` on a fully provisioned machine                                    | KAR-18.4           | Happy path  |
| EPIC-18-S27 | **`doctor` with no agent CLI: degrade with instructions, not a stack trace**           | KAR-18.4           | Edge case   |
| EPIC-18-S28 | git version gates: 2.37 fails, 2.44 warns, 2.45 is exercised not inferred              | KAR-18.4           | Failure     |
| EPIC-18-S29 | **Linux sandbox prerequisites, including the AppArmor restriction that fails open**    | KAR-18.4           | Failure     |
| EPIC-18-S30 | **Auth shadowing is loud, and `doctor` still reads no credential file**                | KAR-18.4           | Failure     |
| EPIC-18-S31 | The capability matrix is regenerated, never asserted from a constant                   | KAR-18.4           | Edge case   |
| EPIC-18-S32 | Version and binary-hash drift since the last recorded probe                            | KAR-18.4           | Edge case   |
| EPIC-18-S33 | An unwritable state directory is a typed failure with a path                           | KAR-18.4           | Failure     |
| EPIC-18-S34 | The memory layer: calibration factor, FTS5 and its exact tokenizer                     | KAR-18.4           | Edge case   |
| EPIC-18-S35 | `@lydell/node-pty` did not load: degrade to no-TTY and say so                          | KAR-18.4           | Failure     |
| EPIC-18-S36 | `doctor --json` and the exit-code contract agree with the text renderer                | KAR-18.4           | Edge case   |
| EPIC-18-S37 | Happy path: one build, one tarball, UI assets as plain files                           | KAR-18.5           | Happy path  |
| EPIC-18-S38 | `@DeFlow/*` inlined, `@lydell/node-pty` external                                       | KAR-18.5           | Edge case   |
| EPIC-18-S39 | `publint` and `attw` gate the release                                                  | KAR-18.5           | Failure     |
| EPIC-18-S40 | **A `paths` alias: green in dev, broken in the tarball, no warning**                   | KAR-18.5           | Failure     |
| EPIC-18-S41 | A deep cross-package import breaks the published resolution                            | KAR-18.5           | Failure     |
| EPIC-18-S42 | **Happy path: the real tarball installed into a clean temp directory and run**         | KAR-18.6           | Happy path  |
| EPIC-18-S43 | **A missing `files` entry drops `dist/ui/` and serves a blank page**                   | KAR-18.6           | Failure     |
| EPIC-18-S44 | The shebang or the exec bit is lost on `dist/bin.mjs`                                  | KAR-18.6           | Failure     |
| EPIC-18-S45 | No compiler on the box: nothing invokes `node-gyp`                                     | KAR-18.6           | Edge case   |
| EPIC-18-S46 | The clean room runs `doctor` and gets an honest, agent-free report                     | KAR-18.6           | Edge case   |
| EPIC-18-S47 | `DeFlow ledger snapshot` produces one consistent, sidecar-free file                    | KAR-18.7           | Happy path  |
| EPIC-18-S48 | `DeFlow status` with a live daemon, and with none at all                               | KAR-18.7           | Happy path  |
| EPIC-18-S49 | `DeFlow status` after a SIGKILL reports `stale`, and signals nothing                   | KAR-18.7           | Recovery    |

---

## EPIC-18-S1 — Happy path: `DeFlow init` bootstraps a repository

**Verifies:** KAR-18.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario: init in a clean repository
    Given a git repository on branch "main" with no ".DeFlow" directory
    And a ".gitignore" containing only "node_modules/"
    When the operator runs "DeFlow init"
    Then ".DeFlow/config.yaml" exists and validates against ".DeFlow/schemas/config.schema.json"
    And ".DeFlow/gates/", ".DeFlow/templates/" and ".DeFlow/memory/" exist
    And ".DeFlow/.worktreeinclude" exists
    And ".gitignore" now also contains ".DeFlow/daemon.json", ".DeFlow/wt/" and ".DeFlow/runs/"
    And the global state directory is created and its absolute path is printed
    And stdout lists each path with "created"
    And the command exits 0
    And "git status --porcelain" shows only ".DeFlow/" and ".gitignore" as changes
```

**Notes:** the two halves of `.DeFlow/` are not interchangeable — the committed half is a team
artefact reviewed in pull requests, the gitignored half is per-machine. The last Then matters: `init`
must not leave the repository dirty in any other way, because the first thing an operator does after
`init` is commit it.

---

## EPIC-18-S2 — Re-running `init` never clobbers an edited config

**Verifies:** KAR-18.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario: init is idempotent and non-destructive
    Given "DeFlow init" has already run
    And the operator has edited ".DeFlow/config.yaml" to set a run budget ceiling of 25.00
    And the operator has added ".DeFlow/gates/typecheck.yaml"
    When the operator runs "DeFlow init" a second time
    Then ".DeFlow/config.yaml" still contains the budget ceiling of 25.00
    And ".DeFlow/gates/typecheck.yaml" is untouched
    And stdout reports "config.yaml  kept (edited)" and the other paths as "unchanged"
    And the command exits 0
    And "git diff --stat" reports no changes
```

**Notes:** people re-run `init` after pulling a repo, after a version bump, and by accident. A
bootstrap command that overwrites a hand-edited policy file is one that gets run once and then
avoided forever.

---

## EPIC-18-S3 — `init` outside a git working tree refuses and writes nothing

**Verifies:** KAR-18.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario: not a repository
    Given an empty temp directory with no ".git" anywhere above it
    When the operator runs "DeFlow init"
    Then stderr contains
        "DeFlow init: not inside a git working tree (run 'git init' first)"
    And the exit code is 5
    And no ".DeFlow" directory was created
    And no ".gitignore" was created
```

**Notes:** every downstream mechanism — worktrees, flat branch names `DeFlow/<runId>__<nodeId>`,
`merge-tree --write-tree` conflict detection, "never write to the default branch" — assumes a
repository. Failing here with one sentence is much cheaper than failing at worktree creation three
minutes into a run.

---

## EPIC-18-S4 — `.gitignore` entries are appended once, and the token file is never committable

**Verifies:** KAR-18.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario Outline: gitignore merge is a fixpoint
    Given a ".gitignore" in state "<state>"
    When the operator runs "DeFlow init" twice
    Then ".DeFlow/daemon.json" appears exactly once in ".gitignore"
    And ".DeFlow/wt/" appears exactly once
    And ".DeFlow/runs/" appears exactly once
    And "git check-ignore -q .DeFlow/daemon.json" exits 0

    Examples:
      | state                                             |
      | absent                                            |
      | present, ends with a newline                      |
      | present, no trailing newline on the last line     |
      | already contains ".DeFlow/wt/" and nothing else    |
      | already contains all three entries                 |
```

**Notes:** `daemon.json` holds a 32-byte bearer token that authorises spawning processes on the
user's machine. The "no trailing newline" row is not pedantry — a naive append concatenates onto the
previous pattern and silently ignores both.

---

## EPIC-18-S5 — `init` when the global state directory is not writable

**Verifies:** KAR-18.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario: unwritable data dir
    Given XDG_DATA_HOME points at a directory with mode 0500
    When the operator runs "DeFlow init"
    Then stderr names the absolute path it tried to create
    And stderr names the errno "EACCES"
    And stderr suggests setting XDG_DATA_HOME or fixing the permissions
    And the exit code is 5
    And no partial state directory was left behind
```

**Notes:** the global dir is where the ledger, the lease, the blob store and the recordings live. A
raw `Error: EACCES: permission denied, mkdir '/…'` stack trace is technically the same information
and practically useless — domain failures are values in a closed union, and `throw` is reserved for
programmer bugs.

---

## EPIC-18-S6 — Provider detection at `init` writes to the global cache, never to the committed config

**Verifies:** KAR-18.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: workspace bootstrap

  Scenario: detection result is machine-local
    Given the mock agent is symlinked onto the temp PATH as "claude"
    When the operator runs "DeFlow init"
    Then stdout reports one detected agent with its absolute resolved path
    And a probe cache file exists under the global state directory
    And ".DeFlow/config.yaml" contains no capability field for any provider
    And ".DeFlow/config.yaml" contains no absolute path
```

**Notes:** AR-5 — capability is probed at runtime and persisted, never hardcoded. A committed
`config.yaml` that records "claude supports resume" is a hardcoded matrix with extra steps, and it
would be wrong on a colleague's machine on day one. The absolute-path assertion matters for the same
reason: the committed half travels between machines.

---

## EPIC-18-S7 — Happy path: `DeFlow up` to a browser in under three seconds

**Verifies:** KAR-18.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: daemon lifecycle

  Scenario: first boot
    Given an initialised repository and a warm provider probe cache
    When the operator runs "DeFlow up --timings --no-open"
    Then the daemon binds 127.0.0.1 and no other interface
    And ".DeFlow/daemon.json" exists with { pid, port, token, startedAt } at mode 0600
    And the token is 32 bytes of crypto.randomBytes encoded base64url
    And stdout contains a URL of the form "http://127.0.0.1:<port>/#token=<token>"
    And the token appears in the URL fragment and never in a query string
    And "GET /api/health" returns 200 without an Authorization header
    And "GET /api/runs" without an Authorization header returns 401
    And the printed total from --timings is under 3000 ms
    And the eight boot steps each report their own duration
```

**Notes:** NF3 is a budget, and steps 2 (open + migrate) and 4 (probe providers) are the two that can
blow it. `--timings` exists so that the first regression is one line of output rather than an
afternoon of bisecting. The fragment — not a query parameter — is the whole point of
[11 §8.1](../../11-api-and-realtime.md): a query string lands in shell history, terminal scrollback,
browser history, `Referer` headers and any access log anyone ever adds.

---

## EPIC-18-S8 — A second `DeFlow up` is refused by the single-instance lease

**Verifies:** KAR-18.2 · **Type:** Concurrency · **Automated at:** e2e

```gherkin
Feature: daemon lifecycle

  Scenario: two terminals, one daemon
    Given DeFlowd is running with pid 4711 on port 7777 holding the flock on
          "<dataDir>/DeFlow.lock" with daemon_epoch = 3
    When the operator runs "DeFlow up" in a second terminal against the same data directory
    Then stderr contains
        "DeFlow up: another DeFlowd is already running (pid 4711, port 7777) — open
         http://127.0.0.1:7777 or run 'DeFlow status'"
    And the exit code is 2
    And daemon_epoch is still 3
    And ".DeFlow/daemon.json" still holds pid 4711
    And no second HTTP listener was bound
    And no event was appended to the ledger by the second process
```

**Notes:** this is described in the architecture as _"very common"_, and it is the reason the lease
exists at all. SQLite enforces one _writer_, but that does not stop two schedulers interleaving
effect execution — two daemons would happily drive the same run twice. The negative assertions are
the load-bearing ones: the refused process must not bump the epoch and must not write.

---

## EPIC-18-S9 — Port 7777 is occupied: the next free port, reported consistently everywhere

**Verifies:** KAR-18.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: port collision with an unrelated process
    Given an unrelated process is listening on 127.0.0.1:7777
    And no DeFlowd holds the lease
    When the operator runs "DeFlow up --no-open"
    Then the daemon binds the next free port reported by get-port
    And the printed URL carries that port
    And ".DeFlow/daemon.json".port equals that port
    And "DeFlow status" reports that port
    And "GET /api/health" on that port returns 200
    And the process on 7777 is untouched
```

**Notes:** the failure this prevents is the port being chosen once and re-derived from the constant
`7777` somewhere else — the URL says one thing, `daemon.json` says another, and the UI cannot
authenticate. Note this is _not_ the two-daemon case: 7777 being busy is not evidence that DeFlow is
running, which is why the lease and the port are separate checks in separate steps.

---

## EPIC-18-S10 — An explicitly pinned `--port` that is occupied fails instead of drifting

**Verifies:** KAR-18.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: pinned port is a contract
    Given an unrelated process is listening on 127.0.0.1:8080
    When the operator runs "DeFlow up --port 8080"
    Then stderr names port 8080 and states that it is in use
    And the exit code is 2
    And no daemon was started on any other port
    And ".DeFlow/daemon.json" was not modified
```

**Notes:** the automatic next-free-port behaviour is a convenience for the default. When a human
pinned a port — because a tunnel, a bookmark or a reverse proxy points at it — silently choosing a
different one produces a daemon nobody can reach and no error to explain it.

---

## EPIC-18-S11 — A pre-migration backup exists before `user_version` moves

**Verifies:** KAR-18.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: migration takes a cheap safety net first
    Given a file-backed ledger at PRAGMA user_version = 4
    And the shipped migration set advances it to 5
    When the daemon boots
    Then "pre-migrate-4.db" exists in the global state directory before the migration runs
    And PRAGMA integrity_check on that backup returns "ok"
    And after boot PRAGMA user_version is 5
    And the backup has no "-wal" or "-shm" sidecar
```

**Notes:** `VACUUM INTO` was **measured at 1007 ms for a 193 MB database** — an acceptable safety net
for something that runs once per schema change. Migrations are append-only and there are no `down`
migrations, so the backup _is_ the rollback story.

---

## EPIC-18-S12 — A failed migration rolls back and no listener is ever bound

**Verifies:** KAR-18.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: a migration that throws mid-way
    Given a file-backed ledger at PRAGMA user_version = 4
    And a migration to 5 that creates one table and then raises
    When the daemon boots
    Then PRAGMA user_version is still 4
    And the table created by the failed migration does not exist
    And "pre-migrate-4.db" exists
    And no HTTP listener was bound on any port
    And the process exits non-zero with a message naming the migration file
    And a subsequent boot with the migration fixed succeeds and reaches user_version 5
```

**Notes:** SQLite DDL is transactional, so a failed migration rolls back cleanly — but only if the
whole migration runs inside one transaction. The "no listener was bound" assertion is what stops a
half-migrated ledger from being served to a UI that would then render a plausible, wrong picture.
This scenario is impossible against `:memory:`, which is why the file-backed rule is in the
Background.

---

## EPIC-18-S13 — A stale `daemon.json` from a SIGKILLed daemon does not block startup

**Verifies:** KAR-18.2 · **Type:** Recovery · **Automated at:** e2e

```gherkin
Feature: daemon lifecycle

  Scenario: boot after kill -9
    Given DeFlowd was running with a mock agent child mid-turn
    And the daemon was killed with SIGKILL, leaving ".DeFlow/daemon.json" behind
    And the flock was released by the kernel when the process died
    When the operator runs "DeFlow up --no-open"
    Then the lease is acquired and daemon_epoch is bumped by exactly 1
    And ".DeFlow/daemon.json" is rewritten with the new pid, port and token
    And the ledger is replayed and RunState is rebuilt from the event log
    And every effect row left "pending" by the previous daemon life is reconciled
    And no completed node is re-executed
    And the run either resumes or halts with a typed failure — it never wedges
```

**Notes:** `pnpm dev` runs the daemon under `node --watch`, so this path executes on **every file
save** during development. That is deliberate: it is free, continuous, adversarial testing of F4.2.
If resume breaks you find out in seconds rather than in hour three of a real run — do not "fix" the
restart.

---

## EPIC-18-S14 — Orphan reaping matches `(pid, process_start_time)`, never a bare pid

**Verifies:** KAR-18.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: a recycled pid must not be killed
    Given the previous daemon recorded an agent child at pid 5150 with a recorded start time
    And that process is gone
    And an unrelated long-lived process now occupies pid 5150 with a different start time
    When DeFlowd boots and runs orphan reaping
    Then no signal is sent to pid 5150
    And the unrelated process is still alive afterwards
    And the reaping report records the pid as "gone (start time mismatch)"
    And "git worktree unlock" is run for every worktree whose owning process is gone

  Scenario: a genuine orphan is reaped
    Given a detached mock agent process whose recorded (pid, start time) both match
    When DeFlowd boots and runs orphan reaping
    Then the process group is signalled SIGTERM, then SIGKILL after the grace period
    And no process in that group remains, excluding processes in state "Z"
```

**Notes:** pids are recycled, and on a laptop that has been suspended overnight they are recycled
often. Killing by bare pid is how a background build, an editor or a database gets shot by a
daemon's boot sequence. The `Z`-state exclusion in the second scenario is the verified trap: after a
successful group SIGKILL the grandchildren are still listed by `ps`, in zombie state with `ppid=1`,
awaiting reaping by init — and reaping lags badly inside containers, which is exactly where you
cannot attach a debugger.

---

## EPIC-18-S15 — First run on a machine with no agent CLI installed at all

**Verifies:** KAR-18.2, KAR-18.4 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: graceful degradation

  Scenario: a fresh laptop with nothing but node, pnpm, git and a browser
    Given a temp PATH containing node, pnpm and git and no agent binary of any kind
    And no ANTHROPIC_API_KEY, OPENAI_API_KEY or any other provider credential in the environment
    When the operator runs "DeFlow up --no-open"
    Then the daemon starts and binds a port
    And stdout contains "0 providers available"
    And stdout names each supported vendor with the command that installs it
    And stdout states that "DeFlow replay" and the bundled mock agent work with no provider
    And the exit code is 0
    And no stack trace appears on stderr

  Scenario: what the daemon refuses, and what it still allows
    Given the daemon from the previous scenario is running
    When the operator submits a task through "DeFlow run"
    Then the run is created and "task.submitted" is appended to the ledger
    And planning refuses to schedule any agent node with a typed failure naming the missing
        provider, rather than failing the whole run at boot
    And "DeFlow replay fixtures/happy-path-12.jsonl" serves a full run over the same HTTP contract
```

**Notes:** this is the first-contact experience for every colleague at M2, and the failure it guards
against is the opaque one — a crash inside a provider probe that says `ENOENT: spawn claude` and
tells the operator nothing about what to do. NF7 is explicit that one provider being unavailable
degrades the plan rather than killing the run; _zero_ providers is the same rule taken to its limit.
The second scenario matters because it is what makes the whole UI developable on a train: the mock
agent binary and `DeFlow replay` ship inside the tarball.

---

## EPIC-18-S16 — Graceful shutdown releases the lease and leaves nothing behind

**Verifies:** KAR-18.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: daemon lifecycle

  Scenario: SIGINT with work in flight
    Given DeFlowd is running with one mock agent child mid-turn
    When the daemon receives SIGINT
    Then the child process group is signalled SIGTERM, then SIGKILL after a 5 s grace
    And no process remains in that group, excluding processes in state "Z"
    And the flock on "<dataDir>/DeFlow.lock" is released
    And ".DeFlow/daemon.json" no longer exists
    And the interrupted node is recorded in the ledger with a typed failure, not left "running"
    And a subsequent "DeFlow up" starts cleanly with no manual intervention
```

**Notes:** SIGTERM tests the shutdown handler; SIGKILL (S13) tests durability. Both must work, and
they are different code paths. The "not left running" assertion is what stops the next boot from
reconciling a node that no process is executing.

---

## EPIC-18-S17 — The probe cache is what keeps the second cold start inside NF3

**Verifies:** KAR-18.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: daemon lifecycle

  Scenario: cached probe on an unchanged version
    Given a probe cache recorded against mock agent version "1.0.0" and its entry-file sha256
    And the binary on PATH still reports "1.0.0" with the same sha256
    When DeFlowd boots
    Then no ACP "initialize" handshake is performed
    And the --timings line for the probe step is under 50 ms

  Scenario: the cache is invalidated by a version change
    Given the same cache
    And the binary on PATH now reports "1.1.0"
    When DeFlowd boots
    Then a real "initialize" handshake is performed against that binary
    And the capability manifest is rewritten with the new version and sha256
    And the probe step's duration is reported honestly in --timings
```

**Notes:** the probe is cached and refreshed **on a version change, not on every start** — that is
the specific concession that makes the eight-step boot fit in three seconds. Keying on the sha256 as
well as the version string catches a rebuilt binary at an unchanged version, which is common with
locally-linked or nightly agent builds.

---

## EPIC-18-S18 — Happy path: `DeFlow run` with no daemon running

**Verifies:** KAR-18.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: headless execution

  Scenario: one command, one completed run, no browser
    Given an initialised repository and no daemon running
    And the mock agent on the temp PATH scripted with a four-node plan that passes its gate
    When the operator runs: DeFlow run "add a health endpoint"
    Then DeFlowd is spawned detached and "GET /api/health" is polled until it answers
    And the run is created and the CLI subscribes to the stream from seq 0
    And the terminal shows each node transitioning through scheduled → started → completed
    And the gate verdict and the branch name "DeFlow/<runId>__<nodeId>" are printed
    And the final line reports total cost and wall-clock duration
    And the exit code is 0
    And the rendered transcript matches its file snapshot through the normalising serializer
```

**Notes:** this is the story the roadmap gates the view work on: _"Do not start W11 until at least
one full run completes headlessly."_ It is also the recorder — the six replay fixtures are recorded
from real mock-agent runs driven through this command, never hand-written, because hand-written
fixtures encode assumptions about the event stream rather than its actual shape.

---

## EPIC-18-S19 — `DeFlow run` attaches to a daemon that is already up

**Verifies:** KAR-18.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: headless execution

  Scenario: attach, never launch a second
    Given DeFlowd is already running and ".DeFlow/daemon.json" is current
    When the operator runs: DeFlow run "…"
    Then no second DeFlowd process is spawned
    And daemon_epoch is unchanged
    And the CLI authenticates with the bearer token read from ".DeFlow/daemon.json"
    And the run appears in the browser tab that is already open, on the same stream
```

**Notes:** the CLI and the browser are two clients of one daemon, not two engines. The epoch
assertion is how a regression to "always autostart" is caught — an autostart that trips the lease
would exit 2 and look like a CLI bug rather than a design bug.

---

## EPIC-18-S20 — The first Ctrl-C detaches; the second cancels

**Verifies:** KAR-18.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: headless execution

  Scenario: detach
    Given "DeFlow run" is streaming a run with a mock agent mid-turn
    When the operator presses Ctrl-C once
    Then stdout contains
        "detached — run <runId> continues; 'DeFlow run --attach <runId>' to watch,
         'DeFlow cancel <runId>' to stop"
    And the CLI exits 130
    And the run reaches "run.completed" afterwards without the CLI attached

  Scenario: cancel
    Given "DeFlow run" is streaming a run with a mock agent mid-turn
    When the operator presses Ctrl-C twice within 3 seconds
    Then "run.aborted" is appended to the ledger
    And every child process in the run's process groups is terminated
    And no process remains, excluding processes in state "Z"
    And the CLI exits 130
```

**Notes:** detach-by-default is the right behaviour for runs measured in hours, and it is surprising
enough that the message must state both alternatives. The double-tap is the same interaction people
already know from other long-running CLIs, and it maps onto the F5.7 kill switch rather than onto a
polite shutdown.

---

## EPIC-18-S21 — Killing the CLI does not kill the run

**Verifies:** KAR-18.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: headless execution

  Scenario: SIGKILL the launcher
    Given "DeFlow run" autostarted DeFlowd and is streaming a run
    When the CLI process is killed with SIGKILL
    Then DeFlowd is still alive
    And DeFlowd is not a member of the CLI's process group
    And the agent child process is still alive
    And the run reaches a terminal state
    And "DeFlow run --attach <runId>" from a new terminal shows the completed transcript
```

**Notes:** the daemon owns execution — _"close the browser, close the laptop lid, reboot, the run
resumes"_ — and that property starts with the daemon not being a child of whatever launched it. If
`DeFlowd` were spawned in the CLI's process group, closing the terminal would take down an
hours-long run, which is precisely the failure mode this whole architecture exists to avoid.

---

## EPIC-18-S22 — The stream drops mid-run: a Node client has no `Last-Event-ID`

**Verifies:** KAR-18.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: headless execution

  Scenario: resume by explicit cursor
    Given "DeFlow run" has rendered events up to seq 41
    When the SSE connection is dropped
    Then the CLI reconnects with "?since=41"
    And it sends no Last-Event-ID header, because it has no browser reconnection logic to set one
    And every event after 41 is rendered exactly once
    And no event before 41 is rendered a second time

  Scenario: a gap in the sequence is healthy
    Given the ledger's seq values jump 4, 5, 7 because a rolled-back transaction burned 6
    When the CLI resumes from seq 5
    Then it renders seq 7 without reporting data loss
    And it never waits for seq 6
```

**Notes:** `EventSource` sends `Last-Event-ID` only on its own automatic reconnect — never on a fresh
connection — and it cannot set custom headers at all, which is why the client library is
`eventsource-client` and why `?since=` is mandatory rather than an optimisation. The gap scenario
encodes the contract: **resume from strictly greater than `seq`**, never "expect `seq + 1`".
`AUTOINCREMENT` values are burned by rolled-back transactions and a real SIGKILL produces exactly
this shape.

---

## EPIC-18-S23 — Exit codes for every terminal state

**Verifies:** KAR-18.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: headless execution

  Scenario Outline: the exit code is a closed contract
    Given a run whose reduced state reaches "<terminal state>"
    When "DeFlow run" observes it with flags "<flags>"
    Then the process exits with code <code>
    And the final line names the reason in one sentence

    Examples:
      | terminal state                       | flags       | code |
      | completed, all gates passed          |             | 0    |
      | completed, one gate failed           |             | 1    |
      | node failed after exhausting retries |             | 1    |
      | paused on a run budget ceiling       |             | 3    |
      | awaiting a human gate                | --no-wait   | 4    |
      | awaiting a human gate                |             | 0    |
      | aborted by the operator              |             | 130  |
      | environment unusable (git < 2.38)    |             | 5    |
```

**Notes:** exit codes are the CLI's API for CI, and the interesting row is the pair on "awaiting a
human gate": with `--no-wait` it is a distinct code (4) so a pipeline can branch, and without it the
CLI blocks and eventually reports the resolved outcome. A budget pause is 3 and not 1 because
[F4.6](../../prd.md) is explicit that hitting a ceiling **pauses for a human decision rather than
failing** — collapsing it into "failure" would train the operator to ignore it.

---

## EPIC-18-S24 — Intake from text, file, issue and spec

**Verifies:** KAR-18.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: headless execution

  Scenario Outline: F1.1 sources
    Given an initialised repository and a running daemon
    When the operator runs "DeFlow run <argument>"
    Then "task.submitted" provenance records source kind "<kind>" and the locator "<locator>"
    And the framing interview receives the resolved content, not the locator
    And ".DeFlow/runs/<runId>/" records the source on disk in an open format

    Examples:
      | argument                     | kind  | locator            |
      | "migrate the button to v3"   | text  | —                  |
      | --file docs/task.md          | file  | docs/task.md       |
      | --issue owner/repo#42        | issue | owner/repo#42      |
      | --spec .DeFlow/specs/x.yaml  | spec  | .DeFlow/specs/x.yaml |
```

**Notes:** recording the _locator_ as well as the content is what lets the node inspector answer
"where did this task come from" six weeks later. A `--file` implementation that inlines content and
discards the path loses that permanently, and the loss is invisible until someone asks.

---

## EPIC-18-S25 — `--json` in a pipe: NDJSON, no ANSI, one renderer per stream

**Verifies:** KAR-18.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: headless execution

  Scenario: machine-readable output
    Given stdout is a pipe rather than a TTY
    When the operator runs "DeFlow run --json '…'"
    Then every line of stdout parses as a single JSON object
    And no line contains an ANSI escape sequence
    And each line carries "seq", "kind" and "runId"
    And the sequence of "seq" values is strictly increasing
    And the exit code follows the same contract as the human renderer
```

**Notes:** the human renderer and the JSON renderer are two renderings of one event stream, not two
clients — there is exactly one stream implementation shared with the browser. A TTY check evaluated
once at module import (rather than at render time) is the usual way colour leaks into a pipe.

---

## EPIC-18-S26 — Happy path: `doctor` on a fully provisioned machine

**Verifies:** KAR-18.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario: everything is fine, and it says so specifically
    Given node >= 24, pnpm 11.18.0, git 2.45 or later
    And a writable global state dir and a writable repo-local ".DeFlow/"
    And the mock agent on the temp PATH advertising a full capability profile
    When the operator runs "DeFlow doctor"
    Then the report contains the sections
        Runtime, git, Sandboxing, Agents, Capabilities, Conformance, Auth shadowing,
        PTY and Memory layer
    And every check reports exactly one of "ok", "warn" or "fail" with a reason
    And no section is empty and no section is omitted
    And the git section states that "merge-tree --write-tree" was executed successfully
    And the Agents section lists the absolute resolved path, --version output and entry-file sha256
    And the exit code is 0
```

**Notes:** the absolute resolved path is not decoration. DeFlowd's `PATH` at daemon start differs
from the login shell's, so the adapter layer resolves and stores an absolute path rather than
relying on `PATH` lookup at spawn time — and `doctor` reports the same path the daemon would
actually spawn.

---

## EPIC-18-S27 — `doctor` with no agent CLI: degrade with instructions, not a stack trace

**Verifies:** KAR-18.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario: nothing installed
    Given a temp PATH with node, pnpm and git and no agent binary
    When the operator runs "DeFlow doctor"
    Then the Agents section reports "0 installed"
    And for each supported vendor the report names the install command
    And the Capabilities section reports that no matrix could be generated, and why
    And the Conformance section is reported as "skipped — no adapter installed", not as passing
    And the Sandboxing section still reports which permission levels the platform could honour
    And the report states that the bundled mock agent and "DeFlow replay" need no provider
    And the exit code is 0
    And stderr is empty
```

**Notes:** the required behaviour here is **degrading, not failing** — the very first thing a new
user runs is `doctor`, and the difference between "0 installed, here is how to install one" and
`ENOENT: spawn claude` decides whether they try again. The Conformance line is the subtle one:
reporting "skipped" rather than "passed" prevents a green `doctor` on a machine where nothing was
actually tested, which is how a broken adapter reaches a three-hour run.

---

## EPIC-18-S28 — git version gates: 2.37 fails, 2.44 warns, 2.45 is exercised not inferred

**Verifies:** KAR-18.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: the git gate
    Given a "git" shim on the temp PATH reporting "<version>"
    When the operator runs "DeFlow doctor"
    Then the git check reports "<status>"
    And the reason mentions "<mechanism>"
    And the process exits <code>

    Examples:
      | version | status | mechanism                        | code |
      | 2.37.0  | fail   | merge-tree --write-tree          | 5    |
      | 2.38.0  | warn   | worktree list --porcelain -z     | 0    |
      | 2.44.1  | warn   | worktree list --porcelain -z     | 0    |
      | 2.45.0  | ok     | merge-tree --write-tree          | 0    |

  Scenario: the version string is not trusted on its own
    Given a real git 2.45 or later on PATH
    When the operator runs "DeFlow doctor"
    Then "git merge-tree --write-tree" is actually executed against a scratch repository
    And a clean merge returns exit 0 and a conflicting merge returns exit 1
    And the report says the command was executed, not that the version implies support
```

**Notes:** `merge-tree --write-tree` landed in git 2.38 and is the ground truth for conflict
detection between concurrent write nodes — declared path scopes are demoted to a plan-time
prediction precisely because agents violate them, so this is the gate. Below 2.38 DeFlow refuses to
schedule write nodes at all. 2.45 is preferred because `worktree list --porcelain -z` output
stabilised there; below it, enumeration needs string parsing that breaks on paths with spaces or
newlines.

---

## EPIC-18-S29 — Linux sandbox prerequisites, including the AppArmor restriction that fails open

**Verifies:** KAR-18.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: which permission levels are honourable on this machine
    Given the platform is Linux
    And bubblewrap is "<bwrap>" and socat is "<socat>" on PATH
    And "sysctl kernel.apparmor_restrict_unprivileged_userns" returns "<userns>"
    When the operator runs "DeFlow doctor"
    Then the honourable permission levels are "<levels>"
    And the report status is "<status>"

    Examples:
      | bwrap   | socat   | userns | levels                              | status |
      | present | present | 0      | read, worktree, worktree+net, full  | ok     |
      | absent  | present | 0      | read                                | warn   |
      | present | absent  | 0      | read                                | warn   |
      | present | present | 1      | read                                | warn   |

  Scenario: the fix is named, and the fail-closed policy is stated
    Given bubblewrap is absent
    When the operator runs "DeFlow doctor"
    Then the report names "sudo apt install bubblewrap socat"
    And where the AppArmor restriction is in effect it names "/etc/apparmor.d/bwrap"
    And the report states that DeFlow sets "sandbox.failIfUnavailable: true" and
        "allowUnsandboxedCommands: false" for every non-"full" level
    And the report states that without those settings the vendor CLI silently runs unsandboxed
```

**Notes:** this is the highest-value check in the whole command. Claude Code's sandbox **silently
falls back to running unsandboxed** when its dependencies are missing, and on Ubuntu 24.04 and later
AppArmor blocks bubblewrap's unprivileged user namespaces by default — a `1` from that sysctl means
the sandbox fails open. In both cases the F5.4 permission ladder becomes decorative and nothing else
in the system notices. Reporting _honourable levels_ rather than "sandbox: ok" is what makes the
degradation actionable.

---

## EPIC-18-S30 — Auth shadowing is loud, and `doctor` still reads no credential file

**Verifies:** KAR-18.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario: the silent billing failure, made loud
    Given "ANTHROPIC_API_KEY" is present in the environment
    And the repository config selects subscription auth for the Claude provider
    When the operator runs "DeFlow doctor"
    Then the Auth shadowing section names the variable "ANTHROPIC_API_KEY"
    And it names the provider whose subscription auth it shadows
    And it states which credential will actually be used
    And it states that at run start the variable is stripped from the child environment and a
        "provider.auth_shadow_stripped" event is recorded
    And the status is "warn", not "ok"

  Scenario: AR-1 holds even while reporting on auth
    When the operator runs "DeFlow doctor" under a syscall or fs-access assertion
    Then no file under "~/.claude", "~/.codex" or "~/.config/gcloud" is opened
    And no auth or login subcommand's stdout is captured
    And where a vendor CLI reports a login command, doctor prints it for the operator to run
```

**Notes:** the failure mode this exists for is stated in the PRD in one sentence: _"you thought you
were on your subscription and you were being billed."_ Nothing else in the system can detect it,
because from the vendor CLI's point of view nothing is wrong. The second scenario is the AR-1 guard
— "never possesses a model credential" has to be verifiable by inspection, and a `doctor` that
helpfully checks whether you are logged in by reading a token file would break it silently.

---

## EPIC-18-S31 — The capability matrix is regenerated, never asserted from a constant

**Verifies:** KAR-18.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: a mock agent wearing each vendor's capability profile
    Given "DeFlow-mock-agent --agent-capabilities <profile>" is on the temp PATH as "<name>"
    When the operator runs "DeFlow doctor"
    Then the regenerated matrix records session.resume = <resume>
    And it records fork = <fork> and list = <list>
    And the report states the resume strategy DeFlow would use for that adapter
    And the matrix fixture file is rewritten with a probe timestamp

    Examples:
      | profile              | name    | resume | fork  | list  |
      | claude-agent-acp     | claude  | true   | true  | true  |
      | codex-acp            | codex   | true   | false | true  |
      | opencode-acp         | opencode| true   | true  | true  |
      | copilot-acp          | copilot | false  | false | true  |
      | gemini-acp           | gemini  | false  | false | false |

  Scenario: no capability constant survives in the source
    When the repository is scanned
    Then no file in "packages/cli" or "packages/adapters" contains a hardcoded capability table
    And the only capability source is the generated fixture with its probe timestamp
```

**Notes:** the Examples table is the **verified 2026-08-02** live probe of `claude-agent-acp@0.64.1`,
`codex-acp@1.1.9`, `opencode@1.18.11`, `copilot@1.0.77` and `gemini@0.53.1` — **two of five cannot
resume at all**. Making `agentCapabilities` a mock-agent flag is what turns "does resume-by-replay
work on a Gemini-shaped profile?" from an integration test needing an installed, authenticated
Gemini CLI into a unit test that runs in 40 ms. The second scenario enforces AR-5 mechanically: two
of those five versions were published the same day they were probed, so a constant would be wrong
within a month.

---

## EPIC-18-S32 — Version and binary-hash drift since the last recorded probe

**Verifies:** KAR-18.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: drift is a warning with both values
    Given a recorded manifest for "claude" at version "<recorded ver>" and sha256 "<recorded sha>"
    And the installed binary reports "<installed ver>" with sha256 "<installed sha>"
    When the operator runs "DeFlow doctor"
    Then the Agents check reports "<status>"
    And where it warns, both the recorded and the installed values appear in the message
    And where it warns, the message points at "pnpm test:record" for refreshing the goldens

    Examples:
      | recorded ver | recorded sha | installed ver | installed sha | status |
      | 0.64.1       | aaa…         | 0.64.1        | aaa…          | ok     |
      | 0.64.1       | aaa…         | 0.65.0        | bbb…          | warn   |
      | 0.64.1       | aaa…         | 0.64.1        | bbb…          | warn   |
```

**Notes:** the third row is the one people forget — a locally-linked or nightly build at an unchanged
version string. Recordings are keyed on the exact agent version so a bump produces a visible new
directory in a pull request rather than silently invalidating old goldens; the hash catches the case
where the version string lies. This is the G7 flag-churn detector doing its job before a user's
three-hour run does it instead.

---

## EPIC-18-S33 — An unwritable state directory is a typed failure with a path

**Verifies:** KAR-18.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: writability is tested by writing
    Given "<dir>" has mode 0500
    When the operator runs "DeFlow doctor"
    Then the Runtime check reports "fail"
    And the message contains the absolute path and the errno "EACCES"
    And the exit code is 5

    Examples:
      | dir                     |
      | the global state dir    |
      | the repo-local .DeFlow/ |
```

**Notes:** the check must attempt a real write and remove it, not call `existsSync`. A directory that
exists and is not writable is the common case (a repo checked out by another user, a read-only mount,
a `$XDG_DATA_HOME` pointing somewhere managed), and `existsSync` reports it as fine.

---

## EPIC-18-S34 — The memory layer: calibration factor, FTS5 and its exact tokenizer

**Verifies:** KAR-18.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario: what the memory section reports
    Given a file-backed ledger whose "artifact_fts" table exists
    When the operator runs "DeFlow doctor"
    Then the Memory layer section reports FTS5 as available
    And it reports the tokenizer exactly as
        unicode61 remove_diacritics 2 tokenchars '_-.'
    And it reports the tokenEstimateFactor per (provider, model) with its sample count n
    And it reports the secretlint rule count

  Scenario Outline: the calibration factor before and after convergence
    Given <n> recorded samples for ("<provider>", "<model>")
    When the operator runs "DeFlow doctor"
    Then the reported factor is "<reported>"

    Examples:
      | provider  | model      | n  | reported                        |
      | anthropic | opus-x     | 0  | 1.2 (seed, n=0)                 |
      | anthropic | opus-x     | 3  | 1.2 (seed, n=3)                 |
      | anthropic | opus-x     | 24 | the converged EWMA value, n=24  |
      | openai    | gpt-x      | 0  | 1.0 (seed, n=0)                 |
      | other     | local-y    | 0  | 1.05 (seed, n=0)                |
```

**Notes:** the tokenizer string is asserted **exactly** because it is set at table creation and is
unchangeable afterwards — without `tokenchars '_-.'`, `snake_case`, `kebab-case` and `file.ext`
fragment and recall on code and stack traces collapses. Reading it back from the table definition
rather than re-deriving it from a default is the difference between a check and a tautology. The
seed values (`anthropic 1.2`, `openai 1.0`, default `1.05`) are used until `n >= 5`, and the EWMA
converges in roughly 20 samples.

---

## EPIC-18-S35 — `@lydell/node-pty` did not load: degrade to no-TTY and say so

**Verifies:** KAR-18.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario: an unsupported platform for the only native optional dependency
    Given the optional dependency "@lydell/node-pty" fails to load
    When the operator runs "DeFlow doctor"
    Then the PTY check reports "warn"
    And the message states that "terminal/*" degrades to a no-TTY spawn
    And the message states that the terminal capability is not advertised to agents
    And the exit code is 0
    And a run started afterwards completes, with terminal-dependent behaviour absent rather
        than failing
```

**Notes:** **no agent process needs a TTY** — ACP and every headless mode is a pure pipe protocol
across all five agents probed — so a pty is needed only for DeFlow's own ACP `terminal/*`
implementation. That makes the fallback survivable rather than fatal, which is why the dependency is
an `optionalDependency` with a plain-`spawn` fallback and why this is a `warn` and not a `fail`. It
is also the only native install risk left in `npx DeFlow up`.

---

## EPIC-18-S36 — `doctor --json` and the exit-code contract agree with the text renderer

**Verifies:** KAR-18.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: environment probe

  Scenario Outline: one status model, two renderings
    Given a fixture of raw probe results containing "<mix>"
    When "DeFlow doctor" and "DeFlow doctor --json" are both run against it
    Then both renderings report the same status for every check
    And both exit with code <code>

    Examples:
      | mix                       | code |
      | all ok                    | 0    |
      | ok and warn               | 0    |
      | ok, warn and one fail     | 5    |
      | two fails                 | 5    |
```

**Notes:** CI consumes the exit code, humans consume the text, and the fastest way to get them out of
step is to compute status in the renderer. One reducer, two printers.

---

## EPIC-18-S37 — Happy path: one build, one tarball, UI assets as plain files

**Verifies:** KAR-18.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: packaging

  Scenario: the fixed build order
    When "pnpm build" runs
    Then "packages/web/dist" is produced first
    And its contents are copied to "packages/cli/dist/ui/"
    And tsdown then bundles "bin.ts", "mcp.ts" and "mock-agent.ts" to "packages/cli/dist"
    And "dist/ui/" contains hashed asset files, not JavaScript-embedded strings
    And the runtime resolves them with fileURLToPath(new URL('./ui', import.meta.url))
    And the emitted file tree matches its normalised snapshot
```

**Notes:** the order is load-bearing: build the web app, copy, then bundle. Reversing the first two
steps produces a tarball with an empty `dist/ui/` and a daemon that starts and serves a blank page —
and every test inside the monorepo still passes, because `pnpm dev` serves the UI through Vite
middleware and never touches `dist/ui/` at all.

---

## EPIC-18-S38 — `@DeFlow/*` inlined, `@lydell/node-pty` external

**Verifies:** KAR-18.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: packaging

  Scenario: exactly one native runtime dependency survives
    When the built "dist/*.mjs" files are scanned
    Then no import specifier begins with "@DeFlow/"
    And no import specifier ends with ".ts"
    And "@lydell/node-pty" is the only external specifier resolved at runtime
    And "vite" appears in no built file
    And "packages/cli/package.json" lists "@lydell/node-pty" under optionalDependencies
    And "packages/cli/package.json" lists no "@DeFlow/*" dependency
```

**Notes:** `noExternal: [/^@DeFlow\//]` is what makes the single-package design work — every
`@DeFlow/*` package is private, so a leaked specifier means npm tries to fetch a name that does not
exist and the install fails for the user with a 404. `vite` is a devDependency imported dynamically
only under `DeFlow_DEV === '1'`; if it appears in the bundle, the published package drags a dev
server behind it.

---

## EPIC-18-S39 — `publint` and `attw` gate the release

**Verifies:** KAR-18.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: packaging

  Scenario: the package-shape linters run against the packed artefact
    When "pnpm pack:check" runs
    Then publint reports no errors against the built package
    And "attw --pack" reports no masked or unresolvable entry points
    And a deliberately broken "exports" map makes the command exit non-zero
```

**Notes:** the last clause is the one that matters — a gate that has never been observed failing is
not a gate. This is the same rule as "the red must be observed", applied to a release check.

---

## EPIC-18-S40 — A `paths` alias: green in dev, broken in the tarball, no warning

**Verifies:** KAR-18.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: packaging

  Scenario: the single most expensive mistake available in this layout
    Given a "paths" alias mapping "@/*" to "src/*" in a tsconfig
    And a source file importing "@/patch.ts"
    When "pnpm dev" runs
    Then the daemon starts and the import resolves, because the .ts file genuinely exists
    When the package is built and installed from the tarball
    Then the published bundle still contains the specifier "@/patch.ts"
    And the installed CLI fails at runtime with a module-not-found error

  Scenario: the guard that stops it reaching a release
    When the config guard test runs
    Then it fails if any "tsconfig*.json" in the workspace declares a "paths" key
    And the failure message explains that rewriteRelativeImportExtensions does not rewrite
        through aliases (microsoft/TypeScript#61991)
```

**Notes:** the whole hazard is that **development works**. `rewriteRelativeImportExtensions` rewrites
relative `.ts` specifiers to `.js` on emit but does not follow a `paths` alias, so the alias survives
into the emitted JavaScript. There is no warning at build time and no failure until a user installs
the package. A cheap config test is the only defence that runs before a release.

---

## EPIC-18-S41 — A deep cross-package import breaks the published resolution

**Verifies:** KAR-18.5 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: packaging

  Scenario: only the package root is importable
    Given a source file importing "@DeFlow/core/src/reduce.ts"
    When the import guard test runs
    Then it fails, naming the file and the specifier
    And the message states that the deep path exists in the workspace and not in the tarball,
        which breaks the publishConfig source→dist swap
    And it states that "index.ts" is the package's contract
```

**Notes:** each package's `exports` map exposes `.` and nothing else. A deep import both breaks the
source→dist swap and turns every internal file into public API — and, like the `paths` case, it is
invisible from inside the monorepo because the path really is there.

---

## EPIC-18-S42 — Happy path: the real tarball installed into a clean temp directory and run

**Verifies:** KAR-18.6 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: install verification

  Scenario: the exact bytes a user would get
    Given "pnpm build" and "pnpm pack:check" have passed
    And "pnpm pack" has produced "DeFlow-0.1.0.tgz"
    And a clean directory from "mktemp -d" with no node_modules above it
    When the following runs in that directory:
      | git init -b main demo                 |
      | cd demo                               |
      | npx /path/to/DeFlow-0.1.0.tgz init    |
      | npx /path/to/DeFlow-0.1.0.tgz up      |
    Then "GET /api/health" answers 200
    And "GET /" returns HTML
    And an asset referenced by that HTML under "/assets/" returns 200 with a JavaScript
        content type
    And with the tarball's own "DeFlow-mock-agent" on PATH, a scripted multi-node run driven by
        "npx /path/to/DeFlow-0.1.0.tgz run" completes and exits 0
    And no node-gyp process was spawned during the install
    And the clean directory is removed on success, and preserved under DeFlow_KEEP_TMP=1
```

**Notes:** `pnpm build` producing a green local run **proves nothing about the tarball**. The
`/assets/` assertion is the whole point of this scenario: a daemon whose `dist/ui/` is missing
answers 200 on `/` perfectly happily, because the SPA fallback serves `index.html` regardless. Only
following through to a referenced asset distinguishes "the UI shipped" from "the blank page shipped".

---

## EPIC-18-S43 — A missing `files` entry drops `dist/ui/` and serves a blank page

**Verifies:** KAR-18.6 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: install verification

  Scenario: the verifier must be able to go red
    Given a deliberately broken variant of the package with "files": ["dist/bin.mjs"]
    When the install verification job runs against it
    Then "GET /api/health" still answers 200
    And "GET /" still returns HTML
    And the referenced "/assets/" request returns 404
    And the verification job fails, naming the missing asset path
```

**Notes:** this is the named classic — _"a missing `files` entry that drops `dist/ui/`, so the daemon
starts and serves a blank page"_ — and this scenario exists to prove the verifier catches it rather
than to prove the bug exists. Building the broken variant on purpose is the only way to know the
assertion is load-bearing.

---

## EPIC-18-S44 — The shebang or the exec bit is lost on `dist/bin.mjs`

**Verifies:** KAR-18.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: install verification

  Scenario Outline: the bin must be executable and self-describing
    Given a built "dist/bin.mjs" with "<defect>"
    When "npx <tarball> --version" runs from a clean directory
    Then the command fails
    And the verification job reports "<report>"

    Examples:
      | defect                     | report                                    |
      | no "#!/usr/bin/env node"   | shebang missing from dist/bin.mjs         |
      | mode without 0o111         | dist/bin.mjs is not executable            |

  Scenario: the healthy case
    Given a correctly built "dist/bin.mjs"
    Then byte 0 is "#" and the mode includes the 0o111 bits
    And "npx <tarball> --version" prints the package version and exits 0
```

**Notes:** a bundler config change is enough to drop the shebang, and the resulting failure is a
syntax error from the shell, which reads like a corrupt download rather than a packaging bug.

---

## EPIC-18-S45 — No compiler on the box: nothing invokes `node-gyp`

**Verifies:** KAR-18.6 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: install verification

  Scenario: NF6 on a machine with no build toolchain
    Given a clean directory and a PATH containing no cc, no make and no python3
    When the tarball is installed
    Then the install log contains no occurrence of "node-gyp"
    And "better-sqlite3" resolves a prebuilt binary from
        prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node
    And "@lydell/node-pty" either resolves a per-platform optionalDependency or is skipped
    And when it is skipped, the daemon starts and doctor reports the no-TTY degradation
    And a mock run completes
```

**Notes:** `better-sqlite3@13.0.2` migrated to N-API, ships eight prebuilds with `gypfile: false` and
**no install script**, and installed in **1 second** with zero compilation; `@lydell/node-pty`
installed in **514 ms** through npm-native per-platform `optionalDependencies`. The dependency this
replaced — upstream `node-pty@1.1.0`, whose install script falls back to `node-gyp rebuild` —
**failed outright** in a toolchain-less environment, which is exactly this scenario. NF6 says no
build toolchain; this is how that stays true as dependencies drift.

---

## EPIC-18-S46 — The clean room runs `doctor` and gets an honest, agent-free report

**Verifies:** KAR-18.6 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: install verification

  Scenario: what a colleague sees on day one
    Given the tarball is installed in a clean directory with no agent CLI on PATH
    When "npx <tarball> doctor" runs
    Then the report renders every section
    And no check fails because a file was resolved relative to the workspace root
    And the Agents section reports 0 installed with install hints
    And the exit code is 0
    And the report matches its snapshot through the normalising serializer
```

**Notes:** this catches the packaging bug that only `doctor` exposes — a fixture, schema or template
path resolved relative to the monorepo root instead of through `import.meta.url`. Inside the
workspace it resolves; inside the tarball it does not exist.

---

## EPIC-18-S47 — `DeFlow ledger snapshot` produces one consistent, sidecar-free file

**Verifies:** KAR-18.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: diagnostics

  Scenario: attach my ledger to this bug report
    Given a running daemon with an active run and a non-empty WAL
    When the operator runs "DeFlow ledger snapshot <runId> --out /tmp/DeFlow-bug-1234.db"
    Then a single file exists at that path
    And no "-wal" or "-shm" sidecar exists beside it
    And "PRAGMA integrity_check" on the copy returns "ok"
    And
        SELECT seq, kind, node_id, attempt FROM event WHERE run_id='<runId>' ORDER BY seq LIMIT 50
      returns rows when run with the plain sqlite3 CLI and DeFlow not installed
    And the daemon continues serving during and after the snapshot
```

**Notes:** this is `VACUUM INTO` behind a flag — **measured at 1007 ms for a 193 MB database** — and
it is NF8 made operational: every artefact inspectable on disk in an open format. Copying the `.db`
file instead would silently lose everything still in the WAL, which is the most recent and most
relevant part of a bug report.

---

## EPIC-18-S48 — `DeFlow status` with a live daemon, and with none at all

**Verifies:** KAR-18.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: diagnostics

  Scenario: a live daemon
    Given DeFlowd is running with two active runs
    When the operator runs "DeFlow status"
    Then stdout reports the pid, port, daemon_epoch and uptime
    And it reports one summary line per active run with its id, state and node counts
    And "DeFlow status --json" reports the same values in one JSON document
    And the exit code is 0

  Scenario: no daemon at all
    Given no ".DeFlow/daemon.json" exists
    When the operator runs "DeFlow status"
    Then stdout says no daemon is running
    And it names the command to start one
    And the exit code is 0
```

**Notes:** exit 0 on "nothing running" is deliberate — `status` is a query, not an assertion, and a
non-zero exit for the normal case breaks every shell wrapper anyone writes around it. This is the
command the lease-refusal message in EPIC-18-S8 points at.

---

## EPIC-18-S49 — `DeFlow status` after a SIGKILL reports `stale`, and signals nothing

**Verifies:** KAR-18.7 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: diagnostics

  Scenario: the daemon.json outlived its daemon
    Given DeFlowd was killed with SIGKILL, leaving ".DeFlow/daemon.json" behind
    When the operator runs "DeFlow status"
    Then stdout reports the daemon as "stale" and names ".DeFlow/daemon.json"
    And it states that "DeFlow up" will take over cleanly
    And no signal is sent to the recorded pid
    And the exit code is 0

  Scenario: the recorded pid has been recycled
    Given ".DeFlow/daemon.json" records a pid now held by an unrelated process
    And the recorded start time does not match that process
    When the operator runs "DeFlow status"
    Then the daemon is reported as "stale", not as running
    And the unrelated process is untouched
```

**Notes:** the same `(pid, process_start_time)` discipline as orphan reaping (EPIC-18-S14), applied
to a read-only command. A `status` that reports a recycled pid as a live daemon sends the operator
looking for a process that is not DeFlow, and — worse — invites them to kill it.

---

**Related:** [Epic](../epics/EPIC-18-cli-packaging.md) · [Board](../board.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
