/**
 * KAR-27.9 AC1 — the join between the ledger's `process` row and the live ACP
 * connection, so that `protocolCancel` has a production implementation.
 *
 * **The gap this closes.** `cancel.ts` documents rung 1 as *"performed by the
 * live turn through `protocolCancel`, because the connection is the adapter's,
 * not the ledger's"* — and until this file, nothing in the shipped tree ever
 * supplied that port. The two integration specs that did supply it constructed
 * the `AbortController` themselves, next to the `runAcpNode` call, which is
 * exactly the shape production needs and exactly the shape production did not
 * have: the operator's cancel arrives at the *drive*, one tick later and three
 * modules away from whoever is holding the connection.
 *
 * So the performer registers its turn here on the way in and disposes on the
 * way out, and the drive asks this registry. Two properties matter:
 *
 * **Per-process by construction, and never durable.** A registration is a
 * promise this process is holding, exactly like `drive.ts`'s `framing` and
 * `executing` sets. A daemon that restarts holds nothing, `protocolCancel`
 * answers `false` for every attempt, and the honest consequence — a live
 * process nobody in this daemon can ask — is the wait KAR-27.6 already reports
 * with the pids named. Writing the registry down would make it a lie that
 * survives a crash.
 *
 * **The ask is delivered once, and the answer is awaited separately.** The
 * drive ticks once a second; a cooperative cancel that has not completed is
 * re-examined on every one of those ticks, and a `session/cancel` sent sixty
 * times is sixty notifications an agent has to ignore. The `cancel()` side is
 * therefore idempotent per turn, while `cancelled` resolves when the turn
 * really ended — which is after the tail is flushed, which is the whole reason
 * this ladder exists.
 *
 * Verifies: EPIC-27-S41 · KAR-27.9 AC1
 */
import type { ProcessKey } from '@DeFlow/ledger';

/** One in-flight agent turn, as everything outside the adapter needs it. */
export interface LiveTurn {
  /**
   * Asks the agent to stop, at the protocol level: aborts the turn's signal,
   * which is what sends `session/cancel` and **keeps the reader running** so
   * the tail arrives (docs/07-provider-adapter-layer.md §2.5).
   *
   * Never signals anything. A cooperative cancel that reached for a pid would
   * be the automatic escalation EPIC-19-S38 and EPIC-27-S30 forbid.
   */
  cancel(): void;
  /**
   * Resolves `true` once the turn ended *because* it was cancelled — the agent
   * answered `stopReason: 'cancelled'` and its transcript is durable — and
   * `false` for a turn that ended any other way, including one that never
   * answered at all.
   */
  readonly cancelled: Promise<boolean>;
}

export interface LiveTurns {
  /** Registers `turn` for `key`, and returns the dispose the performer calls in
   * its `finally`. A dispose whose registration has already been replaced does
   * nothing. */
  register(key: ProcessKey, turn: LiveTurn): () => void;
  /**
   * `CancelPorts.protocolCancel`'s shape, and the port the drive is given.
   *
   * `false` for an attempt this daemon holds no connection for: nothing was
   * asked, and — the part that matters — nothing was signalled either.
   */
  protocolCancel(key: ProcessKey): Promise<boolean>;
  /** Whether this daemon is holding a connection for `key`. */
  holds(key: ProcessKey): boolean;
  /** How many turns are registered. For a shutdown that would rather not close
   * the ledger underneath one. */
  readonly size: number;
}

/** One attempt, addressed as the `process` table addresses it. */
function idOf(key: ProcessKey): string {
  return `${key.runId}/${key.nodeId}/${String(key.attempt)}`;
}

interface Entry {
  readonly turn: LiveTurn;
  /** Whether `cancel()` has already been delivered for this turn. */
  asked: boolean;
}

export function createLiveTurns(): LiveTurns {
  const entries = new Map<string, Entry>();

  return {
    register(key, turn) {
      const id = idOf(key);
      const entry: Entry = { turn, asked: false };
      entries.set(id, entry);
      return () => {
        // Only if it is still *this* registration. A retry that spawned a new
        // attempt under the same key while the old one was unwinding would
        // otherwise be evicted by its predecessor's `finally`.
        if (entries.get(id) === entry) entries.delete(id);
      };
    },

    protocolCancel(key) {
      const entry = entries.get(idOf(key));
      if (entry === undefined) return Promise.resolve(false);
      if (!entry.asked) {
        entry.asked = true;
        entry.turn.cancel();
      }
      return entry.turn.cancelled;
    },

    holds(key) {
      return entries.has(idOf(key));
    },

    get size() {
      return entries.size;
    },
  };
}
