/**
 * KAR-10.4 — a verdict is scoped to the spec it judged (AC5).
 *
 * `docs/10-verification-gates.md` §5.2, mechanism 1: *"the verdict carries
 * `specHash`. If it does not equal the run's current pinned `specHash`, the
 * verdict is void and the gate is re-run."* The rule has a real cost — a
 * mid-run edit can discard an hour of gate work — and the epic's notes are
 * explicit that the answer is to make the cost **visible**, not to soften the
 * rule by diffing only the criteria that changed. So the board has a third
 * state beside green and blank, and these tests are what stop it collapsing
 * back into two.
 *
 * The second half of this file is EPIC-10-S21's third scenario, which is the
 * same mechanism pointed at the other kind of failure: a board that is green
 * everywhere a gate spoke says *nothing* about a prohibition no gate was asked
 * to check. Security-Recall Divergence is *"invisible to standard monitoring,
 * because the commission-type audit signals stay healthy while the prohibitions
 * rot"* (docs/08-context-and-memory.md §4.3), so a constraint gets a row of its
 * own and that row is only ever decided by a verdict entry that names it.
 *
 * Verifies: EPIC-10-S21 (third scenario), EPIC-10-S22, EPIC-10-S29 (third
 * scenario) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  acceptanceBoard,
  constraintCriteria,
  isVerdictVoid,
  staleGateNodes,
  verdictAgainst,
} from './acceptance-board.ts';
import { CriterionIdSchema, GateIdSchema, NodeIdSchema, ProviderIdSchema } from './ids.ts';
import type { VerdictV2 } from './verdict.ts';

const HASH_A = `sha256-${'a'.repeat(64)}`;
const HASH_B = `sha256-${'b'.repeat(64)}`;

const CRITERIA = [
  { id: CriterionIdSchema.parse('ac-3'), statement: 'All 47 components compile under Vue 3.' },
  { id: CriterionIdSchema.parse('ac-8'), statement: 'No component imports from packages/legacy.' },
];

function verdict(overrides: Partial<VerdictV2> = {}): VerdictV2 {
  return {
    schemaId: 'DeFlow.verdict.v2',
    outcome: 'pass',
    gate: GateIdSchema.parse('review'),
    evaluatedNode: NodeIdSchema.parse('implement'),
    by: { node: NodeIdSchema.parse('gate-review'), provider: 'claude-code', model: 'sonnet' },
    criteria: [{ id: CriterionIdSchema.parse('ac-3'), status: 'satisfied' }],
    findings: [],
    summary: 'AC-3 holds.',
    specHash: HASH_A,
    ...overrides,
  } as VerdictV2;
}

suite('a verdict names the spec it was judged against (AC5)', () => {
  it('stamps the run’s specHash onto the verdict it seals', () => {
    const sealed = verdictAgainst(verdict({ specHash: undefined }), HASH_A);
    expect(sealed.specHash).toBe(HASH_A);
  });

  it('is void when its specHash is not the run’s current one', () => {
    expect(isVerdictVoid(verdict({ specHash: HASH_A }), HASH_B)).toBe(true);
    expect(isVerdictVoid(verdict({ specHash: HASH_A }), HASH_A)).toBe(false);
  });

  /**
   * A verdict that names no spec cannot be shown to have judged this one. It is
   * void rather than trusted: the whole mechanism is that a verdict is only
   * evidence about the contract it cites, and "it did not say" is not a cite.
   */
  it('is void when it names no specHash at all', () => {
    expect(isVerdictVoid(verdict({ specHash: undefined }), HASH_A)).toBe(true);
  });
});

suite('the acceptance board excludes void verdicts (AC5, EPIC-10-S22)', () => {
  it('renders a criterion decided at the current hash as satisfied', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [verdict({ specHash: HASH_A })],
      specHash: HASH_A,
    });

    expect(board.find((row) => row.criterion === 'ac-3')?.status).toBe('satisfied');
    // Nothing has spoken to ac-8 yet, which is blank rather than green.
    expect(board.find((row) => row.criterion === 'ac-8')?.status).toBe('pending');
  });

  /**
   * The scenario the story exists for: not blank, and above all not green.
   */
  it('renders a criterion whose only verdict is stale as re-running, naming both hashes', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [verdict({ specHash: HASH_A })],
      specHash: HASH_B,
    });
    const row = board.find((entry) => entry.criterion === 'ac-3');

    expect(row?.status).toBe('revalidating');
    expect(row?.note).toContain('re-running against the amended spec');
    expect(row?.note).toContain(HASH_A);
    expect(row?.note).toContain(HASH_B);
  });

  it('does not count a void pass toward the satisfied set', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [verdict({ specHash: HASH_A })],
      specHash: HASH_B,
    });
    expect(board.filter((row) => row.status === 'satisfied')).toEqual([]);
  });

  it('re-approving an unchanged spec voids nothing', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [verdict({ specHash: HASH_A })],
      specHash: HASH_A,
    });
    expect(board.find((row) => row.criterion === 'ac-3')?.status).toBe('satisfied');
    expect(staleGateNodes([verdict({ specHash: HASH_A })], HASH_A)).toEqual([]);
  });

  /**
   * The rule is not softened by comparing only the criteria that changed: the
   * reviewer's judgement was formed against a different contract, so *every*
   * criterion it spoke to goes back on the board.
   */
  it('voids every criterion the stale verdict spoke to, not only the edited one', () => {
    const wide = verdict({
      specHash: HASH_A,
      criteria: [
        { id: CriterionIdSchema.parse('ac-3'), status: 'satisfied' },
        { id: CriterionIdSchema.parse('ac-8'), status: 'satisfied' },
      ],
    });
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [wide],
      specHash: HASH_B,
    });

    expect(board.map((row) => row.status)).toEqual(['revalidating', 'revalidating']);
  });

  it('names the gate nodes whose verdicts went stale, so they can be re-scheduled', () => {
    expect(staleGateNodes([verdict({ specHash: HASH_A })], HASH_B)).toEqual(['gate-review']);
  });

  /** A later verdict at the current hash replaces a stale one — the re-run
   * lands, and the row goes green on the strength of the new contract. */
  it('lets a re-run at the current hash decide the row', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [],
      verdicts: [verdict({ specHash: HASH_A }), verdict({ specHash: HASH_B })],
      specHash: HASH_B,
    });

    expect(board.find((row) => row.criterion === 'ac-3')?.status).toBe('satisfied');
    expect(
      staleGateNodes([verdict({ specHash: HASH_A }), verdict({ specHash: HASH_B })], HASH_B),
    ).toEqual([]);
  });
});

