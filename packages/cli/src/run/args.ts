/**
 * `DeFlow run`'s argv (KAR-18.3 AC7, AC8).
 *
 * Parsing only: no I/O, no defaults that reach for the environment, and no
 * process. The command body next door takes the result and does the work, which
 * is what lets every refusal in this file be asserted without a daemon.
 *
 * **Four sources, three wire shapes.** F1.1 accepts free text, a file, an issue
 * reference and a spec document; KAR-10.1 settled that the wire carries three
 * kinds, because *"a spec document is the `file` kind with its own `mediaType`
 * in provenance — there is no fourth shape"* (@DeFlow/core's task-intake.ts).
 * `--spec` therefore produces `{ kind: 'file' }` and keeps the operator's own
 * word in `source`, so a message about `--spec` says `--spec`. The locator is
 * what makes the run's source inspectable six weeks later (AC8), and it
 * survives either way: intake records the resolved path in `task.submitted`'s
 * provenance.
 *
 * **An unknown flag is a refusal.** Ignoring one is how `--detach` silently
 * does nothing and the operator concludes the CLI is broken — the same rule
 * `parseUpArgs` follows, for the same reason.
 */
import { PROVIDER_SPECS } from '@DeFlow/adapters';
import type { PermissionLevel } from '@DeFlow/core';
import { PERMISSION_LEVELS, RunIdSchema } from '@DeFlow/core';

/** The wire shape `POST /api/runs` accepts (KAR-10.1's `RunIntakeInput`). */
export type RunInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'issue'; readonly url: string };

/** Which of F1.1's four the operator typed. `spec` and `file` share a wire
 * kind and differ only here. */
export type RunSource = 'text' | 'file' | 'issue' | 'spec';

export interface RunArgs {
  /** `null` when `--attach` was given: there is nothing to submit. */
  readonly input: RunInput | null;
  readonly source: RunSource | null;
  /** The run to watch instead of creating one. */
  readonly attach: string | null;
  /** NDJSON instead of the human transcript (AC7). */
  readonly json: boolean;
  /** Exit 4 on an open human gate instead of waiting for it (AC6). */
  readonly noWait: boolean;
  readonly permission: PermissionLevel;
  /**
   * KAR-19.10 AC1 — the provider the operator named, or `null` for "choose".
   *
   * A registry id, already checked to be one. What it is *not* is a decision
   * about whether this machine can serve it: that is an environment question
   * with a different exit code (5) and a different next action, and it is
   * answered by admission rather than by an argv parser.
   */
  readonly provider: string | null;
}

/**
 * One registered provider, and whether this machine can serve it — the two
 * facts an operator who mistyped `--provider` needs in the same line.
 *
 * Passed in rather than resolved here, so this module keeps its promise: no
 * I/O, no `PATH`, no filesystem. `providerChoicesFor` in `./run.ts` builds it
 * from the roots the command already split.
 */
export interface ProviderChoice {
  readonly id: string;
  readonly usable: boolean;
}

export interface ParseRunArgsOptions {
  /** Defaults to every registered id, with usability unknown — which is the
   * honest answer for a caller that did not look at the machine. */
  readonly providers?: readonly ProviderChoice[];
}

export type ParsedRunArgs =
  | { readonly ok: true; readonly args: RunArgs }
  | { readonly ok: false; readonly message: string };

/** Every registered provider, in id order, with nothing claimed about this
 * machine. Derived from `PROVIDER_SPECS`, so an entry added there changes the
 * refusal message with no other edit (AC1, AC9). */
export function registeredProviderChoices(): readonly ProviderChoice[] {
  return Object.keys(PROVIDER_SPECS)
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({ id, usable: false }));
}

/**
 * AC1's refusal: the closed list, and which of it is worth typing here.
 *
 * Both halves in one line because they answer one question. Knowing that a
 * provider is registered is not useful to an operator whose machine does not
 * have it, and the two facts cost a clause together.
 */
function unknownProviderMessage(given: string, providers: readonly ProviderChoice[]): string {
  const usable = providers.filter((choice) => choice.usable).map((choice) => choice.id);
  return (
    `DeFlow run: --provider takes one of ${providers.map((choice) => choice.id).join(', ')}; got ` +
    `${JSON.stringify(given)}. Usable on this machine: ${usable.length === 0 ? 'none — run "DeFlow doctor"' : usable.join(', ')}.`
  );
}

const USAGE_HINT =
  'DeFlow run: give it something to do — DeFlow run "<task>", or --file <path>, ' +
  '--issue <ref>, --spec <path>, or --attach <runId>';

const ONE_SOURCE =
  'DeFlow run: exactly one source — free text, --file, --issue or --spec — and one is all it takes';

const refuse = (message: string): ParsedRunArgs => ({ ok: false, message });

/** `owner/repo#42`, the form people actually type and paste. */
const ISSUE_SHORTHAND = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/**
 * The issue reference, as the daemon's resolver takes it.
 *
 * `resolveIssue` accepts one shape — `https://github.com/<owner>/<repo>/issues/<n>`
 * — and refuses everything else by design, so the shorthand is expanded *here*
 * rather than loosened *there*: the CLI is where a human types, and the wire
 * shape stays the one shape the resolver documents.
 */
