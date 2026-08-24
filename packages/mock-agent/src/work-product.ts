/**
 * KAR-23.11 — the built-in turn's **work product**: the file the bundled agent
 * writes when the brief it was handed says it changes files.
 *
 * ## Why this exists
 *
 * Until this module, `deflow-mock-agent`'s unscripted turn was a greeting and
 * the prompt read back — no `fs/write_text_file`, no diff, nothing in the
 * worktree afterwards. So `e2e/smoke/live-run.test.ts`, the one scenario in this
 * repository that runs an operator command all the way to an executed node, was
 * executing an `implement` node that produced nothing and calling it a pass.
 * That is precisely the false success KAR-23.11 exists to catch, and when
 * `contract.no-work-product` shipped it caught it: the smoke test went red, and
 * the fixture rather than the rule was what was wrong.
 *
 * A test double that can never write cannot cover the write path either, and
 * KAR-23.10 had just wired `fs/*` mediation onto the ACP route. So the bundled
 * agent now does the smallest honest thing a real agent does with the same
 * brief: it reads its declared write scope out of the prompt and leaves one file
 * inside it, through the ordinary client method, under DeFlow's own mediation.
 *
 * ## Three rules
 *
 * **It writes only when its own contract says it writes.** The trigger is the
 * pinned path-scope segment `compilePinnedSegments` puts in every agent node's
 * packet (`Declared path scopes (pinned):` followed by one `- write: <glob>`
 * line per glob). A node whose plan declares `pathScopes.write: []` gets
 * *"this node declares no write scope and must not write"* instead, no glob line
 * is parsed, and nothing is written — which is the same early return
 * `auditCompletionScope` makes for a reviewer or a verification node. An agent
 * that wrote regardless would be an agent that ignores its own scope, and every
 * spec built on it would be asserting against a badly-behaved double.
 *
 * **The path is derived from the declared glob**, so the write lands *inside*
 * the scope rather than merely somewhere in the worktree. A write outside it
 * would still satisfy the work-product rule — any change counts — while filing a
 * `node.scope_warning` the scenario never asked for, which would make the smoke
 * run's ledger permanently noisy for a reason nobody could act on.
 *
 * **The bytes are a function of the declared scope and nothing else.** No clock,
 * no randomness, no cwd: the same rule ./structured.ts states for the documents
 * it serves. A work product carrying somebody's `TMPDIR` is a smoke test whose
 * two runs never agree.
 */

/** The basename the built-in turn leaves behind, extension aside. */
export const WORK_PRODUCT_BASENAME = 'deflow-mock-agent-note';

/**
 * The pinned line one declared write glob is rendered as
 * (`packages/core/src/compile-pinned.ts`). Anchored to the line so a glob
 * quoted in some other segment's prose cannot be mistaken for a declaration.
 */
const DECLARED_WRITE_LINE = /^-[ \t]*write:[ \t]*(\S.*?)[ \t]*$/gm;

/** Glob metacharacters, in the `.gitignore` dialect `pathScopeMatches` reads. */
const WILDCARD = /[*?[\]]/;

/**
 * The write globs the prompt declares, in the order the packet stated them.
 *
 * Empty for a prompt with no pinned path-scope segment at all — every turn this
 * binary serves outside a DeFlow node, which is most of its own test suite, and
 * the reason nothing else changes behaviour.
 */
export function declaredWriteGlobs(prompt: string): readonly string[] {
  const globs: string[] = [];
  for (const match of prompt.matchAll(DECLARED_WRITE_LINE)) {
    const glob = match[1];
    // A negation re-includes nothing and cannot be written *into*: it is the
    // last matching pattern that decides, and a path derived from `!dist/**`
    // would be a path the scope excludes.
    if (glob !== undefined && !glob.startsWith('!')) globs.push(glob);
  }
  return globs;
}

/**
 * A worktree-relative path inside `glob`.
 *
 * Three shapes, because `.gitignore` syntax means three different things by a
 * pattern:
 *
 * - a trailing `/` (`dist/`) scopes a directory and everything under it, so the
 *   note goes *in* it;
 * - a pattern with no wildcard at all (`README.md`) names one path, and that
 *   path is the only thing inside the scope, so it is what gets written;
 * - anything else keeps the literal segments before the first wildcard segment
 *   as a directory, and takes its extension from the wildcard segment when that
 *   segment names one (`docs/*.md` → `docs/<basename>.md`) so the derived path
 *   still matches.
 */
export function workProductPath(glob: string): string {
  if (glob.endsWith('/')) return `${glob}${WORK_PRODUCT_BASENAME}.md`;
  if (!WILDCARD.test(glob)) return glob;

  const segments = glob.split('/').filter((segment) => segment !== '' && segment !== '.');
  const directories: string[] = [];
  for (const segment of segments) {
    if (WILDCARD.test(segment)) break;
    directories.push(segment);
  }
  const last = segments.at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  const extension = WILDCARD.test(last) && dot > 0 ? last.slice(dot) : '.md';
  return [...directories, `${WORK_PRODUCT_BASENAME}${extension}`].join('/');
}

/** The note's bytes: a function of the declared scope, and of nothing else. */
export function workProductContent(globs: readonly string[]): string {
  return [
    '# deflow-mock-agent',
    '',
    'This node declared a write scope, so it wrote something. DeFlow records what',
    'a node produced, not what it said it did.',
    '',
    'Declared write scope:',
    ...globs.map((glob) => `- ${glob}`),
    '',
  ].join('\n');
}

/** What the built-in turn should leave behind, or `null` when it must not
 * write at all. */
export function workProductFor(
  prompt: string,
): { readonly path: string; readonly content: string } | null {
  const globs = declaredWriteGlobs(prompt);
  const first = globs[0];
  if (first === undefined) return null;
  return { path: workProductPath(first), content: workProductContent(globs) };
}
