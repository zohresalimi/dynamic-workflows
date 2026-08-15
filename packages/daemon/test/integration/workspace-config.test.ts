/**
 * KAR-09.4 AC4/AC5 — `.DeFlow/config.yaml`, read off a real disk.
 *
 * A real file in a real directory rather than a string handed to a parser: the
 * two things that break here are an absent file and a file in the wrong place,
 * and neither is reachable from a fixture in memory. The doctor report is
 * rendered from what that file plus the run's spec really produced, which is
 * what EPIC-09-S22's third scenario means by *"runs against a workspace"*.
 *
 * Verifies: EPIC-09-S22 (third scenario), EPIC-09-S23 (background) · AC4, AC5
 */
import {
  PIN_REINJECT_TURNS_DEFAULT,
  pinReinjectTurnsFor,
  type TaskSpec,
  TaskSpecSchema,
} from '@DeFlow/core';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CONFIG_RELATIVE_PATH, loadWorkspaceConfig } from '../../src/config/workspace-config.ts';
import { workspaceConstraintReport } from '../../src/constraints/doctor.ts';

let cwd = '';

beforeEach(async () => {
  cwd = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(cwd);
});

async function writeConfig(yaml: string): Promise<void> {
  await mkdir(join(cwd, '.DeFlow'), { recursive: true });
  await writeFile(join(cwd, CONFIG_RELATIVE_PATH), yaml, 'utf8');
}

const spec = (constraints: readonly string[]): TaskSpec =>
  TaskSpecSchema.parse({
    schemaId: 'DeFlow.taskspec.v1',
    goal: 'Migrate the checkout module to Vue 3.',
    scope: { included: ['src/checkout/**'] },
    nonGoals: [],
    constraints: [...constraints],
    priorDecisions: [],
    acceptanceCriteria: [{ id: 'c1', statement: 'the checkout tests pass', coveredByGates: [] }],
    knownFailureModes: [],
    approvedBy: { at: '2026-08-06T09:00:00Z', via: 'ui' },
    specHash: `sha256-${'0'.repeat(64)}`,
  });

suite('pinReinjectTurns per provider (AC5)', () => {
  it('reads the interval each provider was configured with', async () => {
    await writeConfig(
      [
        'providers:',
        '  claude:',
        '    pinReinjectTurns: 8',
        '  codex:',
        '    pinReinjectTurns: 5',
        '',
      ].join('\n'),
    );

    const config = loadWorkspaceConfig(cwd);

    expect(pinReinjectTurnsFor(config, 'claude')).toBe(8);
    expect(pinReinjectTurnsFor(config, 'codex')).toBe(5);
  });

  it('defaults to 8 in a workspace that has no config file at all', () => {
    const config = loadWorkspaceConfig(cwd);

    expect(pinReinjectTurnsFor(config, 'claude')).toBe(PIN_REINJECT_TURNS_DEFAULT);
  });

  it('refuses a malformed interval by naming the file, never by silently defaulting', async () => {
    await writeConfig(['providers:', '  claude:', '    pinReinjectTurns: nope', ''].join('\n'));

    expect(() => loadWorkspaceConfig(cwd)).toThrow(/config\.yaml/);
  });
});

suite('deflow doctor over a real workspace (EPIC-09-S22 third scenario)', () => {
  it('reports the forbid-to-allow-only ratio for the loaded spec', async () => {
    // Six prohibitions with no closed positive form, two positive scopes.
    await writeConfig(
      [
        'constraints:',
        "  - { form: allow-only, subject: write-path, allowed: ['src/checkout/**'] }",
        "  - { form: allow-only, subject: branch, allowed: ['DeFlow/r1__implement'] }",
        "  - { form: forbid, subject: exfiltrate credentials, forbidden: ['.env'] }",
        "  - { form: forbid, subject: reach the network, forbidden: ['https://*'] }",
        "  - { form: forbid, subject: print secrets to the log, forbidden: ['STRIPE_KEY'] }",
        "  - { form: forbid, subject: rewrite pushed history, forbidden: ['--force'] }",
        "  - { form: forbid, subject: delete tests, forbidden: ['*.test.ts'] }",
        "  - { form: forbid, subject: patch node_modules, forbidden: ['node_modules/**'] }",
        '',
      ].join('\n'),
    );

    const report = workspaceConstraintReport(cwd, spec([]));

    expect(report).toContain('6 forbid');
    expect(report).toContain('2 allow-only');
    expect(report.toLowerCase()).toContain('decay');
  });

  it("counts the spec's own prose constraints as the require constraints they are", async () => {
    await writeConfig(
      [
        'constraints:',
        "  - { form: allow-only, subject: write-path, allowed: ['src/checkout/**'] }",
        '',
      ].join('\n'),
    );

    const report = workspaceConstraintReport(
      cwd,
      spec(['must not change the public API', 'must not run database migrations']),
    );

    expect(report).toContain('2 require');
  });
});
