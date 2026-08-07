/**
 * KAR-09.7 Tier 3 — exact token counting, and the reason it is unreachable
 * (docs/08-context-and-memory.md §7, docs/15-security-model.md AR-1).
 *
 * Anthropic's `POST /v1/messages/count_tokens` is exact and free of charge, and
 * it requires a credential. Under AR-1 that credential may only ever be one the
 * operator supplied themselves, through the F3.3 direct-API adapter. So the
 * design is a refusal expressed in the signature: the credential is a
 * **parameter**, this module reads no environment variable, opens no file, and
 * imports nothing that could. There is no code path in DeFlowd that reads a
 * token file or sets an auth env var to make this call work, and
 * `test/tier3-api-key-only.test.ts` asserts that by inspection (NF2) rather
 * than by convention.
 *
 * The transport is a parameter too, for the same reason: a module that reached
 * for `fetch` itself would be one import away from being callable, and
 * `packages/adapters/test/integration/no-outbound-http.test.ts` proves the
 * subscription path makes no outbound request at all by watching the real
 * process rather than by trusting this comment.
 *
 * **Note, 2026-08-06:** F3.3 moved to M2. Nothing in a shipped configuration
 * constructs a `DirectApiCredential`, so at M1 this call site is dead code with
 * live specs — deliberately. The negative assertions are what the three-tier
 * design is *for*; the positive path has never run against the real endpoint
 * and stays unverified until the M2 adapter lands. A green suite here does not
 * mean tier 3 works.
 *
 * Verifies: EPIC-09-S40 · KAR-09.7 AC8
 */
import type { ProviderAuthMode, TokenCount } from '@DeFlow/core';

/** The endpoint, named once in the whole daemon. */
export const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

/**
 * A credential the operator handed over, and the auth mode it was handed over
 * under.
 *
 * `authMode` travels with the key rather than being asked of some ambient
 * config, so the refusal below is a check on the value in hand: a caller
 * holding a subscription-mode credential cannot spend it here by forgetting to
 * consult something.
 */
export interface DirectApiCredential {
  readonly apiKey: string;
  /** The API origin, without a trailing slash. Supplied, never defaulted — a
   * default origin is a destination nobody chose. */
  readonly baseUrl: string;
  readonly authMode: ProviderAuthMode;
}

export interface ExactCountRequest {
  readonly model: string;
  readonly prompt: string;
}

/** The one HTTP shape this module needs, injected. Returns the parsed JSON
 * body; throwing is the caller's transport failing, and it propagates. */
export type ExactCountTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<unknown>;

export class ExactCountUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExactCountUnavailable';
  }
}

/**
 * Counts `request.prompt` exactly, against a credential the caller supplied.
 *
 * Labelled `'vendor-reported'` rather than `'gpt-tokenizer/o200k_base'`: the
 * figure came from the vendor's own tokenizer, and it is comparable to the
 * result envelope's counts and *not* to a Tier-2 estimate. §7's rule is that
 * the tiers are never silently mixed, and the label is how that survives past
 * this function.
 */
export async function countTokensExact(
  credential: DirectApiCredential,
  request: ExactCountRequest,
  transport: ExactCountTransport,
): Promise<TokenCount> {
  if (credential.authMode !== 'api_key') {
    throw new ExactCountUnavailable(
      'exact token counting is available only on the direct-API adapter, under a key the ' +
        `operator supplied; this credential is in ${credential.authMode} mode. On the ` +
        'subscription path DeFlow never authenticates to a vendor API (AR-1).',
    );
  }
  if (credential.apiKey.trim() === '') {
    throw new ExactCountUnavailable(
      'the direct-API credential carries no key. DeFlow does not look one up: a key it found ' +
        'rather than one the operator handed over is exactly what AR-1 forbids.',
    );
  }

  const body = await transport(`${credential.baseUrl}${COUNT_TOKENS_PATH}`, {
    method: 'POST',
    headers: {
      'x-api-key': credential.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model,
      messages: [{ role: 'user', content: request.prompt }],
    }),
  });

  const count =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).input_tokens
      : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new ExactCountUnavailable(
      'the exact count endpoint answered without an integer input_tokens. A figure DeFlow ' +
        'cannot read is not a figure to fall back from silently — the caller decides whether ' +
        'to estimate instead.',
    );
  }

  return { estimated: count, method: 'vendor-reported' };
}
