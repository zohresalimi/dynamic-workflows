# API and realtime contract

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

This is the contract between `DeFlowd` and every client: the browser UI, the `deflow` CLI, and
later the Tauri shell and a Slack notifier. There is exactly one API and exactly one event stream.
The CLI is not a second-class consumer with its own path — it imports the same client module and
reads the same frames as the browser.

Everything here rests on one property established in [durable execution](./05-durable-execution.md):
the ledger is a single global SQLite database with one globally monotonic `seq` column
(`INTEGER PRIMARY KEY AUTOINCREMENT`). `seq` is the total order of the system, and the whole
realtime design is a thin shell around that fact.

---

## 1. Transport decision

| Direction                           | Transport                                                | Why                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server → client, all run state      | **HTTP/1.1 + SSE**, one multiplexed connection per tab   | The stream is an append-only log with a total order. SSE's `id:` field plus `Last-Event-ID` maps onto `seq` exactly, giving resumable streams for free (PRD §9.2) |
| Client → server, all writes         | **Plain `POST`**                                         | Pause, resume, cancel, approve, interject, patch decisions. These are low-frequency, need a response body and a status code, and do not benefit from a socket     |
| Bidirectional, interactive PTY only | **One WebSocket**, scoped to a terminal panel's lifetime | Typing into a live `node-pty` (F8.2 steering) genuinely needs client→server bytes at keystroke latency. Nothing else does                                         |

**Do not migrate the event stream to WebSocket.** You would be reimplementing `Last-Event-ID`
resume — which is the single feature that makes the transport match the domain — in exchange for a
bidirectionality no view needs. The rule is: SSE carries the ledger; WebSocket carries keystrokes.

Because Vite runs in middleware mode inside `DeFlowd` (D10, see
[local development](./03-local-development.md)), there is one process, one port, no proxy and no
CORS. Dev and production routing are byte-identical. This matters more than it sounds: Vite's dev
proxy is documented-bad at SSE (buffering events into one burst at stream end, socket timeouts on
hours-long streams, close events not propagating), and the entire UI is an SSE projection.

---

## 2. Exactly one SSE connection per tab

This is an architecture constraint, not a tuning knob. It must be designed in from day one.

`DeFlowd` runs on Node's `http` server, which is **HTTP/1.1**. HTTP/2 on localhost is not available:
browsers refuse h2c (cleartext HTTP/2), so h2 would require TLS, and shipping a certificate for
`127.0.0.1` is a worse problem than the one it solves. Browsers cap concurrent connections per
origin on HTTP/1.1 at **about six**.

An SSE connection is a connection that never closes. One stream per run panel, across two or three
open tabs, exhausts the budget. The failure mode is not an error — it is that every subsequent
`fetch` silently queues behind the streams, forever. The symptom reads as "the daemon hung", and it
will cost an afternoon to diagnose the first time.

**The design:**

```
GET /api/stream?runs=<runId>,<runId>&since=<seq>
```

- **One** `EventSource`-shaped connection per browser tab, opened once at app start.
- The `runs` parameter is a server-side topic filter. `runs=*` subscribes to the low-volume global
  lifecycle topic only (`run.created`, `run.completed`, `run.aborted`, `human.requested`) — that is
  what the run list and the cross-run approval queue (F8.3) need, and it does not drag every
  `node.progress` frame from every run into an idle tab.
- The client fans out on arrival: one `applyEvent(e)` dispatcher, which routes by `e.runId` to the
  right projection set. See [frontend architecture](./12-frontend-architecture.md).
- Adding a run panel must **not** open a second connection and must not require a reconnect. The
  `hello` frame carries a `streamId`; the client mutates the server-side filter with
  `POST /api/stream/:streamId/subscribe { "runs": ["…"] }`. The daemon backfills the newly
  subscribed run from the client's current cursor before resuming live delivery.

**Optional hardening, deferred:** put the single connection in a `SharedWorker` and `BroadcastChannel`
the events to tabs. That reduces N tabs to one connection total. It is worth roughly half a day and
should not be built until three-plus tabs is a habit rather than a hypothetical.

---

## 3. The SSE frame contract

### 3.1 Response headers

```
Content-Type:      text/event-stream
Cache-Control:     no-cache, no-transform
X-Accel-Buffering: no
Connection:        keep-alive
X-DeFlow-Api:      1
```

`no-transform` and `X-Accel-Buffering: no` exist for any intermediary that might appear later
(a reverse proxy in front of a shared dev box, a corporate agent). More importantly:

> **No compression middleware may touch `/api/stream`.**

Mount `hono/compress` on the JSON routes only. gzip buffers, and a buffered SSE stream delivers
events in bursts. The symptom — "events arrive in clumps, then all at once" — looks like a backend
scheduling bug and is not one.

### 3.2 Frame format

```
retry: 2000

: keepalive

id: 10432
data: {"seq":10432,"runId":"r_01J…","ts":1754140000000,"kind":"node.started","v":1,"epoch":7,"nodeId":"n_impl_3","attempt":1,"payload":{…}}

```

Rules:

1. **`id: <seq>` on every ledger frame.** No exceptions. This is the whole design: a browser that
   reconnects sends `Last-Event-ID: 10432`, and resume becomes literally

   ```sql
   SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT 500;
   ```

2. **`retry: 2000` written once, immediately after the headers.** Native `EventSource` honours it.
   `eventsource-client` manages its own reconnection policy in client configuration — set both and
   keep them in agreement, so a native-`EventSource` fallback and the real client behave the same.

