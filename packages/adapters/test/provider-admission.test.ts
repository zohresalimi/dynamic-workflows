/**
 * KAR-19.2 — admission, as a function of the probed manifest.
 *
 * Test plan #1, #3 and #4, and EPIC-19-S11 and EPIC-19-S13's unit halves.
 *
 * The red this file was written against is the reported bug, stated as a table:
 * a machine with `claude` on `PATH` and no `claude-agent-acp` has a binary on
 * `PATH`, and an admission inferred from *that* admits the run — which is what
 * the operator's afternoon was. So the rows below drive the decision from the
 * pair of resolutions the registry distinguishes (`spec.shim.bin` and
 * `spec.bin`), never from "is anything installed".
 *
 * ## Amended 2026-08-13 by KAR-19.10
 *
 * AC1's *"resolves to a spawnable adapter"* is now route-aware, and the row
 * that changed is the second one. A vendor CLI with no ACP bridge is **not**
 * refused any more: it can frame, survey and plan through the exec shim — that
 * is the route every schema-bearing pre-execution turn actually takes — so it
 * is admitted *for the turns that route serves*, with the turn it cannot reach
 * named at submission. The refusal it used to get was a true sentence about the
 * machine and a false one about the run, which is how `doctor` and the run came
 * to disagree on 2026-08-13.
 *
 * What did not change is the rule underneath: the decision comes from the two
 * resolutions and never from "is anything installed", and a machine that can
 * serve nothing is still refused before the 201 with `doctor`'s own words. The
 * amendment is recorded in `docs/delivery/epics/EPIC-19-live-run-pipeline.md`
 * under KAR-19.2, per `docs/delivery/README.md` §9.
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
    bundled: false,
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
  it('admits a machine with one installed adapter, and warns about nothing', () => {
    const verdict = admitRun([installed, absent]);
    expect(verdict.outcome).toBe('admitted');
    if (verdict.outcome !== 'admitted') return;
    expect(verdict.chosen?.provider).toBe('claude');
    // Both routes open, so there is nothing this machine cannot do and nothing
    // to say about it beyond the announcement itself.
    expect(verdict.limitation).toBeNull();
  });

  it('admits a vendor CLI with no ACP adapter, for the turns the shim serves', () => {
    // KAR-19.10's amendment to AC1, and the row this file used to assert the
    // opposite of. `chooseProvider` takes `spec.shim.bin` on purpose, so
    // refusing here would have meant refusing the path the whole pre-execution
    // chain runs on — and the run selected it regardless, silently, which is
    // the defect rather than the fix.
    const verdict = admitRun([resolution(), absent]);

    expect(verdict.outcome).toBe('admitted');
    if (verdict.outcome !== 'admitted') return;
    expect(verdict.chosen?.route).toBe('shim');
    expect(verdict.chosen?.unserved).toEqual(['node execution']);
    expect(verdict.limitation).toContain('node execution');
    // KAR-18.8's install sentence is unchanged and stays attached to the
    // missing ACP route, because agent-node execution still needs the bridge.
    expect(verdict.limitation).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
  });

  it('refuses an empty machine with the same code', () => {
    const verdict = admitRun([absent]);
    expect(verdict.outcome === 'refused' && verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
  });

  it('refuses a machine whose only binary is a bridge over nothing', () => {
    // The degenerate case KAR-18.8 named: `claude-agent-acp` with no `claude`
    // underneath it bridges to nothing, so neither route is open and there is
    // no turn to admit.
    const bridgeOverNothing = resolution({
      state: 'not-installed',
      vendorPath: null,
      adapterPath: '/opt/homebrew/bin/claude-agent-acp',
    });
    const verdict = admitRun([bridgeOverNothing]);

    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    expect(verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
    expect(verdict.providers).toContainEqual({
      id: 'claude',
      state: 'not-installed',
      vendorPath: null,
      adapterPackage: '@agentclientprotocol/claude-agent-acp',
    });
  });

  it('refuses an installed-but-broken bridge with its own code, when it is the one asked for', () => {
    // AC7's vocabulary, on the path KAR-19.10 left it reachable from. A broken
    // bridge over a working vendor CLI can still frame, so the machine is not
    // refused — but an operator who named it explicitly is refused rather than
    // quietly given three turns and a dead node, and the code is still the
    // specific one: this is a repair, not an install.
    const verdict = admitRun([broken, absent], { provider: 'claude' });

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
    const verdict = admitRun([absent]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;

    // `providerVerdict` is what `DeFlow doctor`'s Agents section prints for
    // this machine state (`packages/cli/src/doctor/agents.ts`), and the
    // refusal contains that string rather than a friendlier restatement.
    expect(verdict.message).toContain(providerVerdict(absent).detail);
  });

  it('never says a resolved vendor CLI is not installed', () => {
    const verdict = admitRun([resolution(), absent], { provider: 'claude' });
    expect(verdict.outcome === 'refused' && verdict.message).not.toContain(
      'claude is not installed',
    );
  });

  it.each([
    ['no provider resolves at all', [absent], undefined],
    ['a vendor CLI whose bridge the operator asked for', [resolution(), absent], 'claude'],
    ['a bridge that is present and did not answer', [broken, absent], 'claude'],
  ] as const)('offers the zero-install path for %s (EPIC-19-S11)', (_state, resolutions, named) => {
    const verdict = admitRun([...resolutions], named === undefined ? {} : { provider: named });
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
    const verdict = admitRun([resolution()], { provider: 'claude' });
    expect(verdict.outcome === 'refused' && verdict.message).toContain(
      'npm install -g @agentclientprotocol/claude-agent-acp',
    );
  });
});
