/**
 * KAR-22.3 — a run that ended while the tab was closed, opened from its
 * project's workspace.
 *
 * Verifies: EPIC-22-S44 · AC1, AC4
 *
 * Integration rather than browser, because the claim the scenario makes is
 * about **the order of two network calls**, and no assertion on the DOM can see
 * it: a workspace that opened a socket first and hydrated afterwards would draw
 * exactly the same graph, and would silently miss every event that landed
 * between the two on a run that was still going. So this drives the same feed
 * the workspace mounts (`src/ledger/feed.ts`, through `useRunFeed`) against a
 * real daemon over a real file-backed ledger, with the tape of what went out.
 *
 * The run is completed, and nothing was ever subscribed while it ran — which is
 * the ordinary case for a workspace opened the morning after.
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { boot } from '@DeFlow/daemon';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { openRunFeed } from '../../src/ledger/feed.ts';
import { planProjection } from '../../src/ledger/projections/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260815T090000Z_b17e55');
const T0 = 1_786_800_000_000;

/** The plan this run compiled and then finished: two nodes, both passed. */
const PLAN_NODES = ['recon', 'impl'] as const;

interface Served {
  readonly origin: string;
  readonly projectId: string;
  close(): Promise<void>;
}

function planGraph() {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'b'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: new Date(T0).toISOString(),
    nodes: PLAN_NODES.map((id, index) => ({
      id,
      title: `Step ${id}`,
      deps: index === 0 ? [] : [PLAN_NODES[index - 1]],
      lifecycle: 'active',
      reads: [{ kind: 'spec', section: 'goal' }],
      writes: [],
      permission: 'worktree',
      pathScopes: { write: ['src/**'], read: ['src/**'] },
      returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 4000 },
      retry: { maxAttempts: 3, backoff: { base: 1000, cap: 30_000, jitter: 'full' } },
      budget: { maxCostUsd: 2, maxWallClockMs: 600_000 },
      type: 'agent',
      brief: `Do ${id}.`,
      provider: { prefer: ['claude-code'], requires: ['structuredOutput'] },
      resume: 'native-if-available',
    })),
  };
}

/**
 * A booted daemon, a project, and one whole run appended to its ledger with
 * **nothing subscribed** — which is what "it ended while the tab was closed"
 * means in a form a test can produce.
 *
 * The daemon is `boot`ed rather than assembled from `startHttp` alone, because
 * the workspace's first question — `GET /api/projects/:id/runs` — is answered
 * from the same ports `POST /api/runs` uses, and a half-wired daemon would
 * answer `503 not ready` and prove nothing.
 */
async function serveFinishedRun(tmp: string): Promise<Served> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_DAEMON_TOKEN}` },
    body: JSON.stringify({ name: 'checkout', path: repo.dir }),
  });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;

  // The daemon's **own** write connection: SQLite permits exactly one writer,
  // and `@DeFlow/ledger` enforces that rather than discovering it as corruption
  // later, so a second `openLedger` over the same file is refused.
  const db = booted.db;
  const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload, ...over }) as EventDraft;

  appendEvents(db, [
    draft('task.submitted', {
      source: { kind: 'text', raw: 'migrate the checkout module', bytes: 27 },
      provenance: { kind: 'text', by: 'ui', at: new Date(T0).toISOString(), projectId },
    }),
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'migrate the checkout module',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'it migrates' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'c'.repeat(64)}`,
      },
      cwd: repo.dir,
      repo: { head: 'abcdef1', branch: 'main' },
    }),
    draft('plan.proposed', {
      version: 1,
      planHash: `sha256-${'a'.repeat(64)}`,
      graph: planGraph(),
    }),
    draft('run.started', {}),
    ...PLAN_NODES.flatMap((node, index) => [
      draft('node.scheduled', { node, provider: 'claude-code', permission: 'worktree' }),
      draft(
        'node.started',
        {
          node,
          attempt: 0,
          ikey: `${RUN}/${node}/0/0`,
          binary: { path: '/opt/claude/bin/claude', version: '0.64.1', sha256: 'd'.repeat(64) },
        },
        { v: 2, ts: T0 + 1_000 * (index + 1) },
      ),
      draft(
        'node.completed',
        {
          node,
          attempt: 0,
          result: {
            status: 'completed',
            output: { text: `${node} done` },
            outputSchemaId: 'DeFlow.finding.v1',
            usage: { inputTokens: 100, outputTokens: 20, source: 'vendor-reported' },
            costUsd: 0.01,
            producedFacts: [],
            artifacts: [],
          },
        },
        { ts: T0 + 1_000 * (index + 1) + 500 },
      ),
    ]),
    draft(
      'run.completed',
      { outcome: 'succeeded', criteriaSatisfied: ['ac-1'] },
      { ts: T0 + 9_000 },
    ),
  ]);

  return {
    origin,
    projectId,
    close: () => booted.shutdown(),
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('EPIC-22-S44 — a run that ended while the tab was closed', () => {
  it('is listed as completed for its project, and hydrates before any stream opens', async ({
    tmp,
  }) => {
    served = await serveFinishedRun(tmp);
    const origin = served.origin;

    // What the workspace asks first: which runs this project has. The run is
    // reported in its terminal state, off the ledger's own fold.
    const history = (await (
      await fetch(`${origin}/api/projects/${served.projectId}/runs`, {
        headers: { Authorization: `Bearer ${TEST_DAEMON_TOKEN}` },
      })
    ).json()) as { runs: readonly { runId: string; status: string }[] };
    expect(history.runs.map((run) => [run.runId, run.status])).toEqual([[RUN, 'completed']]);

    // And then the feed the workspace mounts for it, with the tape of what
    // actually went out on the wire.
    const asked: string[] = [];
    const received: Parameters<(typeof planProjection)['apply']>[1][] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      asked.push(new URL(String(input)).pathname);
      return realFetch(input as never, init);
    }) as typeof fetch;

    try {
      const feed = openRunFeed({
        runId: RUN,
        baseUrl: `${origin}/api`,
        token: () => TEST_DAEMON_TOKEN,
        sink: {
          applyEvent(event) {
            received.push(event);
            return true;
          },
        },
      });
      await feed.ready;
      feed.close();
    } finally {
      globalThis.fetch = realFetch;
    }

    // The ordering the API contract requires (docs/11 §4.1): the REST hydrate
    // ran to the head *before* the stream was opened. A client that subscribed
    // first would draw the same graph here and lose every event that landed in
    // the gap on a run that was still going.
    const hydratedAt = asked.findIndex((path) => path.endsWith(`/runs/${RUN}/events`));
    const streamedAt = asked.findIndex((path) => path.endsWith('/stream'));
    expect(hydratedAt, `no hydrate request was made: ${asked.join(', ')}`).toBeGreaterThanOrEqual(
      0,
    );
    expect(streamedAt).toBeGreaterThan(hydratedAt);

    // The full graph, not the tail: every node of the plan, both completed, and
    // the run's own terminal event among the events that arrived.
    const plan = planProjection.create();
    for (const event of received) planProjection.apply(plan, event);
    expect([...plan.nodes.keys()].toSorted()).toEqual([...PLAN_NODES].toSorted());
    expect([...plan.nodes.values()].map((node) => node.state)).toEqual(['passed', 'passed']);
    expect(received.map((event) => event.kind)).toContain('run.completed');
  });
});
