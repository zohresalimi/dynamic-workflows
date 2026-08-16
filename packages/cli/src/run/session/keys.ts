/**
 * KAR-21.2 AC1, AC2 — bytes in, a typed `Intent` out, and no I/O in between.
 *
 * Nothing in this file reads a stream, and that is the point rather than a
 * nicety: it is what makes every key behaviour in this epic a table test rather
 * than a person pressing something. The impure edge — raw mode, the `data`
 * listener, the escape timer — is `keyboard.ts`, and it is the only file that
 * has one.
 *
 * **The decoder holds a buffer.** A switch on the first byte is the single most
 * common bug in hand-rolled terminal input, and it is invisible locally: a local
 * terminal delivers `ESC [ A` in one `data` event, so the arrow key works on the
 * machine it was written on. Over ssh the three bytes arrive separately and the
 * operator's arrow key becomes an Escape — dismissing whatever was open —
 * followed by `[A` typed into the interjection box. So a partial sequence is
 * held, and `flush()` is what the caller calls when its stated wait has passed
 * with nothing else arriving. Both halves are needed: without the buffer an
 * arrow key breaks over ssh, and without the flush the Escape key stops working
 * entirely.
 *
 * The escape byte is spelled from its code point rather than as a literal, for
 * the reason `../../../test/render-guard.test.ts` rule 4 exists: `ESC [ A` is
 * byte-identical whether a terminal sent it or a program is about to write it,
 * and the guard is about writing. Keeping the guard's teeth where they belong
 * costs one `fromCodePoint` here.
 *
 * `KEY_BINDINGS` is a **table**, not a switch, so AC8 — every advertised key is
 * handled and every handled key is advertised — is two set differences in
 * `actions.test.ts` rather than a review. The hint line `view.ts` prints is
 * built from the same table, which is what makes the three agree by
 * construction.
 */

/** The one byte the decoder has to think about. */
const ESC = String.fromCodePoint(0x1b);
/** Ctrl-C, as a terminal sends it once raw mode is on: a byte, not a signal. */
const CTRL_C = String.fromCodePoint(0x03);
/**
 * KAR-21.4 — what the Backspace key sends.
 *
 * `DEL` rather than `BS`: the key labelled Backspace sends 0x7f on every
 * terminal this ships to, and 0x08 is what Ctrl-H sends. One binding for the
 * key people press, rather than two rows in the hint line for one idea.
 */
const DEL = String.fromCodePoint(0x7f);
/** The first printable code point. Below it are the control bytes, which are
 * keys rather than characters however they arrive. */
const FIRST_PRINTABLE = 0x20;

/**
 * Every meaning a key can carry, as one closed set.
 *
 * `select-up`/`select-down` rather than AC1's shorthand `select`, because a
 * direction the caller has to recover from somewhere else is not a decoded
 * intent. `cancel` and `detach` are likewise absent as intents: they are the two
 * outcomes of one `interrupt`, chosen by KAR-18.3 AC3's window in
 * `../interrupt.ts` and not by which key was pressed. A decoder that had a
 * `cancel` key would have added a third meaning to Ctrl-C, which is exactly what
 * AC5 forbids.
 *
 * `none` is a **value rather than an absence**: the caller has to be able to
 * tell "this key means nothing" from "the sequence is not finished yet", and
 * only one of those two may be acted on.
 */
export const INTENTS = [
  'answer',
  'interject',
  'resend',
  'cancel',
  'erase',
  'select-up',
  'select-down',
  'confirm',
  'dismiss',
  'interrupt',
  'none',
] as const;

export type Intent = (typeof INTENTS)[number];

/**
 * KAR-21.4 AC1 — one key press: what it *means*, and what it *is*.
 *
 * A key carries both facts and the session needs both. `i` is the interject key
 * and also the letter in `utils.ts`, so a decoder that reported only the intent
 * would make every correction containing a verb letter unwritable, and one that
 * reported only the character would leave the session no keys at all. Which of
 * the two applies depends on whether a row is open — which this file cannot
 * know and must not guess — so it reports both and decides neither.
 *
 * `text` is `null` for everything that is not a character: the control bytes,
 * the escape sequences, and the erase key. An empty string would be a
 * character that happened to be nothing, which is not the same claim.
 */
export interface DecodedKey {
  readonly intent: Intent;
  /** The bytes this key typed, or `null` when it typed nothing. */
  readonly text: string | null;
}

/** An intent a key can actually produce — everything but the empty one. */
export type BoundIntent = Exclude<Intent, 'none'>;

export interface KeyBinding {
  /** The exact bytes a terminal sends for this key. */
  readonly sequence: string;
  readonly intent: BoundIntent;
  /**
   * What the hint line calls this key.
   *
   * One whitespace-free ASCII token. ASCII because the hint is printed to
   * terminals that may be in the C locale (KAR-18.9's `charset: 'ascii'`), and
   * whitespace-free because `actions.test.ts` checks the hint names each label
   * as a word — a label that split into two would be advertised as two keys
   * that do not exist.
   */
  readonly label: string;
  /** What the hint line says it does, in one ASCII word. */
  readonly describe: string;
}

