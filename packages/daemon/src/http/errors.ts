/**
 * The closed error envelope (docs/11-api-and-realtime.md §10).
 *
 * Domain failures are **values, not exceptions** — the same rule the engine
 * uses internally — and the wire shape is one object with four fields and an
 * optional fifth:
 *
 * ```jsonc
 * { "error": { "code": "run_not_found", "message": "…", "detail": {}, "retryable": false, "seq": 10904 } }
 * ```
 *
 * `code` is a stable identifier clients may branch on and is a member of the
 * union below and of nothing else; `message` is for humans and may change
 * freely; `detail` is typed per code; `seq` is present when the failure *also*
 * produced a ledger event, so a UI can link "this failed" to "here is the event
 * that says so". That last one is NF10 applied to the error path, which is
 * exactly where auditability usually stops.
 *
 * ## The union is closed, and this table is what closes it
 *
 * §10 documents twenty-three (status, code) pairs. All twenty-three are here,
 * with the statuses it gives them, and `errors.test.ts` transcribes that table
 * by hand and checks every pair — a test that derived the pairs from this file
 * would agree with any mapping.
 *
 * The union also carries the codes the already-mounted routes and in-process
 * services answer with, which §10's table did not name (`not_found`,
 * `already_answered`, `use_respond`, `apply_unavailable`, …). They are listed
 * here rather than squeezed into a documented neighbour on purpose: forcing
 * "this node is no longer running" into `run_not_pausable` would make the wire
 * *less* informative, and a client branching on `code` would have to unpick the
 * detail to find out what actually happened. The union stays closed — one
 * enumerated list, one status per code — and §10's table is documented as its
 * subset.
 *
 * There is deliberately **no** `code` for "something we did not anticipate"
 * other than `internal`. See `../http/api.ts`'s `onError`: a thrown `Error`
 * becomes `500 internal` and the stack goes to an artifact, never to a client.
 */

/** One status per code, so a client may key on either and get the same answer. */
export const API_ERROR_STATUS = {
  // 400 — the request itself is wrong.
  invalid_request: 400,
  schema_violation: 400,
  unknown_provider: 400,

  // 401 — KAR-15.2 owns the middleware; the codes are part of this contract.
  missing_token: 401,
  bad_token: 401,

  // 403
  bad_origin: 403,
  permission_refused: 403,
  path_scope_violation: 403,

  // 404 — `not_found` is the general one: a path this API does not serve, or a
  // sub-resource with no more specific code. Everything that *has* a specific
  // code uses it, because "which thing was missing" is the question a 404 has
  // to answer (EPIC-15-S44).
  not_found: 404,
  run_not_found: 404,
  node_not_found: 404,
  artifact_not_found: 404,
  plan_version_not_found: 404,
  patch_not_found: 404,

  // 409 — well formed, and in conflict with what the ledger already records.
  stale_cursor: 409,
  run_not_pausable: 409,
  patch_already_decided: 409,
  epoch_mismatch: 409,
  already_answered: 409,
  node_not_running: 409,
  use_respond: 409,

  // 413
  payload_too_large: 413,

  // 422 — understood, and not actionable as asked.
  //
  // KAR-19.2's two admission refusals are 422 and not 503: `provider_unavailable`
  // (503) says *"try again shortly"*, and this machine will not grow an ACP
  // adapter on its own. A retryable status here would train a client — and
  // `deflow run`'s own watcher — to sit in a loop waiting for an install that
  // only a human can perform, which is the silence this story exists to end.
  no_usable_provider: 422,
  provider_handshake_failed: 422,
  spec_not_approved: 422,
  capability_unsupported: 422,
  unknown_option: 422,
  missing_payload: 422,
  empty_text: 422,
  not_applicable: 422,
  apply_unavailable: 422,

  // 429
  provider_rate_limited: 429,

  // 500 — and nothing else ever reaches a client with a 500.
  internal: 500,

  // 503
  daemon_starting: 503,
  provider_unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export type ApiErrorStatus = (typeof API_ERROR_STATUS)[ApiErrorCode];

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly retryable: boolean;
    /** Present only when the failure also produced a ledger event. */
    readonly seq?: number;
  };
}

export interface ApiErrorOptions {
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
  /** The ledger event that records this failure, where there is one. */
  readonly seq?: number | undefined;
}

/** True for `code`, and for nothing that is not a member of the union. */
export function isApiErrorCode(code: string): code is ApiErrorCode {
  return Object.hasOwn(API_ERROR_STATUS, code);
}

