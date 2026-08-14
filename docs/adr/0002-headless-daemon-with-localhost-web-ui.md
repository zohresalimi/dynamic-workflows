# ADR 0002: Headless daemon with a localhost web UI

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

The interface shape is not a taste decision. It is forced, almost entirely, by
[ADR 0003](./0003-never-hold-provider-credentials.md) (AR-1) and by the length of the runs.
The PRD §6.1 enumerates seven constraints:

| #   | Requirement                                             | Implication                                    |
| --- | ------------------------------------------------------- | ---------------------------------------------- |
| I1  | Must launch vendor CLIs with local credentials (AR-1)   | Local execution. Rules out pure web SaaS.      |
| I2  | Runs last hours; must survive closing the window        | The engine cannot live in the UI process.      |
| I3  | Graph, timeline, diffs, context inspector, memory graph | Web technologies. Rules out TUI-only.          |
| I4  | Observable while away from the machine                  | Network-addressable, mobile-viewable UI.       |
| I5  | Must reach colleagues without a distribution pipeline   | One-command install; self-hostable.            |
| I6  | Built solo, alongside a job and a degree                | Minimise packaging, signing, platform surface. |
| I7  | Author's stack: TypeScript, Vue 3, Node                 | Node engine + web frontend.                    |

I1 and I2 together are decisive. I1 says the process that spawns Claude Code must be on the user's
machine under the user's OS account. I2 says that process must outlive the window you are looking
at it through. Those two facts describe a local background daemon, and everything else is a client
of it.

The nine P0 visualisation views (F10.1–F10.9) are the product, not a debug surface, and every one of
them is a projection of the same event stream (NF10). A single stream with many possible consumers
is the natural consequence.

## Decision

**Ship a headless local daemon (`DeFlowd`) that serves a web UI over HTTP + SSE on
`127.0.0.1:7777`. One process, one port. Add a desktop shell in M3, not before.** (PRD §6.3)

```
npx deflow init          # detect providers, create .DeFlow/
npx deflow up            # start daemon → http://localhost:7777
npx deflow run "…"       # CLI entry, same engine
```

The daemon owns execution, the ledger, the worktrees and every child process. The browser UI is a
client with no privileged state — it holds a projection of the event stream and nothing else
([ADR 0012](./0012-ledger-projection-store-not-a-query-cache.md)). The CLI is a second client over
the same HTTP surface, consuming the identical SSE stream through the identical client module.

In development the Vite server runs _inside_ the daemon rather than beside it
([ADR 0011](./0011-vite-middleware-mode-inside-the-daemon.md)), so dev and production routing are
byte-identical.

`127.0.0.1` binding is not a security boundary. The daemon still authenticates: a 32-byte token
generated on first run, `Authorization: Bearer`, plus an `Origin` check — any local process and any
web page via DNS rebinding can otherwise reach port 7777. See [15-security-model.md](../15-security-model.md).

## Consequences

### Positive

- Close the browser, close the laptop lid, reboot — the run resumes (F4.2, NF4). This is the
  property most tools in the category lack.
- Many clients from one stream: browser tab, phone on the same Wi-Fi, `deflow run` in a terminal,
  later a Tauri shell, later a Slack notifier. All are SSE consumers.
- Zero packaging cost during the phase where there is one user (I6). Team rollout is
  `npx deflow up` per engineer (I5, NF6).
- Vibe Kanban's CLI-plus-web-UI shape is the closest existing precedent and is cross-platform and
  self-hostable — evidence the shape works.

### Negative

- Daemon lifecycle becomes our problem: start, stop, double-launch, orphaned children, stale
  worktree locks. Handled by an epoch counter and a `flock` on `~/.DeFlow/DeFlow.lock`
  ([05-durable-execution.md](../05-durable-execution.md)).
- A browser tab is a worse notification surface than a native app. Deferred to the M3 desktop shell.
- No mobile app; the UI must be responsive enough to read on a phone (I4).

### Neutral

- HTTP/1.1 only, because browsers refuse h2c and we do not want TLS on localhost. This caps the
  browser at ~6 connections per origin and forces exactly one multiplexed SSE stream per tab —
  an architectural constraint, documented in [11-api-and-realtime.md](../11-api-and-realtime.md).

## Alternatives considered

- **VS Code / JetBrains extension.** Rejected: ties us to one IDE, against the brief; the extension
  host is a bad place for hours-long processes (I2); constrained visualisation surface (I3).
- **TUI as the primary surface.** Rejected: fails I3 and I4 outright. A thin `deflow` CLI for
  scripting and CI is retained, as a client.
- **Native desktop app (Electron/Tauri) as primary for v1.** Rejected: packaging, signing,
  notarisation and auto-update cost weeks that buy nothing during solo use (I6), and it tempts you
  to put the engine in the app process, violating I2. Revisited as an M3 _shell_ over the same UI.
- **Cloud web app.** Rejected: violates AR-1 and I1 outright.

## Revisit when

Either of these becomes true:

- Notification latency or OS integration (tray indicator, native "gate failed" alerts, login item)
  is the top complaint after two weeks of daily use → bring the M3 Tauri shell forward. It wraps the
  same localhost UI and does not change this decision, only its packaging.
- A colleague needs to watch a run executing on someone else's machine → that is the M3 hub
  (PRD §9.5), and it aggregates _events_, never credentials or model traffic. If that ever requires
  moving execution server-side, AR-1 has to be reopened first, not this ADR.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
