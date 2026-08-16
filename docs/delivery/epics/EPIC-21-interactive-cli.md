# EPIC-21: Interactive CLI — a real terminal app, not a background command

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-21-interactive-cli-flows.md)

|                      |                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-21                                                                                                                                                                                                                                               |
| **Status**           | Not started                                                                                                                                                                                                                                           |
| **Priority**         | P1                                                                                                                                                                                                                                                    |
| **Milestone**        | M1                                                                                                                                                                                                                                                    |
| **Workstream**       | W16 — created in Linear as `MET-795` on 2026-08-13, markdown authored 2026-08-16                                                                                                                                                                      |
| **Size**             | ~9 days across 5 stories                                                                                                                                                                                                                              |
| **Depends on**       | EPIC-13 (the human-gate and interjection mechanisms, which already exist), EPIC-15 (the event stream), EPIC-18 (KAR-18.3's `run` command and KAR-18.9's presentation layer), EPIC-19 (KAR-19.4's output tail, KAR-19.9's live progress, KAR-19.12's gate block and `deflow answer`), EPIC-20 (the `deflow` name), EPIC-22 (KAR-22.5's `gateAnswerRequest`, the one answer path this becomes the second consumer of) |
| **Blocks**           | Nothing. Every capability it reaches is already reachable — by a second command in a second terminal, or by a browser. This epic is about the cost of reaching them, not about whether they can be reached                                             |
| **PRD requirements** | F8.1, F8.2, F8.3, F8.5, F9.1, F10.1, F10.3, NF5, NF8, NF9, NF10                                                                                                                                                                                       |
| **Architecture**     | [11-api-and-realtime.md §6, §7.4, §7.5](../../11-api-and-realtime.md) (the routes this is a client of), [13-cli-and-daemon.md](../../13-cli-and-daemon.md), [14-testing-strategy.md §2, §8, §9](../../14-testing-strategy.md) (the levels every scenario here declares) |

## Goal

At the end of this epic, `deflow run` is something an operator **sits in front of**. The plan
appears as it forms, node states change on screen, the agent's own output streams past, and the
cost accrues in a region that stays where it was put. When the run stops to ask a question, the
answer is a keypress in that same window. When the agent goes the wrong way, a typed line steers
it. When it has to stop, one key stops it.

And when stdout is not a terminal, every one of those things is absent and the command prints
exactly what it prints today.

## Why this matters

**Asked for by the owner on 2026-08-12**, in their own words: they expected _"a rendered
[interface], similar to CLI apps like codex, claude, gemini, so that user can interact with it, and
see the output, rather than just a command that runs something in the background."_

The 2026-08-13 by-hand run is why it is not cosmetic. `deflow run` printed one line and then
nothing at all for seven minutes while the daemon retried a failing turn every 31 seconds. KAR-19.9
fixed the silence and KAR-19.12 fixed the invisible gate, so the command is no longer mute — but
the interaction model did not change. It is still **fire-and-watch**: a transcript scrolls past,
and every verb an operator might want is somewhere else.

Concretely, today, in a terminal:

- The run stops at the F1.3 spec gate. The terminal prints a block telling the operator to open a
  **second terminal** and type `deflow answer <runId> --gate <node> --option <id>` — a command
  carrying a 29-character run id — or to open a browser.
- The agent starts writing the wrong file. There is **no CLI path to interjection at all**. The
  daemon has had one since KAR-13.3 (`POST /api/runs/:id/interject`,
  `packages/daemon/src/human/interject.ts`), and no command in `packages/cli/src/bin.ts` reaches
  it. F8.2 is _"interject at any time"_ and from a terminal the answer is currently never.
- The run needs to stop. `deflow cancel <runId>` — again, second terminal, same run id — or two
  Ctrl-Cs inside three seconds, which is the only interactive verb the command has.
- The whole state of the run is whatever has not yet scrolled off the top.

**Every one of those capabilities exists and works.** This epic builds no mechanism. It builds the
surface that makes the existing mechanisms reachable from where the operator already is, and the
honest thing to say about its priority is that it is `P1` for exactly that reason: nothing here is
in M1's definition of done, because everything here can already be done. What it changes is the
number of windows and the amount of copy-paste between the operator and a run they are watching —
which is the difference between a tool used three times a week and one used once.

## The risk this epic is designed around

**The largest risk is building a second presentation layer beside KAR-18.9's**, and it is named
here rather than left to discipline because it is the natural thing to do. A TUI wants its own
box-drawing, its own colours, its own width logic, and within a week `deflow doctor` and
`deflow run` look like two different tools again — which is precisely the state KAR-18.9 was built
to end.

So the layer this epic extends is named, with its files:

| File                                | What it already owns                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/render/report.ts` | `Report`/`ReportRow`/`ReportSection`, `renderReport`, `worstState`, `nextAction`, the summary block     |
| `packages/cli/src/render/layout.ts` | `wrapDetail` and `columnWidth` — wrapping that never truncates, and column alignment                    |
| `packages/cli/src/render/style.ts`  | `createStyle`, `shouldStyle`, `terminalWidth`, `glyphCharset` — the once-per-process styling decision   |
| `packages/cli/src/render/glyphs.ts` | `GLYPH_SETS`, `TRANSCRIPT_GLYPHS`, `PART_SEPARATORS` — one glyph vocabulary, UTF-8 and ASCII            |
| `packages/cli/src/run/render.ts`    | `createRenderer`, the `RunRenderer` interface — `event`, `io`, `gate`, `final`, human and `--json`      |

And `packages/cli/test/render-guard.test.ts` is the test that keeps it true: no ANSI escape
literal, no status glyph and no terminal-width derivation outside `packages/cli/src/render/`.

**This epic adds exactly one module to that directory** — `render/screen.ts`, the frame writer that
owns cursor motion — and extends the guard to cover it. Everything else composes what is listed
above. A story in this epic that needs a new colour, a new glyph or a new wrapping rule is a story
that has gone wrong, and the guard will say so before a reviewer has to.

**The second risk is a TUI that is unusable over ssh or in a narrow terminal**, and the design
answer is structural rather than defensive: the session is **not** an alternate-screen application.
The transcript keeps scrolling exactly as it does now, and the live region is a **footer pinned
below it**, redrawn in place. Scrollback survives, `deflow run | tee` still works, a 40-column
split pane still reads, and the fallback when the terminal cannot do any of it is not a degraded
TUI but the stream — which is a thing that already works. KAR-21.5 is that ladder, tested at three
terminal sizes with a real pty.

## The daemon already does all of this — the terminal is a client

Stated with paths, because the expensive failure here is a story reimplementing a decision that has
a home:

| What                          | Where it lives                                                                                                          | The terminal's part                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The event stream              | `followRun` in `packages/cli/src/index.ts`, over `@DeFlow/web`'s `hydrateRun`/`connectStream` (EPIC-15, KAR-18.3)       | Subscribes. There is no second protocol client and this adds none        |
| The agent's own output        | `packages/cli/src/run/io-follow.ts`, polling `GET /runs/:id/nodes/:nodeId/io` (KAR-19.4)                                | Renders it through `RunRenderer.io`, unchanged                           |
| What gate is open             | `pendingGate` over the reduced `RunState` (`packages/core/src/pending-gate.ts`)                                         | Reads it. It does not match on `human.requested` a second way            |
| **Which request answers it**  | `gateAnswerRequest` in `packages/core/src/gate-answer.ts` (KAR-22.5 AC2)                                                | **Third caller, second surface.** It builds no route and no body itself  |
| What an answer *means*        | `POST /runs/:id/spec/{approve,reject,abandon}` (KAR-10.3) and `POST /runs/:id/nodes/:nodeId/respond` (KAR-13.1)         | Forwards refusals verbatim. `planHumanResponse` owns that vocabulary     |
| Interjection                  | `POST /api/runs/:id/interject`, `interjectIntoNode` (`packages/daemon/src/human/interject.ts`), `planInterjection` (KAR-13.3) | Posts text and a mode; renders the `202`'s `delivery` and `alternative`  |
| Whether steering is supported | The `provider_capabilities` row for the provider the node was **scheduled onto**, read by the daemon                    | Never guesses it. It shows what the daemon answered                      |
| Cancelling                    | `cancelRun` in `packages/cli/src/run/cancel.ts` → `POST /runs/:id/cancel` (KAR-19.6)                                    | Calls it. The double-Ctrl-C path already does                            |

KAR-22.5's row is the one worth reading twice. It built **one** answer path precisely so that a
second surface would not build a second one, and its own module note says so: _"a second private
copy is how the day a fifth spec decision is added ends with one surface still answering the old
way."_ The terminal session is that path's second consumer. If a reviewer finds a `/spec/approve`
string literal anywhere in `packages/cli/src/run/session/`, KAR-21.3 was built wrong.

## Testability is the design constraint

A TUI that can only be checked by a human looking at it cannot be built test-first, and this epic
is not allowed an exemption from [README §3](../README.md#3-the-tdd-working-agreement). So the
shape is chosen for testability before it is chosen for anything else, and every story states how
it is proven:

1. **The frame is a pure function.** `(RunState, SessionState, Style) → readonly string[]`. No
   clock read, no `process.*`, no I/O. Most of this epic's assertions are made against its return
   value at a stated width, and cost nothing.
2. **The screen is an interface with a headless implementation.** `createHeadlessScreen()` records
   every frame it was handed instead of writing bytes. "What was on screen after these six events"
   is an array comparison.
3. **Key decoding is a pure function over bytes.** Terminals send `\u001B[A`, sometimes split
   across two `data` events. That is a table test, not a person pressing an arrow key.
4. **A real pty at a fixed size is the level for anything about the terminal itself** — raw-mode
   restoration, resize, exit hygiene. `@lydell/node-pty` is already a dependency of
   `packages/cli` and already driven by `packages/daemon/src/pty/pty-session.ts`, so this is an
   existing mechanism, not a new one.
5. **The non-TTY path is asserted as a golden, not as an intention.** The bytes `deflow run`
   writes to a pipe today are the bytes it writes after this epic, and a test that compares them is
   what makes that a fact.

## Scope

**In scope:**

- A live session region under `deflow run` on a TTY: the plan as it forms, node states, the
  running node's elapsed time, the run's cost cells, and the open gate — redrawn in place below a
  transcript that still scrolls.
- Keyboard input, raw mode, and giving the terminal back on every exit path.
- Answering a human gate inline — the F1.3 spec gate and any plan `human` gate — through
  KAR-22.5's `gateAnswerRequest`.
- Interjecting into the running node, and cancelling the run, from the same session.
- An honest degradation ladder: not a TTY, `TERM=dumb`, `NO_COLOR`, a non-UTF-8 locale, a narrow
  window, a short window, a resized window, and a burst of events over a slow link.

**Out of scope:**

- **Any new daemon capability.** Every route this epic calls exists and is tested. If a story here
  needs a route that does not exist, it is the wrong story and the route belongs to the epic that
  owns that mechanism.
- **A second event-stream client.** `followRun` is the one, per KAR-18.3's own constraint.
- **An alternate-screen full-window TUI.** Deliberately, and the reason is in the risk section: it
  costs scrollback and it is the shape that fails over ssh. If the pinned-footer shape turns out to
  be insufficient after this epic is used, that is a new epic with a recorded reason, not a quiet
  redesign inside this one.
- **A REPL, a chat prompt, or `deflow` with no arguments opening a session.** Starting a run
  conversationally is EPIC-22's composer, on the web. This epic makes an **existing** run
  interactive; it does not add a second way to create one.
- **Multi-run views.** One session watches one run, like `deflow run` does now. The approval queue
  across runs (F8.3) is a surface EPIC-17 owns; what this epic serves of F8.3 is answering the gate
  in front of you.
- **Mouse input, scrollback capture, or a scrollable pager inside the frame.** The terminal's own
  scrollback is the scrollback, which is the whole reason for the pinned-footer shape.
- **Windows.** NF5 is unchanged: macOS and Linux at M1. Nothing here is Windows-specific, and
  nothing here is tested there.
- **Notifications** (F8.4, P1, M2) and **replay** (F10.10, P1, M2).

## Definition of Ready (epic level)

- [ ] EPIC-19 KAR-19.4, KAR-19.9 and KAR-19.12 are Done: the output tail, the live progress lines
      and the gate announcement block exist, so this epic extends three things rather than
      inventing them.
- [ ] EPIC-18 KAR-18.9 is Done and `packages/cli/test/render-guard.test.ts` passes, because the
      guard is what makes "extend the layer" checkable rather than aspirational.
- [ ] EPIC-22 KAR-22.5 is Done, so `gateAnswerRequest` exists in `@DeFlow/core` and KAR-21.3 is its
      third caller rather than the module's author.
- [ ] EPIC-13 KAR-13.3 is Done: `POST /api/runs/:id/interject` answers, and its `202` carries
      `delivery` and — for an adapter with no mid-turn steering — `alternative`, which KAR-21.4
      renders instead of deciding.
- [ ] `@lydell/node-pty` loads on the development machine, confirmed by `deflow doctor`'s
      `memory.pty` check. If it does not, KAR-21.2's and KAR-21.5's pty scenarios have no runner
      and the epic starts by saying so rather than by skipping them.

## Definition of Done (epic level)

- [ ] All five stories are Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-21-interactive-cli-flows.md) is automated at
      the level it declares and passes on `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] `packages/cli/test/render-guard.test.ts` covers `packages/cli/src/run/session/` and
      `packages/cli/src/render/screen.ts`, and still finds no ANSI escape, no status glyph and no
      terminal-width derivation outside `packages/cli/src/render/`.
