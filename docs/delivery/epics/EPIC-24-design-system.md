# EPIC-24: The design system — a component library from the prototype, and the UI rebuilt on it

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-24-design-system-flows.md)

|                      |                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-24                                                                                                                                                                                                                                                     |
| **Status**           | Done                                                                                                                                                                                                                                                        |
| **Priority**         | P0                                                                                                                                                                                                                                                          |
| **Milestone**        | M1                                                                                                                                                                                                                                                          |
| **Workstream**       | W17 — added 2026-08-17, when the owner supplied three HTML design prototypes and asked for them to be "converted into a reusable component library" and used to "design and implement the user interface of this project"                                    |
| **Size**             | ~21 days across 9 stories — **over the 15-day guideline, see Risks**                                                                                                                                                                                        |
| **Depends on**       | EPIC-16 (the app shell, the theme file, the state palette this replaces the values inside), EPIC-17 (the nine views this restyles), EPIC-22 (projects, the composer, the workspace, connectors — the screens the prototype draws), EPIC-19 (a run to render)  |
| **Blocks**           | Nothing mechanical. It blocks the product *looking like one product*, which is the only thing it is for                                                                                                                                                     |
| **PRD requirements** | F10.1, F10.3, F10.6, F10.9, NF3, NF8, NF10, AR-1                                                                                                                                                                                                            |
| **Architecture**     | [12-frontend-architecture.md §8, §8.1, §9, §9.1–§9.5, §10](../../12-frontend-architecture.md), [16-repo-layout.md §7](../../16-repo-layout.md)                                                                                                               |
| **Design source**    | [`docs/design/prototypes/`](../../design/prototypes/) — three `.dc.html` files, supplied 2026-08-17. Direction A is canonical; see "Which prototype won, and why"                                                                                            |

## Goal

At the end of this epic **every pixel in the web application comes from one vocabulary**, and that
vocabulary is a small set of vendored Vue components sitting on one token file — not thirty
`<style scoped>` blocks that each invented a border colour.

Concretely: `packages/web/src/components/ui/` exists, holds roughly fifteen components with typed
variant props, and is rendered in every state on a `/gallery` route that a person can open. The nine
P0 views, the app shell, the projects screen, the run history, the connectors screen and the composer
are all built out of those components. The stylesheet defines the design language once — surfaces,
ink, edges, radii, the type scale, motion — and the seven `--state-*` tokens the rest of the app
already reads keep their names and their contract, with new values taken from the prototype's own
semantics.

**No behaviour changes.** Not one projection, store, route, API call or keyboard binding is touched.
This epic is a change of clothes, and the test that it went right is that every existing spec in
`packages/web` passes with its assertions unmodified except where an assertion names a class or a
literal colour.

## Why this matters

**Asked for by the owner on 2026-08-17**, with three finished prototypes attached and the words
"convert it into a reusable component library, and use it to design and implement the user interface
of this project."

But the reason it is P0 rather than polish is in the architecture doc, which called this shot a year
of stories ago and then never got the story that acted on it. [§8.1](../../12-frontend-architecture.md)
argues for vendored components on the grounds that a dense operator UI otherwise spends its life in
a "theme-override CSS specificity war" — and then §13 of the PRD scoped the project to "nine P0
views, not a design system", so the components were never vendored. What arrived instead is what
always arrives: **twenty-seven `<style scoped>` blocks and about 3,000 lines of CSS across 42 `.vue`
files**, each with its own answer to what a card border is worth, and no single file to change when
the answer moves.

That has two costs that are already being paid:

1. **Every new view is more expensive than the last**, because it starts from nothing and ends by
   adding a twenty-eighth opinion about padding.
2. **The product does not read as one product.** PRD §7.10 calls visualisation "a primary product
   surface with equal weight to execution", and the M1 metric that judges it is *median
   time-to-diagnose a failed run under five minutes*. An operator diagnosing a run reads state off
   colour and glyph at a glance, across four surfaces in ten seconds. Four surfaces that render the
   same state four ways is not an aesthetic problem; it is a latency problem in the operator's head.

The prototypes close this because they are not mood boards. Direction A is a **complete, data-bound
specification of five screens** — 1,137 lines with every surface, border, radius, font size and
motion curve stated as a literal. It is, functionally, a design system that has already been written
down; this epic's job is to move it from HTML attributes into named tokens and typed components
before the fourth screen makes a fourth choice.

## Which prototype won, and why

Three directions were supplied. All three are kept in `docs/design/prototypes/` — a rejected
direction is evidence, not waste.

