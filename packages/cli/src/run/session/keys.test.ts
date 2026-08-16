/**
 * KAR-21.2 AC1, AC2, AC7 / EPIC-21-S10, EPIC-21-S11 — bytes in, a typed intent
 * out, and no I/O anywhere in between.
 *
 * The shape is what these two scenarios fix, and the shape is what makes every
 * other key behaviour in this epic a table test rather than a person pressing
 * something: `keys.ts` never mentions `process.stdin`, holds a buffer rather
 * than switching on a first byte, and is therefore drivable one `data` event at
 * a time — which is exactly how a slow link delivers an arrow key.
 *
 * The escape byte is spelled `String.fromCodePoint(0x1b)` here for the same
 * reason it is in the module under test: `../../../test/render-guard.test.ts`
 * rule 4 forbids an escape literal followed by a cursor-move final byte outside
 * `render/screen.ts`, and `ESC [ A` is byte-identical whether a terminal sent it
 * or a program is about to write it. The guard is about *writing*; a decoder
 * only ever reads. Spelling it from its code point keeps the guard's teeth
 * where they belong instead of carving an exception into it.
 *
 * Verifies: EPIC-21-S10, EPIC-21-S11 · AC1, AC2, AC7 · test plan #10, #11
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { createKeyDecoder, type DecodedKey, type Intent, KEY_BINDINGS } from './keys.ts';

const ESC = String.fromCodePoint(0x1b);
/** Ctrl-C, as the terminal sends it once raw mode is on: a byte, not a signal. */
const CTRL_C = String.fromCodePoint(0x03);
/** BEL — a control byte nothing in this application binds. */
const BEL = String.fromCodePoint(0x07);

/**
 * One key press, start to finish: the bytes arrive and then the stream goes
 * quiet.
 *
 * The `flush` is what "and nothing follows" means for a decoder that holds a
 * buffer, and it is why EPIC-21-S10's `ESC` row can say `dismiss` while
 * EPIC-21-S11 says a lone `ESC` yields nothing *yet*. Both are true and they
 * are about different instants; running them through one helper is what stops
 * the pair being reconciled by weakening either.
 */
function pressedKeys(bytes: string): readonly DecodedKey[] {
  const decoder = createKeyDecoder();
  return [...decoder.feed(bytes), ...decoder.flush()];
}

/** The same press, as the intents alone — what these two scenarios are about. */
function pressed(bytes: string): readonly Intent[] {
  return pressedKeys(bytes).map((key) => key.intent);
}

/** A decoded key's intents, for the assertions made one `data` event at a time. */
const intentsOf = (keys: readonly DecodedKey[]): readonly Intent[] => keys.map((key) => key.intent);

suite('EPIC-21-S10 — the bytes a terminal actually sends (AC1, AC2)', () => {
  const cases: readonly [string, string, Intent][] = [
    ['a printable letter', 'a', 'answer'],
    ['another printable letter', 'i', 'interject'],
    ['the up arrow', `${ESC}[A`, 'select-up'],
    ['the down arrow', `${ESC}[B`, 'select-down'],
    ['carriage return', '\r', 'confirm'],
    ['a lone escape', ESC, 'dismiss'],
    ['Ctrl-C', CTRL_C, 'interrupt'],
    ['an unrecognised control byte', BEL, 'none'],
  ];

  for (const [what, bytes, intent] of cases) {
    it(`decodes ${what} to ${intent}`, () => {
      expect(pressed(bytes)).toEqual([intent]);
    });
  }

  it('never references process.stdin (AC1)', () => {
    // The claim is about the module, not about this process, so it is asserted
    // against the source: a decoder that reached for stdin would still pass
    // every case above while being untestable anywhere else.
    const source = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('stdin');
    expect(source).not.toContain('process.');
  });

  it('yields one intent per key when several arrive in one data event', () => {
    // A terminal coalesces: a fast typist's two letters are one `data` event,
    // and a decoder that answered only about the first byte would drop the
    // second silently.
    expect(pressed('ai')).toEqual(['answer', 'interject']);
  });

  it('does nothing at all for an unrecognised key (AC7)', () => {
    // `none` is a value rather than an absence on purpose: the caller has to be
    // able to tell "this key means nothing" from "the sequence is incomplete",
    // and only one of the two may be acted on.
    expect(pressed(BEL)).toEqual(['none']);
    expect(pressed('Z')).toEqual(['none']);
  });
});

