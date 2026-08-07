/**
 * KAR-08.6 — the kill switch has exactly one kill site, and the repository is
 * what holds it there.
 *
 * A behavioural spec can only cover the paths somebody remembered to run. This
 * covers the ones nobody did, and it exists because every wrong version of a
 * group kill is one character or one option away from the right one:
 *
 *  - `process.kill(pid, …)` rather than `process.kill(-pid, …)` kills the agent
 *    and leaves both grandchildren running, reparented to init, still holding
 *    the worktree open. Measured — the regression spec is
 *    `packages/daemon/test/integration/kill-switch.test.ts`.
 *  - `child.kill()` reads like a tidier spelling of the same thing and is
 *    execa's own documented non-answer: it signals the direct subprocess only.
 *  - `forceKillAfterDelay` does not fire when an explicit signal is passed, and
 *    DeFlow always passes one.
 *
 * None of the three throws. All three produce a kill switch that reports
 * success while agents keep compiling, so the rule is structural rather than
 * remembered: one seam, `killTree`, and the POSIX branch negates exactly once.
 *
 * The scope is the six packages that make up the running daemon.
 * `packages/testkit` and `packages/mock-agent` are excluded and named here
 * rather than silently skipped: the testkit's crash harness exists to SIGKILL a
 * daemon that is deliberately being killed, and the mock agent is a fake vendor
 * CLI that manages its own children — neither is an agent code path, and both
 * would have to grow a dependency on @DeFlow/adapters to use the seam, which
 * inverts the dependency direction @DeFlow/adapters' own specs depend on.
 *
 * Verifies: EPIC-08-S26 (scenario 4), EPIC-08-S28 (scenario 3) · AC1, AC8 ·
 * test plan #7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoExecaKillOptions,
  checkOneKillSite,
  KILL_SEAM,
  describe as render,
} from './support/guards.ts';
import { productionSources, readText } from './support/workspace.ts';

/** The packages that make up the running daemon. */
const RUNTIME_PACKAGES = [
  'packages/core',
  'packages/ledger',
  'packages/adapters',
  'packages/daemon',
  'packages/cli',
  'packages/web',
];

const sources = RUNTIME_PACKAGES.flatMap((dir) => productionSources(dir));

suite('there is exactly one kill site (AC1, EPIC-08-S26 scenario 4)', () => {
  it('scans the whole runtime tree, so an empty result would mean something', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.map((file) => file.path)).toContain(KILL_SEAM);
  });

  it('no runtime source outside killTree signals a process', () => {
    expect(render(checkOneKillSite(sources))).toBe('');
  });

  it('and that is a real result: the seam itself trips the guard when it is not the seam', () => {
    // The guard finds `process.kill` when it is told the seam is somewhere
    // else. Without this, a guard that had stopped matching anything at all
    // would pass the suite above for ever.
    const violations = checkOneKillSite(sources, 'packages/adapters/src/nowhere.ts');
    expect(violations.map((one) => one.where.split(':')[0])).toEqual([KILL_SEAM]);
  });

  it('objects to the tidier-looking spellings that do not kill a tree', () => {
    const tempting = [
      "child.kill('SIGTERM');",
      'subprocess.kill();',
      "agentProcess.kill('SIGKILL');",
      "nodeProcess.kill(pid, 'SIGTERM');",
    ];
    for (const line of tempting) {
      expect(
        checkOneKillSite([{ path: 'packages/daemon/src/made-up.ts', text: line }]),
        `${line} should have been refused`,
      ).toHaveLength(1);
    }
  });
});

suite('the POSIX branch negates the pid exactly once (EPIC-08-S28 scenario 3)', () => {
  const seam = readText(KILL_SEAM);
  const code = seam
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');

  it('sends the negated pid, and never the bare one', () => {
    expect(code.match(/\bkill\s*\(\s*-/g)).toHaveLength(1);
    // The positive form is the whole bug. It must not appear as a call at all.
    expect(code).not.toMatch(/\bkill\s*\(\s*pid\s*,/);
  });

  it('states why, where the next reader will be standing', () => {
    expect(seam).toMatch(/negat/i);
  });
});

suite("execa's three misnamed options are unused (AC8)", () => {
  it('no runtime source reaches for forceKillAfterDelay, killDescendants or cleanup', () => {
    expect(render(checkNoExecaKillOptions(sources))).toBe('');
  });

  it('and that guard is not vacuous', () => {
    const violations = checkNoExecaKillOptions([
      {
        path: 'packages/daemon/src/made-up.ts',
        text: [
          "import { execa } from 'execa';",
          "await execa('x', [], {",
          '  forceKillAfterDelay: 2000,',
          '  cleanup: true,',
          '});',
        ].join('\n'),
      },
    ]);
    expect(violations).toHaveLength(2);
  });

  it('execa itself stays confined to the git chokepoint', () => {
    const importers = sources
      .filter((file) => /from\s*['"]execa['"]/.test(file.text))
      .map((file) => file.path);
    // Agent processes use raw node:child_process precisely because these three
    // options do not do what their names say for a detached group.
    expect(importers).toEqual(['packages/daemon/src/git/run-git.ts']);
  });
});
