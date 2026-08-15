# DeFlow

DeFlow runs coding agents for you and shows you what they did.

You give it a task. It works out a plan, runs the steps — often several at once — checks the
results against your acceptance criteria, and stops to ask you when it hits something it should
not decide alone. Everything it does is recorded, so you can scrub back through a run afterwards
and see why it went the way it did.

It is a local tool. It runs on your machine, against your git repository, driving the agent CLIs
you have already installed and logged into. It never asks for or stores your provider credentials.

## Before you install

You need two things:

- **Node 24 or newer.** DeFlow is an npm package, and the installer stops with the download link
  if this machine's Node is older or missing.
- **git**, and a repository to work in — DeFlow refuses to run outside a git working tree.

You do **not** need an agent CLI to start. A bundled agent, `deflow-mock-agent`, ships inside the
package and runs a whole plan end to end — planning, steps, gates, ledger, the scrubber — on a
machine with no vendor CLI installed and no login anywhere. That is the shortest way to see what
the tool does before deciding whether to point a real agent at it.

## Install it

```bash
npx deflowai setup
```

That is the install. `setup` fetches the package, puts the `deflow` command — and the shorter
`dfl`, which is the same program — where your shell can find it, and then **proves it**: it opens
a shell the way your terminal does and runs the command in there. If your next terminal would not
find it, `setup` says so and exits non-zero rather than congratulating you.

It never edits a file in your home directory without asking. When a `PATH` line is needed, it
names the file, shows you the exact line, and a bare Enter means no.

```bash
deflow --version
deflow --help
```

### If this machine has no Node at all

Then it cannot run the command above, and a script is the way in. It checks for Node, tells you
what to install if there is none, and otherwise hands straight over to the same `deflow setup` —
it installs nothing of its own, writes no file and never uses `sudo`.

```bash
curl -fsSL https://deflow.dev/install.sh -o install.sh
sh install.sh
```

Read it before you run it. It is one screen, and that is the point of downloading it first.

## Adding a real agent

The bundled agent is for looking around. For real work, install a vendor CLI and log into it — your
existing subscription is what pays for the work, and DeFlow never sees the credentials.

Three of the five vendors speak DeFlow's protocol (ACP) themselves, so one package is both the CLI
you log into and the program DeFlow spawns. **Two do not**: `claude` and `codex` reach ACP through a
separate bridge package, so they need two installs — the vendor CLI, and the adapter. Installing
only the adapter leaves you with no vendor CLI at all, which is exactly what `doctor` will tell you.

| Provider   | npm package                             | Puts on `PATH`      | What it is                             |
| ---------- | --------------------------------------- | ------------------- | -------------------------------------- |
| `gemini`   | `@google/gemini-cli`                    | `gemini`            | the vendor CLI — it speaks ACP itself  |
| `copilot`  | `@github/copilot`                       | `copilot`           | the vendor CLI — it speaks ACP itself  |
| `opencode` | `opencode-ai`                           | `opencode`          | the vendor CLI — it speaks ACP itself  |
| `claude`   | `@anthropic-ai/claude-code`             | `claude`            | the vendor CLI — you log into this     |
| `claude`   | `@agentclientprotocol/claude-agent-acp` | `claude-agent-acp`  | the ACP adapter — DeFlow spawns this   |
| `codex`    | `@openai/codex`                         | `codex`             | the vendor CLI — you log into this     |
| `codex`    | `@agentclientprotocol/codex-acp`        | `codex-acp`         | the ACP adapter — DeFlow spawns this   |
| `mock`     | `deflowai`                              | `deflow-mock-agent` | the bundled agent — nothing to install |

So for Claude Code, install the vendor CLI yourself and let DeFlow fetch the adapter it needs:

```bash
npm install -g @anthropic-ai/claude-code
deflow doctor --fix
```

`doctor --fix` installs the missing ACP adapter for every vendor CLI it can already see on your
`PATH`, and nothing else. Without `--fix` it offers, once, and installs nothing if you say no.

## Your first run

Three commands, in your own repository.

```bash
deflow doctor     # can this machine do the work?
deflow init       # set this repository up
deflow up         # start the daemon and open the UI
```

