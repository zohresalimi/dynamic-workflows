/**
 * KAR-01.4 — the testing rules that only a guard can hold.
 *
 * Each of these is a rule the strategy states and that nothing else enforces:
 * a `defineWorkspace` config is silently ignored rather than rejected, a fake
 * timer around a live child process deadlocks only in CI, an in-memory database
 * in a durability test passes while testing nothing, and an unhermetic `git`
 * fixture reads the developer's own ~/.gitconfig.
 *
 * The guards themselves are exercised against violating fixtures in
 * ./guards.test.ts; this file is the half that points them at the real tree.
 *
 * Verifies: EPIC-01-S15 (guard), EPIC-01-S16 (guard), EPIC-01-S18,
 * EPIC-01-S19 (guard) · AC1, AC5, AC9, AC10
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkGitInvocationsAreHermetic,
  checkNoFakeTimers,
  checkNoInMemoryDatabases,
  checkNoUnsupportedGitLibrary,
  checkNoVitestWorkspace,
  FAKE_TIMER_ALLOWLIST,
  describe as render,
} from './support/guards.ts';
import { allManifests, readSources, repoTypeScriptFiles } from './support/workspace.ts';

const files = repoTypeScriptFiles();
const sources = readSources(files);

suite('Vitest 4 removed the workspace file (AC1, EPIC-01-S18)', () => {
  it('no source imports or calls the removed builder', () => {
    expect(render(checkNoVitestWorkspace(sources))).toBe('');
  });

  it('no file in the tree is named vitest.workspace.*', () => {
    expect(files.filter((path) => /(^|\/)vitest\.workspace\.[cm]?ts$/.test(path))).toEqual([]);
  });
});

suite('fake timers are allowlisted and scoped (AC9, EPIC-01-S16)', () => {
  it('no file fakes timers outside the allowlist', () => {
    expect(render(checkNoFakeTimers(sources, FAKE_TIMER_ALLOWLIST))).toBe('');
  });

  it('starts with an empty allowlist, so every entry is a deliberate decision', () => {
    expect(FAKE_TIMER_ALLOWLIST).toEqual([]);
  });
});

suite('durability tests are file-backed (AC10, EPIC-01-S19)', () => {
  it('no integration spec opens an in-memory database', () => {
    expect(render(checkNoInMemoryDatabases(sources))).toBe('');
  });
});

suite('git is real, hermetic, and never a library (AC5, EPIC-01-S15)', () => {
  const testkit = sources.filter((file) => file.path.startsWith('packages/testkit/'));

  it('every git invocation in the testkit passes the isolated environment', () => {
    expect(testkit.length).toBeGreaterThan(0);
    expect(render(checkGitInvocationsAreHermetic(testkit))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    // A guard that matched nothing would pass this suite for ever. Take the
    // hermetic environment away from the real source and the guard must object,
    // which is only possible if it found the invocation in the first place.
    const mutated = testkit.map((file) => ({
      ...file,
      text: file.text.replaceAll('GIT_ENV', 'AMBIENT_ENV'),
    }));
    expect(checkGitInvocationsAreHermetic(mutated).length).toBeGreaterThan(0);
  });

  it('no package depends on isomorphic-git or simple-git', () => {
    expect(render(checkNoUnsupportedGitLibrary(allManifests()))).toBe('');
  });
});
