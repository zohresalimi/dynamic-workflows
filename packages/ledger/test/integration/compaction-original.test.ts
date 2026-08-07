/**
 * KAR-09.6 AC1 / EPIC-09-S30 — the half of F6.6 that is fully achievable.
 *
 * DeFlow's own packet compaction knows both ends because it did the demoting:
 * a measured `before` and `after`, the precise `SegmentId` list, one handle per
 * demoted body — and, which is what this spec adds, an `originalHandle` that
 * resolves back to the manifest as it stood *before* the demotion. That is what
 * makes the vendor's `originalHandle: null` a statement about the vendor rather
 * than about DeFlow.
 *
 * The second scenario is the one with teeth: rendering the resolved manifest
 * has to reproduce the pre-compaction prompt **byte for byte**. A manifest that
 * merely lists what used to be there is a description; one that re-renders is a
 * recovery.
 *
 * Integration because every claim is about a real boundary — a file-backed
 * ledger, real blobs on disk, and bytes that have to still be retrievable
 * afterwards.
 *
 * Verifies: EPIC-09-S30 · AC1 · test plan #3
 */
import type { ContextPacketRecord, TaskSpec } from '@DeFlow/core';
import { buildPacket, contextSegment, renderPacket, TaskSpecSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  getBlob,
  openLedger,
  persistContextPacket,
  readRange,
  rehydratePacket,
} from '../../src/index.ts';

const specFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(specFixture, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const RUN = 'run_20260807T091500Z_090601';
const ENV = { ts: 1_754_557_200_000, epoch: 1 } as const;

/** A packet whose one oversized body cannot fit, so the ladder demotes it. */
async function compactedBuild() {
  const oversized = await contextSegment({
    id: 'build-log',
    kind: 'tool.output',
    text: `pnpm -r build\n${'q'.repeat(200_000)}`,
    sourceEvent: 23,
  });
  const built = await buildPacket({
    runId: RUN,
    nodeId: 'implement',
    attempt: 0,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 20_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: 9,
    },
    segments: [oversized],
  });
  return { built, oversized };
}

suite('AC1 — the exact compaction points at the pre-compaction manifest', () => {
  it('records an originalHandle beside the measured numbers', async ({ tmp }) => {
    const db = openLedger(tmp);
    const { built } = await compactedBuild();

    persistContextPacket(db, {
      dataDir: tmp,
      runDir: join(tmp, 'runs', RUN),
      packet: built.packet,
      demotion: built.demotion,
      ...ENV,
    });

    const compacted = readRange(db, RUN, 0, 100).events.find((e) => e.kind === 'context.compacted');
    expect(compacted?.payload).toMatchObject({
      scope: 'DeFlow.packet',
      fidelity: 'exact',
      trigger: 'threshold',
      before: built.demotion.before,
      after: built.demotion.after,
      droppedSegments: ['build-log'],
    });
    expect(compacted?.payload.originalHandle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
    db.close();
  });

  it('resolves to a manifest that re-renders the pre-compaction prompt exactly', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const { built, oversized } = await compactedBuild();

    persistContextPacket(db, {
      dataDir: tmp,
      runDir: join(tmp, 'runs', RUN),
      packet: built.packet,
      demotion: built.demotion,
      ...ENV,
    });

    const compacted = readRange(db, RUN, 0, 100).events.find((e) => e.kind === 'context.compacted');
    const handle = String(compacted?.payload.originalHandle);
    const manifest: ContextPacketRecord = JSON.parse(
      Buffer.from(getBlob(tmp, handle)).toString('utf8'),
    );

    // Every body is still in the store, so the manifest rehydrates into the
    // packet that existed before the ladder ran.
    const original = rehydratePacket(tmp, manifest);
    expect(original.segments.map((segment) => segment.id)).toContain('build-log');
    expect(original.segments.find((segment) => segment.id === 'build-log')?.text).toBe(
      oversized.text,
    );
    expect(renderPacket(original)).toBe(
      renderPacket({ ...built.packet, segments: built.demotion.preCompaction }),
    );
    // And it is genuinely the *pre*-compaction one: the stored packet's own
    // render is the compacted, smaller prompt.
    expect(renderPacket(original).length).toBeGreaterThan(renderPacket(built.packet).length);
    db.close();
  });

  it('writes no originalHandle when nothing was demoted', async ({ tmp }) => {
    const db = openLedger(tmp);
    const built = await buildPacket({
      runId: RUN,
      nodeId: 'recon',
      attempt: 0,
      builtAtEvent: 60,
      target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
      pinned: {
        spec: approvedSpec(),
        node: { pathScopes: ['src/checkout/**'], permission: 'read' },
        sourceEvent: 9,
      },
    });

    const stored = persistContextPacket(db, {
      dataDir: tmp,
      runDir: join(tmp, 'runs', RUN),
      packet: built.packet,
      demotion: built.demotion,
      ...ENV,
    });

    // No demotion, no compaction event at all — an event saying nothing was
    // compacted would put a bar on a chart for a build that fit.
    expect(stored.compactedSeq).toBeNull();
    db.close();
  });
});
