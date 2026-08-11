/**
 * KAR-17.2 AC7 — scrubbing a **10,000-event** run applies zero events below the
 * snapshot `seq` in the browser, test 9 of the story's plan.
 *
 * Verifies: EPIC-17-S6 (the mechanism), KAR-17.2 · AC7
 *
 * > *"the scrub replays from zero"* — the red this is written against.
 *
 * It is the failure the snapshot endpoint exists to prevent and it is
 * **invisible to every other test in this story**. A view that folded the whole
 * ledger in the tab renders exactly the same graph, passes every encoding
 * assertion, and freezes for seconds on a real run — which is where the operator
 * meets it, on the deepest run they have, in front of somebody.
 *
 * ## Why this lives at the repository's `test/integration/` and not in
 * `packages/web`
 *
 * It needs both halves at once: `@DeFlow/web`'s **real** `createScrubber` — the
 * only module in this codebase that materialises the state at a `seq` — and a
 * **real** file-backed ledger with ten thousand rows in it, read through
 * `@DeFlow/ledger`'s own snapshot query. `packages/web` may import
 * `@DeFlow/daemon` for types only (R2, docs/16-repo-layout.md §4), so the pair
 * can only be assembled from outside either package. Node's environment is
 * right for the same reason: what is under test is a request pattern and a fold
 * count, and neither is a question about a DOM.
 *
 * The `fetch` is counted rather than faked: it goes to a real Hono app over a
 * real socket, and every request the scrubber makes is recorded on the way past.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type RunId, RunIdSchema } from '../../packages/core/src/index.ts';
import {
  clearLedgerView,
  openLedgerView,
  setLedgerView,
} from '../../packages/daemon/src/http/ledger-view.ts';
import { startHttp } from '../../packages/daemon/src/http/server.ts';
import { appendEvents, type EventDraft, openLedger } from '../../packages/ledger/src/index.ts';
import { TEST_DAEMON_TOKEN } from '../../packages/testkit/src/index.ts';
import { createClient } from '../../packages/web/src/api/client.ts';
import { createScrubber } from '../../packages/web/src/api/scrub.ts';

const RUN: RunId = RunIdSchema.parse('run_20260811T101500Z_dee901');
const T0 = 1_786_438_900_000;
const EPOCH = 1;
const HASH = (digit: string) => `sha256-${digit.repeat(64)}`;

/** How deep the ledger is. The number in AC7, not a round number chosen here. */
const DEPTH = 10_000;

const draft = (kind: string, payload: unknown, v = 1): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v, epoch: EPOCH, payload }) as EventDraft;

/**
 * A plan document at `version`.
 *
 * One node, because what this spec is about is the *depth of the ledger*, not
 * the width of the plan: the union layout and the four-way encoding are
 * asserted in the browser, against the `three-patches` recording.
 */
const proposal = (version: number): EventDraft =>
  draft(
    'plan.proposed',
    {
      version,
      planHash: HASH(String(version)),
      graph: {
        schemaId: 'DeFlow.plangraph.v1',
        runId: RUN,
        version,
        planHash: HASH(String(version)),
        parent: version === 1 ? null : HASH(String(version - 1)),
        taskSpecHash: HASH('1'),
        createdBy: 'planner',
        createdAt: '2026-08-11T09:00:00.000Z',
        nodes: [
          {
            id: 'impl',
            title: 'Do the work',
            deps: [],
            lifecycle: 'active',
            reads: [{ kind: 'spec', section: 'goal' }],
            writes: [],
            permission: 'worktree',
            pathScopes: { write: ['src/**'], read: ['src/**'] },
            returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 4000 },
            retry: { maxAttempts: 3, backoff: { base: 1000, cap: 30_000, jitter: 'full' } },
            budget: { maxCostUsd: 2, maxWallClockMs: 600_000 },
            type: 'agent',
            brief: 'Do the work, and report what changed.',
            provider: { prefer: ['claude-code'], requires: ['structuredOutput'] },
            resume: 'native-if-available',
          },
        ],
        edges: [],
      },
      by: 'planner',
    },
    2,
  );

/**
 * A run of `DEPTH` events with four plan versions spread through it.
 *
 * The chatter between the versions is `node.progress`, which is what a real
 * deep run is mostly made of: a chatty agent emits one every few hundred
 * milliseconds, and nine hours of them is how a ledger gets to five figures.
 */
function deepRun(): EventDraft[] {
  const events: EventDraft[] = [
    proposal(1),
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'be a deep run',
        scope: { included: ['packages/web'] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'the scrub does not fold in the tab' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: HASH('1'),
      },
      cwd: '/workspace/repo',
      repo: { head: 'abcdef1', branch: 'main' },
    }),
    draft('run.started', { planHash: HASH('1') }),
    draft('node.scheduled', { node: 'impl', provider: 'claude', permission: 'worktree' }),
  ];

  const patchAt = new Set([2_500, 5_000, 7_500]);
  let version = 1;
  while (events.length < DEPTH) {
    const index = events.length;
    if (patchAt.has(index)) {
      version += 1;
      events.push(
        proposal(version),
        draft('plan.patch.proposed', {
          patch: {
            id: `p-${version}`,
            reason: `the ${version}th shape of this work`,
            proposedBy: 'planner',
            ops: [{ op: 'insert-nodes', nodes: [], edges: [] }],
          },
        }),
        draft(
          'plan.patched',
          {
            version,
            fromHash: HASH(String(version - 1)),
            toHash: HASH(String(version)),
            patchId: `p-${version}`,
            decision: { decision: 'auto', by: 'policy', at: '2026-08-11T09:00:00.000Z' },
          },
          2,
        ),
      );
      continue;
    }
    events.push(draft('node.progress', { node: 'impl', attempt: 1, phase: 'running' }));
  }
  return events;
}

