/**
 * Event drafts for the append specs (KAR-03.3).
 *
 * A draft is the envelope minus `seq` — the ledger assigns that, and the
 * whole point of the story is that nothing upstream may guess it. These
 * helpers keep the specs about sequencing rather than about envelope
 * bookkeeping.
 */
import { type RunId, RunIdSchema } from '@DeFlow/core';
import type { EventDraft } from '../../../src/index.ts';

export const RUN_A: RunId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
export const RUN_B: RunId = RunIdSchema.parse('run_20260802T141134Z_0b7e42');

/** A valid draft, overridable field by field. */
export function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    runId: RUN_A,
    ts: 1_754_308_293_000,
    kind: 'run.created',
    v: 1,
    epoch: 1,
    payload: { note: 'fixture' },
    ...overrides,
  };
}

/** `count` drafts for `runId`, each payload carrying its ordinal. */
export function drafts(count: number, runId: RunId = RUN_A): EventDraft[] {
  return Array.from({ length: count }, (_unused, index) =>
    draft({ runId, payload: { ordinal: index } }),
  );
}
