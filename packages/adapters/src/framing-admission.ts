/**
 * KAR-10.2 AC3 — admission for the framing node: structured output at the
 * adapter boundary, or refuse to schedule.
 *
 * `admit` (./admission.ts) answers the questions an ACP handshake can answer.
 * Structured output is not one of them — no `initialize` response advertises
 * it, which is exactly why `ADAPTER_REQUIREMENT_CAPABILITIES` maps the
 * `structuredOutput` requirement to `null` and admission refuses to answer a
 * question it did not ask. The routing answer is still real; it comes from
 * *how the vendor is invoked* (`./structured-output.ts`, the one reading of
 * `provider-registry.ts`'s `structuredOutputFlag`) rather than from what the
 * vendor said about itself.
 *
 * Both halves are required and neither substitutes for the other:
 *
 *   * **The row must exist.** An unprobed adapter is refused, because a
 *     capability read from anywhere but the probed row is a constant wearing a
 *     capability's clothes (KAR-05.2).
 *   * **The invocation must carry a schema.** A prompt-only adapter is refused
 *     rather than run with the schema in the prompt, because the fallback for a
 *     spec is not a softer contract — it is a different adapter. Refusing is
 *     what makes the planner able to route (F2.7); a soft contract would make
 *     the framing return "valid-ish", which is the state everything downstream
 *     is then judged against.
 *
 * There is deliberately no third answer. A prose parse — a regex, a
 * JSON-block extraction, a heuristic — is not attempted anywhere on this path.
 *
 * Verifies: EPIC-10-S10 · AC3
 */
import type { NodeId } from '@DeFlow/core';
import {
  FRAMING_RETURN_MAX_TOKENS,
  NodeFailureError,
  TASKSPEC_DRAFT_SCHEMA_ID,
} from '@DeFlow/core';
import type { CapabilityRow } from './capabilities.ts';
import {
  providerStructuredOutput,
  type StructuredOutputContract,
  structuredOutputContract,
} from './structured-output.ts';

export interface FramingAdmissionRequest {
  readonly node: NodeId;
  /** The adapter the framing node resolved onto. */
  readonly provider: string;
}

const NO_PROSE_FALLBACK =
  'The fallback for a spec is not a prose parse — it is an adapter that can take the schema. ' +
  'Route the framing node onto one, or refuse the run.';

/**
 * The refusal, or `null` when the framing node may be scheduled here.
 *
 * A `NodeFailureError` for the same reason `admit` returns one: the ledger's
 * shape needs `occurredAtEvent` and `attempt`, which only the caller knows.
 */
export function admitFraming(
  request: FramingAdmissionRequest,
  row: CapabilityRow | null,
): NodeFailureError | null {
  if (row === null) {
    return new NodeFailureError(
      `the framing node ${request.node} cannot be scheduled onto ${request.provider}: no probed ` +
        'capability row exists for it, and DeFlow reads capabilities from the row rather than ' +
        'from a constant',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { node: String(request.node), provider: request.provider },
      },
    );
  }

  const manifest = providerStructuredOutput(request.provider);
  if (manifest.structuredOutput === 'native') return null;

  return new NodeFailureError(
    `the framing node ${request.node} returns ${TASKSPEC_DRAFT_SCHEMA_ID}, and ` +
      `${request.provider} has no flag to take a schema on. ${NO_PROSE_FALLBACK}`,
    {
      reason: 'adapter.capability-missing',
      class: 'permanent',
      detail: {
        node: String(request.node),
        provider: request.provider,
        schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
        structuredOutput: manifest.structuredOutput,
      },
    },
  );
}

export interface FramingSchemaRequest {
  readonly provider: string;
  /** The run's `.DeFlow/schemas` directory, absolute. */
  readonly schemasDir: string;
}

/**
 * How `DeFlow.taskspecdraft.v1` reaches the framing agent: which flag it rides
 * on and which file it is.
 *
 * A thin, named wrapper rather than a call site that has to remember the
 * schema id and the budget — AC10's 4000 is a property of the framing node,
 * and a caller that got it wrong would state a budget in the prompt that
 * differs from the one the handoff is measured against.
 */
export function framingSchemaContract(request: FramingSchemaRequest): StructuredOutputContract {
  return structuredOutputContract({
    provider: request.provider,
    schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
    schemasDir: request.schemasDir,
    maxTokens: FRAMING_RETURN_MAX_TOKENS,
  });
}