3. **`: keepalive` comment every 15 seconds.** An SSE comment line is ignored by every client and
   costs 12 bytes. Its job is to ensure no socket-inactivity timer anywhere in the path — Node's,
   the OS's, a proxy's — ever sees a silent connection. Long-running DeFlow nodes are routinely
   idle for minutes.

   **A per-run subscription ends rather than keeping alive forever** (KAR-19.2 AC8). Once every run
   named in `?runs=` has delivered a `run.completed` or `run.aborted`, the server closes the
   connection: that run will never emit again, and a socket that stays open on keepalives gives a
   UI no way to tell "still working" from "will never speak again". `?runs=*` is never closed this
   way — the global topic is about runs that do not exist yet.

4. **Ledger events use the default (unnamed) event type**, so the client needs exactly one
   `onmessage` handler feeding `applyEvent`. Discriminate on the payload's `kind` field, not on the
   SSE `event:` name. Named SSE events are reserved for **stream-control frames**, which are not
   ledger events and must never reach the reducer:

   | `event:`     | `data`                                                  | Meaning                          |
   | ------------ | ------------------------------------------------------- | -------------------------------- |
   | `hello`      | `{ streamId, apiVersion, build, daemonEpoch, headSeq }` | First frame on every connection  |
   | `subscribed` | `{ runs: RunId[] }`                                     | Filter mutation acknowledged     |
   | `caught_up`  | `{ runId, seq }`                                        | Backfill drained; live from here |

   `hello.daemonEpoch` is how a client detects that the daemon restarted under it (see
   [durable execution §12](./05-durable-execution.md)). `hello.build` is how the UI detects that it
   is an old tab talking to a new daemon and prompts a reload.

