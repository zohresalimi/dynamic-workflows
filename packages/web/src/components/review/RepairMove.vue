<script setup lang="ts">
/**
 * KAR-17.6 AC6 — the surgical repair loop, animated at token level (F7.5).
 *
 * Verifies: EPIC-17-S27 · AC6
 *
 * > *"the single highest-ratio visual win in the app: it makes 'one issue, one
 * > fix, capped at three attempts' legible at a glance instead of requiring a
 * > diff read"* (docs/12-frontend-architecture.md §7).
 *
 * `@shikijs/magic-move` diffs the **tokens** of the before and after states and
 * moves the ones that survived, so the eye follows the two or three that
 * actually changed instead of re-reading the function. The tokens come from the
 * application's one Shiki instance (`../../lib/highlighter.ts`) — this
 * component never constructs a highlighter, which is what
 * `test/one-shiki-instance.test.ts` enforces.
 *
 * ## Three things it has to get right
 *
 * **It must not re-mount.** `ShikiMagicMoveRenderer` owns the innerHTML of its
 * container and animates from whatever is in it, so a container Vue recreates
 * between steps loses both the animation and the scroll position. The renderer
 * therefore lives under a `v-if` that is only ever about reduced motion, and
 * the step is a prop change rather than a key change.
 *
 * **Reduced motion is a different rendering, not a faster one.** Under
 * `prefers-reduced-motion: reduce` the before and after are shown side by side
 * and nothing moves at all — an animation shortened to zero still re-lays out
 * the block, which is exactly what the preference is about.
 *
 * **The cap is part of the story.** A loop that spent its three attempts and
 * escalated is labelled as an escalation, not as a failure of the fix agent:
 * *"conflating them sends work into the repair loop that no amount of repair
 * will fix"*.
 */
import { type KeyedTokensInfo, syncTokenKeys, toKeyedTokens } from '@shikijs/magic-move/core';
import { ShikiMagicMoveRenderer } from '@shikijs/magic-move/vue';
import '@shikijs/magic-move/dist/style.css';
import { useMediaQuery } from '@vueuse/core';
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { ensureGrammar, HIGHLIGHTER_THEMES, sharedHighlighter } from '../../lib/highlighter.ts';
import type { RepairLoopVM } from '../../lib/review-index.ts';
import ReviewFinding from './ReviewFinding.vue';

const props = defineProps<{
  readonly loop: RepairLoopVM;
  /** The file's state before the fix, as the patch's `-` and context lines. */
  readonly before: string;
  /** And after, as its `+` and context lines. */
  readonly after: string;
  readonly lang: string | null;
  readonly dark?: boolean;
}>();

/**
 * The OS preference, read live.
 *
 * `useMediaQuery` rather than a one-shot `matchMedia().matches`: the preference
 * can change while the tab is open, and a transition that was decided at mount
 * would keep animating for the rest of the session.
 */
const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');

/** 0 = the failing state, 1 = the repaired one. */
const step = ref(0);

/** How many times the operator has asked to see the fix again. */
const replays = ref(0);

const steps = shallowRef<readonly KeyedTokensInfo[] | null>(null);

watch(
  [() => props.before, () => props.after, () => props.lang, () => props.dark],
  async () => {
    const grammar = await ensureGrammar(props.lang);
    const highlighter = await sharedHighlighter();
    const theme = props.dark === true ? HIGHLIGHTER_THEMES.dark : HIGHLIGHTER_THEMES.light;

    const tokensOf = (code: string): KeyedTokensInfo => {
      // A language this build does not carry still animates — one token per
      // line, which moves the lines rather than the identifiers. Better than
      // refusing to render the fix at all.
      const result =
        grammar === null
          ? { tokens: code.split('\n').map((line) => [{ content: line, offset: 0 }]) }
          : highlighter.codeToTokens(code, { lang: grammar, theme });
      return toKeyedTokens(code, result.tokens as never);
    };

    const first = tokensOf(props.before);
    const second = tokensOf(props.after);
    const synced = syncTokenKeys(first, second);
    steps.value = [synced.from, synced.to];
    step.value = 1;
  },
  { immediate: true },
);

const current = computed<KeyedTokensInfo | null>(() => steps.value?.[step.value] ?? null);
const previous = computed<KeyedTokensInfo | null>(() =>
  step.value === 0 ? null : (steps.value?.[step.value - 1] ?? null),
);

/**
 * Replays the move from the failing state.
 *
 * Two assignments in two ticks, because one is not a transition: the renderer
 * watches `tokens`, and setting 0 and 1 inside the same tick is a single
 * change from `after` to `after`. `nextTick` is enough — the renderer's own
 * watcher runs on the same queue — and no element is unmounted in between,
 * which is what keeps the scroll position.
 */
async function replay(): Promise<void> {
  step.value = 0;
  await nextTick();
  if (!reduced.value) step.value = 1;
  replays.value += 1;
}
</script>

<template>
  <section
    class="repair"
    data-repair-loop
    :data-repair-node="loop.failedNode"
    :data-repair-fix-node="loop.fixNode"
    :data-repair-gate="loop.gate"
    :data-repair-step="step"
    :data-repair-replays="replays"
    :data-repair-escalated="String(loop.escalated)"
    :data-animated="String(!reduced)"
    aria-label="Surgical repair loop"
  >
    <header class="repair__head">
      <h3 class="repair__title">
        One issue, one fix — <code>{{ loop.gate }}</code> on
        <code>{{ loop.failedNode }}</code>
      </h3>
      <span
        class="repair__attempts"
        :data-repair-attempts="loop.attempts"
        :data-repair-cap="loop.cap"
      >
        attempt {{ loop.attempts }} of {{ loop.cap }}
      </span>
      <span v-if="loop.escalated" class="repair__escalated" data-repair-escalated-label>
        cap spent — escalated to a human. Not a failure of the fix agent.
      </span>
      <button type="button" data-repair-replay @click="void replay()">Replay the fix</button>
    </header>

    <div class="repair__body">
      <div class="repair__move">
        <div v-if="reduced" class="repair__sides" data-side-by-side>
          <pre class="repair__side" data-side="before"><code>{{ before }}</code></pre>
          <pre class="repair__side" data-side="after"><code>{{ after }}</code></pre>
        </div>

        <div v-else class="repair__animated" data-magic-move>
          <ShikiMagicMoveRenderer
            v-if="current !== null"
            :tokens="current"
            v-bind="previous === null ? {} : { previous }"
            :animate="true"
          />
        </div>
      </div>

      <aside class="repair__pinned">
        <p class="repair__pinned-title">The finding this fix was for</p>
        <ReviewFinding
          v-if="loop.finding !== null"
          :data-repair-finding="loop.finding.id"
          :finding="loop.finding"
          placement="file"
        />
        <p v-else class="repair__pinned-none">
          The failing verdict named no line — see the file-level findings above.
        </p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.repair {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.375rem;
}

.repair__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.75rem;
}

.repair__title {
  margin: 0;
  font-size: 0.875rem;
}

.repair__attempts,
.repair__escalated {
  color: var(--ink-muted);
  font-size: 0.75rem;
}

.repair__escalated {
  color: var(--state-awaiting-human);
}

.repair__body {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
}

.repair__sides {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 1fr 1fr;
}

.repair__side {
  margin: 0;
  overflow-x: auto;
  font-size: 0.75rem;
}

.repair__animated {
  overflow-x: auto;
  font-size: 0.75rem;
}

.repair__pinned-title {
  margin: 0 0 0.25rem;
  color: var(--ink-muted);
  font-size: 0.75rem;
}
</style>
