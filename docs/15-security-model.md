# Security model

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

---

This document states what DeFlow guarantees, what it does not, and who it is defending against.

The mechanisms live elsewhere: worktree isolation, the permission ladder, the command allowlist, the
sandbox layering and the kill switch are all specified in
[workspace and safety](./09-workspace-and-safety.md). This document is the threat model above them,
plus the two controls that belong nowhere else — **AR-1 as a verifiable property** and **daemon
authentication**.

Nothing here is optional. AR-1 is the constraint the whole architecture was derived from
(PRD §5), and NF2 requires it to be _verifiable by inspection_, which means it has to be stated as
something a person can actually check.

---

## 1. AR-1, restated as a property you can test

> **AR-1 (inviolable).** DeFlow never possesses a model credential. It launches the vendor's own
> official binary as a child process, on the user's own machine, under the user's own OS account,
> using the credentials that binary already stored for itself.

The PRD phrases the consequence in three clauses. Each is a testable property, not an aspiration:

| Clause                                       | Property                                                                                                                                              | How it is enforced                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeFlow reads no token file**               | No code path in DeFlowd opens a vendor credential store                                                                                               | All filesystem access goes through one `Fs` port; a deny-glob is asserted in tests (§1.2)                                                                                    |
| **DeFlow sets no auth environment variable** | The child environment DeFlow constructs contains no `*_API_KEY`, `*_TOKEN` or vendor auth variable it did not receive an explicit instruction to pass | One `buildChildEnv()` function, allowlist-based (§4)                                                                                                                         |
| **DeFlow transmits no credential anywhere**  | DeFlowd makes no outbound network request to a model provider, ever                                                                                   | DeFlow has no model-provider HTTP client in its dependency tree; the only outbound sockets are the OTLP exporter (user-configured, off by default) and the team hub (M3, §7) |

That AR-1 _works_ was observed directly. **Verified 2026-08-02:** the Claude Code ACP adapter
(`@agentclientprotocol/claude-agent-acp@0.64.1`) returned `"authMethods": []` in its `initialize`
response — it is already authenticated from the user's existing credential store and needs nothing
from DeFlow. That empty array is AR-1 working exactly as designed.

The counterexample is equally instructive. Copilot CLI returned an `authMethods` entry with an
`_meta["terminal-auth"]` block containing the literal `{command, args}` to run for login.
**DeFlow surfaces that to the user as a shell command to run themselves, in their own terminal, and
never runs it and never captures its output.** Running a vendor's login flow on the user's behalf,
even without storing the result, is the first step onto the wrong side of AR-1.

### 1.1 Where credentials do and do not live

```
┌── DeFlowd ──────────────────────────────┐
│  ledger, artifacts, policy, UI          │  ← holds NO model credential
│  holds: its own daemon token (§3)       │
└───────────────┬─────────────────────────┘
                │ spawn(), scrubbed env, worktree cwd
┌───────────────┴─────────────────────────┐
│  vendor binary (claude / codex / …)     │  ← holds the credential, reads its own store
│  reads: ~/.claude, ~/.codex, keychain   │
└─────────────────────────────────────────┘
```

The boundary is the `spawn()` call. Everything above it is DeFlow's code and must be credential-free;
everything below it is the vendor's own first-party client doing exactly what its terms contemplate.

### 1.2 How to audit the claim in the codebase

An architectural rule that cannot be checked in five minutes decays. These are the five checks, and
they belong in CI ([testing strategy](./14-testing-strategy.md)):

1. **One spawn chokepoint.** All child processes are created by `packages/proc/src/spawn.ts`. A lint
   rule (`no-restricted-imports` on `node:child_process`, allowlisting that one file) makes a second
   spawn site fail the build. Grep-auditable in one command.
2. **One environment builder.** `buildChildEnv()` in `packages/proc/src/env.ts` is the only function
   that constructs a child `env`. It is allowlist-based (§4), so the audit question becomes "read
   this one allowlist", not "read the whole daemon".
