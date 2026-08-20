# EPIC-26: Run clean — a teardown that finishes, a dev daemon that knows its machine, and the blueprint's density

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-26-run-clean-flows.md)

|                      |                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-26                                                                                                                                                                     |
| **Status**           | Ready                                                                                                                                                                       |
| **Priority**         | P0                                                                                                                                                                          |
| **Milestone**        | M1                                                                                                                                                                          |
| **Workstream**       | W19 — added 2026-08-20, after the owner ran EPIC-25's merged result on their own machine and filed a new error loop, a dev daemon that cannot admit a run, and a UI that reads as prose where the blueprint draws rows |
| **Size**             | ~8 days across 5 stories                                                                                                                                                    |
| **Depends on**       | EPIC-25 (the settings page, the composer page, and KAR-25.8's occupancy decision are what this epic corrects), EPIC-24 (tokens and `ui/` primitives)                          |
| **Blocks**           | Nothing mechanical. It blocks the owner's own acceptance walk — EPIC-25's last Definition-of-Done item failed on first contact, and this epic is that failure, itemised      |
| **PRD requirements** | F2.4, F10.1, F10.11, NF1, NF8                                                                                                                                               |
| **Architecture**     | [09-workspace-and-safety.md §4](../../09-workspace-and-safety.md), [03-local-development.md](../../03-local-development.md), [12-frontend-architecture.md](../../12-frontend-architecture.md) |
| **Design source**    | [`docs/design/expected/EPIC-25/`](../../design/expected/EPIC-25/) — unchanged. The owner re-supplied the same seven screenshots on 2026-08-20 (byte-identical, verified by hash); the blueprint did not move, the implementation missed it |

## Goal

EPIC-25 closed with one item performed by the owner rather than asserted by the suite: open the
application against a real project and confirm the defects are gone. They did, on 2026-08-20, and
three things came back:

1. **The worktree error loop is back under a new name.** `WorktreeCreateFailed` became
   `WorktreePathOccupiedError`, once per drive tick, forever — same run
   (`run_20260816T194933Z_839b9b`), same node (`recon`), same stranding. KAR-25.8 fixed the case
   it named (a *locked* worktree carrying this node's own reason is reused) and created a new one:
   a worktree that teardown **unlocked and then failed to remove** is registered, unlabeled, and
   sitting at the node's own path — and `#reuseOrRefuse` reads "unlabeled" as "foreign" and
   refuses. The error message even says so, in circles: *"already belongs to an unlabeled worktree
   at* \<the same path\>*"*.

2. **The dev daemon does not know its machine.** Every runtime row says *"This daemon started
   without knowing this machine's PATH"* and the composer says *"Start it with `deflow up`"* —
   while the daemon in question **was** started in the operator's own terminal, by `pnpm dev`,
   with a real `PATH`. `main.ts` hands `pathRoots(process.env)` to the run chain and the executor
   but never to `boot()` itself, so `providerResolutions` is undefined, `GET /providers/routes`
   answers `known: false`, and admission is absent. The owner's question — *"is it really
   possible to test it with just `pnpm dev` locally? I don't think so"* — is currently correct,
   and it should not be.

3. **The screens are honest but they are not the blueprint.** The settings page renders every
   explanation as body copy — per-row caveat paragraphs, a four-row provenance table under
   GitHub, a paragraph on why Linear cannot be connected — where
   [`06-settings.png`](../../design/expected/EPIC-25/06-settings.png) draws one compact row per
   fact: avatar, name, mono subline, status dot + word, toggle. The composer's adapter picker
   renders its empty state as a detached card floating below the composer, where
   [`07-new-run-page.png`](../../design/expected/EPIC-25/07-new-run-page.png) draws a compact
   dropdown *inside* the composer's bottom bar with a grouped popover. Nothing on either screen
   invents a fact; both bury the fact in prose the blueprint gives one line.

The epic's rule is inherited from EPIC-25 unchanged: **no invented facts.** Every word the frame
renders still comes from the daemon; making the page denser must never mean making it up. Where
the blueprint draws a field the daemon does not have (a temperature slider, a tokens-per-second
figure), the density is matched and the field is not faked — the same discipline that amended
KAR-25.5 AC4.

## The mechanism, pinned before the stories

Reproduced and verified on 2026-08-20, not inferred:

- `git worktree list --porcelain -z` prints `locked <reason>` for a locked worktree and **no
  `locked` record at all for an unlocked one** (verified on real git in this repo). So an entry
  with `lockReason: null` is what an interrupted teardown leaves: `remove()` runs unlock first,
  ignores its exit code by design, then `git worktree remove` — and when remove refuses (a dirty
  tree, a crash between the two), the worktree stays registered, now unlabeled.
- `provision` → `#reuseOrRefuse` requires a parseable `DeFlow run=<id> node=<id>` reason; `null`
  parses to no owner → `WorktreePathOccupiedError`.
- `drive.ts`'s `advanceOneRun` catches, logs `carrying run … on from its spec threw`, and retries
  next tick. Nothing marks the node failed, so a deterministic refusal repeats forever.
- `packages/cli/src/up.ts` passes `providerRoots` and `probeProviders` into `boot()`;
  `packages/daemon/src/main.ts` does not, and its own docblock already argues that reading the
  developer's `PATH` there is correct.

## Stories

| Story | Title | Size | Depends on |
| -- | -- | -- | -- |
| KAR-26.1 | An interrupted teardown finishes instead of haunting the run | M | — |
| KAR-26.2 | The dev daemon knows its machine | S | — |
| KAR-26.3 | The composer's adapter control is the blueprint's | M | KAR-26.2 |
| KAR-26.4 | Settings at the blueprint's density | L | — |
| KAR-26.5 | The frame's remaining blueprint gaps, audited and closed | M | KAR-26.3 |

---

### KAR-26.1 — An interrupted teardown finishes instead of haunting the run

**As** an operator whose run failed mid-teardown, **I want** the next provisioning attempt to
finish what teardown started, **so that** a run is never stranded behind a worktree DeFlow itself
left half-removed — and a genuinely foreign worktree fails the node once, loudly, instead of
filling the log once per tick forever.

**Why now.** This is the owner's console dump: the same run that EPIC-25's KAR-25.8 was meant to
un-strand is stranded again, by the fix. The occupancy decision was right to refuse adoption of
a worktree it cannot identify — but a registered, **unlocked** worktree at the node's *own
derived path* (`<runRoot>/runs/<runId>/worktrees/<nodeId>` — a path namespaced by the very run
and node asking) is not unidentifiable. It is an interrupted §4.4 teardown, and the correct move
is to complete it: salvage if dirty, remove, then provision fresh.

**Acceptance criteria**

1. `provision` finding a registered worktree at the requested path with **no lock reason**
   completes the teardown instead of refusing: the existing salvage-aware removal sequence runs
   (dirty → capture, commit, force, exactly KAR-07.4's order; clean → plain remove), and
   provisioning then proceeds as for a fresh path. One `workspace.worktree_removed` and one
   `workspace.worktree_created` land, in that order.
2. A registered worktree at the requested path whose lock reason parses to **this** run and node
   is still reused (KAR-25.8 AC2, unchanged — regression-guarded, not re-implemented).
3. A registered worktree at the requested path whose lock reason is **foreign** — another run,
   another node, or an operator's own words — is still refused, and the refusal is now
   **terminal for the node**: the node is recorded failed with the occupant named, the run takes
   its normal node-failure path, and the next drive tick does **not** re-attempt provisioning.
   `WorktreePathOccupiedError` appears in the log at most once per provisioning attempt, not once
   per tick.
4. The occupant description never describes the path as belonging to itself. For an unlocked
   entry the message names the state (*"a worktree with no lock, left by an interrupted
   removal"* or equivalent); for a foreign lock it names the owner the reason declares.
5. The owner's exact scenario recovers end to end: a ledger and worktree layout matching
   `run_20260816T194933Z_839b9b` (provisioned, unlocked by teardown, remove refused, daemon
   restarted) reaches `workspace.worktree_created` on the next advance with no
   `WorktreePathOccupiedError` logged.
6. Nothing in this story touches `worktree-force-remove.ts`'s reachability: the double-force
   stays reachable only from the reaper path, and the static assertion in
   `test/double-force-reachability.test.ts` still holds.

**Execution plan.** TDD, no visual exception. Red first against a fake git that reproduces the
porcelain shapes (locked-with-reason / registered-unlocked / foreign-reason), then the
`worktree-manager` change, then the node-failure wiring for AC3 — which lives where the run
chain already folds node failures, not as a new catch in `drive.ts`. Integration test on real
git for AC5. Model: opus for plan and verification; opus for implementation (daemon correctness,
no design content).

---

### KAR-26.2 — The dev daemon knows its machine

**As** the owner running `pnpm dev` in my own terminal, **I want** that daemon to resolve
providers against my own `PATH` exactly as `deflow up` would, **so that** the composer can name
adapters, admission can admit, and the app is actually testable without installing the CLI.

**Why now.** The owner asked the question outright, and today's honest answer is "no". The gap
is one wiring omission: `main.ts` builds the chain and executor with
`pathRoots(process.env)` but calls `boot()` without `providerRoots` or `probeProviders`, so the
one daemon a developer actually runs is the one daemon that cannot say what the machine has.

**Acceptance criteria**

1. `boot()` in `packages/daemon/src/main.ts` receives `providerRoots` and `probeProviders` built
   from `process.env`, the same way `up.ts` builds them — and the docblock carries the same
   "operator's own terminal" justification both files already use for the chain.
2. Under `pnpm dev`, `GET /api/providers/routes` answers `known: true` with real rows; the
   composer's adapter picker lists them; the settings runtime rows carry the daemon's own health
   sentences instead of *"started without knowing this machine's PATH"*.
3. A run submitted from the composer under `pnpm dev` passes admission (or is refused on the
   merits of the machine, never on the absence of a resolution).
4. A guard keeps the two composition roots aligned: a test asserts that every boot option
   `up.ts` passes for machine identity (`providerRoots`, `probeProviders`) is passed by
   `main.ts` too, so the next port added to one cannot silently miss the other.
5. `known: false` remains a real answer for daemons genuinely booted without roots (specs,
   fixtures, supervisors) — the endpoint's contract does not change, only this caller.

**Execution plan.** TDD. AC4's guard first (red against today's `main.ts`), then the wiring.
Model: opus throughout — small, but it is composition-root surgery.

---

### KAR-26.3 — The composer's adapter control is the blueprint's

**As** an operator starting a run, **I want** the adapter/model choice to be a compact control
inside the composer's bottom bar — and its empty and error states to live inside that control —
**so that** the page reads like [`07-new-run-page.png`](../../design/expected/EPIC-25/07-new-run-page.png)
instead of sprouting a detached card below the composer.

**Why now.** The owner's screenshot shows the current state: the picker's empty state renders as
a floating panel overlapping the composer's own outline — *"it shows an error in a weird way."*
The blueprint draws: a dropdown button in the bottom bar (`✳ claude-opus-4.1 ▾`) beside Run; a
popover grouped by runtime (`ANTHROPIC · API`, `OLLAMA · LOCAL`, …) with one row per model and a
mono metadata line; the chosen row ticked.

**Acceptance criteria**

1. The adapter control is a button in the composer's bottom bar showing the current choice, and
   its options open as a popover anchored to it (Reka UI, same primitives as every other
   overlay) — grouped by runtime with the section-label treatment the blueprint draws.
2. Each option row renders the daemon's own facts for that resolution — id, route, and whatever
   metadata `GET /providers/routes` actually carries. Fields the daemon does not report (context
   window, tok/s) are **not** invented; the row is simply shorter.
3. The "daemon has no machine" state and the "no adapters usable" state render inside the
   control's own popover (or as the button's disabled state with the sentence as its accessible
   description) — never as a separate card in the page flow. The sentences themselves stay the
   daemon's/the existing honest wording.
4. An unavailable adapter is a visible, disabled row with the daemon's reason — same fact, new
   placement.
5. Run stays disabled until an available adapter is chosen, unchanged in behaviour; keyboard and
   escape behaviour match the other Reka popovers; both themes hold contrast on the new control.
6. The old floating card is gone — a lint-level or DOM-level guard asserts the composer renders
   no adapter content outside the bottom-bar control.

**Execution plan.** Visual TDD exception applies to pixel work only; the state logic (which row
disabled, what Run needs) is test-first. Design change lands in `ui/` or the token layer if any
primitive needs it — never a per-instance override. Model: **fable** for the design
implementation; opus for plan and verify.

---

### KAR-26.4 — Settings at the blueprint's density

**As** the owner, **I want** the settings page to read as
[`06-settings.png`](../../design/expected/EPIC-25/06-settings.png) draws it — one row per fact,
prose demoted to disclosure — **so that** the page is scannable without losing a word of the
honesty EPIC-25 put into it.

**Why now.** The current page is the blueprint's information with none of its economy: every
runtime row carries its caveat paragraph inline, the GitHub connector explains its credential
provenance in a four-row table plus command block in the page flow, and Linear's
cannot-be-connected rationale is a standing paragraph. The blueprint gives each of these one
line and puts the rest behind interaction.

**Acceptance criteria**

1. Runtime rows compact to the blueprint's shape: avatar chip, name, mono subline, status dot +
   short state word, toggle — one row of vertical rhythm each. The daemon's full health sentence
   remains reachable from the row (disclosure, tooltip, or expandable detail) verbatim; the
   short state word is derived from facts the daemon already sends (`available`, `enabled`,
   route presence), never composed into a new claim.
2. The per-row "detected cannot be removed" caveat and its siblings move into the row's
   disclosure; the list itself shows at most one line of explanation per row.
3. Issue-tracker rows compact likewise: service, mono subline, one status chip
   (`CONNECTED` / `CONNECT` / the existing resolved statuses from KAR-25.4's
   `resolveConnectorStatus` — unchanged logic, new clothes). GitHub's provenance table, the
   `gh auth login` command, and Linear's rationale all live behind the row's disclosure, intact.
4. Execution defaults keep exactly the fields `GET /api/config` actually carries, in the
   blueprint's label-value-control rhythm; no slider is invented for a field that does not
   exist (KAR-25.5 AC4's discipline).
5. Both themes hold: every new or moved surface passes the same contrast bar EPIC-24 set, and
   any colour or spacing need is met in the token layer / `ui/` primitives, not per-instance.
6. Every DOM-level assertion that exists today about these panels' *facts* (statuses, sentences,
   toggle wiring) still passes or is updated to the new structure in the same commit with the
   change named in the story notes — no assertion silently deleted.

**Execution plan.** Visual TDD exception for layout; behaviour assertions stay test-first.
Expect a `ui/` disclosure primitive if none exists — that is a design-system change, done in the
design system. Model: **fable** for design implementation; opus for plan and adversarial verify
(the "no invented facts" lens especially).

---

### KAR-26.5 — The frame's remaining blueprint gaps, audited and closed

**As** the owner, **I want** one deliberate pass over the other five blueprint screenshots
against the running frame, **so that** "and other UI parts" becomes a written list with each item
either closed or recorded as out of scope with a reason — not a vibe.

**Why now.** The owner's words: *"and the UI isn't implemented according to the screenshot I
attached … also the settings page screenshot. and other UI parts."* Settings and the composer
have their own stories; this one owns the rest of the frame —
[`01`](../../design/expected/EPIC-25/01-frame-workflow-run.png),
[`02`](../../design/expected/EPIC-25/02-inspector-config.png),
[`03`](../../design/expected/EPIC-25/03-inspector-logs.png),
[`04`](../../design/expected/EPIC-25/04-frame-fanout-run.png),
[`05`](../../design/expected/EPIC-25/05-frame-fanout-scrolled.png) — the rail's chrome (the
LOCAL chip, the dashed "+ New project" affordance, the user footer), the topbar's running
indicator, the inspector's tab treatment, node-card density on the canvas.

**Acceptance criteria**

1. A written audit lands in `docs/design/expected/EPIC-25/README.md` (or a sibling): every
   visible element of the five screenshots, matched against the current frame, each marked
   `matches` / `gap closed here` / `out of scope: <reason>`. Out-of-scope reasons must be the
   epic's standing ones (needs a fact the daemon does not have; needs a feature EPIC-25 recorded
   as unbuilt — Builder, install, editable inspector fields) — "hard" is not a reason.
