/**
 * KAR-05.3 — the verified provider table, encoded once.
 *
 * Everything here is pure: which binary speaks ACP for a vendor, which argv it
 * wants, and which environment entries it needs. The spawn itself, the typed
 * resolution failure and the deprecated-flag retry are claims about a real
 * child process and live in `test/integration/spawn-strategy.test.ts`.
 *
 * The argv table is a **golden snapshot** on purpose (AC2). Vendor flags churn
 * — three breakages were already visible on 2026-08-02 — and the point of the
 * snapshot is not that the values are right today but that changing any of them
 * shows up as a reviewable diff rather than as a quiet edit inside a spawn call.
 *
 * Verifies: EPIC-05-S10 · AC1, AC2, AC3, AC6, AC7 · test plan #1, #2, #7
 */
import { ProviderIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  PROVIDER_SPECS,
  type ProviderSpec,
  providerSpec,
  renderAuthMethods,
  reportAvailability,
  spawnPlan,
} from '../src/index.ts';

/** A resolution as the capability row would have recorded it. */
const RESOLVED = '/opt/DeFlow/bin';
const WORKTREE = '/tmp/DeFlow/wt/n1';

function planFor(spec: ProviderSpec, variant = 0): ReturnType<typeof spawnPlan> {
  return spawnPlan(spec, {
    resolved: {
      provider: spec.id,
      path: `${RESOLVED}/${spec.bin}`,
      ...(spec.companionBin === undefined
        ? {}
        : { companionPath: `${RESOLVED}/${spec.companionBin}` }),
    },
    worktree: WORKTREE,
    variant,
  });
}

suite('one entry per vendor, not one code path per vendor (AC1)', () => {
  it('covers exactly the five verified providers', () => {
    expect(Object.keys(PROVIDER_SPECS).toSorted()).toEqual([
      'claude',
      'codex',
      'copilot',
      'gemini',
      'opencode',
    ]);
  });

  it('every spec declares id, kind, resolve, argv and env', () => {
    for (const spec of Object.values(PROVIDER_SPECS)) {
      expect(spec.id).toBe(ProviderIdSchema.parse(spec.id));
      expect(['native', 'adapter']).toContain(spec.kind);
      expect(typeof spec.resolve).toBe('function');
      expect(typeof spec.argv).toBe('function');
      expect(typeof spec.env).toBe('function');
    }
  });

  it('looks a spec up by id and answers nothing for an unknown vendor', () => {
    expect(providerSpec('gemini')?.kind).toBe('native');
    expect(providerSpec('some-agent-that-does-not-exist')).toBeUndefined();
  });
});

suite('the argv table is a golden snapshot (AC2)', () => {
  it('spawns each vendor exactly the way 2026-08-02 verified', () => {
    const table = Object.values(PROVIDER_SPECS).map((spec) => {
      const plan = planFor(spec);
      return {
        provider: spec.id,
        kind: spec.kind,
        package: spec.package,
        command: plan.command,
        argv: plan.argv,
        env: plan.env,
      };
    });
    expect(table).toMatchSnapshot();
  });

  it("opencode's is a subcommand, not a flag", () => {
    const argv = planFor(PROVIDER_SPECS.opencode).argv;
    expect(argv[0]).toBe('acp');
    expect(argv[0]?.startsWith('--')).toBe(false);
    expect(argv).toEqual(['acp', '--cwd', WORKTREE]);
  });

  it('passes the worktree to the one vendor that takes it, and to no other', () => {
    const carrying = Object.values(PROVIDER_SPECS).filter((spec) =>
      planFor(spec).argv.includes(WORKTREE),
    );
    expect(carrying.map((spec) => spec.id)).toEqual(['opencode']);
  });
});

suite(
  'Claude Code and Codex do not speak ACP — verified absent from claude --help v2.1.220 and codex --help v0.146.0',
  () => {
    it('spawns the adapter package, never the vendor CLI', () => {
      for (const spec of Object.values(PROVIDER_SPECS)) {
        if (spec.kind !== 'adapter') continue;
        const plan = planFor(spec);
        expect(plan.command).toBe(`${RESOLVED}/${spec.bin}`);
        expect(plan.command.endsWith('-acp')).toBe(true);
        expect(plan.command).not.toBe(`${RESOLVED}/${spec.companionBin ?? 'unset'}`);
      }
    });

    it('names the community-maintained adapter package for each', () => {
      expect(PROVIDER_SPECS.claude.package).toBe('@agentclientprotocol/claude-agent-acp');
      expect(PROVIDER_SPECS.codex.package).toBe('@agentclientprotocol/codex-acp');
    });
  },
);