| Direction                                                                       | Language                                                                                        | Verdict                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — "AI Workflow Studio"** ([source](../../design/prototypes/direction-a-workflow-studio.html)) | Near-black surfaces, one lime accent (`#C9F154`), Instrument Sans for prose, JetBrains Mono for every number and identifier | **Canonical.** The only one that draws all five screens, the inspector, the swarm dock and the modal — and the only one whose state colours map cleanly onto the seven this app already has |
| **B — "Studio light"** ([source](../../design/prototypes/direction-b-studio-light.html))         | Warm paper (`#F4F2EE`), Instrument Serif headings, deep-green accent                            | **Contributes the light theme's surfaces.** Direction A has no light mode and this application has had one since KAR-16.1, so B's paper stack is where the light values come from. Its serif headings and its green accent are not adopted |
| **C — "Control room"** ([source](../../design/prototypes/direction-c-control-room.html))         | IBM Plex Mono throughout, orange accent, hairline grid, everything a table row                  | **Rejected as a whole, adopted in one part.** All-mono at 10px is unreadable for prose and it fails NF8 at any zoom. Its *row density* — the 5px-vertical agent row with a fixed column grid — is the right answer for the swarm dock and the run table, and is taken |

The decision is recorded here rather than left implicit because the natural failure of this epic is
a fourth direction assembled by averaging the three, which would be a design nobody drew.

## The one rule this epic is designed around

**A component may not know what it is for.**

The failure mode is specific and it is what turns a component library back into thirty scoped style
blocks within a month: `<Card variant="project">`, `<Chip variant="gate">`, `<StatTile
variant="tokens">`. Each of those is a view's business leaking into the library, and the library
then grows one variant per screen and stops being reusable in the only sense that matters — that the
next screen costs less than the last.

So the variant vocabularies are fixed, small, and named after **appearance or semantics, never after
a caller**:

- `Button`: `primary | secondary | ghost | danger`, sizes `sm | md`
- `Chip`: `neutral | accent | ok | warn | error | info`, plus `state` which takes a `DisplayState`
  and reads `--state-*`
- `Card` / `Panel`: `raised | inset | flush`
- `Toggle`, `Field`, `Modal`, `IconTile`, `SectionLabel`, `StatTile`, `ProgressSplit`, `DataTable`,
  `ListRow`, `EmptyState`, `MetaRow`: no view-named variants at all

A story in this epic that needs a variant named after a screen is a story that has gone wrong, and
`packages/web/scripts/check-ui-vocabulary.ts` — added in KAR-24.2 — fails the lint run when one
appears, in the same spirit as the existing `check-graph-facade.ts` and `check-terminal-facade.ts`
guards.

## The token layer is the whole design, stated once

Direction A's design is currently expressed as ~250 distinct hex literals inline on elements. Read
carefully it is far smaller than that: **nine surfaces, nine inks, six edges, seven semantic hues,
six radii, one type scale and four animations.** KAR-24.1 is the story that says so in
`packages/web/src/styles/theme.css`, and everything after it is spending those tokens.

The mapping that makes this fit the application it is being applied to — rather than being a reskin
bolted beside it — is that **direction A's semantic hues already are the seven display states**:

| `--state-*` (existing name, unchanged) | Direction A's role                                       | Dark value        | Light value (direction B's surfaces) |
| -------------------------------------- | --------------------------------------------------------- | ----------------- | ------------------------------------ |
| `--state-pending`                      | the inert slate of an unreached node (`#4A5261`)          | lightened for text contrast | slate, darkened          |
| `--state-running`                      | the lime accent — the one colour that means *now*         | `#C9F154`         | same hue, darkened to pass on paper  |
| `--state-blocked`                      | the amber `WARN` (`#F2C14E`)                              | `#F2C14E`         | darkened                             |
| `--state-passed`                       | the green `OK` (`#4FD48A`)                                | `#4FD48A`         | darkened                             |
| `--state-failed`                       | the salmon `ERR` (`#FF8172`)                              | `#FF8172`         | darkened                             |
| `--state-abandoned`                    | the dim grey of a row that stopped mattering (`#6B707A`)  | `#6B707A`         | lightened                            |
| `--state-awaiting-human`               | the violet of the gate node and the tracker tint (`#8B7BFF`) | `#8B7BFF`      | darkened                             |

That the prototype's palette lands on the seven states with nothing left over and nothing missing is
the reason this epic is a token swap and not a rewrite. `src/lib/state-palette.ts` does not change:
the names, the labels, the glyphs, the `NodeStatus` mapping and
`packages/web/src/lib/state-palette.test.ts` are all untouched, and only the values behind the seven
custom properties move.

