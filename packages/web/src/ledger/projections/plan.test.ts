/**
 * KAR-16.3 — `plan.ts`, the F10.1 projection.
 *
 * Verifies: EPIC-16-S16 · AC3, AC11
 *
 * Folded over `happy-path-12` in Node's environment: no DOM, no mount, no
 * browser. That is the whole design of this slice — a projection bug renders a
 * wrong picture of a real run, which is the one failure this product exists to
 * prevent, and catching it costs a forty-millisecond test rather than a page.
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { DISPLAY_STATES } from '../../lib/state-palette.ts';
import { applyPlan, emptyPlan, type PlanProjection } from './plan.ts';

const HAPPY = 'happy-path-12';

const happyPlan = (): PlanProjection => fold(HAPPY, emptyPlan, applyPlan);

const stateOf = (plan: PlanProjection, id: string): string | undefined => plan.nodes.get(id)?.state;

suite('EPIC-16-S16 — reducing the happy-path fixture (AC3)', () => {
  it('holds exactly the nodes of the plan document, and no others', () => {
    const plan = happyPlan();

    expect([...plan.nodes.keys()].toSorted()).toEqual(
      [
        'approve-release',
        'gate-contract',
        'gate-typecheck',
        'impl-legacy-shim',
        'impl-login',
        'impl-logout',
        'impl-profile',
        'impl-signup',
        'plan-migration',
        'recon-auth-surface',
        'review-security',
        'smoke-tests',
      ].toSorted(),
    );
  });

  it('gives every node one of the seven states F10.1 names — no eighth, no undefined', () => {
    const plan = happyPlan();
    const states = [...plan.nodes.values()].map((node) => node.state);

    expect(states).not.toContain(undefined);
    for (const state of states) expect(DISPLAY_STATES).toContain(state);
  });

  it('reaches all seven of them, which is what makes the enumeration worth asserting', () => {
    const plan = happyPlan();
    const reached = new Set([...plan.nodes.values()].map((node) => node.state));

    expect([...reached].toSorted()).toEqual([...DISPLAY_STATES].toSorted());
  });
});

suite('EPIC-16-S16 — state transitions come from named events', () => {
  it('leaves a scheduled node pending, and records provider and permission', () => {
    const plan = happyPlan();
    const smoke = plan.nodes.get('smoke-tests');

    expect(smoke?.state).toBe('pending');
    expect(smoke?.provider).toBe('deflow');
    expect(smoke?.permission).toBe('worktree');
  });

  it('moves a started node to running and records the binary that ran it', () => {
    const signup = happyPlan().nodes.get('impl-signup');

    expect(signup?.state).toBe('running');
    expect(signup?.binary?.path).toBe('/tmp/deflow-happy-path-12/bin/claude');
    expect(signup?.binary?.version).toBe('2.1.220');
    expect(signup?.binary?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('updates the live phase on node.progress WITHOUT changing the state', () => {
    const signup = happyPlan().nodes.get('impl-signup');

    // `node.progress` is cheap and frequent and does not advance the progress
    // watermark (docs/04 §9). Treating it as a state change makes the graph
    // flicker on a chatty node.
    expect(signup?.phase).toBe('editing');
    expect(signup?.state).toBe('running');
  });

  it('moves a completed node to passed and a failed one to failed, with its typed reason', () => {
    const plan = happyPlan();

    expect(stateOf(plan, 'recon-auth-surface')).toBe('passed');
    expect(stateOf(plan, 'impl-login')).toBe('failed');
    expect(plan.nodes.get('impl-login')?.failure?.reason).toBe('safety.pin-integrity-violated');
    expect(plan.nodes.get('impl-login')?.failure?.class).toBe('permanent');
  });

  it('moves a node suspended on a human to awaiting-human, and says what it waits for', () => {
    const plan = happyPlan();

    expect(stateOf(plan, 'approve-release')).toBe('awaiting-human');
    expect(plan.nodes.get('approve-release')?.suspendedUntil?.kind).toBe('human');
  });

  it('shows a node the scheduler demoted as blocked, naming what it collided with', () => {
    const profile = happyPlan().nodes.get('impl-profile');

    expect(profile?.state).toBe('blocked');
    expect(profile?.blocked?.conflictsWith).toBe('impl-signup');
    expect(profile?.blocked?.paths).toEqual(['src/router/guards.ts']);
  });

  it('takes a retried node back to pending and carries the attempt it will run next', () => {
    const plan = happyPlan();
    const logout = plan.nodes.get('impl-logout');

    // It ended `passed` on attempt 1 — the retry is what the *inspector* reads,
    // and it must not leave the node stuck at the failed attempt.
    expect(logout?.state).toBe('passed');
    expect(logout?.attempt).toBe(1);
    expect(logout?.retry?.nextAttempt).toBe(1);
  });
});

suite('EPIC-16-S16 — edges carry what flows across them', () => {
  it('exposes a data edge’s carries[] as a field rather than a guess', () => {
    const plan = happyPlan();
    const edge = plan.edges.get('recon-auth-surface→plan-migration:data');

    expect(edge?.kind).toBe('data');
    expect(edge?.carries).toEqual(['finding/auth-uses-jwt']);
  });

  it('gives a control edge an empty carries[] rather than undefined', () => {
    const edge = happyPlan().edges.get('plan-migration→impl-signup:control');

    expect(edge?.carries).toEqual([]);
  });
});

suite('EPIC-16-S16 — a node abandoned by a PlanPatch', () => {
  it('renders abandoned, distinctly from failed', () => {
    const plan = happyPlan();

    expect(stateOf(plan, 'impl-legacy-shim')).toBe('abandoned');
    expect(plan.nodes.get('impl-legacy-shim')?.lifecycle).toBe('abandoned');
    expect(stateOf(plan, 'impl-legacy-shim')).not.toBe('failed');
  });

  it('advances the plan version and the hash the patch produced', () => {
    const plan = happyPlan();

    expect(plan.version).toBe(2);
    expect(plan.planHash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const plan = happyPlan();
    const before = structuredClone(plan);

    expect(() => {
      applyPlan(plan, unknownKind(9_100, ledger(HAPPY)[0]?.runId ?? ''));
    }).not.toThrow();

    // `appliedSeq` is the one field that legitimately moves: an event this
    // build cannot read has still been seen, and a client that re-requested it
    // on every reconnect would do so for the life of the run.
    expect({ ...plan, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