3. **A credential-path deny test.** All filesystem access in DeFlowd goes through an `Fs` port. A
   test double records every path opened; the assertion is that no path matches
   `**/.claude/**`, `**/.codex/**`, `**/.config/gh/**`, `**/.aws/credentials`, `**/.ssh/**`,
   `**/Library/Keychains/**`. Run the full mock-agent run suite (D17) against the recording double
   and the whole daemon is covered, not just the code someone remembered to test.
4. **A no-provider-SDK test.** Assert that the production dependency closure of the `deflow` package
   contains no model-provider SDK (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, …). The
   direct-API adapter (F3.3) is the deliberate exception in §2.3 and is a separate, optional entry
   point — if it is ever inlined into the core bundle, this test fails.
5. **An egress test.** Run a full mock-agent run with outbound network blocked except loopback and
   assert it completes. NF1 already requires this ("full functionality with no network beyond what
   the provider CLIs themselves need"), so the test doubles as an NF1 regression check.

**Publish the result.** The PRD's team phase needs an architecture one-pager for security review;
these five checks, green in CI, are that one-pager's evidence section.

---

## 2. The three consequences (PRD §5.3)

### 2.1 Execution must be local

Not a SaaS backend. This is why the interface is a local daemon plus a localhost UI (D1), and why the
team topology in §7 aggregates events rather than running work. It is the single largest
architectural consequence of AR-1 and it is not revisitable without abandoning AR-1.

### 2.2 Provider access is a capability discovered at runtime

DeFlow probes which agent binaries are installed _and authenticated_, and plans only against what is
actually available. A hardcoded provider matrix is both a correctness bug and a security bug: it
invites the code to assume a credential exists and to "help" when it does not.

The capability manifest is derived from each adapter's live `initialize` response and persisted with
the resolved absolute binary path, its `--version` output and a sha256 of the entry file. See
[the provider adapter layer](./07-provider-adapter-layer.md). Two security-relevant uses:

- **Resume poisoning guard.** On resume, if the recorded binary version or hash differs from the
  current one, refuse by default and require an explicit opt-in. Session-file formats are internal
  vendor details; resuming a Codex 0.146 session under a later build is not a supported operation by
  anyone, and a mismatched session file is untrusted input.
- **`mediatedExecution`.** The one capability bit that decides whether DeFlow can enforce the
  permission ladder at all (see
  [workspace and safety §8.3](./09-workspace-and-safety.md)). When false, no node above `read` is
  schedulable.

### 2.3 API keys are a first-class alternative, never the default — and shadowing is a security event

If a user chooses to supply their own key, or a company key, DeFlow uses it for that provider (F3.3).
That path is explicit, per-provider, opt-in, and visible in the run manifest. It does not soften
AR-1: AR-1 is about DeFlow never _appropriating_ a subscription credential, not about refusing a key
the user deliberately handed over.

The failure mode is the silent one:

> `ANTHROPIC_API_KEY` present in the environment **silently shadows subscription auth** in Claude
> Code. The user thinks they are on their subscription. They are being billed per token.

DeFlow treats this as a detectable condition and surfaces it loudly (F3.8):

- **At `deflow doctor`:** report every provider whose environment contains an auth-shadowing variable,
  naming the variable and stating which credential will actually be used.
- **At run start:** if a node's provider config selects subscription auth but a shadowing variable is
  present in DeFlowd's own environment, **strip it from the child environment** (§4) so subscription
  auth is used, and record a `provider.auth_shadow_stripped` event in the ledger.
- **When the user has explicitly selected the API-key path:** pass the variable through and record
  `provider.auth_mode = "api_key"` on the run manifest, so the cost report and the run report both
  say so.

The invariant is that the _effective_ auth mode of every provider is a recorded, rendered fact, and
never something the user has to infer from a bill.

---

## 3. Daemon authentication — localhost is not a security boundary

The PRD describes `DeFlowd` on `http://localhost:7777` and a phone on the same Wi-Fi as a client.
Both of those need to be said carefully, because binding to loopback is not authentication.

### 3.1 The two attacks that make loopback insufficient

**Any local process.** Every process running as the user — every npm `postinstall`, every VS Code
extension, every agent DeFlow itself spawned — can reach `127.0.0.1:7777`. That last one matters
most: an agent with a prompt-injected instruction and a shell is _inside_ the trust boundary of an
unauthenticated daemon that can start runs, read every artifact and approve human gates.

**DNS rebinding, from any page the user has open.** A page on `attacker.example` whose DNS record
resolves to `127.0.0.1` can make the browser issue requests to the daemon with the browser's own
network position. Same-origin policy does not save you: the browser believes the origin is
`attacker.example` and it is talking to `127.0.0.1:7777`.

### 3.2 The controls

| Control                    | Requirement                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bind**                   | Default bind is `127.0.0.1` only. Never `0.0.0.0` by default.                                                                                                                                                                                                                       |
| **Bearer token**           | Generated at first run: 32 bytes from `crypto.randomBytes`, base64url. Stored in the repo-local, gitignored `.DeFlow/daemon.json` alongside `{ pid, port, startedAt }`, mode `0600`. Every HTTP and SSE request requires `Authorization: Bearer <token>`. Constant-time comparison. |
| **Origin validation**      | Reject any request whose `Origin` header is present and not in the allowlist (`http://127.0.0.1:7777`, `http://localhost:7777`). This is the DNS-rebinding defence: a rebound page sends `Origin: http://attacker.example`.                                                         |
| **`Vary: Origin`**         | Sent on every response. Without it, any intermediate or browser cache can serve a response computed for one origin to a request from another, defeating the check above.                                                                                                            |
| **Host validation**        | Reject requests whose `Host` header is not a loopback name or the configured bind address — the second half of the rebinding defence.                                                                                                                                               |
| **No credentials in URLs** | The token never appears in a query string, so it never lands in a proxy log, a shell history or a browser history entry.                                                                                                                                                            |

**Getting the token into the browser without leaking it.** `deflow up` prints a URL with the token in
the **fragment**: `http://127.0.0.1:7777/#token=<token>`. Fragments are never sent to the server, so
the token cannot appear in any access log. The UI reads it once, stores it in `sessionStorage`, strips
it from the address bar, and sends it as an `Authorization` header thereafter.

**Consequence for the event stream.** `EventSource` cannot set request headers, so the SSE ledger
stream is consumed with `fetch` plus a `ReadableStream` reader, which also lets DeFlow send
`Last-Event-ID` as a header for resumable reconnects. See
[the API and realtime contract](./11-api-and-realtime.md). Do not solve the header problem by putting
the token in the query string.

### 3.3 The "phone on the same Wi-Fi" case (PRD §6.3, I4)

This is a **non-loopback bind** and must be treated as one:

- It requires an explicit flag or config key. It is never a default and never a silent fallback.
- It requires the bearer token to already exist and be enforced — the token is not optional in this
  mode, it is the only thing standing between the daemon and everyone else on the network.
- It should be TLS-terminated or tunnelled. Over plain HTTP on a shared network the bearer token is
  readable by anyone on the segment, which converts a convenience feature into credential
  disclosure. **Unverified / decide before M2:** whether to ship a self-signed certificate flow, a
  Tailscale-style guidance doc, or simply document a reverse-proxy recipe. Shipping the bind without
  answering this would be the wrong order.
- The UI must show, persistently, that the daemon is listening off-loopback. A machine quietly
  serving a full agent control plane to a coffee-shop network is exactly the sort of thing that
  should be impossible to forget about.

---

## 4. Child-environment scrubbing — the load-bearing control

This is the control that would actually have prevented the Kiro incident
([workspace and safety §10.1](./09-workspace-and-safety.md)). The approval gate there existed and was
on by default; it was bypassed because the identity the agent ran as carried standing production
privileges. **A gate you can bypass with ambient authority is theatre.** Removing the authority ranks
above adding the gate.

### 4.1 Allowlist, not deny-list

`buildChildEnv()` starts from an empty object and adds only what is needed:

| Kept                                                               | Why                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `HOME`, `USER`, `LOGNAME`, `SHELL`                                 | The vendor binary needs them to find its own credential store — this is AR-1 working |
| `PATH`                                                             | Resolved from the user's login shell at daemon start, not DeFlowd's inherited `PATH` |
| `LANG`, `LC_*`, `TZ`, `TERM`                                       | Locale and terminal behaviour                                                        |
| `TMPDIR`                                                           | **Overridden** to a per-run directory                                                |
| Vendor config-dir variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) | Only when the user set them; passed through unmodified                               |
| Explicitly declared node variables                                 | Per-node config, recorded in the ledger and rendered in the node inspector           |

