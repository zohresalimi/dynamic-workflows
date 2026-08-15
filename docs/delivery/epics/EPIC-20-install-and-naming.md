# EPIC-20: One-command install and a lowercase command

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-20-install-and-naming-flows.md)

|                      |                                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-20                                                                                                                                                                                                                                                             |
| **Status**           | Not started                                                                                                                                                                                                                                                         |
| **Priority**         | P0                                                                                                                                                                                                                                                                  |
| **Milestone**        | M1                                                                                                                                                                                                                                                                  |
| **Workstream**       | W14 — added 2026-08-14, after the owner installed DeFlow by hand (see [roadmap §2.2](../../17-roadmap.md) and §2.3)                                                                                                                                                  |
| **Size**             | ~10 days across 3 stories                                                                                                                                                                                                                                           |
| **Depends on**       | EPIC-18 (the `bin` map, `doctor`, KAR-18.6's clean-room verifier, KAR-18.8's adapter offer, KAR-18.9's presentation layer), EPIC-19 (`DeFlow run --provider` and the live run the README's first-run section claims), EPIC-01 (the build scripts and the CI matrix)  |
| **Blocks**           | M2's definition of done — _a colleague installs it unaided and finishes a real task_ (PRD §11). Nothing in M1 is formally blocked, and that is exactly how this went unnoticed for a year of planning                                                                |
| **PRD requirements** | F3.1, F3.2, F3.5, NF1, NF5, NF6, NF8, AR-1; and PRD §15.6, the open naming question this epic half-closes                                                                                                                                                            |
| **Architecture**     | [03-local-development.md §2, §8, §9, §10](../../03-local-development.md), [16-repo-layout.md §2, §7, §8](../../16-repo-layout.md); touches [07-provider-adapter-layer.md §2](../../07-provider-adapter-layer.md) only through KAR-18.8's existing adapter offer      |

## Goal

At the end of this epic a person who has never seen this repository runs **one command**, and ends
with a working `deflow` on their `PATH`, a `doctor` report they can read, and — if they said yes —
the ACP adapters for the vendor CLIs they already had. The command is lowercase, like every tool it
sits beside in a shell. The README describes what actually happens when you type it, because every
command in the README has been executed by a test.

Nothing here is a new capability. `doctor` exists, the adapter offer exists, the clean-room installer
exists, the report layer exists. What does not exist is **a path from "I heard about this" to "it
runs"** that does not require the reader to already understand pnpm workspaces, npm global prefixes
and `PATH`.

## Why this matters

**On 2026-08-12 the owner installed DeFlow on their own machine, and the documented steps did not
work.** The README says `pnpm install && pnpm build`, then _"To type `DeFlow` instead of that path,
link it once: `cd packages/cli && npm link`"_, and offers `pnpm link --global` as the workspace-native
alternative. The owner followed it and got `command not found`. `pnpm link --global` did not work at
all, because pnpm's global bin directory was not on `PATH` and nothing in the tool, the docs or the
error said so. It took a hand-run `npm link` to get a working command. **The person who wrote the
build is the person the install failed for**, which sets a floor for how it goes for anybody else.

**A tool nobody can install is a tool nobody uses, and the first five minutes are the whole first
impression.** NF6 is not decoration — _"Single-binary-ish install: `npx DeFlow up`. No database
server, no Docker requirement for the core"_ — and M2's definition of done is a colleague installing
it unaided. Every fussy decision in [16 §2](../../16-repo-layout.md) (exactly one published package,
`noExternal: [/^@DeFlow\//]`, UI assets as plain files, one native dependency) was paid for in order
to make one command work on a machine with no compiler. **That command was never built.** The
packaging is right and the entry point is missing, which is the most expensive kind of nearly-done.

**And the command is capitalised.** `DeFlow` is the only tool on the owner's `PATH` that is: `claude`,
`codex`, `gemini`, `gh`, `git`, `node`, `pnpm` are all lowercase. Capitalisation costs a shift key on
every invocation, breaks tab-completion muscle memory, and — because macOS filesystems are
case-insensitive by default and Linux's are not — produces a class of bug where a link that resolves
on the author's laptop does not resolve on a CI runner. It is also, quietly, a publishing blocker:
npm has refused new package names containing capital letters since 2017, and
`packages/cli/package.json` is currently named `DeFlow`. So `npm publish` has never been tried, and
the day it is tried it fails.

The three problems are one problem — **nobody has walked the path a new user walks** — and that is
why they are one epic rather than three tickets in three places.

## Scope

**In scope:**

- Renaming the published command and its two companions: `DeFlow` → `deflow`, `DeFlow-mcp` →
  `deflow-mcp`, `DeFlow-mock-agent` → `deflow-mock-agent`; the npm package name `DeFlow` → `deflow`;
  and the whole user-visible string surface that names them — usage text, error and report strings,
  `docs/`, the root `README.md`, the delivery epic and flow files where they quote a command line,
  and the tests that assert on those strings.
- `DeFlow` kept working as a **deprecated alias for at least one release**, with a one-line notice on
  stderr pointing at the new name, and an explicit expiry recorded in this file.
- The case-sensitivity discipline the rename requires: a repository check that no two tracked paths
  differ only by case, and a CI assertion of the rename on a **case-sensitive** runner as well as on
  macOS, because a rename that only works on a Mac is not done.
- `npx deflowai setup` — one command, no clone, works anywhere npm does — and a macOS install script in
  the curl-to-shell shape, since that is the owner's platform.
- What `setup` does, in order, reported through KAR-18.9's presentation layer: install or build the
  CLI; put `deflow` on the `PATH` for **this** shell in a way that actually works; verify by invoking
  `deflow --version` as a subprocess; run `deflow doctor`; offer the missing ACP adapters for vendor
  CLIs that are present, through KAR-18.8's existing offer rather than a second one.
- Re-runnability and honesty: safe to run twice, no silent edit of a shell profile, and — when it
  cannot put the binary on `PATH` — the exact line and the exact file, and a non-zero exit rather
  than a green report.
- A README whose install and first-run sections are built around that one command, whose contributor
  path is marked as the contributor path, and **every command in which has been executed**, flags
  included.

**Out of scope:**