**Contrast is a constraint, not an aspiration.** Every ink-on-surface and state-on-surface pair in
both themes is checked to WCAG AA (4.5:1 for text, 3:1 for the graph's non-text state indicators) by
a test that computes the ratio from the stylesheet's own values — because two of direction A's
literals do not pass as written (`#4A5261` and `#4E535C` are decorative-only in the prototype and
would fail the moment a component used them for a label), and finding that in a browser six screens
later is the expensive way.

## Scope

**In scope:**

- **The tokens**: surfaces, ink, edges, radii, shadow, the type scale, the two font families, the
  four animations, and new values behind the seven existing `--state-*` names — for both themes.
- **The primitive layer**: `packages/web/src/components/ui/`, vendored source in this repo, typed
  props, no runtime theming, no `class-variance-authority` dependency added.
- **The gallery**: a dev-only `/gallery` route rendering every component in every variant and every
  state, in both themes, so the library is checkable by looking at one page instead of by touring
  nine.
- **Applying it**: the app shell, the plan graph and its node cards, the node inspector, the
  projects screen, run history, the project workspace boards, connectors, settings and the composer
  — every surface an operator sees.
- **Deleting what it replaces**: the `<style scoped>` block a component's markup no longer needs
  goes with the story that made it dead. A design system beside the CSS it was meant to replace is
  worse than either alone.

**Out of scope:**

- **Any behaviour change.** No store, projection, route, request, keyboard binding or SSE topic is
  modified. A story here that needs a new API field is the wrong story.
- **The builder screen.** Direction A draws a workflow builder (drag a node from a library, save and
  deploy). DeFlow's plans are produced by the planner (EPIC-11), not drawn by hand; there is no
  mechanism behind that screen and this epic does not invent one. Its *node-library and step-card
  visual treatment* is still harvested for the plan graph, which is what those pixels are worth.
- **The swarm dock as a data surface.** Direction A's fan-out dock, and the terminal screenshot
  supplied with it, show N parallel agents under one node. Whether the domain has fan-out nodes is
  EPIC-11's question, not this epic's. KAR-24.3's gallery renders the dock's *components* — the
  phase list, the dense agent row, the split progress bar — against fixtures, and no view mounts it
  against live data until a story with a mechanism behind it does.
- **`shadcn-vue`'s CLI.** [§8](../../12-frontend-architecture.md) named it as the way to vendor
  components. It is not used: it generates a generic light/dark shadcn look that would then have to
  be overridden into direction A's, which is precisely the specificity war §8.1 warns about. The
  *conclusion* of §8.1 — vendored source, in this repo, ours to edit — is followed exactly. `reka-ui`
  stays and keeps doing what §9.3 credits it for: focus trap, roving tabindex, escape and
  outside-click.
- **A published package.** The library is `packages/web/src/components/ui/`, not `@DeFlow/ui`. One
  consumer does not need a package boundary, and NF3's bundle budget is easier to hold without one.
- **Fonts over the network.** The prototypes load Instrument Sans and JetBrains Mono from Google
  Fonts. A locally-installed daemon UI does not make requests to a third party to render its own
  chrome (AR-1, and it simply does not work offline). Both families are self-hosted as woff2 subsets
  from the repo, with a system stack behind them.
- **Mobile layouts.** The operator surface is a desktop window. Nothing here breaks at narrow widths
  that is not already broken, and nothing here fixes it.

## Definition of Ready (epic level)

- [ ] The three prototypes are in `docs/design/prototypes/` and open in a browser.
- [ ] EPIC-22 is Done, so the screens direction A draws — projects, the composer, the workspace,
      connectors — exist to be restyled rather than to be built.
- [ ] `pnpm --filter @DeFlow/web test` is green before the first story, so "the specs still pass"
      means something at the end of it.

## Definition of Done (epic level)

- [ ] All eight stories are Done.
- [x] `packages/web/src/components/ui/` holds the library, and **no `.vue` file under `src/views/`
      or `src/components/` outside `ui/` declares a colour literal.** `checkStateColoursComeFromThePalette`
      asserts it, and predates this epic.
- [x] The `/gallery` route renders every component in every variant, in both themes, and is excluded
      from the production bundle.
- [x] `bundle-budget.test.ts` passes. This epic did break NF3 — 189.6 KB gzip at `f50f43d`,
      212.6 KB after KAR-24.8, against a 200 KB ceiling — and KAR-24.9 closed it by **raising the
      ceiling to 220 KB, on the owner's decision of 2026-08-18**, with the reason written into both
      the spec and [docs/12 §10](../../12-frontend-architecture.md). The 69 KB alternative is
      recorded there rather than taken.
- [ ] Both themes pass WCAG AA for every ink-on-surface and state-on-surface pair, asserted from the
      stylesheet's values rather than from a screenshot.
- [ ] Every existing `packages/web` spec passes, and every one whose assertions had to change is
      named in that story's notes with the reason. A spec deleted because it went red is a
      regression, not a cleanup.
- [x] The CSS count is recorded. **It went up, and that is the honest result**: 3,048 lines across
      42 `.vue` files before, 5,207 across 62 after — 4,639 outside `ui/` and 568 inside it.

      This criterion was written on a wrong theory. A component library does not reduce the amount
      of CSS in an application whose screens simultaneously get richer: this epic added twenty
      files (fifteen primitives, four frame components, the gallery) and turned a flex row of
      buttons into a rail, a topbar, a card grid, a dense table and a modal. What it actually
      bought is stated better by two other numbers — **zero** colour literals outside the token
      layer, mechanically enforced, and **one** vocabulary of fifteen components with a guard
      against a sixteenth variant. Line count was the wrong proxy for "is this one system", and
      the guards are the right one.
- [ ] **Performed, not asserted:** the owner opens the application against a real run, on both
      themes, and says whether it reads as one product. A green suite is not evidence for this item.

## User stories

### KAR-24.1 — The token layer: one prototype, one stylesheet

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | EPIC-16 KAR-16.1 (`theme.css` and the seven-state contract this replaces the values inside)         |
| **PRD**         | F10.1, NF8, NF10                                                                                   |
| **Verified by** | EPIC-24-S01, EPIC-24-S02, EPIC-24-S03, EPIC-24-S04                                                 |

**As** anyone who has to change how this application looks, **I want** the whole design language in
one file, **so that** changing it is an edit rather than an audit.

**Acceptance criteria**

1. `packages/web/src/styles/theme.css` declares the design language as custom properties in three
   families, defined under `:root` and redefined under `.dark`:
   - **Surfaces** — `--surface-canvas`, `--surface`, `--surface-raised`, `--surface-inset`,
     `--surface-code`, `--surface-control`, `--surface-overlay` (direction A's `#0A0B0D`, `#0F1114`,
     `#0C0D10`, `#101216`, `#0E0F13`, `#14161A`, `rgba(5,6,8,.72)`).
   - **Ink** — `--ink`, `--ink-strong`, `--ink-muted`, `--ink-dim`, `--ink-faint` (`#E9EAEE`,
     `#D3D6DC`, `#9CA2AC`, `#6B707A`, `#5C616B`).
   - **Edges** — `--edge`, `--edge-strong`, `--edge-control`, `--edge-hover`, `--edge-dashed`
     (`#1C1E23`, `#1E2128`, `#24272E`, `#3A3E47`, `#282C33`).
2. `--surface` and `--edge` and `--ink` and `--ink-muted` and `--focus-ring` keep the names KAR-16.1
   gave them, because every existing component reads them. Their *values* move to the prototype's.
   No component is edited in this story.
3. The seven `--state-*` names are unchanged and their values are the prototype's semantic hues per
   the table in this epic's "token layer" section. `src/lib/state-palette.ts` is not modified and
   `src/lib/state-palette.test.ts` passes unmodified.
4. Type and shape are tokens too: `--font-sans` (Instrument Sans), `--font-mono` (JetBrains Mono),
   the size ramp `--text-2xs` (8.5px) through `--text-2xl` (24px) as direction A uses it, the radius
   ramp `--radius-xs` (4px) through `--radius-xl` (13px) and `--radius-pill`, and `--shadow-panel`
   / `--shadow-modal`.
5. The four animations direction A defines — `dashrun` (a running edge), `pulsering` (a running
   node), `caret` (a live stream), `shimmer` (a pending value) — are declared once here as
   `@keyframes`, and every one of them is inert under `@media (prefers-reduced-motion: reduce)`
   (NF8, §9.3).
6. The light theme is direction B's paper stack (`#F4F2EE`, `#EDEAE4`, `#FFFFFF`, `#DCD7CE`,
   `#191A18`, `#5F5B54`, `#8C877D`) carrying direction A's *structure*: the same token names, the
   same count, the accent at the same hue and a lightness that passes on paper. Direction B's serif
   and its green accent are not adopted.
