/**
 * KAR-16.5 — a recorded run, read back off disk (docs/03-local-development.md §6.2).
 *
 * A fixture is one file per run: the NDJSON export of a real `ledger.db`'s
 * `event` rows, exactly as `packages/ledger/scripts/export-events-jsonl.ts`
 * wrote them. **The fixture format is the production format** — there is no
 * mock API shape to keep in sync, and no translation layer between what dev
 * shows and what production emits.
 *
 * The reader is strict on purpose, and about one thing in particular. A harness
 * that accepts a line with no `seq` does not fail at that line: it fails four
 * endpoints later, inside a projection, as a view that renders nothing — and
 * the first place anybody looks is the view. Every refusal here names the file
 * and the line.
 *
 * The one thing it is deliberately *not* strict about is the sequence having
 * holes. `seq` is one global `AUTOINCREMENT` shared by every run in a data
 * directory, so a single run's cursor walks a strided subsequence of it
 * (docs/11-api-and-realtime.md §4.2). `crash-resume-seq-gap` is a healthy
 * ledger whose numbers are 4, 5, 7, 8, 11, and a reader that "repaired" it
 * would delete the only fixture in the corpus that proves a client crosses a
 * hole in silence (AC9).
 */
import type { RunId } from '@DeFlow/core';
import { EventEnvelopeSchema } from '@DeFlow/core';
import type { StoredEvent } from '@DeFlow/ledger';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** A fixture line this build cannot read, named where a human can find it. */
export class UnreadableFixture extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, why: string) {
    super(
      `${path} line ${line} is not a recorded event: ${why}. Fixtures are exports of a real ` +
        'ledger, never hand-written, so a line this reader refuses means the export drifted ' +
        'from the Event envelope — rebuild the fixture from the script its README names.',
    );
    this.name = 'UnreadableFixture';
    this.path = path;
    this.line = line;
  }
}

/** A recorded run, as the harness serves it. */
export interface RecordedLedger {
  /** The file it was read from, as it is named in an error and a log line. */
  readonly path: string;
  /** Every recorded envelope, in `seq` order, with its recorded `seq`. */
  readonly events: readonly StoredEvent[];
  /** Every run the file holds, in first-seen order. Usually one. */
  readonly runIds: readonly RunId[];
  /** The highest `seq` in the file — the head a fully-played fixture reaches. */
  readonly headSeq: number;
  /** Recorded wall-clock span, first `ts` to last. What `--speed` divides. */
  readonly spanMs: number;
}

/** Reads `text` as one fixture. `path` is used only to name a bad line. */
export function readFixture(text: string, path: string): RecordedLedger {
  const events: StoredEvent[] = [];
  const runIds: RunId[] = [];
  const seen = new Set<string>();
  let previous: StoredEvent | undefined;

  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new UnreadableFixture(path, index + 1, `it is not JSON (${String(error)})`);
    }

    const parsed = EventEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new UnreadableFixture(
        path,
        index + 1,
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      );
    }

    const event = parsed.data as StoredEvent;
    if (previous !== undefined && event.seq <= previous.seq) {
      throw new UnreadableFixture(
        path,
        index + 1,
        `seq ${event.seq} does not follow ${previous.seq} — an export is ordered by seq, and ` +
          'AUTOINCREMENT never descends or repeats. Holes are expected; going backwards is a ' +
          'corrupt export',
      );
    }

    events.push(event);
    previous = event;
    if (!seen.has(event.runId)) {
      seen.add(event.runId);
      runIds.push(event.runId);
    }
  }

  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) {
    throw new UnreadableFixture(
      path,
      1,
      'the file holds no events at all, and a run that never happened is not a fixture',
    );
  }

  return {
    path,
    events,
    runIds,
    headSeq: last.seq,
    spanMs: last.ts - first.ts,
  };
}

/** Reads the fixture at `path`. */
export async function loadFixture(path: string): Promise<RecordedLedger> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `no fixture at ${path}. The corpus lives under test/fixtures/runs/ — each run is one ` +
        'directory holding events.jsonl and a README recording what produced it.',
      { cause: error },
    );
  }
  return readFixture(text, basename(path));
}
