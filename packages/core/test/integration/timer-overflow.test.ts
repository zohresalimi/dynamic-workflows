/**
 * KAR-14.4 AC4 — the `2**31` demonstration, and the lint rule that keeps the
 * lesson enforced rather than merely remembered.
 *
 * **Verified 2026-08-02** and re-verified here, in a real child process on this
 * machine: Node's maximum timer delay is `2**31 - 1` ms (24.9 days), and passing
 * `2**31` neither throws nor clamps. It fires the callback after **1 ms**, with
 * only a `TimeoutOverflowWarning` on stderr. A 30-day human gate or a monthly
 * quota reset written as a timer fires instantly, and nothing in the logs says
 * "durability failure".
 *
 * The demonstration runs as a subprocess rather than in-process for two
 * reasons: `TimeoutOverflowWarning` is emitted once per process for a given
 * call site and would be swallowed by a warm worker, and the whole claim is
 * about what a *process* does. No fake timers anywhere — faking them would
 * remove exactly the behaviour under test.
 *
 * Verifies: EPIC-14-S22 scenario 1, and the last line of scenario 2 · AC4
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';

const run = promisify(execFile);

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** A real directory on disk, because the demonstration is about a real process.
 * Under `os.tmpdir()` rather than the repo, so nothing machine-local can leak
 * into a diff. */
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'DeFlow-timer-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Node's documented ceiling. Everything below is about the millisecond past it. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

// ── EPIC-14-S22 scenario 1 — the demonstration ───────────────────────────────

suite('EPIC-14-S22 scenario 1 — setTimeout(2 ** 31) fires immediately (AC4)', () => {
  it('fires within 50 ms and warns on stderr, without failing in any other way', async () => {
    const script = join(tmp, 'overflow.mjs');
    writeFileSync(
      script,
      [
        'const started = process.hrtime.bigint();',
        'setTimeout(() => {',
        '  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;',
        '  process.stdout.write(JSON.stringify({ elapsedMs }));',
        '  process.exit(0);',
        '}, 2 ** 31);',
      ].join('\n'),
      'utf8',
    );

    const { stdout, stderr } = await run(process.execPath, [script], { timeout: 20_000 });
    const { elapsedMs } = JSON.parse(stdout) as { elapsedMs: number };

    // Asked for 24.9 days. Got about a millisecond.
    expect(elapsedMs).toBeLessThan(50);
    expect(2 ** 31).toBeGreaterThan(MAX_TIMER_DELAY);

    // And the only sign anything went wrong: a warning on stderr, which no
    // supervisor reads and no alert fires on.
    expect(stderr).toContain('TimeoutOverflowWarning');
    expect(stderr).toContain('does not fit into a 32-bit signed integer');
  });

  it('does not throw, does not clamp, and exits 0 — which is why it is a trap', async () => {
    const script = join(tmp, 'quiet.mjs');
    writeFileSync(
      script,
      [
        // A 30-day human gate, written the way somebody reaches for first.
        'const thirtyDays = 30 * 24 * 60 * 60 * 1000;',
        'let fired = false;',
        'setTimeout(() => { fired = true; }, thirtyDays);',
        'setTimeout(() => {',
        '  process.stdout.write(JSON.stringify({ fired }));',
        '  process.exit(0);',
        '}, 100);',
      ].join('\n'),
      'utf8',
    );

    const { stdout } = await run(process.execPath, [script], { timeout: 20_000 });
    // A wait of thirty days, over in a tenth of a second, with an exit code of
    // zero. Nothing here is distinguishable from success.
    expect(JSON.parse(stdout)).toEqual({ fired: true });
  });
});

// ── AC4 — the lint rule, proven by running the linter ────────────────────────

/** Every package whose source is *engine* code: a wait there must be a row. */
const ENGINE_PACKAGES = ['core', 'ledger', 'adapters'] as const;

const oxlintOn = async (file: string): Promise<{ code: number; out: string }> => {
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'oxlint', file], {
      cwd: REPO,
      timeout: 120_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (thrown) {
    const error = thrown as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

suite('AC4 — a setTimeout used as a wait fails the build in every engine package', () => {
  for (const pkg of ENGINE_PACKAGES) {
    it(`oxlint refuses it under packages/${pkg}/src`, { timeout: 120_000 }, async () => {
      const file = join(REPO, 'packages', pkg, 'src', 'zz-timer-lint-probe.ts');
      writeFileSync(
        file,
        [
          '// A temporary probe written by packages/core/test/integration/',
          '// timer-overflow.test.ts. If you are reading this in a working tree,',
          '// a spec crashed mid-run — delete it.',
          'export function waitForTheReset(ms: number): Promise<void> {',
          '  return new Promise((resolve) => {',
          '    setTimeout(resolve, ms);',
          '  });',
          '}',
        ].join('\n'),
        'utf8',
      );

      try {
        const { code, out } = await oxlintOn(file);
        expect(code).not.toBe(0);
        expect(out).toContain('no-restricted-globals');
        // The message has to say what to do instead, or the rule teaches
        // nothing and gets suppressed the first time it fires.
        expect(out).toContain('node_wake');
      } finally {
        rmSync(file, { force: true });
      }
    });
  }

  it('leaves no probe behind', () => {
    for (const pkg of ENGINE_PACKAGES) {
      const dir = join(REPO, 'packages', pkg, 'src');
      expect(readdirSync(dir).filter((entry) => entry.startsWith('zz-timer-lint-probe'))).toEqual(
        [],
      );
    }
  });

  it('names all three engine packages in the config, not just core', () => {
    // The rule is only worth having where the engine lives. The daemon is
    // excluded on purpose: `packages/daemon/src/clock.ts` is the one legitimate
    // `setTimeout` in the system, and it is a *sleep hint* for the ~1 Hz ticker
    // rather than a wait — capped at one second, so it can never express a
    // deadline at all.
    const config = readFileSync(join(REPO, '.oxlintrc.json'), 'utf8');
    for (const pkg of ENGINE_PACKAGES) {
      expect(config).toContain(`packages/${pkg}/src/**/*.ts`);
    }
  });
});
