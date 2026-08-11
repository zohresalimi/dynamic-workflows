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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { readIoTail } from '../../api/io-tail.ts';
import { useApiClient } from '../../api/provide.ts';
import { readToken } from '../../api/token.ts';
import { acpTranscript } from '../../lib/acp-stream.ts';
import { artifactArchive, type LogArchive } from '../../lib/log-archive.ts';
import {
  ENDED_WITHOUT_RESULT,
  type IoChunkLine,
  NO_OUTPUT_AT_ALL,
  outputRendererFor,
} from '../../lib/node-output.ts';
import type { TerminalSession } from '../../lib/terminal-session.ts';
import { useRunStore } from '../../stores/useRunStore.ts';
import { useUiStore } from '../../stores/useUiStore.ts';
import AgentMessageList from './AgentMessageList.vue';
import FullLogViewer from './FullLogViewer.vue';
import NodeTerminal from './NodeTerminal.vue';

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

onMounted(async () => {
  try {
    // AC6. The tail, once, on open — never the whole log, and never a page
    // walk from zero to get to the end of one.
    const page = await readIoTail(client, props.runId, props.nodeId);
    chunks.value = page.chunks;
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    loaded.value = true;
  }

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