2. Every gap the audit marks `gap closed here` is closed in this story, in the design system
   where the fix is a component or token and in the view where it is composition.
3. The rail carries the blueprint's chrome where the facts exist: the environment chip beside
   the brand, the dashed new-project affordance opening KAR-25.6's modal, the footer identity
   area if and only if an identity fact exists to show.
4. No behaviour changes ride along: routes, stores and daemon calls are untouched except where
   an audit item explicitly names them, and the story notes list any such exception.
5. Both themes, contrast bar, token-layer discipline — same bar as KAR-26.4.

**Execution plan.** The audit is the first deliverable and gates the rest — fable reads the five
screenshots against the live DOM (screenshot comparison in the browser suite where practical).
Model: **fable** for audit and design implementation; opus for verify.

---

## Scope decisions recorded rather than taken quietly

- **The blueprint's model metadata (context window, tok/s) is not faked.** The popover rows and
  runtime rows show what the daemon reports today; extending `GET /providers/routes` to carry
  richer capability metadata is real work touching the probe layer, and if the owner wants it,
  it is its own story — not a quiet field invented in a template.
- **"START FROM A WORKFLOW" chips on the new-run page are out of this epic.** The blueprint
  draws them; they presuppose reusable workflow definitions the product does not have yet (the
  same gap that kept "Builder" out of EPIC-25). Recorded here so the audit in KAR-26.5 can point
  at this line instead of re-litigating it.
- **KAR-25.10 (endpoint-shaped runtimes) stays where it is** — `OpenAI-compatible · not
  configured` in the blueprint's runtime list remains unbuilt, per MET-843.

## Definition of done

- All five stories' acceptance criteria pass; every changed assertion is named in its story's
  notes.
- The owner's console scenario (AC5 of KAR-26.1) is covered by an integration test on real git.
- `pnpm dev` on a clean checkout serves an app whose composer can name this machine's adapters.
- Lint guards pass; no per-instance design overrides; bundle budget (NF3) holds.
- **Performed, not asserted:** the owner restarts their daemon on master, watches the
  `WorktreePathOccupiedError` loop not come back, and walks the settings and new-run pages
  against the blueprint on both themes.
