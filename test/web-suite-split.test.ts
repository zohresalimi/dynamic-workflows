/**
 * KAR-16.3 AC2 — every `@DeFlow/web` spec is claimed by exactly one project.
 *
 * Verifies: EPIC-16-S15 · AC2
 *
 * `packages/web`'s specs are split across two runners for a reason that is not
 * arbitrary: the component and stream specs need a real Chromium (a `getBBox()`
 * of 0 from jsdom does not fail, it *lies* — docs/14 §13), and the projection
 * specs must not pay for one, because they are the largest block of frontend
 * tests and are meant to run on every save.
 *
 * The split is expressed as glob patterns in two config files, and a glob that
 * stops matching does not announce itself. A spec that fell out of **both**
 * projects would simply never run and every gate would stay green; a spec in
 * **both** would run twice, once in an environment it was not written for. So
 * the two sets are computed here from the same directory listing and asserted
 * to partition it.
 *
 * This is the guard that lets the `unit` project's exclusion list be
 * depth-explicit rather than a single `packages/web/**` — see the comment on it
 * in `vitest.config.ts`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const WEB = new URL('../packages/web/', import.meta.url).pathname;

/** Every `*.test.ts` under `packages/web`, as a package-relative path. */
function specsUnder(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).toSorted()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__screenshots__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...specsUnder(full, `${prefix}${entry}/`));
      continue;
    }
    if (entry.endsWith('.test.ts')) found.push(`${prefix}${entry}`);
  }
  return found;
}

const PROJECTIONS = 'src/ledger/projections/';

/** The node slice: pure reducers, no DOM, no mount. */
const nodeSlice = (path: string): boolean => path.startsWith(PROJECTIONS);

/** The browser slice: everything else in the package. */
const browserSlice = (path: string): boolean => !path.startsWith(PROJECTIONS);

suite('AC2 — the web suite is partitioned, not overlapped', () => {
  const specs = specsUnder(WEB, '');

  it('finds specs at all, so a passing partition is not a partition of nothing', () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  it('claims every spec exactly once', () => {
    const unclaimed = specs.filter((path) => !nodeSlice(path) && !browserSlice(path));
    const doubled = specs.filter((path) => nodeSlice(path) && browserSlice(path));

    expect(unclaimed, `unclaimed by either project: ${unclaimed.join(', ')}`).toEqual([]);
    expect(doubled, `claimed by both projects: ${doubled.join(', ')}`).toEqual([]);
  });

  it('puts the projection specs in the node slice and nothing else', () => {
    expect(specs.filter(nodeSlice).toSorted()).toEqual([
      `${PROJECTIONS}blackboard.test.ts`,
      `${PROJECTIONS}context.test.ts`,
      `${PROJECTIONS}cost.test.ts`,
      `${PROJECTIONS}gates.test.ts`,
      `${PROJECTIONS}idempotency.test.ts`,
      // KAR-17.9's aggregation. A pure selector over a folded blackboard, so it
      // belongs on this side of the split for the same reason the seven
      // reducers do: no Vue, no DOM, no mount, and milliseconds instead of a
      // page load.
      `${PROJECTIONS}memory-graph.test.ts`,
      `${PROJECTIONS}plan.test.ts`,
      `${PROJECTIONS}planHistory.test.ts`,
      `${PROJECTIONS}purity.test.ts`,
      `${PROJECTIONS}snapshots.test.ts`,
      `${PROJECTIONS}timeline.test.ts`,
    ]);
  });

  it('keeps the browser slice non-empty, so the split has not collapsed one way', () => {
    expect(specs.filter(browserSlice).length).toBeGreaterThan(5);
  });
});

suite('AC2 — the two configs still express that partition', () => {
  it('excludes the projections from the browser project', async () => {
    const config = await readText(new URL('../packages/web/vitest.config.ts', import.meta.url));

    expect(config).toContain("exclude: ['src/ledger/projections/**/*.test.ts']");
  });

  it('re-admits them to the unit project, past the blanket web exclusion', async () => {
    const config = await readText(new URL('../vitest.config.ts', import.meta.url));

    // Depth-explicit, because a `packages/web/**/!(projections)/**` would let
    // `**` swallow the `projections` segment and quietly take the specs back.
    expect(config).toContain("'packages/web/src/ledger/!(projections)/**/*.test.ts'");
    expect(config).not.toContain("'packages/web/**'");
  });
});

async function readText(url: URL): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}
