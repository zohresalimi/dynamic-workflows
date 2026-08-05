/**
 * EPIC-05-S10, S11, S12 — how each vendor is actually spawned.
 *
 * Integration throughout, because every claim is about a real child process:
 * which argv the kernel was handed, which environment entries it inherited,
 * what happens when the file at the resolved path is gone or unreadable, and
 * how many times DeFlow tried. A mocked `spawn` could only confirm what the
 * mock was given, and the failures this story exists to prevent — a bare name
 * resolved against the wrong `PATH`, a fallback loop against a churning flag —
 * are invisible to one.
 *
 * The child is `support/spawn-witness.ts`, installed into a tmpdir under
 * whichever vendor's bin name the scenario is about, and it writes one JSON
 * line per invocation to `$DeFlow_SPAWN_LOG` — so "exactly two spawn attempts
 * were made in total" is read off disk rather than counted in the spec.
 *
 * Verifies: EPIC-05-S10, EPIC-05-S11, EPIC-05-S12 · AC3–AC7 · test plan
 * #3, #4, #5, #7
 */
import { EventSeqSchema, type NodeFailure, NodeIdSchema } from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  launchProvider,
  PROVIDER_SPECS,
  type ProviderSpec,
  renderAuthMethods,
  reportAvailability,
  toAdapterFailure,
} from '../../src/index.ts';
import { initializeOnce } from './support/handshake.ts';
import { liveInGroup, openTestLedger, type TestLedger } from './support/harness.ts';

const WITNESS = fileURLToPath(new URL('./support/spawn-witness.ts', import.meta.url));

let dir = '';
let binDir = '';
let worktree = '';
let spawnLog = '';
let ledger: TestLedger;
let clock: TestClock;
const opened: { kill: () => void }[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
  binDir = join(dir, 'bin');
  worktree = join(dir, 'wt');
  spawnLog = join(dir, 'spawns.ndjson');
  await mkdir(binDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
  clock = new TestClock(1_754_313_093_000);
});

afterEach(async () => {
  for (const child of opened.splice(0)) child.kill();
  ledger.close();
  await removeTempDir(dir);
});

/**
 * Installs the witness as `<tmp>/bin/<name>`, the way npm installs a vendor
 * CLI: a symlink, under a name with no extension.
 *
 * The link is what makes the fixture honest *and* runnable — the resolver has
 * to follow it exactly as it would follow `~/.nvm/versions/.../bin/gemini`, and
 * Node resolves the link before choosing a loader, so the target's `.ts`
 * extension is what gets type-stripped (testkit's `linkFakeAgent` records the
 * same finding).
 */
function install(name: string): string {
  const path = join(binDir, name);
  symlinkSync(WITNESS, path);
  return path;
}

/** The same name, present but without an execute bit — a copy, because a mode
 * belongs to the file and `chmod` on a link would follow it to the fixture. */
function installUnreadable(name: string): string {
  const path = join(binDir, name);
  copyFileSync(WITNESS, path);
  chmodSync(path, 0o644);
  return path;
}

/** Every invocation the witness recorded, in order. */
function spawns(): { argv: string[]; cwd: string; codexPath: string | null; path: string }[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(
      (line) =>
        JSON.parse(line) as { argv: string[]; cwd: string; codexPath: string | null; path: string },
    );
}

/**
 * The child's `PATH`, shaped like a daemon's: the two directories a launchd or
 * systemd unit gets, plus wherever this Node happens to live.
 *
 * The interpreter entry is an artefact of the witness being a script with a
 * `#!/usr/bin/env node` shebang — a real vendor CLI is resolved by the kernel
 * on its own. What is under test is that *DeFlow* never looked anything up on
 * a `PATH`, and the assertion for that is on the parent's `PATH` below.
 */
const daemonPath = (): string => `/usr/bin:/bin:${dirname(process.execPath)}`;

function launchEnv(): NodeJS.ProcessEnv {
  return { PATH: daemonPath(), DeFlow_SPAWN_LOG: spawnLog };
}

const ports = () => ({ clock, ledger: ledger.sink });

/** Resolves `spec` against the tmp bin directory alone — never `PATH`. */
function resolveIn(spec: ProviderSpec): ReturnType<ProviderSpec['resolve']> {
  return spec.resolve({ roots: [binDir] });
}

function failureOf(thrown: unknown): NodeFailure {
  return toAdapterFailure(thrown, {
    occurredAtEvent: EventSeqSchema.parse(1),
    attempt: 0,
    captureEvidence: ledger.captureEvidence,
  });
}

