<script setup lang="ts">
/**
 * KAR-25.1 — `/settings`'s route, filled in.
 *
 * Verifies: EPIC-25-S02 (the rail's global item resolves everywhere), AC3,
 * AC8
 *
 * **This is a placeholder, not the finished screen.** KAR-25.1 only needs the
 * route to exist and resolve to something, because AC3 requires the rail's
 * Settings row to be active and reachable at every route before anything is
 * actually behind it — and KAR-24.4 AC2 / EPIC-25-S07 forbid a nav item
 * pointing at a route the router does not register. The three panels
 * (*Providers & runtimes*, *Issue tracker*, *Execution defaults*) are
 * KAR-25.2's, KAR-25.3's and KAR-25.4's respectively; nobody should read this
 * heading and subtitle as the finished page.
 */
</script>

<template>
  <main class="settings" data-settings>
    <h1 class="settings__title">Settings</h1>
    <p class="settings__subtitle">Everything here applies to this machine, not to one project.</p>
  </main>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 4px; /* geometry — title-to-subtitle gap */
  padding: 16px; /* geometry — matches ProjectsView's own page padding */
}

.settings__title {
  font-size: var(--text-xl);
  margin: 0;
}

.settings__subtitle {
  font-size: var(--text-base);
  color: var(--ink-muted);
  margin: 0;
}
</style>
