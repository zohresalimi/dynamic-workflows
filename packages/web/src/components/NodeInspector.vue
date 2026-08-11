<script setup lang="ts">
/**
 * KAR-17.3 — F10.3's node inspector: what this node was given, what it
 * returned, and the `seq` behind every figure of it.
 *
 * Verifies: EPIC-17-S12, EPIC-17-S13, EPIC-17-S14, EPIC-17-S15, EPIC-17-S16 ·
 * AC1 … AC11
 *
 * PRD §2.1's third broken thing is *"nobody knows why it went wrong"*, and the
 * question this panel exists to settle is narrower than that and much more
 * useful: **was the agent wrong, or was it given the wrong information?** Those
 * are different bugs with different fixes, and telling them apart needs the
 * assembled context packet beside the output, not a log.
 *
 * ## The component decides nothing
 *
 * Every join, every ordering, every reconciliation and every diff is
 * `../lib/node-inspector.ts`, which is pure and tested without a browser. This
 * file is the DOM those decisions produce. The split is not tidiness: AC3's
 * *"the per-segment token counts sum to the header total"* has to be checkable
 * as arithmetic, and a template that re-derived the total would give the view a
 * second opinion about the same number — which is precisely the divergence the
 * criterion is written to catch.
 *
 * ## Why the overlay hosts a debug ring
 *
 * AC7 asks that clicking a token count, a fact, a cost figure or a state
 * transition *"selects the producing event in the debug ring and shows its
 * envelope"*. Nothing else in the application renders the ring, so the pane is
 * here. It is what makes NF10 demonstrable rather than claimed: if the envelope
 * says one thing and the panel says another, the projection is wrong; if they
 * agree, the daemon is. That is also the fastest way to falsify a suspected
 * projection bug, which is why it is worth the forty lines.
 *
 * ## Two things deliberately not rendered
 *
 * **The raw prompt and the raw output are handles, never bytes.** Both are
 * resolved through `GET /api/artifacts/:sha` when a reader asks; inlining them
 * would put unbounded strings in a store KAR-16.4 caps at a fixed object count.
 * The prompt is also labelled *derived* — the manifest above it is what the
 * daemon assembled and is authoritative, and without the label a rendered
 * prompt silently wins any argument with it.
 *
 * **Nothing is fabricated to fill a hole.** A node that died before context
 * assembly gets a stated absence and its typed `NodeFailure` (AC9); a provider
 * that reports no usage is named rather than charged `0` (AC10). Both are the
 * same rule: a reader must be able to tell a measurement from its absence.
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { computed } from 'vue';
import { INSPECTOR_OVERLAY } from '../app/ids.ts';
import { packetKey } from '../ledger/projections/context.ts';
import {
  attemptRows,
  attemptSparkline,
  diffPackets,
  type InspectorSources,
  inspectNode,
} from '../lib/node-inspector.ts';
import { useRunStore } from '../stores/useRunStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';
import StateChip from './StateChip.vue';

const ui = useUiStore();
const run = useRunStore();

const open = computed({
  get: () => ui.isOverlayOpen(INSPECTOR_OVERLAY),
  set: (next: boolean) => {
    if (next) ui.openOverlay(INSPECTOR_OVERLAY);
    else ui.closeOverlay(INSPECTOR_OVERLAY);
  },
});

/**
 * The five projections, re-read whenever any of their version counters moves.
 *
 * `run.version(name)` is the store's whole change-detection contract (docs/12
 * §3.3): the containers are `shallowRef`s replaced wholesale, so touching the
 * counter is what makes this `computed` re-evaluate on a fold.
 */
const sources = computed<InspectorSources>(() => {
  void run.version('plan');
  void run.version('context');
  void run.version('cost');
  void run.version('timeline');
  void run.version('blackboard');
  return {
    plan: run.plan,
    context: run.context,
    cost: run.cost,
    timeline: run.timeline,
    blackboard: run.blackboard,
  };
});

