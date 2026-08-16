# EPIC-21 flows — Interactive CLI: a real terminal app, not a background command

> Behavioural specification for [EPIC-21](../epics/EPIC-21-interactive-cli.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 16 August 2026

## Actors

| Actor                     | Description                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**              | The person sitting in front of the terminal while a run executes. They have a window of an unknown size, a shell they did not want changed, and no interest in a second window     |
| **The session**           | What `deflow run` becomes on a TTY: the existing scrolling transcript, plus a frame pinned below it. `packages/cli/src/run/session/`                                               |
| **The frame**             | A `readonly string[]` produced by a pure function from `(RunState, SessionState, Style)`. Everything this file asserts about "what was on screen" is asserted about one of these   |
| **The screen**            | `packages/cli/src/render/screen.ts` — the only module in the CLI that emits cursor motion. `createHeadlessScreen()` records frames instead of writing them                        |
| **The presentation layer**| `packages/cli/src/render/` — `report.ts`, `layout.ts`, `style.ts`, `glyphs.ts` (KAR-18.9), plus `run/render.ts`'s `RunRenderer` (KAR-18.3, KAR-19.4, KAR-19.12). Extended, never duplicated |
| **The transcript**        | What `RunRenderer.event`, `.io` and `.final` already write. In this epic it is a **fixed point**: no scenario here may change one byte of it                                       |
| **The daemon**            | `DeFlowd`. It owns gates (EPIC-13), interjection (KAR-13.3), cancellation (KAR-19.6) and the stream (EPIC-15). The session is a client of all four and reimplements none          |
| **`gateAnswerRequest`**   | `packages/core/src/gate-answer.ts` (KAR-22.5 AC2) — the one function that decides which request answers which gate. The session is its third caller and second surface             |
| **The pty**               | `@lydell/node-pty`, already a dependency of `packages/cli` and already driven by `packages/daemon/src/pty/pty-session.ts`. A real terminal at a size a test chose                  |
| **The pipe**              | stdout that is not a TTY: a file, a `\|`, a CI runner. The environment in which none of this epic exists and everything still works                                                |

## Preconditions common to all flows

```gherkin
Background:
  Given a real git repository created with "git init -b main" in an fs.mkdtemp directory
  And GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced author/committer identity
  And every frame assertion is made against a frame a pure function returned, or against a frame a
      headless screen recorded — never against a screenshot and never by a person looking
  And every terminal-behaviour assertion is made under a pty opened at a size the scenario states
  And every "the terminal was given back" assertion is read from the pty master after the child
      process has exited, never from inside the process under test
  And time enters through the injected Clock, so an elapsed time in a frame is a value a test set
  And no scenario calls vi.useFakeTimers() while a child process is alive
  And the normalising snapshot serializer is registered before any frame golden is written,
      covering run ids, node ids, durations, timestamps and absolute paths
  And no credential variable — no *_API_KEY, no *_TOKEN — is present in any child environment (AR-1)
  And the daemon under test is a real DeFlowd on an ephemeral port wherever the level says
      integration or e2e, and a recorded fake only where the level says unit
```

> Two of these carry this epic. **A frame is a value, not a picture**: the design exists in the
> shape it does so that "what would the operator see" is an array a test can compare, and a
> scenario that could only be checked by looking at a terminal has been written wrong. **The
> terminal's mode is read from outside the process**: the process under test is the suspect, so
> asking it whether it restored the terminal answers nothing.
>
> The third is a boundary rather than a setup. **The transcript is a fixed point.** `deflow run`'s
> existing output is pinned by `packages/cli/test/integration/terminal-output.test.ts` and
> `packages/cli/test/integration/run-json.test.ts`, and both must pass **unmodified** at the end of
> this epic. Any scenario here that would require editing either of them is describing a
> regression, not a feature.

## Flow index

| Scenario    | Title                                                                                     | Verifies | Type        |
| ----------- | ------------------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-21-S01 | **Happy path: the frame is a pure function of the run's state**                            | KAR-21.1 | Happy path  |
| EPIC-21-S02 | The frame at 40 and 20 columns wraps rather than running off the edge                      | KAR-21.1 | Edge case   |
| EPIC-21-S03 | **A frame that shrank leaves nothing of the old one behind**                               | KAR-21.1 | Failure     |
| EPIC-21-S04 | An unchanged frame writes no bytes at all                                                  | KAR-21.1 | Edge case   |
| EPIC-21-S05 | **The transcript is untouched: events print exactly the bytes they printed before**        | KAR-21.1 | Failure     |
| EPIC-21-S06 | A plan larger than the window shows what is running and counts the rest                    | KAR-21.1 | Edge case   |
| EPIC-21-S07 | One module owns cursor motion, and the guard is what keeps that true                       | KAR-21.1 | Failure     |
| EPIC-21-S08 | **Not a TTY: no screen is constructed and no cursor byte is written**                      | KAR-21.1 | Edge case   |
| EPIC-21-S09 | Two sessions in one process do not share a screen state                                    | KAR-21.1 | Edge case   |
| EPIC-21-S10 | **Happy path: bytes from a terminal become typed intents**                                 | KAR-21.2 | Happy path  |
| EPIC-21-S11 | **An escape sequence split across two reads is still one key**                             | KAR-21.2 | Edge case   |
| EPIC-21-S12 | Every advertised key is handled, and every handled key is advertised                       | KAR-21.2 | Failure     |
| EPIC-21-S13 | The terminal is given back after a normal exit                                             | KAR-21.2 | Happy path  |
| EPIC-21-S14 | **The terminal is given back after SIGTERM**                                               | KAR-21.2 | Recovery    |
| EPIC-21-S15 | **The terminal is given back after an unexpected throw**                                   | KAR-21.2 | Recovery    |
| EPIC-21-S16 | Ctrl-C still detaches, and twice inside the window still cancels                           | KAR-21.2 | Edge case   |
| EPIC-21-S17 | **stdin is not a TTY: no raw mode, no keys, no hint line**                                 | KAR-21.2 | Edge case   |
| EPIC-21-S18 | **Happy path: the spec gate is approved with one keypress**                                | KAR-21.3 | Happy path  |
| EPIC-21-S19 | **No route string and no request body exists in the session**                              | KAR-21.3 | Failure     |
| EPIC-21-S20 | A plan gate's own options are the options offered                                          | KAR-21.3 | Edge case   |
| EPIC-21-S21 | **A rejection carries a reason, or it is not sent**                                        | KAR-21.3 | Failure     |
| EPIC-21-S22 | `edit` is shown, refused, and the sentence is the one the other surfaces use               | KAR-21.3 | Edge case   |
| EPIC-21-S23 | The daemon's refusal is the words the operator reads, once                                 | KAR-21.3 | Failure     |
| EPIC-21-S24 | **A gate answered in the browser closes the prompt in the terminal**                       | KAR-21.3 | Recovery    |
| EPIC-21-S25 | Two presses of one option are one answer                                                   | KAR-21.3 | Failure     |
| EPIC-21-S26 | Two open gates: the oldest is the one offered                                              | KAR-21.3 | Edge case   |
| EPIC-21-S27 | **`--json` answers nothing, reads nothing, and does not block**                            | KAR-21.3 | Edge case   |
| EPIC-21-S28 | **Happy path: a typed line reaches the node that is running**                              | KAR-21.4 | Happy path  |
| EPIC-21-S29 | The interjection carries the cursor the frame was painted at                               | KAR-21.4 | Edge case   |
| EPIC-21-S30 | **An adapter with no mid-turn steering: the daemon's outcome, and its alternative**        | KAR-21.4 | Edge case   |
| EPIC-21-S31 | Re-sending uses the mode the daemon named, and only when asked                             | KAR-21.4 | Recovery    |
| EPIC-21-S32 | **Nothing is running: the key is inert and the ledger is untouched**                       | KAR-21.4 | Failure     |
| EPIC-21-S33 | Each of the five refusals is shown in the daemon's own words                               | KAR-21.4 | Failure     |
| EPIC-21-S34 | **An accepted interjection appears when the ledger has it, not before**                    | KAR-21.4 | Failure     |
| EPIC-21-S35 | **Cancel asks first, and a bare Enter means no**                                           | KAR-21.4 | Failure     |
| EPIC-21-S36 | A confirmed cancel keeps the screen until the run actually ends                            | KAR-21.4 | Edge case   |
| EPIC-21-S37 | **Not a TTY: byte-identical to what the command printed before this epic**                 | KAR-21.5 | Failure     |
| EPIC-21-S38 | `NO_COLOR`, `--no-color` and a non-UTF-8 locale reach the frame too                        | KAR-21.5 | Edge case   |
| EPIC-21-S39 | **`TERM=dumb`: no frame at all, and the command says so**                                  | KAR-21.5 | Edge case   |
| EPIC-21-S40 | **A resized window re-lays the frame out**                                                 | KAR-21.5 | Edge case   |
| EPIC-21-S41 | 40 and 20 columns are readable, not merely non-crashing                                    | KAR-21.5 | Edge case   |
| EPIC-21-S42 | **A burst of two hundred events is not two hundred repaints**                              | KAR-21.5 | Failure     |
| EPIC-21-S43 | A window too short for the frame gets the stream and one sentence                          | KAR-21.5 | Edge case   |
| EPIC-21-S44 | **Every exit leaves the cursor at the start of a clean line**                               | KAR-21.5 | Recovery    |
| EPIC-21-S45 | `deflow --help` names the keys, and every key it names exists                               | KAR-21.5 | Failure     |

---

## EPIC-21-S01 — Happy path: the frame is a pure function of the run's state

**Verifies:** KAR-21.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: what the operator sees is a value a test can hold

  Scenario: a run mid-flight renders one frame
    Given a RunState reduced from events describing four plan nodes
    And "n_impl_2" is running and has been for 95000 ms as measured by the injected Clock
    And "n_recon_1" completed, "n_impl_3" is pending and "n_impl_4" failed once
    And the run's budget carries an api-key cost of 1.20 and a subscription cost of 0.00
    And a Style of width 80, colour off and the UTF-8 glyph set
    When the frame is rendered from that state
    Then the first line names the run id and its RUN_STATUS_LABELS status word
    And there is one row per plan node, each carrying its TRANSCRIPT_GLYPHS glyph
    And "n_impl_2"'s row carries "1m 35s", which is formatDuration's rendering of 95000
    And the cost line is formatCost's rendering — "$1.20 api-key, $0.00 subscription"
    And no cell of the cost is added to another
    And the function read no clock, opened no socket and touched no process global
    And rendering the same state twice returns two equal arrays
```

**Notes:** every element in the Then clauses is an existing function — `RUN_STATUS_LABELS`,
`TRANSCRIPT_GLYPHS`, `formatDuration`, `formatCost`. That is the whole of KAR-21.1 AC4: the frame
is a **composition** of the presentation layer, and a scenario that had to name a new rendering rule
would be evidence that a second layer was being built.

The purity clause is not decoration. It is what makes the other eight scenarios in this story cost
nothing, and it is why the elapsed time arrives as a number rather than being read (NF9).

---

## EPIC-21-S02 — The frame at 40 and 20 columns wraps rather than running off the edge

**Verifies:** KAR-21.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the frame fits the window it is actually in

  Scenario Outline: a narrow terminal still reads
    Given the state of EPIC-21-S01 and a node whose worktree path is 120 characters long
    And a Style of width <width>
    When the frame is rendered
    Then no line exceeds <width> characters
    And any line that does is a single unbreakable token, emitted whole
    And no row is cut mid-word
    And every continuation line is indented to the column its row's detail began at

    Examples:
      | width |
      | 80    |
      | 40    |
      | 20    |
```

**Notes:** this is KAR-18.9 AC4's rule, not a new one — `wrapDetail` already wraps and never
truncates, and a long absolute path is already emitted as one selectable token. The scenario exists
because a frame is the surface most likely to be written with `padEnd` and `slice` against an
assumed 80 columns, which is the shape that makes a split pane useless.

---

## EPIC-21-S03 — A frame that shrank leaves nothing of the old one behind

**Verifies:** KAR-21.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: redraw erases what was there, not what was expected

  Scenario: frames of different heights follow each other
    Given a headless screen recording every write
    When a frame of 5 lines is rendered
    And a frame of 7 lines is rendered
    And a frame of 5 lines is rendered again
    Then before the second frame the writer erased exactly 5 lines
    And before the third frame the writer erased exactly 7 lines
    And the erase count each time is the height the previous frame occupied after wrapping,
        not the number of entries the view function returned
    And the recorded final frame equals the first frame exactly
```

**Notes:** the distinction in the fourth Then is the bug this scenario is really about. A row that
wraps occupies two lines and is one entry, so a writer that erases `frame.length` lines is correct
until the first long worktree path arrives and then strands a line on screen for the rest of the
run. The frame function returns already-wrapped lines for this reason, and the screen wraps nothing.

---

## EPIC-21-S04 — An unchanged frame writes no bytes at all

**Verifies:** KAR-21.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: a repaint that changes nothing is not a repaint

  Scenario: the same frame twice
    Given a headless screen with one frame already rendered
    When an identical frame is rendered
    Then the screen wrote zero bytes
    And the recorded frame list still has one entry
```

**Notes:** cheap, and it is what stops the region flickering. It also removes the temptation to
solve flicker later with a timer, which would put a second scheduling mechanism beside the one
KAR-21.5 AC6 defines.

---

## EPIC-21-S05 — The transcript is untouched: events print exactly the bytes they printed before

**Verifies:** KAR-21.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the frame is added below the transcript, not instead of it

  Scenario: the same event sequence with the session on and off
    Given a scripted sequence of events covering task.submitted, run.created, node.scheduled,
        node.started, an io_chunk, node.failed, node.completed and run.completed
    When the sequence is rendered with the session enabled
    And the same sequence is rendered with the session disabled
    Then the bytes that are not cursor motion and not frame content are identical between the two
    And "packages/cli/test/integration/terminal-output.test.ts" passes unmodified
    And the io_chunk bytes are the agent's own bytes in both, unwrapped and unprefixed
```

**Notes:** the io clause is the one worth holding on to. KAR-19.4 AC3 made a deliberate decision
that agent output reaches the terminal unedited — _"a renderer that prefixed, wrapped or
re-coloured it would be editing a transcript somebody is reading in order to decide whether to
intervene"_ — and a frame that reflows the region above it would undo that decision without anybody
choosing to.

---

## EPIC-21-S06 — A plan larger than the window shows what is running and counts the rest

**Verifies:** KAR-21.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: a big plan does not push the important line off the screen

  Scenario: forty nodes in twenty-four rows
    Given a RunState with 40 plan nodes, 3 of them running and 1 gate open
    And a terminal of 24 rows
    When the frame is rendered
    Then the frame occupies no more than the stated fraction of 24 rows
    And all 3 running nodes have a row
    And the open gate's summary is present
    And the nodes with no row are represented by a single "+N more" line whose N is exact
    And no row is truncated to make space
```

**Notes:** dropping rows is the right answer and truncating them is the wrong one, which is why
both clauses are here. `pendingGateSummary` is the sentence the gate line uses — the same one
`deflow status` and the run API print, per its own module note, so this surface does not invent a
fourth wording for a fact three others already state.

---

## EPIC-21-S07 — One module owns cursor motion, and the guard is what keeps that true

**Verifies:** KAR-21.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the presentation layer stays one layer

  Scenario: the render guard is extended and bites
    Given "packages/cli/test/render-guard.test.ts"
    When it is run over "packages/cli/src"
    Then it reports no ANSI escape literal outside "packages/cli/src/render/"
    And it reports no status-glyph literal outside it
    And it reports no module deriving a terminal width of its own
    And its file list includes "run/session/view.ts" and "render/screen.ts"

  Scenario: a second module starts writing cursor motion
    Given a fixture source under "packages/cli/src/run/session/" containing the literal "\u001B[2K"
    When the guard is run over it
    Then the guard fails, naming the file and the rule
```

**Notes:** the second scenario is the one that makes the first mean anything. A guard extended in
name only passes forever, and the epic's own stated biggest risk is precisely the thing this guard
is the standing defence against.

---

## EPIC-21-S08 — Not a TTY: no screen is constructed and no cursor byte is written

**Verifies:** KAR-21.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the session exists only where a session can exist

  Scenario: stdout is a file
    Given "deflow run" invoked with stdout redirected to a file
    When the run completes
    Then no Screen was constructed
    And the file contains no cursor-motion or erase sequence
    And the file's bytes equal the golden recorded before KAR-21.1 was started
```

**Notes:** the golden has to be recorded **before** the first line of KAR-21.1 is written, which is
a sequencing requirement rather than an assertion. A golden captured afterwards records whatever
the implementation happened to do, which is a tautology dressed as a regression test
([README §3](../README.md#3-the-tdd-working-agreement)).

---

## EPIC-21-S09 — Two sessions in one process do not share a screen state

**Verifies:** KAR-21.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: what is on screen is a value, not a module

  Scenario: two sessions constructed in one test file
    Given a session A with an interjection input open
    And a session B constructed afterwards with no input open
    When both frames are rendered
    Then B's frame contains no input row
    And A's frame still does
    And no module-level variable in "run/session/" holds screen state
```

**Notes:** this is a testability constraint before it is a correctness one. Screen state in a
module variable is the reason TUI code is usually tested by hand: the second test in a file
inherits the first one's screen, and the failures are order-dependent and unreproducible.

---

## EPIC-21-S10 — Happy path: bytes from a terminal become typed intents

**Verifies:** KAR-21.2 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: keys are decoded by a pure function

  Scenario Outline: the bytes a terminal actually sends
    Given the key decoder with an empty buffer
    When <bytes> are fed to it
    Then it yields the intent <intent>
    And it never referenced process.stdin

    Examples:
      | bytes            | intent      |
      | "a"              | answer      |
      | "i"              | interject   |
      | "\u001B[A"       | select-up   |
      | "\u001B[B"       | select-down |
      | "\r"             | confirm     |
      | "\u001B"         | dismiss     |
      | ""         | interrupt   |
      | ""         | none        |
```

**Notes:** the exact key letters are the implementation's to choose and EPIC-21-S45 is what keeps
them and the help text in agreement. What this scenario fixes is the **shape**: bytes in, a typed
intent out, and no I/O — which is what makes every other key behaviour in this epic a table test
rather than a person pressing something.

---

## EPIC-21-S11 — An escape sequence split across two reads is still one key

**Verifies:** KAR-21.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: a slow link does not turn an arrow key into typing

  Scenario: one sequence, two data events
    Given the key decoder with an empty buffer
    When "\u001B" is fed to it
    Then it yields no intent yet
    When "[A" is fed to it
    Then it yields exactly one "select-up" intent
    And no "dismiss" intent was produced by the lone escape byte

  Scenario: an escape that never completes
    Given the key decoder
    When "\u001B" is fed and nothing follows within the decoder's stated wait
    Then it yields "dismiss"
    And the buffer is empty afterwards
```

**Notes:** this is the single most common bug in hand-rolled terminal input and it is invisible
locally, because a local terminal delivers the three bytes in one `data` event. Over ssh it does
not, and the operator's arrow key becomes an Escape — dismissing whatever was open — followed by
`[A` typed into the interjection box. Both halves are needed: an escape that never completes must
eventually mean Escape, or the Escape key stops working.

---

## EPIC-21-S12 — Every advertised key is handled, and every handled key is advertised

**Verifies:** KAR-21.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the two tables agree

  Scenario: both directions
    Given the decoder's key table and the session's action table
    When each is compared against the other
    Then no key is decoded to an intent nothing handles
    And no intent is handled that no key produces
    And every key the hint line names appears in the decoder's table
```

**Notes:** the failure this prevents is small and constant: a key is renamed on one side of the
pair, the hint line advertises something inert, and the operator concludes the application is
broken. It is also the mechanism EPIC-21-S45 reuses against `--help`.

---

## EPIC-21-S13 — The terminal is given back after a normal exit

**Verifies:** KAR-21.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: a session borrows the terminal and returns it

  Scenario: the run completes and the process exits 0
    Given a pty opened at 80 columns by 24 rows
    And the pty's terminal attributes recorded before the child is spawned
    When "deflow run" is spawned on it and the run reaches run.completed
    And the child process has exited
    Then the pty's terminal attributes equal the recorded ones
    And echo is on and canonical mode is on
```

**Notes:** the attributes are read from the **master** after the child has gone, per this file's
background. Reading them from inside the child would be asking the suspect for an alibi.

---

## EPIC-21-S14 — The terminal is given back after SIGTERM

**Verifies:** KAR-21.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: the terminal is returned on the paths nobody plans for

  Scenario: the session is killed mid-run
    Given a pty at 80x24 with attributes recorded, and a session watching a running node
    When the child is sent SIGTERM
    And the child has exited
    Then the pty's terminal attributes equal the recorded ones
    And the same holds for SIGHUP
```

**Notes:** SIGHUP is in the same scenario because it is the one that actually happens: it is what a
closed ssh session sends, and an operator whose link dropped is exactly the operator who then opens
a new terminal and finds the old shell unusable.

---

## EPIC-21-S15 — The terminal is given back after an unexpected throw

**Verifies:** KAR-21.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: a bug in the session is not also a broken shell

  Scenario: the session throws after raw mode is entered
    Given a pty at 80x24 with attributes recorded
    And a session configured to throw once the stream is open
    When the child exits non-zero
    Then the pty's terminal attributes equal the recorded ones
    And the thrown error's message is readable on the pty, with its line breaks intact
```

**Notes:** the second Then is the part people discover the hard way. In raw mode a bare `\n` moves
down without returning to column 0, so a stack trace printed by a process that has not restored the
terminal renders as a diagonal staircase — which is both unreadable and the exact moment the
operator most needs to read something.

---

## EPIC-21-S16 — Ctrl-C still detaches, and twice inside the window still cancels

**Verifies:** KAR-21.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the one interactive verb the command already had is unchanged

  Scenario: one press
    Given a session watching a run
    When the interrupt intent is delivered once
    Then stdout contains exactly detachSentence(runId)
    And the stream is closed
    And the run is not cancelled

  Scenario: two presses inside the window
    Given a session watching a run
    When the interrupt intent is delivered twice within DETACH_WINDOW_MS
    Then cancelRun is called exactly once
    And the exit code is RUN_EXIT_CODES.interrupted
```

**Notes:** the sentence and the window are KAR-18.3 AC3's, referenced by name rather than
re-specified, because an operator who learned "Ctrl-C detaches" from the current command must not
have to relearn it. A session is a place where "quit the UI" would be a natural third meaning to
add, and adding it would silently make Ctrl-C kill runs it used to leave alone.

---

## EPIC-21-S17 — stdin is not a TTY: no raw mode, no keys, no hint line

**Verifies:** KAR-21.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: an environment with no keyboard is not asked for keys

  Scenario: stdin is /dev/null
    Given "deflow run" invoked with stdin closed and stdout a pipe
    When the run completes
    Then setRawMode was never called
    And no key-hint line appears in the output
    And the process never blocked on a read
    And the exit code is the run's own verdict
```

**Notes:** `setRawMode` on a non-TTY throws, so the failure here is not a cosmetic one — it is
`deflow run` dying at startup in CI. The hint-line clause is separate on purpose: printing a list
of keys into a log where no key can be pressed is a smaller failure but it is still a lie.

---

## EPIC-21-S18 — Happy path: the spec gate is approved with one keypress

**Verifies:** KAR-21.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: the gate is answered where the operator already is

  Scenario: approving the F1.3 gate
    Given a RunState whose pendingGate is the spec-approval gate
    And a recording fetch
    When the frame is rendered
    Then it shows the gate node, gate.prompt verbatim, and one row per gate.options entry
    And each row carries that option's label
    When the row for "approve" is selected and confirmed
    Then exactly one request was made
    And its path and body equal gateAnswerRequest({runId, gate, optionId: "approve", text: null})
    And its authorization header carries the endpoint's own bearer token
    And its "X-DeFlow-Submitted-By" header is "cli"
```

**Notes:** the assertion is deliberately an **equality against `gateAnswerRequest`'s own output**
rather than a comparison against a path spelled in the test. A test that spelled `/runs/:id/spec/approve`
would be a second copy of the decision KAR-22.5 centralised, and it would keep passing on the day
that decision changed — which is precisely the failure its module note describes.

---

## EPIC-21-S19 — No route string and no request body exists in the session

**Verifies:** KAR-21.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: one answer path, three callers, no fourth implementation

  Scenario: a source guard over the session directory
    Given every source file under "packages/cli/src/run/session/"
    When they are scanned with comments stripped
    Then none contains "/spec/approve", "/spec/reject", "/spec/abandon" or "/spec/edit"
    And none contains a "/respond" path or a template that would build one
    And every gate answer in the directory is routed through gateAnswerRequest

  Scenario: the guard bites
    Given a fixture source under that directory containing "/runs/${runId}/spec/approve"
    When the guard is run over it
    Then it fails, naming the file
```

**Notes:** this is the epic's second structural guard and it exists for the same reason as the
first. `deflow answer` made this choice privately until KAR-22.5 moved it; the browser was the
second surface and the terminal is the third caller. A guard is cheaper than a reviewer noticing,
and the thing being protected is invisible in a diff that looks locally reasonable.

---

## EPIC-21-S20 — A plan gate's own options are the options offered

**Verifies:** KAR-21.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the gate says what it accepts

  Scenario: a plan human node with three custom options
    Given a RunState whose pendingGate offers "proceed", "retry" and "skip"
    When the frame is rendered
    Then there is exactly one selectable row per offered option
    And each row's text is that option's label, not its id alone
    And there is no row for "approve", "reject", "abandon" or "edit"
    And gate.specApproval is false, and the frame's routing follows it
```

**Notes:** the last Then is why `PendingGate` carries `specApproval` at all — its own doc comment
says it is carried _"rather than left for each caller to compare against `SPEC_GATE_NODE`, because
two of them route an answer differently on it"_. The session is the third such caller, and reading
the flag is how it avoids being the place that gets the comparison wrong.

---

## EPIC-21-S21 — A rejection carries a reason, or it is not sent

**Verifies:** KAR-21.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: a refusal with nothing to say helps nobody

  Scenario: reject with no text
    Given the spec gate open and a recording fetch
    When "reject" is selected
    Then an inline single-line input opens
    When confirm is pressed with the input empty
    Then no request was made
    And the frame says a reason is required

  Scenario: reject abandoned
    Given the same input open with three characters typed
    When dismiss is pressed
    Then no request was made
    And pendingGate still reports the gate as open
    And the input is closed
```

**Notes:** the rule is `deflow answer`'s, in the same words it already refuses with: the next
framing attempt is given the rejection as an input, so _"a rejection with nothing to say sends the
agent back to the same blank page that produced the spec you just refused"_. The second scenario
matters as much as the first — an abandoned input that silently answered the gate would be worse
than one that refused to.

---

## EPIC-21-S22 — `edit` is shown, refused, and the sentence is the one the other surfaces use

**Verifies:** KAR-21.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: one limitation, one wording

  Scenario: selecting edit
    Given the spec gate open and a recording fetch
    When "edit" is selected
    Then no request was made
    And the frame contains SPEC_EDIT_NEEDS_A_DOCUMENT exactly, imported from "@DeFlow/core"
    And the option row remains visible rather than being hidden
    And the other options remain selectable
```

**Notes:** shown-and-refused rather than hidden, which is the choice the browser's gate panel
already made: an option the gate genuinely offers, that this surface cannot submit, is a fact the
operator should be told rather than one they should be unable to see. The sentence is imported for
the reason its own constant records — a limitation explained two ways is a limitation an operator
has to discover twice.

---

## EPIC-21-S23 — The daemon's refusal is the words the operator reads, once

**Verifies:** KAR-21.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the daemon owns what an answer means, and what it refuses

  Scenario: an option a plan gate does not offer
    Given a daemon that refuses with planHumanResponse's own message
    When an option is selected and the refusal arrives
    Then the frame shows that message verbatim
    And exactly one request was made
    And no retry was attempted
    And the gate remains open and selectable

  Scenario: the gate closed while the keypress was in flight
    Given a daemon that answers 409 for a gate already answered
    When the answer is sent
    Then the daemon's message is shown verbatim
    And the session does not re-send
```

**Notes:** forwarding rather than paraphrasing is a rule this CLI already follows in
`deflow answer` and `deflow run`'s admission path, and the reason is the same each time: the
daemon's sentence is several sentences of specific advice, and a local rewording throws the advice
away while looking tidier.

---

## EPIC-21-S24 — A gate answered in the browser closes the prompt in the terminal

**Verifies:** KAR-21.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: one run, two surfaces, one truth

  Scenario: the answer arrives from somewhere else
    Given a session with the spec gate's options on screen
    When a "human.responded" event for that gate arrives on the stream
    Then the frame no longer offers the options
    And the transcript carries the existing "answered" line naming the option and who answered
    And a later selection sends no request
    And no reconnection and no poll was performed

  Scenario: the answer and the keypress cross
    Given the same session
    When an option is selected and a "human.responded" arrives before the response does
    Then the session settles with the gate closed
    And it does not send a second answer
```

**Notes:** the second scenario is the race and it is the reason the session must hold no opinion of
its own about whether a gate is open. `pendingGate` over the reduced state is the only reader —
exactly as `watch()` in `packages/cli/src/run/run.ts` already does it — so the answered case, the
second-gate case and the re-delivery case are already correct in the projection and are not three
special cases here.

---

## EPIC-21-S25 — Two presses of one option are one answer

**Verifies:** KAR-21.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: one gate, one answer

  Scenario: a double keypress
    Given the spec gate open and a fetch that does not resolve immediately
    When "approve" is selected twice in quick succession
    Then exactly one request was made
    And while the request is outstanding the option rows are inert
    And the frame says the answer is being sent
```

**Notes:** without the inert window, the second answer is refused by the daemon for a gate that is
now closed, and the operator reads a refusal that looks like a bug in a tool that just did what
they asked.

---

## EPIC-21-S26 — Two open gates: the oldest is the one offered

**Verifies:** KAR-21.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the gate blocking the most work is the one in front of you

  Scenario: a run holding two gates
    Given a RunState with two open human gates opened at different seqs
    When the frame is rendered
    Then it offers the gate pendingGate returns, which is the older
    When that gate is answered and its "human.responded" is applied
    Then the frame offers the second gate
    And no ordering of its own was computed by the session
```

**Notes:** `pendingGate`'s own comment states the rule and the reason — oldest first, because it is
blocking the most work — and it also answers _"what do I tell the operator right now"_, which is
exactly this frame's question. A session that sorted the gates itself would be a second answer to a
question that already has one.

---

## EPIC-21-S27 — `--json` answers nothing, reads nothing, and does not block

**Verifies:** KAR-21.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the machine-readable stream is not an application

  Scenario: --json with stdin closed and stdout piped
    Given "deflow run --json" with stdin closed and stdout piped
    When the run reaches a gate and then completes
    Then stdout carries only event objects, one per line, each parsing
    And stderr carries the "DeFlow.cli.gate" object exactly as run/render.ts emits it today
    And no key was read and no input was opened
    And the process never blocked
    And "packages/cli/test/integration/run-json.test.ts" passes unmodified
```

**Notes:** the gate object's shape is a contract KAR-19.12 AC3 settled — it goes to stderr because
stdout is a `seq`-ordered stream of events and an announcement has no `seq` of its own. Nothing in
this epic may move it, and the unmodified-test clause is how that is known rather than believed.

---

## EPIC-21-S28 — Happy path: a typed line reaches the node that is running

**Verifies:** KAR-21.4 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: steering, from where the operator already is

  Scenario: an interjection is sent
    Given a RunState in which "n_impl_2" is running
    And a recording fetch
    When the interject intent is delivered
    Then a single-line input opens in the frame
    When "use the existing helper in utils.ts" is typed and confirm is pressed
    Then exactly one POST was made to "/api/runs/<runId>/interject"
    And its body carries that text and the node id "n_impl_2"
    And the node id came from the reduced state, not from anything the operator typed
    And the operator was never asked for a node id
```

**Notes:** F8.2 is _"interject at any time"_, and from a terminal the answer before this story is
never — the route has existed since KAR-13.3 and no command reaches it. The node-id clause is the
ergonomic half: a node id is DeFlow's vocabulary, and an operator asked to type one is an operator
who has to go and look it up while the thing they wanted to correct carries on.

---

## EPIC-21-S29 — The interjection carries the cursor the frame was painted at

**Verifies:** KAR-21.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the session can be told it was looking at the past

  Scenario: ifLastSeq travels with the interjection
    Given a session whose last rendered event had seq 412
    When an interjection is sent
    Then the request body carries ifLastSeq 412

  Scenario: the node moved between the repaint and the keypress
    Given a daemon answering the "stale_cursor" refusal for that cursor
    When the refusal arrives
    Then the daemon's message is shown verbatim
    And nothing was appended to the ledger
    And the session does not re-send with a newer cursor on its own
```

**Notes:** a frame is by construction a moment behind the ledger, so the operator may be looking at
a node that has already finished. `ifLastSeq` is KAR-13.3 AC6's answer to exactly that, and
omitting it would make the session the one surface that cannot be told it was wrong. Not re-sending
automatically is deliberate: the node the operator was addressing is gone, and silently
re-addressing the next one is not what they asked for.

---

## EPIC-21-S30 — An adapter with no mid-turn steering: the daemon's outcome, and its alternative

**Verifies:** KAR-21.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the capability question is the daemon's to answer

  Scenario: delivery is unsupported
    Given a daemon answering 202 with delivery "unsupported"
    And that answer carries a message and an alternative mode
    When the interjection is sent
    Then the frame shows the daemon's message verbatim
    And it names the alternative mode the daemon named
    And it offers a single keypress to re-send with it
    And no re-send happened automatically
    And the session read no provider capability of its own
```

**Notes:** `unsupported` is a `202`, not an error — the daemon's own note says so: the operator did
nothing wrong and retrying will not help; what helps is the alternative, which is why the answer
names it. The last Then is the boundary: whether an adapter advertises mid-turn steering is a row
in `provider_capabilities` keyed on the provider the node was **scheduled onto**, which a quota
re-route can change mid-run, and a CLI that cached or guessed it would be wrong exactly when it
mattered.

---

## EPIC-21-S31 — Re-sending uses the mode the daemon named, and only when asked

**Verifies:** KAR-21.4 · **Type:** Recovery · **Automated at:** unit

```gherkin
Feature: the second attempt is the one that works, and it is the operator's

  Scenario: the operator accepts the alternative
    Given an "unsupported" answer naming an alternative mode
    When the re-send key is pressed
    Then exactly one further request was made
    And its mode is the alternative the daemon named, not one this package spelled
    And the text is the text originally typed, unchanged

  Scenario: the operator does not
    Given the same answer
    When any other key is pressed
    Then no further request was made
    And the offer is dismissed
```

**Notes:** the mode is taken off the response rather than spelled here for the same reason the
route is taken off `gateAnswerRequest`: a second copy of a vocabulary the daemon owns drifts from
it, and the drift shows up as guidance that is silently never delivered.

---

## EPIC-21-S32 — Nothing is running: the key is inert and the ledger is untouched

**Verifies:** KAR-21.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: an interjection at nothing is not an interjection

  Scenario: the run is between nodes
    Given a RunState with no node in a running status
    And a recording fetch
    When the interject intent is delivered
    Then no input opens
    Then the frame carries one line saying nothing is running to interject into
    And zero requests were made
```

**Notes:** the daemon would refuse this anyway — `node_not_running` — and the reason for refusing
it locally is not efficiency. It is that the refusal costs a round trip during which the operator
believes they have said something, and _an interjection recorded against a node that has finished
is an audit trail implying something happened_, which the daemon's own module note gives as the
reason a refusal appends nothing.

---

## EPIC-21-S33 — Each of the five refusals is shown in the daemon's own words

**Verifies:** KAR-21.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: five different problems are five different sentences

  Scenario Outline: a refusal arrives
    Given a daemon answering with the "<code>" refusal and its own message
    When an interjection is sent
    Then the frame shows that message verbatim
    And exactly one request was made
    And no retry was attempted

    Examples:
      | code            |
      | node_not_found  |
      | node_not_running|
      | use_respond     |
      | empty_text      |
      | stale_cursor    |

  Scenario: use_respond names the thing that does work
    Given the "use_respond" refusal on a human node
    Then the message shown is the daemon's, which directs the operator to answering the gate
    And the session does not silently convert the interjection into a gate answer
```

**Notes:** `use_respond` is the interesting one because the operator has reached for the wrong
mechanism on a node that is waiting for them, and the right mechanism is the one KAR-21.3 built and
is one key away. Converting it automatically would be the session deciding what the operator meant,
on a surface whose whole purpose is to stop guessing on their behalf.

---

## EPIC-21-S34 — An accepted interjection appears when the ledger has it, not before

**Verifies:** KAR-21.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the screen shows what happened, not what was attempted

  Scenario: a real daemon and the bundled agent
    Given a real DeFlowd on an ephemeral port with a PATH holding only deflow-mock-agent
    And a run with a node executing
    When an interjection is sent from the session and accepted with 202
    Then no line about it appears until the "human.interjected" event arrives on the stream
    And when it arrives, it is rendered by the existing transcript renderer
    And the line is the same one any other surface's interjection would produce
```

**Notes:** the optimistic line is the tempting shortcut and it is the one that makes a refused
interjection indistinguishable on screen from an accepted one. Deriving the line from the event
also means an interjection made in the browser shows up here, which is the same property KAR-19.12
AC7 established for gate answers and is free once the rule is "render the ledger".

---

## EPIC-21-S35 — Cancel asks first, and a bare Enter means no

**Verifies:** KAR-21.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: ending a run takes two decisions

  Scenario Outline: the confirmation is answered
    Given a session watching a running run
    When the cancel intent is delivered
    Then a confirmation appears naming the run id
    When <answer> is given
    Then cancelRun was called <calls> times

    Examples:
      | answer        | calls |
      | a bare Enter  | 0     |
      | "n"           | 0     |
      | dismiss       | 0     |
      | "y"           | 1     |
```

**Notes:** defaulting to no on a bare Enter is the same rule KAR-20.2 AC5 applies to editing a
shell profile, and for a stronger reason here: the thing on the other side of the keypress may have
hours of work in it. `cancelRun` is called, not re-implemented — it is the client
`deflow cancel` and the double-Ctrl-C path already use.

---

## EPIC-21-S36 — A confirmed cancel keeps the screen until the run actually ends

**Verifies:** KAR-21.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: you get to see how it ended

  Scenario: after confirming
    Given a confirmed cancel and a daemon that accepts it
    Then the outcome cancelRun returned is shown in the frame
    And the session remains open
    When the run's terminal event arrives
    Then the final verdict line is printed by RunRenderer.final as it is today
    And only then does the session close and restore the terminal
```

**Notes:** a cooperative cancel gives the agent the chance to flush its transcript first, so the
interesting part happens **after** the request returns. A session that exited on the request would
hide exactly the part the operator cancelled in order to look at.

---

## EPIC-21-S37 — Not a TTY: byte-identical to what the command printed before this epic

**Verifies:** KAR-21.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the non-interactive path is a fixed point

  Scenario: three non-interactive environments
    Given the golden output recorded from "deflow run" before KAR-21.1 was started
    When the same run is executed with stdout redirected to a file
    And with stdout piped to another process
    And with "--json"
    Then each output equals its golden byte for byte
    And no output contains a cursor-motion or erase sequence
    And "packages/cli/test/integration/run-json.test.ts" passes unmodified
    And "packages/cli/test/integration/terminal-output.test.ts" passes unmodified
```

**Notes:** this is the epic's regression bar and it is stated as bytes rather than as intent
because that is the only form of it that can fail. The two unmodified test files are the second
half: a suite that had to be edited to accommodate a change is a suite that stopped pinning what it
was written to pin.

---

## EPIC-21-S38 — `NO_COLOR`, `--no-color` and a non-UTF-8 locale reach the frame too

**Verifies:** KAR-21.5 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: one styling decision, honoured everywhere

  Scenario Outline: an environment that says no
    Given a Style built by createStyle from <environment>
    When the frame is rendered with it
    Then the frame contains no colour escape
    And it uses the <charset> glyph set
    And the decision was createStyle's, not one the frame made

    Examples:
      | environment              | charset |
      | NO_COLOR set             | utf8    |
      | --no-color passed        | utf8    |
      | LC_ALL=C                 | ascii   |
      | LANG=en_US.UTF-8         | utf8    |
```

**Notes:** `NO_COLOR` is read by **presence**, including the empty string, and an unset locale
means UTF-8 rather than Latin-1 — both of those are `style.ts`'s existing decisions and both are
easy to get subtly wrong a second time. The frame is given the answer; it does not compute one.

---

## EPIC-21-S39 — `TERM=dumb`: no frame at all, and the command says so

**Verifies:** KAR-21.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a terminal that cannot move a cursor does not get a redrawn region

  Scenario: TERM=dumb under a pty
    Given a pty at 80x24 and TERM=dumb in the child's environment
    When "deflow run" is spawned on it
    Then no cursor-motion or erase sequence is written
    And no frame is rendered
    And the transcript is printed as it is on a pipe
    And one line states that the live view is off because the terminal cannot address the cursor
```

**Notes:** the falling-back target is the stream, which is a thing that already works — that is the
whole argument for the pinned-footer shape over an alternate-screen application. Saying so in one
line rather than silently doing less is the same rule KAR-20.2 applies to a step it could not
perform.

---

## EPIC-21-S40 — A resized window re-lays the frame out

**Verifies:** KAR-21.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the window the operator has now is the window the frame fits

  Scenario: 80 columns becomes 40
    Given a pty at 80x24 with a session rendering frames
    When the pty is resized to 40x24
    Then the next frame is laid out at 40 columns
    And no line of it exceeds 40 characters except a single unbreakable token
    And the erase before that frame accounted for the height the previous one occupied at 80
```

**Notes:** the last Then is the subtle failure. A resize changes how many lines the *previous*
frame is currently occupying, so a writer that recomputes the old height at the new width erases
the wrong number of rows and leaves debris exactly once per resize — which is the kind of bug that
gets attributed to the terminal.

---

## EPIC-21-S41 — 40 and 20 columns are readable, not merely non-crashing

**Verifies:** KAR-21.5 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the split pane is a real place people watch runs

  Scenario Outline: a narrow frame is compared against its golden
    Given the state of EPIC-21-S01 and a Style of width <width>
    When the frame is rendered
    Then it equals the golden for that width
    And every node row still shows its glyph, its id and its status
    And the gate summary is still present and still complete

    Examples:
      | width |
      | 40    |
      | 20    |
```

**Notes:** goldens rather than property assertions here, because "readable" is a judgement and a
golden is how a judgement gets reviewed once and then held. EPIC-21-S02 asserts the property; this
asserts the result, and the two failing for different reasons is useful.

---

## EPIC-21-S42 — A burst of two hundred events is not two hundred repaints

**Verifies:** KAR-21.5 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: a fast run does not saturate a slow link

  Scenario: two hundred events in one tick
    Given a headless screen and a session
    When 200 events are delivered without yielding
    Then the number of frames the screen recorded is at or below the stated ceiling
    And the total bytes written are bounded by that ceiling times the frame size
    And the final frame reflects all 200 events
    And every one of the 200 transcript lines was written
```

**Notes:** the last two clauses are what stop the coalescing from becoming a correctness bug.
Repaints may be dropped; **events may not**. The transcript is append-only and every line is
written, and the frame is a projection whose intermediate values nobody needed to see.

The ceiling is a frame rate and is asserted as a bound rather than as a value, so tuning it after
the performed acceptance does not require rewriting this scenario.

---

## EPIC-21-S43 — A window too short for the frame gets the stream and one sentence

**Verifies:** KAR-21.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a frame taller than the window is worse than no frame

  Scenario: a pty of eight rows
    Given a pty at 80x8
    When "deflow run" is spawned on it with a plan of four nodes
    Then no frame is rendered
    And the transcript is printed as it is on a pipe
    And one line states the terminal is too short for the live view and names the height it needs
```

**Notes:** without this, each repaint scrolls the one before it and the screen becomes a flickering
ladder of half-frames — the failure that makes people say TUIs are broken over ssh. Naming the
height it needs is what lets the operator fix it in one action.

---

## EPIC-21-S44 — Every exit leaves the cursor at the start of a clean line

**Verifies:** KAR-21.5 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: the shell prompt does not land inside our status region

  Scenario Outline: the session ends
    Given a pty at 80x24 with a session rendering frames
    When the session ends by <ending>
    Then the last bytes written erase the frame
    And the cursor is left at column 0 of a line below the transcript
    And the terminal's attributes are the ones recorded before the child was spawned

    Examples:
      | ending                        |
      | the run completing            |
      | a single Ctrl-C detaching     |
      | a confirmed cancel finishing  |
      | an unexpected throw           |
      | SIGTERM                       |
```

**Notes:** this is EPIC-21-S13 through S15's terminal-mode property and the frame-erase property in
one place, because they are one experience: an operator whose shell comes back with echo off *and*
a prompt printed over a stale node list has been handed two problems by one command. The five
endings are the five ways a session actually stops.

---

## EPIC-21-S45 — `deflow --help` names the keys, and every key it names exists

**Verifies:** KAR-21.5 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the one document an operator reads is not the one thing that is wrong

  Scenario: both directions between the help and the decoder
    Given the usage text in "packages/cli/src/bin.ts"
    And the decoder's key table
    When the keys named in the help are compared against the table
    Then every key in the help is decoded by the table
    And every key that opens an input, answers a gate or cancels a run is named in the help
    And the help states that the live view appears only on a terminal
```

**Notes:** KAR-20.3 AC5 established this rule for flags — everything shown exists, and everything a
first run needs is shown — and a key is a flag the operator cannot see. The third clause is the one
that saves a support conversation: somebody running in CI who reads about a live view they will
never see should be told why in the same place.

---

**Related:** [EPIC-21](../epics/EPIC-21-interactive-cli.md) · [Board](../board.md) ·
[Delivery plan](../README.md) · [Testing strategy](../../14-testing-strategy.md)
