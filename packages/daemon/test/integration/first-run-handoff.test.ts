/**
 * KAR-15.2 test plan #7 and #8 — the first-run handoff, end to end.
 *
 * Verifies: EPIC-15-S12 (scenarios 1 and 2; scenario 3 is the browser's, in
 * `packages/web/src/api/token.test.ts`), EPIC-15-S13 (scenario 2) · AC7, AC9
 *
 * Integration: the file mode is a real `stat` on a real file in a real
 * directory, and *"the daemon's request log for that navigation contains no
 * token substring"* is only answerable against a daemon that is actually
 * logging requests — so the second suite spawns `main.ts` the way the published
 * binary does and reads its ndjson off stdout.
 */
import { it, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { DAEMON_FILE_NAME, type DaemonFile, handoffUrl } from '../../src/daemon-file.ts';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

let dir = '';
let booted: Booted | undefined;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(dir);
});

async function readDaemonJson(): Promise<DaemonFile> {
  return JSON.parse(await readFile(join(dir, DAEMON_FILE_NAME), 'utf8')) as DaemonFile;
}

suite('DeFlow up generates and records the token (AC7, EPIC-15-S12 scenario 1)', () => {
  it('writes { pid, port, token, startedAt } at mode 0600', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });
    const file = await readDaemonJson();

    expect(Object.keys(file).sort()).toEqual(['pid', 'port', 'startedAt', 'token']);
    expect(file.pid).toBe(process.pid);
    expect(file.port).toBe(booted.port);
    expect(typeof file.startedAt).toBe('number');

    // 0600 and nothing wider: every other process running as this user can
    // still read it — that limit is honest and recorded — but no *other* user
    // on a shared machine can.
    const mode = statSync(join(dir, DAEMON_FILE_NAME)).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('generates 32 bytes of crypto randomness, base64url-encoded', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });
    const { token } = await readDaemonJson();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toBe(booted.token);
  });

  it('is the token the daemon actually authenticates with', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });
    const { token, port } = await readDaemonJson();

    const authorized = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/runs`);

    expect(authorized.status).not.toBe(401);
    expect(anonymous.status).toBe(401);
  });

  it('prints the URL with the token in the fragment, never in a query string', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });

    expect(booted.url).toBe(`http://127.0.0.1:${booted.port}/#token=${booted.token}`);
    // The half that matters: everything before the `#` carries nothing.
    const [address] = booted.url.split('#');
    expect(address).not.toContain(booted.token);
    expect(address).not.toContain('?');
    expect(handoffUrl(7777, 'abc')).toBe('http://127.0.0.1:7777/#token=abc');
  });

  it('removes the file on shutdown, so nothing points at a dead daemon', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });
    await booted.shutdown();
    booted = undefined;

    await expect(readFile(join(dir, DAEMON_FILE_NAME), 'utf8')).rejects.toThrow();
  });

  it('replaces a file a SIGKILLed daemon left behind, rather than trusting its token', async () => {
    booted = await boot({ dataDir: dir, port: 0, dev: false });
    const first = await readDaemonJson();
    await booted.shutdown();

    booted = await boot({ dataDir: dir, port: 0, dev: false });
    const second = await readDaemonJson();

    expect(second.token).not.toBe(first.token);
    const stale = await fetch(`http://127.0.0.1:${second.port}/api/runs`, {
      headers: { Authorization: `Bearer ${first.token}` },
    });
    expect(stale.status).toBe(401);
  });
});

suite('the fragment never reaches the server (AC7, EPIC-15-S12 scenario 2)', () => {
  it('logs the navigation as GET / with no query string and no token', async () => {
    const daemon = await spawnDaemon(dir);
    try {
      const printed = await daemon.handoffUrl();
      const token = printed.slice(printed.indexOf('#token=') + '#token='.length);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);

      // Navigating the printed URL: `fetch`, like every browser, sends
      // everything before the `#` and nothing after it.
      const response = await fetch(printed);
      // 200 with the built SPA, or 503 `ui_not_built` in a workspace that has
      // not run `pnpm build` — either way the daemon answered the navigation,
      // which is all this scenario needs. What it is *about* is the line the
      // daemon logged for it.
      expect([200, 503]).toContain(response.status);

      const requests = await daemon.requestLogFor('/');
      expect(requests.length).toBeGreaterThan(0);
      for (const line of requests) {
        expect(line.path).toBe('/');
        expect(line.query).toBe('');
      }

      // The property, stated over the whole request log rather than over the
      // one line: a fragment is never sent to the server, so no request the
      // daemon logged can contain any part of the token.
      for (const line of await daemon.requestLog()) {
        expect(JSON.stringify(line)).not.toContain(token);
      }
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});

interface RequestLine {
  readonly path: string;
  readonly query: string;
}

/**
 * DeFlowd as the published binary runs it: `node packages/daemon/src/main.ts`,
 * no watcher, no Vite, its own data directory — and at `debug`, because the
 * request log is what this file reads.
 */
async function spawnDaemon(dataDir: string) {
  const out: string[] = [];
  const child = spawn(process.execPath, [MAIN], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: {
      ...process.env,
      DeFlow_DATA_DIR: dataDir,
      DeFlow_PORT: '0',
      DeFlow_LOG_LEVEL: 'debug',
      DeFlow_DEV: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => out.push(chunk.toString()));

  const lines = (): string[] => out.join('').split('\n');

  const logObjects = (): Record<string, unknown>[] =>
    lines().flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

  return {
    /** The line `DeFlow up` shows the operator, once the daemon has printed it. */
    async handoffUrl(): Promise<string> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const printed = lines().find((line) => line.includes('#token='));
        if (printed !== undefined) return printed.trim();
        if (child.exitCode !== null) throw new Error(`DeFlowd exited:\n${out.join('')}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`DeFlowd never printed a handoff URL:\n${out.join('')}`);
    },
    requestLog(): Promise<Record<string, unknown>[]> {
      return Promise.resolve(logObjects().filter((line) => line.msg === 'request'));
    },
    async requestLogFor(path: string): Promise<RequestLine[]> {
      const matching = (await this.requestLog()).filter((line) => line.path === path);
      return matching.map((line) => ({
        path: String(line.path),
        query: String(line.query ?? ''),
      }));
    },
    async stop(): Promise<void> {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}
