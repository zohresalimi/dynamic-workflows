/**
 * KAR-02.10 — `NodeResult`, the four ways a node can stop
 * (docs/04-domain-model.md §8).
 *
 * A stopped node is a value, and the union is closed so that the scheduler,
 * the ledger and the inspector all agree on what "stopped" can mean.
 * `failed` carries a `NodeFailure` rather than an `Error`; `suspended` says
 * what it is waiting for, so a resumed daemon knows whether to wait for a
 * human, a clock or an external signal; `cancelled` says who cancelled it,
 * because "the user stopped this" and "policy stopped this" are read very
 * differently on a board.
 *
 * Verifies: EPIC-02-S27 · AC4
 */
import { z } from 'zod';
import { FactIdSchema, HandleSchema, SchemaIdSchema } from './ids.ts';
import { NodeFailureSchema } from './node-failure.ts';
import { TokenUsageSchema } from './token-usage.ts';

export const SUSPENSION_KINDS = ['human', 'wake', 'external'] as const;

export const CANCELLATION_SOURCES = ['user', 'policy', 'parent'] as const;

export const NodeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    output: z.unknown(),
    outputSchemaId: SchemaIdSchema,
    usage: TokenUsageSchema,
    costUsd: z.number().nonnegative(),
    producedFacts: z.array(FactIdSchema),
    artifacts: z.array(HandleSchema),
  }),
  z.strictObject({
    status: z.literal('failed'),
    failure: NodeFailureSchema,
  }),
  z.strictObject({
    status: z.literal('suspended'),
    until: z.strictObject({
      kind: z.enum(SUSPENSION_KINDS),
      /** Only meaningful for `wake`; an ISO-8601 instant, not a duration, so
       * it survives a restart that outlives the timer. */
      wakeAt: z.iso.datetime().optional(),
    }),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    by: z.enum(CANCELLATION_SOURCES),
  }),
]);

export type NodeResult = z.infer<typeof NodeResultSchema>;
