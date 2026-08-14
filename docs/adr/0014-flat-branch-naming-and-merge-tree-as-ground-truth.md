# ADR 0014: Flat branch naming, and `git merge-tree` as ground truth

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

Two findings about git, both verified by running it rather than reading about it, and both of which
contradict the PRD.

**1. The PRD's branch naming scheme is a latent bug.** F5.1 specifies `DeFlow/<run-id>/<node-id>`.
That works right up until you create a branch at the run level — which is exactly what an
integration branch is. **Verified 2026-08-02** on git 2.43:

```
$ git branch DeFlow/r1/n1     # ok
$ git branch DeFlow/r1
fatal: cannot lock ref 'refs/heads/DeFlow/r1': 'refs/heads/DeFlow/r1/n1' exists;
       cannot create 'refs/heads/DeFlow/r1'
```

and symmetrically in the reverse order. This is git's refs directory/file conflict:
`refs/heads/DeFlow/r1` cannot be both a file and a directory. It would surface late — when the
integration step is built — and present as an inexplicable git failure mid-run.

**2. Path-scope declarations are a prediction, not a fact.** F5.3 has a write node declare the paths
it may modify, with violations detected on completion. That is the state of the art in the sense that
it is what everyone writes about, but it is prediction-based and depends on agent compliance, and
agents violate declared scopes routinely.

`git merge-tree --write-tree` is ground truth and costs milliseconds. **Verified 2026-08-02** on git
2.43: **exit 0 = clean**, with the resulting tree OID on stdout line 1; **exit 1 = conflict**, with
the tree OID then conflicted-file stage lines then an info block. `--name-only` reduces output to
bare conflicted paths for a cheap poll; `-z` gives NUL-separated machine-parseable output including
structured conflict-type strings. It reads and writes neither the index nor the working tree, so it
is safe to run against live worktrees at any time. It is a real three-way merge with rename
detection and D/F conflict handling, and it requires zero agent cooperation.

No shipping orchestrator found uses it as a continuous scheduling signal.

## Decision

**Branch naming is flat: `DeFlow/<runId>__<nodeId>`.** Integration branches live under a _different_
prefix segment: `DeFlow/int/<runId>`. Ids are sanitised through `git check-ref-format --branch`
before use — **verified 2026-08-02** that it rejects components ending `.lock`, `..` sequences,
trailing spaces and `@{`. Note that `-n` _is_ a valid component, so a leading-dash node id passes
`check-ref-format` and is then parsed as a flag — always use `--` separators or `--branch=` forms.

**`git merge-tree --write-tree` is the ground truth for conflict detection. Declared path scopes are
demoted to a plan-time prediction.**

- **Plan time**: declared scopes are used for admission control — cheap, and it prevents obviously
  overlapping parallel scheduling.
- **Run time**: after each write node commits, merge-tree that node's branch against (a) the
  integration branch and (b) every other in-flight node branch. Store the pairwise conflict matrix
  in SQLite and render it as a live collision map.
- **A scope violation is a warning. A merge-tree conflict is the gate.**

This turns conflict from a merge-time surprise into a **scheduling input**: the planner can
serialise two nodes the moment their branches _start_ conflicting, rather than waiting for both to
finish. It also relaxes F5.2 usefully — rather than statically serialising all write nodes with
overlapping declared scopes, start them in parallel and serialise on _first detected conflict_, since
most declared overlaps never actually conflict (two agents editing different functions in one file
merge fine).

Three supporting rules, all verified:

- **Never pass `--force` to `git worktree add`.** **Verified 2026-08-02**: `--force` _does_ create a
  second worktree on the same branch, and `git worktree list` then shows both. That is the real
  index-corruption footgun. Encode it as an assertion in the `Git` wrapper. `--force` is permitted on
  `worktree remove` only.
