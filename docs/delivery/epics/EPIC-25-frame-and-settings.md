# EPIC-25: The frame tells the truth — global settings, project-scoped work, and the decisions you can actually answer

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-25-frame-and-settings-flows.md)

|                      |                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-25                                                                                                                                                                                    |
| **Status**           | Ready                                                                                                                                                                                      |
| **Priority**         | P0                                                                                                                                                                                        |
| **Milestone**        | M1                                                                                                                                                                                        |
| **Workstream**       | W18 — added 2026-08-18, after the owner ran the built application against a real project and filed ten defects plus two daemon stack traces                                                 |
| **Size**             | ~14 days across 9 stories                                                                                                                                                                 |
| **Depends on**       | EPIC-24 (the token layer and the fifteen `ui/` primitives every screen here is built from), EPIC-22 (projects, connectors, the composer), EPIC-19 (a run with a gate to answer)             |
| **Blocks**           | Nothing mechanical. It blocks the application being usable without a terminal, which is what EPIC-22 was for                                                                               |
| **PRD requirements** | F10.1, F10.3, F10.6, F10.9, F10.11, NF8, NF10, AR-1                                                                                                                                       |
| **Architecture**     | [12-frontend-architecture.md §8–§10](../../12-frontend-architecture.md), [ADR-0003](../../adr/0003-never-hold-provider-credentials.md), [ADR-0011](../../adr/0011-vite-middleware-mode-inside-the-daemon.md)                  |
| **Design source**    | [`docs/design/expected/EPIC-25/`](../../design/expected/EPIC-25/) — seven screenshots supplied by the owner 2026-08-18, annotated below. Direction A (EPIC-24) remains the token vocabulary |

## Goal

At the end of this epic **the frame around the application matches what the application actually
is**: settings that apply to the machine live in one global place, work that belongs to a project is
only offered inside a project, every state the frame announces has a way to act on it, and the two
daemon defects that stop a real run dead are fixed.

EPIC-24 gave the product one vocabulary. It did not change what the frame *said*, and running it
against a real repository on 2026-08-18 showed that what the frame says is wrong in ten specific
ways — the rail offers project-scoped items at global scope and global ones at project scope, the
active row is unreadable in one theme, a "needs a decision" badge announces a decision with no way
to answer it, the connectors screen calls the same service both `not-installed` and `connected` in
the same row, and there is no way back to the start.

**This epic is allowed to change behaviour**, unlike EPIC-24. Routes move, nav items change scope,
the composer stops being a modal and becomes a page, and two daemon code paths are corrected. What
it is *not* allowed to do is invent a fact: every status the frame renders still comes from the
daemon, and no screen here starts a second probe of something the daemon already answers.

## Why this matters

The owner's report is the whole argument, so it is reproduced rather than summarised. Running
`pnpm dev` against `/Users/zohresalmi/projects/negarang`:

1. **Projects and Connectors sit in the rail at project scope.** They vanish on `/projects` and come
   back when a project is selected. Both are global concerns; neither is a thing you do *inside* a
   project.
2. **The active nav row is unreadable in one theme.** `--state-running` fill with `--surface-canvas`
   ink inverts correctly in dark and disappears in light.
3. **Runtimes are a read-only list in the rail with nowhere to manage them.**
4. **"Workspace" is the wrong word.** The thing it shows is a workflow.
5. **Runs and Workflows are project-scoped and are not scoped that way.**
6. **A run can be started with no project selected** — the composer offers it, then the daemon
   refuses it. And the new-project form is inline where it should be a modal.
7. **The topbar says "needs a decision" and nothing can answer it.** Clicking the run in the table
   shows nothing; clicking it on the canvas shows nothing. The only way through is
   `deflow answer` in a terminal — which is exactly the terminal EPIC-22 exists to make optional.
8. **There is no way back to the start.** The brand mark is not a link and the breadcrumb is text.
9. **Connectors contradicts itself.** GitHub renders as `connected` while Jira renders
   `not-installed` *and* offers "Disconnect" *and* says "in use since". Two different facts —
   "is the CLI on this machine" and "is this project bound to this service" — are rendered as one.
10. **The composer is a modal.** The supplied design is a page.

And the terminal, over the same session, printed two failures on a loop:

- `WorktreeCreateFailed … fatal: '…/worktrees/recon' already exists`, once per drive tick, forever.
  A run that fails after provisioning a worktree can never be carried on again, because the retry
  path is not idempotent. The run in the screenshot is stuck at `recon`/`spec-approval` with both
  nodes `Failed` and no provider ever recorded — that is this bug, rendered.
- `ERR_HTTP_HEADERS_SENT` out of `@hono/node-server`'s `responseViaCache`. The Vite-middleware
  adapter resolves "not handled" and lets Hono build a second response over a socket something has
  already written to.

Together these are the difference between a product that demos and a product that works. The design
system was the clothes; this is the wiring.

## What the supplied screenshots specify

Seven files, vendored unmodified at [`docs/design/expected/EPIC-25/`](../../design/expected/EPIC-25/).
They are a **blueprint, not a pixel contract** — the token vocabulary is EPIC-24's and does not move.
What each one settles:

| File                              | Settles                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-frame-workflow-run.png`       | The rail's item set and order (Projects · Workflow · Runs · Builder · Settings), RUNTIMES as a **read-only glance** with a model count, the identity footer, the theme toggle at the bottom of the rail rather than the topbar |
| `02-inspector-config.png`         | The node inspector's three tabs — Output / Config / Logs — and that Config is a `UiMetaRow` list, not prose                                                    |
| `03-inspector-logs.png`           | The Logs tab: a timestamped, level-coloured stream                                                                                                            |
| `04-frame-fanout-run.png`         | The workflow tab strip above the canvas, and the phases/agents table below it                                                                                 |
| `05-frame-fanout-scrolled.png`    | Same, confirming the canvas scrolls independently of the table                                                                                                |
| `06-settings.png`                 | **The settings page.** Three panels: *Providers & runtimes* (per-row health, model list, enable toggle, a `Rescan` action), *Issue tracker* (Linear · Jira · GitHub, each with one status and one action), *Execution defaults* |
| `07-new-run-page.png`             | **The new-run page.** A centred prompt — "What do you want me to do?" — a source picker on the left of the composer bar, a model picker on the right, `Run` with `⌘↵`, and "start from a workflow" chips below. A page, not a modal. Note the rail here is the *project-scoped* set: New run · Ongoing runs · History |

### Two things the screenshots show that this epic does **not** build

Stated so a future reader does not read the omission as an oversight:

- **"Builder"** (`01`) — a workflow authoring surface. There is no route for it and no epic behind
  it. EPIC-24's KAR-24.4 already refused to draw a nav row for a route that does not exist, and
  that rule holds here.
- **Per-node `Temperature` / `Max steps` / `System prompt` as editable fields** (`02`) — the
  inspector renders what the ledger recorded. Making them editable is a plan-authoring feature,
  not a frame fix.

## Scope decision recorded: what "manageable runtimes" means

The owner asked for runtimes to be "managable (possible to add, remove, install, etc)". This epic
delivers four of those verbs and deliberately does not deliver the fifth:

- **Rescan** — `POST /api/providers/doctor` already exists and is single-flight. The button is a
  caller, not a new probe.
- **Enable / disable** — persisted daemon-side, so a disabled runtime stops being offered by the
  composer's picker and by admission. One fact, two readers.
- **Add** — register an endpoint-shaped runtime (the blueprint's `OpenAI-compatible · not configured`
  row): a base URL and a name. This is the only kind of runtime that can be *added* rather than
  detected.
- **Remove** — unregister an added one. A *detected* runtime cannot be removed, because removing it
  would mean lying about what is on the machine; it can only be disabled.
- **Install — not built.** Installing a runtime means running a global package install. DeFlow
  showing the exact command and a copy button is honest; DeFlow executing an arbitrary global
  install triggered from a browser tab is a shell in a web page. The command is rendered; the
  execution is not. **If the owner wants the execute-button, it is a follow-up story and should be
  a deliberate decision, not a side effect of this one.**

## Stories

| Story     | Title                                                                        | Size | Depends on           |
| --------- | ---------------------------------------------------------------------------- | ---- | -------------------- |
| KAR-25.1  | The nav says what scope it is in, and the active row is readable in both themes | M    | —                    |
| KAR-25.2  | `/settings` — one global page, and the way back home                          | M    | KAR-25.1             |
| KAR-25.3  | Providers & runtimes, managed                                                 | L    | KAR-25.2             |
| KAR-25.4  | Connectors stop contradicting themselves, and move into settings              | M    | KAR-25.2             |
| KAR-25.5  | The new-run page replaces the modal                                           | L    | KAR-25.1             |
| KAR-25.6  | A new project is a modal                                                      | S    | KAR-25.1             |
| KAR-25.7  | Every announced decision can be answered where it is announced                | L    | —                    |
| KAR-25.8  | A worktree that already exists is not a dead run                              | M    | —                    |
| KAR-25.9  | The response that was written twice                                           | S    | —                    |

---

### KAR-25.1 — The nav says what scope it is in, and the active row is readable in both themes

**As** an operator, **I want** the rail to offer exactly the things that make sense where I am,
**so that** I stop clicking items that disappear when I navigate.

Fixes owner defects 1, 2, 4, 5.

The scope rule, stated once and implemented once:

| Item          | Scope           | Route                       |
| ------------- | --------------- | --------------------------- |
| **Projects**  | Global — always | `/projects`                 |
| **Settings**  | Global — always | `/settings` (KAR-25.2)      |
| **Workflows** | Project only    | `/projects/:projectId`      |
| **Runs**      | Project only    | `/projects/:projectId/runs` |

"Workspace" is renamed **Workflows** everywhere it is user-visible: the nav label, the route name,
the breadcrumb's view label, and the view's own heading. `ProjectWorkspaceView.vue` is renamed
`ProjectWorkflowsView.vue`; nothing about what it renders changes in this story.

Runs becoming project-scoped is a real route change: today `/` is the global run list. `/` becomes
the **project chooser** when no project is open (`/projects`' content), and the run list lives at
`/projects/:projectId/runs`. A bookmark of `/runs/:runId` still resolves — a run knows its project,
so the route redirects rather than 404s.

**Acceptance criteria**

1. On `/projects` with no project open, the rail shows exactly **Projects** and **Settings**. No
   Workflows row, no Runs row, no project-scoped item of any kind.
2. Inside a project, the rail shows **Projects · Workflows · Runs · Settings**, in that order.
3. Neither Projects nor Settings ever disappears, at any route, in any state.
4. The active row meets **WCAG AA against the ink it is painted with, in both themes**, asserted by
   a test that computes the ratio from resolved custom properties — not by eye. The fix is made in
   the design system (a token pair or a `ui/` component), never as a one-off override on this
   instance.
5. The active row still carries a non-colour signal (weight and `aria-current="page"`), unchanged.
6. The word "Workspace" does not appear in any user-visible string in `packages/web`, asserted by a
   guard over the source.
7. `/runs/:runId` and `/runs/:runId/*` resolve for a run that exists, by redirecting to the
   project-scoped equivalent. A run id that does not exist renders the existing not-found view.
8. Every `to` in the rail resolves to a route the router registers — KAR-24.4 AC2's rule, unchanged.

---

### KAR-25.2 — `/settings` — one global page, and the way back home

**As** an operator, **I want** one page for everything that applies to this machine, **and** a way
back to where I started, **so that** settings are not scattered through project screens.

Fixes owner defects 1 (the destination half) and 8. Blueprint: `06-settings.png`.

The page is global — it takes no `projectId`, and nothing on it is stored per project. It has a
heading, a one-line subtitle, and three panel slots in the blueprint's order: *Providers & runtimes*
(filled by KAR-25.3), *Issue tracker* (filled by KAR-25.4), *Execution defaults* (filled by this
story).

*Execution defaults* renders what `GET /api/config` already reports and writes back the fields the
daemon already accepts. It invents no setting. A field the daemon has no home for is not rendered.

The way home, in three places:

- The **brand mark** in the rail is a link to `/`.
- The **breadcrumb** in the topbar is links, not text: each segment navigates to its own level.
- `/` resolves to the project chooser rather than a run list that is now project-scoped.

**Acceptance criteria**

1. `/settings` renders with no project open and with a project open, identically. It never reads a
   `projectId`.
2. The page renders the three panels in the blueprint's order, each built from `ui/` primitives with
   no colour literal and no bespoke panel chrome.
3. *Execution defaults* renders only fields present in `GET /api/config`'s response, and a change is
   persisted through the config route the daemon already exposes. A field with no daemon home is
   absent, not disabled.
4. The brand mark is a link to `/` with an accessible name, and is keyboard reachable.
5. Every breadcrumb segment except the last is a link to that level; the last is the current page and
   is not a link.
6. From any route in the application, `/` is reachable in one click without using browser history.
7. `/settings` is in the rail's global set (KAR-25.1 AC3) and is active on `/settings`.

---

### KAR-25.3 — Providers & runtimes, managed

**As** an operator, **I want** to see what runtimes this machine has and change which ones DeFlow
may use, **so that** a runtime I do not want is not silently offered to a run.

Fixes owner defect 3. Blueprint: `06-settings.png`, top panel. Scope is as recorded above — add,
remove, enable, disable, rescan; **install is rendered as a command, not executed**.

The rail keeps its RUNTIMES glance (blueprint `01`) and it stays read-only: it is a status line, and
the management lives here. Both read the same `GET /api/providers`; there is one probe.

**Acceptance criteria**

1. Each row shows: the runtime's name, its endpoint or binary path, the models it reports, its health
   as the daemon worded it, and an enable toggle. Nothing on the row is computed by the browser.
2. **Rescan** calls `POST /api/providers/doctor` and re-renders from its result. It does not
   re-probe locally, and a second click while one is in flight does not start a second probe.
3. Disabling a runtime persists daemon-side and removes it from `GET /api/providers/routes`, so the
   composer's picker and admission agree with this page without either being told separately.
4. A runtime that is **detected** cannot be removed — the row offers disable only, and says why in
   one sentence.
5. A runtime that was **added** can be removed, and removing it is confirmed first.
6. Adding a runtime takes a name and a base URL, validates the URL shape before submitting, and
   renders the daemon's refusal verbatim if the daemon refuses.
7. A runtime the daemon reports as not installed shows its install command with a copy control, and
   **no button that would run it**. This absence is asserted, the way `connectors.test.ts` asserts
   the absence of a token field.
8. The rail's RUNTIMES list and this panel never disagree, because both render one response.

---

### KAR-25.4 — Connectors stop contradicting themselves, and move into settings

**As** an operator, **I want** one status per service, **so that** I stop reading "not-installed"
and "Disconnect" on the same row.

Fixes owner defect 9. Blueprint: `06-settings.png`, *Issue tracker* panel.

The contradiction is real and is a rendering bug, not a daemon bug. The daemon reports two
independent facts and the screen paints them as one:

- **`state`** — what the CLI probe found on this machine (`not-installed` · `connected` · …).
- **`connected` / `connectedAt`** — whether *this project* has a row binding it to the service.

A project can be bound to Jira while `acli` is not installed. That is a coherent state and the
daemon is right to report it; the screen is wrong to render it as "not-installed · Disconnect · in
use since". So the row renders **one resolved status** with the second fact as its detail line, and
the action offered is the one that state permits:

| CLI state       | Project bound | Status shown           | Action        |
| --------------- | ------------- | ---------------------- | ------------- |
| `connected`     | yes           | `connected`            | Disconnect    |
| `connected`     | no            | `available`            | Connect       |
| `not-installed` | yes           | `bound · CLI missing`  | Disconnect    |
| `not-installed` | no            | `not installed`        | — (install command only) |
| no route at all | either        | `cannot be connected`  | — (KAR-22.6's rule, unchanged) |

The panel moves onto `/settings`. The project binding it writes is still per project, so the panel
names which project it is binding and is disabled with an explanatory line when no project is open.
`/projects/:projectId/connectors` keeps resolving and redirects to `/settings`.

**Acceptance criteria**

1. A row never shows a CLI state and a binding state as if they were one fact. The status word is
   the resolved status from the table above, asserted for all five rows of that table.
2. A row with `state: 'not-installed'` and no binding offers **no Disconnect control**, and no "in
   use since" line.
3. Every sentence about credentials still comes from the daemon's service descriptor, verbatim.
   KAR-22.4's rule that this screen composes no prose about ADR-0003 is unchanged.
4. There is still **no token input anywhere on the screen**, asserted over the whole page, unchanged
   from `connectors.test.ts`.
5. A service with no authorisation route gets its paragraph and no button and no link — KAR-22.6,
   unchanged.
6. With no project open the panel renders, explains that binding needs a project, and offers no
   action that would 422.
7. `/projects/:projectId/connectors` redirects to `/settings` rather than 404ing.

---

### KAR-25.5 — The new-run page replaces the modal

**As** an operator, **I want** starting a run to be a page I can land on, link to and come back to,
**so that** the most important action in the product is not a dialog I lose by pressing Escape.

Fixes owner defects 6 (the run half) and 10. Blueprint: `07-new-run-page.png`.

`RunComposer.vue` stops being a `UiModal` and becomes the body of a route,
`/projects/:projectId/new-run`. Everything it *does* is preserved exactly — the three intake shapes,
the picker that reduces `GET /api/providers/routes` and nothing else, the verbatim refusal, the
`⌘/Ctrl+Enter` chord. What changes is where it lives and what opens it.

**A run cannot be started without a project.** Today "Start a run" is always enabled and the daemon
refuses afterwards. The topbar action and the `c` shortcut now navigate to `/projects/:id/new-run`
when a project is open, and to the project chooser when one is not — with a line saying why. The
refusal moves from after the click to before it.

Layout, from the blueprint: a centred question, a single large prompt field, a source picker at the
composer bar's left, a model picker at its right, a `Run` button showing `⌘↵`, and — when the project
has any — "start from a workflow" chips beneath.

**Acceptance criteria**

1. `/projects/:projectId/new-run` renders the composer as a page. There is no dialog role and no
   focus trap; Escape does nothing.
2. Every behaviour named in `composer.test.ts` still passes: three intake shapes, the picker's single
   source, the verbatim refusal, the submit chord.
3. With no project open, the "Start a run" affordance does not submit anything — it routes to the
   project chooser and says a project is needed.
4. The model picker is grouped by provider, shows each model's context size, and its options come
   from `GET /api/providers/routes` alone.
5. The prompt field is focused on entering the route, and `/` from anywhere focuses it, matching the
   blueprint's footer hint.
6. `⌘/Ctrl+Enter` submits from the prompt field, unchanged.
7. The `COMPOSER_OVERLAY` overlay id and its store entry are **removed**, not left dangling — a
   guard asserts no component still opens an overlay nothing renders.
8. On submit, the operator lands on the created run's workflow view, not back on the form.

---

### KAR-25.6 — A new project is a modal

**As** an operator, **I want** the new-project form in a modal, **so that** the projects grid is not
half form.

Fixes owner defect 6 (the project half).

`ProjectsView.vue`'s inline `<form>` moves into `UiModal`, opened by all three existing triggers (the
header button, the dashed grid tile, the empty state's action). `UiModal` already supplies the focus
trap, `Esc`, outside-click and focus return; this story adds none of that itself.

The one hazard is `projects.test.ts`, which asserts against the form while it is always in the DOM.
A modal that is not open has no form, so those assertions open the modal first — a change of setup,
never of claim. Any assertion that changes is named in the story's notes.

**Acceptance criteria**

1. All three triggers open one modal, and the form exists only while it is open.
2. Submitting creates the project through the same `POST /api/projects` call, and the daemon's
   refusal is still rendered verbatim.
3. On success the modal closes and the new project appears in the grid without a reload.
4. `Esc`, outside-click and the cancel action all close it and return focus to the trigger.
5. The submit control is still the application's one form-submitting button (`type="submit"`),
   KAR-24.7's rule, unchanged.
6. No assertion in `projects.test.ts` about *what the form does* changes; only how it is reached.

---

### KAR-25.7 — Every announced decision can be answered where it is announced

**As** an operator, **I want** to answer a gate from the place that told me it was waiting,
**so that** I never have to open a terminal to unblock a run.

Fixes owner defect 7. This is the epic's most important story.

The defect, precisely: `RunGateBanner` renders on `useRunStore().openGate`, and that store is only
populated for the one run a tab has subscribed to. The topbar's "needs a decision" pill and the
approvals chip read `GET /api/approvals`, which is global. So the announcement is global and the
answer is per-run — and on every screen that is not the run's own, the announcement has nowhere to go.

Three affordances, one answer path (`gateAnswerRequest` — the same function `deflow answer` routes
with; no second path is created):

1. **The approvals chip in the topbar becomes a control.** It opens a list of everything waiting,
   each entry naming its run and its node, each linking to that run's gate.
2. **A run row that is waiting is clickable to its gate**, in the run list and in the project's run
   history, and lands with the gate panel in view.
3. **A node that is waiting is answerable from the node inspector**, so clicking the node on the
   canvas — which today does nothing for a gate — offers the daemon's options.

**Acceptance criteria**

1. From `/` with a run waiting on a gate, an operator reaches that gate and answers it without
   typing a URL and without a terminal.
2. The approvals control lists one entry per waiting gate, naming run and node, and is absent when
   nothing is waiting — never a "nothing waiting" panel.
3. Clicking a waiting run row lands on the run with its gate panel visible without further
   scrolling or clicking.
4. Selecting a waiting node in the inspector offers **every option the daemon offered, in the
   daemon's words**, including the ones no surface can submit — rendered unsubmittable with the
   daemon's reason beside them, KAR-22.5's rule, unchanged.
5. An answer submitted from any of the three surfaces goes through `gateAnswerRequest` and clears
   every one of them via the `human.responded` frame — no surface has a "did my own request
   succeed" special case.
6. An answer submitted from `deflow answer` in a terminal clears all three surfaces too, by the same
   route.
7. Answering twice is not possible: once the frame arrives the controls are gone, from the ledger,
   not from a local flag.

---

### KAR-25.8 — A worktree that already exists is not a dead run

**As** an operator, **I want** a run that failed after provisioning to be able to try again,
**so that** one transient failure does not strand a run forever.

Fixes the first terminal defect.

`WorkspaceManager.provision` runs `git worktree add` unconditionally. When a node fails *after* the
directory is created, `advanceRun` retries on the next drive tick, `git worktree add` exits 128 with
`already exists`, and the run is stuck in that loop indefinitely — the screenshot's `recon` and
`spec-approval` nodes, both `Failed`, no provider ever recorded.

The fix is to make provisioning idempotent about **its own** worktree, and to keep refusing to
silently adopt somebody else's:

- The path exists **and** `git worktree list` reports it registered **and** its lock reason is this
  run's and this node's → **reuse it**, append a `workspace.worktree_reused` event, return the same
  result shape. Not a new worktree, and the ledger says so.
- The path exists and is registered to a *different* run or node → refuse, loudly, as today.
- The path exists and is **not** registered — an orphan from a crash between `mkdir` and the ledger
  append → `git worktree prune`, remove the directory, re-add. The prune is what makes this safe:
  a directory git does not know about is not a worktree anybody is using.

The existing branch-occupancy pre-check for a write node is unchanged and still runs first.

**Acceptance criteria**

1. Provisioning twice for the same run and node succeeds both times and yields the same path,
   branch and lock reason.
2. The second provision appends `workspace.worktree_reused`, not a second
   `workspace.worktree_created`. Two `created` events for one node would make the ledger lie.
3. A path registered to a different run or node is refused, with the existing message naming the
   holder. This case gets its own test against a fixture, not just a code path.
4. An orphan directory that git does not list is pruned and re-added, and the run continues.
5. A run that failed at `recon` after provisioning advances on the next tick rather than throwing.
   Asserted end to end, because this is the failure the owner actually hit.
6. `--detach` read nodes keep their current behaviour: no branch, no occupancy check, two on one
   commit both succeed.

---

### KAR-25.9 — The response that was written twice

**As** whoever is reading the daemon's log, **I want** it to stop printing `ERR_HTTP_HEADERS_SENT`,
**so that** a real error is visible among the noise.

Fixes the second terminal defect.

The actual cause is in `../http/auth.ts`'s `varyOrigin`, not in `fromConnect`. `varyOrigin` calls
`c.header('Vary', 'Origin')` after `next()`, and on a finalized context `c.header()` does not
mutate the existing `Headers` object in place — it **rebuilds** `c.res` as a new `Response`. When
the response underneath is the `RESPONSE_ALREADY_SENT` sentinel that `../http/connect.ts` returns
after Vite's middleware has written straight to the socket, the rebuild produces a copy that is no
longer that singleton. `@hono/node-server` swaps in a `Response` subclass that caches its own
status/body/headers and checks that cache **before** it checks for the `x-hono-already-sent`
header, so the rebuilt copy takes the ordinary write path and `writeHead` runs against a socket
that has already finished — `ERR_HTTP_HEADERS_SENT`.

The fix is one guard in `varyOrigin`, at the point the fact is knowable: after `next()` settles, if
`c.res === RESPONSE_ALREADY_SENT`, return without touching it. Nothing is lost by skipping the
header there — in dev, the assets Vite serves never had Hono-written headers to vary in the first
place, and in production the SPA and its assets are built by `serveStatic`/`c.body` and still get
the header.

`fromConnect`'s own guard is kept as part of this story: trusting `outgoing.headersSent` /
`outgoing.writableEnded` over whatever a connect middleware's `next()` claims fixes a real bug (a
middleware that writes a complete response and then calls `next()` anyway, which is what Vite's
own error and fallback paths do), and the listener cleanup that now runs on every settle path
fixes a real leak. Both stay in the fall-through branch that `varyOrigin`'s guard now protects.
Neither one, though, was what the owner hit — see the note below.

> **The original diagnosis was wrong, and here is how that was found.** This story first shipped
> believing `fromConnect` was the cause, on the write-then-`next()` theory described above. Tested
> against a live dev daemon with the `fromConnect` guard applied and a temporary `console.error` in
> its fall-through branch, every Vite-served request (`/`, `/favicon.ico`, `/src/main.ts`,
> `/gallery`) still produced exactly two `ERR_HTTP_HEADERS_SENT`, and the `console.error` never
> printed — proof the fall-through branch was never reached and the real cause was upstream of it.
> With `varyOrigin`'s guard applied instead, the same navigation produced zero.

**Acceptance criteria**

1. `varyOrigin` returns the `RESPONSE_ALREADY_SENT` sentinel untouched — asserted by identity
   (`===`), not by inspecting its headers, because a rebuilt copy can carry the same
   `x-hono-already-sent` header and still be the object that crashes the write path.
2. An ordinary response (2xx) still carries `Vary: Origin` after passing through `varyOrigin`,
   unchanged from before this story.
3. A refusal response (non-2xx — `requireAuth`'s 401s and 503, an origin rejection) still carries
   `Vary: Origin`, unchanged. AC4 is specifically about refusals not being exempted from the
   header, and this story must not quietly narrow that.
4. A middleware that writes a response **and then** calls `next()` does not produce a second
   response, and does not throw. Tested against a fake connect middleware — no Vite required.
5. A middleware that calls `next()` without writing still falls through to Hono, unchanged.
6. A middleware that writes and does not call `next()` still returns `RESPONSE_ALREADY_SENT`,
   unchanged.
7. Listeners registered on `outgoing` are removed on every settle path; a test asserts the listener
   count returns to its starting value.
8. `packages/daemon`'s existing HTTP suite passes untouched, and the dev daemon serves `/` and
   `/gallery` with no `ERR_HTTP_HEADERS_SENT` in its log across a navigation of every route.

---

## Risks

| Risk                                                                                                                  | Mitigation                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Making Runs project-scoped breaks every existing run-route spec and every bookmark**                                | KAR-25.1 AC7 makes the old paths redirect rather than 404, and the specs move with the routes in one story rather than leaking across nine   |
| **The composer becoming a page is a large behavioural change to the product's most important action**                 | `composer.test.ts` is a fixed point (AC2). The story may move the component and change what opens it; it may not change what submitting does |
| **KAR-25.3's enable/disable adds daemon state that admission and the picker must agree with**                         | AC3 makes them read one response rather than three. If they cannot, the toggle is not shipped — a picker that disagrees with admission is EPIC-19's whole reason for existing |
| **"Install" is the one verb this epic refuses**                                                                       | Recorded above, with the reason, and flagged to the owner rather than quietly dropped                                                       |
| **KAR-25.7 touches the gate path, which has broken twice before**                                                     | One answer path (`gateAnswerRequest`), three renderings. AC5–AC7 assert the ledger clears all three, so no surface gets a local flag         |
| **The nine stories are sequenced with real dependencies and cannot all be parallelised**                              | The dependency column is honest: 25.7, 25.8 and 25.9 are independent of the frame work and can run alongside it                              |

## Definition of done

- All nine stories' acceptance criteria pass.
- Every existing spec in `packages/web` and `packages/daemon` passes. Where an assertion changed, the
  story's notes name it and say why.
- The lint guards (UI vocabulary, colour literal) pass, and no fix in this epic was made as a
  per-instance override — every design change is in the token layer or a `ui/` component.
- The bundle budget (NF3, 220 KB) still holds.
- **Performed, not asserted:** the owner opens the application against a real project, on both
  themes, and confirms each of the ten defects is gone and the two log errors have stopped.
