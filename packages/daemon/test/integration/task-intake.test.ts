/**
 * KAR-10.1 — `submitTask` end to end: real file-backed ledger, real tmpdir,
 * real fake `gh`, never a mocked module.
 *
 * Verifies: EPIC-10-S1, EPIC-10-S2, EPIC-10-S3, EPIC-10-S4, EPIC-10-S5 · AC1-AC7
 */
import { getBlob, openLedger, readRange } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { submitTask } from '../../src/intake/intake.ts';
import { writeFakeGh } from '../support/fake-gh-bin.ts';

let hexCalls = 0;

function randomHex(): string {
  hexCalls += 1;
  return hexCalls.toString(16).padStart(6, '0');
}

afterEach(() => {
  hexCalls = 0;
});

async function ports(tmp: string) {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const db = openLedger(dataDir);
  const clock = new TestClock(1_754_470_000_000);
  return { db, clock, dataDir, epoch: 1, randomHex };
}

function eventCount(db: Awaited<ReturnType<typeof ports>>['db']): number {
  const row = db.prepare<{ c: number }>('SELECT count(*) AS c FROM event').get();
  return row?.c ?? -1;
}

/** Every event kind in the whole ledger, in `seq` order — the assertion that
 * names what intake appended *and* what it did not. A bare `count(*)` cannot
 * tell one `task.submitted` from one `run.created`. */
function eventKinds(db: Awaited<ReturnType<typeof ports>>['db']): string[] {
  return db
    .prepare<{ kind: string }>('SELECT kind FROM event ORDER BY seq')
    .all()
    .map((row) => row.kind);
}

const TEXT_INPUT = { kind: 'text' as const, text: 'Migrate the design system across packages/ui' };

suite('EPIC-10-S1 — happy path: free text in, run id out, nothing executed', () => {
  it('returns created with a runId and a seq, and appends exactly one task.submitted', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        {
          body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' },
          by: 'ui',
        },
        p,
      );

      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('unreachable');
      expect(result.runId).toMatch(/^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);

      const events = readRange(p.db, result.runId, 0, 10).events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'task.submitted',
        payload: {
          raw: TEXT_INPUT.text,
          provenance: { kind: 'text', by: 'ui' },
        },
      });
      // No node was scheduled — KAR-10.1 schedules nothing, ever.
      expect(events.some((event) => event.kind === 'node.scheduled')).toBe(false);
    } finally {
      p.db.close();
    }
  });

  it('appends no run.created: intake has no TaskSpec to put in it (KAR-10.2 owns that event)', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        { body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' }, by: 'ui' },
        p,
      );
      expect(result.outcome).toBe('created');

      // The whole ledger, not just this run's range: a successful intake writes
      // one event and it is `task.submitted`. `run.created`'s payload carries
      // the `TaskSpec` (docs/04-domain-model.md §9), which intake may not
      // invent — docs/06-planning-and-replanning.md §1.1, "no interpretation
      // happens here" — so the framing interview appends it, not this path.
      expect(eventKinds(p.db)).toEqual(['task.submitted']);
    } finally {
      p.db.close();
    }
  });
});

suite('EPIC-10-S2 — four intake kinds, one task.submitted shape', () => {
  it('text: provenance carries submittedAt and by', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        { body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' }, by: 'ui' },
        p,
      );
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      expect(event?.payload).toMatchObject({
        provenance: { kind: 'text', by: 'ui', submittedAt: 1_754_470_000_000 },
      });
    } finally {
      p.db.close();
    }
  });

  it('file: a small spec.md inlines with mediaType text/markdown, no fourth wire shape', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      await mkdir(join(tmp, 'docs'), { recursive: true });
      await writeFile(join(tmp, 'docs', 'spec.md'), '# Spec\n\nDo the thing.\n');

      const result = await submitTask(
        {
          body: { input: { kind: 'file', path: 'docs/spec.md' }, cwd: tmp, permission: 'read' },
          by: 'ui',
        },
        p,
      );

      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      expect(event?.payload).toMatchObject({
        raw: '# Spec\n\nDo the thing.\n',
        provenance: {
          kind: 'file',
          resolvedPath: join(tmp, 'docs', 'spec.md'),
          mediaType: 'text/markdown',
          bytes: Buffer.byteLength('# Spec\n\nDo the thing.\n'),
        },
      });
    } finally {
      p.db.close();
    }
  });

  it('file: a 200 KiB spec file is stored by handle, not inlined into the event row', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const big = 'x'.repeat(200 * 1024);
      await writeFile(join(tmp, 'big.md'), big);

      const result = await submitTask(
        {
          body: { input: { kind: 'file', path: 'big.md' }, cwd: tmp, permission: 'read' },
          by: 'ui',
        },
        p,
      );

      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      const payload = event?.payload as { raw?: string; handle?: string };
      expect(payload.raw).toBeUndefined();
      expect(payload.handle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);

      const stored = getBlob(p.dataDir, payload.handle as `artifact://${string}`);
      expect(Buffer.from(stored).toString('utf8')).toBe(big);
    } finally {
      p.db.close();
    }
  });

  it('issue: carries url, resolver, httpStatus and fetchedAt', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const gh = await writeFakeGh(tmp, { stdout: '{"title":"Fix the flaky checkout test"}' });
      const result = await submitTask(
        {
          body: {
            input: { kind: 'issue', url: 'https://github.com/acme/web/issues/412' },
            cwd: tmp,
            permission: 'read',
          },
          by: 'ui',
        },
        { ...p, issueEnv: { PATH: gh.pathEnv } },
      );

      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      expect(event?.payload).toMatchObject({
        raw: '{"title":"Fix the flaky checkout test"}',
        provenance: {
          kind: 'issue',
          url: 'https://github.com/acme/web/issues/412',
          resolver: 'gh',
          httpStatus: 200,
        },
      });
    } finally {
      p.db.close();
    }
  });
});

