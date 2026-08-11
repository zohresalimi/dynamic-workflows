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

/**
 * KAR-17.3 — what the node inspector needs of a failure, and could not get.
 *
 * `failure` is the *latest* one, which is the right thing for a node body: a
 * chip has room for one reason. The inspector's attempt table has a row per
 * attempt and needs the failure that ended each of them, and `detail` is where
 * a `contract.schema-invalid` keeps its Ajv errors — *"shows the Ajv error
 * beside the offending output rather than a generic message"* (AC5). Dropping
 * `detail` on the way through the projection made that criterion unmeetable
 * from the ledger the tab holds.
 *
 * The list is bounded by the node's own retry ladder (`maxAttempts`), so this
 * is not the unbounded per-node accumulation KAR-16.4's memory rules forbid.
 */
suite('KAR-17.3 — the failure history, and the detail on each failure', () => {
  const repair = (): PlanProjection => fold('repair-attempts', emptyPlan, applyPlan);

  it('keeps one failure per attempt, oldest first', () => {
    const node = repair().nodes.get('impl-oauth');

    expect(node?.failures.map((one) => [one.attempt, one.reason])).toEqual([
      [0, 'timeout'],
      [1, 'agent.nonzero-exit'],
      [2, 'contract.schema-invalid'],
    ]);
  });

  it('still reports the latest one as `failure`, for the node body’s chip', () => {
    expect(repair().nodes.get('impl-oauth')?.failure?.reason).toBe('contract.schema-invalid');
  });

  it('carries the Ajv errors through on the failure that has them', () => {
    const last = repair().nodes.get('impl-oauth')?.failures.at(-1);

    // The validator's own vocabulary, not a flattened sentence: the inspector's
    // job is to point at the field that failed, and a sentence cannot be
    // pointed with.
    // Asserted as one object rather than by reaching into `detail` behind an
    // optional chain: `detail` is `Record<string, unknown>` by construction —
    // *"reason-specific and JSON-only"* (docs/04 §8) — so any path into it is a
    // cast, and a cast that short-circuits to `undefined` throws inside the
    // expectation instead of failing it.
    expect(last?.detail).toMatchObject({
      schemaId: 'DeFlow.verdict.v4',
      ajv: [
        { instancePath: '/findings/0/severity', keyword: 'enum' },
        { instancePath: '/summary', keyword: 'type' },
      ],
    });
  });

  it('leaves `detail` null on a failure that carried none', () => {
    // `null` rather than `{}`: an empty object reads as "the failure had detail
    // and it was empty", which is a different claim from "it had none".
    expect(repair().nodes.get('impl-oauth')?.failures[0]?.detail).toBeNull();
  });

  it('records the failure of a node that never got past spawn, too', () => {
    const node = repair().nodes.get('probe-oauth-tokens');

    expect(node?.failures).toHaveLength(1);
    expect(node?.failures[0]?.reason).toBe('adapter.spawn-failed');
    expect(node?.failures[0]?.evidence).toHaveLength(1);
  });

  it('does not double-count an attempt whose node.failed is replayed', () => {
    // Backfill legitimately re-sends events at or below the cursor (docs/11
    // §5). The per-projection `seq` guard already refuses them; this is the
    // assertion that the new list is behind that guard and not in front of it.
    const state = repair();
    const before = state.nodes.get('impl-oauth')?.failures.length;
    for (const event of ledger('repair-attempts')) applyPlan(state, event);

    expect(state.nodes.get('impl-oauth')?.failures).toHaveLength(before as number);
  });
});

/**
 * KAR-17.3 AC5 — *"raw output and normalised/validated output are shown
 * separately"*.
 *
 * The normalised, schema-validated object is `node.completed.result.output`,
 * and until now the projection threw it away: only the *fact* of completion was
 * kept. The raw bytes are never inlined — they are an artifact handle, resolved
 * through `GET /api/artifacts/:sha` — so what is retained here is one small
 * object per node, bounded by the plan and by the node's own
 * `returns.maxTokens`, not by the length of the run.
 */
suite('KAR-17.3 — the output a completed node returned', () => {
  const happy = (): PlanProjection => fold('happy-path-12', emptyPlan, applyPlan);

  it('keeps the validated output and the schema it was validated against', () => {
    const result = happy().nodes.get('recon-auth-surface')?.result;

    expect(result?.output).toEqual({ text: 'auth verifies a JWT' });
    expect(result?.outputSchemaId).toBe('DeFlow.finding.v1');
  });

  it('links the output to the node.completed that carried it', () => {
    // AC7 again: a value with no producing event cannot exist.
    expect(happy().nodes.get('recon-auth-surface')?.result?.seq).toBe(11);
  });

  it('leaves `result` null on a node that never completed', () => {
    // Not `{}` and not an empty string: a failed node returned nothing, and an
    // empty output pane that looks like a returned empty object is exactly the
    // fabrication AC9 is about.
    expect(happy().nodes.get('impl-login')?.result).toBeNull();
  });
});

/**
 * KAR-17.3 AC1 — *"opening a node shows … permission level, path scopes,
 * worktree path"*.
 *
 * Permission and worktree were already here; the path scopes were in the plan
 * document and were dropped on the way through. They are the answer to *"was
 * this node even allowed to touch that file"*, which is the second question
 * asked of a bad diff and one the inspector could not previously answer.
 */
suite('KAR-17.3 — the path scopes a node was given', () => {
  it('carries the read and write scopes off the plan document', () => {
    const node = fold('happy-path-12', emptyPlan, applyPlan).nodes.get('impl-signup');

    expect(node?.pathScopes).toEqual({ write: ['src/**'], read: ['src/**'] });
  });

  it('reports a gate’s empty write scope as empty, not as absent', () => {
    // `write: []` is a real answer — "this node may write nothing" — and it is
    // a different claim from "the plan did not say".
    const node = fold('happy-path-12', emptyPlan, applyPlan).nodes.get('gate-typecheck');

    expect(node?.pathScopes).toEqual({ write: [], read: [] });
  });

  it('leaves them null on a node no plan document has described yet', () => {
    const state = emptyPlan();
    for (const event of ledger('crash-resume-seq-gap')) applyPlan(state, event);

    expect(state.nodes.get('impl')?.pathScopes).toBeNull();
  });
});
