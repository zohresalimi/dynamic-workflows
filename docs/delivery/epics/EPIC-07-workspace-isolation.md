# EPIC-07: Workspace isolation and git orchestration

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-07-workspace-isolation-flows.md)

|                      |                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-07                                                                                            |
| **Status**           | Not started                                                                                        |
| **Priority**         | P0                                                                                                 |
| **Milestone**        | M1                                                                                                 |
| **Workstream**       | W5a (see [roadmap §2.2](../../17-roadmap.md))                                                      |
| **Size**             | ~17 days across 8 stories — **over the ~15-day guidance, see Risks**                               |
| **Depends on**       | EPIC-06 (the git effect kind and its idempotency contract), EPIC-03 (the `Db` port and migrations) |
| **Blocks**           | EPIC-08 (worktree path is the scope root), EPIC-12 (gates run against the integration branch)      |
| **PRD requirements** | F5.1, F5.2, F5.3, F5.5, F4.3 (git-effect idempotency), NF6, NF8                                    |
| **Architecture**     | [09-workspace-and-safety.md](../../09-workspace-and-safety.md) §§1–7, §10.6, §11.3, §13            |

## Goal

At the end of this epic DeFlow can put N write-capable agents on one repository at the same time
without any of them seeing, locking or corrupting another's files, and can tell — continuously,
in milliseconds, with zero agent cooperation — whether two in-flight branches have started to
conflict. Every git call goes through one wrapper that mechanically refuses the two operations
that cause unrecoverable damage (`worktree add --force`, any write to the default branch), every
worktree is locked at the instant it is created so a daemon restart cannot prune it out from under
a live agent, and no agent's work is ever discarded — a dirty worktree is salvaged to a commit
before it is force-removed.

## Why this matters

Worktrees are the reason parallel agent work is possible at all, and the PRD rates _"no workspace
isolation"_ (G5) as **High**: two write-capable agents in one working directory race on files and
lockfiles within minutes. But the category research is equally clear that creating a worktree is
the easy half — _"every worktree tool creates worktrees; almost none of them make the worktree
work"_ ([§5](../../09-workspace-and-safety.md)). A worktree with no `node_modules` and no `.env`
is a worktree the agent's very first command fails in.

The sharper reason is that this epic is where the _verified footguns_ live. Git will not check out
one branch twice; the real error string is `already used by worktree at`, not the
`already checked out at` that most notes claim; the operator's own current branch counts as an
occupant, so the failure lands on the **very first run**, not on some exotic concurrency case;
`--force` bypasses the check and produces exactly the two-worktrees-one-branch corruption the rule
exists to prevent; and the PRD's own `DeFlow/<run-id>/<node-id>` branch scheme cannot coexist with
a run-level integration branch because of git's refs directory/file conflict. Each of those was
run and observed on git 2.43 on 2026-08-02. Skipping this epic does not mean "no isolation" — it
means an inexplicable mid-run git failure in the merge phase of a three-hour run.

Finally, the `merge-tree` conflict matrix (D14) is the one piece of design in DeFlow the research
found no prior art for. It converts conflict from a merge-time surprise into a **scheduling
input**, for roughly forty lines of code and milliseconds per probe. It is cheap enough that not
building it would be strange, and it is what lets F5.2 be refined from "statically serialize
overlapping declared scopes" to "start in parallel, serialize on the first _detected_ conflict".

## Scope

**In scope:**

- The `Git` class in `packages/workspace/src/git.ts` — one chokepoint over `execa@^10.0.1`,
  `reject: false`, a 60 s default timeout, `gitChildEnv()`, and the two assertions
  (`assertNoForcedWorktreeAdd`, `assertNotDefaultBranchWrite`) that cannot be bypassed by a caller
  in a hurry.
- Git version gating: hard floor **2.38** (`merge-tree --write-tree`), warn below **2.45**
  (`worktree list --porcelain -z`).
- Flat branch naming (**D13**): `DeFlow/<runId>__<nodeId>` and `DeFlow/int/<runId>`, with
  `BRANCH_SAFE` validation, `git check-ref-format --branch` and leading-dash rejection.
- Worktree lifecycle: `add --lock --reason -b` for write nodes, `add --detach --lock` for read
  nodes, `list --porcelain -z` as the only read path, `unlock`, `remove`, `remove -f -f`, `prune`.
- Branch-occupancy pre-check by scanning the porcelain list, so DeFlow never parses a git error
  string to detect the collision — and DeFlow's own message when the occupant is the operator's
  main checkout.
- The dirty-removal salvage sequence: `status --porcelain=v2 -z` → `workspace.dirty_on_remove`
  event → `DeFlow: WIP salvage` commit on the node branch → `remove --force`.
