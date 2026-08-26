/**
 * `deflow cancel <runId>` (KAR-19.6) — the command the detach sentence has
 * been printing since 2026-08-11 and that has never resolved to anything.
 *
 * `'deflow cancel <runId>' to stop` is what `deflow run` prints when an
 * operator detaches (KAR-18.3 AC3). The daemon has had the capability since
 * KAR-15.5 — `POST /api/runs/:id/cancel`, two ladders, verified kills — and
 * nothing in the CLI was wired to it, so the only route to it was `curl` with
 * a bearer token read out of the token file by hand. A capability no operator
 * can reach is not a capability.
 *
 * Three decisions, and each is an acceptance criterion.
 *
 * **One operator verb, two daemon paths.** The word is `cancel`, because that
 * is the word the operator typed and the word the route already carries. Which
 * path it takes — a ladder for a run with something in flight, a termination
 * for a run that never started — is the **daemon's** decision, read from the
 * reduced ledger (`planRunControl`). This command does not branch on a `422`
 * and try a second route: that fallback was here, it could not help a run with
 * no gate open, and it put the daemon's state machine in the CLI where the web
 * UI could not reach it.
 *
 * **The mode is stated, never guessed.** Cooperative is the default and says
 * that the agent is being given its chance to flush a transcript; `--force`
 * names F5.7's ladder and says that the transcript may be truncated. A `--mode`
 * outside `CANCEL_MODES` is refused here, before a socket is opened, in the
 * daemon's own words (`invalidCancelModeMessage`) rather than in a second
 * wording of the same rule.
 *
 * **Nothing escalates by itself.** A cooperative cancel whose agent never
 * answers leaves the run `cancelling`, and this command says so and names
 * `--force` — because the whole point of having two modes is that one of them
 * may lose the transcript the operator cancelled the run in order to read.
 *
 * Verifies: EPIC-19-S37, EPIC-19-S38, EPIC-19-S41 · AC1, AC2, AC6, AC8
 */
import type { CancelMode, RunStatus } from '@DeFlow/core';
import {
  CANCEL_MODES,
  forcefulCancelCommand,
  invalidCancelModeMessage,
  RUN_STATUS_LABELS,
} from '@DeFlow/core';
import { resolveDataDir } from '@DeFlow/daemon';
import process from 'node:process';
import { type Report, type ReportRow, renderReport } from './render/report.ts';
import { plainStyle, type Style } from './render/style.ts';
import { type DaemonEndpoint, findDaemon } from './run/daemon.ts';
import { EX_USAGE, RUN_EXIT_CODES } from './run/exit-codes.ts';

export interface CancelArgs {
  readonly runId: string;
  readonly mode: CancelMode;
}

export type ParsedCancelArgs =
  | { readonly ok: true; readonly args: CancelArgs }
  | { readonly ok: false; readonly message: string };

const isCancelMode = (value: string): value is CancelMode =>
  (CANCEL_MODES as readonly string[]).includes(value);

/**
 * AC2 — `cancel <runId> [--force | --mode <mode>]`, refused rather than
 * guessed at.
 *
 * `--force` is the spelling an operator reaches for and `--mode` is the one a
 * script writes; both land on the same closed set, so there is no third state
 * in which the command has an opinion the daemon does not.
 */
export function parseCancelArgs(argv: readonly string[]): ParsedCancelArgs {
  let runId: string | null = null;
  let mode: CancelMode = 'cooperative';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    // KAR-18.9 AC7 — accepted and consumed, never acted on: the styling
    // decision is `bin.ts`'s, computed once for the whole process.
    if (argument === '--no-color') continue;

    if (argument === '--force') {
      mode = 'forceful';
      continue;
    }

    if (argument === '--mode') {
      const asked = argv[index + 1];
      index += 1;
      if (asked === undefined || !isCancelMode(asked)) {
        return { ok: false, message: `deflow cancel: ${invalidCancelModeMessage()}` };
      }
      mode = asked;
      continue;
    }

    if (argument.startsWith('-')) {
      return { ok: false, message: `deflow cancel: unknown option ${JSON.stringify(argument)}` };
    }

    if (runId !== null) {
      return { ok: false, message: `deflow cancel: one run id, not two (${runId}, ${argument})` };
    }
    runId = argument;
  }

  if (runId === null) {
    return {
      ok: false,
      message:
        "deflow cancel: which run? Usage: deflow cancel <runId> [--force]. 'deflow status' lists the runs this machine is working on.",
    };
  }

  return { ok: true, args: { runId, mode } };
}

/**
 * AC2 — what the mode means, in the operator's terms: whether the transcript
 * survives.
 *
 * Both sentences name the same consequence from opposite sides, deliberately.
 * "Forceful" and "cooperative" are words about DeFlow's machinery; what the
 * operator is choosing between is a readable transcript and a run that is
 * definitely stopped.
 */
export function cancelModeSentence(mode: CancelMode): string {
  return mode === 'forceful'
    ? 'forceful — session/cancel, then SIGTERM, a grace window, then SIGKILL, answered only once ' +
        'the kill is verified. The transcript may be truncated.'
    : 'cooperative — the agent is being given the chance to flush its transcript before anything ' +
        'is signalled.';
}

/** What the daemon answered, as this command needs it. */
export interface CancelAnswer {
  readonly runId: string;
  /** The mode that was asked for, which the response does not echo. */
  readonly mode: CancelMode;
  readonly status: RunStatus;
  /** `false` when the run was already in the state asked for (AC6). */
  readonly appended: boolean;
  readonly seq: number;
  /** Present only for a `forceful` cancel that ran a ladder. */
  readonly kill?: { readonly outcome: string; readonly survivors: readonly number[] };
}

