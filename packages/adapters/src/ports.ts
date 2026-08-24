/**
 * What `runAcpNode` needs from the world, declared as ports so that
 * @DeFlow/adapters keeps no opinion about SQLite, about the blob store, or
 * about which policy answers a permission request.
 *
 * Two of these are load-bearing rather than tidy:
 *
 * - **`LedgerSink.append` returns the assigned `seq`.** AC4 is a durability
 *   claim — the event must be *durable* before DeFlow asks the agent for more —
 *   and a `seq` is the only observation that proves the transaction committed.
 *   A `void` port could be satisfied by a queue.
 * - **`ClientHandlers` is a plain method→function map.** The ACP handlers are
 *   the daemon's thin fronts (docs/07-provider-adapter-layer.md §3), and ACP v2
 *   deletes `fs/*` and `terminal/*` from the client entirely. Passing them in
 *   as data is what lets the daemon own the fronts without this package
 *   importing the daemon, and what makes deleting the ACP front a one-line
 *   change when v2 lands.
 */

import type {
  Clock,
  EventSeq,
  Handle,
  IdempotencyKey,
  NodeId,
  PendingInterjection,
  PermissionLevel,
  PinnedSegmentView,
  ProducerNodeView,
  ProviderAuthMode,
  ProviderId,
  ResumeRequest,
  RunId,
  SchemaId,
} from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS } from '@DeFlow/core';
import type * as acp from '@agentclientprotocol/sdk';
import type { CapabilityRequirement } from './admission.ts';
import type { CapabilityRow } from './capabilities.ts';
import type { ScopeAudit } from './scope-audit.ts';

/** The agent as the provider registry resolved it (KAR-05.2, KAR-05.3). */
export interface AgentBinary {
  /** Absolute. Never a bare name looked up on PATH at spawn time (§4.3). */
  readonly path: string;
  readonly version: string;
  /** 64 lowercase hex, so a binary swapped under a running daemon is visible. */
  readonly sha256: string;
}

/** One control-plane event on its way to the ledger. `runId`, `epoch` and the
 * envelope's bookkeeping belong to the ledger; the adapter supplies the rest. */
export interface EventRecord {
  readonly kind: string;
  readonly v: number;
  /** ms epoch, from the injected `Clock` and never from `Date.now()`. */
  readonly ts: number;
  /** Absent on the events that are not about a node: a capability probe is a
   * fact about the machine, and `provider.probed` has no node to belong to. */
  readonly nodeId?: NodeId;
  readonly attempt?: number;
  readonly ikey?: IdempotencyKey;
  readonly payload: unknown;
}

/**
 * The payload version this build writes for `kind`.
 *
 * Read from `@DeFlow/core`'s registry rather than written as a literal at each
 * call site, because a literal is only right until the first version bump and
 * then wrong silently: an event written at `v: 1` carrying a v2 payload is
 * refused by `parseEvent` at replay time, hours later, in a run nobody can
 * repeat. `1` for a kind this build has never heard of, which cannot happen
 * for a kind it is writing.
 */
