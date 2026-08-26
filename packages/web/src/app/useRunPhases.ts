/**
 * KAR-28.6 — the run's phases, fetched once per *plan shape* and never per
 * frame.
 *
 * `runPhases()` (KAR-28.5, ADR 0018) is served as a field of
 * `GET /api/runs/:id`, and this is the only thing in the frontend that reads it.
 * What it fetches is the **membership** of each phase — which nodes the plan
 * materialises from which top-level step — because that is a property of the
 * plan *document*, and the tab's plan projection is flat by design
 * (`../ledger/projections/plan.ts`: one VM per node id, no `body` target, no
 * nested subgraph). A band that re-derived containment here would promote every
 * `map`'s body template to a phase of its own, which is the exact failure ADR
 * 0018 names.
 *
 * ## Why the trigger is the plan's shape and not the plan's version
 *
 * The plan projection's version counter moves on every `node.started` and every
 * `node.completed` — it holds the statuses too — so watching it would be a
 * request per frame. This screen has an explicit test against that since
 * KAR-22.3: *"a workspace that re-read an endpoint per frame would look
 * identical and fall over on a real run"*. So the watched value is the set of
 * `id:lifecycle` pairs, which moves when a plan is adopted, patched, or fans
 * out, and stands still while nodes run. The **counts** are not fetched at all —
 * `../lib/phases-band.ts` folds them off the stream with core's own
 * `foldPhaseItems`, in the tick the frame arrives.
 *
 * ## What it does when the answer cannot be had
 *
 * Nothing, loudly enough to be visible: `null`, so the band is off the screen.
 * A daemon that is still starting, a token that has not arrived, a build that
 * serves no `phases` field — none of those is a reason to invent a shape for a
 * run, and none of them is an error this surface can act on.
 */
import { computed, shallowRef, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { type PhasesShape, readPhases } from '../lib/phases-band.ts';
import { useRunStore } from '../stores/useRunStore.ts';

/** The one call this makes, named — the same seam every view draws. */
interface SummaryApi {
  readonly runs: {
    readonly ':id': {
      readonly $get: (args: { param: { id: string } }) => Promise<{
        readonly ok: boolean;
        readonly json: () => Promise<unknown>;
      }>;
    };
  };
}

export interface RunPhasesHandle {
  /** The daemon's answer for the run on screen, or `null` if it has none. */
  readonly phases: Readonly<{ value: PhasesShape | null }>;
}

export function useRunPhases(runId: () => string | null): RunPhasesHandle {
  const api = useApiClient() as never as SummaryApi;
  const run = useRunStore();
  const answer = shallowRef<PhasesShape | null>(null);

  /**
   * The plan's shape as one string: every node id and what became of it.
   *
   * Recomputed whenever the plan projection moves — which is every frame — and
   * *equal* to its previous value unless the plan itself changed, which is what
   * keeps the watcher below quiet while a run is merely running.
   */
  const shape = computed(() =>
    run.planNodes.map((node) => `${node.id}:${node.lifecycle}`).join('\n'),
  );

  /**
   * One request at a time, and one more if the shape moved while it was out.
   *
   * A four-hundred-way fan-out arrives as a burst of plan changes; without this
   * it would be a burst of requests, each answering a plan already superseded by
   * the next.
   */
  let inFlight = false;
  let again = false;

  async function load(): Promise<void> {
    const id = runId();
    if (id === null) {
      answer.value = null;
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }

    inFlight = true;
    try {
      const response = await api.runs[':id'].$get({ param: { id } });
      if (!response.ok) return;
      const body = await response.json();
      // The operator moved to another run while we asked. Answering now would
      // put the previous run's shape under this run's agents.
      if (runId() !== id) return;
      answer.value = readPhases(body);
    } catch {
      // See the module note: no shape is the honest answer, never a made-up one.
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        void load();
      }
    }
  }

  watch(
    [runId, shape],
    ([id], [previous]) => {
      // A different run starts from nothing: the band must never show the run
      // before it while this one's answer is in flight.
      if (id !== previous) answer.value = null;
      void load();
    },
    { immediate: true },
  );

  return { phases: answer };
}