Everything else is dropped. The families that are _never_ passed through implicitly:

```
AWS_*                              GOOGLE_APPLICATION_CREDENTIALS   GOOGLE_CLOUD_*
KUBECONFIG                         DATABASE_URL / DATABASE_*        TF_* / TERRAFORM_*
VAULT_*                            DOCKER_* / REGISTRY_*            SSH_AUTH_SOCK
*_TOKEN  (GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN, SLACK_TOKEN, …)
*_API_KEY  (ANTHROPIC_API_KEY, OPENAI_API_KEY, …)
*_SECRET / *_PASSWORD / *_CREDENTIALS
```

Three notes that are easy to get wrong:

- **`SSH_AUTH_SOCK` is dropped from _agent_ environments but kept for DeFlow's own git invocations.**
  The agent never pushes; the `Git` wrapper does
  ([workspace and safety §1.1](./09-workspace-and-safety.md)). Separating the two means an agent
  cannot use the user's forwarded ssh agent to reach any host the user can.
- **`ANTHROPIC_API_KEY` is dropped by default** so subscription auth is used, unless the node has
  explicitly selected the API-key path (§2.3). This is the mechanism behind auth-shadow detection.
- **The allowlist is a per-node, per-level decision, not a global one.** A node at `worktree+net`
  that legitimately needs a registry token declares it, and that declaration is a ledger event the
  run report shows.

