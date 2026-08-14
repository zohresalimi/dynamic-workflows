/**
 * The second Ctrl-C (KAR-18.3 AC3) — "stop this run", through the one route
 * that answers for every state a run can be in.
 *
 * > **Amended 2026-08-12 by KAR-19.6.** This file used to notice a
 * > `422 spec_not_approved` and fall back to `POST /runs/:id/spec/abandon`,
 * > because KAR-15.5 AC6 refused every control verb on a run whose spec was not
 * > approved and a person is most likely to press Ctrl-C twice at exactly that
 * > point. The fallback proved the point rather than solving it: `abandonRun`
 * > opens with `if (!gateIsOpen(events)) throw`, so it could not help a run that
 * > was accepted and never framed — the state all three runs of 2026-08-12 were
 * > in — and it put the daemon's state machine in the CLI, where the web UI and
 * > any future client cannot reach it. `planRunControl` now plans a termination
 * > for those two statuses, so there is one request here and no branch.
 *
 * `mode: 'forceful'` rather than the route's `cooperative` default, because the
 * operator pressing Ctrl-C twice inside three seconds is not asking the agent
 * to finish its thought — that is what the first press already offered them.
 */
import type { RunId } from '@DeFlow/core';
import { createClient } from '@DeFlow/web';

export interface CancelTarget {
  readonly baseUrl: string;
  readonly token: string;
}

export interface CancelOutcome {
  /** Which route answered — for the operator, and for a spec to assert on. */
  readonly via: 'cancel';
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

/** Stops `runId`, forcefully. */
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
  return {
    via: 'cancel',
    message: `could not cancel run ${runId}: ${cancelled.status} ${errorCode(body) ?? 'unknown'}`,
  };
}
