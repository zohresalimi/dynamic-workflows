# EPIC-07 flows — Workspace isolation and git orchestration

> Behavioural specification for [EPIC-07](../epics/EPIC-07-workspace-isolation.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                 | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Operator**          | The engineer driving DeFlow. Owns the main checkout and is usually sitting on a branch when a run starts          |
| **DeFlowd**           | The local daemon: orchestrator, ledger, workspace manager                                                         |
| **Workspace Manager** | The `packages/workspace` component — the `Git` wrapper, worktree lifecycle, conflict probes, the integration loop |
| **`Git` wrapper**     | `packages/workspace/src/git.ts`. The single chokepoint over `execa`; the only place `git` is invoked              |
| **Repository**        | A real git repository in a temp directory, created by the `makeRepo()` fixture                                    |
| **Provider agent**    | A `deflow-mock-agent` subprocess whose `cwd` is a worktree. It commits, leaves files dirty, or hangs, on script   |
| **Reaper**            | The daemon-boot routine that reaps orphaned processes, releases stale locks and prunes worktrees                  |

## Preconditions common to all flows

```gherkin
Background:
  Given a temp directory created with fs.mkdtemp(path.join(os.tmpdir(), 'DeFlow-'))
  And DeFlow_KEEP_TMP is honoured so a failed worktree survives for post-mortem
  And a repository created by "git init -b main" inside that directory
  And every git invocation in the fixture carries
      GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null,
      GIT_AUTHOR_NAME=t, GIT_AUTHOR_EMAIL=t@x, GIT_COMMITTER_NAME=t, GIT_COMMITTER_EMAIL=t@x
  And the installed git reports version 2.38 or later
  And no test in this file uses isomorphic-git, simple-git, memfs, or a mocked spawn
  And no test in this file uses vi.useFakeTimers() while a child process is alive
```

> The environment isolation is load-bearing, not hygiene. Without it the developer's own
> `~/.gitconfig` (`init.defaultBranch`, `commit.gpgsign`, aliases, hooks) silently changes outcomes —
> the classic "passes locally, fails in CI" and its equally confusing inverse
> ([testing strategy §6](../../14-testing-strategy.md)).

## Flow index

| Scenario    | Title                                                                                    | Verifies | Type        |
| ----------- | ---------------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-07-S1  | Happy path: the wrapper treats exit codes as data and enforces the version floor         | KAR-07.1 | Happy path  |
| EPIC-07-S2  | `worktree add --force` is refused before a process is spawned                            | KAR-07.1 | Failure     |
| EPIC-07-S3  | The corruption `--force` would have created, demonstrated on raw git                     | KAR-07.1 | Edge case   |
| EPIC-07-S4  | Default-branch writes refused across every argument shape                                | KAR-07.1 | Failure     |
| EPIC-07-S5  | Flat branch names, and an integration branch that can coexist with them                  | KAR-07.3 | Happy path  |
| EPIC-07-S6  | Regression: the PRD's hierarchical scheme cannot hold an integration branch              | KAR-07.3 | Failure     |
| EPIC-07-S7  | Ref-name validation across the verified reject set                                       | KAR-07.3 | Edge case   |
| EPIC-07-S8  | The `-n` trap: a valid ref name that git parses as a flag                                | KAR-07.3 | Edge case   |
| EPIC-07-S9  | Write node gets a locked worktree on its own branch, locked atomically                   | KAR-07.2 | Happy path  |
| EPIC-07-S10 | Read node gets a locked detached worktree                                                | KAR-07.2 | Happy path  |
| EPIC-07-S11 | The same branch in two worktrees, and the error string that is not what the blogs say    | KAR-07.2 | Failure     |
| EPIC-07-S12 | The main checkout counts as an occupant, so the operator's own branch is blocked         | KAR-07.2 | Failure     |
| EPIC-07-S13 | Porcelain `-z` parsing, including a lock reason and a path with a space                  | KAR-07.2 | Edge case   |
| EPIC-07-S14 | Git is the authority: the operator removes a worktree by hand                            | KAR-07.2 | Recovery    |
| EPIC-07-S15 | Removal happy path: unlock, then remove                                                  | KAR-07.2 | Happy path  |
| EPIC-07-S16 | A locked worktree refuses removal and needs the double force                             | KAR-07.2 | Edge case   |
| EPIC-07-S17 | A dirty worktree blocks removal, and the WIP salvage commit that unblocks it             | KAR-07.4 | Recovery    |
| EPIC-07-S18 | Gitignored files do not block removal                                                    | KAR-07.4 | Edge case   |
| EPIC-07-S19 | `.worktreeinclude` copies gitignored config, and only that                               | KAR-07.5 | Happy path  |
| EPIC-07-S20 | Package-manager-native sharing, and the symlink that must never exist                    | KAR-07.5 | Edge case   |
| EPIC-07-S21 | Setup runs once and is cached on the lockfile hash                                       | KAR-07.5 | Happy path  |
| EPIC-07-S22 | The disk estimate shown before a fan-out is authorized                                   | KAR-07.5 | Happy path  |
| EPIC-07-S23 | `merge-tree` reports a clean merge with no side effects at all                           | KAR-07.6 | Happy path  |
| EPIC-07-S24 | `merge-tree` returns exit 1 with conflicted paths, and the pipe that destroys the signal | KAR-07.6 | Failure     |
| EPIC-07-S25 | Two parallel write nodes are serialized on the first detected conflict                   | KAR-07.6 | Concurrency |
| EPIC-07-S26 | The integration loop re-sorts the queue after every merge                                | KAR-07.7 | Happy path  |
| EPIC-07-S27 | A conflicting merge spawns a narrow resolution node                                      | KAR-07.7 | Failure     |
| EPIC-07-S28 | A gate failure between merges halts the loop with the queue intact                       | KAR-07.7 | Failure     |
| EPIC-07-S29 | Boot reaping runs reap → unlock → prune, in that order                                   | KAR-07.8 | Recovery    |
| EPIC-07-S30 | A stale conflict probe is re-probed, never trusted                                       | KAR-07.6 | Edge case   |
| EPIC-07-S31 | The PID-reuse guard: a live PID that is not our process                                  | KAR-07.8 | Failure     |
| EPIC-07-S32 | Prunable worktrees, and the locked one with a live owner that must be left alone         | KAR-07.8 | Recovery    |

---

## EPIC-07-S1 — Happy path: the wrapper treats exit codes as data and enforces the version floor

**Verifies:** KAR-07.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One git chokepoint whose exit codes are values

  Scenario: A non-zero exit is returned, not thrown
    Given a repository with branches "DeFlow/r1__a" and "DeFlow/r1__b" that edit the same line of "f.txt"
    When the Git wrapper runs ["merge-tree", "--write-tree", "--name-only", "-z", "DeFlow/r1__a", "DeFlow/r1__b"]
    Then the call resolves rather than rejecting
    And the result is { exitCode: 1 } with a non-empty stdout
    And no exception was constructed

  Scenario: Every call is scoped with -C and a timeout
    When the Git wrapper runs ["status", "--porcelain=v2", "-z"] with cwd set to a worktree path
    Then the argv passed to execa begins with ["-C", "<worktreePath>", "status"]
    And the execa options carry timeout 60000 and reject false
    And the child env is the result of gitChildEnv(), which retains SSH_AUTH_SOCK

  Scenario Outline: The git version floor
    Given a stub "git" on PATH whose "--version" prints "git version <version>"
    When deflow doctor runs the workspace checks
    Then the outcome is "<outcome>"
    And the message contains "<mentions>"

    Examples:
      | version | outcome | mentions                    |
      | 2.37.1  | fail    | merge-tree --write-tree     |
      | 2.38.0  | warn    | worktree list --porcelain   |
      | 2.43.0  | warn    | worktree list --porcelain   |
      | 2.45.0  | pass    | git 2.45                    |

  Scenario: Below the floor the daemon refuses to start a run
    Given the stub git reports "git version 2.37.1"
    When the operator starts a run
    Then no worktree is created
    And the run is rejected with a typed error naming the minimum version 2.38
```

**Notes:** `reject: false` is the single most consequential line in the wrapper. `git merge-tree`
uses exit code **1** to mean _conflict_ — a normal, expected result — and an exception-throwing
wrapper destroys that signal before [EPIC-07-S24](#epic-07-s24--merge-tree-returns-exit-1-with-conflicted-paths-and-the-pipe-that-destroys-the-signal)
can read it. `SSH_AUTH_SOCK` is deliberately _kept_ here and deliberately _dropped_ for agents
([EPIC-08-S18](./EPIC-08-safety-model-flows.md)); the agent never pushes, the wrapper does.

---

## EPIC-07-S2 — `worktree add --force` is refused before a process is spawned

**Verifies:** KAR-07.1 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: The forbidden-argument assertion

  Scenario Outline: Forced worktree add is refused in every spelling
    When the Git wrapper is called with <args>
    Then it throws with the message
         "worktree add --force is forbidden: it creates two worktrees on one branch"
    And the spawn chokepoint recorded zero git invocations

    Examples:
      | args                                                        |
      | ["worktree","add","--force","/tmp/wt","feature"]            |
      | ["worktree","add","-f","/tmp/wt","feature"]                 |
      | ["worktree","add","/tmp/wt","--force","feature"]            |
      | ["worktree","add","--lock","-f","-b","x","/tmp/wt","main"]  |

  Scenario: The assertion is scoped to add, not to remove
    When the Git wrapper is called with ["worktree","remove","--force","/tmp/wt"]
    Then it does not throw
    And exactly one git invocation is recorded

  Scenario: The assertion cannot be bypassed by a second call site
    When the repository is grepped for imports of "node:child_process" outside packages/proc/src/spawn.ts
         and for "execa(" outside packages/workspace/src/git.ts
    Then both greps return zero hits
```

**Notes:** "Zero git invocations recorded" is the observable that matters — it proves the assertion
runs _before_ `execa`, not in an error handler afterwards. A rule enforced by convention decays; a
rule enforced by a throw in the one chokepoint does not. `--force` is permitted only on
`worktree remove`, which [EPIC-07-S16](#epic-07-s16--a-locked-worktree-refuses-removal-and-needs-the-double-force)
and [EPIC-07-S17](#epic-07-s17--a-dirty-worktree-blocks-removal-and-the-wip-salvage-commit-that-unblocks-it) rely on.

---

## EPIC-07-S3 — The corruption `--force` would have created, demonstrated on raw git

**Verifies:** KAR-07.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Why the rule exists

  Scenario: Raw git happily creates two worktrees on one branch
    Given a repository on branch "main" with a branch "feature"
    And a worktree at "<tmp>/wt-a" created with "git worktree add <tmp>/wt-a feature"
    When raw git — bypassing the DeFlow wrapper — runs
         "git worktree add --force <tmp>/wt-b feature"
    Then the command exits 0
    And "git worktree list" shows two entries, both annotated "[feature]"
    And both working trees share one branch ref, which is the index corruption the rule prevents

  Scenario: The same attempt through the wrapper never reaches git
    When the Workspace Manager is asked to create a second worktree on "feature"
    Then the occupancy pre-check refuses it before any git process starts
    And a "workspace.branch_occupied" event names "<tmp>/wt-a" as the occupying path
```

**Notes:** **Verified 2026-08-02 on git 2.43.** This scenario is the _justification_ test — it
exists so a future contributor who wonders why `--force` is banned can read the failure rather than
the comment. It is the only scenario in this file that calls raw git deliberately; keep it in one
place and label it, or someone will copy the pattern.

---

## EPIC-07-S4 — Default-branch writes refused across every argument shape

**Verifies:** KAR-07.1 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: F5.5 enforced mechanically, not documented

  Background:
    Given the repository's default branch resolves to "main" from origin/HEAD

  Scenario Outline: The refusal set
    When the Git wrapper is called with <args>
    Then the outcome is "<outcome>"

    Examples:
      | args                                                          | outcome |
      | ["push","origin","main"]                                      | refused |
      | ["push","origin","HEAD:main"]                                 | refused |
      | ["push","--force","origin","DeFlow/r1__n1"]                   | refused |
      | ["push","-f","origin","DeFlow/r1__n1"]                        | refused |
      | ["branch","-f","main","DeFlow/r1__n1"]                        | refused |
      | ["update-ref","refs/heads/main","<oid>"]                      | refused |
      | ["push","--force-with-lease","origin","DeFlow/r1__n1"]        | allowed |
      | ["push","origin","DeFlow/int/r1"]                             | allowed |
      | ["commit","-m","DeFlow: WIP salvage"]                         | allowed |

  Scenario: Default-branch resolution falls back when there is no remote
    Given a repository with no remote configured
    When the wrapper resolves the default branch
    Then it reads the HEAD symref and resolves "main"
    And the resolution is cached on the run, so a second call spawns no git process

  Scenario: A repository whose default branch is not "main"
    Given origin/HEAD points at "trunk"
    When the wrapper is called with ["push","origin","trunk"]
    Then it is refused
    And ["push","origin","main"] is allowed, because "main" is an ordinary branch here
```

**Notes:** The last scenario is the one that catches a hardcoded `'main'`. F5.5 says _never write to
the default branch_, and the default branch is a property of the repository, not a string constant.

---

## EPIC-07-S5 — Flat branch names, and an integration branch that can coexist with them

**Verifies:** KAR-07.3 · **Type:** Happy path · **Automated at:** unit + integration

```gherkin
Feature: Flat branch naming (D13)

  Scenario: Names are composed and validated once
    When nodeBranch("r1", "n1") is called
    Then it returns "DeFlow/r1__n1"
    And integrationBranch("r1") returns "DeFlow/int/r1"
    And each composed name was passed through "git check-ref-format --branch" exactly once
    And a second call for the same name reads the cached result and spawns no git process

  Scenario: The integration branch coexists with node branches on a real repository
    Given a repository on "main"
    When DeFlowd creates "DeFlow/int/r1" from the base ref
    And then creates "DeFlow/r1__n1", "DeFlow/r1__n2" and "DeFlow/r1__n3"
    Then all four branches exist in "git branch --list 'DeFlow/*'"
    And creating them in the reverse order also succeeds
```

**Notes:** The reverse-order clause matters: git's refs directory/file conflict is symmetric, so a
scheme that only works in one creation order is not fixed, it is lucky.

---

## EPIC-07-S6 — Regression: the PRD's hierarchical scheme cannot hold an integration branch

**Verifies:** KAR-07.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Why D13 overrides PRD F5.1

  Scenario: A run-level branch cannot exist beneath a node-level branch
    Given a repository where "git branch DeFlow/r1/n1" has succeeded
    When raw git runs "git branch DeFlow/r1"
    Then it exits non-zero
    And stderr contains
        "fatal: cannot lock ref 'refs/heads/DeFlow/r1': 'refs/heads/DeFlow/r1/n1' exists"
    And stderr contains "cannot create 'refs/heads/DeFlow/r1'"

  Scenario: And the reverse order fails symmetrically
    Given a repository where "git branch DeFlow/r1" has succeeded
    When raw git runs "git branch DeFlow/r1/n1"
    Then it exits non-zero
    And stderr names a ref conflict on "refs/heads/DeFlow/r1"

  Scenario: DeFlow's own generator can never produce the failing shape
    When nodeBranch is called for 200 random valid (runId, nodeId) pairs
    Then no returned name contains more than two "/" characters
    And no returned name is a prefix of another returned name followed by "/"
```

**Notes:** **Verified 2026-08-02, git 2.43.** This is the highest-value regression test in the epic.
The hierarchical scheme _works_ right up until the merge phase of a real run, where it fails as an
inexplicable git error hours in. A test that pins the failure is what stops someone "simplifying"
the naming back to what the PRD says.

---

## EPIC-07-S7 — Ref-name validation across the verified reject set

**Verifies:** KAR-07.3 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Two-layer ref validation

  Scenario Outline: The domain layer rejects before git is ever asked
    When nodeBranch("r1", "<nodeId>") is called
    Then it throws UnsafeRefError naming the offending component

    Examples:
      | nodeId          | why                                        |
      | node.lock       | any component ending in .lock is invalid   |
      | a..b            | ".." sequence                              |
      | "trailing "     | trailing space                             |
      | ref@{1}         | "@{" is invalid                            |
      | -n              | leading dash is a flag, not a name         |
      | N1              | ids are normalized to a single case first  |
      | <65 chars>      | exceeds the 64-character BRANCH_SAFE bound |

  Scenario: The two layers are checked against each other
    Given the accept set produced by BRANCH_SAFE over a generated corpus
    When each composed name is passed to real "git check-ref-format --branch"
    Then git accepts every name BRANCH_SAFE accepted
    And the only documented disagreement is "-n", which git accepts and BRANCH_SAFE rejects
```

**Notes:** **Verified rejects 2026-08-02**: `.lock` suffix, `..`, trailing space, `@{`. Case
normalization is not a git requirement — it is the cheap way to close the unverified APFS
worktree-path collision question (A5-7) without needing to answer it.

---

## EPIC-07-S8 — The `-n` trap: a valid ref name that git parses as a flag

**Verifies:** KAR-07.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: check-ref-format is necessary and not sufficient

  Scenario: git accepts "-n" as a ref name
    When raw git runs "git check-ref-format --branch -- -n"
    Then it exits 0, confirming "-n" is a structurally valid branch name

  Scenario: and then parses it as a flag
    Given a name that begins with "-" reaches a git command position
    When it is passed without a "--" separator
    Then git interprets it as an option and the command's behaviour is not what the caller intended

  Scenario: DeFlow closes the hole at two levels
    When nodeBranch is asked for a nodeId of "-n"
    Then it throws UnsafeRefError at the domain layer, before any composition
    And every call site that passes a generated name to git is asserted to use either a "--"
        separator or the "--branch=<value>" long form
    And a repository-wide grep finds no git call passing a generated name in a bare positional slot
```

**Notes:** This is the "validity is necessary and not sufficient" case from
[§2.1](../../09-workspace-and-safety.md). Two independent controls, because either one alone is a
single point of failure and the failure is silent.

---

## EPIC-07-S9 — Write node gets a locked worktree on its own branch, locked atomically

**Verifies:** KAR-07.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Worktree creation for a write node

  Scenario: One command creates, branches and locks
    Given a run "r1" with a write node "n1" and base ref "main"
    When the Workspace Manager provisions the worktree
    Then exactly one git invocation is recorded, and its argv is
         ["worktree","add","--lock","--reason","DeFlow run=r1 node=n1",
          "-b","DeFlow/r1__n1","<tmp>/.DeFlow/worktrees/r1__n1","main"]
    And no separate "worktree lock" invocation appears anywhere in the create path
    And "git worktree list --porcelain -z" reports the new entry with a "branch refs/heads/DeFlow/r1__n1"
        record and a "locked DeFlow run=r1 node=n1" record
    And a "workspace.worktree_created" event carries the path, the branch and the base ref

  Scenario: A locked worktree is immune to prune
    Given the worktree from the previous scenario exists and is locked
    When "git worktree prune -v --expire 2.weeks.ago" runs
    Then the worktree is still listed
    And its directory still exists on disk
```

**Notes:** The atomicity assertion — one invocation, no separate `lock` — is the whole scenario.
Create-then-lock races with DeFlow's own reaper across a daemon restart, and the window is small
enough that it will only ever fail in production. Lock-immunity-to-prune is why `--lock` is the
crash-safety primitive rather than a side-channel lockfile that can desync from git's own view.

---

## EPIC-07-S10 — Read node gets a locked detached worktree

**Verifies:** KAR-07.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Detached worktrees for read-only nodes

  Scenario: No branch is created, and branch uniqueness never applies
    Given a run "r1" with a read node "n2"
    When the Workspace Manager provisions the worktree
    Then the argv is ["worktree","add","--detach","--lock","--reason","DeFlow run=r1 node=n2",
                      "<path>","main"]
    And the argv contains no "-b"
    And "git branch --list 'DeFlow/r1__n2'" returns empty

  Scenario: Two read nodes on the same base ref both succeed
    Given read nodes "n2" and "n3" both based on "main"
    When both worktrees are provisioned
    Then both succeed
    And "git worktree list --porcelain -z" reports both with a "detached" record and no "branch" record
    And neither creation attempt produced a "workspace.branch_occupied" event
```

**Notes:** `--detach` is chosen for intent as much as for mechanism: it says _this node is not going
to produce a branch_, and it sidesteps the entire branch-uniqueness class in
[EPIC-07-S11](#epic-07-s11--the-same-branch-in-two-worktrees-and-the-error-string-that-is-not-what-the-blogs-say)
for free.

---

## EPIC-07-S11 — The same branch in two worktrees, and the error string that is not what the blogs say

**Verifies:** KAR-07.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Branch uniqueness

  Scenario: DeFlow refuses before git is asked
    Given a worktree at "<tmp>/wt-a" checked out on branch "feature"
    When the Workspace Manager is asked to provision another worktree on "feature"
    Then no "worktree add" invocation is recorded
    And a "workspace.branch_occupied" event is appended carrying
        { branch: "feature", occupiedBy: "<tmp>/wt-a", occupantKind: "worktree" }
    And the node is failed with a typed error, not a parsed git string

  Scenario: The real git error string, pinned as a regression
    Given a worktree at "<tmp>/wt-a" checked out on branch "feature"
    When raw git runs "git worktree add <tmp>/wt-b feature"
    Then it exits non-zero
    And stderr equals "fatal: 'feature' is already used by worktree at '<tmp>/wt-a'"
    And stderr does NOT contain "is already checked out at"

  Scenario: The belt-and-braces matcher, if one exists at all
    Given a stderr matcher is used only as a secondary signal
    Then it matches the substring "already used by worktree at"
    And it accepts "already checked out" as a legacy alternate
    And the primary detection path is the porcelain list scan, which is what the test asserts ran first
```

**Notes:** **Verified 2026-08-02.** The widely-quoted `already checked out at` is wrong, and a
design that parses git's error text is one release from breaking anyway. The pre-check against
`worktree list --porcelain -z` is the real mechanism; the string assertion exists so that if anyone
does add a matcher, they add the correct one. Vibe Kanban's category research reports hand-rolled
worktree scripts failing silently on exactly this.

---

## EPIC-07-S12 — The main checkout counts as an occupant, so the operator's own branch is blocked

**Verifies:** KAR-07.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The occupant is usually the operator

  Scenario: The very first run, on the branch the operator is sitting on
    Given the operator's main checkout at "<tmp>/repo" is on branch "main"
    And no other worktree exists
    When a write node is planned with base ref "main" and a branch name of "main"
    Then the occupancy pre-check finds the main checkout in "worktree list --porcelain -z"
    And a "workspace.branch_occupied" event is appended with occupantKind "main-checkout"
        and occupiedBy "<tmp>/repo"
    And the operator-facing message names their own current branch and offers to base the node
        on it instead of checking it out
    And the message does not echo git's wording

  Scenario: Raw git agrees, which is why the pre-check exists
    When raw git runs "git worktree add <tmp>/wt main"
    Then stderr equals "fatal: 'main' is already used by worktree at '<tmp>/repo'"

  Scenario: DeFlow's own branches never hit this
    Given node branches are generated as "DeFlow/<runId>__<nodeId>"
    When 20 write nodes across 4 runs are provisioned against base ref "main"
    Then every worktree is created successfully
    And no "workspace.branch_occupied" event is emitted
```

**Notes:** **Verified 2026-08-02.** This — not agent-versus-agent collision — is the common
real-world hit, and it lands on the _very first run_. The third scenario states the design that
makes it a non-event in practice: nodes get generated branch names and take `main` only as a base
ref, never as a checkout target. The error path exists for the case where a plan or a human names a
branch explicitly.

---

## EPIC-07-S13 — Porcelain `-z` parsing, including a lock reason and a path with a space

**Verifies:** KAR-07.2 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: worktree list is read one way only

  Scenario: Every record type round-trips
    Given a captured "git worktree list --porcelain -z" output containing
          a main checkout, a branch worktree, a detached worktree,
          a locked worktree whose reason is "DeFlow run=r1 node=n1",
          and a prunable worktree
    When the porcelain parser reads it
    Then it yields five entries
    And the branch entry carries branch "refs/heads/DeFlow/r1__n1" and detached false
    And the detached entry carries detached true and no branch
    And the locked entry carries locked true and lockReason "DeFlow run=r1 node=n1"
    And the prunable entry carries prunable true with its reason string

  Scenario: A worktree path containing a space
    Given a worktree created at "<tmp>/my worktrees/r1 n1"
    When the porcelain parser reads the list
    Then the entry's path is exactly "<tmp>/my worktrees/r1 n1"
    And no field was split on whitespace

  Scenario: The non-porcelain form is never invoked
    When the packages/workspace source is grepped for "worktree list"
    Then every hit is followed by both "--porcelain" and "-z"
```

**Notes:** `-z` is what makes paths-with-spaces and multi-word lock reasons safe; the non-porcelain
form is a human display format and parsing it is a latent bug waiting for a user with a space in
their home directory. Git 2.45 is the _preferred_ floor precisely because `--porcelain -z` on
`worktree list` stabilized there.

---

## EPIC-07-S14 — Git is the authority: the operator removes a worktree by hand

**Verifies:** KAR-07.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: SQLite is an index over git, never the source of truth

  Scenario: A manual removal reconciles cleanly
    Given DeFlowd has three worktrees provisioned and three rows in the "worktrees" projection table
    When the operator runs "git worktree remove <path-of-second>" in their own terminal
    And DeFlowd refreshes the projection from "git worktree list --porcelain -z"
    Then the projection contains two rows
    And a "workspace.reconciled" event names the removed path
    And no error is raised and no run is failed

  Scenario: A manual rm -rf leaves a prunable entry, and that is also reconciled
    When the operator runs "rm -rf <path-of-third>" without telling git
    And DeFlowd refreshes the projection
    Then the third entry is present with prunable true
    And it is scheduled for pruning at the next reap rather than being treated as live

  Scenario: The projection is never read as truth for a decision
    When the occupancy pre-check runs
    Then it reads "git worktree list --porcelain -z" directly
    And it does not query the "worktrees" table
```

**Notes:** _"The moment a user runs `git worktree remove` by hand — and they will — a
SQLite-authoritative design is wrong and does not know it."_ The third scenario is the one that
keeps the design honest over time: the projection exists for the UI, not for decisions.

---

## EPIC-07-S15 — Removal happy path: unlock, then remove

**Verifies:** KAR-07.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Clean worktree removal

  Scenario: The two-step sequence on a clean worktree
    Given a locked worktree whose node has completed and whose tree is clean
    When the Workspace Manager removes it
    Then the recorded git invocations are exactly
         ["worktree","unlock","<path>"] then ["worktree","remove","<path>"]
    And neither invocation contains "--force"
    And the directory no longer exists
    And the node's branch "DeFlow/r1__n1" still exists with its commits intact
    And a "workspace.worktree_removed" event carries the path and the branch tip OID

  Scenario: The branch survives removal, because the branch is the output
    When "git log --oneline DeFlow/r1__n1" runs after removal
    Then the node's commits are listed
```

**Notes:** Removing the worktree must never remove the work. The branch is the deliverable (F5.5),
and the tip OID in the event is what the integration loop
([EPIC-07-S26](#epic-07-s26--the-integration-loop-re-sorts-the-queue-after-every-merge)) later
merges.

---

## EPIC-07-S16 — A locked worktree refuses removal and needs the double force

**Verifies:** KAR-07.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Locked removal

  Scenario: Plain remove refuses a locked worktree
    Given a worktree locked with reason "DeFlow run=r1 node=n1"
    When raw git runs "git worktree remove <path>"
    Then it exits non-zero
    And stderr contains "cannot remove a locked working tree"
    And stderr contains "use 'remove -f -f' to override or unlock first"

  Scenario: The normal path unlocks rather than forcing
    When the Workspace Manager removes a locked worktree on the node-completion path
    Then it invokes "worktree unlock" first
    And "remove -f -f" never appears in the recorded invocations

  Scenario: The reaper path is the only caller of the double force
    Given a worktree whose owning process is provably gone by the PID-and-start-time check
    When the reaper removes it
    Then the invocation ["worktree","remove","-f","-f","<path>"] is recorded
    And a static assertion confirms "remove -f -f" is unreachable from the node-completion path
```

**Notes:** Two forces, not one — the first overrides dirtiness, the second overrides the lock. The
static reachability assertion is cheap and it is what stops the double force migrating into the
normal path the first time someone hits a flaky unlock.

---

## EPIC-07-S17 — A dirty worktree blocks removal, and the WIP salvage commit that unblocks it

**Verifies:** KAR-07.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Never discard an agent's work

  Background:
    Given a write node "n1" whose worktree contains a modified tracked file "src/a.ts"
      and an untracked file "src/new.ts"

  Scenario: Plain removal refuses, with the verified message
    When raw git runs "git worktree remove <path>"
    Then it exits non-zero
    And stderr contains "contains modified or untracked files, use --force to delete it"

  Scenario: The salvage sequence, in order
    When the Workspace Manager removes the dirty worktree
    Then the ledger contains, in this order:
         a "workspace.dirty_on_remove" event whose payload holds the parsed
           "git status --porcelain=v2 -z" entries for both files,
         a "workspace.wip_salvaged" event carrying the salvage commit OID,
         a "workspace.worktree_removed" event
    And the git invocations are, in order:
         ["status","--porcelain=v2","-z"], ["add","-A"],
         ["commit","-m","DeFlow: WIP salvage"], ["worktree","remove","--force","<path>"]

  Scenario: The work is recoverable from the branch alone
    When "git show DeFlow/r1__n1" runs after removal
    Then the salvage commit's subject is "DeFlow: WIP salvage"
    And its diff contains the modification to "src/a.ts" and the whole of "src/new.ts"

  Scenario: A crash between capture and commit leaves the worktree intact
    Given the daemon is SIGKILLed after the "workspace.dirty_on_remove" event is durable
      and before the commit
    When DeFlowd restarts
    Then the worktree still exists and is still dirty
    And no "--force" removal happened
    And the salvage sequence restarts from the status capture

  Scenario: A dirty detached read worktree has no branch to commit to
    Given a detached read-node worktree with an untracked file
    When the Workspace Manager removes it
    Then the salvage commit lands on a new branch "DeFlow/salvage/r1__n2"
    And the removal then proceeds with "--force"
```

**Notes:** Force becomes acceptable **only after the salvage commit is durable** — that ordering is
the entire story, and the crash scenario is what proves the ordering is real rather than incidental.
Note that `add -A` is deliberate: the untracked file is exactly the thing a blind `--force` would
have destroyed with no record anywhere.

---

## EPIC-07-S18 — Gitignored files do not block removal

**Verifies:** KAR-07.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The non-problem

  Scenario: A worktree whose only untracked content is gitignored
    Given a worktree whose tracked files are all clean
    And a "node_modules/" directory containing 500 files, matched by .gitignore
    And a "dist/" directory, also gitignored
    When the Workspace Manager removes the worktree
    Then "git worktree remove <path>" exits 0
    And no "--force" was passed
    And no "workspace.dirty_on_remove" event was emitted
    And the salvage path was never entered

  Scenario: Mixed content still salvages
    Given the same worktree plus one modified tracked file
    When removal runs
    Then the salvage sequence runs
    And the salvage commit contains the tracked modification and does NOT contain node_modules
```

**Notes:** **Verified 2026-08-02:** a worktree containing only `node_modules/` removed cleanly with
exit 0. So a fat `node_modules` is a **disk** problem
([EPIC-07-S22](#epic-07-s22--the-disk-estimate-shown-before-a-fan-out-is-authorized)), not a removal
problem. Do not build cleanup machinery for it — this scenario exists to stop that machinery being
built.

---

## EPIC-07-S19 — `.worktreeinclude` copies gitignored config, and only that

**Verifies:** KAR-07.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Layer 1 — copy gitignored config

  Background:
    Given a repository whose .gitignore contains ".env", ".env.local", "secrets/" and "node_modules/"
    And a ".worktreeinclude" containing ".env", "config/secrets.json" and "!.env.production"
    And the main checkout contains .env (mode 0600), .env.local, config/secrets.json (tracked),
        .env.production, and node_modules/

  Scenario Outline: Only files that match a pattern AND are gitignored are copied
    When a new worktree is provisioned
    Then "<file>" is "<disposition>" in the worktree

    Examples:
      | file                  | disposition | why                                  |
      | .env                  | copied      | matches a pattern and is gitignored  |
      | .env.local            | absent      | gitignored but matches no pattern    |
      | config/secrets.json   | absent      | matches a pattern but is tracked     |
      | .env.production       | absent      | excluded by the "!" negation         |
      | node_modules/         | absent      | not a .worktreeinclude pattern       |

  Scenario: Modes are preserved so a secret does not widen
    When ".env" is copied into the worktree
    Then its mode is 0600, matching the source
    And a "workspace.included_file" event names the path ".env"
    And that event carries no file contents

  Scenario: No .worktreeinclude means no copying at all
    Given the repository has no ".worktreeinclude"
    When a worktree is provisioned
    Then zero files are copied and zero "workspace.included_file" events are emitted
```

**Notes:** The filename is Claude Code's convention, adopted **verbatim** — zero new concepts for
users already on Claude Code. The mode-preservation clause is not cosmetic: these files frequently
contain credentials, and copying them into a worktree makes them readable by the agent. What keeps
that bounded is the permission level and the vendor sandbox's `credentials.files` deny list
([EPIC-08-S23](./EPIC-08-safety-model-flows.md)) — not this copy step.

---

## EPIC-07-S20 — Package-manager-native sharing, and the symlink that must never exist

**Verifies:** KAR-07.5 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Layer 2 — dependency sharing

  Scenario Outline: The manager is detected from the lockfile
    Given the repository root contains "<lockfile>"
    When a worktree is provisioned
    Then the setup command is "<command>"

    Examples:
      | lockfile          | command                        |
      | pnpm-lock.yaml    | pnpm install --frozen-lockfile |
      | package-lock.json | npm ci                         |
      | yarn.lock         | yarn install --immutable       |

  Scenario: Two lockfiles is an error, not a precedence rule
    Given the repository contains both "pnpm-lock.yaml" and "package-lock.json"
    When a worktree is provisioned
    Then provisioning fails with a typed error naming both lockfiles
    And no install command is run

  Scenario: No shared node_modules symlink is ever created
    When the provisioning plan for three worktrees is computed
    Then no entry in the plan creates a symlink whose target resolves to a "node_modules" directory
    And each worktree's node_modules is a real directory after provisioning

  Scenario: The pnpm store is shared, and that is the safe symlink
    Given the package manager is pnpm
    When three worktrees are provisioned from the same lockfile
    Then each worktree's node_modules contains links into one content-addressable store
    And the marginal disk cost of the second and third worktrees is under 5% of the first
```

**Notes:** **Hard rule:** never symlink a shared `node_modules` across worktrees — two agents
running installs concurrently against one tree corrupts it, and it defeats the isolation the
worktree exists to provide. The one safe shared target is the _store_, which pnpm already does
correctly. **Unverified (A5-10):** `pnpm.io/git-worktrees` 403'd during research; the store-sharing
mechanism is long-standing and safe, but do not write a pnpm config key into docs without
re-fetching that page.

---

## EPIC-07-S21 — Setup runs once and is cached on the lockfile hash

**Verifies:** KAR-07.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Layer 3 — workspace.setup with a content-keyed marker

  Background:
    Given DeFlow.config.ts declares
          workspace.setup = "pnpm install --frozen-lockfile && pnpm build:deps"
      and workspace.setupCacheKey = ["pnpm-lock.yaml"]
    And a fake "pnpm" shim on the tmp PATH that appends its argv to a log file

  Scenario: The first worktree runs setup and streams its output
    When the first worktree is provisioned
    Then the shim log records one invocation
    And the setup command's stdout is appended to the ledger as io_chunk records against the node
    And a success marker keyed on sha256("pnpm-lock.yaml") is written

  Scenario: The second worktree on an unchanged lockfile skips setup entirely
    When a second worktree is provisioned
    Then the shim log still records one invocation in total
    And a "workspace.setup_cache_hit" event is emitted naming the marker key

  Scenario: Touching the lockfile invalidates the marker
    Given "pnpm-lock.yaml" is modified
    When a third worktree is provisioned
    Then the shim log records a second invocation
    And the new marker key differs from the old one

  Scenario: A failing setup fails provisioning before any agent is spawned
    Given the shim exits 1 with "ERR_PNPM_OUTDATED_LOCKFILE" on stderr
    When a worktree is provisioned
    Then provisioning fails with a typed error carrying the exit code and the stderr tail
    And no agent process was spawned for that node
    And the worktree is removed by the ordinary clean-removal path
```

**Notes:** The marker is keyed on file _content_, not on a timestamp or a boolean, so a lockfile
that changes and changes back is correctly a cache hit. The last scenario matters more than it
looks: a node whose dependencies did not install will burn a full agent turn discovering it, which
is exactly the wasted quota this layer exists to prevent.

---

## EPIC-07-S22 — The disk estimate shown before a fan-out is authorized

**Verifies:** KAR-07.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Tell the operator what a fan-out costs before they approve it

  Scenario: The estimate formula
    Given a repository whose tracked working tree is 120 MB
    And a node_modules of 800 MB
    And a plan that fans out to 8 write nodes
    When the plan-approval estimate is computed for npm
    Then the reported figure is 8 × (120 MB + 800 MB), rendered as approximately 7.2 GB
    And the breakdown names the tracked-tree term and the node_modules term separately

  Scenario: pnpm collapses the second term
    Given the same repository with pnpm-lock.yaml
    When the estimate is computed
    Then the node_modules term is reported as approximately zero
    And the total is approximately 960 MB
    And the explanation names the content-addressable store

  Scenario: The object store is shared, so .git is not multiplied
    Given a repository with a 300 KB .git directory
    When 8 worktrees are created
    Then the total on-disk growth attributable to .git is under 100 KB
    And the estimate does not include a per-worktree .git term
```

**Notes:** **Verified:** a 300 KB `.git` served a 24 KB worktree with no object duplication — the
object store is shared, so only the working tree is multiplied. The point of surfacing the number is
behavioural: _a user who is told "this plan will use 14 GB" migrates to pnpm on their own._

---

## EPIC-07-S23 — `merge-tree` reports a clean merge with no side effects at all

**Verifies:** KAR-07.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: merge-tree as a read-only probe (D14)

  Scenario: A clean merge
    Given branches "DeFlow/r1__a" and "DeFlow/r1__b" editing different files
    When mergeTree(git, "DeFlow/r1__a", "DeFlow/r1__b") runs
    Then the underlying invocation is
         ["merge-tree","--write-tree","--name-only","-z","DeFlow/r1__a","DeFlow/r1__b"]
    And the exit code is 0
    And the result is { clean: true, paths: [] }

  Scenario: The probe touches nothing
    Given both branches have live worktrees with uncommitted changes
    And a recursive hash of both worktrees is taken
    When the probe runs
    Then the recursive hashes are unchanged
    And "git status --porcelain=v2 -z" in both worktrees reports the same entries as before
    And the main repository's index mtime is unchanged

  Scenario: Exit codes of two or more are real errors
    Given a probe is run against a ref that does not exist
    When mergeTree runs
    Then it throws GitError
    And the error message contains git's stderr
    And it is NOT reported as a conflict
```

**Notes:** _"Side effects: **None.** Touches neither the index nor any working tree — safe to run
against live worktrees at any moment."_ That property is what makes a _continuous_ probe possible;
the second scenario is the test that stops a future refactor reaching for `git merge` and quietly
breaking every running agent.

---

## EPIC-07-S24 — `merge-tree` returns exit 1 with conflicted paths, and the pipe that destroys the signal

**Verifies:** KAR-07.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The conflict signal is the exit code

  Scenario: Conflict reported as exit 1 with paths
    Given branches "DeFlow/r1__a" and "DeFlow/r1__b" both editing the same line of "f.txt"
    And "DeFlow/r1__b" also editing "g.txt", which "DeFlow/r1__a" does not touch
    When mergeTree(git, "DeFlow/r1__a", "DeFlow/r1__b") runs
    Then the exit code is 1
    And the result is { clean: false, paths: ["f.txt"] }
    And "g.txt" is absent from paths, because it merged cleanly

  Scenario: The first NUL-separated field is the tree OID, not a path
    When the raw stdout of the probe is split on "\0"
    Then the first field matches /^[0-9a-f]{40}$/
    And mergeTree drops it before returning paths

  Scenario: Without --name-only the output carries the info block
    When raw git runs "git merge-tree --write-tree DeFlow/r1__a DeFlow/r1__b"
    Then stdout contains "Auto-merging f.txt"
    And stdout contains "CONFLICT (content): Merge conflict in f.txt"
    And the exit code is still 1

  Scenario: The pipe trap — piping destroys the signal
    Given the same conflicting branches
    When the probe output is piped through another command in a shell
    Then "$?" reports the exit status of the last command in the pipeline, not of merge-tree
    And the conflict is indistinguishable from a clean merge
    And DeFlow therefore captures the exit code directly from execa with reject: false,
        and no code path in packages/workspace pipes a git invocation
```

**Notes:** **Verified 2026-08-02, git 2.43.** The pipe trap is why
[EPIC-07-S1](#epic-07-s1--happy-path-the-wrapper-treats-exit-codes-as-data-and-enforces-the-version-floor)'s
`reject: false` exists. The final assertion — no piping anywhere in `packages/workspace` — is a grep,
and it is cheaper than rediscovering this at merge time in a three-hour run.

---

## EPIC-07-S25 — Two parallel write nodes are serialized on the first detected conflict

**Verifies:** KAR-07.6 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Conflict as a scheduling input, not a merge-time surprise

  Scenario: Overlapping declared scopes do not block admission
    Given write nodes "n1" and "n2" whose declared path scopes both include "src/**"
    When the scheduler admits the ready set
    Then both nodes are started in parallel
    And no node is blocked on the declared overlap alone

  Scenario: The first detected conflict blocks the later starter
    Given "n1" started at T0 and "n2" started at T1, where T1 > T0
    And both have committed edits to the same line of "src/a.ts"
    When the conflict probe runs after "n2" commits
    Then a conflict_probe row exists for (r1, DeFlow/r1__n1, DeFlow/r1__n2)
         with clean 0, path_count 1 and paths_json ["src/a.ts"]
    And "n2" is moved to blocked
    And a "node.blocked" event names "n1" as the conflicting counterpart and lists "src/a.ts"
    And "n1" continues running

  Scenario: The obviously insane case is still refused at plan time
    Given two write nodes declaring the identical single file "src/a.ts" as their entire scope
    When the plan is validated
    Then the plan is rejected before execution with a scope-collision error

  Scenario: Probe fan-out after a commit
    Given five in-flight write branches and one integration branch
    When the third node commits
    Then probes are run for that branch against the integration branch and against the other
         four in-flight branches — five probes
    And all five complete within 500 ms on the fixture repository
```

**Notes:** This is the refinement over F5.2: _start write nodes in parallel and serialize on the
FIRST DETECTED conflict_. Most declared overlaps never actually conflict — two agents editing
different functions in one file merge fine — so static serialization throws away real parallelism.
Declared scope is retained only to refuse the identical-single-file case.

---

## EPIC-07-S26 — The integration loop re-sorts the queue after every merge

**Verifies:** KAR-07.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Sequential, lowest-overlap-first integration

  Background:
    Given a run "r1" whose integration branch "DeFlow/int/r1" was created from "main" at run start
    And four completed node branches n1..n4
    And conflict counts against the integration branch of n1:0, n2:2, n3:1, n4:0

  Scenario: The initial order is ascending conflict count with a completion-time tie-break
    When the merge queue is computed
    Then the order is [n1, n4, n3, n2]
    And n1 precedes n4 because it completed first

  Scenario: After each merge, every remaining branch is re-probed and the queue re-sorted
    When n1 is merged into "DeFlow/int/r1"
    Then probes are re-run for n2, n3 and n4 against the new integration tip
    And a "workspace.merge_queue_reordered" event carries
        { before: ["n4","n3","n2"], after: ["n3","n4","n2"] } when the new counts are n3:0, n4:1, n2:2
    And the next merge takes n3, not n4

  Scenario: A gate runs against the integration branch between merges
    When each merge completes
    Then the run's verification gate is invoked against "DeFlow/int/r1"
    And the gate verdict is recorded before the next merge begins

  Scenario: Merges are --no-ff and name their provenance
    When all four branches have merged
    Then "git log --merges --oneline DeFlow/int/r1" lists four merge commits
    And each merge commit message contains "run=r1" and the merged "node=<nodeId>"
    And "git diff main..DeFlow/int/r1" contains every node's changes
```

**Notes:** Re-sorting is not an optimization. A merge changes every remaining branch's conflict
count against the integration branch, so an order computed once is stale the instant the first
merge lands — and the whole reason to order at all is to hit the conflicts last, when the cheapest
branches are already integrated. The `before`/`after` payload on the reorder event is what makes
this observable in the run timeline instead of being an invisible internal decision.

---

## EPIC-07-S27 — A conflicting merge spawns a narrow resolution node

**Verifies:** KAR-07.7 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Conflicts get a dedicated, tightly-scoped node

  Scenario: The resolution node's shape
    Given the merge of "DeFlow/r1__n2" into "DeFlow/int/r1" conflicts on "src/a.ts"
    When DeFlow handles the conflict
    Then a resolution node is inserted into the plan via a PlanPatch whose reason names the conflict
    And the node's permission level is "worktree"
    And the node's cwd is the integration worktree, not a node worktree
    And the node's context packet contains exactly two segment kinds:
        the conflicted hunks taken from the merge-tree stage lines,
        and the intent summaries of n2 and of the already-merged counterpart from the blackboard
    And the packet contains no file that was not conflicted

  Scenario: No blind auto-resolution
    Then no code path merges with a strategy option that resolves conflicts automatically
    And "-X ours", "-X theirs" and "--strategy=ours" appear nowhere in packages/workspace

  Scenario: The resolver never sees the whole repository
    When the packet's total token count is compared against a full-repository packet
    Then the resolution packet is smaller by at least an order of magnitude
    And the assembled packet is snapshot-tested with the normalizing serializer
```

**Notes:** _"Never let an agent auto-resolve blind, and never hand a resolver the whole
repository."_ The intent summaries are the piece a text-only merge tool structurally cannot supply
and a human reviewer would always ask for — and they are available only because the blackboard
retained intent. This is a narrow, cheap, high-succeeding node shape, which is why conflicts are
affordable rather than run-ending.

---

## EPIC-07-S28 — A gate failure between merges halts the loop with the queue intact

**Verifies:** KAR-07.7 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A failed gate stops integration rather than compounding it

  Scenario: Halt, do not continue merging
    Given the merge queue is [n3, n4, n2] and n3 has just merged
    When the verification gate against "DeFlow/int/r1" returns verdict "fail"
    Then no further merge is attempted
    And a "gate.evaluated" event records the verdict with its evidence findings
    And the remaining queue [n4, n2] is readable from the ledger projection

  Scenario: The loop resumes from the recorded queue
    Given the gate failure was repaired on the integration branch
    When the integration loop is resumed
    Then it re-probes n4 and n2 against the current integration tip
    And re-sorts before merging, rather than trusting the recorded order

  Scenario: The integration branch is never pushed to the default branch
    When the run completes, successfully or not
    Then no invocation pushes "DeFlow/int/r1" to the default branch
    And the run's output is the integration branch itself
```

**Notes:** The second scenario is the subtle one: the recorded queue is a record of _what is left_,
not of _what order to use_. Resuming with a stale order would reintroduce exactly the staleness
[EPIC-07-S26](#epic-07-s26--the-integration-loop-re-sorts-the-queue-after-every-merge) exists to
remove.

---

## EPIC-07-S29 — Boot reaping runs reap → unlock → prune, in that order

**Verifies:** KAR-07.8 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Daemon-boot recovery of orphaned worktrees

  Background:
    Given DeFlowd spawned a detached "bash -c 'sleep 300'" as node n1's agent
    And persisted { runId: "r1", nodeId: "n1", pid, pgid, startedAt, procStartTime } to SQLite
    And n1's worktree is locked with reason "DeFlow run=r1 node=n1"

  Scenario: The full recovery on restart
    Given DeFlowd was SIGKILLed
    When DeFlowd starts again over the same .DeFlow directory
    Then for the non-terminal row it compares the recorded procStartTime with the live process's
         start time (/proc/<pid>/stat field 22 on Linux, "ps -o lstart= -p <pid>" on macOS)
    And on a match it sends process.kill(-pgid, 'SIGKILL')
    And it then runs ["worktree","unlock","<path>"]
    And it then runs ["worktree","prune","-v","--expire","2.weeks.ago"]
    And the recorded git invocation order shows unlock strictly before prune

  Scenario: Pruning before unlocking would silently do nothing
    Given a locked, orphaned worktree whose directory has been "rm -rf"'d
    When "git worktree list --porcelain -z" runs
    Then the entry carries no "prunable" record at all, because it is still locked
    When "git worktree prune -v --expire 2.weeks.ago" is run without unlocking first
    Then the worktree is still listed
    And prune reported no removal for it
    When the same worktree is unlocked
    Then the entry does carry a "prunable" record

  Scenario: Reaping is idempotent
    When the reaper is run a second time immediately after the first
    Then it emits no further events
    And it exits 0
    And the end state is identical

  Scenario: Reaping fits inside the cold-start budget
    Given 20 orphaned rows across 4 runs
    When the reaper runs at boot
    Then it completes in under 2 seconds
    And the daemon reaches ready state within the NF3 3-second budget
```

**Notes:** The order is load-bearing and non-obvious: **locked worktrees are immune to prune**, so
pruning first is a no-op that looks like success. The second scenario is the test that pins that.
This mirrors Claude Code's own documented stale-lock sweep, which is reassuring convergent evidence
rather than a coincidence.

---

## EPIC-07-S30 — A stale conflict probe is re-probed, never trusted

**Verifies:** KAR-07.6 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Both tips are stored so staleness is detectable

  Scenario: A row whose tips no longer match is stale
    Given a conflict_probe row for (r1, DeFlow/r1__a, DeFlow/r1__b) with
          a_commit "aaa…" and b_commit "bbb…" and clean 1
    When branch "DeFlow/r1__a" advances to "ccc…"
    And the scheduler reads the conflict state for that pair
    Then the row is classified stale
    And a fresh probe is run before any scheduling decision is taken
    And the row is upserted with a_commit "ccc…"

  Scenario: A row whose tips still match is used without re-probing
    When neither branch has advanced
    Then no git process is spawned
    And the cached clean value is used

  Scenario: The table's primary key prevents duplicate pairs
    When the same pair is probed twice with different results
    Then exactly one row exists for (run_id, branch_a, branch_b)
    And it holds the later probed_at value

  Scenario: Branch pair ordering is canonical
    When probes are recorded for (a, b) and for (b, a)
    Then both write to the same row, because the pair is normalized before the key is formed
```

**Notes:** Storing both tips is a three-column cost that turns "is this cached answer still true?"
from an unanswerable question into a comparison. Without it, the probe table becomes a source of
confidently wrong scheduling decisions the moment a node commits again — and that failure is silent.

---

## EPIC-07-S31 — The PID-reuse guard: a live PID that is not our process

**Verifies:** KAR-07.8 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Never kill a stranger

  Scenario: A live PID whose start time does not match
    Given a persisted row for node n1 with pid P and procStartTime T
    And the process at pid P is now an unrelated process with start time T' where T' != T
    When the reaper runs at boot
    Then no signal is sent to pid P or to -P
    And a "workspace.pid_recycled" event is emitted carrying { pid: P, recorded: T, observed: T' }
    And the row is marked terminal

  Scenario: The worktree is still cleaned up
    Then n1's worktree is unlocked
    And it is pruned or removed with "remove -f -f"
    And the run is not left holding a lock forever

  Scenario: Bare liveness is never used as the check
    When packages/workspace and packages/proc are grepped
    Then no call site uses process.kill(pid, 0) as an orphan-liveness check
    And every liveness decision reads the recorded process start time

  Scenario: A dead PID is handled without an error
    Given the process at pid P no longer exists at all
    When the reaper runs
    Then reading the start time yields "not found" rather than throwing
    And the row is marked terminal and the worktree cleaned up
```

**Notes:** _"PIDs are recycled, and killing a stranger's process because you reused a number is an
unrecoverable class of bug."_ The grep assertion is deliberate — `kill(pid, 0)` is the obvious,
idiomatic, wrong answer, and it will be reached for by anyone who has not read this scenario.
Recycling is most likely after exactly the events this code exists to survive: a long laptop suspend
or a machine restart.

---

## EPIC-07-S32 — Prunable worktrees, and the locked one with a live owner that must be left alone

**Verifies:** KAR-07.8 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Prune the dead, never the living

  Scenario: A directory removed behind git's back
    Given a worktree at "<path>" that was unlocked and then "rm -rf"'d
    When "git worktree list --porcelain -z" runs
    Then the entry is present with a "prunable" record
    And ".git/worktrees/<name>/index" has not been touched for more than two weeks
    When "git worktree prune -v --expire 2.weeks.ago" runs
    Then its output contains "Removing worktrees/<name>: gitdir file points to non-existent location"
    And the entry is gone from the list
    And the "worktrees" projection row is dropped

  Scenario: The same entry, orphaned an hour ago, is deliberately left listed
    Given the same prunable entry, created minutes ago
    When "git worktree prune -v --expire 2.weeks.ago" runs
    Then it removes nothing, because the expiry is measured against that entry's own age
    And reclaiming it is "worktree remove -f -f", once its owning process is proven gone

  Scenario: A locked worktree whose owning process is alive survives untouched
    Given a locked worktree whose recorded pid and procStartTime both match a live process
    When the reaper runs at boot
    Then the worktree is not unlocked
    And it is not pruned and not removed
    And the daemon adopts the running process rather than killing it

  Scenario: A locked worktree whose owner is gone is fully removed
    Given a locked worktree whose recorded process is verifiably gone
    When the reaper runs
    Then the worktree is unlocked
    And removed with ["worktree","remove","-f","-f","<path>"]
    And a "workspace.orphan_reaped" event names the run, the node and the path
```

**Notes:** "Adopt rather than kill" in the third scenario is what makes a daemon restart during a
long run survivable — `detached: true` means the agent genuinely outlived DeFlowd, and the correct
response to a healthy orphan is to reattach to its output, not to destroy an hour of work. The
adoption path itself belongs to [EPIC-06](../epics/EPIC-06-orchestrator.md); this scenario asserts
only that the reaper leaves it alone. The worktree sweep states that as a property of the
_worktree_ — "never touched while its owner is verifiably alive" — rather than as a consequence of
what the process reaper decided a moment earlier, so it stays true when a kill does not take and
when EPIC-06's adoption arrives.

**Amended 2026-08-06 (KAR-07.8), measured against real git 2.50.1.** The first scenario originally
asserted that `prune -v --expire 2.weeks.ago` removes a freshly `rm -rf`'d entry. It does not:
`--expire` **narrows** prune rather than widening it — bare `prune` uses `TIME_MAX`, and an expiry
restricts removal to entries whose `.git/worktrees/<name>/index` has not been touched since. The
scenario now states that precondition and a second one pins the behaviour it replaced, because that
is what makes `remove -f -f` the reaper's actual instrument rather than an optimisation. It also
said `stdout`; `prune -v` writes to `stderr`. See
[09-workspace-and-safety §4.5](../../09-workspace-and-safety.md).

---

**Related:** [EPIC-07](../epics/EPIC-07-workspace-isolation.md) · [Board](../board.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md) ·
[EPIC-08 flows](./EPIC-08-safety-model-flows.md)

[← Back to the delivery plan](../README.md)
