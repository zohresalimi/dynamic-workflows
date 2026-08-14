<script setup lang="ts">
/**
 * KAR-17.5 — F10.6's output panel: the tail, the right renderer for it, and the
 * archive behind both.
 *
 * Verifies: EPIC-17-S20, EPIC-17-S21, EPIC-17-S23 · AC1, AC3, AC6, AC7, AC8,
 * AC9, AC10
 *
 * ## What this component decides, and what it refuses to
 *
 * It decides **which surface** the output belongs on, from the stream the
 * chunks arrived as (`../../lib/node-output.ts`) — and nothing else. The
 * terminal's disciplines are `../../lib/terminal-session.ts`'s, the ACP parse
 * is `../../lib/acp-stream.ts`'s, and the archive's paging is
 * `../../lib/log-archive.ts`'s. A panel that owned any of those would be the
 * second place each rule lived.
 *
 * ## Three states, and none of them is a spinner that never ends
 *
 * - **Output, of one kind or the other.** Terminal or typed list.
 * - **No output at all** (AC10). Said in a sentence, because an empty terminal
 *   and a broken terminal are indistinguishable, and this panel is what an
 *   operator opens *because* they cannot tell which they are looking at.
 * - **Output that stopped mid-turn** (AC10). An ACP stream with no result
 *   envelope is a turn that did not finish. Rendering it identically to a
 *   finished one is how "it looked like it completed" becomes an hour.
 *
 * ## The bytes stop here (AC8)
 *
 * `io_chunk` data is held in this component's own refs, on its own endpoint,
 * and is dropped when the panel unmounts. It never reaches the run store and
 * never travels on the control-plane SSE stream. What *is* registered with the
 * store is the live `Terminal` — through `adoptTerminal`, so EPIC-16's leak
 * assertion counts one accounting of live terminals rather than two.
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { readIoSince, readIoTail } from '../../api/io-tail.ts';
import { useApiClient } from '../../api/provide.ts';
import { readToken } from '../../api/token.ts';
import { acpTranscript } from '../../lib/acp-stream.ts';
import { artifactArchive, type LogArchive } from '../../lib/log-archive.ts';
import {
  ENDED_WITHOUT_RESULT,
  type IoChunkLine,
  mergeIoChunks,
  NO_OUTPUT_AT_ALL,
  outputRendererFor,
} from '../../lib/node-output.ts';
import type { TerminalSession } from '../../lib/terminal-session.ts';
import { useRunStore } from '../../stores/useRunStore.ts';
import { useUiStore } from '../../stores/useUiStore.ts';
import AgentMessageList from './AgentMessageList.vue';

/**
 * The two surfaces that are only ever needed one at a time, split out of the
 * route's chunk.
 *
 * `outputRendererFor` picks `terminal` or `structured` from the stream the
 * chunks arrived as, and a node is one or the other — never both. Bundling both
 * statically put xterm and its three addons into every load of this route,
 * including the ACP nodes that will never construct a `Terminal`, and pushed
 * the chunk past Rolldown's 500 kB warning (`test/integration/`
 * `bundle-budget.test.ts`, which is what noticed). `FullLogViewer` is the same
 * argument one step further: it is behind a button most operators never press.
 *
 * `defineAsyncComponent` rather than a manual `import()`, because the loading
 * and error states belong to Vue rather than to a ref this file would have to
 * maintain.
 */
const NodeTerminal = defineAsyncComponent(() => import('./NodeTerminal.vue'));
const FullLogViewer = defineAsyncComponent(() => import('./FullLogViewer.vue'));

const props = defineProps<{
  readonly runId: string;
  readonly nodeId: string;
}>();

const client = useApiClient();
const run = useRunStore();
const ui = useUiStore();

const chunks = shallowRef<readonly IoChunkLine[]>([]);
const loaded = ref(false);
const failure = ref<string | null>(null);
const selectedSeq = ref<number | null>(null);
const showingArchive = ref(false);

const renderer = computed(() => outputRendererFor(chunks.value));

/** The shim path: every stdout/stderr chunk concatenated, as bytes to write. */
const terminalText = computed(() =>
  chunks.value
    .filter((chunk) => chunk.stream !== 'agent_json')
    .map((chunk) => chunk.data)
    .join(''),
);

