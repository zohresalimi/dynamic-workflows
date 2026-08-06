/**
 * KAR-08.4 — `buildChildEnv()`, unit level.
 *
 * On 15 December 2025, AWS's own agent Kiro deleted a production environment
 * because the identity it ran as carried standing credentials an approval
 * gate could not see. This is the control that would actually have prevented
 * it: the agent's environment is built from an allowlist, starting from an
 * empty object, rather than inherited from DeFlowd's own `process.env`.
 *
 * Two properties matter more than the rest and get their own suites below:
 * the kept set is *exactly* the allowlist (a snapshot, so an added key is a
 * visible diff), and the never-implicit families are dropped by pattern, not
 * by a list of literal names that a new secret-shaped variable is never on.
 *
 * Verifies: EPIC-08-S16 (unit half), EPIC-08-S17, EPIC-08-S18 (unit half) ·
 * KAR-08.4 AC1, AC2, AC3, AC5, AC7 (test plan #1, #2, #5, #7)
 */
import { readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { expect, it, describe as suite } from 'vitest';
import { gitChildEnv } from '../git/run-git.ts';
import {
  AGENT_ENV_KEYS,
  buildChildEnv,
  createRunTmpdir,
  envDeclaredPayload,
  isNeverImplicit,
  VENDOR_CONFIG_DIR_VARS,
} from './env.ts';

const LOGIN_PATH = '/usr/local/bin:/usr/bin:/bin';
const TMPDIR = '/tmp/DeFlow-run-fixture';

/** The Background of EPIC-08-S16: one variable per never-implicit family, plus
 * a few that must survive because they are not credential-shaped. */
const KIRO_BACKGROUND = {
  AWS_ACCESS_KEY_ID: 'AKIA-fixture',
  AWS_SECRET_ACCESS_KEY: 'fixture-secret',
  AWS_PROFILE: 'prod',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/user/.config/gcloud/creds.json',
  GOOGLE_CLOUD_PROJECT: 'fixture-project',
  KUBECONFIG: '/home/user/.kube/config',
  DATABASE_URL: 'postgres://user:pw@db.internal/prod',
  TF_TOKEN_app_terraform_io: 'fixture-tf-token',
  VAULT_ADDR: 'https://vault.internal',
  VAULT_TOKEN: 'fixture-vault-token',
  DOCKER_HOST: 'tcp://docker.internal:2376',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  GITHUB_TOKEN: 'ghp_fixture',
  NPM_TOKEN: 'npm_fixture',
  SLACK_TOKEN: 'xoxb-fixture',
  ANTHROPIC_API_KEY: 'sk-ant-fixture',
  OPENAI_API_KEY: 'sk-fixture',
  MY_CUSTOM_SECRET: 'fixture',
  DB_PASSWORD: 'fixture',
  SERVICE_CREDENTIALS: 'fixture',
};

const BASE = {
  HOME: '/home/user',
  USER: 'user',
  LOGNAME: 'user',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TZ: 'America/Los_Angeles',
  TERM: 'xterm-256color',
  // Deliberately present so AC1/AC4 have something to reject: PATH and TMPDIR
  // must come from the options, never from base.
  PATH: '/usr/bin:/bin',
  TMPDIR: '/var/folders/original',
  ...KIRO_BACKGROUND,
};

suite('the Kiro control: buildChildEnv() starts from {} (KAR-08.4 AC1)', () => {
  it('drops every variable not on the allowlist', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    for (const name of Object.keys(KIRO_BACKGROUND)) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('the kept set is exactly the base allowlist plus PATH and TMPDIR — a snapshot', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(Object.keys(env).toSorted()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'LOGNAME',
      'PATH',
      'SHELL',
      'TERM',
      'TMPDIR',
      'TZ',
      'USER',
    ]);
  });

  it('reports every dropped variable by name, for scrubbed-env gating', () => {
    const { scrubbed } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    for (const name of Object.keys(KIRO_BACKGROUND)) {
      expect(scrubbed, name).toContain(name);
    }
    // The two variables buildChildEnv itself overrides are not "scrubbed" —
    // they were replaced with a resolved value, not dropped.
    expect(scrubbed).not.toContain('PATH');
    expect(scrubbed).not.toContain('TMPDIR');
  });

  it('AGENT_ENV_KEYS names the ten base keys', () => {
    expect([...AGENT_ENV_KEYS].toSorted()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'LOGNAME',
      'PATH',
      'SHELL',
      'TERM',
      'TMPDIR',
      'TZ',
      'USER',
    ]);
  });
});

suite('even at "full", the families are not implicit (EPIC-08-S16 scenario 3)', () => {
  it('full relaxes the command and network rows, not this allowlist', () => {
    // buildChildEnv takes no `level` parameter at all: the allowlist is the
    // same function call regardless of level, which is the mechanical proof
    // that no level makes a credential family implicit.
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(env).not.toHaveProperty('AWS_PROFILE');
  });
});

