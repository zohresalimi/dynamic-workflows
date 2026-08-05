/**
 * KAR-03.5 — the read path into the reducer: parse, upcast, fold, and count
 * what was skipped (docs/04-domain-model.md §9.2, docs/05-durable-execution.md §4).
 *
 * `reduce` is the law; `foldEvents` is how a stored row reaches it. It exists
 * as a separate pure function for one reason: the degradation a downgrade
 * produces has to be *reportable*. EPIC-03-S16 asks for one aggregate log line
 * — "skipped 40 events of 1 unknown kind" — and explicitly forbids an
 * error-level line per skipped event, so the tally has to be a value the
 * imperative shell logs once, not a side effect inside the fold.
 *
 * Verifies: EPIC-03-S16 (fold half), EPIC-03-S17 (unit half) · AC1, AC2, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { z } from 'zod';
import { EVENT_CURRENT_VERSIONS, EVENT_SCHEMAS } from './event-payloads.ts';
import { describeSkipped, foldEvents } from './fold-events.ts';
import { NodeIdSchema } from './ids.ts';
import { initialRunState } from './run-state.ts';
import { UpcasterRegistry } from './upcasters.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const NODE = 'recon-auth-surface';
const SHA = `sha256-${'a'.repeat(64)}`;
const TS = 1_754_313_093_000;

const usage = { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' } as const;

/** A row as `readRange` hands it back: envelope fields, payload already JSON. */
const row = (
  seq: number,
  kind: string,
  payload: unknown,
  overrides: { v?: number; epoch?: number } = {},
): Record<string, unknown> => ({
  seq,
  runId: RUN_ID,
  ts: TS,
  kind,
  v: overrides.v ?? 1,
  epoch: overrides.epoch ?? 1,
  payload,
});

const started = (seq: number) => row(seq, 'run.started', { planHash: SHA });

const unknown = (seq: number, kind = 'node.sandbox.escalated') =>
  row(seq, kind, { node: NODE, sandbox: 'seatbelt' });

suite('foldEvents applies what it understands', () => {
  it('reduces known kinds and counts them', () => {
    const report = foldEvents([started(1), row(2, 'run.paused', { by: 'user' })]);

    expect(report.state.status).toBe('paused');
    expect(report.applied).toBe(2);
    expect(report.lastSeq).toBe(2);
  });

  it('folds from a state the caller supplies, so a checkpoint can seed it', () => {
    const first = foldEvents([started(1)]);

    const second = foldEvents([row(2, 'run.paused', { by: 'user' })], first.state);

    expect(second.state.status).toBe('paused');
    expect(second.state.planHash).toBe(SHA);
  });

  it('is deterministic: the same rows fold to deeply-equal state twice', () => {
    const rows = [
      started(1),
      row(2, 'node.lock.acquired', { node: NODE, lock: 'repo', key: 'repo' }),
    ];

    expect(foldEvents(rows).state).toEqual(foldEvents(rows).state);
  });
});

/**
 * EPIC-03-S16. A newer daemon's events are data, not an error: they leave the
 * projection alone, they are counted, and the count is a value — never a log
 * line per event, which during a nine-hour replay is its own denial of service.
 */
suite('an unknown kind degrades the projection instead of corrupting it', () => {
  const rows = [
    started(1),
    ...Array.from({ length: 40 }, (_unused, index) => unknown(2 + index)),
    row(42, 'run.paused', { by: 'user' }),
  ];

  it('leaves state exactly as the known events left it', () => {
    const withUnknowns = foldEvents(rows).state;
    const withoutUnknowns = foldEvents([started(1), row(42, 'run.paused', { by: 'user' })]).state;

    expect(withUnknowns).toEqual(withoutUnknowns);
  });

  it('counts the skipped events by kind rather than throwing', () => {
    const report = foldEvents(rows);

    expect(report.skippedByKind).toEqual({ 'node.sandbox.escalated': 40 });
    expect(report.applied).toBe(2);
  });

  it('still advances lastSeq past them, so a resume cursor does not rewind', () => {
    expect(foldEvents(rows).lastSeq).toBe(42);
  });

  it('renders one aggregate line, in the words the scenario asks for', () => {
    expect(describeSkipped(foldEvents(rows))).toBe(
      'skipped 40 events of 1 unknown kind: node.sandbox.escalated',
    );
  });

  it('pluralises, and names every kind, when more than one is unknown', () => {
    const report = foldEvents([unknown(1, 'run.teleported'), unknown(2), unknown(3)]);

    expect(describeSkipped(report)).toBe(
      'skipped 3 events of 2 unknown kinds: node.sandbox.escalated, run.teleported',
    );
  });

  it('says nothing at all when nothing was skipped', () => {
    expect(describeSkipped(foldEvents([started(1)]))).toBeNull();
  });
});

/**
 * A row the schema refuses is not the same failure as a kind from the future,
 * and neither may take the fold down: the ledger is append-only, so a row
 * written malformed by some future bug is permanent, and a replay that throws
 * on it is a run that can never be opened again.
 */
