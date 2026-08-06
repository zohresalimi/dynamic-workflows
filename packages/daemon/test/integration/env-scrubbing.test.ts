/**
 * KAR-08.4 — the Kiro control, proved at the real spawn boundary.
 *
 * On 15 December 2025, AWS's own agent Kiro deleted a production environment
 * during a routine Cost Explorer task. Amazon's own rebuttal attributes the
 * ~13-hour outage to *misconfigured access controls*: the approval gate
 * existed and was on by default, and it was bypassed because the identity
 * the agent ran as carried standing production privileges. **A gate you can
 * bypass with ambient authority is theatre.** `buildChildEnv()` is the
 * control that removes the authority, and this file is what proves it holds
 * at the one place a unit test over the function alone cannot see: the real
 * `spawn()` call inside `createTerminalService`, which is where an agent's
 * `terminal/create` — an ACP method the agent itself invokes — actually gets
 * its environment (docs/09-workspace-and-safety.md §10.1-10.2,
 * docs/15-security-model.md §4).
 *
 * Every assertion below reads what the **child process itself** printed,
 * never what `buildChildEnv()` computed — the distinction the story's own
 * risk note calls out: "building the env correctly and then handing `spawn`
 * an options object that spreads `process.env` underneath it is an easy
 * mistake a unit test over `buildChildEnv()` alone cannot see."
 *
 * Verifies: EPIC-08-S16, EPIC-08-S17, EPIC-08-S18, EPIC-08-S19 · KAR-08.4
 * AC1, AC2, AC3, AC4, AC6 · test plan #3, #4, #6
 */
import type { EventRecord, EventSeq } from '@DeFlow/core';
import { appendEvents, openLedger, readEpoch, readRange } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  buildChildEnv,
  type CreateTerminalRequest,
  createRunTmpdir,
  createTerminalService,
  envDeclaredPayload,
  gitChildEnv,
  resolveLoginShellPath,
} from '../../src/index.ts';

const RUN_ID = 'run_20260806T000000Z_ab12c3';
const NODE = 'n1';

/** EPIC-08-S16's Background, verbatim: one variable per never-implicit
 * family DeFlowd's own process might plausibly hold. */
const KIRO_BACKGROUND = {
  AWS_ACCESS_KEY_ID: 'AKIA-fixture-do-not-use',
  AWS_SECRET_ACCESS_KEY: 'fixture-aws-secret-do-not-use',
  AWS_PROFILE: 'prod',
  GOOGLE_APPLICATION_CREDENTIALS: '/fixture/gcloud-creds.json',
  GOOGLE_CLOUD_PROJECT: 'fixture-project',
  KUBECONFIG: '/fixture/.kube/config',
  DATABASE_URL: 'postgres://fixture-user:fixture-pw@db.internal/prod',
  TF_TOKEN_app_terraform_io: 'fixture-tf-token-do-not-use',
  VAULT_ADDR: 'https://vault.internal',
  VAULT_TOKEN: 'fixture-vault-token-do-not-use',
  DOCKER_HOST: 'tcp://docker.internal:2376',
  SSH_AUTH_SOCK: '/tmp/fixture-ssh-agent.sock',
  GITHUB_TOKEN: 'ghp_fixture_do_not_use',
  NPM_TOKEN: 'npm_fixture_do_not_use',
  SLACK_TOKEN: 'xoxb-fixture-do-not-use',
  ANTHROPIC_API_KEY: 'sk-ant-fixture-do-not-use',
  OPENAI_API_KEY: 'sk-fixture-do-not-use',
  MY_CUSTOM_SECRET: 'fixture-custom-secret',
  DB_PASSWORD: 'fixture-db-password',
  SERVICE_CREDENTIALS: 'fixture-service-creds',
} as const;

let dir = '';
let worktree = '';
let loginPath = '';

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  // Resolved once, exactly the way the daemon resolves it at startup — a
  // real subprocess, never a mock (CLAUDE.md: fake binaries, not mocked
  // modules).
  loginPath = await resolveLoginShellPath();
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** The fake agent binary EPIC-08-S16 asks for: it prints `process.env` as
 * JSON and exits 0. `process.execPath -e <script>` is a real subprocess, an
 * absolute path (the login-shell PATH does not need to resolve it), and
 * exactly the pattern the rest of this test suite already uses for a
 * command whose *own* environment is the thing under test. */
