/**
 * KAR-17.6 test plan row 1 — the findings-to-line index, and the vocabulary the
 * review surface encodes a verdict with.
 *
 * Verifies: EPIC-17-S24 (scenario 1, the index half), EPIC-17-S25, EPIC-17-S27
 * (scenario 2) · AC2, AC3, AC4, AC5, AC6, AC10
 *
 * `Red when: location-less findings land on line 1.` That is the whole reason
 * this module exists as a module rather than as a `groupBy` inside a template.
 * The naive index is a `Map<number, Finding[]>` keyed on
 * `finding.location?.line ?? 1`, it type-checks, it renders, and it is silently
 * misleading in exactly the way this surface exists to prevent — *"this change
 * does the wrong thing"* pinned to whatever happens to occupy the first line of
 * a file it was never about.
 *
 * Two recordings carry most of it. `gate-failure-repair` is a real `tsc`
 * failing with a `blocker` at `src/date-picker.ts:2` and a real fix node making
 * it pass, and `happy-path-12` is the only ledger with a `needs-human` verdict
 * — a gate whose own tooling is missing, which is the case AC5 is about. The
 * `info` severity and the location-less finding have no recording (see
 * `../../test/fixture-events.ts`) and are built as envelopes and read back
 * through `parseEvent`.
 */
import { DEFAULT_NO_PROGRESS_POLICY } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { gateEvaluated, gateFailureRepair, happyPath12 } from '../../test/fixture-events.ts';
import { applyGates, emptyGates, type GatesProjection } from '../ledger/projections/gates.ts';
import {
  diffPointers,
  FINDING_SEVERITY_ORDER,
  OUTCOME_STYLE,
  repairLoops,
  reviewIndex,
  SEVERITY_STYLE,
  worstSeverity,
} from './review-index.ts';

function fold(events: readonly ReturnType<typeof happyPath12>[number][]): GatesProjection {
  const state = emptyGates();
  for (const event of events) applyGates(state, event);
  return state;
}

const repair = (): GatesProjection => fold(gateFailureRepair());
const happy = (): GatesProjection => fold(happyPath12());

/** The `info` finding and the location-less one, appended to `happy-path-12`. */
const withEdgeCases = (): GatesProjection =>
  fold([
    ...happyPath12(),
    gateEvaluated({
      seq: 900,
      gate: 'review',
      gateNode: 'gate-review',
      evaluatedNode: 'impl-signup',
      outcome: 'fail',
      summary: 'the reviewer found one thing about the change as a whole',
      findings: [
        {
          id: 'f-whole-change',
          severity: 'major',
          message: 'no test covers the new branch',
          evidence: [],
        },
        {
          id: 'f-nit',
          severity: 'info',
          message: 'this file is now the longest in the package',
          location: {
            file: 'src/api/contract.ts',
            line: 12,
            blobSha: '58e86c7830ce6cb4c09ecca8103ea0a6505444aa',
          },
          evidence: [],
        },
      ],
    }),
  ]);

suite('KAR-17.6 test 1 — findings grouped by file and ordered by line (AC2)', () => {
  it('indexes the recorded findings under the file they name, ascending by line', () => {
    const index = reviewIndex(happy());

    expect(index.files.map((file) => file.file)).toEqual(['src/api/contract.ts']);
    expect(index.files[0]?.lines.map((line) => line.line)).toEqual([12, 31]);
    expect(index.files[0]?.lines[0]?.findings.map((one) => one.id)).toEqual(['f-contract-2']);
    expect(index.files[0]?.lines[1]?.findings.map((one) => one.id)).toEqual(['f-contract-1']);
  });

  it('answers by line number, which is what a per-line widget slot asks it', () => {
    const file = reviewIndex(repair()).files[0];

    expect(file?.file).toBe('src/date-picker.ts');
    expect(file?.byLine.get(2)?.map((one) => one.severity)).toEqual(['blocker']);
    expect(file?.byLine.get(1)).toBeUndefined();
    expect(file?.byLine.get(3)).toBeUndefined();
  });

  it('sorts the files by path, so the file list is stable across reloads', () => {
    const index = reviewIndex(withEdgeCases());

    expect(index.files.map((file) => file.file)).toEqual(
      [...index.files.map((f) => f.file)].sort(),
    );
  });
});

suite('KAR-17.6 test 1 — a finding with no location is not a finding on line 1 (AC3)', () => {
  it('keeps it in a bucket of its own rather than dropping it', () => {
    const index = withEdgeCases();

    expect(reviewIndex(index).unlocated.map((one) => one.id)).toEqual(['f-whole-change']);
  });

  it('never lets it reach line 1 of any file', () => {
    const index = reviewIndex(withEdgeCases());

    for (const file of index.files) {
      expect(file.byLine.get(1) ?? [], `${file.file} line 1`).toEqual([]);
      for (const line of file.lines) {
        for (const finding of line.findings) expect(finding.location).not.toBeNull();
      }
    }
  });

  it('counts it, so a header that says "3 findings" is not quietly saying two', () => {
    const index = reviewIndex(withEdgeCases());
    const located = index.files.flatMap((file) => file.lines.flatMap((line) => line.findings));

    expect(index.total).toBe(located.length + index.unlocated.length);
    expect(index.total).toBe(4);
  });
});