7. A test computes the WCAG contrast ratio for every ink-on-surface pair and every state-on-surface
   pair, in both themes, from the stylesheet's own declarations, and fails below 4.5:1 for ink and
   3:1 for state. Where a prototype literal does not pass, the token carries the adjusted value and
   a comment naming the original.
8. Instrument Sans and JetBrains Mono are self-hosted woff2 in `packages/web/src/assets/fonts/`,
   declared with `@font-face` and `font-display: swap`, with a system stack behind each. No
   stylesheet in the built application references `fonts.googleapis.com` or `fonts.gstatic.com`, and
   a test asserts it.

**Notes / risks** — the hazard is a token file that grows a second vocabulary beside the first,
where `--surface-raised` and `--panel-bg` both exist and mean the same thing. The count in AC1 is
deliberate: seven surfaces, five inks, five edges, and a name that is not on that list needs a
reason written beside it.

---

### KAR-24.2 — The primitives: the components every screen is made of

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | L                                                                                                  |
| **Depends on**  | KAR-24.1 (the tokens they spend)                                                                    |
| **PRD**         | F10.1, F10.3, NF8, NF10                                                                            |
| **Verified by** | EPIC-24-S05, EPIC-24-S06, EPIC-24-S07, EPIC-24-S08, EPIC-24-S09, EPIC-24-S10                       |

**As** someone building the next screen, **I want** the pieces to already exist, **so that** the
screen is composition rather than CSS.

**Acceptance criteria**

