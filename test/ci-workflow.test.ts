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
import webConfig from '../packages/web/vitest.config.ts';
import rootConfig from '../vitest.config.ts';
import {
  type CiWorkflow,
  checkCiWorkflow,
  checkJobLevelContexts,
  checkNoCorepack,
  checkRecordedCiRuntime,
  checkRunnerImagesArePinned,
  checkTempDirPrefixes,
  checkWorkflowExecutablesAreDeclared,
  checkWorkflowProjectsExist,
  EXPECTED_TEST_MATRIX,
  expandMatrixTemplate,
  PINNED_ACTIONS,
  RUNNER_TEMP_EXPRESSION,
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

/**
 * Every vitest project name the repository actually declares, read out of the
 * configs rather than listed a second time here — the whole point of the guard
 * below is that the workflow and the runner config cannot drift apart.
 */
function declaredProjects(): string[] {
  const entries = (rootConfig as { test?: { projects?: readonly unknown[] } }).test?.projects ?? [];
  const inline = entries.flatMap((entry) =>
    typeof entry === 'string' ? [] : [(entry as { test?: { name?: string } }).test?.name ?? ''],
  );
  const web = (webConfig as { test?: { name?: string } }).test?.name;
  return [...inline, ...(web === undefined ? [] : [web])].filter((name) => name !== '');
}

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

suite('every "--project" a workflow names is a project that exists (AC11, test plan #8)', () => {
  // This replaces a narrower guard that simply forbade the string
  // "--project crash-fuzz" anywhere in a workflow. That prohibition was correct
  // for exactly as long as the project was an empty slot in vitest.config.ts,
  // and it went stale the moment KAR-03.8 filled the slot — after which it was
  // no longer protecting the build, it was blocking the wiring the strategy
  // document asks for. The durable form of the same protection is the one that
  // does not need revisiting per project: whatever a workflow names, the runner
  // config must declare, or the step is a red build on every commit.
  it('the workflows name only projects vitest.config.ts declares', () => {
    expect(
      render(checkWorkflowProjectsExist(readSources(workflowFiles()), declaredProjects())),
    ).toBe('');
  });

  it('flags a step naming a project the runner config has no slot for', () => {
    const violations = checkWorkflowProjectsExist(
      [{ path: 'ci.yml', text: '      - run: pnpm vitest run --project crash-fzz\n' }],
      declaredProjects(),
    );
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('crash-fzz');
    expect(render(violations)).toContain('vitest.config.ts');
  });

  it('accepts the crash-fuzz project now that KAR-03.8 and KAR-06.9 have filled it', () => {
    expect(declaredProjects()).toContain('crash-fuzz');
    expect(
      checkWorkflowProjectsExist(
        [{ path: 'ci.yml', text: '      - run: pnpm vitest run --project crash-fuzz\n' }],
        declaredProjects(),
      ),
    ).toEqual([]);
  });
});

suite('the crash-fuzz slice is wired into the test legs (KAR-06.9 AC7)', () => {
  // KAR-03.8 filled the fifth vitest project and KAR-06.9 added the daemon
  // half, so the "not referenced yet" prohibition this suite used to carry is
  // over. What replaces it is the assertion the prohibition was standing in
  // for: the workflow names the project, on the matrix legs, so that the
  // durability suite is a thing CI runs rather than a thing the README claims.
  //
  // The `test` job is separately held back by `vars.RUN_TESTS_IN_CI` (owner's
  // decision, 2026-08-05) — that gate is deliberately not asserted here. This
  // suite holds the *wiring*: when the variable is set, crash-fuzz runs with
  // everything else, and until then nobody has to remember to come back and
  // add a step.
  const testJob = () => workflow().jobs?.test;

  it('runs "pnpm vitest run --project crash-fuzz" on every matrix leg', () => {
    const runs = (testJob()?.steps ?? []).flatMap((step) =>
      step.run === undefined ? [] : [step.run],
    );
    expect(runs).toContain('pnpm vitest run --project crash-fuzz');
  });

  it('gives every vitest step in the job the tmpdir wiring the upload step needs', () => {
    // Not just the first one. A crash-fuzz leg that fails without
    // DeFlow_KEEP_TMP leaves the ledger it died on nowhere, and a CI-only
    // durability failure with no artefacts is close to undiagnosable — which is
    // the one thing KAR-06.9's own notes say to wire from the first CI run.
    const vitestSteps = (testJob()?.steps ?? []).filter((step) =>
      step.run?.startsWith('pnpm vitest run'),
    );
    expect(vitestSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of vitestSteps) {
      expect(step.env?.DeFlow_KEEP_TMP, `step "${step.run}"`).toBe('1');
      expect(step.env?.TMPDIR, `step "${step.run}"`).toBe('${{ runner.temp }}');
    }
  });
});

suite('the install-verification job (KAR-18.6 AC6, AC7)', () => {
  // AC6 is two halves — "runnable locally with one command" and "runs in CI on
  // ubuntu-26.04 and macos-26 for every release tag … and once per milestone"
  // — and only the first shipped with the story. This suite holds the second.
  //
  // It is **not** held back behind `vars.RUN_TESTS_IN_CI` with the `test` and
  // `browser-e2e` jobs, for the reason KAR-18.5 already wrote into the `check`
  // job next to `pnpm pack:check`: a release gate nobody runs is not a gate.
  // Nor does it cost anything on an ordinary push — the job's `if` restricts it
  // to a release tag and to a manual dispatch, which is what "once per
  // milestone even without a release" is asked to be triggerable by.
  const job = () => workflow().jobs?.['verify-install'];

  it('exists, and runs the one command the story fixes as the procedure', () => {
    expect(job(), 'ci.yml declares no "verify-install" job').toBeDefined();
    expect((job()?.steps ?? []).map((step) => step.run)).toContain('pnpm verify:install');
  });

  it('runs on both platforms NF5 promises, with fail-fast off', () => {
    // ubuntu-26.04 and macos-26 — the same two images as the test matrix, and
    // for a stronger reason here: the tarball's native dependencies resolve a
    // *different prebuild* per platform, so a green Linux leg says nothing
    // about the macOS one.
    expect(job()?.strategy?.matrix?.os).toEqual([...EXPECTED_TEST_MATRIX.os]);
    expect(job()?.strategy?.['fail-fast']).toBe(false);
    expect(job()?.['runs-on']).toBe('${{ matrix.os }}');
  });

  it('is scoped to release tags and manual dispatch, and is not held back by RUN_TESTS_IN_CI', () => {
    const condition = job()?.if ?? '';
    expect(condition).toContain('refs/tags/');
    expect(condition).toContain('workflow_dispatch');
    // The gate the owner set over the test slices is deliberately not on this
    // job: it is the release gate, and a release gate behind an unset variable
    // has never run when the release happens.
    expect(condition).not.toContain('RUN_TESTS_IN_CI');
    // …and the trigger it names has to exist, or "run it once per milestone"
    // is a button that is not there.
    expect(JSON.stringify(workflow().on)).toContain('workflow_dispatch');
  });

  it('keeps the clean room and uploads it when the job fails (AC7)', () => {
    const step = (job()?.steps ?? []).find((entry) => entry.run === 'pnpm verify:install');
    // Without these two the upload below collects nothing: the verifier
    // removes its clean room, and `os.tmpdir()` is /var/folders/…/T on the
    // macOS leg rather than the /tmp a fixed path would name.
    expect(step?.env?.DeFlow_KEEP_TMP).toBe('1');
    expect(step?.env?.TMPDIR).toBe(RUNNER_TEMP_EXPRESSION);

    const upload = (job()?.steps ?? []).find((entry) => entry.uses?.includes('upload-artifact'));
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.path).toContain(RUNNER_TEMP_EXPRESSION);
    // One artefact per leg, or the leg that failed loses its evidence to the
    // one that did not.
    const names = expandMatrixTemplate(upload?.with?.name ?? '', {
      os: EXPECTED_TEST_MATRIX.os,
    });
    expect(new Set(names).size).toBe(2);
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
