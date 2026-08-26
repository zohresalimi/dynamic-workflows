/**
 * KAR-27.7 AC1, AC2 — the tab's half of pause, resume and stop.
 *
 * The sibling of `./answer-gate.ts`, built to the same three rules and for the
 * same reasons: the **typed client**, because `hc<ApiType>`'s routes are
 * properties rather than strings and a surface that assembled `/api/runs/${id}/
 * pause` by hand would be the one place in this application that did not
 * typecheck against the daemon's own route table; the daemon's **refusal
 * verbatim**, because a paraphrase of a 409 is a second wording of a rule the
 * daemon owns (R4); and no decision of its own — which control is offered and
 * whether it is enabled is `../lib/run-controls.ts`'s answer, and what happens
 * on screen afterwards is the ledger's.
 *
 * `mode` is on the wire for `stop` and only for `stop`. The endpoint defaults
 * to `cooperative` when a body omits it, and the whole reason this surface
 * exists is that the default would appear to do nothing until KAR-27.9 wires
 * the cooperative rung — so the mode is stated, from
 * `RUN_CONTROL_STOP_MODE`, and never inferred here.
 *
 * Verifies: EPIC-27-S35, EPIC-27-S36 · AC1, AC2
 */

import {
  RUN_CONTROL_STOP_MODE,
  RUN_CONTROL_VERB,
  type RunControlAction,
} from '../lib/run-controls.ts';
import type { ApiClient } from './client.ts';

/** What the surface needs to know afterwards, and nothing more. */
export interface RunControlOutcome {
  readonly ok: boolean;
  readonly status: number;
  /** The daemon's own code (`run_not_pausable`, …), or `null` when it accepted. */
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

interface Args {
  readonly param: { readonly id: string };
  readonly json: unknown;
}

/** The three routes this module reaches, off the daemon's own chained expression. */
interface ControlApi {
  readonly runs: {
    readonly ':id': Record<
      'pause' | 'resume' | 'cancel',
      { readonly $post: (args: Args) => Promise<HttpAnswer> }
    >;
  };
}

/**
 * The daemon's refusal, verbatim — never a paraphrase (R4).
 *
 * A response with no envelope at all still has to say *something*, and what it
 * says names the status rather than guessing at a cause: a control that failed
 * silently is the failure this whole story is about.
 */
async function refusalOf(response: HttpAnswer): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const message = body.error?.message;
    return {
      code: typeof body.error?.code === 'string' ? body.error.code : null,
      message:
        typeof message === 'string' && message !== ''
          ? message
          : `the daemon refused this with ${response.status} and said nothing about why`,
    };
  } catch {
    return { code: null, message: `the daemon refused this with ${response.status}` };
  }
}

/** Sends one control request, and reports what the daemon said about it. */
export async function sendRunControl(
  client: ApiClient,
  runId: string,
  action: RunControlAction,
): Promise<RunControlOutcome> {
  const run = (client as never as ControlApi).runs[':id'];
  const response = await run[RUN_CONTROL_VERB[action]].$post({
    param: { id: runId },
    // An empty object rather than no body: the route parses the body and
    // tolerates none, but `pause` and `resume` take no fields and stating that
    // is clearer than relying on `catch(() => null)` two packages away.
    json: action === 'stop' ? { mode: RUN_CONTROL_STOP_MODE } : {},
  });

  if (response.ok) return { ok: true, status: response.status, code: null, message: null };

  const refusal = await refusalOf(response);
  return { ok: false, status: response.status, code: refusal.code, message: refusal.message };
}
