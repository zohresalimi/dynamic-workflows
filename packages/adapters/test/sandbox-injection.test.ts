/**
 * KAR-08.5 — the policy on an argv.
 *
 * `@DeFlow/core`'s generator says *what* the policy is; this is the layer that
 * decides how it reaches the process, and the two failure modes it exists to
 * prevent are both silent:
 *
 *  - a policy written to a *file* instead of the command line, which mutates
 *    configuration DeFlow does not own (AR-1) and is per-machine rather than
 *    per-node;
 *  - a self-sandboxing CLI wrapped in a second sandbox, which turns a working
 *    sandbox into a broken one.
 *
 * The spawn itself is `test/integration/sandbox-injection.test.ts`. Everything
 * here is a construction-time fact, and construction-time is the point: a
 * missing bubblewrap has to fail the node *before* an agent process exists,
 * not after one has been running unsandboxed for a minute.
 *
 * Verifies: EPIC-08-S20, EPIC-08-S21, EPIC-08-S24, EPIC-08-S25 · AC1, AC5,
 * AC7 · test plan #7
 */
import { FAILURE_TAG, type PermissionLevel } from '@DeFlow/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import {
  PROVIDER_SPECS,
  type ProviderSpec,
  SANDBOX_UNAVAILABLE_CAUSE,
  type SandboxInvocation,
  sandboxedShimPlan,
} from '../src/index.ts';

const BIN = '/opt/DeFlow/bin';
const WORKTREE = '/tmp/DeFlow/wt/n1';
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CURRENT = '2.1.220';

/** A `roots` list that resolves nothing — every dependency is "absent". */
const NO_ROOTS: readonly string[] = [];

/**
 * A directory holding real, executable files with the given names.
 *
 * Real files rather than a mocked `fs`: the check under test is "is this an
 * executable file on one of these roots", and a stubbed answer would test the
 * stub. Nothing is spawned, so this stays in the unit slice.
 */
