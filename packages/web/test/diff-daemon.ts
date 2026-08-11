/**
 * A `fetch` that serves `GET /api/runs/:id/diff` the way DeFlowd does, over the
 * committed patch in `test/fixtures/diffs/review.patch`.
 *
 * The patch itself is real: `../scripts/build-diff-fixture.ts` produced it by
 * running the daemon's own `git diff --cached --no-color --no-ext-diff
 * --binary` over a real repository. What is stubbed here is only the *transport*
 * — three scopes of the same run, served as `text/x-patch`, with every request
 * recorded so a spec can assert **which** request the view made, which is what
 * AC1 is about and is invisible to a spec that only checks what rendered.
 *
 * The scoping is done by cutting the patch on its `diff --git ` boundaries with
 * four lines of local string work rather than by calling
 * `../src/lib/patch.ts`'s `splitPatch` — that function is the thing under test
 * next door, and a fixture built with it would agree with it by construction.
 */
import reviewPatch from '../../../test/fixtures/diffs/review.patch?raw';

export const DIFF_RUN = 'run_20260810T090000Z_9f31ab';
export const API_BASE = 'http://127.0.0.1:7777/api';

/** The worktree the run held, as `?worktree=` names it. */
export const WORKTREE = 'run_20260810T090000Z_9f31ab__fix-65207341fbd9';

/** The node the fix ran as, as `?node=` names it. */
export const FIX_NODE = 'fix-65207341fbd9';

/** Every `diff --git` section of the fixture, keyed by the path it ends in. */
function sections(): { path: string; text: string }[] {
  return reviewPatch
    .split(/^(?=diff --git )/m)
    .filter((text) => text.startsWith('diff --git '))
    .map((text) => {
      const header = text.slice(0, text.indexOf('\n'));
      const path = header.slice(header.lastIndexOf(' b/') + 3);
      return { path, text };
    });
}

const only = (...paths: readonly string[]): string =>
  sections()
    .filter((section) => paths.includes(section.path))
    .map((section) => section.text)
    .join('');

/**
 * A generated addition of `lines` lines — the 5,000-line file AC7 is about.
 *
 * Generated rather than committed: a quarter of a megabyte of repository to
 * prove a `>` comparison would be a poor trade, and the *shapes* that need a
 * real git are asserted against a real git's output elsewhere.
 */
export function bigFile(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+export const n${i} = ${i};`).join('\n');
  return (
    `diff --git a/${path} b/${path}\n` +
    'new file mode 100644\n' +
    'index 0000000..1111111\n' +
    '--- /dev/null\n' +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${lines} @@\n${body}\n`
  );
}

export const BIG_FILE = 'src/generated/schema.ts';

/**
 * The three scopes, and what each one contains.
 *
 * `src/date-picker.ts` is in all three — it is the file the recorded `blocker`
 * finding names — and `src/dead-code.ts` is in two of them, which is what makes
 * *"the file selection is preserved where the file exists in the new scope"* a
 * claim with a failing case as well as a passing one.
 */
export const SCOPES = {
  node: () => only('src/date-picker.ts'),
  worktree: () =>
    only(
      'src/api/contract.ts',
      'src/date-picker.ts',
      'src/dead-code.ts',
      'test/days-until.test.ts',
    ),
  cumulative: () => reviewPatch + bigFile(BIG_FILE, 5_000),
} as const;

export interface DiffAsked {
  readonly path: string;
  readonly node: string | null;
  readonly worktree: string | null;
  readonly cumulative: string | null;
}

export function diffFetch(asked: DiffAsked[]) {
  return (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.pathname.endsWith('/diff')) {
      const node = url.searchParams.get('node');
      const worktree = url.searchParams.get('worktree');
      const cumulative = url.searchParams.get('cumulative');
      asked.push({ path: url.pathname, node, worktree, cumulative });

      const patch =
        cumulative !== null
          ? SCOPES.cumulative()
          : worktree !== null
            ? SCOPES.worktree()
            : node !== null
              ? SCOPES.node()
              : '';

      return Promise.resolve(
        new Response(patch, {
          status: 200,
          headers: { 'Content-Type': 'text/x-patch; charset=utf-8' },
        }),
      );
    }

    // Only the diff route is recorded. The shell asks for the approval queue on
    // boot, and a spec asserting on "the last request" would be asserting on
    // that instead of on the one it just triggered.
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}
