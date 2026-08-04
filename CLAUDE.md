# DeFlow — working notes for Claude

## Linear is the delivery SSOT

As of 2026-08-04, **Linear is the source of truth for delivery status, priority, and
sequencing** on this project — not the markdown under `docs/delivery/`. The markdown stays in the
repo as the detailed reference (full acceptance criteria, BA-level Given/When/Then scenarios,
architecture links, the TDD working agreement) and is not deleted, but its **Status** fields and
**board.md** rollups should be treated as a point-in-time snapshot, not live state. When the two
disagree on status/priority/sizing, Linear wins.

- **Workspace:** team `MET`, project `DeFlow` (`https://linear.app/metune/project/deflow-9816c8369a25`).
- **Epics** (`EPIC-00` … `EPIC-18`) are parent issues labeled `Epic`, one per
  `docs/delivery/epics/EPIC-NN-*.md` file, each assigned to a same-named Milestone
  (`EPIC-NN — Title · <workstream>`) so the milestone view mirrors the roadmap's W0–W12
  workstreams.
- **Stories** (`KAR-NN.n`) are sub-issues of their epic, in the same milestone, titled
  `KAR-NN.n — <title>`. Their description carries the user story, acceptance criteria (copied
  verbatim from the epic file — this is the acceptance-criteria record), PRD requirement ids, a
  plain-text "Depends on" note, and a "Verified by" scenario count linking back to the matching
  `docs/delivery/flows/EPIC-NN-*-flows.md` file — the BA-level scenarios themselves were **not**
  duplicated into Linear as separate issues (635 of them; too granular to manage as issues). Read
  the flow file when you need the actual Given/When/Then.
- **Dependencies** are wired as real Linear `blockedBy`/`blocks` relations between issues, derived
  from each epic's `Depends on` field and each story's own `Depends on` field in its epic file.
- **Labels:** `Size: XS|S|M|L` (DeFlow's own sizing vocabulary — see `docs/delivery/README.md`
  §6), `Scope-cut candidate` (stories the plan flags as droppable under schedule pressure, e.g.
  `KAR-05.8`, `KAR-17.9`).
- **Priority mapping:** PRD/plan `P0 → Linear High(2)`, `P1 → Medium(3)`, `P2 → Low(4)`.
- **State mapping:** `Not started → Backlog`, `Ready → Todo`, `In progress → In Progress`,
  `Blocked → Todo` (blocked-ness is expressed via a `blockedBy` relation and a comment explaining
  why, not a separate Linear state), `In review → In Review`, `Done → Done`.

### Working with Linear day to day

Use the connected `mcp__claude_ai_Linear__*` tools directly (search for them with `ToolSearch` if
their schemas aren't loaded yet — e.g. `select:mcp__claude_ai_Linear__save_issue`).

- **Starting/finishing a story:** update its Linear issue's `state` (and `priority`/`labels` if
  they changed) via `save_issue`. Don't hand-edit the Status column in `board.md` for this — it's
  now stale by design.
- **Progress notes:** post a comment on the issue via `save_comment` rather than editing the epic
  file's prose. Keep it moderate — a short note on what happened or why something's blocked, not a
  transcript. Comments already exist on: every epic issue (why it matters + biggest risk) and any
  story that's `Blocked` or a `Scope-cut candidate`.
- **New story / new epic / re-scoping / splitting an `XL` story:** these are plan changes. Follow
  `docs/delivery/README.md` §9 ("Changing the plan") in the markdown **first** — it's still the
  authored plan — then create/update the matching Linear issue(s) so Linear reflects it. Don't
  silently do one without the other.
- **Querying what's next:** prefer Linear (`list_issues` filtered by team/project/state/milestone)
  over reading `board.md`'s status columns, since Linear is what's kept current. `board.md`'s
  *structural* content (the dependency graph, the PRD coverage matrix, the traceability check) has
  no Linear equivalent and is still the right place to look.
- **Acceptance criteria / test plans / scenarios:** still authored and read in the markdown
  (`docs/delivery/epics/*.md`, `docs/delivery/flows/*.md`). Linear's story description carries a
  copy of the acceptance criteria for visibility, but the epic file is canonical if they ever
  drift — fix the drift by re-copying into Linear, not by trusting Linear's copy over the file.

### Repo state

This repo is currently docs-only (`docs/` + this file) — no package manifest, no source tree yet.
`EPIC-00`/`EPIC-01` (foundation spikes, dev environment) are the first work; see
`docs/delivery/README.md` and `docs/delivery/17-roadmap.md` for how to pick up from here.
