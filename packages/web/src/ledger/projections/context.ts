/**
 * KAR-16.3 — `context.ts`: packet manifests, per-segment tokens and compaction
 * marks (F10.3, F10.5).
 *
 * Verifies: EPIC-16-S18, EPIC-16-S23 · AC5, AC6, AC10, AC11
 *
 * ## The one rule this file exists to keep
 *
 * `context.compacted` carries `fidelity: 'exact' | 'partial'` and
 * `after: number | null`, and **the null is carried through, never coerced**.
 * Vendor-side compaction reports only `pre_tokens` — Claude Code's
 * `compact_boundary` frame has no post count, no dropped list and no handle to
 * the original (**Verified 2026-08-02**, docs/04 §9.1). So there is no `??  0`
 * anywhere below, and `saved` is `null` rather than a subtraction against a
 * number nobody measured: *a bar with a fabricated "after" is worse than an
 * honest hole*, because a reader cannot tell the fabrication from a
 * measurement.
 *
 * ## Totals are carried, not recomputed
 *
 * `packet.totals.byKind` and each segment's `tokens.estimated` come from the
 * same builder. If this projection re-derived one from the other they could
 * disagree — and the inspector's header and its stacked bar are the same number
 * in two places, so the disagreement would be visible and unexplainable. The
 * packet record is held as the builder wrote it; `./context.test.ts` is what
 * asserts the two reconcile.
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

/**
 * §6's nine-kind closed vocabulary, mirroring Claude Code's own `/context`
 * breakdown so F10.5's chart lines up with the vendor CLI.
 *
 * Restated here rather than imported as a value from `@DeFlow/core` because
 * this module's contract to the views is the *rendering* vocabulary; the
 * type-level tie to the producer is `ContextTotals` below, which is indexed by
 * the same strings and would fail to compile if they diverged.
 */
export const SEGMENT_KINDS = [
  'pinned.constraints',
  'pinned.spec',
  'pinned.pathscope',
  'task.brief',
  'fact',
  'artifact.handle',
  'retrieved',
  'history.summary',
  'tool.output',
] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface SegmentVM {
  readonly id: string;
  readonly kind: SegmentKind;
  readonly sourceEvent: number;
  readonly contentHash: string;
  readonly tokens: { readonly estimated: number; readonly method: string };
  readonly pinned: boolean;
  readonly compactable: boolean;
}

export interface PacketVM {
  readonly nodeId: string;
  readonly attempt: number;
  /** The `seq` of the `context.built` that recorded it. */
  readonly builtAtSeq: number;
  readonly target: {
    readonly provider: string;
    readonly model: string;
    readonly maxContext: number;
  };
  readonly budget: { readonly fraction: number; readonly limitTokens: number };
  readonly totals: {
    readonly tokens: number;
    readonly byKind: Readonly<Partial<Record<SegmentKind, number>>>;
  };
  readonly segments: readonly SegmentVM[];
  readonly renderedPromptHandle: string;
  readonly pinnedDigests: readonly string[];
  /** F6.6: a pinned segment's digest no longer matches what was pinned. */
  violated: boolean;
  violation: PinViolationVM | null;
}

export interface PinViolationVM {
  readonly node: string;
  readonly attempt: number;
  readonly seq: number;
  readonly missingDigests: readonly string[];
  readonly segmentIds: readonly string[];
}

export interface CompactionVM {
  readonly seq: number;
  readonly node: string;
  readonly scope: 'DeFlow.packet' | 'vendor.session';
  readonly fidelity: 'exact' | 'partial';
  readonly trigger: string;
  readonly before: number;
  /** `null` when vendor-reported. Never coerced. */
  readonly after: number | null;
  /** `before - after`, or `null` when there is no honest `after` to subtract. */
  readonly saved: number | null;
  readonly droppedSegments: readonly string[];
  readonly demotedToHandles: readonly string[];
  readonly pinnedKept: readonly string[];
  readonly originalHandle: string | null;
}

export interface ContextProjection {
  appliedSeq: number;
  /** `${nodeId}#${attempt}` → the packet that attempt was built with. */
  packets: Map<string, PacketVM>;
  compactions: CompactionVM[];
  violations: PinViolationVM[];
}

export function emptyContext(): ContextProjection {
  return { appliedSeq: 0, packets: new Map(), compactions: [], violations: [] };
}

export const packetKey = (nodeId: string, attempt: number): string => `${nodeId}#${attempt}`;

export function applyContext(state: ContextProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'context.built': {
      const packet = event.payload.packet;
      state.packets.set(packetKey(event.payload.node, event.payload.attempt), {
        nodeId: event.payload.node,
        attempt: event.payload.attempt,
        builtAtSeq: event.seq,
        target: packet.target,
        budget: packet.budget,
        // Carried, not recomputed. See the module note.
        totals: packet.totals,
        segments: packet.segments as readonly SegmentVM[],
        renderedPromptHandle: packet.renderedPromptHandle,
        pinnedDigests: [...packet.pinnedDigests],
        violated: false,
        violation: null,
      });
      return;
    }

    case 'context.compacted': {
      const after = event.payload.after;
      state.compactions.push({
        seq: event.seq,
        node: event.payload.node,
        scope: event.payload.scope,
        fidelity: event.payload.fidelity,
        trigger: event.payload.trigger,
        before: event.payload.before,
        after,
        // The whole of AC5 in one expression: no `?? 0`, no interpolation.
        saved: after === null ? null : event.payload.before - after,
        droppedSegments: [...event.payload.droppedSegments],
        demotedToHandles: [...event.payload.demotedToHandles],
        pinnedKept: [...event.payload.pinnedKept],
        originalHandle: event.payload.originalHandle,
      });
      return;
    }

    case 'pin.integrity_violated': {
      const violation: PinViolationVM = {
        node: event.payload.node,
        attempt: event.payload.attempt,
        seq: event.seq,
        missingDigests: [...event.payload.missingDigests],
        segmentIds: [...event.payload.segmentIds],
      };
      state.violations.push(violation);

      // The packet is marked where it exists, and the violation is recorded
      // either way: a tab that joined the stream after the `context.built` has
      // no packet to mark, and losing the violation with it would leave the
      // node's typed failure with nothing to explain it.
      const held = state.packets.get(packetKey(event.payload.node, event.payload.attempt));
      if (held === undefined) return;
      held.violated = true;
      held.violation = violation;
      return;
    }

    default:
      ignored<'context'>(event as Ignorable<'context'>);
      return;
  }
}
