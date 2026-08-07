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
 * KAR-09.4 AC1 adds the last gate on the prose escape hatch. `contextSegment`
 * cannot name a `pinned.*` kind and `buildPacket` refuses a segment that
 * arrives already flagged, which leaves exactly one hole: an object literal
 * wearing a pinned kind without the flag. This is where it has to be caught,
 * because the renderer is the last thing between a hand-written string and the
 * prompt — and a hand-written `pinned.constraints` line is precisely the
 * *"free-prose path into a pinned.constraints segment"* §4.2(b) exists to
 * remove.
 *
 * Verifies: EPIC-09-S14 (second scenario), EPIC-09-S21 (second scenario) ·
 * KAR-09.3 AC3 · KAR-09.4 AC1
 */
import { renderOrderOf, type Segment } from './context-packet.ts';

/** One blank line between segments: enough to separate them for a reader,
 * and — because it is a *join* rather than a per-segment wrapper — it never
 * lands inside a pinned segment's bytes. */
const SEPARATOR = '\n\n';

/**
 * A segment carrying a `pinned.*` kind that no pinned builder produced.
 *
 * Refused rather than rendered unpinned, which would be the worst of both: the
 * text would reach the model looking like a pinned constraint while being
 * compactable, demotable and invisible to `assertPinIntegrity`.
 */
export class FreeProsePinnedSegment extends Error {
  readonly segment: string;

  constructor(id: string, kind: string) {
    super(
      `segment "${id}" has the pinned kind "${kind}" but is not flagged pinned. There is no ` +
        'free-prose path into a pinned block: the five §4.1 content types are composed by ' +
        'buildPinnedSegments() from the approved spec, the node and the structured Constraint ' +
        'union, and every constraint line comes from a fixed template rather than from a string ' +
        'somebody wrote. Build it there, or give it one of the unpinned kinds.',
    );
    this.name = 'FreeProsePinnedSegment';
    this.segment = id;
  }
}

export function renderPacket(packet: { readonly segments: readonly Segment[] }): string {
  for (const segment of packet.segments) {
    if (segment.kind.startsWith('pinned.') && !segment.pinned) {
      throw new FreeProsePinnedSegment(segment.id, segment.kind);
    }
  }
  return renderOrderOf(packet)
    .map((segment) => segment.text)
    .join(SEPARATOR);
}
