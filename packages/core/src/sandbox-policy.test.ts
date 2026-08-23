/**
 * KAR-08.5 — the sandbox policy generator, one level at a time.
 *
 * Everything here is a claim about a *document*: what DeFlow hands the vendor
 * CLI so that the vendor's own enforcement engine matches the level the
 * operator chose (D12). No process is spawned and no vendor CLI is installed —
 * the injection of these documents onto a real argv is
 * `packages/adapters/test/integration/sandbox-injection.test.ts`, and this
 * file is the specification of what gets injected.
 *
 * The Examples tables from EPIC-08-S21, EPIC-08-S22, EPIC-08-S24 and
 * EPIC-08-S25 are written out literally rather than assembled from the
 * constants the implementation uses: a table built by the code under test
 * agrees with itself no matter what it produces.
 *
 * Verifies: EPIC-08-S21, EPIC-08-S22, EPIC-08-S23, EPIC-08-S24, EPIC-08-S25 ·
 * AC2, AC3, AC4, AC6, AC7, AC8 · test plan #1, #2, #6, #7
 */
import { expect, it, describe as suite } from 'vitest';
import { NEVER_IMPLICIT_FAMILIES } from './never-implicit.ts';
import { decidePermission } from './permission.ts';
import { PERMISSION_LEVELS, type PermissionLevel } from './plan-graph.ts';
import {
  CLAUDE_SANDBOX_GATES,
  CODEX_WORKSPACE_WRITE_KEYS,
  claudeSandboxPolicy,
  codexSandboxPolicy,
  compareVersions,
  SANDBOX_CREDENTIAL_FILES,
  SANDBOX_RUNTIME_BIN,
  SANDBOX_RUNTIME_PACKAGE,
  SANDBOX_RUNTIME_VERSION,
  sandboxDependencies,
  sandboxRuntimeConfig,
  sandboxStrategy,
} from './sandbox-policy.ts';

/** The version the whole invocation table was verified against on 2026-08-02,
 * and the only one high enough to clear every gate in `CLAUDE_SANDBOX_GATES`. */
const CURRENT = '2.1.220';
const WORKTREE = '/tmp/DeFlow/wt/n1';
const DOMAINS = ['registry.npmjs.org', 'github.com'] as const;

const NON_FULL: readonly PermissionLevel[] = ['read', 'worktree', 'worktree+net'];

function claude(level: PermissionLevel, version = CURRENT): Record<string, unknown> {
  return claudeSandboxPolicy({
    level,
    worktree: WORKTREE,
    version,
    allowedDomains: DOMAINS,
  }).settings.sandbox as unknown as Record<string, unknown>;
}

suite('EPIC-08-S21 — the two keys, or the ladder is decorative (AC2)', () => {
  for (const level of NON_FULL) {
    it(`${level}: enabled, failIfUnavailable, allowUnsandboxedCommands`, () => {
      const sandbox = claude(level);

      expect(sandbox.enabled).toBe(true);
      expect(sandbox.failIfUnavailable).toBe(true);
      expect(sandbox.allowUnsandboxedCommands).toBe(false);
    });
  }

  it('full says the sandbox is off, rather than leaving the two keys unset', () => {
    // The distinction is the whole point of the scenario. `enabled: false` is
    // a statement the operator opted into; an *absent* `failIfUnavailable`
    // beside `enabled: true` is a sandbox that silently is not there.
    expect(claude('full')).toEqual({ enabled: false });
  });

  it('every level is covered, so a fifth rung cannot be added without a policy', () => {
    for (const level of PERMISSION_LEVELS) expect(() => claude(level)).not.toThrow();
  });
});

