/**
 * KAR-07.7 — the static policy check behind EPIC-07-S27's second scenario:
 * *"`-X ours`, `-X theirs` and `--strategy=ours` appear nowhere"*
 * (docs/09-workspace-and-safety.md §7.2).
 *
 * §7.2's first rule is "never let an agent auto-resolve blind", and the way
 * that rule dies is not a decision — it is a one-line fix to a red test at
 * 6pm. `-X ours` makes a conflicting merge succeed, immediately, with no
 * error and no event, by silently discarding one side's work; the run then
 * reports success and the loss surfaces days later as "that change never
 * landed". So the argument is removed from the vocabulary rather than
 * discouraged.
 *
 * **Comments are stripped before scanning**, which is not a loophole but the
 * point: the reason these arguments are absent has to be *written down* where
 * the next person will read it, and a check that punished the explanation
 * would guarantee no explanation exists. What is forbidden is reaching git
 * with one, and only code can do that.
 *
 * Pure text scanning, not an AST, for ./generated-ref-usage.ts's reason: the
 * check has to run over every source file in the package cheaply, and the
 * shapes it is looking for are literal strings in an argv array.
 */

/** The strategy options that resolve a conflict without anyone reading it.
 * `-X` in any spelling, and the `ours`/`theirs` whole-tree strategies. */
const AUTO_RESOLVE = [
  /(^|[^\w-])-X(\s|=|'|"|`|$)/,
  /-Xours\b/,
  /-Xtheirs\b/,
  /--strategy-option\b/,
  /--strategy=ours\b/,
  /--strategy=theirs\b/,
] as const;

export interface AutoResolveUse {
  /** 1-based line number in the original source. */
  readonly line: number;
  readonly text: string;
}

/** Line and block comments removed, line numbering preserved so a hit still
 * reports where it really is. */
export function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');
}

/**
 * Every line of `source` — comments excluded — that names a merge strategy
 * option capable of resolving a conflict on its own.
 */
export function findAutoResolveStrategies(source: string): AutoResolveUse[] {
  const uses: AutoResolveUse[] = [];
  const lines = stripComments(source).split('\n');
  for (const [index, line] of lines.entries()) {
    if (AUTO_RESOLVE.some((pattern) => pattern.test(line))) {
      uses.push({ line: index + 1, text: line.trim() });
    }
  }
  return uses;
}
