<script setup lang="ts">
// Deliberately a separate SFC: an edit here is a self-accepting HMR boundary
// with a known importer, which is what the KAR-01.3 e2e spec asserts survives
// without restarting the daemon or dropping the SSE stream.
</script>

<template>
  <section>
    <h1>DeFlow</h1>
    <p>One command. One port. One origin.</p>
  </section>
</template>