suite('an unreadable row is reported, not thrown', () => {
  it('records an invalid payload and keeps folding', () => {
    const report = foldEvents([
      started(1),
      row(2, 'run.started', { planHash: 'nope' }),
      started(3),
    ]);

    expect(report.unreadable).toMatchObject([
      { seq: 2, kind: 'run.started', reason: 'invalid-payload' },
    ]);
    expect(report.applied).toBe(2);
  });

  it('records a payload version newer than this build, and never guesses at it', () => {
    const report = foldEvents([row(1, 'run.started', { planHash: SHA }, { v: 9 })]);

    expect(report.unreadable).toMatchObject([
      { seq: 1, kind: 'run.started', reason: 'future-version' },
    ]);
    expect(report.state).toEqual(initialRunState());
  });

  it('records a row that is not an envelope at all', () => {
    const report = foldEvents([{ nonsense: true }]);

    expect(report.unreadable[0]?.reason).toBe('invalid-envelope');
    expect(report.state).toEqual(initialRunState());
  });
});

/**
 * AC4 / EPIC-03-S17 — upcasters run on the way *into* the reducer.
 *
 * Every kind this build ships is at v1 (schemas/CHANGELOG.md), so the only
 * honest way to exercise a three-version chain today is a registry that
 * declares one: `node.completed` at v3, with the hops that lift a v1 and a v2
 * payload into the shape the current schema accepts. That is exactly the
 * production mechanism — `parseEvent` reads the current version off the
 * registry it is handed — with the table the test supplies rather than the one
 * this build happens to ship.
 */
suite('a mixed-version ledger reduces to the state an all-v3 ledger does', () => {
  /** v2 predates `artifacts`, so the key is absent rather than empty. */
  const withoutArtifacts = <T extends { artifacts: unknown }>(result: T): Omit<T, 'artifacts'> => {
    const { artifacts: _dropped, ...rest } = result;
    return rest;
  };

  const completedV3 = {
    status: 'completed',
    output: { summary: 'done' },
    outputSchemaId: 'DeFlow.artifact.v1',
    usage,
    costUsd: 0.42,
    producedFacts: [],
    artifacts: [],
  };

  /** v2: the result object, before `artifacts` was added to it. */
  const NodeCompletedV2Schema = z.strictObject({
    node: NodeIdSchema,
    attempt: z.number().int().nonnegative(),
    result: z.strictObject({
      status: z.literal('completed'),
      output: z.unknown(),
      outputSchemaId: z.string(),
      usage: z.unknown(),
      costUsd: z.number(),
      producedFacts: z.array(z.string()),
    }),
  });

  const registry = (): UpcasterRegistry => {
    const built = new UpcasterRegistry({ ...EVENT_CURRENT_VERSIONS, 'node.completed': 3 });
    built.register({
      kind: 'node.completed',
      from: 1,
      to: NodeCompletedV2Schema,
      fixture: {
        node: NODE,
        attempt: 0,
        output: { summary: 'done' },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage,
        costUsd: 0.42,
      },
      // v1 was flat: the result fields sat on the payload itself.
      up: (payload) => {
        const flat = payload as Record<string, unknown>;
        return {
          node: flat.node,
          attempt: flat.attempt,
          result: {
            status: 'completed',
            output: flat.output,
            outputSchemaId: flat.outputSchemaId,
            usage: flat.usage,
            costUsd: flat.costUsd,
            producedFacts: [],
          },
        };
      },
    });
    built.register({
      kind: 'node.completed',
      from: 2,
      to: EVENT_SCHEMAS['node.completed'].payload,
      fixture: { node: NODE, attempt: 0, result: withoutArtifacts(completedV3) },
      up: (payload) => {
        const at2 = payload as { node: unknown; attempt: unknown; result: object };
        return { ...at2, result: { ...at2.result, artifacts: [] } };
      },
    });
    return built;
  };

  const v1 = (seq: number, node: string) =>
    row(
      seq,
      'node.completed',
      {
        node,
        attempt: 0,
        output: { summary: 'done' },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage,
        costUsd: 0.42,
      },
      { v: 1 },
    );

  const v2 = (seq: number, node: string) =>
    row(
      seq,
      'node.completed',
      { node, attempt: 0, result: withoutArtifacts(completedV3) },
      { v: 2 },
    );

  const v3 = (seq: number, node: string) =>
    row(seq, 'node.completed', { node, attempt: 0, result: completedV3 }, { v: 3 });

  it('reduces v1, v2 and v3 payloads to the same projection', () => {
    const options = { registry: registry() };

    const mixed = foldEvents(
      [started(1), v1(2, 'n1'), v2(3, 'n2'), v3(4, 'n3')],
      undefined,
      options,
    );
    const allV3 = foldEvents(
      [started(1), v3(2, 'n1'), v3(3, 'n2'), v3(4, 'n3')],
      undefined,
      options,
    );

    expect(mixed.unreadable).toEqual([]);
    expect(mixed.state).toEqual(allV3.state);
  });

  it('does not touch the rows it read — the ledger is immutable', () => {
    const rows = [v1(2, 'n1'), v2(3, 'n2')];
    const before = structuredClone(rows);

    foldEvents(rows, undefined, { registry: registry() });

    expect(rows).toEqual(before);
    expect(rows[0]?.v).toBe(1);
  });
});