- [ ] **No route string and no request body for answering a gate exists anywhere under
      `packages/cli/src/run/session/`.** A source guard asserts it, because this is the one
      property KAR-22.5 was built to protect and the one a reviewer is least likely to notice.
- [ ] `deflow run` with stdout piped to a file produces bytes identical to the golden recorded
      before this epic began. `packages/cli/test/integration/run-json.test.ts` and
      `packages/cli/test/integration/terminal-output.test.ts` pass **unmodified**.
- [ ] A pty at 80×24, 40×12 and 8 rows each produce the behaviour KAR-21.5 declares, and in all
      three the terminal is returned to its pre-session state after exit — including after
      `SIGTERM`.
- [ ] **Performed, not asserted:** the owner watches one real run to completion in a terminal,
      answers its spec gate with a keypress, and interjects at least once. What they had to think
      about is written into KAR-21.5's notes and onto its Linear issue. A green suite is not
      evidence for this item; the epic exists because a green suite coexisted with a command that
      printed nothing for seven minutes.
- [ ] No `Unverified` claim is introduced by this epic without an entry in the open-risks register.

## User stories

### KAR-21.1 — A live session frame, redrawn in place

|                 |                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                           |
| **Priority**    | P1                                                                                                                    |
| **Size**        | M                                                                                                                     |
| **Depends on**  | EPIC-18 KAR-18.9 (the presentation layer this extends), KAR-18.3 (the `run` command it lives in), EPIC-19 KAR-19.9 (the progress lines it sits under), KAR-19.4 (the agent output it must not disturb) |
| **PRD**         | F9.1, F10.1, F10.3, NF8, NF9, NF10                                                                                    |
| **Verified by** | EPIC-21-S01, EPIC-21-S02, EPIC-21-S03, EPIC-21-S04, EPIC-21-S05, EPIC-21-S06, EPIC-21-S07, EPIC-21-S08, EPIC-21-S09   |

**As** an operator watching a run, **I want** a status region that stays on screen and updates,
**so that** I can see what the run is doing *now* without reading back up a transcript that has
scrolled past.

The design decision that makes this testable and makes it survive ssh is the same decision: the
frame is a **pure function of state**, and the screen is an **interface**. Nothing about what is
displayed requires a terminal to observe, and nothing about the terminal requires a person to
verify.

The frame is a footer, not a window. Events keep scrolling above it exactly as they do today —
this story is forbidden from changing one byte of `RunRenderer.event`'s output — and the footer is
erased and rewritten under them.

**Acceptance criteria**

1. `packages/cli/src/render/screen.ts` is the only module in `packages/cli` that emits cursor
   movement or erase sequences, and `packages/cli/test/render-guard.test.ts` is extended to assert
   it: a cursor-motion or erase literal anywhere else under `packages/cli/src` fails the guard. The
   guard's three existing rules are unchanged and still pass — `screen.ts` spells no glyph, picks
   no colour and derives no width.
2. A `Screen` has two operations, `render(frame: readonly string[])` and `close()`, and
   `createHeadlessScreen()` returns one that records every frame it was given rather than writing
   bytes. Every "what was on screen" assertion in this epic is made against those recordings.
3. The frame is produced by a pure function in `packages/cli/src/run/session/view.ts` taking
   `(RunState, SessionState, Style)` and returning lines. It reads no clock, touches no
   `process.*`, and performs no I/O — elapsed time and wall-clock arrive as values the caller
   measured through the injected `Clock` (NF9).
4. The frame carries five things: the run id with its `RUN_STATUS_LABELS` status; one row per plan
   node with its status glyph from `TRANSCRIPT_GLYPHS`; the running node's elapsed time via
   `formatDuration`; the run's cost from `state.budget.run.costUsd` via `formatCost` — the four
   cells named, never summed across substances; and the open gate's summary when `pendingGate`
   returns one. Each of those five is an existing function; none is re-derived here.