const nodeId = computed(() => ui.inspectedNodeId);

/**
 * The attempt list alone, which is what resolves *"the latest"* below.
 *
 * `attemptRows` rather than `inspectNode(…, 0).attempts`: the full join also
 * builds a packet section and a provenance table, and asking for it here would
 * compute both twice per render — once to find out how many attempts there are,
 * and again for the attempt that answer selects.
 */
const attempts = computed(() =>
  nodeId.value === null ? [] : attemptRows(sources.value, nodeId.value),
);

/**
 * Which attempt is shown. `null` in the store means *the latest*, resolved
 * here rather than at write time — the store cannot know how many attempts
 * there are when `Enter` opens the panel.
 */
const attempt = computed(() => ui.inspectedAttempt ?? attempts.value.at(-1)?.attempt ?? 0);

const view = computed(() =>
  nodeId.value === null ? null : inspectNode(sources.value, nodeId.value, attempt.value),
);

/** The comparison packet, when the operator has chosen one (AC6). */
const diff = computed(() => {
  const other = ui.comparedAttempt;
  if (nodeId.value === null || other === null) return null;
  const mine = sources.value.context.packets.get(packetKey(nodeId.value, attempt.value));
  const theirs = sources.value.context.packets.get(packetKey(nodeId.value, other));
  if (mine === undefined || theirs === undefined) return null;
  return diffPackets(mine, theirs);
});

const SPARK = { width: 60, height: 16 } as const;

const spark = computed(() =>
  nodeId.value === null ? null : attemptSparkline(sources.value, nodeId.value, SPARK),
);

/**
 * The envelope the ring is parked on (AC7).
 *
 * Found by scanning the ring rather than by index: `seq` has holes — `4, 5, 7`
 * is a healthy log (docs/11 §4.2) — so position and `seq` are different things,
 * and a ring that has rolled past the event genuinely no longer has it, which
 * the template says rather than hides.
 */
const envelope = computed(() => {
  void run.ringVersion;
  const seq = ui.selectedEventSeq;
  if (seq === null) return null;
  return run.ring.toArray().find((event) => event.seq === seq) ?? null;
});

const envelopeJson = computed(() =>
  envelope.value === null ? '' : JSON.stringify(envelope.value, null, 2),
);

const money = (value: number | null): string => (value === null ? '—' : `$${value.toFixed(3)}`);

