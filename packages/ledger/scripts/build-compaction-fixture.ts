/**
 * KAR-09.6 AC9 — builds `test/fixtures/runs/compaction/`.
 *
 * The fixture is a real ledger holding one compaction of each fidelity, and it
 * exists because two very different consumers need the same starting point:
 * the replay harness, which reads events, and EPIC-17's context-budget view,
 * which has to be developed against a `partial` event that genuinely has no
 * `after` — not a hand-written object that happens to say `null`.
 *
 * It is **built by the production code paths**, deliberately. The exact event
 * comes out of `persistContextPacket` demoting a real oversized body, and the
 * partial one is `vendorCompaction()` over the same `pre_tokens` the committed
 * `compact_boundary` stream carries. A fixture assembled by hand would drift
 * from what DeFlow writes the first time either shape changed, and the view
 * would be held to a contract nothing produces.
 *
 * Beside the database it writes `compactions.json` — the same payloads, in
 * ledger order — because a browser spec cannot open SQLite and the alternative
 * (a second, hand-maintained copy in the web package) is the drift this file
 * exists to prevent.
 *
 * Usage: `node packages/ledger/scripts/build-compaction-fixture.ts [dir]`
 */
import type { TaskSpec } from '@DeFlow/core';
import {
  buildPacket,
  contextSegment,
  RunIdSchema,
  TaskSpecSchema,
  vendorCompaction,
} from '@DeFlow/core';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvents, readRange } from '../src/append.ts';
import { persistContextPacket } from '../src/context-store.ts';
import { openLedger } from '../src/open-ledger.ts';

/** The run every event in the fixture belongs to. Fixed, so a consumer can
 * read the fixture without discovering the id first. */
export const COMPACTION_FIXTURE_RUN = 'run_20260806T120000Z_c0ffee';

/** Where the committed copy lives, relative to this file. */
export const COMPACTION_FIXTURE_DIR = fileURLToPath(
  new URL('../../../test/fixtures/runs/compaction/', import.meta.url),
);

const SPEC_FIXTURE = fileURLToPath(
  new URL('../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

/** The `pre_tokens` of the committed `compact_boundary` stream, so the two
 * fixtures describe the same imagined session. */
const VENDOR_PRE_TOKENS = 167_000;

/** A fixed instant and epoch: a fixture that moved with the clock would be a
 * new file on every rebuild and could not be diffed. */
const TS = 1_754_557_200_000;
const EPOCH = 1;

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(SPEC_FIXTURE, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

/**
 * Writes the fixture into `dir`, replacing whatever was there.
 *
 * Exported so the spec can rebuild into a tmpdir and compare — the committed
 * copy has to be reproducible, or it is a snapshot of a moment nobody can get
 * back to.
 */
export async function buildCompactionFixture(dir: string): Promise<void> {
  // Everything the previous build left, including the migration's own backup
  // copy: a fixture directory that accumulates files is one whose contents
  // depend on how many times somebody has run this.
  for (const name of [
    'ledger.db',
    'ledger.db-wal',
    'ledger.db-shm',
    'pre-migrate-0.db',
    'compactions.json',
  ]) {
    rmSync(join(dir, name), { force: true });
  }
  for (const name of ['blobs', 'run']) rmSync(join(dir, name), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const runId = RunIdSchema.parse(COMPACTION_FIXTURE_RUN);
  const db = openLedger(dir);
  try {
    // The exact half: a packet whose oversized body does not fit, demoted by
    // the real ladder and persisted by the real store.
    const oversized = await contextSegment({
      id: 'build-log',
      kind: 'tool.output',
      // Just over the 8 KB inline threshold, so the ladder demotes it for a
      // reason the fixture can name — and small enough that the blob it leaves
      // in the repository is measured in kilobytes.
      text: `pnpm -r build\n${'q'.repeat(12_000)}`,
      sourceEvent: 23,
    });
    const built = await buildPacket({
      runId: COMPACTION_FIXTURE_RUN,
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

    persistContextPacket(db, {
      dataDir: dir,
      runDir: join(dir, 'run'),
      packet: built.packet,
      demotion: built.demotion,
      ts: TS,
      epoch: EPOCH,
    });

    // The partial half: what a `compact_boundary` frame becomes. No transcript
    // snapshot, so `originalHandle` is null — the documented degradation, and
    // the shape the view has to render as a gap rather than a zero.
    appendEvents(db, [
      {
        runId,
        ts: TS + 1_000,
        kind: 'context.compacted',
        v: 1,
        epoch: EPOCH,
        nodeId: 'implement',
        attempt: 0,
        payload: {
          node: 'implement',
          ...vendorCompaction({
            trigger: 'auto',
            preTokens: VENDOR_PRE_TOKENS,
            pinnedKept: built.packet.pinnedDigests,
          }),
        },
      },
    ]);

    const compactions = readRange(db, COMPACTION_FIXTURE_RUN, 0, 1000)
      .events.filter((event) => event.kind === 'context.compacted')
      .map((event) => event.payload);

    writeFileSync(
      join(dir, 'compactions.json'),
      `${JSON.stringify({ runId: COMPACTION_FIXTURE_RUN, compactions }, null, 2)}\n`,
      'utf8',
    );
  } finally {
    db.close();
  }

  // The migration backup is an artefact of opening a fresh ledger, not part of
  // the fixture. Left behind it would be committed, and it is a *copy of an
  // empty database* — noise that looks like data.
  rmSync(join(dir, 'pre-migrate-0.db'), { force: true });
}

// Run only when invoked as a script: the spec imports this module to rebuild
// the fixture into a tmpdir, and an import that rewrote the committed copy as a
// side effect would make a passing test indistinguishable from a regenerated
// one.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = process.argv[2] ?? COMPACTION_FIXTURE_DIR;
  await buildCompactionFixture(target);
  process.stdout.write(`compaction fixture written to ${target}\n`);
}
