/**
 * KAR-22.6 AC1, test plan #2 — there is **one** connector surface, and adding a
 * service does not grow a second one.
 *
 * KAR-22.4 built a framework and one service. The failure mode of a framework
 * with one service is that the second service arrives as a *copy*: a
 * `JiraConnectorsView.vue` beside `ConnectorsView.vue`, a `jira_connector`
 * table beside `connector`, a `/jira/issues` route beside
 * `/connectors/:service/issues`. Each of those is plausible, each is one
 * commit, and none is reliably caught by reading a diff — the copy looks
 * correct, because it is a copy of something correct.
 *
 * So it is caught here. Each rule counts a surface across the repository's
 * sources and requires **exactly one**.
 *
 * ## Why this guard passes on the day it is written
 *
 * It does, and that is the point of it rather than a weakness in it: KAR-22.4
 * left exactly one of each, and KAR-22.6's whole job is to add two services
 * without changing that. A guard of this shape cannot be red before the code
 * that violates it exists. What it *can* do is prove it would notice, so every
 * rule is run against a synthetic second occurrence and required to catch it —
 * the same discipline `packages/daemon/test/connector-credential-guard.test.ts`
 * applies to its own patterns.
 *
 * Verifies: EPIC-22-S76 · KAR-22.6 AC1
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

/** Every shipped source under `dir` — no specs, no `node_modules`, no builds. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test';
      return skip ? [] : sources(path);
    }
    if (entry.name.endsWith('.test.ts')) return [];
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

const FILES = sources(PACKAGES);
const display = (path: string): string => relative(ROOT, path);

interface Surface {
  /** What there must be exactly one of. */
  readonly what: string;
  /** A file counts when this matches its path or its contents. */
  readonly matches: (path: string, source: string) => boolean;
  /** A second occurrence the rule must catch, so it cannot rot into a no-op. */
  readonly sabotage: { readonly path: string; readonly source: string };
}

const SURFACES: readonly Surface[] = [
  {
    what: 'connectors screen component',
    matches: (path) => /\/views\/.*[Cc]onnectors?.*\.vue$/.test(path),
    sabotage: { path: '/packages/web/src/views/JiraConnectorsView.vue', source: '<template/>' },
  },
  {
    // A second table is a second store, which AC1 names as a defect in the same
    // breath as a second screen: it splits "is this project connected" across
    // two places that are free to disagree.
    what: '`connector` table creation',
    // No `\b` after the name, deliberately: the plausible second table is
    // `connector_jira`, and a word boundary would have walked past it. The
    // sabotage row below is what found that.
    matches: (_path, source) => /CREATE TABLE\s+connector/i.test(source),
    sabotage: {
      path: '/packages/ledger/src/migrations/0018-jira.ts',
      source: 'db.exec(`CREATE TABLE connector_jira (project_id TEXT)`)',
    },
  },
  {
    what: 'connector registry array',
    matches: (_path, source) => /export const SERVICES\b/.test(source),
    sabotage: {
      path: '/packages/daemon/src/connectors/jira-registry.ts',
      source: 'export const SERVICES = [JIRA];',
    },
  },
  {
    what: 'issue-search route',
    matches: (_path, source) => /connectors\/:service\/issues/.test(source),
    sabotage: {
      path: '/packages/daemon/src/http/jira-api.ts',
      source: ".get('/projects/:id/connectors/:service/issues', async (c) => {})",
    },
  },
  {
    // AC3 says the second and third services render from *the same component*
    // GitHub's list uses. This is what that means in files rather than in
    // intention.
    what: 'composer issue-list rendering',
    matches: (_path, source) => /data-composer-issues\b/.test(source),
    sabotage: {
      path: '/packages/web/src/components/JiraIssueList.vue',
      source: '<ul data-composer-issues></ul>',
    },
  },
];

suite('EPIC-22-S76 — one connector surface, not one per service (AC1)', () => {
  it('collected the repository’s sources at all', () => {
    // Non-vacuity for the whole file: every rule below runs over this set.
    expect(FILES.length).toBeGreaterThan(100);
  });

  it.each(SURFACES)('there is exactly one $what', (surface) => {
    const found = FILES.filter((path) => surface.matches(path, readFileSync(path, 'utf8'))).map(
      display,
    );

    // Asserted as the list rather than as a count, so a failure names the copy
    // instead of saying "expected 1, got 2".
    expect(found).toHaveLength(1);
  });

  it.each(SURFACES)('the rule for "$what" catches a second one', (surface) => {
    expect(surface.matches(surface.sabotage.path, surface.sabotage.source)).toBe(true);
  });
});
