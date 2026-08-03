# EPIC-08: Permission ladder and execution boundary

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-08-safety-model-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-08 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W5b (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~15 days across 8 stories |
| **Depends on** | EPIC-04 (the mock agent and the fake exec-shim agent every mediation test drives), EPIC-05 (the ACP client and its `CLIENT_METHODS` handlers), EPIC-07 (the worktree path that is the scope root) |
| **Blocks** | EPIC-12 (path-scope violations are gate input), EPIC-13 (escalations reach the approval queue) |
| **PRD requirements** | F5.3, F5.4, F5.6, F5.7, F3.8, NF1, NF2, AR-1 |
| **Architecture** | [09-workspace-and-safety.md](../../09-workspace-and-safety.md) §§8–11, [15-security-model.md](../../15-security-model.md) §§1, 2.3, 4, 6 |

## Goal

At the end of this epic there is **one pure function in Karvan's own code** that decides whether any
file write or any command execution proposed by any vendor's agent is allowed, and an execution
boundary around it that removes the authority an agent would need to do real damage before it asks
for permission to try. A run at `worktree` level cannot write outside its worktree, cannot reach the
network, cannot see `AWS_*` or `KUBECONFIG` or the user's ssh agent, cannot run a command that is
not on the repository's own allowlist, and can be stopped — every process in its tree, not just the
one Karvan spawned — by one control that verifies its own success correctly.

## Why this matters

The PRD rates ODW's binary permission model (G6) as **High** and lists *"destructive action at the
execution boundary"* as a **High** risk with the Kiro/AWS incident as its reference failure. The
architecture's reading of that incident is sharper than the PRD's and it is the reason this epic is
shaped the way it is:

> **The approval gate existed and was on by default. It was bypassed because the identity the agent
> ran as had standing production privileges.** The lesson is about **ambient authority**, not about
> adding another review step. A gate you can bypass with ambient IAM is theatre.

So the epic's centre of gravity is KAR-08.4 — building the child environment from an allowlist —
not the human gate. Removing the authority ranks above adding the gate, and the security model says
so in exactly those words.

The second reason this epic is worth its size is that ACP makes it cheap. Karvan is the ACP
*client*, so it implements `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`,
`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and
`terminal/release`. **Karvan sits in the path of every file access and every command execution, for
every vendor.** The ladder therefore collapses from an N-vendors × M-levels flag-mapping matrix —
which would be the PRD's own G7 adapter-churn gap reintroduced inside the safety layer — into one
pure function that is a **fast unit test with no vendor CLI installed at all**. That is a strong
secondary argument for ACP-first and it deserves to be built as such rather than treated as a happy
accident.

## Scope

**In scope:**

- The policy function: `decidePermission(level, request, scope) -> allow | deny | gate`, pure, in
  `@karvan/core`, covering all four levels (`read`, `worktree`, `worktree+net`, `full`) against
  `fs/write_text_file`, `fs/read_text_file`, `terminal/create` and network.
- The `mediatedExecution: true | false` capability bit as the *only* refuse-to-schedule rule — the
  narrowing of F5.4 that replaces per-vendor flag inspection.
- ACP client handlers for the eight `CLIENT_METHODS`, auto-responding from the policy table for
  routine `session/request_permission` calls and escalating only the gated categories.
- `RequestPermissionOutcome` handling including `{outcome: "cancelled"}` as a first-class outcome,
  and the four `PermissionOptionKind` values Karvan offers back.
- Path-scope resolution: `resolve()` plus `realpath()` against the worktree root, rejecting `..`
  traversal, symlinks pointing outside, absolute paths outside, and paths that resolve outside only
  after `realpath`. `additionalDirectories` left empty at `read` and `worktree`.
- Request-time rejection via `ToolCallLocation.path` — the improvement over F5.3's completion-time
  detection.
- The default-deny command allowlist sourced per repo from `karvan.config.ts`, plus the cheap
  syntactic second layer (`git push --force` vs `--force-with-lease`, `git reset --hard` outside the
  worktree, `rm -r` on a path ≤ 2 segments deep, `terraform apply|destroy`, `kubectl delete|apply`,
  `aws|gcloud|az`, `psql|mysql` against a non-localhost host, `prisma migrate deploy`,
  `drizzle-kit push`, `flyway migrate`).
- `buildChildEnv()` in `packages/proc/src/env.ts` — allowlist-based, the only function in karvand
  that constructs a child environment, with the per-run `TMPDIR` override.
- Vendor sandbox policy injection through Claude Code's `--settings '<inline JSON>'` and Codex's
  `sandbox_mode` / `[sandbox_workspace_write]`, including the mandatory `failIfUnavailable: true` and
  `allowUnsandboxedCommands: false` for every non-`full` level, an explicit `sandbox.credentials.files`
  deny list, and version-gated degradation that fails closed.
- `killTree(pid)` — POSIX implementation: `session/cancel` → `process.kill(-pid, 'SIGTERM')` → 5 s →
  `SIGKILL` → 2 s → ledger failure escalation — with kill verification that excludes `Z`-state
  processes.
- Path-scope declaration on write nodes, and violation reporting as a **warning** recorded on the
  node (F5.3 as demoted by D14).
- Auth-shadowing detection and the `provider.auth_shadow_stripped` / `provider.auth_mode` events.
- The five AR-1 CI audit checks from [security model §1.2](../../15-security-model.md).

**Out of scope:**

- Worktree creation, branch naming, `merge-tree` and the worktree-unlock half of orphan reaping —
  [EPIC-07](./EPIC-07-workspace-isolation.md). This epic consumes the worktree path as the scope
  root and owns only the process half of the reaper.
- Cancellation as *scheduling state* (`run.cancel.requested`, the ready-set effect) —
  [EPIC-06](./EPIC-06-orchestrator.md). This epic owns `killTree()`; EPIC-06 decides when to call it.
- The approval-queue UI and the `human.requested` / `human.responded` round trip —
  [EPIC-13](./EPIC-13-human-in-the-loop.md). This epic emits the escalation; EPIC-13 surfaces it.
- Adapter capability probing and the persisted manifest that carries `mediatedExecution` —
  [EPIC-05](./EPIC-05-provider-adapters.md) KAR-05.2. This epic reads the bit.
- `karvan doctor`'s command surface — [EPIC-18](./EPIC-18-cli-packaging.md). The *checks* (git
  version, `bwrap`, `socat`, `kernel.apparmor_restrict_unprivileged_userns`, vendor CLI version
  gating) are specified here and implemented as library functions that `doctor` calls.
- The artifact redactor and export-path redaction (F5.9) — M2, specified in
  [13-observability-and-telemetry.md](../../13-observability-and-telemetry.md).
- Daemon bearer-token auth, `Origin`/`Host` validation and `Vary: Origin` —
  [EPIC-15](./EPIC-15-daemon-api.md) KAR-15.2. It is in the same security document but it is an HTTP
  concern, not an execution-boundary one.
- Container isolation (F5.8) and the fresh-authentication-in-a-named-volume credential pattern — P1,
  M2.
- Windows: `taskkill /pid <pid> /T /F` behind the same `killTree()` seam — M3.

## Definition of Ready (epic level)

- [ ] **EPIC-05 Done through KAR-05.1 and KAR-05.2.** The ACP client dispatches inbound
      `CLIENT_METHODS` to handlers this epic fills in, and the capability manifest carries
      `mediatedExecution`.
- [ ] **EPIC-04 Done.** `karvan-mock-agent` can call back into the client with `fs/read_text_file`,
      `fs/write_text_file` and the full `terminal/*` lifecycle, and can request permission with
      per-option behaviour including `cancelled`.
- [ ] **EPIC-07 Done through KAR-07.2.** A real worktree path exists to be the scope root, so path
      resolution is tested against a real directory with real symlinks.
- [ ] The process-tree kill fixture (`bash -c 'sleep 300 & sleep 300 & sleep 300; wait'`, detached)
      runs on both CI images and the `ps -eo pid,pgid,stat` inspection works on macOS as well as
      Linux.
- [ ] `@agentclientprotocol/sdk@1.3.0`'s `schema/schema.json` is vendored as a test fixture so
      permission-request and tool-call shapes are validated with `ajv` rather than by hand.

## Definition of Done (epic level)

- [ ] All eight stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-08-safety-model-flows.md) exists as an
      automated test at its declared level and passes on `ubuntu-26.04` and `macos-26`.
- [ ] The whole ladder — every level × every mediated method — is covered by unit tests that run
      with **no vendor CLI installed, no credential present and no network reachable**, in under one
      second total.
- [ ] The five AR-1 audit checks are green in CI and their output is collectable as the evidence
      section of the architecture one-pager the PRD's team phase needs.
- [ ] A dedicated test file exists for environment scrubbing, as
      [testing strategy §10](../../14-testing-strategy.md) requires, and it names the Kiro incident
      in its describe block so the reason survives contact with future refactors.
- [ ] Every `Unverified` claim this epic depends on is resolved or carried as a named risk with an
      owner: A5-1 (Claude Code sandbox version gating), A5-2 (macOS 26 Seatbelt regression), A5-3
      (Ubuntu AppArmor and bubblewrap), A5-5 (Codex `ExternalSandbox`), A5-6 (Codex `AskForApproval`
      churn).

## User stories

### KAR-08.1 — The four-level permission ladder as a policy function

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | — |
| **PRD** | F5.4 |
| **Verified by** | EPIC-08-S1, EPIC-08-S2, EPIC-08-S3, EPIC-08-S4, EPIC-08-S5, EPIC-08-S6 |

**As** the daemon, **I want** the entire permission ladder expressed as one pure function over
`(level, request, scope)`, **so that** the safety model is one testable thing rather than a mapping
matrix that decays with every vendor's flag churn.

[§8](../../09-workspace-and-safety.md) is the specification and its table is the function's truth
table:

| Level | `fs/write_text_file` | `terminal/create` | Network |
|---|---|---|---|
| `read` | reject all | reject all non-read-only | deny |
| `worktree` | allow iff `resolve(path)` is inside the node's worktree | allow iff the command passes the allowlist | deny |
| `worktree+net` | same as `worktree` | same as `worktree` | allow, against a domain allowlist |
| `full` | allow within the worktree | allow | allow |

F5.4's *"refuse to schedule where the provider cannot express the level"* is narrowed to **one
capability bit**, `mediatedExecution`, verified from the shipped
`@agentclientprotocol/sdk@1.3.0` type definitions: when the adapter routes `fs/*` and `terminal/*`
through Karvan it is true and Karvan enforces the level itself; when false Karvan can enforce
nothing and refuses to schedule any node above `read`. `full` stays what F5.4 says it is — an
explicit per-run opt-in, never a default, and never acquired by a `PlanPatch`.

**Acceptance criteria**

1. `decidePermission` is a pure function in `@karvan/core` with no import capable of I/O; an
   `import 'node:fs'` anywhere in that package fails the build.
2. Every cell of the four-level table is covered, and the function returns one of exactly three
   outcomes: `allow`, `deny(reason)`, `gate(reason)`.
3. A `read`-level node's `terminal/create` is rejected unless the command is on the read-only subset
   of the allowlist; a `read`-level `fs/write_text_file` is rejected unconditionally, including for
   a path inside its own worktree.
4. An adapter whose manifest reports `mediatedExecution: false` makes any node above `read`
   unschedulable, with a `node.unschedulable` event naming the provider and the bit — not a silent
   downgrade and not a silent escalation.
5. `full` requires an explicit per-run opt-in recorded on the run manifest; a `PlanPatch` that would
   raise a node to `full` is routed to the patch policy engine as requiring approval, never
   auto-applied.
6. Routine permission requests are auto-answered from the policy table with no human involvement;
   only the gated categories from KAR-08.3 reach the operator.
7. `{outcome: "cancelled"}` is handled as a first-class result — the node transitions to cancelled,
   not failed, and no error is constructed.
8. The four `PermissionOptionKind` values Karvan offers back (`allow_once`, `allow_always`,
   `reject_once`, `reject_always`) are validated against the vendored ACP schema.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Truth-table test: 4 levels × {`fs/write`, `fs/read`, `terminal/create`, network} as a table-driven spec | The function does not exist, or a cell is wrong |
| 2 | unit | `read` + `fs/write_text_file` inside its own worktree still denies | `read` is implemented as "worktree minus network" |
| 3 | unit | `mediatedExecution: false` + level `worktree` → unschedulable with the named reason | The bit is read but not enforced |
| 4 | unit | A `PlanPatch` raising level to `full` returns `requires-approval` from the patch policy | `full` is reachable without a run-level opt-in |
| 5 | integration | Mock agent scripted to request permission four ways; `cancelled` yields a cancelled node and no thrown error | `cancelled` is treated as an error outcome |
| 6 | contract | Every permission response Karvan emits validates against `schema/schema.json` with `ajv` | An option shape drifts from the SDK |
| 7 | unit | Package-boundary assertion: `@karvan/core`'s dependency closure contains nothing that can perform I/O | Someone imports `node:fs` "just for a path check" |

---

### KAR-08.2 — Filesystem mediation at the ACP fs boundary

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-08.1, EPIC-07 KAR-07.2 |
| **PRD** | F5.3, F5.4 |
| **Verified by** | EPIC-08-S7, EPIC-08-S8, EPIC-08-S9, EPIC-08-S10, EPIC-08-S11 |

**As** the ACP client, **I want** every `fs/read_text_file` and `fs/write_text_file` resolved against
the node's worktree root before it is honoured, **so that** an agent cannot escape its worktree by
any of the four routes that actually bite.

The four routes are named explicitly in [testing strategy §10](../../14-testing-strategy.md): `..`
traversal, symlinks pointing outside the worktree, absolute paths, and **paths that resolve outside
only after `realpath`**. The last is the one a naive `path.resolve()`-only check misses entirely,
and it is trivially reachable — an agent writes `link` as a symlink to `/etc`, then writes
`link/passwd`. Resolution must therefore be `resolve()` **and** `realpath()` of the deepest existing
ancestor, with the check applied to the result. `NewSessionRequest.additionalDirectories` is left
empty at `read` and `worktree`, so nothing outside the worktree is even nominally in scope. The
improvement over F5.3 is `ToolCallLocation.path` on an inbound permission request: Karvan rejects
the write **before it happens**, with a reason the UI can render, rather than diffing at completion
and calling it a gate failure.

**Acceptance criteria**

1. A write to `../../etc/passwd` from a worktree is denied with reason `path-escape:traversal`, and
   no filesystem write occurs.
2. A write to `<worktree>/link/x` where `link` is a symlink to `/tmp` is denied with reason
   `path-escape:symlink`, verified against a real symlink on a real filesystem.
3. A write to an absolute path outside the worktree is denied with `path-escape:absolute`, and a
   write to an absolute path *inside* the worktree is allowed.
4. A path whose lexical resolution is inside the worktree but whose `realpath` is outside is denied;
   a unit test constructs exactly that case.
5. `fs/read_text_file` at `read` level is allowed inside the worktree and denied outside, so a
   read-only node cannot exfiltrate `~/.aws/credentials` through the ACP read method.
6. `additionalDirectories` is `[]` in every `session/new` request at `read` and `worktree`; a
   contract test asserts the field on the outgoing frame.
7. A denial produces an ACP-valid rejection response *and* a `permission.denied` ledger event
   carrying the level, the method, the requested path and the reason code — the node inspector
   renders that, so it must be structured, not a message string.
8. Denials do not kill the session: the agent receives the rejection and may continue, which the
   mock agent's scripted behaviour exercises.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Path table: `..`, nested `..`, absolute-outside, absolute-inside, `./` noise, a path with a NUL byte | Any single route is unhandled |
| 2 | integration | Real symlink in a real tmpdir pointing outside → denied `path-escape:symlink` | Check is lexical only |
| 3 | unit | Lexically-inside / realpath-outside case → denied | `realpath` is skipped for performance |
| 4 | integration | Mock agent scripted to attempt all four escapes; each yields a rejection and the session survives | A denial tears down the session |
| 5 | contract | `session/new` frame carries `additionalDirectories: []` at `read` and `worktree` | The field is omitted or populated |
| 6 | unit | `permission.denied` event shape snapshot with the normalizing serializer | Reason is a prose string rather than a code |

**Notes / risks** — On a case-insensitive filesystem (APFS), `<worktree>/SRC` and `<worktree>/src`
are the same directory; the containment check must not assume case-sensitive prefix matching. This
is the same A5-7 family as EPIC-07's id normalization.

---

### KAR-08.3 — Command mediation and the default-deny allowlist

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-08.1 |
| **PRD** | F5.6 |
| **Verified by** | EPIC-08-S12, EPIC-08-S13, EPIC-08-S14, EPIC-08-S15 |

**As** the operator, **I want** commands allowlisted per repository with a cheap syntactic second
layer, and everything else routed to a human gate, **so that** the destructive-action risk is
bounded without producing a gate that fires so often I stop reading it.

Deny-lists lose: `rm -rf /` has infinite spellings — `rm -fr`, `$(echo rm) -rf`, `find / -delete`, a
shell script, a Makefile target, a `postinstall` hook. So [§10.3](../../09-workspace-and-safety.md)
allowlists the project's actual verbs (`git`, `pnpm`, `npm`, `node`, `pytest`, `make`, `cargo`,
`go`, `tsc`, `eslint`), sourced per repo from `karvan.config.ts`, and routes everything else to a
human gate. Layer two is deliberately **not** static analysis of shell strings — that is undecidable
and gives false confidence — but a small set of cheap, high-signal syntactic checks that force a
gate even for an allowlisted binary. The frequency argument in [§10.5](../../09-workspace-and-safety.md)
is a design constraint, not commentary: **a gate that fires 200 times in a run is auto-clicked, and
is worse than no gate.** The practical rule is that a command is gated if it (a) is not on the
allowlist, (b) reaches a non-localhost host, or (c) requires an environment variable that was
scrubbed. Everything else runs free inside the worktree.

**Acceptance criteria**

1. `terminal/create` for a command whose binary is not on the repository allowlist returns `gate`,
   emits `human.requested` with the full `{command, args, cwd}` rendered, and the terminal is not
   created until the operator responds.
2. An allowlisted binary running inside the worktree at `worktree` level is allowed with no
   escalation and no human event.
3. The syntactic second layer forces a gate for each of: `git push --force`, `git push -f`,
   `git reset --hard <path outside the worktree>`, `rm -r` on a path ≤ 2 segments deep,
   `terraform apply`, `terraform destroy`, `kubectl delete`, `kubectl apply`, `aws`, `gcloud`, `az`,
   `psql`/`mysql` with a non-localhost host, `prisma migrate deploy`, `drizzle-kit push`,
   `flyway migrate`.
4. `git push --force-with-lease` on a `karvan/` ref is **allowed**, so the safe form is not
   collateral damage.
5. A command requiring an environment variable that KAR-08.4 scrubbed is gated with reason
   `scrubbed-env:<VARNAME>`, rather than being allowed to run and fail confusingly.
6. Network egress at `worktree+net` is checked against a domain allowlist; a request to a
   non-allowlisted domain is gated, and at `worktree` all egress is denied outright.
7. A representative fixture run at `worktree` level produces **zero** human gates; the gate budget
   is asserted in the test, so an allowlist that is too narrow fails CI rather than training the
   operator to auto-click.
8. Denied and gated decisions are recorded as `permission.denied` / `human.requested` events with a
   structured reason code, never a prose blob.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Allowlist table over 20 commands from a fixture `karvan.config.ts`, including a binary with a path prefix (`./node_modules/.bin/vitest`) | Matching is on the raw string rather than the resolved binary |
| 2 | unit | Syntactic-layer table with the full gated set plus `--force-with-lease` as the allowed control | Any check missing, or `--force-with-lease` wrongly gated |
| 3 | unit | `rm -r` depth check: `/`, `/usr`, `/usr/local` gated; `<worktree>/a/b/c` allowed | Depth counted on the string rather than on resolved segments |
| 4 | unit | `psql postgres://localhost/x` allowed; `psql postgres://db.prod/x` gated | Host extraction naive |
| 5 | integration | Mock agent requests a non-allowlisted command; assert `human.requested`, then that no terminal exists until a response arrives | The terminal is created optimistically |
| 6 | integration | **Gate budget:** a scripted 30-command fixture run emits zero gates | The allowlist is too narrow and the design's frequency premise is broken |

**Notes / risks** — An LLM-judge classifier over proposed commands (Claude Code's `auto` permission
mode does this) is a useful *additional* signal but never the only gate for a destructive operation:
it is probabilistic and its failure mode is silent. Out of scope for M1.

---

### KAR-08.4 — Child environment scrubbing

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | — |
| **PRD** | F5.6, NF2, AR-1 |
| **Verified by** | EPIC-08-S16, EPIC-08-S17, EPIC-08-S18, EPIC-08-S19, EPIC-08-S33 |

**As** the operator, **I want** the agent's environment built from an allowlist rather than
inherited, **so that** a prompt-injected agent that gets as far as running a command finds no
credential to use it with.

**This is the control that would actually have prevented the Kiro incident**, and
[security model §4](../../15-security-model.md) is explicit that it *ranks above* the human gate:
the approval gate at AWS existed and was on by default, and it was bypassed because the identity the
agent ran as carried standing production privileges. Removing the authority beats adding the review
step. `buildChildEnv()` in `packages/proc/src/env.ts` is the only function in karvand that
constructs a child environment; it starts from `{}` and adds `HOME`, `USER`, `LOGNAME`, `SHELL`
(which the vendor binary needs to find its own credential store — AR-1 working), `PATH` resolved
from the user's login shell at daemon start rather than karvand's inherited one, `LANG`/`LC_*`/`TZ`/
`TERM`, a `TMPDIR` **overridden** to a per-run directory, vendor config-dir variables only when the
user set them, and explicitly declared per-node variables. Everything else is dropped. Two details
are easy to get wrong: `SSH_AUTH_SOCK` is dropped from *agent* environments but **kept** for
Karvan's own git invocations, because the agent never pushes and the `Git` wrapper does; and the
allowlist is a per-node, per-level decision, not a global one.

**Acceptance criteria**

1. `buildChildEnv()` starts from an empty object; a test asserts that a variable present in
   `process.env` and not on the allowlist is absent from the result.
2. Every family in the never-implicit list is absent from a constructed agent environment:
   `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*`, `KUBECONFIG`, `DATABASE_URL`,
   `DATABASE_*`, `TF_*`, `TERRAFORM_*`, `VAULT_*`, `DOCKER_*`, `REGISTRY_*`, `SSH_AUTH_SOCK`,
   `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`.
3. `TMPDIR` in the child environment points at a per-run directory that exists and is mode `0700`,
   and differs between two concurrent runs.
4. `PATH` is the login-shell `PATH` resolved once at daemon start, not `process.env.PATH`.
5. `SSH_AUTH_SOCK` is absent from every agent environment and present in `gitChildEnv()`.
6. A node at `worktree+net` that declares `NPM_TOKEN` receives it, and the declaration is recorded
   as an `env.declared` ledger event that names the variable but never its value; the run report
   renders it.
7. `buildChildEnv()` is the only function constructing a child `env`; a lint rule and a grep both
   enforce it.
8. The scrubbing test file exists as a dedicated file and names the Kiro incident in its describe
   block.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Seed `process.env` with one variable per never-implicit family; assert each is absent from the built env | Deny-list logic, or a family missed |
| 2 | unit | Assert the kept set is exactly the allowlist, no more — a snapshot of `Object.keys(env).sort()` | Something leaks in via a spread |
| 3 | integration | Fake agent binary prints `process.env` as JSON; assert on what the *child* actually received, not on what Karvan constructed | Karvan builds the env correctly and then merges `process.env` at spawn |
| 4 | integration | Two concurrent runs → two distinct `TMPDIR` values, both mode `0700` | `TMPDIR` inherited or shared |
| 5 | unit | `gitChildEnv()` retains `SSH_AUTH_SOCK`; `buildChildEnv()` drops it | The two builders were unified "for simplicity" |
| 6 | integration | Declared `NPM_TOKEN` reaches the child; `env.declared` event carries the name and not the value | Value logged into the ledger |
| 7 | unit | Wildcard matching: `MY_CUSTOM_TOKEN`, `x_api_key` (lowercase), `AWS_PROFILE` all dropped | Matching is exact-name rather than family-pattern, or case-sensitive |

**Notes / risks** — Test 3 is the one that catches the real bug. Building the env correctly and then
handing `spawn` an options object that spreads `process.env` underneath it is an easy mistake and a
unit test over `buildChildEnv()` alone cannot see it. Assert on what the child *received*.

---

### KAR-08.5 — Vendor sandbox policy injection

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-08.1, EPIC-05 KAR-05.2 |
| **PRD** | F5.4, F5.6 |
| **Verified by** | EPIC-08-S20, EPIC-08-S21, EPIC-08-S22, EPIC-08-S23, EPIC-08-S24, EPIC-08-S25 |

**As** the daemon, **I want** each node's sandbox policy injected as inline JSON on the vendor CLI's
command line, **so that** per-node policy is possible without Karvan ever reading or writing the
operator's own settings files.

**Decision D12**: Karvan does not build a sandbox — it owns policy and mediation, the vendor CLI
owns enforcement. The crucial integration fact is that Claude Code accepts
`--settings '<inline JSON>'`, so a complete per-run sandbox policy goes on the command line as a
string. That is what makes per-node policy compatible with AR-1 and with "Karvan must not mutate the
user's vendor CLI configuration". Two keys are mandatory for every non-`full` level:
**`failIfUnavailable: true`** and **`allowUnsandboxedCommands: false`** — without them the CLI
*silently degrades*, running unsandboxed when bubblewrap and socat are missing or the platform is
unsupported, and letting the model retry a sandbox-failed command outside the sandbox via
`dangerouslyDisableSandbox`. **Without these two keys the permission ladder is decorative.** Also:
Claude Code's default read policy permits `~/.aws/credentials` and `~/.ssh/`, and there is no
built-in credential deny list, so `sandbox.credentials.files` must be populated explicitly. Sandbox
settings are version-gated at fine granularity, and Karvan must detect the CLI version and **degrade
the ladder explicitly or fail closed — never silently**.

**Acceptance criteria**

1. The sandbox policy is passed as `--settings '<json>'` on the spawn argv; no file under
   `~/.claude`, `~/.codex` or any user config directory is opened or written on any code path — the
   `Fs`-port deny test proves it.
2. For every level except `full`, the emitted JSON contains `sandbox.enabled: true`,
   `sandbox.failIfUnavailable: true` and `sandbox.allowUnsandboxedCommands: false`.
3. `sandbox.credentials.files` explicitly denies `~/.aws/credentials`, `~/.ssh/**`,
   `~/.config/gh/**` and `~/Library/Keychains/**`, with `mode: deny`.
4. The level mapping is emitted correctly for both CLIs: `read` → Claude filesystem read-only with
   no `allowedDomains` / Codex `read-only`; `worktree` → `allowWrite` = cwd / `workspace-write` with
   `network_access = false`; `worktree+net` → adds `network.allowedDomains` / `network_access = true`;
   `full` → `bypassPermissions` / `danger-full-access`.
5. With `bwrap` absent from `PATH` on Linux, a `worktree` node **fails to start** with a typed error
   naming bubblewrap — it does not run unsandboxed.
6. A detected Claude Code version below a feature's gate (`credentials` ≥ 2.1.187, `mask` ≥ 2.1.199,
   `filesystem.disabled` ≥ 2.1.216, `strictAllowlist` ≥ 2.1.219) either omits that key and records a
   `sandbox.degraded` event naming the key and the required version, or refuses to schedule —
   configurable, defaulting to refuse for anything credential-related.
7. Karvan never wraps a self-sandboxing CLI in its own bubblewrap or Seatbelt profile; for CLIs with
   no native sandbox (Gemini, Copilot, Cursor, OpenCode) it uses
   `@anthropic-ai/sandbox-runtime@0.0.67`, pinned exactly.
8. The generated policy JSON for each level is a golden file, so a change to it shows as a readable
   diff in a pull request.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Policy generator golden files, one per level per vendor, with the normalizing serializer for paths | Generator not implemented, or a mandatory key missing |
| 2 | unit | Assert `failIfUnavailable` and `allowUnsandboxedCommands` present for `read`, `worktree`, `worktree+net` and deliberately absent-or-relaxed for `full` | Either key unset — the ladder is decorative |
| 3 | integration | Fake `claude` shim on tmp `PATH` echoing its argv; assert `--settings` carries parseable JSON equal to the golden | Policy written to a file instead |
| 4 | integration | `Fs`-port recording double over a full mock-agent run: zero paths match `**/.claude/**`, `**/.codex/**` | Settings read from the user's config |
| 5 | integration | `PATH` without `bwrap` on Linux → node fails to start with a typed bubblewrap error | Silent unsandboxed fallback |
| 6 | unit | Version-gate table across the four gated keys → omit-and-record or refuse, never silently include | A key is emitted to a CLI that does not understand it |
| 7 | unit | Sandbox-strategy selection: vendor-with-sandbox → delegate; vendor-without → `sandbox-runtime`; never both | Nested sandboxing |

**Notes / risks** — **A5-2 (High, macOS):** macOS 26 Tahoe broke Seatbelt profiles in practice — zsh
5.9 reads `hw.*` sysctls that are not in the allowlist, causing sandbox init failures across Claude
Code and Cursor. `sandbox-exec` itself still works; the profiles regressed. **Test on Tahoe before
promising `worktree`-level enforcement on current macOS.** **A5-5 (upside):** Codex's
`SandboxPolicy::ExternalSandbox { network_access }` would let Codex skip its own sandbox when Karvan
provides isolation, avoiding nesting entirely; how to select it is unverified — investigate during
W5, it could meaningfully simplify this story.

---

### KAR-08.6 — The kill switch and process-tree termination

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | EPIC-05 KAR-05.9 |
| **PRD** | F5.7 |
| **Verified by** | EPIC-08-S26, EPIC-08-S27, EPIC-08-S28, EPIC-08-S29 |

**As** the operator, **I want** one control that stops every child process in a run immediately and
verifies it actually happened, **so that** "stop" means stopped rather than "the process I knew
about exited and three grandchildren are still compiling".

[§11](../../09-workspace-and-safety.md), all of it verified by running it on Linux on 2026-08-02.
`detached: true` is **mandatory** at spawn: on POSIX it makes the child a process-group leader with
`pgid === child.pid`, and a child spawning two grandchildren showed all four processes sharing that
pgid. `process.kill(-child.pid, sig)` — **note the negative pid** — signals the whole group; the
positive form killed only the direct child and left both grandchildren alive, reparented to PID 1.
The escalation ladder is: protocol-level `session/cancel` (or ACP `terminal/kill`) so the agent can
flush its final `session/update`s and answer `stopReason: "cancelled"` → `SIGTERM` to the group →
5 s grace → `SIGKILL` → 2 s → report failure to the ledger, because a kill that did not take is an
event, not a silent condition. And then the trap that costs hours, in KAR-08.6's verification step
and in [EPIC-08-S27](../flows/EPIC-08-safety-model-flows.md): **after a successful group SIGKILL,
`ps` still lists the grandchildren in state `Z`.**

**Acceptance criteria**

1. `killTree(pid)` is the single seam for process-tree termination; the POSIX implementation uses
   the negative pgid and there is no other `process.kill` call site outside it.
2. The escalation ladder runs in order with the specified timings — `session/cancel`, `SIGTERM`,
   5 s, `SIGKILL`, 2 s — and each step is recorded as a ledger event with its elapsed time.
3. A fake agent that ignores `SIGTERM` is killed by the `SIGKILL` step, and the ledger shows the
   escalation rather than a clean cancel.
4. Kill verification excludes `Z`-state processes:
   `ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'` returns empty on success, and a
   test asserts that the naive check *without* the `Z` filter would have reported failure.
5. A regression test asserts that `process.kill(child.pid, ...)` with a **positive** pid leaves
   grandchildren alive with `ppid = 1` — this is the test that stops anyone "simplifying" the kill
   path.
6. A kill that still has non-`Z` group members after the `SIGKILL` grace period emits
   `run.kill_failed` with the surviving pids; it never returns success optimistically.
7. Timeouts are driven by the injected `Clock`; no test in this story uses `vi.useFakeTimers()`
   while a child process is alive.
8. execa's `kill()`, `forceKillAfterDelay` and `cleanup` are unused for agent processes, and a grep
   asserts it — all three are documented to behave contrary to their names for detached groups.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Spawn `bash -c 'sleep 300 & sleep 300 & sleep 300; wait'` detached; assert `pgid === child.pid` for all four processes | `detached: true` missing |
| 2 | integration | Group SIGTERM → all four gone (excluding `Z`) within the grace period | Negative pid not used |
| 3 | integration | **Regression:** positive-pid kill leaves two grandchildren alive with `ppid = 1` | Someone simplifies to `child.kill()` |
| 4 | integration | **Zombie false-negative:** after a successful group SIGKILL, the unfiltered `ps` lists grandchildren in state `Z`; the filtered check returns empty. Assert both | The `Z` filter is dropped and the test becomes an intermittent CI flake |
| 5 | integration | Fake agent ignoring SIGTERM → SIGKILL step fires after the grace period; ledger shows both steps with elapsed times | Escalation implemented via execa's `forceKillAfterDelay`, which does not fire when an explicit signal is passed |
| 6 | integration | Simulated survivor (a process that cannot be killed within the window) → `run.kill_failed` with pids | Kill returns success without verifying |
| 7 | unit | Grep assertion: no `process.kill` outside `killTree`, no execa `kill`/`forceKillAfterDelay`/`cleanup` on agent paths | A second kill site appears |

**Notes / risks** — Zombie reaping is prompt under launchd and systemd but **can lag badly inside
containers**, so this bites hardest in CI, where an intermittently-failing kill-switch test is the
least welcome kind of flake. That is precisely why the `Z` exclusion is an acceptance criterion and
not a comment.

---

### KAR-08.7 — Path-scope declaration and violation reporting

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-08.2 |
| **PRD** | F5.3 |
| **Verified by** | EPIC-08-S11, EPIC-08-S30 |

**As** the planner and the operator, **I want** write nodes to declare the paths they intend to
modify, and violations recorded as warnings rather than gates, **so that** declared scope stays a
useful plan-time signal without becoming the thing merges depend on.

D14 demotes F5.3 deliberately, and [§6.3](../../09-workspace-and-safety.md) states the split
precisely: declared path scopes are **plan-time admission control** — a *prediction*, dependent on
agent compliance, whose violation is a **warning** recorded on the node — while
`merge-tree --write-tree` is **run-time gating**, *ground truth*, requiring zero agent cooperation,
whose conflict is a **gate**. The one place declared scope still bites hard is at request time:
`ToolCallLocation.path` on an inbound `session/request_permission` lets Karvan reject an
out-of-scope write **before it happens**, with a reason the UI can render — strictly better than the
PRD's "violations are detected on completion".

**Acceptance criteria**

1. A write node's `pathScope` is a list of globs validated at plan time; an empty scope on a write
   node fails plan validation.
2. A `session/request_permission` carrying a `ToolCallLocation.path` outside the node's declared
   scope is rejected at request time with reason `scope-violation`, and the rejection is rendered
   with the requested path and the declared globs.
3. A write that lands outside the declared scope without a preceding permission request (an adapter
   that does not populate `ToolCallLocation`) is detected on node completion by diffing the worktree
   and recorded as `node.scope_warning` — a warning, not a gate, and the node still completes.
4. Two nodes whose declared scopes overlap are **not** serialized on that basis alone
   ([EPIC-07](./EPIC-07-workspace-isolation.md) KAR-07.6 owns that decision); only the identical
   single-file case is refused at plan time.
5. `node.scope_warning` events are queryable per run and render on the node inspector, so a node
   with a chronic scope habit is visible rather than folklore.
6. Scope checks are path-normalized the same way as KAR-08.2's containment check, so `./src/a.ts`,
   `src/a.ts` and `<worktree>/src/a.ts` are one path.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Glob-scope matcher table including `src/**`, `!src/generated/**`, a bare filename and a trailing-slash directory | Matcher does not handle negation or directories |
| 2 | unit | Plan validation rejects a write node with an empty `pathScope` | Validation missing |
| 3 | integration | Mock agent requests permission with `ToolCallLocation.path` outside scope → rejected at request time, no write occurs | Detection deferred to completion |
| 4 | integration | Adapter with no `ToolCallLocation`; agent writes out of scope → node completes with `node.scope_warning`, no gate | Violation escalated to a gate, contradicting D14 |
| 5 | unit | Two nodes with overlapping globs are both admitted by plan validation | Static serialization reintroduced |

---

### KAR-08.8 — Auth-shadowing detection

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P1 |
| **Size** | S |
| **Depends on** | KAR-08.4 |
| **PRD** | F3.8, AR-1 |
| **Verified by** | EPIC-08-S31, EPIC-08-S32 |

**As** the operator, **I want** to be told loudly when an environment variable is about to shadow my
subscription auth, **so that** I never discover from a bill that I was being charged per token for
work I thought my subscription covered.

`ANTHROPIC_API_KEY` present in the environment **silently shadows subscription auth** in Claude
Code. [Security model §2.3](../../15-security-model.md) makes this a detectable condition with three
surfaces: at `karvan doctor`, report every provider whose environment contains an auth-shadowing
variable, naming the variable and stating which credential will actually be used; at run start, if a
node's provider config selects subscription auth but a shadowing variable is present in karvand's
own environment, **strip it from the child environment** and record
`provider.auth_shadow_stripped`; and when the user has explicitly selected the API-key path, pass it
through and record `provider.auth_mode = "api_key"` on the run manifest. The invariant is that *the
effective auth mode of every provider is a recorded, rendered fact, and never something the user has
to infer from a bill.* This story is P1 because F3.8 is P1 in the PRD — but its stripping half is
already implemented by KAR-08.4's allowlist, so what remains is detection and reporting.

**Acceptance criteria**

1. With `ANTHROPIC_API_KEY` set in karvand's environment and a node configured for subscription
   auth, the variable is absent from the child environment and a `provider.auth_shadow_stripped`
   event names the variable and the provider.
2. With the API-key path explicitly selected for that provider, the variable is passed through and
   the run manifest records `provider.auth_mode: "api_key"`; the cost report and the run report both
   say so.
3. The shadowing variable set covers at least `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
   `GEMINI_API_KEY`/`GOOGLE_API_KEY`, and is data rather than code so a new one is a one-line
   addition.
4. The doctor check reports, per provider: the variable name, the auth mode that will actually be
   used, and how to change it — and it does not print the variable's value.
5. Copilot CLI's `authMethods` entry carrying an `_meta["terminal-auth"]` block is surfaced to the
   operator as a **shell command to run themselves**; Karvan never runs it and never captures its
   output.
6. `claude-agent-acp@0.64.1` returning `"authMethods": []` is treated as the normal, expected,
   AR-1-working case and produces no warning.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Fake agent prints its env; with `ANTHROPIC_API_KEY` set and subscription auth selected, the key is absent and the event is appended | Stripping is only in `buildChildEnv` and never reported |
| 2 | integration | API-key path selected → key present in the child, `provider.auth_mode: "api_key"` on the manifest | The two paths are not distinguished |
| 3 | unit | Doctor report snapshot; assert the value never appears in the output | The value is printed for "helpfulness" |
| 4 | unit | An `authMethods` entry with `_meta["terminal-auth"]` renders as an instruction; assert no spawn occurs | Karvan runs the vendor's login flow |
| 5 | unit | `authMethods: []` produces no warning | The empty case is treated as an error |

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **A5-1: Claude Code's sandbox settings are version-gated at fine granularity** (`credentials` ≥ 2.1.187, `mask` ≥ 2.1.199, `filesystem.disabled` ≥ 2.1.216, classifier routing ≥ 2.1.218, `strictAllowlist` ≥ 2.1.219). A key emitted to an older CLI may be ignored silently. | **High** | KAR-08.5 AC 6 — version-sniff and **fail closed**, defaulting to refuse for anything credential-related. Plus `failIfUnavailable: true` and `allowUnsandboxedCommands: false` on every non-`full` level, without which the ladder is decorative. |
| **A5-2: macOS 26 Tahoe broke Seatbelt profiles in practice.** Whether Claude Code 2.1.220 fixes it is unverified. | **High (macOS)** | Test on Tahoe **before** promising `worktree`-level enforcement on current macOS. If it is still broken, the honest position is that macOS `worktree` enforcement rests on Karvan's own mediation layer alone, and the UI must say so rather than implying an OS boundary that is not there. |
| **A5-3: Ubuntu 24.04+ AppArmor blocks bubblewrap's unprivileged user namespaces by default**, silently breaking Linux sandboxing. | Medium | A `doctor` check for `kernel.apparmor_restrict_unprivileged_userns` with instructions for an `/etc/apparmor.d/bwrap` profile, plus KAR-08.5 AC 5 — a missing bwrap fails the node rather than degrading it. |
| **A5-6: Codex's `AskForApproval` now has a `Granular` variant and `on-failure` is merely an alias for `on-request`** — newer than most documentation and actively churning. | Medium | A direct argument for the ACP path over flag-driving Codex. KAR-08.1's `mediatedExecution` bit means Karvan's enforcement does not depend on getting these flags right. |
| **The gate-frequency premise could be wrong on a real repository.** If the allowlist misses common verbs, the operator gets trained to auto-click. | Medium | KAR-08.3 AC 7 makes the gate budget an assertion in CI on a representative fixture run. If it fails, the allowlist is the bug — not the operator. |
| **`full` level is explicitly not a sandbox**, and defending the user against themselves at `full` is out of scope. | Low | Say it in the same honest words ODW uses, in the UI at the point of opt-in, not only in a document. |
| **Prompt-injected agent reaching the daemon control plane** — an agent Karvan spawned can reach `127.0.0.1:7777`. | Medium | Not this epic: the bearer token is [EPIC-15](./EPIC-15-daemon-api.md) KAR-15.2. Flagged here because the threat model pairs the two, and neither control is sufficient alone. |

---

**Related:** [Flows](../flows/EPIC-08-safety-model-flows.md) · [Board](../board.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[15-security-model.md](../../15-security-model.md) ·
[EPIC-07 workspace isolation](./EPIC-07-workspace-isolation.md)

[← Back to the delivery plan](../README.md)
