/**
 * KAR-16.3 — `blackboard.ts`: facts, provenance, consumer edges and taint
 * (F6.3, F10.4).
 *
 * Verifies: EPIC-16-S22, EPIC-16-S23 · AC10, AC11, AC12
 *
 * ## The consumer set is a query, not an inference
 *
 * `fact.read` exists as an event **only** so that "who used this?" is one
 * lookup rather than a graph walk over declared reads that may or may not have
 * been exercised. A projection that computed consumers from the current plan
 * would report what *could* have read the fact, and the whole value of the
 * memory view is what *did*.
 *
 * ## Taint is carried, never recomputed
 *
 * `fact.invalidated` names its own `taints[]`, computed daemon-side as the
 * consumers whose `fact.read` sits at a `seq` **earlier than the
 * invalidation** — a numeric comparison over `EventSeq`, never a timestamp one
 * (docs/04 §5.2). This projection records that list as given. Recomputing it
 * here from the consumer set the tab happens to hold would produce a different
 * answer on a tab that joined mid-run, and a taint list that depends on when
 * you opened the page is not a taint list.
 *
 * ## Reads can arrive before writes
 *
 * A tab that subscribed mid-burst gets backfilled from the connection's cursor,
 * so a `fact.read` for a fact written before that cursor is ordinary. The read
 * is held against the `factId` regardless, and the fact adopts it when (or if)
 * it arrives — the alternative silently under-reports the consumer set for the
 * life of the tab.
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export interface ProvenanceVM {
  readonly byNode: string;
  readonly byProvider: string;
  readonly byModel: string;
  readonly fromEvidence: readonly string[];
  /** The ordering key. Never `at`. */
  readonly atEvent: number;
  /** ISO 8601, display-only. */
  readonly at: string;
  readonly confidence: 'asserted' | 'verified' | 'speculative';
}

export interface ConsumerVM {
  readonly node: string;
  readonly seq: number;
}

export interface InvalidationVM {
  readonly by: string;
  readonly reason: string;
  readonly seq: number;
  readonly taints: readonly string[];
}

export interface FactVM {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly provenance: ProvenanceVM;
  readonly writtenAtSeq: number;
  readonly supersedes: string | null;
  consumers: ConsumerVM[];
  invalid: InvalidationVM | null;
}

/** One node's record of having used a fact that later proved wrong. */
export interface TaintVM {
  readonly factId: string;
  readonly reason: string;
  readonly by: string;
  readonly seq: number;
}

export interface BlackboardProjection {
  appliedSeq: number;
  facts: Map<string, FactVM>;
  /** `nodeId` → the facts it wrote, in order. The memory graph's default view. */
  byProducer: Map<string, string[]>;
  /** `nodeId` → every fact it consumed that was later invalidated. */
  taints: Map<string, TaintVM[]>;
  /** Reads whose fact this tab has not seen written. Adopted if it arrives. */
  orphanReads: Map<string, ConsumerVM[]>;
  /** Invalidations of a fact this tab has not seen written. Same reason. */
  orphanInvalidations: Map<string, InvalidationVM>;
}

export function emptyBlackboard(): BlackboardProjection {
  return {
    appliedSeq: 0,
    facts: new Map(),
    byProducer: new Map(),
    taints: new Map(),
    orphanReads: new Map(),
    orphanInvalidations: new Map(),
  };
}

export function applyBlackboard(state: BlackboardProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'fact.written': {
      const fact = event.payload.fact;
      const held: FactVM = {
        id: fact.id,
        key: fact.key,
        kind: fact.kind,
        schemaId: fact.schemaId,
        value: fact.value,
        provenance: fact.provenance,
        writtenAtSeq: event.seq,
        supersedes: fact.supersedes ?? null,
        // Reads and invalidations that arrived first are adopted here rather
        // than lost. See the module note.
        consumers: state.orphanReads.get(fact.id) ?? [],
        invalid: state.orphanInvalidations.get(fact.id) ?? null,
      };
      state.orphanReads.delete(fact.id);
      state.orphanInvalidations.delete(fact.id);
      state.facts.set(fact.id, held);

      const produced = state.byProducer.get(fact.provenance.byNode) ?? [];
      if (!produced.includes(fact.id)) produced.push(fact.id);
      state.byProducer.set(fact.provenance.byNode, produced);
      return;
    }

    case 'fact.read': {
      const consumer: ConsumerVM = { node: event.payload.by, seq: event.seq };
      const held = state.facts.get(event.payload.factId);
      if (held === undefined) {
        const waiting = state.orphanReads.get(event.payload.factId) ?? [];
        waiting.push(consumer);
        state.orphanReads.set(event.payload.factId, waiting);
        return;
      }
      // Deduplicated on the reading node: a node that reads the same fact on
      // each of three attempts is one consumer, not three, and the memory graph
      // draws one edge.
      if (held.consumers.some((one) => one.node === consumer.node)) return;
      held.consumers.push(consumer);
      return;
    }

    case 'fact.invalidated': {
      const invalidation: InvalidationVM = {
        by: event.payload.by,
        reason: event.payload.reason,
        seq: event.seq,
        taints: [...event.payload.taints],
      };

      const held = state.facts.get(event.payload.factId);
      if (held === undefined) state.orphanInvalidations.set(event.payload.factId, invalidation);
      else held.invalid = invalidation;

      for (const node of invalidation.taints) {
        const tainted = state.taints.get(node) ?? [];
        if (tainted.some((one) => one.factId === event.payload.factId)) continue;
        tainted.push({
          factId: event.payload.factId,
          reason: invalidation.reason,
          by: invalidation.by,
          seq: event.seq,
        });
        state.taints.set(node, tainted);
      }
      return;
    }

    default:
      ignored<'blackboard'>(event as Ignorable<'blackboard'>);
      return;
  }
}
