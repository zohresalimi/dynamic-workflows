/**
 * Taking one member out of a JSON frame **without reformatting it**.
 *
 * KAR-05.2 AC1 stores the `initialize` response byte-for-byte as received, and
 * `JSON.stringify(JSON.parse(line)).result` is not that: it drops the sender's
 * whitespace, re-encodes numbers (`1.0` becomes `1`, `-1.5e3` becomes `-1500`)
 * and re-escapes strings. None of those differences matter today, which is
 * exactly why they would go unnoticed — and the reason to persist the response
 * unmodified is to answer a question nobody has thought to ask yet. A stored
 * artefact that has already been through this build's encoder cannot answer
 * "what did the agent actually send".
 *
 * So the scan below walks the source text and returns a slice of it. It is a
 * scanner, not a parser: it tracks strings and escapes (so a `}` inside a
 * string value does not end an object) and nesting depth (so a member of a
 * nested object is never mistaken for a top-level one), and it decides
 * nothing about what it found. The caller parses the slice if it wants a
 * value; the bytes are what get stored.
 */

/** Advances past a string literal starting at the opening quote. */
function endOfString(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return -1;
}

/** Advances past whatever value begins at `start`, or -1 if it is unterminated. */
function endOfValue(source: string, start: number): number {
  const first = source[start];
  if (first === '"') return endOfString(source, start);

  if (first === '{' || first === '[') {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        const after = endOfString(source, index);
        if (after === -1) return -1;
        index = after - 1;
        continue;
      }
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }

  // A literal or a number: everything up to the next structural character.
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === ',' || character === '}' || character === ']' || /\s/.test(character)) {
      return index;
    }
  }
  return source.length;
}

/**
 * The exact source text of top-level member `key`, or `null` when `source` is
 * not a JSON object, is truncated, or has no such member.
 *
 * Only *top-level* members count: a `"result"` nested inside another value is
 * not the frame's result, and treating it as one would silently store the
 * wrong object.
 */
export function sliceMember(source: string, key: string): string | null {
  const opening = source.indexOf('{');
  if (opening === -1 || source.slice(0, opening).trim() !== '') return null;

  let index = opening + 1;
  for (; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (/\s|,/.test(character)) continue;
    if (character === '}') return null;
    if (character !== '"') return null;

    const nameEnd = endOfString(source, index);
    if (nameEnd === -1) return null;
    const name = source.slice(index + 1, nameEnd - 1);

    const colon = source.indexOf(':', nameEnd);
    if (colon === -1) return null;

    let valueStart = colon + 1;
    while (valueStart < source.length && /\s/.test(source[valueStart] ?? '')) valueStart += 1;

    const valueEnd = endOfValue(source, valueStart);
    if (valueEnd === -1 || valueStart >= source.length) return null;

    if (name === key) {
      const sliced = source.slice(valueStart, valueEnd);
      // A slice that does not parse means the scan ran off the end of a
      // truncated frame. Better no answer than a plausible-looking fragment.
      try {
        JSON.parse(sliced);
      } catch {
        return null;
      }
      return sliced;
    }

    index = valueEnd - 1;
  }
  return null;
}
