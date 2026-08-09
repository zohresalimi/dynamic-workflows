/**
 * KAR-12.2 AC6, AC7, AC8, AC9 — the routing half of independent review, over a
 * synthetic capability table.
 *
 * "Preferably a different provider" is not implementable, so
 * docs/10-verification-gates.md §3.1's preference is written here as a total
 * rule with four branches and no default. The branch that matters most is the
 * last one: an empty candidate set is a **refusal**, not a fallback. NF7 says a
 * missing provider degrades the plan; it does not say a degraded plan may
 * invent a verdict.
 *
 * Every row below is a fixture, and **no assertion names a vendor's
 * capabilities**. A0-9 is live on this story — two of the five versions in the
 * measured matrix were published the same day they were probed — so a test that
 * asserted "codex supports structured output" would reintroduce inside the
 * suite exactly the staleness the design removed from the source.
 *
 * Verifies: EPIC-12-S11, EPIC-12-S14, EPIC-12-S15 · AC6-AC9 · test plan #3, #4
 */
import { type PermissionLevel, type ProviderId, ProviderIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  type CapabilityRow,
  NO_CAPABLE_REVIEWER,
  pickReviewer,
  REVIEW_CONTEXT_HEADROOM,
  type ReviewerCandidate,
} from '../src/index.ts';

const PRODUCER = ProviderIdSchema.parse('the-one-that-wrote-it');
const OTHER = ProviderIdSchema.parse('the-other-one');
const THIRD = ProviderIdSchema.parse('a-third-one');

/** A probed row that grants everything the caller asks about. */
function row(provider: ProviderId, caps: Record<string, unknown> = {}): CapabilityRow {
  return {
    provider,
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: true, list: true, fork: true },
        ...caps,
      },
      authMethods: [],
    }),
    probedAt: 1_754_313_093_000,
  };
}

function candidate(
  provider: ProviderId,
  overrides: Partial<ReviewerCandidate> = {},
): ReviewerCandidate {
  return {
    provider,
    row: row(provider),
    health: 'healthy',
    structuredOutput: true,
    permissionLevels: ['read', 'worktree'] as readonly PermissionLevel[],
    maxContext: 200_000,
    ...overrides,
  };
}

const routing = (candidates: readonly ReviewerCandidate[], extra = {}) => ({
  producer: PRODUCER,
  permission: 'worktree' as PermissionLevel,
  packetTokens: 20_000,
  requires: [],
  candidates,
  ...extra,
});

suite('two capable providers: the reviewer is not the producer (AC6 · test plan #3)', () => {
  it('routes to the other provider and marks nothing weakened', () => {
    const decision = pickReviewer(routing([candidate(PRODUCER), candidate(OTHER)]));

    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.provider).toBe(OTHER);
    expect(decision.weakened).toBeUndefined();
  });

  it('obeys policy.review.providerOrder before probe order', () => {
    const decision = pickReviewer(
      routing([candidate(PRODUCER), candidate(OTHER), candidate(THIRD)], {
        providerOrder: [THIRD, OTHER],
      }),
    );

    expect(decision.kind === 'routed' && decision.provider).toBe(THIRD);
  });

  it('falls back to probe order when the config names none of them', () => {
    const decision = pickReviewer(
      routing([candidate(PRODUCER), candidate(OTHER), candidate(THIRD)], {
        providerOrder: [ProviderIdSchema.parse('one-nobody-installed')],
      }),
    );

    expect(decision.kind === 'routed' && decision.provider).toBe(OTHER);
  });
});

suite('exactly one capable provider: the stated fallback (AC7 · test plan #3)', () => {
  it('routes to the producer and stamps weakened same-provider', () => {
    const decision = pickReviewer(routing([candidate(PRODUCER)]));

    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.provider).toBe(PRODUCER);
    expect(decision.weakened).toBe('same-provider');
  });

  it('never proposes a fork as the fallback, however forkable the row is', () => {
    // The row grants `session.fork`; the fallback still opens a new session.
    const decision = pickReviewer(routing([candidate(PRODUCER)]));

    expect(decision.kind === 'routed' && decision.session).toBe('session/new');
  });

  it('weakens the provider dimension only, never the session one', () => {
    const preferred = pickReviewer(routing([candidate(PRODUCER), candidate(OTHER)]));
    const fallback = pickReviewer(routing([candidate(PRODUCER)]));

    expect(preferred.kind === 'routed' && preferred.session).toBe('session/new');
    expect(fallback.kind === 'routed' && fallback.session).toBe('session/new');
  });
});