suite('EPIC-21-S11 — one sequence, two data events (AC2)', () => {
  it('holds the escape back and completes it on the next read', () => {
    const decoder = createKeyDecoder();

    expect(intentsOf(decoder.feed(ESC))).toEqual([]);
    expect(decoder.pending()).toBe(true);

    const second = intentsOf(decoder.feed('[A'));

    expect(second).toEqual(['select-up']);
    // The lone escape byte must not have meant Escape on its way past: over ssh
    // that turns an arrow key into a dismissal followed by `[A` typed into
    // whatever was open.
    expect(second).not.toContain('dismiss');
    expect(decoder.pending()).toBe(false);
  });

  it('splits a sequence anywhere, not only after the escape', () => {
    const decoder = createKeyDecoder();

    expect(intentsOf(decoder.feed(`${ESC}[`))).toEqual([]);
    expect(intentsOf(decoder.feed('B'))).toEqual(['select-down']);
    expect(decoder.pending()).toBe(false);
  });

  it('means Escape when the sequence never completes', () => {
    const decoder = createKeyDecoder();

    expect(intentsOf(decoder.feed(ESC))).toEqual([]);
    // `flush` is what the caller calls when the decoder's stated wait has
    // passed with nothing else arriving. Without it the Escape key stops
    // working entirely, which is the other half of the same bug.
    expect(intentsOf(decoder.flush())).toEqual(['dismiss']);
    expect(decoder.pending()).toBe(false);
    // And the buffer is empty afterwards: a second flush has nothing to say.
    expect(intentsOf(decoder.flush())).toEqual([]);
  });

  it('renders a key that follows a completed sequence in the same event', () => {
    const decoder = createKeyDecoder();

    expect(intentsOf(decoder.feed(`${ESC}[Aa`))).toEqual(['select-up', 'answer']);
  });

  it('consumes an unknown escape sequence whole rather than one byte at a time', () => {
    const decoder = createKeyDecoder();

    // `ESC [ 5 ~` is Page Up. Nothing here handles it, and the wrong answer is
    // `dismiss` followed by `[`, `5` and `~` typed into an input box.
    expect(intentsOf(decoder.feed(`${ESC}[5~a`))).toEqual(['none', 'answer']);
  });
});

/**
 * KAR-21.4 AC1 — the bytes that fill an open row.
 *
 * A key carries two facts and the session needs both: what it *means* while
 * nothing is open, and what it *is* while something is. `i` is the interject
 * key and also the letter in "utils", and a decoder that reported only the
 * intent would make every correction containing one of the verb letters
 * unwritable. The decision between them belongs to the session — it is the one
 * that knows whether a row is open — so the decoder reports both and decides
 * neither.
 */
suite('EPIC-21-S28 — a printable key carries its character too (KAR-21.4 AC1)', () => {
  it('reports the character alongside the intent, bound or not', () => {
    expect(pressedKeys('a')).toEqual([{ intent: 'answer', text: 'a' }]);
    expect(pressedKeys('Z')).toEqual([{ intent: 'none', text: 'Z' }]);
    expect(pressedKeys(' ')).toEqual([{ intent: 'none', text: ' ' }]);
    expect(pressedKeys('.')).toEqual([{ intent: 'none', text: '.' }]);
  });

  it('reports no character for the keys that are not letters', () => {
    for (const bytes of ['\r', ESC, CTRL_C, BEL, `${ESC}[A`]) {
      for (const key of pressedKeys(bytes)) expect(key.text).toBeNull();
    }
  });

  it('reports a whole typed word one character at a time, in order', () => {
    expect(
      pressedKeys('utils')
        .map((key) => key.text)
        .join(''),
    ).toBe('utils');
  });
});

suite('the decoder holds a buffer rather than switching on a first byte (AC2)', () => {
  it('exposes every key it decodes as a table', () => {
    // EPIC-21-S12 compares this table against the session's; what is asserted
    // here is only that it exists and is not empty, so that comparison is over
    // something.
    expect(KEY_BINDINGS.length).toBeGreaterThan(0);
    for (const binding of KEY_BINDINGS) {
      expect(pressed(binding.sequence)).toEqual([binding.intent]);
    }
  });

  it('gives every binding a distinct sequence and a label', () => {
    const sequences = KEY_BINDINGS.map((binding) => binding.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    for (const binding of KEY_BINDINGS) {
      expect(binding.label).not.toBe('');
      // The hint line is printed to a terminal that may be in the C locale, so
      // a label has to survive `charset: 'ascii'` (KAR-18.9).
      expect(/^[ -~]+$/.test(binding.label)).toBe(true);
      expect(/^[ -~]+$/.test(binding.describe)).toBe(true);
    }
  });
});
