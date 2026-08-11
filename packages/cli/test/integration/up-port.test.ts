/**
 * KAR-18.2 — `DeFlow up` and the port: one answer, reported identically
 * everywhere, and a pinned port that is a contract rather than a preference.
 *
 * The failure EPIC-18-S9 exists to catch is not "the daemon did not start". It
 * is the daemon starting on 7778 while the printed URL, `daemon.json` or the
 * status command still say 7777, because the port was chosen once and
 * re-derived from the constant somewhere else — after which the UI cannot
 * authenticate and nothing says why.
 *
 * Verifies: EPIC-18-S9, EPIC-18-S10 · AC1, AC4
 */
import { DEFAULT_PORT } from '@DeFlow/daemon';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runUp, type UpResult } from '../../src/up.ts';
import { readDaemonFile, upEnv, writeFakeBrowser } from './support/up-fixture.ts';

let tmp = '';
const started: UpResult[] = [];
const occupied: Server[] = [];

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  for (const result of started.splice(0)) {
    if (result.kind === 'started') await result.stop();
  }
  await Promise.all(
    occupied.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await removeTempDir(tmp);
});

/** Binds `port` on loopback for the rest of the test. */
function occupy(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      occupied.push(server);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not read the bound port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** True when something already holds 7777 — a dev daemon, say. */
async function alreadyOccupied(port: number): Promise<boolean> {
  try {
    await occupy(port);
    return false;
  } catch {
    return true;
  }
}

const remember = (result: UpResult): UpResult => {
  started.push(result);
  return result;
};

suite('port 7777 is occupied by an unrelated process (EPIC-18-S9, AC4)', () => {
  it('binds the next free port and every reader of it agrees', async () => {
    const dataDir = join(tmp, 'data');
    // Either this spec holds 7777 or something on the machine already does.
    // Both are the scenario: 7777 being busy is not evidence that DeFlow is
    // running, which is why the lease and the port are separate checks.
    const held = await alreadyOccupied(DEFAULT_PORT);

    const result = remember(
      await runUp({ env: upEnv({ dataDir }), port: null, open: false, timings: true }),
    );

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;

    expect(result.port).not.toBe(DEFAULT_PORT);
    expect(result.stdout).toContain(`http://127.0.0.1:${result.port}/#token=`);
    expect(result.url).toBe(`http://127.0.0.1:${result.port}/#token=${result.token}`);

    const file = readDaemonFile(dataDir);
    expect(file.port).toBe(result.port);
    expect(file.pid).toBe(process.pid);
    expect(statSync(join(dataDir, 'daemon.json')).mode & 0o777).toBe(0o600);

    // The daemon is really on that port, and the health route needs no token.
    const health = await fetch(`http://127.0.0.1:${result.port}/api/health`);
    expect(health.status).toBe(200);
    // …and everything else does (KAR-15.2).
    const runs = await fetch(`http://127.0.0.1:${result.port}/api/runs`);
    expect(runs.status).toBe(401);

    // The occupant of 7777 was not disturbed.
    if (!held) expect(occupied[0]?.listening).toBe(true);
  });
});

suite('an explicitly pinned --port that is occupied (EPIC-18-S10, AC4)', () => {
  it('refuses with exit 2, names the port, and starts nothing', async () => {
    const dataDir = join(tmp, 'data');
    const taken = await occupy(0);

    const result = remember(
      await runUp({ env: upEnv({ dataDir }), port: taken, open: false, timings: false }),
    );

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(String(taken));
    expect(result.stderr).toMatch(/in use/i);
    expect(result.stdout).toBe('');

    // Nothing was leased, migrated or written: the refusal comes first.
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(false);
    // And the occupant still has its port.
    expect(occupied[0]?.listening).toBe(true);
  });

  it('binds exactly the port it was given when that port is free', async () => {
    const dataDir = join(tmp, 'data');
    const free = await occupy(0);
    await new Promise<void>((resolve) => {
      occupied.pop()?.close(() => resolve());
    });

    const result = remember(
      await runUp({ env: upEnv({ dataDir }), port: free, open: false, timings: false }),
    );

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.port).toBe(free);
    expect(readDaemonFile(dataDir).port).toBe(free);
  });
});

suite('step 8: the browser actually gets the URL (AC1)', () => {
  it('hands the handoff URL, token in the fragment, to $BROWSER', async () => {
    const dataDir = join(tmp, 'data');
    const log = join(tmp, 'browser.log');
    const browser = await writeFakeBrowser(join(tmp, 'bin'), log);

    const result = remember(
      await runUp({
        env: upEnv({ dataDir, browser }),
        port: 0,
        open: true,
        timings: false,
      }),
    );

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;

    // The browser is detached and asynchronous by design, so this is polled.
    const deadline = Date.now() + 10_000;
    let opened = '';
    while (Date.now() < deadline && !opened.includes('#token=')) {
      opened = existsSync(log) ? await readFile(log, 'utf8') : '';
      if (!opened.includes('#token=')) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(opened.trim()).toBe(result.url);
  });

  it('opens nothing at all under --no-open', async () => {
    const dataDir = join(tmp, 'data');
    const log = join(tmp, 'browser.log');
    const browser = await writeFakeBrowser(join(tmp, 'bin'), log);

    const result = remember(
      await runUp({ env: upEnv({ dataDir, browser }), port: 0, open: false, timings: false }),
    );

    expect(result.kind).toBe('started');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(log)).toBe(false);
  });
});
