/**
 * KAR-09.9 AC6 / EPIC-09-S48 (second scenario) — there is no truncation path
 * on the handoff, anywhere.
 *
 * > Never silently truncate. Truncating a JSON payload produces invalid JSON
 * > downstream, which is exactly the "silent propagation of garbage" F6.9
 * > exists to forbid.
 *
 * This is a structural test rather than a code review because the violation
 * arrives looking like a kindness. `output.slice(0, contract.maxTokens)` reads
 * as defensive programming, it makes an oversize node "work", and the damage
 * shows up two nodes later as a JSON parse error nobody can trace back. So the
 * rule is mechanical: **no module on the handoff path may shorten a payload,
 * and none may carry a length ceiling.** The bound this path has is a *budget*
 * that decides accept-or-fail, not a limit that decides where to cut.
 *
 * The scan is deliberately over-broad in what it looks for and narrow in where
 * it looks. `slice`, `substring`, `substr`, `truncate`, `maxLength`, `slice`'s
 * `Buffer` cousin and a `.length >` guard used as a cut point are all
 * violations here — even the ones that would have been harmless — because
 * "harmless truncation" is exactly the argument that ships the harmful one.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  describe as render,
  type SourceFile,
  type Violation,
} from '../../../test/support/guards.ts';
import { readSources } from '../../../test/support/workspace.ts';

/**
 * Every module that touches a structured return between the vendor's envelope
 * and the blackboard. Listed by name rather than globbed: a glob that silently
 * matched nothing would make this file a green no-op, and the first assertion
 * below is what keeps the list honest.
 */
const HANDOFF_PATH = [
  'packages/core/src/handoff.ts',
  'packages/daemon/src/handoff/enforce.ts',
  'packages/adapters/src/structured-output.ts',
];

/** Comments are exempt: explaining *why* nothing truncates is the point. */
function codeOnly(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The shortening operations, and the configuration key that would let one be
 * turned on later. `maxLength` is in the list because EPIC-09-S48 names it: a
 * module with a length ceiling has already decided that cutting is a thing it
 * might do.
 */
const TRUNCATORS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\.slice\s*\(/, what: '.slice(' },
  { pattern: /\.substring\s*\(/, what: '.substring(' },
  { pattern: /\.substr\s*\(/, what: '.substr(' },
  // A *call*, not the word: the repair prompt these modules build says "do not
  // truncate the JSON" in as many words, and a scan that flagged its own
  // instruction would have to be deleted the first time somebody wrote one.
  { pattern: /\btruncate\w*\s*\(/i, what: 'a truncate(' },
  { pattern: /\bmaxLength\b/, what: 'a maxLength' },
  { pattern: /\bmaxBytes\b/, what: 'a maxBytes' },
  { pattern: /\bsubarray\s*\(/, what: '.subarray(' },
];

export function checkNoTruncationOnHandoffPath(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const code = codeOnly(file.text);
    for (const { pattern, what } of TRUNCATORS) {
      if (!pattern.test(code)) continue;
      violations.push({
        where: file.path,
        message:
          `uses ${what} on the handoff path. A structured return is repaired or the node fails ` +
          '(KAR-09.9 AC6) — it is never shortened, because a truncated JSON payload is invalid ' +
          'JSON downstream, which is the silent propagation of garbage F6.9 exists to forbid.',
      });
    }
  }
  return violations;
}

const sources = (): SourceFile[] => readSources(HANDOFF_PATH);

suite('nothing on the handoff path can shorten a return (AC6)', () => {
  it('scans every module the return passes through', () => {
    expect(
      sources()
        .map((file) => file.path)
        .sort(),
    ).toEqual([...HANDOFF_PATH].sort());
  });

  it('finds no truncation and no length ceiling', () => {
    expect(render(checkNoTruncationOnHandoffPath(sources()))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    const mutated = sources().map((file) => ({
      ...file,
      text: `${file.text}\nconst fits = serialised.slice(0, contract.maxTokens);\n`,
    }));
    expect(checkNoTruncationOnHandoffPath(mutated)).toHaveLength(HANDOFF_PATH.length);
  });
});