5. A redraw erases **exactly** the number of lines the previous frame occupied — the count returned
   by the previous render, not a constant — so a frame that grew leaves no gap and a frame that
   shrank leaves no orphan row. Rendering a frame identical to the previous one writes zero bytes.
6. Transcript output and frames never interleave: an event line is emitted by erasing the frame,
   writing the line, and re-rendering. The bytes `RunRenderer.event`, `RunRenderer.io` and
   `RunRenderer.final` produce are unchanged, which
   `packages/cli/test/integration/terminal-output.test.ts` continues to pin unmodified.
7. No frame line exceeds `style.width`, and the frame never occupies more than a stated fraction of
   the terminal's rows. A plan with more nodes than fit shows the running and waiting ones and a
   `+N more` count rather than a row cut mid-token.
8. When stdout is not a TTY no `Screen` is constructed, no cursor byte is written, and the command's
   output is byte-identical to a golden recorded before this story.
9. The session's own state — which region is focused, whether an input is open — lives in one
   `SessionState` value that `view.ts` reads and never writes. Nothing about what is on screen is
   stored in a module-level variable, because a screen state that outlives a test is a screen state
   no test can set up.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                | Red when                                                                                                                                                     |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | unit        | Golden of `view.ts`'s frame at 80 columns for a state with four nodes — one running, one failed, one pending — an open gate and two cost cells                      | The frame is assembled by string concatenation with its own padding, so its status column does not line up with the transcript's and one screen reads as two |
| 2   | unit        | The same state rendered at 40 and at 20 columns; assert no line exceeds the width except a single unbreakable token, and that no row is truncated                  | The frame is built with `padEnd` against an assumed 80, so a 40-column split pane wraps every row into two and the region becomes unreadable                 |
| 3   | unit        | Render frame A (5 lines), then B (7 lines), then A again through the headless screen; assert the emitted control stream erases exactly the previous line count      | The writer erases a constant, so a shrinking frame strands the last two rows of the old one on screen for the rest of the run                                |
| 4   | unit        | Render the identical frame twice; assert the second call writes zero bytes                                                                                          | Every event triggers a full repaint, so a chatty run flickers and emits kilobytes a second for no change                                                    |
| 5   | integration | Drive a scripted event sequence through `run/render.ts` with the screen enabled and with it disabled; assert the non-frame bytes are identical                       | The frame writer takes over the transcript too, and `deflow run`'s existing output silently changes underneath the goldens that pin it                       |
| 6   | unit        | A 40-node plan at 24 rows; assert the running nodes, the gate and the `+N more` count are all present and the frame fits the stated row budget                       | A large plan pushes the gate line off the top of the region, which is the one line the operator was waiting for                                              |
| 7   | unit        | Extend the render guard with a fixture source containing `\u001B[2K`; assert the guard fails on it                                                                   | The guard is extended in name only, and the second module that writes cursor motion arrives unnoticed                                                       |
| 8   | integration | stdout not a TTY; assert zero cursor-motion bytes and a byte-identical golden against the pre-story output                                                            | The session is entered whenever `run` is invoked, and every redirected log fills with escape sequences                                                       |
| 9   | unit        | Construct two sessions in one process with different `SessionState`s; assert their frames are independent                                                            | Screen state lives in a module-level variable, and the second test in the file sees the first one's open input box                                           |

**Notes / risks** — the honest hazard is line-count bookkeeping: the number of lines a frame
*occupied* is not the number of lines it *contains* once a row wraps at the terminal's width. The
count that must be tracked is the post-wrap one, which is why `view.ts` returns already-wrapped
lines and the screen never wraps anything itself. Test 3 is aimed exactly there, and a scenario
with a deliberately over-width row is the one that catches it.

---

### KAR-21.2 — The session reads the keyboard, and always gives the terminal back

|                 |                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                              |
| **Priority**    | P1                                                                                                       |
| **Size**        | S                                                                                                        |
| **Depends on**  | KAR-21.1 (the frame the keys act on), EPIC-18 KAR-18.3 (the Ctrl-C contract this must not break)          |
| **PRD**         | F8.1, NF5, NF8                                                                                           |
| **Verified by** | EPIC-21-S10, EPIC-21-S11, EPIC-21-S12, EPIC-21-S13, EPIC-21-S14, EPIC-21-S15, EPIC-21-S16, EPIC-21-S17   |

**As** an operator, **I want** keys to do something while a run is being watched, **so that** the
terminal is an application rather than a log — **and** I want my shell back exactly as I left it
when it ends.

The second half is the larger half of this story. Raw mode is a **global mutation of the operator's
terminal**: a process that enters it and dies without restoring leaves a shell with no echo and no
line editing, and the operator's remedy is `reset` or a new window. That is a worse outcome than
anything this epic adds, so restoration is asserted on every exit path — including the ones nobody
writes tests for, which is why three of the eight scenarios are a pty being killed.

**Acceptance criteria**

1. Key decoding is a pure function in `packages/cli/src/run/session/keys.ts`: a byte stream in, a
   typed `Intent` out — `answer`, `interject`, `cancel`, `detach`, `select`, `none`. It never
   references `process.stdin`.
2. It decodes what a terminal actually sends: printable bytes, control codes for Ctrl combinations,
   and multi-byte escape sequences — **including a sequence split across two `data` events**, which
   is what a slow link produces. The decoder holds a buffer; it is not a switch on the first byte.
3. Raw mode is entered only when **stdin** is a TTY. The decision is made once and passed, never
   re-derived at a call site — KAR-18.9 AC7's rule, applied to input rather than output.
4. Raw mode is restored on every exit path: normal completion, a thrown error, `SIGINT`, `SIGTERM`,
   `SIGHUP`, and the event stream closing under the session. The restoration is registered in one
   place and is idempotent — calling it twice is not an error and does not restore twice.
