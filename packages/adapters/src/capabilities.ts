/**
 * KAR-05.2 — every routing question, answered from the probed row and from
 * nothing else.
 *
 * There is no provider name in this file, and that is the point. The measured
 * matrix (docs/07-provider-adapter-layer.md §5) is a **test fixture to
 * re-probe, never a hardcoded constant**: two of its five versions were
 * published the same day they were measured, and a constant that goes stale
 * does not fail — it routes a node onto an adapter that cannot honour it,
 * hours into a run. `test/no-capability-table.test.ts` greps this directory to
 * keep it that way.
 *
 * **Absent, `{}` and explicit `false` are three different answers**, and
 * collapsing them is how a router concludes an agent can do something it
 * cannot. All three were observed live on 2026-08-02: Gemini returned no
 * `sessionCapabilities` key at all, Copilot returned exactly `{ list: {} }`,
 * and Codex returned the literal boolean `false` for `mcpCapabilities.acp`.
 * Naive optional chaining flattens all three into one falsy value. So the
 * primitive here is `capability()`, which returns a *reason* alongside the
 * answer, and the boolean predicates are thin readings of it.
 *
 * The two predicates that do not return a plain boolean are deliberate too.
 * `mcpAcp` and `mediatedExecution` return `boolean | undefined`, because for
 * those two "not advertised" and "refused" lead to different decisions: an
 * absent `mcpCapabilities.acp` means the agent predates the field, while an
 * explicit `false` means it has one and says no. `canResume` and friends
 * coerce, because "did not advertise resume" and "advertised no resume" both
 * mean the same thing to a scheduler choosing a resume strategy.
 */
import type { ProviderId } from '@DeFlow/core';

/**
 * One probed row. Structurally the `provider_capabilities` table, declared
 * here rather than imported from @DeFlow/ledger because this package depends
 * on @DeFlow/core alone (docs/16-repo-layout.md R2) — the daemon owns the
 * SQLite side and hands the row across.
 */
export interface CapabilityRow {
  readonly provider: ProviderId;
  /** The verbatim `--version` output. */
  readonly version: string;
  /** sha256 of the resolved entry file, 64 lowercase hex. */
  readonly binarySha256: string;
  /** Absolute, as resolved (§4.3). */
  readonly binaryPath: string;
  /** The entire `initialize` response, byte-for-byte as it arrived. */
  readonly capsJson: string;
  /** ms epoch, from the injected `Clock`. */
  readonly probedAt: number;
}

/**
 * Where each routing question lives inside an `initialize` response.
 *
 * `terminal` and `mediatedExecution` sit under `_meta` because ACP v1 has no
 * field for either: the client advertises `terminal`, not the agent, and
 * `mediatedExecution` is DeFlow's own bit — the one that decides whether the
 * permission ladder can be enforced at all (docs/09-workspace-and-safety.md
 * §8.3). `_meta` is the extension point the protocol reserves for exactly
 * this, and reading them from there means an adapter that starts advertising
 * them is believed without a code change, while today's five honestly answer
 * "absent".
 */
export const CAPABILITY_PATHS = {
  loadSession: 'agentCapabilities.loadSession',
  resume: 'agentCapabilities.sessionCapabilities.resume',
  fork: 'agentCapabilities.sessionCapabilities.fork',
  list: 'agentCapabilities.sessionCapabilities.list',
  close: 'agentCapabilities.sessionCapabilities.close',
  delete: 'agentCapabilities.sessionCapabilities.delete',
  additionalDirectories: 'agentCapabilities.sessionCapabilities.additionalDirectories',
  promptImage: 'agentCapabilities.promptCapabilities.image',
  promptAudio: 'agentCapabilities.promptCapabilities.audio',
  promptEmbeddedContext: 'agentCapabilities.promptCapabilities.embeddedContext',
  mcpHttp: 'agentCapabilities.mcpCapabilities.http',
  mcpSse: 'agentCapabilities.mcpCapabilities.sse',
  mcpAcp: 'agentCapabilities.mcpCapabilities.acp',
  terminal: 'agentCapabilities._meta.terminal',
  mediatedExecution: 'agentCapabilities._meta.mediatedExecution',
} as const;

export type CapabilityKey = keyof typeof CAPABILITY_PATHS;

/**
 * Why the answer is what it is — the field that survives into the node
 * inspector, so an operator reading "cannot fork" can tell "never mentioned
 * it" from "told us no".
 */
