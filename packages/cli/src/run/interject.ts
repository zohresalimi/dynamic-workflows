/**
 * KAR-21.4 AC2, AC3 — the CLI's half of `POST /api/runs/:id/interject`: the
 * transport, and nothing else.
 *
 * It lives here rather than under `run/session/` for the structural reason
 * `./gate-answer.ts` gives and `../../test/session-answer-guard.test.ts`
 * enforces: **no route and no request body may exist under `run/session/`**. A
 * session module that held its own `fetch` would be one refactor away from
 * holding its own route, and the session is the surface where that is least
 * likely to be noticed.
 *
 * Three decisions are the daemon's and are carried through untouched.
 *
 * **`unsupported` is an outcome, not an error.** It arrives on a `202` with the
 * daemon's own sentence and an `alternative` mode that does work, so `ok` here
 * is *"the daemon accepted the request"* and `delivery` is what it did with it.
 * A client that folded `unsupported` into a failure would be re-deciding the one
 * thing KAR-13.3 wrote a whole vocabulary to avoid re-deciding.
 *
 * **The alternative is read, never spelled.** `InterjectionRequest.mode` is a
 * `string` rather than the `InterjectionMode` union precisely so a re-send can
 * carry back the word the daemon named. A second copy of the daemon's mode
 * vocabulary drifts from it, and the drift shows up as guidance that is
 * silently never delivered.
 *
 * **The refusal is forwarded, never paraphrased.** `planInterjection`'s five
 * messages are specific advice — `use_respond` in particular names the gate
 * answer that does work — and a local rewording throws the advice away while
 * looking tidier (docs/11 §11).
 *
 * The route itself is not spelled either: the typed client is `@DeFlow/web`'s,
 * the same one `./cancel.ts` calls, so the daemon's route table is what says
 * where an interjection goes.
 *
 * Verifies: EPIC-21-S28, EPIC-21-S29, EPIC-21-S30, EPIC-21-S33 · AC2, AC3, AC5
 */
import type { InterjectionMode, RunId } from '@DeFlow/core';
import { INTERJECTION_MODES } from '@DeFlow/core';
import { createClient } from '@DeFlow/web';
import type { DaemonEndpoint } from './daemon.ts';

/**
 * The mode a session asks for first.
 *
 * `next-turn` is *"hand this to the agent at its next turn boundary"* — the
 * steering an operator watching a node go wrong is reaching for. Whether the
 * adapter under that node can do it is the daemon's question, answered off the
 * probed capability row; when it cannot, the `202` names `pause-and-inject` as
 * the alternative and one keypress re-sends with it. Typed as
 * `InterjectionMode`, so this stays a choice among the daemon's own words
 * rather than a string.
 */
export const SESSION_INTERJECTION_MODE: InterjectionMode = 'next-turn';

/** Who interjected. The header exists so this and the browser can differ. */
export const SUBMITTED_BY_CLI = 'cli';

export interface InterjectionRequest {
  readonly runId: RunId;
  /** The node the projection says is running — never typed by the operator. */
  readonly node: string;
  readonly text: string;
  readonly mode: string;
  /**
   * KAR-13.3 AC6's stale-cursor guard: the seq this session last rendered.
   *
   * Sent rather than omitted because a frame is by construction a moment behind
   * the ledger, and this is how the session gets told it was looking at a node
   * that has since finished.
   */
  readonly ifLastSeq: number;
}

/** What a surface knows once the daemon has answered, and nothing more. */
export type InterjectionOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      /** The daemon's own answer: recorded and queued, or recorded and not
       * deliverable to this adapter's live session. */
      readonly delivery: 'queued' | 'unsupported';
      /** The daemon's sentence about an `unsupported` delivery, or `null`. */
      readonly message: string | null;
      /** The mode it named as the one that works, or `null`. */
      readonly alternative: string | null;
    }
  | {
      readonly ok: false;
      readonly status: number;
      /** `node_not_found`, `node_not_running`, `use_respond`, `empty_text`,
       * `stale_cursor` — the daemon's, or `null` for a body that is not one. */
      readonly code: string | null;
      /** The daemon's own sentence, verbatim. */
      readonly message: string;
    };

/** The seam a session is handed: a request in, an outcome out, no transport. */
export type InterjectionSender = (request: InterjectionRequest) => Promise<InterjectionOutcome>;

/** Whether the daemon named a mode this client can send back. Checked against
 * the core vocabulary rather than trusted, because it arrives over a socket. */
function knownMode(value: unknown): string | null {
  return typeof value === 'string' && (INTERJECTION_MODES as readonly string[]).includes(value)
    ? value
    : null;
}

interface AcceptedBody {
  readonly delivery?: unknown;
  readonly message?: unknown;
  readonly alternative?: unknown;
}

interface ErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/** The daemon's sentence, or a description of a body that was not one. */
function refusalOf(
  status: number,
  body: ErrorBody | null,
): { code: string | null; message: string } {
  const code = body?.error?.code;
  const message = body?.error?.message;
  return {
    code: typeof code === 'string' && code !== '' ? code : null,
    message:
      typeof message === 'string' && message !== ''
        ? message
        : `the daemon answered ${String(status)}`,
  };
}

function clientFor(
  endpoint: Pick<DaemonEndpoint, 'baseUrl' | 'token'>,
  send: typeof globalThis.fetch | undefined,
): ReturnType<typeof createClient> {
  return createClient({
    baseUrl: `${endpoint.baseUrl.replace(/\/$/, '')}/api`,
    token: () => endpoint.token,
    ...(send === undefined ? {} : { fetch: send }),
  });
}

/**
 * A sender bound to the daemon this session is already connected to.
 *
 * The endpoint is the one this process already reached — the port `deflow up`
 * bound rather than 7777 — and the token is the one it already holds, so
 * nothing here reads a file or guesses a port.
 *
 * The body goes through `init` rather than `json` for the reason `./cancel.ts`
 * gives: the route reads it with `c.req.json()` rather than through a
 * validator, so `hc<ApiType>` infers no JSON input for it and there is no typed
 * slot to put it in. The shape is still the route's own; what is missing is a
 * validator on the server, not a second protocol here.
 */
export function createInterjectionSender(
  endpoint: Pick<DaemonEndpoint, 'baseUrl' | 'token'>,
  send?: typeof globalThis.fetch,
): InterjectionSender {
  const client = clientFor(endpoint, send);

  return async (request) => {
    const response = await client.runs[':id'].interject.$post(
      { param: { id: request.runId } },
      {
        headers: { 'X-DeFlow-Submitted-By': SUBMITTED_BY_CLI, 'content-type': 'application/json' },
        init: {
          body: JSON.stringify({
            nodeId: request.node,
            text: request.text,
            mode: request.mode,
            ifLastSeq: request.ifLastSeq,
          }),
        },
      },
    );

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const refusal = refusalOf(response.status, body as ErrorBody | null);
      return { ok: false, status: response.status, code: refusal.code, message: refusal.message };
    }

    const accepted = body as AcceptedBody | null;
    // The delivery word is the daemon's; anything else is read as the
    // conservative one, because claiming `queued` for an answer this client did
    // not understand is the optimistic line AC6 forbids wearing another hat.
    const delivery = accepted?.delivery === 'queued' ? 'queued' : 'unsupported';
    const message = typeof accepted?.message === 'string' ? accepted.message : null;
    return {
      ok: true,
      status: response.status,
      delivery,
      message: message === '' ? null : message,
      alternative: knownMode(accepted?.alternative),
    };
  };
}
