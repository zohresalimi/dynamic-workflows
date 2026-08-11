/**
 * KAR-16.3 — the committed `events.jsonl` beside each recorded `ledger.db` is
 * still an export of it.
 *
 * Verifies: EPIC-16-S15 · AC2
 *
 * The projection suite folds NDJSON, because the unit slice must never pay for
 * `better-sqlite3`'s native binding (`test/setup.ts` says so). That leaves two
 * copies of the same run in the repository — the database and its export — and
 * two copies drift. So the export is recomputed here from the database and
 * compared: rebuild a fixture and forget to re-export it, and this fails rather
 * than a projection quietly folding last week's run.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { exportEventsJsonl, RUN_FIXTURES_DIR } from '../../scripts/export-events-jsonl.ts';

/** The fixtures that are recordings — each is a real `ledger.db`. */
const RECORDED = ['compaction', 'crash-resume-seq-gap', 'gate-failure-repair'] as const;

suite('every recorded fixture’s events.jsonl matches its ledger', () => {
  it.each(RECORDED)('%s exports to exactly what is committed', async (name) => {
    const dir = join(RUN_FIXTURES_DIR, name);
    const committed = await readFile(join(dir, 'events.jsonl'), 'utf8');

    expect(exportEventsJsonl(dir)).toBe(committed);
  });
});
