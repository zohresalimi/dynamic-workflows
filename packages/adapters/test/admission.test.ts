/**
 * KAR-05.2 AC7 — admission control, decided from the probed row before
 * anything is spawned.
 *
 * Refusing at admission is what turns "this node cannot run here" from an
 * hour-three surprise into a plan-time fact. The failure is `permanent` on
 * purpose: a retry against the same binary produces the same answer, so a
 * transient class would burn the retry budget proving it.
 *
 * Like `capabilities.test.ts`, this file lives under `test/` because it names
 * vendors, and `no-capability-table.test.ts` keeps those out of `src/`.
 *
 * Verifies: EPIC-05-S9 · AC7 · test plan #7
 */
import { NodeIdSchema, ProviderIdSchema } from '@DeFlow/core';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import { admit, type CapabilityRequirement, type CapabilityRow } from '../src/index.ts';

function rowFor(profile: CapabilityProfileName, agentCapabilities: unknown = null): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: agentCapabilities ?? CAPABILITY_PROFILES[profile],
      authMethods: [],
    }),
    probedAt: 1_754_313_093_000,
  };
}

const NODE = NodeIdSchema.parse('n1');

const request = (
  requires: readonly CapabilityRequirement[],
  permission: 'read' | 'worktree' | 'worktree+net' | 'full' = 'read',
) => ({ node: NODE, requires, permission });

suite('a node whose requirements exceed the adapter is refused (EPIC-05-S9)', () => {
  const examples: { profile: CapabilityProfileName; requirement: CapabilityRequirement }[] = [
    { profile: 'codex', requirement: 'session.fork' },
    { profile: 'gemini', requirement: 'session.list' },
    { profile: 'copilot', requirement: 'session.delete' },
    { profile: 'gemini', requirement: 'additionalDirectories' },
  ];

  for (const { profile, requirement } of examples) {
    it(`${profile} cannot honour ${requirement}`, () => {
      const refusal = admit(request([requirement]), rowFor(profile));
      expect(refusal).not.toBeNull();
      expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
      expect(refusal?.deflowFailure.class).toBe('permanent');
      // "failure.detail names the requirement and the profile."
      expect(refusal?.deflowFailure.detail).toMatchObject({ requirement, provider: profile });
      expect(refusal?.message).toContain(requirement);
      expect(refusal?.message).toContain(profile);
    });
  }

  it('names why, so absent and denied stay distinguishable in the inspector', () => {
    expect(admit(request(['session.fork']), rowFor('codex'))?.deflowFailure.detail).toMatchObject({
      reason: 'capability-absent',
      path: 'agentCapabilities.sessionCapabilities.fork',
    });
    expect(admit(request(['mcp.acp']), rowFor('codex'))?.deflowFailure.detail).toMatchObject({
      reason: 'capability-denied',
    });
  });

  it('admits a node whose requirements the row does satisfy', () => {
    expect(admit(request(['session.fork', 'session.resume']), rowFor('claude'))).toBeNull();
    expect(admit(request([]), rowFor('gemini'))).toBeNull();
    // `{ list: {} }` is an advertisement, so a node needing session/list runs.
    expect(admit(request(['session.list']), rowFor('copilot'))).toBeNull();
  });

  it('refuses on the first unmet requirement, and names that one', () => {
    const refusal = admit(request(['session.resume', 'session.fork']), rowFor('codex'));
    expect(refusal?.deflowFailure.detail).toMatchObject({ requirement: 'session.fork' });
  });
});

suite('an adapter that cannot mediate execution is refused, not escalated', () => {
  /** The one bit F5.4 reduces to (docs/09-workspace-and-safety.md §8.3). */
  const cannotMediate = rowFor('claude', { _meta: { mediatedExecution: false } });

  it('refuses a node above read with safety.permission-unschedulable', () => {
    const refusal = admit(request([], 'worktree'), cannotMediate);
    expect(refusal?.deflowFailure.reason).toBe('safety.permission-unschedulable');
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.deflowFailure.detail).toMatchObject({ permission: 'worktree' });
  });

  it('refuses every level above read, and admits read itself', () => {
    for (const level of ['worktree', 'worktree+net', 'full'] as const) {
      expect(admit(request([], level), cannotMediate)?.deflowFailure.reason).toBe(
        'safety.permission-unschedulable',
      );
    }
    expect(admit(request([], 'read'), cannotMediate)).toBeNull();
  });

  it('does not silently escalate or downgrade the level instead', () => {
    // There is no third answer: `admit` returns a refusal or nothing. Anything
    // that "helpfully" ran the node at `read` would be F5.4's documented
    // hazard — ODW's binary permission model — reintroduced.
    const refusal = admit(request([], 'full'), cannotMediate);
    expect(refusal?.message).toMatch(/refus/i);
    expect(refusal?.message).not.toMatch(/downgrad|escalat/i);
  });

  it('an unadvertised mediatedExecution is not a denial: no measured adapter advertises it', () => {
    for (const profile of ['claude', 'codex', 'opencode', 'copilot', 'gemini'] as const) {
      expect(admit(request([], 'full'), rowFor(profile))).toBeNull();
    }
  });
});

suite('no row is no answer', () => {
  it('refuses a node that declares requirements when nothing has been probed', () => {
    const refusal = admit(request(['session.resume']), null);
    expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.message).toMatch(/never probed|no probed row/i);
  });

  it('admits a node that declares none: an unprobed adapter is not a refusal by itself', () => {
    expect(admit(request([]), null)).toBeNull();
  });
});
