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
  PermissionLevel,
  SandboxDegradation,
  SandboxRuntimeConfig,
  SandboxStrategy,
} from '@DeFlow/core';
import {
  SANDBOX_DEPENDENCY_NAMES,
  SANDBOX_RUNTIME_BIN,
  SANDBOX_RUNTIME_PACKAGE,
  sandboxDependencies,
  sandboxRuntimeConfig,
  sandboxStrategy,
} from '@DeFlow/core';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { connectorPermissionRules } from './connector-policy.ts';
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
  /**
   * The connected MCP servers this machine actually has, by display name
   * (`connector-policy.ts`'s discovery vocabulary). Optional because a caller
   * that has not discovered any owes the policy nothing — absent means the
   * settings document carries no `permissions` key and every connector call
   * stays denied, which is the safe direction.
   */
  readonly connectorServers?: readonly string[];
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
 * KAR-23.9 — where the wrapper binary comes from, and the two places it may
 * come from.
 *
 * 1. The **operator's own login-`PATH` roots**, already resolved and split by
 *    the caller. This is what `sandboxedShimPlan` has always done, and it stays
 *    first: an operator who installed `srt` deliberately gets the one they
 *    installed.
 * 2. The copy **DeFlow itself pinned** (`SANDBOX_RUNTIME_VERSION`), resolved
 *    through its own `package.json` rather than by guessing a path inside
 *    `node_modules`. Without this a correctly installed DeFlow on a machine
 *    with no global `srt` refuses every non-vendor node — which is exactly the
 *    class of refusal KAR-23.9 exists to stop turning into "nothing runs".
 *
 * **Never a path from the worktree, and never one the plan names.** A tool
 * node's `run` line is untrusted content; if it could name its own sandbox it
 * would not be a sandbox. `null` means the wrapper cannot be found at all,
 * which the caller must turn into a refusal *before* a spawn — an unwrapped
 * child at a level DeFlow promised to enforce is the silent degradation
 * `failIfUnavailable` exists to prevent, one layer up.
 */
export function resolveSandboxRuntime(roots: readonly string[]): string | null {
  const onOperatorPath = onPath(SANDBOX_RUNTIME_BIN, roots);
  if (onOperatorPath !== null) return onOperatorPath;

  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${SANDBOX_RUNTIME_PACKAGE}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly bin?: string | Readonly<Record<string, string>>;
    };
    const bin =
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[SANDBOX_RUNTIME_BIN];
    if (bin === undefined) return null;
    const candidate = join(dirname(manifestPath), bin);
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    // Not installed, not executable, or a manifest this build cannot read. All
    // three are "there is no wrapper here", and the caller refuses.
    return null;
  }
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

    const connectorServers = sandbox.connectorServers ?? [];
    const policy = injection.build({
      level: ctx.permission,
      worktree: ctx.worktree,
      version: sandbox.version,
      ...(sandbox.allowedDomains === undefined ? {} : { allowedDomains: sandbox.allowedDomains }),
      ...(sandbox.onGateUnmet === undefined ? {} : { onGateUnmet: sandbox.onGateUnmet }),
      // KAR-08.5's document is also where the connector rules ride: one
      // `--settings` flag, one complete document. An empty server list emits
      // no `permissions` key at all rather than an empty one.
      ...(connectorServers.length === 0
        ? {}
        : { connectorPermissions: connectorPermissionRules(ctx.permission, connectorServers) }),
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

  // KAR-23.9 — one answer to "where is the wrapper", shared with
  // `sandboxedCommand` below. Before this, a machine with a correctly installed
  // DeFlow and no global `srt` refused every non-vendor node.
  const wrapper = resolveSandboxRuntime(sandbox.roots);
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

/**
 * KAR-23.9 — the same policy delivery, for a child that has **no vendor**.
 *
 * `sandboxedShimPlan` above takes a `ProviderSpec`, because everything it wraps
 * is a CLI KAR-05.3 registered. A plan script is not one: it is a line the
 * planner wrote, and `sandboxStrategy`'s own default-deny rule is what answers
 * the question it raises — anything that is not a *known* self-sandboxing CLI
 * is wrapped, because "I have not heard of this" and "this sandboxes itself"
 * are opposite claims.
 *
 * So the shape is `sandboxedShimPlan`'s minus the vendor: the caller supplies
 * the command and its argv, this returns what to spawn and the config document
 * that must exist on disk first. The config is written by the **caller**, for
 * the reason the module note gives — a plan builder that touched the filesystem
 * could not be the pure, construction-time refusal AC5 needs.
 *
 * `full` returns the bare command with `runtimeConfig: null`, on the same
 * argument the vendor path makes: a wrapper configured to allow everything and
 * no wrapper at all are the same enforcement, and only one of them can be
 * misconfigured. On the tool-node path that branch is unreachable —
 * `toolNodePerformer` refuses `full` before it gets here — but it exists, and
 * is tested, so the function stays total.
 */
export interface SandboxedCommand {
  /** What to spawn: the wrapper, or the command itself at `full`. */
  readonly command: string;
  readonly argv: readonly string[];
  /** The wrapper config and where it has to exist before the spawn. `null`
   * when nothing is wrapped. */
  readonly runtimeConfig: {
    readonly path: string;
    readonly document: SandboxRuntimeConfig;
  } | null;
}

export interface SandboxedCommandInput {
  /** The binary to run, absolute. Never a bare name for `PATH` to answer at
   * spawn time (docs/07-provider-adapter-layer.md §4.3). */
  readonly command: string;
  readonly args: readonly string[];
  readonly permission: PermissionLevel;
  /** The node's worktree, absolute — the only writable root below `full`. */
  readonly worktree: string;
  readonly platform: NodeJS.Platform;
  /** Where the wrapper may be found, and where the sandbox dependencies are
   * looked for: the operator's login `PATH`, already split. */
  readonly roots: readonly string[];
  /** A directory DeFlow owns, where the wrapper's config is written. */
  readonly configDir: string;
  /** Consulted only at `worktree+net`. */
  readonly allowedDomains?: readonly string[];
}

export function sandboxedCommand(input: SandboxedCommandInput): SandboxedCommand {
  // Dependencies first, for the reason `sandboxedShimPlan` checks them first: a
  // level that cannot be enforced on this machine must not reach a spawn at
  // all. Missing is a throw, never a degradation.
  checkSandboxDependencies({
    permission: input.permission,
    platform: input.platform,
    roots: input.roots,
  });

  const document = sandboxRuntimeConfig({
    level: input.permission,
    worktree: input.worktree,
    ...(input.allowedDomains === undefined ? {} : { allowedDomains: input.allowedDomains }),
  });

  if (document === null) {
    return { command: input.command, argv: [...input.args], runtimeConfig: null };
  }

  const wrapper = resolveSandboxRuntime(input.roots);
  if (wrapper === null) {
    throw sandboxUnavailable(SANDBOX_RUNTIME_BIN, `${SANDBOX_RUNTIME_BIN} (sandbox-runtime)`, {
      platform: input.platform,
      permission: input.permission,
      searched: input.roots.length,
    });
  }

  const path = join(input.configDir, SANDBOX_RUNTIME_SETTINGS_FILE);
  return {
    command: wrapper,
    // `--settings <path>` and then the wrapped command line, unmodified. The
    // caller's own quoting is never re-quoted here: `spawn` without a shell is
    // what makes an argv element containing spaces a single word.
    argv: [WRAPPER_SETTINGS_FLAG, path, input.command, ...input.args],
    runtimeConfig: { path, document },
  };
}
