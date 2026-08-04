<script setup lang="ts">
defineProps<{ disabled?: boolean }>();
const handleClick = () => {};
</script>

<template>
  <button
    type="button"
    class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    :disabled="disabled"
    data-testid="submit-button"
    aria-label="Submit the current form and advance to the next onboarding step"
    @click="handleClick"
  >
    Submit
  </button>
</template>
