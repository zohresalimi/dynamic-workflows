/**
 * KAR-01.4 AC8 — the normalising snapshot serializer.
 *
 * The last two tests are the point of the whole mechanism: two structurally
 * identical events built from *different* random ids, different tmp paths,
 * different durations and different ports must produce byte-identical snapshot
 * output. They are written as two separate inline snapshots on purpose — the
 * committed text is the assertion, and if the serializer registered in
 * test/setup.ts ever stops being applied, both fail immediately rather than
 * churning quietly (EPIC-01-S17).
 *
 * Verifies: EPIC-01-S17 · AC8
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { normaliseSnapshotText, repoRoot } from './snapshot.ts';

const ulid = (): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

const randomEvent = (): Record<string, unknown> => {
  const runId = ulid();
  return {
    t: 'node.finished',
    ts: Date.now(),
    runId,
    nodeId: crypto.randomUUID(),
    durationMs: Math.floor(Math.random() * 10_000),
    port: 1024 + Math.floor(Math.random() * 60_000),
    worktree: join(tmpdir(), `DeFlow-${Math.random().toString(36).slice(2, 10)}`, 'wt'),
    branch: `DeFlow/${runId}__implement-3`,
    at: new Date().toISOString(),
  };
};

suite('normaliseSnapshotText', () => {
  it('replaces a ULID', () => {
    expect(normaliseSnapshotText('run 01JZ8QW3M4K5N6P7R8S9T0VWXY done')).toBe('run <ulid> done');
  });

  it('replaces a UUID', () => {
    expect(normaliseSnapshotText('node 3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe('node <uuid>');
  });

  it('replaces an ISO-8601 timestamp', () => {
    expect(normaliseSnapshotText('at 2026-08-04T11:22:33.444Z')).toBe('at <ts>');
  });

  it('replaces the machine-varying roots of an absolute path', () => {
    expect(normaliseSnapshotText(join(tmpdir(), 'DeFlow-a1b2c3', 'ledger.db'))).toBe(
      '<tmp>/ledger.db',
    );
    expect(normaliseSnapshotText(join(repoRoot, 'packages', 'core'))).toBe('<repo>/packages/core');
  });

  /**
   * KAR-19.12 — the e2e suites do not all use one `mkdtemp` prefix:
   * `e2e/support/daemon.ts` asks for `DeFlow-` and `e2e/support/up.ts` asks for
   * `DeFlow-up-`, so a real directory is `<tmp-root>/DeFlow-up-ualuXM`. The rule
   * stopped at the first hyphen, which left the six random characters of the
   * suffix in the text — invisible until KAR-19.10 put a resolved provider
   * binary path into `deflow run`'s transcript, at which point `e2e/run.test.ts`
   * had a snapshot that could never match twice.
   */
  it('replaces a tmp directory whose prefix itself contains a hyphen', () => {
    expect(normaliseSnapshotText(join(tmpdir(), 'DeFlow-up-ualuXM', 'bin', 'claude'))).toBe(
      '<tmp>/bin/claude',
    );
  });

  it('replaces a port in an address and in a URL', () => {
    expect(normaliseSnapshotText('listening on 127.0.0.1:54321')).toBe(
      'listening on 127.0.0.1:<port>',
    );
    expect(normaliseSnapshotText('http://localhost:7777/api/health')).toBe(
      'http://localhost:<port>/api/health',
    );
  });

  it('replaces a worktree directory name, flat scheme and all (D13)', () => {
    expect(normaliseSnapshotText('DeFlow/01JZ8QW3M4K5N6P7R8S9T0VWXY__implement-3')).toBe(
      'DeFlow/<worktree>',
    );
  });

  it('leaves a stable string completely alone', () => {
    expect(normaliseSnapshotText('node.finished')).toBe('node.finished');
  });

  it('is idempotent, so re-serialising a normalised value cannot loop', () => {
    const once = normaliseSnapshotText(join(tmpdir(), 'DeFlow-zzz', 'x'));
    expect(normaliseSnapshotText(once)).toBe(once);
  });
});

suite('the registered serializer (test/setup.ts)', () => {
  it('normalises every unstable field of an event — first instance', () => {
    expect(randomEvent()).toMatchInlineSnapshot(`
      {
        "at": "<ts>",
        "branch": "DeFlow/<worktree>",
        "durationMs": "<dur>",
        "nodeId": "<uuid>",
        "port": "<port>",
        "runId": "<ulid>",
        "t": "node.finished",
        "ts": "<ts>",
        "worktree": "<tmp>/wt",
      }
    `);
  });

  it('normalises every unstable field of an event — second, differently-valued instance', () => {
    expect(randomEvent()).toMatchInlineSnapshot(`
      {
        "at": "<ts>",
        "branch": "DeFlow/<worktree>",
        "durationMs": "<dur>",
        "nodeId": "<uuid>",
        "port": "<port>",
        "runId": "<ulid>",
        "t": "node.finished",
        "ts": "<ts>",
        "worktree": "<tmp>/wt",
      }
    `);
  });

  it('normalises a numeric duration and port by key, not by value', () => {
    expect({ durationMs: 12, port: 3 }).toMatchInlineSnapshot(`
      {
        "durationMs": "<dur>",
        "port": "<port>",
      }
    `);
  });
});
