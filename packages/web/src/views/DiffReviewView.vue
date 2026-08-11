<script setup lang="ts">
import type { DiffFileHighlighter } from '@git-diff-view/core';
import { getLang } from '@git-diff-view/core';
/**
 * KAR-17.6 — F10.7's diff and review surface.
 *
 * Verifies: EPIC-17-S24, EPIC-17-S25, EPIC-17-S26, EPIC-17-S27 · AC1–AC10
 *
 * One surface instead of two windows. The patch is on the left of the reader's
 * eye and the verdicts are *on the lines*, because a verdict in a panel beside
 * the code is a summary, and the whole point of F7.7 is that a summary is what
 * the operator already had.
 *
 * ## The two sides of the data, and why they come from different places
 *
 * `packages/web/src/api/queries.ts` states the rule this view obeys:
 *
 * > **If the answer changes because an event was appended, it is a projection.
 * > If it changes because a file on disk changed, it is a query.**
 *
 * The **patch** is the second kind — it is `git diff` over a worktree, and it
 * changes when an agent writes a file — so it comes from
 * `GET /api/runs/:id/diff` through the typed client, once per scope.
 *
 * The **findings** are the first kind: a finding exists because a
 * `gate.evaluated` was appended, and the tab is already holding that stream.
 * They therefore come from the `gates` projection rather than from
 * `GET /api/runs/:id/findings`, which is the same data on the other side of the
 * wire. EPIC-17-S26 names the endpoint; the endpoint and the projection are
 * built from the same verdicts, and reading the projection is what makes a
 * verdict arriving mid-review appear without a refetch. The behavioural claim
 * in that scenario — *"a finding produced by a gate on a different node still
 * attaches to the file it names"* — is asserted either way.
 *
 * ## Three scopes, one selection (AC1)
 *
 * `?scope=node|worktree|cumulative` with `?node=` / `?worktree=` beside it, all
 * in the URL, because a diff position is one of the things worth sending
 * somebody. Switching scope keeps the selected file **when that file exists in
 * the new scope** and falls back to the first file when it does not — silently
 * showing a different file under the same name in the sidebar would be worse
 * than either.
 *
 * ## Lazy (AC8)
 *
 * This view is a lazy route and is the only importer of `@git-diff-view/*` and
 * `@shikijs/*` in the application. `packages/web/test/integration/bundle-budget.test.ts`
 * fails the build if any of it reaches the initial chunk.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { type LocationQueryRaw, useRoute, useRouter } from 'vue-router';
import { useApiClient } from '../api/provide.ts';
import { DARK_CLASS } from '../app/theme.ts';
import { useRunFeed } from '../app/useRunFeed.ts';
import DiffFilePanel from '../components/review/DiffFilePanel.vue';
import RepairMove from '../components/review/RepairMove.vue';
import ReviewFinding from '../components/review/ReviewFinding.vue';
import { diffHighlighter, ensureGrammar } from '../lib/highlighter.ts';
import { type PatchFileVM, patchSides, splitPatch } from '../lib/patch.ts';
import { repairLoops, reviewIndex, SEVERITY_STYLE } from '../lib/review-index.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const props = defineProps<{
  /** From `/runs/:runId/diff`. */
  readonly runId?: string;
}>();

const run = useRunStore();
const route = useRoute();
const router = useRouter();
const client = useApiClient();

const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

export type DiffScope = 'node' | 'worktree' | 'cumulative';

const SCOPES: readonly { readonly id: DiffScope; readonly label: string }[] = [
  { id: 'node', label: 'This node' },
  { id: 'worktree', label: 'This worktree' },
  { id: 'cumulative', label: 'The whole run' },
];

const scope = computed<DiffScope>(() => {
  const value = route.query['scope'];
  return value === 'node' || value === 'cumulative' ? value : 'worktree';
});

const node = computed(() => (typeof route.query['node'] === 'string' ? route.query['node'] : null));
const worktree = computed(() =>
  typeof route.query['worktree'] === 'string' ? route.query['worktree'] : null,
);

const patch = ref('');
const loading = ref(false);
const failure = ref<string | null>(null);

/**
 * The query the daemon's `?node=` / `?worktree=` / `?cumulative=1` expects.
 *
 * Mutually exclusive rather than defaulted, exactly as the endpoint is: *"the
 * diff"* means three different things and a caller that got the wrong one would
 * have no way to notice.
 */
interface DiffSelectors {
  readonly node: string | undefined;
  readonly worktree: string | undefined;
  readonly cumulative: string | undefined;
}

const diffQuery = computed<DiffSelectors>(() => {
  // All three keys, two of them `undefined`: that is the shape the route's own
  // `validator('query')` declares, and hono drops an undefined value rather
  // than sending an empty one — so the request carries exactly one selector.
  const empty = { node: undefined, worktree: undefined, cumulative: undefined };
  if (scope.value === 'cumulative') return { ...empty, cumulative: '1' };
  if (scope.value === 'node') return { ...empty, node: node.value ?? undefined };
  return { ...empty, worktree: worktree.value ?? undefined };
});

