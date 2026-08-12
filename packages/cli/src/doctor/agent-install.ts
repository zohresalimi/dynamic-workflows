/**
 * KAR-18.8 — two binaries, three states, and one optional `npm install -g`.
 *
 * The story is a bug report with a fix attached. The first operator to run the
 * shipped CLI on a machine that was not the author's was told
 * `claude is not installed` while `claude --version` answered in the same shell
 * one line above. Both sentences were true, of *different binaries*:
 * KAR-05.3's registry separates the vendor CLI (`spec.shim.bin`, `claude`) from
 * the thing DeFlow actually spawns (`spec.bin`, `claude-agent-acp`, the
 * `@agentclientprotocol` bridge), and `detectProviders` resolved only the
 * second while reporting the failure under the *provider's* name. Accurate
 * about the machine, wrong about the operator, and it sent them to install
 * something they already had.
 *
 * So the fix is a second resolution rather than a reworded sentence. Resolving
 * both binaries is what makes `adapter-missing` sayable at all, and once it is
 * sayable the remaining gap is one `npm install -g` — which this module will
 * run, under two conditions that never relax.
 *
 * **Nothing is spawned without an explicit yes.** `--fix`, or an affirmative
 * answer to a prompt that names the exact command first. A bare Enter is *no*:
 * the operator who pressed it to get past a wall of text did not consent to a
 * network install. `--json` never asks, because a health check that blocks on
 * stdin is a CI job that hangs until its timeout with no output at all.
 *
 * **The state afterwards is re-resolved, never inferred.** An `npm` that exits
 * `0` without producing the binary is a real outcome — a global prefix the
 * operator cannot write to is the common one — and a `doctor` that reported
 * that as fixed would be worse than the report this story replaced.
 *
 * Verifies: EPIC-18-S50 … EPIC-18-S56 · AC1, AC4-AC11
 */
import {
  PROVIDER_SPECS,
  type ProviderSpec,
  providerSpec,
  resolveExecutable,
} from '@DeFlow/adapters';
import type { Clock } from '@DeFlow/core';
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from './report.ts';

/**
 * What the machine has, per provider (AC1).
 *
 * `adapter-missing` is the state that did not exist before this story and the
 * whole reason it does now. `not-installed` covers a vendor CLI that is absent
 * *and* the degenerate case of a bridge with nothing to bridge — a
 * `claude-agent-acp` with no `claude` underneath it is not an installation, and
 * calling it one would move the same confusion along by one binary.
 */
export type AgentInstallState = 'installed' | 'adapter-missing' | 'not-installed';

export interface ProviderResolution {
  readonly provider: string;
  readonly state: AgentInstallState;
  /** `'native'` providers have one executable under one name; `'adapter'` ones
   * have a vendor CLI and a separate ACP bridge, and that is the whole seam. */
  readonly kind: ProviderSpec['kind'];
  /** The vendor CLI the operator installed: `spec.shim.bin`. */
  readonly vendorBin: string;
  /** Absolute, or `null` when nothing on `roots` resolved it. */
  readonly vendorPath: string | null;
  /** The binary DeFlow spawns: `spec.bin`. The same file for a native vendor. */
  readonly adapterBin: string;
  readonly adapterPath: string | null;
  /** The npm package that provides `adapterBin`. */
  readonly package: string;
}

/** The first root holding an executable called `bin`, or `null`. */
function tryResolve(spec: ProviderSpec, bin: string, roots: readonly string[]): string | null {
  try {
    // The registry's own resolver rather than a second `statSync` loop: it
    // follows symlinks, checks X_OK and distinguishes EISDIR from ENOENT, and
    // "does it resolve?" has to mean exactly what it means at spawn time.
    return resolveExecutable(spec.id, bin, { roots });
  } catch {
    return null;
  }
}

/** One provider's state, from resolving both of its binaries. */
export function resolveProviderState(
  spec: ProviderSpec,
  roots: readonly string[],
): ProviderResolution {
  const vendorPath = tryResolve(spec, spec.shim.bin, roots);
  const adapterPath = tryResolve(spec, spec.bin, roots);

  // For a `kind: 'native'` provider the two names are the same executable, so
  // the third branch is unreachable there — and it is written as a condition on
  // `kind` rather than left to the coincidence, because a native provider has
  // no adapter package to offer and claiming one would name something that does
  // not exist (AC1).
  const state: AgentInstallState =
    vendorPath === null
      ? 'not-installed'
      : adapterPath !== null
        ? 'installed'
        : spec.kind === 'adapter'
          ? 'adapter-missing'
          : 'not-installed';

  return {
    provider: spec.id,
    state,
    kind: spec.kind,
    vendorBin: spec.shim.bin,
    vendorPath,
    adapterBin: spec.bin,
    adapterPath,
    package: spec.package,
  };
}

