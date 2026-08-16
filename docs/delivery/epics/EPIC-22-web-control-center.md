# EPIC-22: Web control center — projects, chat-driven runs, live boards

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-22-web-control-center-flows.md)

|                      |                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-22                                                                                                                                                                                                                                                            |
| **Status**           | Not started                                                                                                                                                                                                                                                        |
| **Priority**         | P0                                                                                                                                                                                                                                                                 |
| **Milestone**        | M1                                                                                                                                                                                                                                                                 |
| **Workstream**       | W15 — added 2026-08-13, after the owner asked for "a whole web UI for the solution, a control center" and restated it on 2026-08-14                                                                                                                                 |
| **Size**             | ~23 days across 6 stories                                                                                                                                                                                                                                          |
| **Depends on**       | EPIC-16 (app shell, projections, bounded run store, typed API client), EPIC-17 (the P0 views this reuses — the plan graph above all), EPIC-15 (the HTTP API and the multiplexed SSE stream), EPIC-19 (a run that actually executes), EPIC-18 KAR-18.1 (`init`'s workspace bootstrap) |
| **Blocks**           | Nothing in M1's formal definition of done. It blocks the *use* of everything in it, which is the distinction this epic exists to close                                                                                                                              |
| **PRD requirements** | F1.1, F1.3, F3.2, F3.5, F3.7, F10.1, F10.3, F10.6, F10.9, NF2, NF4, NF7, NF8, NF10, AR-1                                                                                                                                                                            |
| **Architecture**     | [12-frontend-architecture.md §2, §6, §10](../../12-frontend-architecture.md), [11-api-and-realtime.md §6, §7](../../11-api-and-realtime.md), [16-repo-layout.md §7](../../16-repo-layout.md), [05-durable-execution.md §5](../../05-durable-execution.md), [ADR-0003](../../adr) |

## Goal

At the end of this epic an operator opens a browser, **creates a project pointing at a repository on
their machine, types what they want done, picks which agent does it, and watches the run happen** —
and never touches a terminal to do any of it. The project remembers what ran before, and the graph,
the task board and the history are three views of one projection rather than three answers.

Nothing here is a new engine capability. Intake exists (KAR-10.1), admission exists (KAR-19.2),
provider selection exists and has exactly one producer (KAR-19.10), the plan graph exists
(KAR-17.1), the run store and the projections exist (KAR-16.3, KAR-16.4), and `deflow init`'s
workspace bootstrap exists (KAR-18.1). What does not exist is **a way to reach any of it from the
page**, and a notion of a *project* for a run to belong to.

## Why this matters

**Asked for by the owner on 2026-08-12 and restated on 2026-08-14.** Their words: they expected
_"not only a visualization of the graph, but a whole web UI for the solution, a control center"_ —
create a project mapped to a local folder or git repo, see that project's graph, start a run through
a chat-style interface where you pick the adapter and pass a prompt / issue / file, see the list of
tasks the run created with the step names and which model is handling each, and browse history.

**Today the web application can only render a run whose id you already know.** Until KAR-19.1 the
root route did not even list runs — the operator of 2026-08-12 spent an afternoon typing run ids
into the address bar. There is no notion of a project, no way to start a run from the UI, no task
board, no history. Every path into the system runs through a shell, which means the visualisation
that PRD §7.10 calls _"a primary product surface with equal weight to execution"_ is reachable only
by people who have already done the hard part in a terminal.

**And the M1 metric that actually judges this project is `≥ 3 real tasks/week` of personal weekly
active use** ([README §10](../README.md#10-what-done-means-for-m1)). A tool whose only entry point is
a command line with five flags is a tool that gets used on the days you have the energy for it. The
control center is not polish; it is the difference between a finished project and a used one.

## Scope

**In scope:**

- **Projects**: create one against a local path that is a git working tree, bootstrap `.DeFlow/`
  through KAR-18.1's own function, persist them where the daemon persists everything else, list them
  with the truth about whether their path is still there, rename and remove them, and stamp every
  new run with the project it belongs to.
- **Starting a run from the page**: a chat-style composer taking the same three intake shapes
  `deflow run` takes, through the same `submitTask`; an adapter picker reading KAR-19.10's single
  producer of provider state; and the refusal wording KAR-19.2 and KAR-19.12 already ship, surfaced
  verbatim rather than reinvented.
- **The project workspace**: the active run's graph on EPIC-17's canvas, a task/step board that is
  the same projection in a different shape, and run history browsable without knowing a run id.
- **Answering the run's human gates from the page** (KAR-22.5): the gate EPIC-13 opened, the option
  set KAR-19.12 already publishes, and the endpoints `deflow answer` already calls — with one
  request builder shared between the two surfaces rather than a second answer path.
- **Connectors**: the framework and GitHub in KAR-22.4, Linear and Jira in KAR-22.6 — deliberately
  last, and explicitly not required by anything above them. DeFlow holds no connector credential;
  see KAR-22.4's credential decision.

**Out of scope:**

- **A second graph canvas, a second run store, a second projection set or a second API client.**
  EPIC-16 and EPIC-17 built them; a copy is a defect, not a feature. Where this epic needs a
  different *shape* of the same data — the task board — it is a second render of one projection, and
  KAR-22.3 AC3 makes "they can never disagree" a test rather than an intention.
- **Multi-user, accounts, sharing, or a project belonging to anyone.** A project is a row in this
  machine's own state directory. The security model is unchanged: one bearer token, one origin,
  loopback only (docs/15-security-model.md §3).
- **Moving a project's directory, cloning a repository, or creating one.** The path must already be
  a git working tree; `git init` is the operator's command to run, and the refusal says so in
  `deflow init`'s own words.
- **Deleting an operator's code, ever.** Removing a project removes DeFlow's row about it. KAR-22.1
  AC6 makes that a sentence on the screen before the confirmation, not a footnote.
- **A rich text editor, file uploads by drag-and-drop, threading, or a conversation with the agent.**
  The composer submits a task; the run's own surfaces are where the conversation lives.
- **Renaming or restructuring `.DeFlow/`**, the global state directory, or the event vocabulary.
  `task.submitted` gains one optional field and nothing else changes shape.

## Definition of Ready (epic level)

- [ ] EPIC-16 is Done: the app shell, the router, the typed client, the projections and the bounded
      run store all exist and are the ones this epic reuses.
- [ ] EPIC-17 KAR-17.1 is Done: there is a plan-graph canvas to render a project's active run on,
      and KAR-22.3 renders *that* one.
- [ ] EPIC-19 KAR-19.10 is Done: there is exactly one producer of route-aware provider state, and
      the composer's picker reads it rather than probing for itself.
- [ ] EPIC-18 KAR-18.1 is Done: `initWorkspace` exists and is callable, so KAR-22.1 bootstraps a
      project by calling it rather than by writing `.DeFlow/` a second way.
- [ ] A decision is recorded on **where a project lives**. Answered 2026-08-15: the global ledger
      database in the data directory (`$XDG_DATA_HOME/DeFlow/ledger.db`), as its own table behind a
      migration — not `localStorage`, not a JSON file beside it, and not the repository. The
      reasoning is in KAR-22.1's notes.

## Definition of Done (epic level)

- [ ] All six stories are Done, or KAR-22.4 and KAR-22.6 are explicitly deferred with the deferral
      recorded here.
- [ ] Every scenario in [the flow file](../flows/EPIC-22-web-control-center-flows.md) is automated at
      the level it declares and passes on `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] **Performed, not asserted:** a daemon is started, a browser is opened, a project is created
      against a scratch git repository, a run is started from the composer with the bundled agent,
      the run appears and streams, **and its first human gate is answered from the page** — with no
      terminal used after `deflow up`. The transcript goes
      onto the epic's Linear issue. A green suite is not evidence for this item; EPIC-19 exists
      because a green suite coexisted with a pipeline that did nothing.
- [ ] There is exactly one graph canvas, one run store, one projection set and one API client in
      `packages/web`, asserted by a guard rather than by inspection.
- [ ] The adapter picker, `doctor` and admission are shown to answer from one producer — a spec that
      makes them disagree fails.
- [ ] No refusal string in this epic's UI is written twice: the composer renders the words admission
      and the human gate already ship.
- [ ] No `Unverified` claim is introduced by this epic without an entry in the open-risks register.

## User stories

### KAR-22.1 — Projects: create one, map it to a local folder or git repo

|                 |                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                       |
| **Priority**    | P0                                                                                                                                |
| **Size**        | M                                                                                                                                 |
| **Depends on**  | KAR-15.1 (the HTTP API this adds routes to), KAR-16.1 (the app shell and routing), KAR-18.1 (`init`'s workspace bootstrap — reuse it, do not reimplement) |
| **PRD**         | F1.1, NF4, NF8, NF10                                                                                                              |
| **Verified by** | EPIC-22-S1, EPIC-22-S2, EPIC-22-S3, EPIC-22-S4, EPIC-22-S5, EPIC-22-S6, EPIC-22-S7, EPIC-22-S8, EPIC-22-S9, EPIC-22-S10, EPIC-22-S11, EPIC-22-S12, EPIC-22-S13, EPIC-22-S14, EPIC-22-S15, EPIC-22-S16, EPIC-22-S17 |

**As** an operator, **I want** to create a project in the web UI and point it at a local folder or
git repository, **so that** every run I start belongs to a project instead of floating loose.

Everything else in this epic hangs off the noun this story introduces. Without it the composer has
no default working directory, the workspace has nothing to be a workspace *of*, and run history is a
flat list of every run this machine has ever produced across every repository — which is the state
today, and which stops being readable at about thirty runs.

The story is small because it reuses two things wholesale. **`initWorkspace`** (KAR-18.1) is the
whole of "make this directory ready", including the rule that an operator's edited `config.yaml` is
never overwritten; this story calls it and reports its `PathReport[]` rather than writing `.DeFlow/`
a second way. And **the refusal for a path that is not a git working tree is `deflow init`'s own
sentence**, extracted to one exported constant so that the CLI and the browser cannot drift into
telling an operator two different things about one directory.

**Acceptance criteria**

1. A project can be created from the UI: a name, and a local path that must be an existing git
   working tree — the same refusal `deflow init` gives, with the same words, when it is not.
2. Creating a project runs the equivalent of `deflow init` against that path if `.DeFlow/` is
   absent, and reports what it created; it never silently overwrites an operator's edited config.
3. Projects persist across daemon restarts, recorded in the ledger or the global state directory
   rather than browser storage — a project is not a UI preference.
4. Projects list shows, per project, its path, whether the path still exists and is still a git
   repo, and its most recent run.
5. A project whose path has disappeared or is no longer a git repo says so plainly and is not
   silently dropped.
6. A project can be renamed and removed; removing it never deletes the operator's code, and says so
   before confirming.
7. Every run created after this story carries its project id, and runs created before it are still
   viewable.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                          | Red when                                                                                                                                        |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration | `POST /api/projects` against a real `git init -b main` tmpdir; assert 201, the row, and that `GET /api/projects` returns it                                                     | There is no projects surface at all, so a browser has no way to name a repository                                                                |
| 2   | integration | `POST /api/projects` against a tmpdir that is **not** a git working tree; assert 400 and the message byte-identical to `NotAGitWorkingTree`'s                                   | The API writes its own sentence, so the browser and `deflow init` refuse the same directory with two different explanations                      |
| 3   | unit        | A wording guard: the constant the route uses and the constant `NotAGitWorkingTree` throws are the same exported string, and it names `deflow` in lower case                     | The two are copies, and the day one is reworded the other silently keeps the old words                                                           |
| 4   | integration | Create a project against a repo with no `.DeFlow/`; assert `initWorkspace` ran, `.DeFlow/config.yaml` exists, and the response lists the created paths with their statuses      | The route reimplements the bootstrap, and the two writers diverge on `.gitignore`, the schema file or the worktree-include defaults              |
| 5   | integration | Edit `.DeFlow/config.yaml`, then create a project against that repo; assert the bytes are unchanged and the report says `kept (edited)`, or that init was skipped entirely      | Creating a project overwrites a config the operator wrote by hand — the one thing KAR-18.1 AC3 forbids                                           |
| 6   | integration | Create two projects, `db.close()`, reopen the daemon over the same **file-backed** ledger, and list them again                                                                 | Projects are held in memory or in the tab, so restarting the daemon loses every project the operator made                                        |
| 7   | integration | Delete the project's directory from disk, then list; assert the project is still listed with a health state naming the missing path                                            | A vanished path drops the row, and the operator's project disappears without anyone saying why                                                   |
| 8   | integration | `rm -rf` the `.git` directory but keep the folder, then list; assert the health state distinguishes "gone" from "no longer a git repository"                                   | Both failures collapse into one word, so the operator cannot tell a moved folder from a deleted `.git`                                           |
| 9   | integration | Submit two runs against a project, then list; assert the row names the **most recent** one and its status label                                                                | The row shows the first run, or none, and the list stops answering "what happened here lately"                                                   |
| 10  | integration | Rename a project; assert the id, path and run history are unchanged and the new name is what a fresh daemon reads back                                                         | A rename mints a new row, orphaning the runs stamped with the old id                                                                             |
| 11  | integration | Remove a project whose repository has files and a commit; assert the row is gone, `GET /api/projects` no longer lists it, and **every file and the `.git` directory are still there** | Removing a project removes the operator's code, which is unrecoverable and is the worst thing this epic could do                                 |
| 12  | integration | `POST /api/projects` twice with the same path; assert the second is refused and no second row exists                                                                           | One directory acquires two projects, and "its most recent run" has two answers                                                                   |
| 13  | integration | Submit a run with `projectId`; assert `task.submitted`'s provenance carries it and `GET /api/runs/:id` reports it                                                              | The run is created with no project, so nothing downstream can group by one                                                                       |
| 14  | integration | Submit a run with a `projectId` no project holds; assert 400, the field name, and that **no run was created**                                                                  | An unknown project id mints a run nobody can find, which is the floating-loose state this story exists to end                                    |
| 15  | unit        | Fold a `task.submitted` payload with no `projectId` — a run from before this story — through the reducer and the run summary                                                   | `projectId` is required, so every run already on disk becomes unreadable, which a ledger may never do to its own history                         |
| 16  | browser     | Mount the shell at the projects route, fill the form, submit, and assert the row appears; then assert the refusal is rendered for a non-repository path                        | The API works and the page does not, which is the state this whole epic is about                                                                 |
| 17  | browser     | Click remove; assert the confirmation names the path and states that no files are deleted, and that dismissing it issues no request                                            | The destructive action is one click with no sentence, and an operator who misreads it believes their code is gone                                |

**Notes / risks** — the honest hazard is **path identity**. `/repo`, `/repo/`, a symlink to it and
its `realpath` are four strings for one directory, and a projects table keyed on the raw string
would happily hold four rows for it. The path is stored post-`realpath`, exactly as
`resolveWithinRepo` already resolves an intake file, and AC's uniqueness is asserted against the
resolved form — which is also what makes test 12 meaningful rather than a string comparison.

**Where a project lives, decided 2026-08-15.** In the **global ledger database**
(`$XDG_DATA_HOME/DeFlow/ledger.db`), as its own table behind a migration. Three alternatives were
considered and rejected in writing, because AC3 rules out only the worst one:

- **Browser storage** — ruled out by AC3 itself. A project would exist per tab, per browser, per
  profile; `deflow status` could not see it; and clearing site data would delete it.
- **A JSON file in the data directory** — no worse for one process, and worse for two: the daemon
  already holds a lease and a transactional store, and a second writer with its own file locking is
  a second durability story to get right for the sake of avoiding one migration.
- **The repository, under `.DeFlow/`** — the strongest of the three, and rejected because it is
  circular: a project *names* a repository, so a project stored inside the repository cannot be
  listed until you already know where it is. It also makes the operator's list of projects a thing
  they would commit, which nobody wants.

The table is `project`, keyed on a minted `ProjectId` (`prj_<YYYYMMDDTHHMMSSZ>_<6 hex>`, the shape
`mintRunId` uses and for the same reason: string order is creation order), with the resolved path
unique. **It is deliberately not an event.** The ledger's `event` table is the run's history and is
replayed by the reducer; a project is mutable state with a rename and a delete, and putting it in an
append-only log would mean a projection over three event kinds to answer "what projects are there" —
which is the shape `provider_capabilities` and `worktrees` are already tables for.

**What links a run to a project is the ledger, not the table.** `projectId` rides on
`task.submitted`'s provenance beside `cwd`, optional for exactly the reason `cwd` is optional
(KAR-19.3's own note): payloads already on disk do not have it, and a required field would make
every pre-existing run unreadable. So a project's runs are a query over the events the run itself
wrote — one source, and a project row that is deleted cannot orphan a run's own record of where it
came from.

---

### KAR-22.2 — Start a run from a chat-style composer, choosing the adapter

|                 |                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                  |
| **Priority**    | P0                                                                                                                                                           |
| **Size**        | L                                                                                                                                                            |
| **Depends on**  | KAR-22.1 (the project a run belongs to), KAR-19.2 (admission and its refusal wording), KAR-19.10 (explicit provider selection and honest reporting — the same producer), KAR-10.1 (task intake) |
| **PRD**         | F1.1, F1.3, F3.2, F3.5, F3.7, NF7, NF10                                                                                                                      |
| **Verified by** | EPIC-22-S18, EPIC-22-S19, EPIC-22-S20, EPIC-22-S21, EPIC-22-S22, EPIC-22-S23, EPIC-22-S24, EPIC-22-S25, EPIC-22-S26, EPIC-22-S27, EPIC-22-S28, EPIC-22-S29, EPIC-22-S30, EPIC-22-S31, EPIC-22-S32, EPIC-22-S33 |

**As** an operator, **I want** to start a run for a project from a chat-style composer in the web UI
— typing a prompt, attaching a file, or pasting an issue reference, and choosing which agent adapter
handles it — **so that** I never have to drop to a terminal to begin work.

The composer is the thing that makes the control center a control center rather than a viewer. Two
constraints on it are not negotiable and both come from defects this project has already paid for.

**The adapter picker reads KAR-19.10's producer and nothing else.** EPIC-19 exists in part because
`doctor`, admission and selection could disagree about which providers this machine could use; a
picker that probed for itself would be a fourth answer, and the first thing an operator would do
with it is pick something admission then refuses. **And a refusal is shown in the words the CLI
uses.** KAR-19.2's admission refusal and KAR-19.12's human-gate announcement are shipped strings; a
composer that paraphrases them makes the same machine describe the same state two ways.

**Acceptance criteria**

1. The composer accepts a free-text prompt, a file from the project, or an issue reference — the
   same three intake shapes `deflow run` accepts (`--file`, `--issue`, text), reusing the same
   intake path rather than a parallel one.
2. An adapter picker lists the providers this machine can actually use, showing for each whether it
   is available and by which route (ACP adapter or exec shim), taking its answer from the same
   producer `doctor` and admission use — the three must never disagree.
3. A provider that cannot serve the run is not silently selectable: it is shown as unavailable with
   the reason and the command that would fix it.
4. Submitting creates the run, navigates to it, and streams it live — no refresh, no manual
   navigation to `/runs/<id>`.
5. A run that is refused at admission shows the refusal in the composer, in the words the CLI uses,
   rather than appearing to start.
6. The composer records what it submitted so the operator can see afterwards exactly what was asked.
7. Keyboard-first: submit without touching the mouse, and the composer is reachable from anywhere in
   the project.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                             | Red when                                                                                                                             |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | browser     | Type a prompt, submit, and assert the request body is the `RunIntakeBodySchema` shape with `input.kind: 'text'`, the project's `cwd` and its `projectId`         | The composer builds its own body and the API's schema and the page drift apart at the first field either one changes                 |
| 2   | integration | Drive all three intake shapes through the same `submitTask` the CLI calls; assert one `task.submitted` per submission and identical normalisation                | The UI gets a second intake path, and `--file`'s containment check is enforced on one of the two                                      |
| 3   | unit        | The picker's rows are derived from KAR-19.10's producer; a fixture where the producer reports one route and the picker is asked for another fails                | The picker probes `PATH` itself, and the operator picks a provider `doctor` says is missing                                           |
| 4   | integration | A machine with a fake vendor CLI and no ACP adapter; assert `doctor`, admission and the picker name the same route for that provider                             | Three surfaces, three answers — the exact class of mismatch EPIC-19 shipped to end                                                    |
| 5   | browser     | An unavailable provider: assert the option is not submittable, and that the reason **and** the fixing command are on screen                                      | It is greyed out with no explanation, so the operator's next move is to guess                                                         |
| 6   | browser     | Submit, then assert the route changed to the new run and the first stream frame rendered — with no second navigation and no reload                               | The run is created and the operator is left on the form wondering whether it worked                                                   |
| 7   | integration | An admission refusal (no provider can serve the run); assert the composer renders the refusal string byte-identical to the CLI's                                 | The UI paraphrases, and the same failure reads as two different problems depending on where you saw it                                |
| 8   | browser     | After submitting, assert the submitted text/file/issue is rendered back, and survives a navigation away and back                                                 | What was asked is lost the moment the composer clears, and the run's own record is the only copy                                      |
| 9   | browser     | Keyboard only: focus the composer from another route by shortcut, type, submit with the modifier chord, and assert no pointer event was dispatched               | The submit button is reachable only by mouse, which fails the project's own accessibility rule                                        |
| 10  | browser     | A submission that fails with a network error; assert the composer keeps the text and says what happened                                                          | The draft is cleared on failure and the operator retypes a paragraph                                                                  |

**Notes / risks** — the risk is scope. A "chat-style composer" invites threading, history, editing
and re-running, none of which is in this story. What ships is one box, three input shapes, a picker
and a submit; the conversation with the agent is the run's own surface.

---

### KAR-22.3 — The project workspace: live graph, task board and run history

|                 |                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                            |
| **Priority**    | P0                                                                                                                                                                     |
| **Size**        | L                                                                                                                                                                      |
| **Depends on**  | KAR-22.1, KAR-22.2, KAR-16.3 (projections), KAR-16.4 (bounded run store), KAR-17.1 (plan graph), KAR-17.8 (timeline and cost overlay)                                   |
| **PRD**         | F10.1, F10.3, F10.9, NF4, NF10                                                                                                                                         |
| **Verified by** | EPIC-22-S34, EPIC-22-S35, EPIC-22-S36, EPIC-22-S37, EPIC-22-S38, EPIC-22-S39, EPIC-22-S40, EPIC-22-S41, EPIC-22-S42, EPIC-22-S43, EPIC-22-S44, EPIC-22-S45, EPIC-22-S46, EPIC-22-S47 |

**As** an operator, **I want** each project to have a workspace where I can watch the current run's
graph, read the list of tasks the plan created with the step names and which model is handling each,
and browse everything that ran before — **so that** the UI answers "what is happening" and "what
happened" without me hunting for run ids.

**Acceptance criteria**

1. A project route shows its active run live: the plan graph (reusing EPIC-17's canvas, not a second
   one), updating from the stream with no refresh.
2. A task/step board lists the plan's nodes as work items with, per item: title, node type, state,
   the provider and model handling it, permission level, elapsed time and cost so far. Colour is
   never the only carrier of state — glyph and text label too, per the project's existing
   accessibility rule.
3. The board and the graph are two views of the same projection; they can never disagree.
4. Run history for the project: every past run with its outcome, when it ran, what it cost, and the
   task it was given; opening one restores its full view via the existing scrubber.
5. History is browsable without knowing any run id, and survives a daemon restart.
6. A project with no runs yet says so usefully and points at the composer, rather than showing an
   empty canvas.
7. Switching project switches the whole workspace and does not leak the previous project's stream,
   run store or subscriptions.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                    | Red when                                                                                                                    |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | browser     | Mount the project route with an active run, push `node.started` frames, and assert the **existing** canvas component rendered them                      | A second Vue Flow surface is introduced and the two diverge on layout, palette and reduced-motion behaviour                 |
| 2   | unit        | A module guard: exactly one graph canvas, one run store and one API client module exist under `packages/web/src`                                        | The copy is made and nothing notices until the two are asked to agree                                                       |
| 3   | browser     | Board and graph mounted over one store; drive twenty frames and assert every node's state matches in both, per frame                                    | The board keeps its own copy and lags the graph by one frame, which reads as a flickering bug nobody can reproduce          |
| 4   | browser     | Per row: title, node type, state, provider, model, permission, elapsed, cost — asserted against the projection, not against fixture prose               | The board shows a status word and nothing an operator can act on                                                            |
| 5   | browser     | Colour-blind assertion: for every state, a glyph and a text label are present independent of colour                                                     | State is carried by colour alone, which the project's accessibility rule already forbids                                    |
| 6   | integration | Three finished runs for a project; assert history lists all three with outcome, time, cost and task, ordered newest first                               | History is the global run list filtered client-side, and a project with three runs among three hundred cannot be read       |
| 7   | integration | Restart the daemon over the same file-backed ledger; assert history is identical                                                                        | History lives in the tab and a restart empties it                                                                           |
| 8   | browser     | Open a historical run from history; assert the scrubber restores it without a run id being typed anywhere                                               | The operator is back in the address bar, which is the 2026-08-12 failure with extra steps                                   |
| 9   | browser     | A project with no runs; assert the empty state names the composer and does not render an empty canvas                                                   | A blank graph reads as a broken page rather than as "nothing has run yet"                                                   |
| 10  | browser     | Switch projects; assert the previous project's stream is closed, its store released, and no frame from it reaches the new workspace                     | Subscriptions leak, and the second project shows the first one's nodes                                                      |

**Notes / risks** — AC3 is the one with teeth and the one most likely to be quietly weakened. "Two
views of one projection" means the board takes its rows from the same store the canvas takes its
nodes from, in the same tick. If it ever becomes cheaper to keep a second array, the property is
gone and the test that proved it goes with it.

---

### KAR-22.4 — Connectors: the framework, and GitHub

|                 |                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                            |
| **Priority**    | P1                                                                                                     |
| **Size**        | M                                                                                                      |
| **Depends on**  | KAR-22.2, KAR-22.3                                                                                     |
| **PRD**         | F1.1, NF1, NF2, AR-1                                                                                   |
| **Verified by** | EPIC-22-S48, EPIC-22-S49, EPIC-22-S50, EPIC-22-S51, EPIC-22-S52, EPIC-22-S53, EPIC-22-S54, EPIC-22-S55, EPIC-22-S56, EPIC-22-S57, EPIC-22-S68, EPIC-22-S69 |

**Deferred by the owner on 2026-08-12** — planned now so it is not forgotten, to be built after
KAR-22.1–22.3 are usable end to end. All three services are wanted.

**Split on 2026-08-16, before any code was written.** As authored this story carried the connector
framework *and* three services, at Size L, and the three services are not one problem: they have
three different authorisation stories, three different credential holders and three different issue
vocabularies. Building all three on a framework that does not exist yet would have meant designing
the framework three times, in one branch, with the ADR-0003 question — the only part of this story
that is genuinely hard — answered once for GitHub and then assumed for the other two. So the
framework and the one service that DeFlow *already talks to* stay here, and
[KAR-22.6](#kar-226--connectors-linear-and-jira-on-the-same-framework) takes Linear and Jira onto
it. Nothing was dropped; one Size L became a Size M and a Size M, and the framework is proved by a
second service rather than asserted by a first.

**As** an operator, **I want** to connect GitHub to a project from the connectors screen and be told
plainly what that connection is, **so that** I can pick a real issue from a list instead of pasting
a reference into a box — and know exactly who holds the credential that makes it work.

#### The credential decision, settled before any code (AC2)

**DeFlow has no registered OAuth application with GitHub, and this story does not invent one.** A
client id in this repository would be either fabricated or somebody else's, and both are worse than
the honest design, which is the one ADR-0003 already describes for model providers:

| Question                          | Answer                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Whose application authorises?** | GitHub's own — the GitHub CLI's. Not DeFlow's; DeFlow has none.                                                                                            |
| **Where does the token live?**    | In the GitHub CLI's own credential store on the operator's machine — the OS keyring, or `~/.config/gh/hosts.yml`, whichever `gh` itself chose.              |
| **Who put it there?**             | `gh auth login`: GitHub's own device flow, in the operator's own browser, against GitHub's own application.                                                 |
| **Who holds it?**                 | The GitHub CLI. DeFlow never reads it, never copies it, never transmits it, and has no field anywhere to paste it into.                                     |
| **What does DeFlow hold?**        | One row: `(projectId, service)` and a timestamp. No token, no secret, no client id, no refresh token, no expiry.                                            |
| **How does DeFlow reach GitHub?** | By spawning `gh` as a child process on the operator's machine, under the operator's own OS account — exactly as `intake/resolve-issue.ts` has since KAR-10.1. |

**Why this does not violate ADR-0003: it *is* ADR-0003, applied to a second class of credential.**
The ADR's rule — *"the vendor's own official binary, on the user's own machine, under the user's own
OS account, using the credentials that binary already stored for itself"* — is followed literally
here. The ADR is nevertheless **amended with a dated note** (2026-08-16), because its text speaks
only of *model* credentials and the next person to read it will read "no tokens" and be right to;
the amendment says that the rule now names issue-tracker credentials too, and that the reason it can
is that the shape is identical rather than that the credential is less important.

**AC1 is amended, deliberately, and the amendment is on the screen and not only here.** The original
criterion asked for a button that navigates to the service's own authorisation flow. DeFlow cannot
own that button for GitHub without an application it does not have. What it can do is stronger in
one respect and weaker in another, and both are stated out loud:

- **Stronger:** there is *no token field on this screen at all* — not as a secondary path, not
  behind a disclosure. "Not pasting tokens as the primary path" becomes "not pasting tokens".
- **Weaker:** connecting is not one click. It is one click plus one command. The screen shows the
  exact command (`gh auth login --hostname github.com --web --scopes repo`), says that it opens
  GitHub's own authorisation page in the operator's own browser, and offers a link to
  `https://github.com/login/device`, which is that page. The screen also says, in words, *why*
  there is no single button — because DeFlow has no GitHub application and will not use one that is
  not its own.

**AC5 is amended for the same reason.** DeFlow holds no grant of its own, so it has no grant of its
own to revoke and no endpoint it could call to revoke one. Removing a connector deletes the row, and
that row *is* the whole of DeFlow's access: the next issue read for that project spawns no child at
all and is refused as not connected. That is what the test asserts — a spawn that did not happen,
not a row that is hidden. The credential itself stays the operator's and is shared with every other
tool on their machine, so DeFlow never revokes it behind their back; the removal response names
`gh auth logout --hostname github.com` as the command that does, and says what else on the machine
that will affect.

**Acceptance criteria**

1. A connectors screen per project. GitHub shows exactly one of six states — `connected`,
   `not-installed`, `not-authorised`, `expired`, `missing-scope`, `unreachable` — each with a
   sentence and the one command or link that resolves it. `unreachable` is on the list because the
   alternative is calling a network failure an authorisation failure, which sends an operator to
   re-run `gh auth login` about a flight-mode switch. **There is no token input on the screen**, and the screen states
   whose application authorises, where the token lives and what DeFlow itself stores.
2. DeFlow stores no credential of any kind for a connector: the row is `(projectId, service)` and a
   timestamp. The design above states where the token lives, who holds it and why that is
   ADR-0003's own decision rather than an exception to it, and ADR-0003 carries a dated amendment
   saying the rule now names issue-tracker credentials.
3. Once connected, the composer's issue input offers a searchable list of that project's repository's
   real issues, each showing key, title and state; pasting a raw reference still submits a run, with
   or without a connector.
4. A connector that is not installed, not authorised, expired or lacking a scope says **which**, and
   what to do about it — naming the missing scope by name — on the connectors screen and at run
   submission, before any framing turn.
5. Connectors are per project: a connector on project A is not a connector on project B, and each
   project's issue search reads that project's own repository. Removing one ends DeFlow's access
   rather than hiding it — the next read spawns nothing — and the response names the operator's own
   revocation command and what it affects.
6. No connector is required: everything in EPIC-22 works fully with no connector configured for any
   project, and the composer's paste path is unchanged.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                            | Red when                                                                                                            |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | browser     | The connectors screen renders the GitHub row in each of the six states with its sentence and its command, and holds **no** input of type text, password or search for a token | Connecting means reading a README and exporting an environment variable                                             |
| 2   | unit        | An AR-1 / ADR-0003 guard over the connector module and its import graph: nothing reads `~/.claude`, `~/.codex`, `~/.config/gcloud`, a `*_API_KEY`/`*_TOKEN` variable, or `gh`'s own credential store, and nothing captures a login command's output | A connector credential and a model credential end up in one store, and the ADR is violated by accident               |
| 3   | integration | A fake `gh` standing in for GitHub's authorisation, holding a distinctive token in a fake credential store; drive connect, search and submit, then search the whole ledger file, every log line and the whole data directory for the token's bytes | The token is written into an event payload, which is inspectable on disk by design (NF8)                            |
| 4   | browser     | Connected: the issue input becomes a searchable list showing key, title and state; and pasting a raw reference still submits                                     | The list replaces the paste path, and an operator with a URL in their clipboard is stuck                            |
| 5   | integration | An expired token and a token missing a scope; assert each names which, and that the missing scope is named by name, before a run is submitted rather than during one | The failure lands mid-run, and an hour of framing is spent to discover a permissions problem                        |
| 6   | integration | Remove a connector, then ask for its issues; assert **no `gh` was spawned** and the read is refused as not connected, and that the removal named the operator's own revocation command | "Removed" means hidden, and DeFlow keeps spawning `gh` for a project the operator disconnected                      |
| 7   | integration | KAR-22.1–22.3's acceptance re-run with no connector configured at all, on a machine where `gh` is not on `PATH`                                                  | Connectors become load-bearing, and the epic's zero-config path stops working                                       |
| 8   | unit        | The state parse over `gh api -i user`'s output: exit codes, `HTTP 401`, an absent binary, and the `X-OAuth-Scopes` header folded against the required scopes     | "insufficient permissions" is the diagnosis, and the operator guesses which scope                                    |
| 9   | integration | Two projects against two repositories, one connected; assert B lists GitHub as not connected and B's issue search is refused                                     | A connector on one project silently connects every project on the machine                                            |

**Notes / risks** — the temptation this story has to survive is **a token field**, because a token
field would make the button work. It is not there, and test 1 asserts its absence rather than
trusting a review. The second temptation is a second `gh` spawn site; there is one
(`daemon/src/gh/run-gh.ts`, extracted from `intake/resolve-issue.ts` by this story), and the guard
in test 2 reads its import graph rather than a convention.

---

### KAR-22.6 — Connectors: Linear and Jira on the same framework

|                 |                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                            |
| **Priority**    | P1                                                                                                     |
| **Size**        | M                                                                                                      |
| **Depends on**  | KAR-22.4 (the framework, the screen and the ADR-0003 answer it settles)                                |
| **PRD**         | F1.1, NF1, NF2, AR-1                                                                                   |
| **Verified by** | EPIC-22-S70, EPIC-22-S71, EPIC-22-S72, EPIC-22-S73, EPIC-22-S74, EPIC-22-S75, EPIC-22-S76               |

**Created 2026-08-16 by the split of KAR-22.4**, which is recorded in that story above. All three
services were and are wanted; this is the other two.

**As** an operator, **I want** Linear and Jira on the same connectors screen as GitHub, **so that**
a project tracked outside GitHub gets the same searchable issue list rather than a paste box.

#### The credential decision for two more services, settled by research before any code (AC2)

KAR-22.4's answer for GitHub was *"the vendor's own first-party CLI holds the credential; DeFlow
spawns it"*. The split existed because that answer might not generalise. **It generalises to one of
these two services and not to the other**, and the two halves of this section are what was actually
checked rather than what was assumed.

**Jira: the same answer, with a different binary.** Atlassian publishes its own CLI, `acli`, and it
has exactly the shape `gh` has — a login that authorises against Atlassian's own application, a
status command, a logout, and a machine-readable search:

| Question                          | Answer                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Whose application authorises?** | Atlassian's own — `acli`'s. Not DeFlow's; DeFlow has no registered Atlassian application.                                                |
| **Where does the credential live?** | In `acli`'s own credential store on the operator's machine. DeFlow does not know where that is and never looks.                        |
| **Who put it there?**             | `acli jira auth login --site <your-site>.atlassian.net --email <your-atlassian-email> --web`, in the operator's own browser.             |
| **Who holds it?**                 | `acli`. DeFlow never reads it, never copies it, never transmits it, and has no field anywhere to paste it into.                          |
| **What does DeFlow hold?**        | One row: `(projectId, 'jira')` and a timestamp.                                                                                          |
| **How does DeFlow reach Jira?**   | By spawning `acli` as a child process, on the operator's machine, under their own OS account — the same relationship it has with `gh`.   |

The commands are Atlassian's own published reference and nothing here was invented:
`acli jira auth login`, `acli jira auth status`, `acli jira auth logout`,
`acli jira workitem search --jql … --json` and `acli jira workitem view <KEY> --json`.

**Linear: no honest answer exists yet, and the screen says so.** Linear publishes no first-party
command-line tool that holds a credential. What it publishes is a GraphQL API reached with either a
**personal API key** — which DeFlow would have to hold, and ADR-0003 forbids — or an **OAuth
application**, which DeFlow does not have and will not fabricate a client id for. The one
Linear-authored npm package with a binary, `@linear/cli` (`lin`), was last published in 2021, keeps
an API key in its own config file, and has two commands, `lin new` and `lin checkout` — no search
and no list, so it could not serve an issue picker even if holding the key were acceptable.

So Linear ships as a row that says, in the daemon's own sentence, that **DeFlow cannot connect it
without holding a credential and therefore does not**, what would have to change for that to stop
being true, and nothing else. There is no connect button on that row, and the connect route refuses
it — `422 connector_unavailable` — rather than writing a consent row for a service that can never
work. AC2 named this as a permitted outcome before the research was done; this is that outcome,
reached rather than chosen.

**AC5 is added, because a picker that cannot submit is not a picker.** KAR-22.4's composer fills the
issue box from the list, and intake resolves only `https://github.com/…/issues/<n>` — so a Jira
entry would have offered an operator a run that intake then refused. Jira work-item URLs are
resolved by the same `acli`, through `acli jira workitem view <KEY> --json`, at the one spawn
chokepoint. Without this the story would have shipped a list whose every entry was a dead end.

**What Jira does not get, said out loud.** `gh` infers *which repository* from the directory it runs
in, which is what makes GitHub's issue list this project's own. `acli` has no equivalent inference —
nothing ties a directory on disk to a Jira project — and DeFlow stores no Jira project key, because
inventing a second configuration surface was not this story's job. So a connected project's Jira
list is every work item **that operator's own account can see**, most recently updated first,
narrowed by what they type. The row says exactly that. The per-project isolation AC4 asks for is
unmodified where it is asserted — a connector on project A is not one on project B, and B's search
is refused — and the narrower scoping is recorded here as the follow-up it is rather than as a
property this story delivered.

**Acceptance criteria**

1. Linear and Jira are rows on KAR-22.4's connectors screen, rendered by KAR-22.4's framework — a
   second screen, a second store or a second issue-search route is a defect, and a guard asserts
   there is one of each.
2. Each service states **whose application authorises it, where its credential lives and who holds
   it**, to the same standard KAR-22.4 sets for GitHub, and neither introduces a token field. Where
   a service has no first-party CLI that holds a credential the way `gh` does, the honest answer —
   including "DeFlow cannot connect this service without holding a credential, and therefore does
   not yet" — is written into the design and onto the screen rather than papered over with a button.
   A service in that position offers no connect button and its connect route refuses.
3. A connected Jira project's composer offers that service's issues with key, title and state, from
   the same component GitHub's list uses, and a project connected to two services says which service
   each entry came from. Linear satisfies this criterion by AC2's escape: it offers no list because
   it cannot be connected, and says why in the same place the list would have been.
4. The six states, the missing-scope naming, the per-project isolation and the removal semantics
   are KAR-22.4's, unmodified, for both services.
5. An issue picked from the Jira list submits a run. The reference the picker writes into the box is
   resolved by intake through the same `acli`, at the same one spawn chokepoint `gh` uses, and a
   failure is intake's own refusal naming `acli`'s words — never a silent dead end.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                          | Red when                                                                                            |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | browser     | All three services render from one registry and one row component; the screen is asserted to have one issue-list component, and the unconnectable row is asserted to have **no** connect button | A second connectors screen grows beside the first, or a button appears on a row that goes nowhere   |
| 2   | unit        | A source guard: exactly one connectors screen component, one `connector` table, one issue-search route and one issue-list rendering exist in the repository | The framework fits exactly one service and the second one forks it                                  |
| 3   | integration | A Jira connector against a fake `acli`: connect, search, expire, remove — the same table KAR-22.4 runs for GitHub, over the registry rather than over GitHub | Jira is "supported" in a README and nowhere else                                                     |
| 4   | integration | Linear: the connect route refuses with `connector_unavailable`, no row is written, its issue search is refused, and no child process is spawned for it at all | An unconnectable service is papered over with a button, or quietly records consent it can never use |
| 5   | unit        | The credential-holder statement is required by the registry's own type, so a service cannot be registered without one — asserted over every registered service and by a `@ts-expect-error` the typechecker enforces | A service ships with no answer to "who holds the token", which is the question KAR-22.4 exists to answer |
| 6   | unit        | `acli`'s state parse and issue parse as tables: exit codes, "not logged in", a 401, an absent binary, and both plausible shapes of `--json`     | An unrecognised `acli` message is diagnosed confidently and wrongly, and an operator runs a command for nothing |
| 7   | integration | Two services connected to one project; assert the list says which service each entry came from, and that removing one leaves the other connected | Connectors stop composing the moment there are two                                                   |
| 8   | integration | A Jira work-item URL submitted to intake against a fake `acli`, and the same URL with `acli` absent                                            | The picker offers entries that intake then refuses, and the list is a dead end                       |
| 9   | unit        | The credential guard of KAR-22.4 test plan #2, extended to `acli`: nothing in the graph reads `acli`'s own store or captures `acli jira auth`'s output | The second service is the one that quietly holds a credential                                       |

**Notes / risks** — the risk KAR-22.4's split was made to avoid was **assuming the GitHub answer
generalises**, and half of it did not: Linear ships as "not yet, and here is why". The risk that
replaces it is `acli`'s output format. `acli jira auth status` has no documented machine-readable
output, so the state parse is exit-code-first and substring-second, and **anything it does not
recognise is `unreachable` carrying `acli`'s own sentence** rather than a confident guess — the same
rule `readGithubState` follows for the same reason. `--json` is documented for `workitem search` and
`workitem view`; its exact shape is not, so the parser accepts either a bare array or `{ issues: [] }`
and drops any row it cannot key, because an entry with no reference is an entry that submits a run
against nothing.

---

### KAR-22.5 — Answer a run's human gates from the web UI

|                 |                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                            |
| **Priority**    | P0                                                                                                                                                     |
| **Size**        | M                                                                                                                                                      |
| **Depends on**  | KAR-22.3 (the workspace this appears in), KAR-19.12 (the announcement, the option set and `deflow answer`'s endpoints), KAR-13.1 (the gate machinery and its `409`), KAR-10.3 (the F1.3 spec gate's four routes) |
| **PRD**         | F1.3, F8.3, F10.1, F10.3, NF4, NF10                                                                                                                    |
| **Verified by** | EPIC-22-S58, EPIC-22-S59, EPIC-22-S60, EPIC-22-S61, EPIC-22-S62, EPIC-22-S63, EPIC-22-S64, EPIC-22-S65, EPIC-22-S66, EPIC-22-S67                        |

**Found while performing KAR-22.3's by-hand acceptance on 2026-08-15.** The operator created a
project, started a run from the composer, and then could not proceed: the run suspended at its
spec-approval gate and **there was no UI control to answer it**. The acceptance run had to approve
the gate over the raw API route to continue.

**As** an operator, **I want** to answer a run's human gates from the browser, **so that** a run I
started in a tab can be finished in that tab.

This is a hole in the control center's own story rather than a new capability. KAR-22.2 lets an
operator start a run from the browser and KAR-22.3 lets them watch it — and then the run stops at
its first human gate and the only way through is `deflow answer` in a terminal, which defeats the
sentence the whole epic is written against. Everything underneath already exists: EPIC-13 owns the
gate, its `node_wake` row and the transaction that closes it; KAR-10.3 owns the F1.3 gate's four
routes; KAR-19.12 owns the option set, the announcement and `deflow answer`. What is missing is a
**button**.

Two constraints on it, and both are the epic's own rules restated.

**There is one answer path.** `deflow answer` already decides which route answers which gate — the
four spec endpoints for the F1.3 gate and `POST /runs/:id/nodes/:nodeId/respond` for every other —
and that decision moves into one exported function both surfaces call. A page that chose its own
route would be a second answer path, and the day a fifth spec decision is added one of the two would
keep answering the old way.

**A refusal is the daemon's own sentence.** `already_answered` is `planHumanResponse`'s `409` with
the original decision echoed; the page renders it rather than writing its own version of *"somebody
beat you to it"*. This is R4 again, and the reason AC6 is a test rather than a convention.

**Acceptance criteria**

1. A run awaiting a human shows its gate prominently in the workspace and on the run view: which
   gate, why it is waiting, and the full option set the daemon offered (for spec approval: approve /
   edit / reject / abandon).
2. Each option is answerable with one click, using the same endpoint `deflow answer` uses. No second
   answer path.
3. The spec being approved is readable in the UI before answering — goal, scope, non-goals,
   constraints, acceptance criteria, known failure modes — not just an option list.
4. The "edit" option lets the operator amend the spec before approving, through the amend path that
   already exists, or is hidden with a stated reason if that path is not reachable yet.
5. Answering resolves the gate live: the run continues and the graph and board update with no
   reload.
6. A gate answered elsewhere — the CLI, another tab — resolves in this UI without a reload, and a
   gate that is already answered never offers a stale button.
7. The project's run list and the workspace both mark a run that is awaiting a human as such, so it
   is findable without opening it.
8. Permission-escalation and approval gates use the same surface as spec approval, rather than a
   bespoke one per gate kind.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                              | Red when                                                                                                                       |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | A table over every gate/option pair: the request the browser sends and the request `deflow answer` sends are produced by one exported function, path and body both  | The page picks its own route, and the F1.3 gate acquires a second answer path that drifts the day a fifth decision is added     |
| 2   | browser     | Mount the workspace with an open spec gate; assert the node, the prompt and **every** option the daemon offered are on screen                                       | The gate is a status word, and an operator is told a decision is needed without being told what it is                          |
| 3   | browser     | Assert the rendered spec is readable before answering: goal, in scope, non-goals, constraints, acceptance criteria and known failure modes                          | The panel is an option list, and approving is a click on a document nobody read                                                |
| 4   | browser     | Press `approve`; assert exactly one request went out, to `POST /api/runs/:id/spec/approve`, with the same body `deflow answer` sends                                | The click posts to `respond` with `optionId: 'approve'`, which the F1.3 gate does not implement                                 |
| 5   | browser     | `edit`: assert it is **not** submittable, that the stated reason is on screen, and that pressing it issues no request                                               | A button offers an amendment this surface cannot carry, and the operator's edit is silently dropped                            |
| 6   | browser     | Push the `human.responded` frame the answer produces; assert the panel is gone, with no reload and no second fetch of the run                                       | The gate stays on screen after it is answered, and the only way to clear it is F5                                              |
| 7   | integration | Two feeds over one real daemon and one run; answer once over the API; assert **both** receive `human.responded` and both folds report no open gate                  | The answering tab updates and the other one keeps showing a button for a gate that is closed                                   |
| 8   | integration | Answer the same gate twice against a real daemon; assert the second is `409 already_answered` and carries the **first** decision                                    | The second answer wins, or appends a second `human.responded`, and the ledger records two decisions for one question           |
| 9   | browser     | A `409` from the daemon; assert its own sentence is rendered, that the option buttons are gone, and that no retry is issued                                         | The page paraphrases the conflict, or leaves a stale button that answers an answered gate                                      |
| 10  | browser     | A project whose run is waiting: assert the workspace and the project's history row both mark it, without the run being opened                                       | The only way to find out that a run is waiting on you is to open it, which is the state KAR-22.3 shipped                       |
| 11  | browser     | A **permission-escalation** gate, not a spec gate: assert the same panel renders it and that answering posts to `nodes/:nodeId/respond`                             | A second panel is written per gate kind, and the third kind gets none                                                          |

**Notes / risks** — the hazard is a **second answer path**, and it is the same hazard R2 names for
the canvas. The F1.3 gate answers on four endpoints and every other gate answers on one, so a
surface that answers gates has to make that choice — and there are now three surfaces that do
(`deflow answer`, this panel, and whatever KAR-22.4 adds). The choice therefore lives in
`@DeFlow/core` beside `SPEC_DECISIONS` and `SPEC_APPROVAL_OPTIONS`, as a function of the gate and
the option, and test 1 drives it from both callers.

The second hazard is **`edit`**. An edit replaces the whole amended framed document
(`DeFlow.taskspecdraft.v1`) and the gate computes the RFC 6902 patch itself, so there is nothing a
button could carry — which is exactly why `deflow answer` refuses it too. AC4's second half is the
honest answer for this story: the option is shown, not submittable, and the reason is the *same*
exported sentence the CLI prints, so the two surfaces cannot come to explain one limitation two
ways.

---

## Risks

| #   | Risk                                                                                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Scope.** This is the largest remaining epic and the easiest to gold-plate — a control center invites a settings screen, a theme picker and a dashboard nobody asked for. | The scope section names what is out, and the epic's Definition of Done is *performed*: create a project, start a run, watch it, from a browser. Anything that does not serve that sentence is a later story with a number.                                                                  |
| R2  | **A second copy of something EPIC-16/17 already built** — a graph canvas, a run store, a projection, an API client — because copying is faster than reading.               | KAR-22.3 test 2 is a module guard, not a review convention. One canvas, one store, one client, asserted.                                                                                                                                                                                    |
| R3  | **A fourth answer about which providers work.** The picker is the natural place to add a probe.                                                                             | KAR-22.2 AC2 and its tests 3 and 4: the picker is derived from KAR-19.10's producer, and a spec drives `doctor`, admission and the picker together and fails if they diverge.                                                                                                               |
| R4  | **Reworded refusals.** A UI wants shorter, friendlier copy than a CLI, and rewording is invisible until two people compare notes.                                          | KAR-22.2 AC5 and test 7 assert byte-identity with the shipped strings. New wording is a change to the one string, in the one place.                                                                                                                                                          |
| R5  | **Destroying an operator's code.** "Remove project" is one click away from `rm -rf`.                                                                                        | KAR-22.1 AC6, test 11 and test 17: the row goes, the files are asserted to remain, and the confirmation says so in words before it is accepted.                                                                                                                                              |
| R6  | **Path identity.** Trailing slashes, symlinks and `realpath` make one directory into four strings, and a projects table keyed on the raw string holds four rows for it.    | Stored post-`realpath`, uniqueness asserted on the resolved form, and KAR-22.1 test 12 is written against a second create rather than a string comparison.                                                                                                                                   |
| R7  | **`projectId` becomes required** in a later refactor, and every run already on disk becomes unreadable.                                                                     | KAR-22.1 AC7 and test 15: a payload with no `projectId` is folded in a unit spec, exactly as `cwd`'s own optionality is pinned. A ledger may never make its own history unreadable.                                                                                                          |
| R8  | **Connectors pull credentials into a system built not to hold them** (ADR-0003, AR-1).                                                                                     | Settled by KAR-22.4's credential decision: DeFlow stores `(projectId, service)` and nothing else, and reaches GitHub by spawning the operator's own `gh`. ADR-0003 carries a dated amendment naming issue-tracker credentials. Test 2 is a source guard over the import graph; test 3 hunts the token's bytes through the ledger, the logs and the whole data directory. |
| R10 | **A button that goes nowhere.** DeFlow has no registered OAuth application with GitHub, and a connectors screen invites one to be invented.                                | KAR-22.4 AC1 is amended in writing rather than faked: no token field exists at all, the exact `gh auth login` command is on the screen, and the screen says why there is no single button. Test 1 asserts the absence of the field.                                                          |
| R9  | **A second answer path.** The F1.3 gate answers on four endpoints and every other gate on one, and a page that answered gates would naturally re-make that choice locally.                | KAR-22.5 AC2 and its test 1: the choice is one exported function in `@DeFlow/core`, driven from both `deflow answer` and the panel by a table over every gate/option pair.                                                                                                                    |

---

**Related:** [Flows](../flows/EPIC-22-web-control-center-flows.md) · [Board](../board.md) ·
[EPIC-16](./EPIC-16-ui-foundation.md) · [EPIC-17](./EPIC-17-p0-views.md) ·
[EPIC-19](./EPIC-19-live-run-pipeline.md) ·
[12-frontend-architecture.md](../../12-frontend-architecture.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md)

[← Back to the delivery plan](../README.md)
