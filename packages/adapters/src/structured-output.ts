/**
 * KAR-09.9 AC2 — how a return contract reaches an agent, and the record of
 * which way it went (docs/08-context-and-memory.md §9.1).
 *
 * Two mechanisms, and the difference between them is not cosmetic. A CLI that
 * takes the schema as a file enforces it itself and runs its own repair loop
 * before DeFlow ever sees the turn; a CLI that only sees a paragraph of prompt
 * enforces nothing, and the contract holds only because Ajv rejects what comes
 * back. Both are usable. What is not acceptable is the second one happening
 * *silently*: the planner (F2.7) is supposed to be able to prefer a native
 * adapter for a node whose downstream consumers depend on a strict contract,
 * and it can only do that if the softer contract is a field it can read.
 *
 * **This file names no vendor.** Which flag each CLI takes is invocation
 * knowledge and lives in `provider-registry.ts`, the one file allowed to know
 * it (`test/no-capability-table.test.ts`). What lives here is the reading:
 * "there is a flag" means native, "there is none" means prompt-only, and an
 * unregistered provider means prompt-only too — the conservative answer, since
 * claiming a CLI DeFlow has never seen honours a flag is exactly the kind of
 * stale assertion KAR-05.2 exists to prevent.
 *
 * **`structuredOutput` is a manifest field that cannot be probed, and that is
 * the honest reason it is derived here rather than read from a row.** No ACP
 * `initialize` response advertises structured output at all — which is why
 * `ADAPTER_REQUIREMENT_CAPABILITIES` maps the `structuredOutput` requirement to
 * `null` and admission refuses to answer a question it did not ask. The
 * routing answer the planner needs is still real; it just comes from how the
 * vendor is invoked rather than from what it said about itself.
 *
 * Verifies: EPIC-09-S50 · AC2
 */
import type { ProviderId, SchemaId } from '@DeFlow/core';
import { schemaFileName } from '@DeFlow/core';
import { providerSpec } from './provider-registry.ts';

/**
 * The two values AC2 names. `'native'` and `'prompt-only'` and no third: there
 * is no partial enforcement, and a `'none'` would mean a node with a `returns`
 * contract ran with nobody checking it, which is a state this path refuses to
 * have a word for.
 */
export const STRUCTURED_OUTPUT_MECHANISMS = ['native', 'prompt-only'] as const;

export type StructuredOutputMechanism = (typeof STRUCTURED_OUTPUT_MECHANISMS)[number];

/**
 * The manifest row the planner routes on — the field AC2 says is recorded.
 *
 * A row rather than a bare string because `flag` is what the node inspector
 * shows when it says *"the contract was enforced by the CLI, using
 * `--json-schema`"* rather than *"prompt-enforced"* (EPIC-09-S50, third
 * scenario).
 */
export interface StructuredOutputManifest {
  readonly provider: string;
  readonly structuredOutput: StructuredOutputMechanism;
  /** The flag the schema file rides on, or `null` for a prompt-only adapter. */
  readonly flag: string | null;
}

/** AC2 — what this provider can do with a schema, as the manifest records it. */
export function providerStructuredOutput(provider: string): StructuredOutputManifest {
  const flag = providerSpec(provider)?.shim.structuredOutputFlag;
  return flag === undefined
    ? { provider, structuredOutput: 'prompt-only', flag: null }
    : { provider, structuredOutput: 'native', flag };
}

export interface StructuredOutputRequest {
  readonly provider: ProviderId | string;
  readonly schemaId: SchemaId | string;
  /** The run's `.DeFlow/schemas` directory, absolute. */
  readonly schemasDir: string;
  /** `returns.maxTokens`, so the prompt-only instruction can state the budget
   * the node will actually be held to rather than a number it invents. */
  readonly maxTokens: number;
}

export interface StructuredOutputContract {
  readonly mechanism: StructuredOutputMechanism;
  /** The flag, or `null` when the schema travels in the prompt. */
  readonly flag: string | null;
  /**
   * The emitted document's absolute path.
   *
   * Computed on both arms: a native adapter is handed the path, and a
   * prompt-only one is handed the file's *contents*, so the caller needs to
   * know which file to read either way.
   */
  readonly schemaPath: string;
  /**
   * The paragraph appended to the prompt, or `null` when the schema went
   * natively. `{schema}` is where the caller substitutes the document text —
   * this package performs no I/O, and reading the file is the daemon's job.
   */
  readonly promptInjection: string | null;
  readonly manifest: StructuredOutputManifest;
}

/** Where the caller drops the emitted document into the injected prompt. */
export const SCHEMA_PLACEHOLDER = '{schema}';

function injection(schemaId: string, maxTokens: number): string {
  return (
    `Return a single JSON object and nothing else. It must validate against the JSON Schema ` +
    `named ${schemaId}, which is:\n\n${SCHEMA_PLACEHOLDER}\n\n` +
    `Keep the serialised object under ${maxTokens} tokens. If it does not fit, say less — do ` +
    'not cut the JSON short, because a truncated object is not valid JSON.'
  );
}

/**
 * AC2 — the whole contract for one node on one provider: which mechanism, what
 * to put on the argv, what to put in the prompt, and what the manifest records.
 *
 * Pure, and deliberately: the file is not read and no process is spawned here,
 * so this can be asserted in a unit test and reused by the exec-shim path and
 * the ACP path alike.
 */
export function structuredOutputContract(
  request: StructuredOutputRequest,
): StructuredOutputContract {
  const manifest = providerStructuredOutput(String(request.provider));
  const schemaId = String(request.schemaId);
  const schemaPath = `${request.schemasDir.replace(/\/+$/, '')}/${schemaFileName(schemaId)}`;

  return {
    mechanism: manifest.structuredOutput,
    flag: manifest.flag,
    schemaPath,
    promptInjection:
      manifest.structuredOutput === 'native' ? null : injection(schemaId, request.maxTokens),
    manifest,
  };
}
