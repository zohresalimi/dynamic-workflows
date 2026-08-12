/**
 * KAR-18.9 AC3, AC4 — wrapping and column alignment.
 *
 * **A token is never broken.** A wrapper that breaks on character count splits
 * `/Users/…/pre-migrate-7.db` across two lines, and the operator who copies it
 * out of their terminal gets half a path — at exactly the moment they most
 * need to copy it. So a token wider than the column gets a line of its own,
 * whole, and that line is allowed to exceed the width. It is the one deliberate
 * exception to AC4, and it is the one AC4 names.
 *
 * **A continuation line is indented under what it continues.** A paragraph that
 * wraps back to the left margin stops looking like the detail of the check
 * above it and starts looking like a new check.
 *
 * **A column width is never a constant.** One long id pushes its status out of
 * alignment for the whole section, and then the eye has nothing to scan down.
 * The width comes from the longest id *in that section*.
 */

export interface WrapOptions {
  /** The full line width. Continuation lines are laid out inside it. */
  readonly width: number;
  /** The column the detail starts at, and the column continuations align to. */
  readonly indent: number;
}

/**
 * `text` as lines that fit `width`, with every line after the first indented to
 * `indent`.
 *
 * The first line carries no indent of its own: the caller has already written
 * whatever sits to its left (the id and the status), and prefixing it here
 * would double that.
 */
export function wrapDetail(text: string, options: WrapOptions): string[] {
  const padding = ' '.repeat(Math.max(0, options.indent));
  // A column narrower than this is not a column, it is a stack of syllables.
  // Under a pathological indent the detail simply gets the width it can have.
  const column = Math.max(20, options.width - Math.max(0, options.indent));

  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') {
      lines.push(lines.length === 0 ? current : `${padding}${current}`);
      current = '';
    }
  };

  // A newline the caller wrote is a newline the caller meant: `doctor`'s
  // calibration check prints one row per model, and reflowing those into a
  // paragraph would lose the only structure that check has. Each authored line
  // is wrapped on its own, so an explicit break survives and a long one still
  // fits.
  for (const paragraph of text.split(/\r?\n/)) {
    for (const word of paragraph.split(/\s+/).filter((entry) => entry !== '')) {
      if (word.length > column) {
        // Whole, and alone: one token an operator can select and copy.
        flush();
        lines.push(lines.length === 0 ? word : `${padding}${word}`);
        continue;
      }
      const candidate = current === '' ? word : `${current} ${word}`;
      if (candidate.length > column) {
        flush();
        current = word;
        continue;
      }
      current = candidate;
    }
    flush();
  }

  return lines.length === 0 ? [''] : lines;
}

/** The width of the id column in one section — the longest id in it (AC3). */
export function columnWidth(ids: readonly string[]): number {
  return ids.reduce((widest, id) => Math.max(widest, id.length), 0);
}
