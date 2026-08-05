/**
 * The 2,000-event happy-path run behind `../fixtures/runs/happy-path.events.json`
 * (KAR-03.5, EPIC-03-S15 scenario "determinism").
 *
 * The committed JSON is the fixture the scenario names; this builder is how it
 * was produced and how it is checked for drift. Both exist on purpose: a
 * generated-at-test-time fixture would silently change shape the day someone
 * edits the generator, and a hand-written 2,000-event file cannot be
 * maintained at all.
 *
 * The number 2,000 is not decoration. docs/05-durable-execution.md §5.1 rests
 * the "no snapshotting needed" decision on "a 40-node multi-hour run produces
 * on the order of 2,000 control-plane events", so the reducer's own
 * determinism fixture is a run of exactly that size and shape: 40 nodes, one
 * lock at a time, tens of progress reports per node, a human gate, a handful
 * of verification gates and facts, and no failures — the happy path.
 *
 * Everything here is a pure function of the constants below. No clock, no
 * randomness, no ordering that depends on a Map iteration.
 */

import { PAYLOADS } from './event-payloads.fixture.ts';

export const RUN_ID = 'run_20260802T141133Z_9f2a1c';

export const NODE_COUNT = 40;

/** Exactly what the acceptance criterion asks for. */
export const EVENT_COUNT = 2_000;

/** node.scheduled, node.lock.acquired, node.started, node.completed, node.lock.released, budget.consumed. */
const FIXED_PER_NODE = 6;

/** run.created, run.spec.approved, run.started, run.completed. */
const RUN_LEVEL = 4;

/** One verification gate after every fourth node. */
const GATE_EVERY = 4;
const GATES = NODE_COUNT / GATE_EVERY;

/** One fact written by every tenth node. */
const FACT_EVERY = 10;
const FACTS = NODE_COUNT / FACT_EVERY;

/** One human gate, mid-run: requested and responded. */
const HUMAN_EVENTS = 2;
const HUMAN_AT_NODE = 20;

/**
 * Progress reports carry the remainder. Nodes are otherwise identical, so the
 * extra report on the first `PROGRESS_REMAINDER` of them is the only
 * asymmetry in the run — and it is derived, so changing any constant above
 * keeps the fixture at exactly `EVENT_COUNT` events instead of silently
 * drifting off it.
 */
const PROGRESS_TOTAL =
  EVENT_COUNT - RUN_LEVEL - GATES - FACTS - HUMAN_EVENTS - NODE_COUNT * FIXED_PER_NODE;
const PROGRESS_PER_NODE = Math.floor(PROGRESS_TOTAL / NODE_COUNT);
const PROGRESS_REMAINDER = PROGRESS_TOTAL % NODE_COUNT;

const START_TS = 1_754_308_293_000;
/** A step every 8 seconds of a multi-hour run. `ts` is informational — order is `seq`. */
const TS_STEP = 8_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const BARE_SHA = 'd'.repeat(64);
const HANDLE = `artifact://${'b'.repeat(64)}`;

const PHASES = ['reading', 'tool-use', 'writing', 'verifying'] as const;

export const nodeIdOf = (index: number): string => `step-${String(index + 1).padStart(2, '0')}`;

const factIdOf = (index: number): string => `fact_${String(index).padStart(26, '0')}`;

/** A stored row: the §9 envelope, payload already decoded, as `readRange` returns it. */
export interface FixtureEvent {
  readonly seq: number;
  readonly runId: string;
  readonly ts: number;
  readonly kind: string;
  readonly v: number;
  readonly epoch: number;
  readonly payload: unknown;
}

const usage = (index: number) => ({
  inputTokens: 1200 + index * 10,
  outputTokens: 340 + index,
  source: 'vendor-reported' as const,
});

const costOf = (index: number): number => Number(((index + 1) / 100).toFixed(2));

interface FactTemplate {
  readonly provenance: Record<string, unknown>;
  readonly [field: string]: unknown;
}

const factTemplate = (PAYLOADS['fact.written'] as { fact: FactTemplate }).fact;

