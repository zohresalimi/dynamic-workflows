/**
 * KAR-18.7 — `DeFlow ledger snapshot`'s argv, and the sentence it writes.
 *
 * The file it produces is an integration concern and is asserted next door
 * against a real WAL. What is here is the part that has to be right before any
 * of that runs: `--out` is mandatory (a snapshot command with a default output
 * path writes somewhere the operator did not ask for), and the report has to
 * carry the two documented `sqlite3` one-liners, because AC2 is that the file
 * is inspectable *without DeFlow installed* and a path with no query beside it
 * leaves the reader to invent one.
 *
 * Verifies: EPIC-18-S47 · AC1, AC2
 */
import { expect, it, describe as suite } from 'vitest';
import { parseLedgerArgs, renderSnapshotReport } from './ledger-snapshot.ts';

suite('parseLedgerArgs', () => {
  it('takes "snapshot <runId> --out <path>"', () => {
    expect(
      parseLedgerArgs(['snapshot', 'run_20260810T090000Z_9f31ab', '--out', '/tmp/bug.db']),
    ).toEqual({
      ok: true,
      args: { runId: 'run_20260810T090000Z_9f31ab', out: '/tmp/bug.db' },
    });
    expect(
      parseLedgerArgs(['snapshot', 'run_20260810T090000Z_9f31ab', '--out=/tmp/bug.db']),
    ).toEqual({
      ok: true,
      args: { runId: 'run_20260810T090000Z_9f31ab', out: '/tmp/bug.db' },
    });
  });

  it('refuses a snapshot with no --out rather than choosing a path itself', () => {
    const parsed = parseLedgerArgs(['snapshot', 'run_20260810T090000Z_9f31ab']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--out');
  });

  it('refuses a snapshot with no run id', () => {
    const parsed = parseLedgerArgs(['snapshot', '--out', '/tmp/bug.db']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toMatch(/run/i);
  });

  it('names an unknown subcommand', () => {
    const parsed = parseLedgerArgs(['vacuum']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('vacuum');
  });
});

suite('the report a snapshot prints (AC2)', () => {
  it('hands over both documented sqlite3 one-liners, against the file just written', () => {
    const report = renderSnapshotReport({
      out: '/tmp/DeFlow-bug-1234.db',
      runId: 'run_20260810T090000Z_9f31ab',
      runEvents: 18,
      totalEvents: 54,
      runs: 3,
      bytes: 1_234_567,
      elapsedMs: 42,
    });

    expect(report).toContain('/tmp/DeFlow-bug-1234.db');
    expect(report).toContain('run_20260810T090000Z_9f31ab');
    expect(report).toContain('18');
    expect(report).toContain(
      "SELECT seq, kind, node_id, attempt FROM event WHERE run_id='run_20260810T090000Z_9f31ab' " +
        'ORDER BY seq LIMIT 50;',
    );
    expect(report).toContain('PRAGMA integrity_check;');
    // The snapshot is the whole ledger, and saying so is the difference between
    // an operator attaching one run and attaching every run they have.
    expect(report).toContain('3 runs');
    expect(report).toMatch(/no .-wal/);
  });
});
