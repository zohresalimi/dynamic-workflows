<script setup lang="ts">
/**
 * KAR-17.5 — F10.6's route: `/runs/:runId/nodes/:nodeId/output`.
 *
 * Verifies: EPIC-17-S20, EPIC-17-S21, EPIC-17-S23 · AC1, AC6
 *
 * A route of its own rather than a tab inside the inspector, and that is the
 * linkability half of PRD §12: *"a node that has been running for eleven
 * minutes"* is something one person hands to another, and a URL is how. The
 * message permalinks inside the panel are the same idea one level down.
 *
 * The view is thin on purpose — it is where the route's params become props and
 * nothing else. `../components/output/NodeOutputPanel.vue` owns the rest.
 */
import NodeOutputPanel from '../components/output/NodeOutputPanel.vue';

const props = defineProps<{
  readonly runId?: string;
  readonly nodeId?: string;
}>();
</script>

<template>
  <main class="node-output">
    <NodeOutputPanel
      v-if="props.runId !== undefined && props.nodeId !== undefined"
      :run-id="props.runId"
      :node-id="props.nodeId"
    />
    <p v-else class="node-output__missing">No node named in the URL.</p>
  </main>
</template>

<style scoped>
.node-output {
  display: grid;
  block-size: 100%;
  padding: 1rem;
}
</style>
