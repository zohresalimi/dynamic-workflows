/**
 * KAR-05.2 — the capability query API, answered only from a probed row.
 *
 * This file lives under `test/` rather than beside the module in `src/`, and
 * that placement is part of the story: `test/no-capability-table.test.ts`
 * greps every file under `packages/adapters/src/` for a literal
 * provider-to-capability mapping, and the expectation table below — five
 * vendors against five answers — is exactly the shape that grep exists to
 * keep out of the shipped source. Here it is an assertion about a fixture;
 * there it would be the routing layer's opinion.
 *
 * The rows are built from `@DeFlow/mock-agent`'s `CAPABILITY_PROFILES`, which
 * is itself generated from `fixtures/capability-matrix.json` — the exact
 * `agentCapabilities` block each of the five adapters returned on 2026-08-02.
 * Nothing here re-types what an agent said.
 *
 * Verifies: EPIC-05-S7 · AC5, AC6 · test plan #3, #4
 */
import { ProviderIdSchema } from '@DeFlow/core';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import {
  additionalDirectories,
  type CapabilityRow,
  canFork,
  canList,
  canResume,
  capability,
  loadSession,
  mcpAcp,
  mediatedExecution,
  supportsTerminal,
} from '../src/index.ts';

/** A row as the probe would have written it for `profile`. */
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

suite('each adapter row answers the routing questions (EPIC-05-S7)', () => {
  const expected = [
    { row: claude, resume: true, fork: true, list: true, acp: undefined },
    { row: codex, resume: true, fork: false, list: true, acp: false },
    { row: opencode, resume: true, fork: true, list: true, acp: undefined },
    { row: copilot, resume: false, fork: false, list: true, acp: undefined },
    { row: gemini, resume: false, fork: false, list: false, acp: undefined },
  ];

  for (const { row, resume, fork, list, acp } of expected) {
    it(`${row.provider}: resume=${resume} fork=${fork} list=${list} mcpAcp=${String(acp)}`, () => {
      expect(canResume(row)).toBe(resume);
      expect(canFork(row)).toBe(fork);
      expect(canList(row)).toBe(list);
      expect(mcpAcp(row)).toBe(acp);
      // Universally advertised, and semantically *not* resume (§5.2).
      expect(loadSession(row)).toBe(true);
    });
  }

  it('exactly two of the five cannot resume, so two are routed to replay', () => {
    const cannot = expected.filter(({ row }) => !canResume(row)).map(({ row }) => row.provider);
    expect(cannot).toEqual(['copilot', 'gemini']);
  });
});

suite('absent, empty and explicitly false are three different answers (AC6)', () => {
  it('gemini has no sessionCapabilities key at all: absent, not denied', () => {
    expect(capability(gemini, 'resume')).toEqual({
      supported: undefined,
      reason: 'capability-absent',
      path: 'agentCapabilities.sessionCapabilities.resume',
    });
    expect(canResume(gemini)).toBe(false);
  });

  it("copilot's sessionCapabilities is exactly { list: {} }: fork is absent", () => {
    expect(capability(copilot, 'fork').reason).toBe('capability-absent');
    expect(canFork(copilot)).toBe(false);
  });

  it('an empty object is an advertisement, not an omission: copilot can list', () => {
    expect(capability(copilot, 'list')).toEqual({
      supported: true,
      reason: 'capability-empty',
      path: 'agentCapabilities.sessionCapabilities.list',
    });
    expect(canList(copilot)).toBe(true);
  });

  it("codex's mcpCapabilities.acp is the literal false: denied, not absent", () => {
    expect(capability(codex, 'mcpAcp')).toEqual({
      supported: false,
      reason: 'capability-denied',
      path: 'agentCapabilities.mcpCapabilities.acp',
    });
    expect(mcpAcp(codex)).toBe(false);
  });

  it("claude's is absent, and the two are distinguishable (test plan #4)", () => {
    expect(capability(claude, 'mcpAcp').reason).toBe('capability-absent');
    expect(mcpAcp(claude)).toBeUndefined();
    // The whole point: `undefined` and `false` are not the same answer, and a
    // router that treats both as falsy loses the reason it can show a human.
    expect(mcpAcp(claude)).not.toBe(mcpAcp(codex));
    expect(capability(claude, 'mcpAcp').reason).not.toBe(capability(codex, 'mcpAcp').reason);
  });

  it('null is a denial: the ACP schema types every session capability as object-or-null', () => {
    const row: CapabilityRow = {
      ...claude,
      capsJson: JSON.stringify({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: null } },
      }),
    };
    expect(capability(row, 'resume')).toMatchObject({
      supported: false,
      reason: 'capability-denied',
    });
  });

  it('an explicit true is granted, and a non-empty object is granted too', () => {
    expect(capability(claude, 'resume').reason).toBe('capability-granted');
    const row: CapabilityRow = {
      ...claude,
      capsJson: JSON.stringify({
        agentCapabilities: { sessionCapabilities: { resume: { maxAgeDays: 7 } } },
      }),
    };
    expect(capability(row, 'resume')).toMatchObject({
      supported: true,
      reason: 'capability-granted',
    });
  });
});

suite('capabilities ACP v1 does not express are absent, never invented (AC5)', () => {
  it('supportsTerminal and mediatedExecution are absent on every measured row', () => {
    for (const row of [claude, codex, opencode, copilot, gemini]) {
      expect(capability(row, 'terminal').reason).toBe('capability-absent');
      expect(supportsTerminal(row)).toBe(false);
      expect(capability(row, 'mediatedExecution').reason).toBe('capability-absent');
      expect(mediatedExecution(row)).toBeUndefined();
    }
  });

  it('reads them from _meta, which is where ACP puts what it has no field for', () => {
    const row: CapabilityRow = {
      ...claude,
      capsJson: JSON.stringify({
        agentCapabilities: { _meta: { terminal: true, mediatedExecution: false } },
      }),
    };
    expect(supportsTerminal(row)).toBe(true);
    expect(mediatedExecution(row)).toBe(false);
    expect(capability(row, 'mediatedExecution').reason).toBe('capability-denied');
  });
});

suite('a row whose caps_json cannot be read answers absent, and never throws', () => {
  it('treats unparseable text as advertising nothing', () => {
    const row: CapabilityRow = { ...claude, capsJson: 'not json at all' };
    expect(capability(row, 'resume').reason).toBe('capability-absent');
    expect(canResume(row)).toBe(false);
    expect(additionalDirectories(row)).toBe(false);
  });

  it('does not walk into a non-object on the way down the path', () => {
    const row: CapabilityRow = {
      ...claude,
      capsJson: JSON.stringify({ agentCapabilities: { sessionCapabilities: 'yes' } }),
    };
    expect(capability(row, 'resume').reason).toBe('capability-absent');
  });
});
