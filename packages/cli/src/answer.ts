/**
 * `deflow answer <runId> --gate <node> --option <id>` (KAR-19.12 AC4) — the
 * command the gate block has been telling operators to run, and that until now
 * did not exist.
 *
 * `approveSpec` in `./index.ts` has been a client of
 * `POST /api/runs/:id/spec/approve` since KAR-10.3, and its own doc comment
 * describes it as *"`deflow approve <runId>`"* — a command nobody ever
 * registered in `bin.ts`. So the only route to the F1.3 gate was a browser, or
 * a hand-written HTTP request carrying a bearer token the operator had to dig
 * out of the daemon's own token file. That is the same shape as the `cancel`
 * gap KAR-19.6 closed, and it is closed the same way: the token file is read by
 * the CLI, not by the operator.
 *
 * Three decisions, and each is part of AC4.
 *
 * **The gate is named, never guessed.** There is no default `--gate` and no
 * default `--option`. A run can hold more than one open gate, and a command
 * that picked one would answer a question the operator had not read. The block
 * `deflow run` prints carries the exact line to type, so the cost of naming
 * both is a copy and a paste.
 *
 * **The daemon owns what an answer means.** The F1.3 decisions go to the four
 * spec routes and every other gate to `POST /runs/:id/nodes/:nodeId/respond`;
 * this file chooses the route and forwards the refusal verbatim. An option a
 * *plan* gate does not offer is refused by `planHumanResponse` — in **its**
 * words, naming what that gate does offer — because a second validator here
 * would drift from the first the day a plan declares a fifth option. The F1.3
 * gate is the one exception and it is a routing fact, not a policy one: its
 * four decisions are four endpoints, so an option outside them is a route that
 * does not exist and a forwarded `404` would tell the operator nothing. That
 * one check is made against `SPEC_DECISIONS` in `@DeFlow/core` — the same
 * constant the routes and `SPEC_APPROVAL_OPTIONS` are built from, so it is not
 * a second vocabulary either.
 *
 * **`edit` is refused honestly.** An edit replaces the whole amended framed
 * document (`DeFlow.taskspecdraft.v1`), which is not something a flag can
 * carry; the route says so at length and this says the same thing before a
 * socket is opened, naming the surface that *can* supply one. Pretending
 * otherwise would be worse than refusing.
 *
 * Verifies: EPIC-19-S80 · KAR-19.12 AC4
 */
import {
  gateAnswerRequest,
  SPEC_DECISIONS,
  SPEC_EDIT_NEEDS_A_DOCUMENT,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import { resolveDataDir } from '@DeFlow/daemon';
import process from 'node:process';
import type { CommandResult } from './cancel.ts';
import { type Report, renderReport } from './render/report.ts';
import { plainStyle, type Style } from './render/style.ts';
import { type DaemonEndpoint, findDaemon } from './run/daemon.ts';
import { EX_USAGE, RUN_EXIT_CODES } from './run/exit-codes.ts';

export interface AnswerArgs {
  readonly runId: string;
  /** The gate's node id, exactly as the announcement block printed it. */
  readonly gate: string;
  readonly option: string;
  /** `reject`'s reason, `inject`'s guidance, or a note on any option. */
  readonly text: string | null;
}

export type ParsedAnswerArgs =
  | { readonly ok: true; readonly args: AnswerArgs }
  | { readonly ok: false; readonly message: string };

/**
 * The one F1.3 option no flag can carry. @see the module note.
 *
 * The sentence itself is `@DeFlow/core`'s `SPEC_EDIT_NEEDS_A_DOCUMENT` — the
 * same one KAR-22.5's gate panel shows beside the option it will not submit,
 * because it is one limitation and an operator should not have to discover it
 * twice. This adds the command's own name and the surface that *could* take a
 * whole replacement document, both of which are facts about this caller.
 */
const EDIT_REFUSAL =
  `deflow answer: ${SPEC_EDIT_NEEDS_A_DOCUMENT} ` +
  'A whole amended document goes to POST /api/runs/<runId>/spec/edit.';

/** AC4's argv. Nothing is defaulted. @see the module note. */
export function parseAnswerArgs(argv: readonly string[]): ParsedAnswerArgs {
  let runId: string | null = null;
  let gate: string | null = null;
  let option: string | null = null;
  let text: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    // KAR-18.9 AC7 — accepted and consumed, never acted on: the styling
    // decision is `bin.ts`'s, computed once for the whole process.
    if (argument === '--no-color') continue;

    if (argument === '--gate' || argument === '--option' || argument === '--text') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, message: `deflow answer: ${argument} needs a value` };
      }
      if (argument === '--gate') gate = value;
      else if (argument === '--option') option = value;
      else text = value;
      continue;
    }

    if (argument.startsWith('-')) {
      return { ok: false, message: `deflow answer: unknown option ${JSON.stringify(argument)}` };
    }

    if (runId !== null) {
      return { ok: false, message: `deflow answer: one run id, not two (${runId}, ${argument})` };
    }
    runId = argument;
  }

  if (runId === null) {
    return {
      ok: false,
      message:
        'deflow answer: which run? Usage: deflow answer <runId> --gate <node> --option <id>. ' +
        "'deflow status' lists the runs this machine is working on, and the gate each is waiting " +
        'on.',
    };
  }
  if (gate === null) {
    return {
      ok: false,
      message:
        'deflow answer: which gate? Pass --gate <node>. A run can be waiting on more than one, so ' +
        'there is no default — the block `deflow run` printed carries the exact line to type.',
    };
  }
  if (option === null) {
    return {
      ok: false,
      message:
        'deflow answer: which option? Pass --option <id>. The gate offers a closed set and names ' +
        'it in the announcement block; answering without naming one would be a decision nothing ' +
        'could act on.',
    };
  }

  if (gate === SPEC_GATE_NODE && !(SPEC_DECISIONS as readonly string[]).includes(option)) {
    // The F1.3 gate's four decisions are four **endpoints**, so an option
    // outside them is not a refusal the daemon can make — it is a route that
    // does not exist, and forwarding a `404` would tell the operator nothing.
    // The closed set is `SPEC_DECISIONS` in `@DeFlow/core`, which is the same
    // constant those routes and `SPEC_APPROVAL_OPTIONS` are built from, so this
    // is not a second vocabulary.
    return {
      ok: false,
      message:
        `deflow answer: the '${SPEC_GATE_NODE}' gate offers ` +
        `${SPEC_DECISIONS.map((one) => `'${one}'`).join(', ')}; '${option}' is not one of them.`,
    };
  }

  if (gate === SPEC_GATE_NODE && option === 'edit') {
    return { ok: false, message: EDIT_REFUSAL };
  }
  if (gate === SPEC_GATE_NODE && option === 'reject' && text === null) {
    return {
      ok: false,
      message:
        'deflow answer: a rejection carries a reason — pass --text "<why>". The next framing ' +
        'attempt is given it as an input, and a rejection with nothing to say sends the agent ' +
        'back to the same blank page that produced the spec you just refused.',
    };
  }

  return { ok: true, args: { runId, gate, option, text } };
}