- **Do not parse git's error strings.** The actual message is
  `fatal: '<branch>' is already used by worktree at '<path>'`, **not** "is already checked out at",
  which is what most blog posts claim. Pre-check by scanning `git worktree list --porcelain -z`
  instead. Also note **the main checkout counts** — `git worktree add <path> master` fails because
  the user's own working branch is in use, and that is the common real-world hit, not agent-vs-agent
  collision.
- **`git worktree add --lock` at creation time**, atomically, with a reason string. Locked worktrees
  are immune to `prune`, which makes the lock the crash-safety primitive across daemon restarts.
  Claude Code arrived at the same design independently.

Lifecycle protocol, the dirty-removal salvage path, integration ordering and the Git wrapper's
hard-deny list are in [09-workspace-and-safety.md](../09-workspace-and-safety.md).

## Consequences

### Positive

- A whole class of late-surfacing git failure is removed for the cost of one character in a name.
- Conflict detection becomes continuous, cheap and accurate, with no agent cooperation and no
  checkout. Roughly 40 lines of code.
- Parallelism improves: nodes with overlapping declared scopes run in parallel until they actually
  conflict, rather than being serialised on a prediction.
- Integration ordering has a real signal — merge completed branches in ascending conflict count
  against the integration branch, re-running merge-tree after each merge because the counts change.

### Negative

- Branch names are less readable: `DeFlow/r-01H8__recon-vue-components` rather than a nested path.
  `git branch` output does not group by run. Accepted; the UI groups, and the ledger has the
  structure.
- The PRD's F5.1 text is now wrong and must be read alongside this record. Noted in
  [research-findings.md](../research-findings.md).
- The pairwise conflict matrix is O(n²) merge-tree invocations per completed write node. At the
  parallelism DeFlow actually schedules (default 3 agent slots) this is trivially small, but it does
  not scale to hundreds of concurrent branches.

### Neutral

- A useful non-problem: **gitignored files do not block worktree removal.** **Verified 2026-08-02** —
  a worktree containing only `node_modules/` removed cleanly with exit 0 and no `--force`. Only
  tracked-modified and untracked-but-not-ignored files block. So a fat `node_modules` is a disk
  problem, never a removal problem.

## Alternatives considered

- **Keep `DeFlow/<run-id>/<node-id>` and simply never create a run-level branch.** Rejected: the
  integration branch is a run-level branch, and F5.2's sequential merge strategy needs one.
- **`DeFlow/<runId>-<nodeId>` with a single dash.** Acceptable and equivalent; `__` was chosen
  because run ids and node ids may themselves contain dashes, so a double underscore stays visually
  parseable.
- **A custom ref namespace, `refs/DeFlow/<run>/<node>`, outside `refs/heads/`.** Genuinely
  attractive: hierarchical names coexist, `git branch` output stays clean, and agent-created
  branches stop polluting the user's branch list. Rejected because custom refs are invisible to most
  git GUIs and do not push by default, and the review surface matters more than the tidiness.
- **Path-scope declarations as the primary conflict mechanism (the PRD's F5.3 as written).**
  Rejected as primary, retained as plan-time admission control. Prediction cannot be the gate when
  ground truth costs milliseconds.
- **`git merge --no-commit --no-ff` in a scratch worktree.** Rejected: strictly worse — mutates
  state, needs a worktree, needs cleanup on failure, far slower.

## Revisit when

Two checkable triggers:

1. **`git merge-tree --write-tree` output format changes**, or the minimum git version we require
   moves. We require **git ≥ 2.38** for `merge-tree --write-tree` and prefer **≥ 2.45** for stable
   `worktree list --porcelain -z`; `deflow doctor` asserts both. A parser change should be caught by
   the git-fixture tests, which run against the real binary, not a mock.
2. **Concurrent in-flight write branches routinely exceed roughly 20.** The pairwise matrix is
   O(n²); at that point it needs to become incremental (only recompute pairs involving the branch
   that just moved) or bounded to the integration branch alone.

The flat-naming half of this decision has no revisit trigger. It is a git invariant, not a
preference.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
