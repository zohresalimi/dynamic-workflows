/**
 * KAR-17.7 test plan rows 4 and 5 — the acceptance-criteria board, mounted in
 * the real shell over the `happy-path-12` recording.
 *
 * Verifies: EPIC-17-S28, EPIC-17-S29 · AC1, AC2, AC3, AC4, AC6, AC7, AC8
 *
 * `happy-path-12` carries the board's whole three-state matrix in one
 * recording: `unit-tests-pass` (satisfied, one `typecheck` verdict),
 * `no-v-model-regression` (unverifiable, via a `needs-human` verdict from
 * `contract` carrying two findings) and `manual-visual-check` (unverifiable,
 * `unmapped: true` — the F7.4 spec defect AC4 exists to surface).
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { gateEvaluated, HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { NO_GATE_MESSAGE } from '../lib/criteria-board.ts';
import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

const one = (selector: string): HTMLElement | null =>
  shell.container.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

async function openBoard(query: Record<string, string> = {}): Promise<void> {
  shell = await mountShell({
    at: { name: 'run-criteria', params: { projectId: PROJECT_ID, runId: HAPPY_PATH_RUN }, query },
  });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of happyPath12()) run.applyEvent(event);
  await expect.poll(() => all('[data-criterion-row]').length).toBe(3);
}

/**
 * The same board at its **legacy**, project-less address (KAR-25.1 AC7).
 *
 * Every fixture under `test/fixtures/runs/` is a ledger that starts at
 * `run.created` with no `task.submitted`, so it belongs to no project and
 * `/runs/:runId/criteria` renders in place rather than redirecting — that is
 * the case `createLegacyRunGuard` exists for, and it is also the one an
 * operator with an old bookmark is in.
 */
async function openLegacyBoard(): Promise<void> {
  shell = await mountShell({
    at: { name: 'legacy-run-criteria', params: { runId: HAPPY_PATH_RUN } },
  });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  for (const event of happyPath12()) run.applyEvent(event);
  await expect.poll(() => all('[data-criterion-row]').length).toBe(3);
}

beforeEach(async () => {
  setActivePinia(undefined as never);
  await commands.emulateMedia({ reducedMotion: 'no-preference' });
});

afterEach(() => {
  shell?.unmount();
});

suite('KAR-17.7 test 1 — every criterion, in spec order (AC1)', () => {
  it('lists all three with id, statement and status', async () => {
    await openBoard();

    const rows = all('[data-criterion-row]');
    expect(rows.map((row) => row.dataset['criterionRow'])).toEqual([
      'unit-tests-pass',
      'no-v-model-regression',
      'manual-visual-check',
    ]);
    expect(rows[0]?.textContent).toContain('All existing checkout unit tests pass unmodified.');
    expect(rows[0]?.querySelector('[data-status]')?.getAttribute('data-status')).toBe('satisfied');
  });

  it('shows the header counts and an honest headline (AC7)', async () => {
    await openBoard();

    expect(one('[data-criteria-headline]')?.textContent).toBe(
      '1 of 3 criteria satisfied — 2 unverifiable',
    );
    expect(one('[data-count="satisfied"]')?.textContent).toContain('1');
    expect(one('[data-count="unverifiable"]')?.textContent).toContain('2');
    expect(one('[data-criteria-headline]')?.textContent?.toLowerCase()).not.toContain('done');
    expect(one('[data-criteria-headline]')?.textContent).not.toMatch(/%/);
  });
});

suite('KAR-17.7 test 2 — a criterion with no gate is a spec defect, not a blank row (AC4)', () => {
  it('renders manual-visual-check as unverifiable with the explicit F7.4 message', async () => {
    await openBoard();

    const row = one('[data-criterion-row="manual-visual-check"]');
    expect(row?.querySelector('[data-status]')?.getAttribute('data-status')).toBe('unverifiable');

    await userEvent.click(row?.querySelector('[data-criterion-toggle]') as HTMLElement);

    const detail = one('[data-criterion-detail="manual-visual-check"]');
    expect(detail?.querySelector('[data-no-gate-message]')?.textContent?.trim()).toBe(
      NO_GATE_MESSAGE,
    );
  });
});

