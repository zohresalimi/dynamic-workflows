/**
 * KAR-08.4 — the child environment, built from an allowlist rather than
 * inherited (docs/15-security-model.md §4, docs/09-workspace-and-safety.md
 * §10.1-10.2).
 *
 * **This is the control that would actually have prevented the Kiro
 * incident.** On 15 December 2025, AWS's own agent Kiro deleted a production
 * environment during a Cost Explorer task; Amazon's own rebuttal attributes
 * it to *misconfigured access controls* — the approval gate existed and was
 * on by default, and it was bypassed because the identity the agent ran as
 * carried standing production privileges. A gate you can bypass with ambient
 * authority is theatre. Removing the authority ranks above adding the gate,
 * and `buildChildEnv()` is that removal.
 *
 * `buildChildEnv()` is the **only** function in DeFlowd that constructs an
 * agent's child environment (docs/15-security-model.md §1.2 check 2). Two
 * other builders exist deliberately, elsewhere, for different processes that
 * are not the agent:
 *
 *  - `gitChildEnv()` (../git/run-git.ts) — DeFlow's own git invocations. The
 *    agent never pushes; the `Git` wrapper does, and it needs the user's
 *    forwarded `SSH_AUTH_SOCK` to do it.
 *  - `setupChildEnv()` (../workspace/run-setup.ts) — `workspace.setup`, a
 *    command line the repository owner authored in `DeFlow.config.ts`, run
 *    once at worktree provisioning, before any agent exists to prompt-inject.
 *
 * Everything that spawns a process on the agent's behalf — the agent's own
 * process, and every `terminal/create` it issues — must build its `env` here
 * and nowhere else. `test/no-inline-child-env.test.ts` is the grep that
 * enforces it; the `.oxlintrc.json` override on the known agent-adjacent
 * spawn sites is the lint rule (AC7).
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * What every agent environment keeps, always, regardless of level — §4.1's
 * table minus the two DeFlow overrides (`PATH`, `TMPDIR`) which are not
 * copied from `base` at all. `full` relaxes the command and network rows,
 * never this list (EPIC-08-S16 scenario 3): `buildChildEnv()` takes no
 * `level` parameter, which is the mechanical proof of that claim.
 */
export const AGENT_BASE_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TZ',
  'USER',
] as const;

/** `AGENT_BASE_KEYS` plus the two DeFlow always sets itself — the full kept
 * set a caller with no declarations and no vendor config-dir var sees
 * (EPIC-08-S17 scenario 1's snapshot). */
export const AGENT_ENV_KEYS = [...AGENT_BASE_KEYS, 'PATH', 'TMPDIR'] as const;

/**
 * Vendor config-dir variables (§4.1's table). Passed through **only** when
 * the user set them — DeFlowd never invents one, because inventing
 * `CLAUDE_CONFIG_DIR` would silently redirect the vendor binary at a
 * credential store the user never pointed it at.
 */
export const VENDOR_CONFIG_DIR_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

/**
 * The never-implicit families (docs/15-security-model.md §4.1), as
 * case-insensitive patterns rather than a list of literal names — AC7 test
 * #7 exists precisely because a name-list misses `x_api_key` (lowercase) and
 * every secret nobody has thought to enumerate yet. A *family* is the only
 * thing that generalises to the secret a future integration adds.
 */
const NEVER_IMPLICIT_PATTERNS: readonly RegExp[] = [
  /^AWS_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^GOOGLE_CLOUD_/i,
  /^KUBECONFIG$/i,
  /^DATABASE_URL$/i,
  /^DATABASE_/i,
  /^TF_/i,
  /^TERRAFORM_/i,
  /^VAULT_/i,
  /^DOCKER_/i,
  /^REGISTRY_/i,
  /^SSH_AUTH_SOCK$/i,
  /_TOKEN$/i,
  /_API_KEY$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_CREDENTIALS$/i,
];

/** Whether `name` belongs to one of §4.1's never-implicit families. Exported
 * so `PermissionScope.scrubbedEnv` producers and tests can ask the same
 * question `buildChildEnv()` answers internally, without a second copy of the
 * pattern list. */
export function isNeverImplicit(name: string): boolean {
  return NEVER_IMPLICIT_PATTERNS.some((pattern) => pattern.test(name));
}

export interface BuildChildEnvOptions {
  /** DeFlowd's own environment, or a fixture in a test. Defaults to
   * `process.env` — never read anywhere else in this module. */
  readonly base?: NodeJS.ProcessEnv;
  /**
   * The login-shell `PATH`, resolved once at daemon start
   * (`resolveLoginShellPathOnce`) and passed in — **never** `process.env.PATH`
   * (AC4). Required rather than defaulted: a caller that forgot to resolve it
   * gets a compile error, not a silently-wrong `PATH`.
   */
  readonly loginPath: string;
  /**
   * The per-run directory `createRunTmpdir()` made, already `0700` (AC3).
   * Required for the same reason `loginPath` is.
   */
  readonly tmpdir: string;
  /**
   * The node's own declared variable names — from its plan config, never
   * from anything the agent said over the wire. Each is copied through only
   * when present in `base`; declaring a name DeFlowd never received invents
   * nothing (EPIC-08-S19). `validateEnvDeclaration` in `@DeFlow/core` refuses
   * a non-empty list at `read` level before this ever runs.
   */
  readonly declared?: readonly string[];
}

