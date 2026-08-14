/**
 * KAR-11.6 — a provider running out of quota moves the node, or the node waits
 * on a durable row; either way the decision is on the log
 * (docs/06-planning-and-replanning.md §4.4, F3.9, NF7).
 *
 * Integration, and every word of that is load-bearing here. The capability rows
 * come out of a real `provider_capabilities` table rather than a literal, which
 * is the only way EPIC-11-S29's *"capabilitySuperset was computed from the
 * probed rows, not from a constant"* can be asserted at all. The patched plan
 * is really composed, really revalidated and really committed, because the
 * claim is that the swap **is a plan version** — a swap asserted against a
 * decision object would pass just as happily if the plan never changed, which
 * is precisely the silent-swap failure 06 §4.4 forbids.
 *
 * What is deliberately *not* re-tested here, because it already is elsewhere
 * and duplicating it would only slow the suite down:
 *
 *   - the `rate_limit_event` frame → `provider.rate_limited { resetsAt }` parse
 *     (AC1) — `packages/core/src/rate-limit.test.ts` against the committed
 *     frame, and `packages/adapters/src/acp-rate-limit.test.ts` for the
 *     exit-code path;
 *   - a `wake_at` past `2 ** 31` honoured as an instant rather than a timer
 *     (AC6) — `packages/core/test/quota-suspension.test.ts` folds a 30-day
 *     suspension, and `packages/core/test/integration/timer-overflow.test.ts`
 *     demonstrates what a timer does with it in a real process;
 *   - the row surviving a `SIGKILL` mid-suspension (AC6) —
 *     `./quota-suspension.test.ts` kills a real daemon over a real ledger;
 *   - "no source file waits on `setTimeout`" (AC6) —
 *     `packages/daemon/test/no-timer-waits.test.ts` greps for it and the
 *     linter refuses a second call site as it is typed.
 *
 * Verifies: EPIC-11-S29, EPIC-11-S30 (the decision half), EPIC-11-S31 ·
 * AC2, AC3, AC4, AC5, AC7, AC8
 */

import { planTimeCapabilities } from '@DeFlow/adapters';
import type {
  Db,
  NodeFailure,
  NodeId,
  PlanGraph,
  PlanTimeCapability,
  ProviderId,
  RetryPolicy,
  RunId,
} from '@DeFlow/core';
import {
  decide,
  PlanGraphSchema,
  planHash,
  rateLimitedFailure,
  seededRandom,
  type TaskSpec,
  TaskSpecSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  listProviderCapabilities,
  openLedger,
  persistPlanVersion,
  readRange,
  readWakes,
  recordProviderCapabilities,
  replayRun,
} from '@DeFlow/ledger';
import { CAPABILITY_PROFILES, type CapabilityProfileName } from '@DeFlow/mock-agent';
import { GIT_ENV, it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { diffPlanGraphs } from '../../src/plan/diff.ts';
import {
  applyQuotaReroute,
  quotaRouteFor,
  REROUTE_NOT_APPLICABLE,
} from '../../src/providers/quota-reroute.ts';
import { recordNodeFailure } from '../../src/retry.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN = 'run_20260808T090000Z_a71c04' as RunId;
const IMPLEMENT = 'implement' as NodeId;
const T0 = 1_754_640_000_000;
const EPOCH = 4;
const hours = (count: number): number => count * 3_600_000;
const RESETS_AT = T0 + hours(4);
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;

const CLAUDE = 'claude' as ProviderId;
const CODEX = 'codex' as ProviderId;
const COPILOT = 'copilot' as ProviderId;

/** The vendor frame, verbatim, exactly as docs/07 §8.1 records it. */
const FRAME = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT / 1000 },
};

/**
 * One criterion, checked by a human. A `manual` check needs no gate node, which
 * keeps this fixture about the reroute: a spec whose criteria demand gates
 * would have every patched plan refused for `CRITERION_UNCOVERED` before the
 * swap was ever reached, and the refusal would look like a routing bug.
 */
const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Implement the checkout flow behind the existing feature flag.',
  scope: { included: ['packages/checkout'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    {
      id: 'ac-1',
      statement: 'checkout completes',
      check: { kind: 'manual', rubric: 'a human buys something' },
    },
  ],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-08T09:00:00.000Z', via: 'ui' },
  specHash: `sha256-${'1'.repeat(64)}`,
});

const RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoff: { base: 2000, cap: 300_000, jitter: 'full' },
};

const agent = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: RETRY,
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: [CLAUDE], requires: ['resumableSessions'] },
  resume: 'always-replay',
  ...over,
});