suite('no spec relies on PATH (AC3)', () => {
  it("codex's env points CODEX_PATH at the resolved absolute codex binary", () => {
    const env = planFor(PROVIDER_SPECS.codex).env;
    expect(env.CODEX_PATH).toBe(`${RESOLVED}/codex`);
    expect(env.CODEX_PATH?.startsWith('/')).toBe(true);
  });

  it('a codex plan without a resolved companion is refused rather than left to PATH', () => {
    expect(() =>
      spawnPlan(PROVIDER_SPECS.codex, {
        resolved: { provider: PROVIDER_SPECS.codex.id, path: `${RESOLVED}/codex-acp` },
        worktree: WORKTREE,
      }),
    ).toThrow(/CODEX_PATH/);
  });

  it('every command in the table is absolute', () => {
    for (const spec of Object.values(PROVIDER_SPECS)) {
      expect(planFor(spec).command.startsWith('/')).toBe(true);
    }
  });
});

suite("gemini's deprecated flag is data, not a second code path (AC5)", () => {
  it('offers --acp first and --experimental-acp as the one fallback', () => {
    expect(planFor(PROVIDER_SPECS.gemini, 0).argv).toEqual(['--acp']);
    expect(planFor(PROVIDER_SPECS.gemini, 1).argv).toEqual(['--experimental-acp']);
    expect(PROVIDER_SPECS.gemini.argvVariants).toBe(2);
  });

  it('is the only vendor with a fallback at all', () => {
    const withFallback = Object.values(PROVIDER_SPECS).filter((spec) => spec.argvVariants > 1);
    expect(withFallback.map((spec) => spec.id)).toEqual(['gemini']);
  });

  it('does not invent a third attempt', () => {
    expect(() => planFor(PROVIDER_SPECS.gemini, 2)).toThrow(/variant/i);
  });
});

suite('authMethods is rendered for the operator, never run (AC7, test plan #7)', () => {
  /** Copilot's shape, as captured from its `initialize` response on 2026-08-02. */
  const copilotAuth = JSON.stringify({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [
      {
        id: 'terminal',
        name: 'Log in with GitHub',
        description: 'Runs the login flow in your terminal',
        _meta: { 'terminal-auth': { command: '/opt/DeFlow/bin/copilot', args: ['login'] } },
      },
    ],
  });

  it('renders the _meta["terminal-auth"] block as one shell command', () => {
    const rendered = renderAuthMethods(copilotAuth);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.methodId).toBe('terminal');
    expect(rendered[0]?.name).toBe('Log in with GitHub');
    expect(rendered[0]?.command).toBe('/opt/DeFlow/bin/copilot login');
  });

  it('quotes an argument that would otherwise be two words when the operator pastes it', () => {
    const rendered = renderAuthMethods(
      JSON.stringify({
        authMethods: [
          {
            id: 'terminal',
            name: 'Log in',
            _meta: { 'terminal-auth': { command: '/opt/x/cli', args: ['login', 'a b', "it's"] } },
          },
        ],
      }),
    );
    expect(rendered[0]?.command).toBe(`/opt/x/cli login 'a b' 'it'\\''s'`);
  });

  it('renders nothing for an agent that is already authenticated', () => {
    // `claude-agent-acp` answered `"authMethods": []` — AR-1 working as intended.
    expect(renderAuthMethods(JSON.stringify({ authMethods: [] }))).toEqual([]);
  });

  it('renders an auth method that carries no terminal-auth block as a name only', () => {
    const rendered = renderAuthMethods(
      JSON.stringify({ authMethods: [{ id: 'oauth', name: 'Log in with OAuth' }] }),
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.command).toBeNull();
  });

  it('survives a capsJson that is not an object without throwing', () => {
    expect(renderAuthMethods('null')).toEqual([]);
    expect(renderAuthMethods('not json at all')).toEqual([]);
  });

  suite('a missing provider degrades the plan rather than killing the run (AC6, NF7)', () => {
    it('reports an unauthenticated provider as unavailable, with the command to run', () => {
      const report = reportAvailability(PROVIDER_SPECS.copilot, {
        binaryPath: '/opt/DeFlow/bin/copilot',
        capsJson: copilotAuth,
      });
      expect(report.provider).toBe('copilot');
      expect(report.status).toBe('unauthenticated');
      expect(report.login[0]?.command).toBe('/opt/DeFlow/bin/copilot login');
      expect(report.detail).toMatch(/copilot/);
    });

    it('reports an authenticated, resolved provider as available', () => {
      const report = reportAvailability(PROVIDER_SPECS.claude, {
        binaryPath: '/opt/DeFlow/bin/claude-agent-acp',
        capsJson: JSON.stringify({ authMethods: [] }),
      });
      expect(report.status).toBe('available');
      expect(report.login).toEqual([]);
    });

    it('reports a provider that was never probed as not installed', () => {
      const report = reportAvailability(PROVIDER_SPECS.gemini, {});
      expect(report.status).toBe('not-installed');
      expect(report.binaryPath).toBeNull();
      expect(report.detail).toMatch(/gemini/);
    });
  });
});
