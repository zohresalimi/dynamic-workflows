/**
 * KAR-03.1 — the README says what `synchronous = NORMAL` does *not* buy.
 *
 * This is a test rather than a review note because the failure mode is silence:
 * a document that never mentions power loss reads exactly like one that
 * promises invulnerability, and the epic's Definition of Done asks for the
 * sentence explicitly.
 *
 * Verifies: EPIC-03-S25 (scenario 2) · AC8
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

suite('packages/ledger/README.md is honest about durability', () => {
  it('states that NORMAL does not fsync the WAL on every commit', () => {
    expect(readme).toMatch(/does not fsync the WAL on every commit/i);
  });

  it('names what can be lost — a kernel panic or a power cut, not a process crash', () => {
    expect(readme).toMatch(/kernel panic/i);
    expect(readme).toMatch(/power cut/i);
    expect(readme).toMatch(/process crash/i);
  });

  it('records the measured price of the alternative', () => {
    expect(readme).toContain('979');
    expect(readme).toContain('22,982');
  });

  it('says NORMAL is the right trade for a laptop daemon', () => {
    expect(readme).toMatch(/laptop daemon/i);
  });

  it('names the one case that switches to FULL, and how to ask for it', () => {
    expect(readme).toContain('withFullSync');
    expect(readme).toMatch(/irreversible/i);
  });

  it('states the ":memory:" rule before the first durability test relies on it', () => {
    expect(readme).toMatch(/pure projection/i);
    expect(readme).toContain('*.projection.test.ts');
  });
});

/**
 * KAR-03.4 / EPIC-03-S13 scenario 3: the reason unbounded reads are banned has
 * to be written down, because "add a LIMIT" reads like fussiness until someone
 * knows that the driver is synchronous and the cost lands on every other
 * request in the process.
 *
 * Verifies: EPIC-03-S13 (scenario 3), EPIC-03-S14 · AC5
 */
suite('packages/ledger/README.md explains why reads are bounded', () => {
  it('says better-sqlite3 is synchronous and what that costs the rest of the daemon', () => {
    expect(readme).toMatch(/synchronous/i);
    expect(readme).toMatch(/SSE/);
    expect(readme).toMatch(/stalls?/i);
  });

  it('records the held-cursor WAL failure and the bounded drain that replaces it', () => {
    expect(readme).toMatch(/iterate\(\)/);
    expect(readme).toMatch(/-wal/);
    expect(readme).toMatch(/wal_checkpoint\(TRUNCATE\)/);
  });
});

/**
 * KAR-03.5 / EPIC-03-S7 scenario 2: the two downgrade mechanisms are stated
 * *together*, because on their own each one reads like an inconsistency —
 * "the ledger tolerates a newer daemon" and "the ledger refuses a newer
 * daemon" are both true, of different layers, and a reader who meets only one
 * of them will assume the other is a bug.
 *
 * Verifies: EPIC-03-S7 (scenario 2)
 */
suite('packages/ledger/README.md states both downgrade rules as a pair', () => {
  const section = readme.slice(readme.indexOf('Downgrade safety is two mechanisms'));

  it('has a section that introduces them as two mechanisms covering different layers', () => {
    expect(readme).toMatch(/Downgrade safety is two mechanisms, not one/);
  });

  it('names the reducer’s unknown-kind tolerance as the event-payload half', () => {
    expect(section).toMatch(/unknown `kind`/);
    expect(section).toMatch(/KAR-03\.5/);
  });

  it('names LedgerTooNew as the schema half, and points at the backups', () => {
    expect(section).toContain('LedgerTooNew');
    expect(section).toContain('pre-migrate-*.db');
  });

  it('says why there is no equivalent tolerance at the schema layer', () => {
    expect(section).toMatch(/constraint it does not know exists/);
  });
});

/**
 * KAR-03.6 — the checkpoint's contract is written down, because the two ways
 * to get it wrong are both invisible in code review.
 *
 * The first is treating the cache as state: someone reads `run.state_json` and
 * concludes it is where a run lives. The second is editing `RunState` without
 * bumping `CHECKPOINT_VERSION`, which is the only way this cache can produce a
 * wrong answer — and the README is where a reader learns that the bump costs
 * nothing but a replay.
 *
 * Verifies: EPIC-03-S19, EPIC-03-S20 · AC6, AC7
 */
suite('packages/ledger/README.md says the checkpoint is optional and disposable', () => {
  const section = readme.slice(readme.indexOf('## The checkpoint is a cache'));

  it('calls it a pure optimisation rather than state', () => {
    expect(section).toMatch(/pure optimisation/i);
  });

  it('states the same-transaction rule and what it removes', () => {
    expect(section).toMatch(/same transaction as the events it covers/i);
    expect(section).toMatch(/SIGKILL/);
    expect(section).toContain('run.last_seq <= max(event.seq)');
  });

  it('lists what makes a cache be discarded, and that discarding it is correct', () => {
    expect(section).toContain('checkpoint_version');
    expect(section).toContain('RunStateSchema');
    expect(section).toMatch(/replay from seq 0|replay from seq 0\./i);
  });

  it('tells the reader to bump CHECKPOINT_VERSION on a shape change', () => {
    expect(section).toMatch(/Bump it whenever the shape of `RunState` changes/);
  });

  it('names the flag that turns it off, and why the suite runs with it set', () => {
    expect(section).toContain('DeFlow_NO_CHECKPOINT=1');
    expect(section).toMatch(/depend on/i);
  });
});

/**
 * KAR-03.9 — the blob store's three non-obvious rules are written down, because
 * each of them looks like fussiness to a reader who has not been bitten by it.
 *
 * "Put the temp file next to the target" reads as style until you know that
 * `rename` is atomic only within one filesystem; "never delete a blob" reads as
 * an oversight until you know a blob is shared across every run that produced
 * the same bytes; and "verify the hash on read" reads as paranoia until you
 * picture a corrupted build log going to an agent as evidence.
 *
 * Verifies: EPIC-03-S28, EPIC-03-S29 · AC4, AC5, AC6
 */
suite('packages/ledger/README.md explains the blob store', () => {
  const section = readme.slice(readme.indexOf('## Big payloads spill'));
  /** Wrapping is the formatter's business, so the assertions are about words. */
  const flat = section.replaceAll(/\s+/g, ' ');

  it('has the section, and states the threshold and what the event keeps', () => {
    expect(readme).toMatch(/## Big payloads spill/);
    expect(section).toContain('256 KiB');
    expect(flat).toContain('{ sha256, bytes, mime, head, tail }');
  });

  it('says why: replay time is a function of ledger size', () => {
    expect(flat).toMatch(/replay time is\*{0,2} a function of ledger size/i);
  });

  it('gives the reason the temp file is a sibling rather than in a system temp dir', () => {
    expect(flat).toMatch(/atomic only \*{0,2}within one filesystem/);
    expect(section).toContain('.DeFlow-');
  });

  it('states that blobs are global and that nothing here deletes one', () => {
    expect(section).toMatch(/global/i);
    expect(section).toMatch(/mark-and-sweep|reference-counted/);
  });

  it('says the hash is verified on read, and names both typed failures', () => {
    expect(section).toContain('BlobCorrupt');
    expect(section).toContain('BlobMissing');
    expect(section).toMatch(/head\/tail/);
  });
});
