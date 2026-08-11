/**
 * KAR-18.6 AC7 — what happens to the clean room when the verifier is done
 * with it: *"removed on success and preserved under `DeFlow_KEEP_TMP=1` on
 * failure, with the directory uploaded by `actions/upload-artifact` in CI"*
 * (EPIC-18-S42's last line says the same in Gherkin).
 *
 * Both halves are load-bearing and they pull in opposite directions, which is
 * why this is asserted rather than left to the repository's usual
 * `if (DeFlow_KEEP_TMP === undefined) rm(...)` fixture idiom:
 *
 *   - the CI job sets `DeFlow_KEEP_TMP=1` unconditionally, because the
 *     variable has to be on the step *before* anyone knows whether the step
 *     fails. Under the plain idiom that means every green release run leaves a
 *     clean room — a whole npm cache and an installed tarball — behind, which
 *     is the "removed on success" half broken by the very thing that makes the
 *     failure half work.
 *   - and the upload step is `if: failure()`, so the failure half is the only
 *     one that ever collects anything.
 *
 * So the rule the script follows is the conjunction the criterion actually
 * states: the room survives when the verification failed **and** preservation
 * was asked for. A real directory each time, because "was it deleted" is not a
 * question a mocked filesystem can answer about a script whose whole job is to
 * touch the real one.
 *
 * Verifies: EPIC-18-S42 (final Then) · AC7
 */
import { existsSync } from 'node:fs';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { makeCleanRoom, settleCleanRoom } from '../../scripts/verify-install/lib.ts';

const rooms: string[] = [];
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.DeFlow_KEEP_TMP;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.DeFlow_KEEP_TMP;
  else process.env.DeFlow_KEEP_TMP = previous;
  for (const room of rooms.splice(0)) {
    delete process.env.DeFlow_KEEP_TMP;
    await settleCleanRoom(room, { failed: false });
  }
});

async function room(): Promise<string> {
  const install = await makeCleanRoom();
  rooms.push(install.room);
  return install.room;
}

suite('AC7 — the clean room is removed on success', () => {
  it('removes it after a green run, even with DeFlow_KEEP_TMP set', async () => {
    process.env.DeFlow_KEEP_TMP = '1';
    const dir = await room();

    expect(await settleCleanRoom(dir, { failed: false })).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes it after a green run with the variable unset', async () => {
    delete process.env.DeFlow_KEEP_TMP;
    const dir = await room();

    expect(await settleCleanRoom(dir, { failed: false })).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});

suite('AC7 — and preserved under DeFlow_KEEP_TMP=1 on failure', () => {
  it('keeps the room a failed run left behind, so the upload step has it', async () => {
    process.env.DeFlow_KEEP_TMP = '1';
    const dir = await room();

    expect(await settleCleanRoom(dir, { failed: true })).toBe(true);
    // The whole room, not just the git repository inside it: the installed
    // tarball and the npm cache it resolved are what a "works locally, broken
    // on npm" failure is diagnosed from.
    expect(existsSync(dir)).toBe(true);
  });

  it("still removes a failed run's room when preservation was not asked for", async () => {
    // Preservation is opt-in, exactly as the criterion words it. A verifier
    // that kept every failed room would grow one npm cache per red run on the
    // machine of whoever is debugging the release.
    delete process.env.DeFlow_KEEP_TMP;
    const dir = await room();

    expect(await settleCleanRoom(dir, { failed: true })).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});