export type CapabilityReason =
  /** Explicitly `true`, or an object carrying options. */
  | 'capability-granted'
  /** Present as `{}`: advertised, with nothing further claimed about it. */
  | 'capability-empty'
  /** Explicitly `false` or `null`. The agent has the field and says no. */
  | 'capability-denied'
  /** The key is not in the response at all. */
  | 'capability-absent';

export interface CapabilityAnswer {
  /** `undefined` if and only if the key was absent. */
  readonly supported: boolean | undefined;
  readonly reason: CapabilityReason;
  /** The path that was read, so a failure detail can name it. */
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `initialize` response as an object, or `null` when the stored text
 * cannot be read.
 *
 * Unparseable text answers "absent" rather than throwing. A capability query
 * runs while the scheduler is deciding what to do with a node, and a throw
 * there would turn a corrupt manifest row into an unhandled failure of an
 * unrelated node; "this row advertises nothing" refuses the node instead, with
 * a reason a human can act on.
 */
function parseCaps(row: CapabilityRow): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(row.capsJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads `path` out of `caps`, stopping at the first segment that is not an
 * object — `sessionCapabilities: "yes"` has no `.resume`, it is malformed. */
function readPath(caps: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  let cursor: unknown = caps;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return { found: false, value: null };
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

/**
 * The one primitive. Every predicate below is a reading of this, and nothing
 * in DeFlow may answer a capability question any other way.
 */
export function capability(row: CapabilityRow, key: CapabilityKey): CapabilityAnswer {
  const path = CAPABILITY_PATHS[key];
  const caps = parseCaps(row);
  const absent: CapabilityAnswer = { supported: undefined, reason: 'capability-absent', path };
  if (caps === null) return absent;

  const { found, value } = readPath(caps, path);
  if (!found) return absent;
  if (value === false || value === null) {
    return { supported: false, reason: 'capability-denied', path };
  }
  if (value === true) return { supported: true, reason: 'capability-granted', path };
  if (isRecord(value)) {
    const empty = Object.keys(value).length === 0;
    return { supported: true, reason: empty ? 'capability-empty' : 'capability-granted', path };
  }
  // A number, a string, an array: the agent put something in the field that
  // the protocol has no reading for. Not a denial and not a grant — nothing
  // was advertised that DeFlow can act on.
  return absent;
}

/** `true` only where the answer is a grant. An absent key routes to replay. */
function decides(row: CapabilityRow, key: CapabilityKey): boolean {
  return capability(row, key).supported ?? false;
}

/** `session/resume` — a token-cost optimisation, never the durability
 * mechanism (§5.1). Two of the five measured adapters answer `false`. */
export function canResume(row: CapabilityRow): boolean {
  return decides(row, 'resume');
}

export function canFork(row: CapabilityRow): boolean {
  return decides(row, 'fork');
}

export function canList(row: CapabilityRow): boolean {
  return decides(row, 'list');
}

export function canClose(row: CapabilityRow): boolean {
  return decides(row, 'close');
}

export function canDelete(row: CapabilityRow): boolean {
  return decides(row, 'delete');
}

export function additionalDirectories(row: CapabilityRow): boolean {
  return decides(row, 'additionalDirectories');
}

/** `session/load`, which is **not** `session/resume`: it replays the whole
 * conversation back at you as notifications (§5.2). */
export function loadSession(row: CapabilityRow): boolean {
  return decides(row, 'loadSession');
}

export function supportsTerminal(row: CapabilityRow): boolean {
  return decides(row, 'terminal');
}

/**
 * `undefined` when the agent never mentioned `mcpCapabilities.acp`, `false`
 * when it explicitly refused it. Not one falsy value: the elegant "tunnel MCP
 * over the existing ACP pipe" path is specified and implemented nowhere, and
 * telling "predates the field" from "says no" is how that stays visible.
 */
export function mcpAcp(row: CapabilityRow): boolean | undefined {
  return capability(row, 'mcpAcp').supported;
}

/**
 * `undefined` when unadvertised, `false` when explicitly refused.
 *
 * The distinction is load-bearing here more than anywhere: an explicit `false`
 * means DeFlow cannot enforce the permission ladder and must refuse to
 * schedule anything above `read` (docs/15-security-model.md §2.2), while an
 * absent key is the state of every ACP adapter measured so far and must not
 * make the whole fleet unschedulable.
 */
export function mediatedExecution(row: CapabilityRow): boolean | undefined {
  return capability(row, 'mediatedExecution').supported;
}