- **Renaming anything that is not typed at a shell prompt.** The `.DeFlow/` repo directory, the
  `$XDG_DATA_HOME/DeFlow` global state directory, the `DeFlow_*` environment variables, the
  `@DeFlow/*` workspace scope, the `DeFlow/<runId>__<nodeId>` branch prefix and the `DeFlowd` daemon
  name all stay exactly as they are. KAR-20.1 AC8 states each one and why, so this is a recorded
  decision rather than an oversight. Reversing any of them is a separate story with a separate
  migration.
- **Settling the product name.** PRD §15.6 says _"DeFlow is proposed, not decided"_ and this epic does
  not decide it. It settles the **casing** of whatever the command is called. If the product is
  renamed later, the command is renamed again — and this epic is what makes that a one-line change to
  a `bin` map instead of a sweep of 468 files.
- **Publishing to npm.** Making the package name publishable is in scope; running `npm publish` is
  not, and needs no story ([16 §2](../../16-repo-layout.md) already reduced it to two commands).
- **Homebrew, a `.pkg`, code signing, notarisation, auto-update, a desktop shell or a login item.**
  M3 at the earliest (PRD §6.3). The macOS script here is the `brew`-less shape precisely so that
  none of that is required.
- **Windows.** NF5 is unchanged: macOS and Linux at M1, Windows by M3. `setup` must **say** that
  rather than half-working — a PowerShell installer is not built here.
- **Installing a vendor CLI, or anything global the user did not ask for.** KAR-18.8's rule is
  inherited whole: the only thing installed without a prompt is `deflow` itself, which is the thing
  the user just asked to install. Acquiring `claude`, `codex` or `gemini` on someone's behalf remains
  out of scope, here as there.
- **A package manager of our own.** `setup` spawns the operator's `npm`; it does not embed, download
  or choose one.
- **Rewriting `docs/CONTRIBUTING.md` and the architecture set beyond the command rename.**
  KAR-20.1's sweep changes the *name* in those files. Their content is theirs.

## Definition of Ready (epic level)

- [ ] EPIC-18 KAR-18.4, KAR-18.6, KAR-18.8 and KAR-18.9 are Done: `doctor` reports, the clean-room
      verifier runs unattended, the adapter offer exists with its consent rules, and there is one
      presentation layer for `setup` to print through.
- [ ] EPIC-19 KAR-19.10 is Done: `--provider` exists, so KAR-20.3 documents a flag rather than
      inventing one.
