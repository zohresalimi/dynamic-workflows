/**
 * KAR-08.5 — the sandbox policy DeFlow hands to whoever enforces it
 * (docs/09-workspace-and-safety.md §9, ADR-0013).
 *
 * **Decision D12 (locked): DeFlow does not build a sandbox.** It owns policy
 * and mediation; the vendor CLI owns enforcement. So what this module produces
 * is not a sandbox — it is three *documents*, one per enforcement engine, all
 * generated from the same four-rung ladder:
 *
 *  1. Claude Code's settings object, injected as `--settings '<inline JSON>'`.
 *     That one capability is what makes per-node policy compatible with AR-1
 *     and with "DeFlow must not mutate the user's vendor CLI configuration" —
 *     a complete policy goes on the command line as a string, and no file
 *     under `~/.claude` is read or written on any path.
 *  2. Codex's `sandbox_mode` plus its `[sandbox_workspace_write]` section,
 *     whose four keys are verified from the Rust source
 *     (`codex-rs/protocol/src/protocol.rs`).
 *  3. `@anthropic-ai/sandbox-runtime`'s config, for the CLIs that ship no
 *     sandbox of their own.
 *
 * Four things in here are load-bearing and none of them is obvious.
 *
 * **`failIfUnavailable` and `allowUnsandboxedCommands`, or the ladder is
 * decorative.** Without the first, Claude Code falls back to running
 * *unsandboxed* when bubblewrap and socat are missing or the platform is
 * unsupported. Without the second, the model may retry a sandbox-failed
 * command outside the sandbox via `dangerouslyDisableSandbox`. Both failure
 * modes are silent: nothing in the run looks wrong, and the operator believes
 * a policy is in force that is not. Every level except `full` sets both.
 *
 * **The vendor ships no credential deny list.** Claude Code's *default* read
 * policy permits `~/.aws/credentials` and `~/.ssh/`. `sandbox.credentials` is
 * therefore populated explicitly, at every level below `full`, and the same
 * paths are independently denied by DeFlow's own mediation (KAR-08.2) —
 * defence in depth precisely because this enforcement point belongs to someone
 * else's release cycle.
 *
 * **The version is an input.** Claude Code's sandbox settings are version-
 * gated at fine granularity and an *unknown key is ignored rather than
 * rejected*, so emitting a key the installed CLI does not understand produces
 * a policy the operator believes is in force and is not. Every gated key is
 * therefore compared against a detected version, and an unmet gate either
 * omits the key and records a `sandbox.degraded` fact or refuses to schedule —
 * never silently includes it. Credential-related keys default to refusing.
 *
 * **Never nest.** Wrapping a self-sandboxing CLI in a DeFlow-authored
 * bubblewrap or Seatbelt profile turns a working sandbox into a broken one:
 * bubblewrap fails inside an unprivileged container and needs
 * `enableWeakerNestedSandbox`, which Anthropic warns considerably weakens
 * security. `sandboxStrategy` is one total function returning one of two
 * values, so "never both" is a property of the type rather than of a habit.
 *
 * What is deliberately *not* here: any bubblewrap or Seatbelt profile of
 * DeFlow's own, any file path to write a settings file to, and any process.
 * This module is pure, and `packages/adapters/src/sandbox.ts` is what puts its
 * output on an argv.
 *
 * Verifies: EPIC-08-S21, EPIC-08-S22, EPIC-08-S23, EPIC-08-S24, EPIC-08-S25 ·
 * AC2, AC3, AC4, AC6, AC7, AC8
 */
import { NEVER_IMPLICIT_FAMILIES } from './never-implicit.ts';
import { NodeFailureError } from './node-failure.ts';
import type { PermissionLevel } from './plan-graph.ts';

/**
 * Who enforces, for one provider.
 *
 * `vendor` delegates to the CLI's own sandbox; `sandbox-runtime` wraps a CLI
 * that has none. Two values and one function: there is no third state in which
 * a provider gets both, which is what EPIC-08-S25's "never both" asks for.
 */
export const SANDBOX_STRATEGIES = ['vendor', 'sandbox-runtime'] as const;

export type SandboxStrategy = (typeof SANDBOX_STRATEGIES)[number];