1. `packages/web/src/components/ui/` holds these components, each one `<script setup lang="ts">`
   with typed props, each one reading only tokens:

   | Component        | Props                                                                     | Where direction A uses it                            |
   | ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
   | `UiButton`       | `variant: primary \| secondary \| ghost \| danger`, `size: sm \| md`, `disabled` | "Start a run", "New project", "Rescan", modal footer |
   | `UiChip`         | `variant: neutral \| accent \| ok \| warn \| error \| info`, `mono`        | crumb tags, `UNSAVED`, run-id pills, tracker badges  |
   | `UiStateChip`    | `state: DisplayState`, `label?`                                            | node status, run status — wraps the existing glyph + label contract |
   | `UiCard`         | `variant: raised \| inset \| flush`, `interactive`                        | project cards, node cards, settings panels           |
   | `UiPanel`        | `title?`, `action?` slot                                                   | "Providers & runtimes", "Issue tracker", inspector sections |
   | `UiIconTile`     | `size: sm \| md`, `tint`                                                   | the rounded icon square on every node and row        |
   | `UiSectionLabel` | —                                                                          | `STREAMING OUTPUT`, `TOOL CALLS`, `RUNTIMES` — mono, 9px, `.12em` tracking |
   | `UiStatTile`     | `label`, `value`, `tone`                                                   | the inspector's 2×2 stat grid, project card stats    |
   | `UiProgressSplit`| `done`, `running`, `total`                                                 | fan-out bars, run progress, the swarm dock header    |
   | `UiMeter`        | `pct`, `tone`                                                              | node progress, execution defaults sliders            |
   | `UiField`        | `label`, `modelValue`, `placeholder`, `mono`                               | the new-project modal, any input                     |
   | `UiToggle`       | `modelValue`, `label`                                                      | runtime enable, "require approval before writes"     |
   | `UiModal`        | `open`, `title`, footer slot                                               | the new-project modal                                |
   | `UiEmptyState`   | `title`, `hint`, `action?` slot                                            | the dashed "New project" tile, any empty list        |
   | `UiMetaRow`      | `label`, `value`, `mono`                                                   | the inspector's config rows                          |

2. **No component takes a variant named after a screen or a domain concept**, and
   `checkUiVocabulary` in `test/support/guards.ts` fails the build when a `variant` union in
   `src/components/ui/` contains a token outside the vocabularies listed in AC1.

   > **Corrected during implementation.** This originally named
   > `packages/web/scripts/check-ui-vocabulary.ts`, by analogy with the two facade scripts wired
   > into the root `lint` script. The `guards.ts` family is the better home: every guard there is
   > exercised against a violating fixture *and* a clean one in `test/guards.test.ts` — "a
   > structural guard that has only ever seen a compliant repository is not known to detect
   > anything" — and the facade scripts have no such coverage.

3. **No colour literal exists in `src/components/ui/`.** Every colour is `var(--…)`.

   > **Corrected during implementation.** This guard already existed.
   > `checkStateColoursComeFromThePalette` covers every web source — TypeScript, `.vue` and
   > stylesheets — with `theme.css` and `state-palette.ts` as its only exemptions, so `ui/` was
   > under it from the moment those files appeared. Nothing was built for this criterion, which is
   > the good outcome.
4. `UiModal` is built on `reka-ui`'s dialog primitive, not hand-rolled — focus trap, `Esc`,
   outside-click and `aria-modal` are what §9.3 says not to reimplement. `UiToggle` carries
   `role="switch"` and `aria-checked`; `UiField` labels its input; every interactive component shows
   `--focus-ring` on `:focus-visible` and none of them removes an outline without replacing it.
5. `UiStateChip` renders colour **and** glyph **and** text label, from the existing
   `STATE_LABELS`/`stateVar` in `src/lib/state-palette.ts`. It does not define a state vocabulary;
   it consumes the one that exists (§9.2), and `src/components/StateChip.vue` is re-expressed in
   terms of it rather than duplicated.
6. Each component's spec mounts it in every variant and asserts the token it resolved — that a
   `danger` button's colour is `--state-failed` and not a hex, that an `inset` card's background is
   `--surface-inset` — so a token renamed in KAR-24.1 fails here rather than in a screenshot.
7. `src/components/ui/index.ts` re-exports the set. Nothing outside `ui/` imports a file inside it
   by path.

**Notes / risks** — fifteen components is the ceiling, not a target. The pressure in this story is
to add a sixteenth for a shape that appears twice; the answer is that twice is a slot, not a
component.

---

### KAR-24.3 — The gallery: every component, every state, on one route

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | S                                                                                                  |
| **Depends on**  | KAR-24.2 (the components it shows)                                                                  |
| **PRD**         | F10.1, NF3, NF8                                                                                    |
| **Verified by** | EPIC-24-S11, EPIC-24-S12, EPIC-24-S13                                                              |

**As** the person applying the library to six screens, **I want** one page showing every piece in
every state, **so that** a broken variant is found by looking at one route rather than by touring
nine.

This is the story that keeps the other five honest. Without it, "does the `warn` chip work in the
light theme" is a question answered by building a screen that needs one.