export function eventVersion(kind: string): number {
  return (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;
}

/** One data-plane chunk: the frame as it came off the wire, kept verbatim. */
export interface IoRecord {
  readonly nodeId: NodeId;
  /**
   * The **0-based** attempt, exactly as the event envelope spells it.
   *
   * `io_chunk.attempt` is 1-based in the ledger (see `IoChunkDraft`), and the
   * translation belongs in the sink rather than up here: an adapter that had
   * to remember which of two conventions applied to which port would get it
   * wrong on the first retry, and the symptom — a retry's output filed under
   * the attempt it replaced — is invisible until someone reads a transcript.
   */
  readonly attempt: number;
  readonly stream: 'stdout' | 'stderr' | 'agent_json';
  readonly ts: number;
  readonly data: Uint8Array;
}

/**
 * The `provider_capabilities` table, as the probe needs it (KAR-05.2).
 *
 * A port rather than a direct dependency for the same reason `LedgerSink` is
 * one: @DeFlow/adapters depends on @DeFlow/core alone (docs/16-repo-layout.md
 * R2), and the SQL lives in @DeFlow/ledger. `record` returning whether it
 * *inserted* is the load-bearing part — a re-probe of an unchanged binary must
 * be visible as a no-op on the table, not guessed at by counting rows
 * afterwards.
 */
export interface CapabilityStore {
  record(row: CapabilityRow): { readonly inserted: boolean };
  /** Every row probed for `provider`, oldest first. A history, not a lookup. */
  read(provider: ProviderId): readonly CapabilityRow[];
}

export interface LedgerSink {
  /** Appends one event and resolves with the `seq` the ledger assigned it. */
  append(event: EventRecord): Promise<EventSeq>;
  /**
   * Appends a whole batch **in one transaction**, resolving with the `seq`
   * each event was assigned, in order.
   *
   * A separate method rather than a loop over `append`, for the reason
   * `ProcessRegistry.appendWithProcess` is one: KAR-14.1 AC1 requires
   * `budget.consumed` and `node.completed` to be written together, so that
   * there is no instant at which a node has finished and its spend has not
   * been recorded. Two `append` calls are indistinguishable from this one
   * until the crash that lands between them, at which point the run has
   * silently spent money the ledger cannot account for.
   */
  appendAll(events: readonly EventRecord[]): Promise<readonly EventSeq[]>;
  /** Appends one chunk of agent output and resolves with its `seq`. */
  appendIo(chunk: IoRecord): Promise<EventSeq>;
}

/**
 * What is true about a spawned agent at the instant it started (KAR-05.9 AC6).
 *
 * `pgid` is stored beside `pid` rather than derived from it. They are equal for
 * every tree DeFlow spawns — that is what `detached: true` buys — but the pgid
 * is what a signal goes to, and once the leader is dead it is the only thing
 * that still names the descendants together.
 */
export interface AgentProcessRecord {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly pid: number;
  readonly pgid: number;
  /**
   * The OS's own start time for `pid`, verbatim — the guard against PID reuse.
   * `null` when it could not be read, which makes the row unverifiable and so
   * never a thing a later daemon may signal.
   */
  readonly startedAt: string | null;
  readonly binarySha256: string;
  /** The worktree the agent is editing, whose lock a dead orphan still holds. */
  readonly worktree: string | null;
  /** ms epoch, from the injected `Clock`. */
  readonly spawnedAt: number;
}

/**
 * A durable timer row (`node_wake`), as an adapter needs to write one
 * (KAR-14.4 AC2).
 *
 * A port rather than a direct dependency, for the reason every port in this
 * file is one: the SQL lives in @DeFlow/ledger and this package depends on
 * @DeFlow/core alone (docs/16-repo-layout.md R2). It is a *row* and not a
 * `setTimeout` because Node's maximum timer delay is 2^31−1 ms and passing
 * more fires the callback after 1 ms — verified — which would turn a
 * fifteen-minute quota wait into an immediate retry, i.e. exactly the blind
 * retry this exists to replace.
 *
 * It lives here rather than beside either runner because **both** paths write
 * one: the shim reads Claude Code's `rate_limit_event` frame and the ACP path
 * reads a declared JSON-RPC error, and a second declaration for the second
 * caller is a second shape waiting to drift from the table.
 */
export interface NodeWakeRow {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** ms epoch. An instant, so it survives a restart that outlives the wait. */
  readonly wakeAt: number;
  readonly reason: string;
}

export interface WakeRegistry {
  schedule(row: NodeWakeRow): Promise<void>;
}

/** Which spawned process a caller means. A retry is a different one. */
export interface AgentProcessKey {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
}

/**
 * The `process` table, as the adapter needs it (KAR-05.9).
 *
 * A port for the same reason `LedgerSink` is one — the SQL lives in
 * @DeFlow/ledger and @DeFlow/adapters depends on @DeFlow/core alone
 * (docs/16-repo-layout.md R2) — but with one method that could not be composed
 * from `LedgerSink`: `appendWithProcess` writes the row **inside the same
 * transaction** as `node.started`. Two calls would leave a window, and that
 * window is precisely when the daemon is most likely to die, because it has
 * just started a child process.
 */
export interface ProcessRegistry {
  /** Appends `event` and writes `row` atomically, resolving with the `seq`. */
  appendWithProcess(event: EventRecord, row: AgentProcessRecord): Promise<EventSeq>;
  /** Marks the row terminal once the process's exit has been observed. */
  clear(key: AgentProcessKey): Promise<void>;
}

/**
 * The client-side ACP request handlers, by method name.
 *
 * `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` and
 * the five `terminal/*` methods. Each is expected to be a front that unwraps
 * params, calls a service and wraps the result — no business logic, because
 * ACP v2 deletes these methods from the client and the policy behind them has
 * to outlive the transport.
 */
export type ClientHandlers = Readonly<Record<string, (params: never) => unknown>>;

/** KAR-09.4 — how many `session/prompt` turns this node may take, and what
 * DeFlow says to ask for another one. */
export interface TurnBudget {
  /** Work turns, the first prompt included. */
  readonly max: number;
  /**
   * What a continuation turn says. Deliberately content-free: the node's
   * instruction is in the packet, and repeating it would be a second copy that
   * can drift from the pinned one.
   */
  readonly continuation?: string;
}

/** What the node needs to run, as the scheduler decided it. */
export interface AcpNodeRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly provider: ProviderId;
  /**
   * KAR-08.8's effective auth mode for this attempt. Absent means
   * `'subscription'` — the default `resolveProviderAuth` itself uses, because
   * `'api_key'` is only ever reached by an explicit opt-in.
   *
   * KAR-14.1 AC3 is why the run path needs it: subscription quota and real
   * currency are two figures that must never be summed, so the accounting
   * record has to carry which one this spend was.
   */
  readonly authMode?: ProviderAuthMode;
  readonly permission: PermissionLevel;
  readonly model?: string;
  /** The node's worktree. Becomes `session/new`'s `cwd`. */
  readonly worktree: string;
  readonly binary: AgentBinary;
  /** The vendor's own invocation (KAR-05.3 owns the per-vendor strategy). */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** The `mcpServers` array from KAR-05.6. */
  readonly mcpServers: readonly acp.McpServer[];
  /**
   * What this node needs the adapter to be able to do — `AgentNode.provider
   * .requires`, translated by `ADAPTER_REQUIREMENT_CAPABILITIES`.
   *
   * Checked against the probed row before anything is spawned (KAR-05.2 AC7).
   * Empty is the honest default: a node that asks for nothing is refused
   * nothing.
   */
  readonly requires?: readonly CapabilityRequirement[];
  /**
   * KAR-05.5 — resume the session a previous daemon life journalled instead of
   * opening a new one.
   *
   * Absent is a fresh node, and that is the only difference the pull loop
   * sees: a resumed turn sends `session/resume` where a fresh one sends
   * `session/new`, and then runs the identical loop. Which of the two a node
   * gets is decided in ./resume.ts from the probed row, never here.
   */
  readonly resume?: { readonly sessionId: string };
  /**
   * KAR-12.2 — present on a review gate node, absent on everything else.
   *
   * Its presence is what scopes docs/10-verification-gates.md §3.2's
   * precondition to reviews: forking and resuming stay legitimate for
   * continuation work, so a node with no `review` block runs exactly as it did
   * before this field existed.
   *
   * On this path the session id is only known once `session/new` returns, so
   * the check runs **after that response and before the first
   * `session/prompt`** — which is the last point at which the reviewer has
   * still received nothing.
   */
  readonly review?: {
    /** The nodes named in the gate's `independence.notSessionOf`, with the
     * sessions they actually resolved to. */
    readonly producers: readonly ProducerNodeView[];
    /** What this node asked to resume, if anything. */
    readonly resume?: ResumeRequest;
  };
  /** The assembled context packet, as text. */
  readonly prompt: string;
  /**
   * KAR-09.3 — the packet's pinned segments, carried down so the F6.6
   * integrity check can run against the prompt that is really about to be
   * sent.
   *
   * The pinned slice rather than the whole packet, because this is the only
   * thing the adapter is entitled to an opinion about: `prompt` is derived and
   * `pins` is what it must still contain. Absent means the caller assembled no
   * packet — a probe, a conformance turn — and there is nothing to check;
   * present is checked before anything is spawned, and a mismatch fails the
   * node with `safety.pin-integrity-violated` rather than sending a prompt
   * whose constraints went missing.
   */
  readonly pins?: readonly PinnedSegmentView[];
  /**
   * KAR-09.4 — how far DeFlow will continue this node's session.
   *
   * Absent is one `session/prompt` and nothing more, which is what a probe, a
   * conformance turn and every node before this story wanted. Present lets the
   * node span several turns: DeFlow sends `continuation` again for as long as
   * the agent answers `stopReason: 'max_turn_requests'` — the one stop reason
   * that means *"I have more to do"* — and stops at `max` whatever it says.
   *
   * The cap is DeFlow's, not the agent's: an agent that always asks for another
   * turn would otherwise run until the wall-clock budget, and "the scheduler
   * decided how many turns this node gets" is a plan fact worth having.
   */
  readonly turns?: TurnBudget;
  /**
   * KAR-09.4 §4.2(a) — re-inject the pinned set every `everyTurns` turns.
   *
   * Whether it can actually be delivered is *not* here: it is read from
   * `AcpPorts.capabilityRow` through `supportsSteering`, so the behaviour is
   * driven by what the adapter advertised rather than by a provider name
   * (EPIC-09-S24). Absent, or an adapter that does not advertise mid-session
   * steering, means no injection turn is attempted at all — the honest
   * degradation is the packet builder's planning warning, not a fabricated
   * turn against a method the agent never claimed.
   */
  readonly reinject?: { readonly everyTurns: number };
  /** What the node's structured output is validated against (EPIC-09/EPIC-12). */
  readonly outputSchemaId?: SchemaId;
  /**
   * KAR-08.7 — the write globs the plan declared for this node
   * (`AgentNode.pathScopes.write`), carried down so the completion-time
   * backstop has something to compare the worktree against (AC3).
   *
   * Absent is a node that declared none — a `read` node, a probe, a
   * conformance turn — and the audit is skipped for it. Present with no
   * `AcpPorts.scopeAudit` behind it is refused before the spawn: see
   * `scopeAuditRefusal`.
   */
  readonly pathScope?: readonly string[];
  /**
   * KAR-23.11 — the commit this node's worktree was provisioned from.
   *
   * The completion audit counts commits since it, so an agent that commits its
   * own work is not mistaken for one that produced nothing. Absent means the
   * count is `0` and `git status` alone decides — honest for a caller with no
   * git underneath it, and never a licence to skip the check.
   */
  readonly baseOid?: string;
  /**
   * KAR-14.4 AC1 — the JSON-RPC error codes this adapter is known to answer
   * with when the vendor's quota is exhausted.
   *
   * **Empty by default, and DeFlow ships none**, exactly as
   * `ShimNodeRequest.rateLimitExitCodes` ships none: ACP assigns no
   * rate-limit code (`ACP_ASSIGNED_ERROR_CODES` is the whole of what it does
   * assign), and whether any adapter surfaces quota state at all is still
   * Unverified — roadmap §1's M0 ACP spike is what would populate this, and
   * until it does, an undeclared error degrades to full-jitter backoff rather
   * than to a rate limit DeFlow inferred.
   *
   * A code ACP has already taken is refused before the spawn, because
   * declaring `authRequired` would classify a permanent refusal as a transient
   * quota (`undeclarableRateLimitCode`).
   */
  readonly rateLimitErrorCodes?: readonly number[];
}

