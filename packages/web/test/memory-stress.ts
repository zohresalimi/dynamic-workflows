/**
 * KAR-17.9 — a blackboard with three thousand facts on it, built rather than
 * recorded.
 *
 * AC7's acceptance bar is *"a fixture with 3,000 facts"*, and this is where it
 * comes from. It is deliberately **not** a seventh file under
 * `test/fixtures/runs/`: three thousand facts with their provenance and their
 * reads is roughly two megabytes of JSONL whose entire informational content is
 * a count, and a repository that carries it pays for it on every clone, every
 * `git grep` and every fixture-integrity spec forever. `stress-400` is in the
 * same family and is *assembled* by a script for the same reason
 * (`packages/core/scripts/build-ui-run-fixtures.ts`); this one is assembled at
 * the moment a spec asks for it.
 *
 * **Every envelope goes through the production `parseEvent`.** That is the
 * whole difference between a generated ledger and a hand-written one: a
 * payload-schema change in `@DeFlow/core` fails here loudly, rather than
 * leaving a stress fixture that folds cleanly into a projection and describes a
 * shape nothing on the wire produces.
 *
 * No `node:fs`, no `?raw` import and no DOM: it runs unchanged in the `unit`
 * project and in a browser spec, which is what lets the same three thousand
 * facts be asserted on both sides of the render.
 */
import { type Event, parseEvent } from '@DeFlow/core';

export interface MemoryStressOptions {
  /** How many plan nodes write facts. Each becomes one aggregate bubble. */
  readonly producers?: number;
  /** How many facts each of them writes. */
  readonly factsPerProducer?: number;
  /** How many other nodes read each fact. */
  readonly consumersPerFact?: number;
  /**
   * One fact in every `invalidateEvery` is invalidated, tainting its readers.
   * `0` invalidates nothing.
   */
  readonly invalidateEvery?: number;
}

export interface MemoryStressLedger {
  readonly runId: string;
  readonly events: readonly Event[];
  /** How many `fact.written` envelopes it holds — AC7's number. */
  readonly facts: number;
  readonly producers: readonly string[];
  readonly consumers: readonly string[];
}

/** The run these events belong to. Synthetic, and shaped like a real id. */
export const STRESS_RUN = 'run_20260811T120000Z_f00d17';

const HEX = '0123456789abcdef';

/** A 64-hex artifact handle, derived from `n` so the ledger is reproducible. */
function handle(n: number): string {
  let text = '';
  for (let index = 0; index < 64; index += 1) {
    text += HEX[(n * 31 + index * 7) % 16] as string;
  }
  return `artifact://${text}`;
}

/** `fact_` plus twenty-six lowercase base-36 digits, as `FactIdSchema` wants. */
const factId = (n: number): string => `fact_${n.toString(36).padStart(26, '0')}`;

/**
 * A ledger whose blackboard holds `producers × factsPerProducer` facts.
 *
 * The defaults are AC7's bar: thirty producing nodes, one hundred facts each,
 * two readers per fact — three thousand facts and six thousand reads, which is
 * a nine-hour run's worth of blackboard.
 */
export function memoryStressLedger(options: MemoryStressOptions = {}): MemoryStressLedger {
  const producerCount = options.producers ?? 30;
  const perProducer = options.factsPerProducer ?? 100;
  const consumersPerFact = options.consumersPerFact ?? 2;
  const invalidateEvery = options.invalidateEvery ?? 250;

  const producers = Array.from(
    { length: producerCount },
    (_, index) => `producer-${String(index)}`,
  );
  const consumers = Array.from({ length: 12 }, (_, index) => `consumer-${String(index)}`);

  const raw: unknown[] = [];
  let seq = 0;
  let written = 0;

  const at = (n: number): string =>
    new Date(Date.UTC(2026, 7, 11, 12, 0, 0) + n * 1000).toISOString();

  for (const [producerIndex, producer] of producers.entries()) {
    for (let n = 0; n < perProducer; n += 1) {
      seq += 1;
      const id = factId(producerIndex * perProducer + n + 1);
      const writtenAt = seq;
      raw.push({
        seq,
        runId: STRESS_RUN,
        ts: 1_786_449_600_000 + seq * 1000,
        epoch: 1,
        nodeId: producer,
        kind: 'fact.written',
        v: 1,
        payload: {
          fact: {
            id,
            key: `finding/f-${String(producerIndex)}-${String(n)}`,
            kind: 'finding',
            schemaId: 'DeFlow.finding.v1',
            value: { text: `observation ${String(n)} from ${producer}` },
            provenance: {
              byNode: producer,
              byProvider: 'claude-code',
              byModel: 'sonnet-4-6',
              fromEvidence: [handle(written)],
              atEvent: writtenAt,
              at: at(seq),
              confidence: 'verified',
            },
          },
        },
      });
      written += 1;

      const readers: string[] = [];
      for (let c = 0; c < consumersPerFact; c += 1) {
        const reader = consumers[(producerIndex + n + c) % consumers.length] as string;
        readers.push(reader);
        seq += 1;
        raw.push({
          seq,
          runId: STRESS_RUN,
          ts: 1_786_449_600_000 + seq * 1000,
          epoch: 1,
          nodeId: reader,
          kind: 'fact.read',
          v: 1,
          payload: {
            factId: id,
            key: `finding/f-${String(producerIndex)}-${String(n)}`,
            by: reader,
          },
        });
      }

      if (invalidateEvery > 0 && written % invalidateEvery === 0) {
        seq += 1;
        raw.push({
          seq,
          runId: STRESS_RUN,
          ts: 1_786_449_600_000 + seq * 1000,
          epoch: 1,
          nodeId: producer,
          kind: 'fact.invalidated',
          v: 1,
          payload: {
            factId: id,
            by: producer,
            reason: 'superseded by a later observation',
            // The daemon's list, carried as given: every reader whose
            // `fact.read` sits before this event.
            taints: readers,
          },
        });
      }
    }
  }

  const events = raw.map((line, index) => {
    const parsed = parseEvent(line);
    if (parsed.status !== 'ok') {
      throw new Error(
        `the generated stress ledger is not readable by this build at line ${String(index + 1)}: ` +
          JSON.stringify(parsed),
      );
    }
    return parsed.event;
  });

  return { runId: STRESS_RUN, events, facts: written, producers, consumers };
}
