<script setup lang="ts">
/**
 * KAR-26.4 — the disclosure: the one place a row's demoted prose lives, a
 * chevron trigger and a collapsible body, built on Reka UI's Collapsible the
 * way `UiModal` is built on its Dialog.
 *
 * Verifies: EPIC-26-S24, EPIC-26-S26, EPIC-26-S28 · AC1, AC2, AC3
 *
 * ## `unmount-on-hide` is `false`, hard-coded, and that is the whole design
 *
 * Reka's `CollapsibleRoot` defaults `unmountOnHide` to `true`, which removes
 * closed content from the DOM entirely. This component pins it to `false`:
 * closed content stays mounted under `hidden="until-found"`, which Tailwind's
 * own preflight exempts from `display: none` (`[hidden]:where(:not([hidden=
 * 'until-found']))`), so Chromium applies `content-visibility: hidden`
 * instead. Two properties follow, and both are load-bearing for the settings
 * story:
 *
 * - every daemon sentence a row demotes into its disclosure remains in
 *   `textContent` — no existing fact assertion dies because the fact never
 *   leaves the document, and the browser's own find-in-page can still reveal
 *   a collapsed sentence (`beforematch` reopens it);
 * - closed content is skipped from rendering, so "absent from the list" is a
 *   visibility claim, probed with `checkVisibility()` — **not** a geometry
 *   claim: Chromium *forces* layout when a geometry API is called on
 *   `content-visibility: hidden` content, so `getClientRects()` reports
 *   would-be boxes for closed descendants (a11y.test.ts's own comment
 *   records the same measurement). `checkVisibility()` accounts for the
 *   skipped subtree and answers false.
 *
 * It is not a prop because the trade-off belongs to the design system, not to
 * callers: a caller who wanted unmounting back would be re-opening the
 * assertion-survival question this component exists to close.
 *
 * ## Contract
 *
 * `docs/design/component-spec.md` does not exist (the reference in
 * `variants.test.ts`'s header dangles), so the contract is recorded here:
 * `label` is required — it is the trigger's accessible name, because a
 * chevron with no name is a button assistive tech cannot announce. `compact`
 * renders the trigger icon-only with `label` as its `aria-label`; the default
 * renders `label` as visible text beside the chevron. `defaultOpen` seeds the
 * uncontrolled state; `open` + `update:open` make it controlled. No
 * `variant`/`size`/`tone`: one shape, like `UiPanel`.
 *
 * The root renders `display: contents`, so the trigger and the content
 * participate directly in whatever grid or flex row the caller places the
 * disclosure in — the trigger sits in the row, the content (spanning
 * `grid-column: 1 / -1` when the parent is a grid) opens beneath it.
 */
import { ChevronDown } from 'lucide-vue-next';
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui';
import { onMounted, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    /** The trigger's accessible name. */
    readonly label: string;
    /** Icon-only trigger; `label` becomes its `aria-label`. */
    readonly compact?: boolean;
    /** Uncontrolled starting state. */
    readonly defaultOpen?: boolean;
    /** External state (`v-model:open`). `null` — the default — means the
     *  disclosure manages its own state. Typed with `null` rather than
     *  `undefined` on purpose: Vue casts an absent `boolean` prop to `false`,
     *  which would read as "controlled closed" and freeze the trigger. */
    readonly open?: boolean | null;
  }>(),
  { compact: false, defaultOpen: false, open: null },
);

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

/**
 * The one open/closed state Reka's root is bound to. Always driven from here
 * (Reka sees a controlled collapsible): the trigger updates it directly, and
 * a caller's `open` prop overrides it whenever the caller sets one.
 */
const isOpen = ref(props.open ?? props.defaultOpen);

watch(
  () => props.open,
  (value) => {
    if (typeof value === 'boolean') isOpen.value = value;
  },
);

function setOpen(value: boolean): void {
  isOpen.value = value;
  emit('update:open', value);
}

/**
 * Forces one trigger re-render after mount, and that is its whole job. Reka's
 * `CollapsibleContent` assigns the shared `contentId` during its own setup —
 * *after* the trigger's first render — and the context field is not reactive,
 * so a never-touched trigger would otherwise ship `aria-controls=""`: an
 * invalid empty IDREF, in exactly the collapsed state every user meets first.
 * Binding this ref on the trigger (as a data attribute) makes Vue patch the
 * trigger once the component tree is mounted, and the patch re-reads the
 * context's now-assigned id. a11y.test.ts asserts the binding on a trigger
 * nothing has clicked.
 */
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
</script>

<template>
  <CollapsibleRoot
    class="ui-disclosure"
    :open="isOpen"
    :unmount-on-hide="false"
    @update:open="setOpen"
  >
    <CollapsibleTrigger
      class="ui-disclosure__trigger"
      :class="{ 'ui-disclosure__trigger--compact': compact }"
      :aria-label="compact ? label : undefined"
      :data-mounted="mounted ? '' : undefined"
    >
      <span v-if="!compact" class="ui-disclosure__label">{{ label }}</span>
      <ChevronDown class="ui-disclosure__chevron" aria-hidden="true" :size="12" />
    </CollapsibleTrigger>
    <CollapsibleContent class="ui-disclosure__content">
      <div class="ui-disclosure__body">
        <slot />
      </div>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>

<style scoped>
.ui-disclosure {
  display: contents;
}

.ui-disclosure__trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px; /* geometry — label-to-chevron gap */
  padding: 3px 5px; /* geometry — a small, quiet hit target */
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--ink-faint);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  cursor: pointer;
}

.ui-disclosure__trigger:hover {
  color: var(--ink-muted);
}

.ui-disclosure__chevron {
  flex: none;
  transition: transform 120ms ease;
}

.ui-disclosure__trigger[data-state="open"] .ui-disclosure__chevron {
  transform: rotate(180deg);
}

/* Spans the caller's grid, if the caller is one; inert under flex or block. */
.ui-disclosure__content {
  grid-column: 1 / -1;
  min-width: 0;
}

/* Padding and edges live on this inner wrapper, not on the content element:
   the closed content element keeps a (zero-height) box under
   `content-visibility: hidden`, and border or padding on it would paint an
   empty strip while closed. */
.ui-disclosure__body {
  display: grid;
  gap: 8px; /* geometry — the body's own stack gap */
  margin-top: 6px; /* geometry — row-to-body breathing room */
  padding: 10px 12px; /* geometry — the body's own padding */
  background: var(--surface-inset);
  border: 1px solid var(--edge);
  border-radius: var(--radius-md);
}

@media (prefers-reduced-motion: reduce) {
  .ui-disclosure__chevron {
    transition: none;
  }
}
</style>
