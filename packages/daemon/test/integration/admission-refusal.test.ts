/**
 * KAR-19.2 — `POST /api/runs` refuses a machine that cannot serve the run,
 * and records the refusal.
 *
 * A real booted daemon, a real temp `PATH` with real executables on it, real
 * HTTP and a real file-backed ledger. That combination is the point: the
 * reported failure was not a wrong function, it was a *missing call* between
 * two correct ones, and a spec that called the admission reducer directly would
 * have gone green on 2026-08-12 exactly as the rest of the suite did.
 *
 * The three machines below are the three an operator actually has:
 *
 *  - `claude` installed, its ACP bridge not — the reported one (EPIC-19-S9).
 *  - the bundled mock agent linked on as an adapter — the green one, which must
 *    never be refused and must pay for no extra handshake (EPIC-19-S12).
 *  - a bridge that resolves and then fails `initialize` — installed and broken,
 *    which must never be reported as absent (EPIC-19-S14).
 *
 * Verifies: EPIC-19-S9, EPIC-19-S12, EPIC-19-S14 · AC1, AC2, AC3, AC6, AC7 ·
 * test plan #2, #6, #7
 */
import { RUN_REFUSAL_CODES } from '@DeFlow/adapters';
import { openLedger, readRange } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { probeProvidersOnBoot } from '../../src/providers/boot-probe.ts';

const fetch = authorizedFetch();

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: {
      readonly providers?: readonly { id: string; state: string; vendorPath: string | null }[];
      readonly runId?: string;
    };
  };
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/**
 * The temp `PATH`, with a `node` on it and nothing else.
 *
 * Every fake below is a `#!/usr/bin/env node` script, so a child handed a
 * `PATH` with no `node` on it fails to *spawn* — a different story from the one
 * each of these machines is telling. Linking this Node into the temp directory
 * rather than appending its real directory to `PATH` is what keeps the spec
 * hermetic: the author's own machine has a real `claude-agent-acp` beside its
 * `node`, and a spec that found it would assert nothing at all.
 */
async function binDirWithNode(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, 'node'));
}

/** A vendor CLI that answers `--version` and nothing else — exactly what the
 * operator had, and exactly what `adapter-missing` means. */
async function vendorCliOnly(binDir: string): Promise<void> {
  await binDirWithNode(binDir);
  executable(
    join(binDir, 'claude'),
    '#!/usr/bin/env node\nprocess.stdout.write("2.1.220\\n");\nprocess.exit(0);\n',
  );
}

/** A bridge that resolves, answers `--version`, and dies on `initialize`. */
async function brokenBridge(binDir: string): Promise<void> {
  await vendorCliOnly(binDir);
  executable(
    join(binDir, 'claude-agent-acp'),
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('0.64.1\\n');
  process.exit(0);
}
process.stderr.write('Error: Cannot find module ./dist/index.js\\n');
process.exit(9);
`,
  );
}

/** The bundled mock agent, linked on under both names DeFlow resolves. */
async function mockAgentInstalled(binDir: string): Promise<void> {
  await binDirWithNode(binDir);
  await symlink(MOCK_AGENT_BIN, join(binDir, 'claude'));
  await symlink(MOCK_AGENT_BIN, join(binDir, 'claude-agent-acp'));
}

/**
 * The same machine, with the adapter behind a wrapper that records every
 * execution.
 *
 * A counter rather than a stopwatch: EPIC-19-S12's real claim is that admission
 * is a *read*, and a latency budget would pass on a fast machine with a probe
 * in it. Every path is absolute so the wrapper depends on no `PATH` at all.
 */
async function countingMockAgent(binDir: string, logPath: string): Promise<void> {
  await binDirWithNode(binDir);
  await symlink(MOCK_AGENT_BIN, join(binDir, 'claude'));
  executable(
    join(binDir, 'claude-agent-acp'),
    `#!/bin/sh\nprintf 'spawn\\n' >> ${logPath}\nexec ${process.execPath} ${MOCK_AGENT_BIN} "$@"\n`,
  );
}

/** How many times the wrapper above has been executed. */
function spawnCount(logPath: string): number {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

interface Daemon {
  readonly origin: string;
  readonly booted: Booted;
  readonly stop: () => Promise<void>;
}

/**
 * A daemon that has probed exactly `binDir` and nothing else.
 *
 * `PATH` is the temp directory alone — never the host's — because a spec that
 * inherited the developer's own `PATH` would pass or fail depending on whose
 * laptop it ran on, and "no provider resolves" is the assertion.
 */
async function bootAgainst(dataDir: string, binDir: string): Promise<Daemon> {
  const env = { ...process.env, PATH: binDir } satisfies NodeJS.ProcessEnv;
  const booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    token: TEST_DAEMON_TOKEN,
    providerRoots: [binDir],
    probeProviders: ({ db, dataDir: dir }) =>
      probeProvidersOnBoot({
        db,
        clock: { now: () => Date.now(), setTimer: setTimerOf(), sleep: sleepOf() },
        dataDir: dir,
        env,
        randomHex: () => 'aaaaaa',
      }),
  });
  const address = booted.http.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    booted,
    stop: () => booted.shutdown(),
  };
}

/** The real timer seam, spelled here so the probe runs on wall time like it
 * does in production — a probe holds a live child, and a fake timer beside one
 * is the rule docs/14 §8 names outright. */
function setTimerOf() {
  return (ms: number, fire: () => void) => {
    const handle = setTimeout(fire, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  };
}

function sleepOf() {
  return (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
}

async function submit(origin: string, text: string): Promise<Response> {
  return await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { kind: 'text', text },
      cwd: process.cwd(),
      permission: 'read',
    }),
  });
}

