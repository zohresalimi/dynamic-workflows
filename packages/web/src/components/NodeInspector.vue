<script setup lang="ts">
/**
 * KAR-24.6 — the node inspector, in direction A's language.
 *
 * Verifies: EPIC-24-S23, EPIC-24-S24, EPIC-24-S25 · AC1, AC2, AC3, AC4, AC5
 *
 * Direction A draws this as a 400px panel docked to the right edge: a header
 * (icon tile, title, mono `nodeId · kind`, status pill) over a tab strip
 * (output / config / logs) over a scrolling body. This file is that chrome,
 * with **two** tabs rather than three — see below for the log tab's fate.
 * It is **not** a rewrite of what the panel says — `../lib/node-inspector.ts`
 * still owns every join, every ordering and every reconciliation, exactly as
 * it did before this story (KAR-17.3's header comment explains why, and
 * nothing below it changed). What moved is where each fact sits and what it
 * looks like.
 *
 * ## Four things direction A draws that this application does not have
 *
 * The prototype's inspector also shows a tool-call list with per-call
 * timings, a live "streaming output" block with a blinking caret, the
 * system prompt as inlined text, and a **Logs** tab. None of the four is
 * rendered here, on
 * purpose:
 *
 * - **No tool-call list.** `InspectorSources` carries five projections and
 *   none of them is a per-call timeline — `PacketVM`'s `tool.output` segments
 *   are *inputs this node was given*, not calls this node made. Inventing a
 *   list here would be exactly the fabrication the packet-absence and
 *   unaccounted-cost rules in `node-inspector.ts` are written against.
 * - **No live caret over invented text.** The five projections describe
 *   completed ledger events, not a live byte stream — that stream exists
 *   (`../lib/node-output.ts`, `./output/NodeTerminal.vue`) but it is a
 *   different feature with its own polling loop and its own archive, wired to
 *   a routed view rather than to this overlay, and pulling it in here would
 *   be new fetch behaviour a story that changes no API call may not add. The
 *   caret is used **once**, honestly: beside "this attempt hasn't finished"
 *   when `attemptRow.outcome === 'running'`, which is a real field, not
 *   invented text.
 * - **No inlined system prompt.** `PacketSectionVM.promptHandle` is a
 *   handle, never bytes — KAR-17.3's own header comment on the pre-KAR-24.6
 *   version of this file already explains why: the manifest above it is
 *   authoritative, and a rendered prompt that disagreed with it would
 *   silently win the argument. That rule outranks direction A's code block,
 *   so the code block holds the handle and the "derived" note, as before.
 *
 * ## Why the panel is still a `Dialog`, not a docked aside
 *
 * `INSPECTOR_OVERLAY` participates in the `Esc`-closes-topmost-overlay stack
 * and the `CommandJumper` interaction (`../app/keyboard.ts`), and KAR-24.6
 * AC4 keeps both exactly as they were. Only the CSS moved: `.inspector` is
 * still a `DialogContent`, it just now paints flush to the right edge instead
 * of centred, the same way changing a modal's `max-width` was never a
 * behaviour change before this story either.
 *
 * ## Why the tabs cannot hide the sections below them
 *
 * Attempts, the context packet, the compare, provenance and the debug ring
 * are not part of direction A's output/config/logs split — they are this
 * application's own diagnostic material, and `node-inspector.test.ts` reaches
 * every one of them without ever clicking a tab. So they stay below the tab
 * strip, in the one scrolling column the story's own "so that diagnosis is
 * scrolling rather than clicking" is written for, and the two tabs above them
 * govern only the material direction A's mock actually named and this
 * application actually has: the current attempt's output, and its config.
 *
 * ## Why there is no Logs tab
 *
 * There is no level-tagged, per-node log line anywhere in the projections
 * this component reads; the debug ring below is the closest equivalent, and
 * it is already on screen. A first pass rendered the tab anyway, holding a
 * sentence explaining that it was empty and pointing downwards — which is a
 * tab whose only content is an apology, and furniture by the same argument
 * KAR-24.5 used to refuse direction A's flow-tab strip. Consistency in a
 * design system is worth more than fidelity to a mock's tab count, so the
 * tab is gone and the reason lives here instead, where the next person to
 * wonder where it went will find it.
 *
 * The remainder of the original note, for the record: a log
 * stream. `TabsRoot`'s `unmount-on-hide="false"` keeps an inactive tab's
 * markup in the DOM (hidden, not gone), which is what lets every existing
 * `data-field`, `data-prompt-handle` and `data-output` assertion still find
 * its element without the operator having clicked Output first.
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from 'reka-ui';
import { computed, ref } from 'vue';
import { INSPECTOR_OVERLAY } from '../app/ids.ts';
import { packetKey } from '../ledger/projections/context.ts';
import {
  attemptRows,
  attemptSparkline,
  diffPackets,
  type InspectorSources,
  inspectNode,
} from '../lib/node-inspector.ts';
import { type DisplayState, stateVar } from '../lib/state-palette.ts';
import { useRunStore } from '../stores/useRunStore.ts';
import { useUiStore } from '../stores/useUiStore.ts';
import { glyphFor } from './graph/glyphs.ts';
import StateChip from './StateChip.vue';
import { UiChip, UiIconTile, UiMetaRow, UiSectionLabel, UiStatTile } from './ui/index.ts';

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

/** The row for the attempt currently on screen — the output tab's stat grid reads it. */
const attemptRow = computed(
  () => attempts.value.find((row) => row.attempt === attempt.value) ?? null,
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

/**
 * The header's icon tile. `view.header.state` is typed `string` on
 * `InspectorHeaderVM` but is never assigned anything except a `PlanNodeVM`'s
 * own `state`, which is `DisplayState` end to end (`../ledger/projections/plan.ts`)
 * — so this is a type assertion about a value that is already correct, not a
 * silent widening of one that might not be, the same fact the pre-KAR-24.6
 * `as never` on this line was standing in for less precisely.
 */
const headerState = computed<DisplayState>(
  () => (view.value?.header.state ?? 'pending') as DisplayState,
);
const headerGlyph = computed(() => glyphFor(view.value?.header.type ?? null));

/** AC1's three tabs. `output` first — the question an operator opens this panel to ask. */
const activeTab = ref<'output' | 'config'>('output');

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
          <!-- ── header (AC1) — icon tile, title, mono id · kind, status pill ── -->
          <header data-inspector-header class="inspector__head">
            <UiIconTile
              size="md"
              :tint="stateVar(headerState)"
              data-slot="type-glyph"
              :title="view.header.type ?? undefined"
            >
              <component :is="headerGlyph" :size="12" :stroke-width="2" aria-hidden="true" />
            </UiIconTile>
            <div class="inspector__identity">
              <DialogTitle class="inspector__title">{{ view.header.title }}</DialogTitle>
              <DialogDescription class="inspector__id mono">
                {{ view.header.id }}
                · {{ view.header.type ?? 'unknown' }}
              </DialogDescription>
            </div>
            <StateChip :state="headerState" />

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
          </header>

          <p v-if="view.tainted" data-tainted class="inspector__taint">
            This node read a fact that was later invalidated — see the provenance table.
          </p>

          <!-- ── the tab strip: output / config / logs (AC1, AC2, AC3) ─────── -->
          <TabsRoot v-model="activeTab" :unmount-on-hide="false" class="inspector__tabsroot">
            <TabsList class="inspector__tabstrip" aria-label="Inspector">
              <TabsTrigger value="output" class="inspector__tab">Output</TabsTrigger>
              <TabsTrigger value="config" class="inspector__tab">Config</TabsTrigger>
            </TabsList>

            <div class="inspector__tabbody">
              <!-- ── output: the 2×2 stat grid, then this attempt's output (AC2) ── -->
              <TabsContent
                value="output"
                data-inspector-tabpanel="output"
                class="inspector__tabpanel"
              >
                <div class="inspector__stats">
                  <UiStatTile label="Tokens" :value="view.packet.headerTotal ?? '—'" />
                  <UiStatTile
                    label="Cost"
                    :value="money(attemptRow?.cost.vendorReported ?? attemptRow?.cost.estimated ?? null)"
                  />
                  <UiStatTile label="Duration" :value="duration(attemptRow?.durationMs ?? null)" />
                  <UiStatTile label="Attempts" :value="view.attempts.length" />
                </div>

                <div data-output="normalised" class="inspector__output-block">
                  <UiSectionLabel>normalised &amp; schema-validated</UiSectionLabel>
                  <pre
                    v-if="view.normalisedOutput !== null"
                    class="inspector__code mono"
                  >{{ JSON.stringify(view.normalisedOutput.output, null, 2) }}</pre>
                  <!--
                    An attempt still running has produced no `NodeResultVM` yet
                    — that is not the same absence as one that finished with
                    nothing, and the caret says which one this is honestly
                    (`data-motion-token`: switched off under reduced motion by
                    theme.css's blanket rule, not by anything named here).
                  -->
                  <p
                    v-else-if="attemptRow?.outcome === 'running'"
                    data-output-live
                    class="inspector__live"
                  >
                    this attempt hasn't finished — output will appear here once it does
                    <span class="inspector__caret" data-motion-token aria-hidden="true" />
                  </p>
                  <p v-else class="inspector__muted">This attempt returned no validated output.</p>
                </div>

                <div data-output="raw" class="inspector__output-block">
                  <UiSectionLabel>raw</UiSectionLabel>
                  <ul v-if="view.rawOutputHandles.length > 0" class="inspector__evidence">
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
                  The validator's own vocabulary, beside the output that failed
                  it. The inspector's job is to point at the field that failed,
                  and a flattened sentence cannot be pointed with.
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
              </TabsContent>

              <!-- ── config: runtime & model as UiMetaRows, the prompt as a code block (AC3) ── -->
              <TabsContent
                value="config"
                data-inspector-config
                data-inspector-tabpanel="config"
                class="inspector__tabpanel"
              >
                <UiMetaRow
                  v-if="view.header.type !== null"
                  label="type"
                  :value="view.header.type"
                />
                <UiMetaRow
                  v-if="view.header.provider !== null"
                  label="runtime"
                  :value="view.header.provider"
                />
                <UiMetaRow
                  v-if="view.header.model !== null"
                  label="model"
                  :value="view.header.model"
                />
                <UiMetaRow
                  v-if="view.header.worktree !== null"
                  label="worktree"
                  :value="view.header.worktree"
                />
                <!--
                  `data-field="path-scopes"` and `data-field="permission"` above
                  fall through onto `UiMetaRow`'s own root, which also carries
                  the label — fine for the two assertions that read them, which
                  ask "is this truthy" and "does this contain src/**", not "is
                  this exactly one value" (`node-inspector.test.ts`).
                -->
                <UiMetaRow
                  v-if="view.header.pathScopes !== null"
                  label="path scopes"
                  data-field="path-scopes"
                  :value="`write: ${view.header.pathScopes.write.join(', ') || 'nothing'} · read: ${view.header.pathScopes.read.join(', ') || 'nothing'}`"
                />
                <UiMetaRow
                  v-if="view.header.permission !== null"
                  label="permission"
                  data-field="permission"
                  :value="view.header.permission"
                />
                <!--
                  Binary version and sha256 are hand-rolled rather than a third
                  pair of `UiMetaRow`s: `node-inspector.test.ts` reads each
                  value in isolation with `toBe`/`toMatch`, and `UiMetaRow`'s
                  root carries its label text alongside the value — right for
                  every other row here, wrong for the one assertion that wants
                  the value alone.
                -->
                <div v-if="view.header.binary !== null" class="inspector__config-row">
                  <span class="inspector__config-label">CLI version</span>
                  <span class="inspector__config-value mono" data-field="binary-version"
                    >{{ view.header.binary.version }}</span
                  >
                </div>
                <div v-if="view.header.binary !== null" class="inspector__config-row">
                  <span class="inspector__config-label">binary sha256</span>
                  <span class="inspector__config-value mono" data-field="binary-sha256"
                    >{{ view.header.binary.sha256 }}</span
                  >
                </div>

                <div class="inspector__prompt">
                  <UiSectionLabel>system prompt</UiSectionLabel>
                  <template v-if="view.packet.status === 'built'">
                    <!--
                      The whitespace inside a `<pre>` is content, so the
                      expression sits flush against both tags.
                    -->
                    <pre
                      v-if="view.packet.promptHandle !== null"
                      :data-prompt-handle="view.packet.promptHandle"
                      class="inspector__code mono"
                    >{{ view.packet.promptHandle }}</pre>
                    <p data-prompt-derived class="inspector__muted">
                      The rendered prompt is <em>derived</em> from the manifest above. The
                      <strong>manifest is authoritative</strong>: if the two ever disagree, the
                      manifest is what the daemon assembled and sent.
                    </p>
                  </template>
                  <p v-else class="inspector__muted">
                    No context packet was built for this attempt, so there is no prompt to show.
                  </p>
                </div>
              </TabsContent>
            </div>
          </TabsRoot>

          <!-- ── everything below is this application's own diagnostic material,
               not direction A's tab split — always on screen, per the story's
               own "diagnosis is scrolling rather than clicking". ─────────── -->

          <!-- ── attempt history (AC1, AC6, AC7) ────────────────────────── -->
          <section class="inspector__section">
            <UiSectionLabel as="h3">Attempts</UiSectionLabel>

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
            <UiSectionLabel as="h3">Context packet</UiSectionLabel>

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
                    <UiChip v-if="segment.pinned" variant="info" mono>pinned</UiChip>
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
            <UiSectionLabel as="h3">Compare with</UiSectionLabel>
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

          <!-- ── provenance (AC8) ───────────────────────────────────────── -->
          <section class="inspector__section">
            <UiSectionLabel as="h3">Facts this node read</UiSectionLabel>

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
            <UiSectionLabel as="h3">Debug ring</UiSectionLabel>
            <!--
              The whitespace inside a `<pre>` is content, so the expression sits
              flush against both tags: a newline added for readability here
              would be a newline in what the operator reads.
            -->
            <pre
              v-if="envelope !== null"
              :data-ring-envelope="envelope.seq"
              class="inspector__code mono"
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
  background: var(--surface-overlay);
}

/*
 * AC1 — a 400px panel docked to the right edge, full height, rather than the
 * centred card this file drew before KAR-24.6. Still a `DialogContent`: see
 * this file's own header comment for why that half is unchanged.
 */
.inspector {
  position: fixed;
  inset-block: 0;
  inset-inline-end: 0;
  width: min(400px, 100vw);
  max-height: 100vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  border-inline-start: 1px solid var(--edge);
  background: var(--surface-raised);
  color: var(--ink);
  box-shadow: var(--shadow-modal);
}

.inspector__title {
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.inspector__id,
.mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
}

.inspector__head {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — direction A's header gutter */
  flex: none;
  padding: 13px 14px 11px; /* geometry — direction A's header padding */
  border-bottom: 1px solid var(--edge);
}

.inspector__identity {
  flex: 1;
  min-width: 0;
}

.inspector__spark {
  color: var(--state-running);
  flex: none;
}

.inspector__taint {
  flex: none;
  margin: 0;
  padding: 0.4rem 14px;
  color: var(--state-blocked);
  font-size: var(--text-base);
}

.inspector__tabsroot {
  display: flex;
  flex-direction: column;
  flex: none;
}

.inspector__tabstrip {
  display: flex;
  gap: 6px; /* geometry — direction A's tab gutter */
  padding: 0 14px 11px;
}

.inspector__tab {
  padding: 4px 9px; /* geometry — direction A's tab padding */
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--ink-muted);
  font-size: var(--text-base);
  cursor: pointer;
}

