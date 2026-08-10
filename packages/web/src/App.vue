<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { connectStream, type StreamConnection } from './api/stream.ts';
import { readToken } from './api/token.ts';
import HelloDeFlow from './components/HelloDeFlow.vue';

const health = ref<Record<string, unknown> | null>(null);
const streamState = ref<'connecting' | 'open' | 'closed'>('connecting');

let stream: StreamConnection | null = null;

onMounted(async () => {
  // Same origin, so a relative path is all there is. No proxy, no CORS (D10).
  // `/api/health` is the one route that answers without a token — which is why
  // this line still works on a tab that arrived without the handoff fragment.
  health.value = (await (await fetch('/api/health')).json()) as Record<string, unknown>;

  // Not `new EventSource(...)`: it cannot send an `Authorization` header, and a
  // design built on it puts the daemon token in the query string (KAR-15.2 AC9,
  // docs/11-api-and-realtime.md §8.1). `connectStream` sends the token acquired
  // from the first-run fragment as a header instead.
  stream = connectStream({
    runs: [],
    since: 0,
    token: readToken,
    onConnect: () => {
      streamState.value = 'open';
    },
    onDisconnect: () => {
      streamState.value = 'closed';
    },
  });
});

onUnmounted(() => stream?.close());
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
