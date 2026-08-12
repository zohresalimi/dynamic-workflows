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
}

export type ParsedRunArgs =
  | { readonly ok: true; readonly args: RunArgs }
  | { readonly ok: false; readonly message: string };

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

export function parseRunArgs(argv: readonly string[]): ParsedRunArgs {
  let input: RunInput | null = null;
  let source: RunSource | null = null;
  let attach: string | null = null;
  let json = false;
  let noWait = false;
  let permission: PermissionLevel = 'worktree';

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
    return { ok: true, args: { input, source, attach, json, noWait, permission } };
  }
}