suite('EPIC-08-S23 — the credential deny list the vendor does not ship (AC3)', () => {
  const REQUIRED = ['~/.aws/credentials', '~/.ssh/**', '~/.config/gh/**', '~/Library/Keychains/**'];

  it('names all four paths, and nothing shorter counts', () => {
    expect([...SANDBOX_CREDENTIAL_FILES]).toEqual(REQUIRED);
  });

  for (const level of NON_FULL) {
    it(`${level}: denies every credential path with mode deny`, () => {
      const credentials = claude(level).credentials as {
        files: { mode: string; paths: string[] };
      };

      expect(credentials.files.mode).toBe('deny');
      for (const path of REQUIRED) expect(credentials.files.paths).toContain(path);
    });
  }

  it('populates envVars from the never-implicit families of EPIC-08-S16', () => {
    const credentials = claude('worktree').credentials as {
      envVars: { mode: string; names: string[] };
    };

    expect(credentials.envVars.names).toEqual([...NEVER_IMPLICIT_FAMILIES]);
    // `mask` rather than `deny`: a variable the child cannot read at all
    // produces a confusing failure inside the agent, and a masked one produces
    // a value that cannot be used. Both keep the secret; only one is legible.
    expect(credentials.envVars.mode).toBe('mask');
  });

  it('defence in depth: DeFlow denies the same paths itself, independently', () => {
    // The vendor layer belongs to someone else's release cycle, so the claim
    // worth testing is that removing it would change nothing about DeFlow's
    // own answer. KAR-08.2's mediation denies these paths because they are
    // outside the worktree, with no knowledge of this file's list.
    for (const path of ['/home/u/.ssh/id_rsa', '/home/u/.aws/credentials']) {
      const answer = decidePermission(
        'worktree',
        { method: 'fs/read_text_file', path },
        {
          worktree: WORKTREE,
          allowlist: [],
          readOnlyCommands: [],
          allowedDomains: [],
          scrubbedEnv: [],
        },
      );
      expect(answer.outcome).toBe('deny');
    }
  });
});

suite('EPIC-08-S24 — one ladder, two vendor dialects (AC4)', () => {
  it('read: filesystem read-only, and no allowedDomains', () => {
    const sandbox = claude('read');
    const filesystem = sandbox.filesystem as { allowWrite: string[] };
    const network = sandbox.network as { allowedDomains: string[] };

    expect(filesystem.allowWrite).toEqual([]);
    expect(network.allowedDomains).toEqual([]);
  });

  it('worktree: allowWrite is the worktree, and still no egress', () => {
    const sandbox = claude('worktree');

    expect((sandbox.filesystem as { allowWrite: string[] }).allowWrite).toEqual([WORKTREE]);
    expect((sandbox.network as { allowedDomains: string[] }).allowedDomains).toEqual([]);
  });

  it('worktree+net: adds network.allowedDomains and nothing else', () => {
    const net = claude('worktree+net');
    const worktree = claude('worktree');

    expect((net.network as { allowedDomains: string[] }).allowedDomains).toEqual([...DOMAINS]);
    expect(net.filesystem).toEqual(worktree.filesystem);
  });

  const CODEX_MODES: Readonly<Record<PermissionLevel, string>> = {
    read: 'read-only',
    worktree: 'workspace-write',
    'worktree+net': 'workspace-write',
    full: 'danger-full-access',
  };

  for (const [level, mode] of Object.entries(CODEX_MODES)) {
    it(`codex ${level}: sandbox_mode ${mode}`, () => {
      const policy = codexSandboxPolicy({
        level: level as PermissionLevel,
        worktree: WORKTREE,
        allowedDomains: DOMAINS,
      });
      expect(policy.sandbox_mode).toBe(mode);
    });
  }

  it('codex network_access follows the ladder, not the mode', () => {
    const off = codexSandboxPolicy({ level: 'worktree', worktree: WORKTREE });
    const on = codexSandboxPolicy({ level: 'worktree+net', worktree: WORKTREE });

    expect(off.sandbox_workspace_write?.network_access).toBe(false);
    expect(on.sandbox_workspace_write?.network_access).toBe(true);
  });

  it('codex workspace-write uses only the four keys verified from the Rust source', () => {
    const section = codexSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
    }).sandbox_workspace_write;

    expect(Object.keys(section ?? {}).sort()).toEqual([...CODEX_WORKSPACE_WRITE_KEYS].sort());
    expect(section?.writable_roots).toEqual([WORKTREE]);
  });

  it('codex read-only and danger-full-access carry no workspace-write section', () => {
    expect(codexSandboxPolicy({ level: 'read', worktree: WORKTREE }).sandbox_workspace_write).toBe(
      undefined,
    );
    expect(codexSandboxPolicy({ level: 'full', worktree: WORKTREE }).sandbox_workspace_write).toBe(
      undefined,
    );
  });
});