const verdictTemplate = (PAYLOADS['gate.evaluated'] as { verdict: { by: object } & object })
  .verdict;

export function happyPathEvents(): FixtureEvent[] {
  const events: FixtureEvent[] = [];

  const emit = (kind: string, payload: unknown): void => {
    events.push({
      seq: events.length + 1,
      runId: RUN_ID,
      ts: START_TS + events.length * TS_STEP,
      kind,
      v: 1,
      epoch: 1,
      payload,
    });
  };

  // The spec, the fact and the verdict come from the payload corpus the schema
  // suite already exercises (./event-payloads.fixture.ts) rather than being
  // re-invented here, so this fixture cannot drift into a shape the schemas
  // would refuse.
  emit('run.created', PAYLOADS['run.created']);
  emit('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' });
  emit('run.started', { planHash: PLAN_HASH });

  for (let index = 0; index < NODE_COUNT; index += 1) {
    const node = nodeIdOf(index);
    const lockKey = index % 2 === 0 ? 'repo' : `${RUN_ID}__${node}`;
    const lock = index % 2 === 0 ? 'repo' : 'worktree';

    emit('node.scheduled', {
      node,
      provider: index % 3 === 0 ? 'codex' : 'claude-code',
      model: index % 3 === 0 ? 'gpt-5-codex' : 'claude-sonnet-4-6',
      permission: index % 2 === 0 ? 'worktree' : 'read',
    });
    emit('node.lock.acquired', { node, lock, key: lockKey });
    emit('node.started', {
      node,
      attempt: 0,
      ikey: `${RUN_ID}/${node}/0/0`,
      binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: BARE_SHA },
    });

    const reports = PROGRESS_PER_NODE + (index < PROGRESS_REMAINDER ? 1 : 0);
    for (let report = 0; report < reports; report += 1) {
      emit('node.progress', {
        node,
        attempt: 0,
        phase: PHASES[report % PHASES.length],
        ioChunkSeq: report + 1,
      });
    }

    if (index === HUMAN_AT_NODE) {
      emit('human.requested', {
        node,
        prompt: 'The codemod changed 41 files. Proceed?',
        options: [{ id: 'yes', label: 'Proceed', effect: 'approve' }],
      });
      emit('human.responded', { node, optionId: 'yes', at: '2026-08-02T15:02:11.000Z' });
    }

    if (index % FACT_EVERY === 0) {
      emit('fact.written', {
        fact: {
          ...factTemplate,
          id: factIdOf(index),
          key: `finding/${node}`,
          provenance: { ...factTemplate.provenance, byNode: node, atEvent: events.length + 1 },
        },
      });
    }

    emit('node.completed', {
      node,
      attempt: 0,
      result: {
        status: 'completed',
        output: { summary: `${node} done` },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage: usage(index),
        costUsd: costOf(index),
        producedFacts: index % FACT_EVERY === 0 ? [factIdOf(index)] : [],
        artifacts: [HANDLE],
      },
    });
    emit('budget.consumed', {
      node,
      provider: index % 3 === 0 ? 'codex' : 'claude-code',
      usage: usage(index),
      costUsd: costOf(index),
    });
    emit('node.lock.released', { node, lock, key: lockKey });

    if (index % GATE_EVERY === GATE_EVERY - 1) {
      const gate = `gate-${String(index + 1).padStart(2, '0')}`;
      emit('gate.evaluated', {
        gate,
        node,
        verdict: {
          ...verdictTemplate,
          gate,
          evaluatedNode: node,
          by: { ...verdictTemplate.by, node: gate },
          criteria: [
            {
              id: index % 8 === 3 ? 'unit-tests-pass' : 'no-v-model-regression',
              status: 'satisfied',
            },
          ],
        },
      });
    }
  }

  emit('run.completed', { outcome: 'succeeded', criteriaSatisfied: ['unit-tests-pass'] });

  return events;
}

/** The committed fixture's text, one event per line so a diff reads per event. */
export function renderFixture(events: readonly FixtureEvent[]): string {
  return `[\n${events.map((one) => JSON.stringify(one)).join(',\n')}\n]\n`;
}