/**
 * The keys this application has, in the order the hint line names them.
 *
 * Letters for the two verbs, arrows for movement, and the three keys every
 * terminal application already means the same thing by. Nothing is bound to a
 * function key or a modifier combination beyond Ctrl-C: those are the ones that
 * differ between terminal emulators, and a key that works in one emulator and
 * silently does nothing in another is worse than no key.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { sequence: 'a', intent: 'answer', label: 'a', describe: 'answer' },
  { sequence: 'i', intent: 'interject', label: 'i', describe: 'interject' },
  // KAR-21.4. `r` accepts the alternative mode an `unsupported` answer named,
  // and `c` starts the two-step that ends a run; `bksp` is what makes the row
  // they both type into an input rather than a one-shot.
  { sequence: 'r', intent: 'resend', label: 'r', describe: 'resend' },
  { sequence: 'c', intent: 'cancel', label: 'c', describe: 'cancel' },
  { sequence: DEL, intent: 'erase', label: 'bksp', describe: 'erase' },
  { sequence: `${ESC}[A`, intent: 'select-up', label: 'up', describe: 'prev' },
  { sequence: `${ESC}[B`, intent: 'select-down', label: 'down', describe: 'next' },
  { sequence: '\r', intent: 'confirm', label: 'enter', describe: 'confirm' },
  { sequence: ESC, intent: 'dismiss', label: 'esc', describe: 'dismiss' },
  { sequence: CTRL_C, intent: 'interrupt', label: 'ctrl-c', describe: 'detach' },
];

const BY_SEQUENCE = new Map<string, BoundIntent>(
  KEY_BINDINGS.map((binding) => [binding.sequence, binding.intent]),
);

/**
 * How long a lone escape byte is held before it is taken to mean Escape.
 *
 * Stated here because it is the decoder's wait even though `keyboard.ts` is what
 * owns the timer. The value is the conventional one: long enough that the rest
 * of an arrow key arrives over a slow link, short enough that a pressed Escape
 * key does not feel stuck.
 */
export const ESCAPE_WAIT_MS = 50;

/** A CSI sequence ends at the first byte in `@`…`~`; everything before it is
 * parameters. Matching the range rather than a list of known finals is what lets
 * an unhandled sequence be consumed **whole** — see `readEscape`. */
const FINAL_BYTE = /[@-~]/;

export interface KeyDecoder {
  /** Bytes from one `data` event; the keys they completed, in order. */
  feed(chunk: string): readonly DecodedKey[];
  /** Whether bytes are being held back pending more. */
  pending(): boolean;
  /** The caller's stated wait has passed: decide about whatever is held. */
  flush(): readonly DecodedKey[];
}

/** A key that means something but types nothing — every escape sequence, and
 * every control byte. */
const keyOf = (intent: Intent): DecodedKey => ({ intent, text: null });

/**
 * One character off the front of the buffer, as both facts about it.
 *
 * A surrogate pair arrives as two of these and is re-joined by the caller
 * appending them in order, which is why this takes one JS character rather than
 * one code point: there is nothing to decide about half a character, and
 * concatenation puts it back together.
 */
function readCharacter(byte: string): DecodedKey {
  const intent = BY_SEQUENCE.get(byte) ?? 'none';
  const printable = (byte.codePointAt(0) ?? 0) >= FIRST_PRINTABLE && byte !== DEL;
  return { intent, text: printable ? byte : null };
}

/**
 * One escape sequence off the front of `buffer`.
 *
 * `null` means "not finished, and more may still arrive" — the only answer that
 * must never be turned into an intent. `ESC [ 5 ~` (Page Up) is nothing this
 * application binds, and the wrong answer for it is `dismiss` followed by `[`,
 * `5` and `~` typed into whatever was open, so an unknown sequence is consumed
 * to its final byte and reported as one `none`.
 */
function readEscape(buffer: string, final: boolean): { intent: Intent; width: number } | null {
  if (buffer.length === 1) {
    // A lone escape is Escape only once nothing followed it.
    return final ? { intent: 'dismiss', width: 1 } : null;
  }

  const introducer = buffer[1];
  if (introducer !== '[' && introducer !== 'O') {
    // `ESC x` is Alt-x. Nothing here binds one, and splitting it into a dismiss
    // plus a keypress would invent a key the operator did not press.
    return { intent: 'none', width: 2 };
  }

  for (let index = 2; index < buffer.length; index += 1) {
    if (FINAL_BYTE.test(buffer[index] ?? '')) {
      const sequence = buffer.slice(0, index + 1);
      return { intent: BY_SEQUENCE.get(sequence) ?? 'none', width: sequence.length };
    }
  }

  // Incomplete. On a flush the escape stands alone and the truncated tail is
  // dropped: it is noise from a link that stopped mid-sequence, and feeding it
  // back through as printable bytes is the ssh bug arriving by another route.
  return final ? { intent: 'dismiss', width: buffer.length } : null;
}

export function createKeyDecoder(): KeyDecoder {
  let buffer = '';

  const drain = (final: boolean): readonly DecodedKey[] => {
    const keys: DecodedKey[] = [];

    while (buffer !== '') {
      if (buffer.startsWith(ESC)) {
        const read = readEscape(buffer, final);
        if (read === null) break;
        // An escape sequence types nothing: `ESC [ 5 ~` is Page Up, and putting
        // its bytes into an open row is the ssh bug this decoder exists for.
        keys.push(keyOf(read.intent));
        buffer = buffer.slice(read.width);
        continue;
      }

      keys.push(readCharacter(buffer.slice(0, 1)));
      buffer = buffer.slice(1);
    }

    return keys;
  };

  return {
    feed(chunk) {
      buffer += chunk;
      return drain(false);
    },
    pending: () => buffer !== '',
    flush: () => drain(true),
  };
}