5. Ctrl-C keeps KAR-18.3 AC3's contract exactly: the first press prints `detachSentence(runId)` and
   detaches, a second press inside `DETACH_WINDOW_MS` cancels the run. The session adds no third
   meaning to it and reuses the same sentence rather than writing its own.
6. When stdin is not a TTY — CI, `< /dev/null`, a pipe — `setRawMode` is never called, no key is
   read, and `deflow run` behaves exactly as it does today. The key-hint line, which would name
   keys nothing can press, is not printed either.
7. An unrecognised key does nothing at all: no beep, no error line, no repaint.
8. The set of keys the session acts on and the set `keys.ts` decodes are the same set, asserted in
   both directions from the exported tables — so a key cannot be advertised and unhandled, or
   handled and undiscoverable.

**Test plan (TDD)**

| #   | Level               | Test                                                                                                                                                 | Red when                                                                                                                                                     |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | unit                | A table of byte sequences → intents, including `\u001B[A` delivered as `\u001B` then `[A` in two calls                                                | The decoder switches on the first byte, so an arrow key over a slow ssh link reads as Escape followed by a literal `[A` typed into the interjection box      |
| 2   | unit                | Both directions between the decode table and the action table; assert neither has an entry the other lacks                                             | A key is decoded and nothing handles it, so the hint line advertises a key that does nothing when pressed                                                    |
| 3   | integration (pty)   | Spawn `deflow run` under a pty at 80×24; capture the terminal's mode before and after a **normal** exit; assert equality                              | Restoration exists only on the happy path, which is the path that was never in danger                                                                        |
| 4   | integration (pty)   | The same, with the process killed by `SIGTERM` mid-run                                                                                                 | The restore is in a `finally` a signal never reaches, and a killed session leaves the operator with no echo and no Ctrl-C                                    |
| 5   | integration (pty)   | The same, with the session throwing after raw mode is entered                                                                                          | An unexpected error leaves the terminal raw, and the stack trace that would explain it is unreadable because nothing converts `\n` to `\r\n`                 |
| 6   | unit                | One Ctrl-C → `detachSentence(runId)` and detach; a second inside the window → the cancel path; assert against the existing constants                    | The session claims Ctrl-C for "close the UI", and a six-hour run is ended by a key that used to detach from it                                               |
| 7   | integration         | stdin not a TTY; assert `setRawMode` was never called and no key-hint line was printed                                                                 | The session calls `setRawMode` on a pipe, it throws, and `deflow run` in CI dies before the run starts                                                       |
| 8   | unit                | Feed an unmapped byte and a partial escape that never completes; assert no intent, no repaint and no error                                              | An unknown key produces an error line, so a stray keystroke fills the screen with complaints during a run                                                    |

**Notes / risks** — the restoration test is the one worth being fussy about. Asserting it from
inside the process proves nothing: the process is what is suspected. The mode is read from the
**pty master** after the child has exited, which is the only vantage point that can tell the truth
about what the child left behind.

---

### KAR-21.3 — Answer a gate without leaving the session

|                 |                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                            |
| **Priority**    | P1                                                                                                                                     |
| **Size**        | M                                                                                                                                      |
| **Depends on**  | KAR-21.1 (the frame the gate is shown in), KAR-21.2 (the keys that select), EPIC-22 KAR-22.5 (`gateAnswerRequest`), EPIC-19 KAR-19.12 (`deflow answer`, whose client this mirrors), EPIC-13 KAR-13.1 (the respond route), EPIC-10 KAR-10.3 (the four spec routes) |
| **PRD**         | F8.1, F8.3, F10.3, NF10                                                                                                                |
| **Verified by** | EPIC-21-S18, EPIC-21-S19, EPIC-21-S20, EPIC-21-S21, EPIC-21-S22, EPIC-21-S23, EPIC-21-S24, EPIC-21-S25, EPIC-21-S26, EPIC-21-S27       |

**As** an operator whose run has stopped to ask something, **I want** to answer it in the terminal
I am already looking at, **so that** approving a spec is a keypress rather than a second window and
a 29-character run id typed by hand.

Nothing about what an answer *means* is built here. **The one decision that could plausibly be
duplicated — which HTTP request answers which gate — was moved into `gateAnswerRequest`
(`packages/core/src/gate-answer.ts`) by KAR-22.5 for exactly this reason**, and its module note
says what happens otherwise: _"a second private copy is how the day a fifth spec decision is added
ends with one surface still answering the old way."_ This session is that function's third caller
and its second surface, and it adds no branch of its own.

**Acceptance criteria**

1. When `pendingGate(state)` is non-null the frame shows the gate: the node, `gate.prompt`
   verbatim, and one selectable row per entry in `gate.options` with its `label`. The option set
   comes from the gate; this file spells no option id of its own.
2. Selecting an option builds its request with
   `gateAnswerRequest({ runId, gate, optionId, text })` and POSTs the returned `path` and `body` to
   the daemon the session is already connected to, with `authorization: Bearer <token>` from the
   endpoint it already holds and `X-DeFlow-Submitted-By: cli`. **No route string and no request
   body is constructed under `packages/cli/src/run/session/`**, and a source guard asserts it.
3. An option that needs text — the F1.3 gate's `reject` — opens an inline single-line input, and
   nothing is sent while the text is empty. Escape abandons the input and leaves the gate open and
   unanswered.
4. `edit` is shown and is not submittable, and the reason shown is `SPEC_EDIT_NEEDS_A_DOCUMENT`
   from `@DeFlow/core` — the same sentence `deflow answer` prints and the browser's gate panel
   shows. Selecting it makes no request.
5. A refusal from the daemon is shown in the frame verbatim: an option a plan gate does not offer,
   a gate that closed while the keypress was in flight, a gate already answered.
   `planHumanResponse` owns that vocabulary and this forwards it. There is no retry and no
   re-send.
6. A gate answered **anywhere else** — the browser, a second terminal, a deadline policy — closes
   the prompt here, because the session learns it from the `human.responded` event already on the
   stream it is following (KAR-19.12 AC7). No polling and no reconnection.
