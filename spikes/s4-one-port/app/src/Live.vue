<script setup lang="ts">
// The single-file component the spike edits mid-stream. The marker string below
// is what an HMR update changes in the browser; the stream it is rendering
// lives in ./recorder.ts and must not notice.
import { count } from './recorder.ts';

const marker = 'one port, one process';
</script>

<template>
  <h1 id="marker">{{ marker }}</h1>
  <p id="count">{{ count }} events received</p>
</template>
