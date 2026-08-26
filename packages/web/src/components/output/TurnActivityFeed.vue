<script setup lang="ts">
/**
 * KAR-28.1 — the course of actions and decisions a pre-execution turn is taking.
 *
 * Verifies: EPIC-28-S01, EPIC-28-S02, EPIC-28-S03, EPIC-28-S04, EPIC-28-S05,
 * EPIC-28-S06 · AC1–AC6
 *
 * ## What this replaces
 *
 * Observed 2026-08-25: a framing turn ran for nearly five minutes against
 * Linear and the repository, and the whole of what a person could read was
 * `mcp__claude_ai_Linear__get_issue Bash Read` — three names, no arguments, no
 * results, no prose, over a window of the last 64 chunks, so the first four
 * minutes had already scrolled out. KAR-27.3 AC3 asked for *"at minimum, tool
 * invocations as they happen"* and the minimum shipped. This is the rest of the
 * sentence: one row per event, oldest first, for the whole turn.
 *
 * ## Why this polls rather than sharing `./TurnActivityStrip.vue`'s window
 *
 * The two want opposite windows. The strip is a header line whose question is
 * *"is it alive now"*, so it holds a 64-chunk tail and that bound is a memory
 * bound rather than a display one. The feed's question is *"what has it done"*,
 * which is the whole turn. Sharing one window would mean either the header
 * carrying megabytes or the feed carrying a tail — and the tail is exactly the
 * defect. Both reads are a single indexed seek against the io store, which is
 * the data plane and not the ledger (KAR-17.5 AC8); the bytes live in this
 * component's refs and go when it unmounts, as they do there.
 *
 * ## Nothing is invented
 *
 * Every name, argument, result and sentence below is a string copied out of a
 * vendor frame by `../../lib/turn-activity.ts`. A frame in a dialect this build
 * cannot read is skipped there, so it renders as *nothing* here — never as an
 * error, because a newer dialect must make the feed quieter and must not make a
 * working turn look broken (AC5).
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { readIoSince, readIoTail } from '../../api/io-tail.ts';
import { useApiClient } from '../../api/provide.ts';
import { type IoChunkLine, mergeIoChunks } from '../../lib/node-output.ts';
import { NO_ACTIVITY, turnActivity } from '../../lib/turn-activity.ts';

const props = defineProps<{
  readonly runId: string;
  /** For the transcript link — the route this feed points at carries both ids. */
  readonly projectId: string;
  /** `framing`, `recon` or `planner` — the node its io is recorded under. */
  readonly node: string;
}>();

const client = useApiClient();

/** How often the feed asks for what has arrived since its cursor. */
const POLL_MS = 1_500;

/**
 * AC6 — the stated bound.
 *
 * The window has to have one: a turn is unbounded and a browser tab is not.
 * 4 000 chunks is several megabytes of a vendor's stdout and comfortably more
 * than the longest framing turn observed, and when a turn does exceed it the
 * surface *says so* and points at the archive rather than silently starting
 * mid-turn. That sentence is the whole difference between this bound and the
 * 64-chunk tail it replaces.
 */
const HELD_CHUNKS = 4_000;

/** How many chunks one request asks for. The endpoint's own cap is 2 000. */
const PAGE_CHUNKS = 2_000;

const chunks = shallowRef<readonly IoChunkLine[]>([]);

/**
 * Whether anything of this turn is *not* on screen.
 *
 * Two ways it becomes true, and both are facts rather than estimates: the io
 * endpoint answered the opening tail with `X-DeFlow-Io-More: true` (there was
 * output behind the window we asked for), or the window above overflowed and
 * this component dropped the oldest itself.
 */
const windowed = ref(false);

let poll: ReturnType<typeof setTimeout> | null = null;
let live = true;

const activity = computed(() =>
  chunks.value.length === 0 ? NO_ACTIVITY : turnActivity(chunks.value),
);

const events = computed(() => activity.value.events);

/**
 * One page of the turn's output.
 *
 * A failed request is a **skipped poll**, never an error state, for the reason
 * the strip gives: this feed is on screen precisely because something is in
 * flight, and tearing it down on one bad fetch would report the turn as
 * concluded because a socket blinked.
 *
 * The first read is the tail and every later one follows the cursor — so a feed
 * mounted onto a turn already ten minutes old is correct on its first paint,
 * and then never re-reads a chunk it already holds.
 */
async function pull(): Promise<void> {
  try {
    const cursor = activity.value.cursor;
    const page =
      cursor === 0
        ? await readIoTail(client, props.runId, props.node, PAGE_CHUNKS)
        : await readIoSince(client, props.runId, props.node, cursor, PAGE_CHUNKS);

    if (cursor === 0 && page.hasMore) windowed.value = true;

    const merged = mergeIoChunks(chunks.value, page.chunks);
    if (merged.length > HELD_CHUNKS) windowed.value = true;
    chunks.value = merged.slice(-HELD_CHUNKS);
  } catch {
    // The connection, not the turn, is what failed.
  }
}

function schedule(): void {
  poll = setTimeout(() => {
    void pull().finally(() => {
      if (live) schedule();
    });
  }, POLL_MS);
}

/**
 * The scroller, and whether the reader is at the bottom of it.
 *
 * A live feed that yanks the viewport back down while somebody is reading the
 * top of the turn is worse than one that does not follow at all, so following
 * is conditional on them already being at the bottom — the ordinary terminal
 * bargain, and the same one `./NodeTerminal.vue` strikes.
 */
const scroller = ref<HTMLElement | null>(null);
const following = ref(true);

