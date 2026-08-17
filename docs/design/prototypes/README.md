# Design prototypes

Three HTML design candidates for the web control center, supplied by the owner on 2026-08-17 with
the request that they become "a reusable component library" and be used to "design and implement the
user interface of this project". They are the design source for
[EPIC-24](../../delivery/epics/EPIC-24-design-system.md).

They are kept here **unmodified**, including a rejected one, because a design decision without the
alternatives it was made against is an assertion rather than a decision.

| File                                                                   | Direction                | Verdict                                                                                              |
| ---------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`direction-a-workflow-studio.html`](./direction-a-workflow-studio.html) | Near-black, lime accent  | **Canonical.** Draws all five screens, the inspector, the fan-out dock and the modal                 |
| [`direction-b-studio-light.html`](./direction-b-studio-light.html)      | Warm paper, serif, green | **Light theme surfaces only.** A has no light mode; this application has had one since KAR-16.1      |
| [`direction-c-control-room.html`](./direction-c-control-room.html)      | All-mono, orange, dense  | **Rejected, except its row density**, which the run table and the fan-out dock take                  |

The reasoning behind each verdict is in EPIC-24's _"Which prototype won, and why"_ section, not here.

## How to open them

They are self-contained apart from `support.js`, the harness that renders the `{{ … }}` bindings,
`<sc-if>` and `<sc-for>` in direction A. That file is **not** vendored: it is a third-party preview
runtime and nothing in this repository depends on it. Direction A therefore renders as static markup
with its binding placeholders visible when opened directly, which is enough to read every colour,
size, radius and layout decision out of it — and reading those out is the whole reason it is here.

They also load two font families over the network. The application does **not**; EPIC-24 KAR-24.1
self-hosts both, and a test asserts the built application makes no font-CDN request (AR-1).

## These are not the source of truth

Once EPIC-24 KAR-24.1 lands, `packages/web/src/styles/theme.css` is where the design language lives,
and these files become the historical record of where it came from. A colour changed here changes
nothing; a colour changed there changes the product. If the two disagree, the stylesheet is right and
this directory is out of date on purpose.
