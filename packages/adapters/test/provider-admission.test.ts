/**
 * KAR-19.2 — admission, as a function of the probed manifest.
 *
 * Test plan #1, #3 and #4, and EPIC-19-S11 and EPIC-19-S13's unit halves.
 *
 * The red this file is written against is the reported bug, stated as a table:
 * a machine with `claude` on `PATH` and no `claude-agent-acp` has a binary on
 * `PATH`, and an admission inferred from *that* admits the run — which is what
 * the operator's afternoon was. So the rows below drive the decision from the
 * pair of resolutions the registry distinguishes (`spec.shim.bin` and
 * `spec.bin`), never from "is anything installed".
 *
 * Verifies: EPIC-19-S9, EPIC-19-S11, EPIC-19-S13 · AC1, AC2, AC3, AC4, AC6, AC7
 */
import {
  admitRun,
  MOCK_AGENT_FLAG,
  MOCK_AGENT_SENTENCE,
  type ProviderResolution,
  providerVerdict,
  RUN_REFUSAL_CODES,
} from '@DeFlow/adapters';
import { expect, it, describe as suite } from 'vitest';

/** A resolution literal, so the table is about admission and not about a
 * temp directory. `resolveProviderState` is what turns a real `PATH` into
 * one of these, and `provider-install.test.ts` covers that half. */
function resolution(over: Partial<ProviderResolution> = {}): ProviderResolution {
  return {
    provider: 'claude',
    state: 'adapter-missing',
    kind: 'adapter',
    vendorBin: 'claude',
    vendorPath: '/opt/homebrew/bin/claude',
    adapterBin: 'claude-agent-acp',
    adapterPath: null,
    package: '@agentclientprotocol/claude-agent-acp',
    ...over,
  };
}

const installed = resolution({
  state: 'installed',
  adapterPath: '/opt/homebrew/bin/claude-agent-acp',
});

const absent = resolution({
  provider: 'gemini',
  state: 'not-installed',
  kind: 'native',
  vendorBin: 'gemini',
  vendorPath: null,
  adapterBin: 'gemini',
  adapterPath: null,
  package: '@google/gemini-cli',
});

const broken = resolution({
  state: 'handshake-failed',
  adapterPath: '/opt/homebrew/bin/claude-agent-acp',
  handshakeStderr: 'Error: Cannot find module ./dist/index.js',
});

suite('admitRun — the admission reducer (AC1, AC6, AC7)', () => {
  it('admits a machine with one installed adapter, and says nothing else', () => {
    expect(admitRun([installed, absent])).toEqual({ outcome: 'admitted' });
  });

  it('refuses a vendor CLI with no ACP adapter — the reported bug', () => {
    const verdict = admitRun([resolution(), absent]);

    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    expect(verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
    expect(verdict.providers).toContainEqual({
      id: 'claude',
      state: 'adapter-missing',
      vendorPath: '/opt/homebrew/bin/claude',
      adapterPackage: '@agentclientprotocol/claude-agent-acp',
    });
  });

  it('refuses an empty machine with the same code', () => {
    const verdict = admitRun([absent]);
    expect(verdict.outcome === 'refused' && verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
  });

  it('refuses an installed-but-broken bridge with its own code (AC7)', () => {
    const verdict = admitRun([broken, absent]);

    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    expect(verdict.code).toBe(RUN_REFUSAL_CODES.handshakeFailed);
    // The child's own words, not a paraphrase of them.
    expect(verdict.message).toContain('Error: Cannot find module ./dist/index.js');
    // The resolved path of the binary that failed.
    expect(verdict.message).toContain('/opt/homebrew/bin/claude-agent-acp');
    // The worst available outcome: a broken bridge reported as an absent one.
    expect(verdict.message).not.toContain('is not installed');
  });

  it('never refuses a machine that also holds a broken bridge, if something works', () => {
    expect(admitRun([broken, installed]).outcome).toBe('admitted');
  });
});

suite('the refusal message (AC3, AC4)', () => {
  it("is doctor's own sentence, byte for byte (EPIC-19-S13)", () => {
    const verdict = admitRun([resolution(), absent]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;

    // `providerVerdict` is what `DeFlow doctor`'s Agents section prints for
    // this machine state (`packages/cli/src/doctor/agents.ts`), and the
    // refusal contains that string rather than a friendlier restatement.
    expect(verdict.message).toContain(providerVerdict(resolution()).detail);
    expect(verdict.message).not.toContain('claude is not installed');
  });

  it.each([
    ['no provider resolves at all', [absent]],
    ['vendor CLI present, adapter missing', [resolution(), absent]],
    ['adapter present, handshake failed', [broken, absent]],
  ] as const)('offers the zero-install path for %s (EPIC-19-S11)', (_state, resolutions) => {
    const verdict = admitRun([...resolutions]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;

    expect(verdict.message).toContain('DeFlow-mock-agent');
    expect(verdict.message).toContain('ships in this package');
    expect(verdict.message).toContain('no vendor CLI, no credential and no network');
    expect(verdict.message).toContain(MOCK_AGENT_FLAG);
    // AC4 — *ends* with it, so the last thing read is the way forward.
    expect(verdict.message.trimEnd().endsWith(MOCK_AGENT_SENTENCE.trimEnd())).toBe(true);
  });

  it('names the npm command for the adapter it is missing', () => {
    const verdict = admitRun([resolution()]);
    expect(verdict.outcome === 'refused' && verdict.message).toContain(
      'npm install -g @agentclientprotocol/claude-agent-acp',
    );
  });
});
