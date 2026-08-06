/**
 * KAR-08.5 — what the *child* actually received.
 *
 * The unit suite proves the argv is built with `--settings` on it. Only a real
 * spawn proves that the string survived the kernel boundary as **one
 * argument** — a policy that arrived split on whitespace, or shell-quoted, or
 * as a path, is the same failure wearing three costumes, and the vendor's
 * argument parser is the only thing that can tell you which one you have.
 *
 * The other claim needs a process for a different reason. "No file under
 * `~/.claude` is opened or written on any code path" is a statement about
 * behaviour, not about source, so `HOME` is pointed at a directory this spec
 * made, containing a `.claude/settings.json` with a canary value in it. If any
 * part of the path had read the operator's settings, the canary would appear
 * in the argv; if any part had written them, the file would have changed. Both
 * are checked after a real run, against a real directory.
 *
 * Verifies: EPIC-08-S20, EPIC-08-S21 · AC1, AC5
 */
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  PROVIDER_SPECS,
  type ProviderSpec,
  type SandboxInvocation,
  sandboxedShimPlan,
} from '../../src/index.ts';

const WITNESS = fileURLToPath(new URL('./support/spawn-witness.ts', import.meta.url));

/** The canary. If DeFlow ever reads the operator's settings, this shows up. */
const OPERATOR_CANARY = 'operator-settings-must-never-be-read';

let tmp: string;
let binDir: string;
let home: string;
let spawnLog: string;

beforeEach(async () => {
  tmp = await makeTempDir();
  binDir = join(tmp, 'bin');
  home = join(tmp, 'home');
  spawnLog = join(tmp, 'spawns.ndjson');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ sandbox: { enabled: false }, marker: OPERATOR_CANARY }),
  );
  writeFileSync(join(home, '.codex', 'config.toml'), `marker = "${OPERATOR_CANARY}"\n`);
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/**
 * Installs the witness as `<tmp>/bin/<name>`, the way npm installs a vendor
 * CLI: a symlink, under a name with no extension. Node resolves the link
 * before choosing a loader, so the target's `.ts` extension is what gets
 * type-stripped — a *copy* under an extensionless name would not be.
 */
function install(name: string): string {
  const path = join(binDir, name);
  symlinkSync(WITNESS, path);
  return path;
}

function spec(id: string): ProviderSpec {
  const found = (PROVIDER_SPECS as Record<string, ProviderSpec>)[id];
  if (found === undefined) throw new Error(`no spec for ${id}`);
  return found;
}

function invocation(overrides: Partial<SandboxInvocation> = {}): SandboxInvocation {
  return {
    version: '2.1.220',
    platform: 'darwin',
    roots: [binDir],
    configDir: join(tmp, 'sandbox'),
    allowedDomains: ['github.com'],
    ...overrides,
  };
}

/** Every invocation the witness recorded. */
function spawns(): { argv: string[] }[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { argv: string[] });
}

/** Runs the plan as a real child and waits for it to exit. */
async function run(command: string, argv: readonly string[]): Promise<void> {
  const child = spawn(command, [...argv], {
    cwd: tmp,
    stdio: ['pipe', 'ignore', 'ignore'],
    // The witness is a Node script with a `#!/usr/bin/env node` shebang, so
    // the interpreter has to be findable; `binDir` is on the front so that a
    // real vendor CLI on the developer's machine can never be what runs.
    env: {
      PATH: `${binDir}:${dirname(process.execPath)}`,
      HOME: home,
      DeFlow_SPAWN_LOG: spawnLog,
    },
  });
  child.stdin.end();
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
}

suite('the policy arrives on the command line (EPIC-08-S20, AC1)', () => {
  it('the child receives --settings followed by one JSON argument', async () => {
    const claude = install('claude');
    const plan = sandboxedShimPlan(
      spec('claude'),
      {
        resolved: { provider: spec('claude').id, path: claude },
        worktree: tmp,
        prompt: 'say ok',
        sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        permission: 'worktree',
      },
      invocation(),
    );

    await run(plan.command, plan.argv);

    const [received] = spawns();
    expect(received, 'the witness recorded no invocation').toBeDefined();

    const index = (received?.argv ?? []).indexOf('--settings');
    expect(index).toBeGreaterThanOrEqual(0);

    // One argument. If the document had been shell-quoted or split on
    // whitespace, the next entry would start with `{"sandbox":{"enabled":true`
    // and the one after it would be the rest of the object.
    const document = received?.argv[index + 1] ?? '';
    expect(() => JSON.parse(document)).not.toThrow();
    expect(JSON.parse(document)).toEqual(
      JSON.parse(plan.argv[plan.argv.indexOf('--settings') + 1] ?? ''),
    );
    expect(received?.argv).toHaveLength(index + 2);
  });

  it('reads and writes nothing under the operator’s own config directories', async () => {
    const claude = install('claude');
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

    const plan = sandboxedShimPlan(
      spec('claude'),
      {
        resolved: { provider: spec('claude').id, path: claude },
        worktree: tmp,
        prompt: 'say ok',
        sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        permission: 'worktree+net',
      },
      invocation(),
    );
    await run(plan.command, plan.argv);

    // Not read: the operator's `sandbox.enabled: false` did not become the
    // node's policy, and their marker is nowhere on the command line.
    expect(spawns()[0]?.argv.join(' ')).not.toContain(OPERATOR_CANARY);
    expect(JSON.parse(plan.argv[plan.argv.indexOf('--settings') + 1] ?? '')).toMatchObject({
      sandbox: { enabled: true },
    });

    // Not written: byte-for-byte the same file, and no new entry beside it.
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('two nodes in one run reach two children with different policies', async () => {
    const claude = install('claude');
    const base = {
      resolved: { provider: spec('claude').id, path: claude },
      worktree: tmp,
      prompt: 'say ok',
      sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    } as const;

    for (const permission of ['read', 'worktree+net'] as const) {
      const plan = sandboxedShimPlan(spec('claude'), { ...base, permission }, invocation());
      await run(plan.command, plan.argv);
    }

    const [first, second] = spawns();
    const policyOf = (argv: readonly string[]): unknown =>
      JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '');

    expect(policyOf(first?.argv ?? [])).not.toEqual(policyOf(second?.argv ?? []));
  });
});

suite('a missing sandbox dependency fails the node (EPIC-08-S21, AC5)', () => {
  it('linux without bwrap refuses, and no process runs unsandboxed', async () => {
    const claude = install('claude');
    const ctx = {
      resolved: { provider: spec('claude').id, path: claude },
      worktree: tmp,
      prompt: 'say ok',
      sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      permission: 'worktree',
    } as const;

    // The bin directory holds the vendor CLI and nothing else — the same shape
    // as a Linux box where nobody ran `apt install bubblewrap`.
    expect(() => sandboxedShimPlan(spec('claude'), ctx, invocation({ platform: 'linux' }))).toThrow(
      /bubblewrap/,
    );

    // The point of refusing at construction: the witness never ran.
    expect(spawns()).toEqual([]);
  });

  it('with bwrap and socat present, the same node starts', async () => {
    const claude = install('claude');
    install('bwrap');
    install('socat');

    const plan = sandboxedShimPlan(
      spec('claude'),
      {
        resolved: { provider: spec('claude').id, path: claude },
        worktree: tmp,
        prompt: 'say ok',
        sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        permission: 'worktree',
      },
      invocation({ platform: 'linux' }),
    );
    await run(plan.command, plan.argv);

    expect(spawns()).toHaveLength(1);
  });
});
