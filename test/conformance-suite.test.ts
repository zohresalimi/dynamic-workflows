/**
 * KAR-05.7 AC8 — the two things in this story that must **never** run
 * automatically, asserted rather than commented.
 *
 * `pnpm test:record` drives a real, authenticated vendor CLI, and the `@live`
 * parameterisation of the conformance battery runs the eight assertions
 * against one. Both cost real quota against the developer's own subscription,
 * both need credentials CI does not have, and both are nondeterministic by
 * construction: the same prompt to the same model is different tokens on a
 * different day.
 *
 * A comment saying so decays the first time somebody adds a step. These are
 * the assertions that do not.
 *
 * Verifies: EPIC-05-S26 (scenario 3), EPIC-05-S28 · AC4, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { readJson, readSources, workflowFiles } from './support/workspace.ts';

const RECORD_SCRIPT = 'packages/adapters/scripts/record-goldens.ts';
const scripts = readJson('package.json').scripts ?? {};
const workflows = readSources(workflowFiles());

suite('AC8 — pnpm test:record exists, and is a manual tool', () => {
  it('is wired to the capture script rather than to a vitest project', () => {
    // Deliberately not `vitest run --project <something>`: a project is
    // something a `vitest run` with no arguments picks up, and a capture that
    // could be started by a bare `pnpm test` is one stray command away from
    // spending somebody's quota.
    expect(scripts['test:record']).toBe(`node ${RECORD_SCRIPT}`);
  });

  it('is not any other test script in disguise', () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'test:record') continue;
      expect(command, `${name} must not run the recorder`).not.toContain('record-goldens');
    }
  });

  it('refuses CI in its own source, at the top of main()', () => {
    const source = readSources([RECORD_SCRIPT])[0]?.text ?? '';
    expect(source).toContain('process.env.CI !== undefined');
    expect(source).toContain('refuses to run in CI');
  });
});

suite('AC4, AC8 — no workflow reaches for any of it', () => {
  const forbidden = [
    'test:record',
    'record-goldens',
    'DeFlow_RECORD',
    'DeFlow_LIVE',
    '@live',
  ] as const;

  it.each(forbidden)('no workflow file mentions %s', (needle) => {
    for (const workflow of workflows) {
      expect(workflow.text, `${workflow.path} mentions ${needle}`).not.toContain(needle);
    }
  });

  it('has workflows to scan, so the assertion above is not vacuous', () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.some((workflow) => workflow.text.includes('pnpm vitest run'))).toBe(true);
  });

  it('never selects a test name, which is the only way -t "@live" could be reached', () => {
    for (const workflow of workflows) {
      expect(workflow.text, workflow.path).not.toMatch(/vitest run[^\n]*\s-t\s/);
    }
  });
});

suite('AC8 — and it is documented as manual where a contributor reads', () => {
  it('docs/CONTRIBUTING.md explains what test:record costs', () => {
    const contributing = readSources(['docs/CONTRIBUTING.md'])[0]?.text ?? '';
    expect(contributing).toContain('pnpm test:record');
    expect(contributing).toContain('never');
  });
});
