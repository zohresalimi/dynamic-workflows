/**
 * KAR-02.1 — the run-scoped `NodeId` registry.
 *
 * docs/04-domain-model.md §1.1: a retired id is never reused, including
 * across replans, including after the branch it belonged to was abandoned.
 * "The planner allocates ids from a run-scoped registry held in the ledger,
 * not from a counter in memory." This is that registry's in-memory shape;
 * `@DeFlow/ledger` is responsible for persisting and rehydrating it.
 *
 * Verifies: EPIC-02-S3 (id-registry half) · AC6
 */
import type { NodeId } from './ids.ts';

/** Thrown by `NodeIdRegistry.allocate()` when the id is already active or
 * was previously retired. `KAR-02.4`'s patch validator is expected to catch
 * this and surface it as a `'node-id-reused'` patch error. */
export class NodeIdReused extends Error {
  readonly nodeId: NodeId;

  constructor(nodeId: NodeId) {
    super(
      `NodeId "${nodeId}" cannot be allocated: it is already active or was retired earlier in this run and ids are never reused.`,
    );
    this.name = 'NodeIdReused';
    this.nodeId = nodeId;
  }
}

export class NodeIdRegistry {
  readonly #active = new Set<NodeId>();
  readonly #retired = new Set<NodeId>();

  /** Allocates `id` as a new, active node. Throws `NodeIdReused` if `id` is
   * already active or was retired earlier in this run. */
  allocate(id: NodeId): void {
    if (this.#active.has(id) || this.#retired.has(id)) {
      throw new NodeIdReused(id);
    }
    this.#active.add(id);
  }

  /** Retires `id` — `split-node` and `abandon` operations call this rather
   * than deleting the node. The id moves from active to permanently retired;
   * it is never returned to the active set again. */
  retire(id: NodeId): void {
    if (!this.#active.has(id)) {
      throw new Error(
        `cannot retire NodeId "${id}": it was never allocated as active in this registry.`,
      );
    }
    this.#active.delete(id);
    this.#retired.add(id);
  }

  isActive(id: NodeId): boolean {
    return this.#active.has(id);
  }

  isRetired(id: NodeId): boolean {
    return this.#retired.has(id);
  }
}
