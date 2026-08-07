/**
 * KAR-14.4 AC7 — `capabilitySuperset`, computed from the probed rows and from
 * nothing else.
 *
 * The rows below are the measured 2026-08-02 probe, reached through
 * `@DeFlow/mock-agent`'s `CAPABILITY_PROFILES` (generated from
 * `fixtures/capability-matrix.json`) rather than restated here. That matters
 * more than it looks: EPIC-14-S24's note calls the matrix _"a test fixture,
 * never a constant"_, and a hardcoded comparison table is precisely what
 * `test/no-capability-table.test.ts` greps `packages/adapters/src/` to keep
 * out. A reroute decided from a stale constant routes a node onto an adapter
 * that cannot honour it, hours into a run.
 *
 * Verifies: EPIC-14-S24 · AC7
 */
import { ProviderIdSchema } from '@DeFlow/core';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import {
  type CapabilityKey,
  type CapabilityRow,
  capabilitySuperset,
  mediationUnchanged,
  missingCapabilities,
} from '../src/index.ts';

function rowFor(profile: CapabilityProfileName): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: CAPABILITY_PROFILES[profile],
      authMethods: [],
    }),
    probedAt: 1_754_313_093_000,
  };
}

const claude = rowFor('claude');
const codex = rowFor('codex');
const opencode = rowFor('opencode');
const copilot = rowFor('copilot');
const gemini = rowFor('gemini');

suite('EPIC-14-S24 — the superset question, over the probed matrix', () => {
  const rows: readonly [readonly CapabilityKey[], CapabilityRow, boolean][] = [
    [['resume'], codex, true],
    [['resume'], copilot, false],
    [['resume'], gemini, false],
    [['fork'], codex, false],
    [['fork'], opencode, true],
  ];

  for (const [requires, target, superset] of rows) {
    it(`a node requiring ${requires.join('+')} onto ${target.provider}: ${superset}`, () => {
      expect(capabilitySuperset(requires, target)).toBe(superset);
    });
  }

  it('names what is missing, so a rejection is answerable rather than a shrug', () => {
    expect(missingCapabilities(['resume', 'fork'], copilot)).toEqual(['resume', 'fork']);
    expect(missingCapabilities(['resume', 'fork'], codex)).toEqual(['fork']);
    expect(missingCapabilities(['resume', 'fork'], opencode)).toEqual([]);
  });

  it('a node requiring nothing is satisfied by every adapter, including the weakest', () => {
    // Not a special case: an empty requirement set is vacuously covered, and
    // the alternative — refusing to reroute a node with no requirements — would
    // suspend a run that could have kept going.
    for (const row of [claude, codex, opencode, copilot, gemini]) {
      expect(capabilitySuperset([], row)).toBe(true);
    }
  });

  it('an unadvertised capability is not a granted one, and neither is a denied one', () => {
    // §5's three answers — absent, `{}` and explicit `false` — collapse to
    // "cannot" here, which is the only safe reading for a router: a node that
    // needs to resume and is moved onto an adapter that never mentioned resume
    // discovers it at the resume, not at the decision.
    expect(capabilitySuperset(['resume'], gemini)).toBe(false);
    expect(capabilitySuperset(['fork'], codex)).toBe(false);
  });
});

suite('EPIC-14-S24 scenario 2 — a reroute that changes the permission level', () => {
  /** A row that answers `mediatedExecution: false` — DeFlow is not in the path,
   * so the permission ladder cannot be enforced at the level the node was
   * admitted at (docs/09-workspace-and-safety.md §8.3). */
  const unmediated: CapabilityRow = {
    ...codex,
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: {
        ...CAPABILITY_PROFILES.codex,
        _meta: { mediatedExecution: false },
      },
      authMethods: [],
    }),
  };

  const mediated: CapabilityRow = {
    ...codex,
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: {
        ...CAPABILITY_PROFILES.codex,
        _meta: { mediatedExecution: true },
      },
      authMethods: [],
    }),
  };

  it('is not equivalent when the target cannot mediate and the source could', () => {
    expect(mediationUnchanged(mediated, unmediated)).toBe(false);
  });

  it('is equivalent when both mediate, and when both say the same thing', () => {
    expect(mediationUnchanged(mediated, mediated)).toBe(true);
    expect(mediationUnchanged(unmediated, unmediated)).toBe(true);
  });

  it('is equivalent when the target mediates and the source did not — that is not an escalation', () => {
    expect(mediationUnchanged(unmediated, mediated)).toBe(true);
  });

  it('treats "never advertised" as unmediated on both sides, not as an unknown to wave through', () => {
    // `mediatedExecution` is `boolean | undefined` by design: absent means the
    // adapter predates the field. For *this* question absent is a no — a
    // reroute onto an adapter that has not claimed it must not be auto-applied
    // on the strength of a field nobody filled in.
    expect(mediationUnchanged(mediated, codex)).toBe(false);
    expect(mediationUnchanged(codex, mediated)).toBe(true);
    expect(mediationUnchanged(codex, gemini)).toBe(true);
  });
});
