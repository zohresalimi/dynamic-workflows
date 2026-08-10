/**
 * KAR-16.3 — the committed run fixtures are reproducible, and every line of
 * every one of them is an event this build can read.
 *
 * Verifies: EPIC-16-S15 · AC2
 *
 * Two different guarantees, and the fixtures need both for different reasons.
 *
 * **Reproducible.** `happy-path-12` and `three-patches` are *assembled* rather
 * than recorded (see `packages/core/scripts/build-ui-run-fixtures.ts` for why,
 * and for how long that is meant to remain true). An assembled fixture that
 * cannot be regenerated is a snapshot of a moment nobody can get back to, so
 * this rebuilds both into a tmpdir and compares byte for byte. A change to the
 * builder that was never re-run fails here.
 *
 * **Readable.** All five fixtures — including the three real recordings — are
 * re-parsed through `parseEvent`. A payload schema that moves under a committed
 * ledger fails *here*, naming the `seq` and the issues, rather than three
 * packages away inside a projection that quietly ignored the event and rendered
 * a slightly wrong picture. That is exactly what happened to the
 * `gate-failure-repair` fixture's seeded `node.started`, and it is the reason
 * this file exists.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, describe as suite } from 'vitest';
import { buildUiRunFixtures } from '../../scripts/build-ui-run-fixtures.ts';
import { parseEvent } from '../../src/events.ts';

const COMMITTED = fileURLToPath(new URL('../../../../test/fixtures/runs/', import.meta.url));

/** The two this builder owns. */
const ASSEMBLED = ['happy-path-12', 'three-patches'] as const;

/** Everything with an `events.jsonl`, assembled or recorded. */
const ALL = [...ASSEMBLED, 'compaction', 'gate-failure-repair', 'crash-resume-seq-gap'] as const;

const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

suite('the assembled fixtures rebuild to exactly what is committed', () => {
  it.each(ASSEMBLED)('%s is byte-identical after a rebuild', async (name) => {
    const dir = await mkdtemp(join(tmpdir(), 'DeFlow-ui-fixtures-'));
    scratch.push(dir);
    await buildUiRunFixtures(dir);

    const rebuilt = await readFile(join(dir, name, 'events.jsonl'), 'utf8');
    const committed = await readFile(join(COMMITTED, name, 'events.jsonl'), 'utf8');

    expect(rebuilt).toBe(committed);
  });
});

suite('every committed fixture is readable by this build', () => {
  it.each(ALL)('%s parses line by line', async (name) => {
    const text = await readFile(join(COMMITTED, name, 'events.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n');

    expect(lines.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      const parsed = parseEvent(JSON.parse(line));
      expect(parsed.status, `${name} line ${index + 1}: ${JSON.stringify(parsed)}`).toBe('ok');
    }
  });

  it.each(ALL)('%s is in strictly increasing seq order, holes and all', async (name) => {
    const text = await readFile(join(COMMITTED, name, 'events.jsonl'), 'utf8');
    const seqs = text
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { seq: number }).seq);

    // Increasing, never contiguous-by-assertion: `seq` is one global
    // AUTOINCREMENT shared with every other run in a data directory, so a
    // fixture with holes is a healthy fixture (docs/11 §4.2).
    expect(seqs).toEqual(seqs.toSorted((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
