<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import HelloDeFlow from './components/HelloDeFlow.vue';

const health = ref<Record<string, unknown> | null>(null);
const streamState = ref<'connecting' | 'open' | 'closed'>('connecting');

let source: EventSource | null = null;

onMounted(async () => {
  // Same origin, so a relative path is all there is. No proxy, no CORS (D10).
  health.value = (await (await fetch('/api/health')).json()) as Record<string, unknown>;

  source = new EventSource('/api/stream');
  source.addEventListener('open', () => {
    streamState.value = 'open';
  });
  source.addEventListener('error', () => {
    streamState.value = 'closed';
  });
});

onUnmounted(() => source?.close());
</script>

<template>
  <main>
    <HelloDeFlow />
    <p>stream: {{ streamState }}</p>
    <pre v-if="health">{{ health }}</pre>
  </main>
</template>

<style scoped>
main {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 2rem;
}
</style>