/**
 * Whether a client should try the identical request again.
 *
 * Derived from the status rather than listed per code, because the question is
 * "did this fail for a reason that may pass on its own" and that is precisely
 * what 429, 500 and 503 mean and what no 4xx below them does. A `stale_cursor`
 * is *not* retryable: the client has to re-read before it can decide again,
 * and marking it retryable would train a UI to retry blindly.
 */
function retryable(status: ApiErrorStatus): boolean {
  return status === 429 || status === 500 || status === 503;
}

/**
 * The envelope and the status it is served with, as the pair `c.json` takes.
 *
 * Returned as a tuple so a route reads `return c.json(...apiError('run_not_found', '…'))`
 * — which keeps the route's return type inferrable, and therefore keeps the
 * failure shape inside `hc<ApiType>` where the UI can branch on it. A helper
 * that returned a `Response` would type-erase every error path in the API.
 */
export function apiError<C extends ApiErrorCode>(
  code: C,
  message: string,
  options: ApiErrorOptions = {},
): [ApiErrorEnvelope, (typeof API_ERROR_STATUS)[C]] {
  const status = API_ERROR_STATUS[code];
  return [
    {
      error: {
        code,
        message,
        detail: options.detail ?? {},
        retryable: retryable(status),
        // `exactOptionalPropertyTypes` is on: an absent seq is an absent key,
        // never a present key holding undefined. A client checking `'seq' in
        // error` has to be able to trust it.
        ...(options.seq === undefined ? {} : { seq: options.seq }),
      },
    },
    status,
  ];
}

/**
 * The refusal codes the in-process services answer with
 * (`../human/gate.ts`, `../human/interject.ts`, `../human/patch-decision.ts`),
 * and the spec gate's own.
 *
 * Kept as its own type rather than imported from the three modules, because
 * this is the list the HTTP edge promises to have an answer for: adding a
 * refusal to a service without deciding what it looks like on the wire should
 * be a compile error at the call site, not a code nobody documented leaking
 * through a passthrough.
 */
export type ServiceRefusalCode =
  | 'already_answered'
  | 'gate_not_open'
  | 'unknown_option'
  | 'missing_payload'
  | 'schema_violation'
  | 'node_not_found'
  | 'node_not_running'
  | 'use_respond'
  | 'empty_text'
  | 'stale_cursor'
  | 'patch_already_decided'
  | 'patch_not_found'
  | 'not_applicable'
  | 'apply_unavailable';

/**
 * Every service refusal, and the wire code that answers for it.
 *
 * Exhaustive by type rather than a partial map with a fallthrough: adding a
 * refusal to a service is then a compile error here until somebody decides what
 * a client sees, which is the only way a code nobody documented cannot reach
 * the wire through a passthrough.
 *
 * Most map to themselves. The one that does not is a genuine collision rather
 * than an oversight: `gate_not_open` names two different failures — a human
 * gate that is not open on a node (404), and a spec gate that has already been
 * decided (409, answered as `already_answered` at its own call site in
 * `./api.ts`) — so it cannot be one wire code. It maps to the code describing
 * the resource the caller actually addressed, and the service's own word
 * survives in `detail.reason`, so a log or a bug report still says which it was.
 */
const SERVICE_WIRE_CODE: Readonly<Record<ServiceRefusalCode, ApiErrorCode>> = {
  already_answered: 'already_answered',
  gate_not_open: 'node_not_found',
  unknown_option: 'unknown_option',
  missing_payload: 'missing_payload',
  schema_violation: 'schema_violation',
  node_not_found: 'node_not_found',
  node_not_running: 'node_not_running',
  use_respond: 'use_respond',
  empty_text: 'empty_text',
  stale_cursor: 'stale_cursor',
  patch_already_decided: 'patch_already_decided',
  patch_not_found: 'patch_not_found',
  not_applicable: 'not_applicable',
  apply_unavailable: 'apply_unavailable',
};

/**
 * A service refusal as an envelope, mapped onto the closed union.
 *
 * The status comes from the union rather than from the service's own `http`
 * field, so there is exactly one place that decides what a code answers with.
 * The two currently disagree in one place — the human gate reports a payload
 * failing its option schema as 422 and §10 documents `schema_violation` as 400
 * — and §10 wins, because "a request body failing schema validation → 400
 * schema_violation" is the example EPIC-15-S4's outline names by hand.
 */
export function serviceError(
  code: ServiceRefusalCode,
  message: string,
  options: ApiErrorOptions = {},
): [ApiErrorEnvelope, ApiErrorStatus] {
  const wire = SERVICE_WIRE_CODE[code];
  if (wire === code) return apiError(wire, message, options);

  // The word the service used, kept where a human can still read it.
  return apiError(wire, message, {
    ...options,
    detail: { ...options.detail, reason: code },
  });
}
