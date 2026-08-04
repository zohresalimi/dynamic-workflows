# Contributing to DeFlow

```bash
git clone && pnpm install && pnpm dev
```

Then open **http://127.0.0.1:7777**. That is the whole setup — no build step, no
second process, no `.env` required, no credentials.

The full reference is [03-local-development.md](./03-local-development.md). This file records the
things that must be re-verified against a clean checkout rather than trusted, and the handful of
decisions that look like annoyances until you know why they exist.

---

## The dev loop

`pnpm dev` starts **one** Node process serving the API, the SSE stream and the UI from one origin.
Vite runs in middleware mode inside DeFlowd, so its HMR websocket rides the daemon's own
`node:http` server rather than opening a second one (D10, [ADR 0011](./adr/0011-vite-middleware-mode-inside-the-daemon.md)).

| You save…                                        | What happens                                     |
| ------------------------------------------------ | ------------------------------------------------- |
| anything under `packages/{core,ledger,adapters,daemon,cli,mock-agent}/` | the daemon restarts, in well under 2 s |
| a `.vue` or anything else under `packages/web/`   | HMR updates the browser; the daemon does not restart |

Vite needs **two** options to do that, not one. `server: { middlewareMode: { server }, ws: { server } }`:
`middlewareMode.server` is consumed only when forwarding to a configured upstream, and it is
`server.ws.server` that attaches the HMR websocket to DeFlowd's socket. Verified 2026-08-04 against
`vite@8.2.0`'s shipped code; ADR 0011 and 03-local-development.md §4.2 carry the correction, because
both originally read the type declaration's doc comment as meaning HMR. Drop `ws.server` and Vite
silently opens a second listening socket on port 24678.

`node --watch` runs a small supervisor process alongside the daemon. It serves nothing and listens
on nothing: **exactly one socket is listening**, on `127.0.0.1:7777`, and it belongs to the daemon.
That is the property to check if you ever suspect a second server has appeared —
`lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` must print one line.

`packages/web` is deliberately **not** in the dev script's `--watch-path` list. The watch path and
the Vite root would overlap, so a single `.vue` save would produce a daemon restart *and* an HMR
update: the SSE stream would drop and the loop would be unusable while a run is going.

There is also deliberately **no `--env-file-if-exists=.env`** on the dev script, even though
[03-local-development.md §3](./03-local-development.md) shows one. **Verified 2026-08-04 on Node
24.18.0:** a relative env-file path combined with `--watch`/`--watch-path` makes the watcher react
to writes anywhere under the working directory, and Vite's dependency optimizer writes a fresh
`node_modules/.vite/deps_temp_*` on every boot — so the daemon restarts, Vite re-optimizes, and the
loop restarts about twice a second forever. An absolute path does not reproduce it. The daemon loads
`.env` in-process instead (`packages/daemon/src/env.ts`), which is portable and cannot regress into
this; a guard test rejects the flag if anyone re-adds it from the docs.

### The restart is the test

Every save kills DeFlowd mid-flight and starts a new process. Do not "fix" this with a hot-reload
scheme that preserves process state — **the restart is the test**. It is free, continuous,
adversarial testing of **F4.2** (resume after crash), which is the single property most competing
tools lack and the one hardest to be confident in. Keep a mock run going in another tab while you
work on the scheduler and every save becomes a crash-resume trial.

If the daemon does not come back cleanly, that is a real bug in the reducer, the migration or the
reconcile probe — not a dev-loop annoyance.

### Do not delete the ledger

When a restart fails, the instinct is to clear state. Resist it —
**the ledger is the source of truth**, and deleting `ledger.db` to get moving again
**destroys the evidence** — the only reproduction of a durability bug you are likely to get.
Snapshot it first:

```bash
DeFlow ledger snapshot <runId> --out /tmp/DeFlow-bug-1234.db
```

`VACUUM INTO` is measured at about 1 second for a 193 MB database, so there is no excuse.

### Readable logs

```bash
pnpm dev:pretty                                   # pipes through pino-pretty
pnpm dev | pino-pretty | grep '"mod":"scheduler"' # one subsystem
```

`pino-pretty` is a **pipe**, never a runtime transport: a transport spawns a worker thread inside
DeFlowd and turns production logs into something other than ndjson. Every subsystem logs through
`log.child({ mod, runId })`, and redaction (`*.authorization`, `*.token`, `*.headers.cookie`,
`env.ANTHROPIC_API_KEY`, `env.OPENAI_API_KEY`, `env.GITHUB_TOKEN`) is configured at the root logger.

---

## Measurements

Re-measure these on a clean checkout at every milestone; a monorepo accretes implicit prerequisites
that whoever added them never notices.

| Measurement                                    | Budget           | Last measured                              |
| ---------------------------------------------- | ---------------- | ------------------------------------------ |
| Cold start: `pnpm dev` to first 200 on `/api/health` | < 3 s (NF3) | **299 ms** (298/299/300 over four runs, one with `packages/web/node_modules/.vite` deleted), 2026-08-04, macOS / Node 24.18.0 / Apple silicon |
| `pnpm install --frozen-lockfile`, warm store   | seconds          | see KAR-01.1                                |

The cold-start number is asserted by `e2e/dev-loop.test.ts`, which prints the measurement it took,
so a regression shows up in the test log rather than in a vague sense that the loop got slower.
