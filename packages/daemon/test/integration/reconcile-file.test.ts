/**
 * EPIC-06-S14 — an orphaned `.DeFlow-<ikeyHash>.tmp` sibling means redo
 * (KAR-06.4 AC8).
 *
 * A real directory, real files, real `rename`, and two real daemon lives over
 * one file-backed ledger. `memfs` would be wrong here for the reason
 * docs/14-testing-strategy.md §5 gives — but also for a sharper one: the claim
 * is that the temp file and the target are on **one filesystem**, and a
 * virtual filesystem has exactly one of everything, so it cannot fail the way
 * a real one does.
 *
 * The three crash points are produced, not described:
 *
 *   before the rename → an orphan tmp is on disk and the target is not
 *   after the rename  → the target's content hash matches what we journalled
 *   somebody else     → the target is there and its hash is not ours
 *
 * Verifies: EPIC-06-S12 (file rows), EPIC-06-S14, EPIC-06-S16 · AC8, AC9, AC10
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, shortIkeyHash } from '@DeFlow/core';
import { openLedger, readEffect, readRange } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  EffectNeedsReconciliation,
  fileWriteEffect,
  tmpPathFor,
} from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T141133Z_9f2a1c');
const NODE: NodeId = NodeIdSchema.parse('write-report');
const HASH = `sha256-${'a'.repeat(64)}`;
const DAEMON_STARTED_AT = 1_754_313_000_000;
const IKEY = `${RUN}/write-report/0/0`;
const DATA = '{"verdict":"pass"}\n';

const openRunner = (dataDir: string, daemonStartedAt = DAEMON_STARTED_AT) => {
  const db = openLedger(dataDir);
  const clock = new TestClock(daemonStartedAt + 1000);
  return { db, clock, runner: createEffectRunner({ db, clock, daemonStartedAt, epoch: 1 }) };
};

const writeEffect = (target: string, data = DATA) =>
  fileWriteEffect({
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    ordinal: 0,
    requestHash: HASH,
    target,
    data,
  });

/** The daemon dying the instant `perform()` returns — the S16 window. */
function killedAfterPerform<T>(effect: Effect<T>): Effect<T> {
  return {
    ...effect,
    async perform(ctx: EffectCtx): Promise<T> {
      await effect.perform(ctx);
      throw new Error('SIGKILL: the file landed and markDone never ran');
    },
  };
}

const eventsOf = (db: ReturnType<typeof openLedger>, kind: string): Record<string, unknown>[] =>
  readRange(db, RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

async function outputDir(tmp: string): Promise<string> {
  const dir = join(tmp, 'repo', 'reports');
  await mkdir(dir, { recursive: true });
  return dir;
}

suite('the write sequence (EPIC-06-S14, AC8)', () => {
  it('leaves the target written and no temp sibling behind', async ({ tmp }) => {
    const target = join(await outputDir(tmp), 'report.json');
    const { db, runner } = openRunner(tmp);

    try {
      const result = await runner.durable(writeEffect(target));

      expect(await readFile(target, 'utf8')).toBe(DATA);
      expect(await readdir(dirname(target))).toEqual(['report.json']);
      expect(result.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });

  it('writes through a sibling temp file, never through os.tmpdir()', async ({ tmp }) => {
    // The write is caught in the act by making the rename fail: `target` is a
    // directory, so `rename(tmp, target)` cannot succeed and the temp file is
    // left exactly where it was written. Asserting on the leftovers of a
    // *successful* write would prove nothing — the temp file is gone by then,
    // and a `writeFile` straight to the target would leave the same directory
    // behind.
    const dir = await outputDir(tmp);
    const target = join(dir, 'report.json');
    await mkdir(target);
    const ikeyHash = await shortIkeyHash(IKEY as never);
    const { db, runner } = openRunner(tmp);

    try {
      await runner.durable(writeEffect(target)).catch(() => undefined);

      const tmpPath = tmpPathFor(target, ikeyHash);
      expect(await readFile(tmpPath, 'utf8')).toBe(DATA);
      expect(dirname(tmpPath)).toBe(dirname(target));
      // The fixture directory is itself under os.tmpdir(), so what means
      // something here is that the temp file was not *relocated* into the
      // system temp directory, where `rename` would stop being atomic.
      expect(dirname(tmpPath)).not.toBe(tmpdir());
    } finally {
      db.close();
    }
  });
});

suite('crash before the rename (EPIC-06-S14, AC8)', () => {
  it('unlinks the orphan, re-performs, and leaves exactly one file', async ({ tmp }) => {
    const dir = await outputDir(tmp);
    const target = join(dir, 'report.json');
    const ikeyHash = await shortIkeyHash(IKEY as never);
    const orphan = tmpPathFor(target, ikeyHash);

    // Life one: journalled, and killed with a half-written temp file on disk.
    const first = openRunner(tmp);
    try {
      await first.runner
        .durable({
          ...writeEffect(target),
          async perform(): Promise<never> {
            await writeFile(orphan, '{"verdict":"pa');
            throw new Error('SIGKILL: before the rename');
          },
        })
        .catch(() => undefined);

      expect(readEffect(first.db, IKEY)?.state).toBe('pending');
      expect(await readdir(dir)).toContain(orphan.split('/').pop());
    } finally {
      first.db.close();
    }

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      await second.runner.durable(writeEffect(target));

      expect(await readdir(dir)).toEqual(['report.json']);
      expect(await readFile(target, 'utf8')).toBe(DATA);
      // It really re-performed: the effect is recorded as having run, not as
      // having been reconciled away.
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: false });
    } finally {
      second.db.close();
    }
  });

  it('finds the orphan by its name, not by its age', async ({ tmp }) => {
    // An mtime heuristic would call this fresh temp file "current" and leave
    // it. The ikey in the name is exact, and a clock that moved cannot break
    // it.
    const dir = await outputDir(tmp);
    const target = join(dir, 'report.json');
    const ikeyHash = await shortIkeyHash(IKEY as never);
    await writeFile(tmpPathFor(target, ikeyHash), 'partial');
    // A temp file of some *other* effect, which must survive untouched.
    const other = tmpPathFor(target, 'ffffffffffff');
    await writeFile(other, 'not ours');

    const first = openRunner(tmp);
    try {
      await first.runner
        .durable({
          ...writeEffect(target),
          perform: (): Promise<never> => Promise.reject(new Error('SIGKILL')),
        })
        .catch(() => undefined);
    } finally {
      first.db.close();
    }

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      await second.runner.durable(writeEffect(target));
      const left = await readdir(dir);
      expect(left.sort()).toEqual(['report.json', other.split('/').pop()].sort());
    } finally {
      second.db.close();
    }
  });
});

