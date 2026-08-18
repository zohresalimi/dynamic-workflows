<script setup lang="ts">
/**
 * KAR-24.3 — the gallery: every component, every state, on one route.
 *
 * The load-bearing decision is that this route exists at all and renders
 * every primitive `ui/index.ts` exports, in every variant it can take, on one
 * page: without it, "does the warn chip read against the light surface" or
 * "does UiMeter's `error` tone still land against the token layer after
 * KAR-24.1 moves a value" is a question a person has to hold in their head
 * while paging through six unrelated screens, and the failure it prevents is
 * exactly the one that shipped once already — a component whose props or a
 * token whose value drifted underneath a screen, discovered by an operator
 * rather than by a build (KAR-24.3 AC1, AC2).
 *
 * Two more things follow from that:
 *
 * - The token swatches (AC2) read `getComputedStyle` at runtime rather than
 *   repeating theme.css's own values in markup, because a page that shows a
 *   *second copy* of the palette can drift from the first exactly the way the
 *   nine views the palette was written to keep in sync could — it would be
 *   the bug it exists to catch.
 * - The composites at the foot of the page (AC4) are assembled only from the
 *   fifteen primitives above, with no new component: if a screen KAR-24.5
 *   onward needs shape the fifteen cannot express, that has to fail *here*,
 *   where it costs one page, rather than on the sixth screen that depends on
 *   it.
 *
 * Dev-only (AC5): the router only registers this route under
 * `import.meta.env.DEV`, and the component behind it is a dynamic `import()`
 * inside that same guard, so a production build both never navigates here and
 * never ships the module — see ../router/index.ts for the mechanics, which
 * follow ../app/create-app.ts's own dev-only import exactly.
 */
import { Bell, Boxes, GitBranch, Layers } from 'lucide-vue-next';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useTheme } from '../app/theme.ts';
import {
  type DisplayState,
  UiButton,
  UiCard,
  UiChip,
  UiEmptyState,
  UiField,
  UiIconTile,
  UiMetaRow,
  UiMeter,
  UiModal,
  UiPanel,
  UiProgressSplit,
  UiSectionLabel,
  UiStateChip,
  UiStatTile,
  UiToggle,
} from '../components/ui/index.ts';
import { DISPLAY_STATES } from '../lib/state-palette.ts';

const { isDark, toggleTheme } = useTheme();

// AC1 — the fixed vocabularies each primitive is typed against, named once
// here rather than re-typed at every call site below. `DISPLAY_STATES` is
// deliberately *not* one of these: it is imported straight from
// `state-palette.ts` per AC1, so an eighth run state appears in the gallery
// the moment it appears in the domain, with nothing here to remember to edit.
const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;
const BUTTON_SIZES = ['sm', 'md'] as const;
const CHIP_VARIANTS = ['neutral', 'accent', 'ok', 'warn', 'error', 'info'] as const;
const CARD_VARIANTS = ['raised', 'inset', 'flush'] as const;
const ICON_TILE_SIZES = ['sm', 'md', 'lg'] as const;
const TONES = ['default', 'ok', 'warn', 'error', 'accent'] as const;
const METER_STOPS = [0, 50, 100] as const;

const fieldPlain = ref('checkout');
const fieldMono = ref('run_20260812T140000Z_a1b2c3');
const toggleOff = ref(false);
const toggleOn = ref(true);
const modalOpen = ref(false);

/**
 * AC2 — the token names, read off the stylesheet rather than hand-listed.
 *
 * Walks every accessible stylesheet's rule tree looking for `:root` and
 * `.dark`, the two selectors theme.css declares its custom properties under,
 * and keeps the property names that fall under the five prefixes AC2 names.
 * A stylesheet vitest's browser mode cannot read (there are none of its own
 * making here, but a third-party one loaded cross-origin would throw on
 * `.cssRules`) is skipped rather than failing the page — the gallery is
 * showing what *this application's* theme resolved to, not auditing every
 * sheet the page happens to load.
 */
