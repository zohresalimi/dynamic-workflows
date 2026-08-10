/**
 * KAR-16.3 — writes `events.jsonl` beside every committed run fixture's
 * `ledger.db`.
 *
 * The projection modules under `packages/web/src/ledger/projections/` are
 * unit-tested in Vitest's **node** environment against recorded ledgers, and
 * that slice deliberately never pays for `better-sqlite3`'s native binding —
 * `test/setup.ts` says so in as many words. So the recorded ledgers need a form
 * a pure reducer can read, and NDJSON is the form the daemon already serves on
 * the wire and the form `DeFlow replay` will read back (KAR-16.5).
 *
 * It is an **export, never an authoring step**. Every line is a row out of the
 * fixture's own `event` table, read through `readRange` — the same bounded read
 * the API serves — and re-validated through `parseEvent` before it is written,
 * so a fixture that has drifted out of the current `Event` union fails here
 * rather than three files later inside a projection that quietly ignored it.
 *
 * Usage: `node packages/ledger/scripts/export-events-jsonl.ts [fixture…]`
 */
import type { Db } from '@DeFlow/core';
import { parseEvent, type RunId } from '@DeFlow/core';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRange } from '../src/append.ts';
import { openRead } from '../src/sqlite-db.ts';

/** Where the committed fixtures live, relative to this file. */
export const RUN_FIXTURES_DIR = fileURLToPath(
  new URL('../../../test/fixtures/runs/', import.meta.url),
);

/** One page is plenty: the biggest committed fixture is thirty events. */
const PAGE = 10_000;

/** Every run id present in `ledger.db`, in first-appearance order. */
function runsIn(db: Db): RunId[] {
  return db
    .prepare<{ run_id: string }>(
      'SELECT run_id, MIN(seq) AS first FROM event GROUP BY run_id ORDER BY first',
    )
    .all()
    .map((row) => row.run_id as RunId);
}

/**
 * Exports one fixture directory, returning the NDJSON it wrote.
 *
 * Every run in the ledger is exported into the one file, in `seq` order across
 * runs — which is what the daemon's own multiplexed stream delivers, and what
 * makes `crash-resume-seq-gap` legible: the numbers missing from the run under
 * test are right there, owned by the run that burned them.
 */
export function exportEventsJsonl(dir: string): string {
  const db = openRead(join(dir, 'ledger.db'));
  try {
    const envelopes = runsIn(db).flatMap((runId) => readRange(db, runId, 0, PAGE).events);

    const lines = envelopes
      .toSorted((left, right) => left.seq - right.seq)
      .map((envelope) => {
        const parsed = parseEvent(envelope);
        if (parsed.status !== 'ok') {
          throw new Error(
            `${dir}: seq ${envelope.seq} (${envelope.kind}) does not parse against this ` +
              `build's Event union — ${JSON.stringify(parsed)}. The fixture has drifted; ` +
              'rebuild it from its own builder script rather than editing the export.',
          );
        }
        return JSON.stringify(envelope);
      });

    return `${lines.join('\n')}\n`;
  } finally {
    db.close();
  }
}

/** Exports `dir` and writes `events.jsonl` into it. */
export function writeEventsJsonl(dir: string): number {
  const ndjson = exportEventsJsonl(dir);
  writeFileSync(join(dir, 'events.jsonl'), ndjson);
  return ndjson.trimEnd().split('\n').length;
}

/** Fixture directories holding a `ledger.db` — the ones this script can export. */
export function recordedFixtures(): string[] {
  return readdirSync(RUN_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => readdirSync(join(RUN_FIXTURES_DIR, name)).includes('ledger.db'))
    .toSorted();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const names = process.argv.slice(2);
  for (const name of names.length > 0 ? names : recordedFixtures()) {
    const count = writeEventsJsonl(join(RUN_FIXTURES_DIR, name));
    process.stdout.write(`${name}: ${count} events\n`);
  }
}