suite('candidate filtering excludes for the stated reasons (AC9 · test plan #4)', () => {
  const excluded = (defect: Partial<ReviewerCandidate>): string[] => {
    const decision = pickReviewer(routing([candidate(PRODUCER), candidate(OTHER, defect)]));
    expect(decision.kind === 'routed' && decision.weakened).toBe('same-provider');
    return (decision.excluded.find((entry) => entry.provider === OTHER)?.failed ?? []).map(
      (failure) => failure.requirement,
    );
  };

  it('excludes a provider that cannot return structured output', () => {
    expect(excluded({ structuredOutput: false })).toContain('structuredOutput');
  });

  it("excludes a provider missing the node's permission level", () => {
    expect(excluded({ permissionLevels: ['read'] })).toContain('permission');
  });

  it('excludes a provider whose window cannot hold the packet with headroom', () => {
    // The rule is `packetTokens <= maxContext * 0.6`, so 20k needs 33_334.
    expect(excluded({ maxContext: Math.floor(20_000 / REVIEW_CONTEXT_HEADROOM) - 1 })).toContain(
      'context',
    );
    const decision = pickReviewer(
      routing([
        candidate(PRODUCER),
        candidate(OTHER, { maxContext: Math.ceil(20_000 / REVIEW_CONTEXT_HEADROOM) }),
      ]),
    );
    expect(decision.kind === 'routed' && decision.provider).toBe(OTHER);
  });

  it('excludes an unhealthy provider, however capable its row is (test plan #4)', () => {
    // A provider.rate_limited event is what makes health `unavailable`; the row
    // is untouched, which is why health has to be part of the candidate set
    // rather than derived from capabilities.
    expect(excluded({ health: 'unavailable' })).toContain('health');
  });

  it('excludes a provider that was never probed at all', () => {
    expect(excluded({ row: null })).toContain('probed');
  });
});

suite('capability filtering reads the row, never a constant (AC9)', () => {
  const requires = ['session.resume', 'session.list'] as const;

  it('routes to the second provider while its row grants what the gate requires', () => {
    const decision = pickReviewer(
      routing([candidate(PRODUCER), candidate(OTHER)], { requires: [...requires] }),
    );
    expect(decision.kind === 'routed' && decision.provider).toBe(OTHER);
  });

  it('changes the decision when the same row is rewritten, with no code change', () => {
    // The identical call, with one field of one fixture rewritten to a profile
    // that answers `false` to both. Nothing in `pickReviewer` knows a vendor.
    const rewritten = candidate(OTHER, {
      row: row(OTHER, { sessionCapabilities: { resume: false, list: false } }),
    });

    const decision = pickReviewer(
      routing([candidate(PRODUCER), rewritten], { requires: [...requires] }),
    );

    expect(decision.kind === 'routed' && decision.weakened).toBe('same-provider');
    const failed = decision.excluded.find((entry) => entry.provider === OTHER)?.failed ?? [];
    expect(failed.map((failure) => failure.requirement)).toEqual([
      'session.resume',
      'session.list',
    ]);
    // The detail names *why* — "told us no" is not "never mentioned it".
    expect(failed[0]?.detail).toContain('capability-denied');
  });
});

suite('zero capable providers: needs-human, never a fabricated pass (AC8)', () => {
  const decision = pickReviewer(
    routing([
      candidate(PRODUCER, { structuredOutput: false }),
      candidate(OTHER, { health: 'unavailable' }),
    ]),
  );

  it('refuses rather than routing', () => {
    expect(decision.kind).toBe('needs-human');
  });

  it('carries the machine-readable reason', () => {
    expect(decision.kind === 'needs-human' && decision.reason).toBe(NO_CAPABLE_REVIEWER);
    expect(NO_CAPABLE_REVIEWER).toBe('no-capable-reviewer');
  });

  it('names, per provider, which requirement it failed', () => {
    const byProvider = new Map(decision.excluded.map((entry) => [entry.provider, entry.failed]));

    expect([...byProvider.keys()].sort()).toEqual([OTHER, PRODUCER].sort());
    expect(byProvider.get(PRODUCER)?.map((failure) => failure.requirement)).toEqual([
      'structuredOutput',
    ]);
    expect(byProvider.get(OTHER)?.map((failure) => failure.requirement)).toEqual(['health']);
  });

  it('lists every requirement a provider failed, not only the first', () => {
    const hopeless = pickReviewer(
      routing([candidate(PRODUCER, { structuredOutput: false, permissionLevels: ['read'] })]),
    );
    const failed = hopeless.excluded[0]?.failed ?? [];
    expect(failed.map((failure) => failure.requirement)).toEqual([
      'structuredOutput',
      'permission',
    ]);
  });

  it('has no branch that could return a routed decision from an empty set', () => {
    const empty = pickReviewer(routing([]));
    expect(empty.kind).toBe('needs-human');
    expect(empty.excluded).toEqual([]);
  });
});
