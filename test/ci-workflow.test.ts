/**
 * KAR-01.6 — `.github/workflows/ci.yml`, read as a specification.
 *
 * A CI workflow is the one piece of this repository that cannot be exercised
 * from a laptop: the thing under test is a file GitHub interprets on machines
 * you do not have. So the properties that matter are asserted statically, and
 * they are all properties whose violation is silent — an unpinned runner image
 * migrates an architecture under you without a commit, a `fail-fast: true`
 * matrix hides three legs behind one failure, and a colliding artefact name
 * loses the only evidence a platform-specific failure ever produces.
 *
 * The one property that is *not* static — that the artefact path actually
 * matches the directories the fixtures create, on this platform — is in
 * test/integration/ci-artifact-path.test.ts, because it needs a real tmpdir.
 *
 * Verifies: EPIC-01-S23, EPIC-01-S24 (scenarios 1, 2 and 4) ·
 * AC6, AC7, AC8, AC9, AC10, AC11; test plan #5, #6, #7, #8
 */
import { expect, it, describe as suite } from 'vitest';
import { TMP_PREFIX } from '../packages/testkit/src/tmp.ts';
import {
  type CiWorkflow,
  checkCiWorkflow,
  checkJobLevelContexts,
  checkNoCorepack,
  checkNoCrashFuzzProject,
  checkRecordedCiRuntime,
  checkRunnerImagesArePinned,
  checkTempDirPrefixes,
  checkWorkflowExecutablesAreDeclared,
  EXPECTED_TEST_MATRIX,
  expandMatrixTemplate,
  PINNED_ACTIONS,
  describe as render,
} from './support/guards.ts';
import {
  allManifests,
  docFiles,
  readSources,
  readYaml,
  repoTypeScriptFiles,
  workflowFiles,
} from './support/workspace.ts';

const CI = '.github/workflows/ci.yml';
const workflow = (): CiWorkflow => readYaml<CiWorkflow>(CI);

suite('the three jobs and their pinned actions (AC6, EPIC-01-S23)', () => {
  it('declares check, test and browser-e2e exactly as the design records', () => {
    expect(render(checkCiWorkflow(workflow(), CI))).toBe('');
  });

  it.each(Object.entries(PINNED_ACTIONS))('pins %s at %s', (action, tag) => {
    // Verified against the marketplace on 2026-08-04 before pinning — the
    // story's own "Unverified" item. See docs/CONTRIBUTING.md.
    expect(readSources([CI])[0]?.text).toContain(`${action}@${tag}`);
  });
});