/** The state, the check status and the sentence — from the resolutions alone. */
export interface ProviderVerdict {
  readonly state: AgentInstallState;
  readonly status: 'ok' | 'warn';
  readonly detail: string;
}

/**
 * What the operator is told about one provider (AC1, AC2).
 *
 * One function so that the three sentences cannot drift apart, and a pure one
 * so the invariant that this whole story is about — *"is not installed" never
 * co-occurs with a resolved vendor-CLI path* — is a table-driven unit test over
 * the registry rather than a sentence someone remembered to re-read.
 *
 * Neither of the two absences is a `fail`: DeFlow not being able to route
 * through one provider is not DeFlow being unable to run here, so this never
 * moves the exit code (AC3).
 */
export function providerVerdict(resolution: ProviderResolution): ProviderVerdict {
  if (resolution.state === 'installed') {
    return {
      state: 'installed',
      status: 'ok',
      detail:
        `"${resolution.adapterBin}" — the binary DeFlow spawns — resolves at ` +
        `${resolution.adapterPath}, the absolute path DeFlowd would use rather than one looked ` +
        "up on the daemon's own PATH later.",
    };
  }

  if (resolution.state === 'adapter-missing') {
    // The one sentence this must never contain is "<provider> is not
    // installed", because the operator can see that it is. It names the
    // resolved path of the binary they have, the package that provides the one
    // they do not, and the command — so the fix is a copy of one line rather
    // than a package name reconstructed out of a paragraph.
    return {
      state: 'adapter-missing',
      status: 'warn',
      detail:
        `"${resolution.vendorBin}" is installed at ${resolution.vendorPath}, so this vendor CLI ` +
        'is present and working. What is missing is its ACP adapter: DeFlow spawns ' +
        `"${resolution.adapterBin}", which comes from ${resolution.package}, and nothing on PATH ` +
        `resolves it. Install it with "${installCommand(resolution.package)}", or re-run ` +
        '"DeFlow doctor --fix" and answer yes.',
    };
  }

  // A native provider's vendor CLI *is* the ACP agent, so there is one package
  // to name. An adapter-kind one needs the vendor CLI first and the bridge
  // second, and saying only the second is how an operator ends up with a bridge
  // to nothing.
  const next =
    resolution.kind === 'native'
      ? `install it with "${installCommand(resolution.package)}".`
      : `DeFlow spawns "${resolution.adapterBin}" from ${resolution.package}, so this machine ` +
        `needs that vendor CLI and then its ACP adapter — "${installCommand(resolution.package)}" ` +
        `once "${resolution.vendorBin}" is on PATH.`;

  return {
    state: 'not-installed',
    status: 'warn',
    detail:
      `${resolution.provider} is not installed here: no executable "${resolution.vendorBin}" was ` +
      `found on PATH — ${next}`,
  };
}

/** Every registered provider, in id order — the order the report prints. */
export function resolveProviderStates(roots: readonly string[]): readonly ProviderResolution[] {
  return Object.values(PROVIDER_SPECS)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((spec) => resolveProviderState(spec, roots));
}

/** The command that is offered, and — verbatim — the command that is run. */
export const installCommand = (pkg: string): string => `npm install -g ${pkg}`;

/** Exactly what `doctor` may do about an `adapter-missing` provider. */
export type InstallMode = 'fix' | 'prompt' | 'none';

/**
 * `--fix` wins over everything, including `--json`: a provisioning script is
 * the one caller that legitimately wants the install with no human present.
 * `--json` otherwise means never, TTY or not — the machine that hangs on a
 * prompt is usually the one somebody attached a terminal to in order to debug
 * it, so "has a TTY" is not evidence that anyone is watching.
 */
export function installMode(input: {
  readonly json: boolean;
  readonly fix: boolean;
  readonly tty: boolean;
}): InstallMode {
  if (input.fix) return 'fix';
  if (input.json) return 'none';
  return input.tty ? 'prompt' : 'none';
}

/** `y` or `yes`, and nothing else. A bare Enter is no (AC4). */
export function isAffirmative(answer: string): boolean {
  const normalised = answer.trim().toLowerCase();
  return normalised === 'y' || normalised === 'yes';
}