suite('KAR-17.6 — every finding carries the verdict that produced it (AC10)', () => {
  it('stamps each finding with the gate.evaluated seq, so it links back', () => {
    const finding = reviewIndex(repair()).files[0]?.lines[0]?.findings[0];

    // seq 12 is the `gate.evaluated` the recording wrote the failure at.
    expect(finding?.seq).toBe(12);
    expect(finding?.gate).toBe('typecheck');
  });

  it('joins the verdict outcome and the node judged onto the finding', () => {
    const finding = reviewIndex(happy()).files[0]?.lines[0]?.findings[0];

    expect(finding?.outcome).toBe('needs-human');
    expect(finding?.evaluatedNode).toBe('impl-signup');
  });

  it('keeps the evidence handles the finding was written with', () => {
    const finding = reviewIndex(repair()).files[0]?.lines[0]?.findings[0];

    expect(finding?.evidence).toHaveLength(1);
    expect(finding?.evidence[0]).toMatch(/^artifact:\/\//);
  });
});

suite('KAR-17.6 test 4 — severity is a glyph and a label, not only a colour (AC4)', () => {
  it('gives all four severities their own glyph', () => {
    const glyphs = FINDING_SEVERITY_ORDER.map((severity) => SEVERITY_STYLE[severity].glyph);

    expect(FINDING_SEVERITY_ORDER).toEqual(['blocker', 'major', 'minor', 'info']);
    expect(new Set(glyphs).size).toBe(4);
  });

  it('gives all four severities their own label, and the label is the word itself', () => {
    for (const severity of FINDING_SEVERITY_ORDER) {
      expect(SEVERITY_STYLE[severity].label.toLowerCase()).toBe(severity);
    }
  });

  it('ranks them so a file can report its worst without the caller ordering them', () => {
    expect(worstSeverity(['info', 'blocker', 'minor'])).toBe('blocker');
    expect(worstSeverity(['minor', 'info'])).toBe('minor');
    expect(worstSeverity([])).toBeNull();
  });

  it('reports the worst severity per file, which is what the file list badges', () => {
    expect(reviewIndex(repair()).files[0]?.worst).toBe('blocker');
    // major beats the minor beside it on the same file.
    expect(reviewIndex(happy()).files[0]?.worst).toBe('major');
  });
});

suite('KAR-17.6 test 5 — needs-human is not a red file (AC5)', () => {
  it('gives the three outcomes three glyphs and three labels', () => {
    const outcomes = ['pass', 'fail', 'needs-human'] as const;

    expect(new Set(outcomes.map((one) => OUTCOME_STYLE[one].glyph)).size).toBe(3);
    expect(new Set(outcomes.map((one) => OUTCOME_STYLE[one].label)).size).toBe(3);
  });

  it('tones needs-human as a judgement call and never as a failure', () => {
    expect(OUTCOME_STYLE['needs-human'].tone).toBe('judgement');
    expect(OUTCOME_STYLE['needs-human'].tone).not.toBe(OUTCOME_STYLE.fail.tone);
    expect(OUTCOME_STYLE.fail.tone).toBe('failing');
    expect(OUTCOME_STYLE.pass.tone).toBe('clean');
  });

  it('does not colour a file red when the only verdict against it was needs-human', () => {
    // `happy-path-12`'s contract gate returned needs-human because the checker
    // is not installed. The work is not wrong; nobody has judged it.
    const file = reviewIndex(happy()).files[0];

    expect(file?.tone).toBe('judgement');
    expect(file?.tone).not.toBe('failing');
    expect(file?.outcomes).toEqual(['needs-human']);
  });

  it('does colour a file failing when a gate actually failed against it', () => {
    expect(reviewIndex(repair()).files[0]?.tone).toBe('failing');
  });

  it('prefers failing over judgement when both spoke to the same file', () => {
    // The appended `review` gate *failed* on `src/api/contract.ts` while the
    // contract gate only asked for a human. A file with a real failure in it is
    // red, and the judgement call is still listed beside it.
    const file = reviewIndex(withEdgeCases()).files[0];

    expect(file?.tone).toBe('failing');
    expect(file?.outcomes).toEqual(['fail', 'needs-human']);
  });
});

suite('KAR-17.6 test 6 — the repair loop, as a pair of states (AC6)', () => {
  it('pairs the verdict that failed with the one that passed after it', () => {
    const [loop, ...rest] = repairLoops(repair());

    expect(rest).toEqual([]);
    expect(loop?.gate).toBe('typecheck');
    expect(loop?.failing.seq).toBe(12);
    expect(loop?.repaired?.seq).toBe(29);
    expect(loop?.repaired?.outcome).toBe('pass');
  });

  it('names the node whose work failed and the node the fix ran as', () => {
    const loop = repairLoops(repair())[0];

    expect(loop?.failedNode).toBe('impl-1');
    expect(loop?.fixNode).toBe('fix-65207341fbd9');
  });

  it('pins the failing finding and the file the transition is about', () => {
    const loop = repairLoops(repair())[0];

    expect(loop?.finding?.id).toBe('65207341fbd9');
    expect(loop?.finding?.severity).toBe('blocker');
    expect(loop?.file).toBe('src/date-picker.ts');
  });

  it('reports the attempt count against F7.5’s cap, read from the policy', () => {
    const loop = repairLoops(repair())[0];

    expect(loop?.attempts).toBe(2);
    expect(loop?.cap).toBe(DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode);
    expect(loop?.escalated).toBe(false);
  });

  it('marks a loop that spent its cap and never passed as escalated, not as a fix-agent failure', () => {
    const exhausted = fold([
      ...gateFailureRepair().filter((event) => event.seq <= 12),
      ...[2, 3].map((attempt) =>
        gateEvaluated({
          seq: 100 + attempt,
          runId: 'run_20260810T090000Z_9f31ab',
          gate: 'typecheck',
          gateNode: `gate-typecheck-r${attempt}`,
          evaluatedNode: `fix-65207341fbd9-${attempt}`,
          outcome: 'fail',
          attempt,
          summary: 'typecheck failed with 1 finding(s)',
          findings: [
            {
              id: '65207341fbd9',
              severity: 'blocker',
              message: "ts2322: Type 'Date' is not assignable to type 'number'.",
              location: {
                file: 'src/date-picker.ts',
                line: 2,
                blobSha: '6d1cddc4a872ba842437d50d4f9c08b6e11cc9b3',
              },
              evidence: [],
            },
          ],
        }),
      ),
    ]);

    const loop = repairLoops(exhausted)[0];

    expect(loop?.attempts).toBe(DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode);
    expect(loop?.repaired).toBeNull();
    expect(loop?.escalated).toBe(true);
  });

  it('reports no loop at all for a run whose gates only ever passed', () => {
    const clean = fold(happyPath12().filter((event) => event.seq !== 57));

    expect(repairLoops(clean)).toEqual([]);
  });
});

suite('KAR-17.6 — where a node’s verdict points into the diff (AC1, AC2)', () => {
  it('points at the line of the worst located finding of the verdict that judged it', () => {
    const pointers = diffPointers(repair());

    expect(pointers.get('impl-1')).toEqual({
      node: 'impl-1',
      file: 'src/date-picker.ts',
      line: 2,
    });
  });

  it('picks the worst finding rather than the first, because that is what a reader wants', () => {
    // `happy-path-12`'s contract gate reported a `major` at line 31 and a
    // `minor` at line 12. Ordered by line the minor comes first; the link is
    // for the blocker-shaped one.
    expect(diffPointers(happy()).get('impl-signup')).toEqual({
      node: 'impl-signup',
      file: 'src/api/contract.ts',
      line: 31,
    });
  });

  it('says nothing about a node whose latest verdict found nothing to point at', () => {
    // The fix node's re-run passed with no findings — a chip that still linked
    // to a line would be pointing at the bug that is no longer there.
    expect(diffPointers(repair()).has('fix-65207341fbd9')).toBe(false);
  });

  it('follows the latest verdict, so a repaired node stops pointing at its old failure', () => {
    const repaired = fold([
      ...gateFailureRepair(),
      gateEvaluated({
        seq: 901,
        runId: 'run_20260810T090000Z_9f31ab',
        gate: 'typecheck',
        gateNode: 'gate-typecheck-r3',
        evaluatedNode: 'impl-1',
        outcome: 'pass',
        attempt: 1,
        summary: 'typecheck passed',
        findings: [],
      }),
    ]);

    expect(diffPointers(repaired).has('impl-1')).toBe(false);
  });

  it('never guesses a line for a verdict whose findings have no location (AC3)', () => {
    const unlocated = fold([
      ...gateFailureRepair().filter((event) => event.seq <= 10),
      gateEvaluated({
        seq: 902,
        runId: 'run_20260810T090000Z_9f31ab',
        gate: 'review',
        gateNode: 'gate-review',
        evaluatedNode: 'impl-1',
        outcome: 'fail',
        summary: 'one judgement about the change as a whole',
        findings: [
          {
            id: 'f-whole-change',
            severity: 'blocker',
            message: 'no test covers the new branch',
            evidence: [],
          },
        ],
      }),
    ]);

    expect(diffPointers(unlocated).has('impl-1')).toBe(false);
  });
});
