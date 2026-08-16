/**
 * KAR-21.5 AC9 / EPIC-21-S45 — the one document an operator reads is not the
 * one thing that is wrong.
 *
 * KAR-20.3 AC5 established this rule for flags: everything the help shows
 * exists, and everything a first run needs is shown. A key is a flag the
 * operator cannot see, so it needs the rule more, not less — a renamed binding
 * leaves `--help` advertising something inert, and the operator concludes the
 * application is broken rather than that the documentation is.
 *
 * Both directions, over `KEY_BINDINGS` — the same table `keys.ts` decodes with
 * and `view.ts` builds its hint line from. EPIC-21-S12 already pins the decoder
 * against the action table; this pins the *help* against the decoder, which
 * closes the triangle.
 *
 * The usage text is read as **source** rather than imported, because importing
 * `bin.ts` runs the CLI: its last statement is `await main(process.argv)`. What
 * is asserted is therefore what a reader of that file sees, which is also what
 * `deflow --help` prints — `deprecated-alias.test.ts` already spawns the real
 * `--help` and is where "it prints at all" is settled.
 *
 * Verifies: EPIC-21-S45 · AC9 · test plan #9
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { KEY_BINDINGS } from '../src/run/session/keys.ts';

const USAGE_SOURCE = readFileSync(fileURLToPath(new URL('../src/bin.ts', import.meta.url)), 'utf8');

/**
 * The block of `USAGE` that names the session's keys.
 *
 * Delimited by the heading rather than by a line number so the assertions below
 * fail on a missing section rather than on a moved one, and so a key mentioned
 * in some other part of the file — `--no-color`'s paragraph mentions `--json` —
 * cannot satisfy them by accident.
 */
function keySection(): string {
  const start = USAGE_SOURCE.indexOf('Keys in the live session');
  expect(start, 'USAGE has no section naming the live session and its keys').toBeGreaterThan(-1);
  const rest = USAGE_SOURCE.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The key labels the help actually names, as whole words. */
function labelsNamed(section: string): Set<string> {
  return new Set(
    KEY_BINDINGS.map((binding) => binding.label).filter((label) =>
      new RegExp(`(^|[\\s(,])${label}([\\s),.]|$)`, 'm').test(section),
    ),
  );
}

suite('EPIC-21-S45 — --help names the keys, and every key it names exists (AC9)', () => {
  it('names a key that the decoder actually decodes, for every key it names', () => {
    const section = keySection();
    const decoded = new Set(KEY_BINDINGS.map((binding) => binding.label));

    for (const label of labelsNamed(section)) {
      expect(
        decoded.has(label),
        `--help names the key "${label}", which keys.ts does not decode`,
      ).toBe(true);
    }
    // And it named something: a section containing no key at all would satisfy
    // a one-directional check forever.
    expect(labelsNamed(section).size).toBeGreaterThan(0);
  });

  it('names every key that opens an input, answers a gate or cancels a run', () => {
    const named = labelsNamed(keySection());

    // The three verbs S45 names, plus the movement and confirmation keys they
    // are useless without — derived from the table rather than listed here, so
    // a binding added tomorrow is a failing test rather than a silent omission.
    for (const binding of KEY_BINDINGS) {
      expect(
        named.has(binding.label),
        `keys.ts decodes "${binding.label}" (${binding.describe}), which --help never names: ` +
          'it is a key the operator has no way to discover',
      ).toBe(true);
    }
  });

  it('says what each key does, in the words the decoder uses for it', () => {
    const section = keySection();

    for (const binding of KEY_BINDINGS) {
      expect(
        section.includes(binding.describe),
        `--help names "${binding.label}" without saying it is what ${binding.describe} does`,
      ).toBe(true);
    }
  });

  it('states that the live view appears only on a terminal', () => {
    // The clause that saves a support conversation: somebody reading about a
    // live view they will never see in CI is told why in the same place.
    const section = keySection();

    expect(section).toContain('terminal');
    // And the fallback is named rather than implied, because "no live view" is
    // the state most readers of this paragraph are actually in.
    expect(/pipe|redirect|--json|not a terminal/.test(section)).toBe(true);
  });
});
