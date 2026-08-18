<script setup lang="ts">
/**
 * KAR-24.2 AC1 — "runtime enable" and "require approval before writes", the
 * only two-state control in the library, built as a real `<button>` rather
 * than a styled checkbox so keyboard operability (Space/Enter, tab order)
 * comes from the element and not from a set of key handlers this component
 * would otherwise have to reimplement.
 *
 * AC4 — `role="switch"` with `aria-checked` bound to the model value, which
 * is what tells assistive tech this is a two-state switch and not a
 * momentary button. The visible label sits beside it as ordinary text rather
 * than only inside `aria-label`, so a sighted reader and a screen-reader user
 * are told the same thing by the same route (WCAG 2.5.3).
 */
defineProps<{
  readonly modelValue: boolean;
  readonly label: string;
}>();

defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();
</script>

<template>
  <button
    type="button"
    class="ui-toggle"
    role="switch"
    :aria-checked="modelValue"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="ui-toggle__track" :data-on="modelValue || undefined">
      <span class="ui-toggle__knob" :data-on="modelValue || undefined" />
    </span>
    <span class="ui-toggle__label">{{ label }}</span>
  </button>
</template>

<style scoped>
.ui-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px; /* geometry — the track-to-label gap */
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-sans);
  color: var(--ink);
}

.ui-toggle__track {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  width: 34px; /* geometry — the switch track */
  height: 19px; /* geometry — the switch track */
  border-radius: var(--radius-pill);
  padding: 2px; /* geometry — the track's inset around the knob */
  background: var(--edge-control);
  transition: background 0.2s ease;
}

.ui-toggle__track[data-on] {
  background: var(--state-running);
  justify-content: flex-end;
}

.ui-toggle__knob {
  width: 15px; /* geometry — the switch knob */
  height: 15px; /* geometry — the switch knob */
  border-radius: var(--radius-pill);
  background: var(--ink);
}

.ui-toggle__knob[data-on] {
  background: var(--surface-canvas);
}

.ui-toggle__label {
  font-size: var(--text-base);
}

.ui-toggle:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
</style>