### 4.2 Reinforcement at the vendor layer

Scrubbing at `spawn()` covers the agent process. It does not cover a command the agent runs that
inherits from somewhere else, or a process the agent spawns after DeFlow has stopped watching.
Reinforce with the vendor's own controls: Claude Code's `sandbox.credentials.envVars` with
`mode: deny`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, and Copilot CLI's `--secret-env-vars` (which strips
named variables from child environments **and** redacts them from output — worth mirroring in
DeFlow's own redactor).

Defence in depth is the right posture here precisely because the enforcement points belong to someone
else's release cycle.

---

## 5. Artifact confidentiality and the redaction boundary

DeFlow's artifacts are, by design, the most sensitive thing it produces: exact prompts, assembled
context packets, full diffs, stdout, stderr, and raw model output (PRD §9.4, NF8). ODW's own docs
warn about this exposure and its `security.redactEnv` covers environment variables only — G14 in the
PRD's own analysis. DeFlow has to do better, and the important decision is _where_ redaction happens.

> **Redact at export, not at write.**

|          | Write path                                                                                                                                                                                                                                | Export path                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What** | Everything, verbatim, content-addressed on disk under `~/.DeFlow`                                                                                                                                                                         | Run report (F10.13), team-hub sync (§7), OTel export (F10.12), any clipboard or file the user shares                                                                                    |
| **Why**  | NF8 and NF10: every artifact inspectable, every UI state traceable to a ledger event. Redacting at write destroys the debugging value that is the product's central claim, irreversibly, and a redaction bug becomes permanent data loss. | The exposure only exists when bytes leave the machine or the user's own account. Redaction at the boundary is reversible, testable, and can be improved after the fact by re-exporting. |

The corollary is that **on-disk artifacts are protected by filesystem permissions, not by content
filtering**: `~/.DeFlow` is created mode `0700`, per-run directories `0700`, and nothing under it is
world-readable. That is a real control and it needs stating, because "we redact secrets" invites the
assumption that the disk is safe to hand over. It is not; the export is.

