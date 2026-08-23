<script setup lang="ts">
/**
 * KAR-27.3 AC3 — the strip that shows a pre-execution turn is alive.
 *
 * **What it replaces.** On 2026-08-23 an operator watched a framing turn run
 * for minutes behind a strip that said *"No plan yet"* and a status chip that
 * said *"submitted — waiting to be framed"*. The turn was making Linear
 * queries and reading the repository the whole time. Their words: *"the user is
 * unsure if anything is going on."*
 *
 * **Four facts, and every one of them recorded.** Elapsed and time-since-last-
 * output are arithmetic between an instant the ledger holds (`sinceTs`, the
 * `provider.session_opened`; `lastOutputTs`, an `io_chunk.ts`) and this
 * browser's clock — which is why they are labelled as *ago* rather than
 * presented as durations DeFlow measured. The attempt is the run list's own
 * number. The tool calls are the vendor's own names, verbatim.
 *
 * **The bytes stay here.** `io_chunk` is the data plane: polled on this
 * component's own endpoint, held in this component's own refs, dropped when it
 * unmounts, and never folded into the run store (KAR-17.5 AC8). What *is* in
 * the store is the one boolean that decides whether this component is mounted
 * at all.
 *
 * Verifies: EPIC-27-S18 · AC3
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { readIoTail } from '../../api/io-tail.ts';
import { useApiClient } from '../../api/provide.ts';
import type { IoChunkLine } from '../../lib/node-output.ts';
import { holdChunks, NO_ACTIVITY, turnActivity } from '../../lib/turn-activity.ts';

const props = defineProps<{
  readonly runId: string;
  /** `framing`, `recon` or `planner` — the node its io is recorded under. */
  readonly node: string;
  /** 1-based, for display: "attempt 2 of 3". */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The `provider.session_opened`'s `ts`. A ledger instant. */
  readonly sinceTs: number;
}>();

const client = useApiClient();

/**
 * How often the strip asks for more output.
 *
 * Slower than `NodeOutputPanel`'s 4 Hz on purpose: that panel is a terminal
 * somebody is reading, and this is a one-line reassurance beside a plan panel.
 * Every poll is a single indexed seek, and 1.5 s is well inside the interval at
 * which a person stops believing a screen is live.
 */
const POLL_MS = 1_500;

/**
 * How many chunks the strip holds.
 *
 * Small, and it is a memory bound rather than a display one: the strip shows
 * the last few tool calls, so a window that grew with the turn would be a leak
 * wearing a transcript's clothes. `NodeOutputPanel` is where a whole log is
 * read.
 */
const HELD_CHUNKS = 64;

/** How many tool calls are rendered. The tail, because the question is "now". */
const SHOWN_CALLS = 3;

const chunks = shallowRef<readonly IoChunkLine[]>([]);
let poll: ReturnType<typeof setTimeout> | null = null;

/**
 * This browser's clock, sampled on a tick.
 *
 * A ref rather than a `Date.now()` inside the `computed`, because a `computed`
 * over a clock never invalidates: the elapsed time would be frozen at the
 * instant the strip first rendered, which is precisely the "nothing is
 * happening" impression the strip exists to remove.
 */
const now = ref(Date.now());
let ticking: ReturnType<typeof setInterval> | null = null;

const activity = computed(() =>
  chunks.value.length === 0 ? NO_ACTIVITY : turnActivity(chunks.value),
);

const recentCalls = computed(() => activity.value.toolCalls.slice(-SHOWN_CALLS));

/** `4s`, `2m 10s`, `1h 04m`. Coarse on purpose — a stopwatch invites reading a
 * precision into a figure that is a difference of two clocks. */
function since(instant: number): string {
  const seconds = Math.max(0, Math.round((now.value - instant) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const elapsed = computed(() => since(props.sinceTs));

/**
 * How long since the agent last said anything, or `null` before it has.
 *
 * The honest distinction, and the one that makes the strip worth reading: a
 * turn that has produced nothing for four minutes and a turn that produced a
 * tool call two seconds ago look identical on an elapsed timer alone.
 */
const quietFor = computed(() =>
  activity.value.lastOutputTs === null ? null : since(activity.value.lastOutputTs),
);

/**
 * One page of the turn's output.
 *
 * A failed request is a **skipped poll**, never an error state: this strip is
 * on screen precisely because something is in flight, and tearing it down on
 * one bad fetch would report the run as concluded because a socket blinked.
 *
 * The *tail* rather than a cursor-following page, because the window is small
 * and bounded: what the strip wants is always "the newest few chunks", and
 * asking for that directly means a strip mounted onto a turn already ten
 * minutes old is correct on its first paint instead of after a page walk.
 */
async function pull(): Promise<void> {
  try {
    const page = await readIoTail(client, props.runId, props.node, HELD_CHUNKS);
    chunks.value = holdChunks(chunks.value, page.chunks, HELD_CHUNKS);
  } catch {
    // The connection, not the turn, is what failed.
  }
}

function schedule(): void {
  poll = setTimeout(() => {
    void pull().finally(() => {
      if (poll !== null) schedule();
    });
  }, POLL_MS);
}

onMounted(() => {
  void pull();
  schedule();
  ticking = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  if (poll !== null) clearTimeout(poll);
  poll = null;
  if (ticking !== null) clearInterval(ticking);
  ticking = null;
  // The bytes go when the strip goes.
  chunks.value = [];
});
</script>

<template>
  <div class="turn-strip" data-turn-activity :data-turn-node="node">
    <span class="turn-strip__pulse" aria-hidden="true" />
    <span class="turn-strip__node" data-turn-node-name>{{ node }}</span>
    <span class="turn-strip__meta" data-turn-attempt
      >attempt {{ attempt }} of {{ maxAttempts }}</span
    >
    <span class="turn-strip__meta" data-turn-elapsed>running {{ elapsed }}</span>
    <span v-if="quietFor !== null" class="turn-strip__meta" data-turn-quiet
      >last output {{ quietFor }} ago</span
    >
    <span v-else class="turn-strip__meta" data-turn-quiet>no output yet</span>
    <span v-if="recentCalls.length > 0" class="turn-strip__calls" data-turn-calls>
      <code v-for="call in recentCalls" :key="call.seq" class="turn-strip__call"
        >{{ call.name }}</code
      >
    </span>
  </div>
</template>

<style scoped>
.turn-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--ink-muted);
  font-size: var(--text-sm);
}

/*
 * The one piece of motion on the page, and it is the point: a static strip
 * saying "running" is what a wedged run also shows.
 */
.turn-strip__pulse {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--state-running, currentColor);
  animation: turn-strip-pulse 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .turn-strip__pulse {
    animation: none;
  }
}

@keyframes turn-strip-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.turn-strip__node {
  color: var(--ink);
  font-weight: 600;
}

.turn-strip__meta {
  white-space: nowrap;
}

.turn-strip__calls {
  display: flex;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
}

.turn-strip__call {
  overflow: hidden;
  max-width: 14rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}
</style>
