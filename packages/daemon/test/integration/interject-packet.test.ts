/**
 * KAR-13.3 — the guidance as it reaches the node: a segment in the
 * `context.built` manifest, not a string spliced into a prompt (EPIC-13-S21).
 *
 * Integration rather than unit because the claim is about what a **reader of
 * the ledger** can see. `interjectionSegments` returning a `Segment` proves the
 * shape; only the persisted `context.built` payload proves that the manifest
 * the node inspector reads carries the Operator's bytes, the `seq` that
 * produced them, and a per-segment token count — which is the whole of F10.3
 * for this path.
 *
 * The golden snapshot is over the **manifest**, deliberately, and not over the
 * rendered prompt. A snapshot of the prompt would pass just as happily if the
 * guidance had been concatenated into the brief, which is precisely the failure
 * this scenario exists to catch.
 *
 * Verifies: EPIC-13-S21 · AC5, AC8 · test plan #7
 */
import type { Db, Segment } from '@DeFlow/core';
import {
  buildPacket,
  initialRunState,
  interjectionSegments,
  interjectionsOf,
  segmentProvenance,
  TaskSpecSchema,
} from '@DeFlow/core';
import { openLedger, persistContextPacket, readRange, replayAll } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { interjectIntoNode } from '../../src/human/interject.ts';
import {
  EPOCH,
  GUIDANCE,
  IMPL,
  INTERJECT_RUN,
  seedInterjectRun,
  T0,
} from './support/interject-run.ts';

const specFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec() {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(specFixture, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const stateOf = (db: Db) => replayAll(db).runs.get(INTERJECT_RUN) ?? initialRunState();

/** Posts `texts` at `implement`, in order, and returns the packet they produce. */
async function packetAfter(db: Db, texts: readonly string[]) {
  for (const [index, text] of texts.entries()) {
    const posted = interjectIntoNode({
      db,
      runId: INTERJECT_RUN,
      nodeId: IMPL,
      text,
      mode: 'next-turn',
      epoch: EPOCH,
      ts: T0 + index * 1000,
    });
    expect(posted.status).toBe('ok');
  }

  const guidance: readonly Segment[] = await interjectionSegments({
    interjections: interjectionsOf(stateOf(db), IMPL),
  });

  return {
    guidance,
    built: await buildPacket({
      runId: INTERJECT_RUN,
      nodeId: IMPL,
      attempt: 1,
      builtAtEvent: 60,
      target: { provider: 'mock-steerable', model: 'mock-1', maxContext: 200_000 },
      pinned: {
        spec: approvedSpec(),
        node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
        sourceEvent: 9,
      },
      segments: guidance,
    }),
  };
}

suite('EPIC-13-S21 — the segment appears in the packet manifest (AC5, test plan #7)', () => {
  it('carries the Operator’s bytes, its provenance and the seq that produced it', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);
      const { built } = await packetAfter(db, [GUIDANCE]);

      persistContextPacket(db, {
        dataDir: tmp,
        runDir: join(tmp, 'runs', INTERJECT_RUN),
        packet: built.packet,
        demotion: built.demotion,
        ts: T0 + 5000,
        epoch: EPOCH,
      });

      const contextBuilt = readRange(db, INTERJECT_RUN, 0, 500).events.find(
        (event) => event.kind === 'context.built',
      );
      expect(contextBuilt).toBeDefined();

      const manifest = (contextBuilt?.payload as { packet: { segments: readonly Segment[] } })
        .packet.segments;
      const human = manifest.filter((segment) => segmentProvenance(segment) === 'human');
      expect(human).toHaveLength(1);

      const interjectedSeq = interjectionsOf(stateOf(db), IMPL)[0]?.seq;
      // The click-through F10.3 renders: the segment names the event.
      expect(human[0]?.sourceEvent).toBe(interjectedSeq);
      // And a token count, so the budget bar can show what the guidance cost.
      expect(human[0]?.tokens.estimated).toBeGreaterThan(0);
      // Not pinned, and compactable like any other non-pinned segment.
      expect(human[0]?.pinned).toBe(false);
      expect(human[0]?.compactable).toBe(true);

      // Byte-identical — asserted against the segment the builder kept, since
      // the manifest carries the digest rather than the text (§9).
      const withText = built.packet.segments.find((segment) => segment.id === human[0]?.id);
      expect(withText?.text).toBe(GUIDANCE);
      expect(withText?.contentHash).toBe(human[0]?.contentHash);
    } finally {
      db.close();
    }
  });

  it('is a segment beside the pinned set, never spliced into it (AC5)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);
      const { built } = await packetAfter(db, [GUIDANCE]);

      // The pinned block is exactly what it was: the guidance did not join it,
      // which is what keeps the F6.6 pin-integrity check bounded.
      const pinned = built.packet.segments.filter((segment) => segment.pinned);
      expect(pinned.every((segment) => segmentProvenance(segment) === 'deflow')).toBe(true);
      expect(built.packet.pinnedDigests).toHaveLength(pinned.length);

      // And no pinned segment's text swallowed it.
      for (const segment of pinned) expect(segment.text).not.toContain(GUIDANCE);
    } finally {
      db.close();
    }
  });

  it('renders three corrections as three segments, in seq order (AC8)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);
      const { built } = await packetAfter(db, ['first', 'second', 'third']);

      const human = built.packet.segments.filter(
        (segment) => segmentProvenance(segment) === 'human',
      );
      expect(human.map((segment) => segment.text)).toEqual(['first', 'second', 'third']);
      expect(human.map((segment) => segment.sourceEvent)).toEqual(
        [...human.map((segment) => segment.sourceEvent)].toSorted((left, right) => left - right),
      );
    } finally {
      db.close();
    }
  });

  it('matches the golden manifest for a packet carrying one interjection', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedInterjectRun(db);
      const { built } = await packetAfter(db, [GUIDANCE]);

      // The manifest only: a snapshot of the rendered prompt would pass just as
      // happily if the guidance had been concatenated into the brief.
      const manifest = built.packet.segments.map((segment) => ({
        id: segment.id,
        kind: segment.kind,
        provenance: segmentProvenance(segment),
        sourceEvent: segment.sourceEvent,
        pinned: segment.pinned,
        compactable: segment.compactable,
      }));

      await expect(JSON.stringify(manifest, null, 2)).toMatchFileSnapshot(
        '__snapshots__/interjected-packet-manifest.json',
      );
    } finally {
      db.close();
    }
  });
});