- Worktree environment setup: `.worktreeinclude` (Claude Code's convention, verbatim),
  package-manager detection from the lockfile, `workspace.setup` with a success marker cached on
  the `setupCacheKey` lockfile hash, and the opportunistic `cp --reflink=auto` / APFS `clonefile`
  fast path behind a filesystem capability probe.
- The disk estimate rendered before a fan-out is authorized:
  `N × tracked working-tree size + N × node_modules` (second term ≈ 0 under pnpm).
- `mergeTree()` and the `conflict_probe` table: pairwise probes after every write-node commit,
  against the integration branch and every other in-flight node branch, with both tips stored so a
  stale row is detectable.
- The scheduler signal derived from that table: demote the later-starting node to blocked on the
  first `clean = 0`.
- The integration loop: create `DeFlow/int/<runId>` at run start, merge lowest-conflict-count
  first, **re-probe and re-sort after every merge**, run the verification gate against the
  integration branch between merges.
- The conflict resolution node's shape: `worktree` level, integration worktree, packet containing
  only the conflicted hunks and both sides' intent summaries.
- Orphan reaping at daemon boot in the mandated order — reap, unlock, prune — with the PID-reuse
  guard comparing recorded process start time, never bare liveness.
- The `worktrees` projection table, refreshed from `worktree list --porcelain -z`, explicitly not
  the source of truth.

**Out of scope:**

- The permission ladder, the command allowlist, environment scrubbing and the process-tree kill
  itself — [EPIC-08](./EPIC-08-safety-model.md). This epic hands EPIC-08 the worktree path that
  becomes the scope root; EPIC-08 decides what may happen inside it.
- Scheduling policy, the ready set, semaphores and the effect journal —
  [EPIC-06](./EPIC-06-orchestrator.md). This epic supplies the `git` effect's _implementation_ and
  the conflict signal; `decide()` consumes them.
- The `event` and `effect` tables, migrations and `reduce()` — [EPIC-03](./EPIC-03-event-ledger.md).
  Migration `000N` adding `conflict_probe` and `worktrees` is authored here against that machinery.
- Gate execution against the integration branch — [EPIC-12](./EPIC-12-verification-gates.md). This
  epic calls the gate runner between merges; it does not implement gates.
- The collision-map and disk-estimate **rendering** — [EPIC-17](./EPIC-17-p0-views.md). This epic
  produces the projection those views read.
- Container isolation (F5.8) — P1, M2. `@devcontainers/cli@0.88.0` is the recommended path and the
  credential guidance in [§12.1](../../09-workspace-and-safety.md) is already written; none of it
  is M1.
- Windows worktree and path semantics — M3, alongside `killTree()`'s Win32 half.
- Submodules in linked worktrees — a **known gap** (§13.2), not a story. See Risks.

## Definition of Ready (epic level)

- [ ] **EPIC-06 Done through KAR-06.3 and KAR-06.4.** Git operations are journaled effects; the
      `DeFlow-Effect-Id` trailer convention and "already exists is a success" reconciliation rule
      exist to be implemented against.
- [ ] **EPIC-03 Done.** `Db` port, `PRAGMA user_version` migrations and the event append path work,
      so `conflict_probe` and `worktrees` are one more migration rather than new infrastructure.
- [ ] `git >= 2.38` is present on both CI images (`ubuntu-26.04`, `macos-26`) and the version is
      asserted in the integration setup file, so a runner image bump cannot silently drop below the
      floor.
- [ ] The `makeRepo({ branches, files, conflicts })` fixture helper from
      [testing strategy §6](../../14-testing-strategy.md) exists, with `GIT_CONFIG_GLOBAL=/dev/null`,
      `GIT_CONFIG_SYSTEM=/dev/null` and forced identity env.
- [ ] `DeFlow_KEEP_TMP` is honoured by the tmpdir fixture, because a failed worktree is
      undiagnosable post-mortem without it.

## Definition of Done (epic level)

- [ ] All eight stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-07-workspace-isolation-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on both
      `ubuntu-26.04` and `macos-26`.
- [ ] No test in this epic uses `isomorphic-git`, `simple-git`, `memfs`, or a mocked `spawn`. A grep
      in CI enforces it.
- [ ] The regression test that the PRD's `DeFlow/<runId>/<nodeId>` scheme fails is green, so nobody
      reintroduces it.
- [ ] A 5-node fan-out on a real repository creates 5 worktrees, runs `workspace.setup` in each,
      probes 10 pairwise conflicts, merges all 5 into the integration branch with re-sorting, and
      leaves `git worktree list --porcelain -z` reporting exactly one entry (the main checkout)
      afterwards.
- [ ] Every `Unverified` claim in [09-workspace-and-safety.md](../../09-workspace-and-safety.md)
      that this epic depends on is either resolved with a recorded result or carried forward as a
      named risk with an owner: A5-7 (APFS case collisions), A5-8 (submodules), A5-9 (worktree lock
      across macOS sleep/wake), A5-10 (pnpm worktree config keys).

## User stories

### KAR-07.1 — Git wrapper with version enforcement and forbidden-argument assertions

|                 |                                                |
| --------------- | ---------------------------------------------- |
| **Status**      | Ready                                          |
| **Priority**    | P0                                             |
| **Size**        | S                                              |
| **Depends on**  | —                                              |
| **PRD**         | F5.5, NF6                                      |
| **Verified by** | EPIC-07-S1, EPIC-07-S2, EPIC-07-S3, EPIC-07-S4 |

**As** the daemon, **I want** every git invocation to pass through one wrapper that treats exit
codes as data and refuses two specific argument shapes outright, **so that** a caller in a hurry
cannot create the corruption or the default-branch write that no later check can undo.

This is [§1.1](../../09-workspace-and-safety.md) implemented literally: a `Git` class over
`execa@^10.0.1` with `reject: false`, `timeout: 60_000`, `env: gitChildEnv()`, and `-C <cwd>` on
every call. `reject: false` is not a style choice — `git merge-tree` uses exit code **1** to mean
_conflict_, a normal expected result, and an exception-throwing wrapper destroys that signal before
KAR-07.6 can read it. The two assertions are `assertNoForcedWorktreeAdd` (§3.3) and
`assertNotDefaultBranchWrite` (§10.6), and they run before `execa`, not after. The default branch
is resolved once per repo from `origin/HEAD`, falling back to the local `init.defaultBranch` / the
`HEAD` symref, and cached on the run. Version gating lives here too: below git 2.38 the daemon
refuses to start a run at all, because `merge-tree --write-tree` — the entire conflict-detection
design — does not exist; between 2.38 and 2.45 it warns about `worktree list --porcelain -z`.

**Acceptance criteria**

1. `git.run(['merge-tree', …])` against conflicting branches returns `{ exitCode: 1 }` as a value
   and does not throw.
2. `git.run(['worktree', 'add', '--force', …])` and the `-f` spelling both throw
   `worktree add --force is forbidden: it creates two worktrees on one branch` **before** any
   process is spawned — observable because no `git` process appears in the fixture's spawn log.
3. `git.run(['worktree', 'remove', '--force', …])` is permitted; the assertion is scoped to `add`.
4. Every argument shape in the F5.5 refusal set throws: `push` to the local default branch, `push`
   to `origin` `HEAD`, `push --force` / `-f` to any shared ref, `branch -f <default>`, and
   `update-ref` targeting the default branch. `push --force-with-lease` on a `DeFlow/` ref is
   allowed.
5. The default branch is resolved from `origin/HEAD` when present and from the `HEAD` symref when
   there is no remote, and the resolution runs at most once per repository per run.
6. With `git --version` reporting 2.37.x, `deflow doctor` fails hard and the daemon refuses to
   start a run, naming `merge-tree --write-tree` as the missing capability. At 2.43 it warns and
   proceeds.
7. `gitChildEnv()` keeps `SSH_AUTH_SOCK` — the `Git` wrapper is the only thing in DeFlow that
   pushes, and it needs the user's forwarded agent (see [security model §4.1](../../15-security-model.md)).

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                             | Red when                                                                |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | unit        | `assertNoForcedWorktreeAdd(['worktree','add','--force','/p','b'])` throws with the exact message                                 | The assertion does not exist                                            |
| 2   | unit        | `assertNoForcedWorktreeAdd(['worktree','remove','--force','/p'])` does not throw                                                 | The assertion matches on `--force` anywhere                             |
| 3   | unit        | `assertNotDefaultBranchWrite` table-driven over the seven refused shapes plus two allowed ones                                   | Refusals are not implemented or `--force-with-lease` is wrongly refused |
| 4   | integration | Real repo, real `git merge-tree` on conflicting branches: `run()` resolves with `exitCode === 1`                                 | The wrapper uses execa's default `reject: true`                         |
| 5   | integration | A spy on the spawn chokepoint records zero invocations when the forbidden shape is passed                                        | The assertion runs after `execa`                                        |
| 6   | integration | `origin/HEAD` present → default branch is `main`; remote removed → falls back to the `HEAD` symref                               | Resolution depends on a hardcoded name                                  |
| 7   | integration | A stub `git` shim on `PATH` printing `git version 2.37.1` makes `doctor` exit non-zero with the `merge-tree --write-tree` reason | Version gating is absent or warns instead of failing                    |

**Notes / risks** — `execa` is used here and _only_ here. Agent processes use raw
`node:child_process` because three execa options (`kill()`, `forceKillAfterDelay`, `cleanup`) do
not do what their names suggest for detached process groups
([§11.4](../../09-workspace-and-safety.md)); that split is deliberate and is enforced by the spawn
chokepoint lint in [EPIC-08](./EPIC-08-safety-model.md).

---

### KAR-07.2 — Worktree lifecycle: create, lock, list, remove

|                 |                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                           |
| **Priority**    | P0                                                                                                    |
| **Size**        | M                                                                                                     |
| **Depends on**  | KAR-07.1, KAR-07.3                                                                                    |
| **PRD**         | F5.1, F5.2                                                                                            |
| **Verified by** | EPIC-07-S9, EPIC-07-S10, EPIC-07-S11, EPIC-07-S12, EPIC-07-S13, EPIC-07-S14, EPIC-07-S15, EPIC-07-S16 |

**As** the orchestrator, **I want** each write node to get its own locked worktree on its own
branch and each read node a locked detached checkout, **so that** concurrent nodes never touch the
same working tree and the daemon's own reaper cannot delete a worktree an agent is still using.

[§4](../../09-workspace-and-safety.md) is the specification and every command in it was verified on
git 2.43. Three details carry the design. **`--lock` is applied atomically at creation** — the
create-then-lock sequence races with DeFlow's own background reaper across a daemon restart, and
locked worktrees are immune to `prune`, which is exactly why lock is the right primitive rather
than a side-channel lockfile that can desync from git's own view. **`--detach` for read nodes**
sidesteps branch uniqueness entirely and encodes intent. **Occupancy is pre-checked by scanning
`worktree list --porcelain -z`, never by parsing an error string** — the real message is
`fatal: '<branch>' is already used by worktree at '<path>'`, not the widely-quoted
`already checked out at`, and a design that parses it is one git release from breaking. The
`worktrees` table in the ledger database is a projection refreshed from the porcelain list; git is
the authority, because the moment the operator runs `git worktree remove` by hand — and they will —
a SQLite-authoritative design is wrong and does not know it.

**Acceptance criteria**

1. A write node's worktree is created by exactly
   `worktree add --lock --reason "DeFlow run=<runId> node=<nodeId>" -b DeFlow/<runId>__<nodeId> <path> <baseRef>`
   in one invocation; there is no separate `worktree lock` call anywhere in the create path.
2. A read node's worktree is created with `--detach --lock --reason …` and no `-b`; the resulting
   entry in `worktree list --porcelain -z` carries `detached`, not `branch`.
3. Attempting to create a worktree on a branch already listed in the porcelain output is refused by
   DeFlow **before** `git worktree add` runs, with a `workspace.branch_occupied` event naming the
   occupying path.
4. When the occupying worktree is the main checkout, the operator-facing message names the
   operator's own current branch and offers the base-ref choice — it does not echo git's wording.
5. `worktree list` is only ever invoked as `list --porcelain -z`; a grep for `worktree list` without
   both flags returns zero hits in `packages/workspace`.
6. The porcelain parser round-trips `worktree`, `HEAD`, `branch`/`detached`, `locked [reason]` and
   `prunable [reason]` records, including a lock reason containing a space and a path containing a
   space.
7. Removal is `unlock` then `remove`; `remove -f -f` appears only on the reaper code path
   (KAR-07.8), and a unit test asserts it is unreachable from the normal node-completion path.
8. Refreshing the `worktrees` projection after the operator manually removed a worktree yields a
   table with that row gone and emits `workspace.reconciled`, with no error raised.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                     | Red when                                                   |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | unit        | Porcelain `-z` parser over a captured NUL-separated fixture including `locked` with a reason and a path with a space                                     | Parser splits on newlines or on unescaped spaces           |
| 2   | integration | `add --lock -b` then `worktree list --porcelain -z` shows `locked` in the same record; `prune` leaves it                                                 | Lock is applied as a second command, or not at all         |
| 3   | integration | Second `add` on the same branch: DeFlow refuses pre-flight; the spawn log shows no `worktree add`                                                        | Occupancy pre-check is missing                             |
| 4   | integration | Bypassing the pre-check, raw `git worktree add` emits stderr matching `already used by worktree at` — the regression that pins the real string           | Someone "corrects" the matcher to `already checked out at` |
| 5   | integration | `add <path> <mainBranch>` where `<mainBranch>` is the main checkout's branch → DeFlow's own message, and the ledger event names `<mainRepo>` as occupant | The main checkout is not treated as an occupant            |
| 6   | integration | `add --detach --lock` → porcelain record has `detached`; a second detached worktree on the same commit also succeeds                                     | `--detach` is not used for read nodes                      |
| 7   | integration | `rm -rf` the worktree directory, refresh projection → row removed, `workspace.reconciled` emitted, no throw                                              | SQLite is treated as authoritative                         |

---

### KAR-07.3 — Flat branch naming and ref-name validation

|                 |                                                |
| --------------- | ---------------------------------------------- |
| **Status**      | Ready                                          |
| **Priority**    | P0                                             |
| **Size**        | S                                              |
| **Depends on**  | KAR-07.1                                       |
| **PRD**         | F5.1                                           |
| **Verified by** | EPIC-07-S5, EPIC-07-S6, EPIC-07-S7, EPIC-07-S8 |

**As** the workspace manager, **I want** branch names generated by one validated function using the
flat `DeFlow/<runId>__<nodeId>` scheme, **so that** a run-level integration branch is possible and
no generated id can reach git as a flag or an invalid ref.

**Decision D13** overrides the PRD. `DeFlow/<runId>/<nodeId>` cannot coexist with
`DeFlow/<runId>`, because git's refs storage cannot have both a file and a directory at
`refs/heads/DeFlow/r1`. Verified on git 2.43: after `DeFlow/r1/n1` exists,
`git branch DeFlow/r1` fails with
`fatal: cannot lock ref 'refs/heads/DeFlow/r1': 'refs/heads/DeFlow/r1/n1' exists; cannot create 'refs/heads/DeFlow/r1'`,
and the reverse order fails symmetrically. The bug would surface late, in the merge phase, as an
inexplicable mid-run git failure — which is why this story carries a regression test that the old
scheme _fails_, not merely that the new one works. Validation is two-layer: `BRANCH_SAFE =
/^[a-z0-9][a-z0-9._-]{0,63}$/` applied to `runId` and `nodeId` separately at the domain layer, then
`git check-ref-format --branch` on the composed name with the result cached. `check-ref-format`
alone is necessary and not sufficient — `-n` **is** a valid ref name that git then parses as a
command-line flag.

**Acceptance criteria**

1. `nodeBranch(runId, nodeId)` returns `DeFlow/<runId>__<nodeId>`; `integrationBranch(runId)`
   returns `DeFlow/int/<runId>`; neither contains a slash beyond the two literal ones.
2. `nodeBranch` throws `UnsafeRefError` for any id failing `BRANCH_SAFE`, including ids beginning
   with `-`, before the value can reach git.
3. Every composed name is passed through `git check-ref-format --branch` once and the boolean is
   cached per name.
4. The verified reject set is covered: a component ending in `.lock`, a `..` sequence, a trailing
   space, and `@{`.
5. Ids are normalized to a single case before composition, so two node ids differing only in case
   cannot produce colliding worktree paths on a case-insensitive filesystem.
6. Every call site that passes a generated name to git uses either a `--` separator or the
   `--branch=<value>` long form; a lint or grep check enforces it.
7. A regression test creates `DeFlow/r1/n1` on a real repo and asserts `git branch DeFlow/r1` fails
   with the refs lock message — documenting _why_ D13 exists.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                       | Red when                                                             |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | unit        | `nodeBranch('r1','n1') === 'DeFlow/r1__n1'`                                                                                                                | Hierarchical scheme still in place                                   |
| 2   | unit        | Table of rejects: `-n`, `N1` (case), `a..b`, `x.lock`, `x ` (trailing space), `a@{1}`, a 70-char id                                                        | `BRANCH_SAFE` too permissive, or leading `-` not rejected separately |
| 3   | integration | Real `git check-ref-format --branch` agrees with `BRANCH_SAFE` on every accept, and `-n` is the documented disagreement                                    | The two layers are conflated into one                                |
| 4   | integration | **Regression:** `git branch DeFlow/r1` after `DeFlow/r1/n1` exists fails with `cannot lock ref`                                                            | Someone reintroduces the PRD scheme                                  |
| 5   | integration | `git branch --list 'DeFlow/int/*'` after run start shows exactly one integration branch, and creating a node branch under the same run does not disturb it | Integration prefix collides with node names                          |

---

### KAR-07.4 — Dirty-worktree salvage on removal

|                 |                          |
| --------------- | ------------------------ |
| **Status**      | Not started              |
| **Priority**    | P0                       |
| **Size**        | S                        |
| **Depends on**  | KAR-07.2                 |
| **PRD**         | F5.1, NF8                |
| **Verified by** | EPIC-07-S17, EPIC-07-S18 |

**As** the operator, **I want** a worktree that an agent left dirty to be committed to its own
branch before it is removed, **so that** work an agent just did is recoverable by ref rather than
silently discarded by a `--force` the run has no record of.

[§4.4](../../09-workspace-and-safety.md) gives the verified failure text —
`fatal: '<path>' contains modified or untracked files, use --force to delete it` — and the
three-step response: capture `git -C <wt> status --porcelain=v2 -z` into the ledger as a
`workspace.dirty_on_remove` event, auto-commit everything to the node branch as a
`DeFlow: WIP salvage` commit, and only then `worktree remove --force`. The ordering is the whole
point: force becomes acceptable only _after_ the salvage commit is durable. The companion verified
fact keeps this small — a worktree containing only gitignored files (`node_modules/`) removes
cleanly with exit 0 and needs no `--force` at all, so there is no cleanup machinery to build for
it. It is a disk problem ([KAR-07.5](#kar-075--worktree-environment-setup-and-dependency-sharing)),
not a removal problem.

**Acceptance criteria**

1. Removing a worktree with a modified tracked file and an untracked file emits
   `workspace.dirty_on_remove` whose payload contains the parsed `status --porcelain=v2 -z` entries
   before any commit or removal happens.
2. The salvage commit lands on the node's own branch with subject `DeFlow: WIP salvage`, includes
   untracked files, and its OID is recorded in a `workspace.wip_salvaged` event.
3. After removal, `git log DeFlow/<runId>__<nodeId>` shows the salvage commit and `git show` of it
   contains the agent's uncommitted content — the work is recoverable with the branch alone.
4. `worktree remove --force` is only reached when a `workspace.wip_salvaged` event for that node is
   already durable; a crash between capture and commit leaves the worktree present and dirty on
   restart, and the sequence restarts from step 1.
5. A worktree whose only untracked content is gitignored (`node_modules/`, `dist/`) removes with
   plain `worktree remove`, exit 0, emitting no `workspace.dirty_on_remove` event.
6. A detached read-node worktree that is somehow dirty is salvaged to a throwaway
   `DeFlow/salvage/<runId>__<nodeId>` branch rather than being force-removed, because a detached
   HEAD has no branch to commit to.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                     | Red when                                         |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | unit        | `status --porcelain=v2 -z` parser over a fixture with a rename, an untracked file and a path containing a space                          | Parser splits on whitespace or newlines          |
| 2   | integration | Dirty worktree → plain `remove` returns exit 1 with `contains modified or untracked files`; the string is pinned                         | Someone assumes removal just works               |
| 3   | integration | Full salvage sequence → three ordered events, then removal succeeds; `git cat-file -p` of the salvage commit contains the agent's bytes  | Force happens before the commit                  |
| 4   | integration | Kill the process between the `dirty_on_remove` event and the commit; on restart the worktree is still present and the sequence completes | Force is reachable without a durable salvage     |
| 5   | integration | Worktree containing only `node_modules/` (gitignored) → `remove` exits 0, no events                                                      | Cleanup machinery was built for gitignored files |

---

### KAR-07.5 — Worktree environment setup and dependency sharing

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | KAR-07.2                                           |
| **PRD**         | F5.1, NF6                                          |
| **Verified by** | EPIC-07-S19, EPIC-07-S20, EPIC-07-S21, EPIC-07-S22 |

**As** an agent in a fresh worktree, **I want** my dependencies installed and the repo's gitignored
config present before my first command runs, **so that** I do not spend a turn discovering that
`pnpm test` fails because `node_modules` does not exist.

Three layers, from [§5](../../09-workspace-and-safety.md). **Layer 1** adopts Claude Code's
`.worktreeinclude` convention verbatim — gitignore syntax, and only files that match a pattern
**and** are gitignored get copied. Reusing the filename means zero new concepts for users already
on Claude Code. **Layer 2** detects the package manager from the lockfile and runs its native
install; pnpm is the recommended default because its content-addressable store makes marginal disk
per extra worktree near-zero, where `npm ci` and `yarn install --immutable` each cost a full copy.
**Layer 3** is `workspace.setup` in `DeFlow.config.ts` with a success marker cached on the hash of
`setupCacheKey` files, so a second worktree on unchanged dependencies skips setup entirely. Two
hard rules bound it: **never symlink a shared `node_modules` across worktrees** — concurrent
installs corrupt it and it defeats the isolation the worktree exists for; the one safe shared
target is the _store_. And the reflink fast path (`cp --reflink=auto`, APFS `clonefile`) is
opportunistic behind a filesystem capability probe, because ext4 has no reflink.

**Acceptance criteria**

1. Files matching a `.worktreeinclude` pattern **and** ignored by `.gitignore` are copied into a new
   worktree; a file matching the pattern but tracked by git is not copied; a gitignored file not
   matching any pattern is not copied.
2. Copied files preserve mode, so a `0600` `.env` does not become world-readable in the worktree,
   and each copy is recorded in a `workspace.included_file` event naming the path only — never the
   contents.
3. Lockfile detection maps `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`,
   `package-lock.json` → `npm ci`, `yarn.lock` → `yarn install --immutable`; two lockfiles present
   is a hard error naming both, not a silent precedence rule.
4. `workspace.setup` output streams to the ledger as `io_chunk` records against the node, and a
   non-zero exit fails worktree provisioning with a typed error before the agent is spawned.
5. The setup success marker is keyed on the sha256 of the concatenated `setupCacheKey` files; a
   second worktree on an unchanged lockfile skips setup and emits `workspace.setup_cache_hit`.
   Touching the lockfile invalidates it.
6. No code path creates a symlink whose target is a `node_modules` directory; a unit test over the
   provisioning plan asserts it.
7. The reflink fast path is attempted only after a probe writes and clones a 1-byte file in the
   target directory; on ext4 the probe fails and provisioning falls through to the package manager
   with no error surfaced to the user.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                              | Red when                                               |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | unit        | `.worktreeinclude` matcher over a table: pattern-and-ignored (copy), pattern-and-tracked (skip), ignored-not-pattern (skip), negation `!` pattern | Matcher checks only one of the two conditions          |
| 2   | integration | Real repo with `.env` at mode `0600` → copied file's mode is `0600` in the worktree                                                               | Copy uses a default mode                               |
| 3   | unit        | Lockfile detection table, including the two-lockfiles error                                                                                       | Silent precedence                                      |
| 4   | integration | Fake `pnpm` shim on tmp `PATH` recording argv → asserts `install --frozen-lockfile`; a non-zero exit fails provisioning and no agent is spawned   | Setup failure is swallowed                             |
| 5   | integration | Two worktrees, unchanged lockfile → second emits `workspace.setup_cache_hit` and the shim records one invocation total                            | Marker keyed on something other than the lockfile hash |
| 6   | unit        | Provisioning-plan assertion: zero symlinks target a `node_modules` path                                                                           | Someone "optimizes" by sharing the tree                |
| 7   | integration | Reflink probe on the CI filesystem: on failure, provisioning still completes and emits no user-facing warning                                     | Probe failure is treated as an error                   |

**Notes / risks** — **Unverified (A5-10):** `pnpm.io/git-worktrees` returned 403 during the
research, so its specific config keys are unconfirmed. The store-sharing _mechanism_ is
long-standing and safe to rely on; do not document any pnpm config key from memory without
re-fetching that page.

---

### KAR-07.6 — Continuous conflict detection with merge-tree

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | KAR-07.1, KAR-07.3                                 |
| **PRD**         | F5.2, F5.3                                         |
| **Verified by** | EPIC-07-S23, EPIC-07-S24, EPIC-07-S25, EPIC-07-S30 |

**As** the scheduler, **I want** a pairwise conflict probe run after every write-node commit, **so
that** two nodes are serialized the moment their branches start conflicting rather than after both
have burned an hour.

**Decision D14**: `git merge-tree --write-tree` is ground truth for conflict, and declared path
scopes (F5.3) are demoted to a plan-time prediction. The verified behaviour is exact — exit **0**
clean with the tree OID on stdout line 1; exit **1** conflict with the tree OID, then conflicted
stage lines, then an info block; `--name-only` reduces it to bare paths; `-z` makes it
machine-parseable; and it has **no side effects at all**, touching neither the index nor any
working tree, which is what makes it safe to run against live worktrees at any moment. Exit codes
of 2 or above are real errors. The trap that kills naive implementations: **the exit code is the
signal**, so piping `merge-tree` through anything replaces `$?` with the pipe's status and destroys
it. That is precisely why KAR-07.1's wrapper does not throw. Results land in the `conflict_probe`
table with **both branch tips** stored, so a stale row is detectable rather than silently trusted.

**Acceptance criteria**

1. `mergeTree(git, a, b)` returns `{ clean: true, paths: [] }` on exit 0 and
   `{ clean: false, paths: [...] }` on exit 1, and throws `GitError` on exit ≥ 2 with git's stderr
   attached.
2. The invocation is exactly `merge-tree --write-tree --name-only -z <a> <b>`, and the first
   NUL-separated field (the tree OID) is dropped from `paths`.
3. Running a probe against two branches whose worktrees have uncommitted changes leaves both
   worktrees byte-identical — asserted by hashing the worktree trees before and after.
4. After a write node commits, probes run against `DeFlow/int/<runId>` and every other in-flight
   node branch, and each result is upserted into `conflict_probe` keyed
   `(run_id, branch_a, branch_b)` with `a_commit` and `b_commit` set to the tips probed.
5. A probe row whose stored tips no longer match the current tips is treated as stale and re-probed
   rather than read.
6. On the first `clean = 0` between two in-flight write nodes, the later-_starting_ node is demoted
   to blocked and a `node.blocked` event names the conflicting counterpart and the conflicted paths.
7. A declared path-scope overlap alone never blocks scheduling; only the identical-single-file case
   is refused at plan time. Declared-scope violations are recorded as warnings
   ([EPIC-08](./EPIC-08-safety-model.md) KAR-08.7), not gates.
8. A 5-branch run performs 10 pairwise probes in under 500 ms total on the fixture repository.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                 | Red when                                                       |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | integration | `makeRepo({ conflicts: true })`, two branches editing the same line → exit 1, paths `['f.txt']`                      | Wrapper throws, or `--name-only -z` output is mis-sliced       |
| 2   | integration | Two branches editing different files → exit 0, `paths: []`                                                           | Clean case misparsed                                           |
| 3   | integration | A corrupt ref name → exit ≥ 2 → `GitError` raised, not a false "clean"                                               | Exit ≥ 2 collapsed into the conflict branch                    |
| 4   | integration | Hash the worktree trees before and after a probe; assert unchanged                                                   | A future refactor reaches for `merge` instead of `merge-tree`  |
| 5   | unit        | Probe-matrix reducer: given three in-flight branches and one conflicting pair, the demoted node is the later starter | Demotion picks by branch name or by id order                   |
| 6   | unit        | A row whose `a_commit` differs from the current tip is reported stale                                                | Staleness is not detectable, so the stored tips were pointless |
| 7   | integration | Timing assertion over a 5-branch fixture, 10 probes < 500 ms                                                         | Probes shell out more than once per pair                       |

**Notes / risks** — _Apparently novel, stated honestly._ No shipping orchestrator found in the
research uses `merge-tree` as a continuous scheduling signal. That is a survey result, not a proof
of absence — treat it as "we found no prior art".

---

### KAR-07.7 — Integration branch and ordered merge strategy

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | L                                     |
| **Depends on**  | KAR-07.6, KAR-07.3                    |
| **PRD**         | F5.2, F5.5                            |
| **Verified by** | EPIC-07-S26, EPIC-07-S27, EPIC-07-S28 |

**As** the operator, **I want** completed node branches merged one at a time into a run-level
integration branch in ascending conflict order, re-sorted after every merge, **so that** a run's
output is one reviewable branch and a conflict is a small, cheap, well-briefed resolution node
rather than a big-bang N-way merge disaster.

[§7](../../09-workspace-and-safety.md). `DeFlow/int/<runId>` is created from the run's base ref at
run start — which is the entire reason D13 flattened branch naming, because the hierarchical scheme
forecloses it. The loop is: order completed branches by ascending merge-tree conflict count against
the integration branch, merge the lowest, then **re-probe all remaining branches, re-sort**, and
run the verification gate against the integration branch. Re-sorting is not an optimization; a
merge changes every remaining branch's conflict count, and an order computed once is stale after
the first merge. On conflict, DeFlow spawns a resolution node at `worktree` level on the
integration worktree whose context packet contains **only** the conflicted hunks and both sides'
intent summaries from the blackboard — never the whole repository, never blind auto-resolution.
That node shape is narrow, cheap and high-succeeding, and it exists only because the blackboard
retained intent.

**Acceptance criteria**

1. `DeFlow/int/<runId>` is created from the run's base ref during run start, before the first node
   is scheduled, and its creation is a journaled git effect.
2. The merge queue is ordered by ascending `path_count` from the current `conflict_probe` rows
   against the integration branch; ties break on completion time.
3. After each merge, every remaining branch is re-probed and the queue re-sorted — observable in the
   ledger as a `workspace.merge_queue_reordered` event carrying the before and after orders.
4. Between merges, the run's verification gate runs against the integration branch; a gate failure
   halts the loop with the remaining queue intact and recorded, rather than continuing to merge.
5. A merge that conflicts spawns a resolution node at `worktree` level whose context packet
   contains exactly two segment kinds: the conflicted hunks and the two intent summaries. A test
   asserts the packet contains no repository file that was not conflicted.
6. Merges are `--no-ff` so the integration branch's history shows one commit per node branch, and
   each merge commit's message names the `runId` and `nodeId`.
7. The integration branch is never pushed to the default branch by DeFlow; the run's output is the
   branch itself (F5.5, enforced mechanically in KAR-07.1).
8. Merging N branches where the last two conflict produces N−1 successful merges, one resolution
   node, and a final integration branch containing every node's changes.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                | Red when                                                       |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | unit        | Queue ordering over a fixture probe table, including the tie-break                                                                  | Ordering reads declared scopes instead of probe results        |
| 2   | unit        | Re-sort after a simulated merge changes the order; the emitted event carries both orders                                            | Order is computed once                                         |
| 3   | integration | Real repo, 4 branches, 2 conflicting → 3 merges succeed, 1 resolution node spawned, integration tree contains all four changes      | Big-bang merge, or conflicts silently dropped                  |
| 4   | integration | Gate failure between merges halts the loop; the remaining queue is readable from the ledger and resumes on the next run of the loop | Loop continues past a failed gate                              |
| 5   | unit        | Resolution-node packet assertion: only conflicted hunks + two intent summaries                                                      | Packet is built from the worktree rather than the probe output |
| 6   | integration | `git log --merges DeFlow/int/<runId>` shows one commit per node branch with `runId`/`nodeId` in the message                         | Fast-forward merges collapse the history                       |

**Notes / risks** — This is the epic's largest story and the one most likely to slip. If it does,
the fallback that keeps M1 usable is: merge in completion order with no re-sorting, and escalate
every conflict to a human gate. That degrades the feature without breaking the run, and the probe
table (KAR-07.6) is what makes the upgrade a scheduling change rather than a rewrite.

---

### KAR-07.8 — Orphaned worktree reaping on daemon start

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | M                                     |
| **Depends on**  | KAR-07.2, EPIC-08 KAR-08.6            |
| **PRD**         | F4.2, F5.1, NF4                       |
| **Verified by** | EPIC-07-S29, EPIC-07-S31, EPIC-07-S32 |

**As** the daemon, **I want** to reap the process, release the lock and prune the worktree of every
node that did not survive the last restart — in that order, and never on a recycled PID — **so
that** a `kill -9` of DeFlowd does not leave a repository littered with locked worktrees that
`prune` will not touch.

`detached: true` means an agent survives DeFlowd's death — that is the price of group-kill, and
[§11.3](../../09-workspace-and-safety.md) is the bill. At spawn, `{runId, nodeId, pid, pgid,
startedAt, procStartTime}` is persisted. On boot, for every non-terminal row: **verify the pid is
still the same process** by comparing the recorded start time (`/proc/<pid>/stat` field 22 on
Linux, `ps -o lstart= -p <pid>` on macOS), never bare liveness — PIDs are recycled and killing a
stranger's process because you reused a number is an unrecoverable class of bug. Then
`process.kill(-pgid, 'SIGKILL')` if it matches, then `git worktree unlock` any worktree whose owning
process is gone, then `git worktree prune -v --expire 2.weeks.ago`. **The order is load-bearing**:
locked worktrees are immune to prune, so pruning before unlocking is a no-op that looks like
success.

**Acceptance criteria**

1. Boot reaping runs in the exact order reap → unlock → prune, and a test observes the git
   invocation sequence.
2. A recorded row whose PID is live but whose process start time differs is classified
   `pid-recycled`; no signal is sent, a `workspace.pid_recycled` event is emitted, and the worktree
   is still unlocked and pruned.
3. A recorded row whose process is genuinely alive from the previous epoch is group-killed with the
   negative pgid, and the kill is verified with the `Z`-state exclusion from
   [EPIC-08](./EPIC-08-safety-model.md) KAR-08.6.
4. `git worktree prune -v --expire 2.weeks.ago` after `rm -rf` of a worktree directory reports
   `Removing worktrees/<name>: gitdir file points to non-existent location`, and the projection
   table drops the row.
5. A still-locked worktree whose owning process is verifiably gone is unlocked and removed with
   `remove -f -f`; a still-locked worktree whose owning process is **alive** is left entirely alone.
6. Reaping is idempotent: running it twice in a row produces the same end state and no errors, so a
   crash during reaping is safe.
7. Boot reaping completes in under 2 s for 20 orphaned rows, keeping NF3's 3-second cold start
   intact.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                     | Red when                                    |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | integration | Spawn a detached `bash -c 'sleep 300'`, record its row, kill DeFlowd, restart → the process is gone and the worktree unlocked and pruned | Reaping missing or ordered wrong            |
| 2   | integration | Fabricate a row with a live PID and a deliberately wrong `procStartTime` → no signal sent, `workspace.pid_recycled` emitted              | Liveness checked with a bare `kill(pid, 0)` |
| 3   | integration | Assert the git invocation order from the wrapper's spawn log: `unlock` strictly precedes `prune`                                         | Prune runs first and silently does nothing  |
| 4   | integration | `rm -rf` a worktree dir → `prune -v` output matches `gitdir file points to non-existent location`; projection row removed                | Prunable state not handled                  |
| 5   | integration | Locked worktree with a live owning process survives a boot reap untouched                                                                | Reaper kills live agents on restart         |
| 6   | integration | Run the reaper twice; second run emits no events and exits 0                                                                             | Reaping is not idempotent                   |

**Notes / risks** — **Unverified (A5-9):** whether `git worktree lock` and this stale-lock release
behave correctly across a macOS sleep/wake cycle. The lock is a file on disk so it should survive,
but PID recycling after a long suspend makes step 1 load-bearing and it has not been tested across
sleep. Plan a real overnight suspend test during W5.

---

## Risks

| Risk                                                                                                                                                                                                                                                                  | Severity | Mitigation                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The epic totals ~17 days, over the ~15-day solo-builder guidance.** KAR-07.7 alone is L.                                                                                                                                                                            | High     | KAR-07.7 has a named degradation path (merge in completion order, human gate on every conflict) that keeps M1 usable and makes the full behaviour a later scheduling change. KAR-07.5's reflink fast path is the first thing to cut — it is an optimization, not a capability. |
| **Submodules in linked worktrees are untested (A5-8).** Git's submodule support in worktrees has historically been incomplete, since submodule state partly lives in the main `.git`.                                                                                 | Medium   | Not a story, deliberately. If any target repo uses submodules, prototype it _before_ KAR-07.2 lands, because it is a plausible source of silent breakage with no verified answer. Otherwise carry it as a known gap.                                                           |
| **APFS case-insensitivity could collide worktree paths (A5-7).** Two node ids differing only in case were never tested.                                                                                                                                               | Low      | KAR-07.3 normalizes ids to a single case, which removes the question without needing the answer.                                                                                                                                                                               |
| **`git worktree lock` across macOS sleep/wake is unverified (A5-9).**                                                                                                                                                                                                 | Low      | KAR-07.8's PID-reuse guard is the control that makes this safe either way. Test with a real overnight suspend during W5.                                                                                                                                                       |
| **Repository git hooks run on checkout and commit inside a worktree**, and hooks are shared from the main repo. Whether DeFlow's own orchestration git commands should run with hooks disabled is an open question ([security model §6](../../15-security-model.md)). | Medium   | Spike it before KAR-07.4 lands — the salvage commit is the first place DeFlow's own git call could trigger a repository-authored hook. Disabling hooks may break legitimate repo workflows, so the answer is not obviously "disable".                                          |
| **F5.3 is deliberately downgraded.** Declared path scopes become a plan-time prediction, not the enforcement mechanism.                                                                                                                                               | Low      | Stated explicitly in D14 and reflected in KAR-07.6 AC 7 and EPIC-08 KAR-08.7 — the requirement is covered, but as a _warning_ surface plus request-time rejection via `ToolCallLocation.path`, which is strictly better than the PRD's completion-time diffing.                |

---

**Related:** [Flows](../flows/EPIC-07-workspace-isolation-flows.md) · [Board](../board.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[EPIC-08 safety model](./EPIC-08-safety-model.md) · [EPIC-06 orchestrator](./EPIC-06-orchestrator.md)

[← Back to the delivery plan](../README.md)
