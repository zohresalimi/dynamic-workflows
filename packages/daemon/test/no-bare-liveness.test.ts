/**
 * EPIC-07-S31 scenario 3 — "bare liveness is never used as the check".
 *
 * > When packages/workspace and packages/proc are grepped
 * > Then no call site uses `process.kill(pid, 0)` as an orphan-liveness check
 * > And every liveness decision reads the recorded process start time
 *
 * The flow names two packages this repository does not have
 * (docs/16-repo-layout.md's nine-package list has neither); the code they
 * describe lives in `packages/daemon/src` and `packages/adapters/src`, so those
 * are what is scanned.
 *
 * The grep assertion is deliberate, and the scenario says why: `kill(pid, 0)`
 * is the obvious, idiomatic, wrong answer to "is this pid still mine?", and it
 * will be reached for by anyone who has not read the scenario. It answers a
 * *different question* — "does some process with this number exist" — and pids
 * are recycled, most likely after exactly the events the reaper exists to
 * survive: a long laptop suspend, or a machine restart. Killing a stranger's
 * process because you reused a number is an unrecoverable class of bug.
 *
 * Test sources are not scanned. A spec asserting that a process it spawned
 * itself is still running is `process.kill(pid, 0)`'s one legitimate use, and
 * `test/integration/reaper.test.ts` makes exactly that assertion.
 *
 * Verifies: EPIC-07-S31 scenario 3 · KAR-07.8 AC2
 */
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = ['packages/daemon/src', 'packages/adapters/src'];

/** Every `.ts` under `dir`, recursively, minus the `.test.ts` files. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/**
 * A `kill(<anything>, 0)` call, however it is spelled — `process.kill`,
 * `nodeProcess.kill`, a destructured `kill`, or a port called through an
 * injected seam. Signal `0` sends nothing and only asks whether a pid exists,
 * which is the whole problem.
 */
const BARE_LIVENESS = /\bkill\s*\(\s*[^,()]+,\s*0\s*\)/;

async function scannedSources(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of SCANNED) files.push(...(await sources(join(ROOT, dir))));
  return files;
}

suite('no orphan-liveness decision is made from a bare pid', () => {
  it('scanned a real tree, not an empty one', async () => {
    expect((await scannedSources()).length).toBeGreaterThan(50);
  });

  it('spells kill(pid, 0) nowhere in daemon or adapter sources', async () => {
    const offenders = (await scannedSources()).filter((file) =>
      BARE_LIVENESS.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('makes every liveness decision through the recorded start time', async () => {
    const reaper = readFileSync(join(ROOT, 'packages/daemon/src/reaper.ts'), 'utf8');
    const sweep = readFileSync(
      join(ROOT, 'packages/daemon/src/workspace/worktree-reaper.ts'),
      'utf8',
    );

    for (const source of [reaper, sweep]) {
      expect(source).toContain('processStartTime');
      expect(source).toMatch(/startTime/);
    }
  });

  it('verifies a group kill through the Z-filtered check, not a bare ps', async () => {
    // AC3: "the kill is verified with the `Z`-state exclusion from EPIC-08
    // KAR-08.6". `liveGroupMembers` is that check; a second `ps` reader in the
    // reaper would be the unfiltered one the zombie false-negative bites.
    const reaper = readFileSync(join(ROOT, 'packages/daemon/src/reaper.ts'), 'utf8');

    expect(reaper).toContain('liveGroupMembers');
    expect(reaper).not.toContain("'-eo'");
  });
});
