# EPIC-26 flows — run clean

> BA-level scenarios for [EPIC-26](../epics/EPIC-26-run-clean.md). Same working agreement as
> EPIC-25's flow file: the TDD exception covers **visual** work only — pixel placement, spacing,
> colour. Everything else is test-first, without exception. A defect that shipped gets a test
> that would have caught it, written before the fix.

## KAR-26.1 — An interrupted teardown finishes instead of haunting the run

**EPIC-26-S01 — an unlocked registered worktree at the node's own path is a finished teardown, then a fresh worktree**
- **Given** a worktree registered at `<runRoot>/runs/r1/worktrees/n1` with no lock reason (git reports no `locked` record)
- **And** the worktree is clean
- **When** `provision` is called for run `r1`, node `n1`, at that path
- **Then** the worktree is removed without `--force`, `workspace.worktree_removed` lands, `git worktree add` runs, `workspace.worktree_created` lands, and the result is a fresh worktree — no `WorktreePathOccupiedError`.

**EPIC-26-S02 — the dirty variant salvages before it removes**
- **Given** the same unlocked registered worktree, dirty
- **When** `provision` runs
- **Then** the salvage sequence runs in KAR-07.4's order — capture, commit, then the single force — before removal, and provisioning proceeds; nothing in the sequence is skipped because provisioning (rather than completion) triggered it.

**EPIC-26-S03 — a worktree locked with this node's own reason is still reused, not torn down**
- **Given** a worktree at the node's path locked `DeFlow run=r1 node=n1`
- **When** `provision` runs for `r1`/`n1`
- **Then** `workspace.worktree_reused` lands and no removal happens (KAR-25.8 AC2, regression-guarded).

**EPIC-26-S04 — a foreign lock still refuses, and the refusal now fails the node**
- **Given** a worktree at the node's path locked `DeFlow run=r2 node=n9`
- **When** the run is advanced
- **Then** `WorktreePathOccupiedError` is raised once, the node is recorded failed with the occupant named, and the run takes its normal node-failure path.

**EPIC-26-S05 — a refused occupancy is not retried on the next tick**
- **Given** S04 has happened
- **When** the drive loop ticks again
- **Then** no new provisioning attempt is made for that node and no second `WorktreePathOccupiedError` is logged.