/** Within a row's height of the bottom counts as "at the bottom". */
const STICK_SLACK_PX = 32;

function onScroll(): void {
  const element = scroller.value;
  if (element === null) return;
  following.value =
    element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_SLACK_PX;
}

watch(
  () => events.value.length,
  async () => {
    if (!following.value) return;
    // After the rows this tick added have been laid out, not before them.
    await Promise.resolve();
    const element = scroller.value;
    if (element !== null) element.scrollTop = element.scrollHeight;
  },
);

onMounted(() => {
  void pull();
  schedule();
});

onBeforeUnmount(() => {
  live = false;
  if (poll !== null) clearTimeout(poll);
  poll = null;
  // The bytes go when the feed goes (KAR-17.5 AC8).
  chunks.value = [];
});
</script>

<template>
  <section class="turn-feed" data-turn-feed :data-turn-feed-node="node" aria-label="Turn activity">
    <!--
      AC6 — a windowed feed says so, in place, and points at the archive. The
      alternative is a feed that starts mid-turn and looks complete, which is
      the one outcome this story is written against.
    -->
    <p v-if="windowed" class="turn-feed__windowed" data-turn-feed-windowed>
      Showing the most recent {{ HELD_CHUNKS.toLocaleString() }} chunks of this turn — earlier
      output is behind the window.
      <RouterLink
        class="turn-feed__transcript"
        data-turn-feed-transcript
        :to="{ name: 'run-node-output', params: { projectId, runId, nodeId: node } }"
        >Full transcript</RouterLink
      >
    </p>

    <ol
      v-if="events.length > 0"
      ref="scroller"
      class="turn-feed__rows"
      data-turn-feed-rows
      @scroll="onScroll"
    >
      <li
        v-for="event in events"
        :key="event.key"
        class="turn-feed__row"
        :data-turn-feed-row="event.kind"
      >
        <template v-if="event.kind === 'tool'">
          <span class="turn-feed__tool" data-turn-feed-tool>{{ event.name }}</span>
          <span v-if="event.target !== null" class="turn-feed__target" data-turn-feed-target
            >{{ event.target }}</span
          >
          <span
            v-if="event.result !== null"
            class="turn-feed__result"
            :data-turn-feed-result="event.result.ok ? 'ok' : 'failed'"
          >
            <span class="turn-feed__verdict">{{ event.result.ok ? 'ok' : 'failed' }}</span>
            <span v-if="event.result.summary !== ''" class="turn-feed__summary"
              >{{ event.result.summary }}</span
            >
          </span>
        </template>
        <span v-else class="turn-feed__text" data-turn-feed-text>{{ event.text }}</span>
      </li>
    </ol>

    <p v-else class="turn-feed__waiting" data-turn-feed-waiting>
      Waiting for this turn's first output…
    </p>
  </section>
</template>

<style scoped>
/*
 * Geometry is stated literally, as every other component in this package states
 * it: the design system is three colour families plus the `--text-*`/
 * `--radius-*` ramps (`docs/design-system.md` § The tokens) and has no spacing
 * scale to name. `test/web-css-tokens.test.ts` is what stops an invented one
 * resolving to `normal` in silence (KAR-27.4).
 */
.turn-feed {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.turn-feed__windowed {
  flex: none;
  margin: 0;
  padding: 6px 12px; /* geometry — the panel's own inset */
  border-bottom: 1px solid var(--edge);
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.turn-feed__transcript {
  color: var(--accent);
  text-decoration: underline;
}

/* The scroller. `min-height: 0` because a flex child's default floor is its
   content, and without it the list grows the panel instead of scrolling. */
.turn-feed__rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 6px 0; /* geometry — a little air at both ends of the run */
  list-style: none;
}

.turn-feed__row {
  display: flex;
  align-items: baseline;
  gap: 8px; /* geometry — name-to-argument gutter */
  min-width: 0;
  padding: 3px 12px; /* geometry — dense row, panel inset */
  font-size: var(--text-xs);
  line-height: 1.5;
}

.turn-feed__row[data-turn-feed-row="text"] {
  color: var(--ink-muted);
}

.turn-feed__tool {
  flex: none;
  color: var(--ink);
  font-family: var(--font-mono);
  font-weight: 600;
}

/*
 * AC2 — the argument is the frame's own bytes, so the row truncates it visually
 * rather than the reader re-wording it. `turn-activity.ts` has already cut it to
 * `ARGUMENT_LIMIT`; this is only what happens when the panel is narrower still.
 */
.turn-feed__target {
  flex: 1 1 auto;
  overflow: hidden;
  min-width: 0;
  color: var(--ink-muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turn-feed__result {
  display: flex;
  flex: 0 1 auto;
  align-items: baseline;
  gap: 6px; /* geometry — verdict-to-summary gutter */
  overflow: hidden;
  min-width: 0;
  margin-left: auto;
}

.turn-feed__verdict {
  flex: none;
  font-weight: 600;
}

.turn-feed__result[data-turn-feed-result="ok"] .turn-feed__verdict {
  color: var(--state-passed);
}

.turn-feed__result[data-turn-feed-result="failed"] .turn-feed__verdict {
  color: var(--state-failed);
}

.turn-feed__summary {
  overflow: hidden;
  min-width: 0;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Prose wraps. It is the one thing on the feed that is meant to be read as
   sentences rather than scanned as a column. */
.turn-feed__text {
  min-width: 0;
  white-space: pre-wrap;
}

.turn-feed__waiting {
  margin: 0;
  padding: 12px; /* geometry — the panel's own inset */
  color: var(--ink-faint);
  font-size: var(--text-xs);
}
</style>
