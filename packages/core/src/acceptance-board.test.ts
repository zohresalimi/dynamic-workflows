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
 * Verifies: EPIC-10-S22, EPIC-10-S29 (third scenario) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  acceptanceBoard,
  isVerdictVoid,
  staleGateNodes,
  verdictAgainst,
} from './acceptance-board.ts';
import { CriterionIdSchema, GateIdSchema, NodeIdSchema } from './ids.ts';
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
      verdicts: [verdict({ specHash: HASH_A })],
      specHash: HASH_B,
    });
    expect(board.filter((row) => row.status === 'satisfied')).toEqual([]);
  });

  it('re-approving an unchanged spec voids nothing', () => {
    const board = acceptanceBoard({
      criteria: CRITERIA,
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
    const board = acceptanceBoard({ criteria: CRITERIA, verdicts: [wide], specHash: HASH_B });

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
      verdicts: [verdict({ specHash: HASH_A }), verdict({ specHash: HASH_B })],
      specHash: HASH_B,
    });

    expect(board.find((row) => row.criterion === 'ac-3')?.status).toBe('satisfied');
    expect(
      staleGateNodes([verdict({ specHash: HASH_A }), verdict({ specHash: HASH_B })], HASH_B),
    ).toEqual([]);
  });
});