.inspector__tab[aria-selected="true"] {
  color: var(--ink);
  background: var(--surface-inset);
  border-color: var(--edge-strong);
}

.inspector__tabbody {
  padding: 12px 14px 18px; /* geometry — direction A's body padding */
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inspector__tabpanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.inspector__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px; /* geometry — direction A's stat-grid gutter */
}

.inspector__prompt,
.inspector__output-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.inspector__config-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--edge);
}

.inspector__config-label {
  width: 96px;
  flex: none;
  font-size: var(--text-base);
  color: var(--ink-muted);
}

.inspector__config-value {
  flex: 1;
  text-align: right;
  font-size: var(--text-sm);
  color: var(--ink);
}

.inspector__live {
  display: flex;
  align-items: center;
  color: var(--ink-muted);
  font-size: var(--text-base);
}

.inspector__caret {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-inline-start: 0.35em;
  vertical-align: -2px;
  background: var(--state-running);
  animation: caret 1s step-end infinite;
}

.inspector__evidence {
  display: grid;
  gap: 0.15rem;
}

/* Below the tabs: this application's own diagnostic sections. */

.inspector__section {
  flex: none;
  width: 100%;
  display: grid;
  gap: 0.4rem;
  padding: 0.5rem 14px 0;
  border-top: 1px solid var(--edge);
}

.inspector__section h4 {
  font-size: var(--text-sm);
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
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: inherit;
  font-size: var(--text-base);
}

.inspector__tabs button[aria-selected="true"] {
  border-color: var(--focus-ring);
  color: var(--state-running);
}

.inspector__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
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
  font-size: var(--text-base);
}

.inspector__group li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.inspector__muted {
  color: var(--ink-muted);
  font-size: var(--text-base);
}

.inspector__warn {
  color: var(--state-blocked);
  font-size: var(--text-base);
}

.inspector__fail {
  color: var(--state-failed);
  font-size: var(--text-base);
}

.inspector__code {
  max-height: 16rem;
  overflow: auto;
  margin: 0;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-code);
  color: var(--ink-muted);
  font-size: var(--text-sm);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.inspector button[data-seq-link] {
  padding: 0 0.3rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: var(--text-xs);
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
