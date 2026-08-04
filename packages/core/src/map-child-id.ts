/**
 * KAR-02.1 — deterministic map-child identity.
 *
 * `map` node children are materialised into the graph as real nodes with
 * real `NodeId`s (`<mapNodeId>--<itemId>`), because the scheduler, the effect
 * journal and the scrubber all need them to exist (docs/04-domain-model.md
 * §3). `'value-hash'` is the safe default: index-derived ids move whenever a
 * collection is re-derived after a replan, and moving ids is exactly what
 * §1.1 forbids.
 *
 * Verifies: EPIC-02-S4 · AC5
 */

import type { NodeId } from './ids.ts';
import { NodeIdSchema } from './ids.ts';

export type ItemIdFrom = 'index' | 'value-hash';

/** Canonical (key-sorted) JSON encoding, so object key order never changes
 * the hash. Good enough for id derivation; it is not the content-addressing
 * canonical encoder (that is KAR-02.9's `PlanHash`/`specHash` encoder). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',');
  return `{${body}}`;
}

/** FNV-1a, 32-bit, hex-encoded. Not cryptographic — it does not need to be:
 * this is an id-stability hash, not a security boundary, and `node:crypto`
 * is unavailable in `@DeFlow/core` by construction (R1). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derives a stable child `NodeId` for one item of a `map` node's collection.
 *
 * @param mapNodeId The parent `map` node's own id.
 * @param item The item value at this position, used verbatim when
 *   `itemIdFrom` is `'value-hash'`.
 * @param index The item's position in the collection, used only when
 *   `itemIdFrom` is `'index'`.
 * @param itemIdFrom
 *   `'value-hash'` (the default, and the only safe choice) derives the
 *   child id from a canonical hash of the item's value, so ids survive a
 *   collection that gets reordered, filtered, or re-derived by a replan.
 *
 *   **`'index'` is unsafe.** It exists because the architecture names it as
 *   a documented option, not because it should be reached for: §1.1 of
 *   docs/04-domain-model.md forbids moving `NodeId`s, and an index-derived
 *   id denotes a *different* item the moment the collection is reordered —
 *   the same id, silently pointing at different data. Use it only when the
 *   collection is provably append-only and never reordered or filtered.
 */
export function mapChildId(
  mapNodeId: NodeId,
  item: unknown,
  index: number,
  itemIdFrom: ItemIdFrom = 'value-hash',
): NodeId {
  const itemId = itemIdFrom === 'value-hash' ? fnv1aHex(canonicalJson(item)) : String(index);
  return NodeIdSchema.parse(`${mapNodeId}--${itemId}`);
}