7. While a request is in flight the option rows are inert and the frame says so, so two presses
   cannot become two answers for one gate.
8. A run holding more than one open gate answers the one `pendingGate` reports — the oldest — and
   when it closes the next one appears. The session does not invent an ordering of its own.
9. Under `--json`, or with stdout not a TTY, no gate is selectable, no key is read, and the gate
   announcement is exactly what `run/render.ts` emits today — the `DeFlow.cli.gate` object on
   stderr, unchanged.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                            | Red when                                                                                                                                                     |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | unit        | A session over a state with the F1.3 gate open; select `approve`; assert the recorded request equals `gateAnswerRequest`'s own output for the same arguments      | The session builds `/runs/:id/spec/approve` itself, and the day a fifth spec decision lands the terminal is the surface still answering the old way          |
| 2   | unit        | A source guard over `packages/cli/src/run/session/`: no `/spec/`, no `/respond`, no route template                                                                 | The route moves back into the session during a refactor and the two surfaces start drifting again, silently                                                 |
| 3   | unit        | A plan `human` gate offering three custom options; assert every one is selectable and no selectable row exists for an option the gate did not offer               | The option rows are hardcoded to the F1.3 four, so a plan gate offering `retry` shows three rows and none of them is it                                      |
| 4   | unit        | Select `reject` on the spec gate; assert nothing is sent with empty text, and that Escape leaves the gate open                                                     | A rejection is sent with no reason, and the next framing attempt is handed the same blank page that produced the spec that was just refused                  |
| 5   | unit        | Select `edit`; assert the frame shows `SPEC_EDIT_NEEDS_A_DOCUMENT` and that zero requests were made                                                               | The session posts `edit` to a route that does not exist, and the operator gets a 404 for a limitation somebody had already written a sentence about          |
| 6   | integration | A daemon refusing with `planHumanResponse`'s body; assert the sentence appears verbatim and exactly one request was made                                          | The refusal is retried, so one closed gate produces three identical complaints and the operator concludes the tool is broken                                 |
| 7   | integration | With the prompt open, deliver a `human.responded` on the stream; assert the prompt closes and a later selection sends nothing                                     | The terminal keeps offering a gate approved in the browser five minutes ago, and pressing approve posts against a gate that is closed                        |
| 8   | unit        | Two selections inside one in-flight request; assert exactly one request                                                                                           | Two answers are sent for one gate and the second is refused in a way that reads like a daemon bug                                                            |
| 9   | unit        | A state with two open gates; assert the frame offers `pendingGate`'s oldest, and that answering it reveals the second                                             | The session picks the newest gate, so the one blocking the most work is the one nobody is shown                                                              |
| 10  | integration | `--json` with stdout piped and stdin closed; assert the `DeFlow.cli.gate` object is unchanged, no key is read, and the process does not block                     | The interactive path is entered under `--json` and a CI job waits forever on a keypress that can never arrive                                                |

**Notes / risks** — the race in test 7 is the real one and is worth setting up properly: the
answer that arrives from elsewhere and the keypress that is already in flight can cross. The
session must be safe in both orders, and the reason it can be is that it holds no opinion of its own
about whether a gate is open — `pendingGate` over the reduced state is the only reader, exactly as
`watch()` in `packages/cli/src/run/run.ts` already does it.

---

### KAR-21.4 — Interject into the running node, and cancel, from the session

|                 |                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                |
| **Priority**    | P1                                                                                                                         |
| **Size**        | M                                                                                                                          |
| **Depends on**  | KAR-21.1 (the frame), KAR-21.2 (the keys and the input), EPIC-13 KAR-13.3 (the interject route and its refusals), EPIC-19 KAR-19.6 (`cancelRun`, the client this calls) |
| **PRD**         | F8.1, F8.2, F8.5, NF7, NF10                                                                                                |
| **Verified by** | EPIC-21-S28, EPIC-21-S29, EPIC-21-S30, EPIC-21-S31, EPIC-21-S32, EPIC-21-S33, EPIC-21-S34, EPIC-21-S35, EPIC-21-S36        |

**As** an operator watching an agent go the wrong way, **I want** to say something to it, and to be
able to stop the run, from the session I am already in, **so that** steering does not mean a second
terminal or waiting for the node to finish being wrong.

**F8.2 says _"interject at any time"_, and from a terminal the answer today is never.** The daemon
has had the mechanism since KAR-13.3 and no command reaches it. None of that mechanism moves here:
the decision is `planInterjection`'s, the capability lookup is the daemon's, and the delivery
outcome is something this story **renders** rather than computes.

That last point is the one to get right. `POST /api/runs/:id/interject` takes a `mode`, and answers
`202` with a `delivery` of `queued` or `unsupported`; `unsupported` is an outcome and not an error —
the operator did nothing wrong and retrying will not help — and it carries a `message` and an
`alternative` mode that does work. So the session sends a mode and shows the answer. It does not
read `provider_capabilities`, and it does not decide that a run "looks steerable".

**Acceptance criteria**

1. An interject key opens a single-line input in the frame; Enter sends, Escape abandons and sends
   nothing. The target node is the one the reduced state says is running — the operator never types
   a node id, because a node id is DeFlow's vocabulary and not theirs.
2. The request is one POST to `/api/runs/:id/interject` carrying the text, the node id from the
   projection, and `ifLastSeq` set to the seq this session last rendered — the stale-cursor guard
   KAR-13.3 AC6 provides, used rather than omitted, because a session is exactly the surface whose
   view can be behind the ledger.
3. A `202` with `delivery: 'queued'` is shown as queued. A `202` with `delivery: 'unsupported'`
   shows the daemon's own `message` and names its `alternative` mode, and offers to re-send with
   it — one keypress, one further request, no automatic retry.
4. When no node is running, the key is inert: one explanatory line in the frame and zero requests.
   An interjection recorded against a node that has finished is an audit trail implying something
   happened.
