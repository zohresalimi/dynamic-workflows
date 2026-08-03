# ADR 0001: Record architecture decisions

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

DeFlow is being built by one person, alongside a job and a degree, in an area where the ground moves
monthly. During the research pass on 2 August 2026 the following all turned out to be true, and none
of them are things anyone would remember six months later:

- `@zed-industries/agent-client-protocol` was renamed to `@agentclientprotocol/sdk`, and the GitHub
  org moved too. **Verified 2026-08-02.**
- Claude Code's `--permission-prompt-tool` and Codex's `exec --full-auto` both disappeared from
  `--help`. **Verified 2026-08-02.**
- `typescript@7.0.2` is GA and faster, and adopting it would silently break `vue-tsc` and every
  type-aware lint rule. **Verified 2026-08-02.**
- Anthropic announced a subscription-backed Agent SDK credit and then paused it, inside four months.

Six months from now the _choice_ will still be visible in the code, but the _reason_ will not — and
without the reason there is no way to tell a still-valid decision from a stale one. Worse, in a
fast-moving area the failure mode is not "we made the wrong call" but "we never noticed the call
expired". A decision log that only records what was decided rots into folklore.

The architecture documents in `../` describe how DeFlow works _now_. They are rewritten as the
system changes. Something has to hold the reasoning that produced them.

## Decision

We keep a numbered set of Architecture Decision Records in `docs/adr/`, in the lightweight
Nygard-style format used by this file: Context, Decision, Consequences, Alternatives considered,
and — the addition that makes the set worth maintaining — **Revisit when**.

Four rules:

1. **Every ADR carries a "Revisit when" section with a concrete, checkable trigger.** Not "when the
   ecosystem matures" but "when `node:sqlite` reaches Stability 2 _and_ Node 26 is our floor". A
   trigger you cannot check is not a trigger.
2. **ADRs are immutable once accepted.** A decision that is overturned gets a _new_ ADR that
   supersedes the old one. The old file stays, its status changes to `Superseded by ADR NNNN`, and
   its body is left alone. Editing a decision record to match current reality destroys the only
   thing it was for.

   Immutability starts at first publication. While the whole set carries `Draft v1.0` and nothing
   has been built against it, correcting a record is drafting, not rewriting history. Once the
   first line of code cites an ADR, the rule is absolute.

3. **The detail lives in the architecture docs, not here.** An ADR states the forces, the call, and
   the trigger — then links to `../05-durable-execution.md` or wherever the mechanism is actually
   documented. ADRs that grow into design documents stop being read.
4. **Evidence is cited with its confidence.** `**Verified 2026-08-02.**` for things installed,
   probed or benchmarked; `**Unverified.**` for things reasoned about. This matches the convention
   used across the rest of the document set (AR-6).

Numbering is sequential and never reused. `README.md` in this directory is the index.

## Consequences

### Positive

- The seventeen decisions locked during the research pass are recorded with their evidence, so a
  future reader can tell "this was measured" from "this seemed sensible at the time".
- The revisit triggers turn the ADR set into a standing review checklist, which is the only
  realistic mitigation for a solo project against ecosystem churn.
- Superseding rather than editing makes the _history_ of the architecture readable, which matters
  for the M2 security-review one-pager the PRD §13 calls for.

### Negative

- Writing an ADR is friction on every significant decision. Accepted deliberately: the friction is
  the point, and it is bounded — see the length guidance in the [index](./README.md).
- A superseded-not-deleted set grows monotonically. Mitigated by the index carrying status.

### Neutral

- ADRs are Markdown in the repo, versioned with the code. No tooling, no ADR CLI, no separate site.

## Alternatives considered

- **Nothing; rely on git history and commit messages.** Rejected: commit messages record _what_
  changed, almost never _what was rejected and why_. Half the value here is the alternatives.
- **A single `DECISIONS.md`.** Rejected: it invites editing in place, which loses the supersession
  history, and it has no natural place to link from (`../README.md` links per-decision today).
- **MADR / full Nygard with a formal status workflow (Proposed → Accepted → Deprecated).** Rejected
  as ceremony for a single decider. There is no proposal stage when one person decides.
- **Recording decisions only in the architecture docs.** Rejected: those docs are rewritten, so a
  decision's rationale would be silently overwritten by its own consequences.

## Revisit when

A second regular contributor joins the repository. At that point a `Proposed` status and a review
step become meaningful, and this ADR should be superseded by one that defines them.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
