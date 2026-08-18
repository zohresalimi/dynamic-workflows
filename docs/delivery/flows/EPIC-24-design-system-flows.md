# EPIC-24 flows — The design system: a component library from the prototype, and the UI rebuilt on it

> Behavioural specification for [EPIC-24](../epics/EPIC-24-design-system.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 17 August 2026

## A note on level, and on TDD

[README §3](../README.md#3-the-tdd-working-agreement) asks for a failing test before a line of
implementation. **This epic is granted an explicit exception, recorded here rather than taken
quietly**, at the owner's decision on 2026-08-17: _"you can skip TDD for this part; focus on speed
and high accuracy of design specification."_

What that exception is, precisely:

- **Test-first is not required for visual work.** A scoped style block replaced by a token is not a
  behaviour with a red test in front of it, and writing one would be theatre.
- **Test-still-passing is required, absolutely.** Every existing `packages/web` spec must pass, and
  the rule from the epic's Risks holds: an assertion may change only where it names a class or a
  colour, and a behavioural assertion that changed is named in the story's notes with a reason.
- **Four things do keep real tests, written as part of the story**, because they are the properties
  that make the epic's promise checkable at all rather than aesthetic claims: the contrast
  computation (S03), the vocabulary guard (S08), the colour-literal guard (S09) and the bundle
  budget (S12).

So the scenarios below are read as a **design specification** first — the accuracy of what is on the
screen is the deliverable — and as a coverage list second.

## Actors

| Actor                     | Description                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The operator**          | The person watching a run in a browser window they did not resize for us                                                                             |
| **The prototype**         | `docs/design/prototypes/direction-a-workflow-studio.html` — the canonical design, 1,137 lines of stated literals. B contributes the light surfaces; C contributes row density |
| **The token layer**       | `packages/web/src/styles/theme.css`. After KAR-24.1 it is the only file in the application that may contain a colour                                  |
| **The library**           | `packages/web/src/components/ui/`. Vendored source, typed props, no colour literals, no view-named variants                                           |
| **The gallery**           | `/gallery` — dev-only, every component in every variant in both themes                                                                                |
| **The state palette**     | `src/lib/state-palette.ts` and its spec. **A fixed point in this epic**: seven names, seven labels, one `NodeStatus` map, all unchanged. Only values move |
| **The guards**            | `check-ui-vocabulary.ts` and the colour-literal guard, run from the root `lint` script beside `check-graph-facade.ts` and `check-terminal-facade.ts`   |
| **The daemon**            | Unchanged, and untouched. No route, field or event in this epic                                                                                       |

## Preconditions common to all flows

```gherkin
Background:
  Given packages/web's suite is green before the story begins
  And every assertion about a colour is made against a resolved CSS custom property, never a hex
  And no scenario changes a store, a projection, a route's data, a request or a keyboard binding
  And both themes are exercised wherever a scenario names a colour, because a token that was only
      defined under .dark is a bug this epic exists to prevent
  And no scenario asserts against a screenshot
```

## Flow index

| Scenario    | Title                                                                                    | Verifies | Type       |
| ----------- | ---------------------------------------------------------------------------------------- | -------- | ---------- |
| EPIC-24-S01 | **Happy path: the whole design language resolves from one file**                         | KAR-24.1 | Happy path |
| EPIC-24-S02 | The seven state names survive the value swap                                             | KAR-24.1 | Contract   |
| EPIC-24-S03 | Every ink and every state passes WCAG AA on both themes                                  | KAR-24.1 | Contract   |
| EPIC-24-S04 | The chrome renders with no network request to a font CDN                                 | KAR-24.1 | Edge case  |
| EPIC-24-S05 | **Happy path: a screen is built by composition and declares no CSS**                     | KAR-24.2 | Happy path |
| EPIC-24-S06 | Every variant of every component resolves to the token it claims                         | KAR-24.2 | Contract   |
| EPIC-24-S07 | The overlay primitives keep what Reka UI gives them                                      | KAR-24.2 | A11y       |
| EPIC-24-S08 | A view-named variant fails the lint run                                                  | KAR-24.2 | Guard      |
| EPIC-24-S09 | A colour literal outside the token layer fails the lint run                              | KAR-24.2 | Guard      |
| EPIC-24-S10 | The state chip still carries colour, glyph and label                                     | KAR-24.2 | A11y       |
| EPIC-24-S11 | **Happy path: one route shows the entire library in both themes**                        | KAR-24.3 | Happy path |
| EPIC-24-S12 | The gallery is absent from the production bundle                                         | KAR-24.3 | Contract   |
| EPIC-24-S13 | A component whose props changed breaks the gallery spec, not a screen                    | KAR-24.3 | Edge case  |
| EPIC-24-S14 | **Happy path: the frame says where I am and what is running**                            | KAR-24.4 | Happy path |
| EPIC-24-S15 | The nav offers only routes that exist                                                    | KAR-24.4 | Edge case  |
| EPIC-24-S16 | Nothing the old shell did is lost                                                        | KAR-24.4 | Regression |
| EPIC-24-S17 | The skip-link, the keyboard map and the token gate are unchanged                         | KAR-24.4 | A11y       |
| EPIC-24-S18 | The rail yields on a laptop screen                                                       | KAR-24.4 | Edge case  |
| EPIC-24-S19 | **Happy path: a node says what ran it, how far it got and how long it took**             | KAR-24.5 | Happy path |
| EPIC-24-S20 | The card adds no field the view model did not have                                       | KAR-24.5 | Contract   |
| EPIC-24-S21 | Layout is computed against the card's real box                                           | KAR-24.5 | Edge case  |
| EPIC-24-S22 | Motion stops under prefers-reduced-motion, and the graph still reads                     | KAR-24.5 | A11y       |
| EPIC-24-S23 | **Happy path: the inspector answers "what happened here" in one column**                 | KAR-24.6 | Happy path |
| EPIC-24-S24 | The streaming block stays bounded over a long run                                        | KAR-24.6 | Regression |
| EPIC-24-S25 | The overlay's escape stack and focus return survive the restyle                          | KAR-24.6 | A11y       |
| EPIC-24-S26 | **Happy path: the project grid is scannable and the run table is dense**                 | KAR-24.7 | Happy path |
| EPIC-24-S27 | A project whose path has gone is still on the screen                                     | KAR-24.7 | Edge case  |
| EPIC-24-S28 | A live run's row is distinguishable from a finished one without reading it               | KAR-24.7 | Happy path |
| EPIC-24-S29 | Every empty list says something                                                          | KAR-24.7 | Edge case  |
| EPIC-24-S30 | **Happy path: starting a run looks like the rest of the product**                        | KAR-24.8 | Happy path |
| EPIC-24-S31 | Connector rows name the state the button moves them to                                   | KAR-24.8 | Happy path |
| EPIC-24-S32 | Provider status is the daemon's answer, and no credential reaches the DOM                | KAR-24.8 | Security   |
| EPIC-24-S33 | A daemon refusal reaches the screen in the daemon's own words                            | KAR-24.8 | Edge case  |
| EPIC-24-S34 | **The initial chunk is under whatever ceiling NF3 now declares**                          | KAR-24.9 | Contract   |

---

## KAR-24.1 — The token layer

### EPIC-24-S01 — Happy path: the whole design language resolves from one file

```gherkin
Scenario: seven surfaces, five inks, five edges, one ramp each for type and radius
  Given theme.css after this story
  When the declarations under ":root" and under ".dark" are read out of the file
  Then each block declares the same set of custom property names
  And that set contains the seven surface tokens, five ink tokens and five edge tokens the epic names
  And it contains --font-sans, --font-mono, the --text-* ramp and the --radius-* ramp
  And no two token names in it resolve to the same value with different names
```

**Level:** unit, over the stylesheet's own text — the same technique
`src/lib/state-palette.test.ts` already uses, and for the same reason: this is a claim about a
definition, not about what one element computed to.

### EPIC-24-S02 — The seven state names survive the value swap

```gherkin
Scenario: the palette's contract is a fixed point
  Given src/lib/state-palette.ts is not modified by this story
  When state-palette.test.ts runs against the new theme.css
  Then all seven display states are declared under both :root and .dark
  And the NodeStatus map is still total over @DeFlow/core's eight statuses
  And the two themes still resolve the seven to different colours
```

**Level:** unit + browser, unmodified existing specs.

### EPIC-24-S03 — Every ink and every state passes WCAG AA on both themes

```gherkin
Scenario: contrast is computed from the file, not hoped for
  Given the ink tokens, the state tokens and the surface tokens in both themes
  When the contrast ratio of every ink-on-surface and state-on-surface pair is computed
  Then every ink-on-surface pair is at least 4.5:1
  And every state-on-surface pair is at least 3:1
  And where a prototype literal did not pass, the token carries the adjusted value
  And a comment beside it names the original literal and the ratio it scored
```

**Level:** unit. **Written as a real test**, per the note at the top of this file: it is what turns
"we checked contrast" into a thing that stays true after the next edit.

### EPIC-24-S04 — The chrome renders with no network request to a font CDN

```gherkin
Scenario: the fonts are ours
  Given the built application
  When the stylesheet and the built assets are searched
  Then no reference to fonts.googleapis.com or fonts.gstatic.com is present
  And Instrument Sans and JetBrains Mono are served as woff2 from the application's own assets
  And each @font-face declares a system stack fallback and font-display: swap
```

**Level:** integration, over the build output. AR-1: a locally-installed daemon UI does not phone a
third party to draw its own chrome, and it must work with no network at all.

---

## KAR-24.2 — The primitives

### EPIC-24-S05 — Happy path: a screen is built by composition and declares no CSS

```gherkin
Scenario: the library is sufficient for a real screen
  Given the fifteen components the story names
  When the gallery's composite patterns are assembled from them — a node card, a dense table row,
       a phase row, an inspector stat grid
  Then each is expressed as composition and slots
  And none of them adds a component to the library
  And none of them declares a colour
```

### EPIC-24-S06 — Every variant of every component resolves to the token it claims

```gherkin
Scenario Outline: a variant is a promise about a token
  Given <component> mounted with variant "<variant>"
  When its computed <property> is read
  Then it equals the resolved value of "<token>"

  Examples:
    | component      | variant   | property         | token             |
    | UiButton       | primary   | background-color | --state-running   |
    | UiButton       | danger    | color            | --state-failed    |
    | UiButton       | ghost     | background-color | transparent       |
    | UiCard         | inset     | background-color | --surface-inset   |
    | UiCard         | raised    | background-color | --surface-raised  |
    | UiChip         | ok        | color            | --state-passed    |
    | UiChip         | warn      | color            | --state-blocked   |
    | UiChip         | error     | color            | --state-failed    |
```

**Level:** browser component specs. This is what makes a token renamed in KAR-24.1 fail here rather
than six screens later.

### EPIC-24-S07 — The overlay primitives keep what Reka UI gives them

```gherkin
Scenario: UiModal is not hand-rolled
  Given UiModal open over a page with focusable elements behind it
  When Tab is pressed past the last control inside it
  Then focus returns to the first control inside it and never reaches the page behind
  And Escape closes it
  And a click outside it closes it
  And it carries aria-modal and is labelled by its title
  And on close, focus returns to the element that opened it
```

### EPIC-24-S08 — A view-named variant fails the lint run

```gherkin
Scenario: the vocabulary cannot grow a screen's name
  Given a fixture component under src/components/ui/ declaring variant: 'project' | 'gate'
  When check-ui-vocabulary.ts runs
  Then it exits non-zero
  And it names the file, the union and the tokens that are not in the allowed vocabulary
```

**Level:** unit, against a fixture source. **Written as a real test** — a guard asserted only by its
own existence is a guard that was never run.

### EPIC-24-S09 — A colour literal outside the token layer fails the lint run

```gherkin
Scenario: colours live in one file
  Given a fixture .vue file under src/views/ containing "#C9F154"
  When the colour-literal guard runs
  Then it exits non-zero and names the file and the literal
  And the same literal inside src/styles/theme.css does not fail it
  And a literal inside docs/design/prototypes/ does not fail it
```

### EPIC-24-S10 — The state chip still carries colour, glyph and label

```gherkin
Scenario Outline: never colour alone
  Given UiStateChip with state "<state>"
  Then it renders the glyph for that state
  And it renders the text label STATE_LABELS gives it
  And its colour is the resolved value of stateVar("<state>")
  And the label is readable by a screen reader, not aria-hidden

  Examples: pending, running, blocked, passed, failed, abandoned, awaiting-human
```

WCAG 1.4.1, and §9.2's own words.

---

## KAR-24.3 — The gallery

### EPIC-24-S11 — Happy path: one route shows the entire library in both themes

```gherkin
Scenario: the library has a face
  Given the dev server
  When /gallery is opened
  Then every component from KAR-24.2 appears in every variant it declares
  And UiStateChip appears in all seven display states
  And every surface, ink, edge and radius token appears as a labelled swatch with its computed value
  And the page's theme toggle switches between the two themes without a reload
```

### EPIC-24-S12 — The gallery is absent from the production bundle

```gherkin
Scenario: NF3 is not spent on a dev tool
  Given a production build
  When the bundle is inspected
  Then no chunk contains the gallery component
  And packages/web/test/integration/bundle-budget.test.ts passes unchanged
```

**Level:** integration. **Written as a real test.**

### EPIC-24-S13 — A component whose props changed breaks the gallery spec, not a screen

```gherkin
Scenario: the gallery is the canary
  Given a component whose required prop is renamed
  When the gallery spec mounts the page
  Then it fails
  And the failure names the component
```

---

## KAR-24.4 — The app frame

### EPIC-24-S14 — Happy path: the frame says where I am and what is running

```gherkin
Scenario: rail, breadcrumb, run pill
  Given a session with a project and one running run
  When the application is opened
  Then the rail shows the brand, the project switcher with that project active, the nav, the
       runtime list and the identity footer
  And the topbar shows "<project> / <view>" as a breadcrumb
  And the run status pill shows the run's status label and its elapsed time
  And the pill's dot animates while the run is running and stops when it concludes
```

### EPIC-24-S15 — The nav offers only routes that exist

```gherkin
Scenario: no dead ends
  Given the rail's nav
  Then every item resolves to a route in the router's table
  And no item labelled "Builder" is rendered
  And selecting a project in the switcher navigates to that project's workspace
  And the switcher issues no request the application did not already make
```

### EPIC-24-S16 — Nothing the old shell did is lost

```gherkin
Scenario: a restyle is not a deletion
  Given the shell before this story
  When the new frame is in place
  Then the theme toggle, the approvals badge with its aria-label, the search field,
       RunProviderBanner, RunTaskBanner and the composer button are all present and all work
  And the gate band still sits between the bar and the view, and still takes its own height
  And the approvals count still comes from one request made by the shell
```

### EPIC-24-S17 — The skip-link, the keyboard map and the token gate are unchanged

```gherkin
Scenario: the a11y contract of the shell
  Given a fresh tab
  Then the skip-link is the first element in the tab order and moves focus to the main region
  And the keyboard map is installed on document and disposed with the app
  And a tab with no token renders TokenRequired and mounts no view that issues a request
  And shell-boot.test.ts and keyboard.test.ts pass unmodified
```

### EPIC-24-S18 — The rail yields on a laptop screen

```gherkin
Scenario Outline: the frame does not eat the window
  Given a viewport <width> wide
  Then the rail is <rail>

  Examples:
    | width  | rail                                   |
    | 1440px | full, 246px                            |
    | 1000px | collapsed to icons                     |
    | 760px  | hidden, with the nav moved to the topbar |
```

---

## KAR-24.5 — The plan graph

### EPIC-24-S19 — Happy path: a node says what ran it, how far it got and how long it took

```gherkin
Scenario: the card
  Given a plan with a done node, a running node and a pending node
  Then each renders as a card with its kind icon, its title, its status, the provider and model it
       was scheduled onto, its meta line and its elapsed time
  And the running node carries a progress meter and the pulse ring
  And the edge into the running node is the animated dashed accent
  And a pending node's edge is the inert dashed edge
```

### EPIC-24-S20 — The card adds no field the view model did not have

```gherkin
Scenario: a restyle, not a feature
  Given components/graph/node-body.ts before this story
  Then it exposes the same fields after it
  And no new request is made to render a node
  And a node whose provider is not yet known renders without that line rather than with a placeholder
```

### EPIC-24-S21 — Layout is computed against the card's real box

```gherkin
Scenario: ELK is told the truth
  Given node-size.ts carrying the card's dimensions
  When the graph is laid out
  Then no two nodes overlap
  And layout.test.ts and union-layout.test.ts pass with only the dimension constants changed
  And the 400-node measurement is re-run and its number recorded on the story
```

### EPIC-24-S22 — Motion stops under prefers-reduced-motion, and the graph still reads

```gherkin
Scenario: NF8
  Given prefers-reduced-motion: reduce
  Then dashrun, pulsering, caret and shimmer are all inert
  And a running node is still distinguishable from a pending one by colour, glyph and label
  And reduced-motion.test.ts passes unmodified
```

---

## KAR-24.6 — The inspector

### EPIC-24-S23 — Happy path: the inspector answers "what happened here" in one column

```gherkin
Scenario: header, tabs, body
  Given a selected node with output, a config and logs
  Then the header shows its icon, title, "<nodeId> · <kind>" and its status pill
  And the output tab shows a 2x2 stat grid, the streaming block and the tool-call list
  And while the stream is live the caret blinks at its end
  And the config tab shows runtime and model rows and the system prompt in a code block
  And the logs tab shows a three-column mono list of time, level and message
```

### EPIC-24-S24 — The streaming block stays bounded over a long run

```gherkin
Scenario: a restyle does not become a memory leak
  Given the memory-stress fixture
  When a multi-hour run's output is streamed into the restyled block
  Then the retained text is bounded exactly as KAR-16.3 made it
  And the memory-stress spec passes unmodified
```

### EPIC-24-S25 — The overlay's escape stack and focus return survive the restyle

```gherkin
Scenario: one stack for Esc
  Given the inspector open over the graph, and the jumper opened on top of it
  When Escape is pressed twice
  Then the jumper closes, then the inspector closes
  And focus returns to the node that opened the inspector
```

---

## KAR-24.7 — Projects, run history and the workspace boards

### EPIC-24-S26 — Happy path: the project grid is scannable and the run table is dense

```gherkin
Scenario: two shapes, one vocabulary
  Given three projects and twenty runs
  Then each project is a card with initials tile, name, last-activity line, tracker badge,
       description, its recent flows and a stats footer
  And the run list is one table whose columns are run, trigger, workflow, progress, tokens and time
  And the workspace's task board and history reuse those same two shapes rather than a third
```

### EPIC-24-S27 — A project whose path has gone is still on the screen

```gherkin
Scenario: KAR-22.1 AC5 is a behaviour, not a style
  Given a project whose path no longer exists
  Then its card is rendered
  And the daemon's health message is rendered beside it
  And projects.test.ts passes unmodified
```

### EPIC-24-S28 — A live run's row is distinguishable from a finished one without reading it

```gherkin
Scenario: the dot
  Given one running run and one passed run in the list
  Then the running row's dot animates and carries --state-running
  And the passed row's dot is static and carries --state-passed
  And under reduced motion the two are still distinguishable by colour and by their status label
```

### EPIC-24-S29 — Every empty list says something

```gherkin
Scenario: no bare "No runs"
  Given a project with no runs, and an account with no projects
  Then each empty surface renders a UiEmptyState with a sentence and an action
  And the action is one this application can actually perform
```

---

## KAR-24.8 — Settings, connectors and the composer

### EPIC-24-S30 — Happy path: starting a run looks like the rest of the product

```gherkin
Scenario: the composer as a modal
  Given the composer opened with "c" and with the topbar button
  Then both open the same UiModal
  And it has a titled header, labelled sections and a footer with a ghost cancel and a primary action
  And its three intake shapes and its adapter picker behave exactly as before
  And composer.test.ts passes with only selector changes
```

### EPIC-24-S31 — Connector rows name the state the button moves them to

```gherkin
Scenario: the action says what it will do
  Given a connected connector and a disconnected one
  Then the connected row's action reads as disconnecting it
  And the disconnected row's action reads as connecting it
  And neither label is a bare "Toggle"
```

### EPIC-24-S32 — Provider status is the daemon's answer, and no credential reaches the DOM

```gherkin
Scenario: AR-1
  Given the providers-and-runtimes table
  Then every row's status is a value the daemon returned
  And no status is computed in the browser from the presence of a key
  And no API key, token or secret appears in the DOM, in a title attribute or in the console
```

### EPIC-24-S33 — A daemon refusal reaches the screen in the daemon's own words

```gherkin
Scenario: the restyle does not rewrite the message
  Given a daemon that refuses a project creation with a specific sentence
  When the create form submits
  Then that sentence is what appears on the screen
  And KAR-22.1's refusalOf is still the only path it travelled
```

---

## KAR-24.9 — The frame's weight

### EPIC-24-S34 — The initial chunk is under whatever ceiling NF3 now declares

```gherkin
Scenario: the budget is a number somebody chose
  Given a production build
  When the initial payload is measured the way bundle-budget.test.ts measures it
  Then it is at or under the ceiling that spec declares
  And that ceiling and docs/12 section 10 say the same thing
  And bundle-budget.test.ts's claim about what belongs in the first chunk matches the route table
      it is describing — no assertion survives whose stated reason is a route that has moved
```

**Level:** integration, the existing spec. Written as a real test because it is one already; what
this scenario adds is that its *premise* has to be true as well as its number.
