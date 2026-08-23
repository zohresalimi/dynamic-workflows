<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the new-project modal and every other text input, one
 * component so a label is never typed as a bare `<span>` beside an `<input>`
 * again.
 *
 * The label carries UiSectionLabel's exact type treatment (mono, `.08em`
 * tracking, `--ink-faint`, uppercase) without importing that component: a
 * `<label>` and a section heading are different elements answering to
 * different things (one names a control, one names a region), and reaching
 * for UiSectionLabel here would either render the wrong element or force it
 * to grow an `as="label"` escape hatch that serves this one caller.
 *
 * AC4 — a real `<label for>` bound to a real `<input>`. An id is generated
 * when the caller does not supply one, because a label with no `for` is
 * cosmetic: it looks associated and a screen reader does not agree.
 * `outline: none` never appears here — the input inherits the global
 * `:focus-visible` ring from theme.css and this component does not touch it.
 *
 * KAR-26.4 AC4 — `inline` flips the field to the settings blueprint's
 * label-value rhythm: label left, control right, one row. The `<label for>` /
 * `<input id>` association is untouched by it (a11y.test.ts proves the
 * association survives), and every existing caller — which leaves `inline`
 * unset — renders byte-identically.
 */
import { useId } from 'vue';

const props = withDefaults(
  defineProps<{
    readonly label: string;
    readonly modelValue: string;
    readonly placeholder?: string;
    readonly mono?: boolean;
    readonly inline?: boolean;
    readonly id?: string;
  }>(),
  { mono: false, inline: false },
);

defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const generatedId = useId();
const inputId = props.id ?? `ui-field-${generatedId}`;
</script>

<template>
  <div class="ui-field" :data-inline="inline || undefined">
    <label class="ui-field__label" :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      class="ui-field__input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :data-mono="mono || undefined"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >
  </div>
</template>

<style scoped>
.ui-field {
  display: flex;
  flex-direction: column;
}

.ui-field__label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  /* Tracked with `UiSectionLabel`'s own, deliberately: the header comment
     already records that this label *is* that treatment on an element
     `UiSectionLabel` cannot render, so the two move together or the copy has
     started to drift. */
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  text-transform: uppercase;
  margin-bottom: 6px; /* geometry — the label-to-input gap */
}

.ui-field__input {
  box-sizing: border-box;
  width: 100%;
  background: var(--surface-inset);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-md);
  padding: 9px 11px; /* geometry — the input's own padding */
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--text-md);
}

.ui-field__input[data-mono] {
  font-family: var(--font-mono);
}

/* KAR-26.4 — the blueprint's label-value-control rhythm: one row, label
   left, control right. */
.ui-field[data-inline] {
  flex-direction: row;
  align-items: center;
  gap: 10px; /* geometry — label-to-control gutter */
}

.ui-field[data-inline] .ui-field__label {
  margin-bottom: 0;
  flex: none;
}

.ui-field[data-inline] .ui-field__input {
  flex: 1;
  width: auto;
  min-width: 0;
  text-align: right;
}
</style>
