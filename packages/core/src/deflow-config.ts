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
import { type Constraint, ConstraintSchema } from './constraint.ts';
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

export const DeFlowConfigSchema = z.looseObject({
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  context: ContextConfigSchema.optional(),
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

/** KAR-09.5 AC1 — the inline threshold in bytes, defaulting to 8 KB. */
export function inlineThresholdBytesOf(config: DeFlowConfig): number {
  return config.context?.inlineThresholdBytes ?? INLINE_THRESHOLD_BYTES_DEFAULT;
}

/** The structured run-config constraints, `[]` when none are declared. */
export function configuredConstraints(config: DeFlowConfig): readonly Constraint[] {
  return config.constraints ?? [];
}
