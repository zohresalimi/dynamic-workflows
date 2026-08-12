/**
 * KAR-17.6 test plan rows 3, 4, 5, 6 and 7 — the diff and review surface, in a
 * real Chromium, over a real patch and a real recording.
 *
 * Verifies: EPIC-17-S24 (scenarios 1 and 3), EPIC-17-S25, EPIC-17-S26,
 * EPIC-17-S27 · AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC10
 *
 * The arithmetic is `../lib/review-index.ts`'s and `../lib/patch.ts`'s and is
 * asserted next door without a browser. What is here is the half only a browser
 * can answer, and row 3's red says exactly what that half is:
 *
 * > **Red when: widgets are appended after the hunk.**
 *
 * That is the failure `diff2html` would have shipped: a verdict rendered
 * *somewhere near* the code it is about reads as a summary, and a summary is
 * what this surface exists to replace. So the assertion is positional — the
 * widget's row is the extend row belonging to the line the finding names, and
 * the row above it is that line.
 *
 * The patch is `test/fixtures/diffs/review.patch`, produced by real git with
 * the daemon's own flags; the findings are `gate-failure-repair`'s, a real
 * `tsc` blocker at `src/date-picker.ts:2` against the blob this patch's
 * "before" side is. The two fixtures are the same file on purpose.
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import {
  BIG_FILE,
  DIFF_RUN,
  type DiffAsked,
  diffFetch,
  FIX_NODE,
  API_BASE as ORIGIN,
  WORKTREE,
} from '../../test/diff-daemon.ts';
import { gateEvaluated, gateFailureRepair, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;
let asked: DiffAsked[];

const one = (selector: string): HTMLElement | null =>
  shell.container.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

/** Mounts the diff route for `runId` and folds `events` through the store. */
async function openDiff(
  options: {
    readonly events?: readonly ReturnType<typeof happyPath12>[number][];
    readonly query?: Record<string, string>;
    readonly runId?: string;
  } = {},
): Promise<void> {
  asked = [];
  shell = await mountShell({
    at: {
      name: 'run-diff',
      params: { runId: options.runId ?? DIFF_RUN },
      query: { scope: 'worktree', worktree: WORKTREE, ...options.query },
    },
    client: createClient({ baseUrl: ORIGIN, fetch: diffFetch(asked) }),
  });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of options.events ?? gateFailureRepair()) run.applyEvent(event);
  await expect.poll(() => all('[data-diff-file]').length).toBeGreaterThan(0);
}

/**
 * A finding widget **inside the diff**, by id.
 *
 * Scoped to the panel on purpose: the repair loop pins the *same* finding
 * beside its transition, so an unscoped `[data-review-finding="…"]` answers
 * with whichever of the two the document happens to reach first — and a
 * positional assertion about a line would then be asserting about the pinned
 * copy, which is in no line at all.
 */
const inDiff = (id: string): HTMLElement | null =>
  one(`[data-diff-file] [data-review-finding="${id}"]`);

/** The `<tr>` a widget was rendered into, and the row directly above it. */
function widgetRow(id: string): { row: HTMLElement | null; above: HTMLElement | null } {
  const row = inDiff(id)?.closest('tr') ?? null;
  return { row, above: (row?.previousElementSibling as HTMLElement | null) ?? null };
}

beforeEach(async () => {
  setActivePinia(undefined as never);
  await commands.emulateMedia({ reducedMotion: 'no-preference' });
});

afterEach(async () => {
  shell?.unmount();
  await commands.emulateMedia({ reducedMotion: 'no-preference' });
});