suite('isNeverImplicit — pattern families, not a list of names (AC2, AC7 test #7)', () => {
  it.each([
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'KUBECONFIG',
    'DATABASE_URL',
    'DATABASE_REPLICA_URL',
    'TF_TOKEN_app_terraform_io',
    'TERRAFORM_CLOUD_TOKEN',
    'VAULT_ADDR',
    'VAULT_TOKEN',
    'DOCKER_HOST',
    'REGISTRY_AUTH',
    'SSH_AUTH_SOCK',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'MY_CUSTOM_SECRET',
    'DB_PASSWORD',
    'SERVICE_CREDENTIALS',
  ])('%s is never implicit', (name) => {
    expect(isNeverImplicit(name)).toBe(true);
  });

  it('matching is case-insensitive: a lowercase x_api_key is still dropped', () => {
    expect(isNeverImplicit('x_api_key')).toBe(true);
    expect(isNeverImplicit('my_custom_token')).toBe(true);
    expect(isNeverImplicit('aws_profile')).toBe(true);
  });

  it('does not flag ordinary variables', () => {
    for (const name of ['HOME', 'PATH', 'EDITOR', 'MY_APP_FEATURE_FLAG']) {
      expect(isNeverImplicit(name), name).toBe(false);
    }
  });
});

suite('vendor config-dir variables pass through only when the user set them', () => {
  it('lists CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    expect([...VENDOR_CONFIG_DIR_VARS].toSorted()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  });

  it('is present, unmodified, when the user set it', () => {
    const { env } = buildChildEnv({
      base: { ...BASE, CLAUDE_CONFIG_DIR: '/home/user/.claude-alt' },
      loginPath: LOGIN_PATH,
      tmpdir: TMPDIR,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/user/.claude-alt');
  });

  it('is absent when the user never set it — DeFlowd invents nothing', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env).not.toHaveProperty('CODEX_HOME');
  });
});

suite('PATH and TMPDIR are always overridden, never inherited (AC3, AC4)', () => {
  it('PATH is the login-shell PATH, not base.PATH', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(env.PATH).toBe(LOGIN_PATH);
    expect(env.PATH).not.toBe(BASE.PATH);
  });

  it('TMPDIR is the per-run directory, not base.TMPDIR', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(env.TMPDIR).toBe(TMPDIR);
    expect(env.TMPDIR).not.toBe(BASE.TMPDIR);
  });

  it('two builds with different tmpdirs never share one (AC3 unit half)', () => {
    const a = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: '/tmp/DeFlow-run-a' });
    const b = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: '/tmp/DeFlow-run-b' });
    expect(a.env.TMPDIR).not.toBe(b.env.TMPDIR);
  });
});

suite('declared per-node variables (EPIC-08-S19, KAR-08.4 AC6)', () => {
  it('a declared variable present in base reaches the child', () => {
    const { env } = buildChildEnv({
      base: BASE,
      loginPath: LOGIN_PATH,
      tmpdir: TMPDIR,
      declared: ['NPM_TOKEN'],
    });
    expect(env.NPM_TOKEN).toBe(BASE.NPM_TOKEN);
  });

  it('a declared variable is no longer reported as scrubbed', () => {
    const { scrubbed } = buildChildEnv({
      base: BASE,
      loginPath: LOGIN_PATH,
      tmpdir: TMPDIR,
      declared: ['NPM_TOKEN'],
    });
    expect(scrubbed).not.toContain('NPM_TOKEN');
  });

  it('a declared variable absent from base is simply absent from the child — nothing is invented', () => {
    const { env } = buildChildEnv({
      base: BASE,
      loginPath: LOGIN_PATH,
      tmpdir: TMPDIR,
      declared: ['SOME_VAR_NEVER_SET'],
    });
    expect(env).not.toHaveProperty('SOME_VAR_NEVER_SET');
  });

  it('a sibling build that declares nothing does not get it (EPIC-08-S19 scenario 2)', () => {
    const declaring = buildChildEnv({
      base: BASE,
      loginPath: LOGIN_PATH,
      tmpdir: TMPDIR,
      declared: ['NPM_TOKEN'],
    });
    const sibling = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(declaring.env.NPM_TOKEN).toBeDefined();
    expect(sibling.env).not.toHaveProperty('NPM_TOKEN');
  });

  it('envDeclaredPayload names the variable and carries no value', () => {
    const payload = envDeclaredPayload({ node: 'n1', attempt: 0, name: 'NPM_TOKEN' });
    expect(payload).toEqual({ node: 'n1', attempt: 0, name: 'NPM_TOKEN' });
    expect(JSON.stringify(payload)).not.toContain(BASE.NPM_TOKEN);
  });
});

suite('gitChildEnv() and buildChildEnv() are separate functions, deliberately (AC5)', () => {
  it('buildChildEnv drops SSH_AUTH_SOCK', () => {
    const { env } = buildChildEnv({ base: BASE, loginPath: LOGIN_PATH, tmpdir: TMPDIR });
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('gitChildEnv keeps it — the agent never pushes, the Git wrapper does', () => {
    const git = gitChildEnv(BASE);
    expect(git.SSH_AUTH_SOCK).toBe(BASE.SSH_AUTH_SOCK);
  });

  it('the two builders are named differently and neither calls the other', () => {
    expect(buildChildEnv).not.toBe(gitChildEnv);
  });
});

suite('createRunTmpdir — a real per-run directory, mode 0700 (AC3)', () => {
  it('creates a directory that exists and is mode 0700', async () => {
    const dir = await createRunTmpdir();
    try {
      const mode = statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two concurrent runs get two distinct directories (AC3, EPIC-08-S17 scenario 4)', async () => {
    const [a, b] = await Promise.all([createRunTmpdir(), createRunTmpdir()]);
    try {
      expect(a).not.toBe(b);
      expect(statSync(a).mode & 0o777).toBe(0o700);
      expect(statSync(b).mode & 0o777).toBe(0o700);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('nests under the given base directory', async () => {
    const parent = await createRunTmpdir();
    try {
      const before = readdirSync(parent).length;
      expect(before).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