function rootWith(...bins: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'DeFlow-sandbox-'));
  for (const bin of bins) writeFileSync(join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

/** Every sandbox prerequisite present: the "nothing is missing" baseline. */
const COMPLETE_ROOT = rootWith('srt', 'bwrap', 'socat');
/** Half a sandbox: bubblewrap without socat. */
const HALF_ROOT = rootWith('bwrap');

function sandbox(overrides: Partial<SandboxInvocation> = {}): SandboxInvocation {
  return {
    version: CURRENT,
    // macOS ships Seatbelt, so the dependency check is vacuous here and the
    // Linux case gets its own suite rather than leaking into every assertion.
    platform: 'darwin',
    roots: NO_ROOTS,
    configDir: '/tmp/DeFlow/run/sandbox',
    allowedDomains: ['github.com'],
    ...overrides,
  };
}

function plan(
  id: string,
  permission: PermissionLevel,
  invocation: SandboxInvocation = sandbox(),
): ReturnType<typeof sandboxedShimPlan> {
  const spec = (PROVIDER_SPECS as Record<string, ProviderSpec>)[id];
  if (spec === undefined) throw new Error(`no spec for ${id}`);
  return sandboxedShimPlan(
    spec,
    {
      resolved: { provider: spec.id, path: `${BIN}/${spec.shim.bin}` },
      worktree: WORKTREE,
      prompt: 'say ok',
      sessionId: SESSION,
      permission,
    },
    invocation,
  );
}

/** The single argument that follows `--settings`, parsed. */
function settingsArgument(argv: readonly string[]): unknown {
  const index = argv.indexOf('--settings');
  expect(index, '--settings is not on the argv').toBeGreaterThanOrEqual(0);
  const value = argv[index + 1];
  expect(typeof value).toBe('string');
  return JSON.parse(value as string);
}

suite('EPIC-08-S20 — the policy arrives on the command line (AC1)', () => {
  for (const level of ['read', 'worktree', 'worktree+net'] as const) {
    it(`${level}: --settings carries one parseable JSON argument`, () => {
      const argv = plan('claude', level).argv;
      const index = argv.indexOf('--settings');

      // One argument, not a shell-quoted pair and not a path.
      expect(argv.filter((entry) => entry === '--settings')).toHaveLength(1);
      expect(() => settingsArgument(argv)).not.toThrow();
      expect(argv[index + 1]).not.toMatch(/^[/~]/);
    });
  }

  it('the JSON equals the golden policy for the level', () => {
    expect(settingsArgument(plan('claude', 'worktree').argv)).toMatchSnapshot();
  });

  it('two nodes in one run carry different policies', () => {
    const read = settingsArgument(plan('claude', 'read').argv) as {
      sandbox: { filesystem: unknown; network: unknown };
    };
    const net = settingsArgument(plan('claude', 'worktree+net').argv) as {
      sandbox: { filesystem: unknown; network: unknown };
    };

    expect(read.sandbox.filesystem).not.toEqual(net.sandbox.filesystem);
    expect(read.sandbox.network).not.toEqual(net.sandbox.network);
  });

  it('points at no settings file, in a user config directory or anywhere else', () => {
    // The policy names credential paths *inside* the JSON — that is the deny
    // list, and it belongs there. What must not appear is an argv entry that
    // is itself a path into somebody's configuration: a `--settings
    // ~/.claude/settings.json` would make the policy per-machine and would
    // mean DeFlow had read a file it does not own.
    for (const level of ['read', 'worktree', 'worktree+net', 'full'] as const) {
      for (const entry of plan('claude', level).argv) {
        if (!entry.startsWith('/') && !entry.startsWith('~')) continue;
        expect(entry).not.toMatch(/\.(claude|codex|aws|ssh)\b|config\/gh|Library\/Keychains/);
      }
    }
  });

  it('full still states a policy, rather than omitting --settings entirely', () => {
    // An absent `--settings` would let whatever is in the operator's own
    // configuration decide, which is the opposite of an explicit opt-in.
    expect(settingsArgument(plan('claude', 'full').argv)).toEqual({ sandbox: { enabled: false } });
  });
});

suite('EPIC-08-S24 — a level a vendor cannot express is refused (AC4)', () => {
  it('codex has no way to carry network_access, so worktree+net is refused', () => {
    // `-s workspace-write` is on the argv; `network_access` lives in a config
    // section Codex only reads from a file, and DeFlow writes none. Refusing
    // is the specified behaviour — a nearest-neighbour level is never
    // substituted.
    expect(() => plan('codex', 'worktree+net')).toThrow(/worktree\+net/);
  });

  it('codex carries its sandbox mode as a flag, not as injected JSON', () => {
    expect(plan('codex', 'worktree').argv).toContain('workspace-write');
    expect(plan('codex', 'worktree').argv).not.toContain('--settings');
  });
});

suite('EPIC-08-S25 — never nest, and never leave a CLI bare (AC7)', () => {
  it('a self-sandboxing CLI is spawned directly', () => {
    const claude = plan('claude', 'worktree');

    expect(claude.strategy).toBe('vendor');
    expect(claude.command).toBe(`${BIN}/claude`);
    expect(claude.runtimeConfig).toBe(null);
  });

  it('a CLI with no sandbox of its own is wrapped, and the wrapper is srt', () => {
    const gemini = plan('gemini', 'worktree', sandbox({ roots: [COMPLETE_ROOT] }));

    expect(gemini.strategy).toBe('sandbox-runtime');
    expect(gemini.command).toBe(join(COMPLETE_ROOT, 'srt'));
    // The vendor's own command line survives intact, after the wrapper's.
    expect(gemini.argv.slice(0, 2)).toEqual([
      '--settings',
      '/tmp/DeFlow/run/sandbox/srt-settings.json',
    ]);
    expect(gemini.argv[2]).toBe(`${BIN}/gemini`);
    expect(gemini.argv).toContain('--approval-mode');
  });

  it('the wrapper config is handed back to be written, never to a user path', () => {
    const gemini = plan('gemini', 'worktree', sandbox({ roots: [COMPLETE_ROOT] }));

    expect(gemini.runtimeConfig?.path).toBe('/tmp/DeFlow/run/sandbox/srt-settings.json');
    expect(gemini.runtimeConfig?.document.filesystem.allowWrite).toEqual([WORKTREE]);
    // srt's own default is ~/.srt-settings.json. Reading it would make the
    // policy per-machine and would be exactly the configuration DeFlow must
    // not depend on.
    expect(gemini.runtimeConfig?.path).not.toContain('~');
  });

  it('at full there is nothing to wrap, so nothing wraps', () => {
    const gemini = plan('gemini', 'full', sandbox({ roots: [COMPLETE_ROOT] }));

    expect(gemini.strategy).toBe('sandbox-runtime');
    expect(gemini.command).toBe(`${BIN}/gemini`);
    expect(gemini.runtimeConfig).toBe(null);
  });

  it('never both: a wrapped plan carries no --settings JSON of the vendor’s', () => {
    const gemini = plan('gemini', 'worktree', sandbox({ roots: [COMPLETE_ROOT] }));
    const settingsFlags = gemini.argv.filter((entry) => entry === '--settings');

    expect(settingsFlags).toHaveLength(1);
    expect(gemini.argv[gemini.argv.indexOf('--settings') + 1]).toMatch(/\.json$/);
  });

  it('falls back to the wrapper DeFlow pinned when the operator has none (KAR-23.9)', () => {
    // Before KAR-23.9 this asserted a throw, and the throw was the bug: a
    // correctly installed DeFlow on a machine with no *global* `srt` refused
    // every non-vendor node, because the only place looked at was the
    // operator's `PATH`. `resolveSandboxRuntime` now tries the pinned
    // dependency second — never the worktree, never a path the plan names — so
    // an empty `roots` list still produces a wrapped plan.
    const gemini = plan('gemini', 'worktree', sandbox({ roots: NO_ROOTS, platform: 'darwin' }));

    expect(gemini.strategy).toBe('sandbox-runtime');
    expect(gemini.command).toContain('sandbox-runtime');
    expect(gemini.argv[0]).toBe('--settings');
    // The refusal that still has to exist: nothing here comes from the node's
    // own worktree.
    expect(gemini.command.startsWith(WORKTREE)).toBe(false);
  });

  it('and a level whose Linux prerequisites are missing is still a refusal', () => {
    // The wrapper being resolvable is not the same claim as the level being
    // enforceable: bwrap and socat are checked first, and their absence is a
    // refusal before the wrapper is looked for at all.
    expect(() =>
      plan('gemini', 'worktree', sandbox({ roots: NO_ROOTS, platform: 'linux' })),
    ).toThrow(/bubblewrap/);
  });
});

suite('EPIC-08-S23 — Copilot strips named variables from its own children', () => {
  it('--secret-env-vars carries the names KAR-08.4 dropped', () => {
    const copilot = plan(
      'copilot',
      'read',
      sandbox({ roots: [COMPLETE_ROOT], secretEnvVars: ['NPM_TOKEN', 'AWS_PROFILE'] }),
    );
    const index = copilot.argv.indexOf('--secret-env-vars');

    expect(index).toBeGreaterThanOrEqual(0);
    expect(copilot.argv[index + 1]).toBe('NPM_TOKEN,AWS_PROFILE');
  });

  it('nothing scrubbed means no flag, rather than an empty one', () => {
    const copilot = plan('copilot', 'read', sandbox({ roots: [COMPLETE_ROOT] }));
    expect(copilot.argv).not.toContain('--secret-env-vars');
  });

  it('is a Copilot flag and is not invented for other vendors', () => {
    const gemini = plan(
      'gemini',
      'read',
      sandbox({ roots: [COMPLETE_ROOT], secretEnvVars: ['NPM_TOKEN'] }),
    );
    expect(gemini.argv).not.toContain('--secret-env-vars');
  });
});

suite('EPIC-08-S21 — a missing dependency fails the node (AC5)', () => {
  it('linux without bwrap refuses, naming bubblewrap', () => {
    expect(() => plan('claude', 'worktree', sandbox({ platform: 'linux' }))).toThrow(/bubblewrap/);
  });

  it('the refusal is a typed node failure carrying a sandbox-unavailable cause', () => {
    try {
      plan('claude', 'worktree', sandbox({ platform: 'linux' }));
      throw new Error('expected a refusal');
    } catch (error) {
      const tag = (
        error as Record<string, { reason: string; class: string; detail?: Record<string, unknown> }>
      )[FAILURE_TAG];
      // The scenario words this as `node.failed` carrying "sandbox-unavailable".
      // The taxonomy is a closed union embedded in the content-hash-pinned
      // `DeFlow.plangraph.v1` schema, so the cause travels in `detail` and the
      // reason is the existing member that already means "DeFlow cannot
      // enforce the requested level here" (see ../src/failures.ts).
      expect(tag?.reason).toBe('safety.permission-unschedulable');
      expect(tag?.class).toBe('permanent');
      expect(tag?.detail).toMatchObject({ cause: SANDBOX_UNAVAILABLE_CAUSE, dependency: 'bwrap' });
    }
  });

  it('socat is checked too, and named on its own', () => {
    // A root that has bwrap and not socat. Both are required; a check that
    // stops at the first is a check that passes on half a sandbox.
    expect(() =>
      plan('claude', 'worktree', sandbox({ platform: 'linux', roots: [HALF_ROOT] })),
    ).toThrow(/socat/);
  });

  it('full needs nothing, because nothing is enforced there', () => {
    expect(() => plan('claude', 'full', sandbox({ platform: 'linux' }))).not.toThrow();
  });

  it('macOS needs nothing installed, because Seatbelt ships with the OS', () => {
    expect(() => plan('claude', 'worktree', sandbox({ platform: 'darwin' }))).not.toThrow();
  });
});

suite('EPIC-08-S22 — a degraded key travels with the plan (AC6)', () => {
  it('an omitted key is reported so the caller can append sandbox.degraded', () => {
    const degraded = plan('claude', 'worktree', sandbox({ version: '2.1.218' })).degraded;

    expect(degraded).toContainEqual({
      key: 'sandbox.network.strictAllowlist',
      detected: '2.1.218',
      required: '2.1.219',
    });
  });

  it('a current CLI degrades nothing', () => {
    expect(plan('claude', 'worktree').degraded).toEqual([]);
  });
});
