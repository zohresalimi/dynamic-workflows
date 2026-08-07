/**
 * The scripted multi-node run the crash-fuzz suite kills (EPIC-03-S26).
 *
 * A **real process** doing the real durable-execution protocol against a real
 * `.DeFlow/` directory: take the lease, open and replay the ledger, bump the
 * epoch, and then, per node, write the intent to the effect journal, spawn a
 * real fake-agent binary, and record what happened — appending every event
 * through `RunCheckpointer` so the projection cache is written in the same
 * transaction as the rows it covers.
 *
 * ## What is real here, and what is standing in
 *
 * Everything that KAR-03.8 is about is real: the ledger, the append path, the
 * checkpoint, the epoch, the lease, the effect journal's write-ahead protocol,
 * the agent process boundary, and the crash. What is *not* real is the
 * scheduler — EPIC-06 ships the orchestrator, and EPIC-04/05 ship the mock
 * agents' full vocabulary. This file scripts a fixed node order in their place,
 * because a durability suite that waits for the orchestrator is a durability
 * suite that does not exist during the epic that has to prove durability.
 *
 * The two effect-journal statements are docs/05-durable-execution.md §8.2's,
 * inlined here for the same reason. When the Effect Runner lands, this harness
 * should call it rather than keeping its own copy.
 *
 * ## The protocol, and the one branch the whole suite exists for
 *
 * `node.started` is appended **before** the effect is claimed, and the claim is
 * committed **before** the agent is spawned. So a crash can land in exactly
 * three places, and each has a defined answer on restart:
 *
 * - before the claim → the row is absent; perform.
 * - after the claim, before the agent left a trace → the row is `pending` from
 *   a *previous* daemon life, and the agent's own side-effect log says it never
 *   ran; perform. That is §8.3's "no session id is journaled, so the agent
 *   produced no durable state and a clean restart is safe".
 * - after the agent left its trace → reconcile to `done` and **do not spawn
 *   again**. This is the branch the "no duplicate idempotencyKey" assertion is
 *   watching, and the reason the fake agent writes its line first and
 *   synchronously.
 *
 * A node that already reduced to `completed` is skipped entirely — F4.2's
 * "completed nodes are never re-executed", at node granularity.
 *
 * Configuration arrives in the environment so the process's own argv stays
 * empty, exactly as `bin/fake-agent.ts` does it.
 */
import {
  canonicalJson,
  EVENT_CURRENT_VERSIONS,
  type EventSeq,
  ikey as makeIkey,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  acquireLease,
  bumpEpoch,
  type EventDraft,
  openAndReplay,
  RunCheckpointer,
} from '../../../src/index.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const dataDir = required('DeFlow_FUZZ_DATA_DIR');
const agent = required('DeFlow_FUZZ_AGENT');
const sideEffects = required('DeFlow_FUZZ_SIDE_EFFECTS');
const projections = required('DeFlow_FUZZ_PROJECTIONS');
const phaseFile = required('DeFlow_FUZZ_PHASE');
const seed = Number.parseInt(process.env.DeFlow_FUZZ_SEED ?? '1', 10);
const nodeCount = Number.parseInt(process.env.DeFlow_FUZZ_NODES ?? '6', 10);
const stepMs = Number.parseInt(process.env.DeFlow_FUZZ_STEP_MS ?? '25', 10);
const gateMs = Number.parseInt(process.env.DeFlow_FUZZ_GATE_MS ?? '45', 10);
const backoffMs = Number.parseInt(process.env.DeFlow_FUZZ_BACKOFF_MS ?? '140', 10);
/**
 * How long the effect stays *in doubt* — claimed, performed, not yet recorded.
 *
 * A real effect runner spends this window parsing the agent's last frames and
 * draining its output into `io_chunk`; here it is a plain pause, because what
 * matters is that the window exists and is wide enough for a crash to land in.
 * It is the only place a restart can produce a **duplicate** side effect, so a
 * fuzzer that never lands there is a fuzzer that never tests the invariant it
 * was written for.
 */
const settleMs = Number.parseInt(process.env.DeFlow_FUZZ_SETTLE_MS ?? '60', 10);