const TOKEN_PREFIXES = ['--surface-', '--ink-', '--edge-', '--state-', '--radius-'] as const;
type TokenPrefix = (typeof TOKEN_PREFIXES)[number];

function collectFromRuleList(rules: CSSRuleList, into: Set<string>): void {
  for (const rule of Array.from(rules)) {
    if (
      rule instanceof CSSStyleRule &&
      (rule.selectorText === ':root' || rule.selectorText === '.dark')
    ) {
      for (const prop of Array.from(rule.style)) {
        if (TOKEN_PREFIXES.some((prefix) => prop.startsWith(prefix))) into.add(prop);
      }
      continue;
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested) collectFromRuleList(nested, into);
  }
}

function collectTokenNames(): string[] {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectFromRuleList(sheet.cssRules, names);
    } catch {
      // Cross-origin sheet; nothing this page owns.
    }
  }
  return [...names].sort();
}

const tokenNames = ref<string[]>([]);

/**
 * Bumped by the `MutationObserver` below, purely to give `tokenValues` a
 * dependency it can invalidate on.
 *
 * Not `isDark` from `useTheme()`. `useDark()` applies the `.dark` class to
 * `<html>` from its *own* watcher on that same ref, and Vue gives no ordering
 * guarantee between two independent subscribers of one reactive source — a
 * `tokenValues` that depended on `isDark` directly could run its
 * `getComputedStyle` read before that watcher had written the class, cache a
 * stale value, and never be asked to look again. Watching the class attribute
 * itself instead means this only ever reruns once the mutation it cares about
 * has actually happened, which is what "shows what the theme actually
 * resolved to" (AC2) requires — a race is exactly a place that promise
 * would quietly stop being true.
 */
const themeGeneration = ref(0);
let themeObserver: MutationObserver | null = null;

