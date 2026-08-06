/**
 * KAR-06.4 — the `file` effect: an atomic write whose recovery story is a
 * filename (docs/05-durable-execution.md §8.3, EPIC-06-S14).
 *
 * This is the one effect kind that needs no journal beyond its own ikey. The
 * temp file is named after the effect, so an orphan *is* the record of a crash
 * before the rename; and the target's content hash is derivable from the data
 * the effect was asked to write, so "did it land?" is answered by hashing the
 * file rather than by remembering anything.
 *
 * The `unknown` arm is not a hole in this design so much as an honest reading
 * of shared state: a target whose hash is neither ours nor absent means
 * somebody else wrote it. Re-performing would destroy their work, skipping
 * would drop ours, and DeFlow is not entitled to choose. It escalates.
 *
 * Verifies: EPIC-06-S14, EPIC-06-S16 (file rows) · AC8
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { contentHash, shortIkeyHash } from '@DeFlow/core';
import type { Effect, EffectCtx, ReconcileProbe } from './durable.ts';
import { atomicWriteFile, reconcileFileWrite } from './reconcile/file.ts';

export interface FileWriteInput {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly ordinal?: number;
  readonly requestHash: string;
  /** Absolute path of the file to write. */
  readonly target: string;
  /** The exact text to write. UTF-8; the hash is of these bytes. */
  readonly data: string;
}

export interface FileWriteResult {
  readonly path: string;
  /** `sha256-<hex>` of the bytes written. */
  readonly contentHash: string;
  readonly bytes: number;
}

export function fileWriteEffect(input: FileWriteInput): Effect<FileWriteResult> {
  const result = (hash: string): FileWriteResult => ({
    path: input.target,
    contentHash: hash,
    bytes: Buffer.byteLength(input.data, 'utf8'),
  });

  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'file',
    requestHash: input.requestHash,

    async perform(ctx: EffectCtx): Promise<FileWriteResult> {
      const written = await atomicWriteFile(
        input.target,
        input.data,
        await shortIkeyHash(ctx.ikey),
      );
      return result(written.contentHash);
    },

    async reconcile(ctx: EffectCtx): Promise<ReconcileProbe<FileWriteResult>> {
      // What *this* effect meant to write, hashed now rather than remembered:
      // the data is in hand, and a journalled copy could only ever be the same
      // number arrived at less directly.
      const expected = await contentHash(input.data);
      const verdict = await reconcileFileWrite({
        target: input.target,
        ikeyHash: await shortIkeyHash(ctx.ikey),
        expected,
      });

      if (verdict.status === 'done') return { status: 'done', result: result(expected) };
      if (verdict.status === 'not-started') return { status: 'not-started' };

      return {
        status: 'unknown',
        detail: `${input.target} exists and its content hash is not the one this effect wrote`,
        // `after` is what the world would look like had the write landed —
        // the file equivalent of a mutating command's after-hash — and
        // `observed` is what is actually there.
        evidence: { before: null, after: verdict.expected, observed: verdict.observed },
      };
    },
  };
}
