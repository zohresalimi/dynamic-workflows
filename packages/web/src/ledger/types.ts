/**
 * The domain types the UI projects, re-exported **type-only** from
 * `@DeFlow/core` (docs/12-frontend-architecture.md §3.3, rule 1).
 *
 * One re-export rather than a `@DeFlow/core` import in every view: the whole
 * point of rule 1 is that the UI typechecks against the producer, so when a
 * node status is added on the backend it surfaces as a compile error here — in
 * `../lib/state-palette.ts`'s total `Record<NodeStatus, DisplayState>` — in the
 * same commit that added it. A funnel makes that one place to look rather than
 * forty.
 *
 * Type-only, and enforced: `checkWebImportsDaemonTypesOnly` and the R1/R2 rules
 * in docs/16-repo-layout.md §4 are what keep the reducer, the ledger and the
 * daemon out of the browser bundle.
 */
export type { NodeStatus, RunState, RunStatus } from '@DeFlow/core';
