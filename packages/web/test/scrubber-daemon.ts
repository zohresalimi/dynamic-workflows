/**
 * The `three-patches` **recording**, served the way DeFlowd serves it, for the
 * plan-evolution scrubber's browser specs.
 *
 * `./three-patches.ts` next door does a related but different job: it is a
 * hand-built row set with *empty* plan documents, and it exists so
 * EPIC-15-S47 can assert on **which requests the client made**. This one is
 * built on `test/fixtures/runs/three-patches/events.jsonl` — the assembled
 * recording, with real `PlanGraph` documents at all four versions — because
 * KAR-17.2 asserts on **what was drawn**, and a union graph over two empty
 * documents draws nothing.
 *
 * Five routes, because the scrubber uses exactly five:
 *
 * - `…/plans` — the version rail (`GET /api/runs/:id/plans`).
 * - `…/patches` — the marks that are *not* versions: the proposal this run made
 *   and had refused (KAR-17.2 AC1).
 * - `…/snapshot?seq=<N>` — each position, folded server-side with
 *   `@DeFlow/core`'s own `foldEvents`, so `RunState.plan` is a real document at
 *   a real `seq` and resolves down through a `seq` gap exactly as
 *   `snapshotRunAt` does. The fixture's sequence has holes (100, 101, 103, …)
 *   because it is one global `AUTOINCREMENT` shared with every other run in a
 *   data directory.
 * - `…/plans/diff?from=&to=` — what changed.
 *
 * ## Why the diff documents are canned rather than computed
 *
 * `diffPlanGraphs` lives in `@DeFlow/daemon`, which `@DeFlow/web` may import for
 * **types only** (R2, docs/16-repo-layout.md §4). More to the point, a diff this
 * fixture computed from the two documents it is already serving would not be
 * evidence that the view asked the server for one — and *"the rendered diff
 * matches `plans/diff` for the same pair"* is a claim about the view's request
 * pattern first and its rendering second. These are written out by hand as the
 * statement of what the endpoint answers, and `e2e/plan-scrubber.test.ts` runs
 * the same journey against a real daemon computing them for real.
 *
 * Every request is recorded in `asked`, so a spec can assert on what was asked
 * for as well as on what appeared.
 */
import type { RunState } from '@DeFlow/core';
import { type Event, foldEvents, initialRunState, parseEvent } from '@DeFlow/core';
import raw from '../../../test/fixtures/runs/three-patches/events.jsonl?raw';

export const RUN = 'run_20260811T101500Z_b7c9d2';
export const API_BASE = 'http://127.0.0.1:7777/api';

let parsed: readonly Event[] | null = null;

/** The recording, parsed through the production `parseEvent`. */
export function threePatches(): readonly Event[] {
  if (parsed !== null) return parsed;
  parsed = raw
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const result = parseEvent(JSON.parse(line));
      if (result.status !== 'ok') {
        throw new Error(
          `three-patches/events.jsonl line ${index + 1} is not readable by this build: ` +
            `${JSON.stringify(result)} — rebuild the fixture from its own script`,
        );
      }
      return result.event;
    });
  return parsed;
}

/** The version rail, as `GET /api/runs/:id/plans` returns it for this run. */
export const PLAN_VERSIONS = [
  {
    version: 1,
    seq: 100,
    planHash: 'sha256-89951643cc44c46d55f301d4b06aeb642d5529dd7b3082303395226903f217c4',
    decision: null,
    reason: null,
  },
  {
    version: 2,
    seq: 104,
    planHash: 'sha256-6f38ba7466bb4b6cbcdff1ff4b8e5b0e6ba2d0e8b4b62b8a2c1e0d9f8a7b6c5d',
    decision: 'auto',
    reason: 'a security review is required before checkout ships',
  },
  {
    version: 3,
    seq: 108,
    planHash: 'sha256-c29e94ec65d0f1f2e3d4c5b6a7988776655443322110ffeeddccbbaa9988776',
    decision: 'approved',
    reason: 'the checkout rewrite is two independent changes',
  },
  {
    version: 4,
    seq: 112,
    planHash: 'sha256-c2b3868b435871a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081920',
    decision: 'auto',
    reason: 'claude-code is out of quota for the next four hours',
  },
] as const;

/**
 * The marks on the rail that are not versions, as `GET …/patches` returns them.
 *
 * The fourth proposal is the whole reason this route exists: it was recorded,
 * it was refused by `escalates-permission`, and the plan version did **not**
 * advance across it.
 */
export const PLAN_PATCHES = [
  {
    patchId: 'p-insert-review',
    seq: 103,
    reason: 'a security review is required before checkout ships',
    proposedBy: 'planner',
    outcome: 'applied',
    decidedSeq: 105,
    version: 2,
    decision: 'auto',
    rule: 'adds-no-write-capability',
    by: 'policy',
  },
  {
    patchId: 'p-split-impl',
    seq: 107,
    reason: 'the checkout rewrite is two independent changes',
    proposedBy: 'planner',
    outcome: 'applied',
    decidedSeq: 109,
    version: 3,
    decision: 'approved',
    rule: 'default',
    by: 'human',
  },
  {
    patchId: 'p-reroute-payment',
    seq: 111,
    reason: 'claude-code is out of quota for the next four hours',
    proposedBy: 'planner',
    outcome: 'applied',
    decidedSeq: 113,
    version: 4,
    decision: 'auto',
    rule: 'quota-reroute-equivalent',
    by: 'policy',
  },
  {
    patchId: 'p-widen-scope',
    seq: 115,
    reason: 'the payment step needs to edit the shared money helper',
    proposedBy: 'planner',
    outcome: 'rejected',
    decidedSeq: 116,
    version: null,
    decision: null,
    rule: 'escalates-permission',
    by: 'policy',
  },
] as const;

