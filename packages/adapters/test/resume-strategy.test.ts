/**
 * KAR-05.5 — the strategy selector and the cross-version poisoning guard.
 *
 * This file lives under `test/` rather than beside the module, for the reason
 * `capabilities.test.ts` states: the expectation table below names five
 * vendors against two strategies, and that is exactly the shape
 * `test/no-capability-table.test.ts` exists to keep out of `src/`. Here it is
 * an assertion about a probed fixture; there it would be the routing layer's
 * opinion.
 *
 * The rows come from `@DeFlow/mock-agent`'s `CAPABILITY_PROFILES`, generated
 * from the `agentCapabilities` block each real adapter returned on 2026-08-02.
 * Nothing here re-types what an agent said.
 *
 * Verifies: EPIC-05-S19 (scenarios 1, 4), EPIC-05-S20, EPIC-05-S21
 * (scenario 1) · AC1, AC5 · test plan #1
 */
import {
  HumanRequestedSchema,
  NodeFailureError,
  NodeIdSchema,
  ProviderIdSchema,
} from '@DeFlow/core';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import {
  binaryDrift,
  type CapabilityRow,
  crossVersionGatePrompt,
  crossVersionRefusal,
  RESUME_GATE_OPTIONS,
  RESUME_OVERRIDE_OPTION_ID,
  RESUME_REFUSE_OPTION_ID,
  selectResumeStrategy,
} from '../src/index.ts';

/** A row as the probe would have written it for `profile`. */
function rowFor(profile: CapabilityProfileName, capsJson?: unknown): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify(
      capsJson ?? {
        protocolVersion: 1,
        agentCapabilities: CAPABILITY_PROFILES[profile],
        authMethods: [],
      },
    ),
    probedAt: 1_754_313_093_000,
  };
}

const NODE = NodeIdSchema.parse('n1');

suite('the strategy follows the probed row (EPIC-05-S19, test plan #1)', () => {
  const expected: readonly [CapabilityProfileName, string][] = [
    ['claude', 'ResumeNative'],
    ['codex', 'ResumeNative'],
    ['opencode', 'ResumeNative'],
    ['copilot', 'ResumeByReplay'],
    ['gemini', 'ResumeByReplay'],
  ];

  for (const [profile, strategy] of expected) {
    it(`${profile} resumes via ${strategy}`, () => {
      expect(selectResumeStrategy(rowFor(profile))).toBe(strategy);
    });
  }

  it('replays when nothing has been probed at all', () => {
    // An unprobed provider has advertised nothing, and "advertised nothing" is
    // not "can resume". The durability path is the safe default by
    // construction.
    expect(selectResumeStrategy(null)).toBe('ResumeByReplay');
  });

  it("honours the node's own always-replay policy over a resume-capable row", () => {
    expect(selectResumeStrategy(rowFor('claude'), 'always-replay')).toBe('ResumeByReplay');
    expect(selectResumeStrategy(rowFor('claude'), 'native-if-available')).toBe('ResumeNative');
  });

  it('never reads loadSession: it is not resume (EPIC-05-S21 scenario 1)', () => {
    // The trap this exists to close: `loadSession` is `true` on all five probed
    // adapters and is semantically different — it streams the whole history
    // back as notifications.
    const loadOnly = rowFor('gemini', {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    expect(selectResumeStrategy(loadOnly)).toBe('ResumeByReplay');
  });
});

suite('the selection logic names no vendor (EPIC-05-S19 scenario 4)', () => {
  it('has no vendor string literal in its source', () => {
    const source = readFileSync(new URL('../src/resume.ts', import.meta.url), 'utf8')
      // Prose is exempt: explaining *why* two of five cannot resume is how the
      // next reader understands the rule. A comment cannot route a node.
      .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(source).not.toMatch(/claude|codex|gemini|copilot|opencode/i);
  });
});

suite('the poisoning guard reads both halves of the binary identity (EPIC-05-S20)', () => {
  const recorded = { version: '0.146.0', sha256: 'a'.repeat(64) };

  it('is silent when both match', () => {
    expect(binaryDrift(recorded, { ...recorded })).toEqual([]);
  });

  it('sees a version bump', () => {
    expect(binaryDrift(recorded, { ...recorded, version: '0.150.0' })).toEqual(['version']);
  });

  it('sees a sha change at an unchanged version', () => {
    // A locally patched or partially reinstalled binary still reporting the old
    // version string is exactly the case a version-only check misses.
    expect(binaryDrift(recorded, { ...recorded, sha256: 'b'.repeat(64) })).toEqual(['sha256']);
  });

  it('sees both, in a stable order', () => {
    expect(binaryDrift(recorded, { version: '0.150.0', sha256: 'b'.repeat(64) })).toEqual([
      'version',
      'sha256',
    ]);
  });
});

suite('the operator prompt says what changed and what it risks (EPIC-05-S20)', () => {
  const recorded = { version: '0.146.0', sha256: `a${'0'.repeat(63)}` };
  const current = { version: '0.150.0', sha256: `b${'0'.repeat(63)}` };
  const payload = crossVersionGatePrompt({
    node: NODE,
    recorded,
    current,
    drift: ['version', 'sha256'],
  });

  it('is a valid human.requested payload', () => {
    expect(() => HumanRequestedSchema.parse(payload)).not.toThrow();
  });

  it('names the recorded version, the current version and the risk', () => {
    expect(payload.prompt).toContain('0.146.0');
    expect(payload.prompt).toContain('0.150.0');
    expect(payload.prompt).toMatch(/corrupt/i);
  });

  it('offers refuse first, and exactly one override', () => {
    expect(payload.options[0]?.id).toBe(RESUME_REFUSE_OPTION_ID);
    expect(payload.options[0]?.effect).toBe('reject');
    expect(payload.options.filter((option) => option.effect === 'approve')).toHaveLength(1);
    expect(payload.options.at(-1)?.id).toBe(RESUME_OVERRIDE_OPTION_ID);
    expect(RESUME_GATE_OPTIONS).toEqual(payload.options);
  });
});

suite('the refusal is a typed failure, not a throw (AC5)', () => {
  const failure = crossVersionRefusal({
    node: NODE,
    recorded: { version: '0.146.0', sha256: 'a'.repeat(64) },
    current: { version: '0.150.0', sha256: 'b'.repeat(64) },
    drift: ['version'],
  });

  it('is a NodeFailureError the scheduler can act on', () => {
    expect(failure).toBeInstanceOf(NodeFailureError);
    // A gate, not a retry: no automatic action is correct here, and a
    // transient class would invite one.
    expect(failure.deflowFailure.class).toBe('gate');
  });

  it('carries the recorded and the current identity in detail', () => {
    expect(failure.deflowFailure.detail).toMatchObject({
      recordedVersion: '0.146.0',
      currentVersion: '0.150.0',
      drift: ['version'],
    });
  });
});