suite('KAR-17.6 test 3 — the finding renders at the line, not after the hunk (AC2)', () => {
  it('puts the widget in the per-line extend slot for the line it names', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    const { row, above } = widgetRow('65207341fbd9');

    // The extend row is `@git-diff-view`'s per-line widget slot. A widget
    // appended after the hunk would not be in one.
    expect(row?.getAttribute('data-state')).toBe('extend');
    // And the row it extends is line 2 — the line the finding names.
    expect(above?.querySelector('[data-line-new-num="2"]')).not.toBeNull();
  });

  it('shows severity, message, the criterion it maps to and the evidence', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });
    const widget = inDiff('65207341fbd9');

    expect(widget?.getAttribute('data-severity')).toBe('blocker');
    expect(widget?.querySelector('[data-severity-label]')?.textContent?.trim()).toBe('blocker');
    expect(widget?.querySelector('[data-finding-message]')?.textContent).toContain(
      "Type 'Date' is not assignable to type 'number'",
    );
    // This recorded finding is a `tsc` diagnostic and carries no criterion.
    // The slot says so rather than rendering an empty chip.
    expect(widget?.querySelector('[data-criterion]')).toBeNull();
    expect(widget?.querySelector('[data-no-criterion]')).not.toBeNull();

    const evidence = widget?.querySelector<HTMLAnchorElement>('[data-evidence]');
    expect(evidence?.getAttribute('href')).toContain('/api/artifacts/');
  });

  it('links every finding back to the gate.evaluated seq that produced it (AC10)', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });
    const widget = inDiff('65207341fbd9');

    expect(widget?.getAttribute('data-seq')).toBe('12');
    expect(widget?.querySelector('[data-seq-link]')?.textContent).toContain('12');
  });

  it('renders a criterion as a link into the acceptance board when there is one', async () => {
    await openDiff({
      events: happyPath12(),
      query: { file: 'src/api/contract.ts' },
      runId: 'run_20260811T090000Z_a1b2c3',
    });

    const widget = inDiff('f-contract-1');
    expect(widget?.querySelector('[data-criterion]')?.textContent).toContain(
      'no-v-model-regression',
    );
  });
});

suite('KAR-17.6 test 4 — severity is a glyph and a label, not a colour (AC4)', () => {
  it('renders all four severities with their own glyph and their own label', async () => {
    await openDiff({
      query: { file: 'src/date-picker.ts' },
      events: [
        ...gateFailureRepair(),
        gateEvaluated({
          seq: 900,
          runId: DIFF_RUN,
          gate: 'review',
          gateNode: 'gate-review',
          evaluatedNode: 'impl-1',
          outcome: 'fail',
          summary: 'four findings, one of each severity',
          findings: (['major', 'minor', 'info'] as const).map((severity, index) => ({
            id: `f-${severity}`,
            severity,
            message: `a ${severity} thing`,
            location: {
              file: 'src/date-picker.ts',
              line: index + 1,
              blobSha: '6d1cddc4a872ba842437d50d4f9c08b6e11cc9b3',
            },
            evidence: [],
          })),
        }),
      ],
    });

    const rendered = all('[data-diff-file] [data-review-finding]');
    const severities = rendered.map((el) => el.getAttribute('data-severity'));
    expect(new Set(severities)).toEqual(new Set(['blocker', 'major', 'minor', 'info']));

    const glyphs = rendered.map((el) =>
      el.querySelector('[data-severity-glyph]')?.textContent?.trim(),
    );
    const labels = rendered.map((el) =>
      el.querySelector('[data-severity-label]')?.textContent?.trim(),
    );
    // Four severities, four glyphs, four labels — the two non-colour signals.
    expect(new Set(glyphs).size).toBe(4);
    expect(new Set(labels)).toEqual(new Set(['blocker', 'major', 'minor', 'info']));
  });
});