suite('EPIC-08-S22 — version-gated keys fail closed (AC6)', () => {
  it('states each gate at the granularity the vendor ships it', () => {
    expect(CLAUDE_SANDBOX_GATES).toEqual({
      'sandbox.credentials': '2.1.187',
      'sandbox.credentials.envVars.mode.mask': '2.1.199',
      'sandbox.filesystem.disabled': '2.1.216',
      'sandbox.network.strictAllowlist': '2.1.219',
    });
  });

  it('2.1.186: anything credential-related refuses to schedule, by default', () => {
    expect(() => claude('worktree', '2.1.186')).toThrow(/credential/i);
  });

  it('2.1.190: sandbox.credentials is included', () => {
    expect(claude('worktree', '2.1.190').credentials).toBeDefined();
  });

  it('2.1.190: the mask mode is omitted, with a degraded record', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.190',
    });
    const credentials = policy.settings.sandbox.credentials as { envVars?: unknown };

    expect(credentials.envVars).toBe(undefined);
    expect(policy.degraded).toContainEqual({
      key: 'sandbox.credentials.envVars.mode.mask',
      detected: '2.1.190',
      required: '2.1.199',
    });
  });

  it('2.1.200: the mask mode is included', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.200',
    });
    const credentials = policy.settings.sandbox.credentials as { envVars?: unknown };

    expect(credentials.envVars).toBeDefined();
    expect(policy.degraded.map((entry) => entry.key)).not.toContain(
      'sandbox.credentials.envVars.mode.mask',
    );
  });

  it('2.1.215: filesystem.disabled is omitted, with a degraded record', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.215',
    });
    const filesystem = policy.settings.sandbox.filesystem as { disabled?: unknown };

    expect(filesystem.disabled).toBe(undefined);
    expect(policy.degraded).toContainEqual({
      key: 'sandbox.filesystem.disabled',
      detected: '2.1.215',
      required: '2.1.216',
    });
  });

  it('2.1.216: filesystem.disabled is included', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.216',
    });
    expect((policy.settings.sandbox.filesystem as { disabled?: unknown }).disabled).toBe(false);
  });

  it('2.1.218: strictAllowlist is omitted, with a degraded record', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.218',
    });
    const network = policy.settings.sandbox.network as { strictAllowlist?: unknown };

    expect(network.strictAllowlist).toBe(undefined);
    expect(policy.degraded).toContainEqual({
      key: 'sandbox.network.strictAllowlist',
      detected: '2.1.218',
      required: '2.1.219',
    });
  });

  it('2.1.220: strictAllowlist is included', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.220',
    });
    expect((policy.settings.sandbox.network as { strictAllowlist?: unknown }).strictAllowlist).toBe(
      true,
    );
  });

  it('relaxing the credential refusal takes an explicit configuration', () => {
    const policy = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.186',
      onGateUnmet: 'degrade',
    });

    expect(policy.settings.sandbox.credentials).toBe(undefined);
    expect(policy.degraded).toContainEqual({
      key: 'sandbox.credentials',
      detected: '2.1.186',
      required: '2.1.187',
    });
  });

  it('the version is an input, never a constant this module compares against', () => {
    // The mechanical form of the mistake is a default parameter. Asking for a
    // policy without a version must not compile — and at runtime, the same
    // level at two versions must be able to differ.
    const older = claudeSandboxPolicy({
      level: 'worktree',
      worktree: WORKTREE,
      version: '2.1.215',
    });
    const newer = claudeSandboxPolicy({ level: 'worktree', worktree: WORKTREE, version: CURRENT });

    expect(older.settings).not.toEqual(newer.settings);
  });

  it('compares versions numerically, not as strings', () => {
    // '2.1.9' > '2.1.187' lexicographically, and that is the bug this exists
    // to prevent.
    expect(compareVersions('2.1.9', '2.1.187')).toBeLessThan(0);
    expect(compareVersions('2.1.187', '2.1.187')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
  });
});