async function planFor(nodes: readonly Record<string, unknown>[]): Promise<PlanGraph> {
  const graph = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: SPEC.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-08T09:00:00.000Z',
    nodes,
    edges: [],
  });
  return { ...graph, planHash: await planHash(graph as unknown as Record<string, unknown>) };
}

const draft = (kind: string, payload: unknown, extra: Partial<EventDraft> = {}): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v: 1, epoch: EPOCH, payload, ...extra }) as EventDraft;

/** A probed row, as `deflow doctor` would have written it on this machine. */
function probe(db: Db, profile: CapabilityProfileName, dir: string): void {
  recordProviderCapabilities(db, {
    provider: profile,
    version: '1.0.0',
    binarySha256: profile.padEnd(64, '0').slice(0, 64),
    binaryPath: join(dir, 'bin', profile),
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: CAPABILITY_PROFILES[profile],
      authMethods: [],
    }),
    probedAt: T0 - hours(1),
  });
}

interface Seeded {
  readonly db: Db;
  readonly plan: PlanGraph;
}

/**
 * A run one node into its plan, whose `implement` node has just been rate
 * limited by the provider it was running on.
 *
 * The `run` projection row is inserted the way a running run would already have
 * it: `run.plan_hash` is the only thing a patch's `basePlanHash` is compared
 * against, so a pipeline exercised without it is exercising a run nothing
 * executes.
 */
async function seed(
  tmp: string,
  options: {
    readonly probes: readonly CapabilityProfileName[];
    readonly node?: Record<string, unknown>;
  },
): Promise<Seeded> {
  const db = openLedger(tmp);
  const plan = await planFor([agent(IMPLEMENT, options.node ?? {})]);

  appendEvents(db, [
    draft('run.created', {
      spec: SPEC,
      cwd: '/repo',
      repo: { head: 'e83c516', branch: 'main' },
    }),
    draft('run.spec.approved', { specHash: SPEC.specHash, by: 'ui' }),
  ]);
  await persistPlanVersion(db, {
    runDir: join(tmp, 'runs', RUN),
    graph: plan,
    by: 'planner',
    planner: PLANNER,
    diagnostics: [],
    ts: T0,
    epoch: EPOCH,
  });
  appendEvents(db, [
    draft('run.started', { planHash: plan.planHash }),
    draft(
      'node.started',
      { node: IMPLEMENT, attempt: 0, ikey: `${RUN}/${IMPLEMENT}/0/0` },
      { nodeId: IMPLEMENT, attempt: 0 },
    ),
    // AC1 — the frame, normalised, as `run-node.ts` appends it before the
    // failure it caused.
    draft('provider.rate_limited', { provider: CLAUDE, resetsAt: RESETS_AT, raw: FRAME }),
  ]);
  db.prepare(
    `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
        daemon_epoch)
      VALUES (?, 'running', ?, 0, '{}', 1, ?)`,
  ).run(RUN, plan.planHash, EPOCH);

  for (const profile of options.probes) probe(db, profile, tmp);

  return { db, plan };
}

const limited = (attempt = 0): NodeFailure =>
  rateLimitedFailure(
    { provider: CLAUDE, resetsAt: RESETS_AT, raw: FRAME },
    { occurredAtEvent: 1 as never, attempt },
  );

const caps = (db: Db): readonly PlanTimeCapability[] =>
  planTimeCapabilities(listProviderCapabilities(db), () => 200_000);

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: () => 0,
});

const events = (db: Db) => readRange(db, RUN, 0, 500).events;
const payloadOf = (db: Db, kind: string): Record<string, unknown> | undefined =>
  events(db).find((row) => row.kind === kind)?.payload as Record<string, unknown> | undefined;

// ── EPIC-11-S29 — the equivalent swap auto-applies, and is visible ───────────

