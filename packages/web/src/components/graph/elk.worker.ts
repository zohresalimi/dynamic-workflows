/**
 * KAR-16.6 AC5 — the ELK worker entry (EPIC-16-S37, docs/spikes/S3-elk-worker.md).
 *
 * One import, and it is the whole file. `elk-worker.min.js` is the layout
 * engine's own worker script — GWT-transpiled Java that installs its
 * `onmessage` handler as a side effect of being evaluated — so a worker entry
 * that imports it *is* an ELK worker.
 *
 * `.min.js` rather than `.js`: 1.4 MB against 4.8 MB, and it is the 1.4 MB
 * figure AC5 is written about.
 *
 * This file exists as a file so that `./layout.ts` can say `?worker` about a
 * module of ours rather than about a path inside a dependency, which is what
 * makes the swap in AC10 a change to this directory. What must not come back is
 * elkjs's own documented `workerUrl` option: it wants a publicly-served path
 * known at authoring time, and `vite build` renames the file to
 * `elk-worker.min-<hash>.js` — the failure S3 was run to rule out.
 */
import 'elkjs/lib/elk-worker.min.js';
