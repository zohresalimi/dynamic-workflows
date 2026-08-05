/**
 * KAR-05.3 — the verified provider table, encoded once.
 *
 * **This is the one file in `packages/adapters/src/` allowed to name vendors**,
 * and the exemption is narrow on purpose. KAR-05.2 AC5 forbids a per-vendor
 * *capability* matrix anywhere in this package, because a stale one does not
 * produce an error — it produces a wrong routing decision hours into a run, and
 * two of the five versions measured on 2026-08-02 were published that same day.
 * That rule is about what an agent can *do*, which is always read from a row
 * probed on this machine (`capabilities.ts`). This file is about how each
 * vendor is *invoked*, which cannot be probed: you have to know that OpenCode
 * takes a subcommand before you can ask it anything at all.
 *
 * So the trade is explicit. Invocation is a table here; capability is never a
 * table anywhere. `test/no-capability-table.test.ts` holds both halves — it
 * exempts this file from the vendor-name rule and, in exchange, asserts that
 * this file names no capability and imports nothing from `capabilities.ts`.
 *
 * **The finding that shapes the table** (verified 2026-08-02 by running a real
 * `initialize` handshake against each binary):
 *
 * | Vendor              | Kind    | Spawn                                    |
 * | ------------------- | ------- | ---------------------------------------- |
 * | Gemini CLI 0.53.1   | native  | `<abs>/gemini --acp`                     |
 * | Copilot CLI 1.0.77  | native  | `<abs>/copilot --acp`                    |
 * | OpenCode 1.18.11    | native  | `<abs>/opencode acp --cwd <worktree>`    |
 * | Claude Code 2.1.220 | adapter | `<abs>/claude-agent-acp`                 |
 * | Codex CLI 0.146.0   | adapter | `CODEX_PATH=<abs>/codex <abs>/codex-acp` |
 *
 * Claude Code and Codex **do not speak ACP** — verified absent from
 * `claude --help` (v2.1.220) and `codex --help` (v0.146.0), grepped, zero hits
 * — and the PRD's §4.7 claim that they do is contradicted as stated. They reach
 * ACP only through the `@agentclientprotocol/*` bridge packages, which is why
 * `kind` exists: an `adapter` entry spawns something the vendor did not write,
 * and KAR-05.7's conformance battery has to target those, not the natively-ACP
 * agents.
 *
 * Adding a vendor is one entry in `PROVIDER_SPECS`. If it ever needs a new
 * field on `ProviderSpec`, that is the signal that the assumption "every agent
 * speaks ACP the same way" leaked somewhere else too.
 *
 * Verifies: EPIC-05-S10 · AC1, AC2, AC3
 */
import type { ProviderId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import {
  type ResolveContext,
  type ResolvedProvider,
  resolveExecutable,
} from './binary-resolver.ts';
import { registryRefused } from './failures.ts';

/**
 * `native` speaks ACP itself; `adapter` reaches it through a bridge package
 * that drives the vendor CLI underneath.
 *
 * Load-bearing rather than descriptive: an adapter's fidelity to the CLI it
 * wraps is A0-2's risk to the whole ACP-first thesis, and the conformance
 * suite selects on this.
 */
export type ProviderKind = 'native' | 'adapter';

/** Everything the invocation of one vendor can depend on. */
export interface SpawnContext {
  readonly resolved: ResolvedProvider;
  /** The node's worktree. The one vendor that takes it takes it in argv. */
  readonly worktree: string;
  /**
   * Which argv variant to build, 0-based and defaulting to 0.
   *
   * Exactly one vendor has more than one, and only while a flag of its is
   * mid-deprecation. It is a number rather than a boolean so that "exactly one
   * retry" is a bound the launcher reads off the spec (`argvVariants`) instead
   * of a rule it remembers.
   */
  readonly variant?: number;
}

/** One resolved invocation: what to run, with what, and with what environment. */
export interface SpawnPlan {
  /** Absolute. Never a bare name for `PATH` to answer at spawn time. */
  readonly command: string;
  readonly argv: readonly string[];
  /** The **vendor-specific** entries only, merged over the daemon's own env by
   * whoever spawns. Empty for every vendor that needs none. */
  readonly env: NodeJS.ProcessEnv;
}

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  /** The bin name of the package that actually speaks ACP. */
  readonly bin: string;
  /** That package, at the version the spawn was verified against. */
  readonly package: string;
  /** The vendor CLI an adapter drives, where the adapter is not the CLI. */
  readonly companionBin?: string;
  /** How many argv variants exist. More than one only mid-deprecation. */
  readonly argvVariants: number;
  /** Absolute paths for this provider, or a tagged `adapter.spawn-failed`. */
  resolve(ctx: ResolveContext): ResolvedProvider;
  argv(ctx: SpawnContext): readonly string[];
  env(ctx: SpawnContext): NodeJS.ProcessEnv;
}

