/**
 * KAR-09.4 — the slice of `.DeFlow/config.yaml` this story reads.
 *
 * The file is the operator's, so the schema is **loose**: unknown top-level
 * keys are carried through untouched rather than rejected, because a story that
 * validated the whole file would break every workspace the moment a later story
 * added a key. What is validated is what is read — `providers.<id>
 * .pinReinjectTurns` and the structured `constraints` — and those are validated
 * strictly, with a path, because the alternative is a typo that silently
 * disables the mechanism it configures.
 *
 * Reading the file is `@DeFlow/daemon`'s job (`loadWorkspaceConfig`);
 * `@DeFlow/core` performs no I/O (docs/16-repo-layout.md R1).
 *
 * ```yaml
 * # .DeFlow/config.yaml
 * providers:
 *   claude:
 *     pinReinjectTurns: 8
 * constraints:
 *   - form: allow-only
 *     subject: write-path
 *     allowed: ['src/checkout/**']
 * ```
 *
 * Verifies: EPIC-09-S22 (third scenario), EPIC-09-S23 (background) · AC4, AC5
 */
import { z } from 'zod';
import { INLINE_THRESHOLD_BYTES_DEFAULT } from './artifact-offload.ts';
import { type CompactionLever, compactionLever } from './compaction.ts';
import { type Constraint, ConstraintSchema } from './constraint.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { PIN_REINJECT_TURNS_DEFAULT } from './reinjection.ts';

export const ProviderConfigSchema = z.looseObject({
  /**
   * §4.2(a)'s interval, per provider. A positive integer: `0` would mean
   * "re-inject on every turn", which is not what an operator who typed it
   * meant, and there is no spelling of "off" on purpose — the mechanism guards
   * the highest-severity risk in PRD §13.
   */
  pinReinjectTurns: z
    .number()
    .int()
    .positive('pinReinjectTurns must be a positive integer')
    .optional(),
  /**
   * KAR-09.6 AC7 — where the vendor's auto-compaction fires, as a percentage of
   * the window it reported for the turn.
   *
   * Bounded 1–100 rather than clamped: a `0` or a `150` is a typo, and clamping
   * one silently gives the operator a threshold they did not ask for. The
   * bounds are also the only honest range — the CLI applies
   * `Math.min(pct × effectiveWindow, defaultThreshold)`, so anything above 100
   * would be indistinguishable from the default anyway.
   */
  autocompactPct: z
    .number()
    .int()
    .min(1, 'autocompactPct must be between 1 and 100')
    .max(100, 'autocompactPct must be between 1 and 100')
    .optional(),
  /** KAR-09.6 AC8 — a `read` node's opt-out. Refused above `read` by
   * `compactionLever`, not here: the file cannot know a node's level. */
  disableAutoCompact: z.boolean().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * KAR-09.5 AC1 — the packet-assembly knobs. One so far, and it is a size in
 * bytes rather than in tokens on purpose: the threshold is about what a body
 * *is*, and bytes are the same number for every tokenizer, every model and
 * every counting tier (§7). A threshold in tokens would move under a packet
 * whenever the estimator changed tier mid-run.
 */
export const ContextConfigSchema = z.looseObject({
  inlineThresholdBytes: z
    .number()
    .int()
    .positive('inlineThresholdBytes must be a positive integer')
    .optional(),
});

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/**
 * KAR-14.2 AC1 — the workspace's default ceilings, per scope.
 *
 * Defaults, not commands: `POST /api/runs`'s `budget` block wins over anything
 * here, and what the run is actually measured against is pinned into the ledger
 * at creation (`budget.ceiling.set`) rather than read from this file per tick.
 * That is what stops an edit to this file changing what a run already in flight
 * is being held to.
 *
 * Every value is optional and there is no spelling of `0`: a zero ceiling would
 * pause every run on its first tick, and an operator who left the field out
 * meant "unbounded", which is what an absent value says.
 */
export const BudgetCeilingConfigSchema = z.looseObject({
  costUsd: z.number().positive('costUsd must be a positive number').optional(),
  wallclockMs: z.number().int().positive('wallclockMs must be a positive integer').optional(),
});

export type BudgetCeilingConfig = z.infer<typeof BudgetCeilingConfigSchema>;

export const BudgetConfigSchema = z.looseObject({
  /** The ceiling for the whole run. */
  run: BudgetCeilingConfigSchema.optional(),
  /** The ceiling every node inherits unless its plan or an operator says otherwise. */
  node: BudgetCeilingConfigSchema.optional(),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const DeFlowConfigSchema = z.looseObject({
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  context: ContextConfigSchema.optional(),
  /** F4.6's default ceilings for this workspace (KAR-14.2 AC1). */
  budget: BudgetConfigSchema.optional(),
  /** Run-config safety constraints, structured. Prose is refused here for the
   * same reason it is refused in the renderer: there is no free-prose path into
   * a `pinned.constraints` segment (AC1). */
  constraints: z.array(ConstraintSchema).optional(),
});

export type DeFlowConfig = z.infer<typeof DeFlowConfigSchema>;

/** An absent file is an empty config, never an error: `.DeFlow/config.yaml` is
 * optional and every value it can carry has a default. */
export function parseDeFlowConfig(value: unknown): DeFlowConfig {
  if (value === null || value === undefined) return {};
  return DeFlowConfigSchema.parse(value);
}

/** AC5 — `pinReinjectTurns` for one provider, defaulting to 8. */
export function pinReinjectTurnsFor(config: DeFlowConfig, provider: string): number {
  return config.providers?.[provider]?.pinReinjectTurns ?? PIN_REINJECT_TURNS_DEFAULT;
}

/**
 * KAR-09.6 AC7, AC8 — the compaction lever one node runs with: what the file
 * says for its provider, resolved against the node's permission level.
 *
 * The level is the second argument because the default is not a property of the
 * provider: **70% for write-capable nodes**, and nothing at all for a `read`
 * node, whose worst case is a lost analysis rather than lost work.
 */
export function compactionLeverFor(
  config: DeFlowConfig,
  provider: string,
  permission: PermissionLevel,
): CompactionLever {
  const entry = config.providers?.[provider];
  return compactionLever({
    permission,
    ...(entry?.autocompactPct === undefined ? {} : { autocompactPct: entry.autocompactPct }),
    ...(entry?.disableAutoCompact === undefined
      ? {}
      : { disableAutoCompact: entry.disableAutoCompact }),
  });
}

/** KAR-09.5 AC1 — the inline threshold in bytes, defaulting to 8 KB. */
export function inlineThresholdBytesOf(config: DeFlowConfig): number {
  return config.context?.inlineThresholdBytes ?? INLINE_THRESHOLD_BYTES_DEFAULT;
}

/** The structured run-config constraints, `[]` when none are declared. */
export function configuredConstraints(config: DeFlowConfig): readonly Constraint[] {
  return config.constraints ?? [];
}