suite('KAR-17.6 test 5 — needs-human is not a red file (AC5)', () => {
  it('tones a needs-human file as a judgement call and never as a failure', async () => {
    await openDiff({
      events: happyPath12(),
      query: { file: 'src/api/contract.ts' },
      runId: 'run_20260811T090000Z_a1b2c3',
    });

    const panel = one('[data-diff-file="src/api/contract.ts"]');
    expect(panel?.getAttribute('data-tone')).toBe('judgement');
    expect(panel?.getAttribute('data-tone')).not.toBe('failing');

    const outcome = panel?.querySelector('[data-outcome="needs-human"]');
    expect(outcome?.querySelector('[data-outcome-label]')?.textContent?.trim()).toBe(
      'judgement required',
    );
    expect(outcome?.querySelector('[data-outcome-glyph]')?.textContent?.trim()).not.toBe('');
  });

  it('tones a file a gate actually failed on as failing', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    expect(one('[data-diff-file="src/date-picker.ts"]')?.getAttribute('data-tone')).toBe('failing');
  });

  it('surfaces blockers and majors by default and puts minors and infos behind a disclosure', async () => {
    await openDiff({
      events: happyPath12(),
      query: { file: 'src/api/contract.ts' },
      runId: 'run_20260811T090000Z_a1b2c3',
    });

    // f-contract-1 is major, f-contract-2 is minor.
    expect(inDiff('f-contract-1')?.getAttribute('data-surfaced')).toBe('true');
    expect(inDiff('f-contract-2')?.getAttribute('data-surfaced')).toBe('false');
  });

  it('renders a finding with no location at file level, never on line 1 (AC3)', async () => {
    await openDiff({
      query: { file: 'src/date-picker.ts' },
      events: [
        ...gateFailureRepair(),
        gateEvaluated({
          seq: 901,
          runId: DIFF_RUN,
          gate: 'review',
          gateNode: 'gate-review',
          evaluatedNode: 'impl-1',
          outcome: 'fail',
          summary: 'one judgement about the change as a whole',
          findings: [
            {
              id: 'f-whole-change',
              severity: 'major',
              message: 'no test covers the new branch',
              evidence: [],
            },
          ],
        }),
      ],
    });

    const band = one('[data-review-file-level]');
    const widget = band?.querySelector('[data-review-finding="f-whole-change"]');

    expect(widget, 'the location-less finding was dropped').not.toBeNull();
    // Not in any line slot, and above all in nobody's line 1.
    expect(widget?.closest('tr')).toBeNull();
    expect(widgetRow('f-whole-change').row).toBeNull();
    expect(
      band?.querySelector('[data-review-finding="f-whole-change"]')?.getAttribute('data-line'),
    ).toBeNull();
  });
});

suite('KAR-17.6 — three scopes, one selection (AC1)', () => {
  it('asks for the scope it was told to, with the selector that scope uses', async () => {
    await openDiff({ query: { scope: 'node', node: FIX_NODE } });

    expect(asked.at(-1)?.path).toBe(`/api/runs/${DIFF_RUN}/diff`);
    expect(asked.at(-1)?.node).toBe(FIX_NODE);
    expect(asked.at(-1)?.worktree).toBeNull();
    expect(asked.at(-1)?.cumulative).toBeNull();
  });

  it('switches to the cumulative scope on demand, and says so in the URL', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    await userEvent.click(one('[data-scope="cumulative"]') as HTMLElement);
    await expect.poll(() => asked.at(-1)?.cumulative).toBe('1');

    expect(shell.router.currentRoute.value.query['scope']).toBe('cumulative');
    await expect.poll(() => all('[data-review-file]').length).toBeGreaterThan(3);
  });

  it('keeps the file selection when the file exists in the new scope', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    await userEvent.click(one('[data-scope="cumulative"]') as HTMLElement);
    await expect.poll(() => asked.at(-1)?.cumulative).toBe('1');

    await expect
      .poll(() => one('[data-review-file][aria-current="true"]')?.getAttribute('data-review-file'))
      .toBe('src/date-picker.ts');
  });

  it('falls back to the first file when the selection does not exist in the new scope', async () => {
    // Both selectors travel in the URL; the scope is what picks between them.
    await openDiff({ query: { file: 'src/dead-code.ts', node: FIX_NODE } });
    await expect
      .poll(() => one('[data-review-file][aria-current="true"]')?.getAttribute('data-review-file'))
      .toBe('src/dead-code.ts');

    // The per-node scope holds `src/date-picker.ts` alone.
    await userEvent.click(one('[data-scope="node"]') as HTMLElement);
    await expect.poll(() => asked.at(-1)?.node).not.toBeNull();

    await expect
      .poll(() => one('[data-review-file][aria-current="true"]')?.getAttribute('data-review-file'))
      .toBe('src/date-picker.ts');
  });

  it('attaches a finding to the file it names even when another node earned it', async () => {
    // The blocker was reported against `impl-1`; the diff on screen is the fix
    // node's worktree. The finding still belongs to the file it names.
    await openDiff({ query: { scope: 'node', node: FIX_NODE } });

    expect(inDiff('65207341fbd9')?.getAttribute('data-node')).toBe('impl-1');
  });
});