/** The run every iteration writes. One run per data directory. */
export const RUN: RunId = RunIdSchema.parse('run_20260805T091500Z_c7a3d1');

/** The node whose first attempt fails, so a retry backoff is a real window. */
const FAILING_NODE_INDEX = 2;

const PLAN_HASH = `sha256-${'c'.repeat(64)}`;
const REQUEST_HASH = `sha256-${'a'.repeat(64)}`;
const BINARY_SHA = 'd'.repeat(64);
const BASE_TS = 1_754_308_293_000;

const nodeAt = (index: number): NodeId =>
  NodeIdSchema.parse(`step-${String(index + 1).padStart(2, '0')}`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── boot, in the order boot.ts takes it ──────────────────────────────────────

const lease = acquireLease(dataDir);
const opened = openAndReplay(dataDir);
const db = opened.db;
const epoch = bumpEpoch(db);

/**
 * The instant this life began. An effect row `pending` with an earlier
 * `started_at` was claimed by a life that is gone, which is §8.2's only
 * genuinely ambiguous branch.
 */
const daemonStartedAt = Date.now();

/**
 * Interval 5 rather than the shipped 500, so a run this short still writes
 * checkpoints and the restart really goes through the cached path rather than
 * always folding from zero.
 */
const checkpointer = RunCheckpointer.resume(db, RUN, { interval: 5 });

let ts = BASE_TS + opened.headSeq;

const phase = (value: string): void => {
  writeFileSync(phaseFile, value);
};

/** One event this run wants to write, before it is given a `seq` and a `ts`. */
interface Emission {
  readonly kind: string;
  readonly payload: unknown;
  readonly node?: NodeId;
  readonly attempt?: number;
}

/**
 * The payload version this build writes for `kind`.
 *
 * From the registry rather than a literal `1`: `budget.consumed` is at v2, and
 * a row that claimed v1 while carrying a v2 payload would be lifted by the v1→
 * v2 upcaster on replay and come back with the wrong `authMode` — a wrong
 * number, hours later, in a run nobody can repeat.
 */
const versionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

/**
 * Appends a batch **in one transaction** and records the projection it produced.
 *
 * The snapshot is written **after** the transaction commits and **on every
 * batch**, which is what makes assertion (b) — "reduced state equals the
 * pre-crash projection at the last durably-written seq" — checkable at all. A
 * snapshot taken before the commit would describe a row a rollback could
 * remove; one taken every N events would leave the seq the crash landed on
 * unrepresented.
 *
 * Batches exist here for KAR-14.1 AC1: `budget.consumed` and the event that
 * ends the attempt go in together, so there is no instant at which a node has
 * finished and the run does not know what it cost.
 */
function emitAll(emissions: readonly Emission[]): EventSeq[] {
  const drafts = emissions.map((emission): EventDraft => {
    ts += 1;
    const base: EventDraft = {
      runId: RUN,
      ts,
      kind: emission.kind,
      v: versionOf(emission.kind),
      epoch,
      payload: emission.payload,
    };
    return emission.node === undefined
      ? base
      : { ...base, nodeId: emission.node, attempt: emission.attempt };
  });

  const seqs = checkpointer.append(drafts);
  const last = seqs.at(-1);
  if (last === undefined) throw new Error('appending an empty batch returned no seq');

  appendFileSync(
    projections,
    `${JSON.stringify({ seq: last, state: canonicalJson(checkpointer.state) })}\n`,
  );
  return seqs;
}

function emit(kind: string, payload: unknown, node?: NodeId, attempt?: number): EventSeq {
  const [seq] = emitAll([{ kind, payload, node, attempt }]);
  if (seq === undefined) throw new Error(`appending ${kind} returned no seq`);
  return seq;
}

// ── the effect journal (docs/05-durable-execution.md §8.2) ───────────────────

interface EffectRow {
  ikey: string;
  state: string;
  started_at: number;
}

const CLAIM_SQL = `INSERT INTO effect
    (ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, started_at)
  VALUES (?, ?, ?, ?, 0, 'agent', ?, 'pending', ?)
  ON CONFLICT(ikey) DO NOTHING`;
const READ_EFFECT_SQL = 'SELECT ikey, state, started_at FROM effect WHERE ikey = ?';
const SETTLE_SQL = 'UPDATE effect SET state = ?, result_json = ?, ended_at = ? WHERE ikey = ?';

/** Intent first: the row is committed before anything happens in the world. */
function claim(key: string, node: NodeId, attempt: number): EffectRow {
  return db.transaction(() => {
    db.prepare(CLAIM_SQL).run(key, RUN, node, attempt, REQUEST_HASH, daemonStartedAt);
    const row = db.prepare<EffectRow>(READ_EFFECT_SQL).get(key);
    if (row === undefined) throw new Error(`the effect journal lost ${key} immediately`);
    return row;
  });
}

function settle(key: string, state: 'done' | 'failed', result: unknown): void {
  db.prepare(SETTLE_SQL).run(state, canonicalJson(result), Date.now(), key);
}

/**
 * The reconcile probe (§8.3, the agent case).
 *
 * The fake agent's own side-effect log **is** the durable trace an agent leaves
 * behind — the stand-in for a journaled session id. If the key is in it the
 * invocation happened and must be memoised rather than repeated; if it is not,
 * the agent left nothing behind and a clean restart is safe.
 */
function agentAlreadyRan(key: string): boolean {
  if (!existsSync(sideEffects)) return false;
  for (const line of readFileSync(sideEffects, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      if ((JSON.parse(line) as { idempotencyKey?: unknown }).idempotencyKey === key) return true;
    } catch {
      // A torn final line from the crash. It named no key we can trust.
    }
  }
  return false;
}

/** Spawns the real fake binary and returns its exit code. */
function spawnAgent(key: string, node: NodeId, attempt: number, fails: boolean): number {
  try {
    execFileSync(agent, ['--print', '--seed', String(seed)], {
      stdio: 'pipe',
      env: {
        ...process.env,
        DeFlow_FAKE_SIDE_EFFECT_LOG: sideEffects,
        DeFlow_FAKE_RUN_ID: RUN,
        DeFlow_FAKE_NODE_ID: node,
        DeFlow_FAKE_ATTEMPT: String(attempt),
        DeFlow_FAKE_IKEY: key,
        DeFlow_FAKE_EXIT_CODE: fails ? '1' : '0',
      },
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

// ── the scripted run ─────────────────────────────────────────────────────────

const completedResult = (node: NodeId) => ({
  status: 'completed',
  output: { summary: `${node} done` },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.25,
  producedFacts: [],
  artifacts: [],
});

/** The provider every node in this scripted run is routed to. */
const PROVIDER = 'claude-code';

/**
 * KAR-14.1 — what one finished attempt spent, completed **or failed**.
 *
 * A failed attempt is accounted for on purpose (AC5): the money is gone
 * whether or not the attempt produced value, and a repair loop capped at three
 * attempts can spend three times what a rollup counting only the winner would
 * report. The figures differ between the two so a spec can tell which record
 * it is looking at.
 */
const spentOn = (node: NodeId, attempt: number, succeeded: boolean) => ({
  node,
  attempt,
  provider: PROVIDER,
  usage: succeeded
    ? { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' }
    : { inputTokens: 600, outputTokens: 20, source: 'vendor-reported' },
  costUsd: succeeded ? 0.25 : 0.1,
  authMode: 'subscription',
});

const failureOf = (attempt: number, seq: number) => ({
  reason: 'agent.nonzero-exit',
  class: 'transient',
  message: 'the agent exited 1 without producing a result',
  evidence: [],
  occurredAtEvent: seq,
  attempt,
});

/** Runs one attempt of one node, or memoises it. Returns whether it succeeded. */
async function runAttempt(node: NodeId, index: number, attempt: number): Promise<boolean> {
  phase(`node:${index}:attempt:${attempt}`);

  const current = checkpointer.state.nodes[node];
  if (!(current?.status === 'running' && current.attempt === attempt)) {
    emit(
      'node.started',
      {
        node,
        attempt,
        ikey: makeIkey(RUN, node, attempt, 0),
        binary: { path: agent, version: '0.0.0-fake', sha256: BINARY_SHA },
      },
      node,
      attempt,
    );
  }

  const key = makeIkey(RUN, node, attempt, 0);
  emit('effect.started', { ikey: key, kind: 'agent', requestHash: REQUEST_HASH }, node, attempt);

  const row = claim(key, node, attempt);
  let state = row.state;
  let reconciled = false;

  if (state === 'pending' && row.started_at < daemonStartedAt && agentAlreadyRan(key)) {
    // We died mid-effect, and the world says the effect happened.
    settle(key, 'done', { reconciled: true });
    state = 'done';
    reconciled = true;
  }

  if (state === 'pending') {
    await sleep(stepMs);
    emit('node.progress', { node, attempt, phase: 'tool-use' }, node, attempt);
    const code = spawnAgent(key, node, attempt, index === FAILING_NODE_INDEX && attempt === 0);
    // The effect has happened and the journal does not know yet. Everything
    // that protects the run from performing it twice is on the other side of
    // this line.
    phase(`settling:${index}:${attempt}`);
    await sleep(settleMs);
    settle(key, code === 0 ? 'done' : 'failed', { exitCode: code });
    state = code === 0 ? 'done' : 'failed';
    await sleep(stepMs);
  }

  if (state === 'done') {
    emit('effect.completed', { ikey: key, result: { ok: true }, reconciled }, node, attempt);
    // KAR-14.1 AC1 — the spend and the completion in one `BEGIN IMMEDIATE`, so
    // a crash between them is not a state the ledger can be in.
    emitAll([
      { kind: 'budget.consumed', payload: spentOn(node, attempt, true), node, attempt },
      {
        kind: 'node.completed',
        payload: { node, attempt, result: completedResult(node) },
        node,
        attempt,
      },
    ]);
    return true;
  }

  const seq = emit(
    'effect.failed',
    { ikey: key, failure: failureOf(attempt, opened.headSeq + 1) },
    node,
    attempt,
  );
  // The same rule on the failure side: what the attempt burned before it died
  // is spend, and a crash between the two events would lose it (AC5).
  emitAll([
    { kind: 'budget.consumed', payload: spentOn(node, attempt, false), node, attempt },
    {
      kind: 'node.failed',
      payload: { node, attempt, failure: failureOf(attempt, seq) },
      node,
      attempt,
    },
  ]);
  emit(
    'node.retry.scheduled',
    { node, nextAttempt: attempt + 1, wakeAt: ts + backoffMs },
    node,
    attempt,
  );

  // A real pause, on a real clock: this is the "during a retry backoff" window.
  phase(`backoff:${index}`);
  await sleep(backoffMs);
  return false;
}

if (checkpointer.state.status === 'unstarted') {
  emit('run.started', { planHash: PLAN_HASH });
}

for (let index = 0; index < nodeCount; index += 1) {
  const node = nodeAt(index);
  const known = checkpointer.state.nodes[node];

  if (known?.status === 'completed') {
    // F4.2, at node granularity: a completed node is never re-executed.
    phase(`node:${index}:memoised`);
    continue;
  }

  if (known === undefined) {
    phase(`node:${index}:scheduled`);
    emit('node.scheduled', { node, provider: 'claude-code', permission: 'worktree' }, node, 0);
  }

  const attempts = index === FAILING_NODE_INDEX ? [0, 1] : [0];
  for (const attempt of attempts) {
    const before = checkpointer.state.nodes[node];
    if (before?.status === 'completed') break;
    // An attempt this or a previous life already settled — the retry after it
    // is what is left to do.
    if (
      before !== undefined &&
      (before.status === 'failed' || before.status === 'awaiting-retry') &&
      attempt <= before.attempt
    ) {
      continue;
    }
    if (await runAttempt(node, index, attempt)) break;
  }

  // The gate window: a real pause after the node's work, where a kill lands
  // between "the node finished" and "the run moved on".
  phase(`gate:${index}`);
  await sleep(gateMs);
}

emit('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] });
checkpointer.quiesce();
phase('done');

db.close();
lease.release();