suite('EPIC-11-S29 — a quota reroute onto a capability superset (AC2, AC3, AC7)', () => {
  it('proposes, auto-applies and records the swap as a plan version', async ({ tmp }) => {
    const { db, plan } = await seed(tmp, { probes: ['claude', 'codex'] });
    try {
      // AC2 — the scheduler's answer, computed from the probed rows.
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE],
        now: T0 + 1000,
      });
      expect(route).toEqual({
        action: 'reroute',
        provider: CODEX,
        capabilitySuperset: true,
        permissionUnchanged: true,
      });

      const recorded = recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: RETRY,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
        quotaRoute: route,
      });

      const patch = recorded.patch;
      expect(patch).not.toBeNull();
      expect(patch?.proposedBy).toBe('scheduler');
      expect(patch?.ops).toEqual([{ op: 'replace-provider', node: IMPLEMENT, provider: CODEX }]);
      expect(patch?.reason.trim()).not.toBe('');
      expect(payloadOf(db, 'plan.patch.proposed')?.cause).toBe('quota');

      const outcome = await applyQuotaReroute(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        patch: patch as NonNullable<typeof patch>,
        route,
        base: plan,
        nextAttempt: 1,
        retryAt: T0 + 5000,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: caps(db),
        estimatePacketTokens: () => 0,
        refs: new RefFormatChecker(new Git(tmp, { env: GIT_ENV })),
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1000,
        epoch: EPOCH,
      });

      // AC3 — the rule that fired, not merely the decision: `default` would
      // also have produced a ruling, and only the id can tell an ordered table
      // from a set.
      expect(outcome).toMatchObject({
        decision: 'auto',
        ruleId: 'quota-reroute-equivalent',
        applied: true,
      });

      // AC7 — `plan.patched` carries the decision and the id of the proposal
      // whose `reason` the scrubber renders verbatim.
      const patched = payloadOf(db, 'plan.patched');
      expect(patched?.patchId).toBe(patch?.id);
      expect(patched?.decision).toMatchObject({
        decision: 'auto',
        by: 'policy',
        rule: 'quota-reroute-equivalent',
      });
      expect(patched?.proposedBy).toBe('scheduler');

      // The node really runs on the new provider: the run's active plan is the
      // successor, and the scheduler's own command names it.
      const state = replayRun(db, RUN).state;
      const started = decide(state, T0 + 6000).find((command) => command.kind === 'StartNode');
      expect(started).toMatchObject({ node: IMPLEMENT, provider: CODEX, attempt: 1 });
    } finally {
      db.close();
    }
  });

  it('makes the swap visible as a /provider change in the plan diff (AC7)', async ({ tmp }) => {
    const { db, plan } = await seed(tmp, { probes: ['claude', 'codex'] });
    try {
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE],
        now: T0 + 1000,
      });
      const recorded = recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: RETRY,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
        quotaRoute: route,
      });

      await applyQuotaReroute(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        patch: recorded.patch as NonNullable<typeof recorded.patch>,
        route: route as Extract<typeof route, { action: 'reroute' }>,
        base: plan,
        nextAttempt: 1,
        retryAt: T0 + 5000,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: caps(db),
        estimatePacketTokens: () => 0,
        refs: new RefFormatChecker(new Git(tmp, { env: GIT_ENV })),
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1000,
        epoch: EPOCH,
      });

      const state = replayRun(db, RUN).state;
      const after = state.plan as unknown as PlanGraph;
      const diff = diffPlanGraphs(plan, after);

      expect(diff.nodes.added).toEqual([]);
      expect(diff.nodes.removed).toEqual([]);
      const changed = diff.nodes.changed.find((entry) => entry.id === IMPLEMENT);
      expect(changed?.patch.some((op) => op.path.startsWith('/provider'))).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-11-S30 — a weaker adapter is not equivalent, so a human rules ───────

