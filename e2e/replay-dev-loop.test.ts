/**
 * KAR-16.5 AC8 — `pnpm dev:replay`, as a developer actually runs it.
 *
 * Verifies: EPIC-16-S33 (the dev-loop scenario), EPIC-16-S31 · AC1, AC3, AC8
 *
 * The script is **read out of the root `package.json`** rather than restated,
 * exactly as `./support/dev-loop.ts` reads `dev`, so this spec cannot drift
 * from the command anybody types. The only substitution is the port: the script
 * names 7777 because that is where a daemon belongs, and a spec that bound it
 * would fail on any machine with a DeFlowd already running.
 *
 * *"A source edit reloads without restarting the browser session."* What that
 * means concretely, and what is asserted here: `node --watch` kills and respawns
 * the process — a **new** `bootId` on the **same** origin — and the tab that was
 * open reconnects on the `retry: 2000` the stream handed it at open. The
 * session survives; the daemon does not, and is not meant to
 * (docs/03-local-development.md §5).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { freePort, repoRoot, sleep, waitForHealth, waitForRestart } from './support/dev-loop.ts';

const TOUCHED = 'packages/daemon/src/replay/harness.ts';

/** The real `dev:replay` script, with only its port replaced. */
function replayScript(port: number): string {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = root.scripts?.['dev:replay'];
  if (script === undefined) {
    throw new Error('the root package.json declares no "dev:replay" script');
  }
  expect(script, 'dev:replay must run under node --watch (AC8)').toContain('--watch');
  return script.replace('--port 7777', `--port ${String(port)}`);
}

suite('EPIC-16-S33 — pnpm dev:replay', () => {
  let child: ReturnType<typeof spawn>;
  let origin: string;
  let dataDir: string;
  const chunks: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    dataDir = mkdtempSync(join(tmpdir(), 'DeFlow-replay-e2e-'));

    child = spawn('sh', ['-c', replayScript(port)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DeFlow_SSE_KEEPALIVE_MS: '250',
        DeFlow_LOG_LEVEL: 'info',
        // Set so the spec can prove it is *not* used: a replay keeps its ledger
        // in a directory of its own. @see "never writes into the developer's
        // data directory" below.
        DeFlow_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    await waitForHealth(origin, 60_000, () => {
      if (child.exitCode !== null) {
        throw new Error(`dev:replay exited with ${child.exitCode}:\n${chunks.join('')}`);
      }
    });
  }, 90_000);

  afterAll(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000).unref();
      });
    }
    if (process.env.DeFlow_KEEP_TMP === undefined) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serves the recorded run over the daemon’s own stream', async () => {
    // The token comes off the **printed handoff URL**, where it lives in the
    // fragment (KAR-15.2 AC7), because a replay deliberately keeps its ledger
    // in a directory of its own — see the assertion below.
    const token = /#token=([^\s&]+)/.exec(chunks.join(''))?.[1];
    expect(token, `no handoff URL was printed:\n${chunks.join('')}`).toBeDefined();

    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/stream?runs=*&since=0`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = '';
      // The `hello` frame and `retry: 2000` are the first two writes on any
      // DeFlowd stream; a replay is not a special case of that (AC3).
      while (!text.includes('retry: 2000') && reader !== undefined) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('event: hello');
      expect(text).toContain('retry: 2000');
    } finally {
      controller.abort();
    }
  });

  it('never writes into the developer’s data directory', () => {
    // `DeFlow_DATA_DIR` is where a *daemon* keeps a real ledger. A replay
    // restores a recording with its recorded `seq`, which may only be done into
    // a ledger of its own, so it takes a fresh directory and leaves this one
    // untouched — pointing `deflow replay` at a real `.DeFlow/` must never be
    // able to graft a fixture onto somebody's run.
    expect(existsSync(join(dataDir, 'ledger.db'))).toBe(false);
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(false);
  });

  it('prints the handoff URL and what it is replaying, and nothing else', () => {
    const printed = chunks.join('');
    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#token=/);
    expect(printed).toMatch(/replaying .*happy-path-12\/events\.jsonl — \d+ events/);
  });

  it('restarts on a source edit, on the same origin (AC8)', async () => {
    const before = await waitForHealth(origin, 5_000);
    const path = join(repoRoot, TOUCHED);
    const original = readFileSync(path, 'utf8');

    try {
      writeFileSync(path, `${original}\n// touched by the dev:replay e2e\n`);
      const restarted = await waitForRestart(origin, before.bootId, 60_000);

      expect(restarted.health.bootId).not.toBe(before.bootId);
      // Same origin, so the tab that was open reconnects to it rather than
      // being pointed somewhere new.
      expect((await waitForHealth(origin, 5_000)).apiVersion).toBe(before.apiVersion);
    } finally {
      writeFileSync(path, original);
      // Let the watcher's restart for the *revert* settle before the suite
      // tears the process down, or the teardown races a respawning daemon.
      await sleep(500);
    }
  }, 90_000);
});
