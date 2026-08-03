# ADR 0013: Delegate sandboxing to the vendor CLIs; DeFlow owns policy and mediation

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

ODW's binary permission model (`default` or `dangerously-full-access`) is gap G6, and its docs are
commendably honest that the second is not a sandbox. DeFlow needs a graduated ladder — `read`,
`worktree`, `worktree+net`, `full` (F5.4) — with a real enforcement story behind each rung.

The tempting move is to build one: wrap every vendor CLI in a bubblewrap or `sandbox-exec` profile
DeFlow controls, and get uniform enforcement regardless of vendor. **That move breaks a working
sandbox.**

**Both major CLIs already ship real, per-platform OS-level sandboxes**, and they are good:

- **Claude Code** (`@anthropic-ai/claude-code@2.1.220`): Seatbelt on macOS; **bubblewrap + socat** on
  Linux/WSL2, with an optional seccomp filter via `@anthropic-ai/sandbox-runtime`. Configurable
  through `--settings '<inline JSON>'` — the CLI accepts an inline JSON string, so **DeFlow can
  inject a complete per-run sandbox policy without ever touching the user's settings files.** That
  is the single most important integration fact for AR-1 compliance.
- **Codex** (`@openai/codex@0.146.0`): `sandbox-exec`/Seatbelt on macOS; **Landlock LSM + seccomp-bpf**
  on Linux. Modes `read-only`, `workspace-write`, `danger-full-access`, with
  `[sandbox_workspace_write]` keys `writable_roots`, `network_access`, `exclude_tmpdir_env_var`,
  `exclude_slash_tmp` (read from the Rust source, `codex-rs/protocol/src/protocol.rs`).

Nesting your own profile around those does not add a layer — it removes one. Claude Code's own
documentation states that bubblewrap fails inside an unprivileged container and requires
`enableWeakerNestedSandbox`, which they warn _considerably weakens security_. You would be trading a
working, vendor-maintained, per-platform sandbox for a broken nested one that you now maintain.

