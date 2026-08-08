/**
 * KAR-11.6 AC3, AC4, AC5 — where a rate-limited node goes next, decided from
 * the probed rows and from nothing else
 * (docs/06-planning-and-replanning.md §4.4).
 *
 * The rows below are the measured 2026-08-02 probe, reached through
 * `@DeFlow/mock-agent`'s `CAPABILITY_PROFILES` — which is itself generated from
 * `fixtures/capability-matrix.json` — rather than restated here. EPIC-11-S30's
 * last scenario is the proof that it is a fixture and not a table: regenerate
 * the probe with `fork: yes` and the answer flips **with no source change**,
 * which is only possible if the question was asked of the row.
 *
 * Two questions, and they are asked in this order for a reason. *Is this target
 * equivalent?* is `capabilitySuperset` × `permissionUnchanged`, and it is what
 * the policy engine rules on. *Is there a target at all?* is the chooser, and
 * its answer when there is none is **suspend**, never "move it anyway" — a node
 * rerouted onto an adapter that cannot run it fails again in four hours having
 * spent an attempt, which is strictly worse than a durable row that costs
 * nothing while it waits (NF7).
 *
 * Verifies: EPIC-11-S29 (equivalence half), EPIC-11-S30, EPIC-11-S31
 * (scenario 1) · AC3, AC4, AC5
 */
import type { AdapterRequirement, ProviderId } from '@DeFlow/core';
import { ProviderIdSchema, RATE_LIMIT_BACKOFF } from '@DeFlow/core';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import {
  type CapabilityRow,
  capabilityQuestions,
  chooseQuotaRoute,
  type NodeRequirement,
  type ProviderLimit,
  rerouteEquivalence,
} from '../src/index.ts';

const NOW = 1_754_313_093_000;
const hours = (count: number): number => count * 3_600_000;

/** One probed row, exactly as `provider_capabilities` holds it. */
function rowFor(profile: CapabilityProfileName, caps: unknown = undefined): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: caps ?? CAPABILITY_PROFILES[profile],
      authMethods: [],
    }),
    probedAt: NOW - hours(1),
  };
}

const claude = rowFor('claude');
const codex = rowFor('codex');
const copilot = rowFor('copilot');
const gemini = rowFor('gemini');
const opencode = rowFor('opencode');

const id = (name: string): ProviderId => ProviderIdSchema.parse(name);

const limit = (provider: string, resetsAt: number | null, at = NOW - 1000): ProviderLimit => ({
  provider,
  resetsAt,
  at,
});

// ── EPIC-11-S30 — superset or not, from the probed rows ──────────────────────

suite('EPIC-11-S30 — capabilitySuperset is computed, not assumed (AC3, AC4)', () => {
  const rows: readonly [NodeRequirement, CapabilityRow, boolean][] = [
    ['structuredOutput', codex, true],
    ['session.fork', codex, false],
    ['resumableSessions', copilot, false],
    ['session.list', gemini, false],
  ];

  for (const [requirement, target, superset] of rows) {
    it(`a node requiring ${requirement} onto ${target.provider}: ${superset}`, () => {
      const answer = rerouteEquivalence({ requires: [requirement], from: claude, to: target });
      expect(answer.capabilitySuperset).toBe(superset);
    });
  }

  it('names what the target does not advertise, so the refusal is answerable', () => {
    const answer = rerouteEquivalence({
      requires: ['session.fork', 'session.list'],
      from: claude,
      to: codex,
    });
    expect(answer.missing).toEqual(['fork']);
  });

  it('regenerating the probe with fork: yes flips the answer, with no source change', () => {
    // The scenario in EPIC-11-S30's last block, run literally: the same code,
    // a different row. A hardcoded "codex cannot fork" would ignore this.
    const forking = rowFor('codex', {
      ...(CAPABILITY_PROFILES.codex as Record<string, unknown>),
      sessionCapabilities: {
        ...((CAPABILITY_PROFILES.codex as { sessionCapabilities: Record<string, unknown> })
          .sessionCapabilities ?? {}),
        fork: true,
      },
    });

    expect(
      rerouteEquivalence({ requires: ['session.fork'], from: claude, to: codex }),
    ).toMatchObject({ capabilitySuperset: false });
    expect(
      rerouteEquivalence({ requires: ['session.fork'], from: claude, to: forking }),
    ).toMatchObject({ capabilitySuperset: true });
  });

  it('asks the handshake nothing it cannot answer', () => {
    // Four of the domain's requirement kinds have no ACP field behind them
    // (docs/07 §7.1), and a question nobody can answer must not become a
    // refusal — it would make every reroute impossible for a node that asked
    // for structured output, which every agent node does.
    const unanswerable: readonly AdapterRequirement[] = [
      'structuredOutput',
      'streaming',
      'mcp',
      { minContext: 200_000 },
      { permission: 'worktree' },
    ];
    expect(capabilityQuestions(unanswerable)).toEqual([]);
    expect(capabilityQuestions(['resumableSessions', 'session.resume'])).toEqual(['resume']);
    expect(capabilityQuestions(['imageInput'])).toEqual(['promptImage']);
  });

  it('a node that requires nothing is covered by the weakest adapter there is', () => {
    expect(rerouteEquivalence({ requires: [], from: claude, to: gemini })).toMatchObject({
      capabilitySuperset: true,
      permissionUnchanged: true,
    });
  });

  it('a swap from an adapter DeFlow can mediate onto one it cannot is never equivalent', () => {
    const mediated = rowFor('claude', {
      ...(CAPABILITY_PROFILES.claude as Record<string, unknown>),
      _meta: { mediatedExecution: true },
    });
    const unmediated = rowFor('codex', {
      ...(CAPABILITY_PROFILES.codex as Record<string, unknown>),
      _meta: { mediatedExecution: false },
    });

    expect(
      rerouteEquivalence({ requires: [], from: mediated, to: unmediated }).permissionUnchanged,
    ).toBe(false);
    // The other direction constrains the node rather than widening it.
    expect(
      rerouteEquivalence({ requires: [], from: unmediated, to: mediated }).permissionUnchanged,
    ).toBe(true);
  });

  it('claims nothing about a swap whose origin was never probed', () => {
    // `from: null` is "we do not know what it was running on". An unknown
    // origin cannot support the claim that the swap changes nothing, and the
    // patch falls through to a human rather than auto-applying on a guess.
    expect(rerouteEquivalence({ requires: [], from: null, to: codex }).permissionUnchanged).toBe(
      false,
    );
  });
});