const ENDED: readonly RunStatus[] = ['completed', 'aborted'];

/** The state a row is drawn in: a run still winding down is not a failure, and
 * a survivor of the ladder is. */
function killState(kill: CancelAnswer['kill']): ReportRow['state'] {
  if (kill === undefined) return 'ok';
  return kill.survivors.length > 0 ? 'fail' : 'ok';
}

/** AC2, AC6, AC8 — the whole of what the command prints, as a `Report`. */
export function toCancelReport(answer: CancelAnswer): Report {
  const ended = ENDED.includes(answer.status);
  const alreadyEnded = ended && !answer.appended;
  // AC8 — the one case with a next move: the operator asked politely, the agent
  // has not answered, and nothing here is going to escalate for them. A `warn`
  // rather than an `ok`, because "the run is still stopping" is an outstanding
  // fact and an `ok` report is one an operator stops reading.
  const waiting = answer.status === 'cancelling' && answer.mode === 'cooperative';

  const rows: ReportRow[] = [
    {
      id: 'run',
      state: alreadyEnded ? 'skipped' : waiting ? 'warn' : 'ok',
      detail: alreadyEnded
        ? `${answer.runId} had already ended: ${RUN_STATUS_LABELS[answer.status]} (seq ${answer.seq}). Nothing was appended.`
        : `${answer.runId} — ${RUN_STATUS_LABELS[answer.status]} (seq ${answer.seq})`,
      // KAR-27.6 AC2 — the same command `deflow status`, the run list and the
      // run view name, from `@DeFlow/core` rather than spelled a second time
      // here (`test/one-cancel-remedy.test.ts`).
      ...(waiting ? { action: forcefulCancelCommand(answer.runId) } : {}),
    },
    { id: 'mode', state: 'ok', detail: cancelModeSentence(answer.mode) },
  ];

  if (answer.kill !== undefined) {
    rows.push({
      id: 'kill',
      state: killState(answer.kill),
      detail:
        answer.kill.survivors.length > 0
          ? `the kill did not take: ${answer.kill.survivors.join(', ')} outlived it`
          : `every process of the run is gone (${answer.kill.outcome})`,
    });
  }

  return { title: `deflow cancel: ${answer.runId}`, sections: [{ title: 'Cancel', rows }] };
}

export function renderCancel(answer: CancelAnswer, style: Style = plainStyle()): string {
  return renderReport(toCancelReport(answer), style);
}

export interface CancelCommandOptions {
  /** Everything after `cancel`. */
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly style?: Style;
  /**
   * How the daemon is found. Injected so a spec can assert that a refused mode
   * never reaches a socket — the whole of AC2's *"before any request is
   * sent"*.
   */
  readonly findDaemon?: (dataDir: string) => Promise<DaemonEndpoint | null>;
  /** Injected for the same reason. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const refuse = (exitCode: number, message: string): CommandResult => ({
  exitCode,
  stdout: '',
  stderr: `${message}\n`,
});

interface ControlBody {
  readonly runId?: string;
  readonly seq?: number;
  readonly status?: string;
  readonly appended?: boolean;
  readonly kill?: { readonly outcome?: string; readonly survivors?: readonly number[] };
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/** The daemon's sentence, or a description of a body that was not one. Never a
 * stack trace: a refusal an operator can read is the point (AC6). */
async function refusalOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const code = body?.error?.code ?? 'unknown';
  const message = body?.error?.message ?? `the daemon answered ${response.status}`;
  return `${code}: ${message}`;
}

/**
 * `deflow cancel` — the whole command, minus the process (AC1).
 *
 * The token comes from the same `daemon.json` every other command reads, which
 * is the whole of *"no documented way to stop a run involves a hand-extracted
 * bearer token"*: the file is read by the CLI, not by the operator.
 */
export async function runCancel(options: CancelCommandOptions): Promise<CommandResult> {
  const parsed = parseCancelArgs(options.argv);
  if (!parsed.ok) return refuse(EX_USAGE, parsed.message);

  const env = options.env ?? process.env;
  const look = options.findDaemon ?? findDaemon;
  const endpoint = await look(resolveDataDir(env));
  if (endpoint === null) {
    return refuse(
      RUN_EXIT_CODES.daemonRefused,
      'deflow cancel: no daemon is running on this machine, so nothing is driving that run — ' +
        "'deflow status' says what this machine thinks is happening",
    );
  }

  const send = options.fetch ?? globalThis.fetch;
  const response = await send(`${endpoint.baseUrl}/api/runs/${parsed.args.runId}/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
      'X-DeFlow-Submitted-By': 'cli',
    },
    body: JSON.stringify({ mode: parsed.args.mode }),
  });

  if (!response.ok) {
    return refuse(RUN_EXIT_CODES.failed, `deflow cancel: ${await refusalOf(response)}`);
  }

  const body = (await response.json()) as ControlBody;
  const answer: CancelAnswer = {
    runId: parsed.args.runId,
    mode: parsed.args.mode,
    status: (body.status ?? 'cancelling') as RunStatus,
    appended: body.appended ?? true,
    seq: body.seq ?? 0,
    ...(body.kill === undefined
      ? {}
      : {
          kill: {
            outcome: body.kill.outcome ?? 'unknown',
            survivors: body.kill.survivors ?? [],
          },
        }),
  };

  return {
    exitCode: 0,
    stdout: renderCancel(answer, options.style ?? plainStyle()),
    stderr: '',
  };
}
