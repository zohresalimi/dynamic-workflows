/**
 * KAR-09.2 AC10 / EPIC-09-S13 — `context.built` carries the manifest, the CAS
 * carries the text; and EPIC-09-S11's third scenario, which is the one that
 * keeps `prompt.txt` honest.
 *
 * Integration rather than unit because all three assertions are about a real
 * boundary: a file-backed ledger, real blobs on disk, and a real `prompt.txt`
 * written into the run directory. A fake store would let the manifest and the
 * bytes drift in exactly the way this spec exists to catch.
 *
 * Verifies: EPIC-09-S13, EPIC-09-S11 (third scenario) · AC10 · test plan #10, #11
 */
import type { Segment, TaskSpec } from '@DeFlow/core';
import {
  buildPacket,
  contextSegment,
  PinIntegrityViolation,
  renderPacket,
  TaskSpecSchema,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  blobPath,
  DERIVED_MANIFEST,
  getBlob,
  openLedger,
  persistContextPacket,
  promptPathOf,
  readRange,
  rehydratePacket,
  verifyDerivedPrompt,
} from '../../src/index.ts';

const specFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(specFixture, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const RUN = 'run_20260807T091500Z_4d5e6f';
const ENV = { ts: 1_754_557_200_000, epoch: 1 } as const;

/** An `implement` packet with one segment of every unpinned kind that matters. */
async function packet() {
  const segments: Segment[] = [
    await contextSegment({
      id: 'brief',
      kind: 'task.brief',
      text: 'Port CheckoutForm to <script setup>.',
      sourceEvent: 20,
    }),
    await contextSegment({
      id: 'finding',
      kind: 'fact',
      text: 'finding/auth-uses-jwt = true',
      sourceEvent: 21,
    }),
    await contextSegment({
      id: 'log',
      kind: 'tool.output',
      text: `vitest output\n${'x'.repeat(4000)}`,
      sourceEvent: 22,
    }),
  ];
  const built = await buildPacket({
    runId: RUN,
    nodeId: 'implement',
    attempt: 0,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: 9,
    },
    segments,
  });
  return built.packet;
}

/** Every key named `text`, at any depth. */
function textKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => textKeysIn(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      key === 'text' ? [`${path}.${key}`] : textKeysIn(entry, `${path}.${key}`),
    );
  }
  return [];
}

suite('the event payload contains no segment text (EPIC-09-S13, AC10)', () => {
  it('appends context.built as a manifest whose blobs are all resolvable', async ({ tmp }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const built = await packet();

    const stored = persistContextPacket(db, { dataDir: tmp, runDir, packet: built, ...ENV });

    const events = readRange(db, RUN, 0, 100).events.filter((e) => e.kind === 'context.built');
    expect(events.length).toBe(1);
    expect(textKeysIn(events[0]?.payload)).toEqual([]);
    // Every segment's bytes really are in the store, under the sha256 its
    // contentHash claims.
    for (const segment of stored.record.segments) {
      const sha = segment.contentHash.slice('sha256-'.length);
      expect(readFileSync(blobPath(tmp, sha), 'utf8')).toBe(
        built.segments.find((s) => s.id === segment.id)?.text,
      );
    }
    db.close();
  });

  it('projects per segment exactly what the node inspector needs (F10.3, F10.5)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const built = await packet();

    const stored = persistContextPacket(db, {
      dataDir: tmp,
      runDir: join(tmp, 'runs', RUN),
      packet: built,
      ...ENV,
    });

    for (const segment of stored.record.segments) {
      expect(Object.keys(segment).toSorted()).toEqual([
        'compactable',
        'contentHash',
        'id',
        'kind',
        'pinned',
        'sourceEvent',
        'tokens',
      ]);
      expect(segment.tokens.method.length).toBeGreaterThan(0);
    }
    // The F10.5 stacked bar is computable without reading a single blob.
    const fromKinds = Object.values(stored.record.totals.byKind).reduce(
      (total, tokens) => total + tokens,
      0,
    );
    expect(fromKinds).toBe(stored.record.totals.tokens);
    db.close();
  });
});

suite('what was demoted is recorded, not inferred (EPIC-09-S7, third scenario)', () => {
  it('appends context.compacted and leaves every demoted body retrievable', async ({ tmp }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
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
      // 0.5 of 20000 is a 10000-token budget; the log alone is ~50000.
      target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 20_000 },
      pinned: {
        spec: approvedSpec(),
        node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
        sourceEvent: 9,
      },
      segments: [oversized],
    });
    expect(built.demotion.droppedSegments).toEqual(['build-log']);

    const stored = persistContextPacket(db, {
      dataDir: tmp,
      runDir,
      packet: built.packet,
      demotion: built.demotion,
      ...ENV,
    });

    const compacted = readRange(db, RUN, 0, 100).events.find((e) => e.kind === 'context.compacted');
    expect(stored.compactedSeq).not.toBeNull();
    expect(compacted?.payload).toMatchObject({
      scope: 'DeFlow.packet',
      fidelity: 'exact',
      droppedSegments: ['build-log'],
      demotedToHandles: built.demotion.demotedToHandles,
      pinnedKept: built.packet.pinnedDigests,
    });
    // Lossless: the handle in the stub resolves to the exact bytes that left.
    const handle = built.demotion.demotedToHandles[0] ?? '';
    expect(Buffer.from(getBlob(tmp, handle)).toString('utf8')).toBe(oversized.text);
    expect(built.packet.segments.find((s) => s.id === 'build-log')?.text).toContain(handle);
    db.close();
  });
});