const duration = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="inspector__scrim" />
      <DialogContent
        class="inspector"
        data-overlay="inspector"
        @escape-key-down="(event: Event) => event.preventDefault()"
      >
        <template v-if="view !== null">
          <!-- ── header (AC1) ───────────────────────────────────────────── -->
          <header data-inspector-header class="inspector__head">
            <DialogTitle class="inspector__title">{{ view.header.title }}</DialogTitle>
            <DialogDescription class="inspector__id">{{ view.header.id }}</DialogDescription>

            <StateChip :state="view.header.state as never" />

            <!--
              AC11's sparkline: a `<path>` whose `d` was generated by
              `d3-shape`'s `line()`. Vue owns this subtree and nothing else
              writes into it.
            -->
            <svg
              v-if="spark !== null"
              data-sparkline
              class="inspector__spark"
              :width="SPARK.width"
              :height="SPARK.height"
              :viewBox="`0 0 ${SPARK.width} ${SPARK.height}`"
              role="img"
              :aria-label="`packet size across ${spark.points.length} attempts`"
            >
              <path :d="spark.path" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>

            <dl class="inspector__fields">
              <div v-if="view.header.type !== null">
                <dt>type</dt>
                <dd data-field="type">{{ view.header.type }}</dd>
              </div>
              <div v-if="view.header.provider !== null">
                <dt>provider</dt>
                <dd data-field="provider">{{ view.header.provider }}</dd>
              </div>
              <div v-if="view.header.model !== null">
                <dt>model</dt>
                <dd data-field="model">{{ view.header.model }}</dd>
              </div>
              <div v-if="view.header.binary !== null">
                <dt>CLI version</dt>
                <dd data-field="binary-version">{{ view.header.binary.version }}</dd>
              </div>
              <div v-if="view.header.binary !== null">
                <dt>binary sha256</dt>
                <dd data-field="binary-sha256" class="mono">{{ view.header.binary.sha256 }}</dd>
              </div>
              <div v-if="view.header.permission !== null">
                <dt>permission</dt>
                <dd data-field="permission">{{ view.header.permission }}</dd>
              </div>
              <!--
                `null` and `{ write: [], read: [] }` are rendered differently on
                purpose: "the plan did not say" and "this node may write
                nothing" answer *"was it even allowed to touch that file"*
                differently.
              -->
              <div v-if="view.header.pathScopes !== null">
                <dt>path scopes</dt>
                <dd data-field="path-scopes" class="mono">
                  write: {{ view.header.pathScopes.write.join(', ') || 'nothing' }} · read:
                  {{ view.header.pathScopes.read.join(', ') || 'nothing' }}
                </dd>
              </div>
              <div v-if="view.header.worktree !== null">
                <dt>worktree</dt>
                <dd data-field="worktree" class="mono">{{ view.header.worktree }}</dd>
              </div>
            </dl>

            <p v-if="view.tainted" data-tainted class="inspector__taint">
              This node read a fact that was later invalidated — see the provenance table.
            </p>
          </header>

          <!-- ── attempt history (AC1, AC6, AC7) ────────────────────────── -->
          <section class="inspector__section">
            <h3>Attempts</h3>

            <div class="inspector__tabs" role="tablist" aria-label="Attempt">
              <button
                v-for="row in view.attempts"
                :key="row.key"
                type="button"
                role="tab"
                :data-attempt-tab="row.attempt"
                :aria-selected="row.attempt === attempt"
                @click="ui.inspectAttempt(row.attempt)"
              >
                attempt {{ row.attempt }}
              </button>
            </div>

            <table class="inspector__table">
              <thead>
                <tr>
                  <th>attempt</th>
                  <th>outcome</th>
                  <th>duration</th>
                  <th>cost</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in view.attempts" :key="row.key" :data-attempt-row="row.key">
                  <td>{{ row.attempt }}</td>
                  <td data-outcome>
                    <!--
                      AC7: the transition links to the lifecycle event that made
                      it, so "why does it say failed" is one click from the
                      envelope that said so.
                    -->
                    <button
                      v-if="row.endedAtSeq !== null"
                      type="button"
                      :data-seq-link="row.endedAtSeq"
                      @click="ui.selectEvent(row.endedAtSeq)"
                    >
                      {{ row.outcome }}
                    </button>
                    <span v-else>{{ row.outcome }}</span>
                    <em v-if="row.failure !== null" data-failure-reason
                      >{{ row.failure.reason }}</em
                    >
                  </td>
                  <td data-duration>{{ duration(row.durationMs) }}</td>
                  <td data-cost>
                    <button
                      v-if="row.cost.seq > 0"
                      type="button"
                      :data-seq-link="row.cost.seq"
                      @click="ui.selectEvent(row.cost.seq)"
                    >
                      {{ money(row.cost.vendorReported ?? row.cost.estimated) }}
                    </button>
                    <span v-else>—</span>
                    <!--
                      AC10. Named, never a zero: a `0` is a claim the vendor
                      billed nothing, and nobody measured that.
                    -->
                    <small v-if="row.cost.unaccounted.length > 0" data-unaccounted>
                      plus {{ row.cost.unaccounted.join(', ') }}, which report no token accounting
                    </small>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- ── the context packet (AC2, AC3, AC9) ─────────────────────── -->
          <section class="inspector__section" data-packet :data-status="view.packet.status">
            <h3>Context packet</h3>

            <template v-if="view.packet.status === 'built'">
              <p>
                <strong :data-packet-total="view.packet.headerTotal ?? 0">
                  {{ view.packet.headerTotal }}
                  tokens
                </strong>
                <button
                  v-if="view.packet.builtAtSeq !== null"
                  type="button"
                  :data-seq-link="view.packet.builtAtSeq"
                  @click="ui.selectEvent(view.packet.builtAtSeq)"
                >
                  seq {{ view.packet.builtAtSeq }}
                </button>
                <!--
                  AC3 made visible rather than only asserted: if the builder's
                  header and its own segments ever disagreed, an operator would
                  see it here instead of trusting a silently recomputed total.
                -->
                <span v-if="view.packet.reconciles === false" class="inspector__warn">
                  the per-segment counts sum to {{ view.packet.segmentSum }}, which is not the
                  header total — the packet builder disagrees with itself
                </span>
              </p>

              <div
                v-for="group in view.packet.groups"
                :key="group.kind"
                :data-segment-group="group.kind"
                :data-empty="group.segments.length === 0"
                class="inspector__group"
              >
                <h4>{{ group.kind }} · {{ group.tokens }}</h4>
                <ul v-if="group.segments.length > 0">
                  <li
                    v-for="segment in group.segments"
                    :key="segment.id"
                    :data-segment="segment.id"
                    :data-pinned="segment.pinned"
                  >
                    <code>{{ segment.id }}</code>
                    <span :data-segment-tokens="segment.tokens.estimated">
                      {{ segment.tokens.estimated }}
                    </span>
                    <span v-if="segment.pinned" class="inspector__pin">pinned</span>
                    <button
                      type="button"
                      :data-seq-link="segment.sourceEvent"
                      @click="ui.selectEvent(segment.sourceEvent)"
                    >
                      seq {{ segment.sourceEvent }}
                    </button>
                  </li>
                </ul>
                <p v-else class="inspector__muted">nothing of this kind was in the packet</p>
              </div>

              <!-- AC4 — the prompt, and the fact that it is derived. -->
              <p
                v-if="view.packet.promptHandle !== null"
                :data-prompt-handle="view.packet.promptHandle"
                class="mono"
              >
                {{ view.packet.promptHandle }}
              </p>
              <p data-prompt-derived class="inspector__muted">
                The rendered prompt is <em>derived</em> from the manifest above. The
                <strong>manifest is authoritative</strong>: if the two ever disagree, the manifest
                is what the daemon assembled and sent.
              </p>
            </template>

            <!-- AC9 — honest emptiness. Never blank, never a fabricated packet. -->
            <template v-else>
              <p>
                <strong>No context packet was built for this attempt.</strong>
                This node failed before context assembly ran, so there is nothing to show — and
                nothing has been invented to fill the space.
              </p>
              <div v-if="view.packet.absence !== null" data-packet-absence class="inspector__fail">
                <span data-failure-reason>{{ view.packet.absence.reason }}</span>
                <span data-failure-class>{{ view.packet.absence.class }}</span>
                <p data-failure-message>{{ view.packet.absence.message }}</p>
                <ul>
                  <li
                    v-for="handle in view.packet.absence.evidence"
                    :key="handle"
                    data-evidence
                    class="mono"
                  >
                    {{ handle }}
                  </li>
                </ul>
              </div>
            </template>
          </section>

          <!-- ── the side-by-side (AC6) ─────────────────────────────────── -->
          <section class="inspector__section">
            <h3>Compare with</h3>
            <select
              data-compare-with
              aria-label="Compare this attempt’s packet with"
              :value="ui.comparedAttempt === null ? '' : String(ui.comparedAttempt)"
              @change="
                ui.compareAttempt(
                  ($event.target as HTMLSelectElement).value === ''
                    ? null
                    : Number(($event.target as HTMLSelectElement).value),
                )
              "
            >
              <option value="">— no comparison —</option>
              <option
                v-for="row in view.attempts.filter((one) => one.attempt !== attempt && one.hasPacket)"
                :key="row.key"
                :value="String(row.attempt)"
              >
                attempt {{ row.attempt }}
              </option>
            </select>

            <div v-if="diff !== null" data-packet-diff>
              <!--
                EPIC-17-S13. Stated rather than inferred from an absence of
                changed rows, which is indistinguishable from a diff that never
                ran — and "the repair changed nothing" is itself the diagnosis.
              -->
              <p v-if="diff.identical" data-diff-identical class="inspector__warn">
                These two packets are <strong>identical</strong>. The repair between them changed
                nothing about what this node was given.
              </p>
              <ul>
                <li
                  v-for="row in diff.rows"
                  :key="row.id"
                  :data-diff-row="row.id"
                  :data-change="row.change"
                >
                  <code>{{ row.id }}</code>
                  <span>{{ row.change }}</span>
                  <span v-if="row.change === 'changed'" class="mono">
                    {{ row.leftHash }}
                    → {{ row.rightHash }}
                  </span>
                </li>
              </ul>
            </div>
          </section>

          <!-- ── output, twice (AC5) ────────────────────────────────────── -->
          <section class="inspector__section">
            <h3>Output</h3>

            <div data-output="normalised">
              <h4>normalised &amp; schema-validated</h4>
              <pre v-if="view.normalisedOutput !== null">{{
                JSON.stringify(view.normalisedOutput.output, null, 2)
              }}</pre>
              <p v-else class="inspector__muted">This attempt returned no validated output.</p>
            </div>

            <div data-output="raw">
              <h4>raw</h4>
              <ul v-if="view.rawOutputHandles.length > 0">
                <li
                  v-for="handle in view.rawOutputHandles"
                  :key="handle"
                  data-evidence
                  class="mono"
                >
                  {{ handle }}
                </li>
              </ul>
              <p v-else class="inspector__muted">No raw transcript was recorded.</p>
            </div>

            <!--
              AC5: the validator's own vocabulary, beside the output that failed
              it. The inspector's job is to point at the field that failed, and
              a flattened sentence cannot be pointed with.
            -->
            <div v-if="view.schemaErrors !== null" class="inspector__fail">
              <p>
                did not satisfy <strong data-schema-id>{{ view.schemaErrors.schemaId }}</strong>
              </p>
              <ul>
                <li
                  v-for="(error, index) in view.schemaErrors.errors"
                  :key="`${error.instancePath}#${index}`"
                  data-schema-error
                >
                  <code data-instance-path>{{ error.instancePath }}</code>
                  <span>{{ error.keyword }}</span>
                  <span>{{ error.message }}</span>
                </li>
              </ul>
            </div>
          </section>

          <!-- ── provenance (AC8) ───────────────────────────────────────── -->
          <section class="inspector__section">
            <h3>Facts this node read</h3>

            <table v-if="view.provenance.length > 0" class="inspector__table">
              <thead>
                <tr>
                  <th>key</th>
                  <th>value</th>
                  <th>written by</th>
                  <th>confidence</th>
                  <th>when</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in view.provenance"
                  :key="row.factId"
                  :data-provenance-row="row.factId"
                  :data-invalidated="row.invalidated !== null"
                >
                  <td>
                    <span data-fact-key>{{ row.key }}</span>
                    <button
                      type="button"
                      :data-seq-link="row.writtenAtSeq"
                      @click="ui.selectEvent(row.writtenAtSeq)"
                    >
                      seq {{ row.writtenAtSeq }}
                    </button>
                  </td>
                  <td class="mono">{{ row.valueSummary }}</td>
                  <td>
                    <!-- AC8: each row links to the writing node's inspector. -->
                    <button
                      type="button"
                      :data-open-node="row.byNode"
                      @click="ui.inspectNodeById(row.byNode)"
                    >
                      <span data-fact-writer>{{ row.byNode }}</span>
                    </button>
                    <ul>
                      <li v-for="handle in row.evidence" :key="handle" data-evidence class="mono">
                        {{ handle }}
                      </li>
                    </ul>
                  </td>
                  <td data-fact-confidence>{{ row.confidence }}</td>
                  <td data-fact-at>{{ row.at }}</td>
                  <td v-if="row.invalidated !== null" class="inspector__fail">
                    invalidated by
                    <span data-invalidated-by>{{ row.invalidated.by }}</span>
                    — {{ row.invalidated.reason }}
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-else data-provenance-empty class="inspector__muted">
              This node read no facts from the blackboard.
            </p>
          </section>

          <!-- ── the debug ring (AC7) ───────────────────────────────────── -->
          <section class="inspector__section">
            <h3>Debug ring</h3>
            <!--
              The whitespace inside a `<pre>` is content, so the expression sits
              flush against both tags: a newline added for readability here
              would be a newline in what the operator reads.
            -->
            <pre
              v-if="envelope !== null"
              :data-ring-envelope="envelope.seq"
            >{{ envelopeJson }}</pre>
            <p v-else-if="ui.selectedEventSeq !== null" class="inspector__muted">
              Event {{ ui.selectedEventSeq }} has rolled out of the 2,000-envelope ring. Scrub to a
              snapshot at or before it to bring it back.
            </p>
            <p v-else class="inspector__muted">
              Click any figure above to select the event that produced it.
            </p>
          </section>
        </template>

        <template v-else>
          <DialogTitle class="inspector__title">Node</DialogTitle>
          <DialogDescription class="inspector__id">No node is selected.</DialogDescription>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.inspector__scrim {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
}