**EPIC-26-S06 — an operator's own lock reason is foreign**
- **Given** a worktree at the node's path locked with reason `on holiday`
- **When** `provision` runs
- **Then** it is refused as foreign (S04's path), and the occupant description quotes the operator's reason rather than inventing an owner.

**EPIC-26-S07 — the occupant message never points at itself**
- **Given** each of: an unlocked entry, a foreign DeFlow lock, an operator lock
- **When** the refusal or teardown-completion message is composed
- **Then** no message describes the path as "belonging to" a worktree at that same path; the unlocked case names the interrupted removal, the locked cases name the owner or quote the reason.

**EPIC-26-S08 — the owner's console scenario, end to end on real git**
- **Given** a real repository whose worktree was provisioned, unlocked by teardown, and whose `git worktree remove` was refused (dirty), then a daemon restart
- **When** the run advances
- **Then** the salvage commit exists, the worktree is recreated, `workspace.worktree_created` lands, and the log contains zero `WorktreePathOccupiedError` lines.

## KAR-26.2 — The dev daemon knows its machine

**EPIC-26-S09 — the dev composition root passes machine identity to boot**
- **Given** `packages/daemon/src/main.ts` as shipped
- **When** the boot options it constructs are inspected
- **Then** `providerRoots` and `probeProviders` are present, built from `process.env`, matching `up.ts`'s construction.

**EPIC-26-S10 — routes are known under the dev daemon**
- **Given** a daemon booted the way `main.ts` boots it, with a `PATH` containing a resolvable provider
- **When** `GET /api/providers/routes` is called
- **Then** the answer is `known: true` with that provider's row.

**EPIC-26-S11 — the composer lists adapters under the dev daemon**
- **Given** S10's daemon serving the web app
- **When** the new-run page renders
- **Then** the adapter control shows rows, not the "has not been told which machine" sentence.

**EPIC-26-S12 — admission admits under the dev daemon**
- **Given** S10's daemon
- **When** a run naming the resolvable provider is submitted
- **Then** admission evaluates it on the merits (admits, or refuses with a machine fact) — never refuses for want of a resolution thunk.

**EPIC-26-S13 — the two composition roots cannot drift silently**
- **Given** the guard test
- **When** `up.ts` passes a machine-identity boot option that `main.ts` does not
- **Then** the guard fails, naming the option.

**EPIC-26-S14 — booting without roots still answers known:false**
- **Given** a daemon booted with no `providerRoots` (a fixture, a spec)
- **When** `GET /api/providers/routes` is called
- **Then** `known: false` — the endpoint's contract is unchanged.

## KAR-26.3 — The composer's adapter control is the blueprint's

**EPIC-26-S15 — the control lives in the bottom bar**
- **Given** the new-run page with adapters known
- **When** it renders
- **Then** the adapter choice is a button in the composer's bottom bar showing the current selection, beside Run — and no adapter content renders outside that control.

**EPIC-26-S16 — the popover groups by runtime**
- **Given** resolutions on two routes/runtimes
- **When** the control opens
- **Then** options appear under per-runtime section labels, one row per option, the selected row marked.

**EPIC-26-S17 — rows carry only daemon facts**
- **Given** what `GET /providers/routes` returns for a row
- **When** the row renders
- **Then** every rendered field maps to a field in the response; no context-window or throughput figure appears unless the daemon sent one.

**EPIC-26-S18 — an unavailable adapter is a disabled row with the daemon's reason**
- **Given** a row with `available: false` and a reason
- **When** the popover renders
- **Then** the row is visible, disabled, and carries the daemon's sentence.

**EPIC-26-S19 — the unknown-machine state lives inside the control**
- **Given** `known: false`
- **When** the page renders
- **Then** the existing sentence appears inside the control (popover body or disabled button description) and no floating card exists in the page flow.

**EPIC-26-S20 — no usable adapter, same placement**
- **Given** `known: true` with zero available rows
- **When** the page renders
- **Then** the empty state is inside the control, Run stays disabled.

**EPIC-26-S21 — Run's gating is unchanged**
- **Given** the page
- **When** no available adapter is selected / one is
- **Then** Run is disabled / enabled exactly as before this story.

**EPIC-26-S22 — overlay behaviour matches the house popovers**
- **Given** the open control
- **When** Escape is pressed or focus leaves
- **Then** it closes and returns focus like every other Reka popover; both themes pass the contrast bar on the new surfaces.

## KAR-26.4 — Settings at the blueprint's density

**EPIC-26-S23 — a runtime row is one row**
- **Given** the settings page with routes known
- **When** a runtime row renders
- **Then** it shows avatar, name, mono subline, status dot + short word, toggle in a single row's rhythm — no inline caveat paragraph.

**EPIC-26-S24 — the full health sentence is one disclosure away, verbatim**
- **Given** a runtime row
- **When** its disclosure opens
- **Then** the daemon's health sentence appears word-for-word as today.

**EPIC-26-S25 — the short state word composes no new claim**
- **Given** each combination of `available`/`enabled`/route-presence the daemon can send
- **When** the row's state word renders
- **Then** it is a total mapping from those fields (table-tested), and no combination renders a word the facts do not support.

**EPIC-26-S26 — detected-cannot-be-removed moves into the disclosure**
- **Given** a `detected` runtime row
- **When** it renders closed / open
- **Then** the caveat is absent from the list / present verbatim in the disclosure.

**EPIC-26-S27 — an issue-tracker row is one row with one chip**
- **Given** each `resolveConnectorStatus` outcome
- **When** the connector row renders
- **Then** service, mono subline, and exactly one status chip — the status logic itself untouched (existing table tests still green).

**EPIC-26-S28 — GitHub's provenance survives, demoted**
- **Given** the GitHub row's disclosure
- **When** it opens
- **Then** the authorised-by/held-by/stored-in/DeFlow-keeps facts and the `gh auth login` command are all present, intact.

**EPIC-26-S29 — execution defaults render only real config fields**
- **Given** `GET /api/config`'s actual shape
- **When** the panel renders
- **Then** every control maps to a real field, edits still `PATCH` whole top-level keys, and no blueprint-only slider exists.

**EPIC-26-S30 — both themes hold the bar**
- **Given** the reworked page on light and dark
- **When** contrast is computed on the new surfaces
- **Then** the EPIC-24 bar passes; all colour/spacing changes live in tokens or `ui/`.

**EPIC-26-S31 — no fact-assertion silently dies**
- **Given** the pre-existing DOM assertions about these panels
- **When** the story lands
- **Then** each still passes or its change is named in the story notes.

## KAR-26.5 — The frame's remaining blueprint gaps, audited and closed

**EPIC-26-S32 — the audit exists and is total**
- **Given** blueprint screenshots 01–05
- **When** the audit document is read
- **Then** every visible element appears with a verdict — `matches`, `gap closed here`, or `out of scope: <reason>` — and every out-of-scope reason is one of the epic's standing ones.

**EPIC-26-S33 — every `gap closed here` is closed**
- **Given** the audit's closed list
- **When** the frame renders
- **Then** each listed gap matches the blueprint, verified per item.

**EPIC-26-S34 — the rail's environment chip**
- **Given** the rail
- **When** it renders
- **Then** the brand row carries the environment chip the blueprint draws, fed by a real daemon fact.

**EPIC-26-S35 — the dashed new-project affordance**
- **Given** the rail at any scope
- **When** the new-project affordance is used
- **Then** KAR-25.6's modal opens — one modal, no second form.

**EPIC-26-S36 — the footer identity area only if a fact exists**
- **Given** whatever identity fact the daemon exposes (or none)
- **When** the rail renders
- **Then** the footer shows exactly that fact, or is absent — never a placeholder name.

**EPIC-26-S37 — no behaviour rides along**
- **Given** the story's diff
- **When** routes, stores, and daemon calls are compared before/after
- **Then** they are unchanged except where an audit item names them.

**EPIC-26-S38 — themes and tokens, same bar**
- **Given** every surface the audit touched
- **When** both themes render
- **Then** the contrast bar passes and no per-instance override exists.
