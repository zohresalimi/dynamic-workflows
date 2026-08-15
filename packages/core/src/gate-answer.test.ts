/**
 * KAR-22.5 AC2 — one answer path, driven from a table.
 *
 * Verifies: EPIC-22-S60 · test plan #1
 */
import { expect, it, describe as suite } from 'vitest';
import { gateAnswerRequest, SPEC_EDIT_NEEDS_A_DOCUMENT } from './gate-answer.ts';
import { SPEC_DECISIONS, SPEC_GATE_NODE } from './spec-approval.ts';

const RUN = 'run_20260815T090000Z_b17e55';

suite('EPIC-22-S60 — the F1.3 gate answers on its four endpoints', () => {
  it('routes approve to the approve endpoint, with the body that route takes', () => {
    expect(gateAnswerRequest({ runId: RUN, gate: SPEC_GATE_NODE, optionId: 'approve' })).toEqual({
      target: { kind: 'spec-decision', decision: 'approve' },
      path: `/api/runs/${RUN}/spec/approve`,
      body: {},
    });
  });

  it('routes abandon to its own endpoint rather than to approve', () => {
    expect(gateAnswerRequest({ runId: RUN, gate: SPEC_GATE_NODE, optionId: 'abandon' })).toEqual({
      target: { kind: 'spec-decision', decision: 'abandon' },
      path: `/api/runs/${RUN}/spec/abandon`,
      body: {},
    });
  });

  it("carries a rejection's reason in the field that route reads", () => {
    expect(
      gateAnswerRequest({
        runId: RUN,
        gate: SPEC_GATE_NODE,
        optionId: 'reject',
        text: 'the scope is wrong',
      }),
    ).toEqual({
      target: { kind: 'spec-decision', decision: 'reject' },
      path: `/api/runs/${RUN}/spec/reject`,
      body: { reason: 'the scope is wrong' },
    });
  });

  it('refuses edit rather than inventing a route for it', () => {
    expect(gateAnswerRequest({ runId: RUN, gate: SPEC_GATE_NODE, optionId: 'edit' })).toBeNull();
    // The reason is one exported sentence, so the CLI and the browser cannot
    // come to explain one limitation two ways (AC4).
    expect(SPEC_EDIT_NEEDS_A_DOCUMENT).toContain('DeFlow.taskspecdraft.v1');
  });

  it('has an answer for every decision the gate offers, and refuses only edit', () => {
    const routed = SPEC_DECISIONS.filter(
      (option) =>
        gateAnswerRequest({ runId: RUN, gate: SPEC_GATE_NODE, optionId: option }) !== null,
    );
    expect(routed).toEqual(['approve', 'reject', 'abandon']);
  });
});

suite('EPIC-22-S60 — every other gate answers on one endpoint', () => {
  it('routes a plan gate to nodes/:nodeId/respond, naming the option', () => {
    expect(gateAnswerRequest({ runId: RUN, gate: 'review-changes', optionId: 'approve' })).toEqual({
      target: { kind: 'node-response', node: 'review-changes' },
      path: `/api/runs/${RUN}/nodes/review-changes/respond`,
      body: { optionId: 'approve' },
    });
  });

  it('attaches the operator’s note only when there is one', () => {
    expect(
      gateAnswerRequest({
        runId: RUN,
        gate: 'escalate-write',
        optionId: 'deny',
        text: 'not outside the worktree',
      })?.body,
    ).toEqual({ optionId: 'deny', text: 'not outside the worktree' });

    expect(
      gateAnswerRequest({ runId: RUN, gate: 'escalate-write', optionId: 'deny' })?.body,
    ).toEqual({ optionId: 'deny' });
  });

  it('does not treat a non-spec gate’s "edit" as the F1.3 edit', () => {
    // `edit` is an ordinary `HumanOptionEffect` on a plan gate: it supplies the
    // node's output, and `respond` takes it. Only the F1.3 gate's `edit` is the
    // one no button can carry.
    expect(
      gateAnswerRequest({ runId: RUN, gate: 'review-changes', optionId: 'edit' }),
    ).not.toBeNull();
  });
});
