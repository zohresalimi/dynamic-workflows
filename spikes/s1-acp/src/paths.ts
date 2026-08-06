/**
 * Where a run's generated capability fixture lands.
 *
 * A live probe of a real vendor is the only run that has anything new to say:
 * its fixture is the artefact of that probe — the agentCapabilities block a
 * named vendor version really returned, stamped with when it was asked — and it
 * belongs in the committed `fixtures/capabilities/`.
 *
 * A replay is not a probe. It re-drives the same client over a recording of one
 * that already happened, so the only field it can contribute is a fresh
 * `probedAt`, which is a lie about when the agent was asked and, until this
 * split existed, was enough to leave a clean checkout dirty after `pnpm test`.
 * A fake agent has even less standing: it exists to contradict a snapshot on
 * purpose. Both generate their fixture into a temporary directory, and
 * test/integration/spike-s1-acp.test.ts compares the replay's against the
 * committed one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The committed fixtures. Only a live probe writes here. */
export const COMMITTED_FIXTURE_DIR = join(REPO_ROOT, 'fixtures/capabilities');

export function fixtureDirFor(mode: 'live' | 'replay', kind: 'vendor' | 'fake'): string {
  return mode === 'live' && kind === 'vendor'
    ? COMMITTED_FIXTURE_DIR
    : mkdtempSync(join(tmpdir(), 'deflow-s1-fixtures-'));
}

/** Whether `path` is inside the committed fixture directory. */
export function isCommittedFixture(path: string): boolean {
  return path.startsWith(COMMITTED_FIXTURE_DIR);
}
