/**
 * KAR-18.2 — `deflow up` as a user meets it: a real `DeFlow` process, a real
 * socket, a real signal.
 *
 * Everything here is asserted from *outside* the process — stdout, stderr, exit
 * codes, listening sockets, files on disk — because that is all an operator
 * has. The in-process halves of the same scenarios (the port arithmetic, the
 * migration rollback, the probe cache, the group kill) are integration specs
 * next to the code they exercise; what only a spawned binary can settle is that
 * the argv, the shebang, the signal handling and the exit codes are wired to
 * them at all.
 *
 * Verifies: EPIC-18-S7, EPIC-18-S8, EPIC-18-S13, EPIC-18-S15, EPIC-18-S16 ·
 * AC1, AC2, AC3, AC6, AC7, AC8, AC9
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type CliProcess,
  MOCK_AGENT_BIN,
  makeDataDir,
  removeDataDir,
  sleep,
  spawnUp,
  waitForUrl,
} from './support/up.ts';

let tmp = '';
const running: CliProcess[] = [];

beforeEach(async () => {
  tmp = await makeDataDir();
});

afterEach(async () => {
  for (const cli of running.splice(0)) await cli.stop();
  await removeDataDir(tmp);
});

const start = (options: Parameters<typeof spawnUp>[0]): CliProcess => {
  const cli = spawnUp(options);
  running.push(cli);
  return cli;
};

/** A bin directory holding the bundled mock agent under a vendor's name. */
function withMockAgent(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'claude-agent-acp');
  writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${MOCK_AGENT_BIN} "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(shim, 0o755);
  return dir;
}

/** This machine's first non-loopback IPv4 address, if it has one. */
function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
  /** KAR-18.7 — the OS's own start time for `pid`, opaque and compared for
   * equality by `deflow status`. */
  readonly processStartedAt: string | null;
}

const daemonFile = (dataDir: string): DaemonFile =>
  JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonFile;

suite('deflow up, first boot (EPIC-18-S7)', () => {
  it('binds loopback, hands over a token in the fragment, and says how long it took', async () => {
    const dataDir = join(tmp, 'data');
    const bin = withMockAgent(join(tmp, 'bin'));

    // The scenario's "warm provider probe cache": the first boot records the
    // manifest, the second is the one the 3-second budget is measured on.
    const warm = start({ dataDir, args: ['--no-open'], binDirs: [bin] });
    await waitForUrl(warm);
    await warm.stop();

    const cli = start({ dataDir, args: ['--timings', '--no-open'], binDirs: [bin] });
    const url = await waitForUrl(cli);

    // AC1 — the URL, and the token in the **fragment**, never a query string.
    const parsed = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)$/.exec(url);
    expect(parsed, url).not.toBeNull();
    const port = Number(parsed?.[1]);
    const token = parsed?.[2] ?? '';
    // 32 bytes of crypto.randomBytes, base64url: 43 characters, no padding.
    expect(token).toHaveLength(43);
    expect(token).not.toContain('=');
    expect(url).not.toContain('?token=');

    // AC1 — the daemon file, its fields and its mode. `processStartedAt` is
    // KAR-18.7's: the OS's own start time for that pid, which is what makes
    // `deflow status` able to tell this daemon from a recycled pid.
    const file = daemonFile(dataDir);
    expect(Object.keys(file).sort()).toEqual([
      'pid',
      'port',
      'processStartedAt',
      'startedAt',
      // KAR-19.1 AC2 — the ticker this daemon life started, so `deflow status`
      // reports the loop rather than assuming it.
      'tickIntervalMs',
      'token',
    ]);
    expect(file.processStartedAt).toEqual(expect.any(String));
    expect(file.port).toBe(port);
    expect(file.token).toBe(token);
    expect(file.pid).toBe(cli.child.pid);
    expect(file.startedAt).toBeGreaterThan(0);
    expect(statSync(join(dataDir, 'daemon.json')).mode & 0o777).toBe(0o600);

    // Health is unauthenticated; everything else is not (KAR-15.2).
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/runs`)).status).toBe(401);
    // …and the token the fragment carried is one the daemon accepts: not a 401
    // is the claim, because which routes exist behind it is EPIC-15's business.
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/runs`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).not.toBe(401);

    // …and it is on loopback and nowhere else.
    const lan = lanAddress();
    if (lan !== null) {
      await expect(fetch(`http://${lan}:${port}/api/health`)).rejects.toThrow();
    }

    // AC2 — eight steps, each with its own number, and a total inside NF3.
    const stdout = cli.stdout();
    for (const step of [
      'pick-port',
      'resolve-data-dir',
      'lease',
      'migrate',
      'reap-orphans',
      'probe-providers',
      'bind-port',
      'open-browser',
    ]) {
      expect(stdout, step).toMatch(new RegExp(`^\\s+${step}\\s+\\d+ ms$`, 'm'));
    }
    const total = /^\s+total\s+(\d+) ms$/m.exec(stdout);
    expect(total, stdout).not.toBeNull();
    expect(Number(total?.[1])).toBeLessThan(3_000);
  });
});