suite('every runner image is explicit (AC7, test plan #5, EPIC-01-S24 scenario 4)', () => {
  it('no workflow uses a "-latest" image', () => {
    expect(render(checkRunnerImagesArePinned(readSources(workflowFiles())))).toBe('');
  });

  it('names the migration in the failure message, so the fix is not "pin it back and move on"', () => {
    const violations = checkRunnerImagesArePinned([
      { path: '.github/workflows/ci.yml', text: 'jobs:\n  test:\n    runs-on: macos-latest\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('macos-latest');
    expect(render(violations)).toContain('June 2026');
    expect(render(violations)).toMatch(/node-pty/);
    expect(render(violations)).toMatch(/case-sensitiv/);
  });

  it('accepts the pinned images', () => {
    expect(
      render(
        checkRunnerImagesArePinned([
          { path: 'ci.yml', text: 'runs-on: ubuntu-26.04\nruns-on: macos-26\n' },
        ]),
      ),
    ).toBe('');
  });
});

suite('every job-level expression names a context GitHub provides there (AC12)', () => {
  // The failure this guards is the worst kind the workflow has: GitHub rejects
  // the file before it schedules anything, so the run completes in seconds with
  // *zero* jobs and a conclusion of "failure". Nothing in this suite noticed —
  // every other assertion here reads the YAML, and the YAML is valid; it is the
  // expression contexts that are not. Measured on run 30913790575: the whole
  // file was uninterpretable because job-level `env:` used `runner.temp`, which
  // only exists from a step onwards. AC12 asks for a *green* run's wall clock,
  // and a workflow that cannot start can never produce one.
  it('no job-level env, runs-on or if uses a step-only context', () => {
    expect(render(checkJobLevelContexts(workflow(), CI))).toBe('');
  });
});

suite('corepack appears nowhere (AC8, test plan #6)', () => {
  // KAR-01.2's guard covered the workflows and CONTRIBUTING.md. AC8 widens it
  // to the whole of docs/: a setup document that says "corepack enable" misleads
  // a colleague on Node 26 exactly as badly as a workflow step does.
  it('neither the workflows nor any document under docs/ runs "corepack enable"', () => {
    expect(render(checkNoCorepack(readSources([...workflowFiles(), ...docFiles()])))).toBe('');
  });
});

suite('crash-fuzz is not referenced yet (AC11, test plan #8, EPIC-01-S23 last scenario)', () => {
  it('no workflow runs "--project crash-fuzz"', () => {
    expect(render(checkNoCrashFuzzProject(readSources(workflowFiles())))).toBe('');
  });

  it('flags the example step the strategy document itself shows', () => {
    const violations = checkNoCrashFuzzProject([
      { path: 'ci.yml', text: '      - run: pnpm vitest run --project crash-fuzz\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('EPIC-03');
  });
});

suite('the matrix (AC9, test plan #7, EPIC-01-S24 scenario 1)', () => {
  it('is exactly the four legs, with fail-fast off', () => {
    const test = workflow().jobs?.test;
    expect(test?.strategy?.['fail-fast']).toBe(false);
    expect(test?.strategy?.matrix?.os).toEqual([...EXPECTED_TEST_MATRIX.os]);
    expect(test?.strategy?.matrix?.node).toEqual([...EXPECTED_TEST_MATRIX.node]);
  });

  it('lists no Node 22 anywhere (EPIC-01-S23, "Node 22 is nowhere")', () => {
    expect(JSON.stringify(workflow().jobs?.test?.strategy?.matrix)).not.toContain('22');
  });
});

suite('the artefact name is per matrix cell (AC10, EPIC-01-S24 scenario 2)', () => {
  const uploadStep = () =>
    (workflow().jobs?.test?.steps ?? []).find((step) => step.uses?.includes('upload-artifact'));

  it('uploads only on failure', () => {
    expect(uploadStep()?.if).toBe('failure()');
  });

  it('expands to four distinct names, so one leg cannot overwrite another', () => {
    const template = uploadStep()?.with?.name;
    expect(template).toBe('tmp-${{ matrix.os }}-${{ matrix.node }}');
    const names = expandMatrixTemplate(template ?? '', EXPECTED_TEST_MATRIX);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names).toContain('tmp-macos-26-26');
  });

  it('sets DeFlow_KEEP_TMP, or there is nothing left on disk to upload', () => {
    expect(JSON.stringify(workflow().jobs?.test)).toContain('DeFlow_KEEP_TMP');
  });

  // The artefact glob is only worth as much as the directories it matches, and
  // it is case-sensitive on the Linux legs. A spec that names its tmpdir
  // anything else is a spec whose failure uploads nothing — silently, because
  // upload-artifact warns rather than fails on an empty match.
  it('every temp directory in the repo carries the prefix the glob looks for', () => {
    // ./guards.test.ts is excluded because it is, by construction, a file full
    // of violating fixtures — every guard in this repo needs one input that
    // breaks the rule, and they live there.
    const targets = repoTypeScriptFiles().filter((path) => path !== 'test/guards.test.ts');
    expect(render(checkTempDirPrefixes(readSources(targets), TMP_PREFIX))).toBe('');
  });
});

suite('every "pnpm exec" in the workflow resolves on a clean checkout (AC12)', () => {
  // This one is invisible on the machine that wrote it. `node_modules/.bin` at
  // the workspace root accumulates shims from every package that was ever
  // installed there, so `pnpm exec playwright` runs locally long after
  // playwright stopped being a root dependency — and then fails on the first
  // clean `--frozen-lockfile` install with "Command not found". Measured: run
  // 30914294996, browser-e2e, nineteen seconds in.
  it('names a binary the package it runs in actually declares', () => {
    expect(render(checkWorkflowExecutablesAreDeclared(workflow(), CI, allManifests()))).toBe('');
  });
});

suite('the measured CI wall clock is on the record (AC12)', () => {
  // AC12 has two halves, and the second one is the one that rots. The number
  // cannot come from a laptop — it is GitHub-hosted runner wall clock — so the
  // only place it can live is the measurements table, and nothing but this
  // assertion stops that row from sliding back to "not yet measured" or from
  // recording a figure that quietly went over budget. It fails if the row is a
  // placeholder, if it cites no run, or if the number it cites exceeds ten
  // minutes.
  it('records a green run, identified, inside the ten-minute budget', () => {
    expect(
      render(checkRecordedCiRuntime(readSources(['docs/CONTRIBUTING.md'])[0]?.text ?? '')),
    ).toBe('');
  });
});
