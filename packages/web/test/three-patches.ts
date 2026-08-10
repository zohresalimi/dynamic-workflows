/**
 * The `three-patches` fixture, and a `fetch` that serves it the way DeFlowd
 * does.
 *
 * It is the fixture EPIC-15-S47 is written against: a run that compiled v1,
 * started on it, and was patched three times. Its sequence is 1, 2, 3, 6, 7, 9,
 * 12, 13, 15 — the holes belong to other runs in the same data directory, which
 * is what makes "hydrated from `?seq=<N>`" a claim with teeth, because several
 * of the numbers a scrubber lands on were never committed by *this* run.
 *
 * Three routes, because the plan-evolution view uses exactly three:
 * `…/plans` for the version rail, `…/snapshot?seq=<N>` for each position, and
 * `…/plans/diff?from=&to=` for what changed. Every request is recorded, so a
 * spec can assert on *which request the client made* — which is the whole point
 * of EPIC-15-S47 and is invisible to a spec that only checks what rendered.
 *
 * The snapshot route folds with `@DeFlow/core`'s own `foldEvents`, so the states
 * it serves are real reduced states and resolve down through a gap exactly as
 * `snapshotRunAt` does. The diff route serves canned documents: `diffPlanGraphs`
 * lives in `@DeFlow/daemon`, which the web package may import for **types
 * only** (R2, docs/16-repo-layout.md §4), and a diff the client could compute
 * for itself would not be evidence that it asked the server for one.
 */
import type { RunState } from '@DeFlow/core';
import { foldEvents, initialRunState, PLANGRAPH_SCHEMA_ID } from '@DeFlow/core';

export const RUN = 'run_20260806T141133Z_9f2a1c';
export const API_BASE = 'http://127.0.0.1:7777/api';

const hashOf = (digit: string): string => `sha256-${digit.repeat(64)}`;
export const HASHES = [hashOf('1'), hashOf('2'), hashOf('3'), hashOf('4')] as const;
const SPEC_HASH = hashOf('f');

const DECISION = { decision: 'auto', by: 'policy', at: '2026-08-06T14:12:00.000Z' } as const;

interface Row {
  readonly seq: number;
  readonly runId: string;
  readonly ts: number;
  readonly kind: string;
  readonly v: number;
  readonly epoch: number;
  readonly payload: unknown;
}

const row = (seq: number, kind: string, v: number, payload: unknown): Row => ({
  seq,
  runId: RUN,
  ts: 1_754_140_000_000 + seq,
  kind,
  v,
  epoch: 7,
  payload,
});

const patch = (version: number, seq: number, fromHash: string, toHash: string): Row =>
  row(seq, 'plan.patched', 2, {
    version,
    fromHash,
    toHash,
    patchId: `p_v${version}`,
    decision: DECISION,
  });

export const THREE_PATCHES: readonly Row[] = [
  row(1, 'plan.proposed', 2, {
    version: 1,
    planHash: HASHES[0],
    graph: {
      schemaId: PLANGRAPH_SCHEMA_ID,
      runId: RUN,
      version: 1,
      planHash: HASHES[0],
      parent: null,
      taskSpecHash: SPEC_HASH,
      createdBy: 'planner',
      createdAt: '2026-08-06T14:11:33.000Z',
      nodes: [],
      edges: [],
    },
    by: 'planner',
  }),
  row(2, 'run.started', 1, { planHash: HASHES[0] }),
  row(3, 'node.scheduled', 1, { node: 'n-impl-1', provider: 'claude', permission: 'read' }),
  patch(2, 6, HASHES[0], HASHES[1]),
  row(7, 'node.progress', 1, { node: 'n-impl-1', attempt: 1, phase: 'running' }),
  patch(3, 9, HASHES[1], HASHES[2]),
  row(12, 'node.progress', 1, { node: 'n-impl-1', attempt: 1, phase: 'running' }),
  patch(4, 13, HASHES[2], HASHES[3]),
  row(15, 'run.paused', 1, { by: 'user' }),
];

/** The version rail, as `GET /api/runs/:id/plans` returns it. */
export const PLAN_VERSIONS = [
  { version: 1, seq: 1, planHash: HASHES[0], decision: null, reason: null },
  { version: 2, seq: 6, planHash: HASHES[1], decision: 'auto', reason: 'quota reroute' },
  { version: 3, seq: 9, planHash: HASHES[2], decision: 'auto', reason: 'gate failure repair' },
  { version: 4, seq: 13, planHash: HASHES[3], decision: 'human', reason: 'operator interjection' },
] as const;