suite('EPIC-11-S30 — a reroute onto a weaker adapter is not auto (AC4)', () => {
  it('queues the plan-directed swap for approval instead of applying it', async ({ tmp }) => {
    // The plan's own `onFailure: reroute` names the target — F4.5 makes that
    // policy on the node — and the target cannot resume. The equivalence is
    // still computed from the probed rows, and it says no.
    const rerouting: RetryPolicy = {
      ...RETRY,
      onFailure: [{ when: 'provider.rate-limited', action: 'reroute' }],
    };
    const { db, plan } = await seed(tmp, {
      probes: ['claude', 'copilot'],
      node: {
        retry: rerouting,
        provider: { prefer: [CLAUDE, COPILOT], requires: ['resumableSessions'] },
      },
    });
    try {
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE, COPILOT],
        now: T0 + 1000,
      });
      // AC5's chooser would not have moved it anywhere; the plan did.
      expect(route.action).toBe('suspend');

      const recorded = recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: rerouting,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE, COPILOT] },
        quotaRoute: route,
      });
      expect(recorded.patch?.ops).toEqual([
        { op: 'replace-provider', node: IMPLEMENT, provider: COPILOT },
      ]);

      const outcome = await applyQuotaReroute(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        patch: recorded.patch as NonNullable<typeof recorded.patch>,
        route: {
          action: 'reroute',
          provider: COPILOT,
          capabilitySuperset: false,
          permissionUnchanged: true,
        },
        base: plan,
        nextAttempt: 1,
        retryAt: T0 + 5000,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: caps(db),
        estimatePacketTokens: () => 0,
        refs: new RefFormatChecker(new Git(tmp, { env: GIT_ENV })),
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1000,
        epoch: EPOCH,
      });

      expect(outcome).toMatchObject({ decision: 'approve', ruleId: 'default', applied: false });
      expect(payloadOf(db, 'plan.patch.queued')?.rule).toBe('default');
      // Nothing was applied: the run's plan is still the one it started with.
      expect(payloadOf(db, 'plan.patched')).toBeUndefined();
      expect(replayRun(db, RUN).state.plan?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('records the refusal when the graph the swap names no longer holds the node', async ({
    tmp,
  }) => {
    // The one path that reaches `auto` and still applies nothing. NF10's
    // question is *"what did the run want to do, and why did it not happen"*,
    // so it leaves a rejection rather than a silent return.
    const { db } = await seed(tmp, { probes: ['claude', 'codex'] });
    try {
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE],
        now: T0 + 1000,
      });
      const recorded = recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: RETRY,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
        quotaRoute: route,
      });

      const outcome = await applyQuotaReroute(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        patch: recorded.patch as NonNullable<typeof recorded.patch>,
        route: route as Extract<typeof route, { action: 'reroute' }>,
        // A graph that never had `implement` in it — what a base moving under
        // the proposal looks like from `applyPatch`'s side.
        base: await planFor([agent('other')]),
        nextAttempt: 1,
        retryAt: T0 + 5000,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: caps(db),
        estimatePacketTokens: () => 0,
        refs: new RefFormatChecker(new Git(tmp, { env: GIT_ENV })),
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1000,
        epoch: EPOCH,
      });

      expect(outcome).toMatchObject({ decision: 'auto', applied: false });
      expect(payloadOf(db, 'plan.patch.rejected')).toMatchObject({
        patchId: recorded.patch?.id,
        rule: REROUTE_NOT_APPLICABLE,
        by: 'validation',
      });
      expect(payloadOf(db, 'plan.patched')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

// ── EPIC-11-S31 — no healthy provider: a durable row, and nothing else ───────

suite('EPIC-11-S31 — suspend rather than reroute (AC5, AC8)', () => {
  it('proposes no patch and writes one quota wake at the vendor’s own reset', async ({ tmp }) => {
    // Only the rate-limited adapter and one that cannot resume are installed,
    // so nothing healthy satisfies the node.
    const { db } = await seed(tmp, { probes: ['claude', 'copilot'] });
    try {
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE],
        now: T0 + 1000,
      });
      expect(route.action).toBe('suspend');

      const recorded = recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: RETRY,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
        quotaRoute: route,
      });

      expect(recorded.patch).toBeNull();
      expect(events(db).some((row) => row.kind === 'plan.patch.proposed')).toBe(false);

      // One row, the vendor's own instant, and the reason it renders under.
      const wakes = readWakes(db, RUN);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        nodeId: IMPLEMENT,
        wakeAt: RESETS_AT,
        reason: 'quota',
      });

      const suspended = payloadOf(db, 'node.suspended');
      expect(suspended?.until).toMatchObject({
        kind: 'quota',
        wakeAt: new Date(RESETS_AT).toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it('resumes on the original provider once the reset passes (AC8)', async ({ tmp }) => {
    const { db } = await seed(tmp, { probes: ['claude', 'copilot'] });
    try {
      const route = quotaRouteFor(db, {
        requires: ['resumableSessions'],
        current: CLAUDE,
        prefer: [CLAUDE],
        now: T0 + 1000,
      });
      recordNodeFailure(db, {
        runId: RUN,
        nodeId: IMPLEMENT,
        failure: limited(),
        retry: RETRY,
        epoch: EPOCH,
        ts: T0 + 1000,
        random: seededRandom(7),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
        quotaRoute: route,
      });

      const state = replayRun(db, RUN).state;
      // A minute before the vendor said so, nothing starts — the wait is the
      // row's instant and not a poll that happens to be due.
      expect(
        decide(state, RESETS_AT - 60_000).filter((command) => command.kind === 'StartNode'),
      ).toEqual([]);

      const woken = decide(state, RESETS_AT).find((command) => command.kind === 'StartNode');
      expect(woken).toMatchObject({ node: IMPLEMENT, provider: CLAUDE, attempt: 1 });
    } finally {
      db.close();
    }
  });
});
