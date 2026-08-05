/**
 * KAR-05.5 AC3 — the prompt `ResumeByReplay` sends, rebuilt from the ledger.
 *
 * This is the module that makes the design rule true rather than aspirational:
 * every prompt DeFlow sends must be reconstructible from its own log alone. It
 * reads two things — the `context.built` event for the node's attempt, and the
 * segment bytes out of DeFlow's own content-addressed store — and it reads
 * **no vendor session file and no vendor API**. That is what lets a Copilot or
 * Gemini node, which cannot resume at all, survive a crash on exactly the same
 * terms as a Claude one.
 *
 * Everything derivable is re-derived rather than copied. Each segment's bytes
 * are re-hashed and checked against the `contentHash` the record claims, the
 * pinned digest list is rebuilt from the segments that are pinned, the prompt
 * is re-rendered in `renderOrderOf`'s order, and the rendered bytes are hashed
 * and checked against `renderedPromptHandle`. A record whose store has drifted
 * underneath it is refused, loudly, rather than sent to an agent as if it were
 * the original context — a resume that silently substitutes different bytes is
 * the same class of corruption the version guard exists to prevent.
 *
 * What is *not* re-derived is the per-segment token count: counting tokens
 * needs the tokenizer EPIC-14 installs, and inventing a number here would make
 * the F10.5 context chart disagree with itself. The recorded counts are
 * reconciled against `totals` instead, through core's own
 * `packetTotalsAreConsistent`.
 */
import {
  type ContextPacket,
  type ContextPacketRecord,
  ContextPacketRecordSchema,
  contentHash,
  type EventSeq,
  NodeFailureError,
  type NodeId,
  packetTotalsAreConsistent,
  renderOrderOf,
  type Segment,
  sha256Hex,
} from '@DeFlow/core';