/**
 * The CLIs that ship a real OS-level sandbox: Claude Code (Seatbelt on macOS,
 * bubblewrap + socat on Linux/WSL2) and Codex (`sandbox-exec` on macOS,
 * Landlock LSM + seccomp-bpf on Linux). Both spellings of Claude Code's id are
 * accepted because the flows call it `claude-code` and KAR-05.3's registry
 * calls it `claude`.
 */
export const VENDOR_SANDBOX_PROVIDERS = ['claude', 'claude-code', 'codex'] as const;

/**
 * The narrow exception to "do not build a sandbox": Anthropic's standalone
 * extraction of the same Seatbelt/bubblewrap machinery, which can wrap an
 * arbitrary process and needs no Docker at all (so it stays NF6-compatible).
 *
 * **0.0.x.** Pinned exactly, with no range, and its API is treated as
 * unstable — the version below is asserted by a test and by the catalog guard,
 * so a floating bump cannot arrive without a visible diff.
 */
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime';
export const SANDBOX_RUNTIME_VERSION = '0.0.67';
/** Its bin, from the package's own `bin` map. */
export const SANDBOX_RUNTIME_BIN = 'srt';

/**
 * Which engine enforces this provider's policy.
 *
 * An unrecognised provider is **wrapped**, not trusted: "I have not heard of
 * this CLI" and "this CLI sandboxes itself" are opposite claims, and the
 * default-deny reading of the first is the second's negation.
 */
export function sandboxStrategy(provider: string): SandboxStrategy {
  return (VENDOR_SANDBOX_PROVIDERS as readonly string[]).includes(provider)
    ? 'vendor'
    : 'sandbox-runtime';
}

/**
 * AC3 — the credential paths the vendor's default read policy permits and
 * DeFlow does not.
 *
 * `~`-relative rather than expanded: the policy is generated in the daemon and
 * enforced in a child that may have a different `HOME` (a container, a
 * different user), and the vendor's own settings reader is what should resolve
 * it. It also keeps the golden files free of this machine's home directory.
 */
export const SANDBOX_CREDENTIAL_FILES = [
  '~/.aws/credentials',
  '~/.ssh/**',
  '~/.config/gh/**',
  '~/Library/Keychains/**',
] as const;

/**
 * AC6 — Claude Code's sandbox settings, and the version each one arrived in.
 *
 * A5-1, rated High: the granularity is real, and an unknown key is *ignored*
 * rather than rejected. Every value below was read from the vendor's own
 * release notes; the keys are spelled as their full settings path so that a
 * `sandbox.degraded` event names something a reader can search for.
 */
export const CLAUDE_SANDBOX_GATES = {
  'sandbox.credentials': '2.1.187',
  'sandbox.credentials.envVars.mode.mask': '2.1.199',
  'sandbox.filesystem.disabled': '2.1.216',
  'sandbox.network.strictAllowlist': '2.1.219',
} as const;

export type ClaudeGatedKey = keyof typeof CLAUDE_SANDBOX_GATES;

/**
 * The keys whose unmet gate defaults to refusing to schedule rather than
 * degrading: a policy that silently stops denying credentials is the one
 * failure this story exists to prevent.
 *
 * `sandbox.credentials.envVars.mode.mask` is deliberately **not** on this
 * list, and EPIC-08-S22's Examples table is why: on a CLI that has
 * `sandbox.credentials` but not `mask`, the file deny list — the half that
 * covers `~/.ssh` and `~/.aws/credentials` — is still enforced, and only the
 * environment-variable half is missing. That is a degradation worth recording,
 * not a reason to refuse the node.
 */
export const CREDENTIAL_GATED_KEYS: readonly ClaudeGatedKey[] = ['sandbox.credentials'];

/**
 * Dotted numeric version ordering, and nothing else.
 *
 * Not a semver library, and not a string comparison: `'2.1.9' > '2.1.187'`
 * lexicographically, which would clear every gate in the table above by
 * accident. Trailing non-numeric junk (`2.1.220-beta.1`) sorts as its numeric
 * prefix, which is the conservative reading — a prerelease of the gated
 * version is not the gated version.
 */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.split('.').map((part) => {
      const digits = /^\d+/.exec(part);
      return digits === null ? 0 : Number(digits[0]);
    });

  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** What to do about a key whose gate the installed CLI does not meet. */
