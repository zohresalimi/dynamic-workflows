/**
 * KAR-16.5 test plan #1 — the fixture reader, and why it is strict.
 *
 * Verifies: EPIC-16-S32, EPIC-16-S34 · AC1, AC6, AC9
 *
 * *"Red when the reader is lenient and a bad fixture fails later, obscurely."*
 * A replay harness that accepts a line with no `seq` does not fail at the line:
 * it fails four endpoints later, inside a projection, as a view rendering
 * nothing — and the first place anybody looks is the view. So every refusal
 * here names the file and the line number, and a fixture this reader cannot
 * read never reaches a socket.
 *
 * The one leniency is deliberate and is the corpus's whole point: `seq` may
 * jump. `crash-resume-seq-gap` is a *healthy* ledger whose numbers are 4, 5, 7,
 * 8, 11, and a reader that "repaired" it would delete the only fixture that
 * proves the client crosses a hole in silence (AC9).
 */
import { expect, it, describe as suite } from 'vitest';
import { readFixture, UnreadableFixture } from './fixture.ts';

const RUN = 'run_20260811T090000Z_a1b2c3';
const OTHER = 'run_20260811T101500Z_b7c9d2';

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    seq: 1,
    runId: RUN,
    ts: 1_786_438_801_000,
    epoch: 3,
    kind: 'run.started',
    v: 1,
    payload: {},
    ...over,
  });

const ndjson = (...lines: string[]): string => `${lines.join('\n')}\n`;

suite('a recorded ledger, read back as the envelopes it was exported as', () => {
  it('reads every line, in order, with its recorded seq', () => {
    const read = readFixture(
      ndjson(line({ seq: 4 }), line({ seq: 5 }), line({ seq: 7 })),
      'happy.jsonl',
    );

    expect(read.events.map((event) => event.seq)).toEqual([4, 5, 7]);
    expect(read.headSeq).toBe(7);
    expect(read.runIds).toEqual([RUN]);
  });

  it('keeps a seq gap exactly as recorded — the gap is the fixture (AC9)', () => {
    const read = readFixture(
      ndjson(line({ seq: 4 }), line({ seq: 5 }), line({ seq: 7 }), line({ seq: 11 })),
      'crash-resume.jsonl',
    );

    // 6, 9 and 10 belong to another run in the same data directory. A reader
    // that renumbered would turn the one fixture that proves gap tolerance
    // into the one fixture that cannot.
    expect(read.events.map((event) => event.seq)).toEqual([4, 5, 7, 11]);
  });

  it('reports every run the file holds, in first-seen order', () => {
    const read = readFixture(
      ndjson(line({ seq: 1 }), line({ seq: 2, runId: OTHER }), line({ seq: 3 })),
      'two-runs.jsonl',
    );

    expect(read.runIds).toEqual([RUN, OTHER]);
  });

  it('measures the recorded span, which is what --speed divides', () => {
    const read = readFixture(
      ndjson(
        line({ seq: 1, ts: 1_000_000 }),
        line({ seq: 2, ts: 1_000_500 }),
        line({ seq: 3, ts: 1_040_000 }),
      ),
      'span.jsonl',
    );

    expect(read.spanMs).toBe(40_000);
  });

  it('ignores blank lines and a trailing newline, which every exporter writes', () => {
    const read = readFixture(`${line({ seq: 1 })}\n\n${line({ seq: 2 })}\n`, 'blank.jsonl');
    expect(read.events).toHaveLength(2);
  });
});

suite('what it refuses, at the line rather than four endpoints later', () => {
  it('refuses a line with no seq, naming the file and the line', () => {
    const bad = ndjson(line({ seq: 1 }), JSON.stringify({ runId: RUN, ts: 1, kind: 'x', v: 1 }));

    expect(() => readFixture(bad, 'bad.jsonl')).toThrow(UnreadableFixture);
    expect(() => readFixture(bad, 'bad.jsonl')).toThrow(/bad\.jsonl line 2/);
    expect(() => readFixture(bad, 'bad.jsonl')).toThrow(/seq/);
  });

  it('refuses a line with no kind', () => {
    const bad = ndjson(line({ kind: undefined }));
    expect(() => readFixture(bad, 'bad.jsonl')).toThrow(/kind/);
  });

  it('refuses a line that is not JSON at all', () => {
    expect(() => readFixture(ndjson(line(), '{ nope'), 'bad.jsonl')).toThrow(/bad\.jsonl line 2/);
  });

  it('refuses a sequence that goes backwards — an export is ordered by seq', () => {
    const bad = ndjson(line({ seq: 5 }), line({ seq: 4 }));
    expect(() => readFixture(bad, 'bad.jsonl')).toThrow(/descend|order/i);
  });

  it('refuses a repeated seq, which no AUTOINCREMENT ever issues', () => {
    expect(() => readFixture(ndjson(line({ seq: 5 }), line({ seq: 5 })), 'bad.jsonl')).toThrow(/5/);
  });

  it('refuses an empty fixture rather than serving a run that never happened', () => {
    expect(() => readFixture('\n\n', 'empty.jsonl')).toThrow(/no events/i);
  });
});