**Acceptance criteria**

1. `/gallery` renders every component from KAR-24.2 in every variant, plus `UiStateChip` in all
   seven display states, plus the composite patterns the later stories reuse: a node card, a dense
   table row, a phase list row, an inspector stat grid.
2. It renders the token layer itself — every surface, ink, edge and radius as a labelled swatch with
   its computed value — so KAR-24.1's file has a visible face.
3. A theme toggle on the page switches `:root`/`.dark` for the gallery, and both themes are
   inspectable without leaving it.
4. The route is registered only when `import.meta.env.DEV` is true, its component is a dynamic
   import, and `packages/web/test/integration/bundle-budget.test.ts` passes unchanged — the gallery
   is not in the production bundle (NF3).
5. A spec mounts the gallery and asserts it renders without error in both themes, so a component
   whose props changed under it fails a test rather than a person's memory.

---

### KAR-24.4 — The app frame: the rail, the switcher and the topbar

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | KAR-24.2, EPIC-22 KAR-22.1 (the projects the switcher lists), KAR-22.2 (the composer the button opens) |
| **PRD**         | F10.1, F10.3, NF8, NF10                                                                            |
| **Verified by** | EPIC-24-S14, EPIC-24-S15, EPIC-24-S16, EPIC-24-S17, EPIC-24-S18                                    |

**As** an operator, **I want** the application to have a frame — where I am, what is running, what
is waiting on me — **so that** I stop navigating by address bar.

Direction A's frame is a 246px left rail (brand, project switcher, five-item nav, runtime status
list, identity footer) and a 52px topbar (breadcrumb, run status pill, primary action). Today
`App.vue` is a single flex row of buttons with no rail at all.

**Acceptance criteria**

1. `src/components/frame/AppRail.vue` renders: the brand mark with the `LOCAL` badge; the project
   switcher; the nav; the runtime list; the identity footer. It is composed from KAR-24.2's
   components and declares no colour.
2. The nav's items are the routes that exist — runs, projects, and the current project's workspace
   and connectors — and each links through `RouterLink`. **No nav item points at a route this
   application does not have**; direction A's "Builder" is not rendered.
3. The project switcher lists projects from the endpoint `ProjectsView` already calls, marks the
   active one, and navigates on select. It adds no request the application did not already make.
4. The topbar renders the breadcrumb (`project / view`), and keeps every element `App.vue` has
   today — the theme toggle, the approvals badge, the search field, `RunProviderBanner`,
   `RunTaskBanner`, the composer button — restyled, not removed. The `awaitingOperator` count keeps
   its own request and its `aria-label`.
5. The run status pill shows the open run's status label, its elapsed time and a dot that animates
   only while running (and not at all under reduced motion). It reads the run store; it computes no
   new state.
6. The skip-link stays first in the DOM and still targets `MAIN_CONTENT_ID`; the keyboard map from
   `app/keyboard.ts` is installed exactly as it is today; `TokenRequired` still gates every view.
   `packages/web/src/app/shell-boot.test.ts` and `keyboard.test.ts` pass unmodified.
7. The rail collapses to icons below 1100px and is hidden below 820px with the nav moving into the
   topbar, so the frame does not eat a laptop screen.

---

### KAR-24.5 — The plan graph and its node cards, in the new language

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | KAR-24.2, EPIC-17 KAR-17.1 (the graph this restyles)                                                 |
| **PRD**         | F10.1, F10.9, NF8                                                                                  |
| **Verified by** | EPIC-24-S19, EPIC-24-S20, EPIC-24-S21, EPIC-24-S22                                                 |

**As** an operator diagnosing a run, **I want** the graph to say what each node is, what model ran
it, how far it got and how long it took, **so that** the answer is on the canvas rather than one
click into an inspector.

Direction A's node is a 200px card: a header (icon tile, title, mono status) over a body (a runtime
dot with the model id, an optional progress bar, and a meta/time row). Today's node renders a title
and a state border.

**Acceptance criteria**

1. `PlanNode.vue`, `MemoryNode.vue` and `PlanDiffNode.vue` render direction A's card, composed from
   `UiCard`, `UiIconTile`, `UiStateChip` and `UiMeter`. The state colour reaches the border through
   `stateVar()`, exactly as it does today.
2. The card shows: kind icon, title, status, the provider and model id the node was scheduled onto,
   the node's own meta line, and elapsed time. **Every one of those is a field the view model
   already carries** — `components/graph/node-body.ts` is the source, and this story adds no field
   to it and no request behind one.
3. Node size is stated in `components/graph/node-size.ts` as it is today, updated to the card's
   dimensions, so ELK lays out against the real box. `packages/web/src/components/graph/layout.test.ts`
   and `union-layout.test.ts` pass with only the dimension constants changed.
4. A running node carries `pulsering` and a running edge carries `dashrun`; both are inert under
   reduced motion, and `reduced-motion.test.ts` passes unmodified.