// ── EPIC-10-S21, third scenario — a green board is not evidence ──────────────

const PROHIBITION = 'must not change the public API of the shared ui package';
const SECOND_CONSTRAINT = 'run only the commands listed in the allowed-commands set';

/** Every acceptance criterion green, decided by a gate at the hash in force —
 * the "every deterministic gate passes" half of the scenario. */
const ALL_GREEN = verdict({
  criteria: CRITERIA.map((criterion) => ({ id: criterion.id, status: 'satisfied' as const })),
  summary: 'every criterion holds.',
});

suite('a prohibition is checked explicitly, never inferred from green gates (EPIC-10-S21)', () => {
  it('gives every constraint its own criterion, carrying the constraint verbatim', () => {
    const criteria = constraintCriteria([PROHIBITION, SECOND_CONSTRAINT]);

    expect(criteria.map((criterion) => criterion.id)).toEqual(['constraint-1', 'constraint-2']);
    expect(criteria.map((criterion) => criterion.statement)).toEqual([
      PROHIBITION,
      SECOND_CONSTRAINT,
    ]);
  });

  /**
   * The scenario, stated as the board states it: every gate passed, and the
   * constraint's row is *not* satisfied. `pending` and not green is the whole
   * claim — a run that reported it satisfied here would be reporting on the
   * strength of gates that were never asked about it.
   */
  it('leaves the constraint pending while every acceptance criterion is green', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [PROHIBITION],
      verdicts: [ALL_GREEN],
      specHash: HASH_A,
    });

    expect(board.filter((row) => row.criterion.startsWith('ac-')).map((row) => row.status)).toEqual(
      ['satisfied', 'satisfied'],
    );

    const row = board.find((entry) => entry.criterion === 'constraint-1');
    expect(row?.statement).toBe(PROHIBITION);
    expect(row?.status).toBe('pending');
    expect(row?.decidedBy).toBeNull();
  });

  /** A blank row beside two green ones reads as "nobody got to it yet", which
   * is exactly the misreading §4.3 warns about. The row says why. */
  it('says on the row why the green gates are not evidence about it', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [PROHIBITION],
      verdicts: [ALL_GREEN],
      specHash: HASH_A,
    });
    const row = board.find((entry) => entry.criterion === 'constraint-1');

    expect(row?.note).toContain('not evidence that a prohibition was honoured');
    expect(row?.note).toContain('constraint-1');
  });

  /** The other half of the Then: *"the constraint is checked explicitly, with
   * its own criterion and its own verdict entry"*. Only an entry naming the
   * constraint's criterion moves the row — in either direction. */
  it('is decided only by a verdict entry that names the constraint’s criterion', () => {
    const checked = verdict({
      gate: GateIdSchema.parse('public-api-check'),
      by: {
        node: NodeIdSchema.parse('gate-public-api-check'),
        provider: ProviderIdSchema.parse('claude-code'),
        model: 'sonnet',
      },
      outcome: 'fail',
      criteria: [{ id: CriterionIdSchema.parse('constraint-1'), status: 'unsatisfied' }],
      summary: 'the diff removes an export from the shared ui package.',
    });

    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [PROHIBITION],
      verdicts: [ALL_GREEN, checked],
      specHash: HASH_A,
    });
    const row = board.find((entry) => entry.criterion === 'constraint-1');

    expect(row?.status).toBe('unsatisfied');
    expect(row?.decidedBy).toBe('gate-public-api-check');
    expect(row?.note).toBeNull();
  });

  /** Constraint rows are rows: the void rule reaches them exactly as it reaches
   * the criteria, or a spec edit would leave a prohibition green on a verdict
   * formed against a contract that no longer exists. */
  it('voids a constraint’s verdict when the spec moves under it', () => {
    const checked = verdict({
      criteria: [{ id: CriterionIdSchema.parse('constraint-1'), status: 'satisfied' }],
      specHash: HASH_A,
    });

    const board = acceptanceBoard({
      criteria: CRITERIA,
      constraints: [PROHIBITION],
      verdicts: [checked],
      specHash: HASH_B,
    });

    expect(board.find((entry) => entry.criterion === 'constraint-1')?.status).toBe('revalidating');
  });

  /**
   * Two rows with one id is how a constraint quietly inherits somebody else's
   * verdict. Refused rather than resolved: at that point no reader can tell
   * which row a verdict entry spoke to.
   */
  it('refuses a spec whose own criterion id collides with a constraint row', () => {
    expect(() =>
      acceptanceBoard({
        criteria: [
          { id: CriterionIdSchema.parse('constraint-1'), statement: 'a hand-written criterion' },
        ],
        constraints: [PROHIBITION],
        verdicts: [],
        specHash: HASH_A,
      }),
    ).toThrow(/constraint-1/);
  });
});
