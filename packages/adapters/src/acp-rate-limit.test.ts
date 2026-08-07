/**
 * KAR-14.4 AC1, AC9 — the rate-limit signal on the **ACP** path.
 *
 * The shim path reads Claude Code's `rate_limit_event` frame, which is the one
 * rate-limit signal any vendor has been verified to emit. AC1 asks for the
 * equivalent on the ACP path, and the honest equivalent is not a vendor table:
 * ACP itself has no rate-limit concept — every code the SDK assigns is a
 * transport or auth condition — so DeFlow declares nothing on the adapter's
 * behalf and reads only what the *caller* declared, exactly as
 * `rateLimitExitCodes` works next door on the shim.
 *
 * The three assertions that make this more than a lookup:
 *
 *   - an undeclared error stays whatever it was, so a `-32601` does not become
 *     a quota because it happened to arrive during a busy hour;
 *   - a code ACP has already assigned cannot be declared at all, because
 *     declaring `-32000` would turn every permanent auth refusal into a
 *     transient retry — the conflation AC9 exists to forbid;
 *   - `resetsAt` comes from the vendor or is `null`. Never inferred.
 *
 * Verifies: EPIC-14-S28 · AC1, AC9
 */
import { ProviderIdSchema, rateLimitOf, toNodeFailure } from '@DeFlow/core';
import * as acp from '@agentclientprotocol/sdk';
import { expect, it, describe as suite } from 'vitest';
import { ACP_ASSIGNED_ERROR_CODES, acpRateLimit, undeclarableRateLimitCode } from './failures.ts';

/** Deliberately not a real vendor: nothing here is provider-specific, and
 * `test/no-capability-table.test.ts` keeps this file honest about that. */
const PROVIDER = ProviderIdSchema.parse('mock');
/** Inside JSON-RPC's implementation-defined server range, and not one ACP has
 * taken. A caller's datum, never a table this package ships. */
const DECLARED = -32_042;
const NOW_SECONDS = 1_800_000_000;

const context = {
  occurredAtEvent: 12 as never,
  attempt: 0,
  captureEvidence: (() => 'artifact://x') as never,
};

suite('a declared JSON-RPC error code (AC1)', () => {
  it('normalises to provider.rate_limited with the vendor payload verbatim', () => {
    const error = new acp.RequestError(DECLARED, 'quota exhausted', {
      rate_limit_info: { status: 'rejected', resetsAt: NOW_SECONDS },
    });

    const limited = acpRateLimit(error, { provider: PROVIDER, codes: [DECLARED] });

    expect(limited).not.toBeNull();
    expect(limited?.limit).toEqual({
      provider: PROVIDER,
      resetsAt: NOW_SECONDS * 1000,
      raw: {
        code: DECLARED,
        message: 'quota exhausted',
        data: { rate_limit_info: { status: 'rejected', resetsAt: NOW_SECONDS } },
      },
    });
  });

  it('produces the same failure shape the shim path produces (AC9)', () => {
    const error = new acp.RequestError(DECLARED, 'quota exhausted', { resetsAt: NOW_SECONDS });
    const limited = acpRateLimit(error, { provider: PROVIDER, codes: [DECLARED] });
    const failure = toNodeFailure(limited?.thrown, context);

    expect(failure.reason).toBe('provider.rate-limited');
    expect(failure.class).toBe('transient');
    // The one reader the scheduler uses, on both paths.
    expect(rateLimitOf(failure)).toEqual({
      provider: PROVIDER,
      resetsAt: NOW_SECONDS * 1000,
      raw: { code: DECLARED, message: 'quota exhausted', data: { resetsAt: NOW_SECONDS } },
    });
    expect(failure.message).not.toContain('\n');
  });

  it('reads resetsAt as epoch seconds, the one spelling a vendor has emitted', () => {
    const error = new acp.RequestError(DECLARED, 'slow down', { resetsAt: NOW_SECONDS });
    // Milliseconds would put the wake in 1970 — a row that fires immediately,
    // i.e. the blind retry AC6 forbids wearing a scheduler's clothes.
    expect(acpRateLimit(error, { provider: PROVIDER, codes: [DECLARED] })?.limit.resetsAt).toBe(
      NOW_SECONDS * 1000,
    );
  });

  it('leaves resetsAt null when the vendor named none, and invents nothing', () => {
    const error = new acp.RequestError(DECLARED, 'slow down', { retryAfter: '30s' });
    const limited = acpRateLimit(error, { provider: PROVIDER, codes: [DECLARED] });

    expect(limited?.limit.resetsAt).toBeNull();
    // The unparsed field is still there to be re-read by a later build.
    expect(limited?.limit.raw).toMatchObject({ data: { retryAfter: '30s' } });
    expect(toNodeFailure(limited?.thrown, context).message).toContain('reset time unknown');
  });

  it('accepts an error that is a plain object rather than a RequestError', () => {
    // What arrives off the wire is a JSON-RPC error object; whether the SDK
    // reconstructed a class around it is not a fact about the vendor.
    const limited = acpRateLimit(
      { code: DECLARED, message: 'quota exhausted', data: { resetsAt: NOW_SECONDS } },
      { provider: PROVIDER, codes: [DECLARED] },
    );
    expect(limited?.limit.resetsAt).toBe(NOW_SECONDS * 1000);
  });
});

suite('everything that is not a declared rate limit (AC9)', () => {
  it.for([
    ['an undeclared server error', new acp.RequestError(-32_043, 'something else', {})],
    ['method not found', acp.RequestError.methodNotFound('session/prompt')],
    ['auth required', acp.RequestError.authRequired({ authMethods: [] })],
    ['a plain Error', new Error('the agent exited mid-turn')],
    ['a thrown string', 'boom'],
    ['null', null],
  ] as const)('stays what it was: %s', ([, thrown]) => {
    expect(acpRateLimit(thrown, { provider: PROVIDER, codes: [DECLARED] })).toBeNull();
  });

  it('reads nothing at all when the caller declared no codes — the default', () => {
    const error = new acp.RequestError(DECLARED, 'quota exhausted', { resetsAt: NOW_SECONDS });
    expect(acpRateLimit(error, { provider: PROVIDER, codes: [] })).toBeNull();
  });
});

suite('a code ACP has already assigned cannot be declared (AC9)', () => {
  it('names every assigned code, so none of them can be re-pointed at a quota', () => {
    // The set the SDK's own constructors use. `authRequired` is the one that
    // matters: declaring it would classify a permanent auth refusal as a
    // transient quota and retry it until the attempt budget ran out.
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.authRequired().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.methodNotFound('x').code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.invalidParams().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.internalError().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.parseError().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.invalidRequest().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.requestCancelled().code);
    expect(ACP_ASSIGNED_ERROR_CODES).toContain(acp.RequestError.resourceNotFound('file:///x').code);
  });

  it('refuses the declaration itself, before a process exists', () => {
    const refusal = undeclarableRateLimitCode(PROVIDER, [DECLARED, -32_000]);

    expect(refusal).not.toBeNull();
    const failure = toNodeFailure(refusal, context);
    expect(failure.class).toBe('permanent');
    expect(failure.message).toContain('-32000');
  });

  it('says nothing about a set that only names codes ACP left free', () => {
    expect(undeclarableRateLimitCode(PROVIDER, [DECLARED])).toBeNull();
    expect(undeclarableRateLimitCode(PROVIDER, [])).toBeNull();
  });
});
