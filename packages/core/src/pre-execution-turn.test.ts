/**
 * KAR-27.3 AC1 — the completion vocabulary, one arm at a time.
 *
 * Every assertion here is about *when a pre-execution turn stops being in
 * flight*. That is the whole risk of this projection: a conclusion nobody wrote
 * down leaves a framing node running for ever, and a conclusion written down
 * too eagerly puts the run back to "waiting" while its child is still working.
 *
 * Verifies: EPIC-27-S15, EPIC-27-S16 · KAR-27.3 AC1
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test as it, describe as suite } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { DEFAULT_RETRY_POLICY } from './plan-graph.ts';
import {
  foldPreExecutionTurns,
  inFlightPreExecution,
  PRE_EXECUTION_NODE_IDS,
  type PreExecutionTurns,
} from './pre-execution-turn.ts';

/** The committed plan graph, so the planner arm folds a document the schema
 * actually accepts rather than a hand-typed stub that drifts from it. */
const PLAN_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../test/fixtures/plans/seven-types.json', import.meta.url)),
    'utf8',
  ),
) as { readonly version: number; readonly planHash: string };

const RUN_ID = 'run_20260823T104141Z_e9eac2';
const TS = 1_756_000_000_000;

function event(
  kind: EventKind,
  payload: unknown,
  envelope: { seq?: number; ts?: number; nodeId?: string; attempt?: number } = {},
): Event {
  const result = parseEvent({
    seq: envelope.seq ?? 1,
    runId: RUN_ID,
    ts: envelope.ts ?? TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
    ...(envelope.nodeId === undefined ? {} : { nodeId: envelope.nodeId }),
    ...(envelope.attempt === undefined ? {} : { attempt: envelope.attempt }),
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

/** One `provider.session_opened`, envelope and payload agreeing as they must. */
const opened = (node: string, attempt: number, ts = TS): Event =>
  event(
    'provider.session_opened',
    {
      node,
      attempt,
      provider: 'claude',
      session: { id: `9d1f0f2a-0000-4000-8000-00000000000${attempt}`, origin: 'minted' },
    },
    { nodeId: node, attempt, ts },
  );

const failed = (node: string, attempt: number, maxAttempts?: number): Event =>
  event('node.failed', {
    node,
    attempt,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    failure: {
      reason: 'agent.nonzero-exit',
      class: 'transient',
      message: 'the agent exited 1',
      occurredAtEvent: 1,
      attempt,
      evidence: [],
    },
  });

const created = (): Event =>
  event('run.created', {
    spec: {
      schemaId: 'DeFlow.taskspec.v1',
      goal: 'make the run look alive',
      scope: { included: ['the workflow view'] },
      nonGoals: [],
      constraints: [],
      priorDecisions: [],
      acceptanceCriteria: [{ id: 'ac-1', statement: 'the strip renders' }],
      knownFailureModes: [],
      approvedBy: null,
      specHash: `sha256-${'2'.repeat(64)}`,
    },
    cwd: '/repo',
    repo: { head: 'abcdef1', branch: 'master' },
  });

const reconFact = (byNode: string): Event =>
  event('fact.written', {
    fact: {
      id: 'fact_01hq5m9z00000000000000000a',
      key: 'finding/repo-is-a-monorepo',
      kind: 'finding',
      schemaId: 'DeFlow.finding.v1',
      value: { note: 'a monorepo' },
      provenance: {
        byNode,
        byProvider: 'claude',
        byModel: 'claude-opus-5',
        fromEvidence: [],
        atEvent: 1,
        at: '2026-08-23T10:41:41.000Z',
        confidence: 'asserted',
      },
    },
  });

const NONE: PreExecutionTurns = {};

/** The record after folding `events` from empty, ignoring the `null`s. */
function foldAll(events: readonly Event[]): PreExecutionTurns {
  let state: PreExecutionTurns = NONE;
  for (const next of events) state = foldPreExecutionTurns(state, next) ?? state;
  return state;
}

suite('foldPreExecutionTurns — a turn starting', () => {
  it('marks the node running from the session row, with its ts as the since-instant', () => {
    const state = foldAll([opened('framing', 0, TS)]);

    expect(state.framing).toEqual({
      running: true,
      sessions: 1,
      failures: 0,
      sinceTs: TS,
      maxAttempts: DEFAULT_RETRY_POLICY.maxAttempts,
    });
  });

  it('counts sessions from the envelope, so the second child addresses its own io', () => {
    const state = foldAll([opened('framing', 0), opened('framing', 1, TS + 1000)]);

    expect(state.framing?.sessions).toBe(2);
    expect(state.framing?.sinceTs).toBe(TS + 1000);
  });

  it('quiesces the previous node, because the chain runs one turn at a time', () => {
    const state = foldAll([opened('framing', 0), created(), opened('recon', 0, TS + 5)]);

    expect(state.framing?.running).toBe(false);
    expect(state.recon?.running).toBe(true);
  });

  it('ignores a session opened for a node that is not a pre-execution turn', () => {
    expect(foldPreExecutionTurns(NONE, opened('implement-auth', 0))).toBeNull();
  });
});

suite('foldPreExecutionTurns — the completion vocabulary', () => {
  it.each([
    ['run.created', created()],
    [
      'human.requested (a clarifying question)',
      event('human.requested', {
        node: 'framing',
        prompt: 'Which repository did you mean?',
        options: [{ id: 'this-one', label: 'This one', effect: 'approve' }],
      }),
    ],
    ['node.failed', failed('framing', 0)],
    [
      'node.cancelled',
      event('node.cancelled', {
        node: 'framing',
        attempt: 0,
        result: { status: 'cancelled', by: 'user' },
      }),
    ],
    ['run.aborted', event('run.aborted', { outcome: 'failed', criteriaSatisfied: [] })],
  ])('%s concludes an in-flight framing turn', (_name, concluding) => {
    const state = foldAll([opened('framing', 0), concluding]);

    expect(state.framing?.running).toBe(false);
    expect(inFlightPreExecution(state)).toBeNull();
  });

  it('a recon fact concludes recon, because facts are derived after the child exits', () => {
    const state = foldAll([opened('recon', 0), reconFact('recon')]);

    expect(state.recon?.running).toBe(false);
  });

  it('a fact written by some other node concludes nothing', () => {
    const running = foldAll([opened('recon', 0)]);

    expect(foldPreExecutionTurns(running, reconFact('implement-auth'))).toBeNull();
  });

  it('a proposed plan concludes the planner', () => {
    const state = foldAll([
      opened('planner', 0),
      event('plan.proposed', {
        version: PLAN_FIXTURE.version,
        planHash: PLAN_FIXTURE.planHash,
        graph: PLAN_FIXTURE,
        by: 'planner',
      }),
    ]);

    expect(state.planner?.running).toBe(false);
  });

  it('an unrelated kind answers null rather than a copy', () => {
    const running = foldAll([opened('framing', 0)]);

    expect(
      foldPreExecutionTurns(
        running,
        event('run.started', { planHash: `sha256-${'a'.repeat(64)}` }),
      ),
    ).toBeNull();
  });

  it('a concluding event that concludes nothing answers null, so the watermark stays put', () => {
    expect(
      foldPreExecutionTurns(
        NONE,
        event('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] }),
      ),
    ).toBeNull();
  });
});

suite('foldPreExecutionTurns — the two numbers stay apart', () => {
  it('counts a failure as a spent attempt even when no session was ever opened', () => {
    const state = foldAll([failed('framing', 0)]);

    expect(state.framing).toMatchObject({ running: false, sessions: 0, failures: 1 });
  });

  it('carries the spent attempts into the next turn, so the display reads 2 of 3', () => {
    const state = foldAll([opened('framing', 0), failed('framing', 0), opened('framing', 1)]);

    expect(state.framing).toMatchObject({ running: true, sessions: 2, failures: 1 });
  });

  it('reads the ceiling off the failure rather than keeping a second copy of it', () => {
    const state = foldAll([opened('framing', 0), failed('framing', 0, 5)]);

    expect(state.framing?.maxAttempts).toBe(5);
  });

  it('resets the spent attempts on run.created, exactly as attemptsSpent does', () => {
    const state = foldAll([
      opened('framing', 0),
      failed('framing', 0),
      opened('framing', 1),
      created(),
    ]);

    expect(state.framing).toMatchObject({ running: false, failures: 0, sessions: 2 });
  });
});

suite('inFlightPreExecution', () => {
  it('answers null when nothing is running', () => {
    expect(inFlightPreExecution(NONE)).toBeNull();
    expect(inFlightPreExecution(foldAll([opened('framing', 0), created()]))).toBeNull();
  });

  it('names the node and hands back its turn', () => {
    const found = inFlightPreExecution(foldAll([opened('recon', 0, TS + 9)]));

    expect(found?.node).toBe('recon');
    expect(found?.turn.sinceTs).toBe(TS + 9);
  });

  it('lists the three pre-execution nodes and no plan node', () => {
    expect([...PRE_EXECUTION_NODE_IDS]).toEqual(['framing', 'recon', 'planner']);
  });
});