suite('KAR-17.6 test 7 — a large file does not freeze the tab (AC7)', () => {
  it('renders a 5,000-line file collapsed, with an explicit expand', async () => {
    await openDiff({ query: { scope: 'cumulative', cumulative: '1', file: BIG_FILE } });

    const panel = one(`[data-diff-file="${CSS.escape(BIG_FILE)}"]`);
    expect(panel?.getAttribute('data-collapsed')).toBe('true');
    expect(panel?.querySelector('[data-expand]')).not.toBeNull();
    // Nothing of the file's body is in the DOM until it is asked for.
    expect(panel?.querySelectorAll('tr').length ?? 0).toBe(0);
  });

  it('expands it on demand, and virtualises rather than drawing every line', async () => {
    await openDiff({ query: { scope: 'cumulative', cumulative: '1', file: BIG_FILE } });

    const panel = one(`[data-diff-file="${CSS.escape(BIG_FILE)}"]`) as HTMLElement;
    await userEvent.click(panel.querySelector('[data-expand]') as HTMLElement);

    await expect.poll(() => panel.getAttribute('data-collapsed')).toBe('false');
    await expect.poll(() => panel.querySelectorAll('tr').length).toBeGreaterThan(0);
    // Virtualised: a fraction of five thousand rows, not all of them.
    expect(panel.querySelectorAll('tr').length).toBeLessThan(5_000);
  });

  it('says how big it is before it is opened, so expanding is an informed click', async () => {
    await openDiff({ query: { scope: 'cumulative', cumulative: '1', file: BIG_FILE } });

    const panel = one(`[data-diff-file="${CSS.escape(BIG_FILE)}"]`);
    expect(panel?.querySelector('[data-changed-lines]')?.textContent).toContain('5,000');
  });
});

suite('KAR-17.6 test 6 — the repair loop, made legible at a glance (AC6)', () => {
  it('renders the before → after of the repaired file as a magic-move transition', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    const loop = one('[data-repair-loop]');
    expect(loop?.getAttribute('data-repair-node')).toBe('impl-1');
    expect(loop?.getAttribute('data-repair-fix-node')).toBe('fix-65207341fbd9');
    expect(loop?.querySelector('[data-magic-move]')).not.toBeNull();
    // Token-level: the transition is rendered from Shiki tokens, so there are
    // spans to move rather than two blocks of text to cross-fade.
    await expect
      .poll(() => loop?.querySelectorAll('[data-magic-move] .shiki-magic-move-item').length ?? 0)
      .toBeGreaterThan(0);
  });

  it('pins the failing finding beside it', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    const pinned = one('[data-repair-loop] [data-repair-finding]');
    expect(pinned?.getAttribute('data-repair-finding')).toBe('65207341fbd9');
    expect(pinned?.textContent).toContain("Type 'Date' is not assignable to type 'number'");
  });

  it('shows the attempt count and the cap', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    expect(one('[data-repair-attempts]')?.getAttribute('data-repair-attempts')).toBe('2');
    expect(one('[data-repair-attempts]')?.getAttribute('data-repair-cap')).toBe('3');
    expect(one('[data-repair-loop]')?.getAttribute('data-repair-escalated')).toBe('false');
  });

  it('does not animate under prefers-reduced-motion, and shows before and after side by side', async () => {
    await commands.emulateMedia({ reducedMotion: 'reduce' });
    await openDiff({ query: { file: 'src/date-picker.ts' } });

    const loop = one('[data-repair-loop]');
    expect(loop?.getAttribute('data-animated')).toBe('false');
    expect(loop?.querySelector('[data-magic-move]')).toBeNull();
    expect(loop?.querySelector('[data-side-by-side] [data-side="before"]')).not.toBeNull();
    expect(loop?.querySelector('[data-side-by-side] [data-side="after"]')).not.toBeNull();
  });

  it('keeps the same element across the transition, so scroll position survives', async () => {
    await openDiff({ query: { file: 'src/date-picker.ts' } });
    await expect.poll(() => one('[data-magic-move]')).not.toBeNull();

    const before = one('[data-magic-move]');
    (before as HTMLElement).scrollLeft = 24;

    await userEvent.click(one('[data-repair-replay]') as HTMLElement);
    await expect
      .poll(() => one('[data-repair-loop]')?.getAttribute('data-repair-replays'))
      .toBe('1');

    // The same DOM node, not a re-mounted one: a transition that re-mounts
    // throws the scroll position away, which is the row's stated red.
    expect(one('[data-magic-move]')).toBe(before);
    expect((one('[data-magic-move]') as HTMLElement).scrollLeft).toBe(24);
  });
});
