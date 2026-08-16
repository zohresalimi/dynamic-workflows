/**
 * KAR-21.3 AC2 — the CLI's half of the one answer path: the transport, and
 * nothing else.
 *
 * `gateAnswerRequest` (`@DeFlow/core`) decides *which* endpoint answers a gate
 * and *what body* it takes, and its own module note says the transport is
 * deliberately **not** in it: `deflow answer` reads a token file and `fetch`es,
 * the browser goes through the typed client, and neither of those is a domain
 * fact. This is that transport for the two surfaces that live in this package —
 * `deflow answer` and the live session under `deflow run` — so the bearer
 * token, the `X-DeFlow-Submitted-By` header and the way a refusal is read off
 * the envelope are written once rather than twice.
 *
 * It lives here rather than under `run/session/` for a structural reason, and
 * `test/session-answer-guard.test.ts` is what keeps it true: **no route string
 * and no request body may exist under `run/session/`**. A session module that
 * held its own `fetch` would be one refactor away from holding its own path,
 * and that is the fourth implementation KAR-22.5 exists to prevent.
 *
 * The refusal is forwarded, never paraphrased. `planHumanResponse` owns that
 * vocabulary and it is several sentences of specific advice; a local rewording
 * throws the advice away while looking tidier (docs/11 §11).
 *
 * Verifies: EPIC-21-S18, EPIC-21-S23 · KAR-21.3 AC2, AC5
 */
import type { GateAnswerRequest } from '@DeFlow/core';
import type { DaemonEndpoint } from './daemon.ts';

/**
 * Why a rejection with nothing to say is refused before a socket is opened.
 *
 * One sentence, two surfaces: `deflow answer` prints it when `--text` is
 * missing and the session prints it when the inline row is still empty. The
 * rule is the same one in both places — the next framing attempt is *given* the
 * rejection as an input — so stating it twice would be one limitation an
 * operator has to discover twice (R4).
 */
export const REJECTION_NEEDS_A_REASON =
  'The next framing attempt is given it as an input, and a rejection with nothing to say sends ' +
  'the agent back to the same blank page that produced the spec you just refused.';

/** Who answered. The header exists so this and the browser can differ. */
export const SUBMITTED_BY_CLI = 'cli';

/** What a surface knows once the daemon has answered, and nothing more. */
export interface GateAnswerOutcome {
  readonly ok: boolean;
  readonly status: number;
  /** The daemon's own code (`already_answered`, …), or `null` when it accepted. */
  readonly code: string | null;
  /** The daemon's own sentence, verbatim, or `null` when it accepted. */
  readonly message: string | null;
}

/** The seam a session is handed: a request in, an outcome out, no transport. */
export type GateAnswerSender = (request: GateAnswerRequest) => Promise<GateAnswerOutcome>;

interface ErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/** The daemon's sentence, or a description of a body that was not one. */
async function refusalOf(response: Response): Promise<{ code: string | null; message: string }> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const code = body?.error?.code;
  const message = body?.error?.message;
  return {
    code: typeof code === 'string' && code !== '' ? code : null,
    message:
      typeof message === 'string' && message !== ''
        ? message
        : `the daemon answered ${String(response.status)}`,
  };
}

/**
 * A sender bound to the daemon this process already reached.
 *
 * The endpoint is the one the caller is *already* connected to — the port
 * `deflow up` bound rather than 7777 — and the token is the one it already
 * holds, so nothing here reads a file or guesses a port.
 */
export function createGateAnswerSender(
  endpoint: Pick<DaemonEndpoint, 'baseUrl' | 'token'>,
  send: typeof globalThis.fetch = globalThis.fetch,
): GateAnswerSender {
  return async (request) => {
    const response = await send(`${endpoint.baseUrl}${request.path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
        'X-DeFlow-Submitted-By': SUBMITTED_BY_CLI,
      },
      body: JSON.stringify(request.body),
    });

    if (response.ok) {
      return { ok: true, status: response.status, code: null, message: null };
    }
    const refusal = await refusalOf(response);
    return { ok: false, status: response.status, code: refusal.code, message: refusal.message };
  };
}
