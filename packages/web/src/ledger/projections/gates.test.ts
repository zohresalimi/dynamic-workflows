/**
 * KAR-16.3 — `gates.ts`, the F7.3 / F7.4 / F10.8 projection.
 *
 * Verifies: EPIC-16-S19 · AC7
 *
 * The repair-loop assertions run over `gate-failure-repair`, which is a
 * **recording**: a real `tsc` behind a real gate definition failed, a real fix
 * node wrote a failing test and then the fix, and the gate set re-ran from the
 * deterministic tier and passed. The three-state and `needs-human` assertions
 * run over `happy-path-12`, which is the fixture that has a gate whose own
 * tooling is missing.
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyGates, emptyGates, type GatesProjection } from './gates.ts';

const repair = (): GatesProjection => fold('gate-failure-repair', emptyGates, applyGates);
const happy = (): GatesProjection => fold('happy-path-12', emptyGates, applyGates);

suite('EPIC-16-S19 — reducing the gate-fail-repair fixture', () => {
  it('contributes one verdict per gate.evaluated, with a typed outcome', () => {
    const verdicts = repair().verdicts;

    expect(verdicts.map((one) => one.outcome)).toEqual(['fail', 'pass']);
    expect(verdicts.map((one) => one.gate)).toEqual(['typecheck', 'typecheck']);
    expect(verdicts.map((one) => one.evaluatedNode)).toEqual(['impl-1', 'fix-65207341fbd9']);
  });

  it('carries each finding’s severity, criterion, location and evidence handles', () => {
    const [failed] = repair().verdicts;
    const finding = failed?.findings[0];

    expect(finding?.severity).toBe('blocker');
    // `criterion` is optional on a `Finding`, and this recorded one does not
    // carry it — a `tsc` diagnostic is about a line, not about an acceptance
    // criterion. Absent reads as `null` rather than `undefined`, so a template
    // that renders it does not have to know which flavour of nothing it got.
    expect(finding?.criterion).toBeNull();
    expect(happy().verdicts[1]?.findings[0]?.criterion).toBe('no-v-model-regression');
    expect(finding?.location).toEqual({
      file: 'src/date-picker.ts',
      line: 2,
      endLine: null,
      blobSha: '6d1cddc4a872ba842437d50d4f9c08b6e11cc9b3',
    });
    expect(finding?.evidence).toHaveLength(1);
  });

  it('indexes findings by file and orders them by line, so a diff can attach them', () => {
    const byFile = happy().findingsByFile;
    const contract = byFile.get('src/api/contract.ts') ?? [];

    expect([...byFile.keys()]).toEqual(['src/api/contract.ts']);
    expect(contract.map((one) => one.location?.line)).toEqual([12, 31]);
  });

  it('exposes the attempt sequence per evaluated node, so the loop is legible', () => {
    const attempts = repair().attemptsByNode;

    // Attempt 1 failing, a surgical fix node, attempt 2 passing — read off the
    // projection alone, with no join back into the plan.
    expect(attempts.get('impl-1')?.map((one) => one.outcome)).toEqual(['fail']);
    expect(attempts.get('fix-65207341fbd9')?.map((one) => one.outcome)).toEqual(['pass']);
  });
});

suite('EPIC-16-S19 — three criterion states, not two (AC7)', () => {
  it('keeps unverifiable as a distinct third state, never folded into unsatisfied', () => {
    const criteria = happy().criteria;

    expect(criteria.get('no-v-model-regression')?.status).toBe('unverifiable');
    expect(criteria.get('no-v-model-regression')?.status).not.toBe('unsatisfied');
    expect(criteria.get('unit-tests-pass')?.status).toBe('satisfied');
  });

  it('surfaces a criterion no gate ever spoke to as unverifiable — a spec defect', () => {
    const manual = happy().criteria.get('manual-visual-check');

    // F7.4 requires every criterion to map to at least one gate. This one does
    // not, and the board says so as data rather than by omitting the row.
    expect(manual?.status).toBe('unverifiable');
    expect(manual?.unmapped).toBe(true);
    expect(manual?.gates).toEqual([]);
  });

  it('lets a later verdict correct an earlier one, which is what a repair loop is', () => {
    const criterion = repair().criteria.get('ac-1');

    expect(criterion?.status).toBe('satisfied');
    expect(criterion?.gates).toEqual(['typecheck']);
  });

  it('carries the criterion’s statement from the spec, not just its id', () => {
    expect(happy().criteria.get('manual-visual-check')?.statement).toBe(
      'The checkout flow renders identically in a manual pass.',
    );
  });
});

suite('EPIC-16-S19 — needs-human is an outcome, not a failure mode (AC7)', () => {
  it('does not fold a needs-human verdict into fail', () => {
    const contract = happy().verdicts.find((one) => one.gate === 'contract');

    expect(contract?.outcome).toBe('needs-human');
    expect(contract?.outcome).not.toBe('fail');
  });

  it('keeps it out of the repair loop’s failure count', () => {
    const state = happy();

    // One `needs-human` and one `pass` in this fixture, and zero failures. A
    // projection that counted the escalation as a failure would send work into
    // a loop no amount of repair will fix (docs/04 §7).
    expect(state.failureCount).toBe(0);
    expect(state.needsHumanCount).toBe(1);
    expect(repair().failureCount).toBe(1);
  });

  it('records the escalation the operator was asked to answer, and their answer', () => {
    const state = happy();

    expect(state.escalations.map((one) => one.node)).toEqual(['review-security']);
    expect(state.escalations[0]?.answeredWith).toBe('proceed');
    expect(state.escalations[0]?.answeredBy).toBe('operator');
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = happy();
    const before = structuredClone(state);

    expect(() => {
      applyGates(state, unknownKind(9_100, ledger('happy-path-12')[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
