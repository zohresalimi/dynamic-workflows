/**
 * KAR-03.5 — upcasters run on the way into the reducer, and the ledger is
 * never rewritten (EPIC-03-S17), against a real file-backed ledger.
 *
 * Every kind this build ships is at v1, so the three-version chain the
 * scenario asks for is supplied by the test's own registry: `node.completed`
 * declared at v3, with the hops that lift a v1 and a v2 payload into the shape
 * the current schema accepts. The code under test is unchanged — `parseEvent`
 * reads the current version off whichever registry it is handed — and the
 * ledger is the real thing, which is the half that matters here: the scenario's
 * second claim is about *stored bytes*, and only a real database can be asked
 * whether it rewrote a row.
 *
 * Verifies: EPIC-03-S17 · AC4
 */
import {
  EVENT_CURRENT_VERSIONS,
  EVENT_SCHEMAS,
  foldEvents,
  initialRunState,
  UpcasterRegistry,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { expect, describe as suite } from 'vitest';
import { z } from 'zod';
import { appendEvents, drainEvents, type EventDraft, openLedger } from '../../src/index.ts';
import { RUN_A } from './support/events.ts';

const TS = 1_754_308_293_000;
const SHA = `sha256-${'a'.repeat(64)}`;
const HANDLE = `artifact://${'b'.repeat(64)}`;
const usage = { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' } as const;

const resultV3 = (node: string) => ({
  status: 'completed',
  output: { summary: `${node} done` },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage,
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [HANDLE],
});

/** v2 predates `artifacts`; v1 predates the `result` wrapper entirely. */
const payloadV2 = (node: string) => {
  const { artifacts: _later, ...result } = resultV3(node);
  return { node, attempt: 0, result };
};

const payloadV1 = (node: string) => ({
  node,
  attempt: 0,
  output: { summary: `${node} done` },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage,
  costUsd: 0.42,
});

const NodeCompletedV2Schema = z.strictObject({
  node: z.string(),
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

/** A build in which `node.completed` has reached v3, with both hops registered. */
function registryAtV3(): UpcasterRegistry {
  const registry = new UpcasterRegistry({ ...EVENT_CURRENT_VERSIONS, 'node.completed': 3 });
  registry.register({
    kind: 'node.completed',
    from: 1,
    to: NodeCompletedV2Schema,
    fixture: payloadV1('step-01'),
    up: (payload) => {
      const flat = payload as ReturnType<typeof payloadV1>;
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
  registry.register({
    kind: 'node.completed',
    from: 2,
    to: EVENT_SCHEMAS['node.completed'].payload,
    fixture: payloadV2('step-01'),
    up: (payload) => {
      const at2 = payload as { node: string; attempt: number; result: object };
      return { ...at2, result: { ...at2.result, artifacts: [HANDLE] } };
    },
  });
  return registry;
}

const draftOf = (kind: string, v: number, payload: unknown): EventDraft => ({
  runId: RUN_A,
  ts: TS,
  kind,
  v,
  epoch: 1,
  payload,
});

/** One ledger holding v1, v2 and v3 payloads for the same kind. */
function seedMixed(tmp: string) {
  const db = openLedger(tmp);
  appendEvents(db, [
    draftOf('run.started', 1, { planHash: SHA }),
    draftOf('node.completed', 1, payloadV1('step-01')),
    draftOf('node.completed', 2, payloadV2('step-02')),
    draftOf('node.completed', 3, resultV3AsPayload('step-03')),
  ]);
  return db;
}

/** Only for the all-v3 comparison ledger. */
function seedAllV3(tmp: string) {
  const db = openLedger(tmp);
  appendEvents(db, [
    draftOf('run.started', 1, { planHash: SHA }),
    draftOf('node.completed', 3, resultV3AsPayload('step-01')),
    draftOf('node.completed', 3, resultV3AsPayload('step-02')),
    draftOf('node.completed', 3, resultV3AsPayload('step-03')),
  ]);
  return db;
}

function resultV3AsPayload(node: string) {
  return { node, attempt: 0, result: resultV3(node) };
}

const fold = (db: ReturnType<typeof openLedger>) =>
  foldEvents(drainEvents(db, RUN_A), initialRunState(), { registry: registryAtV3() });

suite('a mixed-version ledger reduces correctly', () => {
  it('lifts every payload to v3 before reduce sees it', ({ tmp }) => {
    const db = seedMixed(tmp);
    try {
      const report = fold(db);

      expect(report.unreadable).toEqual([]);
      expect(report.applied).toBe(4);
      for (const node of ['step-01', 'step-02', 'step-03']) {
        expect(report.state.nodes[node]?.result?.artifacts).toEqual([HANDLE]);
      }
    } finally {
      db.close();
    }
  });

  it('reduces to state deeply equal to the all-v3 ledger of equivalent events', ({ tmp }) => {
    // Two data directories, because a ledger is a directory and one process
    // may hold only one writer per file (KAR-03.1).
    mkdirSync(`${tmp}/mixed`, { recursive: true });
    mkdirSync(`${tmp}/all-v3`, { recursive: true });
    const mixed = seedMixed(`${tmp}/mixed`);
    const allV3 = seedAllV3(`${tmp}/all-v3`);
    try {
      expect(fold(mixed).state).toEqual(fold(allV3).state);
    } finally {
      mixed.close();
      allV3.close();
    }
  });
});

suite('the ledger is not rewritten by the fold', () => {
  it('leaves the stored payload text byte-identical, and v still 1', ({ tmp }) => {
    const db = seedMixed(tmp);
    try {
      const raw = () =>
        db
          .prepare<{ seq: number; v: number; payload: string }>(
            'SELECT seq, v, payload FROM event WHERE run_id = ? ORDER BY seq',
          )
          .all(RUN_A);
      const before = raw();

      fold(db);

      const after = raw();
      expect(after).toEqual(before);
      expect(after[1]?.v).toBe(1);
      expect(after[1]?.payload).toContain('"outputSchemaId"');
      // The v1 row never learned about `result` or `artifacts`.
      expect(after[1]?.payload).not.toContain('"artifacts"');
    } finally {
      db.close();
    }
  });

  it('reads the same state again from the untouched rows', ({ tmp }) => {
    const db = seedMixed(tmp);
    try {
      expect(fold(db).state).toEqual(fold(db).state);
    } finally {
      db.close();
    }
  });
});
