/**
 * KAR-07.5 test 6 — the hard rule, asserted over the plan
 * (docs/09-workspace-and-safety.md §5.1: "never symlink a shared
 * `node_modules` across worktrees"; EPIC-07-S20).
 *
 * Two agents running installs concurrently against one shared tree corrupts
 * it, and a shared tree defeats the isolation the worktree exists to provide.
 * The one safe shared target is the *store*, which pnpm manages itself and
 * DeFlow never links by hand.
 *
 * The assertion is made over a **plan** rather than by grepping for `symlink(`
 * because the tempting future optimisation is not a rogue call — it is someone
 * adding a legitimate-looking link step to make the third worktree install
 * instantly. So the plan type can express a symlink, the guard rejects the one
 * target that must never appear, and the guard runs in production before any
 * step is executed rather than only in this file.
 *
 * Verifies: EPIC-07-S20 · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  assertNoSharedNodeModules,
  planWorktreeProvision,
  SharedNodeModulesRefused,
} from './provision-plan.ts';

const REPO = '/repo';
const wt = (n: number): string => `/repo/.DeFlow/wt/run__n${n}`;

const planFor = (n: number) =>
  planWorktreeProvision({
    repoRoot: REPO,
    worktreePath: wt(n),
    includes: [
      { path: '.env', mode: 0o600 },
      { path: 'config/local.json', mode: 0o644 },
    ],
    setupCommand: 'pnpm install --frozen-lockfile',
    reflinkSupported: true,
    hasSourceNodeModules: true,
  });

suite('the provisioning plan for three worktrees creates no shared node_modules (AC6)', () => {
  const plans = [1, 2, 3].map((n) => planFor(n));

  it('contains no symlink step at all — the store is pnpm’s to manage, not DeFlow’s', () => {
    const symlinks = plans.flatMap((plan) => plan.filter((step) => step.kind === 'symlink'));

    expect(symlinks).toEqual([]);
  });

  it('passes the guard, for every worktree', () => {
    for (const plan of plans) expect(() => assertNoSharedNodeModules(plan)).not.toThrow();
  });

  it('gives each worktree its own copy destination — nothing is written twice', () => {
    const destinations = plans.flatMap((plan) =>
      plan.filter((step) => step.kind === 'copy').map((step) => step.to),
    );

    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it('plans the copies, the reflink clone and the install, in that order', () => {
    expect(planFor(1).map((step) => step.kind)).toEqual(['copy', 'copy', 'clone', 'run']);
  });

  it('plans no clone when the filesystem probe failed, and no error with it', () => {
    const plan = planWorktreeProvision({
      repoRoot: REPO,
      worktreePath: wt(1),
      includes: [],
      setupCommand: 'npm ci',
      reflinkSupported: false,
      hasSourceNodeModules: true,
    });

    expect(plan.map((step) => step.kind)).toEqual(['run']);
  });

  it('plans no clone when the main checkout has no node_modules to clone', () => {
    const plan = planWorktreeProvision({
      repoRoot: REPO,
      worktreePath: wt(1),
      includes: [],
      setupCommand: 'npm ci',
      reflinkSupported: true,
      hasSourceNodeModules: false,
    });

    expect(plan.map((step) => step.kind)).toEqual(['run']);
  });

  it('plans no run step when nothing declared one', () => {
    const plan = planWorktreeProvision({
      repoRoot: REPO,
      worktreePath: wt(1),
      includes: [],
      setupCommand: null,
      reflinkSupported: false,
      hasSourceNodeModules: false,
    });

    expect(plan).toEqual([]);
  });
});

suite('the guard is not vacuous', () => {
  it('refuses a symlink whose target is a node_modules directory', () => {
    expect(() =>
      assertNoSharedNodeModules([
        { kind: 'symlink', from: `${REPO}/node_modules`, to: `${wt(2)}/node_modules` },
      ]),
    ).toThrow(SharedNodeModulesRefused);
  });

  it('refuses it however the target is spelled', () => {
    const spellings = [
      `${REPO}/node_modules/`,
      `${REPO}/./node_modules`,
      `${REPO}/packages/web/node_modules`,
      `${REPO}/node_modules/.pnpm`,
    ];

    for (const from of spellings) {
      expect(
        () => assertNoSharedNodeModules([{ kind: 'symlink', from, to: `${wt(2)}/node_modules` }]),
        from,
      ).toThrow(SharedNodeModulesRefused);
    }
  });

  it('names both ends, so the message says which worktree would have been poisoned', () => {
    let thrown: SharedNodeModulesRefused | undefined;
    try {
      assertNoSharedNodeModules([
        { kind: 'symlink', from: `${REPO}/node_modules`, to: `${wt(2)}/node_modules` },
      ]);
    } catch (error) {
      thrown = error as SharedNodeModulesRefused;
    }

    expect(thrown?.from).toBe(`${REPO}/node_modules`);
    expect(thrown?.to).toBe(`${wt(2)}/node_modules`);
  });

  it('allows a symlink to the package manager store, which is the one safe shared target', () => {
    expect(() =>
      assertNoSharedNodeModules([
        { kind: 'symlink', from: '/home/u/.local/share/pnpm/store/v3', to: `${wt(2)}/.pnpm-store` },
      ]),
    ).not.toThrow();
  });

  it('allows a copy of node_modules — a real directory per worktree is the point', () => {
    expect(() =>
      assertNoSharedNodeModules([
        { kind: 'clone', from: `${REPO}/node_modules`, to: `${wt(2)}/node_modules` },
      ]),
    ).not.toThrow();
  });
});
