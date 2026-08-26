/**
 * KAR-28.4 AC1, AC3 — the inspector's header note and the inspector's code say
 * the same thing.
 *
 * Verifies: EPIC-28-S17 · AC1, AC3
 *
 * KAR-24.6 chose a Reka `Dialog` and wrote the reason into
 * `NodeInspector.vue`'s header; KAR-26.5's audit then recorded the scrim as
 * *"the largest single visual divergence in the five screenshots"* and deferred
 * it, because an audit story may not change behaviour. KAR-28.4 is where the
 * behaviour changes — and a decision note left behind after its decision is
 * reversed is worse than no note at all, because the next person reads it and
 * believes it.
 *
 * So this file is the guard on the *pair*: the component must not be a modal
 * dialog any more, **and** the header must not still be arguing that it is. It
 * is a rule about source text for the same reason
 * `./no-overlay-composer.test.ts` is: the failure it catches — prose that
 * survived a rewrite of the code under it — is invisible in a component spec
 * and nearly invisible in review.
 *
 * The third rule here is the one KAR-28.4 AC3 asks to *keep*: there is no Logs
 * tab and the reason for that stays written down. Nothing in the projections
 * this panel reads is a level-tagged, per-node log line, and inventing one is
 * barred; a rule that only ever removed things would let that reason quietly
 * go with the Dialog note.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const INSPECTOR = 'packages/web/src/components/NodeInspector.vue';

const source = readFileSync(fileURLToPath(new URL(`../${INSPECTOR}`, import.meta.url)), 'utf8');

/**
 * The `<script setup>` block's **code**, with its comments removed.
 *
 * The comments have to go: the header note this file also polices is where
 * `DialogContent` is named *as the thing this component stopped being*, and a
 * rule that could not tell the prose from the code would forbid explaining the
 * decision it exists to enforce.
 */
const script = (): string => {
  const start = source.indexOf('<script setup');
  const end = source.indexOf('</script>');
  if (start === -1 || end === -1) throw new Error(`${INSPECTOR} has no <script setup> block`);
  return source
    .slice(start, end)
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/\/\/[^\n]*/g, ' ');
};

/** The `<template>` block alone. */
const template = (): string => {
  const start = source.indexOf('<template>');
  const end = source.lastIndexOf('</template>');
  if (start === -1 || end === -1) throw new Error(`${INSPECTOR} has no <template> block`);
  return source.slice(start, end);
};

suite('AC1 — the inspector is not a modal dialog any more', () => {
  it('imports no Dialog primitive from reka-ui', () => {
    // The whole import list, so a `DialogRoot` reintroduced under an alias is
    // still caught: the name comes from the package either way.
    expect(script()).not.toMatch(/\bDialog(?:Root|Portal|Overlay|Content|Title|Description)\b/);
  });

  it('renders no dialog and no scrim', () => {
    const markup = template();
    expect(markup).not.toMatch(/<Dialog[A-Za-z]*/);
    // The overlay token is the scrim's colour and nothing else's — a docked
    // panel that dims nothing has no use for it.
    expect(source).not.toContain('--surface-overlay');
  });

  it('no longer argues in its header that it is still a Dialog', () => {
    expect(source).not.toContain('Why the panel is still a `Dialog`');
    expect(source).not.toMatch(/still a `?Dialog`?/);
  });

  it('records what it is instead, and which story decided that', () => {
    expect(source).toContain('KAR-28.4');
    expect(source).toMatch(/docked/i);
  });
});

suite('AC3 — Logs stays out, and the reason stays written down', () => {
  it('renders no Logs tab', () => {
    expect(template()).not.toMatch(/value="logs"/i);
    expect(template()).not.toMatch(/>\s*Logs\s*</);
  });

  it('still records why there is none', () => {
    expect(source).toContain('level-tagged');
    expect(source).toMatch(/no Logs tab/i);
  });
});