const control = (from: string, to: string) => ({ from, to, kind: 'control' });

/**
 * The three adjacent pairs, plus the non-adjacent `v1 → v4` the secondary
 * comparison mode (AC8) asks for.
 *
 * Node ids are listed in `to`'s own node order, which is the order
 * `diffPlanGraphs` produces them in.
 */
export const DIFFS: Record<string, unknown> = {
  '1:2': {
    from: 1,
    to: 2,
    nodes: {
      added: ['review-checkout'],
      removed: [],
      changed: [],
      unchanged: ['recon', 'impl-checkout'],
    },
    edges: { added: [control('impl-checkout', 'review-checkout')], removed: [] },
    unionLayoutKey: `${RUN}:union:v1-v2`,
    reason: 'a security review is required before checkout ships',
    decision: 'auto',
  },
  '2:3': {
    from: 2,
    to: 3,
    nodes: {
      added: ['impl-checkout-cart', 'impl-checkout-payment'],
      removed: ['impl-checkout'],
      changed: [
        {
          id: 'review-checkout',
          patch: [
            { op: 'replace', path: '/deps/0', value: 'impl-checkout-cart' },
            { op: 'add', path: '/deps/1', value: 'impl-checkout-payment' },
          ],
        },
      ],
      unchanged: ['recon'],
    },
    edges: {
      added: [
        control('recon', 'impl-checkout-cart'),
        control('recon', 'impl-checkout-payment'),
        control('impl-checkout-cart', 'review-checkout'),
        control('impl-checkout-payment', 'review-checkout'),
      ],
      removed: [control('recon', 'impl-checkout'), control('impl-checkout', 'review-checkout')],
    },
    unionLayoutKey: `${RUN}:union:v2-v3`,
    reason: 'the checkout rewrite is two independent changes',
    decision: 'approved',
  },
  '3:4': {
    from: 3,
    to: 4,
    nodes: {
      added: [],
      removed: [],
      changed: [
        {
          id: 'impl-checkout-payment',
          patch: [{ op: 'replace', path: '/provider/prefer/0', value: 'codex' }],
        },
      ],
      unchanged: ['recon', 'impl-checkout-cart', 'review-checkout'],
    },
    edges: { added: [], removed: [] },
    unionLayoutKey: `${RUN}:union:v3-v4`,
    reason: 'claude-code is out of quota for the next four hours',
    decision: 'auto',
  },
  /** AC8's secondary mode: two versions that are not adjacent. */
  '1:4': {
    from: 1,
    to: 4,
    nodes: {
      added: ['impl-checkout-cart', 'impl-checkout-payment', 'review-checkout'],
      removed: ['impl-checkout'],
      changed: [],
      unchanged: ['recon'],
    },
    edges: {
      added: [
        control('recon', 'impl-checkout-cart'),
        control('recon', 'impl-checkout-payment'),
        control('impl-checkout-cart', 'review-checkout'),
        control('impl-checkout-payment', 'review-checkout'),
      ],
      removed: [control('recon', 'impl-checkout')],
    },
    unionLayoutKey: `${RUN}:union:v1-v4`,
    reason: 'claude-code is out of quota for the next four hours',
    decision: 'auto',
  },
};

/**
 * The plan document at each version, taken off the recording's own
 * `plan.proposed` events.
 *
 * The daemon resolves `…/plans/:version` through the content-addressed `plan`
 * table, which the replay path populates from exactly these inline documents
 * (`packages/ledger/src/restore.ts`). Reading them here is therefore the same
 * bytes by the same route, and not a second source of truth.
 */
let byVersion: Map<number, unknown> | null = null;

function planDocuments(): Map<number, unknown> {
  if (byVersion !== null) return byVersion;
  byVersion = new Map();
  for (const event of threePatches()) {
    if (event.kind !== 'plan.proposed') continue;
    const payload = event.payload as { readonly version: number; readonly graph: unknown };
    if (!byVersion.has(payload.version)) byVersion.set(payload.version, payload.graph);
  }
  return byVersion;
}

/** Every request the client made, as its path and the queries that matter. */
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
function serverFold(events: readonly Event[]) {
  let base: { seq: number; state: RunState } = { seq: 0, state: initialRunState() };
  return (upTo: number): { seq: number; state: RunState } => {
    if (base.seq > upTo) base = { seq: 0, state: initialRunState() };
    const pending = events.filter((one) => one.seq > base.seq && one.seq <= upTo);
    const report = foldEvents(pending, base.state);
    base = { seq: Math.max(base.seq, report.lastSeq), state: report.state };
    return { seq: base.seq, state: base.state };
  };
}

/** A `fetch` serving `…/plans`, `…/patches`, `…/plans/diff` and `…/snapshot`. */
export function daemonFetch(asked: Asked[], events: readonly Event[] = threePatches()) {
  const fold = serverFold(events);

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
    if (url.pathname.endsWith('/patches')) return json(PLAN_PATCHES);

    // `…/plans/:version` — the immutable plan document, which is where both
    // halves of the union graph come from. Registered after the two literal
    // paths above for the same reason the daemon registers it after
    // `/plans/diff`: a parameter that matched `diff` would answer a 404 with a
    // plan document.
    const version = /\/plans\/(\d+)$/.exec(url.pathname)?.[1];
    if (version !== undefined) {
      const document = planDocuments().get(Number(version));
      return document === undefined
        ? Promise.resolve(new Response('no such version', { status: 404 }))
        : json(document);
    }

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
      const after = events.filter((one) => one.seq > since);
      return json({
        events: after,
        cursor: after.at(-1)?.seq ?? since,
        headSeq: events.at(-1)?.seq ?? 0,
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