suite('each vendor is invoked its own way (EPIC-05-S10, test plan #3)', () => {
  it("passes opencode's acp as a subcommand, before --cwd", async () => {
    install('opencode');
    const outcome = await launchProvider(
      {
        spec: PROVIDER_SPECS.opencode,
        resolved: resolveIn(PROVIDER_SPECS.opencode),
        worktree,
        env: launchEnv(),
      },
      ports(),
      initializeOnce,
    );
    opened.push(outcome.child);

    expect(outcome.value.protocolVersion).toBe(1);
    const [first] = spawns();
    expect(first?.argv).toEqual(['acp', '--cwd', worktree]);
    expect(first?.argv[0]).toBe('acp');
    expect(first?.argv[0]?.startsWith('--')).toBe(false);
  });

  it('gives codex-acp an absolute CODEX_PATH rather than letting it search (AC3)', async () => {
    install('codex-acp');
    install('codex');
    const outcome = await launchProvider(
      {
        spec: PROVIDER_SPECS.codex,
        resolved: resolveIn(PROVIDER_SPECS.codex),
        worktree,
        env: launchEnv(),
      },
      ports(),
      initializeOnce,
    );
    opened.push(outcome.child);

    const [first] = spawns();
    expect(first?.argv).toEqual([]);
    expect(first?.codexPath).toBe(join(binDir, 'codex'));
    expect(outcome.plan.command).toBe(join(binDir, 'codex-acp'));
  });

  it('starts the child detached, in the worktree, with all three streams piped', async () => {
    install('gemini');
    const outcome = await launchProvider(
      {
        spec: PROVIDER_SPECS.gemini,
        resolved: resolveIn(PROVIDER_SPECS.gemini),
        worktree,
        env: launchEnv(),
      },
      ports(),
      async (child) => {
        // Asserted while the child is alive: a group that is reachable by
        // `kill(-pgid)` is what makes a wedged agent and everything it spawned
        // killable with one signal (§9.3).
        expect(liveInGroup(child.pid ?? 0)).not.toEqual([]);
        expect(child.stdin).not.toBeNull();
        expect(child.stderr).not.toBeNull();
        return initializeOnce(child);
      },
    );
    opened.push(outcome.child);

    expect(outcome.pgid).toBe(outcome.child.pid);
    expect(spawns()[0]?.argv).toEqual(['--acp']);
    // `realpathSync`, because macOS hands out tmpdirs under a symlinked
    // /var and the child reports where it actually landed.
    expect(spawns()[0]?.cwd).toBe(realpathSync(worktree));
  });
});