// ── EPIC-11-S29 / S31 scenario 1 — reroute, or suspend ───────────────────────

suite('EPIC-11-S29 — the chooser moves a node onto a healthy superset (AC3)', () => {
  const requires: readonly NodeRequirement[] = ['session.list'];

  it('picks the healthy adapter that covers what the node requires', () => {
    const route = chooseQuotaRoute({
      requires,
      current: id('claude'),
      prefer: [id('claude'), id('codex')],
      rows: [claude, codex, gemini],
      limits: [limit('claude', NOW + hours(4))],
      now: NOW,
    });

    expect(route).toEqual({
      action: 'reroute',
      provider: 'codex',
      capabilitySuperset: true,
      permissionUnchanged: true,
    });
  });

  it('honours the plan preference order before anything else probed', () => {
    const route = chooseQuotaRoute({
      requires: [],
      current: id('claude'),
      // `opencode` is probed first and `codex` is preferred; the plan wins.
      prefer: [id('claude'), id('codex')],
      rows: [opencode, claude, codex],
      limits: [limit('claude', NOW + hours(4))],
      now: NOW,
    });

    expect(route).toMatchObject({ action: 'reroute', provider: 'codex' });
  });

  it('will reroute onto a probed adapter the plan never named, rather than stall', () => {
    const route = chooseQuotaRoute({
      requires: ['session.fork'],
      current: id('claude'),
      prefer: [id('claude')],
      rows: [claude, codex, opencode],
      limits: [limit('claude', NOW + hours(4))],
      now: NOW,
    });

    // `codex` cannot fork; `opencode` can, and is not in the plan's preference
    // list at all. A run that suspended for four hours with a capable adapter
    // installed is the failure NF7 names.
    expect(route).toMatchObject({ action: 'reroute', provider: 'opencode' });
  });
});

suite('EPIC-11-S31 scenario 1 — no healthy provider: suspend, do not reroute (AC5)', () => {
  it('proposes nothing when every capable adapter is itself rate limited', () => {
    const route = chooseQuotaRoute({
      requires: ['session.fork'],
      current: id('claude'),
      prefer: [id('claude'), id('opencode')],
      rows: [claude, codex, opencode],
      limits: [limit('claude', NOW + hours(4)), limit('opencode', NOW + hours(2))],
      now: NOW,
    });

    expect(route.action).toBe('suspend');
  });

  it('proposes nothing when the only healthy adapters cannot run the node', () => {
    // AC5's exact wording: *no healthy provider satisfies the node's
    // requirements*. `codex` is healthy and cannot fork, which is not a
    // reroute — it is an attempt spent proving what the probed row already
    // said.
    const route = chooseQuotaRoute({
      requires: ['session.fork'],
      current: id('claude'),
      prefer: [id('claude'), id('codex')],
      rows: [claude, codex],
      limits: [limit('claude', NOW + hours(4))],
      now: NOW,
    });

    expect(route.action).toBe('suspend');
  });

  it('routes onto a provider whose own limit has already lifted', () => {
    const route = chooseQuotaRoute({
      requires: [],
      current: id('claude'),
      prefer: [id('claude'), id('codex')],
      rows: [claude, codex],
      limits: [limit('claude', NOW + hours(4)), limit('codex', NOW - hours(1))],
      now: NOW,
    });

    expect(route).toMatchObject({ action: 'reroute', provider: 'codex' });
  });

  it('treats a limit that named no reset as lifted only after the capped backoff', () => {
    // "Reset time unknown" is never filled in with a plausible instant
    // (KAR-14.4), so the only honest reading for a router is the one the blind
    // retry already uses: wait the capped backoff, then look again. Refusing
    // the provider for ever would make one unknown limit permanent across every
    // future run, since the ledger keeps the last limit indefinitely.
    const unknown = (at: number): ProviderLimit => limit('codex', null, at);
    const route = (at: number) =>
      chooseQuotaRoute({
        requires: [],
        current: id('claude'),
        prefer: [id('claude'), id('codex')],
        rows: [claude, codex],
        limits: [limit('claude', NOW + hours(4)), unknown(at)],
        now: NOW,
      });

    expect(route(NOW - RATE_LIMIT_BACKOFF.cap + 1000).action).toBe('suspend');
    expect(route(NOW - RATE_LIMIT_BACKOFF.cap).action).toBe('reroute');
  });

  it('never proposes a swap back onto the provider that just refused the node', () => {
    const route = chooseQuotaRoute({
      requires: [],
      current: id('claude'),
      prefer: [id('claude')],
      rows: [claude],
      limits: [],
      now: NOW,
    });

    // Even with no recorded limit for it: the node is here *because* that
    // provider refused it, and a patch that changes nothing claims a decision
    // was made.
    expect(route.action).toBe('suspend');
  });
});
