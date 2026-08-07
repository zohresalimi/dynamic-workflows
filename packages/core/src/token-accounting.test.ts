/**
 * KAR-09.7 — which tier may measure, and what the cost cell says when nothing
 * can.
 *
 * Two claims live here and they are both about honesty rather than arithmetic.
 * A provider whose manifest says `tokenAccounting: 'none'` has told DeFlow it
 * reports nothing; projecting `0` for it would be a confident lie that a budget
 * ceiling and a cost chart would both act on. And tier 3 — Anthropic's exact
 * `count_tokens` — is reachable only from the F3.3 direct-API adapter under a
 * key the operator supplied themselves, so the selection function has to refuse
 * it on the subscription path rather than leave the refusal to a call site.
 *
 * Verifies: EPIC-09-S40, EPIC-09-S41 · KAR-09.7 AC8, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import {
  projectNodeCost,
  selectTokenTier,
  TOKEN_ACCOUNTING_MODES,
  TokenAccountingSchema,
} from './token-accounting.ts';
import type { TokenUsage } from './token-usage.ts';

const REPORTED: TokenUsage = {
  inputTokens: 4_000,
  outputTokens: 900,
  source: 'vendor-reported',
};

const ESTIMATE = { estimated: 3_400, method: 'gpt-tokenizer/o200k_base' } as const;

suite('the manifest capability drives the projected figure (AC9)', () => {
  it('enumerates exactly the three modes the manifest may declare', () => {
    expect(TOKEN_ACCOUNTING_MODES).toEqual(['exact', 'estimated', 'none']);
    expect(TokenAccountingSchema.safeParse('partial').success).toBe(false);
  });

  it('reports the vendor figure when the manifest says exact', () => {
    const projected = projectNodeCost({
      accounting: 'exact',
      reported: { costUsd: 0.42, usage: REPORTED },
      estimate: ESTIMATE,
    });
    expect(projected).toEqual({
      costUsd: 0.42,
      tokens: { estimated: 4_900, method: 'vendor-reported' },
    });
  });

  it('projects a blank cost — never a zero — when the manifest says estimated', () => {
    const projected = projectNodeCost({
      accounting: 'estimated',
      reported: null,
      estimate: ESTIMATE,
    });
    expect(projected.costUsd).toBeNull();
    expect(projected.tokens).toEqual(ESTIMATE);
  });

  it('projects a blank cost — never a zero — when the manifest says none', () => {
    const projected = projectNodeCost({ accounting: 'none', reported: null, estimate: ESTIMATE });
    expect(projected.costUsd).toBeNull();
    expect(projected.tokens.method).toBe('gpt-tokenizer/o200k_base');
  });

  it('never produces 0 for a provider that reports nothing, whatever it is handed', () => {
    for (const estimated of [0, 1, 12_345]) {
      const projected = projectNodeCost({
        accounting: 'none',
        // A reported figure that arrived anyway is still not believed: the
        // manifest said this provider does not report, and believing the
        // envelope over the manifest is how a zero becomes a cost.
        reported: { costUsd: 0, usage: REPORTED },
        estimate: { estimated, method: 'gpt-tokenizer/o200k_base' },
      });
      expect(projected.costUsd).toBeNull();
      expect(projected.costUsd).not.toBe(0);
    }
  });

  it('blanks the cost when the manifest promises exact and the envelope carried none', () => {
    const projected = projectNodeCost({ accounting: 'exact', reported: null, estimate: ESTIMATE });
    expect(projected.costUsd).toBeNull();
    expect(projected.tokens).toEqual(ESTIMATE);
  });
});

suite('tier selection is a policy, not a call-site convention (AC8)', () => {
  const subscription = {
    phase: 'pre-flight',
    accounting: 'exact',
    authMode: 'subscription',
    exactCounter: false,
  } as const;

  it('estimates pre-flight on the subscription path, always', () => {
    expect(selectTokenTier(subscription)).toBe('estimated');
  });

  it('refuses tier 3 on the subscription path even when an exact counter is wired', () => {
    expect(selectTokenTier({ ...subscription, exactCounter: true })).toBe('estimated');
  });

  it('refuses tier 3 on the api_key path when no direct-API counter is wired', () => {
    // F3.3 moved to M2, so this is the M1 state of the world: the operator may
    // have selected api_key auth and there is still no adapter that can count.
    expect(selectTokenTier({ ...subscription, authMode: 'api_key' })).toBe('estimated');
  });

  it('reaches tier 3 only with a user-supplied key and a direct-API counter', () => {
    expect(selectTokenTier({ ...subscription, authMode: 'api_key', exactCounter: true })).toBe(
      'exact-api',
    );
  });

  it('reads the vendor envelope post-hoc when the manifest says it reports', () => {
    expect(selectTokenTier({ ...subscription, phase: 'post-hoc' })).toBe('vendor-reported');
    expect(
      selectTokenTier({
        ...subscription,
        phase: 'post-hoc',
        authMode: 'api_key',
        exactCounter: true,
      }),
    ).toBe('vendor-reported');
  });

  it('falls back to the estimate post-hoc when the manifest says the vendor reports nothing', () => {
    for (const accounting of ['estimated', 'none'] as const) {
      expect(selectTokenTier({ ...subscription, phase: 'post-hoc', accounting })).toBe('estimated');
    }
  });
});