.inspector {
  position: fixed;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: min(58rem, 94vw);
  max-height: 88vh;
  overflow-y: auto;
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  padding: 1rem;
  border: 1px solid var(--edge);
  border-radius: 0.75rem;
  background: var(--surface-raised);
  color: var(--ink);
}

.inspector__title {
  font-size: 1rem;
  font-weight: 600;
}

.inspector__id,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.inspector__head {
  display: grid;
  gap: 0.35rem;
  width: 100%;
}

.inspector__spark {
  color: var(--state-running);
}

.inspector__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.25rem 1rem;
  margin: 0;
  font-size: 0.8125rem;
}

.inspector__fields dt {
  color: var(--ink-muted);
  font-size: 0.75rem;
}

.inspector__fields dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.inspector__section {
  width: 100%;
  display: grid;
  gap: 0.4rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--edge);
}

.inspector__section h3 {
  font-size: 0.875rem;
  font-weight: 600;
}

.inspector__section h4 {
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.inspector__tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.inspector__tabs button {
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--edge);
  border-radius: 0.4rem;
  background: var(--surface);
  color: inherit;
  font-size: 0.8125rem;
}

.inspector__tabs button[aria-selected="true"] {
  border-color: var(--focus-ring);
  color: var(--state-running);
}

.inspector__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.inspector__table th,
.inspector__table td {
  text-align: left;
  padding: 0.2rem 0.4rem;
  border-bottom: 1px solid var(--edge);
  vertical-align: top;
}

.inspector__group ul {
  display: grid;
  gap: 0.15rem;
  font-size: 0.8125rem;
}

.inspector__group li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.inspector__pin {
  color: var(--state-awaiting-human);
  font-size: 0.75rem;
}

.inspector__muted {
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.inspector__warn {
  color: var(--state-blocked);
  font-size: 0.8125rem;
}

.inspector__fail {
  color: var(--state-failed);
  font-size: 0.8125rem;
}

.inspector__taint {
  color: var(--state-blocked);
  font-size: 0.8125rem;
}

.inspector pre {
  max-height: 16rem;
  overflow: auto;
  padding: 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 0.4rem;
  background: var(--surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
}

.inspector button[data-seq-link] {
  padding: 0 0.3rem;
  border: 1px solid var(--edge);
  border-radius: 0.3rem;
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 0.7rem;
}

.inspector button[data-open-node] {
  border: 0;
  background: none;
  color: var(--state-running);
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
</style>