5. The canvas gets direction A's dot grid, its bottom-right zoom control and its flow-tab strip; the
   Vue Flow keyboard a11y that §9.3 credits is untouched and `disableKeyboardA11y` is still not set.
6. The 400-node stress measurement (`packages/web/scripts/measure-graph.ts`) is re-run and the
   number recorded on the story. A card with four more text nodes than a rectangle is a rendering
   cost, and it is measured rather than assumed.

---

### KAR-24.6 — The node inspector, in the new language

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P0                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | KAR-24.2, EPIC-17 KAR-17.3 (the inspector this restyles)                                             |
| **PRD**         | F10.3, F10.6, NF8                                                                                  |
| **Verified by** | EPIC-24-S23, EPIC-24-S24, EPIC-24-S25                                                              |

**As** an operator, **I want** the inspector to answer "what happened in this node" in one column,
**so that** diagnosis is scrolling rather than clicking.

**Acceptance criteria**

1. The inspector is a 400px right panel with direction A's header — icon tile, title, mono
   `nodeId · kind`, status pill — over a tab strip, over a scrolling body.
2. The **output** tab renders the 2×2 `UiStatTile` grid, the streaming output block in
   `--surface-code` with the blinking caret while the stream is live, and the tool-call list. Each
   reads the projections that feed it today (`lib/node-output.ts`, `lib/node-inspector.ts`); none is
   recomputed.
3. The **config** tab renders `UiMetaRow`s for runtime and model and the system prompt in a code
   block. The **logs** tab renders the mono three-column log list (time, level, message).
4. `NodeInspector.vue` keeps its overlay behaviour exactly: the `Esc` stack, the focus return, and
   the `CommandJumper` interaction. `node-inspector.test.ts` passes with only selector changes, each
   named in the story's notes.
5. The streamed-text surface keeps its bounded-buffer behaviour from KAR-16.3 — this story restyles
   the box, it does not change what is retained in it, and the memory-stress spec passes unmodified.

---

### KAR-24.7 — Projects, run history and the workspace boards

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P1                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | KAR-24.2, KAR-24.4, EPIC-22 KAR-22.1, KAR-22.3                                                       |
| **PRD**         | F10.9, F1.1, NF8                                                                                   |
| **Verified by** | EPIC-24-S26, EPIC-24-S27, EPIC-24-S28, EPIC-24-S29                                                 |

**As** an operator, **I want** the list screens to be scannable, **so that** finding the run I care
about is a glance.

**Acceptance criteria**

1. `ProjectsView` renders direction A's card grid: icon tile with initials, name, last-activity
   line, tracker badge, description, the project's recent flows, and a stats footer — plus the
   dashed `UiEmptyState` tile that opens the create form. Every field is one the endpoint already
   returns; a field the API does not have is not invented, and the card renders without it.
2. **A project whose path has gone is still rendered, with its health message beside it.** KAR-22.1
   AC5 is a behaviour, and a card grid that hid unhealthy rows would break it. `projects.test.ts`
   passes unmodified.
3. `RunListView` renders direction A's dense table: the run id with an animated dot for a live run,
   trigger over source, workflow, a progress meter with a step count, tokens and elapsed. Column
   widths are the prototype's grid, and the row height is direction C's density.
4. The project workspace's task board and history reuse the same table and card primitives rather
   than a third treatment, and the workspace's live graph is KAR-24.5's canvas.
5. Every list has a real empty state — `UiEmptyState` with a sentence and an action — and none of
   them is a bare "No runs".

---

### KAR-24.8 — Settings, connectors and the composer

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                        |
| **Priority**    | P1                                                                                                 |
| **Size**        | M                                                                                                  |
| **Depends on**  | KAR-24.2, KAR-24.4, EPIC-22 KAR-22.2, KAR-22.4, KAR-22.6                                             |
| **PRD**         | F1.1, F3.5, NF8, AR-1                                                                              |
| **Verified by** | EPIC-24-S30, EPIC-24-S31, EPIC-24-S32, EPIC-24-S33                                                 |

**As** an operator, **I want** starting a run and wiring a connector to look like the rest of the
product, **so that** the two things I do most are not the two ugliest screens.

**Acceptance criteria**

1. `RunComposer` becomes `UiModal` with direction A's modal chrome: a titled header, a body of
   labelled sections, a footer with a ghost cancel and a primary action. Its three intake shapes,
   its adapter picker and its submit path are unchanged, and `composer.test.ts` passes with only
   selector changes.
2. `ConnectorsView` renders the "Issue tracker" panel treatment: one row per connector with its
   tint, name, detail line and an action button whose label is the state it will move to.
3. A settings surface renders the providers-and-runtimes table — icon tile, name over endpoint,
   model list, a status dot with its mono label, and a `UiToggle` — **reading `deflow doctor`'s own
   provider status through the endpoint that already serves it.** No provider health is computed in
   the browser, and no credential is displayed, echoed or logged (AR-1).
