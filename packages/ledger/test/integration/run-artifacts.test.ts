/**
 * KAR-09.5 — the run's artifact index: what `runs/<runId>/artifacts/<sha256>/`
 * holds, and why an offloaded body is retrievable from the run that offloaded
 * it and from no other.
 *
 * Integration, and every boundary is real: a file-backed ledger, real blobs on
 * disk under their own digests, real directories under the run. A fake store
 * would let the index and the bytes drift in exactly the way content addressing
 * exists to prevent, and the deduplication claim (AC2) is a claim about
 * directories on a disk — nothing else can observe it.
 *
 * Verifies: EPIC-09-S26 (first scenario), EPIC-09-S27 · AC1, AC2 ·
 * test plan #2
 */
import type { Segment, TaskSpec } from '@DeFlow/core';
import { buildPacket, contextSegment, renderPacket, TaskSpecSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  getBlob,
  listRunArtifacts,
  openLedger,
  persistContextPacket,
  putBlob,
  readRunArtifact,
  runArtifactDirOf,
  runArtifactsDirOf,
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

/** EPIC-09-S26's background: a failed `pnpm -r build`, 412 lines, 38.4 KB. */
function fixedSizeLog(lines: number, bytes: number, fill = 'x'): string {
  const content = bytes - (lines - 1);
  const per = Math.floor(content / lines);
  const rows = Array.from({ length: lines }, () => fill.repeat(per));
  rows[lines - 1] += fill.repeat(content - per * lines);
  return rows.join('\n');
}

const BUILD_LOG = fixedSizeLog(412, 39_322);
const DESCRIPTION = 'build-log for `pnpm -r build` (fail)';

async function packetWith(nodeId: string, segments: readonly Segment[]) {
  return buildPacket({
    runId: RUN,
    nodeId,
    attempt: 0,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
      sourceEvent: 9,
    },
    segments,
    descriptions: { 'build-log': DESCRIPTION },
  });
}

const buildLogSegment = (id: string, at: number, text = BUILD_LOG): Promise<Segment> =>
  contextSegment({ id, kind: 'tool.output', text, sourceEvent: at });

suite('an offloaded body lands in the CAS and in the run index (EPIC-09-S26, AC1)', () => {
  it('stores the bytes under their digest and indexes them under the run', async ({ tmp }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const built = await packetWith('implement', [await buildLogSegment('build-log', 23)]);

    expect(built.demotion.bodies.map((body) => body.reason)).toEqual(['inline-threshold']);
    const handle = built.demotion.demotedToHandles[0] ?? '';
    const sha = handle.slice('artifact://'.length);

    persistContextPacket(db, {
      dataDir: tmp,
      runDir,
      packet: built.packet,
      demotion: built.demotion,
      ...ENV,
    });

    // The bytes: in the content-addressed store, verified against their digest
    // on the way out.
    expect(Buffer.from(getBlob(tmp, handle)).toString('utf8')).toBe(BUILD_LOG);

    // The index: one directory named by the digest, describing what it is.
    expect(readdirSync(runArtifactsDirOf(runDir))).toEqual([sha]);
    const entry = readRunArtifact(runDir, sha);
    expect(entry).toMatchObject({
      sha256: sha,
      handle,
      bytes: 39_322,
      lines: 412,
      description: DESCRIPTION,
      node: 'implement',
      reason: 'inline-threshold',
    });
    expect(runArtifactDirOf(runDir, sha)).toBe(join(runDir, 'artifacts', sha));

    // AC1: the body is not in the prompt the node received.
    expect(renderPacket(built.packet)).not.toContain(BUILD_LOG);
    db.close();
  });
});

suite('content addressing is deduplication, not a naming convention (EPIC-09-S27, AC2)', () => {
  it('gives two nodes writing the same 1 MB report one directory and one handle', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const report = fixedSizeLog(2048, 1024 * 1024, 'c');

    const a = await packetWith('test-a', [await buildLogSegment('build-log', 23, report)]);
    const b = await packetWith('test-b', [await buildLogSegment('build-log', 24, report)]);

    for (const built of [a, b]) {
      persistContextPacket(db, {
        dataDir: tmp,
        runDir,
        packet: built.packet,
        demotion: built.demotion,
        ...ENV,
      });
    }

    expect(a.demotion.demotedToHandles).toEqual(b.demotion.demotedToHandles);
    expect(listRunArtifacts(runDir)).toEqual([a.demotion.demotedToHandles[0]?.slice(11)]);
    expect(readdirSync(runArtifactsDirOf(runDir)).length).toBe(1);
    db.close();
  });

  it('cannot be rewritten under the same digest, because the digest is the bytes', ({ tmp }) => {
    const original = putBlob(tmp, Buffer.from(BUILD_LOG, 'utf8'), 'text/plain');
    const rewritten = putBlob(tmp, Buffer.from(`${BUILD_LOG}\ntampered`, 'utf8'), 'text/plain');

    expect(rewritten).not.toBe(original);
    // The handle an old event recorded still addresses the bytes that event
    // saw — which is what makes `Provenance.fromEvidence` trustworthy months
    // later.
    expect(Buffer.from(getBlob(tmp, original)).toString('utf8')).toBe(BUILD_LOG);
  });

  it('keeps the first description when the same bytes are offloaded twice', async ({ tmp }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    const first = await packetWith('test-a', [await buildLogSegment('build-log', 23)]);
    persistContextPacket(db, {
      dataDir: tmp,
      runDir,
      packet: first.packet,
      demotion: first.demotion,
      ...ENV,
    });

    const second = await buildPacket({
      runId: RUN,
      nodeId: 'test-b',
      attempt: 0,
      builtAtEvent: 61,
      target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
      pinned: {
        spec: approvedSpec(),
        node: { pathScopes: ['src/checkout/**'], permission: 'worktree' },
        sourceEvent: 9,
      },
      segments: [await buildLogSegment('build-log', 24)],
      descriptions: { 'build-log': 'a later, different sentence about the same bytes' },
    });
    persistContextPacket(db, {
      dataDir: tmp,
      runDir,
      packet: second.packet,
      demotion: second.demotion,
      ...ENV,
    });

    const sha = (first.demotion.demotedToHandles[0] ?? '').slice('artifact://'.length);
    expect(readRunArtifact(runDir, sha)).toMatchObject({
      description: DESCRIPTION,
      node: 'test-a',
    });
    db.close();
  });
});