export type GateDisposition = 'refuse' | 'degrade';

/** A key that was omitted because the detected CLI predates it. Becomes a
 * `sandbox.degraded` event; the node inspector renders it beside the level. */
export interface SandboxDegradation {
  readonly key: ClaudeGatedKey;
  readonly detected: string;
  readonly required: string;
}

/** Everything a policy for one node depends on, in any dialect. */
export interface SandboxPolicyInput {
  readonly level: PermissionLevel;
  /** The node's worktree, absolute. The only writable root below `full`. */
  readonly worktree: string;
  /** Consulted only at `worktree+net`; the ladder, not the dialect, decides
   * whether egress is possible at all. */
  readonly allowedDomains?: readonly string[];
  /** The env-var families the vendor's credential layer should mask. Defaults
   * to §4.1's never-implicit families, so a caller cannot narrow it by
   * forgetting to pass it. */
  readonly credentialEnvVars?: readonly string[];
}

export interface ClaudeSandboxInput extends SandboxPolicyInput {
  /** The **detected** CLI version. Required, and never defaulted: a gate
   * compared against a hardcoded "current" is a gate that stops working the
   * day someone downgrades. */
  readonly version: string;
  /** What an unmet gate does. Defaults to `refuse` for the credential keys and
   * `degrade` for the rest; passing `degrade` explicitly relaxes the
   * credential default, which is the "explicit configuration" AC6 requires. */
  readonly onGateUnmet?: GateDisposition;
  /**
   * The connector tool rules for this node's level, precomputed by the caller
   * (`@DeFlow/adapters`' `connectorPermissionRules` owns the vocabulary; this
   * module only carries the document). When present they ride in the same
   * `--settings` document as the sandbox block — one flag, one document —
   * including at `full`, where the sandbox relaxes but the destructive-verb
   * denials do not.
   */
  readonly connectorPermissions?: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
}

interface CredentialFiles {
  readonly mode: 'deny';
  readonly paths: readonly string[];
}

interface CredentialEnvVars {
  readonly mode: 'mask';
  readonly names: readonly string[];
}

/**
 * Claude Code's `sandbox` settings block.
 *
 * The *key paths* are verified (§9.2's table:
 * `sandbox.{enabled,filesystem,network,credentials,excludedCommands,
 * allowUnsandboxedCommands,failIfUnavailable}`, with `mode: deny | mask` on
 * credentials). The leaf shape of `credentials` is DeFlow's reading of that
 * table rather than a transcript of the vendor's schema, which is exactly why
 * AC8 makes the generated document a golden file: when it is checked against a
 * real CLI, the correction arrives as a readable diff instead of a quiet edit.
 */
export interface ClaudeSandboxSettings {
  readonly enabled: boolean;
  readonly failIfUnavailable?: boolean;
  readonly allowUnsandboxedCommands?: boolean;
  readonly filesystem?: {
    readonly disabled?: boolean;
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly network?: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist?: boolean;
  };
  readonly credentials?: {
    readonly files: CredentialFiles;
    readonly envVars?: CredentialEnvVars;
  };
  readonly excludedCommands?: readonly string[];
}

export interface ClaudeSandboxPolicy {
  /** The whole document `--settings` carries. A complete policy, never a diff
   * over whatever the operator happens to have in `~/.claude`. */
  readonly settings: {
    readonly sandbox: ClaudeSandboxSettings;
    /** Connector tool rules — see `ClaudeSandboxInput.connectorPermissions`.
     * Absent when the caller passed none, so the document stays byte-identical
     * for a machine with no connectors. */
    readonly permissions?: {
      readonly allow: readonly string[];
      readonly deny: readonly string[];
    };
  };
  readonly degraded: readonly SandboxDegradation[];
}

/** The node cannot be scheduled at this level against this CLI. Permanent:
 * retrying spawns the same binary at the same version. */
