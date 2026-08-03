# ADR 0003: DeFlow never holds a provider credential

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

The requirement "support whatever AI provider the user is subscribed to" is a legal and policy
constraint before it is a technical one, and the policy surface moved twice inside six months
(PRD §5.1):

- **19 February 2026** — Anthropic published an explicit Authentication and Credential Use policy:
  OAuth credentials from Free, Pro and Max plans are intended exclusively for Claude Code and
  claude.ai; using them in any other product, tool or service violates the Consumer Terms. Third
  parties may not offer Claude.ai login or route requests on users' behalf with those credentials.
- **15 June 2026** — a monthly Agent SDK credit for Pro/Max/Team/Enterprise was announced,
  explicitly covering third-party apps authenticating with a Claude subscription — and **paused on
  the same day**. The current published position is that Agent SDK, `claude -p` and third-party app
  usage still draw from subscription limits, and the plan is being reworked.
- There are credible reports of client fingerprinting and account action against third-party
  harnesses bridging subscription auth.
- Other vendors moved too: Gemini CLI's unpaid tier and Google One users were migrated to
  Antigravity CLI on 18 June 2026, and individual Google accounts no longer authenticate against the
  paid Code Assist path.

The conclusion is not "pick the safe vendor". It is that **the policy surface is volatile,
vendor-specific, and will change again during this project's lifetime.** Any design in which DeFlow
holds, transports, refreshes or proxies a provider credential is legally exposed, operationally
fragile, and will get the author's and their colleagues' accounts flagged.

## Decision

**AR-1, inviolable: DeFlow never possesses a model credential.**

DeFlow launches the vendor's own official binary as a child process, on the user's own machine,
under the user's own OS account, using the credentials that binary already stored for itself.
DeFlow reads no token file, sets no auth environment variable, and transmits no credential
anywhere. Every model request is made by the vendor's own first-party client — exactly the usage
each vendor's terms contemplate.

The rule produces an **auditable property**, and this is the point of stating it so absolutely: the
claim "DeFlow handles no credentials" is verifiable by inspection (NF2). There is one place in the
codebase that constructs a child environment, it is deny-by-default, and a test asserts that no
`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`,
`DATABASE_URL`, `TF_*` or `VAULT_*` value crosses it unless the node's declared level asked for it.
A property you can test is worth more than a policy you can only assert.

**Verified 2026-08-02.** The design works in practice: `@agentclientprotocol/claude-agent-acp@0.64.1`
returned `"authMethods": []` from its `initialize` response — it is already authenticated from the
user's existing Claude Code credential store and needs nothing from DeFlow. Copilot returned an
`authMethods` entry carrying an `_meta["terminal-auth"]` block with the literal `{command, args}`
to run for login; DeFlow surfaces that to the user as a shell command **to run themselves**, and
never captures its output.

Three consequences follow directly and are not negotiable (PRD §5.3):

1. **Execution must be local** — which forces [ADR 0002](./0002-headless-daemon-with-localhost-web-ui.md).
2. **Provider access is a capability discovered at runtime, not a configuration.** DeFlow probes
   which binaries are installed and authenticated and plans only against what is available (AR-5).
3. **API keys stay a first-class alternative, not the default** (F3.3). If a user supplies their own
   key, DeFlow uses it for that provider. And because `ANTHROPIC_API_KEY` in the environment
   silently shadows subscription auth in Claude Code, DeFlow detects and surfaces that explicitly
   (F3.8) — the failure mode is "you thought you were on your subscription and you were being billed".

## Consequences

### Positive

- Legal exposure moves from DeFlow to the relationship the user already has with their vendor.
- Every harness improvement the vendors ship is inherited for free; we never reimplement a tool loop.
- Team rollout is compliant _and_ cheap: runs execute on each engineer's machine with their own seat
  credentials; the M3 hub aggregates events and redacted artifacts, never credentials or model
  traffic (PRD §5.4).
- NF2 becomes a test, not a promise.

### Negative

- No server-side execution, ever, without reopening this decision. Rules out CI workers and remote
  runners in their obvious form (M4+ speculative work must respect it or supersede this ADR).
- Container isolation (F5.8) is in genuine tension with AR-1 and is therefore P1, not P0. The
  documented path is to authenticate _fresh inside_ the container and persist it in a named volume
  (`source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume` plus
  `CLAUDE_CONFIG_DIR`), **not** to bind-mount `~/.claude` from the host.
- Some capabilities are only reachable through an API key (exact token counting via Anthropic's
  `count_tokens` endpoint, for instance). Those degrade to estimates on the subscription path
  ([08-context-and-memory.md](../08-context-and-memory.md)).

### Neutral

- The adapter layer's job becomes protocol translation, not authentication
  ([ADR 0004](./0004-acp-first-adapter-layer.md)). ACP fits because the credential stays behind the
  pipe: DeFlow only speaks JSON-RPC to a process that authenticated itself.

## Alternatives considered

- **Proxy subscription OAuth tokens** (the pattern several third-party harnesses use). Rejected:
  explicitly prohibited by Anthropic's February 2026 policy, and the reported fingerprinting means
  the failure mode is the user's account, not ours.
- **API-key-only, like LangGraph/CrewAI/Mastra.** Rejected: contradicts the core premise — you
  already pay for Claude Max, ChatGPT Plus and a Copilot seat, and per-token billing on top is the
  thing this project exists to avoid (PRD §2.1, §4.3).
- **Hold credentials but store them in the OS keychain.** Rejected: storage location is irrelevant.
  The prohibited act is a third party transporting the credential at all.
- **Pick one vendor and integrate deeply.** Rejected: single-vendor lock-in is one of the four
  problems in the problem statement, and it does not even solve the policy risk — it concentrates it.

## Revisit when

**All three** of the following hold, not any one:

1. A vendor publishes explicit, current terms permitting a named third-party orchestrator to
   authenticate on a user's behalf with subscription credentials — and it is still published 90 days
   later, given the 15 June 2026 same-day pause.
2. That path is available for at least two of the six target vendors, so adopting it does not
   reintroduce single-vendor lock-in.
3. There is a concrete capability that AR-1 blocks and that users are actually asking for.

Until then, treat vendor policy pages as a standing quarterly review item (PRD §13). Note that a
_relaxation_ would not require abandoning AR-1 — it would only add an option. Abandoning it needs
a superseding ADR that explains what changed about the risk, not about the convenience.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