suite('the rendered prompt is a derived artifact (EPIC-09-S13, EPIC-09-S11)', () => {
  it('writes prompt.txt byte-identically to a render over the rehydrated manifest', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const built = await packet();

    const stored = persistContextPacket(db, { dataDir: tmp, runDir, packet: built, ...ENV });

    const onDisk = readFileSync(promptPathOf(runDir, 'implement'), 'utf8');
    const rehydrated = rehydratePacket(tmp, stored.record);
    expect(onDisk).toBe(renderPacket(rehydrated));
    expect(onDisk).toBe(renderPacket(built));
    db.close();
  });

  it('marks prompt.txt derived, so a consistency check rebuilds rather than trusts it', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const built = await packet();
    const stored = persistContextPacket(db, { dataDir: tmp, runDir, packet: built, ...ENV });

    const manifest: unknown = JSON.parse(
      readFileSync(join(runDir, 'nodes', 'implement', DERIVED_MANIFEST), 'utf8'),
    );
    expect(manifest).toMatchObject({ derived: [{ path: 'prompt.txt' }] });
    expect(verifyDerivedPrompt(tmp, runDir, stored.record)).toEqual({ ok: true });
    db.close();
  });

  it('reports a prompt.txt that no longer matches the manifest instead of trusting it', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const built = await packet();
    const stored = persistContextPacket(db, { dataDir: tmp, runDir, packet: built, ...ENV });

    // Something outside DeFlow edited the derived file.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(promptPathOf(runDir, 'implement'), 'hand-edited', 'utf8');

    const result = verifyDerivedPrompt(tmp, runDir, stored.record);
    expect(result.ok).toBe(false);
    db.close();
  });
});

/**
 * KAR-10.4 AC8 — `pinnedKept` is evidence that the check ran, not a copy of the
 * manifest.
 *
 * *"Without it, 'the check passed' and 'the check never ran' are
 * indistinguishable in the ledger, and NF10 requires any state in the UI to be
 * traceable to specific ledger events"* (`pinnedKept` in
 * `packages/core/src/pin-integrity.ts`). Assembling the list off the packet
 * records only that a packet *had* pins — which is true of a packet whose
 * pinned bytes were replaced after they were digested.
 *
 * Verifies: EPIC-10-S20 (third scenario), EPIC-10-S23 (third scenario) · AC8 ·
 * test plan #9
 */
suite('a compaction proves the pin check ran (KAR-10.4 AC8)', () => {
  it('refuses to record pinnedKept for a packet whose pinned digest no longer matches its text', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
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

    // A packet mutated after the digest was taken: the acceptance criteria are
    // in the prompt and the manifest says they hash to something else.
    // Deliberately *self-consistent* — the digest is corrupted everywhere the
    // packet schema cross-checks it, so `ContextPacketSchema` is satisfied and
    // the rendered prompt is byte-for-byte the one that was built. The only
    // equation left that can catch it is contentHash === sha256(text), and the
    // only thing that evaluates it is the pin check itself.
    const corrupted = `sha256-${'0'.repeat(64)}`;
    const corrupt = (segments: readonly Segment[]): Segment[] =>
      segments.map((segment) =>
        segment.id === 'pinned-spec-criteria' ? { ...segment, contentHash: corrupted } : segment,
      );
    const digestsOf = (segments: readonly Segment[]): string[] =>
      segments.filter((segment) => segment.pinned).map((segment) => segment.contentHash);

    const segments = corrupt(built.packet.segments);
    const preCompaction = corrupt(built.demotion.preCompaction);
    const tampered = { ...built.packet, segments, pinnedDigests: digestsOf(segments) };

    expect(() =>
      persistContextPacket(db, {
        dataDir: tmp,
        runDir,
        packet: tampered,
        demotion: { ...built.demotion, preCompaction },
        ...ENV,
      }),
    ).toThrow(PinIntegrityViolation);

    // And nothing was appended: a compaction that could not prove the check ran
    // must not leave a `pinnedKept` list behind claiming it did.
    expect(readRange(db, RUN, 0, 100).events.map((event) => event.kind)).toEqual([]);
    db.close();
  });
});