const PRINT_ENV: CreateTerminalRequest = {
  command: process.execPath,
  args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
};

async function runAndCapture(
  childEnv: Readonly<Record<string, string>>,
  request: CreateTerminalRequest = PRINT_ENV,
): Promise<string> {
  const service = createTerminalService({ root: worktree, childEnv });
  const id = await service.create(request);
  await service.waitForExit(id);
  return service.output(id).output;
}

suite("the Kiro control: none of DeFlowd's ambient authority reaches the child", () => {
  it('none of the Background is present in the JSON the child actually printed', async () => {
    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({
      base: { ...process.env, ...KIRO_BACKGROUND },
      loginPath,
      tmpdir: tmp,
    });

    const printed = await runAndCapture(env);
    const received = JSON.parse(printed) as Record<string, string>;

    for (const [name, value] of Object.entries(KIRO_BACKGROUND)) {
      expect(received, name).not.toHaveProperty(name);
      // The stronger form: not merely "the key is absent" but "the value is
      // nowhere in the raw bytes the child printed" — a renamed key that kept
      // the value would still fail this.
      expect(printed, name).not.toContain(value);
    }
  });

  it('AC1: an ordinary, non-secret-shaped variable is dropped too — this is an allowlist, not a deny-list', async () => {
    const tmp = await createRunTmpdir(dir);
    const { env, scrubbed } = buildChildEnv({
      base: { ...process.env, SOME_RANDOM_APP_SETTING: 'ambient-only-marker' },
      loginPath,
      tmpdir: tmp,
    });
    expect(scrubbed).toContain('SOME_RANDOM_APP_SETTING');

    const printed = await runAndCapture(env);
    const received = JSON.parse(printed) as Record<string, string>;
    expect(received).not.toHaveProperty('SOME_RANDOM_APP_SETTING');
    expect(printed).not.toContain('ambient-only-marker');
  });

  it('a successful prompt injection that runs an allowlisted command finds no credential', async () => {
    // "the artifact written to disk contains none of those values either"
    // (EPIC-08-S16 scenario 2): the terminal's full output, which is what a
    // node's artifact is built from, is scanned the same way.
    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({
      base: { ...process.env, ...KIRO_BACKGROUND },
      loginPath,
      tmpdir: tmp,
    });
    const artifact = await runAndCapture(env, {
      command: process.execPath,
      args: [
        '-e',
        // An agent echoing "everything I can see" — the shape a successful
        // prompt injection would actually try.
        'process.stdout.write(Object.entries(process.env).map(([k,v]) => `${k}=${v}`).join("\\n"))',
      ],
    });
    for (const value of Object.values(KIRO_BACKGROUND)) {
      expect(artifact).not.toContain(value);
    }
  });

  it('even at what would be "full", the families are still not implicit (scenario 3)', async () => {
    // buildChildEnv() takes no `level` parameter — the ladder's `full` level
    // relaxes the command and network rows (KAR-08.1), never this allowlist.
    // Calling it exactly the same way regardless of level is the proof.
    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({
      base: { ...process.env, ...KIRO_BACKGROUND },
      loginPath,
      tmpdir: tmp,
    });
    const printed = await runAndCapture(env);
    expect(JSON.parse(printed) as Record<string, string>).not.toHaveProperty('AWS_PROFILE');
  });
});

