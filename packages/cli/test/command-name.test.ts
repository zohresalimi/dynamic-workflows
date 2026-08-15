/**
 * KAR-20.1 — the half of the rename a `grep` cannot see.
 *
 * `test/command-name.test.ts` scans the repository's text and would catch every
 * literal. What it cannot catch is a sentence **assembled at runtime** from a
 * constant, and EPIC-20-S7's second scenario is aimed at exactly those: the
 * two or three refusals a user only reaches once something has already gone
 * wrong, which is the worst possible moment to be told to type a command that
 * does not exist. So each one is *rendered* here and read.
 *
 * The alias module's own contract lives here too, because AC4's expiry is a
 * claim about this package's version and there is nowhere better to pin it.
 *
 * Verifies: EPIC-20-S3 (the expiry half) · EPIC-20-S7 · AC2, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { parseCancelArgs } from '../src/cancel.ts';
import {
  ALIAS_REMOVED_IN,
  COMMAND,
  DEPRECATED_COMMAND,
  deprecationNotice,
} from '../src/command-name.ts';
import { parseRunArgs } from '../src/run/args.ts';
import { detachSentence } from '../src/run/run.ts';
import { alreadyRunningMessage } from '../src/up.ts';

const RUN_ID = 'run_20260810T101500Z_c4a5b1';

/** Every way the capitalised name can still be *typed at a prompt*. */
function namesTheOldCommand(text: string): boolean {
  return /\bDeFlow(?:-(?:mcp|mock-agent)\b|\s+(?:init|up|run|cancel|doctor|status|ledger|replay|help)\b|\s+--?[a-zA-Z])/.test(
    text,
  );
}

suite('refusals assembled at runtime name the lowercase command (AC2)', () => {
  it("KAR-18.2 AC3's lease refusal", () => {
    for (const live of [
      { pid: 4242, port: null },
      { pid: 4242, port: 7777 },
    ]) {
      const message = alreadyRunningMessage(live);
      expect(message).toContain(`${COMMAND} up:`);
      expect(message).toContain(`'${COMMAND} status'`);
      expect(namesTheOldCommand(message)).toBe(false);
    }
  });

  it("KAR-18.3 AC3's detach sentence", () => {
    const sentence = detachSentence(RUN_ID);
    expect(sentence).toContain(`'${COMMAND} run --attach ${RUN_ID}' to watch`);
    expect(sentence).toContain(`'${COMMAND} cancel ${RUN_ID}' to stop`);
    expect(namesTheOldCommand(sentence)).toBe(false);
  });

  it("KAR-19.6's cancel hint", () => {
    const parsed = parseCancelArgs([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.message).toContain(`${COMMAND} cancel <runId>`);
    expect(namesTheOldCommand(parsed.message)).toBe(false);
  });

  it("run's own refusals, every one of them", () => {
    const argvs: readonly (readonly string[])[] = [
      [],
      ['--attach'],
      ['--attach', 'nonsense'],
      ['--file'],
      ['--spec'],
      ['--issue'],
      ['--permission', 'nonsense'],
      ['--provider', 'nonsense'],
      ['--nonsense'],
      ['a task', '--file', 'x'],
      ['--attach', RUN_ID, 'a task'],
    ];
    const refusals = argvs.map((argv) => {
      const parsed = parseRunArgs(argv);
      return parsed.ok ? '' : parsed.message;
    });
    expect(refusals.filter((message) => message === '')).toEqual([]);
    expect(refusals.filter((message) => namesTheOldCommand(message))).toEqual([]);
  });
});

suite('the deprecated alias (AC4, AC7)', () => {
  it('prints exactly one line, naming both names and the release it goes in', () => {
    const notice = deprecationNotice(`/usr/local/bin/${DEPRECATED_COMMAND}`);
    expect(notice).toBeDefined();
    if (notice === undefined) throw new Error('unreachable');
    expect(notice.endsWith('\n')).toBe(true);
    expect(notice.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(notice).toContain(DEPRECATED_COMMAND);
    expect(notice).toContain(COMMAND);
    expect(notice).toContain(ALIAS_REMOVED_IN);
  });

  it('says nothing when the new name was used', () => {
    expect(deprecationNotice(`/usr/local/bin/${COMMAND}`)).toBeUndefined();
  });

  it('says nothing when the program was run from source or from dist', () => {
    // `node packages/cli/src/bin.ts` and `node dist/bin.mjs` are how the
    // monorepo and the tarball both run it; neither is a user typing the old
    // name, and a notice on either is noise in every spec in the repository.
    expect(deprecationNotice('/repo/packages/cli/src/bin.ts')).toBeUndefined();
    expect(deprecationNotice('/prefix/lib/node_modules/deflow/dist/bin.mjs')).toBeUndefined();
    expect(deprecationNotice(undefined)).toBeUndefined();
  });

  it('expires by going red rather than by being remembered (EPIC-20-S3)', () => {
    // The alias is removed in ALIAS_REMOVED_IN. Once this package's version
    // reaches it, this test fails and the alias has to go — which is the only
    // mechanism for removing a deprecation that has ever worked.
    const manifest = JSON.parse(readText('packages/cli/package.json')) as { version?: string };
    const version = manifest.version ?? '0.0.0';
    const order = (semver: string): number[] =>
      semver.split('-')[0]?.split('.').map(Number) ?? [0, 0, 0];
    const [major = 0, minor = 0, patch = 0] = order(version);
    const [expiredMajor = 0, expiredMinor = 0, expiredPatch = 0] = order(ALIAS_REMOVED_IN);
    const asNumber = (parts: readonly number[]): number =>
      parts[0] * 1e6 + parts[1] * 1e3 + parts[2];
    expect({
      version,
      removedIn: ALIAS_REMOVED_IN,
      stillSupported:
        asNumber([major, minor, patch]) < asNumber([expiredMajor, expiredMinor, expiredPatch]),
    }).toEqual({ version, removedIn: ALIAS_REMOVED_IN, stillSupported: true });
  });
});