onMounted(() => {
  tokenNames.value = collectTokenNames();
  themeObserver = new MutationObserver(() => {
    themeGeneration.value += 1;
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});

onUnmounted(() => {
  themeObserver?.disconnect();
  themeObserver = null;
});

/** The computed value of every collected token, re-read after every class change on `<html>`. */
const tokenValues = computed<Record<string, string>>(() => {
  void themeGeneration.value;
  if (typeof document === 'undefined' || tokenNames.value.length === 0) return {};
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    tokenNames.value.map((name) => [name, styles.getPropertyValue(name).trim()]),
  );
});

const TOKEN_GROUPS: readonly { readonly label: string; readonly prefix: TokenPrefix }[] = [
  { label: 'Surfaces', prefix: '--surface-' },
  { label: 'Ink', prefix: '--ink-' },
  { label: 'Edges', prefix: '--edge-' },
  { label: 'States', prefix: '--state-' },
  { label: 'Radii', prefix: '--radius-' },
];

const groupedTokens = computed(() =>
  TOKEN_GROUPS.map((group) => ({
    ...group,
    tokens: tokenNames.value.filter((name) => name.startsWith(group.prefix)),
  })),
);

/** The one inline style each swatch kind needs to show what its token is *for*. */
function swatchStyle(prefix: TokenPrefix, name: string): Record<string, string> {
  const value = `var(${name})`;
  switch (prefix) {
    case '--surface-':
    case '--state-':
      return { background: value };
    case '--ink-':
      return { color: value, background: 'var(--surface-inset)' };
    case '--edge-':
      return { background: 'var(--surface)', border: `2px solid ${value}` };
    case '--radius-':
      return {
        background: 'var(--surface-control)',
        border: '1px solid var(--edge-strong)',
        borderRadius: value,
      };
  }
}

// The composites below (AC4) — a plan-node card, a dense table row, a
// phase-list row and an inspector stat grid — are fixtures, not live data:
// this route has no run to read one from, and its job is to show the shape
// the later screens build from, not to reproduce one of them.
const planNodeState: DisplayState = 'running';
const phaseRows = [
  { icon: GitBranch, label: 'Fan-out', done: 4, running: 1, total: 6 },
  { icon: Boxes, label: 'Aggregate', done: 2, running: 0, total: 2 },
  { icon: Layers, label: 'Verify', done: 0, running: 1, total: 3 },
] as const;
const tableRows = DISPLAY_STATES.slice(0, 3).map((state, index) => ({
  state,
  name: `checkout-node-${index + 1}`,
  model: 'claude-sonnet-5',
  pct: [30, 65, 100][index] ?? 0,
}));
</script>

<template>
  <main class="gallery" data-gallery>
    <header class="gallery__header">
      <div>
        <h1 class="gallery__title">Component gallery</h1>
        <p class="gallery__subtitle">KAR-24.3 — every ui/ component, every variant, both themes.</p>
      </div>
      <button
        type="button"
        class="gallery__theme-toggle"
        data-gallery-theme-toggle
        :aria-pressed="isDark"
        :aria-label="isDark ? 'Switch to the light theme' : 'Switch to the dark theme'"
        @click="toggleTheme()"
      >
        {{ isDark ? 'Dark' : 'Light' }}
        theme
      </button>
    </header>

    <!-- AC1 — UiButton: four variants x two sizes, plus disabled. -->
    <section class="gallery__section" data-gallery-section="button">
      <UiSectionLabel>UiButton</UiSectionLabel>
      <div class="gallery__row">
        <template v-for="variant in BUTTON_VARIANTS" :key="variant">
          <UiButton
            v-for="size in BUTTON_SIZES"
            :key="`${variant}-${size}`"
            :variant="variant"
            :size="size"
          >
            {{ variant }}
            / {{ size }}
          </UiButton>
        </template>
        <UiButton variant="primary" disabled>primary / disabled</UiButton>
      </div>
    </section>

    <!-- AC1 — UiChip: six variants, tinted and mono. -->
    <section class="gallery__section" data-gallery-section="chip">
      <UiSectionLabel>UiChip</UiSectionLabel>
      <div class="gallery__row">
        <UiChip v-for="variant in CHIP_VARIANTS" :key="variant" :variant="variant"
          >{{ variant }}</UiChip
        >
        <UiChip variant="accent" mono>mono</UiChip>
      </div>
    </section>

    <!-- AC1 — UiStateChip: every DisplayState, enumerated rather than hand-listed. -->
    <section class="gallery__section" data-gallery-section="state-chip">
      <UiSectionLabel>UiStateChip</UiSectionLabel>
      <div class="gallery__row">
        <UiStateChip
          v-for="state in DISPLAY_STATES"
          :key="state"
          :state="state"
          :data-gallery-state-chip="state"
        />
      </div>
    </section>

    <!-- AC1 — UiCard: three variants, one of them interactive. -->
    <section class="gallery__section" data-gallery-section="card">
      <UiSectionLabel>UiCard</UiSectionLabel>
      <div class="gallery__row">
        <UiCard v-for="variant in CARD_VARIANTS" :key="variant" :variant="variant"
          >{{ variant }}
          card</UiCard
        >
        <UiCard variant="raised" interactive>raised / interactive</UiCard>
      </div>
    </section>

    <!-- AC1 — UiPanel: with and without an action. -->
    <section class="gallery__section" data-gallery-section="panel">
      <UiSectionLabel>UiPanel</UiSectionLabel>
      <div class="gallery__row">
        <UiPanel title="No action">Body only.</UiPanel>
        <UiPanel title="With an action">
          <template #action>
            <UiButton variant="ghost" size="sm">Refresh</UiButton>
          </template>
          Body plus a header action.
        </UiPanel>
      </div>
    </section>

    <!-- AC1 — UiIconTile: three sizes. -->
    <section class="gallery__section" data-gallery-section="icon-tile">
      <UiSectionLabel>UiIconTile</UiSectionLabel>
      <div class="gallery__row gallery__row--center">
        <UiIconTile
          v-for="size in ICON_TILE_SIZES"
          :key="size"
          :size="size"
          tint="var(--state-running)"
        >
          <Bell :size="size === 'sm' ? 10 : size === 'md' ? 12 : 14" />
        </UiIconTile>
      </div>
    </section>

    <!-- AC1 — UiSectionLabel, on itself. -->
    <section class="gallery__section" data-gallery-section="section-label">
      <UiSectionLabel>Streaming output</UiSectionLabel>
    </section>

    <!-- AC1 — UiStatTile: five tones. -->
    <section class="gallery__section" data-gallery-section="stat-tile">
      <UiSectionLabel>UiStatTile</UiSectionLabel>
      <div class="gallery__row">
        <UiStatTile
          v-for="tone in TONES"
          :key="tone"
          :label="tone"
          :value="tone === 'default' ? 12 : 7"
          :tone="tone"
        />
      </div>
    </section>

    <!-- AC1 — UiProgressSplit, one live example. -->
    <section class="gallery__section" data-gallery-section="progress-split">
      <UiSectionLabel>UiProgressSplit</UiSectionLabel>
      <UiProgressSplit :done="4" :running="2" :total="9" />
    </section>

    <!-- AC1 — UiMeter: five tones, at 0/50/100. -->
    <section class="gallery__section" data-gallery-section="meter">
      <UiSectionLabel>UiMeter</UiSectionLabel>
      <div class="gallery__stack">
        <div v-for="tone in TONES" :key="tone" class="gallery__row gallery__row--center">
          <span class="gallery__meter-tone">{{ tone }}</span>
          <UiMeter
            v-for="pct in METER_STOPS"
            :key="`${tone}-${pct}`"
            :pct="pct"
            :tone="tone"
            :ariaLabel="`${tone} at ${pct}%`"
            class="gallery__meter"
          />
        </div>
      </div>
    </section>

    <!-- AC1 — UiField: plain and mono. -->
    <section class="gallery__section" data-gallery-section="field">
      <UiSectionLabel>UiField</UiSectionLabel>
      <div class="gallery__row">
        <UiField v-model="fieldPlain" label="Name" placeholder="checkout" />
        <UiField v-model="fieldMono" label="Run id" mono />
      </div>
    </section>

    <!-- AC1 — UiToggle: both states. -->
    <section class="gallery__section" data-gallery-section="toggle">
      <UiSectionLabel>UiToggle</UiSectionLabel>
      <div class="gallery__row">
        <UiToggle v-model="toggleOff" label="Off" />
        <UiToggle v-model="toggleOn" label="On" />
      </div>
    </section>

    <!-- AC1 — UiModal: a button that opens it. -->
    <section class="gallery__section" data-gallery-section="modal">
      <UiSectionLabel>UiModal</UiSectionLabel>
      <UiButton variant="secondary" data-gallery-modal-open @click="modalOpen = true"
        >Open modal</UiButton
      >
      <UiModal :open="modalOpen" title="Example modal" @close="modalOpen = false">
        <p>A modal's body is whatever the caller slots in.</p>
        <template #footer>
          <UiButton variant="ghost" size="sm" @click="modalOpen = false">Cancel</UiButton>
          <UiButton variant="primary" size="sm" @click="modalOpen = false">Confirm</UiButton>
        </template>
      </UiModal>
    </section>

    <!-- AC1 — UiEmptyState. -->
    <section class="gallery__section" data-gallery-section="empty-state">
      <UiSectionLabel>UiEmptyState</UiSectionLabel>
      <UiEmptyState title="No runs yet" hint="Start one from the composer.">
        <template #action>
          <UiButton variant="primary" size="sm">New run</UiButton>
        </template>
      </UiEmptyState>
    </section>

    <!-- AC1 — UiMetaRow. -->
    <section class="gallery__section" data-gallery-section="meta-row">
      <UiSectionLabel>UiMetaRow</UiSectionLabel>
      <div class="gallery__meta-list">
        <UiMetaRow label="Model" value="claude-sonnet-5" />
        <UiMetaRow label="Branch" value="main" mono />
        <UiMetaRow label="Owner" value="zohre" :mono="false" />
      </div>
    </section>

    <!-- AC2 — the token layer, read at runtime rather than duplicated. -->
    <section class="gallery__section" data-gallery-section="tokens">
      <UiSectionLabel>Token layer</UiSectionLabel>
      <div v-for="group in groupedTokens" :key="group.label" class="gallery__token-group">
        <h2 class="gallery__token-group-title">{{ group.label }}</h2>
        <div class="gallery__token-grid">
          <div
            v-for="name in group.tokens"
            :key="name"
            class="gallery__token-swatch"
            data-gallery-token-swatch
            :data-token-name="name"
          >
            <span class="gallery__token-chip" :style="swatchStyle(group.prefix, name)">Aa</span>
            <span class="gallery__token-name">{{ name }}</span>
            <span class="gallery__token-value" data-gallery-token-value
              >{{ tokenValues[name] }}</span
            >
          </div>
        </div>
      </div>
    </section>

    <!-- AC4 — the composites the later stories reuse, built from the primitives
         above and adding no new component. -->
    <section class="gallery__section" data-gallery-section="composites">
      <UiSectionLabel>Composites</UiSectionLabel>

      <h2 class="gallery__composite-title">Plan-node card</h2>
      <UiCard variant="raised" class="gallery__plan-node" data-gallery-plan-node>
        <div class="gallery__plan-node-head">
          <UiIconTile size="md" tint="var(--state-running)">
            <Boxes :size="12" />
          </UiIconTile>
          <span class="gallery__plan-node-title">checkout-node-2</span>
          <UiStateChip :state="planNodeState" />
        </div>
        <p class="gallery__plan-node-model">claude-sonnet-5</p>
        <UiMeter :pct="55" tone="accent" ariaLabel="checkout-node-2 progress" />
        <UiMetaRow label="Started" value="2026-08-18T09:12:03Z" />
      </UiCard>

      <h2 class="gallery__composite-title">Dense table row</h2>
      <div class="gallery__table" data-gallery-table>
        <div
          v-for="row in tableRows"
          :key="row.name"
          class="gallery__table-row"
          data-gallery-table-row
        >
          <UiStateChip :state="row.state" />
          <span class="gallery__table-name">{{ row.name }}</span>
          <UiChip variant="neutral" mono>{{ row.model }}</UiChip>
          <UiMeter
            :pct="row.pct"
            tone="accent"
            :ariaLabel="`${row.name} progress`"
            class="gallery__table-meter"
          />
        </div>
      </div>

      <h2 class="gallery__composite-title">Phase-list row</h2>
      <div class="gallery__phase-list" data-gallery-phase-list>
        <div
          v-for="phase in phaseRows"
          :key="phase.label"
          class="gallery__phase-row"
          data-gallery-phase-row
        >
          <UiIconTile size="sm" tint="var(--surface-control)">
            <component :is="phase.icon" :size="10" />
          </UiIconTile>
          <span class="gallery__phase-label">{{ phase.label }}</span>
          <UiProgressSplit
            :done="phase.done"
            :running="phase.running"
            :total="phase.total"
            class="gallery__phase-progress"
          />
          <span class="gallery__phase-count">{{ phase.done }}/{{ phase.total }}</span>
        </div>
      </div>

      <h2 class="gallery__composite-title">Inspector stat grid</h2>
      <div class="gallery__stat-grid" data-gallery-stat-grid>
        <UiStatTile label="Nodes" value="12" tone="default" />
        <UiStatTile label="Passed" value="9" tone="ok" />
        <UiStatTile label="Blocked" value="1" tone="warn" />
        <UiStatTile label="Failed" value="2" tone="error" />
      </div>
    </section>
  </main>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: 20px; /* geometry — the gap between gallery sections */
  padding: 16px; /* geometry — the page's own padding */
}

