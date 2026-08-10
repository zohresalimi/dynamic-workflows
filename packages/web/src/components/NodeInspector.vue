<script setup lang="ts">
/**
 * F10.3's node inspector, as far as this story owns it: the overlay `Enter`
 * opens for the selected node (AC7).
 *
 * What goes *inside* it — the packet manifest, the transcript, the cost rollup
 * — is EPIC-17's. What is here is the frame and the a11y contract: a Reka UI
 * dialog, so focus is trapped and returned, and the same one-Escape-handler
 * rule as the jumper next door.
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { computed } from 'vue';
import { INSPECTOR_OVERLAY } from '../app/ids.ts';
import { useUiStore } from '../stores/useUiStore.ts';
import StateChip from './StateChip.vue';

const ui = useUiStore();

const open = computed({
  get: () => ui.isOverlayOpen(INSPECTOR_OVERLAY),
  set: (next: boolean) => {
    if (next) ui.openOverlay(INSPECTOR_OVERLAY);
    else ui.closeOverlay(INSPECTOR_OVERLAY);
  },
});

const node = computed(() => ui.nodes.find((one) => one.id === ui.inspectedNodeId) ?? null);
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="inspector__scrim" />
      <DialogContent
        class="inspector"
        data-overlay="inspector"
        @escape-key-down="(event: Event) => event.preventDefault()"
      >
        <DialogTitle class="inspector__title">{{ node?.title ?? 'Node' }}</DialogTitle>
        <DialogDescription class="inspector__id">{{ node?.id ?? '' }}</DialogDescription>
        <StateChip v-if="node" :state="ui.stateOf(node)" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.inspector__scrim {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
}

.inspector {
  position: fixed;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: min(34rem, 92vw);
  display: grid;
  gap: 0.5rem;
  justify-items: start;
  padding: 1rem;
  border: 1px solid var(--edge);
  border-radius: 0.75rem;
  background: var(--surface-raised);
  color: var(--ink);
}

.inspector__title {
  font-size: 1rem;
  font-weight: 600;
}

.inspector__id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  color: var(--ink-muted);
}
</style>
