/**
 * KAR-08.5 — putting the policy on the command line.
 *
 * `@DeFlow/core`'s `sandbox-policy.ts` decides *what* the policy is, for one
 * node, in each enforcement engine's dialect. This module decides how it
 * reaches a process, and there is exactly one right answer per strategy:
 *
 *  - **vendor / Claude Code** — `--settings '<inline JSON>'`. The crucial
 *    integration fact of the whole story: the CLI takes a complete settings
 *    document as a *string on the argv*, so per-node policy is possible
 *    without DeFlow ever opening a file under `~/.claude`. Nothing in this
 *    module reads or writes a user configuration directory, and
 *    `test/no-user-config-access.test.ts` is the grep that keeps it that way.
 *  - **vendor / Codex** — the sandbox mode is already a flag (`-s`), built by
 *    KAR-05.3's registry. Codex's `[sandbox_workspace_write]` section has no
 *    argv form, so `worktree+net` — the one level that needs it — is
 *    **refused** rather than approximated by `workspace-write` with egress
 *    silently off (EPIC-08-S24 scenario 3).
 *  - **sandbox-runtime** — for the CLIs with no sandbox of their own, `srt`
 *    wraps the vendor's own command line. Its config is a file, so this
 *    function returns the document and the path it must be written to, and
 *    the caller writes it: a plan builder that touched the filesystem could
 *    not be the pure, construction-time refusal that AC5 needs.
 *
 * **Refuse before spawning, always.** Every check here runs before a process
 * exists. A missing bubblewrap discovered after the agent is running is a
 * minute of unsandboxed execution nobody agreed to, and Claude Code's own
 * default is to degrade to exactly that, silently.
 *
 * Verifies: EPIC-08-S20, EPIC-08-S21, EPIC-08-S23, EPIC-08-S24, EPIC-08-S25 ·
 * AC1, AC5, AC7
 */
import type {
  GateDisposition,
  SandboxDegradation,
  SandboxRuntimeConfig,
  SandboxStrategy,
} from '@DeFlow/core';
import {
  SANDBOX_DEPENDENCY_NAMES,
  SANDBOX_RUNTIME_BIN,
  sandboxDependencies,
  sandboxRuntimeConfig,
  sandboxStrategy,
} from '@DeFlow/core';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxUnavailable } from './failures.ts';
import type { ProviderSpec, ShimContext, ShimPlan } from './provider-registry.ts';
import { shimPlan } from './provider-registry.ts';

/** The file the wrapper's `--settings` is pointed at. Per-run, under a
 * directory DeFlow made — never `~/.srt-settings.json`, which is the
 * operator's, and reading which would make the policy per-machine. */
export const SANDBOX_RUNTIME_SETTINGS_FILE = 'srt-settings.json';

/** The wrapper's own settings flag, from its README. */
const WRAPPER_SETTINGS_FLAG = '--settings';

/** Everything about *this machine and this node* that the policy's delivery
 * depends on. Separate from `ShimContext` because none of it is about how the
 * vendor is invoked — it is about whether the invocation can be enforced. */
export interface SandboxInvocation {
  /** The **detected** vendor CLI version (KAR-05.3's capability row records
   * it). Never a default: a gate compared against an assumed version is a gate
   * that silently stops applying. */
  readonly version: string;
  /** The platform the child will run on. An input rather than
   * `process.platform`, so the Linux prerequisites are testable from macOS. */
  readonly platform: NodeJS.Platform;
  /**
   * Directories the sandbox dependencies and the wrapper binary may be found
   * in — the login-shell `PATH`, already resolved and split by the caller.
   * Never a bare name for `PATH` to answer at spawn time
   * (docs/07-provider-adapter-layer.md §4.3).
   */
  readonly roots: readonly string[];
  /** A directory DeFlow owns, where the wrapper's config is written. */
  readonly configDir: string;
  /** Consulted only at `worktree+net`. */
  readonly allowedDomains?: readonly string[];
  /** The names `buildChildEnv()` dropped, for Copilot's own scrub flag. */
  readonly secretEnvVars?: readonly string[];
  /** Relaxes an unmet version gate from refusing to degrading. Explicit, per
   * AC6 — the credential default is to refuse. */
  readonly onGateUnmet?: GateDisposition;
}

export interface SandboxedShimPlan extends ShimPlan {
  readonly strategy: SandboxStrategy;
  /** Keys omitted because the detected CLI predates them. The caller appends
   * one `sandbox.degraded` event per entry. */
  readonly degraded: readonly SandboxDegradation[];
  /**
   * The wrapper config, and where it has to exist before the spawn. `null`
   * when nothing is wrapped — a vendor that sandboxes itself, or `full`, where
   * there is nothing to enforce and therefore nothing to write.
   */
  readonly runtimeConfig: {
    readonly path: string;
    readonly document: SandboxRuntimeConfig;
  } | null;
}