4. Every one of these screens renders a daemon refusal in the daemon's own words, exactly as it does
   today. A restyle that rewrites an error message into a friendlier one is a regression, and
   KAR-22.1's `refusalOf` stays the single path.

### KAR-24.9 — The frame's weight, against NF3's ceiling _(added)_

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Done                                                                                               |
| **Priority**    | P0                                                                                                 |
| **Size**        | S                                                                                                  |
| **Depends on**  | KAR-24.4 (the frame that costs it), KAR-24.8 (the measurement)                                       |
| **PRD**         | NF3                                                                                                |
| **Verified by** | EPIC-24-S34                                                                                        |

**As** whoever owns NF3, **I want** the initial-bundle decision re-made now that the application has
a frame, **so that** the ceiling is a number somebody chose rather than one the build keeps failing.

Added 2026-08-18, at the end of this epic, because the epic broke a budget it could not fix from the
inside. The measurement is not in dispute: 189.6 KB gzip at `f50f43d`, 212.6 KB after KAR-24.8, a
200 KB ceiling, and the growth is the frame rather than any one mistake.

**Acceptance criteria**

**Resolved 2026-08-18: the ceiling was raised to 220 KB.** The owner made the call; the reasoning and
the rejected alternative are recorded in `bundle-budget.test.ts` and docs/12 §10, so the next person
to look at this number finds the argument rather than just the digit.

1. The two options are written down with their costs, and one is chosen:
   - **Raise the ceiling.** ~215 KB with a recorded reason, on the grounds that the application in
     NF3's line was a viewer and this one has a frame. Cheap, honest, and spends real bytes on every
     first load.
   - **Re-decide what is eager.** `GraphCanvas` is 69 KB of the first chunk, and it is there because
     `bundle-budget.test.ts` asserts *"@vue-flow/core… because the plan graph is the landing view"*.
     KAR-19.1 made the run list the root route and left that premise standing. Making the run-plan
     route lazy takes the first chunk to roughly 143 KB and costs a navigation on the way into a
     run.
2. Whichever is chosen, [docs/12 §10](../../12-frontend-architecture.md) and
   `bundle-budget.test.ts`'s own assertion are updated to say the same thing, because they are two
   statements of one decision and a stale one is what produced this story.
3. `pnpm test` is green, including `packages/web/test/integration/bundle-budget.test.ts`.

**Notes / risks** — the temptation is to widen the number quietly because it is one line. The reason
this is a story rather than a commit is that NF3 is a product promise about how fast the page opens
on a cold load, and a ceiling nobody defends stops being one.

---

## Risks

**~20 days is over the 15-day guideline**, and it is stated rather than hidden. The epic is
splittable at a real seam if the schedule demands it: KAR-24.1 through KAR-24.5 are the product's
main surface — the frame and the graph — and KAR-24.6 through KAR-24.8 are the screens reached from
it. Stopping after KAR-24.5 leaves an application that is *coherent where an operator spends their
time* and unstyled where they visit occasionally, which is a worse-looking product but not a broken
one. Stopping after KAR-24.2 leaves a library nothing uses, which is the one cut that is worth
nothing — so KAR-24.3, the gallery, exists partly to make even that state useful.

**The real risk is scope creep from "restyle" into "redesign".** Direction A draws a builder that
has no engine behind it and a swarm dock whose data model is EPIC-11's open question. Both are
excluded above in writing. The check when a story feels large is whether it is adding a field to a
view model; if it is, it has stopped being this epic.

**The second risk is a half-migration** — the library exists, six screens use it, and four keep their
scoped styles, so the codebase now has two vocabularies instead of one. The Definition of Done's
colour-literal guard is the mechanism against it: once it is switched on, a screen that has not
migrated cannot pass lint, which makes the half-migration state fail loudly rather than persist
quietly.

**The fourth risk materialised, and it is the bundle.** The frame is not free: a rail, a topbar, a
switcher, a status pill and fifteen primitives cost ~23 KB gzip in the initial chunk, and NF3's
ceiling had only ~10 KB of headroom to begin with. The obvious 69 KB of headroom is `GraphCanvas`,
which sits in the first chunk because `bundle-budget.test.ts` asserts it must — *"because the plan
graph is the landing view"*, a premise KAR-19.1 falsified when it made the run list the root route.
Correcting that is an architecture change governed by [docs/12 §10](../../12-frontend-architecture.md)
and an ADR, not something to slip into a restyle, so this epic reports the number and does not widen
the budget. **KAR-24.9 is the story that decides between raising the ceiling with a recorded reason
and re-deciding what is eager.**

**The third is that this epic touches every spec in `packages/web` without changing any behaviour**,
which is exactly the shape in which a real regression hides among two hundred selector updates. The
rule for every story: a spec's *assertions* may change only where they name a class or a colour, and
any spec whose behavioural assertion changed is named in that story's notes with the reason.
