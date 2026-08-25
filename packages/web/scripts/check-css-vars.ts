/**
 * KAR-27.4 AC3 — every `var(--x)` in `packages/web/src` names a token something
 * actually declares.
 *
 * Run by `pnpm lint` (and therefore by the pre-push hook and by CI's `check`
 * job), for the same reason `./check-graph-facade.ts` and
 * `./check-workspace-word.ts` are scripts rather than component specs: this is a
 * rule about source text, and the failure it catches is invisible in review.
 *
 * ## Why an undefined token needs a guard at all
 *
 * It fails *silently and completely*. A custom property nothing declares makes
 * its declaration invalid at computed-value time — not a parse error, not a
 * warning, not a fallback to the property's initial value in any way a reviewer
 * or a reduced test sees. `gap: var(--space-2)` on a flex row simply resolves to
 * `normal`, which is zero, and the row renders as though no gutter had ever been
 * written. KAR-27.3's activity strip shipped that way and read
 * `framingattempt 1 of 3running 1m 24s…` to an operator for two days.
 *
 * The deeper rule it enforces is `docs/design-system.md`'s: three token
 * families and the named ramps, and *"a name not on that list needs a reason
 * written beside it"*. A second vocabulary — `--space-*` alongside literal
 * geometry — is exactly what that rule refuses, and until now nothing checked.
 *
 * ## What counts as a declaration
 *
 * Three things, because the frontend legitimately has three:
 *
 * 1. **A CSS declaration** anywhere in any scanned file — `theme.css`'s
 *    `:root`/`.dark` blocks, and a component's own scoped block declaring a
 *    property it then reads.
 * 2. **A style binding's key** — `:style="{ '--run-status-pill-colour': colour }"`.
 *    Three properties in this package are set only that way (the run-status
 *    pill, the run list's dot, the history dot); each is genuinely declared,
 *    just in a template rather than a stylesheet, and a guard that could not see
 *    them would be a guard nobody could keep green.
 * 3. **Any file's declaration, for any file's reference.** The set is global on
 *    purpose: `theme.css` declaring what forty components read is the whole
 *    design of the token layer, so per-file scoping would report it as forty
 *    violations.
 *
 * A reference carrying its own fallback — `var(--maybe, currentColor)` — is
 * never reported. It has stated what happens when the token is absent, which is
 * the one case where absence is a decision rather than an accident.
 */
import { pathToFileURL } from 'node:url';
import { type ScannedFile, webSourceFiles } from './check-graph-facade.ts';

export type { ScannedFile };

export interface TokenViolation {
  /** Package-relative path, as `webSourceFiles` reports it. */
  readonly where: string;
  /** 1-based, so the message is clickable. */
  readonly line: number;
  /** The property that nothing declares, including its leading `--`. */
  readonly token: string;
  readonly message: string;
}

/**
 * `text` with comment bodies blanked **and every newline kept**.
 *
 * The shared `stripComments` collapses a block comment to a single space, which
 * is right for a rule that only asks *whether* a file matches and wrong for one
 * that reports a line number: a 30-line header comment would shift every line
 * beneath it. Here each comment becomes the same number of newlines it spanned,
 * so offsets after it are unmoved.
 */
function blankComments(text: string): string {
  const blank = (match: string): string => match.replaceAll(/[^\n]/g, ' ');
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, blank)
    .replaceAll(/\/\*[\s\S]*?\*\//g, blank)
    .replaceAll(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + blank(match.slice(before.length)),
    );
}

/**
 * A custom property being *given a value*: `--x: …` in CSS, or `'--x': …` as a
 * style binding's key. The optional quote is what covers the second case; the
 * closing paren of a `var(--x)` reference is what keeps it from covering reads.
 */
const DECLARATION = /(--[a-zA-Z0-9_-]+)\s*['"]?\s*:/g;

/** A read with no fallback. A comma after the name means a fallback exists. */
const REFERENCE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g;

/** Every custom property `files` declare, by any of the three routes above. */
export function declaredTokens(files: readonly ScannedFile[]): Set<string> {
  const declared = new Set<string>();

  for (const file of files) {
    for (const [, token] of blankComments(file.text).matchAll(DECLARATION)) {
      if (token !== undefined) declared.add(token);
    }
  }

  return declared;
}

/** Every violation in `files`, in the order the files were given. */
export function undefinedTokenViolations(files: readonly ScannedFile[]): TokenViolation[] {
  const declared = declaredTokens(files);
  const violations: TokenViolation[] = [];

  for (const file of files) {
    const code = blankComments(file.text);

    for (const match of code.matchAll(REFERENCE)) {
      const token = match[1];
      if (token === undefined || declared.has(token)) continue;

      const line = code.slice(0, match.index).split('\n').length;
      violations.push({
        where: file.path,
        line,
        token,
        message:
          `${file.path}:${String(line)} reads \`${token}\`, which nothing declares. ` +
          'An undefined custom property does not warn — the whole declaration becomes ' +
          'invalid at computed-value time, so the property silently takes its initial ' +
          'value (a `gap` becomes zero) and the screen looks like the rule was never ' +
          'written. Either declare it, give the read a fallback — `var(' +
          `${token}, …)\` — or state the value literally. ` +
          'The token vocabulary is `packages/web/src/styles/theme.css` and the rule for ' +
          'adding to it is in `docs/design-system.md`: three families and the named ramps, ' +
          'and a name outside them needs a reason written beside it.',
      });
    }
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = undefinedTokenViolations(webSourceFiles());
  for (const violation of violations) process.stderr.write(`${violation.message}\n\n`);
  if (violations.length > 0) {
    process.stderr.write(`${String(violations.length)} undefined custom-property reference(s).\n`);
    process.exitCode = 1;
  }
}