export interface BuiltChildEnv {
  readonly env: Readonly<Record<string, string>>;
  /**
   * Every variable present in `base` that this call did not keep — by name,
   * never by value. Feeds `PermissionScope.scrubbedEnv` directly (KAR-08.3's
   * `scrubbed-env:<VARNAME>` gate), and the run report's declaration list is
   * this set's complement among the never-implicit families.
   */
  readonly scrubbed: readonly string[];
}

/**
 * Starts from `{}` and adds only what §4.1 allows (AC1). The whole function
 * is synchronous and has no side effect — `loginPath` and `tmpdir` are
 * computed once, by the daemon, and handed in.
 */
export function buildChildEnv(options: BuildChildEnvOptions): BuiltChildEnv {
  const base = options.base ?? process.env;
  const declared = new Set(options.declared ?? []);
  const env: Record<string, string> = {};
  const kept = new Set<string>(['PATH', 'TMPDIR']);

  for (const key of AGENT_BASE_KEYS) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
      kept.add(key);
    }
  }

  for (const key of VENDOR_CONFIG_DIR_VARS) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
      kept.add(key);
    }
  }

  for (const name of declared) {
    const value = base[name];
    kept.add(name);
    if (value !== undefined) env[name] = value;
  }

  env.PATH = options.loginPath;
  env.TMPDIR = options.tmpdir;

  const scrubbed = Object.keys(base).filter((key) => base[key] !== undefined && !kept.has(key));

  return { env, scrubbed };
}

/**
 * Names the variable a node declared, for the `env.declared` ledger event
 * (`@DeFlow/core`'s `EnvDeclaredSchema`) — never the value. There is
 * deliberately no `value` field on the return type: the shape itself is what
 * makes "the value never enters the ledger" true, not the discipline of
 * whoever calls this.
 */
export function envDeclaredPayload(input: {
  readonly node: string;
  readonly attempt: number;
  readonly name: string;
}): { readonly node: string; readonly attempt: number; readonly name: string } {
  return { node: input.node, attempt: input.attempt, name: input.name };
}

/**
 * The user's login-shell `PATH`, resolved by actually running their shell
 * (AC4). DeFlowd's own `PATH` at daemon start is not the user's — a daemon
 * started by a launch agent, a systemd unit or `npx` inherits a different
 * one (docs/09-workspace-and-safety.md §9.1) — so this is a real subprocess,
 * not a guess from `process.env.SHELL`'s dotfiles.
 *
 * Falls back to `process.env.PATH` if the shell cannot be run at all (no
 * shell configured, or it refuses to start): a resolvable-but-wrong `PATH` is
 * better than a child that cannot find anything, and the fallback is exactly
 * as good as DeFlowd's own inherited `PATH` — no worse than never having
 * resolved anything.
 */
export function resolveLoginShellPath(options: { readonly shell?: string } = {}): Promise<string> {
  const shell = options.shell ?? process.env.SHELL ?? '/bin/sh';
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(shell, ['-lc', 'echo -n "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(process.env.PATH ?? '');
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', () => finish(process.env.PATH ?? ''));
    child.once('close', (code) => {
      finish(code === 0 && out.trim() !== '' ? out.trim() : (process.env.PATH ?? ''));
    });
  });
}

let cachedLoginPath: Promise<string> | null = null;

/**
 * `resolveLoginShellPath`, memoised for the life of the process (AC4: "once
 * at daemon start"). Production calls this exactly once, at startup; tests
 * call the unmemoised `resolveLoginShellPath` directly so one spec's shell
 * cannot poison the next.
 */
export function resolveLoginShellPathOnce(options?: { readonly shell?: string }): Promise<string> {
  cachedLoginPath ??= resolveLoginShellPath(options);
  return cachedLoginPath;
}

/** Test-only: clears the memoised login `PATH`, so a spec that needs a fresh
 * resolution is not stuck with an earlier spec's cached value. */
export function resetLoginShellPathCache(): void {
  cachedLoginPath = null;
}

/**
 * A fresh, per-run `TMPDIR`, mode `0700` (AC3). `fs.mkdtemp` already creates
 * with `0700` on POSIX (the C `mkdtemp(3)` contract, independent of umask),
 * and the explicit `chmod` below makes that a guarantee this module states
 * rather than one it borrows from a libc detail nobody here reads twice.
 */
export async function createRunTmpdir(base: string = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(base, 'DeFlow-run-'));
  await chmod(dir, 0o700);
  return dir;
}
