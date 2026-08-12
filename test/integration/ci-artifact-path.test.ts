/**
 * KAR-01.6 — the one part of the CI workflow that a static read cannot check:
 * does the artefact path actually match the directories the fixtures create?
 *
 * This is the failure EPIC-01-S24 is about, and it is invisible until the day
 * you need it. `actions/upload-artifact` treats "no files matched the path" as
 * a warning, not an error, so a job that fails on macOS uploads nothing, stays
 * red for the right reason, and hands you no evidence — which is precisely the
 * state the artefact exists to prevent. The trap is concrete:
 * `os.tmpdir()` is `/tmp` on the Linux runners and `/var/folders/…/T` on the
 * macOS ones, so the strategy document's `path: /tmp/DeFlow-*` would quietly
 * match nothing on exactly the two legs whose failures you cannot reproduce.
 *
 * So the workflow pins `TMPDIR` to `${{ runner.temp }}` and uploads from there,
 * and this spec runs the real fixture under that environment and globs the real
 * path the workflow declares.
 *
 * The pin lives on the vitest *step*, not on the job: `runner.*` is not a
 * context a job header may name, and a job-level `env:` that uses it makes
 * GitHub reject the file outright — see checkJobLevelContexts.
 *
 * Verifies: EPIC-01-S24 (scenarios 2 and 3) · AC10; test plan #9
 */
import { globSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { makeCleanRoom } from '../../packages/cli/scripts/verify-install/lib.ts';
import { makeTempDir } from '../../packages/testkit/src/tmp.ts';
import { type CiWorkflow, RUNNER_TEMP_EXPRESSION } from '../support/guards.ts';
import { readYaml } from '../support/workspace.ts';

const workflow = readYaml<CiWorkflow>('.github/workflows/ci.yml');
const testJob = workflow.jobs?.test;

/** What GitHub would substitute for `${{ runner.temp }}` on the runner. */
let runnerTemp: string;
let previousTmpdir: string | undefined;

beforeEach(() => {
  runnerTemp = mkdtempSync(join(tmpdir(), 'DeFlow-runner-temp-'));
  previousTmpdir = process.env.TMPDIR;
  // node:os reads TMPDIR on every call, so this is what the fixture sees.
  process.env.TMPDIR = runnerTemp;
});

afterEach(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  if (process.env.DeFlow_KEEP_TMP === undefined) {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

const expand = (value: string): string => value.replaceAll(RUNNER_TEMP_EXPRESSION, runnerTemp);

suite('the uploaded path matches what the fixtures actually create', () => {
  it('the vitest step points TMPDIR at the runner temp directory', () => {
    const vitestStep = (testJob?.steps ?? []).find((step) =>
      step.run?.startsWith('pnpm vitest run'),
    );
    expect(vitestStep?.env?.TMPDIR).toBe(RUNNER_TEMP_EXPRESSION);
  });

  it('globbing the declared artefact path finds the directory makeTempDir() made', async () => {
    const uploadStep = (testJob?.steps ?? []).find((step) =>
      step.uses?.includes('upload-artifact'),
    );
    const declaredPath = uploadStep?.with?.path;
    expect(declaredPath, 'the upload step must declare a path').toBeDefined();

    const created = await makeTempDir();
    expect(created.startsWith(runnerTemp)).toBe(true);

    const matched = globSync(expand(declaredPath ?? ''));

    expect(
      matched,
      `The workflow uploads "${declaredPath}", which does not match "${created}" — the directory ` +
        'the shared tmpdir fixture creates on this platform. upload-artifact treats an empty ' +
        'match as a warning, so the failing leg would stay red and hand you nothing to look at.',
    ).toContain(created);
  });
});

suite(
  'the verify-install job uploads the clean room the verifier actually makes (KAR-18.6 AC7)',
  () => {
    // The same class of failure as above, against a different directory: the
    // release gate's clean room is made by `makeCleanRoom()` rather than by the
    // shared tmpdir fixture, and nothing but this assertion keeps the two
    // prefixes in step. A verify-install leg that fails on the platform you do
    // not own, having uploaded nothing, is the one failure this job exists to be
    // diagnosable from.
    const verifyJob = workflow.jobs?.['verify-install'];

    it('the verify:install step points TMPDIR at the runner temp directory', () => {
      const step = (verifyJob?.steps ?? []).find((entry) => entry.run === 'pnpm verify:install');
      expect(step?.env?.TMPDIR).toBe(RUNNER_TEMP_EXPRESSION);
    });

    it('globbing the declared artefact path finds the room makeCleanRoom() made', async () => {
      const uploadStep = (verifyJob?.steps ?? []).find((step) =>
        step.uses?.includes('upload-artifact'),
      );
      const declaredPath = uploadStep?.with?.path;
      expect(declaredPath, 'the upload step must declare a path').toBeDefined();

      const install = await makeCleanRoom();
      expect(install.room.startsWith(runnerTemp)).toBe(true);

      const matched = globSync(expand(declaredPath ?? ''));

      expect(
        matched,
        `The verify-install job uploads "${declaredPath}", which does not match "${install.room}" — ` +
          'the clean room the release gate creates on this platform.',
      ).toContain(install.room);
    });
  },
);
