/**
 * `pnpm test` must leave the working tree exactly as it found it.
 *
 * Six consecutive epic gates opened with a `git restore` of the same two
 * tracked files. `fixtures/capabilities/claude-agent-acp@0.64.1.json` had its
 * `probedAt` restamped from the wall clock by the S1 replay, which is not a
 * probe and has nothing new to say about when the agent was probed.
 * `spikes/s3-elk-worker/measurements/browser-layout.json` was rewritten by the
 * S3 browser spike with a fresh duration, a fresh tick count, and a worker URL
 * carrying whatever ephemeral port the static server happened to bind. Both
 * artefacts are still produced on every run — they are the evidence those
 * spikes exist to leave behind — but they are produced into a temporary
 * directory and compared against the committed copy.
 *
 * A guard that shelled out to the whole suite from inside the suite would be
 * theatre, so this one drives each of the two writers for real and asserts
 * where the bytes landed: outside the working tree, with the committed file
 * byte-identical across the call. The opposite direction is asserted too — an
 * explicit, documented opt-in must still refresh the goldens — so the guard
 * cannot be satisfied by taking the ability to record away.
 *
 * Deliberately *not* `git status --porcelain` over the whole tree: that says
 * nothing about who wrote what, it cannot run before the writer it is judging,
 * and it would fail on anyone who had just re-recorded a golden on purpose and
 * not committed it yet. Before-and-after around the real call is the assertion
 * that means what it says.
 *
 * Verifies: repository hygiene. No story owns this; the churn it prevents is
 * the six gates' worth of manual `git restore` that motivated it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { COMMITTED_FIXTURE_DIR, fixtureDirFor } from '../../spikes/s1-acp/src/paths.ts';
import type { RunReport } from '../../spikes/s1-acp/src/report.ts';
import {
  MEASUREMENTS_DIR,
  measurementsOutDir,
  RECORD_MEASUREMENTS_ENV,
  writeMeasurement,
} from '../../spikes/s3-elk-worker/src/harness.ts';
import { repoRoot } from '../support/workspace.ts';

/** The two files the suite used to rewrite, repo-relative. */
const CHURNED = [
  'fixtures/capabilities/claude-agent-acp@0.64.1.json',
  'spikes/s3-elk-worker/measurements/browser-layout.json',
] as const;

/** True when `candidate` lands anywhere inside the working tree. */
function insideWorkingTree(candidate: string): boolean {
  const path = relative(repoRoot, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

const committedBytes = (repoRelativePath: string): string =>
  readFileSync(join(repoRoot, repoRelativePath), 'utf8');

suite('the files this guard is about are tracked', () => {
  it.each(CHURNED)('%s is in the index, so rewriting it dirties a clean checkout', (path) => {
    // `git ls-files` prints nothing for an untracked path rather than failing,
    // so the assertion is on the output and not on the exit code. Untracking
    // these files, or adding them to .gitignore, would hide the churn instead
    // of fixing it — and would fail here.
    expect(git('ls-files', '--', path).trim()).toBe(path);
  });
});

suite('the S1 replay generates its capability fixture outside the working tree', () => {
  it('writes to a temporary directory and leaves the committed fixture untouched', () => {
    const before = committedBytes(CHURNED[0]);

    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'spikes/s1-acp/run.ts'), '--agent', 'claude-agent-acp', '--replay', '--json'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    const report = JSON.parse(run.stdout) as RunReport;

    // The fixture is still generated — that is what makes it a generated
    // artefact rather than a hand-written constant (A0-9).
    expect(report.fixturePath).not.toBeNull();
    const written = report.fixturePath ?? '';
    expect(readFileSync(written, 'utf8').length).toBeGreaterThan(0);
    expect(insideWorkingTree(written), `${written} is inside ${repoRoot}`).toBe(false);
    expect(committedBytes(CHURNED[0])).toBe(before);
  });

  it('still writes into the committed directory for a live vendor probe, the only run that knows when it probed', () => {
    expect(fixtureDirFor('live', 'vendor')).toBe(COMMITTED_FIXTURE_DIR);
    expect(insideWorkingTree(COMMITTED_FIXTURE_DIR)).toBe(true);
    // And no other combination does — a fake agent exists to contradict the
    // snapshot, so it must never land on a real vendor's fixture.
    for (const [mode, kind] of [
      ['replay', 'vendor'],
      ['live', 'fake'],
      ['replay', 'fake'],
    ] as const) {
      expect(insideWorkingTree(fixtureDirFor(mode, kind)), `${mode}/${kind}`).toBe(false);
    }
  });
});

suite('the S3 browser spike records its measurement outside the working tree', () => {
  it('writes to a temporary directory and leaves the committed measurement untouched', () => {
    const before = committedBytes(CHURNED[1]);

    // The real writer the e2e spec calls, with the ambient environment of an
    // ordinary `pnpm test`, carrying the shape it really records.
    const written = writeMeasurement('browser-layout.json', {
      nodes: 60,
      durationMs: 1,
      heartbeatTicks: 5,
      workerAsset: '/assets/probe.js',
    });

    expect(insideWorkingTree(written), `${written} is inside ${repoRoot}`).toBe(false);
    expect(JSON.parse(readFileSync(written, 'utf8'))).toMatchObject({ nodes: 60 });
    expect(committedBytes(CHURNED[1])).toBe(before);
  });

  it('still rewrites the committed measurement under the documented opt-in', () => {
    expect(measurementsOutDir({ [RECORD_MEASUREMENTS_ENV]: '1' })).toBe(MEASUREMENTS_DIR);
    expect(insideWorkingTree(MEASUREMENTS_DIR)).toBe(true);
  });
});
