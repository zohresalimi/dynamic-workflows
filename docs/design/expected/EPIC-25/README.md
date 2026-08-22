# Expected design — EPIC-25

Seven screenshots supplied by the owner on 2026-08-18, after running the built application against
a real repository and filing ten defects. Vendored here unmodified.

They are a **blueprint, not a pixel contract**. The token vocabulary remains EPIC-24's
(`packages/web/src/styles/theme.css`); what these files settle is *structure and scope* — which
items the rail offers, what belongs on a settings page, and that starting a run is a page rather
than a dialog. Where a screenshot's colour differs from a token, the token wins.

| File                           | What it settles                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `01-frame-workflow-run.png`    | The rail's item set and order, RUNTIMES as a read-only glance, the identity footer, the theme toggle's home                          |
| `02-inspector-config.png`      | The node inspector's Output / Config / Logs tabs, and Config as a label/value list                                                  |
| `03-inspector-logs.png`        | The Logs tab: timestamped, level-coloured                                                                                          |
| `04-frame-fanout-run.png`      | The workflow tab strip above the canvas and the phases/agents table below it                                                        |
| `05-frame-fanout-scrolled.png` | The canvas scrolling independently of the table                                                                                    |
| `06-settings.png`              | The settings page: *Providers & runtimes*, *Issue tracker*, *Execution defaults*                                                    |
| `07-new-run-page.png`          | The new-run page: a centred prompt, a source picker, a model picker grouped by provider, `Run ⌘↵`, workflow chips                    |

Two things these files show that EPIC-25 does **not** build, recorded so the omission is not read as
an oversight: the **Builder** nav row (no route, no epic behind it — KAR-24.4 AC2's rule) and
**editable per-node execution fields** in the inspector (the inspector renders what the ledger
recorded; making those editable is plan authoring, not a frame fix).

KAR-26.5's element-by-element audit of `01`–`05` against the live frame — every visible element
marked `matches` / `gap closed here` / `out of scope: <standing reason>` — is
[`KAR-26.5-frame-audit.md`](./KAR-26.5-frame-audit.md), in this directory.
