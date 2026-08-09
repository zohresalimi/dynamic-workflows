/**
 * KAR-12.3 — the adversarial tier's side of the contract
 * (docs/10-verification-gates.md §4).
 *
 * The enforcement itself is not here and must not be: the schema reaches the
 * CLI on `--json-schema` / `--output-schema` as the file
 * `.DeFlow/schemas/verdict.schema.json`, the return is validated by Ajv against
 * that same file, and the budget is enforced by `judgeHandoff` — all of it
 * already built by KAR-09.9 and EPIC-05. What this module adds is the two
 * things specific to a gate: the contract a gate node is held to, and what
 * DeFlow does with a return that already validated.
 *
 * **There is no prose fallback parser here, and there is nowhere to put one.**
 * `admitVerdict` takes a value that Ajv has already accepted and re-parses it
 * with Zod; a return that is not a verdict throws. §10 is explicit that parsing
 * findings out of prose *"breaks on the next CLI release"*, and
 * `../test/no-prose-parser.test.ts` greps this package for the regex-shaped
 * extractor that would reintroduce it.
 *
 * Verifies: EPIC-12-S18, EPIC-12-S21 · AC4, AC7, AC8, AC9
 */
import type {
  CriterionId,
  GateId,
  NodeId,
  NodeReturns,
  VerdictCost,
  VerdictCriterion,
  VerdictV3,
} from '@DeFlow/core';
import { materialiseCriteria, VERDICT_V3_SCHEMA_ID, VerdictV3Schema } from '@DeFlow/core';

/**
 * AC4 — `returns.maxTokens` for a gate node.
 *
 * 600 rather than the 300 docs/08-context-and-memory.md §9.3 gives every gate
 * by default: a typical verdict lands around 300, and the headroom is for the
 * findings-heavy failures that are exactly the verdicts worth reading
 * (docs/10-verification-gates.md §4). It is still well inside F6.4's 500–2,000
 * band, and it is a *budget*, not a truncation point — a return over it gets
 * one compression re-prompt and then fails whole.
 */
export const GATE_RETURN_BUDGET = 600;

/** The return contract every gate node is held to. */
export function gateVerdictContract(): NodeReturns {
  return {
    schemaId: VERDICT_V3_SCHEMA_ID as NodeReturns['schemaId'],
    maxTokens: GATE_RETURN_BUDGET,
  };
}

export interface AdmitVerdict {
  /** The reviewer's structured return, already validated against the on-disk
   * document by the daemon's Ajv2020 store. */
  readonly returned: unknown;
  readonly gate: GateId;
  /** The gate's own node. */
  readonly node: NodeId;
  /** Whose work was judged. */
  readonly evaluatedNode: NodeId;
  readonly specHash: string;
  readonly provider: string;
  readonly model: string;
  /** What the gate definition says this gate speaks to (F7.4). */
  readonly declaredCriteria: readonly CriterionId[];
  /** Measured by DeFlow around the invocation — see `verdictCost`. */
  readonly cost: VerdictCost;
}

/**
 * AC7, AC9 — the reviewer's judgement, sealed with the facts DeFlow owns.
 *
 * The split is the whole point. **What the reviewer judged** — the outcome, the
 * findings, the per-criterion statuses, the summary — is kept verbatim.
 * **What happened** — which gate ran, on whose work, against which pinned spec,
 * on which provider and model, and what it cost — is stamped by DeFlow over
 * whatever the return claimed. A reviewer describing its own invocation is not
 * evidence about the invocation, and a verdict whose `specHash` came from the
 * model it was checking would defeat the anti-drift rule it exists to serve
 * (§5.2).
 *
 * Criteria go through `materialiseCriteria`, so a criterion the reviewer did
 * not mention arrives as `unverifiable` rather than as a gap the board renders
 * green.
 *
 * Throws when the return is not a verdict. There is no repair here: the bounded
 * repair happened at the handoff boundary, and a second one on top of it is the
 * thing AC3 forbids.
 */
export function admitVerdict(input: AdmitVerdict): VerdictV3 {
  const judged = VerdictV3Schema.parse({
    ...(input.returned as Record<string, unknown>),
    schemaId: VERDICT_V3_SCHEMA_ID,
    gate: input.gate,
    evaluatedNode: input.evaluatedNode,
    by: { node: input.node, provider: input.provider, model: input.model },
    specHash: input.specHash,
    cost: input.cost,
  });

  return {
    ...judged,
    criteria: [
      ...materialiseCriteria(
        input.declaredCriteria,
        judged.criteria as readonly VerdictCriterion[],
      ),
    ],
  };
}
