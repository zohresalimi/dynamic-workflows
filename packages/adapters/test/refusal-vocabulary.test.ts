/**
 * KAR-19.13 AC6, AC7 / EPIC-19-S89, EPIC-19-S90 — the words a CLI uses when it
 * refuses an argument are data, and so is whether its session-id flag can only
 * create.
 *
 * **Why this is its own file.** KAR-19.8 taught `rejectedArgument` the sentence
 * Claude Code 2.1.220 writes for a malformed session id — *"Invalid session ID.
 * Must be a valid UUID."* — by adding `invalid` and `must be` to a regex. Three
 * days later the same vendor refused the same flag with
 *
 * ```
 * Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use
 * ```
 *
 * which contains none of those words, so the refusal fell through to
 * `agentExited`'s `transient` — a standing instruction to retry the identical
 * id, every tick, for ever. One more literal would close that case and leave
 * the next wording to the next real run. A **table whose rows each carry the
 * sentence they exist for** is what converts *"we added a word"* into *"here is
 * what is covered"*, and this file is what makes an uncovered row fail rather
 * than pass vacuously.
 *
 * Verifies: EPIC-19-S89, EPIC-19-S90 · KAR-19.13 AC6, AC7
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import { argumentRefused, REFUSAL_VOCABULARY, rejectedArgument } from '../src/argument-refusal.ts';
import { PROVIDER_SPECS, type ProviderSpec } from '../src/provider-registry.ts';

const specs = Object.values(PROVIDER_SPECS) as readonly ProviderSpec[];

suite('KAR-19.13 AC6 — every phrasing has a vendor sentence behind it', () => {
  it('is a table, and a non-trivial one', () => {
    // Guards the file itself: a vocabulary that had been emptied would make
    // every `it.each` below vacuous, and a vacuous pass is the failure mode
    // this whole story is about.
    expect(REFUSAL_VOCABULARY.length).toBeGreaterThanOrEqual(8);
  });

  it.each(REFUSAL_VOCABULARY.map((entry) => [entry.phrasing, entry] as const))(
    '%s recognises the sentence recorded beside it',
    (_phrasing, entry) => {
      expect(entry.sentence.trim()).not.toBe('');
      expect(entry.pattern.test(entry.sentence)).toBe(true);
      expect(['executed', 'help', 'bundle', 'documented']).toContain(entry.provenance.how);
      expect(entry.provenance.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  /**
   * The argv the sentence is tested against: every flag the sentence names,
   * plus the session-id flag it may only have named the *subject* of.
   *
   * Built from the sentence rather than fixed, because `rejectedArgument`
   * deliberately needs **two agreeing facts** — the child said something was
   * refused, and the thing it named is on the argv DeFlow built. A fixed argv
   * would test the matcher against arguments DeFlow never passed, which is a
   * weaker claim than the one the row is making.
   */
  const argvFor = (sentence: string): readonly string[] => [
    '-p',
    'do the thing',
    ...[...new Set(sentence.match(/--[a-z-]+/g) ?? [])].flatMap((flag) => [
      flag,
      'a-value-deflow-chose',
    ]),
    '--session-id',
    'a-value-deflow-chose',
  ];

  it.each(REFUSAL_VOCABULARY.map((entry) => [entry.phrasing, entry.sentence] as const))(
    '%s makes its sentence an argument refusal, classed permanent',
    (_phrasing, sentence) => {
      const rejected = rejectedArgument({
        argv: argvFor(sentence),
        stderr: sentence,
        spec: PROVIDER_SPECS.claude,
      });

      expect(rejected, sentence).not.toBeNull();
      const failure = argumentRefused({
        provider: 'claude',
        rejected: rejected as NonNullable<typeof rejected>,
        stderr: sentence,
        code: 1,
        signal: null,
      });
      expect(failure.deflowFailure.class).toBe('permanent');
    },
  );

  it('covers the "already in use" family the 2026-08-16 run died on', () => {
    const phrasings = REFUSAL_VOCABULARY.map((entry) => entry.phrasing);

    expect(phrasings).toContain('already in use');
    expect(phrasings).toContain('already exists');
    expect(phrasings).toContain('in use');
  });
});

suite('KAR-19.13 AC7 — the registry says which session-id flags can only create', () => {
  it.each(specs.map((spec) => [spec.id, spec] as const))(
    '%s either declares how its session-id flag behaves, or passes none',
    (_id, spec) => {
      const declared = spec.shim.sessionId;
      if (declared === undefined) {
        // The other arm of the same claim: an entry that declares nothing must
        // put nothing on the argv, or the fact would be missing rather than
        // absent.
        const argv = spec.shim.argv({
          resolved: { provider: spec.id, path: `/opt/DeFlow/bin/${spec.shim.bin}` },
          worktree: '/tmp/DeFlow/wt/n1',
          prompt: 'summarise the failing test',
          sessionId: 'a-value-deflow-chose',
          permission: 'read',
        });
        expect(argv).not.toContain('a-value-deflow-chose');
        return;
      }

      expect(declared.flag.startsWith('-')).toBe(true);
      expect(declared.form).toBe('uuid');
      expect(['create-only', 'may-attach']).toContain(declared.reuse);
      expect(declared.reuseProvenance.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['executed', 'help', 'bundle']).toContain(declared.reuseProvenance.how);
    },
  );

  it('covers every entry rather than the one that broke', () => {
    expect(specs.map((spec) => spec.id).toSorted()).toEqual(Object.keys(PROVIDER_SPECS).toSorted());
    expect(specs.length).toBeGreaterThanOrEqual(4);
  });

  it('names no vendor in the derivation that reads the declaration', () => {
    const source = readFileSync(new URL('../src/vendor-session.ts', import.meta.url), 'utf8');
    const code = source
      .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    expect(code.toLowerCase()).not.toMatch(/claude|gemini|codex|copilot/);
  });
});
