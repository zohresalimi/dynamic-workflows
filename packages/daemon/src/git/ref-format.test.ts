/**
 * KAR-07.3 AC3 — `RefFormatChecker`'s caching mechanics, over a plain
 * counting test double (not a mock of `child_process`: `RefFormatChecker`
 * never spawns anything itself, it only calls the `run()` its constructor
 * was given — the double here is an ordinary injected dependency, the same
 * shape `Git.run()` has). Real `git check-ref-format` behaviour — what it
 * actually accepts and rejects — is verified against the genuine binary in
 * test/integration/branch-name.test.ts (EPIC-07-S5, S7, S8); this file is
 * only "does the cache work".
 */
import { expect, it, describe as suite } from 'vitest';
import { RefFormatChecker } from './ref-format.ts';

function countingRunner(exitCode: number): { calls: string[][]; run: RefFormatChecker['isValid'] } {
  const calls: string[][] = [];
  const checker = new RefFormatChecker({
    run: (args: readonly string[]) => {
      calls.push([...args]);
      return Promise.resolve({ exitCode });
    },
  });
  return { calls, run: (name: string) => checker.isValid(name) };
}

suite('RefFormatChecker (AC3)', () => {
  it('spawns "check-ref-format --branch <name>" and resolves true on exit 0', async () => {
    const { calls, run } = countingRunner(0);
    await expect(run('DeFlow/r1__n1')).resolves.toBe(true);
    expect(calls).toEqual([['check-ref-format', '--branch', 'DeFlow/r1__n1']]);
  });

  it('resolves false on a non-zero exit', async () => {
    const { run } = countingRunner(1);
    await expect(run('DeFlow/r1__node.lock')).resolves.toBe(false);
  });

  it('a second call for the same name reads the cache and spawns nothing', async () => {
    const { calls, run } = countingRunner(0);
    await run('DeFlow/r1__n1');
    await run('DeFlow/r1__n1');
    await run('DeFlow/r1__n1');
    expect(calls).toHaveLength(1);
  });

  it('caches false results too, not only true ones', async () => {
    const { calls, run } = countingRunner(1);
    await run('DeFlow/bad');
    await run('DeFlow/bad');
    expect(calls).toHaveLength(1);
  });

  it('different names are each checked once, independently', async () => {
    const { calls, run } = countingRunner(0);
    await run('DeFlow/r1__n1');
    await run('DeFlow/r1__n2');
    await run('DeFlow/r1__n1');
    expect(calls).toHaveLength(2);
  });
});
