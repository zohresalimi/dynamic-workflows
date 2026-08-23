<script setup lang="ts">
/**
 * The run's open gate, as the one thing on the page you are meant to do.
 *
 * Two columns and one card: `./SpecEvidence.vue` on the left — what is being
 * asked, in the gate's own bytes — and `./GateOptions.vue` on the right, the
 * buttons that answer it. Both already existed; this file is the composition
 * and the chrome, and it adds no behaviour of its own. In particular it holds
 * **no** opinion about whether the gate is still open: it renders while its
 * caller passes a gate, and the caller's gate is `useRunStore().openGate`, the
 * tab's fold of `human.requested`/`human.responded` (`RunGateBanner.vue`'s
 * responsibility 4, unchanged and inherited).
 *
 * ## Why this is the page's one raised card
 *
 * System law 1 says a page gets one `--surface` + `--edge-strong` + shadow
 * object, and this is the page's. A run that has stopped to ask a human a
 * question has exactly one thing an operator should do, and the previous
 * layout said so nowhere: the gate was a hairline-bordered band above the
 * fold, the same weight as the header card under it. The dominance is spent
 * here rather than distributed: `--shadow-modal`-weight elevation, and a 3px
 * `--state-awaiting-human` bar along the top — a state-coloured *accent*, not
 * a full outline, so the card reads as "this one is waiting on you" without a
 * second box being drawn around it.
 *
 * ## Where the sticky column comes from
 *
 * Above 1100px the decision column is `position: sticky`, because the evidence
 * beside it is a document an operator scrolls: a spec whose approve button
 * scrolled away with the first section is a spec that gets approved from the
 * top of the page or not at all. Below that width the card stacks — goal,
 * pinned decisions, decision — and the stickiness goes with the two columns
 * that justified it.
 *
 * ## The one thing this card cannot say
 *
 * The blueprint asks the header for "since 11:52:02Z". The tab does not hold
 * that fact: `EscalationVM` (../../ledger/projections/gates.ts) carries the
 * ledger `seq` the gate opened at and no timestamp, and the frame it is folded
 * from is not kept. So the header shows the sequence — which is true, is
 * machine-owned, and is the thing an operator would quote in a bug report —
 * rather than a wall-clock time this surface would have had to invent. Adding
 * `ts` to that projection is a projection change with snapshots behind it, and
 * it is not a redesign.
 */
import { computed } from 'vue';
import StateChip from '../StateChip.vue';
import GateOptions from './GateOptions.vue';
import SpecEvidence from './SpecEvidence.vue';

const props = defineProps<{
  readonly runId: string;
  readonly gate: {
    readonly node: string;
    /** What the gate asked, verbatim from `human.requested` (AC3). */
    readonly prompt?: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
    /** The ledger sequence the gate opened at, where the caller has it. */
    readonly requestedSeq?: number;
  };
}>();

/**
 * The one sentence under the node name: what kind of stop this is and what it
 * is holding up. Prose, in `--ink-muted`, and deliberately not a chip — a
 * sentence squeezed into a pill is a sentence nobody finishes reading (system
 * law 5).
 */
const subtitle = computed(() =>
  props.gate.prompt === undefined || props.gate.prompt === ''
    ? 'human gate'
    : 'human gate · blocks planning',
);

const openedAt = computed(() =>
  typeof props.gate.requestedSeq === 'number' ? `seq ${props.gate.requestedSeq}` : null,
);
</script>

<template>
  <section id="gate-decision" class="gate-card" data-gate-decision-card>
    <header class="gate-card__head">
      <!--
        System law 4 — the *one* status token on this surface. The topbar says
        how many things are waiting with a count, the run header says the run's
        own status with a pill, and this says what this gate is. Three
        surfaces, three sentences, no repetition.
      -->
      <StateChip state="awaiting-human" />
      <span v-if="openedAt" class="gate-card__since">{{ openedAt }}</span>
      <span class="gate-card__node" data-run-gate-node>{{ gate.node }}</span>
      <span class="gate-card__subtitle">{{ subtitle }}</span>
    </header>

    <div class="gate-card__body">
      <div class="gate-card__evidence">
        <SpecEvidence :prompt="gate.prompt ?? ''" />
      </div>

      <div class="gate-card__decision">
        <GateOptions :run-id="runId" :gate="gate" />
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The page's one raised object (system law 1). The top bar is the state
 * colour's whole appearance here — an outline in it would make the card a
 * status badge the size of the viewport.
 */
.gate-card {
  background: var(--surface);
  border: 1px solid var(--edge-strong);
  border-top: 3px solid var(--state-awaiting-human); /* geometry — the dominance bar */
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
  min-width: 0;
}

.gate-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px; /* geometry — the header row's gutter */
  padding: 12px 16px; /* geometry — the header row's padding */
  border-bottom: 1px solid var(--edge);
}

/* Machine-owned strings: the ledger position and the node's id (law 2). */
.gate-card__since {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}

.gate-card__node {
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--ink);
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Prose, not a chip (law 5). */
.gate-card__subtitle {
  font-size: var(--text-sm);
  color: var(--ink-muted);
}

.gate-card__body {
  display: grid;
  gap: 20px; /* geometry — the column gutter */
  padding: 16px; /* geometry — the card body's padding */
  min-width: 0;
}

.gate-card__evidence,
.gate-card__decision {
  min-width: 0;
}

@media (min-width: 1100px) {
  .gate-card__body {
    grid-template-columns: minmax(0, 1fr) clamp(300px, 34%, 420px);
  }

  /* See the header comment: the answer stays on screen while the evidence
     beside it is read. */
  .gate-card__decision {
    position: sticky;
    top: 12px; /* geometry — clears the card's own top padding */
    align-self: start;
  }
}

@media (max-width: 819px) {
  .gate-card__head {
    padding: 10px 12px; /* geometry — the narrow card's own padding */
  }

  .gate-card__body {
    padding: 12px; /* geometry — the narrow card's own padding */
    gap: 14px; /* geometry — the narrow stack's gap */
  }
}
</style>
