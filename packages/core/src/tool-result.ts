/**
 * KAR-23.9 — what a `tool` node's `node.completed` carries as its output
 * document.
 *
 * A gate node has had `DeFlow.verdict.v4` under its `outputSchemaId` since
 * KAR-12.2, and this is the same decision for the other node type whose work is
 * a process rather than a model turn: `outputSchemaId` names a document that
 * really exists, so a reader who resolves it gets the shape the ledger claims.
 *
 * The alternative — reusing the node's own declared `returns.schemaId` — was
 * rejected on the grounds this codebase writes tests against: a script produces
 * an exit code and two streams, not the planner's contract, and filing the one
 * under the name of the other would put a quiet lie in the ledger that nothing
 * validates and nobody could later trust.
 *
 * **The streams are handles, never text.** The full output lives in the data
 * plane — streamed there while it is happening, a content-addressed blob
 * afterwards — so the fix for a silent tool node does not become a fat event
 * payload. `null` means the stream produced nothing, which is different from a
 * handle to an empty blob and is worth the distinction on a failed command.
 */
import { z } from 'zod';
import { HandleSchema } from './ids.ts';

export const TOOL_RESULT_SCHEMA_ID = 'DeFlow.toolresult.v1' as const;

export const ToolResultSchema = z.strictObject({
  /** The only kind this document has today; a discriminator so `mcp` and
   * `http` can be added as members rather than as optional fields. */
  kind: z.literal('script'),
  /** `null` when the command was killed before it could exit — a timeout, a
   * cancel — which is a different fact from exit code 0. */
  exitCode: z.int().nullable(),
  /** The POSIX signal that ended it, when one did. */
  signal: z.string().min(1).nullable(),
  /** Measured on the injected `Clock`, never `Date.now()`. */
  durationMs: z.int().nonnegative(),
  timedOut: z.boolean(),
  /** The captured streams, in the blob store. `null` when the stream was
   * empty. */
  stdout: HandleSchema.nullable(),
  stderr: HandleSchema.nullable(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