- [ ] A decision is recorded on whether `deflow` is available on the npm registry, because
      KAR-20.2's `npx deflowai setup` resolves a **package name**, not a bin name. If it is taken, the
      fallback (`npx @scope/deflow setup`, with `deflow` still the bin) is written into KAR-20.2
      before it starts.
      **Answered 2026-08-15, and the answer is that it is taken. Decided the same day: the package
      is `deflowai` — see *The package name and the short alias* below.** `deflow` on npm is
      [`Deflow`](https://www.npmjs.com/package/deflow) 0.6.4, an unrelated Redis-backed job-flow
      library published by `fabiencdp`. So `npx deflowai setup` as AC1 spells it today fetches a
      stranger's package, and `packages/cli/package.json` — whose `name` is `deflow` — cannot be
      published as it stands. This blocks nothing that is built (every automated spec and the
      performed acceptance install from a packed tarball, which is also what the release gate
      does), but it blocks *publishing*, and it must be decided before KAR-20.3 documents an
      install command a reader will type. Both `@deflow/*` and `@metune/*` were unclaimed when
      this was checked; picking between them is the owner's call, not this story's, because it is
      a decision about which npm organisation the project publishes under. The bin stays `deflow`
      either way — only the package specifier moves — so `setup`'s `PACKAGE` constant and
      `scripts/install.sh`'s `DEFLOW_PACKAGE` default are the two lines that change.
- [ ] The CI matrix has at least one case-sensitive runner (`ubuntu-26.04`), which it does, so
      KAR-20.1 AC6 can be asserted rather than reasoned about.

## Definition of Done (epic level)

- [ ] All three stories are Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-20-install-and-naming-flows.md) is automated at
      the level it declares and passes on `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] **Performed, not asserted:** on a machine where `deflow` is not on `PATH`, one command is run
      in a fresh shell, and `deflow doctor` then works in a **different** fresh shell. The transcript
      — the command, its output, and the second shell's `which deflow` — is pasted into KAR-20.2's
      notes and onto its Linear issue. A green suite is not evidence for this item; the whole epic
      exists because a green suite coexisted with an install that did not work.
- [ ] `deflow`, `deflow-mcp` and `deflow-mock-agent` are the names in the published `bin` map, and a
      clean-room install (KAR-18.6) resolves all three by their lowercase names.
- [ ] `DeFlow` still runs and prints its deprecation notice, and the notice appears on **stderr**
      only — no `--json` document and no piped stdout contains it.
- [ ] `git ls-files | tr 'A-Z' 'a-z' | sort | uniq -d` is empty, asserted in CI on the case-sensitive
      runner, so no case-only path pair can be created by a checkout that silently merges them.
- [ ] Every fenced shell command in the root `README.md` is executed by a test and exits as the
      README says it does. A README command that stops working turns a test red.
- [ ] The commands quoted in PRD §8 (NF6), [roadmap §2.2](../../17-roadmap.md),
      [03 §9–§10](../../03-local-development.md) and [16 §2](../../16-repo-layout.md) name the
      lowercase command. A stale architecture doc is worse than none, because it is trusted
      ([README §5](../README.md#5-definition-of-done)).
- [ ] No `Unverified` claim is introduced by this epic without an entry in the open-risks register.

## User stories

### KAR-20.1 — The command is `deflow`

|                 |                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                |
| **Priority**    | P0                                                                                                         |
| **Size**        | M                                                                                                          |
| **Depends on**  | EPIC-18 KAR-18.5 (the `bin` map and the build this renames), KAR-18.6 (the clean room that proves the published names resolve) |
| **PRD**         | NF5, NF6, NF8; PRD §15.6                                                                                   |
| **Verified by** | EPIC-20-S1, EPIC-20-S2, EPIC-20-S3, EPIC-20-S4, EPIC-20-S5, EPIC-20-S6, EPIC-20-S7, EPIC-20-S8, EPIC-20-S9, EPIC-20-S10, EPIC-20-S34 |

**As** an engineer with a shell, **I want** the command to be `deflow`, **so that** it types like
every other tool I use and nothing in my toolchain has to care which letters are capitals.

Three separate arguments arrive at the same answer. **Convention:** `claude`, `codex`, `gemini`, `gh`,
`git`, `node`, `pnpm` — every neighbour is lowercase, and a capitalised command is a small friction
paid on every invocation forever. **Publishing:** npm has refused new package names containing
capital letters since 2017, and `packages/cli/package.json` is named `DeFlow`; `npm publish` has
therefore never been tried and would fail the day it is. **Portability:** macOS's default APFS volume
is case-insensitive and Linux's ext4 is not, so `DeFlow` and `deflow` are the same directory entry on
one machine and two on the other. That is not a curiosity — this checkout has
`core.ignorecase = true`, which means git itself will hide a case-only rename from the author and
show it to CI.

The surface is larger than the `bin` map and pretending otherwise is how half-renames happen: 468
tracked files contain a `DeFlow `-prefixed command literal, and the epic and flow files under
`docs/delivery/` quote command lines that the tests assert on word for word.

**Acceptance criteria**

1. `packages/cli/package.json` declares `bin` as `{ "deflow": "./dist/bin.mjs", "dfl":
   "./dist/bin.mjs", "deflow-mcp": "./dist/mcp.mjs", "deflow-mock-agent": "./dist/mock-agent.mjs" }`,
   and its `name` field is `deflowai`. Every workspace reference that selected the package by name —
   including the root `pack:check` script's `pnpm --filter DeFlow` — selects it by the new name and
   the scripts still run. **Amended 2026-08-15** (see *The package name and the short alias* below):
   the package name and the command are two different strings, because `deflow` on npm belongs to
   somebody else; and `dfl` is a second `bin` key pointing at the same entry script, so the command
   has a short spelling that shadows nothing the machine already has.
2. Every user-visible string that names the command names the lowercase one: the usage block in
   `packages/cli/src/bin.ts`, every refusal and report string across `packages/*/src`, the exit-code
   tables, and the sentences other stories pinned by hand (KAR-18.2 AC3's lease refusal, KAR-18.3
   AC3's detach sentence, KAR-19.6's cancel hint). A source guard asserts that no shipped string
   outside the alias module in AC4 contains the capitalised command followed by a space or an
   end-of-string.
3. The provider registry's bundled entry spawns `deflow-mock-agent`, the testkit puts
   `deflow-mock-agent` on its temp `PATH`, and `EPIC-04`'s fixtures resolve it. A run on a `PATH`
   holding only the bundled agent still reaches `run.completed` — the KAR-19.5 smoke test passes
   unmodified except for the binary's name.
4. `DeFlow` continues to work for **at least one release**: invoking it runs the same program, with
   the same arguments, the same exit code and the same stdout, and prints exactly one line to
   **stderr** — naming the old name, the new name and the release the alias is removed in. The
   expiry is written into this story's Notes, not only into the string.
5. The deprecation notice never contaminates a machine-readable stream: with `--json`, with stdout
   piped, or with stdout and stderr both redirected to the same file and then filtered on stdout, no
   `--json` document contains the notice and no NDJSON line fails to parse because of it.
6. The rename is correct on a **case-sensitive** filesystem and not only on macOS. Specifically: no
   two tracked repository paths differ only by case (`git ls-files | tr 'A-Z' 'a-z' | sort | uniq -d`
   is empty); no build step performs a case-only file rename; and the published `bin` names resolve
   in a clean-room install on `ubuntu-26.04` as well as `macos-26`. Where a file genuinely must
   change case, it is renamed through an intermediate name in two commits, because
   `core.ignorecase = true` makes a one-step case-only rename a no-op that looks like a success.
7. On a case-insensitive filesystem `deflow` and `DeFlow` are **one** directory entry in the global
   bin directory, so the alias cannot be a second file there. The design states this rather than
   working around it: both names map to the same entry script, and the notice is decided at runtime
   from `basename(process.argv[1])` — distinct on Linux, best-effort on macOS where the shell's
   spelling is not recoverable. A test asserts the Linux behaviour and asserts that the macOS case
   still runs the program correctly rather than failing.
8. What this story **does not** rename is enumerated in the code and in this file, each with its
   reason, and a guard fails if any of them changes as a side effect:
   - `.DeFlow/` (repo-local) and `$XDG_DATA_HOME/DeFlow` (global) — renaming them orphans every
     already-initialised repository's committed config and every `.gitignore` entry `init` wrote, for
     no ergonomic gain; nobody types a directory name at a prompt.
   - The `DeFlow_*` environment variables (39 distinct names, `DeFlow_KEEP_TMP` alone used 120
     times) — a second deprecation window with two spellings live at once, in exchange for nothing a
     user notices.
   - The `@DeFlow/*` workspace scope — none of it is published ([16 §2](../../16-repo-layout.md)), so
     it is invisible outside this repository.
   - The `DeFlow/<runId>__<nodeId>` branch prefix — renaming it strands in-flight worktrees and
     branches in repositories DeFlow has already touched.
   - `DeFlowd`, and the product name in prose — PRD §15.6 owns the product name, and this story does
     not pre-empt it.
9. `docs/`, the root `README.md`, `docs/CONTRIBUTING.md` and the delivery epic and flow files under
   `docs/delivery/` name the lowercase command wherever they quote a command line — including PRD §8's
   NF6 text, which quotes `npx DeFlow up` and is the requirement this epic serves. Prose about the
   product keeps the product's own spelling.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                    | Red when                                                                                                                          |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | Read `packages/cli/package.json` and assert the three `bin` keys and the `name` field are lowercase and map to existing entry files                                     | The `bin` map is renamed and `name` is left as `DeFlow`, so the package is still unpublishable and `npx deflowai` resolves nothing   |
| 2   | e2e         | Clean-room install of the packed tarball (KAR-18.6's verifier), then resolve all three bins by their lowercase names and spawn each one — `deflow --version`, `deflow-mcp --help`, `deflow-mock-agent --version` | A bin key was renamed but its target path was not shipped, which only a clean room sees                                           |
| 3   | unit        | A source guard over `packages/*/src` and `docs/`: no shipped string matches the capitalised command as a whole word, outside the alias module and this story's own tests | One error string in a rarely-hit branch still says `DeFlow status`, and the report contradicts the command the reader just typed   |
| 4   | integration | Invoke the program through the `DeFlow` name; assert identical stdout, identical exit code, and exactly one notice line on stderr naming both names and the expiry      | The alias re-implements argument parsing and drifts, or prints its notice on stdout                                               |
| 5   | integration | `DeFlow doctor --json` with stdout piped and stderr captured separately; assert the stdout document parses and contains no notice                                       | The notice is written with `console.log`, so every `--json` consumer's parse breaks on the first line                             |
| 6   | unit        | `git ls-files` lower-cased, sorted and checked for duplicates is empty; and no build script contains a case-only rename of the same path                                | A case-only pair is created on a Mac, merges silently in the author's checkout, and appears as two files on the Linux runner       |
| 7   | integration | On the case-sensitive runner: link both names and assert two distinct entries, each running the program and only one printing the notice                               | The alias is implemented as a copy of the entry script and the two drift, or the notice fires for the new name too                |
| 8   | integration | A `PATH` holding only `deflow-mock-agent`; drive KAR-19.5's smoke path and assert the run reaches `run.completed`                                                       | The registry's bundled entry still spawns the capitalised binary, so every vendor-free run stops resolving its own agent          |
| 9   | unit        | A non-rename guard: the five names in AC8 still appear with their original spelling in the paths, env reads, scope and branch template that own them                    | A global find-and-replace renames `.DeFlow/` too, and every repository already initialised loses its config                       |
| 10  | integration | Initialise a repository under the old build, then run the renamed binary against it; assert the existing `.DeFlow/` is read unchanged and nothing is migrated           | The rename is applied to the on-disk state directory, and an upgrade silently abandons the user's gates, templates and memory     |

**Notes / risks** — the alias expiry is **the release after the one that introduces it**; write the
version into the notice string and into a test that fails once the package version passes it, so the
alias cannot outlive its argument by inertia. The 468-file sweep is mechanical and the risk is not
the sweep — it is the two or three strings that are *constructed* rather than literal, which the AC2
guard is aimed at and which a find-and-replace will miss.

**The alias expiry, recorded (AC4).** `DeFlow` is removed in **0.2.0**. The package is at `0.0.0`
and the alias ships in the first release after it, so 0.2.0 is the release after the one that
introduces it. The version lives in `ALIAS_REMOVED_IN`
(`packages/cli/src/command-name.ts`), is printed in the notice, and is pinned by
*"expires by going red rather than by being remembered"* in
`packages/cli/test/command-name.test.ts` — that test fails the moment
`packages/cli/package.json`'s version reaches 0.2.0, which is the only mechanism for removing a
deprecation that has ever worked.

**How it was implemented.** There is **one entry script** and no second file: on a case-insensitive
volume `deflow` and `DeFlow` are one directory entry, so an alias-as-a-copy cannot exist there. The
notice is decided at runtime from `basename(process.argv[1])` — exact on ext4, best-effort on APFS,
where the shell still passes through whichever spelling was typed. `packages/daemon/bin/DeFlow-mcp.ts`
was renamed to `packages/daemon/bin/mcp.ts` rather than to `deflow-mcp.ts`, deliberately: a
`DeFlow-mcp` → `deflow-mcp` rename is case-only, which `core.ignorecase = true` turns into a no-op
that reports success, and the sibling `packages/mock-agent/bin/mock-agent.ts` already names the file
after its role rather than after its bin. Two exemptions are recorded in the AC2 guard:
`packages/ledger/src/migrations/` (append-only and content-hashed — editing a shipped migration to
correct a comment breaks a stronger invariant than the one this story adds) and this epic's own two
files, which quote the old name because they are the record of the rename.

**The package name and the short alias — owner's decision, 2026-08-15.**

Two names were decided on 2026-08-15, after the registry was checked rather than assumed, and both
amend criteria that were written before anyone had looked.

**The npm package is `deflowai`; the command stays `deflow`.** The Definition of Ready above asked
whether `deflow` was free on npm, and it is not: it is
[an unrelated Redis-backed job-flow library](https://www.npmjs.com/package/deflow) at 0.6.4,
published by `fabiencdp`. So KAR-20.2 AC1's literal `npx deflow setup` was not a thing that could be
made to work — `npx <name>` resolves a **package**, and that line fetches and executes somebody
else's code. `deflowai` was verified free on the registry on 2026-08-15 and is what
`packages/cli/package.json` is named. A `bin` key does not have to match the package that declares
it, so *nothing a user types changed*: the install route is `npx deflowai setup`, and the command it
installs is `deflow`. Everything that names the npx route — the PRD's NF6, the architecture set, the
roadmap, `scripts/install.sh`'s `DEFLOW_PACKAGE` default and `setup`'s own `PACKAGE` constant — was
moved with it, and `test/command-name.test.ts` fails on any bare npx route that names the command
instead of the package.

**The short alias is `dfl`, and deliberately not `df`.** `deflow` is six characters typed many times
a day, so the package declares a second `bin` key beside it. It is `dfl` because **`df` is POSIX.1's
disk-free utility and is on every Unix machine this project supports** — npm's global bin directory
usually sits *ahead* of `/bin` on `PATH`, so a `df` of ours would shadow it and `df -h` would
silently stop being `df -h` for every shell on that machine. A tool that breaks an unrelated command
is a tool people uninstall. `dfl` was checked on 2026-08-15: it resolves to nothing on the owner's
machine and is free on npm.

Because `dfl` collides with nothing, there is **no collision detection, no confirmation prompt and
no shadowing default** in this epic — it installs plainly, like any other bin. That is a smaller
design than the one an earlier draft of this decision implied, and the smaller design is the correct
one: a prompt about a collision that cannot happen is a question with one answer. What is kept is
the discipline rather than the ceremony — `SYSTEM_UTILITIES` in `packages/cli/src/command-name.ts`
names `df` and its neighbours with the reason each is off limits, and a guard in
`test/command-name.test.ts` fails if any published `bin` key is ever one of them. `dfl` is not
deprecated and prints no notice; the notice mechanism keys off `DEPRECATED_COMMAND` alone.

**Two corrections, 2026-08-14.**

- **`deflow-mcp` had never been spawned from a tarball by anything.** `deflow` is exercised by the
  clean room's `init`/`up`/`doctor` and `deflow-mock-agent` by KAR-18.6 AC2's `--version`, but the
  second bin's only argv was `--socket <path> --run <runId>`, which needs a running DeFlowd — so
  every argv a clean room could offer it, `--help` included, exited `EX_USAGE`, which is what a
  *correct* build does too. A tarball shipping a broken or missing `dist/mcp.mjs` was green. The
  shim now answers `--help` on stdout with exit 0 before it parses anything else
  (`packages/daemon/src/mcp/shim.ts`, unit spec beside it), and EPIC-20-S2 is automated end to end
  in `e2e/install-verification.test.ts`: all three bins spawned from the packed tarball, `deflow
  --version` compared against `packages/cli/package.json`, and every resolved path checked to be
  inside the clean room's own prefix — with the "nothing of this name was on `PATH` beforehand"
  precondition measured rather than assumed. The scenario's declared level moved from `integration`
  to `e2e` for the reason recorded in the flow file: the clean room *is* an e2e fixture.
- **One command literal survived the AC2 sweep**, in `packages/cli/src/bin.ts`'s Ctrl-C line for
  `up`. The source guard could not see it: the name was preceded by `\n` inside a template literal,
  and `n` is a word character, so the `\b` every pattern starts with failed. The guard now
  normalises `\n`, `\r` and `\t` to a space before matching — narrower than loosening `\b`, which
  would have started matching `MyDeFlow doctor` — and carries that exact line as its own red case.

---

### KAR-20.2 — One command installs `deflow` and gets the machine ready

|                 |                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                                                         |
| **Priority**    | P0                                                                                                                                                  |
| **Size**        | L                                                                                                                                                   |
| **Depends on**  | KAR-20.1 (the name it installs), EPIC-18 KAR-18.4 (`doctor`), KAR-18.6 (the clean-room verifier this reuses), KAR-18.8 (the adapter offer and its consent rules), KAR-18.9 (the report layer every step prints through) |
| **PRD**         | F3.1, F3.2, F3.5, NF1, NF5, NF6, NF7, AR-1                                                                                                          |
| **Verified by** | EPIC-20-S11, EPIC-20-S12, EPIC-20-S13, EPIC-20-S14, EPIC-20-S15, EPIC-20-S16, EPIC-20-S17, EPIC-20-S18, EPIC-20-S19, EPIC-20-S20, EPIC-20-S21, EPIC-20-S22, EPIC-20-S23, EPIC-20-S24, EPIC-20-S25 |

**As** somebody installing DeFlow for the first time, **I want** to run one command and end up with a
working `deflow`, **so that** I am not asked to understand npm global prefixes before I have seen the
tool do anything.

Two entry points, because they fail in different places. **`npx deflowai setup`** works anywhere npm
does and needs no clone; it is the honest reading of NF6's _"single-binary-ish install"_. **A macOS
install script**, in the curl-to-shell shape a `brew`-less tool uses, exists because that is the
owner's platform and because `npx` presumes a Node the user may not have yet.

The failure this replaces is specific and worth keeping in view: `pnpm link --global` reported
success and produced no usable command, **because pnpm's global bin directory was not on `PATH` and
nothing said so**. So the design rule for this story is that _every step is verified by observation,
not by exit code_ — the binary is confirmed by spawning `deflow --version` and reading what comes
back, not by trusting that a link command that returned 0 did what its name suggests.

The second rule is **honesty about the operator's machine**. Putting something on `PATH` means editing
a shell profile, and a tool that edits a dotfile without saying which one is a tool people uninstall.
So: name the file, show the line, ask, and be a fixpoint on the second run. And when it cannot do it
— an unwritable prefix, an unrecognised shell, a `PATH` managed by something else — say exactly what
to add and where, and **exit non-zero**, because a green report over a broken install is the failure
mode this whole epic came from.

**Acceptance criteria**

1. `npx deflowai setup` on a machine with no `deflow` installed and no clone of this repository
   completes with `deflow` **and** its short alias `dfl` resolvable on `PATH` in a **new** shell, and
   exits 0. The macOS install script, run by `curl … | sh`, reaches the same end state through the
   same reported steps. **Amended 2026-08-15**: this criterion said `npx deflow setup`, which was
   unsatisfiable — `deflow` on npm is an unrelated package — so the route names `deflowai`, the
   package, while `deflow` stays the command. `verify` observes both names (see AC3).
2. The steps are performed in this order and each is reported as a line through KAR-18.9's layer with
   its own `ok` / `warn` / `fail` / `skipped` state: **install** (or build) the CLI → **link** it onto
   `PATH` → **verify** → **doctor** → **adapters**. A step that fails does not silently continue into
   the next one, and the report ends with KAR-18.9 AC5's summary block whose first line is the next
   action.
3. **Verification is a subprocess, never an inference.** The `verify` step spawns `deflow --version`
   in a shell resolving the same `PATH` a fresh login shell would, and asserts on its stdout and exit
   code. If the spawn fails or the version does not parse, the step is `fail` regardless of what the
   install and link steps reported. **Amended 2026-08-15**: it spawns `dfl --version` the same way and
   compares the two. A missing or disagreeing alias is a `warn`, not a `fail` — the tool is installed
   and works — and `doctor` and `adapters` still run.
4. When the global bin directory is not on `PATH` — the owner's actual failure — the report names
   **which** directory (`npm prefix -g`/`pnpm bin -g` resolved, absolute), says it is not on `PATH`,
   and offers the fix. It never reports success on the strength of the link command's exit code.
5. No shell profile is modified without saying so first: the report names the **absolute path of the
   file** and prints the **exact line** to be appended, and on a TTY asks before writing, defaulting
   to **no** on a bare Enter. With `--yes` it writes without asking and still prints file and line.
   Nothing is ever written to a profile when stdout is not a TTY unless `--yes` was passed.
6. Re-running is safe and is a fixpoint: a second run appends no duplicate profile line, re-links
   nothing that is already correct, reports each step as `ok — already` rather than re-doing it, and
   exits 0. Running it twice concurrently does not interleave two writes into one profile file.
7. Shells are handled by name, not by guess: `zsh` → `~/.zshrc`, `bash` → `~/.bash_profile` on macOS
   and `~/.bashrc` on Linux, `fish` → `~/.config/fish/config.fish`. An unrecognised `$SHELL` is a
   `warn` that prints the line to add and does not write to any file.
8. If `deflow` cannot be put on `PATH` at all, the command **exits non-zero** with the exact line to
   add and the file to add it to, and the summary block's next action is that line. It never exits 0
   with a `fail` in the report.
9. `deflow doctor` is run as the fourth step, through the installed binary. Its findings are shown,
   and **its exit code does not become `setup`'s** — a machine that installed correctly but has a
   degraded sandbox is a successful install with a warning, and `setup` says which of the two
   happened.
10. The adapter offer is KAR-18.8's, called rather than reimplemented: only for a provider whose
    vendor CLI actually resolves, only after a confirmation or an explicit `--fix`/`--yes`, one
    attempt, and the result re-resolved rather than assumed. `--json` never prompts and never reads
    stdin.
11. **Nothing global is installed without consent except `deflow` itself** — the thing the user just
    asked for. A spawn guard asserts that the only unprompted child process that mutates global state
    is the one installing this package; no global update, no package manager installation, no
    `sudo`.
12. With no network egress the install step fails, names the underlying `npm` error verbatim (trimmed,
    not paraphrased), leaves no half-written profile line and no partial link, and exits non-zero. One
    attempt, no retry (NF1: an offline machine costs one timeout, not several).
13. On Windows the command refuses in one sentence naming NF5 and the WSL2 instruction from
    [03 §1](../../03-local-development.md), and exits non-zero without touching anything.
14. `setup` reads no credential file and captures no auth command's output (AR-1), before or after
    any install — the same guard KAR-18.4 and KAR-18.8 carry, extended to this entry point.
15. **The acceptance for this story is performed, not asserted.** On a machine where `deflow` is not
    on `PATH`, the one command is run in a fresh shell; then `deflow doctor` is run in a **different**
    fresh shell and works. The transcript is pasted into this story's notes and onto its Linear
    issue. A green suite is not evidence for this criterion.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                             | Red when                                                                                                                            |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | e2e         | In a clean room (KAR-18.6's `mktemp -d` + fake `HOME` + minimal `PATH`), run the packed tarball's `setup`; then spawn a **new** login shell and run `deflow --version`           | `setup` links into a directory the new shell's `PATH` never contains, which is the 2026-08-12 failure exactly                       |
| 2   | integration | Stub the link step to exit 0 while placing nothing on `PATH`; assert the `verify` step is `fail` and the overall exit is non-zero                                                | Verification reads the link command's exit code, so a lying success propagates all the way to the summary block                     |
| 3   | integration | A clean room whose npm global prefix is deliberately not on `PATH`; assert the absolute directory is named, the fix is offered, and the step is not `ok`                         | The report says "installed" because the tarball unpacked, and the operator is back where they started                               |
| 4   | integration | A fake `HOME` with a `.zshrc`; run `setup` twice; assert exactly one appended line, byte-identical file after the second run, and `ok — already` on every step                   | The appender is unconditional, so every run adds another `export PATH=` line to the operator's profile                              |
| 5   | integration | A scripted TTY answering `n`, and one answering bare Enter; assert no file was written in either case and the line was printed                                                   | The prompt defaults to yes on Enter, so a dotfile is edited by pressing return                                                      |
| 6   | integration | `$SHELL` set to `zsh`, `bash` (on each platform) and `fish`, then to `/usr/bin/nonsense`; assert the right file per shell and a `warn` with no write for the unknown one         | One profile path is hardcoded, so a fish user gets a line appended to a file fish never reads                                        |
| 7   | integration | Make the link target unwritable; assert exit non-zero, the exact line and file in the message, and the summary block's next action being that line                               | It exits 0 with a `fail` in the body, and CI — and the reader — conclude the install worked                                          |
| 8   | integration | A `doctor` stub exiting 5 for a degraded sandbox; assert `setup` reports the warning, distinguishes it from an install failure, and exits 0                                      | `doctor`'s exit code is returned directly, so a perfectly installed tool reports installation failure                               |
| 9   | integration | A fake `claude` on the temp `PATH` with no adapter, and a fake `npm` recording argv; assert one prompt, one install of the adapter package, and none for an absent vendor        | `setup` reimplements the offer instead of calling KAR-18.8's, and the consent rules diverge between the two entry points            |
| 10  | integration | `setup --json` with stdin closed and stdout piped; assert the document parses, contains a per-step result, contains no ANSI, and the process never blocks                        | Prompting is gated on `stdout.isTTY` alone, so a CI job hangs on a read that can never be answered                                   |
| 11  | integration | A spawn guard over a full run: assert the only unprompted global-mutating child is the install of this package                                                                   | A convenience `npm install -g` for something else creeps in, and `setup` becomes a command that changes machines without asking     |
| 12  | integration | A clean room with egress blocked; assert the npm error text is present verbatim, no profile line was written, exit non-zero, and exactly one install attempt was made            | The failure is retried three times, so an offline user waits three timeouts to be told the same thing                               |
| 13  | unit        | Platform dispatch over `darwin` / `linux` / `win32`; assert the Windows branch refuses with the NF5 sentence before any filesystem access                                        | The Windows path falls through to the POSIX branch and half-edits a profile that does not exist                                      |
| 14  | unit        | An AR-1 guard over the `setup` module's source and import graph: no read of `~/.claude`, `~/.codex`, `~/.config/gcloud`, no `*_API_KEY`/`*_TOKEN` read, no login-command capture | Somebody adds an "are you logged in?" check to make the report friendlier and captures a credential command's output                 |
| 15  | manual      | The performed acceptance of AC15, transcript pasted into this story and its Linear issue                                                                                         | The suite is green and nobody has actually installed it from nothing — the precondition of this entire epic                          |

**Notes / risks** — the honest hazard is that `PATH` is the operator's, not ours. A machine with
`asdf`, `nvm`, `mise` or a Homebrew Node has an npm prefix that moves between shells, and no installer
can be right about all of them. The mitigation is the one this story is built around: **verify by
observation and report the truth**, including the truth that we could not do it. That is strictly
better than the current state, where the tool cannot tell the difference between a working install
and a link into a directory nothing reads.

**How it was implemented.** `packages/cli/src/setup/` in three files: `plan.ts` (pure — the shell
→ profile-file mapping, the line in that shell's own syntax, the exit-code invariant, the Windows
refusal), `profile.ts` (the only writer, under an `O_EXCL` lock so two concurrent runs cannot both
append), and `run.ts` (the five steps and their subprocesses). `scripts/install.sh` is the
curl-to-shell entry point and is deliberately inert: it checks `uname`, `node`, the Node major and
`npx`, then `exec`s `npx --package=<pkg> -- deflow setup --from <pkg>`, so every byte it leaves
behind is written by `setup` under `setup`'s consent rules. `test/install-script.test.ts` reads it
the way a suspicious operator would and fails if it ever grows a second capability.

The one idea the whole story rests on is `freshShellPath` (`plan.ts`): **the `PATH` this process can
see is not the `PATH` the operator's next terminal will have.** `npx deflowai setup` runs with the npx
cache's `node_modules/.bin` prepended, so `deflow` resolves inside the running process no matter what
the install did — verifying against that would print a green tick over the exact 2026-08-12 failure.
So the ephemeral entries are dropped, the directories the *profile* now provides are added, and every
observation (the "is it already installed?" pre-check, `verify`, `doctor`) is spawned through a shell
given that computed `PATH`. `e2e/setup-install.test.ts` then goes one better and spawns a real
interactive `zsh`/`bash`, which reads the profile file itself.

**Four decisions worth recording.**

- **AC6's "each step reports `ok — already`" applies to the two steps that do work.** `install` and
  `link` say `already` and do nothing on a second run; `verify`, `doctor` and `adapters` run again
  and say what they observed. Skipping the verification on the grounds that a previous run passed
  would be precisely the inference this story exists to remove, and none of the three changes
  anything. The fixpoint claim the scenario is actually about — a byte-identical profile, no second
  link, exit 0 — is asserted in full.
- **`doctor` is spawned as `deflow doctor --json --skip-conformance`.** `--json` because the step
  needs a structured verdict rather than a screen of prose, and because it guarantees the child
  cannot prompt; `--skip-conformance` because the battery spawns a turn per assertion per installed
  adapter and the operator is four minutes into their first five. The step says the battery did not
  run and names `deflow doctor` as the command that runs it. Its next action comes from
  `toReport()` + `nextAction()` — doctor's own layer over doctor's own document — rather than from a
  sentence written here; because KAR-18.9 AC6 keeps per-check actions out of `--json`, what surfaces
  is doctor's own fallback action, which is doctor's words either way.
- **"The exact line" is exact everywhere the renderer does not touch it**: in the step detail, in
  the prompt question and in the `--json` document, and inside the `printf '%s\n' … >> …` next
  action, which is single-quoted so the line's own double quotes survive. In the *rendered* report a
  line longer than the terminal is wrapped, because KAR-18.9 AC4 wraps rather than truncates and
  this story does not get to be the second formatter. That is only visible with very long prefixes —
  a temp directory in a test, not `/usr/local/bin`.
- **EPIC-20-S12's second scenario moved from `e2e` to a source guard.** "The script installs no
  package the npx path does not, and writes no file the npx path does not" is a claim about what the
  script *can* do; asserting it by observing one run would pass for a script that does something
  else on a machine with Homebrew. `test/install-script.test.ts` reads the script; the e2e keeps the
  end-state comparison, which is the half only a real install can answer.

**The performed acceptance (AC15, EPIC-20-S25).** Run on 2026-08-14 on the owner's macOS machine,
against the packed tarball, with a sandbox `HOME` and an npm prefix of its own so that the run could
not touch the machine's real profile — everything else (node, npm, zsh, the filesystem) is this
machine's own, and `deflow` was genuinely absent from the `PATH` the first shell was given. The
transcript is on the Linear issue (MET-798); its shape is: `which deflow` in a fresh shell finds
nothing → `sh scripts/install.sh --yes` reports install/link/verify/doctor/adapters → a **second**
fresh shell finds `deflow` at an absolute path inside the sandbox prefix and `deflow doctor` runs and
prints its report there.

---

### KAR-20.3 — The README documents the real install path

|                 |                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                            |
| **Priority**    | P0                                                                                                     |
| **Size**        | S                                                                                                      |
| **Depends on**  | KAR-20.2 (the command it documents), KAR-20.1 (the name it uses), EPIC-19 KAR-19.10 (`--provider`)     |
| **PRD**         | F3.1, F3.2, NF1, NF6, NF8                                                                              |
| **Verified by** | EPIC-20-S26, EPIC-20-S27, EPIC-20-S28, EPIC-20-S29, EPIC-20-S30, EPIC-20-S31, EPIC-20-S32, EPIC-20-S33 |

**As** a person deciding in five minutes whether to try this, **I want** the README's first commands
to work, **so that** the first thing DeFlow does is not lie to me.

The current install section is the artefact that failed. It says _"DeFlow is not published to npm yet,
so you build it from this repository"_, then `pnpm install && pnpm build`, then _"To type `DeFlow`
instead of that path, link it once"_, and offers, as alternatives, calling
`node packages/cli/dist/bin.mjs` directly or writing a shell alias by hand. That is not an install
path; it is a set of hints, and following it produced `command not found`.

Two more things in that file are wrong today and are fixed while here, because a README nobody has
executed is a README that is wrong in ways nobody has noticed. **The agent-CLI block claims to install
agent CLIs and two of its five lines install something else**: `@agentclientprotocol/claude-agent-acp`
is the ACP *bridge*, not `claude`, and `@agentclientprotocol/codex-acp` is the bridge, not `codex` —
so a reader who runs the whole block still has no vendor CLI for two of the five, which is precisely
the confusion KAR-18.8 exists to un-confuse in `doctor`. And **`--provider` is documented nowhere**:
it exists in `packages/cli/src/run/args.ts`, is expected by users, and appears in neither the usage
block nor the README.

**Acceptance criteria**

1. The README's install section is **one command** — KAR-20.2's — with the macOS script named as the
   alternative for a machine with no Node. The build-then-link sequence, the `node
   packages/cli/dist/bin.mjs` alternative and the hand-written `alias` are gone from the install
   section entirely.
2. The from-source path survives, moved below and **explicitly labelled the contributor path**, with
   a one-line statement of who it is for. A reader looking for "how do I install this" cannot land on
   it by accident.
3. Every command in the README uses the lowercase `deflow`, and the README's own prose about the
   product uses the product's spelling. No `DeFlow <subcommand>` command line remains.
4. **Every fenced shell command in the README is executed by a test**, in a clean room, and asserted
   to exit as the README says it does. A command whose behaviour changes turns that test red. Where a
   command cannot run unattended (it needs a vendor login, or it opens a browser) it is marked in the
   test's own skip list **with a reason**, and the skip list is asserted to be short and named — not a
   silent catch-all.
5. Every flag shown in the README exists in `deflow --help`, and every flag in `--help` that a first
   run needs is shown in the README — specifically `--provider`, which is currently in neither.
6. The agent-CLI block distinguishes the **vendor CLI** from its **ACP adapter**, per provider, and
   each package name installs what the line says it installs. A test resolves each named package
   against the provider registry's `spec.package` and `spec.shim.bin` and fails on a mismatch.
7. The first-run section's claims match the commands' real output: the exit-code table matches
   `run`'s documented set, the permission table matches the ladder's four levels, and the `up` section
   describes the URL and token behaviour the daemon actually prints.
8. The README states what happens on a machine with no vendor CLI at all — the bundled agent runs a
   whole plan — because that is the zero-friction first run and it is currently a parenthetical.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                          | Red when                                                                                                                     |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | Parse the README's fenced blocks into a command list; assert every entry is either executable-in-clean-room or on a named skip list with a reason              | The extractor silently skips anything it cannot classify, and the test passes over the commands most likely to be wrong      |
| 2   | e2e         | Execute the extracted install and first-run commands in a clean room against the packed tarball; assert each exit code the README claims                       | The README's first command is a build step that assumes a clone, so a reader without one cannot start                        |
| 3   | integration | Cross-check every flag in the README against `deflow --help`, both directions                                                                                 | `--provider` is documented in neither, and the users who need it keep guessing — the state this story found                 |
| 4   | integration | For each provider line in the agent-CLI block, resolve the named package against the registry's `spec.package` and `spec.shim.bin`                             | The block claims `@agentclientprotocol/claude-agent-acp` installs `claude`, and a reader who runs it still has no vendor CLI |
| 5   | unit        | A wording guard: no `DeFlow <subcommand>` command line in `README.md`; the contributor section carries its label                                               | The rename sweep updates code and misses the file every new reader opens first                                              |
| 6   | e2e         | Sabotage: break one documented command's behaviour and assert test 2 goes red                                                                                 | The README test asserts that commands *run*, not that they do what the README says, and can never fail on a wrong claim     |
| 7   | manual      | A person follows the README top to bottom on a machine with no `deflow`, in a fresh shell, and records where they had to think                                 | Every automated check passes and the document still does not read as instructions — which is how it got here               |

**Notes / risks** — the durable half of this story is test 1 and test 2: the README stops being prose
somebody maintains by memory and becomes an artefact with a build. The risk is the skip list growing
until it covers everything interesting, which AC4's "short and named, with a reason" is aimed at and
which is worth re-reading whenever a line is added to it.

---

## Risks

| #   | Risk                                                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **A half-rename.** 468 tracked files carry a command literal and `core.ignorecase = true` hides case-only changes from the author's own checkout.                                        | KAR-20.1 AC2's source guard, AC6's case-only-path check asserted on a case-sensitive runner, and AC8's explicit non-rename list. The sweep is mechanical; the guards are what make a missed string red rather than a bug report.                                                                                |
| R2  | **`PATH` belongs to the operator.** `nvm`, `asdf`, `mise` and Homebrew each place npm's global prefix somewhere different, and it can differ between the running shell and the next one. | KAR-20.2 AC3 verifies by spawning `deflow --version` in a fresh-shell `PATH` rather than trusting a link command, and AC8 makes "I could not do it, here is the line" a first-class, non-zero-exit outcome. The installer is allowed to fail; it is not allowed to be wrong.                                     |
| R3  | **An installer that edits dotfiles is a new kind of thing for DeFlow to be**, and it can annoy people permanently.                                                                       | AC5 (name the file, print the line, ask, default no), AC6 (fixpoint on re-run), AC11 (nothing global without consent except the tool itself). The rules are KAR-18.8's, applied to a wider blast radius rather than reinvented.                                                                                 |
| R4  | **`deflow` may be taken on npm**, and `npx deflowai setup` resolves a package name.                                                                                                        | A Definition-of-Ready item: settle it before KAR-20.2 starts, and if taken, `npx @scope/deflow setup` with `deflow` still the bin. The bin name — the thing users type — is unaffected either way.                                                                                                             |
| R5  | **A curl-to-shell installer is a supply-chain surface** and a reasonable person will refuse to pipe it into a shell.                                                                     | `npx deflowai setup` is the first-class path and the script is the alternative; the script does nothing the npx path does not, is readable in one screen, and the README shows the download-then-read form beside the piped one.                                                                                 |
| R6  | **The deprecated alias outlives its argument.** Aliases are removed by nobody.                                                                                                           | KAR-20.1 AC4 puts the removal release in the notice string **and** in a test that fails once the package version passes it. The alias expires by going red, not by being remembered.                                                                                                                           |
| R7  | **An executed README is a slow test**, and slow tests get skipped.                                                                                                                       | KAR-20.3's clean-room execution rides KAR-18.6's existing `verify-install` job — tags and manual dispatch, not every push — and the fast half (flag cross-check, package-name cross-check, wording guard) is `unit`/`integration` and runs always.                                                              |
| R8  | **This epic is P0 and is not on M1's critical path**, so schedule pressure will suggest it slips whole.                                                                                  | It is ~10 days, it is the cheapest epic in the plan, and it is the only one that changes whether anybody else can run the product. The reason it was never planned is the reason it must not slip again: nobody had walked the path a new user walks.                                                          |

---

**Related:** [Flows](../flows/EPIC-20-install-and-naming-flows.md) · [Board](../board.md) ·
[EPIC-18](./EPIC-18-cli-packaging.md) · [EPIC-19](./EPIC-19-live-run-pipeline.md) ·
[03-local-development.md](../../03-local-development.md) ·
[16-repo-layout.md](../../16-repo-layout.md)

[← Back to the delivery plan](../README.md)
