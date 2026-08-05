/**
 * KAR-03.8 — a real child that can be killed the way a crash kills things:
 * `SIGKILL`, and everything it spawned along with it (EPIC-03-S26).
 *
 * The process **group** is the load-bearing detail. A daemon that is SIGKILLed
 * leaves its children running unless they go too, and an orphaned agent that
 * writes its side-effect line *after* the restart has already decided the
 * effect never happened turns a correct restart into a duplicate — a flake with
 * no bug behind it. Killing the group is what a `kill -9` on a crashed laptop
 * really does, and it is what makes the crash point a single instant rather
 * than a window.
 *
 * Real processes throughout. There is no way to ask a process to be killed this
 * rudely from inside itself, which is exactly why the fixture exists.
 *
 * Verifies: EPIC-03-S26 (background) · AC5
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Crashable, it, startCrashable, waitFor } from '../../src/index.ts';

const SPAWNER = fileURLToPath(new URL('./support/spawns-a-child.ts', import.meta.url));

const started: Crashable[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) await child.sigkill();
});

function start(script: string, args: readonly string[]): Crashable {
  const child = startCrashable({ script, args });
  started.push(child);
  return child;
}

const readMarker = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

suite('startCrashable', () => {
  it('kills the child and everything it spawned, in one signal', async ({ tmp }) => {
    const parentMarker = join(tmp, 'parent.txt');
    const childMarker = join(tmp, 'grandchild.txt');
    const child = start(SPAWNER, [parentMarker, childMarker]);

    // Both processes are up and have said so on disk.
    await waitFor(() => readMarker(parentMarker) === 'up' && readMarker(childMarker) === 'up', {
      describe: 'the spawner and its grandchild to start',
    });

    const outcome = await child.sigkill();
    expect(outcome.signal).toBe('SIGKILL');

    // The grandchild rewrites its marker every 20 ms while it lives. If the
    // group kill missed it, the file keeps changing after the parent is gone.
    writeFileSync(childMarker, 'killed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readMarker(childMarker)).toBe('killed');
  });

  it('reports a clean exit rather than a signal when the child finishes on its own', async ({
    tmp,
  }) => {
    const child = start(SPAWNER, [join(tmp, 'parent.txt'), join(tmp, 'grandchild.txt'), '--exit']);
    expect(await child.exited).toEqual({ code: 0, signal: null });
  });

  it('is safe to kill twice — the second is a process that is already gone', async ({ tmp }) => {
    const child = start(SPAWNER, [join(tmp, 'parent.txt'), join(tmp, 'grandchild.txt'), '--exit']);
    await child.exited;
    await expect(child.sigkill()).resolves.toEqual({ code: 0, signal: null });
  });

  it('collects the child’s stderr, so a failing harness says why', async ({ tmp }) => {
    const child = start(SPAWNER, [join(tmp, 'parent.txt'), join(tmp, 'grandchild.txt'), '--boom']);
    await child.exited;
    expect(child.stderr()).toContain('the scripted run refused to start');
  });
});

suite('waitFor', () => {
  it('resolves as soon as the condition holds', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    await expect(waitFor(() => ready, { describe: 'the flag' })).resolves.toBeUndefined();
  });

  it('fails with what it was waiting for rather than with a bare timeout', async () => {
    await expect(
      waitFor(() => false, { describe: 'a condition that never holds', timeoutMs: 60 }),
    ).rejects.toThrow('a condition that never holds');
  });
});
