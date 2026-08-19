/**
 * KAR-25.4 — the resolved status table: turning the daemon's two independent
 * facts about a connector into the one status word and one action a row may
 * offer.
 *
 * Verifies: EPIC-25-S22, EPIC-25-S23, EPIC-25-S24 · AC1, AC2
 *
 * ## The defect this exists to make impossible
 *
 * `../../daemon/src/connectors/connectors.ts` reports two facts about a
 * service that do not imply one another: `state.state` is what the CLI probe
 * found **on this machine, right now** (`connected` / `not-installed` / …),
 * and `connected` is whether **this project** has a row binding it to the
 * service. A project can be bound to Jira while `acli` is not on `PATH` — that
 * is a coherent state — and the owner's filed defect was a screen that
 * rendered both facts side by side as if they were one: the state chip said
 * `not-installed`, the action button said `Disconnect`, and a third line said
 * `in use since …`. This module is the one place those two facts are folded
 * into a single resolved status and a single permitted action, so a caller
 * cannot reach in and render one without the other.
 *
 * ## The table, and the vocabulary it has to cover
 *
 * The epic's table names five rows, built from `connected` × `not-installed`.
 * `packages/daemon/src/connectors/registry.ts`'s `ConnectorStateName` has six
 * members, not two: `connected | not-installed | not-authorised | expired |
 * missing-scope | unreachable`. A table that only recognised the two named
 * states would let the other four fall through to whatever the code
 * happened to do next — which is exactly the "a state the table does not
 * cover must not render as one it does" failure the story calls out by name.
 * So every state that is not `connected` is treated the way `not-installed`
 * is treated in the epic's own table: bound-and-broken reads as
 * `bound · <what is broken>`, unbound-and-broken reads as `<what is broken>`
 * on its own, and only `connected` ever offers Connect or reads as `connected`
 * / `available`. `not-installed`'s own detail word is `CLI missing` because
 * that is the daemon's specific rendering (EPIC-25-S23's own wording); every
 * other broken state reads as its own name with the hyphen turned into a
 * space, because there is no shipped scenario asking for a friendlier one.
 *
 * `authorisation.kind === 'unavailable'` (KAR-22.6's Linear row: no
 * authorisation route exists at all) overrides every other input. It is not a
 * sixth `ConnectorStateName` — it is a completely different axis, "can this
 * service ever be reached" rather than "is it reachable right now" — and it
 * wins regardless of `state` or `connected` because there is no state on this
 * machine that would make Linear connectable.
 */

/** What a row may offer, once the two facts are resolved into one. */
export type ConnectorAction = 'connect' | 'disconnect' | 'none';

export interface ResolvedConnectorStatus {
  /** The one status word a row renders. Never a raw daemon state name and a
   *  binding fact rendered side by side — that pairing is the defect. */
  readonly status: string;
  readonly action: ConnectorAction;
}

/** The slice of `ConnectorView` this module reads. Narrower than the full
 *  shape so a caller can pass a fixture without constructing the rest. */
export interface ConnectorStatusInput {
  readonly connected: boolean;
  readonly state: { readonly state: string };
  readonly authorisation: { readonly kind: string };
}

/**
 * `not-installed`'s own word is the epic's (`CLI missing`, only once bound —
 * see the header comment); everything else is its own name with the hyphen
 * turned into a space, because no shipped scenario asks for anything more
 * specific and inventing prose here would be a second description of what
 * `state.message` already says in full, right beside this chip.
 */
function stateWord(name: string): string {
  return name.replace(/-/g, ' ');
}

/**
 * `row`'s one resolved status and the one action its row may offer.
 *
 * Pure and total over every `ConnectorStateName` the daemon can send
 * (`registry.ts`'s six), plus the `authorisation.kind === 'unavailable'`
 * override — there is no input this function does not have an answer for,
 * which is the whole point of it existing as a table rather than as
 * conditionals inlined into a template.
 */
export function resolveConnectorStatus(row: ConnectorStatusInput): ResolvedConnectorStatus {
  // KAR-22.6 — a service with no authorisation route at all cannot be
  // connected by any state this machine could report, so this check runs
  // before either of the other two facts is even read.
  if (row.authorisation.kind === 'unavailable') {
    return { status: 'cannot be connected', action: 'none' };
  }

  const cliState = row.state.state;

  if (row.connected) {
    if (cliState === 'connected') return { status: 'connected', action: 'disconnect' };
    const detail = cliState === 'not-installed' ? 'CLI missing' : stateWord(cliState);
    // Bound and broken is a coherent state, not a contradiction — EPIC-25-S23.
    return { status: `bound · ${detail}`, action: 'disconnect' };
  }

  if (cliState === 'connected') return { status: 'available', action: 'connect' };
  // Not bound, and there is nothing to disconnect from — EPIC-25-S24.
  return { status: stateWord(cliState), action: 'none' };
}
