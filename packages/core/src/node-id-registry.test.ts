/**
 * KAR-02.1 — retired NodeIds are never reused.
 *
 * A node whose lifecycle is `superseded` or `abandoned` stays in the graph
 * (docs/04-domain-model.md §1.1) and its id must be refused if a later patch
 * tries to allocate it again — the planner allocates ids from this run-scoped
 * registry, not from a counter in memory.
 *
 * Verifies: EPIC-02-S3 (id-registry half) · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeIdSchema } from './ids.ts';
import { NodeIdRegistry, NodeIdReused } from './node-id-registry.ts';

suite('NodeIdRegistry', () => {
  it('allocates a fresh id without error', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('migrate-forms');
    expect(() => registry.allocate(id)).not.toThrow();
    expect(registry.isActive(id)).toBe(true);
  });

  it('allocate(id) twice on a registry seeded with a retired id throws NodeIdReused', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('recon-auth-surface');

    registry.allocate(id);
    registry.retire(id);

    expect(() => registry.allocate(id)).toThrow(NodeIdReused);
    expect(registry.isRetired(id)).toBe(true);
  });

  it('the thrown error names the reused id', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('migrate-forms');
    registry.allocate(id);
    registry.retire(id);

    expect.assertions(2);
    try {
      registry.allocate(id);
    } catch (error) {
      expect(error).toBeInstanceOf(NodeIdReused);
      expect((error as NodeIdReused).nodeId).toBe(id);
    }
  });

  it('refuses to allocate an id that is currently active, not only a retired one', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('migrate-forms');
    registry.allocate(id);
    expect(() => registry.allocate(id)).toThrow(NodeIdReused);
  });

  it('a retired node id remains present in the graph as a concept: retiring twice is refused rather than silently ignored', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('migrate-forms');
    registry.allocate(id);
    registry.retire(id);
    expect(() => registry.retire(id)).toThrow();
  });

  it('refuses to retire an id that was never allocated', () => {
    const registry = new NodeIdRegistry();
    const id = NodeIdSchema.parse('never-allocated');
    expect(() => registry.retire(id)).toThrow();
  });
});