The redactor itself — pattern set, entropy heuristics, known-token shapes, the `Vary`-style
allowlisting of things that only _look_ like secrets — is specified in
[observability and telemetry](./13-observability-and-telemetry.md), alongside the OTel emission it
also guards. F5.9 is satisfied by that redactor being on the export path of every one of the four
export surfaces above, with a test per surface.

---

## 6. Threat model

Assumed trusted: the user's OS account, the vendor CLI binaries, and the git binary. Assumed hostile:
everything that arrives as content.

| Actor                                                                                           | Asset at risk                                                                                | Realistic path                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Malicious or compromised repository**                                                         | Arbitrary code execution as the user; then every asset below                                 | Hostile `package.json` scripts, a `Makefile` target, a `.devcontainer` config, or repository git hooks that run on checkout/commit | Worktree `cwd` + vendor sandbox (delegated, `failIfUnavailable: true`); default-deny command allowlist at `terminal/create`; scrubbed environment so execution yields no credentials. **Unverified:** git hooks are shared from the main repo across worktrees; whether DeFlow should run its own orchestration git commands with hooks disabled needs a spike before M1 — it is a genuine execution path and disabling hooks may break legitimate repo workflows. |
| **Prompt-injected agent** (hostile content in a file, issue, dependency README or fetched page) | The default branch; production infrastructure; other repos on disk; the daemon control plane | The agent is instructed to exfiltrate, to push to `main`, to run `terraform apply`, or to call back into DeFlowd                   | Permission ladder enforced at `fs/*` and `terminal/*` — **the agent cannot exceed its level regardless of what it was told**; `ToolCallLocation.path` rejects out-of-scope writes at request time; F5.5 enforced mechanically in the `Git` wrapper; human gates at the network-egress and identity boundary; env scrubbing means a successful injection reaches no credential; **daemon bearer token means an agent that finds port 7777 still cannot drive it**   |
| **Compromised local process** (another tool, an npm `postinstall`, a browser extension)         | The daemon control plane; the ledger; artifacts                                              | Connects to `127.0.0.1:7777` and starts runs, reads packets, or auto-approves gates                                                | Bearer token on every request (§3); `~/.DeFlow` mode `0700`; token file mode `0600`. Note honestly: a process running _as the user_ can read the token file. This mitigation raises the bar from "trivial" to "requires filesystem access as the user" — it does not eliminate the class, and only OS-level isolation would.                                                                                                                                       |
| **Hostile web page in the user's browser**                                                      | The daemon control plane                                                                     | DNS rebinding to `127.0.0.1:7777` from a page the user already has open                                                            | `Origin` allowlist + `Vary: Origin` + `Host` validation + bearer token, which the page cannot obtain (§3.2)                                                                                                                                                                                                                                                                                                                                                        |
| **A shared run report** (PR description, Slack, a colleague)                                    | Secrets in prompts, diffs, stdout, model output                                              | The user exports a report from a run that touched a `.env` copied by `.worktreeinclude`                                            | Redaction on the export path (§5), applied to all four export surfaces; report generation refuses to run if the redactor reports an unrecoverable parse of any segment                                                                                                                                                                                                                                                                                             |
| **The team hub** (M3) and whoever operates it                                                   | Model credentials; source code; run content                                                  | Naive design syncs everything an engineer's daemon holds                                                                           | Credentials and model traffic **never reach the hub** (§7); only redacted events and artifacts sync; sync is opt-in per run                                                                                                                                                                                                                                                                                                                                        |
| **A future DeFlow contributor**                                                                 | AR-1 itself                                                                                  | A well-meaning PR adds `process.env.ANTHROPIC_API_KEY` to a child environment "so the adapter works"                               | The five CI checks in §1.2 — this actor is the reason those checks exist rather than being a convention in a document                                                                                                                                                                                                                                                                                                                                              |

### 6.1 Explicitly out of scope

- **Defending the user against themselves at `full` permission.** `full` is an explicit per-run
  opt-in that grants everything the provider allows. It is documented as not a sandbox, in ODW's own
  honest phrasing, and DeFlow says the same thing in the same words.
