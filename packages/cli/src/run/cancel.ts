/**
 * The second Ctrl-C (KAR-18.3 AC3) — "stop this run", whichever way the daemon
 * spells it for the state the run is in.
 *
 * `POST /runs/:id/cancel` is the F5.7 route and the forceful ladder goes
 * straight to the process group, which is what AC3 asks for. But KAR-15.5 AC6
 * is explicit that *"a run whose spec is not approved cannot be controlled at
 * all"* — the control verbs are a state machine over an approved spec — and a
 * run parked at the F1.3 gate is exactly where a person is most likely to press
 * Ctrl-C twice. Refusing them with `spec_not_approved` and leaving the run
 * standing would be answering a question nobody asked.
 *
 * So there are two routes and one meaning: cancel, and if the daemon says the
 * spec was never approved, abandon. Both are the daemon's own transaction, both
 * append a terminal event to the ledger, and neither is a second
 * implementation of anything — the CLI picks which sentence to speak, not what
 * it means.
 */
import type { RunId } from '@DeFlow/core';
import { createClient } from '@DeFlow/web';

export interface CancelTarget {
  readonly baseUrl: string;
  readonly token: string;
}

export interface CancelOutcome {
  /** Which route answered — for the operator, and for a spec to assert on. */
  readonly via: 'cancel' | 'abandon';
  readonly message: string;
}

function clientFor(target: CancelTarget): ReturnType<typeof createClient> {
  return createClient({
    baseUrl: `${target.baseUrl.replace(/\/$/, '')}/api`,
    token: () => target.token,
  });
}

/** The envelope's `code`, or `null` for a body that is not one. */
function errorCode(body: unknown): string | null {
  const error: unknown = (body as { error?: unknown } | null)?.error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Stops `runId`, forcefully.
 *
 * `mode: 'forceful'` rather than the route's `cooperative` default, because the
 * operator pressing Ctrl-C twice inside three seconds is not asking the agent
 * to finish its thought — that is what the first press already offered them.
 */
export async function cancelRun(runId: RunId, target: CancelTarget): Promise<CancelOutcome> {
  const client = clientFor(target);

  // The body goes through `init` rather than `json`, because the route reads it
  // with `c.req.json()` rather than through a validator — so `hc<ApiType>`
  // infers no JSON input for it and there is no typed slot to put it in. The
  // shape is still the route's own `ControlRequestBody`; what is missing is a
  // validator on the server, not a second protocol here.
  const cancelled = await client.runs[':id'].cancel.$post(
    { param: { id: runId } },
    {
      headers: { 'X-DeFlow-Submitted-By': 'cli', 'content-type': 'application/json' },
      init: { body: JSON.stringify({ mode: 'forceful' }) },
    },
  );
  if (cancelled.ok) {
    return { via: 'cancel', message: `cancelling run ${runId} — the kill switch is running` };
  }

  const body: unknown = await cancelled.json();
  if (errorCode(body) !== 'spec_not_approved') {
    return {
      via: 'cancel',
      message: `could not cancel run ${runId}: ${cancelled.status} ${errorCode(body) ?? 'unknown'}`,
    };
  }

  // Nothing has been scheduled yet, so there is no process group to kill; what
  // ends the run is `run.aborted`, which is what abandon appends.
  const abandoned = await client.runs[':id'].spec.abandon.$post(
    { param: { id: runId } },
    { headers: { 'X-DeFlow-Submitted-By': 'cli' } },
  );
  return abandoned.ok
    ? { via: 'abandon', message: `abandoned run ${runId} before its spec was approved` }
    : { via: 'abandon', message: `could not stop run ${runId}: ${abandoned.status}` };
}
