/**
 * KAR-02.1 — deterministic map-child identity.
 *
 * `itemIdFrom: 'value-hash'` is the schema default (docs/04-domain-model.md
 * §3): index-derived ids move when a collection is re-derived after a
 * replan, and moving ids is exactly what §1.1 forbids. The second suite
 * below deliberately asserts the *bad* behaviour of `'index'` so nobody
 * "simplifies" the default away.
 *
 * Verifies: EPIC-02-S4 · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeIdSchema } from './ids.ts';
import { mapChildId } from './map-child-id.ts';

const mapNodeId = NodeIdSchema.parse('migrate-components');

suite('mapChildId — itemIdFrom: value-hash (the safe default)', () => {
  it('returns the same id set regardless of item order in the collection', () => {
    const original = ['Header.vue', 'Footer.vue', 'Sidebar.vue'];
    const shuffled = ['Sidebar.vue', 'Footer.vue', 'Header.vue'];

    const idsFromOriginal = original.map((item, i) => mapChildId(mapNodeId, item, i, 'value-hash'));
    const idsFromShuffled = shuffled.map((item, i) => mapChildId(mapNodeId, item, i, 'value-hash'));

    expect(new Set(idsFromShuffled)).toEqual(new Set(idsFromOriginal));
  });

  it('is the default when itemIdFrom is omitted', () => {
    expect(mapChildId(mapNodeId, 'Header.vue', 0)).toBe(
      mapChildId(mapNodeId, 'Header.vue', 0, 'value-hash'),
    );
  });

  it('keeps the three original child ids stable and adds exactly one new id when the collection grows', () => {
    const before = ['Header.vue', 'Footer.vue', 'Sidebar.vue'];
    const after = ['Sidebar.vue', 'Header.vue', 'Footer.vue', 'Nav.vue'];

    const idsBefore = new Set(
      before.map((item, i) => mapChildId(mapNodeId, item, i, 'value-hash')),
    );
    const idsAfter = after.map((item, i) => mapChildId(mapNodeId, item, i, 'value-hash'));

    const retained = idsAfter.filter((id) => idsBefore.has(id));
    const added = idsAfter.filter((id) => !idsBefore.has(id));

    expect(new Set(retained)).toEqual(idsBefore);
    expect(added).toHaveLength(1);
  });

  it('every produced id is itself a valid NodeId', () => {
    const id = mapChildId(mapNodeId, 'Header.vue', 0, 'value-hash');
    expect(NodeIdSchema.safeParse(id).success).toBe(true);
    expect(id.startsWith('migrate-components--')).toBe(true);
  });
});

suite("mapChildId — itemIdFrom: 'index' (regression guard, not the default)", () => {
  it('the same position denotes a different item once the collection is reordered — this is why value-hash is the default', () => {
    const before = ['Header.vue', 'Footer.vue', 'Sidebar.vue'];
    const after = ['Sidebar.vue', 'Header.vue', 'Footer.vue'];

    const idAtZeroBefore = mapChildId(mapNodeId, before[0], 0, 'index');
    const idAtZeroAfter = mapChildId(mapNodeId, after[0], 0, 'index');

    // Same id...
    expect(idAtZeroAfter).toBe(idAtZeroBefore);
    // ...but a different item now sits behind it. Index-derived ids move.
    expect(before[0]).not.toBe(after[0]);
  });
});