interface Served {
  readonly origin: string;
  close(): Promise<void>;
}

async function serve(tmp: string): Promise<Served> {
  const db = openLedger(tmp);
  const events = deepRun();
  // In pages, because ten thousand drafts in one statement is a transaction
  // nothing in production ever writes.
  for (let at = 0; at < events.length; at += 500) {
    appendEvents(db, events.slice(at, at + 500));
  }

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;
const scratchDirs: string[] = [];

/** A real directory for a real file-backed ledger; `:memory:` cannot answer
 * anything about how deep a run is on disk. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'DeFlow-scrub-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await served?.close();
  served = undefined;
  for (const dir of scratchDirs.splice(0)) {
    if (process.env['DeFlow_KEEP_TMP'] === undefined)
      await rm(dir, { recursive: true, force: true });
  }
});

/** Every path the client asked for, in order. */
function countingFetch(paths: string[]): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(`${url.pathname}${url.search}`);
    return globalThis.fetch(input, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${TEST_DAEMON_TOKEN}` },
    });
  };
}

suite('AC7 — a ten-thousand-event run scrubs without folding in the tab', () => {
  it('hydrates each version from one snapshot request and folds nothing', async () => {
    const tmp = await scratch();
    served = await serve(tmp);
    const paths: string[] = [];
    const client = createClient({
      baseUrl: `${served.origin}/api`,
      fetch: countingFetch(paths) as typeof fetch,
    });

    const rail = (await (
      await client.runs[':id'].plans.$get({ param: { id: RUN }, query: { limit: undefined } })
    ).json()) as { version: number; seq: number }[];
    expect(rail.length).toBeGreaterThanOrEqual(1);

    const scrubber = createScrubber(client, RUN, { replayWindow: 0 });
    paths.length = 0;

    // The marquee journey: back to the first version, then forward through
    // every patch.
    const positions = [];
    for (const row of rail) positions.push(await scrubber.positionAt(row.seq));

    // **Zero events applied below the snapshot seq.** Not "few" — zero. Every
    // position is a fold the server did, and `replayed` is the count of events
    // this client folded to reach it.
    expect(positions.map((one) => one.replayed)).toEqual(rail.map(() => 0));
    expect(positions.every((one) => one.hydratedBy === 'snapshot')).toBe(true);

    // And it never asked for the events at all, which is the other half: a
    // client that fetched them and folded them would report `replayed` honestly
    // and still have hauled ten thousand rows into a tab.
    expect(paths.filter((path) => path.includes('/events'))).toEqual([]);
    expect(paths.filter((path) => path.includes('/snapshot'))).toHaveLength(rail.length);
  });

  it('costs the same number of requests however deep the ledger is', async () => {
    const tmp = await scratch();
    // The property AC7 is really about: the tab's work is a function of how
    // many versions there are, not of how many events there are. A fold-from-
    // zero implementation passes every rendering assertion in this story and
    // fails this one.
    served = await serve(tmp);
    const paths: string[] = [];
    const client = createClient({
      baseUrl: `${served.origin}/api`,
      fetch: countingFetch(paths) as typeof fetch,
    });

    const rail = (await (
      await client.runs[':id'].plans.$get({ param: { id: RUN }, query: { limit: undefined } })
    ).json()) as { version: number; seq: number }[];

    const scrubber = createScrubber(client, RUN, { replayWindow: 0 });
    paths.length = 0;

    // Four positions, dragged back and forth twice: eight steps.
    for (const row of [...rail, ...[...rail].reverse()]) await scrubber.positionAt(row.seq);

    // One request per *distinct* position, and none for the re-drags: positions
    // are held by the `seq` they reflect (`packages/web/src/api/scrub.ts`).
    expect(paths).toHaveLength(rail.length);
  });

  it('re-drags over ground it covered without asking the daemon again', async () => {
    const tmp = await scratch();
    served = await serve(tmp);
    const paths: string[] = [];
    const client = createClient({
      baseUrl: `${served.origin}/api`,
      fetch: countingFetch(paths) as typeof fetch,
    });

    const rail = (await (
      await client.runs[':id'].plans.$get({ param: { id: RUN }, query: { limit: undefined } })
    ).json()) as { version: number; seq: number }[];
    const first = rail[0];
    const last = rail.at(-1);
    if (first === undefined || last === undefined) throw new Error('the rail must have versions');

    const scrubber = createScrubber(client, RUN, { replayWindow: 0 });
    await scrubber.positionAt(first.seq);
    await scrubber.positionAt(last.seq);
    paths.length = 0;

    await scrubber.positionAt(first.seq);
    await scrubber.positionAt(last.seq);

    expect(paths).toEqual([]);
  });

  it('answers a seq this run never committed with the state at the one below it', async () => {
    const tmp = await scratch();
    // The rail's seqs are real, but a *drag* lands wherever the pointer is, and
    // `seq` is a global AUTOINCREMENT with holes in it. Resolving down is the
    // server's job, and the client has to carry the answer rather than the
    // request — or the panel labels a position with a seq nothing happened at.
    served = await serve(tmp);
    const client = createClient({
      baseUrl: `${served.origin}/api`,
      fetch: countingFetch([]) as typeof fetch,
    });

    const scrubber = createScrubber(client, RUN, { replayWindow: 0 });
    const landed = await scrubber.positionAt(DEPTH * 4);

    expect(landed.seq).toBeLessThanOrEqual(DEPTH * 4);
    expect(landed.replayed).toBe(0);
  });
});