suite('EPIC-08-S17 — the allowlist keeps exactly what the vendor binary needs', () => {
  it('PATH the child receives is the resolved login-shell PATH, not process.env.PATH', async () => {
    const tmp = await createRunTmpdir(dir);
    // A PATH DeFlowd's own process.env very likely does not carry, standing
    // in for "a launch agent's PATH lacks /opt/homebrew/bin" (EPIC-08-S17
    // scenario 3) without depending on this machine's real layout.
    const deliberatelyDifferentDaemonPath = '/definitely-not-the-login-path';
    const { env } = buildChildEnv({
      base: { ...process.env, PATH: deliberatelyDifferentDaemonPath },
      loginPath,
      tmpdir: tmp,
    });

    const printed = await runAndCapture(env);
    const received = JSON.parse(printed) as Record<string, string>;
    expect(received.PATH).toBe(loginPath);
    expect(received.PATH).not.toBe(deliberatelyDifferentDaemonPath);
  });

  it('TMPDIR is a real directory that exists and is mode 0700, and two runs never share one', async () => {
    const [tmpA, tmpB] = await Promise.all([createRunTmpdir(dir), createRunTmpdir(dir)]);
    const envA = buildChildEnv({ base: process.env, loginPath, tmpdir: tmpA }).env;
    const envB = buildChildEnv({ base: process.env, loginPath, tmpdir: tmpB }).env;

    const [printedA, printedB] = await Promise.all([runAndCapture(envA), runAndCapture(envB)]);
    const receivedA = JSON.parse(printedA) as Record<string, string>;
    const receivedB = JSON.parse(printedB) as Record<string, string>;

    expect(receivedA.TMPDIR).toBe(tmpA);
    expect(receivedB.TMPDIR).toBe(tmpB);
    expect(receivedA.TMPDIR).not.toBe(receivedB.TMPDIR);
  });

  it('a vendor config-dir variable the user set passes through unmodified', async () => {
    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({
      base: { ...process.env, CLAUDE_CONFIG_DIR: '/fixture/.claude-alt' },
      loginPath,
      tmpdir: tmp,
    });
    const printed = await runAndCapture(env);
    expect((JSON.parse(printed) as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(
      '/fixture/.claude-alt',
    );
  });
});

suite('EPIC-08-S18 — SSH_AUTH_SOCK dropped for the agent, kept for the Git wrapper', () => {
  it('the terminal-service child never receives it', async () => {
    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({
      base: { ...process.env, SSH_AUTH_SOCK: '/fixture/ssh-agent.sock' },
      loginPath,
      tmpdir: tmp,
    });
    const printed = await runAndCapture(env);
    expect(JSON.parse(printed) as Record<string, string>).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('gitChildEnv keeps it — a different, deliberate function', () => {
    const git = gitChildEnv({ ...process.env, SSH_AUTH_SOCK: '/fixture/ssh-agent.sock' });
    expect(git.SSH_AUTH_SOCK).toBe('/fixture/ssh-agent.sock');
  });
});

suite('EPIC-08-S19 — a declared variable at the node level, recorded by name only', () => {
  it('a node whose config declares NPM_TOKEN receives it; a sibling that declares nothing does not', async () => {
    const tmp = await createRunTmpdir(dir);
    const base = { ...process.env, NPM_TOKEN: 'npm_fixture_do_not_use' };

    const declaring = buildChildEnv({ base, loginPath, tmpdir: tmp, declared: ['NPM_TOKEN'] }).env;
    const sibling = buildChildEnv({ base, loginPath, tmpdir: tmp }).env;

    const [printedDeclaring, printedSibling] = await Promise.all([
      runAndCapture(declaring),
      runAndCapture(sibling),
    ]);

    expect((JSON.parse(printedDeclaring) as Record<string, string>).NPM_TOKEN).toBe(
      'npm_fixture_do_not_use',
    );
    expect(JSON.parse(printedSibling) as Record<string, string>).not.toHaveProperty('NPM_TOKEN');
  });

  it('the env.declared ledger event names the variable and carries no value, and the ledger has no trace of it', async () => {
    const db = openLedger(dir);
    try {
      const epoch = readEpoch(db);
      const payload = envDeclaredPayload({ node: NODE, attempt: 0, name: 'NPM_TOKEN' });
      const record: EventRecord = {
        kind: 'env.declared',
        v: 1,
        ts: 0,
        nodeId: NODE,
        attempt: 0,
        payload,
      };

      const seq = appendEvents(db, [
        {
          runId: RUN_ID,
          ts: record.ts,
          kind: record.kind,
          v: record.v,
          epoch,
          nodeId: record.nodeId,
          attempt: record.attempt,
          payload: record.payload,
        },
      ])[0] as EventSeq;
      expect(seq).toBeGreaterThan(0);

      const page = readRange(db, RUN_ID, 0, 10);
      const stored = page.events.find((e) => e.kind === 'env.declared');
      expect(stored?.payload).toEqual({ node: NODE, attempt: 0, name: 'NPM_TOKEN' });

      // "the ledger and every artifact for the run are scanned for the
      // token's value" (EPIC-08-S19 scenario 4) — zero matches.
      const wholeLedgerAsText = JSON.stringify(page.events);
      expect(wholeLedgerAsText).not.toContain('npm_fixture_do_not_use');
    } finally {
      db.close();
    }
  });
});
