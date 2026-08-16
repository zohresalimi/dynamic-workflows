# EPIC-22 flows — Web control center: projects, chat-driven runs, live boards

> Behavioural specification for [EPIC-22](../epics/EPIC-22-web-control-center.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 15 August 2026

## Actors

| Actor                     | Description                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**              | The person in front of the browser. After this epic they never open a terminal except to run `deflow up` once                                                                  |
| **The control center**    | `@DeFlow/web` served by the daemon on one origin. The **existing** app shell, router, typed client, projections and bounded run store — never a second copy of any of them     |
| **A project**             | A name plus a resolved local path that is a git working tree, held as a row in the global ledger database. Not a folder DeFlow created, not something it owns, and never deleted with the row |
| **`DeFlowd`**             | The daemon. Owns the ledger, the lease, `/api` and the SSE stream                                                                                                              |
| **The projects API**      | `GET/POST /api/projects`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id` — chained onto the one Hono expression, so `hc<ApiType>` sees them                             |
| **`initWorkspace`**       | KAR-18.1's own bootstrap (`packages/daemon/src/init/workspace-init.ts`). Called, never reimplemented. Its `PathReport[]` is what "reports what it created" means               |
| **The refusal**           | `deflow init`'s sentence for a directory that is not a git working tree. One exported constant, thrown by the CLI and returned by the API                                       |
| **The composer**          | The chat-style box: text, a file from the project, or an issue reference, plus an adapter picker. It builds a `RunIntakeBodySchema` body and nothing else                      |
| **The provider producer** | KAR-19.10's single, route-aware ({acp, shim}) source of provider state, read by `doctor`, by admission and — after KAR-22.2 — by the picker. Three readers, one answer         |
| **The plan graph**        | KAR-17.1's canvas. There is exactly one in this repository and this epic does not add a second                                                                                 |
| **The board**             | KAR-22.3's task/step list. A second *render* of the graph's projection, never a second copy of its data                                                                        |
| **The bundled agent**     | `deflow-mock-agent` on a temp `PATH` — the provider every scenario here uses, because a control center is testable without spending credits                                    |

## Preconditions common to all flows

```gherkin
Background:
  Given a real git repository created with "git init -b main" in an fs.mkdtemp directory
  And GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced author/committer identity
  And DeFlow_DATA_DIR points inside that same tmpdir, so no scenario reads or writes the
      developer's own ~/.DeFlow
  And the ledger is a real file-backed SQLite database in that data directory — never ":memory:",
      because every persistence clause here is a claim about surviving a close and a reopen
  And time enters through the injected Clock; no scenario reads Date.now() and none calls
      vi.useFakeTimers() while a child process is alive
  And PATH is a temp PATH built for the scenario, holding "deflow-mock-agent" and whatever fake
      vendor binaries that scenario needs — never the developer's own
  And no credential variable — no *_API_KEY, no *_TOKEN — is present in any child environment (AR-1)
  And every browser scenario runs in real Chromium through the "web" vitest project, because jsdom
      has no SVG measurement and returns 0 from getBBox() rather than failing
  And every browser scenario mounts the real shell through test/shell.ts, so no scenario asserts
      against an application assembly that does not ship
  And the normalising snapshot serializer is registered before any snapshot is written, covering
      timestamps, run ids, project ids, durations and absolute paths
```

> Two of these carry this epic. **A file-backed ledger** is the difference between "the project is
> there" and "the project is still there tomorrow": AC3 of KAR-22.1 is a durability claim, and
> `:memory:` cannot be closed and reopened. **Real Chromium** is the second: this epic's whole
> subject is a page, and the one runner that can measure a page is the one that is a browser.
>
> **`DeFlow_DATA_DIR` inside the tmpdir** matters more here than anywhere outside EPIC-20, because
> these are the scenarios that create rows an operator would expect to keep. A scenario that leaks
> out of the tmpdir writes projects into the author's real state directory.

## Flow index

| Scenario     | Title                                                                                     | Verifies | Type       |
| ------------ | ------------------------------------------------------------------------------------------- | -------- | ---------- |
| EPIC-22-S1   | **Happy path: a project is created against a git working tree**                            | KAR-22.1 | Happy path |
| EPIC-22-S2   | **A path that is not a git working tree is refused in `deflow init`'s own words**           | KAR-22.1 | Failure    |
| EPIC-22-S3   | The refusal is one string, not two copies of one sentence                                  | KAR-22.1 | Failure    |
| EPIC-22-S4   | **Creating a project bootstraps `.DeFlow/` and reports what it created**                    | KAR-22.1 | Happy path |
| EPIC-22-S5   | A repository that is already initialised is not initialised twice                          | KAR-22.1 | Edge case  |
| EPIC-22-S6   | **An operator's edited `config.yaml` is never overwritten**                                 | KAR-22.1 | Failure    |
| EPIC-22-S7   | **Projects survive a daemon restart**                                                       | KAR-22.1 | Recovery   |
| EPIC-22-S8   | The list says whether each path still exists and is still a git repository                 | KAR-22.1 | Happy path |
| EPIC-22-S9   | **A project whose directory has gone is listed, and says so**                               | KAR-22.1 | Failure    |
| EPIC-22-S10  | A directory that is still there but is no longer a git repository says which                | KAR-22.1 | Failure    |
| EPIC-22-S11  | The list shows each project's most recent run                                              | KAR-22.1 | Happy path |
| EPIC-22-S12  | A project is renamed, and its id, path and history do not move                             | KAR-22.1 | Edge case  |
| EPIC-22-S13  | **Removing a project removes a row and not a single file**                                  | KAR-22.1 | Failure    |
| EPIC-22-S14  | The same directory cannot become two projects                                              | KAR-22.1 | Edge case  |
| EPIC-22-S15  | **Every run created after this story carries its project id**                               | KAR-22.1 | Happy path |
| EPIC-22-S16  | **A run submitted before projects existed is still readable**                               | KAR-22.1 | Recovery   |
| EPIC-22-S17  | **The page: the form creates a project, the refusal is shown, and removal states the risk** | KAR-22.1 | Happy path |
| EPIC-22-S18  | **Happy path: a prompt typed in the browser becomes a running run**                         | KAR-22.2 | Happy path |
| EPIC-22-S19  | The composer builds the API's own body, not one of its own                                 | KAR-22.2 | Happy path |
| EPIC-22-S20  | All three intake shapes go through one intake path                                         | KAR-22.2 | Happy path |
| EPIC-22-S21  | **The picker, `doctor` and admission answer from one producer**                             | KAR-22.2 | Failure    |
| EPIC-22-S22  | Each provider's route is named — ACP adapter or exec shim                                  | KAR-22.2 | Edge case  |
| EPIC-22-S23  | **An unavailable provider is not silently selectable**                                      | KAR-22.2 | Failure    |
| EPIC-22-S24  | **Submitting navigates to the run and streams it, with no reload**                          | KAR-22.2 | Happy path |
| EPIC-22-S25  | **An admission refusal is shown in the CLI's own words**                                    | KAR-22.2 | Failure    |
| EPIC-22-S26  | A human gate announces itself in the words KAR-19.12 ships                                 | KAR-22.2 | Edge case  |
| EPIC-22-S27  | What was submitted is still readable afterwards                                            | KAR-22.2 | Edge case  |
| EPIC-22-S28  | **Keyboard only: reach the composer, type, submit**                                         | KAR-22.2 | Happy path |
| EPIC-22-S29  | A failed submission keeps the draft and says what happened                                 | KAR-22.2 | Recovery   |
| EPIC-22-S30  | An empty submission is refused before a request is made                                    | KAR-22.2 | Edge case  |
| EPIC-22-S31  | A file outside the project is refused by the containment check, not by the page            | KAR-22.2 | Failure    |
| EPIC-22-S32  | Double submission creates one run                                                          | KAR-22.2 | Edge case  |
| EPIC-22-S33  | **Performed: a run started from the browser against the bundled agent**                     | KAR-22.2 | Happy path |
| EPIC-22-S34  | **Happy path: the project route shows its active run live**                                 | KAR-22.3 | Happy path |
| EPIC-22-S35  | **There is exactly one canvas, one run store and one client**                               | KAR-22.3 | Failure    |
| EPIC-22-S36  | **The board and the graph cannot disagree**                                                 | KAR-22.3 | Failure    |
| EPIC-22-S37  | Every board row carries the eight facts an operator acts on                                | KAR-22.3 | Happy path |
| EPIC-22-S38  | State is never carried by colour alone                                                     | KAR-22.3 | Edge case  |
| EPIC-22-S39  | **Run history for the project, newest first**                                               | KAR-22.3 | Happy path |
| EPIC-22-S40  | History survives a daemon restart                                                          | KAR-22.3 | Recovery   |
| EPIC-22-S41  | **A historical run opens without a run id being typed**                                     | KAR-22.3 | Happy path |
| EPIC-22-S42  | A project with no runs says so and points at the composer                                  | KAR-22.3 | Edge case  |
| EPIC-22-S43  | **Switching project leaks no stream, no store and no subscription**                         | KAR-22.3 | Failure    |
| EPIC-22-S44  | A run that ended while the tab was closed is shown in its terminal state                   | KAR-22.3 | Recovery   |
| EPIC-22-S45  | A project whose path has gone still shows its history                                      | KAR-22.3 | Edge case  |
| EPIC-22-S46  | The board is bounded — a plan with two hundred nodes does not unbound memory                | KAR-22.3 | Edge case  |
| EPIC-22-S47  | A run belonging to no project is still reachable from the run list                         | KAR-22.3 | Recovery   |
| EPIC-22-S48  | Happy path: GitHub is connected from the screen, not from a README                         | KAR-22.4 | Happy path |
| EPIC-22-S49  | **No model credential is read, written or logged by a connector**                           | KAR-22.4 | Failure    |
| EPIC-22-S50  | **A connector token never reaches a ledger event or a log line**                            | KAR-22.4 | Failure    |
| EPIC-22-S51  | Connected: the issue input becomes a list, and pasting still works                          | KAR-22.4 | Happy path |
| EPIC-22-S52  | An expired token says so before a run is submitted                                         | KAR-22.4 | Failure    |
| EPIC-22-S53  | A missing scope names the scope                                                            | KAR-22.4 | Failure    |
| EPIC-22-S54  | Removing a connector ends DeFlow's access rather than hiding it                             | KAR-22.4 | Edge case  |
| EPIC-22-S55  | Connectors are per project                                                                 | KAR-22.4 | Edge case  |
| EPIC-22-S56  | **Everything in this epic works with no connector at all**                                  | KAR-22.4 | Happy path |
| EPIC-22-S57  | ADR-0003 is satisfied or amended, in writing                                                | KAR-22.4 | Edge case  |
| EPIC-22-S58  | **Happy path: the run's open gate is answered from the browser**                            | KAR-22.5 | Happy path |
| EPIC-22-S59  | **The spec is readable before it is approved**                                               | KAR-22.5 | Happy path |
| EPIC-22-S60  | There is one answer path, and both surfaces build their request with it                     | KAR-22.5 | Happy path |
| EPIC-22-S61  | `edit` is offered honestly or not at all                                                     | KAR-22.5 | Failure    |
| EPIC-22-S62  | **Answering resolves the gate live, with no reload**                                         | KAR-22.5 | Happy path |
| EPIC-22-S63  | **Two tabs watching one run both see the answer**                                            | KAR-22.5 | Edge case  |
| EPIC-22-S64  | **A gate answered twice records one decision**                                               | KAR-22.5 | Failure    |
| EPIC-22-S65  | The conflict is rendered in the daemon's words, and the stale buttons go                    | KAR-22.5 | Failure    |
| EPIC-22-S66  | A run that is waiting on a person is findable without opening it                            | KAR-22.5 | Happy path |
| EPIC-22-S67  | A permission escalation uses the same surface as a spec approval                            | KAR-22.5 | Edge case  |
| EPIC-22-S68  | **The connectors screen has no token field at all, and says whose application authorises**   | KAR-22.4 | Failure    |
| EPIC-22-S69  | `gh` is not installed: the screen says so and the rest of the page still works               | KAR-22.4 | Edge case  |
| EPIC-22-S70  | Linear and Jira are rows on the same framework, each naming its own credential holder        | KAR-22.6 | Happy path |
| EPIC-22-S71  | **Linear cannot be connected without DeFlow holding a credential, and says so**               | KAR-22.6 | Failure    |
| EPIC-22-S72  | A connected Jira project's issue search returns key, title and state                         | KAR-22.6 | Happy path |
| EPIC-22-S73  | One project connected to two services picks from both, and each removes independently        | KAR-22.6 | Edge case  |
| EPIC-22-S74  | A Jira work item picked from the list actually submits a run                                 | KAR-22.6 | Happy path |
| EPIC-22-S75  | A service cannot be registered without saying who holds its credential                       | KAR-22.6 | Failure    |
| EPIC-22-S76  | One screen, one store, one issue-search route, one issue list                                | KAR-22.6 | Edge case  |

---

## EPIC-22-S1 — Happy path: a project is created against a git working tree

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: a run has somewhere to belong

  Scenario: a name and a repository become a project
    Given a real git repository at <repo> created with "git init -b main"
    And a daemon with a file-backed ledger in its own data directory
    When "POST /api/projects" is called with { name: "checkout", path: <repo> }
    Then the response status is 201
    And the body's "project.id" matches /^prj_\d{8}T\d{6}Z_[0-9a-f]{6}$/
    And "project.name" is "checkout"
    And "project.path" is the realpath of <repo>
    And "GET /api/projects" lists exactly one project with that id
    And that row's "health.state" is "ok"
```

**Notes:** the id shape is `mintRunId`'s, deliberately: timestamp before suffix, so plain string
comparison sorts projects in creation order and a directory listing reads chronologically.

`project.path` is the **realpath**, not the string the caller sent. A trailing slash, a symlink and
the resolved directory are three spellings of one place, and a table keyed on the raw string holds
three rows for it — which is what EPIC-22-S14 is written against.

---

## EPIC-22-S2 — A path that is not a git working tree is refused in `deflow init`'s own words

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: two surfaces, one sentence

  Scenario: a plain directory is not a project
    Given a directory <dir> that exists and contains no ".git"
    When "POST /api/projects" is called with { name: "nope", path: <dir> }
    Then the response status is 400
    And the error code is "invalid_request"
    And the error message is byte-identical to the message "deflow init" prints for the same
        directory
    And "detail.field" is "path"
    And no row exists in the "project" table
    And nothing was written inside <dir>

  Scenario: a path that does not exist at all
    Given a path <missing> that does not exist
    When "POST /api/projects" is called with { name: "nope", path: <missing> }
    Then the response status is 400
    And the message names the path
    And no row exists in the "project" table
```

**Notes:** "the same refusal `deflow init` gives, with the same words" is AC1's wording and it is a
claim about **one string**, not about two strings that currently agree. EPIC-22-S3 is what stops
them drifting.

The "nothing was written inside `<dir>`" clause matters: a refusal that had already created
`.DeFlow/` before checking would leave the operator with a directory DeFlow half-owns and no project
to explain it.

---

## EPIC-22-S3 — The refusal is one string, not two copies of one sentence

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: a reworded copy is a lie in waiting

  Scenario: the CLI's error and the API's refusal come from one constant
    Given the exported constant the projects route returns for a non-repository path
    And the message "NotAGitWorkingTree" is constructed with
    Then the two are the same string
    And it names the command in lower case ("deflow"), not the capitalised product name
    And it names the command an operator would run next
```

**Notes:** a guard rather than a behaviour, and it belongs at `unit` because it is a fact about the
source. The failure it prevents is silent by construction: two copies agree on the day they are
written and disagree on the day one of them is improved.

---

## EPIC-22-S4 — Creating a project bootstraps `.DeFlow/` and reports what it created

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: a project is ready to run against the moment it exists

  Scenario: a repository with no .DeFlow gets one
    Given a real git repository at <repo> with no ".DeFlow" directory
    When "POST /api/projects" is called with { name: "checkout", path: <repo> }
    Then the response body's "init.ran" is true
    And "<repo>/.DeFlow/config.yaml" exists
    And "<repo>/.DeFlow/schemas/" contains the config JSON Schema
    And "<repo>/.gitignore" contains the per-machine entries "init" appends
    And "init.paths" contains one entry per path with a status of
        "created" | "unchanged" | "updated" | "kept (edited)"
    And every entry's "relativePath" is repository-relative, as it would read in "git status"
    And the paths reported are exactly the paths "deflow init" reports for the same repository
```

**Notes:** the last clause is the reuse claim. `initWorkspace` is called; the route does not write
`.DeFlow/` itself. Two writers of one directory diverge on the `.gitignore` merge, the schema file
or the worktree-include defaults, and the divergence is invisible until somebody initialises the
same repository both ways.

---

## EPIC-22-S5 — A repository that is already initialised is not initialised twice

**Verifies:** KAR-22.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: "if .DeFlow/ is absent" is a condition, not a formality

  Scenario: an already-initialised repository
    Given a real git repository at <repo> that already has a ".DeFlow" directory
    And the mtime and bytes of every file under it are recorded
    When "POST /api/projects" is called with { name: "again", path: <repo> }
    Then the response status is 201
    And "init.ran" is false
    And "init.reason" says the workspace was already initialised
    And every file under "<repo>/.DeFlow" has the bytes it had before
```

**Notes:** AC2 says *"runs the equivalent of `deflow init` … **if `.DeFlow/` is absent**"*. Running
it anyway would be harmless in most cases and not in all — `ensureConfigSchema` rewrites the schema
file whenever it differs, which is a change to a tracked file the operator did not ask for while
creating a project.

---

## EPIC-22-S6 — An operator's edited `config.yaml` is never overwritten

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the operator's file is the operator's

  Scenario: an edited config survives project creation
    Given a real git repository at <repo> whose ".DeFlow/config.yaml" an operator has edited
    And the exact bytes of that file are recorded
    When a project is created against <repo>
    Then the file's bytes are unchanged, byte for byte
    And no report entry claims a status of "created" or "updated" for it

  Scenario: an edited config in a repository being initialised through the API
    Given a repository with ".DeFlow/config.yaml" present and edited, and nothing else under
        ".DeFlow/"
    When a project is created against <repo>
    Then the missing directories are created
    And "config.yaml" is reported as "kept (edited)"
    And its bytes are unchanged
```

**Notes:** this is KAR-18.1 AC3's rule, asserted from the new entry point rather than assumed to be
inherited. The second scenario is the one that fails if the route re-implements the bootstrap: a
naive "write the defaults" pass creates the directories *and* rewrites the file.

---

## EPIC-22-S7 — Projects survive a daemon restart

**Verifies:** KAR-22.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: a project is not a UI preference

  Scenario: two projects, a close, and a reopen
    Given a daemon with a file-backed ledger at <dataDir>
    And two projects created through the API
    When the database is closed and a fresh daemon is constructed over the same <dataDir>
    Then "GET /api/projects" lists both projects
    And each has the same id, name and path it had before
    And nothing was read from browser storage to produce the answer
```

**Notes:** `:memory:` cannot express this scenario, which is why the Background forbids it. The
final clause is asserted structurally — the projects store is a daemon module with no DOM in its
import graph — because "did not use localStorage" is not observable from a passing read.

---

## EPIC-22-S8 — The list says whether each path still exists and is still a git repository

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: the list tells the truth about the machine

  Scenario: a healthy project
    Given a project whose path is a git working tree that still exists
    When "GET /api/projects" is called
    Then the row's "health.state" is "ok"
    And the row carries the project's path, name and id
    And "health" was computed by asking the filesystem and git, not read from the row
```

**Notes:** health is derived per request rather than stored, and that is deliberate: a stored health
column is a cache of the outside world, and the outside world changes while nobody is looking.

---

## EPIC-22-S9 — A project whose directory has gone is listed, and says so

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: a missing repository is a fact to report, not a row to hide

  Scenario: the directory was deleted or moved
    Given a project whose path was a git working tree
    When that directory is removed from disk
    And "GET /api/projects" is called
    Then the project is still listed
    And its "health.state" is "missing"
    And "health.message" names the absolute path that is no longer there
    And the row is not deleted from the "project" table
```

**Notes:** AC5's *"is not silently dropped"* is the whole scenario. A list that filters unhealthy
rows answers "where did my project go?" with silence, and the operator's next move — recreate it —
mints a second id and orphans the runs stamped with the first.

---

## EPIC-22-S10 — A directory that is still there but is no longer a git repository says which

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: two failures, two words

  Scenario: the folder survived and .git did not
    Given a project whose path is a git working tree
    When "<path>/.git" is removed and the directory itself is left in place
    And "GET /api/projects" is called
    Then the project is still listed
    And its "health.state" is "not-a-git-repo"
    And "health.state" is not "missing"
    And "health.message" says the directory exists but is no longer a git working tree
```

**Notes:** collapsing the two into one word costs the operator the diagnosis. "Missing" sends them
looking for a moved folder; "no longer a git working tree" sends them to `git init` — or to the
realisation that they are looking at the wrong directory.

---

## EPIC-22-S11 — The list shows each project's most recent run

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: "what happened here lately" is answered by the list

  Scenario: two runs, and the row names the newer
    Given a project <p>
    And a run submitted against <p>, and then a second run submitted against <p>
    When "GET /api/projects" is called
    Then the row's "lastRun.runId" is the second run's id
    And "lastRun.status" is that run's status
    And "lastRun.label" is the string "runStatusLabel" produces — the same one the run list and
        "deflow status" print
    And "lastRun.createdAt" is an ISO-8601 timestamp

  Scenario: a project nothing has run in
    Given a project with no runs
    When "GET /api/projects" is called
    Then the row's "lastRun" is null
```

**Notes:** `label` is not derived here. There is one producer of a run's human-readable status
(`runStatusLabel` in `@DeFlow/core`), and a projects list that rendered its own adjective would be
the fourth surface describing one run in its own words.

---

## EPIC-22-S12 — A project is renamed, and its id, path and history do not move

**Verifies:** KAR-22.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a name is a label, not an identity

  Scenario: renaming
    Given a project <p> named "checkout" with one run against it
    When "PATCH /api/projects/<p>" is called with { name: "checkout-v2" }
    Then the response status is 200
    And the project's id and path are unchanged
    And the run submitted earlier is still found for <p>
    And a fresh daemon over the same data directory reads back the new name

  Scenario: a rename to an empty name
    When "PATCH /api/projects/<p>" is called with { name: "" }
    Then the response status is 400
    And "detail.field" is "name"
    And the stored name is unchanged
```

**Notes:** the second scenario exists because a blank name is the easiest way to make a list
unreadable, and a `TEXT NOT NULL` column accepts the empty string quite happily.

---

## EPIC-22-S13 — Removing a project removes a row and not a single file

**Verifies:** KAR-22.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: DeFlow never deletes the operator's code

  Scenario: removing a project with a populated repository
    Given a project whose repository contains tracked files, a commit and a ".DeFlow" directory
    And a recursive listing of that directory is recorded
    When "DELETE /api/projects/<p>" is called
    Then the response status is 200
    And "GET /api/projects" no longer lists it
    And a recursive listing of the directory is identical to the one recorded
    And "<repo>/.git" still exists
    And "<repo>/.DeFlow" still exists
    And the response states in words that no files were deleted

  Scenario: the runs that belonged to it
    Given the project had two runs
    When it is removed
    Then both runs are still listed by "GET /api/runs"
    And each is still openable by its own id
```

**Notes:** the second scenario is the reason `projectId` lives on the run's own `task.submitted`
rather than being looked up through the project row. A deleted project cannot make a run
unreadable, because the run recorded where it came from itself.

---

## EPIC-22-S14 — The same directory cannot become two projects

**Verifies:** KAR-22.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: one directory, one project

  Scenario Outline: a second create for the same place
    Given a project already exists for the realpath of <repo>
    When "POST /api/projects" is called with { name: "second", path: "<spelling>" }
    Then the response status is 409
    And the error names the existing project's id
    And "GET /api/projects" still lists exactly one project

    Examples:
      | spelling            |
      | <repo>              |
      | <repo>/             |
      | <symlink to repo>   |
```

**Notes:** the three spellings are the whole point. A uniqueness constraint on the string the caller
sent is satisfied by all three at once, and the operator ends up with three projects, three
histories and one directory.

---

## EPIC-22-S15 — Every run created after this story carries its project id

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: a run knows which project it belongs to

  Scenario: submitting against a project
    Given a project <p> whose path is <repo>
    When "POST /api/runs" is called with { input: {kind:"text", text:"…"}, cwd: <repo>,
        permission: "worktree", projectId: <p> }
    Then the response status is 201
    And the run's only event is a "task.submitted"
    And its payload's "provenance.projectId" is <p>
    And "GET /api/runs/<runId>" reports the same project id

  Scenario: a project id nothing holds
    When "POST /api/runs" is called with projectId "prj_20260101T000000Z_ffffff"
    Then the response status is 400
    And "detail.field" is "projectId"
    And no run was created — "GET /api/runs" is unchanged
    And no "task.submitted" was appended

  Scenario: a malformed project id
    When "POST /api/runs" is called with projectId "not-an-id"
    Then the response status is 400
    And "detail.field" is "projectId"
```

**Notes:** the second scenario's *"no run was created"* is the clause with teeth. Intake's own rule
(KAR-10.1 AC5) is that a rejected submission leaves no half-born run, and an unknown project must be
rejected under that rule rather than after the append.

---

## EPIC-22-S16 — A run submitted before projects existed is still readable

**Verifies:** KAR-22.1 · **Type:** Recovery · **Automated at:** unit

```gherkin
Feature: a ledger may never make its own history unreadable

  Scenario: a payload with no projectId
    Given a "task.submitted" payload whose provenance carries no "projectId"
    When it is parsed by "TaskSubmittedSchema"
    Then it parses
    And folding it through "reduce()" produces the same run state it produced before this story
    And the run summary reports the project id as null rather than throwing

  Scenario: the run list
    Given a ledger holding one run with a project id and one without
    When "GET /api/runs" is called
    Then both runs are listed
```

**Notes:** `projectId` is optional for exactly the reason `cwd` is optional, and that reason is
written down in `task-intake.ts` already: payloads on disk do not have it, and a required field
would make them unreadable. `unit` is the right level because it is a schema and reducer property,
and the integration half is covered by the second scenario in EPIC-22-S13.

---

## EPIC-22-S17 — The page: the form creates a project, the refusal is shown, and removal states the risk

**Verifies:** KAR-22.1 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the operator does this from a browser, which is the entire point

  Scenario: creating a project from the form
    Given the shell is mounted at the projects route with a client that answers the projects API
    When a name and a path are typed and the form is submitted
    Then exactly one "POST /api/projects" request was made, with those two fields
    And a row for the new project appears without the page reloading
    And the row shows the project's path

  Scenario: the refusal is rendered, not swallowed
    Given the client answers "POST /api/projects" with the 400 a non-repository path earns
    When the form is submitted
    Then the refusal's message is on screen, verbatim
    And the typed path is still in the field

  Scenario: removing states what is and is not deleted
    Given a project row
    When remove is activated
    Then a confirmation is shown that names the project's path
    And states that no files on disk are deleted
    And dismissing it issues no request at all
    And confirming it issues exactly one "DELETE /api/projects/<id>"

  Scenario: an unhealthy project is visible, not hidden
    Given the client lists a project with health state "missing"
    Then that row is rendered
    And its health message is on screen
    And it is not styled as though it were ordinary
```

**Notes:** the third scenario's *"dismissing it issues no request at all"* is what makes the
confirmation real. A dialog that has already sent the request is a notification.

Real Chromium, through the existing `mountShell` helper: a spec that assembled its own app would be
asserting against a shell that does not ship, and the plugin it forgot is always the one the bug is
in.

---

## EPIC-22-S18 — Happy path: a prompt typed in the browser becomes a running run

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the terminal stops being the only way in

  Scenario: text, an adapter, and a submit
    Given a project with a healthy path
    And the picker lists the bundled agent as available
    When a prompt is typed, the bundled agent is selected, and the composer is submitted
    Then exactly one "POST /api/runs" request was made
    And the route is now the new run's
    And the run's first stream frame is rendered
    And no page reload occurred
```

---

## EPIC-22-S19 — The composer builds the API's own body, not one of its own

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: one wire shape

  Scenario: the request body
    When a prompt is submitted from the composer
    Then the request body parses against "RunIntakeBodySchema"
    And "input.kind" is "text"
    And "cwd" is the project's path
    And "projectId" is the project's id
    And "provider" is the id the picker had selected
    And no field is present that the schema does not declare
```

---

## EPIC-22-S20 — All three intake shapes go through one intake path

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: the UI is a client of intake, not a second intake

  Scenario Outline: text, file and issue
    Given a project at <repo>
    When "<shape>" is submitted through "POST /api/runs"
    Then exactly one "task.submitted" event exists for the run
    And its provenance kind is "<kind>"
    And it was produced by the same "submitTask" the CLI calls

    Examples:
      | shape                        | kind  |
      | a free-text prompt           | text  |
      | a file inside the project    | file  |
      | an issue reference           | issue |
```

---

## EPIC-22-S21 — The picker, `doctor` and admission answer from one producer

**Verifies:** KAR-22.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: three readers, one answer

  Scenario: a machine with one vendor CLI and no ACP adapter
    Given a temp PATH holding a fake vendor CLI and no ACP adapter for it
    When "doctor" is asked about that provider
    And admission is asked whether it can serve a run
    And the composer's picker is rendered
    Then all three name the same availability
    And all three name the same route
    And the picker performed no probe of its own — it read the producer's answer

  Scenario: the producer changes its mind
    Given the producer is re-run after the ACP adapter is installed
    Then all three change together
```

**Notes:** the epic that just shipped exists because of exactly this class of mismatch. A picker
with its own probe is a fourth answer, and the first thing an operator does with it is select
something admission then refuses.

---

## EPIC-22-S22 — Each provider's route is named — ACP adapter or exec shim

**Verifies:** KAR-22.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: "available" is not enough to plan with

  Scenario: the picker's rows
    Given the producer reports one provider reachable over ACP and one over the exec shim
    Then each row names its route in words
    And the route shown for each is the route the producer reported
```

---

## EPIC-22-S23 — An unavailable provider is not silently selectable

**Verifies:** KAR-22.2 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: a dead end is labelled before it is walked into

  Scenario: an unavailable provider
    Given the producer reports a provider as unavailable, with a reason and a fixing command
    Then its row is not submittable
    And the reason is on screen
    And the fixing command is on screen
    And submitting the composer while it is selected issues no request
```

---

## EPIC-22-S24 — Submitting navigates to the run and streams it, with no reload

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the operator is taken to the thing they just started

  Scenario: after a 201
    When the composer is submitted and the API answers 201 with a run id
    Then the router's current route is that run's
    And a stream subscription for that run was opened
    And a frame pushed onto it renders
    And no full page load occurred between the submit and the frame
```

---

## EPIC-22-S25 — An admission refusal is shown in the CLI's own words

**Verifies:** KAR-22.2 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: one machine, one sentence

  Scenario: nothing on this machine can serve the run
    Given the API answers "POST /api/runs" with KAR-19.2's admission refusal
    Then the composer renders the refusal's message byte-identical to the CLI's
    And it does not claim the run started
    And the run id the refusal names is shown, because the run exists and was aborted
    And the draft is still in the box
```

---

## EPIC-22-S26 — A human gate announces itself in the words KAR-19.12 ships

**Verifies:** KAR-22.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: the gate says what it already says everywhere else

  Scenario: a run that stops to ask
    Given a run whose projection carries a pending gate
    Then the announcement rendered is the one KAR-19.12 produces
    And it names the node and the options, exactly as the run list and the CLI do
```

---

## EPIC-22-S27 — What was submitted is still readable afterwards

**Verifies:** KAR-22.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: "what did I ask for?" has an answer on screen

  Scenario: after submitting
    When a prompt is submitted
    Then the submitted text is rendered back on the run's own surface
    And navigating away and back still shows it
    And it came from the run's own "task.submitted", not from a copy the page kept
```

---

## EPIC-22-S28 — Keyboard only: reach the composer, type, submit

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: keyboard-first, per the shell's existing map

  Scenario: no pointer events
    Given the shell is mounted somewhere inside a project
    When the composer's shortcut is pressed, a prompt is typed and the submit chord is pressed
    Then a run was submitted
    And no pointer event was dispatched during the scenario
    And focus is visible at every step
```

---

## EPIC-22-S29 — A failed submission keeps the draft and says what happened

**Verifies:** KAR-22.2 · **Type:** Recovery · **Automated at:** browser

```gherkin
Feature: a paragraph is not retyped because a socket failed

  Scenario: the request fails
    Given the client rejects "POST /api/runs" with a network error
    When the composer is submitted
    Then the typed text is still in the box
    And an error is on screen naming what failed
    And submitting again issues a second request
```

---

## EPIC-22-S30 — An empty submission is refused before a request is made

**Verifies:** KAR-22.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: the cheapest refusal is the one that costs no round trip

  Scenario: nothing typed
    When the composer is submitted with an empty box and no file and no issue
    Then no request was made
    And the composer says what it needs
```

---

## EPIC-22-S31 — A file outside the project is refused by the containment check, not by the page

**Verifies:** KAR-22.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: one containment check, at the boundary that owns it

  Scenario: a path escaping the project
    Given a project at <repo>
    When a run is submitted with input { kind: "file", path: "../outside.txt" }
    Then the response status is 400
    And the refusal is the one intake's own realpath containment check produces
    And no run was created
```

---

## EPIC-22-S32 — Double submission creates one run

**Verifies:** KAR-22.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: a double-click is not two tasks

  Scenario: submit twice quickly
    When the submit chord is pressed twice before the first response arrives
    Then exactly one "POST /api/runs" request was made
    Or two were made carrying the same "Idempotency-Key" and exactly one run exists
```

---

## EPIC-22-S33 — Performed: a run started from the browser against the bundled agent

**Verifies:** KAR-22.2 · **Type:** Happy path · **Automated at:** manual

```gherkin
Feature: the epic's own acceptance, performed rather than asserted

  Scenario: a person does it
    Given a built UI, a daemon started with "deflow up", and a scratch git repository
    When a browser is opened, a project is created against that repository, and a run is started
        from the composer with the bundled agent
    Then the run appears without a run id being typed
    And it streams
    And the transcript is pasted onto the epic's Linear issue
```

**Notes:** a green suite is not evidence for this scenario. EPIC-19 exists because roughly ten
thousand tests passed while a live run did nothing.

### Performed — 2026-08-16

Level: **browser**. Real Chromium (Playwright 1.62, headless, 1440×900) driving the UI the daemon
serves; the daemon was the built artefact (`pnpm build`, then
`node packages/cli/dist/bin.mjs up --no-open --port 7891` with `DeFlow_DATA_DIR` pointed at a
scratch directory). The project was a throwaway git repository at `/tmp/s33-scratch/repo` — one
commit, a README, nothing else. Both were deleted afterwards, and no `deflow up` process was left
behind.

What was exercised, and what was seen:

- **A project was created from `/projects`.** Name and path typed into the form, `Create project`
  clicked; the row appeared as `s33-scratch · /private/tmp/s33-scratch/repo` — stored post-`realpath`
  as KAR-22.1 says — linking to `/projects/prj_20260816T080723Z_24f51a`.
- **A run was started from the composer** on the project workspace, with `mock` chosen in the
  adapter picker (the picker listed all six providers with their per-route reasons; only `claude`
  and `mock` were usable on this machine). Clicking `Start run` navigated straight to
  `/runs/run_20260816T080816Z_857a35` — **no run id was typed anywhere**.
- **It progressed.** Within six seconds of submission the page showed the framed spec and the
  `spec-approval` gate waiting, with the whole `DeFlow.taskspecdraft.v1` document readable above the
  four options.
- **The gate was answered in the page.** `approve` was clicked. No navigation and no reload
  occurred (main-frame navigations after the click: zero), and within five seconds the gate panel
  was gone and the compiled plan had rendered.
- **Graph, board and history all showed it.** Graph: three nodes, `implement → verify → review`,
  with edges and per-node state. Board (`Show the node table`): the same three rows with step, type,
  state, agent, model, permission, elapsed and cost. History: one entry —
  *"Carry out the submitted task in this repository, and leave it green." · aborted · 8/16/2026,
  10:08:16 AM*.
- **The run reached a terminal state.** `implement` passed, `verify` passed, and the trailing
  `review` gate failed: the scratch repository carries no gate definition, so the ledger recorded
  *"no gate definition resolved for review — a gate that does not run is a milestone advancing on a
  verdict nobody produced"* and the run ended `aborted`. The mock agent edits nothing, so this is
  the honest outcome for a bare repository rather than a broken pipeline — `e2e/smoke` gets a
  completed run only because its harness writes `.DeFlow/gates/typecheck.yaml` first.

Two things a human should still eyeball, both found while performing this and neither fixed here:

1. **A fresh daemon lists a run nobody started.** On a brand-new data directory, `GET /api/runs`
   and the browser's run list show one run — status `created`, *"submitted — waiting to be framed"*
   — which never progresses. It is the boot-time provider probe: `probeProvidersOnBoot` mints a real
   run id for its `provider.probed` events, and the run list derives runs from event `run_id`s
   rather than from `run.created`. `api.ts`'s own comment on the `/providers/doctor` route states
   the opposite intent ("nothing appends `run.created` for it, so it never becomes a run"). It is
   the first thing a new operator sees.
2. **The browser never says why a run failed.** The failure message above is in the ledger, but
   the workspace shows only `Failed` on the node and `aborted` in history; clicking the failed node
   changes nothing on the page, and `/runs/:runId` on its own shows no run-level status at all.
   An operator who stays in the browser cannot learn the reason.

Cosmetic, worth a look but not filed: the graph node cards clip their own body text at 1440 px, and
the node table's right-hand columns need horizontal scroll at that width.

---

## EPIC-22-S34 — Happy path: the project route shows its active run live

**Verifies:** KAR-22.3 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the workspace answers "what is happening"

  Scenario: frames arrive and the graph moves
    Given a project with an active run
    When "node.started" and "node.completed" frames are pushed onto its subscription
    Then the graph updates without a reload
    And the canvas rendering them is the existing plan-graph component
```

---

## EPIC-22-S35 — There is exactly one canvas, one run store and one client

**Verifies:** KAR-22.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: a second copy is a defect, not a feature

  Scenario: the module guard
    Given the module graph under "packages/web/src"
    Then exactly one module imports "@vue-flow/core" as the plan canvas
    And exactly one run store module exists
    And exactly one API client module exists
    And this epic's views import those and not copies of them
```

---

## EPIC-22-S36 — The board and the graph cannot disagree

**Verifies:** KAR-22.3 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: two views, one projection

  Scenario: twenty frames, checked after each
    Given the board and the graph are mounted over one store
    When twenty lifecycle frames are pushed one at a time
    Then after each frame, every node's state in the board equals its state in the graph
    And the board holds no array of its own that the graph does not read from
```

---

## EPIC-22-S37 — Every board row carries the eight facts an operator acts on

**Verifies:** KAR-22.3 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: a board is a work list, not a status column

  Scenario: one row
    Then the row shows the node's title, its node type and its state
    And the provider and the model handling it
    And its permission level
    And its elapsed time and its cost so far
    And every one of those came from the projection rather than from fixture prose
```

---

## EPIC-22-S38 — State is never carried by colour alone

**Verifies:** KAR-22.3 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: the project's existing accessibility rule, applied to a new surface

  Scenario Outline: every state
    Given a node in state "<state>"
    Then a glyph is rendered for it
    And a text label is rendered for it
    And removing colour from the computed style leaves both readable

    Examples:
      | state          |
      | pending        |
      | running        |
      | blocked        |
      | passed         |
      | failed         |
      | abandoned      |
      | awaiting-human |
```

---

## EPIC-22-S39 — Run history for the project, newest first

**Verifies:** KAR-22.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: "what happened" without a run id

  Scenario: three finished runs
    Given a project with three finished runs and a fourth run in another project
    When the project's history is requested
    Then exactly the three are listed, newest first
    And each carries its outcome, when it ran, what it cost and the task it was given
    And the fourth is not listed
```

---

## EPIC-22-S40 — History survives a daemon restart

**Verifies:** KAR-22.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: history is the ledger's, not the tab's

  Scenario: close and reopen
    Given a project with three finished runs
    When the database is closed and a fresh daemon is constructed over the same data directory
    Then the history is identical
```

---

## EPIC-22-S41 — A historical run opens without a run id being typed

**Verifies:** KAR-22.3 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the address bar stops being an input device

  Scenario: opening a past run
    When a history row is activated
    Then the route is that run's
    And the existing scrubber restores its full view
    And no run id was typed anywhere in the scenario
```

---

## EPIC-22-S42 — A project with no runs says so and points at the composer

**Verifies:** KAR-22.3 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: an empty canvas reads as a broken page

  Scenario: a fresh project
    Given a project with no runs
    Then the workspace says nothing has run yet
    And names the composer as the next action
    And renders no empty graph canvas
```

---

## EPIC-22-S43 — Switching project leaks no stream, no store and no subscription

**Verifies:** KAR-22.3 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: the second project is not haunted by the first

  Scenario: switching
    Given the workspace is open on project A with an active run
    When the operator switches to project B
    Then A's stream subscription was closed
    And A's run store entry was released
    And a frame pushed onto A's old subscription renders nothing in B's workspace
    And the leak assertion the shell already carries reports nothing retained
```

---

## EPIC-22-S44 — A run that ended while the tab was closed is shown in its terminal state

**Verifies:** KAR-22.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: hydrate before stream, as the API contract requires

  Scenario: reopening after the end
    Given a run that completed while nothing was subscribed
    When the workspace is opened for its project
    Then the run is shown as completed
    And its full graph is present
    And the events came from the hydrate endpoint before any stream was opened
```

---

## EPIC-22-S45 — A project whose path has gone still shows its history

**Verifies:** KAR-22.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the past does not depend on the present

  Scenario: a deleted directory
    Given a project with two finished runs
    When its directory is removed from disk
    Then its history still lists both runs
    And the workspace states that the path is missing
    And starting a new run from it is refused with that reason
```

---

## EPIC-22-S46 — The board is bounded

**Verifies:** KAR-22.3 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: the bounded run store's guarantee is not lost in a new view

  Scenario: two hundred nodes
    Given a plan with two hundred nodes
    Then the board renders
    And the number of retained node objects stays within the store's declared bound
    And no per-row subscription was opened
```

---

## EPIC-22-S47 — A run belonging to no project is still reachable

**Verifies:** KAR-22.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: the run list keeps working for runs from before projects

  Scenario: a projectless run
    Given a run whose "task.submitted" carries no project id
    Then "GET /api/runs" lists it
    And opening it renders its full view
    And no project workspace claims it
```

---

## EPIC-22-S48 — Happy path: GitHub is connected from the screen, not from a README

**Verifies:** KAR-22.4 · **Type:** Happy path · **Automated at:** browser

**Re-pointed 2026-08-16 by the split of KAR-22.4.** As written this scenario named all three
services; the two rows that are not GitHub moved to EPIC-22-S70 under KAR-22.6, and what stays here
is the framework and the one service KAR-22.4 builds.

```gherkin
Feature: connecting is a screen, not a paragraph in a README

  Scenario: the connectors screen
    Given a project
    Then GitHub is listed with exactly one of connected, not-installed, not-authorised,
        expired, missing-scope or unreachable
    And that state carries a sentence and the one command or link that resolves it
    And connecting is started from this screen rather than from documentation
```

---

## EPIC-22-S49 — No model credential is read, written or logged by a connector

**Verifies:** KAR-22.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: AR-1 and ADR-0003, enforced by a guard rather than by intention

  Scenario: the source guard
    Given the connector module and its import graph
    Then nothing reads "~/.claude", "~/.codex" or "~/.config/gcloud"
    And nothing reads a "*_API_KEY" or "*_TOKEN" environment variable belonging to a model provider
    And nothing captures the output of a vendor login command
```

---

## EPIC-22-S50 — A connector token never reaches a ledger event or a log line

**Verifies:** KAR-22.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: everything on disk is inspectable, which cuts both ways

  Scenario: a fake authorisation server
    Given a connector is authorised against a fake authorisation server
    When the full ledger and every log line produced are searched for the token's bytes
    Then neither contains it
    And the token is where the design says it is, and nowhere else
```

---

## EPIC-22-S51 — Connected: the issue input becomes a list, and pasting still works

**Verifies:** KAR-22.4 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: picking beats pasting, and pasting still works

  Scenario: a connected project
    Then the composer's issue input offers a searchable list of the project's real issues
    And each entry shows key, title and state
    And pasting a raw reference still submits a run
```

---

## EPIC-22-S52 — An expired token says so before a run is submitted

**Verifies:** KAR-22.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: a permissions problem is not discovered an hour into framing

  Scenario: expiry
    Given a connector whose token has expired
    Then the connectors screen says it has expired and what to do
    And submitting a run that needs it is refused before any framing turn
```

---

## EPIC-22-S53 — A missing scope names the scope

**Verifies:** KAR-22.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: "insufficient permissions" is not a diagnosis

  Scenario: a token without the scope
    Given a connector whose token lacks the scope needed to read issues
    Then the failure names the missing scope
    And names how to grant it
```

---

## EPIC-22-S54 — Removing a connector ends DeFlow's access rather than hiding it

**Verifies:** KAR-22.4 · **Type:** Edge case · **Automated at:** integration

**Amended 2026-08-16 with KAR-22.4's credential decision.** DeFlow holds no grant of its own with
GitHub — its access *is* permission to spawn the operator's `gh` — so there is no revocation call it
could make, and asserting one would have meant inventing an OAuth application to make it with. What
is asserted instead is stronger than a hidden row and honest about what DeFlow controls: after
removal DeFlow spawns nothing at all for that project. The credential is the operator's and is
shared with every other tool on their machine, so the removal *names* the command that revokes it
rather than running it behind their back.

```gherkin
Feature: "removed" means DeFlow stops asking

  Scenario: removal
    When a connector is removed
    Then the row is gone
    And a subsequent issue read for that project spawns no child process at all
    And that read is refused as not connected rather than answered
    And the removal response names `gh auth logout --hostname github.com` as the operator's own
        revocation command, and says it affects every tool on the machine that uses `gh`
```

---

## EPIC-22-S55 — Connectors are per project

**Verifies:** KAR-22.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: two projects, two connections

  Scenario: isolation
    Given project A is connected to GitHub and project B is not
    Then B's connectors screen shows GitHub as not connected
    And B's composer offers no issue list
```

---

## EPIC-22-S56 — Everything in this epic works with no connector at all

**Verifies:** KAR-22.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: no connector is required

  Scenario: the zero-config path
    Given no connector is configured for any project
    Then creating a project, starting a run and watching it all work
    And the issue input still accepts a pasted reference
```

---

## EPIC-22-S57 — ADR-0003 is satisfied or amended, in writing

**Verifies:** KAR-22.4 · **Type:** Edge case · **Automated at:** manual

```gherkin
Feature: a constraint is not quietly outgrown

  Scenario: the written decision
    Given ADR-0003 says DeFlow never holds provider credentials
    Then this epic's design states where a connector's token lives, who holds it and why that is
        consistent with the ADR
    Or the ADR carries a dated amendment saying what changed and why
```

**Notes:** an issue-tracker token is not a model credential, and that distinction is defensible — but
it has to be written down, because the next person to read ADR-0003 will read it as "no tokens" and
will be right to.

**Settled 2026-08-16.** The answer turned out not to need the distinction: DeFlow holds no connector
token either. The token lives in the GitHub CLI's own credential store, put there by `gh auth login`
against GitHub's own application, and DeFlow reaches GitHub by spawning `gh` — which is ADR-0003's
own decision, applied to a second class of credential rather than excepted from. ADR-0003 carries
the dated amendment saying so.

---

## EPIC-22-S68 — The connectors screen has no token field at all

**Verifies:** KAR-22.4 · **Type:** Failure · **Automated at:** browser

**Added 2026-08-16 with KAR-22.4's amended AC1.** DeFlow has no registered OAuth application with
GitHub, so it cannot own the authorisation button; the temptation that replaces a missing button is
a token box, and this scenario is what stops one appearing.

```gherkin
Feature: the missing button is not replaced by a token box

  Scenario: no field to paste a credential into
    Given the connectors screen for a project
    Then it holds no input of type text, password, search or textarea for a token
    And it states whose application authorises GitHub, which is GitHub's own CLI's and not DeFlow's
    And it states where the token lives and that DeFlow stores only the project and the service name
    And it says why connecting takes one command rather than one click
```

---

## EPIC-22-S69 — `gh` is not installed: the screen says so and the rest of the page still works

**Verifies:** KAR-22.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a missing CLI is a sentence, not a stack trace

  Scenario: no gh on PATH
    Given a machine with no `gh` on PATH
    Then the connectors screen reports GitHub as not-installed and names how to install it
    And the projects list, the composer and the workspace are unaffected
    And a run submitted with a pasted issue reference is refused by intake's own sentence rather
        than by the connector
```

---

## EPIC-22-S70 — Linear and Jira are rows on the same framework

**Verifies:** KAR-22.6 · **Type:** Happy path · **Automated at:** browser

**Inherited 2026-08-16 from EPIC-22-S48**, which named all three services before KAR-22.4 was split.

**Amended 2026-08-16 with what the research found.** Atlassian publishes `acli`, which holds a Jira
credential exactly the way `gh` holds a GitHub one, so Jira is a connector in full. Linear publishes
no first-party tool that holds a credential — only a personal API key DeFlow would have to hold and
an OAuth application DeFlow does not have — so its row is the honest "not yet" this scenario's last
clause already anticipated. The clause is now load-bearing rather than defensive.

```gherkin
Feature: a second and third service prove the framework rather than fork it

  Scenario: three rows, one registry
    Given a project
    Then Linear and Jira are listed beside GitHub, rendered by the same row component
    And each names whose application authorises it, where its credential lives and who holds it
    And a service DeFlow cannot connect without holding a credential says exactly that, rather
        than offering a button that goes nowhere
```

---

## EPIC-22-S71 — Linear cannot be connected without DeFlow holding a credential, and says so

**Verifies:** KAR-22.6 · **Type:** Failure · **Automated at:** integration

**Rewritten 2026-08-16, after the research this story's split existed to force.** As authored this
scenario assumed a connected Linear project. Linear publishes no first-party command-line tool that
holds a credential: reaching its API needs either a personal API key, which DeFlow would then hold
and ADR-0003 forbids, or an OAuth application DeFlow does not have and will not fabricate a client
id for. `@linear/cli` (`lin`) is Linear-authored but was last published in 2021, keeps an API key in
its own config file, and has no search or list command at all. So there is no connected Linear
project to search, and asserting one would have been asserting a fiction. What is asserted instead
is the answer KAR-22.6 AC2 named in advance as permitted, made real and made refusable.

```gherkin
Feature: "not yet, and here is why" is a shipped answer

  Scenario: the row that says it cannot be connected
    Given a project
    Then Linear is listed with the sentence saying DeFlow cannot connect it without holding a
        credential, and therefore does not
    And that sentence names what would have to change for it to become connectable
    And the row carries no command and no authorisation link to follow
    When connecting Linear is attempted anyway
    Then it is refused as `connector_unavailable` rather than recorded
    And no connector row is written for it
    And asking for its issues is refused, having spawned no child process at all
```

---

## EPIC-22-S72 — A connected Jira project's issue search returns key, title and state

**Verifies:** KAR-22.6 · **Type:** Happy path · **Automated at:** integration

**Amended 2026-08-16 on the missing-scope clause.** Atlassian's credentials are not scoped the way a
GitHub OAuth token is — what governs whether an account may read a work item is that account's own
Jira project permissions, which `acli` reports as an ordinary failure and not as a named scope. Jira
therefore declares no required scopes and never reports `missing-scope`, and the state union is
unmodified: the six states are still the six. GitHub remains the service the missing-scope naming is
asserted over, in EPIC-22-S53.

```gherkin
Feature: Jira is supported in the product, not in a README

  Scenario: searching Jira
    Given a project connected to Jira through Atlassian's own `acli`
    When the composer's issue input is searched
    Then each entry shows key, title and state
    And an expired credential and a removal behave exactly as GitHub's do
    And the search term reached `acli` rather than being filtered inside DeFlow
```

---

## EPIC-22-S73 — One project connected to two services

**Verifies:** KAR-22.6 · **Type:** Edge case · **Automated at:** integration

**Re-pointed 2026-08-16 from Linear to Jira.** The pair this scenario names has to be two services
that can both actually be connected, and EPIC-22-S71 records why Linear is not one of them. GitHub
and Jira are, and they are the harder pair anyway: two different binaries, two different issue
vocabularies and two different credential holders reduced to one list.

```gherkin
Feature: connectors compose

  Scenario: two at once
    Given a project connected to both GitHub and Jira
    Then the composer's issue list says which service each entry came from
    And removing one leaves the other connected
    And removing the second leaves the project working with no connector at all
```

---

## EPIC-22-S74 — A Jira work item picked from the list actually submits a run

**Verifies:** KAR-22.6 · **Type:** Happy path · **Automated at:** integration

**Added 2026-08-16 with KAR-22.6's AC5.** KAR-22.4's composer writes the picked issue's reference
into the box, and intake resolved only `https://github.com/…/issues/<n>` — so every Jira entry would
have been an entry that submits a run intake then refuses. A picker whose entries are dead ends is
worse than no picker, because the dead end is discovered after the click.

```gherkin
Feature: the list's entries are references that work

  Scenario: submitting what the picker wrote
    Given a project connected to Jira
    And the reference the picker wrote into the issue box is that work item's browse URL
    When the run is submitted
    Then intake resolves it through the same `acli`, at the same one spawn chokepoint `gh` uses
    And the run is accepted
  Scenario: `acli` is not installed
    Given the same submission on a machine with no `acli`
    Then intake refuses it in its own sentence, naming the resolver and offering the text path
    And nothing is invented in place of an answer
```

---

## EPIC-22-S75 — A service cannot be registered without saying who holds its credential

**Verifies:** KAR-22.6 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the type is the ADR

  Scenario: the registry's own requirement
    Given the connector registry
    Then every registered service answers whose application authorises it, where its credential
        lives, who holds it and what DeFlow itself stores
    And none of those four answers is empty
    And a service declared without them does not typecheck
```

---

## EPIC-22-S76 — One screen, one store, one issue-search route, one issue list

**Verifies:** KAR-22.6 · **Type:** Edge case · **Automated at:** unit

**Added 2026-08-16 with KAR-22.6 AC1.** The failure this story exists to avoid is the second service
arriving as a copy of the first — a second screen, a second table, a second route — and a copy is
not something a reviewer reliably notices. It is something a guard notices.

```gherkin
Feature: a second service proves the framework rather than forks it

  Scenario: the source guard
    Given the repository
    Then exactly one connectors screen component exists
    And exactly one `connector` table is created by exactly one migration
    And exactly one issue-search route is mounted
    And exactly one component renders the composer's issue list
    And the guard is proved non-vacuous by finding each of them at all
```

---

## EPIC-22-S58 — Happy path: the run's open gate is answered from the browser

**Verifies:** KAR-22.5 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: a run started in a tab can be finished in that tab

  Scenario: the spec-approval gate, approved with one click
    Given a project whose newest run has stopped on its "spec-approval" gate
    When the workspace for that project is opened
    Then the gate panel names the node "spec-approval"
    And it renders every option the daemon offered — approve, edit, reject and abandon —
        each with the label the gate itself carries
    When "approve" is pressed
    Then exactly one request is made
    And it is "POST /api/runs/<runId>/spec/approve"
    And its body is the one "deflow answer" sends for the same gate and option
```

**Notes:** the option **labels** are the gate's, not the page's. `SPEC_APPROVAL_OPTIONS` is where
§1.3's four sentences live; a panel that wrote its own would be the fifth place this project has
described one decision.

---

## EPIC-22-S59 — The spec is readable before it is approved

**Verifies:** KAR-22.5 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: approving is not a click on a document nobody read

  Scenario: the rendered spec on the panel
    Given a run stopped on its "spec-approval" gate
    And the gate's prompt is "renderSpecForReview"'s own rendering of the draft
    When the workspace is opened
    Then the panel shows the prompt verbatim, including its Goal, In scope, Non-goals,
        Constraints, Acceptance criteria and Known failure modes sections
    And the text is present before any option is pressed
```

**Notes:** verbatim, and that is the point — the bytes on the page are the bytes in
`human.requested.prompt`, which are the bytes the terminal printed. A panel that re-rendered the spec
from `run.created.spec` would be a second renderer of one document, and the two would disagree the
first time a run was amended.

---

## EPIC-22-S60 — There is one answer path, and both surfaces build their request with it

**Verifies:** KAR-22.5 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: the routing decision is made once

  Scenario Outline: every gate and option a surface can answer
    Given the gate <gate> and the option <option>
    When the browser builds its request and "deflow answer" builds its own
    Then both are the same path and the same body
    And that path is <path>

    Examples:
      | gate           | option  | path                                      |
      | spec-approval  | approve | /api/runs/<runId>/spec/approve            |
      | spec-approval  | reject  | /api/runs/<runId>/spec/reject             |
      | spec-approval  | abandon | /api/runs/<runId>/spec/abandon            |
      | review-changes | approve | /api/runs/<runId>/nodes/review-changes/respond |
```

**Notes:** the F1.3 gate's four decisions are four endpoints because that is what KAR-10.3 built —
approving pins the spec, rejecting mints a reframing attempt, abandoning ends the run. Every other
gate is one endpoint and an option id. That is a routing fact with two readers, so it is one
function.

---

## EPIC-22-S61 — `edit` is offered honestly or not at all

**Verifies:** KAR-22.5 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: no button promises something the surface cannot carry

  Scenario: the edit option
    Given a run stopped on its "spec-approval" gate
    When the workspace is opened
    Then "edit" is listed among the options
    And it is not submittable
    And the reason on screen is the same exported sentence "deflow answer" prints for it
    When "edit" is pressed anyway
    Then no request is made
```

**Notes:** an edit replaces the whole amended framed document (`DeFlow.taskspecdraft.v1`) and the
gate computes the RFC 6902 patch itself, so there is nothing a button could carry. Hiding the option
entirely was the alternative and is worse: the daemon offered four and an operator who read the
terminal block would go looking for the fourth.

---

## EPIC-22-S62 — Answering resolves the gate live, with no reload

**Verifies:** KAR-22.5 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: the gate clears itself the way everything else on this page does

  Scenario: the answer comes back over the stream
    Given the workspace of a run stopped on a gate, with the panel on screen
    When the "human.responded" frame the answer produced arrives on the run's feed
    Then the panel is gone
    And no reload happened and no second fetch of the run was made
    And the graph and the board are still the same two views of one projection
```

**Notes:** the panel is cleared by the **event**, never by the response to the POST. That is what
makes EPIC-22-S63 work at all: the answering tab and the watching tab are cleared by the same frame,
so there is one code path and no "did my own request succeed" special case.

---

## EPIC-22-S63 — Two tabs watching one run both see the answer

**Verifies:** KAR-22.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the gate is in the ledger, not in a tab

  Scenario: two feeds, one answer
    Given a real daemon over a file-backed ledger with a run stopped on a gate
    And two run feeds open on that run, as two tabs would open them
    When the gate is answered once over the API
    Then both feeds receive the "human.responded" event
    And the gates projection each fold reports no open gate
```

**Notes:** two feeds rather than two mounted shells, because the claim is about **the wire**: a
second tab is a second subscription, and what has to be true is that the daemon fans the answer out
to both. A browser spec with a shared pushable feed would assert the fan-out it had itself
performed.

---

## EPIC-22-S64 — A gate answered twice records one decision

**Verifies:** KAR-22.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the second answer never wins

  Scenario: the same gate, answered twice
    Given a real daemon and a run stopped on a "human" node's gate
    When the gate is answered with one option
    And it is answered again with a different one
    Then the second response is 409 with the code "already_answered"
    And it carries the first decision
    And the ledger holds exactly one "human.responded" for that node
```

---

## EPIC-22-S65 — The conflict is rendered in the daemon's words, and the stale buttons go

**Verifies:** KAR-22.5 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: "somebody beat you to it" is the daemon's sentence, not the page's

  Scenario: a 409 answering an already-answered gate
    Given the panel on screen for a gate the CLI answered a moment ago
    When an option is pressed and the daemon answers 409 "already_answered"
    Then the daemon's own message is rendered
    And no option remains pressable
    And no retry is issued
```

---

## EPIC-22-S66 — A run that is waiting on a person is findable without opening it

**Verifies:** KAR-22.5 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: you should not have to open a run to learn that it wants you

  Scenario: the project's history rows
    Given a project with two runs, one of which is stopped on a gate
    When the workspace is opened
    Then the history row for the waiting run says which gate it is waiting on
    And the row for the other run says nothing of the kind
```

**Notes:** the fact is `pendingGate`'s, arriving on `GET /api/projects/:id/runs`'s rows because
`runEntry` already carries it — the same field the global run list renders (EPIC-19-S82). No second
query and no second vocabulary.

---

## EPIC-22-S67 — A permission escalation uses the same surface as a spec approval

**Verifies:** KAR-22.5 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: one panel, every gate kind

  Scenario: a permission escalation
    Given a run whose safety layer escalated a permission decision, not a spec approval
    When the workspace is opened
    Then the same panel renders it, with that gate's own prompt and its own options
    When an option is pressed
    Then the request is "POST /api/runs/<runId>/nodes/<node>/respond" carrying that option id
```

**Notes:** the panel branches on nothing but the gate's node id, and it branches there only to choose
a route — `pendingGate.specApproval` carries that answer so the comparison is not written twice.

---

**Related:** [EPIC-22](../epics/EPIC-22-web-control-center.md) · [Board](../board.md) ·
[EPIC-16 flows](./EPIC-16-ui-foundation-flows.md) · [EPIC-17 flows](./EPIC-17-p0-views-flows.md) ·
[EPIC-19 flows](./EPIC-19-live-run-pipeline-flows.md)

[← Back to the delivery plan](../README.md)
