# EPIC-20 flows — One-command install and a lowercase command

> Behavioural specification for [EPIC-20](../epics/EPIC-20-install-and-naming.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 14 August 2026

## Actors

| Actor                    | Description                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New user**             | Someone who has never seen this repository and has no clone. They have a terminal, a `PATH` they did not design, and about five minutes                                |
| **Owner**                | The engineer who built it and could not install it on 2026-08-12. Every install scenario here is written from what they could observe that day                         |
| **`deflow` CLI**         | `packages/cli`, the one published package. Bins after this epic: `deflow`, `deflow-mcp`, `deflow-mock-agent`. Before it: the same three, capitalised                    |
| **The alias**            | `DeFlow` — the old name, kept working for one release, printing one notice line on **stderr** and nothing on stdout                                                    |
| **`setup`**              | `npx deflow setup`, and the macOS `curl … \| sh` script that reaches the same end state. Five steps: install, link, verify, doctor, adapters                            |
| **The clean room**       | KAR-18.6's `mktemp -d` + `git init -b main` + a fake `HOME` + a minimal `PATH`, installing the packed tarball — the exact bytes a user would get                        |
| **A fresh shell**        | A **new** login shell spawned after `setup` returned, resolving `PATH` from the profile files as a real terminal would. The distinction is the whole point of the epic  |
| **The global bin dir**   | Wherever `npm prefix -g`/`pnpm bin -g` resolves on this machine. On the owner's it was not on `PATH`, and nothing said so                                              |
| **Provider agent**       | A vendor CLI. Here it is `deflow-mock-agent` on a temp `PATH`, or a fake `claude` shim with no ACP bridge behind it, or deliberately absent                            |
| **The README**           | The root `README.md`. In this epic it is an artefact with a test, not prose somebody maintains by memory                                                               |
| **Platform**             | macOS (case-insensitive APFS by default) or Linux (case-sensitive ext4). The difference is load-bearing here and nowhere else in the backlog                           |

## Preconditions common to all flows

```gherkin
Background:
  Given a real git repository created with "git init -b main" in an fs.mkdtemp directory
  And GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced author/committer identity
  And HOME points at a directory inside that same tmpdir, so no scenario edits the author's own
      shell profile
  And XDG_DATA_HOME points inside that tmpdir too, so no scenario touches ~/.DeFlow
  And PATH is a temp PATH built for the scenario — never the developer's own, because "is it on
      PATH" is the property under test
  And no credential variable — no *_API_KEY, no *_TOKEN — is present in any child environment (AR-1)
  And every "installed" assertion is made by spawning the binary and reading its output, never by
      checking that an install command exited 0
  And every "on PATH" assertion is made in a shell spawned after the command returned, never in the
      process that ran it
  And the normalising snapshot serializer is registered before any snapshot is written, covering
      absolute paths, tmpdir names, versions and durations
  And no scenario calls vi.useFakeTimers() while a child process is alive
  And the platform under test is stated wherever it changes the expected outcome
```

> Two of these carry this epic. **A fresh shell** is the difference between the install that
> reported success on 2026-08-12 and the install that worked: the process that edits a profile
> already has its own environment, and asserting `PATH` inside it proves nothing about the shell the
> user opens next. **Spawning the binary** is the second: `pnpm link --global` exited 0 and produced
> no usable command, so an exit code is not evidence and this file never treats it as one.
>
> **`HOME` inside the tmpdir** matters more here than in any other flow file, because these are the
> only scenarios in the backlog that write to a shell profile. A scenario that leaks out of the
> tmpdir edits the author's real `~/.zshrc`.

## Flow index

| Scenario    | Title                                                                                     | Verifies | Type        |
| ----------- | ------------------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-20-S1  | Happy path: the published command is `deflow`                                              | KAR-20.1 | Happy path  |
| EPIC-20-S2  | All three bins are lowercase, and all three resolve from a clean-room install              | KAR-20.1 | Happy path  |
| EPIC-20-S3  | **`DeFlow` still works, and says once that it is the old name**                            | KAR-20.1 | Edge case   |
| EPIC-20-S4  | The deprecation notice never reaches stdout or a `--json` document                         | KAR-20.1 | Failure     |
| EPIC-20-S5  | **One directory entry on macOS, two on Linux: the alias cannot be a second file**          | KAR-20.1 | Edge case   |
| EPIC-20-S6  | **No two tracked paths differ only by case**                                               | KAR-20.1 | Failure     |
| EPIC-20-S7  | No shipped string still names the capitalised command                                      | KAR-20.1 | Failure     |
| EPIC-20-S8  | What is deliberately not renamed, and a guard that says so                                 | KAR-20.1 | Edge case   |
| EPIC-20-S9  | A repository initialised before the rename keeps working, unmigrated                       | KAR-20.1 | Recovery    |
| EPIC-20-S10 | The bundled agent is `deflow-mock-agent` everywhere that spawns it                         | KAR-20.1 | Edge case   |
| EPIC-20-S11 | **Happy path: one command, and `deflow` works in a shell opened afterwards**               | KAR-20.2 | Happy path  |
| EPIC-20-S12 | The macOS script reaches the same end state as `npx deflow setup`                          | KAR-20.2 | Happy path  |
| EPIC-20-S13 | Five steps, in order, each with a state and a summary block that says what to do next      | KAR-20.2 | Happy path  |
| EPIC-20-S14 | **Verification is a subprocess: a link that lied is caught**                               | KAR-20.2 | Failure     |
| EPIC-20-S15 | **The global bin directory is not on `PATH` — the 2026-08-12 failure, named**              | KAR-20.2 | Failure     |
| EPIC-20-S16 | A shell profile is never edited without naming the file and printing the line              | KAR-20.2 | Edge case   |
| EPIC-20-S17 | Running `setup` twice changes nothing the second time                                      | KAR-20.2 | Edge case   |
| EPIC-20-S18 | **It cannot put the binary on `PATH`: the exact line, the exact file, a non-zero exit**    | KAR-20.2 | Failure     |
| EPIC-20-S19 | `doctor` runs last and its verdict does not become the installer's                         | KAR-20.2 | Edge case   |
| EPIC-20-S20 | Missing ACP adapters are offered through KAR-18.8, and declining installs nothing          | KAR-20.2 | Edge case   |
| EPIC-20-S21 | Non-interactive: `--json`, stdin closed, no prompt, no hang                                | KAR-20.2 | Edge case   |
| EPIC-20-S22 | **Nothing global is installed without consent except the tool itself**                     | KAR-20.2 | Failure     |
| EPIC-20-S23 | zsh, bash and fish get the right file; an unknown shell is told, not guessed               | KAR-20.2 | Edge case   |
| EPIC-20-S24 | No network egress, and Windows                                                             | KAR-20.2 | Failure     |
| EPIC-20-S25 | **Performed: installed from nothing, in one fresh shell, checked in another**              | KAR-20.2 | Happy path  |
| EPIC-20-S26 | Happy path: the README's install section is one command                                    | KAR-20.3 | Happy path  |
| EPIC-20-S27 | **Every command in the README is executed, and exits as the README says**                  | KAR-20.3 | Happy path  |
| EPIC-20-S28 | The contributor path survives, below and labelled                                          | KAR-20.3 | Edge case   |
| EPIC-20-S29 | **Every documented flag exists, and `--provider` is documented**                           | KAR-20.3 | Failure     |
| EPIC-20-S30 | **The agent CLI package names install what the README says they install**                  | KAR-20.3 | Failure     |
| EPIC-20-S31 | No capitalised command line survives in the README                                         | KAR-20.3 | Failure     |
| EPIC-20-S32 | Sabotage: a README claim that stops being true turns a test red                            | KAR-20.3 | Failure     |
| EPIC-20-S33 | **Performed: a person follows the README top to bottom**                                   | KAR-20.3 | Edge case   |

---

## EPIC-20-S1 — Happy path: the published command is `deflow`

**Verifies:** KAR-20.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: the command has the name a shell user expects

  Scenario: the package declares a lowercase command
    Given "packages/cli/package.json"
    When its "bin" map and "name" field are read
    Then "bin" has exactly the keys "deflow", "deflow-mcp" and "deflow-mock-agent"
    And every value in "bin" points at a file the build produces
    And "name" is "deflow"
    And no key in "bin" and no character of "name" is an upper-case letter
    And the root "pack:check" script selects the package by "deflow" and still resolves it
```

**Notes:** `name` is not cosmetic. npm has refused new package names containing capital letters
since 2017, so `DeFlow` is not a publishable name and `npx deflow setup` — which resolves a package
name, not a bin name — cannot work until this changes.

---

## EPIC-20-S2 — All three bins are lowercase, and all three resolve from a clean-room install

**Verifies:** KAR-20.1 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: the published names are the names that resolve

  Scenario: the tarball's three commands resolve by their lowercase names
    Given a clean room with the packed tarball installed and no DeFlow on PATH beforehand
    When "deflow --version", "deflow-mcp --help" and "deflow-mock-agent --version" are each spawned
    Then each exits 0
    And "deflow --version" prints the version in "packages/cli/package.json"
    And each resolved path is inside the clean room's own install prefix
    And this holds on both "macos-26" and "ubuntu-26.04"
```

**Notes:** a bin key renamed without its target shipping is invisible from inside the monorepo —
that is the whole argument of KAR-18.6, applied to a rename.

**Level corrected (2026-08-14), from `integration` to `e2e`.** The clean room this scenario names is
KAR-18.6's, and KAR-18.6's own three scenarios (EPIC-18-S42, S45, S46) are declared `e2e` because it
costs a real `pnpm build` and a real `pnpm pack`. Standing a second one up in the integration project
to spawn three binaries would add minutes to every save and assert nothing the tarball already packed
in `e2e/install-verification.test.ts`'s `beforeAll` cannot answer. Automated there, in the suite named
for this scenario id.

**`deflow-mcp --help` is a behaviour this scenario created.** Before it, every argv the shim did not
recognise was `EX_USAGE` — `--help` included — so the only question a clean room could ask the second
bin was one a *correct* build also answered 64. There is nothing else to ask it: every other argv
needs a running DeFlowd, a socket it opened and a run token it minted. The usage text goes to stdout
and returns before any MCP transport exists, so it contaminates nothing.

---

## EPIC-20-S3 — `DeFlow` still works, and says once that it is the old name

**Verifies:** KAR-20.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: nobody is broken mid-flight

  Scenario: the old name runs the same program
    Given a clean room where both "deflow" and "DeFlow" have been linked
    When "DeFlow doctor" and "deflow doctor" are each run against the same machine state
    Then both exit with the same code
    And both write byte-identical stdout once the notice is excluded
    And "DeFlow" writes exactly one line to stderr
    And that line names the old name, the new name and the release the alias is removed in
    And "deflow" writes no such line to stderr

  Scenario: the alias expires by going red rather than by being remembered
    Given the package version has passed the release named in the notice
    Then the test that pins the expiry fails
```

**Notes:** the second scenario is the one with teeth. An alias nobody removes is a second supported
spelling forever; making its expiry a failing test is the only mechanism that has ever worked.

---

## EPIC-20-S4 — The deprecation notice never reaches stdout or a `--json` document

**Verifies:** KAR-20.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: a compatibility shim is not allowed to break a contract

  Scenario Outline: the notice stays on stderr
    Given the program is invoked through the old name as "<command>"
    And stdout is piped to a file and stderr is captured separately
    When the command completes
    Then the file contains no occurrence of the notice text
    And <assertion>

    Examples:
      | command                  | assertion                                              |
      | DeFlow doctor --json     | the file parses as exactly one JSON document           |
      | DeFlow run --json …      | every line of the file parses as JSON                  |
      | DeFlow status --json     | the file parses as exactly one JSON document           |
      | DeFlow ledger snapshot … | the file contains only what the command normally emits |
```

**Notes:** KAR-18.9 AC6 pinned every `--json` document to a golden precisely so a presentation change
could not break CI. A deprecation notice written with `console.log` is the same defect arriving from
a different direction.

---

## EPIC-20-S5 — One directory entry on macOS, two on Linux: the alias cannot be a second file

**Verifies:** KAR-20.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the rename is honest about the filesystem it lands on

  Scenario: a case-sensitive filesystem has two entries
    Given a Linux clean room with both bin names linked
    Then the global bin directory contains two distinct entries, "deflow" and "DeFlow"
    And running each one runs the program
    And only the "DeFlow" entry prints the deprecation notice

  Scenario: a case-insensitive filesystem has one entry
    Given a macOS clean room with both bin names linked
    Then the global bin directory contains one entry for the two names
    And "deflow --version" and "DeFlow --version" both run the program and print the same version
    And neither invocation fails, and neither leaves a broken link behind
```

**Notes:** this is the scenario the story's "a rename that only works on a Mac is not done" clause
exists for, and it points the other way too. On macOS the two names are one directory entry, so the
alias **cannot** be a separate file there; the notice is decided at runtime from
`basename(process.argv[1])`, which is exact on Linux and best-effort on macOS. The behaviour that is
never allowed to differ is that the program runs.

---

## EPIC-20-S6 — No two tracked paths differ only by case

**Verifies:** KAR-20.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: git does not hide a case collision from the person who created it

  Scenario: the repository has no case-only path pair
    Given the list of tracked paths from "git ls-files"
    When every path is lower-cased and the result is checked for duplicates
    Then there are none
    And the check runs on the case-sensitive CI runner, not only on the author's machine

  Scenario: a case-only rename is done in two steps
    Given a file whose name must change case
    Then the change is recorded as a rename through an intermediate name
    And no build script performs a one-step case-only rename of the same path
```

**Notes:** this checkout has `core.ignorecase = true`. A one-step case-only rename on macOS is a
no-op that reports success, and the divergence surfaces on Linux as two files with the same content
— usually weeks later, in somebody else's failing build.

---

## EPIC-20-S7 — No shipped string still names the capitalised command

**Verifies:** KAR-20.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the tool does not tell you to type a command that no longer exists

  Scenario: a source guard over every shipped string
    Given every file under "packages/*/src" and every file under "docs/"
    When each is scanned for the capitalised command as a whole word followed by a space,
        a quote or an end of string
    Then there are no matches outside the alias module and its own tests
    And the guard covers constructed strings, not only literals, by asserting on the rendered
        output of every refusal listed in KAR-18.2 AC3, KAR-18.3 AC3 and KAR-19.6

  Scenario: a message assembled at runtime is caught too
    Given a refusal whose command name is interpolated rather than written inline
    When the refusal is rendered
    Then the rendered text names the lowercase command
```

**Notes:** the second scenario is why this is not a `grep`. A find-and-replace fixes every literal
and misses the two or three places where the command name is built from a constant, and those are
exactly the paths a user only reaches when something has already gone wrong.

---

## EPIC-20-S8 — What is deliberately not renamed, and a guard that says so

**Verifies:** KAR-20.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the boundary of the rename is a decision, not an accident

  Scenario Outline: the five names that keep their spelling
    Given the rename has been applied
    Then "<name>" still appears with its original spelling in "<where>"
    And the guard fails if it changes

    Examples:
      | name                          | where                                                  |
      | .DeFlow/                      | the repo-local state directory init creates            |
      | $XDG_DATA_HOME/DeFlow         | the resolved global state directory                    |
      | DeFlow_* environment variables| every env read across the workspace                    |
      | @DeFlow/*                     | the workspace package scope, none of it published      |
      | DeFlow/<runId>__<nodeId>      | the branch-name template                               |
```

**Notes:** each one has a reason and the reasons are different. The two directories would orphan
every already-initialised repository; the env vars would buy a second deprecation window for
something nobody types; the scope is invisible outside this repo; the branch prefix would strand
in-flight worktrees. Recording them here is what makes this a boundary rather than an oversight.

---

## EPIC-20-S9 — A repository initialised before the rename keeps working, unmigrated

**Verifies:** KAR-20.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: upgrading does not cost you your configuration

  Scenario: an existing .DeFlow/ is read as it stands
    Given a repository initialised by the previous release, with an edited ".DeFlow/config.yaml",
          a custom gate under ".DeFlow/gates/" and entries in ".DeFlow/memory/"
    And a global state directory containing a probe cache and a ledger
    When the renamed binary runs "deflow doctor" and "deflow status" in that repository
    Then the existing config, gate and memory are read unchanged
    And nothing under ".DeFlow/" is renamed, moved or rewritten
    And "git status --porcelain" reports no change caused by the upgrade
```

**Notes:** the failure this forbids is a global find-and-replace that renames the state directory
too. The user's gates and memory are the most expensive thing they own here, and an upgrade that
quietly abandons them is worse than one that refuses to start.

---

## EPIC-20-S10 — The bundled agent is `deflow-mock-agent` everywhere that spawns it

**Verifies:** KAR-20.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the zero-install run keeps working through the rename

  Scenario: a run on a PATH holding only the bundled agent
    Given a temp PATH containing "deflow-mock-agent" and no vendor CLI
    And the provider registry's bundled entry
    When a run is submitted through the built binary
    Then the registry resolves "deflow-mock-agent" on that PATH
    And the run reaches "run.completed" and the command exits 0
    And no scenario in this file references the capitalised binary name on a PATH
```

**Notes:** the bundled agent is what makes the whole backlog testable without credentials. If the
rename misses the registry entry or the testkit's temp-`PATH` helper, every vendor-free scenario in
every epic stops resolving its own agent — a large, loud failure, which is the good case; the bad
case is that it resolves on macOS by case-insensitivity and fails only in CI.

---

## EPIC-20-S11 — Happy path: one command, and `deflow` works in a shell opened afterwards

**Verifies:** KAR-20.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: install in one command

  Scenario: a machine with no deflow, and no clone
    Given a clean room with a fake HOME, a minimal PATH and no "deflow" anywhere on it
    And no clone of this repository
    When the new user runs "npx deflow setup"
    Then the report lists the steps install, link, verify, doctor and adapters, in that order
    And every step reports "ok"
    And the command exits 0
    When a new login shell is spawned, resolving PATH from the profile files
    And "deflow --version" is run inside it
    Then it exits 0 and prints the installed version
    And the resolved path of "deflow" is inside the clean room's install prefix
```

**Notes:** the second `When` is the scenario. Asserting `PATH` inside the process that just edited a
profile proves only that the process can see its own environment — which is what a passing check
would have said on 2026-08-12, while the operator's next terminal said `command not found`.

---

## EPIC-20-S12 — The macOS script reaches the same end state as `npx deflow setup`

**Verifies:** KAR-20.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: two entry points, one outcome

  Scenario: the curl-to-shell script on macOS
    Given a macOS clean room with a fake HOME and no "deflow" on PATH
    When the install script is fetched to a file, read, and executed with "sh"
    Then it reports the same five steps in the same order through the same layer
    And a shell spawned afterwards resolves "deflow" and prints the installed version
    And the end state — binary location, profile line, doctor verdict — matches what
        "npx deflow setup" produced in EPIC-20-S11 on the same machine

  Scenario: the script does nothing the npx path does not
    Then the script installs no package beyond the one the npx path installs
    And it writes no file the npx path does not write
```

**Notes:** the second scenario is the answer to "why would I pipe your script into my shell". The
script is a bootstrap for a machine without Node; it is not a second, more powerful installer, and
the README shows the download-then-read form beside the piped one.

**Amended 2026-08-14 while implementing KAR-20.2.** The first scenario is automated at `e2e`
(`e2e/setup-install.test.ts`, both entry points into two clean rooms, then a real interactive shell
in each). The **second** is automated at `unit`, as a source guard over the script
(`test/install-script.test.ts`), and that is a strengthening rather than a downgrade: "it installs
no package the npx path does not" is a claim about everything the script *can* do, and one observed
run cannot distinguish a script that installs nothing from one that would install something on a
machine with Homebrew on it. The guard reads the script the way a suspicious operator would — one
`exec`, no second package name, no `sudo`, no redirection into a file, no `PATH` edit of its own.

---

## EPIC-20-S13 — Five steps, in order, each with a state and a summary block that says what to do next

**Verifies:** KAR-20.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: the installer reads like the rest of the tool

  Scenario: the report is KAR-18.9's, not a second formatter
    Given a clean room
    When "deflow setup" runs
    Then each of install, link, verify, doctor and adapters is one check with a glyph,
         a text label and a colour, in that fixed order
    And stripping every ANSI sequence from the report loses no information
    And the report ends with a summary block whose first line is one next action naming a command
    And no module outside the shared render module emitted an ANSI escape or a status glyph

  Scenario: a failed step stops the sequence
    Given the link step reports "fail"
    Then the verify, doctor and adapters steps are reported as "skipped" with the reason
    And no adapter is installed and no profile is written
```

**Notes:** `skipped` is a first-class state in KAR-18.9 AC2 for exactly this shape. "We did not get
that far" and "that passed" must not look alike in a report somebody is reading because something
already went wrong.

---

## EPIC-20-S14 — Verification is a subprocess: a link that lied is caught

**Verifies:** KAR-20.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: an exit code is not evidence

  Scenario: the link step exits 0 and puts nothing on PATH
    Given a stubbed link step that exits 0 and creates no entry anywhere on PATH
    When "deflow setup" runs
    Then the verify step spawns "deflow --version" in a shell resolving a fresh-login PATH
    And the spawn fails to resolve the command
    And the verify step is "fail" naming what it tried to run and what happened
    And the overall exit code is non-zero
    And the summary block's next action is the line that would fix it

  Scenario: the version is unreadable
    Given a "deflow" on PATH that exits 0 and prints nothing parseable as a version
    Then the verify step is "fail" rather than "ok"
```

**Notes:** this is the 2026-08-12 defect in miniature. `pnpm link --global` exited 0 and produced no
usable command; anything downstream that trusted that exit code inherited the lie.

---

## EPIC-20-S15 — The global bin directory is not on `PATH` — the 2026-08-12 failure, named

**Verifies:** KAR-20.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: say the thing that was not said

  Scenario: the prefix exists, is written to, and is invisible
    Given a clean room whose npm global prefix resolves to a real directory
    And that directory is deliberately absent from PATH
    When "deflow setup" runs
    Then the link step names that directory by its absolute path
    And states that it is not on PATH
    And prints the exact line that would put it there and the file to put it in
    And the link step is not reported as "ok"
    And the verify step is "fail" rather than being skipped as unnecessary

  Scenario: the pnpm case
    Given the same machine where "pnpm bin -g" resolves elsewhere and is also not on PATH
    Then the report names the pnpm directory too, rather than reporting only npm's
```

**Notes:** this is the scenario the epic exists for and it should be read as the acceptance test of
its argument. The owner's install failed here, silently, with a success message; the difference
between the old behaviour and the new one is entirely in what is printed.

**Amended 2026-08-15 while performing AC15.** A third scenario is automated at `integration`
(`packages/cli/test/integration/setup.test.ts`, "the directory npm named is not there"):

```gherkin
  Scenario: npm names a directory that is not there
    Given a machine where "npm prefix -g" answers with a directory that does not exist
    When "deflow setup" runs
    Then no line is appended to any shell profile
    And the link step is "fail", naming that directory and saying it does not exist
    And the command exits non-zero
```

It is here because the performed acceptance found it rather than because anyone predicted it. The
clean room sat under a path with a UUID-shaped segment, and **npm 11 redacts token-shaped strings
out of its own output** — so `npm prefix -g` answered with `…/***/…`, a directory that had never
existed. `setup` believed the string and appended a `PATH` line pointing nowhere. `verify` did catch
it and the command exited 1, which is this story's central claim holding up under a failure nobody
designed for; but a dotfile had already been edited to add a directory that was not there, and AC5
is a promise about what gets **written**, not only about what gets reported. So the resolved
directory is now an observation like every other step: if it is not there, nothing is appended.

---

## EPIC-20-S16 — A shell profile is never edited without naming the file and printing the line

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: consent before a dotfile is touched

  Scenario Outline: the prompt
    Given a fake HOME with an existing "<profile>"
    And stdout is a scripted TTY answering "<answer>"
    When "deflow setup" reaches the link step
    Then the absolute path of "<profile>" and the exact line to append are both printed
        before any write
    And the file is <outcome>

    Examples:
      | profile  | answer      | outcome                          |
      | .zshrc   | y           | appended exactly one line        |
      | .zshrc   | n           | byte-identical to before         |
      | .zshrc   | <Enter>     | byte-identical to before         |

  Scenario: --yes writes without asking and still says what it wrote
    Given stdout is not a TTY and "--yes" was passed
    When the link step runs
    Then the file and the appended line are printed
    And exactly one line is appended

  Scenario: no TTY and no --yes writes nothing
    Given stdout is not a TTY and "--yes" was not passed
    Then no profile file is modified
    And the line to add is printed for the operator to add themselves
```

**Notes:** a bare Enter must mean **no**, the same default KAR-18.8 AC4 settled for the adapter
offer. The blast radius here is larger — a wrong line in a shell profile follows somebody into every
terminal they open — so the rule is inherited rather than relaxed.

---

## EPIC-20-S17 — Running `setup` twice changes nothing the second time

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: re-runnable, because people re-run things

  Scenario: the second run is a fixpoint
    Given "deflow setup" has already completed successfully in this clean room
    When it is run a second time
    Then the profile file is byte-identical to what the first run left
    And no link is recreated that is already correct
    And every step reports "ok — already" rather than repeating its work
    And the command exits 0

  Scenario: two runs at once do not interleave
    Given two "deflow setup" processes started concurrently against the same fake HOME
    Then the profile file contains the export line exactly once
    And neither process leaves a partially written file
```

**Notes:** an installer people run twice is an installer that appends twice unless it is written not
to. The concurrent case is not hypothetical on a machine where someone ran it, thought nothing
happened, and ran it again in another tab — which is how the owner met the daemon lease, too.

---

## EPIC-20-S18 — It cannot put the binary on `PATH`: the exact line, the exact file, a non-zero exit

**Verifies:** KAR-20.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: failing honestly is allowed; reporting success is not

  Scenario: the link target is not writable
    Given a clean room whose global bin directory is chmod 0500
    When "deflow setup" runs
    Then the link step is "fail" naming the absolute path and the errno
    And the report prints the exact line to add and the absolute path of the file to add it to
    And the summary block's first line is that next action
    And the command exits non-zero
    And no step after link is reported as "ok"

  Scenario: a report with a fail never exits 0
    Given any run of "deflow setup" whose report contains a "fail"
    Then the exit code is non-zero
```

**Notes:** the second scenario is a one-line invariant and it is the one that matters. Exit 0 with a
`fail` in the body is how a script wrapping this command — or a person skimming it — concludes the
install worked.

---

## EPIC-20-S19 — `doctor` runs last and its verdict does not become the installer's

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a degraded machine is not a failed install

  Scenario: doctor exits 5 on a machine that installed correctly
    Given a clean room where the install, link and verify steps all reported "ok"
    And a "doctor" that exits 5 because the state directory is unwritable
    When "deflow setup" runs
    Then the doctor step reports doctor's own findings through the same layer
    And the report distinguishes "installed, and this machine has problems" from
        "installation failed"
    And "deflow setup" exits 0
    And the summary block's next action is doctor's own next action

  Scenario: doctor cannot be run at all
    Given the verify step failed
    Then the doctor step is "skipped" with that reason, and doctor is not spawned
```

**Notes:** KAR-18.4 AC11 fixed `doctor`'s exit-code contract as _5 means DeFlow cannot run here_, not
_something is imperfect_. Forwarding it as the installer's exit code would overload a code CI already
branches on, and would call a successful install a failure.

---

## EPIC-20-S20 — Missing ACP adapters are offered through KAR-18.8, and declining installs nothing

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the adapter offer is called, not reimplemented

  Scenario: a vendor CLI with no bridge
    Given a fake "claude" on the temp PATH and no "claude-agent-acp"
    And a fake "npm" that records its argv
    And stdout is a scripted TTY answering "y"
    When "deflow setup" reaches the adapters step
    Then exactly one prompt is shown, naming the exact command to be run
    And "npm" is called exactly once with "install -g @agentclientprotocol/claude-agent-acp"
    And the provider is re-resolved afterwards rather than assumed installed

  Scenario: declining
    Given the same machine and a scripted TTY answering "n"
    Then no child process is spawned by the adapters step
    And the command to run is printed
    And the overall exit code is unchanged

  Scenario: a vendor CLI that is not present
    Given a temp PATH with no vendor CLI at all
    Then no adapter is offered and none is installed under any flag
    And the step reports the install hints and does not fail
```

**Notes:** these are KAR-18.8's own rules, asserted here because `setup` is a second caller and a
second caller is how consent rules drift apart. The assertion is that the same function is used —
not that two implementations happen to agree today.

---

## EPIC-20-S21 — Non-interactive: `--json`, stdin closed, no prompt, no hang

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: safe to run from a script

  Scenario: piped stdout and closed stdin
    Given "deflow setup --json" with stdout piped to a file and stdin closed
    When it runs to completion
    Then the file parses as one JSON document with a per-step result
    And the document contains no ANSI escape and no summary block
    And no prompt was written to any stream
    And the process never blocked on a read
    And the exit code matches what the text renderer would have produced for the same machine
```

**Notes:** the hang is the real failure here. Gating a prompt on `process.stdout.isTTY` alone leaves
a CI job waiting on a stdin read that can never be answered — the same trap KAR-18.8 AC6 closed for
`doctor --json --fix`.

---

## EPIC-20-S22 — Nothing global is installed without consent except the tool itself

**Verifies:** KAR-20.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: an installer is trusted or it is uninstalled

  Scenario: a spawn guard over a whole run
    Given a clean room where every child process spawn is recorded with its argv
    When "deflow setup" runs to completion with no prompt answered affirmatively
    Then exactly one recorded spawn mutates global state, and it installs this package
    And no recorded spawn is a global update, a package-manager installation, or "sudo"
    And no recorded spawn installs a vendor CLI

  Scenario: AR-1 holds across the whole run
    Then no credential file was opened
    And no login subcommand's output was captured
    And no *_API_KEY or *_TOKEN variable was read
```

**Notes:** the exception is deliberately exactly one thing — the tool the user just asked to install
— and it is stated as a guard rather than a promise, because "we would never do that" is not a
property a test can check and "exactly one spawn" is.

---

## EPIC-20-S23 — zsh, bash and fish get the right file; an unknown shell is told, not guessed

**Verifies:** KAR-20.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the profile file is chosen by name, never by assumption

  Scenario Outline: the file per shell
    Given $SHELL is "<shell>" on "<platform>"
    When the link step needs to extend PATH
    Then the file it names is "<file>"
    And the line it prints is valid syntax for that shell

    Examples:
      | shell | platform | file                          |
      | zsh   | macOS    | ~/.zshrc                      |
      | zsh   | Linux    | ~/.zshrc                      |
      | bash  | macOS    | ~/.bash_profile               |
      | bash  | Linux    | ~/.bashrc                     |
      | fish  | either   | ~/.config/fish/config.fish    |

  Scenario: an unrecognised shell
    Given $SHELL is "/usr/bin/nonsense"
    Then the link step is "warn"
    And it prints the line to add and says it could not determine where to add it
    And no file is written
```

**Notes:** fish is in the table because `export PATH=…` is not fish syntax, and writing bash syntax
into `config.fish` produces an error on every new terminal the user opens — a worse outcome than
doing nothing.

---

## EPIC-20-S24 — No network egress, and Windows

**Verifies:** KAR-20.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the two environments where the answer is "not here"

  Scenario: no egress
    Given a clean room with network egress blocked
    When "deflow setup" runs
    Then the install step is "fail" carrying npm's own stderr, trimmed but not paraphrased
    And exactly one install attempt was made, with no retry
    And no profile line was written and no partial link was left behind
    And the command exits non-zero

  Scenario: Windows
    Given the platform is win32
    When "deflow setup" runs
    Then it refuses in one sentence naming NF5 and the WSL2 instruction
    And it exits non-zero
    And no file was read or written outside the current directory
```

**Notes:** NF1 says full functionality with no network beyond what the provider CLIs need — which
`setup` cannot honour, since it fetches a package, so the requirement it must honour instead is that
an offline machine costs **one** timeout and gets told the truth. NF5 puts Windows at M3; saying so
is cheaper than half-working there.

---

## EPIC-20-S25 — Performed: installed from nothing, in one fresh shell, checked in another

**Verifies:** KAR-20.2 · **Type:** Happy path · **Automated at:** manual

```gherkin
Feature: the acceptance is performed, not asserted

  Scenario: a real machine with no deflow on PATH
    Given a machine where "which deflow" finds nothing
    When the operator opens a fresh shell and runs the one command
    And the command completes
    And the operator opens a different fresh shell
    And runs "deflow doctor" in it
    Then "deflow doctor" runs and prints its report
    And "which deflow" in that second shell prints an absolute path
    And the transcript — the command, its output, both shells' "which deflow" — is pasted into
        KAR-20.2 and onto its Linear issue

  Scenario: a green suite is not accepted as evidence for this story
    Given every automated scenario in this file passes
    And no such install has been performed since the change
    Then KAR-20.2 is not Done
```

**Notes:** the second scenario is the standing correction. This epic exists because a green suite
coexisted with an install that did not work for the person who wrote it, so accepting the suite as
its own acceptance would reproduce the defect at the level of the plan. The same shape as
EPIC-19-S78, for the same reason.

---

## EPIC-20-S26 — Happy path: the README's install section is one command

**Verifies:** KAR-20.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: the first thing a reader sees is the thing that works

  Scenario: the install section
    Given the root "README.md"
    When its install section is read
    Then it contains exactly one command as the install path
    And that command is KAR-20.2's
    And the macOS script is named as the alternative for a machine with no Node
    And the section contains no "pnpm build" followed by a link step
    And it contains no "node packages/cli/dist/bin.mjs" and no hand-written "alias"
```

**Notes:** the three things this forbids are the three things that are there today. They are not
instructions — they are hints for a reader who already knows the answer, which is the one reader who
does not need them.

---

## EPIC-20-S27 — Every command in the README is executed, and exits as the README says

**Verifies:** KAR-20.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: the README has a build

  Scenario: extraction
    Given the root "README.md"
    When its fenced shell blocks are parsed into a list of commands
    Then every command is either executable in the clean room or on a named skip list
    And every skip-list entry carries a reason
    And the skip list is asserted to be short and enumerated, not a catch-all pattern

  Scenario: execution
    Given a clean room with the packed tarball
    When each executable command is run in the order the README presents it
    Then each exits with the code the README claims for it
    And the install and first-run commands together leave a machine on which "deflow doctor" runs
```

**Notes:** the skip list is the part that rots. A command that needs a vendor login or opens a
browser is legitimately unrunnable here; a skip list that grows to cover the interesting half turns
this test into decoration, which is why AC4 asks for it to be enumerated and short rather than a
pattern.

---

## EPIC-20-S28 — The contributor path survives, below and labelled

**Verifies:** KAR-20.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: two audiences, told apart

  Scenario: from source is for contributors
    Given the root "README.md"
    Then a from-source section exists containing "pnpm install" and the build
    And it appears after the install section, not before it
    And it opens with a sentence naming who it is for
    And the install section does not link to it as the way to install
```

**Notes:** the from-source path is not wrong, it was mis-filed: it is how you work on DeFlow, and it
was presented as how you install DeFlow. Keeping it and labelling it costs a sentence.

---

## EPIC-20-S29 — Every documented flag exists, and `--provider` is documented

**Verifies:** KAR-20.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the flags in the docs and the flags in the program are the same set

  Scenario: both directions
    Given the flags shown in "README.md"
    And the flags listed by "deflow --help"
    Then every README flag exists in --help
    And "--provider" appears in both

  Scenario: the flag that exists and is documented nowhere
    Given "--provider" is accepted by "deflow run"
    Then it appears in the usage block
    And it appears in the README's first-run or terminal section with what it takes
```

**Notes:** `--provider` is real — `packages/cli/src/run/args.ts` parses it and refuses an unknown
value with the registry's own list — and it is in neither the usage block nor the README. It was
added by KAR-19.10 because an operator tried it and got `unknown option`; documenting it is the
other half of that fix.

---

## EPIC-20-S30 — The agent CLI package names install what the README says they install

**Verifies:** KAR-20.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the difference between a vendor CLI and its ACP adapter, in the README too

  Scenario: each named package is checked against the registry
    Given the README's agent-CLI block
    When each package name is resolved against the provider registry
    Then a package that equals a provider's "spec.package" is labelled as the ACP adapter
    And a package that installs a provider's "spec.shim.bin" is labelled as the vendor CLI
    And no line claims that installing an adapter gives you the vendor CLI

  Scenario: the two lines that are wrong today
    Given the lines naming "@agentclientprotocol/claude-agent-acp" and
          "@agentclientprotocol/codex-acp"
    Then neither is presented as the way to install "claude" or "codex"
    And the README states which of the two a first run actually needs
```

**Notes:** this is KAR-18.8's distinction — `spec.bin` is what DeFlow spawns, `spec.shim.bin` is the
vendor CLI — reaching the document a reader meets before `doctor` exists on their machine. A reader
who runs the whole block today still has no `claude` and no `codex`, and their first `doctor` will
tell them so in words the README just contradicted.

---

## EPIC-20-S31 — No capitalised command line survives in the README

**Verifies:** KAR-20.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: the rename reaches the file every new reader opens first

  Scenario: a wording guard
    Given the root "README.md"
    Then no fenced block and no inline code span contains the capitalised command
         followed by a subcommand
    And prose about the product may still use the product's own spelling
    And every command shown is one "deflow --help" would recognise
```

**Notes:** the split between "the command" and "the product name" is deliberate and is the same
split KAR-20.1 AC8 draws. PRD §15.6 still owns the product name; nothing here pre-empts it.

---

## EPIC-20-S32 — Sabotage: a README claim that stops being true turns a test red

**Verifies:** KAR-20.3 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: a test that cannot fail is not a test

  Scenario Outline: each sabotage is caught by a named test
    Given the README as written
    When "<sabotage>" is applied
    Then "<test>" fails

    Examples:
      | sabotage                                              | test                          |
      | a documented exit code is changed in the program      | the execution test            |
      | a documented flag is removed from the parser          | the flag cross-check          |
      | a provider's package name changes in the registry     | the package-name cross-check  |
      | the install command is renamed                        | the execution test            |
```

**Notes:** the sabotage table is KAR-19.5's mechanism, borrowed. Its point is that a README test can
pass by asserting that commands merely run, and would then never notice a wrong claim — which is the
exact failure mode this story is fixing in prose.

---

## EPIC-20-S33 — Performed: a person follows the README top to bottom

**Verifies:** KAR-20.3 · **Type:** Edge case · **Automated at:** manual

```gherkin
Feature: instructions are judged by somebody following them

  Scenario: a read-through on a machine with no deflow
    Given a machine where "which deflow" finds nothing
    And a fresh shell
    When a person reads the README from the top and does only what it says
    Then they reach a working "deflow doctor" without consulting any other document
    And every point at which they had to stop and think is written down
    And each such point becomes either a README change or a note in KAR-20.3

  Scenario: no substitution is accepted for this
    Given every automated scenario in this file passes
    Then this scenario is still required before KAR-20.3 is Done
```

**Notes:** every other check in this story is mechanical, and mechanical checks cannot see the thing
that actually went wrong on 2026-08-12: each individual sentence was true and the sequence did not
add up to an install. The person does not have to be somebody new — the owner following their own
README without using what they know is enough, and is the cheapest version of this that exists.

---

**Related:** [EPIC-20](../epics/EPIC-20-install-and-naming.md) · [Board](../board.md) ·
[Delivery plan](../README.md) · [EPIC-18 flows](./EPIC-18-cli-packaging-flows.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md)

[← Back to the delivery plan](../README.md)