function refuseGate(key: ClaudeGatedKey, detected: string, required: string): NodeFailureError {
  return new NodeFailureError(
    `Claude Code ${detected} predates ${key} (added in ${required}), and an unknown settings key ` +
      'is ignored rather than rejected — so the credential policy would appear to be in force ' +
      'and would not be. Upgrade the CLI, or opt in to degrade-and-continue explicitly',
    {
      reason: 'safety.permission-unschedulable',
      class: 'permanent',
      detail: { key, detected, required },
    },
  );
}

/**
 * AC2, AC3, AC4, AC6 — the whole `--settings` document for one node.
 *
 * `full` is the one level that emits `enabled: false`: it relaxes the command
 * and network rows by the operator's explicit run-level opt-in, and stating
 * that plainly is different from leaving `failIfUnavailable` unset beside
 * `enabled: true`, which is the shape that silently degrades.
 */
export function claudeSandboxPolicy(input: ClaudeSandboxInput): ClaudeSandboxPolicy {
  // Emitted at every level, `full` included: `full` is the operator relaxing
  // the *sandbox*, and the connector denials are not the sandbox — a level
  // that dropped them would let bypassPermissions reach `delete_*` on the
  // operator's tracker.
  const permissions =
    input.connectorPermissions === undefined ? {} : { permissions: input.connectorPermissions };

  if (input.level === 'full') {
    return { settings: { sandbox: { enabled: false }, ...permissions }, degraded: [] };
  }

  const degraded: SandboxDegradation[] = [];

  /** Whether `key`'s gate is met, recording or refusing when it is not. */
  const gate = (key: ClaudeGatedKey): boolean => {
    const required = CLAUDE_SANDBOX_GATES[key];
    if (compareVersions(input.version, required) >= 0) return true;

    const disposition =
      input.onGateUnmet ?? (CREDENTIAL_GATED_KEYS.includes(key) ? 'refuse' : 'degrade');
    if (disposition === 'refuse') throw refuseGate(key, input.version, required);

    degraded.push({ key, detected: input.version, required });
    return false;
  };

  const writable = input.level === 'read' ? [] : [input.worktree];
  const domains = input.level === 'worktree+net' ? [...(input.allowedDomains ?? [])] : [];
  const envVarNames = [...(input.credentialEnvVars ?? NEVER_IMPLICIT_FAMILIES)];

  // Order matters only for the refusal: the credential gates are checked first
  // so that a CLI too old to deny credentials refuses before anything else is
  // decided about it.
  const credentialsAllowed = gate('sandbox.credentials');
  const maskAllowed = credentialsAllowed && gate('sandbox.credentials.envVars.mode.mask');
  const filesystemDisabledAllowed = gate('sandbox.filesystem.disabled');
  const strictAllowlistAllowed = gate('sandbox.network.strictAllowlist');

  return {
    settings: {
      sandbox: {
        enabled: true,
        // Without these two the CLI silently runs unsandboxed and the model
        // may retry outside the sandbox. They are the story.
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          // Stated rather than omitted where the CLI understands it: an
          // operator-level default that disabled the filesystem layer would
          // otherwise survive into a policy that looks complete.
          ...(filesystemDisabledAllowed ? { disabled: false } : {}),
          allowWrite: writable,
          denyWrite: [],
        },
        network: {
          allowedDomains: domains,
          deniedDomains: [],
          ...(strictAllowlistAllowed ? { strictAllowlist: true } : {}),
        },
        ...(credentialsAllowed
          ? {
              credentials: {
                files: { mode: 'deny', paths: [...SANDBOX_CREDENTIAL_FILES] },
                // `mask` rather than `deny` for variables: a name the child
                // cannot read at all fails confusingly inside the agent, and a
                // masked value cannot be used either way.
                ...(maskAllowed ? { envVars: { mode: 'mask', names: envVarNames } } : {}),
              },
            }
          : {}),
        // Nothing is exempt. Empty rather than absent, for the same reason
        // `disabled: false` is stated: this is a complete document.
        excludedCommands: [],
      } satisfies ClaudeSandboxSettings,
      ...permissions,
    },
    degraded,
  };
}

