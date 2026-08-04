/**
 * KAR-01.6 — the pre-commit/pre-push contract as `lefthook.yml` declares it.
 *
 * The hook's real behaviour — a floating promise actually rejecting a commit, a
 * misformatted file actually being rewritten and re-staged, the two-second
 * budget actually holding — is exercised against a real git repository and the
 * real lefthook binary in `test/integration/git-hooks.test.ts`. This file is
 * only about what the configuration says, because two of the acceptance
 * criteria are statements about the file rather than about a run: the lint job
 * must never grow `--type-aware`, and `.vue` may only be auto-staged once
 * KAR-00.6's note says it is safe to.
 *
 * Verifies: EPIC-01-S20 (last scenario), EPIC-01-S21 (scenarios 3 and 4) ·
 * AC1, AC2, AC5; test plan #4
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkLefthookConfig,
  checkPrepareInstallsHooks,
  type LefthookConfig,
  readVueStageFixedVerdict,
  describe as render,
  VUE_SPIKE_NOTE,
} from './support/guards.ts';
import { exists, readJson, readText, readYaml } from './support/workspace.ts';

const config = (): LefthookConfig => readYaml<LefthookConfig>('lefthook.yml');
const verdict = () =>
  readVueStageFixedVerdict(exists(VUE_SPIKE_NOTE) ? readText(VUE_SPIKE_NOTE) : undefined);

suite('lefthook.yml (AC1, AC2)', () => {
  it('declares the pre-commit and pre-push split the budget depends on', () => {
    expect(
      render(checkLefthookConfig(config(), { text: readText('lefthook.yml'), verdict: verdict() })),
    ).toBe('');
  });

  it('runs the pre-commit jobs in parallel (EPIC-01-S21 scenario 3)', () => {
    expect(config()['pre-commit']?.parallel).toBe(true);
  });

  it('keeps --type-aware out of the pre-commit lint job (test plan #4)', () => {
    const lint = config()['pre-commit']?.jobs?.find((job) => job.name === 'lint');
    expect(lint?.run).toContain('oxlint');
    expect(lint?.run).not.toContain('--type-aware');
  });

  it('carries typecheck and the unit slice on pre-push instead (EPIC-01-S21 scenario 4)', () => {
    const jobs = config()['pre-push']?.jobs ?? [];
    expect(jobs.find((job) => job.name === 'typecheck')?.run).toContain('pnpm typecheck');
    expect(jobs.find((job) => job.name === 'unit')?.run).toContain(
      'pnpm vitest run --project unit',
    );
  });

  it('carries the type-aware pass on pre-push too, since pre-commit refuses it (AC4)', () => {
    // All six of the correctness rules .oxlintrc.json turns on are type-aware,
    // so the pre-commit lint job cannot see any of them — measured, not
    // assumed, in test/integration/git-hooks.test.ts. Pre-push is then the last
    // point before a branch at which a floating promise costs a re-edit rather
    // than a red build.
    const jobs = config()['pre-push']?.jobs ?? [];
    expect(jobs.find((job) => job.name === 'lint')?.run).toContain('pnpm lint');
  });
});

suite('the .vue opt-in is gated on KAR-00.6 rather than assumed (AC2)', () => {
  // The conditional is the acceptance criterion: `stage_fixed: true` may reach
  // .vue only if the spike note gives a "safe" verdict. Encoding it as a test
  // means the day the note lands, the hook either changes or this fails —
  // instead of the gate quietly staying shut, or quietly being forced open.
  it('the note either says "safe" and .vue is formatted, or .vue is excluded with a reason', () => {
    const formatGlob =
      config()['pre-commit']?.jobs?.find((job) => job.name === 'format')?.glob ?? '';
    if (verdict() === 'safe') {
      expect(formatGlob).toContain('vue');
    } else {
      expect(formatGlob).not.toContain('vue');
      expect(readText('lefthook.yml')).toContain(VUE_SPIKE_NOTE);
    }
  });
});

suite('hooks exist after a fresh clone (AC5, EPIC-01-S1 background)', () => {
  it('"prepare" runs lefthook install and lefthook comes from the catalog', () => {
    expect(render(checkPrepareInstallsHooks(readJson('package.json')))).toBe('');
  });
});
