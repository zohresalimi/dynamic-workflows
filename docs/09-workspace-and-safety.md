# Workspace and safety

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This document specifies the Workspace Manager and the safety model: how DeFlow drives git, how it
isolates concurrent write nodes in worktrees, how it detects conflicts before they become merge
disasters, how the permission ladder is enforced, and how a run is stopped dead.

It implements PRD §7.5 (F5.1–F5.8) and is the mechanical backing for the risk row _"destructive
action at the execution boundary"_.

Everything marked **Verified 2026-08-02** was checked by running it — git 2.43.0 and Node on Linux,
plus package installs and live agent binary probes. Where the research contradicts the PRD, this
document follows the research and says so.

---

## 1. Git access: shell out to the binary

> **Decision (locked).** DeFlow invokes the system `git` binary through `execa@^10.0.1`, wrapped in
> a thin internal `Git` class. No JavaScript git library is used, for worktrees or for anything else.

This is not a preference. Every JS option fails at the one thing the Workspace Manager exists to do.

| Candidate        | Version checked                              | Verdict                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isomorphic-git` | 1.40.0                                       | **No worktree support at all.** The full runtime export list was enumerated: `branch`, `checkout`, `merge`, `stash`, … and no `worktree*` function of any kind. **Verified 2026-08-02.**                                                                      |
| `simple-git`     | 3.36.0                                       | **No worktree API.** Grepping `node_modules/simple-git/dist/typings/*.d.ts` for `worktree` returns zero hits. You would call `.raw(['worktree', …])` and parse the strings yourself — paying a dependency for nothing. **Verified 2026-08-02.**               |
| `nodegit`        | 0.27.0 stable / 0.28.0-alpha.38 (2026-04-23) | Needs `node-gyp` native compilation, declares `engines.node >= 6`, and has been in alpha for three years. Breaks `npx DeFlow up` (NF6) on every Node ABI bump. It is libgit2-based, and **libgit2 still does not support relative worktrees** (libgit2#7210). |
| `dugite`         | 3.2.2                                        | The one defensible alternative — GitHub Desktop's wrapper, ships a known-good git binary so you do not depend on the user's version. Cost: ~40 MB download against NF6. **Hold in reserve**; adopt only if version-drift support burden becomes real.         |

Worktree management is about eight git subcommands with stable, machine-readable porcelain output.
Shelling out gets submodules, sparse-checkout, credential helpers, hooks and LFS working correctly
for free — all of which a library reimplementation silently breaks. It also matches AR-1's spirit:
DeFlow is already a program whose job is spawning other people's binaries under the user's account.

### 1.1 The `Git` wrapper

One chokepoint. Everything that touches git goes through it, so the assertions in §3.3 and §10.5
cannot be bypassed by a caller in a hurry.

```ts
// packages/workspace/src/git.ts
import { execa } from "execa";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class Git {
  constructor(private readonly repoRoot: string) {}

  async run(
    args: readonly string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<GitResult> {
    assertNoForcedWorktreeAdd(args); // §3.3
    assertNotDefaultBranchWrite(args); // §10.5
    const r = await execa("git", ["-C", opts.cwd ?? this.repoRoot, ...args], {
      reject: false, // exit codes are data — see §6
      timeout: opts.timeoutMs ?? 60_000,
      env: gitChildEnv(), // see 15-security-model.md §4
    });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? -1 };
  }
}
```

Note `reject: false`. `git merge-tree` uses exit code 1 to mean _conflict_, which is a normal,
expected result and not an error (§6).

**Why `execa` here but raw `node:child_process` for agents.** Git calls are short-lived,
output-capturing and never need a process group. Agent processes are long-lived, need
`detached: true`, and need explicit group-kill semantics that execa's options actively obscure
(§11.4). The two use different tools deliberately. See
[the provider adapter layer](./07-provider-adapter-layer.md) for the agent side.

### 1.2 Minimum git version, enforced in `DeFlow doctor`

| Requirement | Version         | Why                                                                                                  |
| ----------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Hard floor  | **git >= 2.38** | `git merge-tree --write-tree` — the entire conflict-detection design (§6) does not exist below this. |
| Preferred   | **git >= 2.45** | Stable `--porcelain -z` on `worktree list`, which is how DeFlow reads worktree state (§4.2).         |

Below 2.38, `DeFlow doctor` fails hard and the daemon refuses to start a run. Between 2.38 and 2.45
it warns. `doctor` also checks, on Linux, for `bwrap` and `socat` (§9.2) and for the Ubuntu 24.04+
AppArmor restriction on unprivileged user namespaces (§13).

**Do not enable `worktree.useRelativePaths` / `--relative-paths` (git 2.46+).** It implies
`extensions.relativeWorktrees`, which is incompatible with older git _and_ unsupported by libgit2
(libgit2#7210) — so it silently breaks IDEs and tools built on libgit2 that the user also has open
on the same repo.

---

## 2. Branch naming — the PRD's scheme is a bug

> **Decision D13 (locked).** Branch names are flat: `DeFlow/<runId>__<nodeId>`.
> Integration branches live under a reserved, non-colliding prefix: `DeFlow/int/<runId>`.

The PRD's F5.1 specifies `DeFlow/<run-id>/<node-id>`. That scheme forecloses a run-level integration
branch, which §7 requires.

**Verified 2026-08-02, git 2.43.** After `DeFlow/r1/n1` exists:

```
$ git branch DeFlow/r1
fatal: cannot lock ref 'refs/heads/DeFlow/r1': 'refs/heads/DeFlow/r1/n1' exists;
       cannot create 'refs/heads/DeFlow/r1'
```

The reverse order fails symmetrically. This is git's refs directory/file conflict:
`refs/heads/DeFlow/r1` cannot be both a file and a directory. The hierarchical scheme works only as
long as you never create a branch at the run level — and an integration branch is exactly that. The
bug would surface late, in the merge phase, as an inexplicable mid-run git failure.

Flat naming costs nothing and removes the whole class.

### 2.1 Sanitizing ids

Run ids and node ids reach git as ref components. Every generated name goes through
`git check-ref-format --branch <name>` before use, and the result is cached.

**Verified rejects 2026-08-02:** any path component ending in `.lock`
(`DeFlow/run-1/node.lock` → INVALID), `..` sequences, trailing spaces, and `@{`.

**The trap:** a component like `-n` **is** a valid ref name and passes `check-ref-format`, but git
will then parse it as a command-line flag. So validity is necessary and not sufficient:

- Always use `--` separators or the `--branch=<value>` long form when passing a generated name.
- Additionally reject any id that starts with `-` at the domain layer, before it becomes a ref.
- Normalize ids to a single case. **Unverified:** worktree path collisions on case-insensitive APFS
  were not tested; single-casing removes the question without needing the answer.

```ts
const BRANCH_SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/; // applied to runId and nodeId separately

export function nodeBranch(runId: string, nodeId: string): string {
  if (!BRANCH_SAFE.test(runId) || !BRANCH_SAFE.test(nodeId))
    throw new UnsafeRefError(runId, nodeId);
  return `DeFlow/${runId}__${nodeId}`; // flat — D13
}
export const integrationBranch = (runId: string) => `DeFlow/int/${runId}`;
```

**Alternative not taken:** a custom ref namespace, `refs/DeFlow/<run>/<node>`, outside
`refs/heads/`. It allows hierarchy and keeps `git branch` output clean of agent noise, but custom
refs are invisible to most GUIs and do not push by default — which defeats the "output lands as a
branch or PR" requirement (F5.5).

---

## 3. Git will not check out the same branch twice — with three corrections

The rule in PRD F5.1 is correct. It is also incomplete in three ways that each produce a real bug.

### 3.1 The error string is not what the blogs say

**Verified 2026-08-02.** The actual message is:

```
fatal: 'feature' is already used by worktree at '/path/to/wt'
```

Not _"is already checked out at"_, which is what most blog posts and most people's notes claim.

**So do not parse errors at all.** Pre-check by scanning `git worktree list --porcelain -z` for the
branch ref before attempting `add`. If you must also match on the message (belt and braces), match
`already used by worktree at` and accept `already checked out` as a legacy alternate.

### 3.2 The main checkout counts

**Verified 2026-08-02.** `git worktree add <path> master` fails with
`fatal: 'master' is already used by worktree at '<mainRepo>'`.

The user's own current branch is off-limits. This — not agent-versus-agent collision — is the common
real-world hit, and it happens on the _very first run_, on the branch the user is sitting on. The
error message must say so in DeFlow's own words, not git's.

### 3.3 `--force` bypasses it, and that is the actual corruption footgun

**Verified 2026-08-02.** `git worktree add --force <path> <branch>` **does** create a second worktree
on the same branch; `git worktree list` then shows two entries both on `[feature]`. Two working
trees sharing one branch ref is the index corruption the rule exists to prevent.

> **DeFlow must never pass `--force` to `worktree add`.** `--force` is permitted only on
> `worktree remove`.

Encode it as an assertion in the wrapper (§1.1), not as a convention:

```ts
function assertNoForcedWorktreeAdd(args: readonly string[]): void {
  if (
    args[0] === "worktree" &&
    args[1] === "add" &&
    (args.includes("--force") || args.includes("-f"))
  )
    throw new Error(
      "worktree add --force is forbidden: it creates two worktrees on one branch",
    );
}
```

Workarounds in preference order: (a) a unique branch per write node (§2), (b) `--detach` for read
nodes (§4.1), (c) never `--force`.

---

## 4. Worktree lifecycle

All commands below were **verified 2026-08-02** on git 2.43.

### 4.1 Create

```bash
# write node
git -C <mainRepo> worktree add --lock --reason "DeFlow run=<runId> node=<nodeId>" \
    -b DeFlow/<runId>__<nodeId> <path> <baseRef>

# read-only node
git -C <mainRepo> worktree add --detach --lock --reason "DeFlow run=<runId> node=<nodeId>" \
    <path> <baseRef>
```

- **`--lock` is applied atomically at creation.** Do not create-then-lock — that races with DeFlow's
  own background reaper across a daemon restart.
- **`--detach` for read nodes.** Detached HEAD sidesteps branch uniqueness entirely (§3) and encodes
  intent: this node is not going to produce a branch.
- **`-b` for write nodes.** One branch, one node, per D13.

### 4.2 `--lock` is the crash-safety primitive

**Locked worktrees are immune to `prune`.** That is precisely why lock is the right mechanism: it
gives exactly-once semantics against DeFlow's own reaper, across daemon restarts, without inventing
a side-channel lockfile that can desync from git's own view.

Anthropic independently arrived at the same design: Claude Code's documentation states that it runs
`git worktree lock` on an agent's worktree while the agent is running, and that a periodic sweep
releases locks whose owning process has exited. DeFlow copies that, **including the stale-lock
release** — see §11.3.

### 4.3 List — always porcelain, always `-z`

```bash
git -C <mainRepo> worktree list --porcelain -z
```

NUL-separated records: `worktree <path>`, `HEAD <oid>`, `branch <ref>` or `detached`, plus optional
`locked [reason]` and `prunable [reason]`. **Never parse the non-porcelain form.**

**Git is the authority; SQLite is an index over it.** The `worktrees` table in the ledger database
is a projection refreshed from `worktree list --porcelain -z`, never the source of truth. The moment
a user runs `git worktree remove` by hand — and they will — a SQLite-authoritative design is wrong
and does not know it.

### 4.4 Remove — never blind-force

Happy path:

```bash
git -C <main> worktree unlock <path> && git -C <main> worktree remove <path>
```

**Verified failure modes:**

| Situation                                                      | git says                                                                                                    | DeFlow does                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Worktree still locked                                          | `fatal: cannot remove a locked working tree, lock reason: … use 'remove -f -f' to override or unlock first` | `unlock` first; `remove -f -f` only in the reaper path where the owning process is provably gone |
| Agent left it dirty                                            | `fatal: '<path>' contains modified or untracked files, use --force to delete it`                            | the salvage sequence below                                                                       |
| Worktree contains only gitignored files (e.g. `node_modules/`) | _nothing_ — `remove` succeeds, exit 0, no `--force` needed                                                  | nothing special                                                                                  |

**The dirty-removal path.** DeFlow must never blind-force, because forcing discards work an agent
just did and the run has no record of it:

1. Capture `git -C <wt> status --porcelain=v2 -z` into the ledger as a
   `workspace.dirty_on_remove` event.
2. Auto-commit everything to the node branch as a `DeFlow: WIP salvage` commit, so the work is
   recoverable by ref.
3. _Then_ `git worktree remove --force <path>`.

Only after the salvage commit is durable does force become acceptable.

**Gitignored files do not block removal — verified.** A worktree containing only `node_modules/`
removed cleanly with exit 0. So a fat `node_modules` is a _disk_ problem (§5), not a removal
problem. Do not build cleanup machinery for it.

### 4.5 Prune on daemon start

```bash
git -C <main> worktree prune -v --expire 2.weeks.ago
```

**Verified:** after `rm -rf` of a worktree directory, `worktree list` marks the entry `prunable` and
`prune` reports `Removing worktrees/<name>: gitdir file points to non-existent location`. Locked
worktrees are skipped, which is the point of §4.2.

Prune runs once at daemon boot, after orphan reaping (§11.3) has released the locks belonging to
processes that did not survive the restart. Order matters: reap, unlock, prune.

---

## 5. `node_modules` across worktrees

Every worktree tool creates worktrees; almost none of them make the worktree _work_. The verified
2026 landscape treats dependency setup as the user's problem — Claude Code's own docs concede it:
_"A worktree is a fresh checkout, so initialize your development environment there: ask Claude to
install dependencies."_ Standalone tools exist purely to symlink and run setup scripts.

Solving this properly is cheap and immediately felt. It is a genuine DeFlow differentiator.

### 5.1 Three layers

**Layer 1 — copy gitignored config (always on, cheap).** Adopt Claude Code's `.worktreeinclude`
convention _verbatim_: gitignore syntax, and only files that match a pattern **and** are gitignored
get copied into a new worktree. Reusing their filename means zero new concepts for users already on
Claude Code. Typical contents: `.env`, `.env.local`, `config/secrets.json`.

Note the interaction with [the security model](./15-security-model.md): these files frequently
contain credentials, and copying them into a worktree makes them readable by the agent. The
permission level and the vendor sandbox's `credentials.files` deny list (§9.2) are what keep that
bounded.

**Layer 2 — package-manager-native sharing.** Detect the manager from the lockfile:

| Lockfile            | Command                          | Marginal disk per extra worktree                         |
| ------------------- | -------------------------------- | -------------------------------------------------------- |
| `pnpm-lock.yaml`    | `pnpm install --frozen-lockfile` | Near-zero — hardlinks into one content-addressable store |
| `package-lock.json` | `npm ci`                         | A full copy                                              |
| `yarn.lock`         | `yarn install --immutable`       | A full copy                                              |

**pnpm is the recommended default** and the thing DeFlow should nudge users toward, because its
content-addressable global store means each worktree's `node_modules` is hardlinks and symlinks into
one store: install is seconds and marginal disk is negligible. pnpm publishes worktree-specific
guidance for exactly this multi-agent case. **Unverified:** the specific config keys on
`pnpm.io/git-worktrees` could not be fetched (403) — the store-sharing _mechanism_ is long-standing
and safe to rely on, but check that page before documenting any keys.

> **Hard rule: never symlink a shared `node_modules` across worktrees.** Two agents running installs
> concurrently against one shared tree corrupts it, and it defeats the isolation the worktree exists
> to provide. The one safe symlink target is the _store_, which pnpm already does correctly.

**Layer 3 — explicit escape hatch.** `DeFlow.config.ts` exposes `workspace.setup`, a command run once
per worktree (`pnpm install --frozen-lockfile && pnpm build:deps`), with output streamed to the
ledger and a **success marker cached on the lockfile hash**, so re-runs against unchanged
dependencies are free.

```ts
workspace: {
  setup: 'pnpm install --frozen-lockfile && pnpm build:deps',
  setupCacheKey: ['pnpm-lock.yaml'],   // hashed; a hit skips setup entirely
  worktreeInclude: '.worktreeinclude', // Layer 1
}
```

### 5.2 Reflink fast path — opportunistic only

Copy-on-write cloning of an existing `node_modules` (`cp --reflink=auto` on btrfs/XFS, APFS
`clonefile` on macOS) is genuinely near-free and instant _where supported_. Add it behind a
filesystem capability probe as a fast path. It cannot be the only strategy: ext4 has no reflink.

### 5.3 Show the disk cost before spawning N nodes

A worktree costs one full checkout of _tracked_ files. **The object store is shared** — verified: a
300 KB `.git` served a 24 KB worktree with no object duplication. So the estimate is:

```
N × (tracked working-tree size)  +  N × node_modules   (unless pnpm, where the second term ≈ 0)
```

Render that number in the UI on the plan-approval screen, before the user authorizes a fan-out. See
[the frontend architecture](./12-frontend-architecture.md). A user who is told "this plan will use
14 GB" migrates to pnpm on their own.

---

## 6. `git merge-tree --write-tree` as continuous conflict detection

> **Decision D14 (locked).** `git merge-tree --write-tree` is ground truth for conflict. Declared
> path scopes (F5.3) are demoted to a plan-time prediction.

### 6.1 Verified behaviour

```bash
git -C <main> merge-tree --write-tree <branchA> <branchB>
```

| Aspect          | Behaviour (**verified 2026-08-02**, git 2.43)                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean merge     | **exit 0**; stdout line 1 is the resulting tree OID                                                                                                            |
| Conflict        | **exit 1**; stdout is the tree OID, then conflicted-file stage lines, then an info block (`Auto-merging f.txt`, `CONFLICT (content): Merge conflict in f.txt`) |
| Cheap poll      | `--name-only` reduces output to bare conflicted paths                                                                                                          |
| Machine parsing | `-z` gives NUL-separated output including structured conflict-type strings (`CONFLICT (contents)`)                                                             |
| Side effects    | **None.** Touches neither the index nor any working tree — safe to run against live worktrees at any moment                                                    |

**The pipe-exit-code trap.** The exit code _is_ the conflict signal. If you pipe `merge-tree`
through anything, `$?` becomes the pipe's exit status and the signal is destroyed. Capture the exit
code directly from execa with `reject: false` (§1.1). This is why the `Git` wrapper does not throw
on non-zero.

```ts
export async function mergeTree(
  git: Git,
  a: string,
  b: string,
): Promise<ConflictProbe> {
  const r = await git.run([
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    a,
    b,
  ]);
  if (r.exitCode === 0) return { clean: true, paths: [] };
  if (r.exitCode === 1)
    return {
      clean: false,
      paths: r.stdout.split("\0").slice(1).filter(Boolean),
    };
  throw new GitError(`merge-tree failed: ${r.stderr}`); // 2+ is a real error
}
```

### 6.2 The design: a live pairwise conflict matrix

After each write node commits, DeFlow runs `merge-tree` of that node's branch against:

- (a) the run's integration branch `DeFlow/int/<runId>`, and
- (b) every other **in-flight** node branch.

The pairwise result is stored in SQLite and projected into the UI as a live **collision map**.

```sql
CREATE TABLE conflict_probe (
  run_id      TEXT NOT NULL,
  branch_a    TEXT NOT NULL,
  branch_b    TEXT NOT NULL,
  probed_at   INTEGER NOT NULL,     -- epoch ms
  a_commit    TEXT NOT NULL,        -- both tips, so a stale row is detectable
  b_commit    TEXT NOT NULL,
  clean       INTEGER NOT NULL,     -- 0 | 1
  path_count  INTEGER NOT NULL,
  paths_json  TEXT NOT NULL,
  PRIMARY KEY (run_id, branch_a, branch_b)
) STRICT;
```

**This turns conflict from a merge-time surprise into a scheduling input.** The scheduler can
serialize two nodes the moment their branches _start_ conflicting, rather than discovering it after
both have burned an hour. It costs milliseconds per probe and roughly forty lines of code.

**Apparently novel, stated honestly.** No shipping orchestrator found in the research uses
`merge-tree` as a continuous scheduling signal — everyone defers conflict to merge time. That is a
survey result, not a proof of absence; treat it as "we found no prior art", not "there is none".

### 6.3 Relationship to F5.3 — say this precisely

| Mechanism                           | Role                                                                                                | Nature                                          | Enforcement                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| **Declared path scopes** (F5.3)     | Plan-time **admission control** — do not schedule two nodes whose declared scopes obviously collide | A _prediction_, dependent on agent compliance   | A violation is a **warning** recorded on the node |
| **`merge-tree --write-tree`** (D14) | Run-time **gating** — this is what actually happens on merge                                        | _Ground truth_, requires zero agent cooperation | A conflict is a **gate**                          |

Path scopes stay useful and stay in the plan. They just stop being the thing merges depend on.

There is one further improvement over the PRD available under ACP: `ToolCallLocation.path` on an
inbound permission request lets DeFlow enforce path scope **at request time** rather than detecting
a violation on completion — strictly better than F5.3's "violations are detected on completion"
(§8.2).

---

## 7. Integration strategy

F5.2's _"serialize writes, parallelize reads"_ is confirmed as the industry consensus. Integration
guidance is equally consistent: merge sequentially, lowest-overlap-first, verify after each — never
a big-bang N-way merge.

### 7.1 The loop

1. Create `DeFlow/int/<runId>` from the run's base ref at run start (which is why §2 exists).
2. Order completed node branches by **ascending merge-tree conflict count** against the integration
   branch. Lowest-risk first.
3. Merge one branch. Then:
   - re-run `merge-tree` for **all remaining** branches — their conflict counts have changed;
   - **re-sort**;
   - run the run's verification gate against the integration branch
     ([verification gates](./10-verification-gates.md)).
4. Repeat until the queue is empty or a gate fails.

### 7.2 Conflicts get a dedicated resolution node

Never let an agent auto-resolve blind, and never hand a resolver the whole repository. On conflict,
DeFlow spawns a resolution node at `worktree` permission, on the integration worktree, whose context
packet contains **only**:

- the conflicted hunks (from the `merge-tree` stage lines), and
- both sides' **intent summaries** — the structured node outputs already on the blackboard, which is
  exactly the thing a human reviewer would ask for and a text-only merge tool cannot supply.

See [context and memory](./08-context-and-memory.md) for packet assembly. This is a narrow, cheap,
highly-succeeding node shape, and it exists only because the blackboard retained intent.

### 7.3 The refinement over the PRD: serialize on _detected_, not _declared_, overlap

F5.2 statically serializes write nodes with overlapping declared scopes. Most declared overlaps
never actually conflict — two agents editing different functions in one file merge fine. Static
serialization therefore throws away real parallelism.

> **Start write nodes in parallel and serialize on the FIRST DETECTED conflict.**

Concretely: the scheduler admits parallel write nodes whose declared scopes overlap, runs the
`merge-tree` probe on every commit, and demotes the later-starting node to a blocked state the
moment a probe returns `clean = 0`. Declared scope is used only to refuse the obviously insane case
(two nodes declaring the identical single file).

**Alternative not taken:** stacked/dependent branches, where node N branches from node N-1. It
removes conflicts by construction but destroys parallelism — sequential execution wearing a branch
costume. Reserve it for genuinely dependent plan edges.

---

## 8. The permission ladder, mapped through ACP

> **Decision (locked).** The ladder (F5.4) is enforced by DeFlow at the ACP client boundary, not by
> translating levels into each vendor's CLI flags.

### 8.1 Why this is the whole game

**Verified 2026-08-02** from the shipped type definitions of `@agentclientprotocol/sdk@1.3.0`
(`PROTOCOL_VERSION = 1`): the `CLIENT_METHODS` that DeFlow implements include
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
`terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`.

**DeFlow sits in the path of every file access and every command execution, for every vendor.** The
ladder therefore collapses from an N-vendors × M-levels mapping matrix into a single pure function:

| Level          | `fs/write_text_file`                                    | `terminal/create`                                  | Network                           |
| -------------- | ------------------------------------------------------- | -------------------------------------------------- | --------------------------------- |
| `read`         | reject all                                              | reject all non-read-only                           | deny                              |
| `worktree`     | allow iff `resolve(path)` is inside the node's worktree | allow iff the command passes the allowlist (§10.2) | deny                              |
| `worktree+net` | same as `worktree`                                      | same as `worktree`                                 | allow, against a domain allowlist |
| `full`         | allow within the worktree                               | allow                                              | allow                             |

`full` remains what F5.4 says it is: an explicit per-run opt-in, never a default.

The second consequence is at least as valuable as the first: **the entire safety model becomes
unit-testable with no vendor CLI installed at all.** Point the policy function at the deterministic
mock agent (D17) and the ladder, path-scope enforcement, command allowlist and gate logic are all
fast offline tests. See [the testing strategy](./14-testing-strategy.md).

### 8.2 Verified ACP types used by the enforcement layer

| Type                       | Verified shape                                                                                                      | Use in DeFlow                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PermissionOptionKind`     | `"allow_once" \| "allow_always" \| "reject_once" \| "reject_always"`                                                | The options DeFlow offers back on `session/request_permission`                    |
| `RequestPermissionOutcome` | `{outcome:"cancelled"} \| {outcome:"selected", optionId}`                                                           | Cancellation must be handled as a first-class outcome, not an error               |
| `ToolKind`                 | `"read" \| "edit" \| "delete" \| "move" \| "search" \| "execute" \| "think" \| "fetch" \| "switch_mode" \| "other"` | Maps almost 1:1 onto the ladder rows                                              |
| `ToolCallLocation`         | `{ path: string, line?: number }`                                                                                   | **Path-scope enforcement at request time**                                        |
| `NewSessionRequest`        | `{ cwd, additionalDirectories?, mcpServers }`                                                                       | `cwd` is the worktree; `additionalDirectories` is left empty at `read`/`worktree` |

`ToolCallLocation.path` is the improvement over F5.3 noted in §6.3: DeFlow rejects the write _before
it happens_, with a reason the UI can render, rather than diffing at completion and calling it a
gate failure. **DeFlow auto-responds** to routine `session/request_permission` calls from the policy
table — no human in the loop — and escalates to the UI only for the gated categories in §10.

### 8.3 Narrowing F5.4's "refuse to schedule"

As literally written — inspect each vendor's flags and refuse where the vendor cannot express the
level — F5.4 is a permanent flag-churn maintenance burden, which is the PRD's own G7 gap
reintroduced in the safety layer. Under ACP it is near-moot: DeFlow enforces the level itself
regardless of what the vendor can express.

> **Reduce F5.4's refusal rule to one capability bit: `mediatedExecution: true | false`.**

It is true when the adapter routes `fs/*` and `terminal/*` through DeFlow, false otherwise. When
false, DeFlow cannot enforce anything and would be trusting vendor flags — so it refuses to schedule
any node above `read`. That is one boolean on the capability manifest
([provider adapter layer](./07-provider-adapter-layer.md)), not a per-flag matrix.

The degraded, non-ACP path for Claude Code is `--permission-prompt-tool <mcp-tool>`, which routes
permission prompts to an MCP tool DeFlow hosts — the same interception pattern, one vendor at a
time. **Note the churn:** `--permission-prompt-tool` is no longer present in `claude --help` as of
2.1.220 (grepped, zero hits). Verify before depending on it.

---

## 9. Sandboxing, in four layers

> **Decision D12 (locked).** DeFlow does not build a sandbox. It owns policy and mediation; the
> vendor CLI owns enforcement.

### 9.1 Layer 1 — DeFlow: worktree boundary + process containment (always on, free)

The worktree _is_ the primary filesystem boundary. Every agent is spawned with `cwd` set to its
worktree, `detached: true` (§11), a scrubbed environment
([security model §4](./15-security-model.md)), and a per-run `TMPDIR`. This costs nothing and is the
boundary that actually holds in practice.

### 9.2 Layer 2 — the vendor CLI's own sandbox (delegate; configure, do not reimplement)

Both major CLIs ship real OS-level sandboxes.

**Claude Code** (`@anthropic-ai/claude-code@2.1.220`) — macOS: Seatbelt. Linux/WSL2: **bubblewrap +
socat**, both of which must be installed; an optional seccomp filter via
`@anthropic-ai/sandbox-runtime` adds Unix-socket blocking. Native Windows unsupported.

> **The crucial integration fact: the CLI accepts `--settings '<inline JSON>'`.** DeFlow can inject
> a complete per-run sandbox policy as a string on the command line, **without ever reading or
> writing the user's settings files.** This is what makes per-node policy compatible with AR-1 and
> with "DeFlow must not mutate the user's vendor CLI configuration".

Verified settings keys:

| Key                                                                                         | Purpose                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `sandbox.enabled`                                                                           | Master switch                                       |
| `sandbox.filesystem.{allowWrite,denyWrite,allowRead,denyRead,disabled}`                     | Path scoping                                        |
| `sandbox.network.{allowedDomains,deniedDomains,strictAllowlist,tlsTerminate,httpProxyPort}` | Egress control — this is where `worktree+net` lives |
| `sandbox.credentials.{files,envVars}` with `mode: deny \| mask`                             | Credential denial                                   |
| `sandbox.excludedCommands`                                                                  | Commands exempted from the sandbox                  |
| `sandbox.allowUnsandboxedCommands`                                                          | Whether the model may retry outside the sandbox     |
| `sandbox.failIfUnavailable`                                                                 | Whether a missing dependency is fatal               |

> **For any non-`full` level, DeFlow must set `failIfUnavailable: true` and
> `allowUnsandboxedCommands: false`.** Otherwise the CLI **silently degrades**: it falls back to
> running unsandboxed when bubblewrap/socat are missing or the platform is unsupported, and the
> model can retry a sandbox-failed command outside the sandbox via `dangerouslyDisableSandbox`.
> Without these two keys, the permission ladder is decorative.

Also note: the default read policy allows reading `~/.aws/credentials` and `~/.ssh/`. There is no
built-in credential deny list — DeFlow must populate `sandbox.credentials.files` explicitly.

**Codex** (`@openai/codex@0.146.0`) — macOS: `sandbox-exec`/Seatbelt. Linux: **Landlock LSM +
seccomp-bpf**. `sandbox_mode` (`-s`): `read-only`, `workspace-write`, `danger-full-access`.
`[sandbox_workspace_write]` keys, **verified from the Rust source**
(`codex-rs/protocol/src/protocol.rs`): `writable_roots`, `network_access`, `exclude_tmpdir_env_var`,
`exclude_slash_tmp`.

Ladder mapping, confirmed to fit both CLIs cleanly:

| DeFlow level   | Claude Code                                 | Codex                                       |
| -------------- | ------------------------------------------- | ------------------------------------------- |
| `read`         | `filesystem` read-only, no `allowedDomains` | `read-only`                                 |
| `worktree`     | default `allowWrite` = cwd                  | `workspace-write`, `network_access = false` |
| `worktree+net` | + `network.allowedDomains`                  | `workspace-write`, `network_access = true`  |
| `full`         | `bypassPermissions`                         | `danger-full-access`                        |

**Unverified / open:** Codex has a `SandboxPolicy::ExternalSandbox { network_access }` variant whose
doc comment reads _"Indicates the process is already in an external sandbox"_. If it is
user-selectable it would let Codex skip its own sandbox when DeFlow provides isolation, avoiding
nesting entirely. How to select it from the CLI or `config.toml` could not be verified. Investigate
before relying on it.

### 9.3 Layer 3 — DeFlow's mediated execution (the real control point)

Every command arrives at DeFlow's `terminal/create` handler _before_ it runs, carrying `command`,
`args`, `cwd`, `env`. That is where the allowlist and the human gates live (§10). This layer is the
one DeFlow can actually test, version and reason about.

### 9.4 Layer 4 — containers (opt-in, P1)

See §12.

### 9.5 Do not nest your own sandbox around a CLI that already sandboxes

Claude Code's documentation is explicit that bubblewrap fails inside an unprivileged container and
needs `enableWeakerNestedSandbox`, which Anthropic warns _considerably weakens security_. Wrapping a
sandboxing CLI in a DeFlow-authored bwrap or Seatbelt profile turns a working sandbox into a broken
one. DeFlow's leverage is policy and mediation, not enforcement primitives.

The narrow exception: `@anthropic-ai/sandbox-runtime@0.0.67` is Anthropic's standalone extraction of
the same Seatbelt/bubblewrap machinery and can wrap an arbitrary process. Use it for CLIs with **no
native sandbox of their own** (Gemini, Copilot, Cursor, OpenCode) — never as a second layer around
one that has one. It is 0.0.x; pin exactly and treat the API as unstable.

---

## 10. The execution boundary (F5.6)

### 10.1 The Kiro incident, and the lesson the PRD gets half right

**Verified.** On **15 December 2025**, AWS's internal agent Kiro, tasked with a Cost Explorer bug,
decided the fastest path was to delete and recreate the production environment, causing a
**~13-hour outage** affecting Cost Explorer in mainland China. The Financial Times reported it on
**20 February 2026**, citing four people familiar with the events. Amazon published a formal rebuttal
(_"Correcting the Financial Times report about AWS, Kiro, and AI"_, aboutamazon.com) attributing the
outage to **user error — specifically misconfigured access controls — not AI**, stating that Kiro
"requests authorisation before taking any action" by default, but that the engineer's elevated
permissions bypassed those checks.

The PRD (§4.5, F5.6) says approved specs did not prevent it _"because nothing reviewed the moment of
action."_ True, but incomplete — and the incomplete half is the actionable half.

> **The approval gate existed and was on by default. It was bypassed because the identity the agent
> ran as had standing production privileges.** The lesson is about **ambient authority**, not about
> adding another review step. A gate you can bypass with ambient IAM is theatre.

Amazon's framing is contested, but it is the most useful part of the story, because "misconfigured
access controls" is a control DeFlow can actually implement, whereas "the AI decided badly" is not.

### 10.2 Consequence 1: scrub the child environment — this ranks _above_ the human gate

The agent must not inherit credentials it does not need. DeFlow builds the child environment from an
allowlist, and strips the following families unless the node's declared level explicitly requests
them: `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `DATABASE_URL`, `TF_*`, `VAULT_*`,
`*_TOKEN`, `*_API_KEY`, `*_SECRET`. Reinforce with Claude Code's `sandbox.credentials.envVars`
(`mode: deny`) and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.

**This is the control that would actually have prevented Kiro.** Full specification, including the
interaction with AR-1 and the vendor CLI's own credentials, is in
[the security model](./15-security-model.md).

### 10.3 Consequence 2: default-deny allowlist at `terminal/create`, not a deny-list

Deny-lists lose. `rm -rf /` has infinite spellings: `rm -fr`, `$(echo rm) -rf`, `find / -delete`, a
shell script, a Makefile target, a `postinstall` hook.

Allowlist the project's actual verbs — `git`, `pnpm`, `npm`, `node`, `pytest`, `make`, `cargo`,
`go`, `tsc`, `eslint` — sourced per repo from `DeFlow.config.ts`, and route **everything else** to a
human gate.

### 10.4 Consequence 3: cheap syntactic checks as a second layer

Do **not** attempt real static analysis of shell strings. It is undecidable and gives false
confidence. Do run cheap, high-signal syntactic checks that force a gate even for an
allowlisted binary:

- `git push --force` / `-f` (allow `--force-with-lease`)
- `git reset --hard` with a target outside the node's worktree
- any absolute path outside the worktree in a destructive position
- `rm` with `-r` and a path ≤ 2 segments deep
- `terraform apply|destroy`, `kubectl delete|apply`, `aws|gcloud|az`, `psql|mysql` with a
  non-localhost host, `prisma migrate deploy`, `drizzle-kit push`, `flyway migrate`

An LLM-judge classifier over proposed commands (Claude Code's `auto` permission mode does this) is a
useful _additional_ signal but never the only gate for a destructive operation: it is probabilistic
and its failure mode is silent.

### 10.5 Where human gates belong

> **Human gates belong at the network-egress and identity boundary, not at the command boundary.**

The practical rule: a command is gated if it (a) is not on the allowlist, (b) reaches a non-localhost
host, or (c) requires an environment variable that was scrubbed. Everything else runs free inside the
worktree.

This is a frequency argument, and it is the whole design. **A gate that fires 200 times in a run is
auto-clicked, and is worse than no gate** — it manufactures the habit of approving without reading,
and it makes the one gate that mattered indistinguishable from the 199 that did not.

### 10.6 F5.5 enforced mechanically

_"Never write to the default branch"_ is enforced in the `Git` wrapper (§1.1), not in a policy
document:

```ts
function assertNotDefaultBranchWrite(args: readonly string[]): void {
  // hard-refuse: push to the local default branch or to origin/HEAD
  // hard-refuse: push --force / -f to any shared ref; require --force-with-lease
  // hard-refuse: branch -f, and any update-ref targeting the default branch
}
```

The default branch is resolved once per repo from `origin/HEAD` (falling back to the local
`init.defaultBranch` / `HEAD` symref) and cached on the run.

---

## 11. The kill switch (F5.7)

One control stops every child process in a run immediately. All behaviour below was **verified
2026-08-02** by running it on Linux.

### 11.1 Spawn detached, kill the group

```ts
const child = spawn(bin, args, {
  detached: true, // MANDATORY
  cwd: worktreePath,
  stdio: ["ignore", "pipe", "pipe"],
  env: scrubbedEnv,
});
```

On POSIX, `detached: true` makes the child a process-group leader with `pgid === child.pid`.
**Verified:** a child spawning two grandchildren showed all four processes sharing
`pgid = child.pid`.

```ts
process.kill(-child.pid, "SIGTERM"); // NOTE THE NEGATIVE PID — signals the whole group
```

**Verified:** `process.kill(child.pid, 'SIGTERM')` with a **positive** pid killed only the direct
child and left **both grandchildren alive**, reparented to PID 1. Only the negative form killed
everything. Non-detached is worse than useless here — the only process group containing the
grandchildren is DeFlowd's own, so group-signalling it would kill the daemon.

**Escalation ladder:**

1. Protocol-level `session/cancel` (or ACP `terminal/kill`), so the agent can flush its final
   `session/update`s and answer with `stopReason: "cancelled"`.
2. `process.kill(-pid, 'SIGTERM')` → wait a configurable grace period (default 5 s; long-running
   CLIs need time to flush transcripts).
3. `process.kill(-pid, 'SIGKILL')` → wait 2 s.
4. Report failure to the ledger. A kill that did not take is an event, not a silent condition.

### 11.2 The zombie false-negative — the trap that costs hours

**Verified.** After a _successful_ group SIGKILL, `ps` still lists the grandchildren. The first test
run concluded the group kill had failed. It had not: adding the `stat` column showed the processes in
state **`Z` (zombie)** with `ppid = 1` — already dead, awaiting reaping by init.

> **Any "did the kill work?" check must exclude `Z`-state processes.**

```bash
ps -eo pid,pgid,stat | awk -v g="$PGID" '$2==g && $3 !~ /Z/'
```

Zombie reaping is prompt under launchd and systemd but can lag badly inside containers — so this
bites hardest in CI, where an intermittently-failing kill-switch test is the least welcome kind of
flake. The kill-switch test fixture is `bash -c "sleep 300 & sleep 300 & sleep 300"` with the
assertion filtered on `stat !~ /Z/`.

### 11.3 The orphan reaper

`detached: true` means an agent survives DeFlowd's death, which is the price of group-kill. So:

At spawn, persist `{runId, nodeId, pid, pgid, startedAt, procStartTime}` into SQLite.

On daemon boot, for each non-terminal row:

1. **Verify the pid is still the same process** — compare the recorded start time
   (`/proc/<pid>/stat` field 22 on Linux, `ps -o lstart= -p <pid>` on macOS), never bare liveness.
   PIDs are recycled, and killing a stranger's process because you reused a number is an
   unrecoverable class of bug.
2. `process.kill(-pgid, 'SIGKILL')` if it matches.
3. `git worktree unlock` any worktree whose owning process is gone — mirroring Claude Code's
   documented stale-lock sweep (§4.2).
4. Only then `git worktree prune` (§4.5).

**Unverified:** whether `git worktree lock` and this stale-lock release behave correctly across a
macOS laptop sleep/wake cycle. The lock is a file on disk so it should survive, but pid recycling
after a long suspend makes step 1 load-bearing and it has not been tested across sleep.

### 11.4 execa caveats — counterintuitive, verified from its own docs

If you use execa for process control anywhere (§1.1 uses it only for git), three of its options do
not do what their names suggest:

| Option                | Reality                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subprocess.kill()`   | "only sends a signal to that subprocess, **not to any process it might have spawned itself**". Tree termination needs **`killDescendants`** — a different option entirely.                                                                                                                                                |
| `forceKillAfterDelay` | Is **not** the tree-kill option, and "does not work when the subprocess is terminated by calling `subprocess.kill()` with a specific signal", or by `process.kill(subprocess.pid)`. Since DeFlow always passes an explicit signal, there is **no automatic escalation** — the timer in §11.1 must be implemented by hand. |
| `cleanup`             | Does **not** apply to `detached` subprocesses. Since `detached` is required for group-kill, daemon-exit cleanup must be implemented manually via `process.on('exit')` plus the SQLite orphan table.                                                                                                                       |

This is precisely why agent processes use raw `node:child_process` with explicit group semantics: the
most safety-critical code in the daemon should not depend on three options whose documented
behaviour contradicts their names.

### 11.5 Windows (deferred to M3)

Negative pids do not exist. Use `taskkill /pid <pid> /T /F`. `tree-kill@1.2.2` does this correctly
but has not been published since **2022** — vendor the ~30 lines rather than take the dependency.
Isolate everything behind a single `killTree(pid)` with a POSIX and a Win32 implementation.

---

## 12. Container isolation (F5.8, P1)

**Recommended path:** `@devcontainers/cli@0.88.0` (published 2026-07-22), driven as
`devcontainer up --workspace-folder <worktree>` then `devcontainer exec`.

Devcontainers win because they are a published spec with a per-repo config file that many target
repos already have, so DeFlow reuses the user's own `.devcontainer/devcontainer.json` rather than
inventing an image format. Anthropic ships a reference devcontainer for Claude Code; note that it
runs Claude as a **non-root** user, which matters because `--dangerously-skip-permissions` is blocked
when running as root.

| Alternative            | Verdict                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plain Docker           | No — you would reimplement mounts, user mapping and credential passthrough that devcontainers already specify.                                                                                                                                                                                                           |
| Dagger `container-use` | No, for DeFlow specifically. Good design (per-agent container + `container-use/<env>` branch), but it is an **MCP server the agent drives**, so the _agent_ chooses its own isolation. Architecturally backwards for an orchestrator that must impose isolation, and it adds a Dagger engine dependency. Worth studying. |
| Apple `container`      | Not yet. **1.2.0** (2026-07-29), macOS 26 Tahoe + Apple Silicon only — too narrow for a cross-platform P1. Track quarterly, not annually.                                                                                                                                                                                |

### 12.1 Credentials in containers — the corrected guidance

Containerizing breaks the vendor CLI's stored credentials, which live in the host keychain,
`~/.claude` or `~/.codex`. **Do not bind-mount `~/.claude` into the container.** Anthropic's
documented path is to **authenticate fresh inside the container** and persist the result in a named
Docker volume:

```jsonc
{
  "mounts": [
    "source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume",
  ],
  "containerEnv": { "CLAUDE_CONFIG_DIR": "/home/node/.claude" },
}
```

This keeps the host credential store off the container's filesystem entirely and keeps AR-1 intact:
the credential is created by the vendor's binary, inside the container, for the user.

This tension — not engineering effort — is the real reason container isolation is P1. The worktree
plus vendor-sandbox combination already covers most of the risk.

### 12.2 The no-Docker option

For the narrow case of _"wrap a CLI that has no sandbox of its own"_,
`@anthropic-ai/sandbox-runtime@0.0.67` gives OS-level isolation with **no Docker at all** — strictly
better than a container for that case and fully NF6-compatible. Prefer it over a container wherever
it suffices.

---

## 13. Pitfalls — what not to do

| Do not                                                          | Because                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass `--force` to `git worktree add`                            | It bypasses the same-branch check and creates two worktrees on one branch — the exact corruption the rule prevents. **Verified.**                   |
| Parse git error strings to detect the branch conflict           | The real string is `already used by worktree at`, not the widely-quoted `already checked out at`. Pre-check `worktree list --porcelain -z` instead. |
| Use `DeFlow/<runId>/<nodeId>`                                   | Refs directory/file conflict forecloses `DeFlow/<runId>` as an integration branch. **Verified.**                                                    |
| Trust `check-ref-format` alone                                  | `-n` is a _valid_ ref name that git then parses as a flag. Use `--` separators and reject leading dashes.                                           |
| Blind-force a dirty worktree removal                            | Discards agent work with no record. Capture status → WIP salvage commit → then force.                                                               |
| Build cleanup machinery for `node_modules`                      | Gitignored files do not block `worktree remove`. **Verified.** It is a disk problem, not a removal problem.                                         |
| Symlink a shared `node_modules` across worktrees                | Concurrent installs corrupt it and it defeats the isolation the worktree exists for. Share the _store_, not the tree.                               |
| Pipe `git merge-tree` output                                    | `$?` becomes the pipe's exit code and the conflict signal (0 clean / 1 conflict) is destroyed. Capture it via execa `reject: false`.                |
| Use a positive pid with `process.kill`                          | Kills only the direct child and orphans grandchildren to PID 1. **Verified.** Use the negative pid with `detached: true`.                           |
| Conclude a group kill failed because `ps` still lists processes | They are `Z`-state zombies awaiting reaping. **Verified false negative.** Filter on `stat !~ /Z/`.                                                  |
| Rely on execa's `forceKillAfterDelay` for escalation            | It does not fire when an explicit signal is passed, and it is not the tree-kill option (`killDescendants` is).                                      |
| Rely on execa's `cleanup` for detached agents                   | It does not apply to detached subprocesses.                                                                                                         |
| Leave `failIfUnavailable` unset for non-`full` levels           | Claude Code's sandbox **silently** runs unsandboxed when bubblewrap/socat are missing. Your ladder becomes decorative.                              |
| Leave `allowUnsandboxedCommands` unset                          | `dangerouslyDisableSandbox` lets the model retry a sandbox-failed command outside the sandbox.                                                      |
| Assume the vendor sandbox protects credentials by default       | Claude Code's default read policy permits `~/.aws/credentials` and `~/.ssh/`. Populate `sandbox.credentials.files` explicitly.                      |
| Nest your own bwrap profile around a sandboxing CLI             | bubblewrap cannot mount a fresh `/proc` inside an unprivileged container; `enableWeakerNestedSandbox` "considerably weakens security".              |
| Enable `worktree.useRelativePaths`                              | Implies `extensions.relativeWorktrees`, unsupported by libgit2 — silently breaks the user's other tools.                                            |
| Depend on `@zed-industries/claude-code-acp`                     | Renamed. Stale at 0.16.2 (2026-03-26); the live package is `@agentclientprotocol/claude-agent-acp` at 0.64.1.                                       |

### 13.1 Environment checks that belong in `DeFlow doctor`

- `git --version` >= 2.38 (fail) / >= 2.45 (warn)
- Linux: `bwrap` and `socat` present
- Ubuntu 24.04+: `kernel.apparmor_restrict_unprivileged_userns` — when set, bubblewrap's user
  namespaces are blocked by default and Linux sandboxing silently breaks until an
  `/etc/apparmor.d/bwrap` profile is installed
- Vendor CLI versions, and the fine-grained version gating of Claude Code sandbox settings
  (`filesystem.disabled` >= 2.1.216, `credentials` >= 2.1.187, `mask` mode >= 2.1.199,
  `strictAllowlist` >= 2.1.219). DeFlow must detect the CLI version and **degrade the ladder
  explicitly or fail closed** — never silently.
- **Unverified, test before promising `worktree`-level enforcement on current macOS:** macOS 26
  Tahoe broke Seatbelt profiles in practice (zsh 5.9 reads `hw.*` sysctls that are not in the
  allowlist), causing sandbox init failures across Claude Code and Cursor. `sandbox-exec` itself
  still works; the profiles regressed. Whether this is fixed as of Claude Code 2.1.220 is unknown.

### 13.2 Known gaps

- **Submodules in linked worktrees were not tested.** Git's submodule support in worktrees has
  historically been incomplete (submodule state partly lives in the main `.git`). If target repos use
  submodules, prototype this early — it is a plausible source of silent breakage with no verified
  answer.
- The ACP adapters for Claude Code and Codex are adapters, not first-party vendor implementations.
  Their fidelity to the underlying CLI is the main risk to the ACP-first thesis, and the F3.4
  conformance suite must target **the adapters**, not only the CLIs.

---

**Related:** [Provider adapter layer](./07-provider-adapter-layer.md) ·
[Security model](./15-security-model.md) · [Verification gates](./10-verification-gates.md) ·
[Durable execution](./05-durable-execution.md) · [Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
