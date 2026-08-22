# KAR-26.5 — frame audit: blueprints 01–05 against the live frame

> Part of [EPIC-26](../../../delivery/epics/EPIC-26-run-clean.md) (KAR-26.5 AC1) ·
> Blueprint files and their standing in [`README.md`](./README.md) ·
> Scenarios EPIC-26-S32…S38 in
> [`EPIC-26-run-clean-flows.md`](../../../delivery/flows/EPIC-26-run-clean-flows.md)

Every visible element of `01-frame-workflow-run.png`, `02-inspector-config.png`,
`03-inspector-logs.png`, `04-frame-fanout-run.png` and `05-frame-fanout-scrolled.png`, matched
against the frame as it ships, each with one of three verdicts:

- **matches** — the frame already renders the blueprint's element (token vocabulary wins over
  screenshot colour, per `README.md`).
- **gap closed here** — closed in KAR-26.5 itself; the close is described inline and listed again
  in [§ Gaps closed](#gaps-closed-in-kar-265) with its named exceptions.
- **out of scope: \<reason\>** — never "hard". The reason is one of the epic's standing ones:
  *needs a fact the daemon does not have* · *EPIC-25-recorded unbuilt feature* (Builder,
  install execution, editable inspector fields — recorded at the bottom of `README.md`) ·
  *reusable workflow definitions do not exist* (the same gap that kept Builder out; also the
  epic's recorded "START FROM A WORKFLOW chips are out" line) · *model/throughput metadata is not
  faked* (the epic's own scope decision) · *KAR-25.10 endpoint runtimes stay unbuilt (MET-843)*.
  Exactly two rows carry a reason outside that list, and both say so rather than dressing an
  analogy up as a standing one: the blueprint's **"⏸ Pause run" button** and the **inspector's
  scrim**. Each would need a behaviour change — a new daemon call wired into the frame; KAR-24.6's
  recorded Dialog-semantics decision reversed — and behaviour changes are what this story's own
  AC4 bars from riding along in an audit, so each row cites AC4 and names where the underlying
  decision (or absence of one) is recorded. This paragraph is the deviation's record, echoed in
  the epic's execution notes.

Fact claims below were verified against `packages/daemon/src/http/api.ts` (the daemon's GET
surface), not inferred from the frontend.

## Rail (01, 04, 05)

| Element | Blueprint | Current frame | Verdict |
|---|---|---|---|
| Brand row: icon tile + wordmark | Diamond tile + "Loomlet" | `UiIconTile` + "DeFlow", a `RouterLink` to `/` (KAR-25.2) | matches — the brand name is this application's own; the blueprint's is a prototype brand |
| Environment chip beside the brand | `LOCAL` mono chip | `UiChip mono` rendering the literal `LOCAL` (`AppRail.vue`), mandated by KAR-24.4 AC1 | out of scope (the fact-fed half): **needs a fact the daemon does not have** — verified: `GET /api/health` carries `apiVersion, build, daemonEpoch, headSeq, uptimeMs, pid, bootId` and no bind/environment field; loopback-only binding is boot behaviour (`main.ts`), reported nowhere. Adding an endpoint is daemon work, default-out per the story. The literal chip stays because KAR-24.4 AC1 names it; retiring it is a plan change (delivery README §9), recorded here as a standing tension rather than closed silently |
| Project switcher card: initials tile, name, chevron | "PP · Payments Platform", chevron | Initials tile, project display name, `ChevronsUpDown` | matches |
| Switcher subline | "2 workflows · LIN-PAY" | The project's filesystem path — a real `GET /api/projects` field | out of scope: **facts the daemon does not have** — the projects rows carry `id/name/path/createdAt/health/lastRun`; no workflow count (workflow definitions do not exist) and no tracker key on this endpoint |
| Nav items + order | Projects · Workflow · Runs · Builder · Settings | Projects · Workflows · Runs · Settings (project-scoped per KAR-25.1), lucide icons, `--accent` active row | matches — the label wording is KAR-25.1's own AC; token wins over screenshot colour |
| "Builder" nav row | Present | Absent | out of scope: **EPIC-25-recorded unbuilt** (no route, no epic — KAR-24.4 AC2's rule) |
| Workflow item count badge ("1") | Numeric badge on the active nav row | None | out of scope: **needs a fact the daemon does not send to any surface the rail reads** — no count field on anything the frame already fetches; wiring `GET /projects/:id/runs` into the rail is a new daemon call AC4 bars |
| RUNTIMES section label | `RUNTIMES` mono caps | `UiSectionLabel` "Runtimes" (mono, uppercase, letterspaced) | matches |
| Runtime rows: dot + name | Green dot on, grey off; vendor display names ("Anthropic · Claude") | Dot from `data-installed`/`data-enabled` (`--state-passed` / `--ink-faint`), name = the daemon's own provider id from `GET /api/providers` | matches — the id is the daemon's own word; a client-side pretty-name table would be a rename the wire does not carry |
| Runtime row right column | "4 models", "6 models", … | `version` / `installed` / `not installed` / `disabled` — all real fields | out of scope: **model metadata is not faked** — KAR-25.3's recorded amendment: DeFlow reports no model list anywhere; `test/no-context-window-table.test.ts` forbids inventing one |
| "OpenAI-compatible · off" row | Present | Absent | out of scope: **KAR-25.10 endpoint runtimes stay unbuilt (MET-843)** — named verbatim in EPIC-26's scope decisions |
| Dashed "+ New project" affordance | Rail chrome (KAR-26.5 AC3, S35) | The switcher popover footer now carries a dashed-plus **"New project"** row above "All projects"; it routes to `/projects?new=1` and `ProjectsView` opens KAR-25.6's existing modal off that marker — one modal, no second form | **gap closed here** |
| Footer identity area | Avatar "SR", "Sam Rao", "Workspace admin" | Glyph tile + "Local daemon" / "Connected"·"No session" off `useSessionStore.authenticated` | matches per EPIC-26-S36 — the footer shows exactly the identity fact that exists (the daemon connection); the person is out of scope: **needs an identity fact the daemon does not have** (DeFlow has no notion of who is logged in — recorded in `AppRail.vue`'s header) |
| Theme toggle in the rail footer (right) | Sun glyph at the footer's right edge; `README.md`'s own table says 01 settles "the theme toggle's home" | It lived in `AppTopBar.vue` only; no EPIC-25 story moved it | **gap closed here** — the toggle renders in the rail footer at rail widths; the topbar keeps one wherever the rail is gone: below 820px (the same pairing the nav already uses) **and** on a tokenless tab, which mounts no rail at any width — without that second case the TokenRequired screen at desktop width had no theme control at all (see § Gaps closed, item 2) |

## Topbar (01, 04, 05)

| Element | Blueprint | Current frame | Verdict |
|---|---|---|---|
| Breadcrumb, project segment | Project display name ("Payments Platform"), muted, linked | Was the raw `projectId` as a `RouterLink` (`AppTopBar.vue` refuses a second request) | **gap closed here** — the display name is a fact the daemon already sends and the frame already fetches (the switcher's one `GET /api/projects`); that read lifted into a shared app-level handle (`src/app/useProjects.ts`) both consume — same single request, the topbar still owns none. Named AC4 exception: state ownership moves, request count does not |
| Breadcrumb, second segment | Workflow name ("Issue → PR pipeline") + chip (`v14 · live`, `107 agents · live`) | View word per route name ("Workflows", "Plan", …) | out of scope: **reusable workflow definitions do not exist** — name, version and liveness are workflow-definition facts |
| Running indicator pill | `● RUNNING · n6 10:22` | `RunStatusPill`: state-coloured dot (pulsing while running, motion-token'd) + the daemon's own status word | dot + word: matches. Elapsed time: **gap closed here** — KAR-24.4 AC5 already promised "its elapsed time" and it never shipped; derived purely from the timeline projection's own span facts (earliest `startTs`; latest `endTs` once nothing is open), 1s ticker only while a span is open, formatted with the graph's own `formatElapsed` so there is one duration vocabulary. Node id: **out of scope: needs a fact the daemon does not have** — there is no "current node" fact; the plan can hold several running nodes at once and naming one composes a claim |
| "⏸ Pause run" button | Present, top right | No frame surface calls `POST /api/runs/:id/pause` (the endpoint exists — verified — with zero web callers) | out of scope: **not a standing reason — this story's own AC4** (see the preamble's two-row note). Run-control UI is a feature no epic's plan contains, and building it here means wiring a new daemon call into the frame, which AC4 bars from riding along in an audit story. Recorded openly as this audit's own scope call so a follow-up story has its pointer |

## Canvas + node cards (01, 04, 05)

| Element | Blueprint | Current frame | Verdict |
|---|---|---|---|
| Dot grid | Faint dot grid | `radial-gradient(var(--edge) …)` at 22px pitch on `.graph-canvas` (recorded honest deviation: the dots do not pan) | matches |
| Zoom control bottom-right | `100% − +` pill | `@vue-flow/controls` restyled: live `%` label, −/+ buttons with real disabled states, bottom-right | matches — the fit-view button and top-right minimap are kept extras: function, not invention |
| Workflow tab strip above the canvas | `● Issue → PR` / `Deep research` chips | None (KAR-24.5's implementation refused the flow-tab strip; the argument is recorded in `NodeInspector.vue`) | out of scope: **reusable workflow definitions do not exist** — the chips are workflow names |
| Node card chrome | Icon tile + title + status word header; body rows | `PlanNode.vue`: `UiIconTile` glyph, title, state chip (word + glyph), state-coloured border | matches |
| Runtime line | Tinted square dot + `provider · model` mono | Plain dot + `provider · model` mono | matches; the per-runtime tint is out of scope: **fact the daemon does not have** — `node-body.ts` carries a provider name, no swatch (recorded in KAR-24.5) |
| Progress facts line ("9 files changed", "18 chunks") | One mono progress line | `phase — progressMessage`, the daemon's own progress words when sent | matches in substance |
| Duration / bottom row | `2m36s` etc. | `elapsed` + `cost` mono figures row | matches — cost is a kept extra |
| "3 of 5 checks" / fan-out progress bars + "N agents" chips ("6 of 6", "31 of 75") | Bars + agent-count chips | None — `node-body.ts` has no fraction or agent-count field; the domain has no fan-out/parallel-agent node fact | out of scope: **facts the daemon does not have** (recorded when KAR-24.5 refused `UiMeter` a percentage) |
| Human-approval card | "Human approval · blocking · Sam Rao · awaiting run" | Gate nodes render with awaiting-human state via the same card | state matches; the assignee is out of scope: **no identity fact** |
| Edges: running / pending | Dashed animated into the running node; faint dashed into pending | `plan-edge--running` (`--state-running`, `dashrun`) / `plan-edge--pending` (`--edge-dashed`) | matches |
| Edges: completed path | Solid green through DONE nodes | Was the renderer's stock grey — no rule tinted a passed target's edge | **gap closed here** — `plan-edge--done` off the same target-node-state derivation `motionOf` already uses; stroke `var(--state-passed)`, still solid, still inert. CSS plus one pure-function branch in `GraphCanvas.vue` |
| PHASES panel + agents table below the canvas; All/Running/Verified/Queued filters; per-agent rows (`claude-opus-4.1 · 200k`, `13.7k tok`, `1 tool`, `28s`); "select a row to pin its transcript"; `1–24 of 75` | The whole lower band of 04/05 | None | out of scope: **facts the daemon does not have** — no phases projection, no per-agent rows, and the `200k`/tok-per-agent figures are the **model metadata the epic records as not faked**; the harness itself presupposes fan-out workflow definitions |
| Canvas scrolls independently of the table (05) | Independent scroll | No table exists; the canvas pans/zooms independently already | out of scope with the row above — nothing to scroll against |

## Inspector (01, 02, 03, 04)

| Element | Blueprint | Current frame | Verdict |
|---|---|---|---|
| Docked right panel, ~400px | Flush right, full height | `DialogContent` fixed right, `min(400px, 100vw)`, full height | panel geometry: matches. **The scrim does not**: the shipped panel is a Reka `Dialog` whose `DialogOverlay` (`--surface-overlay`, 72%-black in dark) dims the rail, the topbar and the canvas — and all five blueprints draw the opposite, the frame at full brightness around the open panel (01 even shows the selected card lit). This is the largest single visual divergence in the five screenshots, out of scope: **not a standing reason — this story's own AC4** (see the preamble's two-row note). The Dialog decision is recorded in KAR-24.6 (`NodeInspector.vue`'s header), and de-modalising the inspector is a behaviour change AC4 bars; recorded like Pause run, so a follow-up story has its pointer |
| Header: icon, title, `n6 · agent`, RUNNING pill | As drawn | Icon tile (state-tinted), `DialogTitle`, mono `id · kind`, state chip | matches |
| Tab strip: Output / Config / Logs | Three chip tabs, active filled + bordered | Two Reka tabs (Output, Config); active = `--surface-inset` + `--edge-strong` border | treatment matches; the **Logs tab** is out of scope: **fact the daemon does not have** — no level-tagged per-node log line exists in any projection (the refusal and the reason are recorded in `NodeInspector.vue`'s header; the debug ring is the honest equivalent, already on screen) |
| Logs stream (03): timestamped, level-coloured | `14:22:07 INFO …` | None | out of scope: same reason as the Logs tab |
| Output stat tiles | TOKENS IN / TOKENS OUT / TOK/SEC / CTX USED | 2×2 `UiStatTile` grid: Tokens / Cost / Duration / Attempts — real fields only | matches in rhythm; TOK/SEC and CTX USED are out of scope: **model/throughput metadata is not faked**; the IN/OUT split needs token-accounting fields the projections do not carry |
| STREAMING OUTPUT live block + caret | Live prose, `live` tag | Refused (recorded): projections are completed ledger events; the live stream is `NodeTerminal`'s own routed feature; the caret is used once, honestly, on `outcome === 'running'` | out of scope: **fact the daemon does not have at this surface** (recorded in KAR-24.6 — pulling the stream in is new fetch behaviour) |
| TOOL CALLS list with timings | Per-call rows | None — no per-call projection exists (`PacketVM` tool segments are inputs, not calls) | out of scope: **fact the daemon does not have** |
| Config as label/value rows | RUNTIME & MODEL group: Provider, Model | `UiMetaRow`s: type, runtime, model, worktree, path scopes, permission (+ CLI version, sha256) | matches |
| Config: Context / Temperature / Max steps | `200,000` / `0.2` / `12` | Absent — the ledger records no such per-node fields | out of scope: **model metadata is not faked** + **EPIC-25-recorded unbuilt** (editable per-node execution fields) |
| SYSTEM PROMPT inlined text | Prompt prose in a code block | Prompt **handle** + "manifest is authoritative" note (the recorded rule since KAR-17.3) | out of scope: **fact the daemon does not have** — the wire carries a handle, never bytes |
| Sections below the tabs (attempts, packet, compare, provenance, ring) | Not drawn | Present | kept — this application's own diagnostic material, recorded in KAR-24.6; not a blueprint gap |

## Elements the frame renders that the blueprint does not draw

Kept, all of them: the topbar search field, the approvals menu, `RunProviderBanner` /
`RunTaskBanner`, the "Start a run" button (KAR-24.4 AC4 mandates keeping them), the node-card
cost figure, the canvas node-table toggle, minimap and fit-view (accessibility and function).
Removing any of them is a behaviour change AC4 bars.

## Gaps closed in KAR-26.5

1. **Dashed "+ New project" affordance opening KAR-25.6's modal** (AC3, S35).
   `ProjectSwitcher.vue`'s popover footer gained the dashed-plus "New project" row (above the
   kept "All projects" link) navigating to `/projects?new=1`; `ProjectsView.vue` watches that
   query marker and sets its existing `formOpen` — one modal, no second form. *Named AC4
   exception:* one route-query read added, plus one `router.replace` that clears the spent
   marker when the modal closes (so the affordance works a second time and a reload after
   closing does not reopen it). Zero daemon-call changes.
2. **The theme toggle's home is the rail footer** (01 settles it, per `README.md`).
   `AppRail.vue` renders the toggle at the right edge of `.rail__identity` (prop `isDark` +
   `toggle-theme` emit threaded from `App.vue`); `AppTopBar.vue`'s toggle is now visible only
   where the rail — and its footer — is gone, which is **two** states: below 820px (the same
   pairing the nav uses) and on a tokenless tab, where `App.vue`'s AC6 `v-if` mounts no rail at
   any width (`no-rail` prop → `.topbar--no-rail`; without it the TokenRequired screen above
   820px lost the toggle entirely, against KAR-24.4 AC4's "every element … survives" contract).
   One shape reported rather than extracted, per KAR-24.4's "report rather than add a sixteenth
   primitive" rule: the toggle's control treatment is now spelled twice — `.topbar__theme` and
   `.rail__theme`, deliberately declaration-for-declaration identical (both files say so beside
   the rules) — because a `ui/` primitive for one shared button skin is the sixteenth primitive
   that rule exists to refuse. The two copies are the seam a token change must apply to twice.
3. **Run-status pill elapsed time** (KAR-24.4 AC5's own unshipped clause + the blueprint).
   `RunStatusPill.vue` renders elapsed time derived purely from the timeline projection's span
   facts: earliest `startTs`, measured to the tab's clock while any span is open (1s ticker,
   paused otherwise) and to the latest `endTs` once none is. Formatted with
   `node-body.ts`'s `formatElapsed` — one duration vocabulary, not a second `mm:ss` table.
   *Named AC4 exception:* read-only selectors over `useRunStore.timelineSpans`; no fold change,
   no daemon call. No node id — no "current node" fact exists.
4. **Breadcrumb project display name.** `src/app/useProjects.ts` now owns the one
   `GET /api/projects` read as an app-level provide/inject handle; `ProjectSwitcher.vue`
   consumes it in place of its local `load()` (and still triggers the fetch, so a tokenless tab
   — which never mounts the rail — still issues no request), and `AppTopBar.vue` renders the
   matching `name`, falling back to the raw id until the answer lands. `ProjectsView.vue` reads
   and writes the **same** handle in place of its private `ref` — its mount `GET` (which predates
   this story) fills the shared rows, and its create/remove update them — so a project created in
   this session names itself in the switcher and the breadcrumb immediately; without that, the
   raw-id fallback was permanent for exactly the project the operator had just made, since the
   rail mounts once and nothing re-fetched. *Named AC4 exception:* the request's owner moves into
   the shared handle (for the view as well as the switcher); the request count is unchanged.
5. **Completed-path edge tint.** `GraphCanvas.vue`'s `motionOf` also answers `'done'` for a
   passed target; `.plan-edge--done .vue-flow__edge-path { stroke: var(--state-passed) }`.
   Tokens only; the edge stays solid and inert.

All five closes use existing tokens (`--state-passed`, `--ink-faint`, the mono scale) — both
themes and the EPIC-24 contrast bar hold with no new colour pair and no per-instance override.
Everything else in the five screenshots is verified **matches** above or carries an out-of-scope
reason — a standing one everywhere except the two AC4-cited rows the preamble names.
