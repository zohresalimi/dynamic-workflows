/**
 * KAR-09.6 — the vendor-facing half of compaction: the lever as environment,
 * and the conformance check over the frames the mechanism reads.
 *
 * The policy (70% for write-capable nodes, the opt-out scoped to `read`) and
 * the arithmetic (`Math.min(pct × effectiveWindow, defaultThreshold)`) are in
 * `@DeFlow/core`, where they can be reasoned about without a vendor. What is
 * here is the translation into one CLI's environment, and it is deliberately
 * thin: two variable names and a `String()`.
 *
 * `checkCompactionShape` is the part that earns its keep over time. Every
 * constant behind this story came from **one** shipping bundle, and the failure
 * mode of a drifted constant is not an exception — it is a threshold set at the
 * wrong number and a compaction that happens somewhere else than the operator
 * configured. So the shape is asserted against a stream: the boundary frame
 * still exists and still carries `pre_tokens`, and `modelUsage` still reports
 * the window fields the threshold is derived from. `DeFlow doctor` runs it
 * against whatever is installed; the specs run it against the committed
 * fixture. A change fails there rather than three hours into a run.
 *
 * Verifies: EPIC-09-S35 · AC7, AC8
 */
import type { AutoCompactConstants, CompactionLever } from '@DeFlow/core';
import type { ProviderSpec } from './provider-registry.ts';
import { COMPACT_BOUNDARY_SUBTYPE, type ShimLine, shimCompactBoundary } from './shim-frames.ts';

/**
 * The environment overlay that expresses `lever` for this provider — `{}` for a
 * vendor with no such lever, which is an honest "the vendor's own defaults"
 * rather than a variable invented for it.
 */
export function compactionEnv(spec: ProviderSpec, lever: CompactionLever): NodeJS.ProcessEnv {
  const compaction = spec.compaction;
  if (compaction === undefined) return {};

  // The disable flag wins outright: a percentage *and* a disable would be a
  // contradiction to hand a CLI, and the disable is the one a node opted into
  // explicitly. `compactionLever` has already refused the combination above
  // `read`, so what reaches here is a read node that asked for it.
  if (lever.autoCompactDisabled) return { [compaction.disableEnv]: '1' };

  return lever.autocompactPct === null ? {} : { [compaction.pctEnv]: String(lever.autocompactPct) };
}

/** The decoded offsets the threshold arithmetic needs, or `null` for a vendor
 * whose compaction DeFlow does not model. */
export function autoCompactConstants(spec: ProviderSpec): AutoCompactConstants | null {
  const compaction = spec.compaction;
  return compaction === undefined
    ? null
    : {
        outputReserve: compaction.outputReserve,
        autoCompactOffset: compaction.autoCompactOffset,
      };
}

/**
 * KAR-09.6 AC6 — where §6.3 says this vendor's session transcript is, or `null`
 * when the vendor documents none or the inputs cannot name a file.
 *
 * `~/.claude/projects/<project>/<session_id>.jsonl`, where `<project>` is the
 * working directory with its separators replaced by dashes. The convention was
 * decoded from the bundle and **never exercised against a live authenticated
 * session**, which is why every caller treats a missing file as
 * `originalHandle: null`.
 *
 * A session id that is not a plain identifier answers `null` rather than
 * producing a path. It matters more here than it looks: the caller reads the
 * result and treats "no file" as normal, so a path assembled out of `../..`
 * would read somewhere else on disk and nobody would ever be told.
 */
export function vendorTranscriptPath(
  spec: ProviderSpec,
  input: { readonly home: string; readonly project: string; readonly sessionId: string },
): string | null {
  const dir = spec.compaction?.transcriptDir;
  if (dir === undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input.sessionId)) return null;

  const project = input.project.replaceAll(/[^A-Za-z0-9]/g, '-');
  return [input.home, ...dir, project, `${input.sessionId}.jsonl`].join('/');
}

/**
 * What a stream must still carry for the compaction mechanism to mean anything,
 * as a list of problems — `[]` when the wire is as decoded.
 *
 * A list rather than a throw because both callers want it as data: the
 * conformance battery turns each entry into a failed assertion, and `DeFlow
 * doctor` prints them beside the versions actually installed.
 */
export function checkCompactionShape(lines: readonly ShimLine[]): readonly string[] {
  const problems: string[] = [];

  const boundaries = lines.filter((line) => shimCompactBoundary(line) !== null);
  if (boundaries.length === 0) {
    problems.push(
      `no ${COMPACT_BOUNDARY_SUBTYPE} frame carrying compact_metadata.pre_tokens: the vendor ` +
        'either stopped emitting it or renamed it, and DeFlow now records no compaction at all',
    );
  }

  const result = lines.find((line) => line.type === 'result');
  if (result === undefined) {
    problems.push('no result envelope: the turn reported neither usage nor a window');
    return problems;
  }

  const modelUsage = result.raw.modelUsage;
  const entries =
    typeof modelUsage === 'object' && modelUsage !== null && !Array.isArray(modelUsage)
      ? Object.values(modelUsage as Record<string, unknown>)
      : [];
  if (entries.length === 0) {
    problems.push('the result envelope carries no modelUsage entries');
    return problems;
  }

  // Checked on every entry rather than on the dominant one: a window reported
  // by one model and not another is the drift this is for.
  for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
    const missing = entries.filter(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>)[field] !== 'number',
    );
    if (missing.length > 0) {
      problems.push(
        `${missing.length} modelUsage entr${missing.length === 1 ? 'y' : 'ies'} report no ` +
          `${field}: the auto-compaction threshold is derived from it, and a missing one would ` +
          'have to be replaced by a per-model table',
      );
    }
  }

  return problems;
}
