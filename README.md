# DeFlow

DeFlow runs coding agents for you and shows you what they did.

You give it a task. It works out a plan, runs the steps — often several at once — checks the
results against your acceptance criteria, and stops to ask you when it hits something it should
not decide alone. Everything it does is recorded, so you can scrub back through a run afterwards
and see why it went the way it did.

It is a local tool. It runs on your machine, against your git repository, driving the agent CLIs
you have already installed and logged into. It never asks for or stores your provider credentials.

## Before you start

You will need:

- **Node 24 or newer** and **pnpm**
- **git**, and a repository to work in — DeFlow refuses to run outside a git working tree
- **at least one agent CLI installed and logged in**: `claude`, `codex`, `gemini`, `copilot` or
  `opencode`. DeFlow shells out to these; your existing login is what pays for the work.

DeFlow is not on npm yet. For now you run it from this repository:

```bash
pnpm install
pnpm build
```

That produces the `DeFlow` binary at `packages/cli/dist/bin.mjs`. Put it on your `PATH`, or alias
it, and the commands below will work as written.

## Your first run

Three commands, in your own repository.

```bash
DeFlow doctor     # can this machine do the work?
DeFlow init       # set this repository up
DeFlow up         # start the daemon and open the UI
```

**`doctor`** is the one to run first, and the one to come back to when something is odd. It checks
eight things — your runtime, git, sandboxing, which agents are installed, what they can each do,
whether they actually respond correctly, your logins, and your memory setup — and tells you what is
wrong in words rather than a stack trace. It exits 0 if everything is usable and 5 if anything is
broken, so you can also use it in CI.

**`init`** prepares the repository. It creates a `.DeFlow/` folder holding your config, your custom
gates, your templates and your project memory, and adds the machine-specific bits to `.gitignore` so
you do not accidentally commit them. Safe to re-run: it leaves anything you have edited alone.

**`up`** starts the background service and opens the UI at `http://127.0.0.1:7777`. The access token
is handed to the browser in the URL fragment and stripped from the address bar immediately, so it
never ends up in your shell history or your browser's address bar. Run `up` a second time and it
tells you a daemon is already running rather than starting a second one.

From there, describe your task in the UI and watch it go.

## Working from the terminal instead

If you would rather not open a browser at all:

```bash
DeFlow run "add rate limiting to the public API"
DeFlow run --file docs/tasks/rate-limit.md
DeFlow run --issue owner/repo#42
DeFlow run --attach r_01JXQ          # watch a run that is already going
```

`run` streams the run to your terminal and exits with a code that means something:

| Code | What happened |
| ---- | ------------- |
| 0 | Finished, every check passed |
| 1 | A check failed, or a step failed |
| 2 | The daemon would not start |
| 3 | Paused because it hit a budget ceiling |
| 4 | Waiting on you, and you passed `--no-wait` |
| 5 | This machine cannot host a run — run `doctor` |
| 130 | You interrupted it |

Press **Ctrl-C once** to walk away: the run keeps going in the background and you can re-attach
later. Press it **twice within three seconds** to actually cancel the run.

Add `--json` for one JSON object per line if you are piping this into something else.

## How much you let it do

Every run has a permission level, and `worktree` is the default:

| Level | What the agent can touch |
| ----- | ------------------------ |
| `read` | Nothing. It can look, not change |
| `worktree` | Its own isolated copy of your repo — **the default** |
| `repo` | Your actual working tree |
| `system` | The machine |

```bash
DeFlow run "refactor the auth module" --permission read
```

The default matters: work happens in a separate git worktree, so a run that goes wrong cannot
scribble on the branch you are sitting on. You review the result before it goes anywhere near your
working tree.

## The other two commands

```bash
DeFlow status                              # is a daemon running, and where?
DeFlow ledger snapshot r_01JXQ --out bug.db
```

`status` is a question, not an assertion — "nothing is running" is a normal answer and it always
exits 0.

`ledger snapshot` copies everything about one run into a single file you can attach to a bug report.
Whoever receives it can open it with plain `sqlite3` and does not need DeFlow installed.

## Making it yours

Everything configurable lives in `.DeFlow/` in your repository:

- **`config.yaml`** — your settings, validated against a schema that `init` writes alongside it, so
  your editor can autocomplete it and tell you when you have made a typo.
- **`gates/`** — your own checks. Drop a script in here and DeFlow will run it as part of verifying
  work, alongside the built-in ones like typecheck and lint.
- **`templates/`** and **`memory/`** — reusable task shapes, and what the project has learned.

Because `.DeFlow/` is committed (apart from the per-machine parts), your team shares the same gates
and the same settings.

## When something looks wrong

Run `DeFlow doctor` first — most problems are a missing CLI, an expired login, or two agent CLIs
whose credentials are shadowing each other, and `doctor` names all three specifically.

If a run itself misbehaved, open it in the UI and drag the scrubber. Every view is rebuilt from the
recorded events, so you can step back to any moment and see the plan as it stood then, what each
step was given, what it cost, and which check turned red. If you need help, `ledger snapshot` puts
that whole history in one file.

## A note on cost

DeFlow tracks spend per run and per step and will pause a run rather than quietly burn through your
quota — that is what exit code 3 means. Budgets and ceilings are set in `.DeFlow/config.yaml`.

## Where to read more

`docs/` holds the design in detail: `docs/01-architecture-overview.md` for how the pieces fit,
`docs/09-workspace-and-safety.md` for the permission model, `docs/10-verification-gates.md` for how
checking works, and `docs/adr/` for the decisions behind all of it and why they were made.