/** Every event kind the ledger holds for every run in it, in `seq` order. */
function kindsInLedger(dataDir: string): { runId: string; kinds: string[] }[] {
  const db = openLedger(dataDir);
  try {
    const rows = db
      .prepare<{ run_id: string }>(
        'SELECT run_id, MIN(seq) AS first FROM event GROUP BY run_id ORDER BY first',
      )
      .all();
    return rows.map((row) => ({
      runId: row.run_id,
      kinds: readRange(db, row.run_id as never, 0, 100).events.map((event) => event.kind),
    }));
  } finally {
    db.close();
  }
}

suite('EPIC-19-S9 — a vendor CLI with no ACP adapter is refused at submission', () => {
  it('answers 4xx no_usable_provider and records the refusal in the ledger', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await vendorCliOnly(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const response = await submit(daemon.origin, 'Migrate the checkout module');
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);

      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);

      // AC2 — the providers, as the UI branches on them.
      const claude = body.error.detail.providers?.find((entry) => entry.id === 'claude');
      expect(claude?.state).toBe('adapter-missing');
      expect(claude?.vendorPath).toBe(join(binDir, 'claude'));

      // AC3 — the package to install, the command that installs it, and the
      // sentence KAR-18.8 deleted, absent.
      expect(body.error.message).toContain('@agentclientprotocol/claude-agent-acp');
      expect(body.error.message).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
      expect(body.error.message).toContain(join(binDir, 'claude'));
      expect(body.error.message).not.toContain('claude is not installed');

      // AC4 — and the way to proceed with nothing installed.
      expect(body.error.message).toContain('DeFlow-mock-agent');
    } finally {
      await daemon.stop();
    }

    // AC1 — the run exists, and its three events say what happened, in order.
    const ledger = kindsInLedger(dataDir);
    const run = ledger.find((entry) => entry.kinds.includes('task.submitted'));
    expect(run).toBeDefined();
    expect(run?.kinds[0]).toBe('task.submitted');
    expect(run?.kinds).toContain('provider.probed');
    expect(run?.kinds.at(-1)).toBe('run.aborted');
    // The refusal is never also a hand-off: nothing may pick this run up later.
    expect(run?.kinds).not.toContain('run.created');
  });

  it('records what was and was not found, with the absolute resolved path', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await vendorCliOnly(binDir);
    const daemon = await bootAgainst(dataDir, binDir);
    let runId = '';
    try {
      const body = (await (
        await submit(daemon.origin, 'Migrate the checkout module')
      ).json()) as ErrorBody;
      runId = body.error.detail.runId ?? '';
      expect(runId).not.toBe('');
    } finally {
      await daemon.stop();
    }

    const db = openLedger(dataDir);
    try {
      // Scoped to the refused run: the boot probe appends `provider.probed`
      // too, under a synthetic run id of its own, and AC1 is a claim about
      // *this run's* ledger.
      const probed = db
        .prepare<{ payload: string }>(
          "SELECT payload FROM event WHERE kind = 'provider.probed' AND run_id = ? ORDER BY seq",
        )
        .all(runId)
        .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

      const claude = probed.find((payload) => payload.provider === 'claude');
      expect(claude?.admission).toBe('adapter-missing');
      expect(claude?.vendorPath).toBe(join(binDir, 'claude'));
      expect(claude?.adapterPath).toBeNull();
      expect(claude?.package).toBe('@agentclientprotocol/claude-agent-acp');
    } finally {
      db.close();
    }
  });
});

suite('EPIC-19-S12 — a usable machine is never refused', () => {
  it('answers 201 and appends no run.aborted', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const response = await submit(daemon.origin, 'Migrate the checkout module');
      expect(response.status).toBe(201);
    } finally {
      await daemon.stop();
    }

    const run = kindsInLedger(dataDir).find((entry) => entry.kinds.includes('task.submitted'));
    expect(run?.kinds).not.toContain('run.aborted');
  });

  it('spawns no child of its own at submission time', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    const logPath = join(tmp, 'spawns.log');
    await countingMockAgent(binDir, logPath);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      // The boot probe is a spawn, and it is the one this machine pays for:
      // `--version` and then the `initialize` handshake.
      const afterBoot = spawnCount(logPath);
      expect(afterBoot).toBeGreaterThan(0);

      expect((await submit(daemon.origin, 'Migrate the checkout module')).status).toBe(201);
      expect((await submit(daemon.origin, 'And the router as well')).status).toBe(201);

      // Two submissions, and not one further execution of the adapter. A check
      // that re-handshaked every vendor on every submission would put a second
      // of latency on the one path that has to feel instant.
      expect(spawnCount(logPath)).toBe(afterBoot);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-19-S14 — an adapter that resolves and then fails its handshake', () => {
  it('refuses with provider_handshake_failed and the child’s own stderr', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await brokenBridge(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const response = await submit(daemon.origin, 'Migrate the checkout module');
      expect(response.status).toBeGreaterThanOrEqual(400);

      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe(RUN_REFUSAL_CODES.handshakeFailed);
      // Not paraphrased: the module name is what makes this one reading.
      expect(body.error.message).toContain('Cannot find module ./dist/index.js');
      // The resolved path of the binary that failed.
      expect(body.error.message).toContain(join(binDir, 'claude-agent-acp'));
      // And never the sentence that makes an operator uninstall a working CLI.
      expect(body.error.message).not.toContain('is not installed');
    } finally {
      await daemon.stop();
    }
  });
});