interface SpecEntry {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly bin: string;
  readonly package: string;
  readonly companionBin?: string;
  /**
   * One argv builder per variant, in the order they are attempted. Data rather
   * than a branch inside `argv`, so "the deprecated flag is tried second and
   * only second" is visible in the entry.
   */
  readonly variants: readonly ((ctx: SpawnContext) => readonly string[])[];
  readonly env?: (ctx: SpawnContext) => NodeJS.ProcessEnv;
}

const NO_ENV: NodeJS.ProcessEnv = {};

function defineSpec(entry: SpecEntry): ProviderSpec {
  const id = ProviderIdSchema.parse(entry.id);
  return {
    id,
    kind: entry.kind,
    bin: entry.bin,
    package: entry.package,
    ...(entry.companionBin === undefined ? {} : { companionBin: entry.companionBin }),
    argvVariants: entry.variants.length,
    resolve(ctx: ResolveContext): ResolvedProvider {
      const path = resolveExecutable(id, entry.bin, ctx);
      if (entry.companionBin === undefined) return { provider: id, path };
      const companionPath = resolveExecutable(id, entry.companionBin, {
        roots: ctx.companionRoots ?? ctx.roots,
        ...(ctx.companionPath === undefined ? {} : { binaryPath: ctx.companionPath }),
      });
      return { provider: id, path, companionPath };
    },
    argv(ctx: SpawnContext): readonly string[] {
      const variant = ctx.variant ?? 0;
      const build = entry.variants[variant];
      if (build === undefined) {
        throw registryRefused(
          `${entry.id} has ${entry.variants.length} argv variant(s) and was asked for variant ` +
            `${variant}; the bounded fallback is the point — an unbounded one turns a clear ` +
            'failure into a slow one',
          { provider: entry.id, variant, variants: entry.variants.length },
        );
      }
      return build(ctx);
    },
    env: entry.env ?? ((): NodeJS.ProcessEnv => NO_ENV),
  };
}

/**
 * The five verified providers.
 *
 * The three natively-ACP entries pass a flag or a subcommand; the two adapter
 * entries spawn a bridge binary and, for the one that needs it, point the
 * bridge at the vendor CLI through the environment rather than letting it
 * search (§4.3).
 */
export const PROVIDER_SPECS = {
  gemini: defineSpec({
    id: 'gemini',
    kind: 'native',
    bin: 'gemini',
    package: '@google/gemini-cli',
    // `--experimental-acp` still exists, and `--help` marks it "(deprecated,
    // use --acp instead)". Current flag first, one bounded fallback second.
    variants: [(): readonly string[] => ['--acp'], (): readonly string[] => ['--experimental-acp']],
  }),
  copilot: defineSpec({
    id: 'copilot',
    kind: 'native',
    bin: 'copilot',
    package: '@github/copilot',
    variants: [(): readonly string[] => ['--acp']],
  }),
  opencode: defineSpec({
    id: 'opencode',
    kind: 'native',
    bin: 'opencode',
    package: 'opencode-ai',
    // A subcommand, not a flag — and it takes the worktree itself.
    variants: [(ctx): readonly string[] => ['acp', '--cwd', ctx.worktree]],
  }),
  claude: defineSpec({
    id: 'claude',
    kind: 'adapter',
    bin: 'claude-agent-acp',
    package: '@agentclientprotocol/claude-agent-acp',
    variants: [(): readonly string[] => []],
  }),
  codex: defineSpec({
    id: 'codex',
    kind: 'adapter',
    bin: 'codex-acp',
    package: '@agentclientprotocol/codex-acp',
    companionBin: 'codex',
    variants: [(): readonly string[] => []],
    // The bridge honours CODEX_PATH to select the CLI it drives. Using it is
    // what keeps the resolution DeFlow already did from being redone against a
    // PATH DeFlow does not control.
    env: (ctx): NodeJS.ProcessEnv => {
      if (ctx.resolved.companionPath === undefined) {
        throw registryRefused(
          'codex-acp needs CODEX_PATH set to the resolved absolute codex binary; resolving the ' +
            'bridge without its companion would leave the bridge to search PATH, which is the ' +
            'one thing §4.3 forbids',
          { provider: 'codex', missing: 'companionPath' },
        );
      }
      return { CODEX_PATH: ctx.resolved.companionPath };
    },
  }),
} as const satisfies Record<string, ProviderSpec>;

export type KnownProviderId = keyof typeof PROVIDER_SPECS;

/** The spec for `id`, or `undefined` — an unknown provider is a planning
 * question, answered by the caller, not an exception thrown from a lookup. */
export function providerSpec(id: string): ProviderSpec | undefined {
  return Object.hasOwn(PROVIDER_SPECS, id)
    ? (PROVIDER_SPECS as Record<string, ProviderSpec>)[id]
    : undefined;
}

/** The complete invocation for one attempt: command, argv and env overlay. */
export function spawnPlan(spec: ProviderSpec, ctx: SpawnContext): SpawnPlan {
  return {
    command: ctx.resolved.path,
    argv: spec.argv(ctx),
    env: spec.env(ctx),
  };
}
