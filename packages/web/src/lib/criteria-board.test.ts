/**
 * KAR-17.7 test plan rows 1, 2 and 6 — the criterion → gate join and the
 * copy-as-markdown export, over real recordings and one built envelope.
 *
 * Verifies: EPIC-17-S28, EPIC-17-S29 · AC1, AC2, AC4, AC5, AC7, AC8
 *
 * `happy-path-12` carries the three-state matrix this join exists for in one
 * recording: `unit-tests-pass` (satisfied), `no-v-model-regression`
 * (unverifiable, via a `needs-human` verdict) and `manual-visual-check`
 * (unverifiable, `unmapped: true` — no gate has ever spoken to it).
 * `gate-failure-repair` carries the real non-conflict: one gate, `typecheck`,
 * correcting itself across two attempts. Neither recording has two *different*
 * gates disagreeing about the same criterion — nothing DeFlow has run has
 * produced that yet — so the conflict case is built as an envelope and read
 * back through `parseEvent`, exactly as `../lib/review-index.test.ts` does for
 * its own two unrecorded cells.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  GATE_REPAIR_RUN,
  gateEvaluated,
  gateFailureRepair,
  HAPPY_PATH_RUN,
  happyPath12,
} from '../../test/fixture-events.ts';
import { applyGates, emptyGates, type GatesProjection } from '../ledger/projections/gates.ts';
import {
  type CriteriaBoardVM,
  criteriaBoard,
  criteriaMarkdown,
  NO_GATE_MESSAGE,
} from './criteria-board.ts';

function fold(events: readonly ReturnType<typeof happyPath12>[number][]): GatesProjection {
  const state = emptyGates();
  for (const event of events) applyGates(state, event);
  return state;
}

const happy = (): CriteriaBoardVM => criteriaBoard(fold(happyPath12()));
const repair = (): CriteriaBoardVM => criteriaBoard(fold(gateFailureRepair()));

suite('KAR-17.7 test 1 — every criterion, in spec order, with id and text (AC1)', () => {
  it('lists all three of the happy-path spec, in the order the TaskSpec declared them', () => {
    const board = happy();

    expect(board.rows.map((row) => row.id)).toEqual([
      'unit-tests-pass',
      'no-v-model-regression',
      'manual-visual-check',
    ]);
    expect(board.rows[0]?.statement).toBe('All existing checkout unit tests pass unmodified.');
    expect(board.total).toBe(3);
  });

  it('gives each a status in the three-value set, never a fourth', () => {
    const board = happy();

    expect(board.rows.map((row) => row.status)).toEqual([
      'satisfied',
      'unverifiable',
      'unverifiable',
    ]);
  });
});

suite('KAR-17.7 test 2 — unmapped criteria are not dropped (AC4)', () => {
  it('keeps a criterion no gate ever spoke to, as unverifiable rather than a blank row', () => {
    const manual = happy().rows.find((row) => row.id === 'manual-visual-check');

    expect(manual).toBeDefined();
    expect(manual?.status).toBe('unverifiable');
    expect(manual?.unmapped).toBe(true);
    expect(manual?.evidence).toEqual([]);
  });

  it('carries the exact F7.4 message the board and the export both read', () => {
    // One string, read by both — a defect message that drifted between the
    // component and the export would be the same failure mode this whole
    // module exists to prevent for the criterion→gate join itself.
    expect(NO_GATE_MESSAGE).toBe('no gate maps to this criterion — spec defect (F7.4)');
  });
});

suite('KAR-17.7 test 2 — conflicting verdicts (AC5)', () => {
  it('does not flag a repair loop — one gate correcting itself — as a conflict', () => {
    // Real recording: `typecheck` alone judged `ac-1` twice, `unsatisfied`
    // then `satisfied`. That is the ordinary repair loop, not a conflict.
    const row = repair().rows.find((one) => one.id === 'ac-1');

    expect(row?.status).toBe('satisfied');
    expect(row?.conflict).toBe(false);
    expect(row?.evidence.map((one) => one.status)).toEqual(['unsatisfied', 'satisfied']);
  });

  it('flags two different gates disagreeing about the same criterion', () => {
    const events = [
      ...happyPath12(),
      gateEvaluated({
        seq: 900,
        runId: HAPPY_PATH_RUN,
        gate: 'review-a',
        gateNode: 'gate-review-a',
        evaluatedNode: 'impl-signup',
        outcome: 'pass',
        summary: 'review-a says this is fine',
        criteria: [{ id: 'conflict-check', status: 'satisfied' }],
        findings: [],
      }),
      gateEvaluated({
        seq: 901,
        runId: HAPPY_PATH_RUN,
        gate: 'review-b',
        gateNode: 'gate-review-b',
        evaluatedNode: 'impl-signup',
        outcome: 'fail',
        summary: 'review-b disagrees',
        criteria: [{ id: 'conflict-check', status: 'unsatisfied' }],
        findings: [],
      }),
    ];
    const board = criteriaBoard(fold(events));
    const row = board.rows.find((one) => one.id === 'conflict-check');

    // The most recent verdict wins the headline (review-b, seq 901)...
    expect(row?.status).toBe('unsatisfied');
    // ...and the disagreement is surfaced rather than silently resolved.
    expect(row?.conflict).toBe(true);
    expect(row?.gates).toEqual(['review-a', 'review-b']);
  });
});

suite('KAR-17.7 test 1 — the evidence behind a criterion (AC3 join)', () => {
  it('joins every verdict that spoke to it, each with its findings for that criterion', () => {
    const row = happy().rows.find((one) => one.id === 'no-v-model-regression');

    expect(row?.evidence).toHaveLength(1);
    expect(row?.evidence[0]?.gate).toBe('contract');
    expect(row?.evidence[0]?.outcome).toBe('needs-human');
    expect(row?.evidence[0]?.summary).toBe('the contract checker is not installed');
    expect(row?.evidence[0]?.findings.map((finding) => finding.id)).toEqual([
      'f-contract-1',
      'f-contract-2',
    ]);
  });
});

suite('KAR-17.7 — the headline never claims done while anything is unverifiable (AC7)', () => {
  it('counts by status and never says "done" or a percentage while unverifiable > 0', () => {
    const board = happy();

    expect(board.counts).toEqual({ satisfied: 1, unsatisfied: 0, unverifiable: 2 });
    expect(board.headline.toLowerCase()).not.toContain('done');
    expect(board.headline).not.toMatch(/%/);
    expect(board.headline).toBe('1 of 3 criteria satisfied — 2 unverifiable');
  });

  it('says so plainly once everything is satisfied', () => {
    const board = repair();

    expect(board.counts).toEqual({ satisfied: 1, unsatisfied: 0, unverifiable: 0 });
    expect(board.headline).toBe('all 1 criteria satisfied');
  });
});

suite('KAR-17.7 test 6 — copy-as-markdown output (AC8)', () => {
  it('renders a PR-ready checklist that matches the table, not a second derivation', () => {
    const markdown = criteriaMarkdown(happy());

    expect(markdown).toBe(
      [
        '_1 of 3 criteria satisfied — 2 unverifiable_',
        '',
        '- [x] **unit-tests-pass** — All existing checkout unit tests pass unmodified.',
        '- [ ] **no-v-model-regression** — No v-model modifier is silently dropped by the codemod. — unverifiable',
        '- [ ] **manual-visual-check** — The checkout flow renders identically in a manual pass. — ' +
          `unverifiable (${NO_GATE_MESSAGE})`,
      ].join('\n'),
    );
  });

  it('marks a conflict in the export, so a reader of the PR body sees it too', () => {
    const events = [
      ...gateFailureRepair(),
      gateEvaluated({
        seq: 900,
        runId: GATE_REPAIR_RUN,
        gate: 'security-review',
        gateNode: 'gate-security',
        evaluatedNode: 'impl-1',
        outcome: 'fail',
        summary: 'security disagrees with typecheck',
        criteria: [{ id: 'ac-1', status: 'unsatisfied' }],
        findings: [],
      }),
    ];
    const markdown = criteriaMarkdown(criteriaBoard(fold(events)));

    expect(markdown).toContain('conflicting verdicts');
  });
});

suite('AC11 — an unmapped-only board is not "no acceptance criteria"', () => {
  it('reports the empty case honestly when a run has no criteria at all', () => {
    expect(criteriaBoard(emptyGates()).headline).toBe('no acceptance criteria recorded');
  });
});