suite('crash after the rename (EPIC-06-S14, EPIC-06-S16, AC8, AC9)', () => {
  it('returns done and does not rewrite the file', async ({ tmp }) => {
    const target = join(await outputDir(tmp), 'report.json');

    const first = openRunner(tmp);
    try {
      await first.runner.durable(killedAfterPerform(writeEffect(target))).catch(() => undefined);
      expect(readEffect(first.db, IKEY)?.state).toBe('pending');
    } finally {
      first.db.close();
    }

    const before = await stat(target);

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const result = await second.runner.durable(writeEffect(target));

      expect(result.path).toBe(target);
      // Not rewritten: same inode, same size, same mtime.
      const after = await stat(target);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      // AC9: the reconcile is in the timeline, flagged as one.
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: true });
      expect(readEffect(second.db, IKEY)?.state).toBe('done');
    } finally {
      second.db.close();
    }
  });
});

suite('a third party edited the target (EPIC-06-S14, EPIC-06-S15, AC8, AC10)', () => {
  it('is unknown, and escalates instead of overwriting their work', async ({ tmp }) => {
    const target = join(await outputDir(tmp), 'report.json');

    const first = openRunner(tmp);
    try {
      await first.runner.durable(killedAfterPerform(writeEffect(target))).catch(() => undefined);
    } finally {
      first.db.close();
    }

    // Somebody — a human, another tool, a merge — changed the file.
    await writeFile(target, '{"verdict":"edited by hand"}\n');

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const thrown = await second.runner
        .durable(writeEffect(target))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EffectNeedsReconciliation);
      // Their file is untouched: `unknown` never resolves itself by writing.
      expect(await readFile(target, 'utf8')).toBe('{"verdict":"edited by hand"}\n');

      const needsHuman = eventsOf(second.db, 'run.needs_human');
      expect(needsHuman).toHaveLength(1);
      expect(needsHuman[0]).toMatchObject({ reason: 'reconcile-unknown' });

      const failed = eventsOf(second.db, 'node.failed');
      expect(failed[0]).toMatchObject({
        node: NODE,
        failure: { reason: 'effect.reconcile-unknown', class: 'gate' },
      });
      expect(
        (failed[0] as { failure: { detail: Record<string, unknown> } }).failure.detail,
      ).toMatchObject({ ikey: IKEY, kind: 'file' });
    } finally {
      second.db.close();
    }
  });
});