/** Whether `bin` is an executable file in one of `roots`. */
function onPath(bin: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const candidate = join(root, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not this one. A missing directory and a non-executable file are the
      // same answer here: the dependency is not usable from that root.
    }
  }
  return null;
}

/**
 * AC5 — every prerequisite the level needs, or a refusal naming the first one
 * missing.
 *
 * Both Linux dependencies are required, and they are checked in order rather
 * than in parallel so the message names one thing to install. A check that
 * stopped after finding either would pass on half a sandbox.
 */
export function checkSandboxDependencies(input: {
  readonly permission: ShimContext['permission'];
  readonly platform: NodeJS.Platform;
  readonly roots: readonly string[];
}): void {
  for (const dependency of sandboxDependencies({
    level: input.permission,
    platform: input.platform,
  })) {
    if (onPath(dependency, input.roots) !== null) continue;
    throw sandboxUnavailable(dependency, SANDBOX_DEPENDENCY_NAMES[dependency] ?? dependency, {
      platform: input.platform,
      permission: input.permission,
      searched: input.roots.length,
    });
  }
}

/**
 * The vendor's own invocation, with this node's sandbox policy applied.
 *
 * The order is the specification. Dependencies first, because a level that
 * cannot be enforced on this machine must not reach the vendor's flag table at
 * all; then `shimPlan`, whose own refusals (an unsupported output format, an
 * inexpressible level) are construction-time facts KAR-05.8 already owns; then
 * the policy, which is the only part this module decides.
 */
export function sandboxedShimPlan(
  spec: ProviderSpec,
  ctx: ShimContext,
  sandbox: SandboxInvocation,
): SandboxedShimPlan {
  checkSandboxDependencies({
    permission: ctx.permission,
    platform: sandbox.platform,
    roots: sandbox.roots,
  });

  const base = shimPlan(spec, ctx);
  const strategy = sandboxStrategy(spec.id);

  if (strategy === 'vendor') {
    // One vendor takes a whole settings document inline; the other carries its
    // sandbox mode in a flag that KAR-05.3's registry already built. Which is
    // which is a fact of the registry, not of this file — `provider-registry`
    // is the one place allowed to know how a vendor is invoked.
    const injection = spec.shim.sandbox;
    if (injection === undefined) {
      return { ...base, strategy, degraded: [], runtimeConfig: null };
    }

    const policy = injection.build({
      level: ctx.permission,
      worktree: ctx.worktree,
      version: sandbox.version,
      ...(sandbox.allowedDomains === undefined ? {} : { allowedDomains: sandbox.allowedDomains }),
      ...(sandbox.onGateUnmet === undefined ? {} : { onGateUnmet: sandbox.onGateUnmet }),
    });

    return {
      ...base,
      // One argument, not two, and not a path: the whole document is the
      // string. `JSON.stringify` is the serialisation, and `spawn` without a
      // shell is what makes quoting a non-issue.
      argv: [...base.argv, injection.flag, JSON.stringify(policy.settings)],
      strategy,
      degraded: policy.degraded,
      runtimeConfig: null,
    };
  }

  const secretEnvFlag = spec.shim.secretEnvFlag;
  const secrets = sandbox.secretEnvVars ?? [];
  const argv =
    secretEnvFlag !== undefined && secrets.length > 0
      ? [...base.argv, secretEnvFlag, secrets.join(',')]
      : [...base.argv];

  const document = sandboxRuntimeConfig({
    level: ctx.permission,
    worktree: ctx.worktree,
    ...(sandbox.allowedDomains === undefined ? {} : { allowedDomains: sandbox.allowedDomains }),
  });

  // `full`: nothing is enforced, so nothing wraps. A wrapper configured to
  // allow everything and no wrapper at all are the same enforcement, and only
  // one of them can be misconfigured.
  if (document === null) {
    return { ...base, argv, strategy, degraded: [], runtimeConfig: null };
  }

  const wrapper = onPath(SANDBOX_RUNTIME_BIN, sandbox.roots);
  if (wrapper === null) {
    throw sandboxUnavailable(SANDBOX_RUNTIME_BIN, `${SANDBOX_RUNTIME_BIN} (sandbox-runtime)`, {
      platform: sandbox.platform,
      permission: ctx.permission,
      searched: sandbox.roots.length,
    });
  }

  const path = join(sandbox.configDir, SANDBOX_RUNTIME_SETTINGS_FILE);
  return {
    ...base,
    command: wrapper,
    argv: [WRAPPER_SETTINGS_FLAG, path, base.command, ...argv],
    strategy,
    degraded: [],
    runtimeConfig: { path, document },
  };
}