export interface AcpPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  /**
   * Where the spawned process is recorded so a *later* daemon can find it
   * (KAR-05.9). Absent means nothing is persisted about the child, which is
   * honest for a probe and wrong for a node: `detached: true` means the agent
   * outlives DeFlowd, and an unrecorded agent is one nobody will ever reap.
   */
  readonly processes?: ProcessRegistry;
  /**
   * Stores a diagnostic and returns the handle it can be read back through —
   * the daemon's blob store. Failures carry handles, never stacks.
   *
   * Takes bytes as well as text because some evidence *is* bytes: the first
   * 4 KiB of a frame that broke the size cap has to be readable back at
   * exactly the length it arrived at, and a round trip through a string
   * re-encodes anything that was not valid UTF-8 (KAR-05.4 AC1).
   */
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /** The daemon's thin ACP fronts. */
  readonly handlers?: ClientHandlers;
  /**
   * What this provider's binary said it could do, the last time it was probed
   * on this machine — the single input the routing layer trusts (KAR-05.2).
   *
   * `null` or absent means nothing has been probed, which refuses a node that
   * declared requirements and admits one that did not. It is passed in rather
   * than read here because @DeFlow/adapters owns no database.
   */
  readonly capabilityRow?: CapabilityRow | null;
  /**
   * KAR-13.3 AC2, AC8 — the corrections an Operator has posted at this node and
   * that no live session has been handed yet, oldest `seq` first.
   *
   * Asked **again at every turn boundary**, never once, because the whole point
   * is that an Operator types while the node runs. The daemon answers it from
   * `undeliveredInterjections` over the reduced ledger, so the receipt this
   * package appends is what retires an item — there is no "mark as sent"
   * callback and there must not be one: a flag held in the adapter would
   * re-deliver everything after a restart, and the projection is the only thing
   * that survives one.
   *
   * Absent means the caller wired nothing, which is the honest state for a
   * probe and a conformance turn. Whether anything may be *delivered* is not
   * here either: it is read from `capabilityRow` through `supportsSteering`,
   * exactly as interval re-injection is, so the behaviour is driven by what the
   * adapter advertised rather than by a provider name.
   */
  readonly pendingInterjections?: () => readonly PendingInterjection[];
  /**
   * Cooperative cancellation. Aborting sends `session/cancel` at the protocol
   * level and **keeps the loop running** until the stop frame arrives, so the
   * tail of the turn is appended rather than lost (§2.5).
   */
  readonly signal?: AbortSignal;
  /** How long, on the injected `Clock`, a cancelled agent has to answer
   * before the process group is signalled. */
  readonly cancelGraceMs?: number;
  /** How long after `SIGTERM` before `SIGKILL`. */
  readonly killGraceMs?: number;
  /**
   * The frame cap in bytes since the last newline, defaulting to 8 MiB
   * (KAR-05.4). A run may lower it; it can never be turned off, and
   * `parseFrameLimit` is where that is refused.
   */
  readonly maxFrameBytes?: number;
  /**
   * The environment the golden-recording tee reads (KAR-05.7 AC1).
   *
   * A port rather than `process.env` so that a spec can turn recording on for
   * one turn without mutating the process every other spec in the file shares.
   * Absent means "off" — the same answer an environment without
   * `DeFlow_RECORD=1` gives, which is what the daemon passes in production.
   */
  readonly record?: NodeJS.ProcessEnv;
  /**
   * KAR-08.7 AC3 — what answers "did this node write outside its declared
   * scope", asked once, on completion.
   *
   * A port because the answer comes from `git status`, and the daemon owns the
   * one place a `git` child is spawned. Required whenever
   * `AcpNodeRequest.pathScope` is non-empty: a declared scope with no auditor
   * behind it is refused before the spawn rather than completed with a
   * backstop that never runs.
   */
  readonly scopeAudit?: ScopeAudit;
  /**
   * Called immediately before each `session.nextUpdate()`, with the bytes read
   * off the child's stdout so far.
   *
   * A tracing seam, and the only way a spec can observe that the reader did
   * not race ahead of the durable writes — which is the whole claim of §2.3.
   */
  readonly onPull?: (pull: number, bytesRead: number) => void;
  /**
   * KAR-14.4 AC2 — where a quota suspension's `node_wake` row goes.
   *
   * Absent means no row is written, which is honest for a probe and for a
   * caller with no scheduler behind it: the failure is still `transient` and
   * still carries the limit, so `recordFailure` writes the row from the
   * failure itself in the same transaction as `node.failed`. This port is what
   * lets the adapter record the vendor's own instant at the moment it read it,
   * which is the same thing the shim path does with a `rate_limit_event`.
   */
  readonly wakes?: WakeRegistry;
}
