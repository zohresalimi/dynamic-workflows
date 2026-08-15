/**
 * KAR-22.5 AC2 — the tab's half of the one answer path.
 *
 * `gateAnswerRequest` (`@DeFlow/core`) decides *which* endpoint answers a gate
 * and *what body* it takes; this decides nothing. What it adds is the two
 * things that are this caller's and not the domain's: the **typed client**,
 * because `hc<ApiType>`'s routes are properties rather than strings and a page
 * that assembled a URL by hand would be the one place in this application that
 * did not typecheck against the daemon's own route table; and the
 * `X-DeFlow-Submitted-By` header, which says `ui` here and `cli` in
 * `deflow answer` — the whole point of it being a header is that the two
 * disagree.
 *
 * The switch below is mechanical and is covered by an assertion rather than by
 * care: `../views/run-gate-answer.test.ts` drives a real client over an
 * injected `fetch` and compares the pathname that actually left with
 * `gateAnswerRequest`'s `path`, so a wrong accessor here is a red test and not
 * a subtle 404.
 *
 * Verifies: EPIC-22-S58, EPIC-22-S65, EPIC-22-S67 · AC2, AC6
 */
import type { GateAnswer } from '@DeFlow/core';
import { gateAnswerRequest } from '@DeFlow/core';
import type { ApiClient } from './client.ts';

/** What the panel needs to know afterwards, and nothing more. */
export interface GateAnswerOutcome {
  readonly ok: boolean;
  readonly status: number;
  /** The daemon's own code (`already_answered`, …), or `null` when it accepted. */
  readonly code: string | null;
  /** The daemon's own sentence, verbatim, or `null` when it accepted. */
  readonly message: string | null;
}

/** The shape every route in this module answers with, named once. */
interface HttpAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/** The routes this module reaches, off the daemon's own chained expression. */
interface AnswerApi {
  readonly runs: {
    readonly ':id': {
      readonly spec: Record<
        'approve' | 'reject' | 'abandon',
        { readonly $post: (args: Args, init: Init) => Promise<HttpAnswer> }
      >;
      readonly nodes: {
        readonly ':nodeId': {
          readonly respond: {
            readonly $post: (args: NodeArgs, init: Init) => Promise<HttpAnswer>;
          };
        };
      };
    };
  };
}

interface Args {
  readonly param: { readonly id: string };
  readonly json: unknown;
}
interface NodeArgs {
  readonly param: { readonly id: string; readonly nodeId: string };
  readonly json: unknown;
}
interface Init {
  readonly headers: Record<string, string>;
}

/** Who answered. The header exists so this and `deflow answer` can differ. */
const SUBMITTED_BY: Init = { headers: { 'X-DeFlow-Submitted-By': 'ui' } };

/**
 * The daemon's refusal, verbatim — never a paraphrase (R4).
 *
 * A response with no envelope at all still has to say *something*, and what it
 * says names the status rather than guessing at a cause.
 */
async function refusalOf(response: HttpAnswer): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const message = body.error?.message;
    return {
      code: typeof body.error?.code === 'string' ? body.error.code : null,
      message:
        typeof message === 'string' && message !== ''
          ? message
          : `the daemon refused this answer with ${response.status} and said nothing about why`,
    };
  } catch {
    return { code: null, message: `the daemon refused this answer with ${response.status}` };
  }
}

/**
 * Sends `answer` to the endpoint `gateAnswerRequest` names.
 *
 * Throws for the one pair that has no endpoint — the F1.3 gate's `edit`. The
 * panel never reaches that, because it renders that option unsubmittable with
 * `SPEC_EDIT_NEEDS_A_DOCUMENT` beside it; a throw here is the assertion that it
 * stays that way rather than a path an operator can walk into.
 */
export async function answerGate(
  client: ApiClient,
  answer: GateAnswer,
): Promise<GateAnswerOutcome> {
  const request = gateAnswerRequest(answer);
  if (request === null) {
    throw new Error(`no endpoint answers '${answer.gate}' with '${answer.optionId}'`);
  }

  const api = client as never as AnswerApi;
  const run = api.runs[':id'];
  const response =
    request.target.kind === 'spec-decision'
      ? await run.spec[request.target.decision].$post(
          { param: { id: answer.runId }, json: request.body },
          SUBMITTED_BY,
        )
      : await run.nodes[':nodeId'].respond.$post(
          {
            param: { id: answer.runId, nodeId: String(request.target.node) },
            json: request.body,
          },
          SUBMITTED_BY,
        );

  if (response.ok) return { ok: true, status: response.status, code: null, message: null };

  const refusal = await refusalOf(response);
  return { ok: false, status: response.status, code: refusal.code, message: refusal.message };
}
