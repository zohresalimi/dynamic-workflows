/**
 * KAR-15.1 test plan #4 — the closed error envelope, table-driven over every
 * documented status → code pair.
 *
 * Verifies: EPIC-15-S4 (the Scenario Outline, and the shape it asserts)
 *
 * Unit rather than integration because the envelope is a pure value: a route
 * that answers with one is answering with `c.json(...apiError(...))`, so what
 * is worth pinning here is the mapping and the shape, not the transport.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  apiError,
  isApiErrorCode,
  serviceError,
} from './errors.ts';

/**
 * docs/11-api-and-realtime.md §10's table, transcribed — the pairs KAR-15.1
 * AC4 enumerates by hand, in the order it enumerates them.
 *
 * Written out as data rather than derived from `API_ERROR_STATUS`, because a
 * test that read the mapping it is checking would agree with any mapping.
 */
const DOCUMENTED: readonly (readonly [number, ApiErrorCode])[] = [
  [400, 'invalid_request'],
  [400, 'schema_violation'],
  [400, 'unknown_provider'],
  [401, 'missing_token'],
  [401, 'bad_token'],
  [403, 'bad_origin'],
  [403, 'permission_refused'],
  [403, 'path_scope_violation'],
  [404, 'run_not_found'],
  [404, 'node_not_found'],
  [404, 'artifact_not_found'],
  [404, 'plan_version_not_found'],
  [409, 'stale_cursor'],
  [409, 'run_not_pausable'],
  [409, 'patch_already_decided'],
  [409, 'epoch_mismatch'],
  [413, 'payload_too_large'],
  [422, 'spec_not_approved'],
  [422, 'capability_unsupported'],
  [429, 'provider_rate_limited'],
  [500, 'internal'],
  [503, 'daemon_starting'],
  [503, 'provider_unavailable'],
];

suite('the documented status → code table', () => {
  it.each(DOCUMENTED)('answers %i for "%s", in the closed envelope', (status, code) => {
    const [body, answered] = apiError(code, 'a message for a human');

    expect(answered).toBe(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe('a message for a human');
    // Closed: a client may branch on `code`, and on nothing that is not here.
    expect(Object.keys(body.error).sort()).toEqual(['code', 'detail', 'message', 'retryable']);
    expect(typeof body.error.retryable).toBe('boolean');
  });

  it('accepts every documented code and nothing else', () => {
    for (const [, code] of DOCUMENTED) expect(isApiErrorCode(code)).toBe(true);
    expect(isApiErrorCode('not_a_code')).toBe(false);
    // The one that reads most like a code and is not: HTTP statuses are not it.
    expect(isApiErrorCode('404')).toBe(false);
  });

  it('gives every code exactly one status, so a client can key on either', () => {
    for (const code of Object.keys(API_ERROR_STATUS) as ApiErrorCode[]) {
      expect(typeof API_ERROR_STATUS[code]).toBe('number');
    }
    // Codes the routes emit that §10's table did not name are still in the
    // closed union, and still carry exactly one status.
    expect(API_ERROR_STATUS.not_found).toBe(404);
    expect(API_ERROR_STATUS.already_answered).toBe(409);
  });
});

suite('retryable', () => {
  it('is true exactly for the codes a client should try again', () => {
    for (const code of Object.keys(API_ERROR_STATUS) as ApiErrorCode[]) {
      const [body, status] = apiError(code, 'm');
      expect(body.error.retryable).toBe(status === 429 || status === 500 || status === 503);
    }
  });
});

suite('detail and seq', () => {
  it('carries the typed detail it was given', () => {
    const [body] = apiError('invalid_request', 'm', { detail: { field: 'cwd' } });
    expect(body.error.detail).toEqual({ field: 'cwd' });
  });

  it('defaults detail to an empty object rather than to undefined', () => {
    const [body] = apiError('internal', 'm');
    expect(body.error.detail).toEqual({});
  });

  it('carries seq only when the failure also produced a ledger event', () => {
    const [without] = apiError('stale_cursor', 'm');
    expect('seq' in without.error).toBe(false);

    const [withSeq] = apiError('stale_cursor', 'm', { seq: 10_904 });
    expect(withSeq.error.seq).toBe(10_904);
    expect(Object.keys(withSeq.error).sort()).toEqual([
      'code',
      'detail',
      'message',
      'retryable',
      'seq',
    ]);
  });
});

suite('service refusals', () => {
  /**
   * Every refusal code the in-process services already answer with
   * (`human/gate.ts`, `human/interject.ts`, `human/patch-decision.ts`). The
   * HTTP edge may not invent a wire code for one of these, and may not pass one
   * through unmapped — either would put a code on the wire that is not in the
   * union a client is allowed to branch on.
   */
  const SERVICE_CODES = [
    'already_answered',
    'gate_not_open',
    'unknown_option',
    'missing_payload',
    'schema_violation',
    'node_not_found',
    'node_not_running',
    'use_respond',
    'empty_text',
    'stale_cursor',
    'patch_already_decided',
    'patch_not_found',
    'not_applicable',
    'apply_unavailable',
  ] as const;

  it.each(SERVICE_CODES)('maps "%s" onto a member of the closed union', (code) => {
    const [body, status] = serviceError(code, 'm');
    expect(isApiErrorCode(body.error.code)).toBe(true);
    expect(status).toBe(API_ERROR_STATUS[body.error.code]);
  });

  it("keeps the service's own code when the union already has it", () => {
    expect(serviceError('stale_cursor', 'm')[0].error.code).toBe('stale_cursor');
    expect(serviceError('node_not_found', 'm')[0].error.code).toBe('node_not_found');
  });

  it('records the service code in detail when the wire code is broader', () => {
    const [body, status] = serviceError('gate_not_open', 'm');
    expect(status).toBe(404);
    expect(body.error.code).toBe('node_not_found');
    expect(body.error.detail).toMatchObject({ reason: 'gate_not_open' });
  });
});