suite('KAR-17.7 test 5 — expanding a criterion shows the evidence behind it (AC3)', () => {
  it('lists the gate, its outcome, its summary and its findings with a diff deep link', async () => {
    await openBoard();

    const row = one('[data-criterion-row="no-v-model-regression"]');
    await userEvent.click(row?.querySelector('[data-criterion-toggle]') as HTMLElement);

    const detail = one('[data-criterion-detail="no-v-model-regression"]');
    const evidence = detail?.querySelector('[data-criterion-evidence]');
    expect(evidence?.getAttribute('data-gate')).toBe('contract');
    expect(evidence?.getAttribute('data-outcome')).toBe('needs-human');
    expect(evidence?.querySelector('[data-evidence-summary]')?.textContent).toContain(
      'the contract checker is not installed',
    );

    const findings = detail?.querySelectorAll('[data-evidence-finding]') ?? [];
    expect(findings).toHaveLength(2);

    const first = detail?.querySelector('[data-finding-id="f-contract-1"]');
    expect(first?.querySelector('[data-finding-message]')?.textContent).toContain(
      'the signup response drops `emailVerified`',
    );

    const link = first?.querySelector<HTMLAnchorElement>('[data-diff-link]');
    expect(link?.getAttribute('href')).toContain(`/runs/${HAPPY_PATH_RUN}/diff`);
    expect(link?.getAttribute('href')).toContain('node=impl-signup');
    expect(link?.getAttribute('href')).toContain('file=src/api/contract.ts');
    expect(link?.getAttribute('href')).toContain('line=31');
  });

  it('expands at the legacy address too, and its diff link stays legacy', async () => {
    // The defect: `diffTo` named the project-scoped `run-diff` route and passed
    // it only a `runId`. Resolving a `RouterLink` happens while the detail is
    // rendering, so on a project-less run the whole expansion threw
    // `Missing required param "projectId"` — the criterion never opened, and
    // `e2e/five-minute-diagnosis.test.ts` timed out at "the criterion expanded"
    // rather than saying which link it was. A finding's line is F7.4's
    // "and back again", so this is the operator losing the walk, not a cosmetic
    // href.
    await openLegacyBoard();

    const row = one('[data-criterion-row="no-v-model-regression"]');
    await userEvent.click(row?.querySelector('[data-criterion-toggle]') as HTMLElement);

    const detail = one('[data-criterion-detail="no-v-model-regression"]');
    expect(detail, 'the criterion did not expand at its legacy address').not.toBeNull();

    const link = detail
      ?.querySelector('[data-finding-id="f-contract-1"]')
      ?.querySelector<HTMLAnchorElement>('[data-diff-link]');
    // Legacy in, legacy out: a link that jumped to `/projects/…` from a run
    // that has no project is the same missing param one navigation later.
    expect(link?.getAttribute('href')).toContain(`/runs/${HAPPY_PATH_RUN}/diff`);
    expect(link?.getAttribute('href')).not.toContain('/projects/');
    expect(link?.getAttribute('href')).toContain('node=impl-signup');
  });

  it('collapses again on a second click', async () => {
    await openBoard();

    const toggle = one(
      '[data-criterion-row="no-v-model-regression"] [data-criterion-toggle]',
    ) as HTMLElement;
    await userEvent.click(toggle);
    expect(one('[data-criterion-detail="no-v-model-regression"]')).not.toBeNull();

    await userEvent.click(toggle);
    expect(one('[data-criterion-detail="no-v-model-regression"]')).toBeNull();
  });
});

suite('KAR-17.7 — a deep link into a criterion arrives pre-expanded (EPIC-17-S24)', () => {
  it('opens the named criterion when `?criterion=` is in the URL', async () => {
    await openBoard({ criterion: 'no-v-model-regression' });

    await expect.poll(() => one('[data-criterion-detail="no-v-model-regression"]')).not.toBeNull();
  });
});

suite('KAR-17.7 test 4 — the board updates live, with no refetch (AC6)', () => {
  it('flips a row when a gate.evaluated event arrives, and updates the header counts', async () => {
    await openBoard();

    expect(
      one('[data-criterion-row="no-v-model-regression"] [data-status]')?.getAttribute(
        'data-status',
      ),
    ).toBe('unverifiable');

    const run = useRunStore(shell.pinia);
    run.applyEvent(
      gateEvaluated({
        seq: 900,
        runId: HAPPY_PATH_RUN,
        gate: 'contract',
        gateNode: 'gate-contract',
        evaluatedNode: 'impl-signup',
        outcome: 'pass',
        summary: 'contract checker installed and clean on re-run',
        criteria: [{ id: 'no-v-model-regression', status: 'satisfied' }],
        findings: [],
      }),
    );

    await expect
      .poll(() =>
        one('[data-criterion-row="no-v-model-regression"] [data-status]')?.getAttribute(
          'data-status',
        ),
      )
      .toBe('satisfied');
    expect(one('[data-count="satisfied"]')?.textContent).toContain('2');
    expect(one('[data-count="unverifiable"]')?.textContent).toContain('1');
  });
});

suite('KAR-17.7 test 6/AC8 — copy as markdown', () => {
  it('places the same checklist the table shows onto the clipboard', async () => {
    await commands.grantClipboard();
    await openBoard();

    await userEvent.click(one('[data-copy-markdown]') as HTMLElement);

    await expect.poll(() => navigator.clipboard.readText()).toContain('- [x] **unit-tests-pass**');
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('- [ ] **manual-visual-check**');
    expect(copied).toContain(NO_GATE_MESSAGE);
    expect(one('[data-copy-status]')?.textContent).toMatch(/copied/i);
  });
});
