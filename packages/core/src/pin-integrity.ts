/**
 * KAR-09.3 — the integrity check: about fifteen lines, and the highest
 * value-per-line in the backlog.
 *
 * docs/08-context-and-memory.md §4.1 prints it in full. Two details of the
 * printed version change here and neither changes what it checks:
 *
 *   - **It is async.** The document's `createHash` comes from `node:crypto`,
 *     and @DeFlow/core imports no `node:` builtin (R1). `contentHash` uses the
 *     Web Crypto global, whose digest is a promise. The check runs once per
 *     dispatch, against five segments; the cost is unmeasurable either way.
 *   - **It takes a view, not a `ContextPacket`.** The caller that matters most
 *     is the adapter, immediately before it spawns a process, and what it
 *     holds there is the pinned slice of the packet rather than the packet.
 *     `ContextPacket` satisfies `PinnedPacketView` structurally, so the
 *     signature AC5 names still typechecks.
 *
 * Both halves of the predicate are load-bearing and it is easy to "simplify"
 * away either one. `rendered.includes(seg.text)` catches a render path that
 * lost a pin — which is the failure the check exists for, and the reason it
 * takes `rendered` at all rather than checking the manifest against itself.
 * `sha256(seg.text) !== seg.contentHash` catches a packet mutated after the
 * digest was taken, where the bytes in the prompt are present and *wrong*.
 *
 * And it collects before it throws. A loop that returned on the first miss
 * would report one vanished pin out of three, which sends a human to look at
 * the wrong rendering path.
 *
 * Verifies: EPIC-09-S14, EPIC-09-S16, EPIC-09-S17, EPIC-09-S18 · AC4, AC5
 */
import { contentHash } from './hash.ts';
import type { SegmentId } from './ids.ts';
import { NodeFailureError } from './node-failure.ts';

/** The fields the check reads. A `Segment` has all of them. */
export interface PinnedSegmentView {
  readonly id: SegmentId;
  readonly text: string;
  readonly contentHash: string;
  readonly pinned: boolean;
}

/** A `ContextPacket`, or any other carrier of the segments about to be sent. */
export interface PinnedPacketView {
  readonly segments: readonly PinnedSegmentView[];
}

/** Which half of the predicate failed, kept because the two send a reader to
 * different places: `absent` is a rendering bug, `digest` is a mutated packet. */
export type PinViolationKind = 'absent' | 'digest';

export interface PinViolation {
  readonly id: SegmentId;
  readonly contentHash: string;
  readonly kind: PinViolationKind;
}

/**
 * The failure a vanished pin raises, tagged so `toNodeFailure` maps it without
 * a second lookup table.
 *
 * `class: 'gate'` rather than `'permanent'`, and never `'transient'`: *"a pin
 * that vanished is either a bug in the packet builder or a rendering path
 * nobody expected, and both want a human."* A gate suspends the node and stops
 * the run for a person; a permanent failure would poison the branch and move
 * on, and a transient one would retry the same broken render three times.
 */
export class PinIntegrityViolation extends NodeFailureError {
  readonly missingDigests: readonly string[];
  readonly segmentIds: readonly SegmentId[];
  readonly violations: readonly PinViolation[];

  constructor(violations: readonly PinViolation[]) {
    const missingDigests = violations.map((violation) => violation.contentHash);
    const segmentIds = violations.map((violation) => violation.id);
    super(describe(violations), {
      reason: 'safety.pin-integrity-violated',
      class: 'gate',
      detail: { missingDigests, segmentIds },
    });
    this.name = 'PinIntegrityViolation';
    this.missingDigests = missingDigests;
    this.segmentIds = segmentIds;
    this.violations = violations;
  }
}

/** One line, because it becomes `NodeFailure.message` and a board cell renders
 * it. It names each segment and which half of the check it failed. */
function describe(violations: readonly PinViolation[]): string {
  const parts = violations.map((violation) =>
    violation.kind === 'absent'
      ? `${violation.id} (present in the manifest, absent from the prompt)`
      : `${violation.id} (contentHash no longer matches its own text)`,
  );
  return `${violations.length} pinned segment${
    violations.length === 1 ? '' : 's'
  } did not survive rendering verbatim: ${parts.join('; ')}`;
}

/** Every pinned segment that did not survive, in packet order. */
export async function findPinViolations(
  packet: PinnedPacketView,
  rendered: string,
): Promise<readonly PinViolation[]> {
  const violations: PinViolation[] = [];
  for (const segment of packet.segments) {
    if (!segment.pinned) continue;
    if ((await contentHash(segment.text)) !== segment.contentHash) {
      violations.push({ id: segment.id, contentHash: segment.contentHash, kind: 'digest' });
      continue;
    }
    if (!rendered.includes(segment.text)) {
      violations.push({ id: segment.id, contentHash: segment.contentHash, kind: 'absent' });
    }
  }
  return violations;
}

/**
 * Throws `PinIntegrityViolation` when any pinned segment's bytes are not in
 * the outgoing prompt exactly as they were built; returns nothing when they
 * all are.
 *
 * A paraphrase, a reflow to 72 columns and a renumbered list are all failures
 * here, and that is the point: the paper's result is about *verbatim*
 * re-injection, so a paraphrase is an untested intervention. Tolerating
 * "harmless" formatting is how the check quietly stops meaning anything.
 */
export async function assertPinIntegrity(
  packet: PinnedPacketView,
  rendered: string,
): Promise<void> {
  const violations = await findPinViolations(packet, rendered);
  if (violations.length > 0) throw new PinIntegrityViolation(violations);
}

/**
 * The digests of every pinned segment, *after* verifying them — the value
 * `context.compacted.pinnedKept` carries (AC7).
 *
 * It returns the list rather than letting a caller assemble one from the
 * packet, because that is the difference between recording that the check
 * passed and recording that a packet had pins. Without it, "the check passed"
 * and "the check never ran" are indistinguishable in the ledger, and NF10
 * requires any state in the UI to be traceable to specific ledger events.
 */
export async function pinnedKept(
  packet: PinnedPacketView,
  rendered: string,
): Promise<readonly string[]> {
  await assertPinIntegrity(packet, rendered);
  return packet.segments.filter((segment) => segment.pinned).map((segment) => segment.contentHash);
}