/** One attempt: what ran, what it returned, how long it took, what it said. */
export interface InstallOutcome {
  readonly command: string;
  /** `null` when no process was started at all — see `stderr` for why. */
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  /** The child's own stderr, trimmed and capped. Never paraphrased (AC8). */
  readonly stderr: string;
}

/** Enough of npm's output to diagnose it, without pasting a whole install log. */
const STDERR_CAP = 4000;

function trimStderr(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= STDERR_CAP
    ? trimmed
    : `${trimmed.slice(0, STDERR_CAP)}\n… (truncated at ${STDERR_CAP} characters)`;
}

export interface InstallPorts {
  /** `PATH`, split — where `npm` itself is looked for. */
  readonly roots: readonly string[];
  /** Wall clock for the elapsed measurement; nothing here reads `Date.now`. */
  readonly clock: Clock;
  /** A scratch directory. **Never** the operator's repository (AC11). */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * `npm install -g <pkg>`, once.
 *
 * One attempt and no retry (AC10): every retry on a machine with no egress
 * costs a full npm timeout, and three of them turn a thirty-second health check
 * into two minutes of silence, which is how an operator learns to stop running
 * `doctor`.
 */
export async function installAdapterPackage(
  pkg: string,
  ports: InstallPorts,
): Promise<InstallOutcome> {
  const command = installCommand(pkg);
  const npmPath = resolveNpm(ports.roots);

  if (npmPath === null) {
    return {
      command,
      exitCode: null,
      elapsedMs: 0,
      stderr:
        'no executable "npm" was found on PATH, so nothing was run. Install the package by hand ' +
        `with: ${command}`,
    };
  }

  mkdirSync(ports.cwd, { recursive: true });
  const startedAt = ports.clock.now();

  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(npmPath, ['install', '-g', pkg], {
      cwd: ports.cwd,
      env: ports.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      resolve({ code: null, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

  return {
    command,
    exitCode: result.code,
    elapsedMs: Math.max(0, ports.clock.now() - startedAt),
    stderr: trimStderr(result.stderr),
  };
}

/**
 * `npm` on the operator's own `PATH`, or `null`.
 *
 * Its own loop rather than `resolveExecutable`, whose first argument is a
 * `ProviderId`: npm is not a provider, and borrowing one vendor's id to look it
 * up would put a misleading name into any diagnostic that ever escaped.
 */
function resolveNpm(roots: readonly string[]): string | null {
  for (const root of roots) {
    const candidate = join(root, 'npm');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // The next root, for every reason: absent, a directory, not executable.
    }
  }
  return null;
}

/** The sentence the operator answers, with the command in it before the yes. */
export function installPrompt(resolution: ProviderResolution): string {
  return (
    `${resolution.provider}: "${resolution.vendorBin}" is installed at ${resolution.vendorPath}, ` +
    `but the ACP adapter DeFlow spawns ("${resolution.adapterBin}", from ` +
    `${resolution.package}) is not. Run "${installCommand(resolution.package)}" now? [y/N] `
  );
}

export interface AdapterInstallInput {
  readonly resolutions: readonly ProviderResolution[];
  readonly mode: InstallMode;
  /** Prints the question and reads the answer. The only reader of stdin. */
  readonly prompt: (question: string) => Promise<string>;
  readonly roots: readonly string[];
  readonly clock: Clock;
  /** The global state directory; the scratch npm runs in is created under it. */
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface AdapterInstallResult {
  /** The states as they are **now**, re-resolved after any install (AC8). */
  readonly resolutions: readonly ProviderResolution[];
  /** One `agents.<provider>.install` check per provider an offer was made for. */
  readonly checks: ReadonlyMap<string, DoctorCheck>;
}

/** `<dataDir>/doctor-install/` — where npm runs, so no lockfile can land in the
 * operator's working copy (AC11). Created and removed around the attempt. */
const INSTALL_SCRATCH = 'doctor-install';

function declinedCheck(resolution: ProviderResolution): DoctorCheck {
  return {
    id: `agents.${resolution.provider}.install`,
    status: 'warn',
    detail:
      `declined — nothing was installed and no process was spawned. Run ` +
      `"${installCommand(resolution.package)}" yourself when you want it, or re-run ` +
      '"DeFlow doctor --fix".',
    data: { provider: resolution.provider, package: resolution.package, installed: false },
  };
}

function attemptCheck(
  before: ProviderResolution,
  outcome: InstallOutcome,
  after: ProviderResolution,
): DoctorCheck {
  const ran =
    `ran "${outcome.command}" — ` +
    `${outcome.exitCode === null ? 'no process was started' : `exit ${outcome.exitCode}`} in ` +
    `${outcome.elapsedMs} ms.`;

  const data = {
    provider: before.provider,
    package: before.package,
    command: outcome.command,
    exitCode: outcome.exitCode,
    elapsedMs: outcome.elapsedMs,
    stateAfter: after.state,
    ...(outcome.stderr === '' ? {} : { stderr: outcome.stderr }),
  };

  if (after.state === 'installed' && after.adapterPath !== null) {
    return {
      id: `agents.${before.provider}.install`,
      status: 'ok',
      detail:
        `${ran} "${after.adapterBin}" now resolves at ${after.adapterPath}, re-resolved rather ` +
        'than assumed from the exit code — so the Capabilities and Conformance sections below ' +
        'describe the adapter that exists now, not this machine as it was when doctor started.',
      data,
    };
  }

  // The outcome nobody writes a branch for: npm exited 0 and the binary is
  // still not there. A global prefix that is not on this PATH, a registry that
  // served a stub, or a partially written package all produce exactly this, and
  // reporting it as a success is the one failure mode worse than reporting
  // nothing at all.
  const why =
    outcome.exitCode === 0
      ? `The command reported success and "${before.adapterBin}" is still not resolvable on ` +
        'PATH, which usually means npm wrote it to a global prefix this PATH does not include — ' +
        'check "npm prefix -g" and whether its "bin" directory is on yours.'
      : `"${before.adapterBin}" still does not resolve on PATH.`;

  // NF1 — an offer that cannot be completed without a network is survivable
  // rather than fatal, and the report says when it *can* be completed instead
  // of leaving the operator to work that out.
  const next = looksLikeNoEgress(outcome.stderr)
    ? `Nothing else about DeFlow needs a registry: run "${outcome.command}" later from a machine ` +
      'with network egress, or through your proxy.'
    : `Install it by hand with "${outcome.command}".`;

  return {
    id: `agents.${before.provider}.install`,
    // Never `fail`: an adapter that could not be installed is a provider DeFlow
    // will not route through, not a machine DeFlow cannot run on (AC3).
    status: 'warn',
    detail:
      `${ran} ${why} ${before.provider} is still adapter-missing — the state was re-resolved ` +
      `afterwards rather than taken from the exit code. ${next}` +
      (outcome.stderr === '' ? '' : `\nnpm said:\n${outcome.stderr}`),
    data,
  };
}

/** npm's own vocabulary for "there was no registry at the other end". */
function looksLikeNoEgress(stderr: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network request to/i.test(stderr);
}

/**
 * Offers, installs and re-resolves — in that order, and before detection runs.
 *
 * Before detection is the load-bearing half of AC9. A `doctor` that installed
 * an adapter and then described the machine as it was at start would tell the
 * operator to run `doctor` again to find out whether `doctor` worked, which is
 * the round trip this story exists to remove.
 */
export async function offerAdapterInstalls(
  input: AdapterInstallInput,
): Promise<AdapterInstallResult> {
  const resolutions: ProviderResolution[] = [];
  const checks = new Map<string, DoctorCheck>();
  const scratch = join(input.dataDir, INSTALL_SCRATCH);
  let spawned = false;

  try {
    for (const resolution of input.resolutions) {
      // AC7 — a provider whose vendor CLI did not resolve is never offered an
      // adapter, under any flag combination. Half an install is worse than
      // none: it leaves a bridge to nothing and the vendor CLI still to get.
      if (resolution.state !== 'adapter-missing' || input.mode === 'none') {
        resolutions.push(resolution);
        continue;
      }

      if (
        input.mode === 'prompt' &&
        !isAffirmative(await input.prompt(installPrompt(resolution)))
      ) {
        checks.set(resolution.provider, declinedCheck(resolution));
        resolutions.push(resolution);
        continue;
      }

      spawned = true;
      const outcome = await installAdapterPackage(resolution.package, {
        roots: input.roots,
        clock: input.clock,
        cwd: scratch,
        env: input.env,
      });

      const spec = providerSpec(resolution.provider);
      const after = spec === undefined ? resolution : resolveProviderState(spec, input.roots);
      checks.set(resolution.provider, attemptCheck(resolution, outcome, after));
      resolutions.push(after);
    }
  } finally {
    if (spawned) rmSync(scratch, { recursive: true, force: true });
  }

  return { resolutions, checks };
}
