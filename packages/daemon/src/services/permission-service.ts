/**
 * The transport-neutral permission service — the entry point of the F5.4
 * ladder (docs/07-provider-adapter-layer.md §2.4).
 *
 * The decision itself is EPIC-08: auto-answered from policy for most tool
 * kinds, escalated to a human for the gated ones. What lives here is the shape
 * the decision is asked for and given in, expressed in DeFlow's own vocabulary
 * rather than ACP's — because ACP v2 keeps `session/request_permission` but
 * MCP asks the same question in a different envelope, and a service that spoke
 * ACP would have to be rewritten to answer either.
 *
 * `PermissionDecision` mirrors ACP's `RequestPermissionOutcome` deliberately,
 * including the `{ outcome: 'cancelled' }` arm with no `optionId`. That arm is
 * the one implementations forget: an agent whose client destructures
 * `optionId` unconditionally wedges the node.
 */

/** ACP's `ToolKind`, which maps almost one-to-one onto the ladder. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** What the agent is asking to do, as the ladder needs to see it. */
export interface PermissionQuery {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: ToolKind;
  /**
   * F5.3: path scope is enforceable at *request* time because of this.
   *
   * `line` is `null` when the agent named a file rather than a span. ACP
   * spells "absent" that way, and flattening it to `undefined` would lose the
   * difference between "no line" and "the field was never sent".
   */
  readonly locations: readonly { readonly path: string; readonly line?: number | null }[];
  readonly options: readonly PermissionOption[];
}

export type PermissionDecision =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' };

export type PermissionDecider = (query: PermissionQuery) => Promise<PermissionDecision>;

export interface PermissionService {
  decide(query: PermissionQuery): Promise<PermissionDecision>;
}

/**
 * Wraps the decider EPIC-08 supplies.
 *
 * Thin today and deliberately a seam rather than a direct call: the ledger
 * events for "the agent asked" and "this is what we said" belong here, above
 * the transport and below the policy, so both fronts and every policy get them
 * for free.
 */
export function createPermissionService(decide: PermissionDecider): PermissionService {
  return { decide: (query) => decide(query) };
}
