/**
 * KAR-09.3 — `renderPacket(packet) -> string`: pure, total, and pinned first.
 *
 * Ordering is the whole story. arXiv 2606.22528's finding is that a constraint
 * which survives compaction is honoured and one that does not is not, and the
 * cheapest way to lose one is to render it *after* the task brief, where a
 * later summariser or a vendor's own compaction reaches it first. So the order
 * is a property of the renderer, not of whoever assembled the packet:
 * `renderOrderOf` (KAR-02.6) puts every pinned segment first and everything
 * else in `sourceEvent` order, and this function does nothing but join what it
 * returns.
 *
 * No clock, no I/O, no randomness — §12's *"`render(segments) -> string` is
 * pure"*. KAR-09.2 extends it with the fill order and the budget; what it must
 * not change is that the pinned block leads and that every segment's `text`
 * appears verbatim, because `assertPinIntegrity` is a substring check against
 * exactly these bytes.
 *
 * Verifies: EPIC-09-S14 (second scenario) · AC3
 */
import { renderOrderOf, type Segment } from './context-packet.ts';

/** One blank line between segments: enough to separate them for a reader,
 * and — because it is a *join* rather than a per-segment wrapper — it never
 * lands inside a pinned segment's bytes. */
const SEPARATOR = '\n\n';

export function renderPacket(packet: { readonly segments: readonly Segment[] }): string {
  return renderOrderOf(packet)
    .map((segment) => segment.text)
    .join(SEPARATOR);
}
