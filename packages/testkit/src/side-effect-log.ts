/**
 * KAR-03.8 — the fake agents' own record of what they were asked to do, and
 * the duplicate check that turns it into an assertion (EPIC-03-S26).
 *
 * The crash-fuzz suite's first invariant is "no effect executed twice", and it
 * is deliberately **not** checked against the effect journal alone. The journal
 * is the mechanism that is supposed to prevent the second execution; reading it
 * back to ask whether a second execution happened proves only that it agrees
 * with itself. So every fake binary appends one line per invocation to a text
 * file, and the invariant becomes a duplicate-key check on that file — an
 * observation of the world, not an inference from the thing under test.
 *
 * Nothing here writes. `bin/fake-agent.ts` is the writer, from inside the
 * child process where the invocation actually happens.
 */
import { existsSync, readFileSync } from 'node:fs';

/** One invocation, as the fake binary recorded it. */
export interface SideEffect {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

export interface SideEffectLog {
  readonly entries: readonly SideEffect[];
  /**
   * Lines that were not a complete record.
   *
   * Reported rather than dropped. The log is written by a process that gets
   * `SIGKILL`ed on purpose, so a torn final line is a thing that can genuinely
   * happen — but a suite that silently ignores unreadable output cannot tell a
   * crash from a bug, and the count is what lets a spec say which it expects.
   */
  readonly malformed: number;
}

function toSideEffect(value: unknown): SideEffect | null {
  if (value === null || typeof value !== 'object') return null;
  const { runId, nodeId, attempt, idempotencyKey } = value as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof nodeId !== 'string') return null;
  if (typeof attempt !== 'number' || typeof idempotencyKey !== 'string') return null;
  return { runId, nodeId, attempt, idempotencyKey };
}

/** Reads the NDJSON log at `path`. A file that does not exist is an empty log. */
export function readSideEffectLog(path: string): SideEffectLog {
  if (!existsSync(path)) return { entries: [], malformed: 0 };

  const entries: SideEffect[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const effect = toSideEffect(parsed);
    if (effect === null) malformed += 1;
    else entries.push(effect);
  }
  return { entries, malformed };
}

/** An idempotency key that was performed more than once. */
export interface DuplicateEffect {
  readonly idempotencyKey: string;
  readonly invocations: number;
}

/**
 * The keys that appear more than once, in the order they were first performed.
 *
 * An empty array is F4.2 holding: "completed nodes are never re-executed", at
 * effect granularity, observed from outside.
 */
export function duplicateIdempotencyKeys(
  entries: readonly SideEffect[],
): readonly DuplicateEffect[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.idempotencyKey, (counts.get(entry.idempotencyKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, invocations]) => invocations > 1)
    .map(([idempotencyKey, invocations]) => ({ idempotencyKey, invocations }));
}
