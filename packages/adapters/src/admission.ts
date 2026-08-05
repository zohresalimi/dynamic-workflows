/**
 * KAR-05.2 AC7 — admission control: the last question asked before a process
 * is spawned, answered from the probed row.
 *
 * "The capability row is the single input the entire routing layer trusts."
 * Refusing here is what makes an unschedulable node a plan-time fact rather
 * than an hour-three surprise, and it is why the refusal is `permanent`: a
 * retry against the same binary reaches the same answer, so a transient class
 * would spend the retry budget re-proving it.
 *
 * Two rules, and the difference between them is the whole design:
 *
 * - **A declared requirement the row does not grant is a refusal.** Absent and
 *   explicitly-denied are both refusals, but the `detail` records *which*, so
 *   the inspector can tell "never mentioned it" from "told us no" and an
 *   operator can decide whether to re-route or upgrade.
 * - **An unadvertised `mediatedExecution` is not a denial.** F5.4 reduces to
 *   one bit (docs/09-workspace-and-safety.md §8.3), and no ACP adapter
 *   measured so far advertises it — treating absence as `false` would make the
 *   entire installed fleet unschedulable above `read`. Only an explicit
 *   `false` refuses, and it refuses rather than quietly running the node at a
 *   level DeFlow cannot enforce. There is deliberately no third answer here:
 *   an automatic downgrade would be exactly ODW's binary permission model,
 *   which F5.4 exists to avoid.
 */
import type { NodeId, PermissionLevel } from '@DeFlow/core';
import { NodeFailureError } from '@DeFlow/core';
import { type CapabilityKey, type CapabilityRow, capability } from './capabilities.ts';

/**
 * What a node may ask of an adapter, spelled the way the plan spells it.
 *
 * The dotted names match `@DeFlow/mock-agent`'s `--dishonest-capabilities`
 * vocabulary, so "the agent advertises X and refuses X" (EPIC-05-S27) names
 * the same thing on both sides of the wire.
 */
export const CAPABILITY_REQUIREMENTS = {
  'session.resume': 'resume',
  'session.fork': 'fork',
  'session.list': 'list',
  'session.close': 'close',
  'session.delete': 'delete',
  additionalDirectories: 'additionalDirectories',
  loadSession: 'loadSession',
  'mcp.http': 'mcpHttp',
  'mcp.sse': 'mcpSse',
  'mcp.acp': 'mcpAcp',
  'prompt.image': 'promptImage',
  'prompt.audio': 'promptAudio',
  'prompt.embeddedContext': 'promptEmbeddedContext',
  terminal: 'terminal',
  mediatedExecution: 'mediatedExecution',
} as const satisfies Readonly<Record<string, CapabilityKey>>;

export type CapabilityRequirement = keyof typeof CAPABILITY_REQUIREMENTS;

/**
 * `AgentNode.provider.requires`, translated into capability questions.
 *
 * Four of the domain's seven requirement kinds map to `null` — not an
 * oversight, and not something to paper over with a guess. `structuredOutput`
 * and `streaming` are not advertised by any ACP field; `mcp` is satisfied by
 * the stdio `mcpServers` variant, which is the untagged default and needs no
 * capability flag at all (docs/07-provider-adapter-layer.md §7.1); and
 * `minContext` is a model property the handshake says nothing about. A `null`
 * means "this row cannot answer that", and admission does not refuse on a
 * question it did not ask.
 */
export const ADAPTER_REQUIREMENT_CAPABILITIES: Readonly<
  Record<string, CapabilityRequirement | null>
> = {
  structuredOutput: null,
  streaming: null,
  imageInput: 'prompt.image',
  mcp: null,
  resumableSessions: 'session.resume',
};

/** What admission needs to know about the node. */
export interface AdmissionRequest {
  readonly node: NodeId;
  readonly requires: readonly CapabilityRequirement[];
  readonly permission: PermissionLevel;
}

/** The levels at which DeFlow must be able to mediate execution to enforce
 * anything at all. `read` is the one level that needs no mediation. */
const NEEDS_MEDIATION: readonly PermissionLevel[] = ['worktree', 'worktree+net', 'full'];

/**
 * Returns the refusal, or `null` when the node may be scheduled.
 *
 * A `NodeFailureError` rather than a `NodeFailure` value: the ledger's shape
 * needs `occurredAtEvent` and `attempt`, which only the caller knows, and
 * every adapter failure reaches the ledger through the one `toAdapterFailure`
 * boundary (KAR-05.1 AC7). Admission does not append anything itself.
 */
export function admit(
  request: AdmissionRequest,
  row: CapabilityRow | null,
): NodeFailureError | null {
  if (row === null) {
    if (request.requires.length === 0) return null;
    return new NodeFailureError(
      `node ${request.node} requires ${request.requires.join(', ')}, but no probed row exists ` +
        'for its adapter: DeFlow never believes a documentation claim over a handshake',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { node: request.node, requires: [...request.requires] },
      },
    );
  }

  for (const requirement of request.requires) {
    const answer = capability(row, CAPABILITY_REQUIREMENTS[requirement]);
    if (answer.supported === true) continue;
    return new NodeFailureError(
      `node ${request.node} requires ${requirement}, which ${row.provider} ${row.version} ` +
        `does not advertise (${answer.reason} at ${answer.path})`,
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: {
          node: request.node,
          requirement,
          provider: row.provider,
          version: row.version,
          reason: answer.reason,
          path: answer.path,
        },
      },
    );
  }

  if (
    NEEDS_MEDIATION.includes(request.permission) &&
    capability(row, 'mediatedExecution').supported === false
  ) {
    return new NodeFailureError(
      `${row.provider} ${row.version} reports mediatedExecution false, so DeFlow cannot enforce ` +
        `permission level ${request.permission} for node ${request.node} and refuses to schedule it`,
      {
        reason: 'safety.permission-unschedulable',
        class: 'permanent',
        detail: {
          node: request.node,
          permission: request.permission,
          provider: row.provider,
          version: row.version,
        },
      },
    );
  }

  return null;
}
