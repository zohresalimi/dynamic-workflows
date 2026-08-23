<script setup lang="ts">
/**
 * The run's metadata, as labelled pairs — system law 5.
 *
 * `./RunProviderBanner.vue` renders the same facts as `announceProviderChoice`
 * composes them: one mono sentence, *"provider mock — /tmp/bin/x — exec shim
 * route"*. That is the right shape in a terminal and in an HTTP body, and it
 * is the wrong shape in a header, where an operator is not reading a sentence
 * — they are looking for one field. A sentence makes every field cost a scan
 * of the whole line; a pair makes it cost a glance.
 *
 * So this reads the *facts* off `run.provider.chosen` (the projection, which
 * is where they live) and lays them out as `provider` / `bin` / `route`, plus
 * `started` from the run's own list row. It composes no sentence of its own —
 * that would be the fourth wording `test/one-provider-route-reducer.test.ts`
 * exists to prevent — and it spells no route *label*: `chosen.route` is the
 * machine's own word for the route and is printed as such, which is why this
 * file needs neither `announceProviderChoice` nor its vocabulary. The banner
 * still renders the sentence wherever the sentence is the right shape (the
 * topbar, on every run view that has no header of its own).
 *
 * **The limitation is not a pair.** `chosen.limitation` is prose — what this
 * machine will not be able to do — and prose is never a chip and never a
 * value column (law 5). It keeps its own line, in `--state-blocked`, exactly
 * as the banner already renders it.
 *
 * Renders nothing at all when nothing has been recorded: a daemon booted
 * without `providerRoots` admitted the run because it had no basis on which to
 * refuse, and it has none on which to announce either.
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/useRunStore.ts';

const props = defineProps<{
  /**
   * When the run was created, ISO-8601, from the project's own run list, or
   * `null` while that answer has not landed. Required-and-nullable rather
   * than optional: `null` is a fact ("we do not know yet"), and an absent
   * prop is a caller that forgot.
   */
  readonly startedAt: string | null;
}>();

const run = useRunStore();

/** The projection's own counter, so this recomputes on a provider event only. */
const version = computed<number>(() => run.version('provider'));

const chosen = computed(() => {
  void version.value;
  return run.provider.chosen;
});

interface Pair {
  readonly label: string;
  readonly value: string;
}

/** `2026-08-15 10:11` in the tab's own zone, or nothing when the date is not
 * one — the same refusal `ProjectWorkflowsView`'s own `when()` makes. */
function when(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

const pairs = computed<readonly Pair[]>(() => {
  const out: Pair[] = [];
  const facts = chosen.value;
  if (facts !== null) {
    out.push({ label: 'provider', value: facts.provider });
    out.push({ label: 'bin', value: facts.binaryPath });
    out.push({ label: 'route', value: facts.route });
  }
  const started = props.startedAt === null ? null : when(props.startedAt);
  if (started !== null) out.push({ label: 'started', value: started });
  return out;
});
</script>

<template>
  <p v-if="pairs.length > 0" class="run-meta" data-run-provider>
    <span v-for="pair in pairs" :key="pair.label" class="run-meta__pair">
      <span class="run-meta__label">{{ pair.label }}</span>
      <span class="run-meta__value">{{ pair.value }}</span>
    </span>
    <!--
      AC7 — what this machine will not be able to do, beside the choice rather
      than three minutes later at the first agent node.
    -->
    <span v-if="chosen?.limitation" class="run-meta__limitation" data-run-provider-limitation
      >{{ chosen.limitation }}</span
    >
  </p>
</template>

<style scoped>
.run-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 1.25rem;
  row-gap: 4px; /* geometry — the wrapped row's own gap */
  margin: 0;
  min-width: 0;
}

.run-meta__pair {
  display: inline-flex;
  align-items: baseline;
  gap: 6px; /* geometry — label-to-value gutter */
  min-width: 0;
}

/* Law 2 — a label is a word a human wrote, so it is sans and sentence case.
   The uppercase mono micro-label this replaced said "look at me" about the
   quietest thing on the header. */
.run-meta__label {
  font-size: var(--text-xs);
  color: var(--ink-faint);
  white-space: nowrap;
}

/* Law 2 — every value here is machine-owned: a provider id, an absolute path,
   a route name, a timestamp. Tabular figures so two runs' times line up. */
.run-meta__value {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Prose, and a warning: it takes the whole row rather than sitting in a value
   column, because it is a sentence (law 5). */
.run-meta__limitation {
  flex-basis: 100%;
  font-size: var(--text-xs);
  color: var(--state-blocked);
}
</style>
