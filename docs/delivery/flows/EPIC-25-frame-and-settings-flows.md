# EPIC-25 flows — The frame tells the truth

> Behavioural specification for [EPIC-25](../epics/EPIC-25-frame-and-settings.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 18 August 2026

## A note on level, and on TDD

[README §3](../README.md#3-the-tdd-working-agreement) asks for a failing test before a line of
implementation. EPIC-24 was granted an explicit exception for visual work; **this epic inherits that
exception only for the parts that are visual, and does not extend it to behaviour.**

- **Layout, tokens, panel chrome** — no test-first requirement. A panel moving from one route to
  another is not a behaviour with a red test in front of it.
- **Everything else is test-first, without exception.** KAR-25.7 (answering a gate), KAR-25.8 (the
  worktree), KAR-25.9 (the double write) and every scope/redirect rule in KAR-25.1 are behaviour, and
  three of them are defects that already shipped once. A defect that shipped gets a test that would
  have caught it, written before the fix.
- **Test-still-passing is required, absolutely**, everywhere. An assertion may change where it names
  a route, a class or a selector; a behavioural assertion that changed is named in the story's notes
  with a reason.

## Actors

| Actor                | Description                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **The operator**     | The person who ran the product against a real repository on 2026-08-18 and filed ten defects                                     |
| **The blueprint**    | `docs/design/expected/EPIC-25/` — seven screenshots. A specification of structure and scope, not of pixels                        |
| **The token layer**  | `packages/web/src/styles/theme.css`. Still the only file in the application that may contain a colour                            |
| **The library**      | `packages/web/src/components/ui/`. Every fix in this epic lands here or in the token layer, never as a per-instance override      |
| **The daemon**       | Changed in this epic, unlike EPIC-24: provider enable/disable state, and two defect fixes                                         |
| **The ledger**       | The single source of whether a gate is open. Every one of KAR-25.7's three surfaces folds it; none holds a local flag             |

## Preconditions common to all flows

```gherkin
Background:
  Given packages/web's and packages/daemon's suites are green before the story begins
  And every assertion about a colour is made against a resolved CSS custom property, never a hex
  And both themes are exercised wherever a scenario names a colour
  And no scenario asserts against a screenshot
  And no surface in any scenario starts a probe of something the daemon already answers
```

## Flow index

| Scenario    | Title                                                                     | Verifies  | Type       |
| ----------- | ------------------------------------------------------------------------- | --------- | ---------- |
| EPIC-25-S01 | **Happy path: the rail offers only what this scope can do**               | KAR-25.1  | Happy path |
| EPIC-25-S02 | Projects and Settings survive every navigation                            | KAR-25.1  | Contract   |
| EPIC-25-S03 | The active row clears AA in both themes                                   | KAR-25.1  | A11y       |
| EPIC-25-S04 | The active row is legible without colour                                  | KAR-25.1  | A11y       |
| EPIC-25-S05 | "Workspace" appears nowhere a person can read it                          | KAR-25.1  | Guard      |
| EPIC-25-S06 | A bookmarked global run URL still resolves                                | KAR-25.1  | Edge case  |
| EPIC-25-S07 | A nav item that points at no route fails the build                        | KAR-25.1  | Guard      |
| EPIC-25-S08 | **Happy path: one settings page, whatever project is open**               | KAR-25.2  | Happy path |
| EPIC-25-S09 | Settings never reads a projectId                                          | KAR-25.2  | Contract   |
| EPIC-25-S10 | Execution defaults render only what the daemon has a home for             | KAR-25.2  | Contract   |
| EPIC-25-S11 | A changed default persists through the daemon's own config route          | KAR-25.2  | Happy path |
| EPIC-25-S12 | The brand mark goes home, by mouse and by keyboard                        | KAR-25.2  | A11y       |
| EPIC-25-S13 | Every breadcrumb segment but the last navigates                           | KAR-25.2  | Happy path |
| EPIC-25-S14 | **Happy path: a runtime is disabled and the composer stops offering it**  | KAR-25.3  | Happy path |
| EPIC-25-S15 | Rescan calls the daemon's single-flight probe, once                       | KAR-25.3  | Contract   |
| EPIC-25-S16 | A detected runtime cannot be removed, and says why                        | KAR-25.3  | Edge case  |
| EPIC-25-S17 | An added runtime is removed, after confirmation                           | KAR-25.3  | Happy path |
| EPIC-25-S18 | A malformed base URL is refused before it is submitted                    | KAR-25.3  | Edge case  |
| EPIC-25-S19 | The daemon's refusal to add a runtime is rendered verbatim                | KAR-25.3  | Contract   |
| EPIC-25-S20 | An install command is shown and nothing offers to run it                  | KAR-25.3  | Guard      |
| EPIC-25-S21 | The rail's runtimes and the settings panel cannot disagree                | KAR-25.3  | Contract   |
| EPIC-25-S22 | **Happy path: one service, one status, one action**                       | KAR-25.4  | Happy path |
| EPIC-25-S23 | Bound-but-CLI-missing reads as one coherent state                         | KAR-25.4  | Edge case  |
| EPIC-25-S24 | Not-installed and unbound offers no Disconnect and no "in use since"      | KAR-25.4  | Edge case  |
| EPIC-25-S25 | Every credential sentence is still the daemon's, verbatim                 | KAR-25.4  | Contract   |
| EPIC-25-S26 | There is still no token field anywhere on the page                        | KAR-25.4  | Guard      |
| EPIC-25-S27 | A service with no authorisation route offers no button and no link        | KAR-25.4  | Contract   |
| EPIC-25-S28 | With no project open, binding explains itself and offers nothing          | KAR-25.4  | Edge case  |
| EPIC-25-S29 | The old connectors URL redirects rather than 404s                         | KAR-25.4  | Edge case  |
| EPIC-25-S30 | **Happy path: a run is started from a page, and lands on the run**        | KAR-25.5  | Happy path |
| EPIC-25-S31 | All three intake shapes still submit what they always submitted           | KAR-25.5  | Contract   |
| EPIC-25-S32 | The picker reduces one response and nothing else                          | KAR-25.5  | Contract   |
| EPIC-25-S33 | Admission's refusal is still rendered verbatim                            | KAR-25.5  | Contract   |
| EPIC-25-S34 | Escape does nothing, because this is not a dialog                         | KAR-25.5  | Contract   |
| EPIC-25-S35 | Starting a run with no project routes to the chooser and says why         | KAR-25.5  | Edge case  |
| EPIC-25-S36 | The submit chord still submits                                            | KAR-25.5  | Contract   |
| EPIC-25-S37 | No component opens an overlay nothing renders                             | KAR-25.5  | Guard      |
| EPIC-25-S38 | **Happy path: a project is created from a modal**                         | KAR-25.6  | Happy path |
| EPIC-25-S39 | All three triggers open one modal                                         | KAR-25.6  | Contract   |
| EPIC-25-S40 | The daemon's refusal to create a project is rendered verbatim             | KAR-25.6  | Contract   |
| EPIC-25-S41 | Escape, outside-click and cancel all close it and return focus            | KAR-25.6  | A11y       |
| EPIC-25-S42 | **Happy path: a gate announced globally is answered globally**            | KAR-25.7  | Happy path |
| EPIC-25-S43 | The approvals control names every waiting run and node                    | KAR-25.7  | Happy path |
| EPIC-25-S44 | Nothing waiting means no control, not an empty panel                      | KAR-25.7  | Contract   |
| EPIC-25-S45 | A waiting run row lands on its gate, in view                              | KAR-25.7  | Happy path |
| EPIC-25-S46 | A waiting node is answerable from the inspector                           | KAR-25.7  | Happy path |
| EPIC-25-S47 | An option no surface can submit is shown unsubmittable, with its reason   | KAR-25.7  | Contract   |
| EPIC-25-S48 | An answer from one surface clears all three                               | KAR-25.7  | Contract   |
| EPIC-25-S49 | An answer from the terminal clears all three                              | KAR-25.7  | Contract   |
| EPIC-25-S50 | A gate cannot be answered twice                                           | KAR-25.7  | Edge case  |
| EPIC-25-S51 | **Happy path: a failed node provisions again and the run advances**       | KAR-25.8  | Happy path |
| EPIC-25-S52 | The second provision is recorded as reuse, not as a second creation       | KAR-25.8  | Contract   |
| EPIC-25-S53 | A worktree held by another node is still refused, by name                 | KAR-25.8  | Edge case  |
| EPIC-25-S54 | An orphan directory git does not know about is pruned and re-added        | KAR-25.8  | Edge case  |
| EPIC-25-S55 | Read nodes keep detached, unchecked, concurrent provisioning              | KAR-25.8  | Contract   |
| EPIC-25-S56 | **Happy path: a middleware that writes and calls next does not throw**    | KAR-25.9  | Happy path |
| EPIC-25-S57 | A middleware that only calls next still falls through                     | KAR-25.9  | Contract   |
| EPIC-25-S58 | A middleware that writes and does not call next is still already-sent     | KAR-25.9  | Contract   |
| EPIC-25-S59 | Listeners are removed on every settle path                                | KAR-25.9  | Contract   |
| EPIC-25-S60 | A navigation of every route logs no ERR_HTTP_HEADERS_SENT                 | KAR-25.9  | Happy path |

---

## KAR-25.1 — The nav says what scope it is in

### EPIC-25-S01 — Happy path: the rail offers only what this scope can do

```gherkin
Scenario: the rail's item set follows the scope, not the last thing that was open
  Given the application is open at /projects with no project selected
  Then the rail shows exactly the items "Projects" and "Settings"
  And it shows no "Workflows" item and no "Runs" item
  When the operator opens a project
  Then the rail shows "Projects", "Workflows", "Runs" and "Settings", in that order
  When the operator navigates back to /projects
  Then the rail shows exactly "Projects" and "Settings" again
  And no item appeared, disappeared or reordered other than the two project-scoped ones
```

### EPIC-25-S02 — Projects and Settings survive every navigation

```gherkin
Scenario Outline: the two global items are present at every route
  Given the application is open at "<route>"
  Then the rail contains a "Projects" item linking to /projects
  And the rail contains a "Settings" item linking to /settings

  Examples:
    | route                                 |
    | /                                     |
    | /projects                             |
    | /settings                             |
    | /projects/prj_1                       |
    | /projects/prj_1/runs                  |
    | /projects/prj_1/runs/run_1            |
    | /projects/prj_1/new-run               |
```

### EPIC-25-S03 — The active row clears AA in both themes

```gherkin
Scenario Outline: the active nav row is readable, computed rather than hoped for
  Given the application is rendered under "<theme>"
  And a nav row is the active one
  When the row's resolved background and the row's resolved ink are read from the browser
  Then their WCAG contrast ratio is at least 4.5
  And the fix that made it so lives in theme.css or in components/ui, not in AppRail's scoped block

  Examples:
    | theme |
    | light |
    | dark  |
```

### EPIC-25-S04 — The active row is legible without colour

```gherkin
Scenario: colour is never the only signal for which row is current
  Given a nav row is the active one
  Then it carries aria-current="page"
  And it is rendered at a heavier weight than the inactive rows
  And a reader that ignores colour entirely can still identify it
```

### EPIC-25-S05 — "Workspace" appears nowhere a person can read it

```gherkin
Scenario: the rename is complete, not partial
  When the guard scans every user-visible string in packages/web/src
  Then the word "Workspace" does not appear in a nav label, a heading, a breadcrumb or a page title
  And the route formerly named "project-workspace" is named "project-workflows"
  And a route rename that missed a reference fails type-checking rather than rendering a dead row
```

### EPIC-25-S06 — A bookmarked global run URL still resolves

```gherkin
Scenario: moving the run list under a project does not break a link somebody saved
  Given a run "run_1" exists and belongs to project "prj_1"
  When the operator opens /runs/run_1
  Then they land on /projects/prj_1/runs/run_1 with the run rendered
  When the operator opens /runs/run_nope for a run that does not exist
  Then the not-found view renders, and no redirect loop occurs
```

### EPIC-25-S07 — A nav item that points at no route fails the build

```gherkin
Scenario: KAR-24.4 AC2's rule, unchanged and still enforced
  Given a nav item is added whose "to" matches no route the router registers
  When the suite runs
  Then it fails, naming the item and the missing route
```

---

## KAR-25.2 — `/settings`, and the way home

### EPIC-25-S08 — Happy path: one settings page, whatever project is open

```gherkin
Scenario: settings is global
  Given the application is open with no project selected
  When the operator opens /settings
  Then the page renders a heading, a subtitle and three panels
  And the panels are "Providers & runtimes", "Issue tracker" and "Execution defaults", in that order
  When the operator selects a project and opens /settings again
  Then the same three panels render, with the same values
```

### EPIC-25-S09 — Settings never reads a projectId

```gherkin
Scenario: nothing on the page is stored per project
  When the settings view's source is read
  Then it declares no projectId prop and reads no projectId route param
  And every request it makes is to a route with no project segment
```

### EPIC-25-S10 — Execution defaults render only what the daemon has a home for

```gherkin
Scenario: no invented setting
  Given GET /api/config reports a set of fields
  When the "Execution defaults" panel renders
  Then every control on it corresponds to one of those fields
  And a field the daemon does not report is absent from the panel, not rendered disabled
```

### EPIC-25-S11 — A changed default persists through the daemon's own config route

```gherkin
Scenario: the page writes through the existing route
  Given the operator changes an execution default
  When the change is submitted
  Then it is sent to the config route the daemon already exposes
  And re-opening /settings after a reload shows the new value
  And a refusal from the daemon is rendered in the daemon's own words
```

### EPIC-25-S12 — The brand mark goes home, by mouse and by keyboard

```gherkin
Scenario: the way back exists and is reachable without a pointer
  Given the application is open at any route
  Then the rail's brand mark is a link to /
  And it has an accessible name
  When the operator reaches it by keyboard and activates it
  Then they land on /
```

### EPIC-25-S13 — Every breadcrumb segment but the last navigates

```gherkin
Scenario: the breadcrumb is a path, not a caption
  Given the operator is at /projects/prj_1/runs/run_1
  Then the breadcrumb shows the project and the current view
  And every segment except the last is a link to that level
  And the last segment is the current page and is not a link
  When the operator activates the project segment
  Then they land on that project
```

---

## KAR-25.3 — Providers & runtimes, managed

### EPIC-25-S14 — Happy path: a runtime is disabled and the composer stops offering it

```gherkin
Scenario: one fact, two readers
  Given a runtime "claude" is detected, healthy and enabled
  And the new-run page's model picker offers it
  When the operator disables it in Settings
  Then the change persists daemon-side
  And GET /api/providers/routes no longer offers it
  And the new-run page's picker no longer offers it, without the page being told separately
  And admission refuses a run that names it, in the same words it always used
```

### EPIC-25-S15 — Rescan calls the daemon's single-flight probe, once

```gherkin
Scenario: the button is a caller, not a second probe
  When the operator activates "Rescan"
  Then exactly one POST to /api/providers/doctor is made
  And the panel re-renders from that response
  When the operator activates "Rescan" again while the first is still in flight
  Then no second request is made
  And the browser performs no probe of its own at any point
```

### EPIC-25-S16 — A detected runtime cannot be removed, and says why

```gherkin
Scenario: DeFlow does not lie about what is on the machine
  Given a runtime was detected by probing this machine
  Then its row offers a disable control and no remove control
  And it carries one sentence explaining that a detected runtime can be disabled but not removed
```

### EPIC-25-S17 — An added runtime is removed, after confirmation

```gherkin
Scenario: removing something the operator added
  Given a runtime was added by the operator with a name and a base URL
  When the operator activates its remove control
  Then a confirmation is required before anything is sent
  And on confirmation the runtime is gone from the panel and from GET /api/providers
```

### EPIC-25-S18 — A malformed base URL is refused before it is submitted

```gherkin
Scenario: the shape check is local; the truth check is the daemon's
  Given the operator enters "not a url" as a base URL
  When they submit
  Then nothing is sent, and the field explains what is wrong
  And a well-formed URL that the daemon later rejects IS sent, because only the daemon knows that
```

### EPIC-25-S19 — The daemon's refusal to add a runtime is rendered verbatim

```gherkin
Scenario: one machine, one description of its state
  Given the daemon refuses to add a runtime, with a sentence
  When the refusal is rendered
  Then it is the daemon's sentence, unshortened, unrewritten and unfriendlified
```

### EPIC-25-S20 — An install command is shown and nothing offers to run it

```gherkin
Scenario: a command to copy, never a shell in a browser tab
  Given a runtime the daemon reports as not installed
  Then its row shows the install command and a copy control
  And the page contains no control that would execute an install
  And that absence is asserted over the whole page, not over the row
```

### EPIC-25-S21 — The rail's runtimes and the settings panel cannot disagree

```gherkin
Scenario: one response, two renderings
  Given the rail's RUNTIMES list and the settings panel are both rendered
  Then both were built from one GET /api/providers response
  And no second request was made for the second surface
```

---

## KAR-25.4 — Connectors stop contradicting themselves

### EPIC-25-S22 — Happy path: one service, one status, one action

```gherkin
Scenario Outline: the resolved status table, all five rows
  Given the daemon reports CLI state "<state>" and project binding "<bound>"
  When the service's row renders
  Then its status reads "<status>"
  And the only action offered is "<action>"

  Examples:
    | state         | bound | status              | action     |
    | connected     | yes   | connected           | Disconnect |
    | connected     | no    | available           | Connect    |
    | not-installed | yes   | bound · CLI missing | Disconnect |
    | not-installed | no    | not installed       | none       |
    | no-route      | any   | cannot be connected | none       |
```

### EPIC-25-S23 — Bound-but-CLI-missing reads as one coherent state

```gherkin
Scenario: the defect the owner filed
  Given this project is bound to Jira
  And acli is not on this machine's PATH
  When the Jira row renders
  Then it does not show the words "not-installed" and "connected" as two separate statuses
  And it states, in one line, that the project is bound and the CLI is missing
  And it names what to install to make it work
```

### EPIC-25-S24 — Not-installed and unbound offers no Disconnect and no "in use since"

```gherkin
Scenario: nothing to disconnect from
  Given a service whose CLI is not installed and to which this project is not bound
  Then its row offers no Disconnect control
  And it shows no "in use since" timestamp
```

### EPIC-25-S25 — Every credential sentence is still the daemon's, verbatim

```gherkin
Scenario: KAR-22.4's rule, unchanged by the move to Settings
  When the "authorised by", "held by", "stored in" and "DeFlow keeps" lines render
  Then each is the daemon's service descriptor's own sentence
  And this screen composes no prose of its own about credentials
```

### EPIC-25-S26 — There is still no token field anywhere on the page

```gherkin
Scenario: ADR-0003, asserted over the page and not the row
  When the settings page is rendered in every state this epic can produce
  Then it contains no input whose purpose is a credential
  And the assertion is made over the whole page, because the box would arrive somewhere nobody was looking
```

### EPIC-25-S27 — A service with no authorisation route offers no button and no link

```gherkin
Scenario: KAR-22.6's rule, unchanged
  Given Linear, which DeFlow cannot connect without holding a credential
  Then its row renders its paragraph
  And offers no button and no authorisation link
```

### EPIC-25-S28 — With no project open, binding explains itself and offers nothing

```gherkin
Scenario: a global page containing a per-project fact
  Given no project is open
  When the "Issue tracker" panel renders
  Then it explains that binding a service needs a project open
  And it offers no Connect or Disconnect control that would 422
  And it still renders each service's credential facts, which are not per project
```

### EPIC-25-S29 — The old connectors URL redirects rather than 404s

```gherkin
Scenario: a saved link keeps working
  When the operator opens /projects/prj_1/connectors
  Then they land on /settings with the issue-tracker panel in view
```

---

## KAR-25.5 — The new-run page

### EPIC-25-S30 — Happy path: a run is started from a page, and lands on the run

```gherkin
Scenario: the product's most important action is a place
  Given a project is open
  When the operator opens /projects/prj_1/new-run
  Then the prompt field is focused
  And the page renders a source picker, a model picker and a Run control showing its chord
  When the operator types a prompt, chooses a model and submits
  Then a run is created through POST /api/runs
  And the operator lands on that run's workflow view
```

### EPIC-25-S31 — All three intake shapes still submit what they always submitted

```gherkin
Scenario Outline: the composer's behaviour is a fixed point
  Given the operator selects the "<shape>" intake
  When they submit
  Then the request body is exactly what composer.test.ts already asserts for that shape
  And the page reads no file and resolves no path itself

  Examples:
    | shape |
    | text  |
    | file  |
    | issue |
```

### EPIC-25-S32 — The picker reduces one response and nothing else

```gherkin
Scenario: there is one reduction of this machine, not three
  When the model picker renders
  Then its options come from GET /api/providers/routes and nothing else
  And it is grouped by provider, each option naming its context size
  And the page performs no probe of its own
```

### EPIC-25-S33 — Admission's refusal is still rendered verbatim

```gherkin
Scenario: KAR-19.2's shipped string
  Given admission refuses the submitted run
  When the refusal renders
  Then it is the daemon's own sentence, unmodified
```

### EPIC-25-S34 — Escape does nothing, because this is not a dialog

```gherkin
Scenario: a page, not a modal
  Given the operator is on /projects/prj_1/new-run with a half-typed prompt
  When they press Escape
  Then nothing closes, nothing navigates, and the prompt is still there
  And the page has no dialog role, no aria-modal and no focus trap
```

### EPIC-25-S35 — Starting a run with no project routes to the chooser and says why

```gherkin
Scenario: the refusal moves from after the click to before it
  Given no project is open
  When the operator activates "Start a run"
  Then no run is submitted
  And they land on the project chooser
  And a line explains that a run needs a project
```

### EPIC-25-S36 — The submit chord still submits

```gherkin
Scenario: the chord survives the move
  Given a valid prompt in the prompt field
  When the operator presses Cmd+Enter or Ctrl+Enter
  Then the run is submitted, exactly as the Run control would have
```

### EPIC-25-S37 — No component opens an overlay nothing renders

```gherkin
Scenario: the removed overlay leaves nothing dangling
  When the guard scans for overlay opens
  Then no component calls openOverlay with COMPOSER_OVERLAY
  And the overlay id and its store entry no longer exist
```

---

## KAR-25.6 — A new project is a modal

### EPIC-25-S38 — Happy path: a project is created from a modal

```gherkin
Scenario: the grid is a grid again
  Given the operator is on /projects
  Then no project form is present in the document
  When they activate "New project"
  Then a modal opens containing the form, with the name field focused
  When they submit a name and a repository path
  Then the project is created through POST /api/projects
  And the modal closes and the project appears in the grid without a reload
```

### EPIC-25-S39 — All three triggers open one modal

```gherkin
Scenario Outline: three doors, one room
  When the operator activates "<trigger>"
  Then the same modal opens
  And exactly one form exists in the document

  Examples:
    | trigger                  |
    | the header button        |
    | the dashed grid tile     |
    | the empty state's action |
```

### EPIC-25-S40 — The daemon's refusal to create a project is rendered verbatim

```gherkin
Scenario: unchanged from KAR-22.1
  Given the daemon refuses the path, with a sentence
  When the refusal renders inside the modal
  Then it is the daemon's sentence, and the modal stays open with the input preserved
```

### EPIC-25-S41 — Escape, outside-click and cancel all close it and return focus

```gherkin
Scenario Outline: UiModal's own behaviour, not a second copy of it
  Given the modal is open, having been opened from the header button
  When the operator "<dismisses>"
  Then the modal closes
  And focus returns to the header button

  Examples:
    | dismisses            |
    | presses Escape       |
    | clicks outside it    |
    | activates Cancel     |
```

---

## KAR-25.7 — Answering a decision where it is announced

### EPIC-25-S42 — Happy path: a gate announced globally is answered globally

```gherkin
Scenario: the defect the owner filed, end to end
  Given a run has stopped at a gate offering options
  And the operator is on / with no run subscribed
  Then the frame announces that a decision is waiting
  When the operator acts on that announcement
  Then they reach the gate and answer it
  And they did so without typing a URL and without opening a terminal
  And the run advances
```

### EPIC-25-S43 — The approvals control names every waiting run and node

```gherkin
Scenario: an announcement that says what it is announcing
  Given two runs are waiting on gates
  When the operator opens the approvals control
  Then it lists two entries
  And each names its run and its node
  And each links to that run's gate
```

### EPIC-25-S44 — Nothing waiting means no control, not an empty panel

```gherkin
Scenario: this surface only reports facts
  Given nothing is waiting on an operator
  Then no approvals control is rendered
  And there is no panel saying that nothing is waiting
```

### EPIC-25-S45 — A waiting run row lands on its gate, in view

```gherkin
Scenario Outline: clicking the thing that told you
  Given a run is waiting on a gate
  When the operator activates its row in "<list>"
  Then they land on that run
  And the gate panel is in view without further scrolling or clicking

  Examples:
    | list                    |
    | the run list            |
    | the project run history |
```

### EPIC-25-S46 — A waiting node is answerable from the inspector

```gherkin
Scenario: the canvas stops being a dead end
  Given a node is waiting on a human decision
  When the operator selects that node on the canvas
  Then the inspector offers the gate's options
  And answering from there advances the run
```

### EPIC-25-S47 — An option no surface can submit is shown unsubmittable, with its reason

```gherkin
Scenario: KAR-22.5's rule, on a third surface
  Given the daemon offered four options, one of which needs a document no surface can supply
  When the options render on any of the three surfaces
  Then all four are shown
  And the one that cannot be submitted is rendered unsubmittable with the daemon's reason beside it
  And it is not hidden, because an operator who read the terminal would go looking for it
```

### EPIC-25-S48 — An answer from one surface clears all three

```gherkin
Scenario Outline: one ledger, three renderings
  Given a gate is open and all three surfaces are showing it
  When the operator answers from "<surface>"
  Then the human.responded frame arrives
  And all three surfaces stop offering the gate
  And none of them consulted a local flag to decide that

  Examples:
    | surface              |
    | the approvals list   |
    | the run's gate panel |
    | the node inspector   |
```

### EPIC-25-S49 — An answer from the terminal clears all three

```gherkin
Scenario: the CLI and the tab are peers
  Given a gate is open and the tab is showing it
  When the gate is answered by `deflow answer` in a terminal
  Then all three surfaces stop offering it, by the same human.responded frame
```

### EPIC-25-S50 — A gate cannot be answered twice

```gherkin
Scenario: the ledger decides, not the button
  Given a gate has been answered
  When the operator attempts to answer it again from any surface
  Then no control to do so exists
  And a request replayed by hand is refused by the daemon, unchanged
```

---

## KAR-25.8 — A worktree that already exists

### EPIC-25-S51 — Happy path: a failed node provisions again and the run advances

```gherkin
Scenario: the exact failure from the owner's terminal
  Given a run provisioned a worktree for node "recon" and then failed
  And the worktree directory still exists
  When the drive ticker carries the run on
  Then provisioning succeeds
  And the run advances past recon rather than throwing WorktreeCreateFailed
  And the log does not repeat the same failure on the next tick
```

### EPIC-25-S52 — The second provision is recorded as reuse, not as a second creation

```gherkin
Scenario: the ledger does not claim two worktrees where there is one
  Given a worktree for run R node N already exists and is registered to R and N
  When provisioning is requested again for R and N
  Then a workspace.worktree_reused event is appended
  And no second workspace.worktree_created event is appended
  And the returned path, branch and lock reason are identical to the first
```

### EPIC-25-S53 — A worktree held by another node is still refused, by name

```gherkin
Scenario: idempotence is about this node, not about any node
  Given the path is registered to a different run or a different node
  When provisioning is requested
  Then it is refused
  And the message names the holder, as it does today
  And the refusal is exercised against a fixture, not only reasoned about
```

### EPIC-25-S54 — An orphan directory git does not know about is pruned and re-added

```gherkin
Scenario: a crash between mkdir and the ledger append
  Given the path exists on disk
  And git worktree list does not report it
  When provisioning is requested
  Then the stale entry is pruned, the directory removed, and the worktree added
  And the run continues
```

### EPIC-25-S55 — Read nodes keep detached, unchecked, concurrent provisioning

```gherkin
Scenario: §4.1's rule, unchanged
  Given two read nodes provision against the same commit
  Then both succeed
  And neither performs a branch-occupancy check
  And both are detached with no branch claimed
```

---

## KAR-25.9 — The response that was written twice

### EPIC-25-S56 — Happy path: a middleware that writes and calls next does not throw

```gherkin
Scenario: the defect, reproduced without Vite
  Given a connect middleware that writes a complete response and then calls next()
  When a request goes through the adapter
  Then the adapter reports the response as already sent
  And Hono does not build a second response
  And no ERR_HTTP_HEADERS_SENT is thrown
```

### EPIC-25-S57 — A middleware that only calls next still falls through

```gherkin
Scenario: the ordinary path is unchanged
  Given a connect middleware that calls next() without writing
  When a request goes through the adapter
  Then Hono's next handler runs and builds the response
```

### EPIC-25-S58 — A middleware that writes and does not call next is still already-sent

```gherkin
Scenario: the streaming path is unchanged
  Given a connect middleware that writes a response and never calls next()
  When a request goes through the adapter
  Then the adapter reports the response as already sent, as it does today
```

### EPIC-25-S59 — Listeners are removed on every settle path

```gherkin
Scenario Outline: no listener leak on a long-lived server
  Given the outgoing response's listener count is recorded before the request
  When the adapter settles via "<path>"
  Then the listener count returns to what it was

  Examples:
    | path                    |
    | next() with no write     |
    | next() after a write     |
    | finish without next()    |
    | close without next()     |
    | next(error)              |
```

### EPIC-25-S60 — A navigation of every route logs no ERR_HTTP_HEADERS_SENT

```gherkin
Scenario: the log is quiet enough that a real error is visible
  Given the dev daemon is running with Vite in middleware mode
  When every route in the application is navigated to in one session
  Then the daemon's log contains no ERR_HTTP_HEADERS_SENT
```