.gallery__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px; /* geometry — the header's own gutter */
}

.gallery__title {
  font-size: var(--text-2xl);
  margin: 0;
}

.gallery__subtitle {
  font-size: var(--text-sm);
  color: var(--ink-muted);
  margin: 4px 0 0; /* geometry — the title-to-subtitle gap */
}

.gallery__theme-toggle {
  flex: none;
  padding: 6px 11px; /* geometry — matches UiButton's sm padding */
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  background: var(--surface-control);
  color: var(--ink);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: var(--text-base);
}

.gallery__theme-toggle:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.gallery__section {
  display: flex;
  flex-direction: column;
  gap: 10px; /* geometry — the label-to-content gap inside a section */
  padding-bottom: 16px; /* geometry — the divider's own breathing room */
  border-bottom: 1px solid var(--edge);
}

.gallery__row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 10px; /* geometry — the gap between swatches on a row */
}

.gallery__row--center {
  align-items: center;
}

.gallery__stack {
  display: flex;
  flex-direction: column;
  gap: 8px; /* geometry — the gap between meter-tone rows */
}

.gallery__meter-tone {
  width: 64px; /* geometry — the tone label column */
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.gallery__meter {
  width: 96px; /* geometry — one meter swatch's own track length */
}

.gallery__meta-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.gallery__token-group {
  display: flex;
  flex-direction: column;
  gap: 8px; /* geometry — the group title to grid gap */
  margin-top: 8px; /* geometry — the gap between token groups */
}

.gallery__token-group-title {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 0;
}

.gallery__token-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px; /* geometry — the gap between token swatch cells */
}

