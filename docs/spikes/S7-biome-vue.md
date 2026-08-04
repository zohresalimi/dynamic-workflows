---
closes: [A2-3]
---

# S7 — Biome's Vue formatter, run against real SFCs

> Spike for [KAR-00.6](../delivery/epics/EPIC-00-foundation-spikes.md#kar-006--spike-biomes-vue-formatter-on-real-sfcs).
> Scenario: [EPIC-00-S20](../delivery/flows/EPIC-00-foundation-spikes-flows.md).
> Artefact: [`spikes/s7-biome-vue/`](../../spikes/s7-biome-vue/) and the scratch branch
> `spike/s7-biome-vue` (not merged), executed by
> [`test/integration/spike-s7-biome-vue.test.ts`](../../test/integration/spike-s7-biome-vue.test.ts)
> and [`test/spike-s7-biome-vue-diff.test.ts`](../../test/spike-s7-biome-vue-diff.test.ts).
> Closes open risk **A2-3** ([roadmap §6](../17-roadmap.md)).

**Date:** 2026-08-04. **Biome:** 2.5.6. **oxlint:** 1.76.0.

## Verdict: safe.

**Verdict: safe.** `stage_fixed: true` may auto-stage Biome's `.vue` rewrites in the pre-commit
`format` job. `lefthook.yml`'s `format` job glob now includes `vue`.

## Decision

**Adopt.** Turn the `html` block on (`experimentalFullSupportEnabled: true`,
`formatter.enabled: true`) and include `vue` in the pre-commit `format` job's glob with
`stage_fixed: true`, exactly as the Verdict above states and as `biome.json`/`lefthook.yml` already
implement (KAR-01.5, KAR-01.6). No fallback ("do not auto-stage `.vue`") is taken — Findings 1–3
below are the evidence for why not.

## The question

Biome's `.vue` support is gated behind `"html": { "experimentalFullSupportEnabled": true,
"formatter": { "enabled": true } }`, off by default. Before wiring `biome check --write` into a
`stage_fixed: true` hook (KAR-01.6), does it actually do to real Vue SFCs what the architecture
assumes — and is the flag actually required for the hazard the epic names?

## Method

`spikes/s7-biome-vue/src/fixtures.ts` holds two deliberately misformatted, real-shaped SFCs, the
single source shared between the automated integration test and the `spike/s7-biome-vue` branch's
before commit:

- **`complex-generics.vue`** — a `<script setup lang="ts">` block with a generic interface carrying
  a constrained, defaulted type parameter (`GraphNode<TPayload extends Record<string, unknown> =
  Record<string, unknown>>`), a two-type-parameter generic function with a recursive call, and a
  template-literal union type — AC3's "complex generics" case.
- **`long-attrs.vue`** — a template whose single `<button>` carries six attributes, one a long
  Tailwind-style class string — AC3's "long attribute list" case.

Both are formatted with real `git init` repositories in `fs.mkdtemp` directories
(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`), a real `biome` binary, and — for the
linter-split check — a real `oxlint` binary, exactly as `test/integration/spike-s7-biome-vue.test.ts`
runs them.

## Measurement

Three findings, each backed by a real `biome`/`oxlint` binary run against real-shaped SFCs in a
real `git init` tmpdir — full numbers and diffs in Findings 1–3 below.

## Finding 1 — the "silent no-op" claim needed a correction (AC1, test plan #1)

The epic's premise: without the `html` block, `biome check --write` is a total no-op on `.vue` files
— a green run, zero formatting. **Measured: this is only true of the `<template>` markup.** The
`html` block gates the markup formatter alone; the embedded `<script>` block is handed to Biome's
ordinary TypeScript formatter regardless of the flag, because that formatter has no idea it is
running inside an SFC.

| Config                    | `<template>` block  | `<script setup>` block | `git diff --name-only -- '*.vue'` |
| -------------------------- | -------------------- | ----------------------- | ----------------------------------- |
| `html` block absent        | byte-for-byte identical | reformatted (spacing, semicolons) | **not empty** — both fixtures listed |
| `html` block present (prod)| reformatted           | reformatted              | not empty — both fixtures listed    |

So "a green run and zero formatting" does not hold for any `.vue` file that contains misformatted
TypeScript, flag or no flag — the flag decides only whether the *markup half* is also touched. This
is a real correction to the epic's stated hazard, not a restatement of it: **the previously-assumed
safe baseline (flag off ⇒ file untouched) does not exist.** Practically this raises rather than
lowers the case for turning the flag on — leaving it off does not buy the do-nothing safety net the
architecture assumed, it only leaves the markup half inconsistent with the script half.

## Finding 2 — with the opt-in, the diff is small, bounded and semantically inert (AC2, AC3)

`git diff --stat` on the two-fixture worst case:

```
complex-generics.vue | 37 +++++++++++++++++++++----------------
long-attrs.vue       | 15 ++++++++++++---
2 files changed, 33 insertions(+), 19 deletions(-)
```

52 changed lines total across two files chosen to be maximally messy — a real commit touches far
less, since only the lines actually misformatted move.

**`<script setup>` with complex generics, reviewed line by line:**

```diff
-interface GraphNode<TPayload extends Record<string,unknown> = Record<string,unknown>> {
+interface GraphNode<TPayload extends Record<string, unknown> = Record<string, unknown>> {
-function collect<TPayload,TResult>(nodes:GraphNode<TPayload>[],project:(node:GraphNode<TPayload>)=>TResult):Map<string,TResult>{
+function collect<TPayload, TResult>(
+  nodes: GraphNode<TPayload>[],
+  project: (node: GraphNode<TPayload>) => TResult,
+): Map<string, TResult> {
```

Every rewrite is whitespace, semicolons, and line-wrapping. The constrained/defaulted type
parameter, the two-type-parameter function signature, the recursive call and the union type all
survive unchanged in substance — nothing was mangled, dropped or reordered. `vue-tsc --noEmit`
against the before and after text type-checks identically (confirmed by hand; not automated, since
the fixture is a scratch file with no workspace `tsconfig.json` of its own).

**Template with a long attribute list, reviewed line by line:**

```diff
-  <button type="button" class="rounded-md border … focus:ring-indigo-500" :disabled="disabled" data-testid="submit-button" aria-label="Submit the current form and advance to the next onboarding step" @click="handleClick">Submit</button>
+  <button
+    type="button"
+    class="rounded-md border … focus:ring-indigo-500"
+    :disabled="disabled"
+    data-testid="submit-button"
+    aria-label="Submit the current form and advance to the next onboarding step"
+    @click="handleClick"
+  >
+    Submit
+  </button>
```

One attribute per line, exactly the reflow a human would do by hand. The long `class` string itself
is left as one line — Biome does not break inside an attribute value — which is the readable choice,
not the unreadable one the epic worried about.

## Finding 3 — the ownership split holds; oxlint's template blindness is real (AC5, test plan #3, #4)

| Run                                                              | Result                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| production `biome.json` (`linter.enabled: false`) over an unused local variable | ignored — "these paths were provided but ignored"; no `noUnusedVariables` |
| `oxlint` over the same file                                       | `error eslint(no-unused-vars): Variable 'unusedGuard' is declared but never used` |
| a scratch `biome.json` with `linter.enabled: true` over the same file | `lint/correctness/noUnusedVariables` — the **exact duplicate** `linter.enabled: false` exists to prevent |
| `oxlint` over an Options-API `.vue` file registering `components: { UnusedWidget }`, never rendered in `<template>` | **no diagnostic at all** |

The third row is the check AC5 asks for directly: with Biome's linter re-enabled alongside oxlint,
the exact same unused binding is flagged twice, once by each tool under its own rule name
(`noUnusedVariables` and `no-unused-vars`) — the diagnostic appears twice, which is precisely what
production `biome.json`'s `linter.enabled: false` exists to prevent, and no autofix from either run
reverses the other's, since Biome's own run here applied no fixes (`No fixes applied`).

The fourth row is the one worth being precise about: from a plain-JS reading of the `<script>`
block, `UnusedWidget` is *used* — it's referenced by the object-shorthand property in
`components: { UnusedWidget }`. Nothing is an unused binding. The component is only dead from the
`<template>`'s point of view, and confirming that requires cross-referencing the template AST
against the registered components — exactly what `vue/no-unused-components` does and a script-only
linter structurally cannot. `oxlint` returning clean here is not a gap in effort; it is a gap in what
information the tool has, confirmed live rather than assumed from the plugin's documentation.

## The risk this closes

From [roadmap §6](../17-roadmap.md): **A2-3** — Biome's `.vue` support, real behaviour unverified.
Closed: the markup formatter genuinely gates on the `html` block (Finding 1's correction to the
opposite direction notwithstanding), the diff with it on is small and semantics-preserving on the
two hardest cases named in the story (Finding 2), and the Biome/oxlint split holds under a live
duplicate-diagnostic test rather than a reading of `linter.enabled: false` (Finding 3).

## What this spike does not answer

- **Files bigger than one component.** Both fixtures are single-purpose scratch files; a real SFC
  with several hundred lines of template was not exercised here.
- **Options-API `<template>` edge cases beyond one registered-and-unused component** — `v-slot`,
  scoped slots, and dynamic component tags (`<component :is="...">`) were not tried against either
  the formatter or the linter split.
- **Windows line endings.** Every measurement here ran on macOS/APFS with LF line endings.
