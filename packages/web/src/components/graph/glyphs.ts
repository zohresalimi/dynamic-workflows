/**
 * KAR-17.1 AC4 — the type glyph on a node body.
 *
 * A node's **state** and a node's **type** are two different facts and they get
 * two different glyph vocabularies: the state glyph says what is happening
 * (`../StateChip.vue`, seven silhouettes over `--state-*`), and this one says
 * what kind of work it is. An operator scanning a forty-node plan reads the
 * shape of the run — where the gates are, where the human steps are, where a
 * `map` fanned out — before reading a single title.
 *
 * A **total** `Record<NodeType, Component>` over `@DeFlow/core`'s own
 * `NODE_TYPES`, deliberately, and for the same reason `NODE_STATUS_DISPLAY` is
 * total: an eighth node type added to the domain fails the build here rather
 * than rendering as a blank box in one view that nobody looks at twice.
 *
 * A separate module rather than a `const` inside the component so the totality
 * is checkable without mounting anything.
 */
import type { NodeType } from '@DeFlow/core';
import {
  Bot,
  Boxes,
  Repeat,
  ShieldCheck,
  Split,
  SquareDashed,
  UserRound,
  Wrench,
} from 'lucide-vue-next';
import type { Component } from 'vue';

export const NODE_TYPE_GLYPHS: Record<NodeType, Component> = {
  /** An agent doing work in a worktree. */
  agent: Bot,
  /** A deterministic command. */
  tool: Wrench,
  /** A verification gate — the only nodes that produce a verdict. */
  gate: ShieldCheck,
  /** A step that suspends until a person answers. */
  human: UserRound,
  /** A fan-out over a collection. */
  map: Split,
  /** A bounded repeat — the repair loop's shape. */
  loop: Repeat,
  /** A nested plan. */
  subgraph: Boxes,
};

/**
 * The glyph for a node's type, or the dashed placeholder for one that has none.
 *
 * `PlanNodeVM.type` is `string | null` rather than `NodeType`: a node exists in
 * the plan before any document has described it, and a `map` fan-out's children
 * arrive before their type does. The placeholder says *"we do not know yet"* in
 * the same visual grammar as the rest — a box with no line in it — rather than
 * guessing `agent`, which is the type it would be wrong about most expensively.
 */
export function glyphFor(type: string | null): Component {
  if (type === null) return SquareDashed;
  return (NODE_TYPE_GLYPHS as Record<string, Component | undefined>)[type] ?? SquareDashed;
}
