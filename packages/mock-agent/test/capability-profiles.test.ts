/**
 * KAR-04.4 AC2, AC3 — the six named profiles are generated from the
 * capability-matrix fixture, not typed by hand.
 *
 * The first spec is the load-bearing one: it re-parses
 * `fixtures/capability-matrix.json` independently of the module under test's
 * own cached import and asserts `CAPABILITY_PROFILES` deep-equals what
 * `generateCapabilityProfiles` produces from that fresh read. A hand-edit of
 * `CAPABILITY_PROFILES` that never touched the fixture is exactly what this
 * catches — the red condition test plan row 1 names ("profiles are a
 * hardcoded literal that has drifted").
 *
 * Verifies: KAR-04.4 · AC2, AC3 · test plan row 1
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import {
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROFILE_NAMES,
  CAPABILITY_PROFILES,
  type CapabilityMatrix,
  generateCapabilityProfiles,
} from '../src/capability-profiles.ts';

suite('AC2 — the profiles are generated from the fixture, not hand-typed', () => {
  it('CAPABILITY_PROFILES equals a fresh generation from an independently-parsed fixture', () => {
    const freshlyParsed: CapabilityMatrix = JSON.parse(
      readFileSync(CAPABILITY_MATRIX_PATH, 'utf8'),
    ) as CapabilityMatrix;
    expect(CAPABILITY_PROFILES).toEqual(generateCapabilityProfiles(freshlyParsed));
  });

  it('names exactly claude, codex, opencode, copilot, gemini and mock-full', () => {
    expect(CAPABILITY_PROFILE_NAMES).toEqual([
      'claude',
      'codex',
      'opencode',
      'copilot',
      'gemini',
      'mock-full',
    ]);
    expect(Object.keys(CAPABILITY_PROFILES).sort()).toEqual([...CAPABILITY_PROFILE_NAMES].sort());
  });

  it('rejects a matrix missing a required profile', () => {
    const { gemini: _gemini, ...withoutGemini } = {
      claude: {},
      codex: {},
      opencode: {},
      copilot: {},
      gemini: {},
      'mock-full': {},
    };
    expect(() => generateCapabilityProfiles(withoutGemini)).toThrow(/gemini/);
  });

  it('rejects a matrix with an unexpected profile name', () => {
    expect(() =>
      generateCapabilityProfiles({
        claude: {},
        codex: {},
        opencode: {},
        copilot: {},
        gemini: {},
        'mock-full': {},
        antigravity: {},
      }),
    ).toThrow(/antigravity/);
  });
});

suite('AC3 — the three shapes that break naive optional-chaining', () => {
  it('gemini omits sessionCapabilities entirely, not as an empty object', () => {
    const gemini = CAPABILITY_PROFILES.gemini as Record<string, unknown>;
    expect('sessionCapabilities' in gemini).toBe(false);
    expect(gemini['loadSession']).toBe(true);
  });

  it('copilot emits sessionCapabilities: { list: {} }, and nothing else', () => {
    const copilot = CAPABILITY_PROFILES.copilot as { sessionCapabilities: unknown };
    expect(copilot.sessionCapabilities).toEqual({ list: {} });
  });

  it('codex carries mcpCapabilities.sse and .acp as literal false, not absent', () => {
    const codex = CAPABILITY_PROFILES.codex as {
      mcpCapabilities: { sse: unknown; acp: unknown };
    };
    expect(codex.mcpCapabilities.sse).toBe(false);
    expect(codex.mcpCapabilities.acp).toBe(false);
  });
});

suite('EPIC-04-S13 — the measured matrix, row by row', () => {
  const rows: ReadonlyArray<{
    profile: 'claude' | 'codex' | 'opencode' | 'copilot' | 'gemini';
    resume: boolean | undefined;
    fork: boolean | undefined;
    list: unknown;
  }> = [
    { profile: 'claude', resume: true, fork: true, list: true },
    { profile: 'codex', resume: true, fork: undefined, list: true },
    { profile: 'opencode', resume: true, fork: true, list: true },
    { profile: 'copilot', resume: undefined, fork: undefined, list: {} },
    { profile: 'gemini', resume: undefined, fork: undefined, list: undefined },
  ];

  it.each(rows)(
    '$profile — resume $resume, fork $fork, list $list',
    ({ profile, resume, fork, list }) => {
      const caps = CAPABILITY_PROFILES[profile] as {
        sessionCapabilities?: { resume?: unknown; fork?: unknown; list?: unknown };
      };
      expect(caps.sessionCapabilities?.resume).toEqual(resume);
      expect(caps.sessionCapabilities?.fork).toEqual(fork);
      expect(caps.sessionCapabilities?.list).toEqual(list);
    },
  );
});

suite('mock-full — the synthetic everything-on profile', () => {
  it('advertises resume, fork and list', () => {
    const mockFull = CAPABILITY_PROFILES['mock-full'] as {
      sessionCapabilities: { resume: unknown; fork: unknown; list: unknown };
    };
    expect(mockFull.sessionCapabilities.resume).toBe(true);
    expect(mockFull.sessionCapabilities.fork).toBe(true);
    expect(mockFull.sessionCapabilities.list).toBe(true);
  });
});
