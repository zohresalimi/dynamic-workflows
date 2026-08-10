/**
 * Which node has a live terminal right now (KAR-15.8 AC1).
 *
 * The same registry pattern, and for the same reason, as `../http/ledger-view.ts`
 * and `../runtime.ts`: `pty-socket.ts` is reached from a module-level upgrade
 * listener, the executor is what owns the processes, and neither should have
 * to import the other. There is exactly one daemon per process — the lease in
 * `boot.ts` enforces that — so a module-level map is the honest cardinality.
 *
 * A node has at most one live pty: retries replace, they do not accumulate.
 * Registering a second session for the same node therefore evicts the first
 * rather than silently shadowing it, and unregistering only removes a session
 * that is still the registered one — otherwise a slow teardown of attempt 1
 * would delete attempt 2's terminal out from under a panel that had just
 * attached to it.
 */
import type { NodeId, RunId } from '@DeFlow/core';
import type { PtySession } from './pty-session.ts';

const sessions = new Map<string, PtySession>();

const keyOf = (runId: RunId, nodeId: NodeId): string => `${runId}/${nodeId}`;

/** Returns the unregister function, which is a no-op once superseded. */
export function registerPtySession(session: PtySession): () => void {
  const key = keyOf(session.runId, session.nodeId);
  sessions.set(key, session);
  return () => {
    if (sessions.get(key) === session) sessions.delete(key);
  };
}

/** The live terminal for a node, or null — which the socket answers as a 404. */
export function ptySessionFor(runId: RunId, nodeId: NodeId): PtySession | null {
  return sessions.get(keyOf(runId, nodeId)) ?? null;
}

/** Shutdown, and every test's teardown. Does not kill: that is the owner's job. */
export function clearPtySessions(): void {
  sessions.clear();
}
