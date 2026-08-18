# The design system

> Built by [EPIC-24](./delivery/epics/EPIC-24-design-system.md) from the prototypes in
> [`docs/design/prototypes/`](./design/prototypes/) · [Frontend architecture](./12-frontend-architecture.md) §8, §9

This is the written half of the design system. The other half is the **`/gallery` route**, which is
the live one: every component in every variant, every token as a swatch showing its computed value,
in both themes, on one page. Read this for the rules; open `/gallery` for what they look like.

## Where things live

| | |
| --- | --- |
| The tokens | `packages/web/src/styles/theme.css` — the only file in the application allowed to contain a colour |
| The fonts | `packages/web/src/styles/fonts.css` and `src/assets/fonts/` — self-hosted, never a CDN |
| The components | `packages/web/src/components/ui/`, exported through its `index.ts` |
| The state vocabulary | `packages/web/src/lib/state-palette.ts` — seven display states, their labels and their two `*_DISPLAY` maps |
| The frame | `packages/web/src/components/frame/` — rail, switcher, topbar, run status pill |
| The living documentation | `/gallery`, dev-only, `packages/web/src/views/GalleryView.vue` |

## Why there is no Storybook

Considered and declined, for three reasons worth keeping written down, because the question comes up
about once a quarter:

1. **The gallery cannot drift from what ships.** It mounts inside the real app shell with the real
   stylesheet and the real router. A second harness with its own CSS bootstrapping lets a component
   look right in the harness and wrong in the application — which is the exact failure a design
   system exists to prevent.
2. **The gallery is a test.** `gallery.test.ts` mounts it in both themes, and `ui/variants.test.ts`
   asserts every variant resolves to the token it claims, in real Chromium. Stories only fail a
   build if you also run a test-runner or a visual-diff service, which is a second CI job and a
   second thing to keep green.
3. **The dependency budget.** `pnpm-workspace.yaml` argues in writing about every package that runs
   an install script. Storybook is several hundred packages and its own build, bought for prop
   controls that `variants.test.ts` already checks mechanically.

What Storybook would genuinely add, and this system does not have: per-prop controls, a static
build shareable with people who do not have the repository, and prose docs pages per component. If
those become needs rather than wants, that is a story with a cost, not a gap to fill quietly.

## The one rule

**A component may not know what it is for.**

No `variant="project"`. No `variant="gate"`. No `size="composer"`. A library that grows one variant
per screen stops being reusable in the only sense that matters — that the next screen costs less
than the last — and it does so gradually enough that nobody notices until it has happened.

`checkUiVocabulary` in `test/support/guards.ts` fails the build on it. The allowed members are:

| prop | members |
| --- | --- |
| `variant` | `primary` `secondary` `ghost` `danger` · `neutral` `accent` `ok` `warn` `error` `info` · `raised` `inset` `flush` |
| `size` | `sm` `md` `lg` |
| `tone` | `default` `ok` `warn` `error` `accent` |

Widening that table is a design decision, made once, in a diff a reviewer can see. Adding a member
because one screen wants it is the thing the guard exists to stop.

## The second rule

**Colour is never the only signal.** Every state carries a colour *and* a glyph *and* a text label
(WCAG 1.4.1, and §9.2's own argument: roughly 8% of male engineers will otherwise misread the
graph). `UiStateChip` renders all three from `state-palette.ts` and defines none of them itself.

Turn every colour off and the screen must still read. That is a thing to check, not to assume.

## The tokens

Three families, defined under `:root` and redefined under `.dark`, and nothing else:

- **Surfaces** — `--surface-canvas` `--surface` `--surface-raised` `--surface-inset` `--surface-code`
  `--surface-control` `--surface-overlay`
- **Ink** — `--ink` `--ink-strong` `--ink-muted` `--ink-dim` `--ink-faint`
- **Edges** — `--edge` `--edge-strong` `--edge-control` `--edge-hover` `--edge-dashed`

Plus `--focus-ring`, the seven `--state-*`, the `--text-*` and `--radius-*` ramps, `--font-sans` /
`--font-mono`, `--shadow-panel` / `--shadow-modal`, and four `@keyframes`: `dashrun`, `pulsering`,
`caret`, `shimmer`.

**A name not on that list needs a reason written beside it.** The failure this prevents is a second
vocabulary growing alongside the first, where `--surface-raised` and `--panel-bg` both exist and
mean the same thing, and half the app reads each.

**Contrast is a constraint, not an aspiration.** `theme-contrast.test.ts` computes every
ink-on-surface and state-on-surface pair from the stylesheet's own declarations, in both themes, and
fails below 4.5:1. Three of direction A's own literals did not pass and carry the adjusted value
with the original and its ratio in a comment beside them.

**Motion is opt-out-able by construction.** Anything animating carries `data-motion-token`, and
theme.css's `prefers-reduced-motion` block switches those off without the component knowing that
rule exists.

## Adding to the system

**Prefer a slot to a component.** A shape that appears twice is a slot. A shape that appears in four
unrelated screens and needs the same three props each time might be a component. Fifteen is a
ceiling, not a target.

**Never a colour outside `theme.css`.** `checkStateColoursComeFromThePalette` covers every web
source — TypeScript, `.vue` and stylesheets — with `theme.css` and `state-palette.ts` as its only
exemptions. If a component needs a tint, it takes it as a prop whose value the *caller* sources from
a token.

**Geometry may be px; type may not.** A 34×19 toggle track and an 18px icon tile are geometry, and
px is right for them — mark them with a comment saying so. Font sizes and radii come from the ramps,
because NF8 means a reader's browser font-size setting has to move the type.

**Reka UI does the hard parts.** Focus trap, roving tabindex, `aria-expanded`, escape and
outside-click are what §9.3 credits it with and says not to reimplement. `UiModal` is its dialog;
the project switcher is its popover.

## Applying it to a screen

1. Compose from `ui/index.ts`. Import through the barrel, never by file path — the set of things the
   library offers should be one file a reader can open.
2. Write no CSS you can express as a token. A `<style scoped>` block that declares spacing and
   layout is fine; one that declares a colour is a bug the build will catch.
3. Render what the view model carries and nothing else. Every story in EPIC-24 that reached for
   something the projections did not have reported it as a finding instead of adding a field —
   `UiMeter` goes unrendered on the plan graph for exactly that reason. A screen that needs a new
   field is a different epic.
4. Give every list a real empty state, and every error the daemon's own sentence.