suite('the adapter never searches PATH (EPIC-05-S11, test plan #4)', () => {
  it('finds the binary under a daemon-shaped PATH and completes initialize', async () => {
    install('claude-agent-acp');
    const savedPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const outcome = await launchProvider(
        {
          spec: PROVIDER_SPECS.claude,
          resolved: resolveIn(PROVIDER_SPECS.claude),
          worktree,
          env: launchEnv(),
        },
        ports(),
        initializeOnce,
      );
      opened.push(outcome.child);
      expect(outcome.value.protocolVersion).toBe(1);
      expect(outcome.plan.command).toBe(join(binDir, 'claude-agent-acp'));
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('ignores a binary of the right name sitting on PATH', async () => {
    const decoyDir = join(dir, 'decoy');
    await mkdir(decoyDir, { recursive: true });
    symlinkSync(WITNESS, join(decoyDir, 'gemini'));

    const savedPath = process.env.PATH;
    process.env.PATH = decoyDir;
    try {
      let thrown: unknown;
      try {
        PROVIDER_SPECS.gemini.resolve({ roots: [binDir] });
      } catch (error) {
        thrown = error;
      }
      expect(failureOf(thrown).reason).toBe('adapter.spawn-failed');
      expect(JSON.stringify(failureOf(thrown).detail)).not.toContain(decoyDir);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('names the vendor and every path searched, never a bare ENOENT (AC4)', () => {
    let thrown: unknown;
    try {
      PROVIDER_SPECS.gemini.resolve({ roots: [binDir, join(dir, 'also-not-here')] });
    } catch (error) {
      thrown = error;
    }
    const failure = failureOf(thrown);
    expect(failure.reason).toBe('adapter.spawn-failed');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toMatch(/gemini/);
    expect(failure.message).not.toMatch(/^ENOENT/);
    const detail = JSON.stringify(failure.detail);
    expect(detail).toContain(join(binDir, 'gemini'));
    expect(detail).toContain(join(dir, 'also-not-here', 'gemini'));
    expect(detail).toContain('ENOENT');
  });

  it('distinguishes a non-executable file from a missing one', () => {
    installUnreadable('gemini');
    let thrown: unknown;
    try {
      PROVIDER_SPECS.gemini.resolve({ roots: [binDir] });
    } catch (error) {
      thrown = error;
    }
    const detail = JSON.stringify(failureOf(thrown).detail);
    expect(detail).toContain('EACCES');
    expect(detail).not.toContain('ENOENT');
  });

  it('turns a binary deleted after resolution into adapter.spawn-failed, not a raw errno', async () => {
    const path = install('gemini');
    const resolved = resolveIn(PROVIDER_SPECS.gemini);
    writeFileSync(join(dir, 'gone'), '');
    // Removed between resolution and spawn — the race a long-lived daemon
    // actually loses when a user upgrades a vendor CLI mid-run.
    const { rm } = await import('node:fs/promises');
    await rm(path);

    let thrown: unknown;
    try {
      await launchProvider(
        { spec: PROVIDER_SPECS.gemini, resolved, worktree, env: launchEnv() },
        ports(),
        initializeOnce,
      );
    } catch (error) {
      thrown = error;
    }
    const failure = failureOf(thrown);
    expect(failure.reason).toBe('adapter.spawn-failed');
    expect(failure.message).toContain(path);
    expect(spawns()).toEqual([]);
  });
});

suite("gemini's deprecated flag fallback, exactly once (EPIC-05-S12, test plan #5)", () => {
  it('tries --acp first and does not retry when it works', async () => {
    install('gemini');
    const outcome = await launchProvider(
      {
        spec: PROVIDER_SPECS.gemini,
        resolved: resolveIn(PROVIDER_SPECS.gemini),
        worktree,
        env: launchEnv(),
      },
      ports(),
      initializeOnce,
    );
    opened.push(outcome.child);

    expect(outcome.spawns).toBe(1);
    expect(outcome.fellBack).toBe(false);
    expect(spawns().map((call) => call.argv)).toEqual([['--acp']]);
    expect(spawns()[0]?.argv).not.toContain('--experimental-acp');
  });

  it('falls back exactly once, and records that it did (AC5)', async () => {
    install('gemini');
    const node = NodeIdSchema.parse('n1');
    const outcome = await launchProvider(
      {
        spec: PROVIDER_SPECS.gemini,
        resolved: resolveIn(PROVIDER_SPECS.gemini),
        worktree,
        version: '0.53.1',
        nodeId: node,
        attempt: 0,
        // Rejected exactly the way a yargs CLI rejects a flag it no longer has.
        env: { ...launchEnv(), DeFlow_REJECT_ARG: '--acp' },
      },
      ports(),
      initializeOnce,
    );
    opened.push(outcome.child);

    expect(outcome.value.protocolVersion).toBe(1);
    expect(outcome.spawns).toBe(2);
    expect(outcome.fellBack).toBe(true);
    expect(spawns().map((call) => call.argv)).toEqual([['--acp'], ['--experimental-acp']]);

    const progress = ledger
      .events()
      .filter(
        (event) =>
          event.kind === 'node.progress' && event.payload.phase === 'adapter.flag-fallback',
      );
    expect(progress).toHaveLength(1);
    expect(progress[0]?.payload.node).toBe('n1');
    expect(String(progress[0]?.payload.message)).toContain('--experimental-acp');
    expect(String(progress[0]?.payload.message)).toContain('0.53.1');
  });

  it('does not retry a second time, and fails with adapter.spawn-failed', async () => {
    install('gemini');
    let thrown: unknown;
    try {
      await launchProvider(
        {
          spec: PROVIDER_SPECS.gemini,
          resolved: resolveIn(PROVIDER_SPECS.gemini),
          worktree,
          // Rejects every argument containing "acp", so both variants fail.
          env: { ...launchEnv(), DeFlow_REJECT_ARG: 'acp' },
        },
        ports(),
        initializeOnce,
      );
    } catch (error) {
      thrown = error;
    }

    const failure = failureOf(thrown);
    expect(failure.reason).toBe('adapter.spawn-failed');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toMatch(/gemini/);
    expect(spawns()).toHaveLength(2);
    expect(spawns().map((call) => call.argv)).toEqual([['--acp'], ['--experimental-acp']]);
  });

  it('does not fall back for a vendor whose flag is not mid-deprecation', async () => {
    install('copilot');
    let thrown: unknown;
    try {
      await launchProvider(
        {
          spec: PROVIDER_SPECS.copilot,
          resolved: resolveIn(PROVIDER_SPECS.copilot),
          worktree,
          env: { ...launchEnv(), DeFlow_REJECT_ARG: '--acp' },
        },
        ports(),
        initializeOnce,
      );
    } catch (error) {
      thrown = error;
    }
    expect(failureOf(thrown).reason).toBe('adapter.spawn-failed');
    expect(spawns()).toHaveLength(1);
  });
});

suite('an authMethods payload is rendered, never run (AC7, test plan #7)', () => {
  it('renders the command and leaves the sentinel it would have written absent', async () => {
    const sentinel = join(dir, 'login-ran');
    const loginBin = join(binDir, 'would-login');
    // A real, executable program that proves it ran by existing evidence, not
    // by a spy: if any code path anywhere in the registry executed the
    // authMethods payload, this file would be on disk.
    writeFileSync(loginBin, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(loginBin, 0o755);

    const capsJson = JSON.stringify({
      protocolVersion: 1,
      authMethods: [
        {
          id: 'terminal',
          name: 'Log in with GitHub',
          _meta: { 'terminal-auth': { command: loginBin, args: ['login'] } },
        },
      ],
    });

    const rendered = renderAuthMethods(capsJson);
    const report = reportAvailability(PROVIDER_SPECS.copilot, {
      binaryPath: join(binDir, 'copilot'),
      capsJson,
    });

    expect(rendered[0]?.command).toBe(`${loginBin} login`);
    expect(report.status).toBe('unauthenticated');
    expect(report.login[0]?.command).toBe(`${loginBin} login`);

    // A turn of the loop, in case anything had been kicked off asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(sentinel)).toBe(false);
  });
});
