# EPIC-08 flows — Permission ladder and execution boundary

> Behavioural specification for [EPIC-08](../epics/EPIC-08-safety-model.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                  | Description                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**           | The engineer driving DeFlow. Answers gates, opts in to `full`, and is the person the frequency argument in §10.5 is about                                             |
| **DeFlowd**            | The local daemon. Here specifically: the ACP **client**, the policy function, `buildChildEnv()` and `killTree()`                                                      |
| **Policy function**    | `decidePermission(level, request, scope)` in `@DeFlow/core` — pure, no I/O, no vendor CLI                                                                             |
| **Provider agent**     | `DeFlow-mock-agent` or the fake exec-shim agent, spawned detached with `cwd` set to a worktree. It calls back into the client for every file access and every command |
| **Vendor CLI sandbox** | Claude Code's Seatbelt/bubblewrap or Codex's Landlock+seccomp — enforcement DeFlow configures and does not reimplement                                                |
| **Process tree**       | A real `bash -c 'sleep 300 & sleep 300 & sleep 300; wait'` and its grandchildren                                                                                      |

## Preconditions common to all flows

```gherkin
Background:
  Given a temp directory created with fs.mkdtemp(path.join(os.tmpdir(), 'DeFlow-'))
  And a git worktree at "<tmp>/wt" which is the node's scope root
  And "<tmp>/bin" prepended to PATH with the mock agent symlinked in under a vendor name
  And DeFlowd holds the resolved ABSOLUTE path to that binary, never relying on PATH at spawn time
  And no vendor CLI is installed, no credential is present and no network is reachable
  And every child is spawned by packages/proc/src/spawn.ts with detached: true
  And every child env is constructed by buildChildEnv() and by nothing else
  And no test in this file uses vi.useFakeTimers() while a child process is alive
```

> Almost every scenario below is a **unit** test. That is the point of ACP-first: because DeFlow is
> the client, it implements `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`,
> `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and
> `terminal/release`, so the whole safety model is one function in DeFlow's own code
> ([§8.1](../../09-workspace-and-safety.md)). The scenarios that genuinely need a process — the kill
> switch, environment scrubbing observed from the child's side, the sandbox argv — say so.

## Flow index

| Scenario    | Title                                                                           | Verifies           | Type       |
| ----------- | ------------------------------------------------------------------------------- | ------------------ | ---------- |
| EPIC-08-S1  | The ladder across four levels: `fs/write_text_file`                             | KAR-08.1           | Happy path |
| EPIC-08-S2  | The ladder across four levels: `terminal/create`                                | KAR-08.1           | Happy path |
| EPIC-08-S3  | `mediatedExecution: false` refuses scheduling above `read`                      | KAR-08.1           | Failure    |
| EPIC-08-S4  | `full` is an explicit per-run opt-in a patch cannot acquire                     | KAR-08.1           | Edge case  |
| EPIC-08-S5  | Routine permission requests are auto-answered without a human                   | KAR-08.1           | Happy path |
| EPIC-08-S6  | `cancelled` is an outcome, not an error                                         | KAR-08.1           | Edge case  |
| EPIC-08-S7  | Path escape by `..` traversal                                                   | KAR-08.2           | Failure    |
| EPIC-08-S8  | Path escape by a symlink pointing outside the worktree                          | KAR-08.2           | Failure    |
| EPIC-08-S9  | Absolute paths, and `additionalDirectories` left empty                          | KAR-08.2           | Failure    |
| EPIC-08-S10 | A `read` node cannot exfiltrate through `fs/read_text_file`                     | KAR-08.2           | Failure    |
| EPIC-08-S11 | `ToolCallLocation.path` rejects an out-of-scope write at request time           | KAR-08.2, KAR-08.7 | Edge case  |
| EPIC-08-S12 | An allowlisted command runs free inside the worktree                            | KAR-08.3           | Happy path |
| EPIC-08-S13 | A command not on the allowlist routes to a human gate                           | KAR-08.3           | Failure    |
| EPIC-08-S14 | The cheap syntactic second layer                                                | KAR-08.3           | Failure    |
| EPIC-08-S15 | The gate budget: 200 gates is worse than no gate                                | KAR-08.3           | Edge case  |
| EPIC-08-S16 | The Kiro control: ambient authority removed from the child environment          | KAR-08.4           | Failure    |
| EPIC-08-S17 | The allowlist keeps exactly what the vendor binary needs                        | KAR-08.4           | Happy path |
| EPIC-08-S18 | `SSH_AUTH_SOCK` dropped for agents, kept for the `Git` wrapper                  | KAR-08.4           | Edge case  |
| EPIC-08-S19 | A declared variable at `worktree+net`, recorded by name only                    | KAR-08.4           | Happy path |
| EPIC-08-S20 | Sandbox policy injected inline; the operator's own config untouched             | KAR-08.5           | Happy path |
| EPIC-08-S21 | `failIfUnavailable` and `allowUnsandboxedCommands`, or the ladder is decorative | KAR-08.5           | Failure    |
| EPIC-08-S22 | Version-gated sandbox keys fail closed                                          | KAR-08.5           | Failure    |
| EPIC-08-S23 | The credential deny list the vendor does not ship                               | KAR-08.5           | Edge case  |
| EPIC-08-S24 | The ladder mapped onto both vendors' sandboxes                                  | KAR-08.5           | Happy path |
| EPIC-08-S25 | Never nest a sandbox around a CLI that already sandboxes                        | KAR-08.5           | Edge case  |
| EPIC-08-S26 | The kill switch stops a whole process tree                                      | KAR-08.6           | Happy path |
| EPIC-08-S27 | The zombie false-negative                                                       | KAR-08.6           | Failure    |
| EPIC-08-S28 | Positive-pid regression: grandchildren survive, reparented to PID 1             | KAR-08.6           | Failure    |
| EPIC-08-S29 | A kill that did not take is an event, not a silent condition                    | KAR-08.6           | Failure    |
| EPIC-08-S30 | A path-scope violation is a warning, not a gate                                 | KAR-08.7           | Edge case  |
| EPIC-08-S31 | Auth shadowing: the key is stripped and the fact is recorded                    | KAR-08.8           | Failure    |
| EPIC-08-S32 | Auth shadowing: the explicit API-key path is recorded too                       | KAR-08.8           | Happy path |
| EPIC-08-S33 | The five AR-1 audit checks                                                      | KAR-08.4           | Recovery   |

---

## EPIC-08-S1 — The ladder across four levels: `fs/write_text_file`

**Verifies:** KAR-08.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: One policy function decides every file write, for every vendor

  Background:
    Given a node whose worktree root is "<tmp>/wt"
    And the policy function decidePermission(level, request, scope)

  Scenario Outline: fs/write_text_file across the ladder
    Given the node's permission level is "<level>"
    When the agent calls fs/write_text_file for "<path>"
    Then the decision is "<decision>"
    And the reason code is "<reason>"

    Examples:
      | level         | path                     | decision | reason            |
      | read          | <tmp>/wt/src/a.ts        | deny     | level-read        |
      | read          | <tmp>/wt/README.md       | deny     | level-read        |
      | read          | /etc/passwd              | deny     | level-read        |
      | worktree      | <tmp>/wt/src/a.ts        | allow    | —                 |
      | worktree      | <tmp>/wt/nested/deep/b   | allow    | —                 |
      | worktree      | /etc/passwd              | deny     | path-escape       |
      | worktree      | <tmp>/other/c.ts         | deny     | path-escape       |
      | worktree+net  | <tmp>/wt/src/a.ts        | allow    | —                 |
      | worktree+net  | /etc/passwd              | deny     | path-escape       |
      | full          | <tmp>/wt/src/a.ts        | allow    | —                 |
      | full          | /etc/passwd              | deny     | path-escape       |

  Scenario: read denies writes even inside its own worktree
    Given the node's permission level is "read"
    When the agent calls fs/write_text_file for a path demonstrably inside "<tmp>/wt"
    Then the decision is deny with reason "level-read"
    And the reason is NOT "path-escape", because the level decided before the path did
```

**Notes:** The last row of the table is the one people get wrong. `full` is _"allow within the
worktree"_ in [§8.1](../../09-workspace-and-safety.md) — not "allow anything". `full` relaxes the
_command_ and _network_ rows, and the run-level opt-in is what the operator is consenting to; the
worktree containment on `fs/*` stays. The second scenario pins the ordering of the two checks so
that a `read` node's denial reason is stable and renderable rather than depending on which path it
happened to try.

---

## EPIC-08-S2 — The ladder across four levels: `terminal/create`

**Verifies:** KAR-08.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: One policy function decides every command execution

  Background:
    Given the repository allowlist from DeFlow.config.ts is
          ["git","pnpm","npm","node","pytest","make","cargo","go","tsc","eslint"]
    And the read-only subset is ["git status","git log","git diff","ls","cat"]

  Scenario Outline: terminal/create across the ladder
    Given the node's permission level is "<level>"
    When the agent calls terminal/create with command "<command>"
    Then the decision is "<decision>"

    Examples:
      | level         | command                          | decision |
      | read          | git status                       | allow    |
      | read          | git log --oneline                | allow    |
      | read          | pnpm test                        | deny     |
      | read          | git commit -m x                  | deny     |
      | read          | curl https://example.com         | deny     |
      | worktree      | pnpm test                        | allow    |
      | worktree      | git commit -m x                  | allow    |
      | worktree      | terraform destroy                | gate     |
      | worktree      | curl https://example.com         | deny     |
      | worktree+net  | pnpm install                     | allow    |
      | worktree+net  | curl https://registry.npmjs.org  | allow    |
      | worktree+net  | curl https://evil.example        | gate     |
      | full          | terraform destroy                | gate     |
      | full          | anything-at-all                  | allow    |

  Scenario: Network is a row of the ladder, not a property of a command
    Given the node's permission level is "worktree"
    When any egress is attempted, by any command, to any host
    Then the decision is deny with reason "level-no-network"
    And the domain allowlist is not consulted, because it does not apply below worktree+net
```

**Notes:** `full` still gates `terraform destroy`. The syntactic second layer
([EPIC-08-S14](#epic-08-s14--the-cheap-syntactic-second-layer)) is orthogonal to the ladder — it
forces a gate on identity- and infrastructure-boundary operations regardless of level, because
that is where [§10.5](../../09-workspace-and-safety.md) says human gates belong. `full` means "the
provider allows it", not "DeFlow stops looking".

---

## EPIC-08-S3 — `mediatedExecution: false` refuses scheduling above `read`

**Verifies:** KAR-08.1 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: One capability bit replaces an N-vendors × M-levels flag matrix

  Scenario: An unmediated adapter cannot run a write node
    Given a provider whose capability manifest reports mediatedExecution false
    And a plan containing a write node at level "worktree"
    When the scheduler evaluates the ready set
    Then the node is not scheduled
    And a "node.unschedulable" event names the provider and the reason "mediatedExecution:false"
    And the node's level is NOT silently downgraded to "read"
    And the node's level is NOT silently escalated

  Scenario: The same provider can still run read nodes
    Given the same unmediated provider
    And a plan containing an analysis node at level "read"
    Then the node is scheduled normally

  Scenario: The bit is read from the persisted manifest, not from a hardcoded table
    When the manifest for the provider is replaced with mediatedExecution true
    Then the same write node becomes schedulable with no code change
```

**Notes:** This is the narrowing of F5.4. As literally written — inspect each vendor's flags and
refuse where the vendor cannot express the level — F5.4 is a permanent flag-churn maintenance
burden, which is the PRD's own G7 gap reintroduced inside the safety layer. Under ACP it is
near-moot: DeFlow enforces the level itself regardless of what the vendor can express, so the only
question left is whether the adapter routes `fs/*` and `terminal/*` through DeFlow at all. One
boolean, on the manifest.

---

## EPIC-08-S4 — `full` is an explicit per-run opt-in a patch cannot acquire

**Verifies:** KAR-08.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: full never arrives by accident

  Scenario: A run without the opt-in cannot contain a full node
    Given a run whose manifest does not carry the full-permission opt-in
    When a plan containing a node at level "full" is validated
    Then validation fails naming the node and the missing run-level opt-in

  Scenario: A PlanPatch cannot raise a node to full on its own authority
    Given a running node proposes a PlanPatch raising a sibling node from "worktree" to "full"
    When the patch policy engine evaluates it
    Then the decision is "requires-approval", never "auto"
    And the approval request states plainly that full is not a sandbox

  Scenario: The opt-in is a recorded, rendered fact
    Given the operator opts in to full for a run
    Then the run manifest records the opt-in with a timestamp
    And every node scheduled at full carries the level on its "node.scheduled" event
    And the node inspector renders the level alongside the provider and CLI version
```

**Notes:** _"Defending the user against themselves at `full` is explicitly out of scope"_
([security model §6.1](../../15-security-model.md)) — which is exactly why the opt-in must be
deliberate, visible and un-acquirable by a patch. ODW's docs state honestly that
`dangerously-full-access` is not a sandbox; DeFlow says the same thing in the same words, at the
moment of opt-in rather than only in a document.

---

## EPIC-08-S5 — Routine permission requests are auto-answered without a human

**Verifies:** KAR-08.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: DeFlow answers the agent from the policy table

  Scenario: An in-scope edit is approved with no human involvement
    Given a node at level "worktree" whose scope includes "src/**"
    When the mock agent sends session/request_permission for a tool of kind "edit"
         with ToolCallLocation.path "<tmp>/wt/src/a.ts"
    Then DeFlowd responds within the same turn with
         { outcome: "selected", optionId: "<the allow_once option>" }
    And no "human.requested" event is appended
    And the operator's approval queue is unchanged

  Scenario: The four option kinds DeFlow offers are schema-valid
    When DeFlowd constructs the option list for a permission request
    Then the option kinds are drawn from
         "allow_once" | "allow_always" | "reject_once" | "reject_always"
    And the outgoing frame validates against the vendored ACP schema.json with ajv

  Scenario: Only gated categories reach the operator
    When a run performs 30 in-scope edits and 12 allowlisted commands
    Then zero "human.requested" events are appended
```

**Notes:** **Verified 2026-08-02** from the shipped `@agentclientprotocol/sdk@1.3.0` type
definitions (`PROTOCOL_VERSION = 1`). Auto-responding is not a convenience — it is what makes the
gates that _do_ fire meaningful. See
[EPIC-08-S15](#epic-08-s15--the-gate-budget-200-gates-is-worse-than-no-gate).

---

## EPIC-08-S6 — `cancelled` is an outcome, not an error

**Verifies:** KAR-08.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: RequestPermissionOutcome has two shapes and both are normal

  Scenario: The cancelled outcome
    Given a node at level "worktree" awaiting an operator decision on a gated command
    When the run is cancelled while the permission request is outstanding
    Then DeFlowd responds { outcome: "cancelled" } to the agent
    And the node transitions to cancelled, not failed
    And no Error object is constructed anywhere on that path
    And the agent's prompt response carries stopReason "cancelled"

  Scenario: The selected outcome with a rejection
    When the operator chooses the reject_once option
    Then DeFlowd responds { outcome: "selected", optionId: "<reject_once>" }
    And the agent continues its turn rather than exiting
    And a "permission.denied" event records the option chosen and who chose it

  Scenario: The client keeps accepting trailing updates after a cancel
    When session/cancel is sent
    Then DeFlowd continues to accept session/update notifications the agent flushes afterwards
    And the reader does not deadlock
```

**Notes:** `RequestPermissionOutcome` is
`{outcome:"cancelled"} | {outcome:"selected", optionId}` — **verified from the shipped types**.
Cancellation must be handled as a first-class outcome, not as an error, or a cancelled run is
indistinguishable from a broken one in the ledger. The trailing-updates clause is the M0-S1 success
criterion carried into production: an agent flushes after `session/cancel` and a client that stops
reading deadlocks.

---

## EPIC-08-S7 — Path escape by `..` traversal

**Verifies:** KAR-08.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Containment is checked on the resolved path

  Scenario Outline: Traversal attempts
    Given a node at level "worktree" whose scope root is "<tmp>/wt"
    When the agent calls fs/write_text_file for "<requested>"
    Then the decision is deny with reason "path-escape:traversal"
    And no filesystem write occurred

    Examples:
      | requested                          |
      | ../../etc/passwd                   |
      | src/../../../etc/passwd            |
      | ./src/./../../outside.txt          |
      | src/sub/../../../../tmp/x          |

  Scenario: Harmless dot segments inside the worktree are allowed
    When the agent calls fs/write_text_file for "src/./sub/../a.ts"
    Then the decision is allow
    And the path DeFlowd actually writes to is the resolved "<tmp>/wt/src/a.ts"

  Scenario: The written path is the resolved one, never the requested one
    Then no code path passes the agent's raw string to the filesystem
```

**Notes:** The last scenario is the quiet one that matters: deciding on the resolved path and then
_writing_ the raw string reintroduces the entire class. Resolve once, decide on the result, write
the result.

---

## EPIC-08-S8 — Path escape by a symlink pointing outside the worktree

**Verifies:** KAR-08.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: realpath, not just resolve

  Background:
    Given a real worktree at "<tmp>/wt" on a real filesystem
    And a real symlink "<tmp>/wt/link" whose target is "<tmp>/outside"

  Scenario: Writing through a symlink that leaves the worktree
    Given a node at level "worktree"
    When the agent calls fs/write_text_file for "<tmp>/wt/link/x.txt"
    Then the decision is deny with reason "path-escape:symlink"
    And "<tmp>/outside/x.txt" does not exist afterwards

  Scenario: The lexically-inside, realpath-outside case
    Given "<tmp>/wt/a" is a symlink to "/etc"
    When the agent calls fs/write_text_file for "<tmp>/wt/a/passwd"
    Then path.resolve() alone reports the path as inside the worktree
    And the realpath check reports it as outside
    And the decision is deny

  Scenario: A symlink that stays inside is fine
    Given "<tmp>/wt/inner" is a symlink to "<tmp>/wt/src"
    When the agent calls fs/write_text_file for "<tmp>/wt/inner/a.ts"
    Then the decision is allow

  Scenario: A path whose parent does not yet exist
    When the agent calls fs/write_text_file for "<tmp>/wt/new/dir/a.ts"
    Then the realpath check is applied to the deepest existing ancestor
    And the decision is allow, without requiring the file to pre-exist
```

**Notes:** The second scenario is the one a `path.resolve()`-only implementation fails, and it is
trivially reachable — the agent creates the symlink itself with an allowed in-scope write, then
writes through it. The last scenario is why the check resolves the deepest _existing_ ancestor: a
naive `realpath` on a not-yet-created file throws, and the tempting fix is to skip the check for new
files, which reopens the hole.

---

## EPIC-08-S9 — Absolute paths, and `additionalDirectories` left empty

**Verifies:** KAR-08.2 · **Type:** Failure · **Automated at:** unit + contract

```gherkin
Feature: Nothing outside the worktree is even nominally in scope

  Scenario: Absolute path outside
    Given a node at level "worktree"
    When the agent calls fs/write_text_file for "/etc/hosts"
    Then the decision is deny with reason "path-escape:absolute"

  Scenario: Absolute path inside is fine
    When the agent calls fs/write_text_file for "<tmp>/wt/src/a.ts" as an absolute path
    Then the decision is allow

  Scenario: session/new declares no additional directories at read or worktree
    When DeFlowd sends session/new for a node at level "read"
    Then the request's cwd is the node's worktree path
    And "additionalDirectories" is present and equal to []
    And the frame validates against the vendored ACP schema

  Scenario: Case-insensitive filesystems do not create a hole
    Given a case-insensitive filesystem
    When the agent calls fs/write_text_file for "<TMP>/WT/src/a.ts"
    Then containment is evaluated case-insensitively and the decision is allow
    And on a case-sensitive filesystem the same request is evaluated case-sensitively
```

**Notes:** `NewSessionRequest` is `{ cwd, additionalDirectories?, mcpServers }` — **verified from
the shipped types**. Leaving `additionalDirectories` empty is defence in depth: even a vendor that
honours it and bypasses DeFlow's mediation has been told nothing else is in scope. The
case-sensitivity clause is the same A5-7 family as EPIC-07's id normalization; getting it backwards
in either direction is a bug.

---

## EPIC-08-S10 — A `read` node cannot exfiltrate through `fs/read_text_file`

**Verifies:** KAR-08.2 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: read means read inside the worktree, not read anywhere

  Scenario: Reading the user's cloud credentials is denied
    Given a node at level "read" whose scope root is "<tmp>/wt"
    When the agent calls fs/read_text_file for "~/.aws/credentials"
    Then the decision is deny with reason "path-escape:absolute"
    And the file was never opened — the Fs port's recording double logs zero opens for that path

  Scenario Outline: The credential deny set is unreachable at every level below full
    When the agent calls fs/read_text_file for "<path>" at level "<level>"
    Then the decision is deny

    Examples:
      | level        | path                        |
      | read         | ~/.ssh/id_ed25519           |
      | worktree     | ~/.aws/credentials          |
      | worktree+net | ~/.config/gh/hosts.yml      |
      | worktree+net | ~/.claude/.credentials.json |

  Scenario: Reading inside the worktree is the whole point of read level
    When the agent calls fs/read_text_file for "<tmp>/wt/src/a.ts"
    Then the decision is allow
```

**Notes:** A prompt-injected agent's cheapest attack is not `terraform destroy` — it is reading a
credential file and putting it in its own output. `fs/read_text_file` is the method that makes that
one JSON-RPC call, and it is easy to forget because the ladder table in
[§8.1](../../09-workspace-and-safety.md) lists only `fs/write_text_file`. The reads are mediated
too, and this scenario is what proves it. It pairs with the vendor-layer deny list in
[EPIC-08-S23](#epic-08-s23--the-credential-deny-list-the-vendor-does-not-ship).

---

## EPIC-08-S11 — `ToolCallLocation.path` rejects an out-of-scope write at request time

**Verifies:** KAR-08.2, KAR-08.7 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Reject before it happens, not diff after it happened

  Scenario: An in-worktree but out-of-scope write
    Given a write node at level "worktree" whose declared pathScope is ["src/**"]
    When the mock agent sends session/request_permission for a tool of kind "edit"
         with ToolCallLocation { path: "<tmp>/wt/infra/main.tf" }
    Then DeFlowd responds with the reject_once option
    And a "permission.denied" event records
        { reason: "scope-violation", requested: "infra/main.tf", declared: ["src/**"] }
    And "<tmp>/wt/infra/main.tf" is unchanged on disk
    And the node continues rather than failing

  Scenario: The UI can render the reason
    Then the event's payload is structured, with separate requested and declared fields
    And no part of the reason is a pre-formatted prose sentence

  Scenario: An adapter that does not populate ToolCallLocation
    Given a provider whose permission requests carry no location
    When the agent writes out of scope anyway
    Then no request-time rejection is possible
    And the violation is detected on node completion by diffing the worktree
    And it is recorded as "node.scope_warning" — see EPIC-08-S30
```

**Notes:** `ToolCallLocation` is `{ path: string, line?: number }` — **verified from the shipped
types**. This is the improvement over F5.3 called out in [§6.3](../../09-workspace-and-safety.md):
DeFlow rejects the write _before it happens_, with a reason the UI can render, rather than diffing
at completion and calling it a gate failure. The third scenario is the honest fallback for adapters
that do not populate it, and it is why KAR-08.7 still exists.

---

## EPIC-08-S12 — An allowlisted command runs free inside the worktree

**Verifies:** KAR-08.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The common case costs nothing

  Scenario: A test run at worktree level
    Given a node at level "worktree" and a repository allowlist containing "pnpm"
    When the agent calls terminal/create with { command: "pnpm", args: ["test"], cwd: "<tmp>/wt" }
    Then the decision is allow
    And no "human.requested" event is appended
    And the terminal is created with the child env from buildChildEnv()
    And terminal/output, terminal/wait_for_exit and terminal/release complete the lifecycle

  Scenario: A binary resolved from the worktree's own node_modules
    When the agent runs "./node_modules/.bin/vitest"
    Then allowlist matching is performed on the resolved binary name "vitest"
    And the decision follows the allowlist entry for "vitest", not a raw string comparison

  Scenario: cwd outside the worktree is refused even for an allowlisted binary
    When the agent calls terminal/create with cwd "<tmp>/other"
    Then the decision is deny with reason "path-escape:cwd"
```

**Notes:** The `cwd` check is easy to omit — the command and args get all the attention. An
allowlisted `git` invocation with a `cwd` outside the worktree is a full escape with no exotic
syntax at all.

---

## EPIC-08-S13 — A command not on the allowlist routes to a human gate

**Verifies:** KAR-08.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Default deny, then ask

  Scenario: An unknown binary
    Given a node at level "worktree" and a repository allowlist that does not contain "rsync"
    When the agent calls terminal/create with { command: "rsync", args: ["-av","/","/backup"] }
    Then the decision is gate with reason "not-allowlisted:rsync"
    And a "human.requested" event is appended carrying the full command, args and cwd verbatim
    And no terminal is created and no process is spawned
    And the node suspends cheaply — no CPU is consumed while waiting

  Scenario: The operator approves
    When the operator approves the request
    Then a "human.responded" event records the decision and the responder
    And the terminal is then created with exactly the command that was shown, byte for byte

  Scenario: The operator rejects
    When the operator rejects the request
    Then DeFlowd responds with the reject_once option
    And no process is spawned
    And the agent may continue its turn

  Scenario: The command shown is the command run
    Then a test asserts the argv passed to spawn is identical to the argv rendered in the
         human.requested event, with no shell interpolation between the two
```

**Notes:** The last scenario is a real class of attack and a real class of bug: an approval UI that
renders a normalized or shell-quoted form of a command, and then runs a different string, is an
approval of something the operator did not see. Deny-lists lose because `rm -rf /` has infinite
spellings — `rm -fr`, `$(echo rm) -rf`, `find / -delete`, a Makefile target, a `postinstall` hook —
which is exactly why the allowlist is on the binary and everything else is asked about.

---

## EPIC-08-S14 — The cheap syntactic second layer

**Verifies:** KAR-08.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: High-signal syntactic checks force a gate even for allowlisted binaries

  Scenario Outline: The gated set
    Given a node at level "worktree" whose worktree root is "<tmp>/wt"
    And "<binary>" is on the repository allowlist
    When the agent calls terminal/create with "<command>"
    Then the decision is "<decision>"

    Examples:
      | binary    | command                                          | decision |
      | git       | git push --force origin DeFlow/r1__n1            | gate     |
      | git       | git push -f origin DeFlow/r1__n1                 | gate     |
      | git       | git push --force-with-lease origin DeFlow/r1__n1 | allow    |
      | git       | git reset --hard HEAD~1                          | allow    |
      | git       | git reset --hard -- /etc                         | gate     |
      | rm        | rm -rf /                                         | gate     |
      | rm        | rm -r /usr                                       | gate     |
      | rm        | rm -rf <tmp>/wt/dist/cache/tmp                   | allow    |
      | terraform | terraform apply                                  | gate     |
      | terraform | terraform destroy                                | gate     |
      | terraform | terraform plan                                   | allow    |
      | kubectl   | kubectl delete pod x                             | gate     |
      | kubectl   | kubectl get pods                                 | allow    |
      | aws       | aws s3 rm s3://bucket --recursive                | gate     |
      | psql      | psql postgres://localhost:5432/dev               | allow    |
      | psql      | psql postgres://db.prod.internal/main            | gate     |
      | prisma    | prisma migrate deploy                            | gate     |
      | prisma    | prisma migrate dev                               | allow    |
      | drizzle   | drizzle-kit push                                 | gate     |
      | flyway    | flyway migrate                                   | gate     |

  Scenario: A command needing a scrubbed variable is gated, not failed
    Given AWS_PROFILE was scrubbed from the child environment
    When the agent calls terminal/create with a command whose args reference $AWS_PROFILE
    Then the decision is gate with reason "scrubbed-env:AWS_PROFILE"
    And the operator sees which variable is being requested and why it was removed

  Scenario: No static analysis of shell strings is attempted
    Then the implementation contains no shell parser
    And a command using command substitution is treated by its outer binary alone,
        and gated if that binary is not allowlisted
```

**Notes:** _"Do **not** attempt real static analysis of shell strings. It is undecidable and gives
false confidence."_ The `rm -r` rule is a **depth** rule — a path of two segments or fewer — not a
list of dangerous paths, because the list is infinite and the depth is not. The
`--force-with-lease` row exists so that the safe form is not collateral damage; gating it would
train the operator to approve force-pushes, which is precisely backwards.

---

## EPIC-08-S15 — The gate budget: 200 gates is worse than no gate

**Verifies:** KAR-08.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Gate frequency is a design constraint, asserted in CI

  Scenario: A representative run produces no gates
    Given a fixture repository whose DeFlow.config.ts allowlist covers its actual verbs
    And a scripted run performing 30 commands and 40 file writes at level "worktree"
    When the run completes
    Then exactly zero "human.requested" events were appended
    And the test fails loudly if that count is greater than zero

  Scenario: A deliberately narrow allowlist fails the budget
    Given the same run with "pnpm" removed from the allowlist
    Then the gate count exceeds the budget
    And the test failure names the commands that were gated, so the fix is to the allowlist

  Scenario: The gates that do fire are the ones that matter
    Given a scripted run that additionally attempts "terraform destroy" once
    Then exactly one "human.requested" event is appended
    And it is distinguishable in the approval queue without scrolling
```

**Notes:** _"A gate that fires 200 times in a run is auto-clicked, and is worse than no gate — it
manufactures the habit of approving without reading, and it makes the one gate that mattered
indistinguishable from the 199 that did not."_ Turning that into a CI assertion is what stops the
allowlist from being quietly narrowed by someone being cautious. Human gates belong at the
network-egress and identity boundary, not at the command boundary.

---

## EPIC-08-S16 — The Kiro control: ambient authority removed from the child environment

**Verifies:** KAR-08.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The control that would actually have prevented the Kiro incident

  Background:
    Given DeFlowd's own process environment contains
          AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_PROFILE,
          GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT,
          KUBECONFIG, DATABASE_URL, TF_TOKEN_app_terraform_io,
          VAULT_ADDR, VAULT_TOKEN, DOCKER_HOST, SSH_AUTH_SOCK,
          GITHUB_TOKEN, NPM_TOKEN, SLACK_TOKEN,
          ANTHROPIC_API_KEY, OPENAI_API_KEY,
          MY_CUSTOM_SECRET, DB_PASSWORD, SERVICE_CREDENTIALS
    And a fake agent binary that prints process.env as JSON and exits 0

  Scenario: None of it reaches the agent
    When DeFlowd spawns the agent for a node at level "worktree"
    And the harness reads the JSON the CHILD printed
    Then every variable listed in the Background is absent from the child's environment
    And the assertion is made on what the child received, not on what DeFlowd constructed

  Scenario: A successful prompt injection reaches no credential
    Given the agent is scripted to run an allowlisted command that echoes its environment
    When the command runs
    Then its output contains no value from the Background set
    And the artifact written to disk contains none of those values either

  Scenario: Even at full, the families are not implicit
    Given a node at level "full"
    Then the same families are still absent unless the node explicitly declared them
    And full relaxes the command and network rows, not the environment allowlist
```

**Notes:** This scenario carries the whole argument of the epic. **Verified:** on 15 December 2025
AWS's Kiro agent deleted a production environment during a Cost Explorer task, causing a ~13-hour
outage; Amazon's own rebuttal attributes it to **misconfigured access controls**, stating Kiro
requests authorization before acting but that the engineer's elevated permissions bypassed those
checks. _"A gate you can bypass with ambient authority is theatre. Removing the authority ranks
above adding the gate."_ Amazon's framing is contested, and it is also the most useful part of the
story, because "misconfigured access controls" is a control DeFlow can implement whereas "the AI
decided badly" is not. This test file names the incident in its describe block so the reason
survives future refactors.

---

## EPIC-08-S17 — The allowlist keeps exactly what the vendor binary needs

**Verifies:** KAR-08.4 · **Type:** Happy path · **Automated at:** unit + integration

```gherkin
Feature: buildChildEnv() starts from {} and adds

  Scenario: The kept set, exactly
    When buildChildEnv() constructs an agent environment for a node at level "worktree"
    Then Object.keys(env).sort() equals the snapshot of
         HOME, LANG, LC_ALL, LOGNAME, PATH, SHELL, TERM, TMPDIR, TZ, USER
    And the snapshot is the assertion, so an added key is a visible diff in the pull request

  Scenario: HOME is kept, and that is AR-1 working
    Then HOME is present, because the vendor binary needs it to find its own credential store
    And DeFlowd itself never opens anything under it

  Scenario: PATH comes from the login shell, not from DeFlowd
    Given DeFlowd was started by a launch agent whose PATH lacks /opt/homebrew/bin
    When buildChildEnv() runs
    Then the child's PATH is the login-shell PATH resolved once at daemon start
    And it is not process.env.PATH

  Scenario: TMPDIR is overridden per run
    Given two concurrent runs r1 and r2
    Then their children receive different TMPDIR values
    And each directory exists with mode 0700

  Scenario: Vendor config-dir variables pass through only when the user set them
    Given the user set CLAUDE_CONFIG_DIR
    Then it is present in the child environment unmodified
    And when the user did not set it, DeFlowd does not invent one
```

**Notes:** `PATH` is the one people are surprised by: DeFlowd's `PATH` at daemon start differs from
the user's login shell, which is why [testing strategy §3.3](../../14-testing-strategy.md) also
insists on spawning by resolved absolute path. Both controls exist because either alone leaves a
"works in my terminal, fails as a daemon" failure mode.

---

## EPIC-08-S18 — `SSH_AUTH_SOCK` dropped for agents, kept for the `Git` wrapper

**Verifies:** KAR-08.4 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Two environment builders, deliberately different

  Scenario: The agent never gets the forwarded ssh agent
    Given SSH_AUTH_SOCK is present in DeFlowd's environment
    When buildChildEnv() constructs an agent environment at any level
    Then SSH_AUTH_SOCK is absent

  Scenario: DeFlow's own git invocations do get it
    When gitChildEnv() constructs the environment for a git push
    Then SSH_AUTH_SOCK is present

  Scenario: The two builders are not unified
    When the source is inspected
    Then buildChildEnv and gitChildEnv are separate functions with separate tests
    And a comment or test name records that the difference is intentional

  Scenario: The consequence, demonstrated
    Given the agent is scripted to attempt "ssh git@github.com"
    Then the command is not on the allowlist and is gated
    And even if approved, the child has no SSH_AUTH_SOCK and cannot authenticate as the user
```

**Notes:** _"The agent never pushes; the `Git` wrapper does. Separating the two means an agent
cannot use the user's forwarded ssh agent to reach any host the user can."_ Two defences stacked
deliberately — the allowlist gate and the missing socket — because the allowlist is per-repo
configuration and configuration drifts.

---

## EPIC-08-S19 — A declared variable at `worktree+net`, recorded by name only

**Verifies:** KAR-08.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The allowlist is per-node, not global

  Scenario: A node that legitimately needs a registry token declares it
    Given a node at level "worktree+net" whose config declares env ["NPM_TOKEN"]
    And NPM_TOKEN is present in DeFlowd's environment
    When the agent is spawned
    Then NPM_TOKEN is present in the child's environment
    And an "env.declared" event records { node: "n1", name: "NPM_TOKEN" }
    And the event carries no value
    And the run report renders the declaration

  Scenario: A sibling node at the same level does not get it
    Given a second node at level "worktree+net" that declares nothing
    Then NPM_TOKEN is absent from its child environment

  Scenario: A declaration at read level is refused
    Given a node at level "read" declaring env ["NPM_TOKEN"]
    Then plan validation fails, because a read node has no execution that could need it

  Scenario: The value never enters the ledger or an artifact
    When the ledger and every artifact for the run are scanned for the token's value
    Then zero matches are found
```

**Notes:** The declaration being a _rendered ledger fact_ is the point. A credential that reaches an
agent should be visible in the run report as a decision someone made, not as something that happened
to be in the environment — that is the difference between granted authority and ambient authority.

---

## EPIC-08-S20 — Sandbox policy injected inline; the operator's own config untouched

**Verifies:** KAR-08.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Per-node policy without mutating the user's vendor configuration

  Scenario: The policy arrives on the command line
    Given a node at level "worktree" routed to Claude Code
    And a fake "claude" shim on the tmp PATH that writes its argv to a file
    When DeFlowd spawns the agent
    Then the argv contains "--settings" followed by a single JSON string argument
    And that JSON parses and equals the golden policy for level "worktree"

  Scenario: No user configuration file is read or written
    Given the Fs port is replaced with a recording double for the whole run
    When a full mock-agent run completes
    Then no recorded path matches "**/.claude/**"
    And none matches "**/.codex/**"
    And none matches "**/.config/gh/**", "**/.aws/credentials", "**/.ssh/**",
        or "**/Library/Keychains/**"

  Scenario: Two nodes in one run can carry different policies
    Given node n1 at level "read" and node n2 at level "worktree+net"
    Then each spawn carries its own "--settings" JSON
    And the two JSON documents differ in the filesystem and network sections

  Scenario: The policy is a golden file
    Then the generated JSON per level per vendor is snapshotted with the normalizing serializer
    And a change to it appears as a readable diff in a pull request
```

**Notes:** _"The crucial integration fact: the CLI accepts `--settings '<inline JSON>'`."_ That one
capability is what makes per-node policy compatible with AR-1 and with "DeFlow must not mutate the
user's vendor CLI configuration". The `Fs`-recording-double scenario is audit check 3 from
[security model §1.2](../../15-security-model.md), reused here for free — run the whole mock-agent
suite against it and the entire daemon is covered, not just the code someone remembered to test.

---

## EPIC-08-S21 — `failIfUnavailable` and `allowUnsandboxedCommands`, or the ladder is decorative

**Verifies:** KAR-08.5 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: The two keys without which the vendor sandbox silently degrades

  Scenario Outline: Both keys are set for every non-full level
    Given a node at level "<level>"
    When the sandbox policy JSON is generated for Claude Code
    Then it contains sandbox.enabled true
    And it contains sandbox.failIfUnavailable true
    And it contains sandbox.allowUnsandboxedCommands false

    Examples:
      | level        |
      | read         |
      | worktree     |
      | worktree+net |

  Scenario: A missing sandbox dependency fails the node rather than degrading it
    Given Linux, and a PATH from which "bwrap" is absent
    When a node at level "worktree" is started
    Then the node fails to start with a typed error naming bubblewrap
    And no agent process ran unsandboxed
    And a "node.failed" event carries reason "sandbox-unavailable"

  Scenario: socat is checked too
    Given "socat" is absent from PATH on Linux
    Then the same failure occurs, naming socat

  Scenario: The AppArmor case on Ubuntu 24.04+
    Given kernel.apparmor_restrict_unprivileged_userns is set
    Then the doctor check reports it with instructions for an /etc/apparmor.d/bwrap profile
    And a worktree-level node fails closed rather than running unsandboxed
```

**Notes:** **Without these two keys the permission ladder is decorative.** The CLI falls back to
running unsandboxed when bubblewrap and socat are missing or the platform is unsupported, and the
model can retry a sandbox-failed command outside the sandbox via `dangerouslyDisableSandbox`. Both
failure modes are silent, which is what makes them worth a dedicated scenario — nothing in the run
would look wrong.

---

## EPIC-08-S22 — Version-gated sandbox keys fail closed

**Verifies:** KAR-08.5 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Detect the CLI version and degrade explicitly, never silently

  Scenario Outline: A key whose gate the installed CLI does not meet
    Given the detected Claude Code version is "<version>"
    When the policy for level "worktree" is generated
    Then the "<key>" key is "<disposition>"

    Examples:
      | version  | key                    | disposition               |
      | 2.1.186  | sandbox.credentials    | refuse to schedule        |
      | 2.1.190  | sandbox.credentials    | included                  |
      | 2.1.190  | credentials mode mask  | omitted, degraded event   |
      | 2.1.200  | credentials mode mask  | included                  |
      | 2.1.215  | filesystem.disabled    | omitted, degraded event   |
      | 2.1.216  | filesystem.disabled    | included                  |
      | 2.1.218  | strictAllowlist        | omitted, degraded event   |
      | 2.1.220  | strictAllowlist        | included                  |

  Scenario: Degradation is an event, not a log line
    When a key is omitted because of a version gate
    Then a "sandbox.degraded" event names the key, the detected version and the required version
    And the node inspector renders it alongside the permission level

  Scenario: Anything credential-related refuses by default
    Given the installed CLI predates the credentials gate
    Then the default behaviour is to refuse to schedule the node
    And relaxing that to degrade-and-continue requires explicit configuration

  Scenario: The version is detected, never assumed
    Then the policy generator takes the version as an input
    And no gate constant is compared against a hardcoded "current" version
```

**Notes:** **A5-1, rated High.** Claude Code's sandbox settings are version-gated at fine
granularity — `credentials` ≥ 2.1.187, `mask` ≥ 2.1.199, `filesystem.disabled` ≥ 2.1.216, classifier
routing ≥ 2.1.218, `strictAllowlist` ≥ 2.1.219 — and an unknown key is ignored rather than
rejected, so the failure mode is a policy the operator believes is in force and is not.
_"DeFlow must detect the CLI version and degrade the ladder explicitly or fail closed — never
silently."_

---

## EPIC-08-S23 — The credential deny list the vendor does not ship

**Verifies:** KAR-08.5 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Claude Code's default read policy is more permissive than people assume

  Scenario: The default permits what DeFlow must deny
    Given no sandbox.credentials.files entry is configured
    Then the vendor CLI's default read policy permits reading "~/.aws/credentials" and "~/.ssh/"
    And there is no built-in credential deny list

  Scenario: DeFlow populates it explicitly
    When the policy for any non-full level is generated
    Then sandbox.credentials.files denies at least
         "~/.aws/credentials", "~/.ssh/**", "~/.config/gh/**", "~/Library/Keychains/**"
    And the mode is "deny"
    And sandbox.credentials.envVars is populated with the never-implicit families from EPIC-08-S16

  Scenario: Defence in depth, not duplication
    Then the same paths are ALSO denied by DeFlow's own fs mediation (EPIC-08-S10)
    And a test documents that the two layers are independent, because the vendor layer belongs
        to someone else's release cycle

  Scenario: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB reinforces the process boundary
    Then the generated environment sets it
    And Copilot CLI's --secret-env-vars is used on that adapter's spawn path, since it strips
        named variables from child environments AND redacts them from output
```

**Notes:** _"Assume the vendor sandbox protects credentials by default"_ is on the pitfalls list for
a reason. Scrubbing at `spawn()` covers the agent process; it does not cover a command the agent
runs that inherits from somewhere else, or a process the agent spawns after DeFlow has stopped
watching. Defence in depth is the right posture here **precisely because the enforcement points
belong to someone else's release cycle.**

---

## EPIC-08-S24 — The ladder mapped onto both vendors' sandboxes

**Verifies:** KAR-08.5 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: One ladder, two vendor dialects

  Scenario Outline: The mapping
    Given a node at level "<level>"
    Then the Claude Code policy is "<claude>"
    And the Codex policy is "<codex>"

    Examples:
      | level        | claude                             | codex                                        |
      | read         | filesystem read-only, no allowedDomains | sandbox_mode read-only                  |
      | worktree     | allowWrite = cwd                   | workspace-write, network_access false        |
      | worktree+net | + network.allowedDomains           | workspace-write, network_access true         |
      | full         | bypassPermissions                  | danger-full-access                           |

  Scenario: Codex workspace-write keys come from the verified enum
    When the Codex policy for "worktree" is generated
    Then the [sandbox_workspace_write] section uses only
         writable_roots, network_access, exclude_tmpdir_env_var, exclude_slash_tmp
    And writable_roots contains exactly the node's worktree path

  Scenario: A level DeFlow cannot express on a given vendor is refused, not approximated
    Given a vendor with no equivalent of the requested level
    Then the node is refused scheduling with a typed reason
    And no nearest-neighbour level is substituted
```

**Notes:** The Codex keys are **verified from the Rust source**
(`codex-rs/protocol/src/protocol.rs`), which is why they are safe to hardcode where the _flag_
surface is not. **A5-6:** `AskForApproval` now has a `Granular` variant and `on-failure` is merely
an alias for `on-request` — actively churning, and a direct argument for driving Codex over ACP
rather than flags.

---

## EPIC-08-S25 — Never nest a sandbox around a CLI that already sandboxes

**Verifies:** KAR-08.5 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: DeFlow owns policy and mediation; the vendor owns enforcement (D12)

  Scenario Outline: Sandbox strategy selection
    Given a provider "<provider>"
    When the sandbox strategy is chosen
    Then it is "<strategy>"

    Examples:
      | provider    | strategy                                  |
      | claude-code | delegate to the vendor sandbox            |
      | codex       | delegate to the vendor sandbox            |
      | gemini      | wrap with @anthropic-ai/sandbox-runtime   |
      | copilot     | wrap with @anthropic-ai/sandbox-runtime   |
      | cursor      | wrap with @anthropic-ai/sandbox-runtime   |
      | opencode    | wrap with @anthropic-ai/sandbox-runtime   |

  Scenario: Never both
    Then no provider is assigned both a vendor sandbox and a DeFlow-authored wrapper
    And a unit test asserts the strategy set is a partition, not an overlay

  Scenario: sandbox-runtime is pinned exactly
    Then the dependency is "@anthropic-ai/sandbox-runtime": "0.0.67" with no range
    And a comment records that it is 0.0.x and its API is treated as unstable

  Scenario: No DeFlow-authored bwrap or Seatbelt profile exists at all
    When the repository is searched for bubblewrap or sandbox-exec profile authoring
    Then zero hits are found outside the sandbox-runtime dependency
```

**Notes:** _"bubblewrap fails inside an unprivileged container and needs `enableWeakerNestedSandbox`,
which Anthropic warns considerably weakens security. Wrapping a sandboxing CLI in a DeFlow-authored
profile turns a working sandbox into a broken one."_ The narrow exception is
`@anthropic-ai/sandbox-runtime` for CLIs with no native sandbox — never as a second layer around one
that has one. For that case it is also strictly better than a container and fully NF6-compatible,
since it needs no Docker at all.

---

## EPIC-08-S26 — The kill switch stops a whole process tree

**Verifies:** KAR-08.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One control stops every child process in a run

  Background:
    Given a child spawned as
          spawn('bash', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'],
                { detached: true, stdio: ['ignore','pipe','pipe'] })
    And "ps -eo pid,ppid,pgid,stat" shows four processes sharing pgid === child.pid

  Scenario: The escalation ladder, in order
    When the operator triggers the kill switch
    Then DeFlowd first sends the protocol-level session/cancel (or ACP terminal/kill)
    And the agent is given the chance to flush its final session/update notifications
    And the prompt response carries stopReason "cancelled"
    And DeFlowd then calls process.kill(-child.pid, 'SIGTERM')
    And waits a 5 second grace period driven by the injected Clock
    And escalates to process.kill(-child.pid, 'SIGKILL') if the group is not empty
    And waits 2 seconds before reporting

  Scenario: Every step is a ledger event with its elapsed time
    Then the ledger contains, in order,
         "process.cancel_requested", "process.sigterm_sent", "process.sigkill_sent"
         (the last only if escalation occurred), and "process.killed"
    And each carries elapsed milliseconds measured through the Clock port

  Scenario: An agent that ignores SIGTERM
    Given the fake exec-shim agent is scripted to ignore SIGTERM
    When the kill switch runs
    Then the SIGKILL step fires after the grace period
    And the group is empty afterwards, excluding Z-state processes

  Scenario: There is exactly one kill site
    When the repository is grepped for "process.kill"
    Then every hit is inside killTree()
    And no agent code path uses execa's kill(), forceKillAfterDelay or cleanup
```

**Notes:** `detached: true` is **mandatory**. **Verified 2026-08-02:** a child spawning two
grandchildren showed all four processes sharing `pgid = child.pid`. Non-detached is worse than
useless — the only process group containing the grandchildren would be DeFlowd's own, so
group-signalling it would kill the daemon. The final scenario exists because execa's
`forceKillAfterDelay` _"does not work when the subprocess is terminated by calling `subprocess.kill()`
with a specific signal"_, and DeFlow always passes an explicit signal, so there is **no automatic
escalation** — the timer must be hand-written.

---

## EPIC-08-S27 — The zombie false-negative

**Verifies:** KAR-08.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: ps still lists processes that are already dead

  Background:
    Given the process tree from EPIC-08-S26 with pgid $PGID
    And a successful group SIGKILL has just been sent

  Scenario: The naive check reports failure when the kill succeeded
    When the harness runs "ps -eo pid,pgid,stat" and filters only on "$2 == g"
    Then it still lists the grandchildren
    And a naive assertion would conclude the group kill failed
    And the test asserts explicitly that this naive check DOES report survivors,
        so the trap is documented rather than discovered

  Scenario: The processes are zombies, already dead, awaiting reaping
    When the "stat" column is inspected for those pids
    Then their state is "Z"
    And their ppid is 1, because they were reparented to init

  Scenario: The correct verification excludes Z-state processes
    When the harness runs
         ps -eo pid,pgid,stat | awk -v g="$PGID" '$2==g && $3 !~ /Z/'
    Then the output is empty
    And killTree() reports success

  Scenario: The exclusion is in the production code, not only in the test
    When killTree() verifies its own success
    Then it filters on process state and ignores Z
    And a unit test over the ps-output parser covers a mixed listing of R, S and Z rows

  Scenario: Container timing
    Given zombie reaping can lag badly inside containers
    Then the verification retries within the 2 second post-SIGKILL window
    And it does not assert on a single instantaneous ps snapshot
```

**Notes:** **Verified by measurement.** The first test run of the kill fixture concluded the group
kill had failed. It had not — adding the `stat` column showed the processes in state **`Z`** with
`ppid = 1`. Zombie reaping is prompt under launchd and systemd but **can lag badly inside
containers**, so this bites hardest in CI, where an intermittently-failing kill-switch test is the
least welcome kind of flake, and where you cannot attach a debugger.
**Any kill-verification assertion must exclude `Z`-state processes.** This scenario is worth more
than three happy paths.

---

## EPIC-08-S28 — Positive-pid regression: grandchildren survive, reparented to PID 1

**Verifies:** KAR-08.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The regression test that stops anyone simplifying the kill path

  Scenario: A positive pid kills only the direct child
    Given the process tree from EPIC-08-S26
    When the harness calls process.kill(child.pid, 'SIGTERM') with a POSITIVE pid
    Then the direct child exits
    And both grandchildren are still alive, excluding Z-state
    And their ppid is now 1, because init adopted them
    And they still hold the original pgid

  Scenario: Only the negative form clears the group
    When the harness then calls process.kill(-child.pid, 'SIGKILL')
    Then the filtered group listing is empty

  Scenario: The obvious simplification is blocked
    When the repository is inspected
    Then no call site uses child.kill() or subprocess.kill() on an agent process
    And killTree()'s POSIX branch takes a pgid and negates it exactly once
```

**Notes:** **Verified 2026-08-02.** This scenario exists to fail loudly the day someone replaces
`process.kill(-pid, sig)` with the tidier-looking `child.kill(sig)`. execa's own documentation says
`subprocess.kill()` _"only sends a signal to that subprocess, not to any process it might have
spawned itself"_ — tree termination there needs `killDescendants`, a different option entirely.
DeFlow does not rely on any of it: _the most safety-critical code in the daemon should not depend on
three options whose documented behaviour contradicts their names._

---

## EPIC-08-S29 — A kill that did not take is an event, not a silent condition

**Verifies:** KAR-08.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Honest reporting when the kill switch fails

  Scenario: A survivor after the SIGKILL window
    Given a process that cannot be terminated within the 2 second post-SIGKILL window
    When killTree() completes its verification
    Then it does NOT report success
    And a "run.kill_failed" event is appended carrying the surviving pids and their states
    And the UI surfaces the failure to the operator with the pids

  Scenario: Success is never assumed from the absence of an error
    Then killTree() returns only after a positive verification that the filtered group is empty
    And no code path returns success on the mere fact that the signal call did not throw

  Scenario: The kill switch is idempotent
    When the operator triggers it twice
    Then the second invocation completes without error
    And it does not signal an unrelated pid, because the pgid is re-validated against the
        recorded process start time first

  Scenario: Cancellation state and process state stay consistent
    Then the run's cancel state (owned by EPIC-06) and the process events (owned here)
         reconcile in the ledger, so a run is never "cancelled" with live children
```

**Notes:** _"A kill that did not take is an event, not a silent condition."_ The idempotence
scenario carries the PID-reuse guard forward from
[EPIC-07-S31](./EPIC-07-workspace-isolation-flows.md): by the time a second kill runs, the pgid may
belong to someone else entirely, and signalling it is the same unrecoverable class of bug.

---

## EPIC-08-S30 — A path-scope violation is a warning, not a gate

**Verifies:** KAR-08.7 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: F5.3 demoted to a plan-time prediction (D14)

  Scenario: A completion-time violation is recorded as a warning
    Given a write node whose declared pathScope is ["src/**"]
    And a provider whose permission requests carry no ToolCallLocation
    When the node writes "<tmp>/wt/docs/readme.md" and completes
    Then a "node.scope_warning" event records the declared globs and the actual out-of-scope paths
    And the node's status is completed, not failed
    And no gate is created

  Scenario: The prediction and the ground truth are different mechanisms
    Then declared path scope is described as plan-time admission control, dependent on agent
         compliance, whose violation is a warning
    And merge-tree --write-tree is described as run-time gating, ground truth, requiring zero
         agent cooperation, whose conflict is a gate

  Scenario: Two overlapping declared scopes do not serialize
    Given nodes n1 and n2 both declaring "src/**"
    Then both are admitted in parallel
    And serialization happens only on a detected conflict (EPIC-07-S25)

  Scenario: Warnings accumulate visibly
    Given a node emits three scope warnings across a run
    Then all three are queryable per node
    And the node inspector renders them, so a chronic scope habit is visible rather than folklore

  Scenario: Path normalization matches the containment check
    When a warning is evaluated for "./src/a.ts", "src/a.ts" and "<tmp>/wt/src/a.ts"
    Then all three are treated as one path
```

**Notes:** Path scopes stay useful and stay in the plan; they just stop being the thing merges depend
on. The reason the demotion is safe is that ACP gave DeFlow something better for the enforcement
half — `ToolCallLocation.path` rejects at request time
([EPIC-08-S11](#epic-08-s11--toolcalllocationpath-rejects-an-out-of-scope-write-at-request-time)) —
so this warning path is the honest fallback for adapters that do not populate it, not the primary
control.

---

## EPIC-08-S31 — Auth shadowing: the key is stripped and the fact is recorded

**Verifies:** KAR-08.8 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: You should never learn your auth mode from a bill

  Scenario: A shadowing variable is stripped and reported
    Given ANTHROPIC_API_KEY is present in DeFlowd's environment
    And a node configured for subscription auth on Claude Code
    When the agent is spawned
    Then ANTHROPIC_API_KEY is absent from the child environment
    And a "provider.auth_shadow_stripped" event names the variable and the provider
    And the event carries no value
    And the run manifest records provider.auth_mode "subscription"

  Scenario Outline: The shadowing set is data, not code
    Given "<variable>" is present in DeFlowd's environment
    Then it is detected as auth-shadowing for provider "<provider>"

    Examples:
      | variable          | provider    |
      | ANTHROPIC_API_KEY | claude-code |
      | OPENAI_API_KEY    | codex       |
      | GEMINI_API_KEY    | gemini      |
      | GOOGLE_API_KEY    | gemini      |

  Scenario: DeFlow doctor reports it before a run is ever started
    When doctor runs with ANTHROPIC_API_KEY set
    Then it reports the provider, the variable name, the auth mode that will actually be used,
         and how to change it
    And it does not print the variable's value

  Scenario: The empty authMethods case is normal
    Given the Claude Code ACP adapter returns "authMethods": [] from initialize
    Then no warning is emitted
    And the run proceeds, because that empty array is AR-1 working exactly as designed
```

**Notes:** **Verified 2026-08-02:** `@agentclientprotocol/claude-agent-acp@0.64.1` returned
`"authMethods": []` — it is already authenticated from the user's own credential store and needs
nothing from DeFlow. The failure this scenario prevents is the silent one: _"the user thinks they
are on their subscription; they are being billed per token."_ The invariant is that the effective
auth mode of every provider is a recorded, rendered fact.

---

## EPIC-08-S32 — Auth shadowing: the explicit API-key path is recorded too

**Verifies:** KAR-08.8 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: API keys are a first-class alternative, never the default

  Scenario: The user deliberately selects the key path
    Given the provider config for this run selects auth mode "api_key"
    And ANTHROPIC_API_KEY is present in DeFlowd's environment
    When the agent is spawned
    Then ANTHROPIC_API_KEY IS present in the child environment
    And the run manifest records provider.auth_mode "api_key"
    And no "provider.auth_shadow_stripped" event is emitted

  Scenario: The cost report says so
    Then the run report and the cost report both state that this provider ran on an API key
    And the statement is derived from the manifest, not inferred

  Scenario: Copilot's terminal-auth block is surfaced, never executed
    Given Copilot CLI's initialize response contains an authMethods entry whose
          _meta["terminal-auth"] carries a literal { command, args } to run for login
    When DeFlowd handles it
    Then the command is rendered to the operator as a shell command to run themselves
    And the spawn chokepoint recorded zero invocations of it
    And its output is never captured

  Scenario: AR-1 is not softened by the key path
    Then DeFlow still reads no vendor token file
    And the key came from the environment the user configured, not from anything DeFlow stored
```

**Notes:** AR-1 is about DeFlow never _appropriating_ a subscription credential, not about refusing
a key the user deliberately handed over. The Copilot scenario is the sharp edge: _"running a
vendor's login flow on the user's behalf, even without storing the result, is the first step onto
the wrong side of AR-1."_ Print it; let the user run it.

---

## EPIC-08-S33 — The five AR-1 audit checks

**Verifies:** KAR-08.4 · **Type:** Recovery · **Automated at:** integration + contract

```gherkin
Feature: An architectural rule that cannot be checked in five minutes decays

  Scenario: One spawn chokepoint
    When the repository is linted
    Then no-restricted-imports on "node:child_process" allows exactly one file,
         packages/proc/src/spawn.ts
    And a second spawn site fails the build

  Scenario: One environment builder
    When the repository is inspected
    Then buildChildEnv() in packages/proc/src/env.ts is the only function constructing a child env
    And the audit question is "read this one allowlist", not "read the whole daemon"

  Scenario: The credential-path deny test
    Given the Fs port is replaced with a recording double
    When the full mock-agent run suite executes against it
    Then no recorded path matches "**/.claude/**", "**/.codex/**", "**/.config/gh/**",
         "**/.aws/credentials", "**/.ssh/**" or "**/Library/Keychains/**"

  Scenario: The no-provider-SDK test
    When the production dependency closure of the "DeFlow" package is enumerated
    Then it contains no "@anthropic-ai/sdk", no "openai" and no "@google/generative-ai"
    And the direct-API adapter is a separate optional entry point, so inlining it fails this test

  Scenario: The egress test
    Given outbound network is blocked except loopback
    When a full mock-agent run executes
    Then it completes successfully
    And the test doubles as an NF1 regression check

  Scenario: The five results are collectable as evidence
    Then CI publishes the five outcomes in a form that can be pasted into the architecture
         one-pager the team-phase security review needs
```

**Notes:** The threat actor these checks defend against is named explicitly in the security model's
own table: **a future DeFlow contributor** whose well-meaning pull request adds
`process.env.ANTHROPIC_API_KEY` to a child environment "so the adapter works". _"Conventions decay
under time pressure. The five checks belong in CI."_ They live in this epic because four of the five
are assertions about the spawn boundary this epic owns.

---

**Related:** [EPIC-08](../epics/EPIC-08-safety-model.md) · [Board](../board.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[15-security-model.md](../../15-security-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md) ·
[EPIC-07 flows](./EPIC-07-workspace-isolation-flows.md)

[← Back to the delivery plan](../README.md)