**`doctor`** is the one to run first, and the one to come back to when something is odd. It checks
eight things — your runtime, git, sandboxing, which agents are installed, what they can each do,
whether they actually respond correctly, your logins, and your memory setup — and tells you what is
wrong in words rather than a stack trace. It exits 0 if every check is ok or a warning, and 5 if any
check fails, so you can also use it in CI.

**`init`** prepares the repository. It creates a `.DeFlow/` folder holding your config, your custom
gates, your templates and your project memory, and adds the machine-specific bits to `.gitignore` so
you do not accidentally commit them. Safe to re-run: it leaves anything you have edited alone.

**`up`** starts the background service and prints the URL it is serving, then opens it:
`http://127.0.0.1:7777/#token=<token>`. 7777 is the default rather than a promise — if something
else already holds that port, `up` takes the next free one and the URL it prints is the one it
bound, so read the URL rather than assuming the number. `--port <n>` pins it instead, and fails
outright if that port is taken. The access token rides in the URL **fragment**, which
browsers never send to a server and which the page strips from the address bar as soon as it has
read it — so it does not end up in your shell history, in a server log or in a bookmark. The URL is
printed whether or not a browser opens, so a machine with no browser still has something to click.
Run `up` a second time and it tells you a daemon is already running rather than starting a second
one.

From there, describe your task in the UI and watch it go.

## Working from the terminal instead

If you would rather not open a browser at all:

```bash
deflow run "add rate limiting to the public API"
deflow run --provider gemini "add rate limiting to the public API"
```

`run` takes the task from the command line, or from somewhere else:

| Flag                  | What it does                                                          |
| --------------------- | --------------------------------------------------------------------- |
| `--file <path>`       | Take the task from a file in this repository                          |
| `--issue <ref>`       | Take it from a git issue: a URL, or `owner/repo#42`                   |
| `--spec <path>`       | Take it from a spec document                                          |
| `--attach <runId>`    | Watch a run that already exists instead of creating one               |
| `--provider <id>`     | Send every step to one agent — `gemini`, `copilot`, `opencode`, `claude`, `codex` or `mock`. Refused, with the list this machine actually has, if it is not one of them |
| `--permission <level>` | How much the agent may touch; see below                              |
| `--json`              | One JSON object per line, for a pipe                                  |
| `--no-wait`           | Exit 4 on an open human gate instead of waiting for it                |

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

## How much you let it do

Every run has a permission level, and `worktree` is the default:

| Level | What the agent can touch |
| ----- | ------------------------ |
| `read` | Nothing. It can look, and it cannot write or run anything |
| `worktree` | Its own isolated copy of your repo, and no network — **the default** |
| `worktree+net` | The same copy, plus the network against a domain allowlist |
| `full` | Everything, network included — never a default, always asked for |

```bash
deflow run "refactor the auth module" --permission read
```

The default matters: work happens in a separate git worktree, so a run that goes wrong cannot
scribble on the branch you are sitting on. You review the result before it goes anywhere near your
working tree.

## The other two commands

```bash
deflow status
deflow ledger snapshot <runId> --out bug.db
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

Run `deflow doctor` first — most problems are a missing CLI, an expired login, or two agent CLIs
whose credentials are shadowing each other, and `doctor` names all three specifically.

If a run itself misbehaved, open it in the UI and drag the scrubber. Every view is rebuilt from the
recorded events, so you can step back to any moment and see the plan as it stood then, what each
step was given, what it cost, and which check turned red. If you need help, `ledger snapshot` puts
that whole history in one file.

## A note on cost

DeFlow tracks spend per run and per step and will pause a run rather than quietly burn through your
quota — that is what exit code 3 means. Budgets and ceilings are set in `.DeFlow/config.yaml`.

## Building it from source — the contributor path

This section is for people who want to **work on DeFlow itself**. If you only want to use it, the
install above is the whole story and this is not a second way to do it.

```bash
pnpm install
pnpm build
```

That produces the command in `packages/cli/dist/`, which the repository's own test suite drives
directly. `docs/03-local-development.md` is the rest of it: the toolchain versions, the git hooks,
and how to run one slice of the tests instead of all of them.

## Where to read more

`docs/` holds the design in detail: `docs/01-architecture-overview.md` for how the pieces fit,
`docs/09-workspace-and-safety.md` for the permission model, `docs/10-verification-gates.md` for how
checking works, and `docs/adr/` for the decisions behind all of it and why they were made.