suite('EPIC-10-S3 — intake normalises and does not interpret', () => {
  it('preserves CRLF, a trailing space, a tab-indented block, an emoji and a literal ```', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const text = 'line one\r\nline two \r\n\tindented\r\nemoji: 🎉\r\nfence: ```\r\n';
      const result = await submitTask(
        { body: { input: { kind: 'text', text }, cwd: tmp, permission: 'worktree' }, by: 'ui' },
        p,
      );
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      expect((event?.payload as { raw: string }).raw).toBe(text);
    } finally {
      p.db.close();
    }
  });

  it('writes no interpretation: the payload has no goal, scope, criteria or archetype field', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        { body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' }, by: 'ui' },
        p,
      );
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      const payload = event?.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['provenance', 'raw', 'sha256']);
    } finally {
      p.db.close();
    }
  });
});

suite('EPIC-10-S4 — rejected inputs create nothing', () => {
  it('a file path escaping the repository root: 4xx-shaped rejection naming input.path', async ({
    tmp,
  }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        {
          body: {
            input: { kind: 'file', path: '../../../etc/passwd' },
            cwd: tmp,
            permission: 'read',
          },
          by: 'ui',
        },
        p,
      );
      expect(result).toMatchObject({ outcome: 'rejected', field: 'input.path' });
      expect(eventCount(p.db)).toBe(0);
    } finally {
      p.db.close();
    }
  });

  it('a missing file: rejection naming input.path', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        {
          body: {
            input: { kind: 'file', path: 'docs/does-not-exist.md' },
            cwd: tmp,
            permission: 'read',
          },
          by: 'ui',
        },
        p,
      );
      expect(result).toMatchObject({ outcome: 'rejected', field: 'input.path' });
      expect(eventCount(p.db)).toBe(0);
    } finally {
      p.db.close();
    }
  });

  it('an unreachable issue URL: rejection naming input.url, no run created', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const gh = await writeFakeGh(tmp, { stderr: 'gh: Not Found (HTTP 404)' });
      const result = await submitTask(
        {
          body: {
            input: { kind: 'issue', url: 'https://github.com/acme/web/issues/999999' },
            cwd: tmp,
            permission: 'read',
          },
          by: 'ui',
        },
        { ...p, issueEnv: { PATH: gh.pathEnv } },
      );
      expect(result).toMatchObject({ outcome: 'rejected', field: 'input.url' });
      expect(eventCount(p.db)).toBe(0);
    } finally {
      p.db.close();
    }
  });

  it('empty text: rejection naming input.text', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        {
          body: { input: { kind: 'text', text: '' }, cwd: tmp, permission: 'worktree' },
          by: 'ui',
        },
        p,
      );
      expect(result).toMatchObject({ outcome: 'rejected', field: 'input.text' });
      expect(eventCount(p.db)).toBe(0);
    } finally {
      p.db.close();
    }
  });

  it('a symlink resolving outside the repo: rejected after realpath', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      await writeFile(join(tmp, '..', 'outside-target.md'), 'not part of the repo\n');
      await symlink(join(tmp, '..', 'outside-target.md'), join(tmp, 'outside.md'));

      const result = await submitTask(
        {
          body: { input: { kind: 'file', path: 'outside.md' }, cwd: tmp, permission: 'read' },
          by: 'ui',
        },
        p,
      );
      expect(result).toMatchObject({ outcome: 'rejected', field: 'input.path' });
      expect(eventCount(p.db)).toBe(0);
    } finally {
      p.db.close();
    }
  });
});

suite('EPIC-10-S5 — Idempotency-Key makes a retried submission free', () => {
  it('the same key twice returns the same runId, exactly one task.submitted', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const first = await submitTask(
        {
          body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' },
          by: 'ui',
          idempotencyKey: 'k-1',
        },
        p,
      );
      const second = await submitTask(
        {
          body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' },
          by: 'ui',
          idempotencyKey: 'k-1',
        },
        p,
      );

      expect(first.outcome).toBe('created');
      expect(second).toEqual(first);
      // Exactly one intake event, and it is the only kind intake writes.
      expect(eventKinds(p.db)).toEqual(['task.submitted']);
    } finally {
      p.db.close();
    }
  });

  it('a different key is a different run', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const first = await submitTask(
        {
          body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' },
          by: 'ui',
          idempotencyKey: 'k-1',
        },
        p,
      );
      const second = await submitTask(
        {
          body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' },
          by: 'ui',
          idempotencyKey: 'k-2',
        },
        p,
      );

      if (first.outcome !== 'created' || second.outcome !== 'created') {
        throw new Error('unreachable');
      }
      expect(second.runId).not.toBe(first.runId);
      expect(eventKinds(p.db)).toEqual(['task.submitted', 'task.submitted']);
    } finally {
      p.db.close();
    }
  });
});

suite('AC7 — deflow run records by: "cli"', () => {
  it('provenance.by is "cli" when submitted by the CLI', async ({ tmp }) => {
    const p = await ports(tmp);
    try {
      const result = await submitTask(
        { body: { input: TEXT_INPUT, cwd: tmp, permission: 'worktree' }, by: 'cli' },
        p,
      );
      if (result.outcome !== 'created') throw new Error('unreachable');
      const [event] = readRange(p.db, result.runId, 0, 1).events;
      expect(event?.payload).toMatchObject({ provenance: { by: 'cli' } });
    } finally {
      p.db.close();
    }
  });
});