function issueUrl(reference: string): string {
  const match = ISSUE_SHORTHAND.exec(reference);
  if (match === null) return reference;
  return `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
}

/** The value of `--flag value` or `--flag=value`, and how far to skip. */
function valueOf(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string | undefined; next: number } {
  const argument = argv[index] ?? '';
  if (argument.startsWith(`${flag}=`)) {
    return { value: argument.slice(flag.length + 1), next: index };
  }
  return { value: argv[index + 1], next: index + 1 };
}

const isPermission = (value: string): value is PermissionLevel =>
  (PERMISSION_LEVELS as readonly string[]).includes(value);

export function parseRunArgs(
  argv: readonly string[],
  options: ParseRunArgsOptions = {},
): ParsedRunArgs {
  const providers = options.providers ?? registeredProviderChoices();
  let input: RunInput | null = null;
  let source: RunSource | null = null;
  let attach: string | null = null;
  let json = false;
  let noWait = false;
  let permission: PermissionLevel = 'worktree';
  let provider: string | null = null;

  const setSource = (next: RunSource, value: RunInput): string | null => {
    if (source !== null) return ONE_SOURCE;
    source = next;
    input = value;
    return null;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    // Everything after `--` is the task, so a task may start with a dash.
    if (argument === '--') {
      const rest = argv.slice(index + 1).join(' ');
      if (rest === '') return refuse(USAGE_HINT);
      const clash = setSource('text', { kind: 'text', text: rest });
      return clash === null ? finish() : refuse(clash);
    }

    // KAR-18.9 AC7 — accepted and *consumed* here, never acted on: the styling
    // decision is `bin.ts`'s, computed once for the whole process. A parser
    // that refused this flag would make "--no-color works everywhere" false
    // for four of the five commands.
    if (argument === '--no-color') continue;

    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--no-wait') {
      noWait = true;
      continue;
    }

    if (argument === '--permission' || argument.startsWith('--permission=')) {
      const { value, next } = valueOf(argv, index, '--permission');
      if (value === undefined || !isPermission(value)) {
        return refuse(
          `DeFlow run: --permission takes one of ${PERMISSION_LEVELS.join(', ')}; got ` +
            JSON.stringify(value ?? ''),
        );
      }
      permission = value;
      index = next;
      continue;
    }

    // KAR-19.10 AC1 — validated here, before anything is submitted, and against
    // the registry rather than a literal. `EX_USAGE` and not exit 5: a
    // misspelling is not an unusable machine, and the two lead to opposite next
    // actions — edit the command, versus install a package.
    if (argument === '--provider' || argument.startsWith('--provider=')) {
      const { value, next } = valueOf(argv, index, '--provider');
      if (value === undefined || !providers.some((choice) => choice.id === value)) {
        return refuse(unknownProviderMessage(value ?? '', providers));
      }
      provider = value;
      index = next;
      continue;
    }

    if (argument === '--attach' || argument.startsWith('--attach=')) {
      const { value, next } = valueOf(argv, index, '--attach');
      if (value === undefined) return refuse('DeFlow run: --attach needs a run id');
      if (!RunIdSchema.safeParse(value).success) {
        return refuse(
          `DeFlow run: --attach needs a run id like run_20260810T101500Z_c4a5b1; got ${JSON.stringify(value)}`,
        );
      }
      attach = value;
      index = next;
      continue;
    }

    if (argument === '--file' || argument.startsWith('--file=')) {
      const { value, next } = valueOf(argv, index, '--file');
      if (value === undefined || value === '') return refuse('DeFlow run: --file needs a path');
      const clash = setSource('file', { kind: 'file', path: value });
      if (clash !== null) return refuse(clash);
      index = next;
      continue;
    }

    if (argument === '--spec' || argument.startsWith('--spec=')) {
      const { value, next } = valueOf(argv, index, '--spec');
      if (value === undefined || value === '') return refuse('DeFlow run: --spec needs a path');
      const clash = setSource('spec', { kind: 'file', path: value });
      if (clash !== null) return refuse(clash);
      index = next;
      continue;
    }

    if (argument === '--issue' || argument.startsWith('--issue=')) {
      const { value, next } = valueOf(argv, index, '--issue');
      if (value === undefined || value === '')
        return refuse('DeFlow run: --issue needs an issue reference');
      const clash = setSource('issue', { kind: 'issue', url: issueUrl(value) });
      if (clash !== null) return refuse(clash);
      index = next;
      continue;
    }

    if (argument.startsWith('-')) {
      return refuse(`DeFlow run: unknown option ${JSON.stringify(argument)}`);
    }

    const clash = setSource('text', { kind: 'text', text: argument });
    if (clash !== null) return refuse(clash);
  }

  return finish();

  function finish(): ParsedRunArgs {
    if (attach !== null && input !== null) {
      return refuse(
        'DeFlow run: --attach watches a run that already exists, so it takes no task of its own',
      );
    }
    if (attach === null && input === null) return refuse(USAGE_HINT);
    return { ok: true, args: { input, source, attach, json, noWait, permission, provider } };
  }
}
