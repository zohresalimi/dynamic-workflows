/**
 * KAR-21.2 AC7, AC8 / EPIC-21-S12 — the two tables agree, in both directions.
 *
 * The failure this prevents is small and constant: a key is renamed on one side
 * of the pair, the hint line advertises something inert, and the operator
 * concludes the application is broken. It is cheap to prevent only because both
 * sides are *tables* rather than switch statements — `KEY_BINDINGS` in
 * `keys.ts` and `SESSION_ACTIONS` here — so "compare each against the other" is
 * two set differences rather than a review.
 *
 * `SESSION_ACTIONS` is a total `Record<Intent, …>`, so half of AC8 is already a
 * compile error. The runtime half is still asserted: a `Record` cannot notice
 * that a key was removed from `KEY_BINDINGS` and left an action stranded.
 *
 * Everything here is a pure function of `SessionState`, for the reason
 * `state.ts` gives: screen state in a module-level variable is what makes TUI
 * code testable only by hand.
 *
 * Verifies: EPIC-21-S12 · AC7, AC8 · test plan #12
 */
import { expect, it, describe as suite } from 'vitest';
import { createStyle } from '../../render/style.ts';
import { applyIntent, SESSION_ACTIONS } from './actions.ts';
import { INTENTS, KEY_BINDINGS } from './keys.ts';
import { initialSessionState, type SessionState } from './state.ts';
import { keyHintLine } from './view.ts';

const watching = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState(),
  keyboard: true,
  ...over,
});

suite('EPIC-21-S12 — no key is decoded to an intent nothing handles (AC8)', () => {
  it('has an action for every intent a key produces', () => {
    const handled = new Set(Object.keys(SESSION_ACTIONS));
    for (const binding of KEY_BINDINGS) {
      expect(
        handled.has(binding.intent),
        `the key "${binding.label}" decodes to "${binding.intent}", which no session action ` +
          'handles: it would be advertised and inert',
      ).toBe(true);
    }
  });

  it('has a key for every intent it handles', () => {
    // `none` is the deliberate exception and is named rather than filtered by a
    // predicate: it is what an *unrecognised* key produces, so a binding for it
    // would be a key that means "means nothing".
    const produced = new Set<string>([...KEY_BINDINGS.map((binding) => binding.intent), 'none']);
    for (const intent of Object.keys(SESSION_ACTIONS)) {
      expect(
        produced.has(intent),
        `the session handles "${intent}", which no key produces: it is undiscoverable`,
      ).toBe(true);
    }
  });

  it('covers the whole Intent union from both sides', () => {
    // The union itself is the third party to the agreement: an intent added to
    // `Intent` and to neither table would otherwise pass both checks above.
    expect(Object.keys(SESSION_ACTIONS).toSorted()).toEqual([...INTENTS].toSorted());
  });

  it('names only keys the decoder table carries, in the hint line', () => {
    const hint = keyHintLine(createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } }));
    const labels = KEY_BINDINGS.map((binding) => binding.label);

    for (const label of labels) expect(hint).toContain(label);
    // …and nothing else that looks like a key. The line is *built* from the
    // table, which is what makes this true by construction rather than by
    // vigilance — asserted anyway, because "built from the table" is the thing
    // a well-meaning edit undoes.
    expect(hint.split(/\s+/).filter((word) => labels.includes(word)).length).toBe(labels.length);
  });
});

suite('what each key does to the session (AC7)', () => {
  it('leaves the state untouched for an unrecognised key, and says so', () => {
    const before = watching();

    const after = applyIntent(before, 'none');

    // Identity, not deep equality: the caller decides whether to repaint by
    // comparing references, and AC7's "no repaint" has to be observable.
    expect(after.state).toBe(before);
    expect(after.effect).toBe('none');
  });

  it('opens the interjection row on `interject` and closes it on `dismiss`', () => {
    const opened = applyIntent(watching(), 'interject').state;

    expect(opened.input).not.toBeNull();
    expect(opened.input?.kind).toBe('interject');
    expect(opened.input?.text).toBe('');

    const closed = applyIntent(opened, 'dismiss').state;

    expect(closed.input).toBeNull();
    expect(closed.focus).toBe('transcript');
  });

  it('aims the keyboard at the gate on `answer` and back on `dismiss`', () => {
    const aimed = applyIntent(watching(), 'answer').state;

    expect(aimed.focus).toBe('gate');
    expect(applyIntent(aimed, 'dismiss').state.focus).toBe('transcript');
  });

  it('moves the focus with the arrows and wraps at neither end', () => {
    const transcript = watching();

    expect(applyIntent(transcript, 'select-up').state.focus).toBe('plan');
    expect(applyIntent(transcript, 'select-down').state.focus).toBe('transcript');

    const plan = watching({ focus: 'plan' });
    expect(applyIntent(plan, 'select-up').state.focus).toBe('gate');
    expect(applyIntent(plan, 'select-down').state.focus).toBe('transcript');

    const gate = watching({ focus: 'gate' });
    expect(applyIntent(gate, 'select-up').state.focus).toBe('gate');
  });

  it('closes an open input on `confirm` without inventing a wire call', () => {
    // KAR-21.3 and KAR-21.4 are what send an answer and an interjection. What
    // this story owes them is a row that opens, closes and is never left half
    // open — nothing here talks to a daemon.
    const opened = applyIntent(watching(), 'interject').state;

    const confirmed = applyIntent(opened, 'confirm');

    expect(confirmed.state.input).toBeNull();
    expect(confirmed.effect).toBe('none');
  });

  it('escapes the session on `interrupt` and changes nothing itself (AC5)', () => {
    const before = watching();

    const after = applyIntent(before, 'interrupt');

    // The one intent the session cannot answer by itself: Ctrl-C is KAR-18.3
    // AC3's and the session adds no third meaning to it.
    expect(after.effect).toBe('interrupt');
    expect(after.state).toBe(before);
  });

  it('is a pure function of the state it was given (AC9)', () => {
    const before = watching();
    const snapshot = JSON.stringify(before);

    applyIntent(before, 'interject');
    applyIntent(before, 'select-up');

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