5. **The `data` payload is the full `EventEnvelope`** from
   [the domain model](./04-domain-model.md#9-the-event-union), serialised as one line of JSON. Never
   split an event across multiple `data:` lines; there is no reason to and it complicates the reader.

6. **Unknown `kind` values must be ignored by the client**, exactly as the backend reducer ignores
   them. This is what lets a user run an older UI build against a newer daemon without corruption.

---

## 4. Two caveats that are usually stated wrong

### 4.1 `Last-Event-ID` is sent only on automatic reconnect

The browser sends `Last-Event-ID` when **its own** reconnection logic fires on a connection that had
previously opened successfully. It does **not** send it:

- on a fresh `EventSource` after a page reload;
- on the very first connection attempt of a session;
- if the initial connection never opened successfully (daemon not yet up, port not yet bound).

That third case is the common one during development: you restart `DeFlowd`, the tab's stream fails
to open, and when the daemon comes back the tab reconnects with no cursor at all. If the server
treats "no `Last-Event-ID`" as "start from head", the UI silently loses every event that occurred
while it was down and shows a plausible but wrong picture — a direct NF10 violation.

> **Therefore the explicit hydrate path is mandatory, not an optimisation.**

The client persists its cursor itself (the highest `seq` it has applied) and always opens the stream
with `?since=<seq>`. On a cold start with no cursor it first calls
`GET /api/runs/:id/events?since=0` (or `…/snapshot?seq=head`, §7.4) and only then opens the stream
at the returned cursor. The server's precedence is:

```
since query param  >  Last-Event-ID header  >  head of log
```

The query parameter wins because the client's own persisted cursor is more trustworthy than the
browser's, and because the CLI has no `Last-Event-ID` mechanism at all.

### 4.2 Sequence numbers have gaps

`seq` 4, 5, 7 is a normal, healthy log. `6` belongs to another run — the `event` table is one global
sequence keyed by `run_id` — or to a pruned event, whose number `AUTOINCREMENT` never reissues. (This
paragraph used to say "a rolled-back transaction burns `AUTOINCREMENT` values"; corrected 2026-08-05,
see [05-durable-execution §6](./05-durable-execution.md#6-autoincrement-is-mandatory).)

> **The cursor contract is "resume from strictly greater than `seq`". It is never "expect `seq + 1`".**

Any client that treats a gap as a dropped event will report false data loss on a perfectly correct
stream and, worse, may try to "repair" by refetching from zero. Do not write gap detection. If you
want an integrity check, compare your applied count against `hello.headSeq` for _ordering_, never
for _density_.

`AUTOINCREMENT` itself is mandatory for the opposite reason: a bare `INTEGER PRIMARY KEY` reuses
rowids after a delete, so the moment run retention ships, every persisted SSE cursor would point at
a different event than the one it was written for — silently. **Verified 2026-08-02**; the full
demonstration is in [durable execution §6](./05-durable-execution.md).

---

## 5. The serving loop

The handler is a two-phase drain, and the second phase is subscribe-then-drain-again, never
subscribe-only. Getting this order wrong loses every event that commits between the last drain and
the subscription.

```ts
// packages/daemon/src/http/stream.ts
import { streamSSE } from "hono/streaming";

api.get("/stream", (c) => {
  const runs = parseRuns(c.req.query("runs"));
  const since = Number(
    c.req.query("since") ?? c.req.header("Last-Event-ID") ?? 0,
  );

  return streamSSE(c, async (stream) => {
    let cursor = since;
    stream.writeSSE({ event: "hello", data: JSON.stringify(hello(runs)) });
    await stream.write("retry: 2000\n\n");

    const wake = new Signal(); // resolves when notified
    const off = bus.on("committed", () => wake.notify());
    stream.onAbort(() => {
      off();
      wake.notify();
    });

    const ka = setInterval(() => stream.write(": keepalive\n\n"), 15_000);

    try {
      for (;;) {
        // Phase 1 — drain to empty. Bounded query, cursor advanced per batch.
        for (;;) {
          const batch = ledger.tailSince(runs, cursor, 500); // see below
          if (batch.length === 0) break;
          for (const e of batch) {
            await stream.writeSSE({
              id: String(e.seq),
              data: JSON.stringify(e),
            });
            cursor = e.seq;
          }
        }
        // Phase 2 — park until the post-commit emitter fires, then drain again.
        await wake.wait();
        if (stream.aborted) return;
      }
    } finally {
      clearInterval(ka);
      off();
    }
  });
});
```

### 5.1 The drain query

```sql
SELECT seq, run_id, ts, kind, v, node_id, attempt, ikey, payload
FROM event
WHERE run_id = ? AND seq > ?
ORDER BY seq
LIMIT 500;
```

**Verified 2026-08-02:** served by `SEARCH event USING COVERING INDEX event_run_seq`; 1,000 such
tail queries completed in **196 ms total, roughly 0.2 ms each**. For a multiplexed stream the
handler runs one bounded query per subscribed run and merge-sorts the batches by `seq` before
writing. With a handful of subscribed runs that is a fraction of a millisecond per wake-up.

Three hard rules on the read side, all from measured failure:

- **Never hold an open `iterate()` cursor or a read transaction across the stream.** Holding one
  open while writing 20k rows produced an **82.6 MB** `-wal` file that no checkpoint could truncate.
  Drain with bounded `LIMIT` queries and close each one.
- **Never serve the stream from the write connection.** `better-sqlite3@13.0.2` is fully synchronous
  and blocks the event loop; readers are separate read-only connections, each with `busy_timeout`.
- **Never let `io_chunk` into this query.** Agent stdout is the data plane and is served separately
  (§7.6). Mixing it in is what makes people believe event sourcing needs snapshots.

### 5.2 The emitter fires POST-COMMIT

```ts
// packages/daemon/src/ledger/append.ts
const seqs = db.transaction(appendAll)(events); // one transaction, control plane
bus.emit("committed", seqs); // AFTER commit returns, never inside
```

If the emitter fires inside the transaction, a stream can read a row that a subsequent rollback
removes, and the client's cursor advances past an event that does not exist. Because the notify is
post-commit and the reaction is "drain from my cursor" rather than "here is the payload", the
emitter carries no data and needs no ordering guarantees — a missed notification only delays
delivery to the next one, and the keepalive tick bounds that. This is deliberately the least
clever part of the system.

---

## 6. Endpoints

All paths are relative to `/api`. All responses are JSON unless stated. All require
`Authorization: Bearer <token>` (§8).

### Projects

Added by KAR-22.1. A project is a name and a resolved local path that is a git working tree, held
as a row in the global ledger database — not in browser storage, because a project is not a UI
preference.

| Method   | Path            | Purpose                                                                | Req  |
| -------- | --------------- | ---------------------------------------------------------------------- | ---- |
| `GET`    | `/projects`     | List projects with `health` and `lastRun`. Never filters an unhealthy row | NF10 |
| `POST`   | `/projects`     | `{ name, path }` — bootstraps `.DeFlow/` if absent and reports what it wrote | F1.1 |
| `PATCH`  | `/projects/:id` | `{ name }` — renames. The id, the path and the history do not move     |      |
| `DELETE` | `/projects/:id` | Forgets the project. **Deletes no files**, and says so on the response | NF8  |

Two properties of this group are contracts rather than implementation details. **`health` is
derived per request**, by asking the filesystem and `git` — a stored column would be a cache of a
world that changes while nobody is looking, and a list that is confidently wrong is worse than a
slow one. And **`POST /projects` refuses a non-repository with `deflow init`'s own sentence**, from
the one exported constant both surfaces read, so the CLI and the browser cannot tell an operator two
different things about one directory.

`project_exists` (409) and `project_not_found` (404) join the closed error union in §10.

### Connectors (KAR-22.4)

| Method   | Path                                          | Purpose                                                                     | Req  |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| `GET`    | `/projects/:id/connectors`                    | Every registered service, its **live** state, and its credential statement   | AR-1 |
| `POST`   | `/projects/:id/connectors/:service`           | Record that this project may use the service. Obtains **no** credential      | F1.1 |
| `DELETE` | `/projects/:id/connectors/:service`           | Forget it. Deletes no credential, and names the operator's own revocation command | NF8  |
| `GET`    | `/projects/:id/connectors/:service/issues?q=` | That project's repository's issues as `{ key, title, state, url }`           | F1.1 |

**DeFlow holds no connector credential, and these routes are shaped by that.** `POST` opens no
browser, calls no authorisation server, and receives no token: the row it writes is
`(projectId, service)` and a timestamp. For GitHub the token lives in the GitHub CLI's own
credential store, put there by the operator's own `gh auth login` against GitHub's own application,
and DeFlow reads issues by spawning `gh`. See [ADR-0003](../adr/0003-never-hold-provider-credentials.md)
and its amendment of 16 August 2026.

Two further properties are contracts. **State is derived per request** — six values (`connected`,
`not-installed`, `not-authorised`, `expired`, `missing-scope`, `unreachable`), each with a sentence
and at most one command — for the reason `health` is, and a stored `connected` column would be a
cache of somebody else's credential store. And **`q` is passed to the service**, not applied as a
filter here, so a repository with three hundred issues is a search rather than three hundred rows.

`connector_not_connected` (409) and `connector_unusable` (422) join the closed error union in §10.
`connector_unusable` is 422 and not 503 for KAR-19.2's reason: no amount of waiting installs `gh` or
grants a scope, and a retryable status would train a client to loop over a human's decision.

### Runs

| Method | Path                           | Purpose                                                   | Req  |
| ------ | ------------------------------ | --------------------------------------------------------- | ---- |
| `GET`  | `/runs?status=&limit=&cursor=` | List runs, newest first                                   |      |
| `POST` | `/runs`                        | Create a run from free text, file, issue ref or spec doc. Takes an optional `projectId` (KAR-22.1) | F1.1 |
| `GET`  | `/runs/:id`                    | Run summary: status, plan version, counts, cost, head seq |      |
| `POST` | `/runs/:id/spec/approve`       | Approve the `TaskSpec` — the real gate before execution   | F1.3 |
| `POST` | `/runs/:id/spec/edit`          | Replace the framed document; appends `spec.amended`       | F1.3 |
| `POST` | `/runs/:id/spec/reject`        | Reject with a reason and re-run the framing interview     | F1.3 |
| `POST` | `/runs/:id/spec/abandon`       | End the run from the gate; appends `run.aborted`          | F1.3 |

### Stream and hydration

| Method | Path                             | Purpose                                           | Req           |
| ------ | -------------------------------- | ------------------------------------------------- | ------------- |
| `GET`  | `/stream?runs=&since=`           | **The** SSE connection (§2–§5)                    | F4.1          |
| `POST` | `/stream/:streamId/subscribe`    | Mutate the topic filter without reconnecting      |               |
| `GET`  | `/runs/:id/events?since=&limit=` | Explicit hydrate — JSON array of envelopes (§4.1) | NF10          |
| `GET`  | `/runs/:id/snapshot?seq=N`       | Reduced run state **at** seq N, server-side       | F10.2, F10.10 |

### Control

| Method | Path               | Purpose                                                               | Req  |
| ------ | ------------------ | --------------------------------------------------------------------- | ---- |
| `POST` | `/runs/:id/pause`  | Append `run.paused`                                                   | F4.4 |
| `POST` | `/runs/:id/resume` | Append `run.resumed`                                                  | F4.4 |
| `POST` | `/runs/:id/cancel` | `{ mode: 'cooperative' \| 'forceful' }` — forceful is the kill switch | F5.7 |

### Human in the loop

| Method | Path                                | Purpose                                                        | Req  |
| ------ | ----------------------------------- | -------------------------------------------------------------- | ---- |
| `GET`  | `/approvals`                        | Cross-run queue of everything waiting on you                   | F8.3 |
| `POST` | `/runs/:id/nodes/:nodeId/respond`   | Answer a blocking `human` node                                 | F8.1 |
| `POST` | `/runs/:id/interject`               | Inject guidance into a running node without discarding the run | F8.2 |
| `POST` | `/runs/:id/patches/:patchId/decide` | `{ decision: 'approve' \| 'reject', reason? }`                 | F2.5 |

### Plan and inspector

| Method | Path                                                  | Purpose                                                         | Req          |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `GET`  | `/runs/:id/plans`                                     | Version rail: `{ version, seq, planHash, decision, reason }[]`  | F10.2        |
| `GET`  | `/runs/:id/plans/:version`                            | The immutable plan document                                     | F2.6         |
| `GET`  | `/runs/:id/plans/diff?from=&to=`                      | Node/edge set diff + per-node RFC 6902 patch + union layout key | F10.2        |
| `GET`  | `/runs/:id/nodes/:nodeId?attempt=`                    | The full inspector bundle                                       | F10.3        |
| `GET`  | `/runs/:id/nodes/:nodeId/packet?attempt=`             | Assembled context packet with per-segment token counts          | F10.3, F10.5 |
| `GET`  | `/runs/:id/nodes/:nodeId/io?attempt=&fromSeq=&limit=` | `io_chunk` tail — terminal reattach and log paging              | F10.6        |

### Blackboard, gates, diffs, artifacts

| Method | Path                                            | Purpose                                                     | Req         |
| ------ | ----------------------------------------------- | ----------------------------------------------------------- | ----------- |
| `GET`  | `/runs/:id/facts?key=&by=`                      | Blackboard facts with provenance                            | F6.3, F10.4 |
| `GET`  | `/runs/:id/facts/:factId/consumers`             | Every node that read this fact                              | F10.4       |
| `GET`  | `/runs/:id/gates`                               | Gate results with typed verdicts                            | F7.3        |
| `GET`  | `/runs/:id/criteria`                            | Acceptance criteria + satisfying evidence                   | F7.4, F10.8 |
| `GET`  | `/runs/:id/findings?file=`                      | Findings grouped by file, ordered by line                   | F7.7        |
| `GET`  | `/runs/:id/diff?node=\|worktree=\|cumulative=1` | Unified patch, `text/x-patch`                               | F10.7       |
| `GET`  | `/artifacts/:sha`                               | Content-addressed blob. Supports `Range`. Immutable caching | F6.5, NF8   |
| `HEAD` | `/artifacts/:sha`                               | Size and media type without the body                        |             |

### Providers, config, meta

| Method | Path                          | Purpose                                                                                      | Req        |
| ------ | ----------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| `GET`  | `/providers`                  | Installed adapters, versions, capability manifests                                           | F3.5, F3.6 |
| `GET`  | `/providers/routes`           | Which providers can serve a run here, and by which route — the composer's picker             | F3.2, F3.7 |
| `POST` | `/providers/doctor`           | Re-probe binaries and run the conformance battery                                            | F3.4       |
| `GET`  | `/config` / `PATCH` `/config` | `.DeFlow/config.yaml` as JSON                                                                |            |
| `GET`  | `/health`                     | `{ apiVersion, build, daemonEpoch, headSeq, uptimeMs }` — **the only unauthenticated route** |            |

The first two rows look like one endpoint split in half and are deliberately not. `GET /providers`
answers *"what has been probed on this machine"* out of the ledger's capability rows — versions,
digests, advertised capabilities. `GET /providers/routes` answers *"can a run start on it here, and
on which route"*, from the resolutions `boot()` established and handed to admission in the same
expression, so the composer's picker, `deflow doctor` and admission are three renderings of one
answer (KAR-19.10, KAR-22.2 AC2). Merging them would put two producers behind one path, and the
failure mode is the one EPIC-19 shipped to end: a client reading `installed: true` off a probed row
and concluding a run could use it.

`GET /providers/routes` answers `{ providers, known }`. **`known: false` is a real answer**: a
daemon booted without provider roots has no honest basis on which to call anything missing, and an
empty array read as "nothing is installed" would send an operator to npm to fix a machine that is
fine.

### PTY

| Protocol    | Path                  | Purpose                     | Req  |
| ----------- | --------------------- | --------------------------- | ---- |
| `WebSocket` | `/pty/:runId/:nodeId` | Interactive terminal attach | F8.2 |

---

## 7. Shapes for the interesting ones

### 7.1 `POST /api/runs`

```jsonc
// request
{
  "input": {
    "kind": "text",
    "text": "Migrate the design system across packages/ui",
  },
  //         | { "kind": "file", "path": "docs/spec.md" }
  //         | { "kind": "issue", "url": "https://github.com/…/issues/412" }
  "cwd": "/Users/meg/work/voyado-web",
  "budget": { "costUsd": 25, "wallclockMs": 14400000 },
  "permission": "worktree", // read | worktree | worktree+net | full  (F5.4)
}
```

```jsonc
// 201 Created
{ "runId": "r_01JXQ…", "seq": 10433, "status": "awaiting-spec-approval" }
```

Creating a run does **not** start execution. It appends `task.submitted` (KAR-10.1) and, once the
framing interview (KAR-10.2) has produced a `TaskSpec` to run against, `run.created`; execution
begins only after `POST /runs/:id/spec/approve` (F1.3). `run.created`'s payload carries the spec
itself (§9 of [the domain model](./04-domain-model.md)), which intake cannot honestly produce —
"no interpretation happens here" ([06 §1.1](./06-planning-and-replanning.md)) — so it is framing's
event to append, not intake's.

**Admission happens before the response** (KAR-19.2). If no provider in the registry resolves to a
spawnable adapter, the request is refused with `422 no_usable_provider` — or
`422 provider_handshake_failed` when one resolved and did not answer ACP `initialize`:

```jsonc
// 422 Unprocessable Content
{
  "error": {
    "code": "no_usable_provider",
    "message": "…", // doctor's own sentences, then the mock-agent hint
    "detail": {
      "runId": "r_01JXQ…",
      "providers": [
        {
          "id": "claude",
          "state": "adapter-missing", // installed | adapter-missing | not-installed | handshake-failed
          "vendorPath": "/opt/homebrew/bin/claude",
          "adapterPackage": "@agentclientprotocol/claude-agent-acp",
        },
      ],
    },
    "retryable": false,
    "seq": 10435, // the `run.aborted` that ended it
  },
}
```

The run still exists: its ledger holds `task.submitted`, one `provider.probed` per registered
provider recording what was and was not found, and `run.aborted` with `outcome: "failed"` — so the
refusal reaches the `runs=*` topic like any other ending, and is answerable six weeks later (NF8).
`GET /api/runs/:id` carries the same `{ code, message, providers }` under `refusal`. `message` is
rendered by the function `deflow doctor` prints from, never a second wording, and `deflow run`
exits `5` (`environmentUnusable`) on it.

Admission is a read of what the daemon probed at boot: it spawns no child of its own, so a machine
with a usable provider pays nothing for the check.

### 7.2 `GET /api/runs/:id/events?since=<seq>`

```jsonc
{
  "events": [
    /* EventEnvelope[] */
  ],
  "cursor": 10891, // highest seq in this page
  "headSeq": 10891, // highest seq in the ledger for this run
  "more": false, // true ⇒ call again with since=cursor
}
```

`limit` defaults to 1000 and is capped at 5000. The client hydrates in a loop until `more` is false,
then opens the stream at `cursor`. `headSeq` lets the UI show an honest progress bar during a long
hydrate rather than a spinner of unknown duration.

### 7.3 `GET /api/runs/:id/snapshot?seq=N`

The reason this exists is browser memory, not server convenience. Scrubbing the plan-evolution
timeline (F10.2) or replaying a run (F10.10) must not mean replaying from `seq` 0 in JavaScript — on
a multi-hour run that freezes the tab. SQLite rebuilds state far faster than the browser can
(**verified 2026-08-02**: 10,000 control-plane events reduced to state in **29 ms**).

```jsonc
{
  "seq": 8200,
  "state": {
    /* the reduced RunState at exactly seq 8200 */
  },
  "planVersion": 4,
  "planHash": "sha256:…",
}
```

`seq=head` is accepted as an alias for the current head. The client replays forward from the
nearest snapshot only.

### 7.4 `GET /api/runs/:id/plans/diff?from=3&to=4`

```jsonc
{
  "from": 3,
  "to": 4,
  "nodes": {
    "added": ["n_probe_deps"],
    "removed": [],
    "changed": [
      {
        "id": "n_impl_3",
        "patch": [{ "op": "replace", "path": "/provider", "value": "codex" }],
      },
    ],
    "unchanged": ["n_spec", "n_recon", "n_impl_1", "n_impl_2"],
  },
  "edges": { "added": ["n_recon->n_probe_deps"], "removed": [] },
  "unionLayoutKey": "r_01JXQ…:union:v1-v4",
  "reason": "Anthropic rate limit hit; re-routing implementation node to Codex",
  "decision": "auto",
}
```

`patch` is RFC 6902 (`rfc6902@5.3.0` — **not** `fast-json-patch`, which last shipped in 2022) so the
UI can render a field-level "why did this change" panel next to the human-readable `reason` from the
`plan.patched` event. `unionLayoutKey` is a cache key, not coordinates: the union-graph layout is
computed once by the client's ELK worker and cached under it. See
[frontend architecture §6.2](./12-frontend-architecture.md).

### 7.5 `POST /api/runs/:id/interject`

```jsonc
// request
{
  "nodeId": "n_impl_3",
  "text": "Use the existing useToast composable, don't add a new one.",
  "mode": "next-turn", // next-turn | pause-and-inject
  "ifLastSeq": 10891,
}
```

```jsonc
// 202 Accepted
{ "seq": 10892, "delivery": "queued" } // queued | delivered | unsupported
```

`delivery: "unsupported"` is returned, with 202 and not an error, when the node's adapter cannot
accept mid-turn steering (F8.5 is P1 and adapter-dependent). The UI must render that honestly rather
than showing a delivered guidance bubble that never arrived.

### 7.6 `GET /api/runs/:id/nodes/:nodeId/io`

Returns `application/x-ndjson`, one `io_chunk` per line, so a terminal reattach can stream rather
than buffer:

```
{"seq":88120,"stream":"stdout","ts":1754140012345,"data":"[32m✓[0m 42 tests passed\r\n"}
```

The browser asks for the **last N KB**, never the whole log — `fromSeq` omitted plus `limit` set
means "tail". The complete archive lives on disk at `runs/<runId>/nodes/<nodeId>/stdout.log` (NF8)
and is opened in a virtualised viewer, not in xterm.

### 7.7 The PTY WebSocket

`GET /api/pty/:runId/:nodeId` upgrades. The upgrade is handled by a `server.on('upgrade', …)`
listener attached to the same Node HTTP server that Hono is serving from, which keeps it independent
of any Hono WebSocket helper's version. Bearer auth is enforced on the upgrade request before the
socket is accepted.

| Direction | Frame  | Payload                               |
| --------- | ------ | ------------------------------------- |
| → server  | binary | Raw bytes to write to the pty         |
| → server  | text   | `{"t":"resize","cols":120,"rows":40}` |
| ← client  | binary | Raw pty output                        |
| ← client  | text   | `{"t":"exit","code":0}`               |

One socket per visible terminal panel, closed on unmount. The socket is a **live interactive
channel only** — durable output continues to land in `io_chunk` regardless, so closing the panel
never loses anything.

---

## 8. Auth

`DeFlowd` binds `127.0.0.1` only. That is not a security boundary and must not be treated as one:
any local process can reach port 7777, and any web page the user has open can reach it via
DNS rebinding.

**Three mechanisms, all required:**

1. **Bearer token.** 32 random bytes generated on first `deflow up`, written to
   `.DeFlow/daemon.json` alongside `{ pid, port, startedAt }`. Every request except `GET /api/health`
   requires `Authorization: Bearer <token>`. Compare in constant time.
2. **`Origin` validation.** Reject any request whose `Origin` header is present and is not the
   daemon's own origin. Send `Vary: Origin` on every response. This is the specific defence against
   DNS rebinding, because a rebound page cannot forge `Origin`.
3. **Bootstrap handoff.** `deflow up` prints a URL carrying the token in the **fragment**:
   `http://127.0.0.1:7777/#token=<token>`. Fragments are never sent to the server, so the token
   cannot land in an access log. The UI reads it once, stores it in `sessionStorage`, strips it
   from the address bar via `history.replaceState`, and sends it as an `Authorization` header
   thereafter. Never a query parameter — see §8.1.

### 8.1 Why the token cannot live in the query string

A token in a URL query string ends up in shell history, terminal scrollback, browser history, the
`Referer` header of any outbound link, and any access log anyone ever adds. For a long-lived token
that authorises spawning processes on the user's machine, that is unacceptable.

This is the entire reason for the client library choice. **Native `EventSource` cannot send custom
headers** — the API has no mechanism for it. So a native-`EventSource` design forces the token into
the query string.

> Use **`eventsource-client@^1.2.0`** (2025-09-19). It is `fetch` + WebStreams based, sends arbitrary
> headers, supports non-`GET` methods, exposes `initialLastEventId` and a configurable reconnection
> policy, and runs in Node as well as the browser.

Two libraries to avoid, both of which rank highly in searches:

- **`@microsoft/fetch-event-source`** — abandoned. Last published 2.0.1 on **2021-04-25**.
- **`eventsource@^4.1.0`** — a spec-faithful polyfill by the same maintainer as `eventsource-client`,
  and therefore deliberately API-compatible with browser `EventSource`, which means it **inherits the
  no-headers limitation**. Its own README points at `eventsource-client` as the modern alternative.

---

## 9. The typed client

Hono's `hc<AppType>` gives the Vue UI end-to-end types straight off the route definitions. No
codegen step, no OpenAPI document, no schema drift.

```ts
// packages/daemon/src/http/api.ts
export const api = new Hono()
  .get("/runs", (c) => c.json(listRuns()))
  .get("/runs/:id", (c) => c.json(getRun(c.req.param("id"))))
  .post("/runs/:id/pause", (c) => c.json(pauseRun(c.req.param("id"))));
// …

export type ApiType = typeof api; // this is the whole contract
```

```ts
// packages/web/src/api/client.ts  — and the CLI imports the same module
import { hc } from "hono/client";
import type { ApiType } from "@DeFlow/daemon/http/api.ts";

export const rpc = hc<ApiType>(baseUrl, {
  headers: () => ({ Authorization: `Bearer ${token()}` }),
});

const res = await rpc.runs[":id"].$get({ param: { id: runId } });
const run = await res.json(); // typed. Rename a field in the daemon → the UI fails to compile.
```

Because `@DeFlow/daemon`'s `exports` field points at `./src/index.ts` inside the workspace (see
[repo layout](./16-repo-layout.md)), the UI typechecks against **live daemon source**. A route
change breaks the build in the same commit that made it. For a solo developer this is the single
largest cross-boundary ergonomic available, and it costs nothing.

**One client module, two consumers.** The stream client lives beside it:

```ts
// packages/web/src/api/stream.ts  — imported unchanged by packages/cli
import { createEventSource } from "eventsource-client";

export function openStream(opts: {
  runs: string[];
  since: number;
  onEvent: (e: Event) => void;
}) {
  return createEventSource({
    url: `${baseUrl}/stream?runs=${opts.runs.join(",")}&since=${opts.since}`,
    headers: { Authorization: `Bearer ${token()}` },
    initialLastEventId: String(opts.since),
    onMessage: ({ data, event }) => {
      if (event && event !== "message") return handleControl(event, data);
      opts.onEvent(JSON.parse(data) as Event);
    },
  });
}
```

`eventsource-client` runs in Node, so `deflow run "…"` consumes the identical stream through the
identical code path — it just renders to a terminal instead of to Vue Flow. There is no second
protocol implementation to keep in sync, which is the usual place a CLI and a UI diverge.

The `Event` union itself is imported **type-only** from `@DeFlow/core`, the package that also
defines the backend reducer's vocabulary. One definition, both sides of the wire.

---

## 10. Errors

Domain failures are values, not exceptions — the same rule the engine uses internally (see
[durable execution](./05-durable-execution.md)). The wire shape is a closed envelope:

```jsonc
{
  "error": {
    "code": "budget_exceeded", // closed union — see below
    "message": "Run budget of $25.00 exceeded; run is paused",
    "detail": {
      "scope": "run",
      "dimension": "cost",
      "limit": 25,
      "actual": 25.4,
    },
    "retryable": false,
    "seq": 10904, // the ledger event that records this, when there is one
  },
}
```

| HTTP | `code` values                                                                     |
| ---- | --------------------------------------------------------------------------------- |
| 400  | `invalid_request`, `schema_violation`, `unknown_provider`                         |
| 401  | `missing_token`, `bad_token`                                                      |
| 403  | `bad_origin`, `permission_refused`, `path_scope_violation`                        |
| 404  | `run_not_found`, `node_not_found`, `artifact_not_found`, `plan_version_not_found` |
| 409  | `stale_cursor`, `run_not_pausable`, `patch_already_decided`, `epoch_mismatch`     |
| 413  | `payload_too_large`                                                               |
| 422  | `spec_not_approved`, `capability_unsupported`                                     |
| 429  | `provider_rate_limited`                                                           |
| 500  | `internal`                                                                        |
| 503  | `daemon_starting`, `provider_unavailable`                                         |

`code` is a stable identifier that clients may branch on; `message` is for humans and may change
freely. `detail` is typed per code. Every error that also produced a ledger event carries its `seq`,
so the UI can link "this failed" to "here is the event that says so" — that is NF10 applied to the
error path, which is exactly where auditability usually stops.

**The union is closed, and the table above is a subset of it.** The codes the in-process services
answer with are members too, listed here rather than folded into a documented neighbour: squeezing
"this node is no longer running" into `run_not_pausable` would make the wire *less* informative, and
a client branching on `code` would have to unpick `detail` to find out what actually happened.

| HTTP | additional `code` values                                                       | why it is not one of the above                                               |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 404  | `not_found`                                                                    | a path this API does not serve, or a sub-resource with no more specific code |
| 404  | `patch_not_found`                                                              | the run exists and never proposed this patch                                 |
| 409  | `already_answered`                                                             | a human gate, or a spec gate, that somebody already decided                  |
| 409  | `node_not_running`, `use_respond`                                              | KAR-13.3's two interjection refusals — different remedies, different words   |
| 422  | `unknown_option`, `missing_payload`, `empty_text`, `not_applicable`, `apply_unavailable` | understood, and not actionable as asked                             |
| 422  | `no_usable_provider`, `provider_handshake_failed`                              | KAR-19.2's admission refusals — this machine cannot host a run (see §7.1)    |

`packages/daemon/src/http/errors.ts` is where the union lives — one enumerated list, one status per
code — and `errors.test.ts` transcribes the first table by hand and checks every pair, so the two
cannot drift.

Errors on the **SSE stream** are different: a stream never returns an error body mid-flight. A fatal
condition closes the connection with a final `event: fatal` frame carrying the same envelope, and
the client stops retrying only for `bad_token` and `epoch_mismatch`.

---

## 11. Idempotency of writes

Three layers, applied in this order:

1. **Most writes are naturally idempotent because they are event appends over a state machine.**
   Pausing a paused run is a no-op that returns the existing `seq` and `200`, not an error. Approving
   an already-approved patch returns `409 patch_already_decided` with the original decision, so the
   UI can show what actually happened rather than double-applying.

2. **Optimistic concurrency via `ifLastSeq`.** Any write may carry `ifLastSeq: <seq>`, meaning "I am
   acting on the state I had at this cursor". If the run's head has advanced past it _in a way that
   changes the decision surface_, the daemon returns `409 stale_cursor` with the current head. This
   is what stops an operator approving a patch on a panel that went stale while they read it — a real
   hazard given that patches are auto-applied on a policy timer (F2.5).

3. **`Idempotency-Key` header on creation.** `POST /api/runs` accepts an `Idempotency-Key`; a repeat
   with the same key returns the original `201` body rather than starting a second run. This exists
   for the CLI and for retry-on-network-blip, and it is stored in the `effect` journal alongside
   engine-level idempotency keys, not in a separate table.

The engine's own `(runId, nodeId, attempt)` idempotency keys (F4.3) are **not** exposed on the API.
They govern side effects inside the daemon. Conflating the two would let a client reach into the
effect journal, which is precisely the invariant that makes crash recovery sound.

---

## 12. Versioning

The API is versioned on three independent axes, and only one of them ever needs a URL change.

| Axis               | Mechanism                                                                                                                                 | Why it is enough                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Event payloads** | Every envelope carries `v`. Readers upcast old payloads; the reducer ignores unknown `kind`                                               | This is where change actually happens. Adding an event kind or a payload field is not a breaking change by construction |
| **Build skew**     | `X-DeFlow-Api: 1` on every response; `hello.build` on the stream. An old tab against a new daemon detects the mismatch and prompts reload | Daemon and UI ship in the same npm tarball, so skew only ever means "stale tab", never "stale deployment"               |
| **Shape breaks**   | `/api/v2/...`, mounted alongside `/api/...`, reserved and unused                                                                          | Kept in reserve. If it is ever needed, both versions serve from the same ledger                                         |

`GET /api/health` is the unauthenticated discovery endpoint and returns
`{ apiVersion, build, daemonEpoch, headSeq, uptimeMs }`. It is unauthenticated deliberately so that
`deflow up` can poll for readiness before it has read the token file, and it exposes nothing a local
process could not already learn from `.DeFlow/daemon.json`.

Two things are explicitly **not** part of the versioned contract: the `io_chunk` NDJSON framing
(a tail format, may change) and `unionLayoutKey` (an opaque cache key).

---

## 13. What not to do

- **Do not open one SSE connection per run panel.** Six-connection cap, silent hang, afternoon lost.
  One connection per tab, server-side filtering, client-side fan-out.
- **Do not put compression middleware in front of `/api/stream`.** Buffered SSE arrives in bursts and
  looks like a scheduler bug.
- **Do not proxy SSE through the Vite dev server.** D10 exists to remove this entire class of bug.
  If you ever run two processes anyway, set `timeout: 0` and `proxyTimeout: 0` and verify the stream
  is unbuffered before you trust anything you see.
- **Do not rely on `Last-Event-ID` alone.** It is absent after a page reload and after a failed first
  connect. The `?since=` hydrate path is mandatory.
- **Do not write gap detection.** `seq` gaps are normal; rolled-back transactions burn values.
  "Strictly greater than" is the only contract.
- **Do not emit the post-commit notification inside the transaction.** A rollback would hand clients
  a cursor past an event that does not exist.
- **Do not hold a read cursor open for the life of a stream.** Measured: an 82.6 MB WAL that no
  checkpoint could truncate.
- **Do not put the bearer token in the query string.** It is the reason `eventsource-client` is a
  dependency rather than native `EventSource`.
- **Do not use `@microsoft/fetch-event-source`** (abandoned 2021) or plain `eventsource`
  (no header support by design).
- **Do not treat `127.0.0.1` as authentication.** Bearer token _and_ `Origin` validation, from
  commit one.
- **Do not stream `io_chunk` on the control-plane stream.** Agent stdout is the data plane; it has
  its own endpoint and its own back-pressure story.

---

**Related:** [Durable execution](./05-durable-execution.md) · [Frontend architecture](./12-frontend-architecture.md) · [Domain model](./04-domain-model.md) · [Security model](./15-security-model.md) · [Local development](./03-local-development.md)

[← Back to index](./README.md)