suite('a second deflow up (EPIC-18-S8, AC3)', () => {
  it('exits 2 with the pid and port of the one that is running, and changes nothing', async () => {
    const dataDir = join(tmp, 'data');
    const first = start({ dataDir, args: ['--no-open'] });
    await waitForUrl(first);

    const file = daemonFile(dataDir);
    const bytes = readFileSync(join(dataDir, 'daemon.json'), 'utf8');
    const epochBefore = (await (
      await fetch(`http://127.0.0.1:${file.port}/api/health`)
    ).json()) as {
      daemonEpoch: number;
    };

    const second = start({ dataDir, args: ['--no-open'] });
    const exit = await second.exited;

    expect(exit.code).toBe(2);
    expect(second.stderr().trim()).toBe(
      `deflow up: another DeFlowd is already running (pid ${file.pid}, port ${file.port}) — ` +
        `open http://127.0.0.1:${file.port} or run 'deflow status'`,
    );
    // No stack trace, no SQLITE_BUSY, and no token anywhere in it.
    expect(second.stderr()).not.toMatch(/\bat .*:\d+:\d+/);
    expect(second.stderr()).not.toContain(file.token);
    expect(second.stdout()).toBe('');

    // It touched nothing: same file, same epoch.
    expect(readFileSync(join(dataDir, 'daemon.json'), 'utf8')).toBe(bytes);
    const epochAfter = (await (await fetch(`http://127.0.0.1:${file.port}/api/health`)).json()) as {
      daemonEpoch: number;
    };
    expect(epochAfter.daemonEpoch).toBe(epochBefore.daemonEpoch);
  });
});

suite('booting over a SIGKILLed daemon (EPIC-18-S13, AC6)', () => {
  it('takes the lease, bumps the epoch by one and rewrites the file', async () => {
    const dataDir = join(tmp, 'data');
    const first = start({ dataDir, args: ['--no-open'] });
    await waitForUrl(first);
    const before = daemonFile(dataDir);
    const epochBefore = (
      (await (await fetch(`http://127.0.0.1:${before.port}/api/health`)).json()) as {
        daemonEpoch: number;
      }
    ).daemonEpoch;

    // No handler runs, nothing is unlinked: only the kernel closing the file
    // descriptor releases this lease.
    first.child.kill('SIGKILL');
    await first.exited;
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(true);

    const second = start({ dataDir, args: ['--no-open'] });
    await waitForUrl(second);
    const after = daemonFile(dataDir);

    expect(after.pid).toBe(second.child.pid);
    expect(after.pid).not.toBe(before.pid);
    expect(after.token).not.toBe(before.token);
    const epochAfter = (
      (await (await fetch(`http://127.0.0.1:${after.port}/api/health`)).json()) as {
        daemonEpoch: number;
      }
    ).daemonEpoch;
    expect(epochAfter).toBe(epochBefore + 1);
  });
});

suite('graceful shutdown (EPIC-18-S16, AC7)', () => {
  it('removes the file, releases the lease and lets the next up start clean', async () => {
    const dataDir = join(tmp, 'data');
    const first = start({ dataDir, args: ['--no-open'] });
    await waitForUrl(first);
    const port = daemonFile(dataDir).port;

    first.child.kill('SIGINT');
    const exit = await first.exited;

    expect(exit.code).toBe(0);
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(false);
    // The port is genuinely closed, not merely unreferenced.
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();

    const second = start({ dataDir, args: ['--no-open'] });
    await expect(waitForUrl(second)).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    // "No manual intervention": nothing about a held lease, and no stack trace.
    // (A source-tree run warns that dist/ui is missing, which is a build state
    // rather than a lifecycle failure, so the assertion names what it means.)
    expect(second.stderr()).not.toMatch(/already running|Error|\bat .*:\d+:\d+/);
  });
});

suite('a machine with no agent CLI installed at all (EPIC-18-S15, AC8, AC9)', () => {
  it('starts, names what to install, and never touches a credential', async () => {
    const dataDir = join(tmp, 'data');
    const home = join(tmp, 'home');
    // AR-1's runtime half (AC9): a credentials file that *cannot* be read, and
    // a provider key in the environment. A daemon that reached for either would
    // fail here — with EACCES for the file — instead of passing quietly.
    mkdirSync(join(home, '.claude'), { recursive: true });
    const credentials = join(home, '.claude', '.credentials.json');
    writeFileSync(credentials, '{"note":"synthetic; nothing real lives here"}\n');
    chmodSync(credentials, 0o000);

    const cli = start({
      dataDir,
      args: ['--no-open'],
      // Only node: no agent binary of any kind on this PATH.
      binDirs: [],
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: 'sk-ant-synthetic-sentinel-not-a-real-key',
      },
    });

    const url = await waitForUrl(cli);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);

    const stdout = cli.stdout();
    expect(stdout).toContain('0 providers available');
    expect(stdout).toMatch(/npm install -g/);
    expect(stdout).toContain('deflow-mock-agent');
    expect(stdout).toContain('deflow replay');
    // No stack trace, and the sentinel key appears nowhere at all.
    expect(cli.stderr()).not.toMatch(/\bat .*:\d+:\d+/);
    expect(stdout).not.toContain('sk-ant-synthetic-sentinel');
    expect(cli.stderr()).not.toContain('sk-ant-synthetic-sentinel');

    // And it is still running, rather than having exited over any of it.
    await sleep(100);
    expect(cli.child.exitCode).toBeNull();

    chmodSync(credentials, 0o600);
  });
});
