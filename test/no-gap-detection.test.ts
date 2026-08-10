/**
 * KAR-15.4 AC5 / test plan #3 — nobody, anywhere, compares an incoming `seq` to
 * its predecessor plus one.
 *
 * Verifies: EPIC-15-S29 (its CI-grep clause) · AC5
 *
 * `seq` 4, 5, 7 is a **healthy** log. `6` belongs to another run — the `event`
 * table is one global sequence keyed by `run_id` — or to a pruned event, whose
 * number `AUTOINCREMENT` never reissues (docs/11-api-and-realtime.md §4.2). A
 * client that treats that hole as a dropped event reports false data loss on a
 * perfectly correct stream and, worse, may try to "repair" by refetching from
 * zero, which on a multi-hour run is minutes of wasted work triggered by
 * nothing.
 *
 * So this is a property of the **absence** of code, and the only kind of test
 * that can hold it is a scan. A gap detector passes every behaviour test in the
 * suite — a fixture with no gap never triggers it — and is wrong only against a
 * real ledger, which is the worst possible place to find out.
 *
 * `packages/ledger/test/append-only.test.ts` already holds the ledger and the
 * daemon to `cursor + 1` (EPIC-03-S9). This one is deliberately wider in two
 * directions: **every** workspace package, because the client half of the
 * resume contract lives in `packages/web` and `packages/cli`, and every
 * spelling of *density* — `seq - previous > 1` says the same wrong thing as
 * `previous + 1` and reads as diligence.
 *
 * The scope is production sources and the fixture-building scripts, not specs.
 * A spec may legitimately assert contiguity over a harness it controls — the
 * one-port spike's stand-in server assigns `1, 2, 3` and nothing burns a number
 * there, so *"the next event is the previous plus one"* is a true statement
 * about that fixture. What must not exist is a **shipped** code path that
 * decides a healthy ledger has lost something.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

interface Source {
  readonly path: string;
  readonly text: string;
}

const PACKAGES_DIR = new URL('../packages/', import.meta.url).pathname;

function sourcesUnder(dir: string, prefix: string): Source[] {
  const found: Source[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      found.push(...sourcesUnder(full, `${prefix}${entry}/`));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
  }
  return found;
}

/**
 * The rule is about expressions, not prose.
 *
 * Every file that explains *why* gap detection is forbidden has to write the
 * forbidden expression down to explain it, and the file doing the explaining
 * must not be the file this test fails on.
 */
const code = (source: Source): Source => ({
  ...source,
  text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
});

/** Every workspace package's `src/`, and the one script directory beside it. */
function workspaceSources(): Source[] {
  const found: Source[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR).sort()) {
    for (const dir of ['src', 'scripts']) {
      const full = join(PACKAGES_DIR, pkg, dir);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      found.push(...sourcesUnder(full, `packages/${pkg}/${dir}/`));
    }
  }
  return found.map(code);
}

const sources = workspaceSources();

/** A `seq`-shaped name. `lastSeq`, `afterSeq`, `cursor`, `last_seq`, `headSeq`. */
const SEQ = String.raw`[\w.$#]*(?:seq|cursor)`;

/**
 * `cursor + 1` in every spelling, and `1 + cursor` for the reader who writes it
 * backwards.
 */
const SUCCESSOR = new RegExp(String.raw`\b${SEQ}\s*\+\s*1\b|\b1\s*\+\s*${SEQ}\b`, 'i');

/**
 * Density: `seq - previous > 1`, `>= 2`, `!== 1`. The subtraction alone is
 * innocent — it is *how far behind am I*, which `hello.headSeq` invites — so
 * what is caught is a difference **compared to a small constant**, which is the
 * question "was anything skipped" and has no correct answer.
 */
const DENSITY = new RegExp(String.raw`${SEQ}\s*-\s*[\w.$#]+\s*(?:[!=]==?|[<>]=?)\s*[123]\b`, 'i');

const matching = (files: readonly Source[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

suite('EPIC-15-S29 — no gap detection exists anywhere (AC5)', () => {
  it('scanned a real, non-empty set of sources, client packages included', () => {
    expect(sources.length).toBeGreaterThan(50);
    const paths = sources.map((file) => file.path);
    expect(paths).toContain('packages/daemon/src/http/stream.ts');
    expect(paths).toContain('packages/daemon/src/http/resume.ts');
    expect(paths).toContain('packages/web/src/api/dispatch.ts');
    expect(paths).toContain('packages/cli/src/index.ts');
    expect(paths).toContain('packages/ledger/src/append.ts');
  });

  it('computes no successor of a cursor', () => {
    expect(matching(sources, SUCCESSOR)).toEqual([]);
  });

  it('compares no difference between two seqs against a small constant', () => {
    expect(matching(sources, DENSITY)).toEqual([]);
  });

  it('and both patterns have teeth', () => {
    const planted: Source[] = [
      { path: 'successor.ts', text: 'const expected = cursor + 1;' },
      { path: 'successor-reversed.ts', text: 'if (event.seq !== 1 + lastSeq) warn();' },
      { path: 'density.ts', text: 'if (event.seq - previousSeq > 1) reportDataLoss();' },
      { path: 'density-equality.ts', text: 'const contiguous = nextSeq - lastSeq === 1;' },
    ];
    const scanned = planted.map(code);
    expect(matching(scanned, SUCCESSOR).toSorted()).toEqual([
      'successor-reversed.ts',
      'successor.ts',
    ]);
    expect(matching(scanned, DENSITY).toSorted()).toEqual(['density-equality.ts', 'density.ts']);
  });

  it('leaves the honest comparisons alone', () => {
    // Ordering against the head, and "strictly greater than my cursor", are the
    // two integrity checks §4.2 permits. Neither may be flagged, or the guard
    // would push people towards writing something worse.
    const honest: Source[] = [
      { path: 'ordering.ts', text: 'const behind = hello.headSeq - cursor;' },
      { path: 'strict.ts', text: 'if (event.seq > cursor) apply(event);' },
      { path: 'max.ts', text: 'cursor = Math.max(cursor, event.seq);' },
      { path: 'window.ts', text: "const SQL = 'SELECT * FROM event WHERE seq > ? LIMIT ?';" },
    ];
    const scanned = honest.map(code);
    expect(matching(scanned, SUCCESSOR)).toEqual([]);
    expect(matching(scanned, DENSITY)).toEqual([]);
  });
});