/**
 * Codex's `[sandbox_workspace_write]` keys, **verified from the Rust source**
 * (`codex-rs/protocol/src/protocol.rs`). Safe to hardcode where the *flag*
 * surface is not — `--full-auto` was gone by 0.146.0 and `AskForApproval` is
 * still churning.
 */
export const CODEX_WORKSPACE_WRITE_KEYS = [
  'writable_roots',
  'network_access',
  'exclude_tmpdir_env_var',
  'exclude_slash_tmp',
] as const;

export interface CodexWorkspaceWrite {
  readonly writable_roots: readonly string[];
  readonly network_access: boolean;
  /** `false`: KAR-08.4 gives every run its own `0700` `TMPDIR`, and that is
   * the one scratch directory the agent is *meant* to have. */
  readonly exclude_tmpdir_env_var: boolean;
  /** `true`: the shared `/tmp` is not the node's, and a worktree-scoped node
   * writing there is exactly the escape the level exists to prevent. */
  readonly exclude_slash_tmp: boolean;
}

export interface CodexSandboxPolicy {
  readonly sandbox_mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly sandbox_workspace_write?: CodexWorkspaceWrite;
}

/** AC4 — the same ladder in Codex's dialect. */
export function codexSandboxPolicy(input: SandboxPolicyInput): CodexSandboxPolicy {
  if (input.level === 'read') return { sandbox_mode: 'read-only' };
  if (input.level === 'full') return { sandbox_mode: 'danger-full-access' };

  return {
    sandbox_mode: 'workspace-write',
    sandbox_workspace_write: {
      writable_roots: [input.worktree],
      network_access: input.level === 'worktree+net',
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: true,
    },
  };
}

/**
 * `@anthropic-ai/sandbox-runtime`'s config document, as its README specifies
 * it: `filesystem.{denyRead,allowWrite,denyWrite}` and
 * `network.{allowedDomains,deniedDomains}`.
 *
 * Its defaults are the opposite way round from Claude Code's, which is worth
 * stating because getting it backwards fails open: **write** is allow-only and
 * empty means no write access, while **read** is deny-then-allow and the
 * default is to allow everywhere — so the credential paths have to be denied
 * explicitly here too.
 */
export interface SandboxRuntimeConfig {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
}

/**
 * The wrapper's config for one node, or `null` at `full`.
 *
 * `null` rather than a permissive config: "wrap the process in a sandbox that
 * allows everything" and "do not wrap the process" are the same enforcement
 * and different amounts of machinery, and the second cannot go wrong.
 */
export function sandboxRuntimeConfig(input: SandboxPolicyInput): SandboxRuntimeConfig | null {
  if (input.level === 'full') return null;

  return {
    network: {
      allowedDomains: input.level === 'worktree+net' ? [...(input.allowedDomains ?? [])] : [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [...SANDBOX_CREDENTIAL_FILES],
      allowWrite: input.level === 'read' ? [] : [input.worktree],
      denyWrite: [],
    },
  };
}

/**
 * AC5 — what has to be on `PATH` for the level to be enforceable at all.
 *
 * Linux/WSL2 sandboxing is bubblewrap plus socat, and **both** must be
 * installed; macOS ships Seatbelt, so there is nothing to check. Ubuntu 24.04+
 * additionally blocks bubblewrap's unprivileged user namespaces by default
 * (`kernel.apparmor_restrict_unprivileged_userns`), which `doctor` reports —
 * the presence check here is necessary and not sufficient, and both are why
 * `failIfUnavailable: true` is set regardless.
 */
export const LINUX_SANDBOX_DEPENDENCIES = ['bwrap', 'socat'] as const;

/** The name to put in a failure message, where the binary is not the project.
 * "bwrap is missing" sends nobody to the right `apt install`. */
export const SANDBOX_DEPENDENCY_NAMES: Readonly<Record<string, string>> = {
  bwrap: 'bubblewrap (bwrap)',
  socat: 'socat',
};

export function sandboxDependencies(input: {
  readonly level: PermissionLevel;
  readonly platform: NodeJS.Platform;
}): readonly string[] {
  if (input.level === 'full') return [];
  return input.platform === 'linux' ? [...LINUX_SANDBOX_DEPENDENCIES] : [];
}