suite('EPIC-08-S25 — never nest a sandbox around a CLI that already sandboxes (AC7)', () => {
  /**
   * EPIC-08-S25's Examples table. It spells Claude Code `claude-code`; this
   * repository's `ProviderId` for the same vendor is `claude` (KAR-05.3's
   * registry), so both spellings are asserted rather than one silently
   * standing in for the other.
   */
  const STRATEGIES: Readonly<Record<string, string>> = {
    'claude-code': 'vendor',
    claude: 'vendor',
    codex: 'vendor',
    gemini: 'sandbox-runtime',
    copilot: 'sandbox-runtime',
    cursor: 'sandbox-runtime',
    opencode: 'sandbox-runtime',
  };

  for (const [provider, strategy] of Object.entries(STRATEGIES)) {
    it(`${provider} → ${strategy}`, () => {
      expect(sandboxStrategy(provider)).toBe(strategy);
    });
  }

  it('the strategy set is a partition, not an overlay', () => {
    // "Never both" has to be a property of the type, not of a convention: one
    // total function returning one of two values cannot assign both.
    for (const provider of ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'opencode']) {
      const strategy = sandboxStrategy(provider);
      expect(['vendor', 'sandbox-runtime']).toContain(strategy);
    }
  });

  it('an unknown provider is wrapped rather than trusted', () => {
    expect(sandboxStrategy('a-cli-nobody-has-audited')).toBe('sandbox-runtime');
  });

  it('pins sandbox-runtime exactly, and treats its API as unstable', () => {
    expect(SANDBOX_RUNTIME_PACKAGE).toBe('@anthropic-ai/sandbox-runtime');
    expect(SANDBOX_RUNTIME_VERSION).toBe('0.0.67');
    expect(SANDBOX_RUNTIME_VERSION).not.toMatch(/^[\^~><=]/);
    expect(SANDBOX_RUNTIME_BIN).toBe('srt');
  });

  it('the wrapper config follows the same ladder', () => {
    expect(
      sandboxRuntimeConfig({ level: 'read', worktree: WORKTREE })?.filesystem.allowWrite,
    ).toEqual([]);
    expect(
      sandboxRuntimeConfig({ level: 'worktree', worktree: WORKTREE })?.filesystem.allowWrite,
    ).toEqual([WORKTREE]);
    expect(
      sandboxRuntimeConfig({ level: 'worktree+net', worktree: WORKTREE, allowedDomains: DOMAINS })
        ?.network.allowedDomains,
    ).toEqual([...DOMAINS]);
    expect(
      sandboxRuntimeConfig({ level: 'worktree', worktree: WORKTREE })?.filesystem.denyRead,
    ).toEqual([...SANDBOX_CREDENTIAL_FILES]);
  });

  it('full is not wrapped at all, rather than wrapped with everything open', () => {
    expect(sandboxRuntimeConfig({ level: 'full', worktree: WORKTREE })).toBe(null);
  });
});

suite('the platform dependencies a level actually needs (AC5)', () => {
  it('linux needs bubblewrap and socat below full', () => {
    for (const level of NON_FULL) {
      expect(sandboxDependencies({ level, platform: 'linux' })).toEqual(['bwrap', 'socat']);
    }
  });

  it('linux at full needs nothing, because nothing is enforced', () => {
    expect(sandboxDependencies({ level: 'full', platform: 'linux' })).toEqual([]);
  });

  it('macOS ships Seatbelt, so there is nothing to install', () => {
    expect(sandboxDependencies({ level: 'worktree', platform: 'darwin' })).toEqual([]);
  });
});

suite('the generated policy is a golden file (AC8)', () => {
  for (const level of PERMISSION_LEVELS) {
    it(`claude ${level}`, () => {
      expect(
        claudeSandboxPolicy({
          level,
          worktree: WORKTREE,
          version: CURRENT,
          allowedDomains: DOMAINS,
        }),
      ).toMatchSnapshot();
    });

    it(`codex ${level}`, () => {
      expect(
        codexSandboxPolicy({ level, worktree: WORKTREE, allowedDomains: DOMAINS }),
      ).toMatchSnapshot();
    });

    it(`sandbox-runtime ${level}`, () => {
      expect(
        sandboxRuntimeConfig({ level, worktree: WORKTREE, allowedDomains: DOMAINS }),
      ).toMatchSnapshot();
    });
  }
});

suite('connector permissions ride in the same settings document', () => {
  const RULES = {
    allow: ['mcp__claude_ai_Linear__list*'],
    deny: ['mcp__claude_ai_Linear__*delete*'],
  } as const;

  const withConnectors = (level: PermissionLevel): Record<string, unknown> =>
    claudeSandboxPolicy({
      level,
      worktree: WORKTREE,
      version: CURRENT,
      allowedDomains: DOMAINS,
      connectorPermissions: RULES,
    }).settings as unknown as Record<string, unknown>;

  it('every level carries them beside the sandbox block, full included', () => {
    // `full` relaxes the *sandbox* by explicit opt-in; the connector denials
    // are not the sandbox, and a level that dropped them would let
    // bypassPermissions reach delete_* on the operator's tracker.
    for (const level of PERMISSION_LEVELS) {
      expect(withConnectors(level).permissions).toEqual(RULES);
    }
  });

  it('absent input emits no permissions key at all, so the document is unchanged', () => {
    for (const level of PERMISSION_LEVELS) {
      const settings = claudeSandboxPolicy({
        level,
        worktree: WORKTREE,
        version: CURRENT,
        allowedDomains: DOMAINS,
      }).settings as unknown as Record<string, unknown>;
      expect('permissions' in settings).toBe(false);
    }
  });
});