5. A refusal — `node_not_found`, `node_not_running`, `use_respond`, `empty_text`, `stale_cursor` —
   is shown as the daemon's own `message`, verbatim, once, with no retry. `use_respond` in
   particular directs the operator to the gate answer KAR-21.3 provides, in the daemon's words.
6. An accepted interjection appears in the transcript when its `human.interjected` event arrives on
   the stream, rendered by the existing transcript renderer. The session prints no optimistic line
   of its own before the ledger has it, so an interjection that was refused cannot look like one
   that was accepted.
7. Cancelling from the session calls `cancelRun` in `packages/cli/src/run/cancel.ts` — the same
   client `deflow cancel` and the double-Ctrl-C path already use — and asks for confirmation
   first, defaulting to **no** on a bare Enter, because it ends a run that may have hours in it.
8. A confirmed cancel shows the outcome `cancelRun` returned and **keeps the session open** until
   the run reaches a terminal state, so the operator sees how it ended rather than losing the screen
   at the moment of the decision.
9. Neither key exists when stdin is not a TTY, and neither is reachable under `--json`.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                          | Red when                                                                                                                                                     |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | unit        | Type into the input and press Enter; assert one POST to `/api/runs/<id>/interject` with the text, the projection's node id and an `ifLastSeq`                    | The node id is taken from a variable the session updated itself, so an interjection lands on the node that *was* running when the frame was last painted     |
| 2   | unit        | A `202` with `delivery: 'unsupported'`; assert the daemon's `message` and `alternative` are both shown and nothing was re-sent automatically                     | The CLI decides the interjection is "steer" because the run looks live, and a provider with no mid-turn steering silently drops the operator's correction    |
| 3   | unit        | The re-send keypress after an `unsupported`; assert exactly one further request, carrying the `alternative` mode the daemon named                                | The re-send builds its own mode string, and the one mode that works on every adapter is not the one that gets sent                                           |
| 4   | unit        | No node running; assert the key is inert, one explanatory line and zero requests                                                                                 | An interjection is posted between nodes, the daemon writes nothing, and the session reports it as delivered                                                  |
| 5   | integration | A daemon returning each of the five refusal codes; assert each `message` is shown verbatim, once, and exactly one request was made for each                      | Refusals are paraphrased into one generic sentence, and `use_respond` — which has a specific remedy — becomes "something went wrong"                          |
| 6   | integration | A real daemon and the bundled mock agent: interject at a running node, assert `human.interjected` arrives on the stream and is rendered by the transcript        | The session prints its own "sent" line, and an interjection the daemon refused reads on screen exactly like one it accepted                                  |
| 7   | unit        | Press cancel and answer with bare Enter, then with `n`; assert `cancelRun` was not called in either case                                                          | Cancel is one keypress away from a six-hour run, and a hand on the wrong key ends it                                                                         |
| 8   | unit        | Confirm the cancel; assert exactly one `cancelRun` call and that the session stays open until the run's terminal event                                            | The session exits on the cancel request, so the operator never learns whether the run actually stopped                                                       |
| 9   | integration | stdin not a TTY and `--json`; assert neither key path is reachable and no input is read                                                                          | The input box opens in CI, and a run that would have completed blocks on a line nobody will type                                                             |

**Notes / risks** — `ifLastSeq` is the subtle one and it is worth stating why it is in AC2 rather
than left out for simplicity. A session's frame is repainted from a projection that is, by
construction, a moment behind the ledger. The operator is looking at a node that may have finished
between the repaint and the keypress, and `stale_cursor` is the daemon's answer to exactly that.
Omitting the cursor would make the session the one surface that cannot be told it was looking at
the past.

---

### KAR-21.5 — It degrades honestly: not a TTY, narrow, short, resized, over ssh

|                 |                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                      |
| **Priority**    | P1                                                                                               |
| **Size**        | S                                                                                                |
| **Depends on**  | KAR-21.1, KAR-21.2, KAR-21.3, KAR-21.4 (this is the ladder underneath all four)                   |
| **PRD**         | F10.1, NF5, NF8                                                                                  |
| **Verified by** | EPIC-21-S37, EPIC-21-S38, EPIC-21-S39, EPIC-21-S40, EPIC-21-S41, EPIC-21-S42, EPIC-21-S43, EPIC-21-S44, EPIC-21-S45 |

**As** somebody piping `deflow run` into a log, running it in CI, or watching it over ssh from a
window the size of a phone, **I want** the session to become the thing that works there, **so that**
the interactive version is a gain and never a regression.

The bar is stated as a property rather than as a feeling: **nothing that worked before this epic
works differently after it in a non-interactive environment**, and the way that is known is a
golden of the bytes rather than a review of the code.

**Acceptance criteria**

1. Not a TTY → exactly today's behaviour. Piped, redirected, or under `--json`, the command writes
   not one cursor byte and reads not one key, and its output is pinned by a golden recorded before
   KAR-21.1 began. `packages/cli/test/integration/run-json.test.ts` and
   `packages/cli/test/integration/terminal-output.test.ts` pass **unmodified**.
2. `NO_COLOR`, `FORCE_COLOR`, `--no-color` and a locale naming a non-UTF-8 charset are honoured by
   the frame exactly as `render/style.ts` already honours them for reports — the ASCII glyph set
   and no colour, decided by `createStyle` and not re-decided here.
3. `TERM=dumb` produces **no frame at all** and the plain stream instead, because a terminal that
   cannot address the cursor cannot have a region redrawn in it. The command says so in one line
   rather than silently doing less.
4. The frame re-lays out on `SIGWINCH`, and the width still comes from the one place
   `render/style.ts` computes it. No module under `packages/cli/src/run/session/` reads
   `stdout.columns` — the existing render-guard rule, which this story keeps green.
5. At 40 columns and at 20 columns the frame is readable: rows wrap under themselves through
   `wrapDetail` rather than off the edge, and no row is truncated mid-token (KAR-18.9 AC4,
   unchanged).