Meanwhile [ADR 0004](./0004-acp-first-adapter-layer.md) hands us something better than enforcement
primitives. As the ACP client, DeFlow implements `session/request_permission`, `fs/read_text_file`,
`fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
`terminal/kill` and `terminal/release`. **DeFlow sits in the path of every file access and every
command execution, for every vendor.**

## Decision

**Four layers. DeFlow owns 1 and 3, the vendor owns 2, the user opts into 4. DeFlow does not build
a sandbox.**

| Layer                                          | Owner                          | What it is                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Filesystem scope + process containment** | DeFlow, always on, free        | The worktree _is_ the primary boundary. Spawn each CLI with `cwd` = the worktree, `detached: true`, a scrubbed env, and a per-run `TMPDIR`.                         |
| **2 — OS-level sandbox**                       | Vendor CLI                     | Drive it, do not duplicate it. Inject policy per run via Claude Code's inline `--settings` JSON or Codex's `-s` and `[sandbox_workspace_write]`.                    |
| **3 — Mediated execution**                     | DeFlow, the real control point | Every command arrives at the ACP `terminal/create` handler _before_ it runs, with `command`, `args`, `cwd`, `env`. That is where the ladder and the allowlist live. |
| **4 — Container**                              | User, opt-in, P1               | Devcontainers via `@devcontainers/cli@0.88.0`.                                                                                                                      |

Layer 3 is what makes the ladder a **pure function evaluated identically for every vendor**, rather
than an N-vendors × M-levels flag matrix:

| Level          | `fs/write_text_file`                             | `terminal/create`                   | Network                  |
| -------------- | ------------------------------------------------ | ----------------------------------- | ------------------------ |
| `read`         | reject all                                       | reject all non-readonly             | deny                     |
| `worktree`     | allow iff `resolve(path)` is inside the worktree | allow iff the command passes policy | deny                     |
| `worktree+net` | same                                             | same                                | allow (domain allowlist) |
| `full`         | allow in worktree                                | allow                               | allow                    |

Two non-obvious configuration rules for layer 2: set `failIfUnavailable: true` and
`allowUnsandboxedCommands: false` for **any** level below `full`. Otherwise the CLI silently falls
back to unsandboxed on a missing dependency, and the model can retry commands outside the sandbox
via `dangerouslyDisableSandbox`.

**Refuse-to-schedule (F5.4) narrows to one genuine case.** As literally specified — inspect each
vendor's flags and refuse if the vendor cannot express the level — it is impractical and recreates
G7's flag-churn burden. Under ACP, DeFlow enforces the level itself regardless of vendor capability.
So refusal applies only when _the adapter does not support ACP-mediated fs/terminal at all_, encoded
as a single `mediatedExecution: true|false` boolean on the capability manifest.

The command policy at `terminal/create` is **default-deny allowlist, not deny-list** — `rm -rf /`
has infinite spellings, and the allowlist is the project's actual verbs (`git`, `pnpm`, `npm`,
`node`, `pytest`, `make`, `cargo`, `go`, `tsc`). Full policy, the Kiro/AWS analysis, the env
scrubbing rules and the kill switch are in
[09-workspace-and-safety.md](../09-workspace-and-safety.md).

## Consequences

### Positive

- DeFlow inherits two well-maintained, per-platform OS sandboxes and keeps inheriting their fixes.
- **The whole permission ladder is unit-testable with zero vendor CLIs installed**, because a fake
  ACP _agent_ can issue the `fs/*` and `terminal/*` calls
  ([ADR 0017](./0017-mock-agent-binary-as-a-shipped-package.md)). For a solo author this is the
  decisive practical argument.
- Policy injection via inline `--settings` JSON means DeFlow **never mutates the user's vendor CLI
  configuration** — required by AR-1's posture, not merely polite.
- `ToolCallLocation.path` from the ACP schema gives path-scope enforcement _at request time_ rather
  than as post-hoc detection.

### Negative

- Enforcement quality varies by vendor at layer 2. Gemini, Copilot, Cursor and OpenCode have no
  comparable native sandbox, so those runs rely on layers 1 and 3 alone. Documented, and the fallback
  is `@anthropic-ai/sandbox-runtime@0.0.67` — Anthropic's standalone extraction of the same
  Seatbelt/bubblewrap machinery, which can wrap an arbitrary process. It is 0.0.x; pin exactly.
- Layer 3 is only as good as the allowlist. A deliberately hostile agent inside a worktree with an
  allowlisted `node` binary can do a lot. Layers 1 and 2 are what bound that, which is why they are
  not optional.
- We depend on vendor sandbox flags remaining stable — the same churn risk as everywhere else in the
  adapter layer, and covered by the same conformance suite (F3.4).

### Neutral

- Container isolation stays P1. **The credential story is the opposite of what it first appears**:
  do **not** bind-mount `~/.claude`. Anthropic's documented path is to authenticate fresh _inside_
  the container and persist it in a named volume
  (`source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume` plus
  `containerEnv: { CLAUDE_CONFIG_DIR: "/home/node/.claude" }`), which **isolates** container
  credentials from the host keychain and therefore strengthens AR-1 rather than weakening it.

## Alternatives considered

- **Build a DeFlow sandbox profile (bwrap / `sandbox-exec`) and wrap every CLI in it.** Rejected:
  nesting sandboxes needs `enableWeakerNestedSandbox`, which Anthropic explicitly warns weakens
  security. You end up maintaining a worse sandbox that fights theirs.
- **Container-per-agent as the default isolation.** Rejected as a default: requires Docker (against
  NF6), and it is P1 precisely because the worktree plus vendor sandbox already covers most of the
  risk.
- **Dagger `container-use`.** Studied, not adopted. It is an **MCP server the agent drives**, so the
  _agent_ chooses its own isolation — architecturally backwards for an orchestrator whose job is to
  impose isolation.
- **Deny-list of dangerous commands.** Rejected as the primary mechanism: undecidable in general and
  it gives false confidence. Retained as a cheap _second_ layer of syntactic checks that force a
  gate even for allowlisted binaries (`git push --force`, `terraform destroy`, `kubectl delete`,
  `psql` with a non-localhost host).
- **Refuse to schedule per the PRD's literal wording.** Rejected: it recreates the flag-churn
  maintenance burden G7 describes, and ACP mediation makes it unnecessary.

## Revisit when

Any of these, each checkable:

1. **A vendor removes or fundamentally changes its sandbox**, or removes the ability to inject
   policy without touching user config (e.g. Claude Code drops inline `--settings` JSON). That
   removes the mechanism this decision rests on. Covered by the conformance suite, which should
   assert policy injection still works per adapter version.
2. **Apple `container` becomes cross-platform-viable.** It is at **1.2.0** (2026-07-29), with 1.1.0
   on 2026-07-06 — three releases in under two months, so **track it quarterly, not annually**.
   Currently macOS 26 + Apple Silicon only, which is why the P1 deferral stands.
3. **A majority of scheduled nodes run on adapters with `mediatedExecution: false`.** At that point
   layer 3 is not covering the fleet and layer 2 substitutes must be taken seriously — i.e. wrapping
   the sandbox-less CLIs in `@anthropic-ai/sandbox-runtime` becomes the default rather than a
   fallback.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