- **A malicious vendor CLI.** DeFlow spawns first-party binaries the user already trusts with their
  code and their credentials. If that binary is hostile, nothing in this document helps.
- **Multi-tenancy.** DeFlow is single-user, per-machine. The hub aggregates; it does not execute.
- **Protecting the ledger from the user's own OS account.** Everything DeFlow stores is the user's,
  readable by the user.

---

## 7. Team-phase posture (PRD §5.4)

When DeFlow goes to a team, **runs still execute on each engineer's machine with their own seat
credentials.** The hub aggregates events, artifacts and shared workflows.

> **Credentials and model traffic never reach the hub.**

| Crosses to the hub                             | Never crosses                                          |
| ---------------------------------------------- | ------------------------------------------------------ |
| Redacted ledger events                         | Any credential, token, key or session file             |
| Redacted artifacts (opt-in per run)            | Raw, unredacted artifacts                              |
| Shared workflow, gate and template definitions | Model API traffic of any kind — the hub is not a proxy |
| Approval-queue state and notifications         | The daemon bearer token                                |

This is simultaneously the compliant design under the vendor policy analysis in PRD §5.1, the cheaper
design (no per-token billing at the hub, no egress), and the strongest possible posture for the
internal security review the PRD anticipates: _the hub is an event aggregator with no ability to run
anything and no credential to run it with._

Two hub-specific requirements that do not exist in the single-user phase:

- **Hub authentication is separate from daemon authentication.** The daemon's bearer token is a
  local secret and must never be used as a hub credential. The daemon holds a per-engineer hub token,
  scoped to publish, stored in `~/.DeFlow` mode `0600`, and it is on the deny-list of §4 like any
  other `*_TOKEN`.
- **Redaction runs before transmission, on the engineer's machine.** Never on the hub. Data that has
  already left the machine cannot be un-sent, and a hub-side redactor would mean the raw bytes
  crossed the wire first.

---

## 8. Pitfalls — what not to do

| Do not                                               | Because                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Treat `127.0.0.1` as authentication                  | Every local process reaches it, including agents DeFlow spawned, and DNS rebinding reaches it from the browser                       |
| Put the daemon token in a query string               | It lands in access logs, shell history and browser history                                                                           |
| Omit `Vary: Origin`                                  | A cached cross-origin response defeats the Origin check that is the rebinding defence                                                |
| Use `EventSource` for the ledger stream              | It cannot set an `Authorization` header, which pushes you toward the query-string mistake above                                      |
| Bind off-loopback without the token already enforced | Turns "convenient" into "an agent control plane on a shared network"                                                                 |
| Redact artifacts at write time                       | Destroys the debugging value that is the product's central claim, irreversibly, and turns a redactor bug into permanent data loss    |
| Assume redaction protects the disk                   | It does not. `~/.DeFlow` at mode `0700` protects the disk; redaction protects exports                                                |
| Deny-list environment variables                      | New credential variable names appear constantly. Allowlist, and drop everything else                                                 |
| Pass `SSH_AUTH_SOCK` to agents                       | It grants the agent every host the user's ssh agent can reach; DeFlow's own `Git` wrapper needs it, the agent does not               |
| Let `ANTHROPIC_API_KEY` through silently             | It shadows subscription auth. The user believes they are on their plan and is being billed                                           |
| Run a vendor's login command on the user's behalf    | Even without storing the result, this is the first step across the AR-1 line. Print it; let the user run it                          |
| Bind-mount `~/.claude` into a container              | Authenticate fresh inside the container into a named volume instead — see [workspace and safety §12.1](./09-workspace-and-safety.md) |
| Let redaction run on the hub                         | The raw bytes have already crossed the wire by then                                                                                  |
| Keep AR-1 as a convention                            | Conventions decay under time pressure. The five checks in §1.2 belong in CI                                                          |

---

**Related:** [Workspace and safety](./09-workspace-and-safety.md) ·
[Observability and telemetry](./13-observability-and-telemetry.md) ·
[API and realtime](./11-api-and-realtime.md) ·
[Provider adapter layer](./07-provider-adapter-layer.md) ·
[Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