/**
 * The diff documents `GET …/plans/diff?from=N&to=M` answers with, for the three
 * adjacent pairs the scrubber walks.
 *
 * Deliberately not derivable from anything the client holds: the node ids and
 * the RFC 6902 patches exist only here, so a view that rendered a diff it
 * computed itself from two snapshots would render *nothing* rather than
 * something slightly wrong, and the failure would be unmissable.
 */
export const DIFFS: Record<string, unknown> = {
  '1:2': {
    from: 1,
    to: 2,
    nodes: {
      added: ['n-review'],
      removed: [],
      changed: [{ id: 'n-impl-1', patch: [{ op: 'replace', path: '/provider', value: 'gemini' }] }],
      unchanged: ['n-plan'],
    },
    edges: { added: [{ from: 'n-impl-1', to: 'n-review', kind: 'sequence' }], removed: [] },
    unionLayoutKey: 'ulk-1-2',
    reason: 'quota reroute',
    decision: 'auto',
  },
  '2:3': {
    from: 2,
    to: 3,
    nodes: {
      added: ['n-repair'],
      removed: ['n-review'],
      changed: [],
      unchanged: ['n-plan', 'n-impl-1'],
    },
    edges: { added: [], removed: [{ from: 'n-impl-1', to: 'n-review', kind: 'sequence' }] },
    unionLayoutKey: 'ulk-2-3',
    reason: 'gate failure repair',
    decision: 'auto',
  },
  '3:4': {
    from: 3,
    to: 4,
    nodes: {
      added: [],
      removed: [],
      changed: [
        { id: 'n-repair', patch: [{ op: 'replace', path: '/permission', value: 'write' }] },
      ],
      unchanged: ['n-plan', 'n-impl-1'],
    },
    edges: { added: [], removed: [] },
    unionLayoutKey: 'ulk-3-4',
    reason: 'operator interjection',
    decision: 'human',
  },
};

/** Every request the client made, as its path and the two queries that matter. */
export interface Asked {
  readonly path: string;
  readonly seq: string | null;
  readonly since: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

const json = (body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

/**
 * A fold with the checkpoint cache the real ledger has (KAR-03.6), resolving
 * down exactly as `snapshotRunAt` does: the answer is the greatest committed
 * `seq` at or below the request, whatever the request was.
 */
function serverFold(rows: readonly Row[]) {
  let base: { seq: number; state: RunState } = { seq: 0, state: initialRunState() };
  return (upTo: number): { seq: number; state: RunState } => {
    if (base.seq > upTo) base = { seq: 0, state: initialRunState() };
    const pending = rows.filter((candidate) => candidate.seq > base.seq && candidate.seq <= upTo);
    const report = foldEvents(pending, base.state);
    base = { seq: Math.max(base.seq, report.lastSeq), state: report.state };
    return { seq: base.seq, state: base.state };
  };
}

/** A `fetch` serving `…/plans`, `…/plans/diff`, `…/snapshot` and `…/events`. */
export function daemonFetch(asked: Asked[], rows: readonly Row[] = THREE_PATCHES) {
  const fold = serverFold(rows);

  return (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    asked.push({
      path: url.pathname,
      seq: url.searchParams.get('seq'),
      since: url.searchParams.get('since'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });

    if (url.pathname.endsWith('/plans/diff')) {
      const key = `${url.searchParams.get('from')}:${url.searchParams.get('to')}`;
      const diff = DIFFS[key];
      return diff === undefined
        ? Promise.resolve(new Response('no such pair', { status: 404 }))
        : json(diff);
    }

    if (url.pathname.endsWith('/plans')) return json(PLAN_VERSIONS);

    if (url.pathname.endsWith('/snapshot')) {
      const requested = url.searchParams.get('seq');
      const snapshot = fold(requested === 'head' ? Number.POSITIVE_INFINITY : Number(requested));
      return json({
        seq: snapshot.seq,
        state: snapshot.state,
        planVersion: snapshot.state.planVersion,
        planHash: snapshot.state.planHash,
      });
    }

    if (url.pathname.endsWith('/events')) {
      const since = Number(url.searchParams.get('since') ?? '0');
      const after = rows.filter((candidate) => candidate.seq > since);
      return json({
        events: after,
        cursor: after.at(-1)?.seq ?? since,
        headSeq: rows.at(-1)?.seq ?? 0,
        more: false,
      });
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

export const snapshotsIn = (asked: readonly Asked[]) =>
  asked.filter((one) => one.path.endsWith('/snapshot'));
export const eventsIn = (asked: readonly Asked[]) =>
  asked.filter((one) => one.path.endsWith('/events'));
export const diffsIn = (asked: readonly Asked[]) =>
  asked.filter((one) => one.path.endsWith('/plans/diff'));
