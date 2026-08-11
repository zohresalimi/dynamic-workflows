<script setup lang="ts">
/**
 * KAR-17.6 — one gate finding, rendered wherever it belongs (F7.7).
 *
 * Verifies: EPIC-17-S24 (scenario 1), EPIC-17-S25 · AC2, AC3, AC4, AC10
 *
 * The same component in two places, which is the point: mounted in
 * `@git-diff-view`'s per-line `#extend` slot it is an inline verdict at
 * `location.line`, and mounted in the view's file-level band it is a judgement
 * about the change as a whole. Nothing about the finding changes between the
 * two — only where it is put — so a location-less finding cannot be quietly
 * downgraded into a different, smaller thing on its way to the screen.
 *
 * **Severity is three signals.** A glyph, the word itself, and a colour, in
 * that order of reliability (WCAG 1.4.1). `data-severity` carries the value for
 * CSS and for specs; neither is the accessible name.
 *
 * **Every finding says which verdict produced it** (AC10). The `seq` is the
 * `gate.evaluated` event's, so the link is into the ledger at the exact point
 * the judgement was written — not "the typecheck gate", which was answered
 * twice in the fixture this is developed against.
 */
import { computed } from 'vue';
import { type LocationQueryRaw, useRoute } from 'vue-router';
import { API_BASE_PATH } from '../../api/client.ts';
import { type ReviewFindingVM, SEVERITY_STYLE } from '../../lib/review-index.ts';

const props = defineProps<{
  readonly finding: ReviewFindingVM;
  /** Rendered inline at a line, or at file level. Only the styling differs. */
  readonly placement: 'line' | 'file';
}>();

const route = useRoute();

const style = computed(() => SEVERITY_STYLE[props.finding.severity]);

/**
 * `artifact://<sha>` → the daemon's content-addressed read route.
 *
 * A handle is not a URL and is never rendered as one: the scheme is DeFlow's,
 * and the mapping to a path lives here rather than in the ledger so that a
 * recorded run stays readable if the route ever moves.
 */
const evidence = computed(() =>
  props.finding.evidence.map((handle) => ({
    handle,
    href: `${API_BASE_PATH}/artifacts/${handle.replace(/^artifact:\/\//, '')}`,
    short: handle.replace(/^artifact:\/\//, '').slice(0, 12),
  })),
);

/**
 * Where clicking the criterion goes.
 *
 * A query parameter rather than a route, because the acceptance-criteria board
 * is KAR-17.7 and does not exist yet. The deep link is the durable half — the
 * criterion id in the URL — and the board picks it up when it lands, which is
 * the shape EPIC-17-S24's third scenario needs.
 */
const criterionTo = computed(() => ({
  query: { ...(route.query as LocationQueryRaw), criterion: props.finding.criterion },
}));

/** The ledger position the verdict was written at (AC10). */
const seqTo = computed(() => ({
  query: { ...(route.query as LocationQueryRaw), seq: String(props.finding.seq) },
}));
</script>

<template>
  <article
    class="finding"
    :class="`finding--${finding.severity}`"
    :data-review-finding="finding.id"
    :data-severity="finding.severity"
    :data-outcome="finding.outcome"
    :data-node="finding.evaluatedNode"
    :data-gate="finding.gate"
    :data-seq="finding.seq"
    :data-placement="placement"
    :data-surfaced="String(style.surfacedByDefault)"
    :data-line="placement === 'line' ? (finding.location?.line ?? null) : null"
  >
    <header class="finding__head">
      <span class="finding__severity">
        <span data-severity-glyph aria-hidden="true">{{ style.glyph }}</span>
        <span data-severity-label>{{ style.label }}</span>
      </span>
      <span class="finding__gate" data-gate-name>{{ finding.gate }}</span>
      <RouterLink class="finding__seq" :to="seqTo" data-seq-link>
        seq {{ finding.seq }}
      </RouterLink>
    </header>

    <p class="finding__message" data-finding-message>{{ finding.message }}</p>

    <footer class="finding__foot">
      <RouterLink
        v-if="finding.criterion !== null"
        class="finding__criterion"
        :to="criterionTo"
        data-criterion
      >
        {{ finding.criterion }}
      </RouterLink>
      <span v-else class="finding__criterion finding__criterion--none" data-no-criterion>
        no criterion — a diagnostic about the code, not about the contract
      </span>

      <a
        v-for="item of evidence"
        :key="item.handle"
        class="finding__evidence"
        :href="item.href"
        :data-evidence="item.handle"
        rel="noreferrer"
      >
        evidence {{ item.short }}
      </a>
    </footer>
  </article>
</template>

<style scoped>
.finding {
  display: grid;
  gap: 0.25rem;
  padding: 0.4rem 0.6rem;
  border-inline-start: 3px solid var(--finding-accent);
  background: var(--surface-raised);
  font-size: 0.8125rem;
  text-align: start;
  white-space: normal;
}

/* Colour is the third signal, never the only one. */
.finding--blocker {
  --finding-accent: var(--state-failed);
}
.finding--major {
  --finding-accent: var(--state-awaiting-human);
}
.finding--minor {
  --finding-accent: var(--state-blocked);
}
.finding--info {
  --finding-accent: var(--ink-muted);
}

.finding__head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.finding__severity {
  display: inline-flex;
  gap: 0.3rem;
  align-items: baseline;
  font-weight: 600;
  color: var(--finding-accent);
}

.finding__gate,
.finding__seq {
  color: var(--ink-muted);
  font-size: 0.75rem;
}

.finding__message {
  margin: 0;
  font-family: ui-monospace, monospace;
}

.finding__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.finding__criterion--none {
  color: var(--ink-muted);
}
</style>
