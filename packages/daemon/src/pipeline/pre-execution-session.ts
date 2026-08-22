/**
 * KAR-19.13 — the vendor session one pre-execution turn opens, and the ledger
 * row that makes the next one different.
 *
 * **The defect this closes.** On 2026-08-16 run `run_20260816T194933Z_839b9b`
 * reached `compilePlanV1` and the child exited 1 with
 *
 * ```
 * Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use
 * ```
 *
 * That value is the diagnosis rather than colour: it is exactly
 * `vendorSessionId({ runId, nodeId: 'planner', attempt: 0 })`. The planner turn
 * asked the vendor for its **first** session twice, because `live-chain.ts`
 * derived every pre-execution session from a pinned `PRE_EXECUTION_ATTEMPT = 0`.
 *
 * The pin was deliberate and its stated reason was continuity — *"a repair and
 * a re-framed spec are continuations of the same conversation"*. That reason is
 * sound for an adapter whose resume strategy is `ResumeNative`, and it is wrong
 * here: this path is `ResumeByReplay`, `replayOnlySession` says so in its own
 * words, and `vendorSessionIdFor` already writes the rule — under
 * `ResumeByReplay` **the attempt stays in the tuple**, so the two transcripts
 * remain separately findable. The pin opted the three pre-execution turns out
 * of the one rule that was written for them.
 *
 * **Three things this file is careful about.**
 *
 * *The count comes from the ledger.* The cheap version is a counter on the
 * chain's own context object: correct in one daemon life, and reset by the
 * restart that produced this report to exactly the value that collides. So the
 * attempt is `count(provider.session_opened)` for this `(run, node)`, and the
 * row is written **before** the child is spawned.
 *
 * *The id stays derived, never minted.* `randomUUID()` per turn satisfies the
 * vendor in a minute and makes every transcript under the vendor's own projects
 * directory unfindable from the ledger — the quiet half of the 2026-08-13 bug,
 * returning as the fix for the 2026-08-16 one. Nothing here reads a clock, an
 * environment variable or a random source, and the unit spec asserts that at
 * source.
 *
 * *No vendor is named.* Whether a session-id flag can only *create* is a
 * declaration in `PROVIDER_SPECS` beside its form and provenance, read here
 * through `sessionIdIsSingleUse`. `if (provider === 'claude')` is the shortcut
 * this refuses: the registry is the one file allowed to name a vendor.
 *
 * Verifies: EPIC-19-S84, EPIC-19-S85, EPIC-19-S86 · KAR-19.13 AC1, AC2, AC3, AC7
 */
import type { SessionIdSpec } from '@DeFlow/adapters';
import { providerSpec, sessionIdIsSingleUse, vendorSessionId } from '@DeFlow/adapters';
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema } from '@DeFlow/core';
import { appendEvents, countNodeEventsOfKind } from '@DeFlow/ledger';

/**
 * KAR-19.8 — the node ids the three pre-execution turns are recorded under.
 *
 * They are `NodeId`s rather than free strings because they are half of the
 * tuple every vendor session id is derived from — `(runId, nodeId, attempt)`,
 * the same one F4.3 builds an idempotency key from — and a turn kind spelled
 * differently at two call sites would derive two sessions for one turn.
 */
export const PRE_EXECUTION_NODES = {
  framing: NodeIdSchema.parse('framing'),
  recon: NodeIdSchema.parse('recon'),
  planner: NodeIdSchema.parse('planner'),
} as const satisfies Readonly<Record<string, NodeId>>;

/** The event kind whose rows *are* the count. Named once. */
export const PRE_EXECUTION_SESSION_KIND = 'provider.session_opened';

/**
 * The **first** turn of a pre-execution node, which is the attempt a session is
 * derived from when the vendor's flag may legitimately be presented twice.
 *
 * The branch is not decoration. A flag that attaches keeps one transcript per
 * turn kind, which is what the original pin was reaching for; a flag that can
 * only create refuses the second presentation outright, and there the turn has
 * to stay in the tuple.
 */
const FIRST_TURN = 0;

export interface PreExecutionSessionKey {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** How many turns of this kind the **ledger** already records for this run. */
  readonly turnsRecorded: number;
  /** The vendor's own declaration, or `undefined` for an entry that declares
   * nothing — which is treated as create-only, the safe direction. */
  readonly sessionId?: SessionIdSpec | undefined;
}

/**
 * The vendor-side session id for one pre-execution turn.
 *
 * The derivation is `@DeFlow/adapters`' and there is no second one: this
 * function formats nothing itself (`test/no-formatted-session-id.test.ts`).
 */
export function preExecutionSessionId(key: PreExecutionSessionKey): string {
  return vendorSessionId({
    runId: key.runId,
    nodeId: key.nodeId,
    attempt: sessionIdIsSingleUse(key.sessionId) ? key.turnsRecorded : FIRST_TURN,
  });
}

export interface OpenPreExecutionSession {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The registry id of the adapter this turn runs on. */
  readonly provider: string;
  readonly epoch: number;
  /** From the injected `Clock`, never from `Date.now()` — and it stamps the
   * record rather than reaching the derivation (AC2). */
  readonly ts: number;
}

/**
 * Records that a turn is about to open a vendor session, and returns the id it
 * derived.
 *
 * Appended **before** the spawn, for the same reason `node.started`'s `session`
 * is: a crash between the two would otherwise leave a session created in the
 * vendor's projects directory that the ledger holds no handle for. It also
 * means a turn that then dies before it produces anything has still spent its
 * attempt, which is the behaviour the collision needs — the next turn must not
 * present the id the dead one already created.
 */
export function openPreExecutionSession(input: OpenPreExecutionSession): string {
  const attempt = countNodeEventsOfKind(
    input.db,
    input.runId,
    PRE_EXECUTION_SESSION_KIND,
    input.nodeId,
  );
  const spec = providerSpec(input.provider);
  const id = preExecutionSessionId({
    runId: input.runId,
    nodeId: input.nodeId,
    turnsRecorded: attempt,
    sessionId: spec?.shim.sessionId,
  });

  appendEvents(input.db, [
    {
      runId: input.runId,
      ts: input.ts,
      kind: PRE_EXECUTION_SESSION_KIND,
      v: 1,
      epoch: input.epoch,
      nodeId: input.nodeId,
      attempt,
      payload: {
        node: input.nodeId,
        attempt,
        provider: ProviderIdSchema.parse(input.provider),
        // `minted` is the discriminator `node.started.session` already uses for
        // this path: DeFlow chose the uuid and put it on the argv before the
        // process existed.
        session: { id, origin: 'minted' },
      },
    },
  ]);

  return id;
}