/** One control-plane row as a resume reads it back: no envelope opinions. */
export interface LedgerEventRow {
  readonly seq: EventSeq;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Where segment bytes come from: DeFlow's blob store, keyed by the segment's
 * own `contentHash`.
 *
 * A port rather than a `readFileSync`, for the reason every port in this
 * package exists — @DeFlow/adapters owns no store (docs/16-repo-layout.md R2).
 * `null` means "not there", which is a refusal and never an empty segment.
 */
export interface PacketSources {
  readSegmentText(contentHash: string): string | null;
}

export interface ReconstructedPacket {
  /** The record as re-derived here — byte-identical to `recorded` or refused. */
  readonly packet: ContextPacketRecord;
  /** The record exactly as `context.built` carried it. */
  readonly recorded: ContextPacketRecord;
  /** The bytes to send. */
  readonly prompt: string;
}

/**
 * What separates two segments in the rendered prompt.
 *
 * Stated once, here, because the round trip is only a proof if the forward and
 * backward directions agree on it — and a blank line between segments is what
 * every vendor's prompt formatting expects anyway.
 */
export const SEGMENT_SEPARATOR = '\n\n';

/**
 * The one definition of "the rendered prompt": pinned segments first, then
 * everything else in `sourceEvent` order (AC6 of KAR-02.6), joined.
 *
 * Exported because EPIC-09's packet builder must render through this function
 * rather than through its own copy. Two renderers is one drift away from a
 * replay that sends different bytes than the original attempt did.
 */
export function renderPrompt(packet: ContextPacket): string {
  return renderOrderOf(packet)
    .map((segment) => segment.text)
    .join(SEGMENT_SEPARATOR);
}

/**
 * DeFlow's own state does not add up: no packet was recorded for this attempt,
 * the payload does not parse, or the totals disagree with the segments.
 *
 * `internal` is the honest slot — this is not the agent misbehaving and not the
 * machine being unavailable, it is DeFlow's log failing to describe its own
 * run — and `permanent` because nothing about it changes between attempts.
 */
function packetNotReconstructible(
  message: string,
  detail: Record<string, unknown>,
): NodeFailureError {
  return new NodeFailureError(message, { reason: 'internal', class: 'permanent', detail });
}

/**
 * A segment's bytes are gone or no longer hash to what the record says.
 *
 * `safety.pin-integrity-violated` with the detail shape `pin.integrity_violated`
 * carries, so the event a caller writes from this failure needs no translation.
 * The reason is F6.6's, and it holds for an unpinned segment too: the check is
 * defined over `contentHash`, and a packet whose bytes changed under a resume
 * is corrupt whichever segment moved.
 */
function segmentIntegrityViolated(
  node: NodeId,
  attempt: number,
  broken: readonly { readonly id: string; readonly contentHash: string; readonly why: string }[],
): NodeFailureError {
  return new NodeFailureError(
    `cannot rebuild the context packet for ${node} attempt ${attempt}: ` +
      broken.map((segment) => `${segment.id} ${segment.why}`).join('; '),
    {
      reason: 'safety.pin-integrity-violated',
      class: 'permanent',
      detail: {
        node,
        attempt,
        segmentIds: broken.map((segment) => segment.id),
        // The digests the record claims and the store could not produce —
        // exactly `pin.integrity_violated`'s `missingDigests`.
        missingDigests: broken.map((segment) => segment.contentHash.replace(/^sha256-/, '')),
      },
    },
  );
}

/** The last `context.built` recorded for this node and attempt, parsed. */
function recordedPacketFor(
  history: readonly LedgerEventRow[],
  target: { readonly nodeId: NodeId; readonly attempt: number },
): ContextPacketRecord {
  const candidates = history.filter((row) => {
    if (row.kind !== 'context.built') return false;
    if (typeof row.payload !== 'object' || row.payload === null) return false;
    const payload = row.payload as { node?: unknown; attempt?: unknown };
    return payload.node === target.nodeId && payload.attempt === target.attempt;
  });

  const last = candidates.at(-1);
  if (last === undefined) {
    throw packetNotReconstructible(
      `no context.built event for ${target.nodeId} attempt ${target.attempt}: the ledger cannot ` +
        'reconstruct the prompt for this attempt, and a replay resume does not invent one',
      { node: target.nodeId, attempt: target.attempt },
    );
  }

  const parsed = ContextPacketRecordSchema.safeParse(
    (last.payload as { packet?: unknown }).packet ?? null,
  );
  if (!parsed.success) {
    throw packetNotReconstructible(
      `the context.built payload at seq ${last.seq} is not a context packet record: ` +
        parsed.error.issues.map((issue) => issue.path.join('.') || '<root>').join(', '),
      { node: target.nodeId, attempt: target.attempt, seq: last.seq },
    );
  }
  return parsed.data;
}

export async function reconstructPacket(
  history: readonly LedgerEventRow[],
  target: { readonly nodeId: NodeId; readonly attempt: number },
  sources: PacketSources,
): Promise<ReconstructedPacket> {
  const recorded = recordedPacketFor(history, target);

  const segments: Segment[] = [];
  const broken: { id: string; contentHash: string; why: string }[] = [];

  for (const segment of recorded.segments) {
    const text = sources.readSegmentText(segment.contentHash);
    if (text === null) {
      broken.push({
        id: segment.id,
        contentHash: segment.contentHash,
        why: 'has no bytes in the store',
      });
      continue;
    }
    const rehashed = await contentHash(text);
    if (rehashed !== segment.contentHash) {
      broken.push({
        id: segment.id,
        contentHash: segment.contentHash,
        why: `hashes to ${rehashed}, not the ${segment.contentHash} the ledger recorded`,
      });
      continue;
    }
    // The re-derived digest, not the recorded one: if the two ever disagreed
    // the loop above has already refused, so this is the same value written
    // the honest way round.
    segments.push({ ...segment, contentHash: rehashed, text });
  }

  if (broken.length > 0) throw segmentIntegrityViolated(target.nodeId, target.attempt, broken);

  const withText: ContextPacket = {
    ...recorded,
    segments,
    pinnedDigests: segments
      .filter((segment) => segment.pinned)
      .map((segment) => segment.contentHash),
  };

  const totals = packetTotalsAreConsistent(withText);
  if (!totals.consistent) {
    throw packetNotReconstructible(
      `the context packet recorded for ${target.nodeId} attempt ${target.attempt} does not add ` +
        `up: ${totals.message}`,
      { node: target.nodeId, attempt: target.attempt, path: totals.path },
    );
  }

  const prompt = renderPrompt(withText);
  const renderedPromptHandle = `artifact://${await sha256Hex(prompt)}`;
  if (renderedPromptHandle !== recorded.renderedPromptHandle) {
    throw packetNotReconstructible(
      `the prompt rebuilt for ${target.nodeId} attempt ${target.attempt} hashes to ` +
        `${renderedPromptHandle}, but context.built recorded ${recorded.renderedPromptHandle}`,
      { node: target.nodeId, attempt: target.attempt },
    );
  }

  const packet = ContextPacketRecordSchema.parse({
    ...withText,
    renderedPromptHandle,
    segments: segments.map(({ text: _text, ...rest }) => rest),
  });

  return { packet, recorded, prompt };
}