6. Repaints are coalesced to a stated ceiling per second rather than one per event, and the bytes
   written for a burst of N events in one tick are bounded and asserted.
7. A terminal with fewer rows than the frame's stated minimum gets the stream and one explanatory
   line, not a frame that scrolls itself.
8. On **every** exit — completion, detach, cancel, error, signal — the frame is erased and the
   cursor is left at column 0 of a fresh line, so the shell prompt does not land on top of a stale
   status region.
9. `deflow --help` names the session and its keys, and every key it names is one `keys.ts` decodes,
   asserted in both directions — KAR-20.3 AC5's rule applied to this surface.

**Test plan (TDD)**

| #   | Level             | Test                                                                                                                                        | Red when                                                                                                                                            |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration       | Piped stdout compared byte for byte against the pre-epic golden; `run-json.test.ts` executed unmodified                                      | The session is entered whenever `run` is invoked, and every CI log and every redirected transcript fills with `\u001B[2K`                            |
| 2   | unit              | `NO_COLOR`, `--no-color` and `LC_ALL=C` each against the frame; assert no escape and the ASCII glyph set                                     | The frame does its own colour detection, so `NO_COLOR` works for reports and not for the region the operator is actually looking at                  |
| 3   | integration (pty) | `TERM=dumb` under a pty; assert no frame, the stream, and the one explanatory line                                                           | Cursor motion is written to a terminal that cannot move a cursor, and the output is a wall of literal escape text                                    |
| 4   | integration (pty) | A pty at 80×24 resized to 40×24 mid-run; assert the next frame is laid out at the new width                                                  | The width is captured when the session starts, so resizing the window leaves every row wrapping at the old column for the rest of the run            |
| 5   | unit              | Frame goldens at 40 and at 20 columns                                                                                                        | The frame is designed at 80 and is unusable in the split pane the operator actually watches it in                                                    |
| 6   | unit              | 200 events delivered in one tick; assert the repaint count is at or below the ceiling and the byte count is bounded                          | One repaint per event over ssh saturates the link, and the screen runs a minute behind the run it is describing                                      |
| 7   | integration (pty) | A pty of 8 rows; assert the stream and the explanation, and no frame                                                                         | The frame is taller than the window, each repaint scrolls the one before it, and the screen becomes a flickering ladder                              |
| 8   | integration (pty) | Normal exit, detach, and a `SIGTERM`; assert in each case that the final bytes erase the frame and end at column 0 of a new line             | The shell prompt is printed on top of the last status region, and the operator's next command is typed into the middle of it                         |
| 9   | unit              | Every key named in `--help` against `keys.ts`'s table, both directions                                                                       | The help names a key that was renamed, and the one document an operator reads to learn the application is the one thing that is wrong                |

**Notes / risks** — the repaint ceiling in AC6 is the only number in this epic that is a judgement
rather than a derivation, and it is recorded here so it can be argued with: it is a **frame rate**,
not an event rate, and the test asserts a bound rather than a value so that tuning it does not
require rewriting the specification. If the performed acceptance finds the region feels laggy, the
number moves and the test still means what it meant.

**The performed acceptance.** The epic's Definition of Done requires one real run watched end to
end in a terminal, with its spec gate answered by a keypress and at least one interjection made.
The transcript and what the operator had to stop and think about are written into this story's
notes and onto its Linear issue when it happens. Nothing above is evidence for it: the whole epic
exists because a green suite coexisted with a command that printed nothing for seven minutes.

---

## Risks

| Risk                                                                                                                                    | Mitigation                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A second presentation layer grows beside KAR-18.9's** — the epic's own stated biggest risk                                             | One new module in `src/render/`; `render-guard.test.ts` extended to cover it and the session directory; every frame element built from an existing function named in KAR-21.1 AC4  |
| **A second gate-answer implementation grows beside KAR-22.5's**                                                                          | KAR-21.3 AC2 plus a source guard (test plan #2) asserting no route string exists under `packages/cli/src/run/session/`                                                             |
| **The interactive path regresses the non-interactive one**, which is the one CI and every pipe depend on                                 | KAR-21.5 AC1: a byte golden recorded *before* KAR-21.1 starts, and two existing test files that must pass unmodified                                                               |
| **Raw mode is left on after an abnormal exit**, which is worse than anything this epic adds                                              | KAR-21.2 AC4 and three pty scenarios reading the terminal's mode from the master after the child exited                                                                            |
| **`@lydell/node-pty` does not load on a contributor's platform**, taking six scenarios' runner with it                                   | It is an `optionalDependency` and `doctor`'s `memory.pty` check already reports it. The epic's Definition of Ready requires it to load, and the honest failure is to say so        |
| **The pinned-footer shape turns out to be the wrong shape** once it is used daily                                                        | Recorded in Scope as a decision with a reason rather than as an assumption, so replacing it is a new epic with a written argument and not a quiet redesign inside this one         |
| **~9 days of `P1` work sits behind a `P0` backlog**                                                                                      | Stated rather than hidden: this epic is schedulable at any point after its dependencies and blocks nothing. Every capability it fronts is already reachable by another route       |

## Out of scope, restated for the record

Nothing in this epic changes the daemon, the ledger, the reducers, the adapters or the web
application. If a story here appears to need one of those changed, that is the signal that the
mechanism it wants does not exist, and it belongs to the epic that owns the mechanism — not to
this one under a different name.

---

**Related:** [Board](../board.md) · [Delivery plan](../README.md) ·
[Flows for this epic](../flows/EPIC-21-interactive-cli-flows.md) ·
[EPIC-13](./EPIC-13-human-in-the-loop.md) · [EPIC-18](./EPIC-18-cli-packaging.md) ·
[EPIC-19](./EPIC-19-live-run-pipeline.md) · [EPIC-22](./EPIC-22-web-control-center.md)
