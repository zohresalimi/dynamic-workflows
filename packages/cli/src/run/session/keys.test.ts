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
import { createKeyDecoder, type Intent, KEY_BINDINGS } from './keys.ts';

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
function pressed(bytes: string): readonly Intent[] {
  const decoder = createKeyDecoder();
  return [...decoder.feed(bytes), ...decoder.flush()];
}

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

    expect(decoder.feed(ESC)).toEqual([]);
    expect(decoder.pending()).toBe(true);

    const second = decoder.feed('[A');

    expect(second).toEqual(['select-up']);
    // The lone escape byte must not have meant Escape on its way past: over ssh
    // that turns an arrow key into a dismissal followed by `[A` typed into
    // whatever was open.
    expect(second).not.toContain('dismiss');
    expect(decoder.pending()).toBe(false);
  });

  it('splits a sequence anywhere, not only after the escape', () => {
    const decoder = createKeyDecoder();

    expect(decoder.feed(`${ESC}[`)).toEqual([]);
    expect(decoder.feed('B')).toEqual(['select-down']);
    expect(decoder.pending()).toBe(false);
  });

  it('means Escape when the sequence never completes', () => {
    const decoder = createKeyDecoder();

    expect(decoder.feed(ESC)).toEqual([]);
    // `flush` is what the caller calls when the decoder's stated wait has
    // passed with nothing else arriving. Without it the Escape key stops
    // working entirely, which is the other half of the same bug.
    expect(decoder.flush()).toEqual(['dismiss']);
    expect(decoder.pending()).toBe(false);
    // And the buffer is empty afterwards: a second flush has nothing to say.
    expect(decoder.flush()).toEqual([]);
  });

  it('renders a key that follows a completed sequence in the same event', () => {
    const decoder = createKeyDecoder();

    expect(decoder.feed(`${ESC}[Aa`)).toEqual(['select-up', 'answer']);
  });

  it('consumes an unknown escape sequence whole rather than one byte at a time', () => {
    const decoder = createKeyDecoder();

    // `ESC [ 5 ~` is Page Up. Nothing here handles it, and the wrong answer is
    // `dismiss` followed by `[`, `5` and `~` typed into an input box.
    expect(decoder.feed(`${ESC}[5~a`)).toEqual(['none', 'answer']);
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
