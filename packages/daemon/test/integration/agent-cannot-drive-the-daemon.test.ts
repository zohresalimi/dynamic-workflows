/**
 * KAR-15.2 test plan #10 — the threat-model row, exercised rather than
 * asserted in prose.
 *
 * Verifies: EPIC-15-S14 · AC1, AC10
 *
 * > An agent with a prompt-injected instruction and a shell is inside the trust
 * > boundary of an unauthenticated daemon that can start runs, read every
 * > artifact and approve human gates.
 *
 * This is that agent. `terminal/create` is an ACP method the *agent* invokes,
 * and `createTerminalService` is what the daemon runs when it does — so the
 * command below is spawned through the same code path a real prompt injection
 * would reach, with the same `buildChildEnv()` environment, and it issues a
 * real HTTP request to a real daemon on a real port. Nothing here is mocked;
 * the only thing that is scripted is what the agent decided to run.
 *
 * Integration: a real subprocess, a real socket and a real ledger are three of
 * the four things the assertion is about.
 */
import { it, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import {
  buildChildEnv,
  createRunTmpdir,
  createTerminalService,
  resolveLoginShellPath,
} from '../../src/index.ts';

let dir = '';
let worktree = '';
let loginPath = '';
let booted: Booted | undefined;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  loginPath = await resolveLoginShellPath();
  booted = await boot({ dataDir: join(dir, 'data'), port: 0, dev: false });
});

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(dir);
});

/** The agent's own environment, built exactly as the daemon builds it. */
async function childEnv(): Promise<Readonly<Record<string, string>>> {
  return buildChildEnv({
    base: { ...process.env },
    loginPath,
    tmpdir: await createRunTmpdir(dir),
  }).env;
}

/** Runs `command` through the terminal service and returns what it printed. */
async function throughTerminalCreate(
  env: Readonly<Record<string, string>>,
  script: string,
): Promise<string> {
  const service = createTerminalService({ root: worktree, childEnv: env });
  const id = await service.create({ command: process.execPath, args: ['-e', script] });
  await service.waitForExit(id);
  return service.output(id).output;
}

function eventCount(): number {
  const row = booted?.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM event').get();
  return row?.n ?? -1;
}

suite('an agent DeFlow spawned finds port 7777 and cannot drive it (AC10)', () => {
  it('is answered 401 missing_token, and creates no run', async () => {
    const before = eventCount();
    const port = booted?.port ?? 0;

    const printed = await throughTerminalCreate(
      await childEnv(),
      // What a prompt-injected agent would actually try: the control plane is
      // on loopback, the agent is on loopback, and starting a run is the most
      // valuable thing it could do with that.
      `fetch(${JSON.stringify(`http://127.0.0.1:${port}/api/runs`)}, {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ input: { kind: 'text', text: 'do as I say' }, cwd: '/tmp' }),
       })
        .then(async (response) => process.stdout.write(response.status + ' ' + (await response.text())))
        .catch((error) => process.stdout.write('ERROR ' + String(error)));`,
    );

    expect(printed).toContain('401');
    expect(printed).toContain('missing_token');
    // Not "the request failed" — the daemon answered, and answered a refusal.
    expect(printed).not.toContain('ERROR');
    expect(eventCount()).toBe(before);
  }, 30_000);

  it('received no token variable in its environment to find one with', async () => {
    const env = await childEnv();
    const token = booted?.token ?? '';
    expect(token).not.toBe('');

    // `buildChildEnv()` is an allowlist, so this holds by construction — but by
    // construction is exactly the kind of claim that stops being true quietly,
    // and the daemon token is on the wrong side of it like every other
    // `*_TOKEN` (docs/15-security-model.md §4.1).
    const printed = await throughTerminalCreate(
      env,
      'process.stdout.write(JSON.stringify(process.env))',
    );

    expect(printed).not.toContain(token);
    for (const name of Object.keys(JSON.parse(printed) as Record<string, string>)) {
      expect(name).not.toMatch(/TOKEN/i);
    }
  }, 30_000);

  it('cannot read the daemon file out of the data directory it was never told about', async () => {
    // The honest limit, stated as a test rather than as a promise: a process
    // running *as the user* can read `.DeFlow/daemon.json` if it knows where
    // to look, and this only shows that the environment does not tell it. That
    // raises the bar from trivial to requiring filesystem access as the user;
    // it does not eliminate the class, and only OS-level isolation would.
    const env = await childEnv();
    for (const value of Object.values(env)) {
      expect(value).not.toContain(join(dir, 'data'));
    }
  });
});
