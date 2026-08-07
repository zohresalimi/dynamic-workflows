/**
 * KAR-09.2 AC5 / EPIC-09-S28 third scenario — *"the demotion module has no
 * dependency on any provider or adapter type"*.
 *
 * The other two scenarios in EPIC-09-S28 are behavioural and live in
 * `../src/build-packet.test.ts`: a five-times-over-budget build completes, and
 * no `history.summary` appears under budget pressure. They prove the demotion
 * path does not summarise *today*. This one proves it cannot start: a module
 * whose every import is a sibling in `@DeFlow/core` cannot reach a provider,
 * an adapter, a socket or a subprocess, no matter who edits it later.
 *
 * Worth a structural test rather than a comment because the change that breaks
 * it is the reasonable-looking one — "the packet is 3% over, just summarise the
 * biggest tool output" is a two-line diff that passes every behavioural test in
 * the epic and quietly makes a run's context unauditable.
 *
 * Verifies: EPIC-09-S28 (third scenario) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkDemotionIsProviderFree,
  describe as render,
  type SourceFile,
} from '../../../test/support/guards.ts';
import { allWorkspaceSources } from '../../../test/support/workspace.ts';

/** Assembly, the ladder, and the pinned set the ladder must never reach. */
const DEMOTION_MODULES = [
  'packages/core/src/build-packet.ts',
  'packages/core/src/pinned-set.ts',
  'packages/core/src/render-packet.ts',
];

const sources = (): SourceFile[] => allWorkspaceSources();

suite('the demotion path cannot reach a provider (AC5)', () => {
  it('scans a workspace that really contains the modules', () => {
    const paths = sources().map((file) => file.path);
    for (const module of DEMOTION_MODULES) expect(paths).toContain(module);
  });

  it('finds no import outside @DeFlow/core in any of them', () => {
    expect(render(checkDemotionIsProviderFree(sources(), DEMOTION_MODULES))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    const mutated = sources().map((file) =>
      DEMOTION_MODULES.includes(file.path)
        ? { ...file, text: `import { spawn } from 'node:child_process';\n${file.text}` }
        : file,
    );

    expect(checkDemotionIsProviderFree(mutated, DEMOTION_MODULES).length).toBe(
      DEMOTION_MODULES.length,
    );
  });
});
