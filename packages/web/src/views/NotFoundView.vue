<script setup lang="ts">
/**
 * The catch-all route.
 *
 * It exists so that a URL nobody recognises is an honest, navigable page rather
 * than a blank `<RouterView>` — the same rule AC3 states for the tokenless tab,
 * applied to the other way a tab lands somewhere it cannot render.
 */
import { RouterLink } from 'vue-router';
</script>

<template>
  <section class="not-found">
    <h1>No such view</h1>
    <p>That address does not name anything this app renders.</p>
    <RouterLink :to="{ name: 'projects' }">Back to your projects</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  display: grid;
  gap: 0.5rem;
  justify-items: start;
  max-width: 32rem;
  margin: 3rem auto;
}
</style>
