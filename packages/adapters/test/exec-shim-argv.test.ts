/**
 * KAR-05.8 — the exec shim's argv, generated from the per-vendor spec.
 *
 * The whole cost of the CLI fallback is that vendors stop resembling each
 * other, and every flag below was read from the installed binary's own
 * `--help` on 2026-08-02. Three of them were already mid-breakage that day:
 * `--permission-prompt-tool` had left Claude Code's help, `codex exec
 * --full-auto` was gone, and Gemini's `--allowed-tools` was marked deprecated.
 *
 * So the argv is a **golden snapshot** for the same reason KAR-05.3's is: not
 * because today's values are right, but because a flag change becomes a
 * reviewable diff instead of a quiet edit inside a spawn call (AC1).
 *
 * Two of the differences are load-bearing enough to be asserted directly
 * rather than left to the snapshot:
 *
 * - Claude Code **exits** when `-p --output-format stream-json` arrives
 *   without `--verbose`, and succeeds without it under `--output-format json`
 *   — so the mistake is invisible in the format most people try first (AC2).
 * - Copilot has **no `stream-json` at all**. A shim that assumes one streaming
 *   format across vendors has to fail here, at construction, before a process
 *   exists (AC3).
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC1, AC2, AC3 · test plan #1
 */
import { PERMISSION_LEVELS, type PermissionLevel } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS, type ProviderSpec, type ShimFormat, shimPlan } from '../src/index.ts';

const BIN = '/opt/DeFlow/bin';
const WORKTREE = '/tmp/DeFlow/wt/n1';
const PROMPT = 'summarise the failing test';
/** Client-chosen, and verified honoured verbatim in every emitted frame. */
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function plan(
  spec: ProviderSpec,
  permission: PermissionLevel,
  format?: ShimFormat,
): ReturnType<typeof shimPlan> {
  return shimPlan(spec, {
    resolved: { provider: spec.id, path: `${BIN}/${spec.shim.bin}` },
    worktree: WORKTREE,
    prompt: PROMPT,
    sessionId: SESSION,
    permission,
    ...(format === undefined ? {} : { format }),
  });
}

const specs = Object.values(PROVIDER_SPECS) as readonly ProviderSpec[];
const byId = (id: string): ProviderSpec => {
  const found = specs.find((spec) => spec.id === id);
  if (found === undefined) throw new Error(`no spec for ${id}`);
  return found;
};

/**
 * EPIC-05-S29's Examples table, verbatim.
 *
 * This is the acceptance specification, so it is written out as strings rather
 * than assembled from the same helpers the implementation uses — a table built
 * by the code under test would agree with itself no matter what it produced.
 */
const READ_ONLY_ARGV: Readonly<Record<string, string>> = {
  claude: `-p ${PROMPT} --output-format stream-json --session-id ${SESSION} --verbose`,
  codex: `exec --json --skip-git-repo-check -C ${WORKTREE} ${PROMPT}`,
  gemini: `-p ${PROMPT} --output-format stream-json --session-id ${SESSION}`,
  copilot: `-p ${PROMPT} --output-format json --allow-all-tools`,
  opencode: `run --format json ${PROMPT}`,
};

suite('each vendor’s headless invocation (EPIC-05-S29, AC1)', () => {
  for (const [id, argv] of Object.entries(READ_ONLY_ARGV)) {
    it(`${id}: a read-only node is invoked exactly as verified`, () => {
      expect(plan(byId(id), 'read').argv.join(' ')).toBe(argv);
    });
  }

  it('runs the vendor CLI itself, not the ACP bridge KAR-05.3 spawns', () => {
    // The whole point of the fallback is that it needs no ACP path: the shim
    // drives `claude`, never `claude-agent-acp`.
    expect(plan(byId('claude'), 'read').command).toBe(`${BIN}/claude`);
    expect(plan(byId('codex'), 'read').command).toBe(`${BIN}/codex`);
  });

  it('is a snapshot for read-only and for worktree-write nodes', () => {
    const table = specs.map((spec) => ({
      provider: spec.id,
      bin: spec.shim.bin,
      dialect: spec.shim.dialect,
      formats: spec.shim.formats,
      read: plan(spec, 'read').argv,
      worktree: spec.shim.permissions.includes('worktree')
        ? plan(spec, 'worktree').argv
        : 'refused: the vendor has no flag for this level',
    }));
    expect(table).toMatchSnapshot();
  });
});

suite('Claude Code’s --verbose requirement is never violated (AC2)', () => {
  it('adds --verbose to every stream-json invocation, at every level', () => {
    // Every permission level the vendor can express, and both ways of asking
    // for the format — the default and the explicit request. The requirement
    // belongs to the *format*, so no call site can be the one that forgets it.
    const claude = byId('claude');
    for (const permission of PERMISSION_LEVELS) {
      if (!claude.shim.permissions.includes(permission)) continue;
      expect(plan(claude, permission, 'stream-json').argv, permission).toContain('--verbose');
      expect(plan(claude, permission).argv, `${permission} (default format)`).toContain(
        '--verbose',
      );
    }
  });

  it('is not spread to a vendor that never asked for it', () => {
    // Gemini's stream-json has no such requirement (verified `--help`,
    // 2026-08-02). Passing the flag everywhere would look like a safe default
    // and would be an invented flag on four of the five vendors.
    expect(plan(byId('gemini'), 'read', 'stream-json').argv).not.toContain('--verbose');
  });

  it('does not add it to the format that does not require it', () => {
    // `--output-format json` succeeds without `--verbose`, which is exactly
    // why the requirement is missable: passing it everywhere would hide that
    // the guard is even needed.
    expect(plan(byId('claude'), 'read', 'json').argv).not.toContain('--verbose');
  });
});

suite('Copilot has no stream-json (AC3)', () => {
  it('refuses at construction, naming the formats it does support', () => {
    expect(() => plan(byId('copilot'), 'read', 'stream-json')).toThrow(/text\|json/);
  });

  it('the refusal is a tagged permanent failure, not a bare Error', () => {
    try {
      plan(byId('copilot'), 'read', 'stream-json');
      expect.unreachable('constructing a copilot stream-json plan must throw');
    } catch (error) {
      expect(error).toMatchObject({
        deflowFailure: { reason: 'adapter.spawn-failed', class: 'permanent' },
      });
    }
  });

  it('every other vendor’s default format is one it actually supports', () => {
    for (const spec of specs) {
      expect(spec.shim.formats, spec.id).toContain(spec.shim.stream);
      expect(plan(spec, 'read').format, spec.id).toBe(spec.shim.stream);
    }
  });
});

suite('a level the vendor cannot express is refused, never escalated', () => {
  it('refuses rather than silently picking the nearest flag', () => {
    // OpenCode's `run` has no permission flag at all (verified `--help`,
    // 2026-08-02). Choosing its default anyway would run a worktree-write node
    // at whatever level the vendor happens to default to, which is the silent
    // escalation §8 exists to prevent.
    const opencode = byId('opencode');
    expect(opencode.shim.permissions).toEqual(['read']);
    expect(() => plan(opencode, 'worktree')).toThrow(/safety|cannot express|no flag/i);
  });

  it('the refusal carries safety.permission-unschedulable', () => {
    try {
      plan(byId('opencode'), 'worktree');
      expect.unreachable('an inexpressible permission level must throw');
    } catch (error) {
      expect(error).toMatchObject({
        deflowFailure: { reason: 'safety.permission-unschedulable', class: 'permanent' },
      });
    }
  });
});