watch(
  [runId, diffQuery],
  async ([id, query]) => {
    if (id === null) return;
    loading.value = true;
    failure.value = null;
    try {
      const response = await client.runs[':id'].diff.$get({ param: { id }, query });
      if (!response.ok) {
        failure.value = `the daemon refused this diff with ${response.status}`;
        patch.value = '';
        return;
      }
      patch.value = await response.text();
    } catch (error) {
      failure.value = error instanceof Error ? error.message : String(error);
      patch.value = '';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

const files = computed<readonly PatchFileVM[]>(() => splitPatch(patch.value));

const index = computed(() => {
  // The projection's own counter, so this recomputes when a verdict arrives
  // and not when anything else does.
  void run.version('gates');
  return reviewIndex(run.gates);
});

const loops = computed(() => {
  void run.version('gates');
  return repairLoops(run.gates);
});

/**
 * The file on screen.
 *
 * The URL is the source of truth so the position is linkable, and the fallback
 * is applied on read rather than by rewriting the URL: switching scope to one
 * that does not hold the selected file must not destroy the selection the
 * operator would get back by switching scope again.
 */
const selected = computed<PatchFileVM | null>(() => {
  const wanted = typeof route.query['file'] === 'string' ? route.query['file'] : null;
  return files.value.find((file) => file.path === wanted) ?? files.value[0] ?? null;
});

const review = computed(() => index.value.files.find((file) => file.file === selected.value?.path));

/** The repair loop that touched the selected file, if any. */
const loop = computed(() => loops.value.find((one) => one.file === selected.value?.path) ?? null);

const sides = computed(() => (selected.value === null ? null : patchSides(selected.value)));

const lang = computed(() =>
  selected.value === null ? null : getLang(selected.value.newPath ?? selected.value.oldPath ?? ''),
);

const dark = ref(document.documentElement.classList.contains(DARK_CLASS));

const highlighter = shallowRef<DiffFileHighlighter | null>(null);

// AC9 — the application's one Shiki instance, wearing the renderer's face. The
// grammar for the selected file is loaded before it is handed over, because
// `getAST` is called inside the renderer's own synchronous render pass and
// cannot wait for an import.
watch(
  lang,
  async (value) => {
    await ensureGrammar(value);
    highlighter.value = await diffHighlighter();
  },
  { immediate: true },
);

function select(path: string): void {
  void router.replace({ query: { ...(route.query as LocationQueryRaw), file: path } });
}

function switchScope(next: DiffScope): void {
  void router.replace({ query: { ...(route.query as LocationQueryRaw), scope: next } });
}
</script>

<template>
  <section class="review" aria-label="Diff and review">
    <template v-if="runId === null">
      <p class="review__empty">No run open. Open one at <code>/runs/&lt;runId&gt;/diff</code>.</p>
    </template>

    <template v-else>
      <nav class="review__scopes" data-review-scope aria-label="Diff scope">
        <button
          v-for="one of SCOPES"
          :key="one.id"
          type="button"
          :data-scope="one.id"
          :aria-pressed="scope === one.id"
          @click="switchScope(one.id)"
        >
          {{ one.label }}
        </button>
      </nav>

      <p v-if="failure !== null" class="review__empty" data-diff-error>{{ failure }}</p>

      <section
        v-if="index.unlocated.length > 0"
        class="review__file-level"
        data-review-file-level
        aria-label="Findings about the change as a whole"
      >
        <h2 class="review__file-level-title">
          About the change as a whole — {{ index.unlocated.length }} with no line to sit on
        </h2>
        <ReviewFinding
          v-for="finding of index.unlocated"
          :key="finding.id"
          :finding="finding"
          placement="file"
        />
      </section>

      <div class="review__body">
        <nav class="review__files" aria-label="Files in this diff">
          <button
            v-for="file of files"
            :key="file.path"
            type="button"
            class="review__file"
            :data-review-file="file.path"
            :data-tone="index.files.find((one) => one.file === file.path)?.tone ?? 'clean'"
            :aria-current="selected?.path === file.path ? 'true' : 'false'"
            @click="select(file.path)"
          >
            <span class="review__file-path">{{ file.path }}</span>
            <span
              v-if="index.files.find((one) => one.file === file.path)?.worst != null"
              class="review__file-worst"
              aria-hidden="true"
            >
              {{ SEVERITY_STYLE[
                  index.files.find((one) => one.file === file.path)?.worst ?? 'info'
                ].glyph }}
            </span>
          </button>

          <p v-if="files.length === 0" class="review__empty">
            <template v-if="loading">Asking the daemon for this diff…</template>
            <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
            <template v-else>This scope has no changes in it.</template>
          </p>
        </nav>

        <div class="review__main">
          <RepairMove
            v-if="loop !== null && sides !== null"
            :loop="loop"
            :before="sides.before"
            :after="sides.after"
            :lang="lang"
            :dark="dark"
          />

          <DiffFilePanel
            v-if="selected !== null"
            :key="selected.path"
            :file="selected"
            :review="review"
            :highlighter="highlighter ?? undefined"
            :dark="dark"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.review {
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
  block-size: 100%;
  overflow-y: auto;
  align-content: start;
}

.review__scopes {
  display: flex;
  gap: 0.5rem;
}

.review__scopes button[aria-pressed="true"] {
  font-weight: 600;
  text-decoration: underline;
}

.review__body {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr);
  align-items: start;
}

.review__files {
  display: grid;
  gap: 0.125rem;
}

.review__file {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0.4rem;
  border-radius: 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  text-align: start;
}

.review__file[aria-current="true"] {
  background: var(--surface-raised);
  font-weight: 600;
}

.review__file[data-tone="failing"] {
  color: var(--state-failed);
}

.review__file[data-tone="judgement"] {
  color: var(--state-awaiting-human);
}

.review__main {
  display: grid;
  gap: 0.75rem;
  min-inline-size: 0;
}

.review__file-level {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem;
  border: 1px dashed var(--edge);
  border-radius: 0.375rem;
}

.review__file-level-title {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.review__empty {
  color: var(--ink-muted);
  font-size: 0.8125rem;
}
</style>