.gallery__token-swatch {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the chip-to-text gap */
  padding: 6px 8px; /* geometry — the swatch cell's own padding */
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.gallery__token-chip {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px; /* geometry — the swatch chip */
  height: 28px; /* geometry — the swatch chip */
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}

.gallery__token-name {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--ink-faint);
  flex: 1;
}

.gallery__token-value {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--ink-muted);
}

.gallery__composite-title {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 8px 0 0; /* geometry — the gap above each composite */
}

.gallery__plan-node {
  display: flex;
  flex-direction: column;
  gap: 8px; /* geometry — the plan-node card's own stack gap */
  max-width: 260px; /* geometry — matches the plan graph's node width */
}

.gallery__plan-node-head {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the head row's gutter */
}

.gallery__plan-node-title {
  flex: 1;
  font-size: var(--text-md);
  font-weight: 600;
}

.gallery__plan-node-model {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.gallery__table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.gallery__table-row {
  display: flex;
  align-items: center;
  gap: 10px; /* geometry — the dense row's gutter */
  padding: 6px 10px; /* geometry — the dense row's own padding */
  border-bottom: 1px solid var(--edge);
  background: var(--surface);
}

.gallery__table-row:last-child {
  border-bottom: none;
}

.gallery__table-name {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.gallery__table-meter {
  width: 80px; /* geometry — the dense row's own meter track length */
}

.gallery__phase-list {
  display: flex;
  flex-direction: column;
  gap: 6px; /* geometry — the gap between phase rows */
}

.gallery__phase-row {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — the phase row's gutter */
}

.gallery__phase-label {
  width: 90px; /* geometry — the phase label column */
  flex: none;
  font-size: var(--text-base);
}

.gallery__phase-progress {
  flex: 1;
}

.gallery__phase-count {
  width: 40px; /* geometry — the count column */
  flex: none;
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
}

.gallery__stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px; /* geometry — the 2x2 grid's own gutter */
  max-width: 260px; /* geometry — matches the inspector's own panel width */
}
</style>