export interface AnswerCommandOptions {
  /** Everything after `answer`. */
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly style?: Style;
  /** Injected so a spec can assert that a refused argv never reaches a socket. */
  readonly findDaemon?: (dataDir: string) => Promise<DaemonEndpoint | null>;
  readonly fetch?: typeof globalThis.fetch;
}

const refuse = (exitCode: number, message: string): CommandResult => ({
  exitCode,
  stdout: '',
  stderr: `${message}\n`,
});

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/** The daemon's sentence, or a description of a body that was not one. */
async function refusalOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const code = body?.error?.code ?? 'unknown';
  const message = body?.error?.message ?? `the daemon answered ${String(response.status)}`;
  return `${code}: ${message}`;
}

/**
 * Which route answers this gate, and with what body.
 *
 * The F1.3 gate's four decisions are four endpoints rather than one `respond`
 * with an option id, because that is what KAR-10.3 built and what the daemon's
 * transactions are written against — approving pins the spec, rejecting mints a
 * reframing attempt, abandoning ends the run. Routing them through `respond`
 * would need a second implementation of all three.
 *
 * That choice used to be made here, privately, when this was the only surface
 * that had to make it. KAR-22.5 added a second — the browser's gate panel — so
 * it moved to `gateAnswerRequest` in `@DeFlow/core`, beside the `SPEC_DECISIONS`
 * vocabulary it branches on. `null` is unreachable from here: `parseAnswerArgs`
 * has already refused the one pair that has no route.
 */
function route(args: AnswerArgs): { path: string; body: unknown } {
  const request = gateAnswerRequest({
    runId: args.runId,
    gate: args.gate,
    optionId: args.option,
    text: args.text,
  });
  if (request === null) throw new Error(EDIT_REFUSAL);
  return request;
}

/** What the command prints when the daemon accepted the answer (AC4). */
export function toAnswerReport(args: AnswerArgs): Report {
  return {
    title: `deflow answer: ${args.runId}`,
    sections: [
      {
        title: 'Answer',
        rows: [
          { id: 'gate', state: 'ok', detail: args.gate },
          { id: 'option', state: 'ok', detail: args.option },
          ...(args.text === null ? [] : [{ id: 'text', state: 'ok' as const, detail: args.text }]),
        ],
      },
    ],
  };
}

/**
 * `deflow answer` — the whole command, minus the process it runs in.
 *
 * An unknown option, a gate that is not open and a gate that was already
 * answered are all the daemon's refusals, forwarded verbatim: `planHumanResponse`
 * owns that vocabulary and this command is a client of it.
 */
export async function runAnswer(options: AnswerCommandOptions): Promise<CommandResult> {
  const parsed = parseAnswerArgs(options.argv);
  if (!parsed.ok) return refuse(EX_USAGE, parsed.message);

  const env = options.env ?? process.env;
  const look = options.findDaemon ?? findDaemon;
  const endpoint = await look(resolveDataDir(env));
  if (endpoint === null) {
    return refuse(
      RUN_EXIT_CODES.daemonRefused,
      'deflow answer: no daemon is running on this machine, so nothing is holding that gate open ' +
        "— 'deflow status' says what this machine thinks is happening",
    );
  }

  const { path, body } = route(parsed.args);
  const send = options.fetch ?? globalThis.fetch;
  const response = await send(`${endpoint.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
      'X-DeFlow-Submitted-By': 'cli',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return refuse(RUN_EXIT_CODES.failed, `deflow answer: ${await refusalOf(response)}`);
  }

  return {
    exitCode: 0,
    stdout: renderReport(toAnswerReport(parsed.args), options.style ?? plainStyle()),
    stderr: '',
  };
}