const transcript = computed(() => acpTranscript(chunks.value));

/**
 * The archive handle, if this node has published one.
 *
 * `null` is the ordinary case for a node that has not completed, and the button
 * says so rather than opening an empty viewer over nothing.
 *
 * It comes from the **node bundle** (`GET /api/runs/:id/nodes/:nodeId`), whose
 * `result.artifacts` is where a completed node records what it produced, rather
 * than from the plan projection — a second request, deliberately, because the
 * projections are shared application state and this panel's whole contract is
 * that its bytes are its own (AC8). The daemon publishes no *named* `stdout.log`
 * handle: `GET /api/artifacts/:sha` is addressed by digest, so the handle is
 * whichever artifact the node recorded.
 */
const archiveHandle = ref<string | null>(null);

const archive = shallowRef<LogArchive | null>(null);

function openFullLog(): void {
  const handle = archiveHandle.value;
  if (handle === null) return;
  const sha = handle.replace(/^artifact:\/\//, '');
  archive.value = artifactArchive({
    url: `/api/artifacts/${sha}`,
    // The size comes from the artifact's own `HEAD`; until it has been asked
    // for, one page is the honest bound and the viewer grows from there.
    bytes: Number.MAX_SAFE_INTEGER,
    fetch: globalThis.fetch.bind(globalThis),
    token: readToken,
  });
  showingArchive.value = true;
}

/** The session the store adopted, so unmount can hand it back. */
let adopted: TerminalSession | null = null;

function onTerminalOpened(session: TerminalSession): void {
  adopted = run.adoptTerminal(`${props.runId}/${props.nodeId}`, session);
}

function onTerminalClosed(): void {
  if (adopted === null) return;
  adopted = null;
  run.disposeTerminal(`${props.runId}/${props.nodeId}`);
}

/**
 * KAR-19.4 AC4 — how often a live node is asked for what has arrived since the
 * cursor, while it is producing.
 *
 * A poll rather than a subscription, deliberately: `io_chunk` is the data plane
 * and is *not* on the control-plane SSE stream (KAR-03.4), because a chatty
 * agent must not be able to drown the log every replay re-reads. Four times a
 * second is below the threshold at which a person reads a terminal as
 * "streaming", and each one is a single indexed seek.
 */
const IO_FOLLOW_MS = 250;

/**
 * …and how often once it has gone quiet.
 *
 * A panel is often left open on a node that finished yesterday, and 4 Hz
 * forever for output that will never change is a cost with no reader. The
 * panel does not ask the run store whether the node has ended — this route is
 * linkable and may be opened without the store ever being hydrated for that
 * run, and a follow that stopped on "the store says nothing" would stop on a
 * *live* node. Quietness is the honest signal it has for itself.
 */
const IO_IDLE_MS = 2_000;

/** Empty polls in a row before the slower cadence takes over. */
const IO_IDLE_AFTER = 8;

/** The highest `seq` this panel has applied — the cursor a reconnect resumes
 * from. `seq > fromSeq`, never `+ 1`: pruning leaves permanent gaps. */
const cursor = ref(0);
let follow: ReturnType<typeof setTimeout> | null = null;
let quiet = 0;

/**
 * One page of whatever has arrived since the cursor.
 *
 * A failed request is a **skipped poll**, not an error state: a dropped
 * connection is the case the cursor exists for, and a panel that tore its own
 * output down on one bad fetch would lose the transcript the operator is
 * reading precisely because something went wrong. The cursor is unchanged, so
 * the next poll asks for the same window and the backfill closes the hole with
 * no gap and no duplicate (`mergeIoChunks`).
 *
 * A failure is deliberately **not** counted as quiet, either. A dropped
 * connection is the moment the panel most needs to keep asking, and easing off
 * because the socket is broken is how a reconnect takes two seconds longer than
 * it has to.
 */
async function pullSince(): Promise<void> {
  try {
    const page = await readIoSince(client, props.runId, props.nodeId, cursor.value);
    if (page.chunks.length === 0) {
      quiet += 1;
      return;
    }
    quiet = 0;
    chunks.value = mergeIoChunks(chunks.value, page.chunks);
    cursor.value = chunks.value.at(-1)?.seq ?? cursor.value;
  } catch {
    // See above: the connection, not the output, is what failed.
  }
}

/** The follow loop: one pull, then the next one scheduled at the cadence the
 * last few pulls earned. */
function scheduleFollow(): void {
  follow = setTimeout(
    () => {
      void pullSince().finally(() => {
        if (follow !== null) scheduleFollow();
      });
    },
    quiet >= IO_IDLE_AFTER ? IO_IDLE_MS : IO_FOLLOW_MS,
  );
}

onMounted(async () => {
  try {
    // AC6. The tail, once, on open — never the whole log, and never a page
    // walk from zero to get to the end of one.
    const page = await readIoTail(client, props.runId, props.nodeId);
    chunks.value = page.chunks;
    cursor.value = page.chunks.at(-1)?.seq ?? 0;
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    loaded.value = true;
  }

  // KAR-19.4 AC4 — and then it keeps up. Before this, the panel painted
  // whatever the node had said at the instant it was opened and never changed
  // again, which on a node that runs for eleven minutes is indistinguishable
  // from a node that produced nothing.
  scheduleFollow();

  // Second, and after the output, because the output is what the panel was
  // opened for: this only decides whether one button is enabled.
  try {
    const response = await client.runs[':id'].nodes[':nodeId'].$get({
      param: { id: props.runId, nodeId: props.nodeId },
    });
    if (!response.ok) return;
    const bundle = (await response.json()) as {
      result?: { artifacts?: readonly unknown[] } | null;
    };
    const handle = bundle.result?.artifacts?.[0];
    archiveHandle.value = typeof handle === 'string' ? handle : null;
  } catch {
    // A node the daemon cannot describe still has output worth reading. The
    // button stays disabled and says why.
  }
});

onBeforeUnmount(() => {
  if (follow !== null) clearTimeout(follow);
  follow = null;
  onTerminalClosed();
  // AC8's other half: the bytes go when the panel goes.
  chunks.value = [];
  archive.value = null;
});
</script>

<template>
  <section class="output" data-node-output :data-renderer="renderer">
    <header class="output__head">
      <h2 class="output__title">Output — {{ props.nodeId }}</h2>
      <label class="output__setting">
        <input
          type="checkbox"
          data-screen-reader-setting
          :checked="ui.screenReaderMode"
          @change="ui.setScreenReaderMode(($event.target as HTMLInputElement).checked)"
        >
        Screen-reader mode
      </label>
      <button
        type="button"
        class="output__archive"
        data-open-full-log
        :disabled="archiveHandle === null"
        :title="
          archiveHandle === null
            ? 'This node has published no output archive yet — the full log becomes available when it completes.'
            : 'Open the complete output archive'
        "
        @click="openFullLog"
      >
        Open full log
      </button>
    </header>

    <p v-if="failure !== null" class="output__note" data-output-error>{{ failure }}</p>

    <p v-else-if="loaded && renderer === 'none'" class="output__note" data-output-empty>
      {{ NO_OUTPUT_AT_ALL }}
    </p>

    <template v-else-if="loaded">
      <p
        v-if="renderer === 'structured' && transcript.endedWithoutResult"
        class="output__note"
        data-output-truncated
      >
        {{ ENDED_WITHOUT_RESULT }}
      </p>

      <AgentMessageList
        v-if="renderer === 'structured'"
        class="output__body"
        :messages="transcript.messages"
        :selected-seq="selectedSeq"
        @select="(seq) => (selectedSeq = seq)"
      />
      <NodeTerminal
        v-else
        class="output__body"
        :node-id="`${props.runId}/${props.nodeId}`"
        :text="terminalText"
        :screen-reader-mode="ui.screenReaderMode"
        @opened="onTerminalOpened"
        @closed="onTerminalClosed"
      />
    </template>

    <FullLogViewer
      v-if="showingArchive && archive !== null"
      class="output__archive-view"
      :archive="archive"
    />
  </section>
</template>

<style scoped>
.output {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 0.5rem;
  block-size: 100%;
  min-block-size: 20rem;
}

.output__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.output__title {
  font-size: 0.95rem;
  font-weight: 600;
}

.output__setting {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.output__archive {
  margin-inline-start: auto;
}

.output__note {
  padding: 0.5rem 0.75rem;
  color: var(--ink-muted);
}

.output__body,
.output__archive-view {
  min-block-size: 16rem;
}
</style>
